"""Intake (#204): an MQTT print event → the job it identifies → that job's state.

Each printer's events run one at a time. Intake matches them to jobs by
printer and submission ID, keeps the per-print memory events need (whose start
and completion already ran, and a Stop sent from the printer controls), and
hands the job to its state. The state's effects run once its transaction
commits; intake waits for them before the printer's next event.
"""

import asyncio
import logging
from dataclasses import dataclass, field
from functools import partial

from sqlalchemy import or_, select

from backend.app.core.database import async_session, run_with_retry
from backend.app.core.tasks import spawn_background_task
from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import AWAITING_PLATE_CLEAR_STATUSES, FINAL_STATUSES, PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services import print_effects
from backend.app.services.job_identity import event_identity, find_job, telemetry_identity
from backend.app.services.lifecycle import deadlines, effects, printing
from backend.app.services.lifecycle.engine import hold_printer
from backend.app.services.printer_manager import printer_manager

logger = logging.getLogger(__name__)
_ACTIVE = ("PREPARE", "SLICING", "RUNNING", "PAUSE")

# Serialize MQTT start/finish callbacks per printer, including slow archiving.
# A short print must not finish before its Archive link has been persisted.
_job_event_locks: dict[int, asyncio.Lock] = {}
_started_job_effects: dict[int, int] = {}  # The job whose new-print effects ran.
_completed_job_events: dict[int, int] = {}  # The job whose completion ran.
# A Stop from the printer controls, which the printer reports as failed or aborted.
_user_stopped_printers: set[int] = set()
# Connected-edge reconciliation (#1542): armed once per connection, deferred
# while the first real state after reconnect is active.
_printer_reconciled_since_connect: dict[int, bool] = {}
_pending_stale_reconciliation: set[int] = set()


@dataclass
class PrintMemory:
    """Intake's per-print context, passed explicitly to the heavy services."""

    finish_frames: dict[int, bytes] = field(default_factory=dict)
    finish_in_flight: dict[int, asyncio.Event] = field(default_factory=dict)
    timelapse_baselines: dict[int, set[str]] = field(default_factory=dict)
    bed_cool_waiters: dict[int, dict] = field(default_factory=dict)


print_memory = PrintMemory()


async def finish_photo_moment(printer_id: int, data: dict) -> None:
    await print_effects.on_finish_photo_moment(printer_id, data, memory=print_memory)


async def bed_cooled(printer_id: int, bed_temp: float) -> None:
    await print_effects.bed_cooled(printer_id, bed_temp, memory=print_memory)


def _lock(printer_id: int) -> asyncio.Lock:
    return _job_event_locks.setdefault(printer_id, asyncio.Lock())


def busy(printer_id: int) -> bool:
    """Whether one of the printer's events is in progress, such as a completion recovery mustn't race."""
    return _lock(printer_id).locked()


def mark_printer_stopped_by_user(printer_id: int) -> None:
    """Record a Grove Stop, so the printer's "failed" or "aborted" report completes as cancelled."""
    _user_stopped_printers.add(printer_id)
    logger.info("Marked printer %s as user-stopped from queue", printer_id)


async def print_started(printer_id: int, data: dict, *, recovering: bool = False) -> None:
    async with _lock(printer_id):
        await _observe_print_start(printer_id, data, recovering=recovering)


async def print_running_observed(printer_id: int, data: dict) -> None:
    """After a restart, restore the running print's job, then its usage tracking and timelapse baseline."""
    await print_started(printer_id, data, recovering=True)
    await print_effects.print_resumed(printer_id, memory=print_memory)


async def _observe_print_start(printer_id: int, data: dict, *, recovering: bool = False) -> None:
    """Record every observed print as a job; its start effects run once that commits."""
    identity = event_identity(data)
    if not identity:
        return
    async with async_session() as db:
        await hold_printer(db, printer_id)  # Read and write the printer's job as its only writer.
        await printing.bind_observed_id(db, printer_id, identity, data.get("previous_submission_id"))
        # A delayed start cannot replace a plate hold. For a very short print,
        # telemetry may already be terminal while this active snapshot waits
        # behind another callback; its exact live identity still proves the run.
        active = (data.get("raw_data") or {}).get("gcode_state") in _ACTIVE
        live = printer_manager.get_status(printer_id)
        item, _ = await printing.observe_print(db, printer_id, identity, observed_state=live, active_snapshot=active)
        if item is None:
            return  # Missing identity or another job still owns this printer.
        start = {
            **data,
            "submission_id": identity,
            "ams_mapping": printing.job_ams_mapping(item.ams_mapping, data.get("ams_mapping")),
            "plate_id": item.plate_id if item.plate_id is not None else data.get("plate_id"),
            "owner_id": item.created_by_id,
        }
        new = not recovering and _started_job_effects.get(printer_id) != item.id
        work = partial(
            print_effects.print_started, printer_id, start, item.id, item.archive_id, new=new, memory=print_memory
        )
        effects.after_commit_task(db, work, key=("print_start", item.id))
        item_id = item.id
        await db.commit()
        _started_job_effects[printer_id] = item_id
        if new:
            _user_stopped_printers.discard(printer_id)  # A Stop marker never outlives its print.
        started = effects.spawned(db)
    await effects.wait_for(started)


async def print_state_changed(printer_id: int, data: dict) -> None:
    """Persist pause/resume without replaying print-start or completion effects."""
    identity = event_identity(data)
    if not identity:
        return
    async with _lock(printer_id):

        async def _apply(db):
            await hold_printer(db, printer_id)
            item = await find_job(db, printer_id, identity, ("printing", "paused"))
            if item is None:
                return
            live = printer_manager.get_status(printer_id)
            if live is None or live.state != data.get("state"):
                return  # A later push superseded this snapshot while the callback waited.
            if await printing.sync_print_state(db, item, live):
                await db.commit()

        await run_with_retry(_apply, label="queue pause/resume", session_factory=async_session)


async def print_completed(printer_id: int, data: dict):
    async with _lock(printer_id):
        return await _complete_identified_print(printer_id, data)


async def _complete_identified_print(printer_id: int, data: dict):
    """End the identified job for the printer's report, then wait for its completion effects; False if none ended."""
    # Connected-edge reconciliation runs in the background and can race with
    # queue dispatch. A synthetic completion must never run while any print is
    # active: its effects are printer-level, so even a stale archive for a
    # different job must be deferred.
    if data.get("_reconciled") and _is_printer_actively_printing(printer_manager.get_status(printer_id)):
        logger.info(
            "[CALLBACK] Ignoring stale reconciled completion for printer %s while a print is active", printer_id
        )
        return False
    if data.get("status", "completed") not in ("completed", "failed", "aborted", "cancelled"):
        return False
    identity = event_identity(data)
    live = printer_manager.get_status(printer_id)
    if (
        live
        and live.connected
        and live.state in (*_ACTIVE, "FINISH", "FAILED")
        and telemetry_identity(live) not in (None, identity)
    ):
        return False
    stopped = printer_id in _user_stopped_printers
    # The terminal transition, Archive outcome and printer hold commit together.
    # A locked SQLite database retries the whole transaction in a fresh session,
    # so a busy writer cannot leave the job printing with no effects run (#897).
    end = partial(_end, printer_id, identity, data, stopped)
    ended = await run_with_retry(end, label="queue completion", session_factory=async_session)
    if ended is None:
        return False
    job_id, completion = ended
    _completed_job_events[printer_id] = job_id
    _user_stopped_printers.discard(printer_id)
    await effects.wait_for(completion)
    # The real terminal callback has now completed its archive, queue and
    # printer-level state changes. It is safe to reconcile any older stale
    # archive from the same reconnect without racing the live completion.
    _schedule_pending_stale_reconciliation(printer_id)


async def _end(printer_id: int, identity: str | None, data: dict, stopped: bool, db):
    """The ended job's ID and its completion effects, or None for a duplicate or unidentified report."""
    await hold_printer(db, printer_id)
    await printing.bind_observed_id(db, printer_id, identity, data.get("previous_submission_id"))
    statuses = ("dispatching", "printing", "paused", "cancelled")
    if data.get("_recovered_dispatch"):
        statuses += ("finished", "failed", "successful")
    job = await find_job(db, printer_id, identity, statuses)
    done = _completed_job_events.get(printer_id)
    if job is None or done == job.id or (job.status == "cancelled" and job.physical_outcome is not None):
        terminal = (*AWAITING_PLATE_CLEAR_STATUSES, *FINAL_STATUSES)
        ended = job or await find_job(db, printer_id, identity, terminal)
        if ended is not None and ended.status in terminal:
            return None
    if job is None and identity:
        job = await _adopt_legacy_archive(db, printer_id, identity)
    if job is None or done == job.id:
        return None
    job_id = job.id
    await printing.end(db, job, data, stopped=stopped, memory=print_memory)
    await db.commit()
    return job_id, effects.spawned(db)


async def _adopt_legacy_archive(db, printer_id: int, identity: str) -> PrintQueueItem | None:
    """A print an older version archived may finish while Grove is offline; its exact ID establishes a job.

    ID-less or filename-only history cannot establish continuity.
    """
    archives = list(
        await db.scalars(
            select(PrintArchive).where(
                PrintArchive.printer_id == printer_id,
                PrintArchive.subtask_id == identity,
                PrintArchive.status == "printing",
                PrintArchive.dispatched_queue_item_id.is_(None),
            )
        )
    )
    if len(archives) != 1:
        return None
    job, _ = await printing.observe_print(db, printer_id, identity)
    if job is not None:
        archive = archives[0]
        job.archive_id = archive.id
        job.started_at = archive.started_at
        archive.dispatched_queue_item_id = job.id
        await db.commit()
    return job


async def printer_status(printer_id: int, state) -> None:
    """Telemetry: wake the lifecycle loop on each connect and disconnect, and reconcile missed completions on reconnect.

    MQTT's connect broadcast still carries construction defaults (state
    "unknown"), so reconciliation waits for the first real push_status (#1679).
    If that first state is active, it is deferred until the real terminal
    completion, which it would otherwise race (#1542).
    """
    known = bool(state.state) and state.state.upper() not in ("", "UNKNOWN")
    if state.connected and known and not _printer_reconciled_since_connect.get(printer_id, False):
        _printer_reconciled_since_connect[printer_id] = True
        deadlines.wake()
        if _is_printer_actively_printing(state):
            _pending_stale_reconciliation.add(printer_id)
        elif printer_id in _pending_stale_reconciliation:
            # A reconnect can begin in a terminal state without producing a
            # separate completion callback. This is the safe fallback for a
            # deferred reconciliation left by an earlier active reconnect.
            _schedule_pending_stale_reconciliation(printer_id)
        else:
            spawn_background_task(
                reconcile_stale_active_prints(printer_id), name=f"reconcile-stale-prints-{printer_id}"
            )
    elif not state.connected and _printer_reconciled_since_connect.get(printer_id, False):
        _printer_reconciled_since_connect[printer_id] = False  # Re-arm for the next reconnect.
        deadlines.wake()


def _is_printer_actively_printing(state) -> bool:
    """Whether ``state`` proves the printer is printing; a synthetic completion never runs then."""
    current_state = (getattr(state, "state", "") or "").upper()
    return bool(state and getattr(state, "connected", False) and current_state in _ACTIVE)


def _schedule_pending_stale_reconciliation(printer_id: int) -> None:
    """Run a deferred reconciliation once the printer is safe, re-arming it if not."""
    if printer_id not in _pending_stale_reconciliation:
        return

    _pending_stale_reconciliation.remove(printer_id)

    async def _run_reconciliation():
        try:
            await reconcile_stale_active_prints(printer_id)
        finally:
            # A new print may have started while reconciliation was querying
            # the database, or the printer may have disconnected again. Keep
            # the retry armed so the next terminal callback/reconnect can
            # flush the stale archive safely.
            state = printer_manager.get_status(printer_id)
            if not state or not state.connected or _is_printer_actively_printing(state):
                _pending_stale_reconciliation.add(printer_id)

    spawn_background_task(_run_reconciliation(), name=f"reconcile-stale-prints-after-completion-{printer_id}")


async def reconcile_stale_active_prints(printer_id: int) -> int:
    """Complete each unlinked printing Archive whose exact print the printer now reports as ended.

    Runs on each (re)connection and at startup. A print that finished during a
    disconnect would otherwise keep its SD file, which the firmware replays
    after a power cycle (#1542). Queue recovery owns linked jobs. Returns the
    number of Archives reconciled.
    """
    state = printer_manager.get_status(printer_id)
    # Never decide against stale cached state; the connected edge retries.
    if not state or not state.connected:
        return 0
    async with async_session() as db:
        result = await db.execute(
            select(PrintArchive).where(PrintArchive.printer_id == printer_id, PrintArchive.status == "printing")
        )
        active = list(result.scalars().all())
    if not active:
        return 0
    # The connected-edge task may have read an IDLE state just before queue
    # dispatch started a print. Re-read after the database await so the stale
    # snapshot cannot be used to synthesize completion for a live print.
    state = printer_manager.get_status(printer_id)
    if not state or not state.connected or _is_printer_actively_printing(state):
        return 0
    reconciled = 0
    for archive in active:
        if archive.dispatched_queue_item_id is not None:
            continue  # Queue recovery owns the linked job and its outcome.
        identity = telemetry_identity(state)
        if not identity or identity != archive.subtask_id or state.state not in ("FINISH", "FAILED"):
            continue
        logger.info(
            "[RECONCILE] Printer %s: synthesising missed PRINT COMPLETE for archive %s (%s) — %s",
            printer_id,
            archive.id,
            archive.filename,
            f"matching submission ID in {state.state}",
        )
        try:
            # raw_data is the live state, so usage tracking can compare
            # end-of-print remain% against the values captured at start.
            completion_result = await print_completed(
                printer_id,
                {
                    "status": "completed" if state.state == "FINISH" else "failed",
                    "filename": archive.filename,
                    "subtask_name": archive.print_name or "",
                    "subtask_id": archive.subtask_id or "",
                    "raw_data": state.raw_data or {},
                    "_reconciled": True,
                },
            )
            if completion_result is not False:
                reconciled += 1
        except Exception as e:
            # The Archive stays printing; the next reconnect retries.
            logger.warning("[RECONCILE] on_print_complete synthesis failed for archive %s: %s", archive.id, e)
    return reconciled


async def reconcile_print_archives() -> None:
    """Repair missing Archive projections in one paced scheduler pass."""
    live_ids = [
        (pid, telemetry_identity(state))
        for pid, state in printer_manager.get_all_statuses().items()
        if state.connected and state.job_telemetry_ready and telemetry_identity(state)
    ]
    if not live_ids:
        return
    async with async_session() as db:
        jobs = (
            await db.execute(
                select(
                    PrintQueueItem.id,
                    PrintQueueItem.printer_id,
                    PrintQueueItem.dispatch_subtask_id,
                    PrintQueueItem.ams_mapping,
                    PrintQueueItem.plate_id,
                    PrintQueueItem.created_by_id,
                )
                .join(Printer)
                .where(
                    PrintQueueItem.archive_id.is_(None),
                    PrintQueueItem.started_at.is_not(None),
                    Printer.auto_archive.is_(True),
                    or_(
                        *[
                            (PrintQueueItem.printer_id == pid) & (PrintQueueItem.dispatch_subtask_id == identity)
                            for pid, identity in live_ids
                        ]
                    ),
                )
            )
        ).all()
    for job in jobs:
        lock = _lock(job.printer_id)
        if lock.locked():
            continue
        async with lock:
            live = printer_manager.get_status(job.printer_id)
            if (
                not live
                or not live.connected
                or not live.job_telemetry_ready
                or telemetry_identity(live) != job.dispatch_subtask_id
            ):
                continue
            data = {
                "submission_id": job.dispatch_subtask_id,
                "filename": live.gcode_file or live.current_print,
                "subtask_name": live.subtask_name,
                "raw_data": dict(live.raw_data or {}),
                "ams_mapping": printing.job_ams_mapping(job.ams_mapping, None),
                "plate_id": job.plate_id,
                "owner_id": job.created_by_id,
            }
            try:
                if data["filename"] or data["subtask_name"]:
                    await print_effects._archive_print_start(
                        job.printer_id, data, queue_job_id=job.id, memory=print_memory
                    )
                    await print_effects._link_observed_archive(job.printer_id, job.id, job.dispatch_subtask_id)
            except Exception:
                logger.exception("Archive reconciliation failed for Queue job %s", job.id)

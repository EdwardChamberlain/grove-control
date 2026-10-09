"""Printing (#204): printing and paused, from a confirmed dispatch or an adopted external print until it ends.

Enter: dispatching's confirmation, or ``observe_print`` for a print the printer
started itself. A confirmed dispatch publishes its queue start after commit.
Wait: ``sync_print_state`` follows the printer's pause and resume. Exit:
``end`` enters the awaiting state for the printer's reported outcome and runs
the completion effects after commit; a failed or stopped print shuts down the
heaters a heat soak left on.
"""

import json
from dataclasses import dataclass
from functools import partial

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import HOLDING_STATUSES, PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.user import User
from backend.app.services.job_identity import find_job, normalize_id, telemetry_identity
from backend.app.services.lifecycle import clock, effects
from backend.app.services.lifecycle.engine import hold_printer, transfer_hold, transition_queue_item
from backend.app.services.lifecycle.preheating import shut_down_inherited
from backend.app.services.printer_manager import printer_manager

ACTIVE = ("PREPARE", "SLICING", "RUNNING", "PAUSE")
_REPORTED = (*ACTIVE, "FINISH", "FAILED")


@dataclass(frozen=True)
class Completion:
    """What the completion transaction committed, for the effects that follow it."""

    printer_id: int
    job_id: int
    owner_id: int | None
    owner: tuple[int, str] | None
    queue_status: str
    auto_off: bool
    archive_id: int | None
    remote_filename: str | None
    archive_filename: str | None
    data: dict  # The report, with the reported status and the job's tray mapping and plate.


async def on_enter(change, row) -> None:
    """Enter: a confirmed dispatch publishes its queue start once this transaction commits."""
    if change.before == "dispatching":
        effects.queue_job_started(change.db, change.item_id)


async def on_exit(change, row) -> None:
    """Exit: a failed or stopped print shuts down the heaters its soak left on.

    A print that ends in the transaction that confirmed it announces only its
    end: the queue start re-reads the job after commit and finds it ended.
    """
    await shut_down_inherited(change, row)


async def owner_of(db: AsyncSession, item: PrintQueueItem) -> tuple[int, str] | None:
    """The job's owner, whom its completion credits; None for an ownerless job."""
    owner = await db.get(User, item.created_by_id) if item.created_by_id else None
    return (owner.id, owner.username) if owner else None


def job_ams_mapping(stored: str | None, observed: list[int] | None) -> list[int] | None:
    """The job's tray mapping, or the one the printer reported for an external print."""
    if stored is not None:
        try:
            mapping = json.loads(stored)
            if isinstance(mapping, list) and all(isinstance(tray, int) for tray in mapping):
                return mapping
        except (ValueError, TypeError):
            pass  # Malformed legacy metadata must not block the job's lifecycle.
    return observed


def superseded_by(item: PrintQueueItem, state, states=_REPORTED) -> str | None:
    """The different print fresh telemetry reports in ``states``, which proves ``item``'s print has ended.

    Only firmware IDs count: a session-local ID can't prove continuity across a restart.
    """
    if not state or not state.connected or not getattr(state, "job_telemetry_ready", True) or state.state not in states:
        return None
    ours, live = normalize_id(item.dispatch_subtask_id), telemetry_identity(state)
    return live if ours and live and ours != live and ours.isdigit() and live.isdigit() else None


async def sync_print_state(db: AsyncSession, item: PrintQueueItem, state) -> bool:
    """Apply a fresh, matching PAUSE/RUNNING observation without releasing the hold.

    Preparation and uncertain/offline telemetry do not resume a paused job.
    Callers own the transaction; duplicate observations do not write anything.
    """
    if (
        item.status not in ("printing", "paused")
        or state is None
        or not state.connected
        or not getattr(state, "job_telemetry_ready", True)
        or not normalize_id(item.dispatch_subtask_id)
        or telemetry_identity(state) != item.dispatch_subtask_id
    ):
        return False
    destination = {"PAUSE": "paused", "RUNNING": "printing"}.get(state.state)
    if destination is None or destination == item.status:
        return False
    await transition_queue_item(
        db,
        item,
        item.status,
        destination,
        conditions=(
            PrintQueueItem.printer_id == item.printer_id,
            PrintQueueItem.dispatch_subtask_id == item.dispatch_subtask_id,
        ),
    )
    return True


async def bind_observed_id(db: AsyncSession, printer_id: int, identity: str | None, previous: str | None):
    """Bind a session-local job to the firmware ID observed later in that run."""
    if not identity or not previous or identity == previous:
        return
    # An already-used firmware ID cannot establish a new association.
    if (
        await db.scalar(
            select(PrintQueueItem.id)
            .where(PrintQueueItem.printer_id == printer_id, PrintQueueItem.dispatch_subtask_id == identity)
            .limit(1)
        )
        is not None
    ):
        return
    item = await find_job(db, printer_id, previous, ("printing", "paused"))
    if item is None:
        return
    await transition_queue_item(
        db,
        item,
        item.status,
        item.status,
        values={"dispatch_subtask_id": identity},
        conditions=(PrintQueueItem.dispatch_subtask_id == previous,),
    )
    # Creation records the attempt's owner before the Queue projection links
    # it. A transient link failure must not detach it when firmware reports
    # its ID later; the unique owner column identifies the same attempt.
    await db.execute(
        update(PrintArchive)
        .where(
            PrintArchive.dispatched_queue_item_id == item.id,
            PrintArchive.printer_id == printer_id,
            PrintArchive.subtask_id == previous,
        )
        .values(subtask_id=identity)
    )


async def observe_print(
    db: AsyncSession, printer_id: int, identity: str | None, *, observed_state=None, active_snapshot: bool = False
) -> tuple[PrintQueueItem | None, bool]:
    """Enter: confirm the observed print's dispatched job, or adopt it as a new external job.

    The printer row serializes duplicate callbacks on SQLite and PostgreSQL.
    The existing unique active-printer index also fences scheduler dispatch.
    Never displace a different or unidentifiable active reservation. Fresh
    telemetry can establish a new external run on a plate still held by an
    ended job, which then transfers its hold in this transaction.
    """
    if not identity:
        return None, False
    await hold_printer(db, printer_id)
    locked = await db.execute(update(Printer).where(Printer.id == printer_id).values(id=Printer.id))
    if not locked.rowcount:
        return None, False
    item = await find_job(db, printer_id, identity)
    if item:
        confirmed = item.status == "dispatching"
        if confirmed:
            values = {"started_at": clock.now(), "error_message": None}
            await transition_queue_item(db, item, "dispatching", "printing", values=values)
        await sync_print_state(db, item, observed_state)
        return item, confirmed
    ended = await db.scalar(
        select(PrintQueueItem.id)
        .where(
            PrintQueueItem.printer_id == printer_id,
            PrintQueueItem.dispatch_subtask_id == identity,
            PrintQueueItem.status.in_(("finished", "failed", "cancelled", "successful", "unsuccessful")),
        )
        .limit(1)
    )
    if ended is not None:
        return None, False  # A duplicate/delayed start cannot revive a finished job.
    held = await db.scalar(
        select(PrintQueueItem)
        .where(PrintQueueItem.printer_id == printer_id, PrintQueueItem.status.in_(HOLDING_STATUSES))
        .execution_options(populate_existing=True)
    )
    if held is not None:
        # Check the live, mutable state after acquiring the printer/row locks.
        # A start that waited behind another callback may now be stale.
        replace_awaiting = (
            observed_state is not None
            and observed_state.connected
            and getattr(observed_state, "job_telemetry_ready", True)
            and telemetry_identity(observed_state) == identity
            and (
                observed_state.state in ("PREPARE", "SLICING", "RUNNING", "PAUSE")
                or (active_snapshot and observed_state.state in ("FINISH", "FAILED", "IDLE"))
            )
        )
        if not replace_awaiting or not await transfer_hold(db, held, identity):
            return None, False
    item = PrintQueueItem(
        printer_id=printer_id, status="printing", dispatch_subtask_id=identity, started_at=clock.now()
    )
    db.add(item)
    await db.flush()
    await sync_print_state(db, item, observed_state)
    return item, False


async def end(db: AsyncSession, job: PrintQueueItem, data: dict, *, stopped: bool, memory) -> None:
    """Exit for the printer's report that the print ended, into the awaiting state for its outcome.

    ``stopped`` is a Grove Stop from the printer controls. The completion
    effects run once the caller commits.
    """
    from backend.app.services.print_effects import (
        _format_hms_error_summary,
        derive_failure_reason,
        print_completed,
    )

    printer_id, reported = job.printer_id, data.get("status", "completed")
    grove_stop = job.status == "cancelled" or stopped
    cancelled = job.status == "cancelled" or (stopped and reported == "failed")
    queue_status = "cancelled" if reported == "aborted" or (reported != "completed" and cancelled) else reported
    # A stop from Grove is reported as "cancelled", now also after a restart.
    # Every other outcome, including a touchscreen "aborted", keeps the
    # printer's own name for notifications and integrations.
    reported_status = "cancelled" if grove_stop and reported in ("failed", "aborted") else reported
    destination = "finished" if queue_status == "completed" else queue_status
    if job.status == "dispatching" and destination == "finished":
        # Exact terminal identity also proves this dispatch was accepted.
        await transition_queue_item(db, job, "dispatching", "printing")
    if job.status not in ("successful", "unsuccessful"):
        reason = job.error_message
        if queue_status == "failed" and not reason:
            reason = _format_hms_error_summary(data.get("hms_errors") or [])
        completing_cancelled = job.status == "cancelled"
        if completing_cancelled and destination == "finished":
            reason = None  # The identified print finished despite the Stop request.
        now = clock.now()
        await transition_queue_item(
            db,
            job,
            job.status,
            destination,
            action="printer_report" if job.physical_outcome is None else None,
            values={"completed_at": now if completing_cancelled else job.completed_at or now, "error_message": reason},
            archive_failure_reason=derive_failure_reason(reported_status, data.get("hms_errors")),
        )
    remote_filename = archive_filename = None
    if job.archive_id:
        attempt = await db.scalar(
            select(PrintArchive).where(
                PrintArchive.id == job.archive_id, PrintArchive.dispatched_queue_item_id == job.id
            )
        )
        if attempt:
            # Capture cleanup identity before automatic Clear Plate releases
            # the hold and makes this Archive eligible for deletion.
            remote_filename = (attempt.extra_data or {}).get("remote_filename")
            archive_filename = attempt.filename
    await _bump_library_file_usage_if_completed(db, job, queue_status)
    completion = Completion(
        printer_id=printer_id,
        job_id=job.id,
        owner_id=job.created_by_id,
        owner=await owner_of(db, job),
        queue_status=queue_status,
        auto_off=bool(job.auto_off_after),
        archive_id=job.archive_id,
        remote_filename=remote_filename,
        archive_filename=archive_filename,
        data={
            **data,
            "status": reported_status,
            "ams_mapping": job_ams_mapping(job.ams_mapping, data.get("ams_mapping")),
            "plate_id": job.plate_id if job.plate_id is not None else data.get("plate_id"),
        },
    )
    effects.after_commit_task(db, partial(print_completed, completion, memory=memory), key=("print_complete", job.id))


async def _bump_library_file_usage_if_completed(db, item, queue_status: str) -> None:
    """Count a completed print of a Files source (#1008); other outcomes are not usage. The caller commits."""
    if queue_status != "completed" or item.library_file_id is None:
        return
    lib_file = await db.scalar(select(LibraryFile).where(LibraryFile.id == item.library_file_id))
    if lib_file is None:
        return
    lib_file.print_count = (lib_file.print_count or 0) + 1
    lib_file.last_printed_at = clock.now()


async def adopt_legacy_prints(db: AsyncSession) -> None:
    """A print an older version archived without a job becomes an ownerless job once fresh telemetry reports its ID.

    Only an exact, unique ID establishes continuity; an Archive left printing
    by a print that ended long ago never reserves a printer.
    """
    legacy = (
        await db.execute(
            select(PrintArchive.id, PrintArchive.printer_id, PrintArchive.subtask_id).where(
                PrintArchive.status == "printing",
                PrintArchive.dispatched_queue_item_id.is_(None),
                PrintArchive.printer_id.is_not(None),
                PrintArchive.subtask_id.is_not(None),
            )
        )
    ).all()
    await db.rollback()
    candidates: dict[tuple[int, str], list[int]] = {}
    for archive_id, printer_id, subtask_id in legacy:
        candidates.setdefault((printer_id, normalize_id(subtask_id)), []).append(archive_id)
    for (printer_id, identity), archive_ids in candidates.items():
        state = printer_manager.get_status(printer_id)
        live = state and state.connected and getattr(state, "job_telemetry_ready", False)
        if not identity or len(archive_ids) != 1 or not live or telemetry_identity(state) != identity:
            continue
        await hold_printer(db, printer_id)
        job, _ = await observe_print(db, printer_id, identity)
        archive = await db.get(PrintArchive, archive_ids[0])
        if job is None or job.archive_id is not None or archive is None or archive.dispatched_queue_item_id:
            await db.rollback()
            continue
        archive.dispatched_queue_item_id = job.id
        values = {"archive_id": archive.id, "started_at": archive.started_at or job.started_at}
        await transition_queue_item(db, job, job.status, job.status, values=values)
        await db.commit()

"""Intake (#204): an MQTT print event → the job it identifies → that job's state.

Intake matches printer events by printer and submission ID, then records facts
on the job. A small registration marker suppresses duplicate best-effort
start effects; persisted job state owns every lifecycle decision.
"""

import asyncio
import logging
from dataclasses import dataclass, field
from functools import partial

from sqlalchemy import select

from backend.app.core.database import async_session, run_with_retry
from backend.app.models.print_queue import AWAITING_PLATE_CLEAR_STATUSES, FINAL_STATUSES, PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services import print_effects
from backend.app.services.job_identity import event_identity, find_job, telemetry_identity
from backend.app.services.lifecycle import deadlines, effects, printing
from backend.app.services.lifecycle.engine import transition_queue_item, writer
from backend.app.services.printer_manager import printer_manager

logger = logging.getLogger(__name__)
_ACTIVE = ("PREPARE", "SLICING", "RUNNING", "PAUSE")


@dataclass
class PrintMemory:
    """Intake's per-print context, passed explicitly to the heavy services."""

    finish_frames: dict[int, bytes] = field(default_factory=dict)
    finish_in_flight: dict[int, asyncio.Event] = field(default_factory=dict)
    timelapse_baselines: dict[int, set[str]] = field(default_factory=dict)
    bed_cool_waiters: dict[int, dict] = field(default_factory=dict)
    # Best-effort start-effect registration only; the persisted job owns state.
    started_job_effects: dict[int, int] = field(default_factory=dict)


print_memory = PrintMemory()


async def finish_photo_moment(printer_id: int, data: dict) -> None:
    await print_effects.on_finish_photo_moment(printer_id, data, memory=print_memory)


async def bed_cooled(printer_id: int, bed_temp: float) -> None:
    await print_effects.bed_cooled(printer_id, bed_temp, memory=print_memory)


async def print_started(printer_id: int, data: dict, *, recovering: bool = False) -> None:
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
    async with writer(printer_id), async_session() as db:
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
        source_filename = data.get("filename") or data.get("subtask_name")
        if source_filename and not item.source_filename:
            await transition_queue_item(
                db,
                item,
                item.status,
                item.status,
                values={"source_filename": str(source_filename)[:512]},
            )
        new = not recovering and print_memory.started_job_effects.get(printer_id) != item.id
        work = partial(
            print_effects.print_started, printer_id, start, item.id, item.archive_id, new=new, memory=print_memory
        )
        effects.after_commit_task(db, work, key=("print_start", item.id))
        item_id = item.id
        await db.commit()
        print_memory.started_job_effects[printer_id] = item_id
        started = effects.spawned(db)
    await effects.wait_for(started)


async def print_state_changed(printer_id: int, data: dict) -> None:
    """Persist pause/resume without replaying print-start or completion effects."""
    identity = event_identity(data)
    if not identity:
        return

    async def _apply(db):
        async with writer(printer_id):
            item = await find_job(db, printer_id, identity, ("printing", "paused"))
            if item is None:
                return
            live = printer_manager.get_status(printer_id)
            if live is None or live.state != data.get("state"):
                return  # A later push superseded this snapshot before the write.
            if await printing.sync_print_state(db, item, live):
                await db.commit()

    await run_with_retry(_apply, label="queue pause/resume", session_factory=async_session)


async def print_completed(printer_id: int, data: dict):
    return await _complete_identified_print(printer_id, data)


async def _complete_identified_print(printer_id: int, data: dict):
    """End the identified job for the printer's report, then wait for its completion effects; False if none ended."""
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
    # The terminal transition, Archive outcome and printer hold commit together.
    # A locked SQLite database retries the whole transaction in a fresh session,
    # so a busy writer cannot leave the job printing with no effects run (#897).
    end = partial(_end, printer_id, identity, data)
    ended = await run_with_retry(end, label="queue completion", session_factory=async_session)
    if ended is None:
        return False
    job_id, completion = ended
    await effects.wait_for(completion)


async def _end(printer_id: int, identity: str | None, data: dict, db):
    """The ended job's ID and its completion effects, or None for a duplicate or unidentified report."""
    async with writer(printer_id):
        await printing.bind_observed_id(db, printer_id, identity, data.get("previous_submission_id"))
        job = await find_job(db, printer_id, identity, ("dispatching", "printing", "paused", "cancelled"))
        if job is None or (job.status == "cancelled" and job.physical_outcome is not None):
            terminal = (*AWAITING_PLATE_CLEAR_STATUSES, *FINAL_STATUSES)
            ended = job or await find_job(db, printer_id, identity, terminal)
            if ended is not None and ended.status in terminal:
                return None
        if job is None:
            return None
        job_id = job.id
        await printing.end(db, job, data, memory=print_memory)
        await db.commit()
        completion = effects.spawned(db)
    return job_id, completion


async def printer_status(printer_id: int, state) -> None:
    """Telemetry: wake the lifecycle loop when a printer connects or disconnects, for recovery to run at once.

    MQTT's connect broadcast still carries construction defaults (state
    "unknown"), so a connection counts from the first real report (#1679).
    """
    known = bool(state.state) and state.state.upper() not in ("", "UNKNOWN")
    if state.connected and known and getattr(state, "job_telemetry_ready", False):
        deadlines.wake()


async def reconcile_print_archives() -> None:
    """Retry Archive acquisition for started jobs using their durable source identity."""
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
                    PrintQueueItem.source_filename,
                )
                .join(Printer, Printer.id == PrintQueueItem.printer_id)
                .where(
                    PrintQueueItem.archive_id.is_(None),
                    PrintQueueItem.started_at.is_not(None),
                    Printer.auto_archive.is_(True),
                    PrintQueueItem.status.not_in(("queued", "preheating", "dispatching")),
                )
            )
        ).all()
    for job in jobs:
        live = printer_manager.get_status(job.printer_id)
        matching_live = bool(
            live and live.connected and live.job_telemetry_ready and telemetry_identity(live) == job.dispatch_subtask_id
        )
        filename = (live.gcode_file or live.current_print) if matching_live else None
        filename = filename or job.source_filename
        if not filename or not job.dispatch_subtask_id:
            continue
        data = {
            "submission_id": job.dispatch_subtask_id,
            "filename": filename,
            "subtask_name": live.subtask_name if matching_live else job.source_filename,
            "raw_data": dict(live.raw_data or {}) if matching_live else {},
            "ams_mapping": printing.job_ams_mapping(job.ams_mapping, None),
            "plate_id": job.plate_id,
            "owner_id": job.created_by_id,
        }
        try:
            await print_effects._archive_print_start(job.printer_id, data, queue_job_id=job.id, memory=print_memory)
            await print_effects._link_observed_archive(job.printer_id, job.id, job.dispatch_subtask_id)
        except Exception:
            logger.exception("Archive reconciliation failed for Queue job %s", job.id)

"""Dispatching (#204): reserve, copy, link, upload and send; confirm the attempt or hold it for review."""

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import and_, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from backend.app.core.config import settings
from backend.app.core.database import async_session, run_with_retry
from backend.app.core.tasks import spawn_background_task
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import HOLDING_STATUSES, PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.schemas.print_queue import PrintQueueItemUpdate
from backend.app.services.bambu_ftp import (
    UploadCancelled,
    cache_3mf_download,
    delete_file_async,
    ftps_handshake_cooloff_deadline,
    get_ftp_retry_settings,
    upload_file_async,
    with_ftp_retry,
)
from backend.app.services.job_identity import sync_print_state, telemetry_identity
from backend.app.services.lifecycle import effects
from backend.app.services.lifecycle.engine import (
    InvalidQueueTransition,
    QueueTransitionConflict,
    lock_queue_item,
    transition_queue_item,
)
from backend.app.services.lifecycle.preheating import abort_heat_soak, request_heater_shutdown
from backend.app.services.notification_service import notification_service
from backend.app.services.printer_manager import printer_manager
from backend.app.services.printer_selection import (
    _incompatible_sliced_model_reason,
    _installed_nozzle_diameters,
    _nozzle_mismatch_message,
    _rack_nozzle_diameters,
    _sliced_for_model,
)

logger = logging.getLogger(__name__)

# Bambu firmware states that mean the project_file has actually been accepted
_ACTIVE_PRINT_STATES: frozenset[str] = frozenset({"PREPARE", "SLICING", "RUNNING", "PAUSE"})
DISPATCH_TELEMETRY_WAIT_SECONDS = 30
_WAITING_FOR_DRYING_MESSAGE = "Waiting for AMS drying to complete"
_STOPPING_DRYING_MESSAGE = "Stopping AMS drying before dispatch"
_DRYING_STOP_FAILED_MESSAGE = "Unable to stop AMS drying; waiting to retry"
_DRYING_WAITING_MESSAGES: frozenset[str] = frozenset(
    {
        _WAITING_FOR_DRYING_MESSAGE,
        _STOPPING_DRYING_MESSAGE,
        _DRYING_STOP_FAILED_MESSAGE,
    }
)
_DISPATCH_REVIEW_MESSAGE = (
    "Printer did not provide a correlated active-state confirmation; "
    "dispatch held for manual review to avoid a duplicate print."
)


def _queue_status_from_dispatch_telemetry(printer_status, dispatch_subtask_id: str | None) -> str | None:
    """Map telemetry for this exact dispatch to its queue lifecycle state."""
    expected_id = str(dispatch_subtask_id).strip() if dispatch_subtask_id is not None else ""
    reported_id = telemetry_identity(printer_status) if printer_status else None
    if not expected_id or expected_id == "0" or reported_id != expected_id:
        return None

    state = getattr(printer_status, "state", None)
    if state in _ACTIVE_PRINT_STATES:
        return "printing"
    return {"FINISH": "completed", "FAILED": "failed"}.get(state, "dispatching")


# A soak owns the heaters while preheating, and until its dispatch is sent.
SOAKING = or_(
    PrintQueueItem.status == "preheating",
    and_(
        PrintQueueItem.status == "dispatching",
        PrintQueueItem.chamber_heat_soak.is_(True),
        PrintQueueItem.dispatch_subtask_id.is_(None),
    ),
)


def is_soaking(item: PrintQueueItem) -> bool:
    return item.status == "preheating" or (
        item.status == "dispatching" and bool(item.chamber_heat_soak) and item.dispatch_subtask_id is None
    )


_EDITABLE_FIELDS = tuple(name for name in PrintQueueItemUpdate.model_fields if name in PrintQueueItem.__table__.columns)


@dataclass(frozen=True, slots=True)
class _DispatchBinding:
    """A selection decision handed to its dispatch worker."""

    printer_id: int
    ams_mapping: str | None
    unassigned: bool
    selected: tuple[tuple[str, object], ...] = ()

    @classmethod
    def for_item(cls, item: PrintQueueItem, printer_id: int, ams_mapping: str | None, *, unassigned: bool):
        selected = tuple((name, getattr(item, name)) for name in _EDITABLE_FIELDS if hasattr(item, name))
        return cls(printer_id, ams_mapping, unassigned, selected)

    def values(self) -> dict[str, int | str | None]:
        return {"printer_id": self.printer_id, "ams_mapping": self.ams_mapping}

    def edited_fields(self, item: PrintQueueItem) -> list[str]:
        return [name for name, value in self.selected if getattr(item, name) != value]


def _bind_in_memory(item: PrintQueueItem, printer_id: int | None, ams_mapping: str | None) -> None:
    """Evaluate a pool job against one printer without persisting the choice."""
    set_committed_value(item, "printer_id", printer_id)
    set_committed_value(item, "ams_mapping", ams_mapping)


async def _defer_incompatible_dispatch(
    db: AsyncSession,
    item: PrintQueueItem,
    printer,
    sliced_for_model: str | None,
    *,
    heat_soak_complete: bool = False,
    remote_path: str | None = None,
    ftp_timeout: int | None = None,
) -> bool:
    """Keep an incompatible job pending and clean up a file already uploaded."""
    reason = _incompatible_sliced_model_reason(sliced_for_model, printer)
    if not reason:
        return False

    current = await lock_queue_item(db, item.id)
    if heat_soak_complete:
        owns_handoff = bool(
            current
            and current.status == "dispatching"
            and current.preheat_owner is None
            and current.dispatch_subtask_id is None
        )
    else:
        owns_handoff = bool(current and current.status in ("queued", "dispatching"))

    failed_handoff = owns_handoff and current.status == "dispatching"
    if owns_handoff:
        if current.status == "queued":
            current.waiting_reason = reason
        else:
            await transition_queue_item(
                db,
                current,
                current.status,
                "failed",
                values={"error_message": reason, "completed_at": datetime.now(timezone.utc)},
            )
        await db.commit()
    else:
        await db.rollback()

    # A committed failed transition handles its own SD copy. A lost claim
    # still needs immediate cleanup because another state won the race.
    if remote_path and not failed_handoff:
        try:
            await delete_file_async(
                printer.ip_address,
                printer.access_code,
                remote_path,
                socket_timeout=ftp_timeout,
                printer_model=printer.model,
                respect_handshake_cooloff=False,
            )
        except Exception as cleanup_error:
            logger.warning(
                "Queue item %s: failed to remove incompatible uploaded file %s: %s",
                item.id,
                remote_path,
                cleanup_error,
            )

    logger.info("Queue item %s: dispatch deferred - %s", item.id, reason)
    return True


class Dispatcher:
    """Dispatch workers and recovery, exposed through the scheduler until intake replaces its tick."""

    def __init__(self):
        super().__init__()
        self._terminal_dispatch_recoveries: set[int] = set()
        self._recovery_started_at: datetime | None = None
        self._inflight: dict[int, tuple[asyncio.Task, int | None]] = {}
        self._visible_unsent: set[int] = set()

    def cancel_inflight(self, item_id: int) -> bool:
        """Cancel a worker after its queue row has been cancelled or deleted."""
        entry = self._inflight.get(item_id)
        if not entry:
            return False
        task, _printer_id = entry
        if task.done():
            return False
        task.cancel()
        return True

    async def wait_unsent(self, db: AsyncSession) -> None:
        """Watch unsent soak handoffs with their existing heartbeat and recovery policy."""
        from backend.app.services.lifecycle.preheating import HEARTBEAT_TIMEOUT, _show_preheating, utcnow

        ids = list(
            await db.scalars(
                select(PrintQueueItem.id).where(
                    PrintQueueItem.status == "dispatching",
                    PrintQueueItem.chamber_heat_soak.is_(True),
                    PrintQueueItem.dispatch_subtask_id.is_(None),
                )
            )
        )
        visible = set()
        for item_id in ids:
            try:
                item = await lock_queue_item(db, item_id)
                if not item or not is_soaking(item) or item.status != "dispatching":
                    await db.rollback()
                    continue
                elapsed = (
                    (utcnow() - item.preheat_checked_at).total_seconds()
                    if item.preheat_checked_at
                    else HEARTBEAT_TIMEOUT
                )
                if item.preheat_owner != self._heat_soak.owner:
                    if 0 <= elapsed < HEARTBEAT_TIMEOUT:
                        await db.rollback()
                        continue
                    item.error_message = "Heat soak interrupted; inspect the printer, then stop or skip heat soak"
                    _show_preheating(item.printer_id, True)
                    visible.add(item.printer_id)
                    await db.commit()
                elif elapsed < 0 or elapsed >= HEARTBEAT_TIMEOUT:
                    await abort_heat_soak(
                        db, item, "Heat soak interrupted by restart or scheduler timeout; retry required"
                    )
                else:
                    await db.rollback()
            except Exception:
                await db.rollback()
                logger.exception("Queue item %s: unsent dispatch recovery failed", item_id)
        for printer_id in self._visible_unsent - visible:
            _show_preheating(printer_id, False)
        self._visible_unsent = visible

    async def _clear_stale_dispatch_claims(self) -> None:
        """Settle unsent attempts and release the previous process's claims."""
        try:
            async with async_session() as db:
                unsent = list(
                    await db.scalars(
                        select(PrintQueueItem).where(
                            PrintQueueItem.status == "dispatching",
                            PrintQueueItem.dispatch_subtask_id.is_(None),
                            PrintQueueItem.dispatched_at.is_(None),
                        )
                    )
                )
                for item in unsent:
                    await self._transition_or_skip(
                        db,
                        item,
                        "failed",
                        error_message="Dispatch interrupted before print command; retry required",
                        completed_at=datetime.now(timezone.utc),
                    )
                result = await db.execute(
                    update(PrintQueueItem).where(PrintQueueItem.dispatching_at.is_not(None)).values(dispatching_at=None)
                )
                await db.commit()
                if result.rowcount:
                    logger.info("Cleared %d stale queue dispatch claim(s)", result.rowcount)
        except Exception:
            logger.exception("Failed to clear stale queue dispatch claims")

    async def _recover_stale_dispatches(self, db: AsyncSession) -> None:
        """Reconcile durable dispatches left behind by a restart."""
        result = await db.execute(
            select(PrintQueueItem).where(PrintQueueItem.status.in_(("dispatching", "printing", "paused")))
        )
        dispatches = list(result.scalars().all())
        if not dispatches:
            return

        now = datetime.now(timezone.utc)
        stale_before = now.timestamp() - 270
        changed = False
        terminal_dispatches: list[tuple[int, int, dict]] = []
        for item in dispatches:
            if item.status == "dispatching" and item.dispatching_at is not None:
                continue  # A live preparation worker still owns this attempt.
            if item.status == "dispatching" and item.dispatched_at is None and not item.dispatch_subtask_id:
                # Startup already settled interrupted workers. A live-process
                # telemetry timeout leaves an unsent hold for Stop and Retry.
                continue
            if item.status == "dispatching" and self._recovery_started_at and item.dispatched_at:
                sent = item.dispatched_at.replace(tzinfo=timezone.utc)
                if sent >= self._recovery_started_at and (now - sent).total_seconds() < 270:
                    continue  # Live acknowledgement owns fresh dispatches.
            printer_status = printer_manager.get_status(item.printer_id) if item.printer_id is not None else None
            if printer_status and (
                not getattr(printer_status, "connected", False)
                or not getattr(printer_status, "job_telemetry_ready", True)
            ):
                printer_status = None
            dispatch_subtask_id = str(item.dispatch_subtask_id).strip() if item.dispatch_subtask_id else None
            telemetry_status = _queue_status_from_dispatch_telemetry(printer_status, dispatch_subtask_id)

            # A print can reach FINISH or FAILED while Grove Control is down.
            terminal_status = getattr(printer_status, "state", None) if printer_status else None
            if telemetry_status in ("completed", "failed"):
                # Commit the terminal observation before starting the normal
                # completion side effects. A process stop after this point must
                # not turn a printer-confirmed terminal job back into a retry.
                if telemetry_status == "completed" and item.status == "dispatching":
                    if not await self._transition_or_skip(db, item, "printing", started_at=now):
                        continue
                if not await self._transition_or_skip(
                    db,
                    item,
                    "finished" if telemetry_status == "completed" else telemetry_status,
                    action="printer_report",
                    completed_at=now,
                ):
                    continue
                changed = True
                filename = getattr(printer_status, "gcode_file", None)
                if not filename and item.archive_id is not None:
                    archive = await db.get(PrintArchive, item.archive_id)
                    filename = archive.filename if archive else None
                raw_data = dict(getattr(printer_status, "raw_data", None) or {})
                # Use the id we just matched rather than an incomplete terminal
                # push (some firmwares send subtask_id=0 at FINISH/FAILED).
                raw_data["subtask_id"] = dispatch_subtask_id
                terminal_dispatches.append(
                    (
                        item.id,
                        item.printer_id,
                        {
                            "status": telemetry_status,
                            "filename": filename or f"queue-dispatch-{item.id}",
                            "subtask_name": "",
                            "subtask_id": dispatch_subtask_id,
                            "raw_data": raw_data,
                            "_reconciled": True,
                            "_recovered_dispatch": True,
                        },
                    )
                )
                logger.info(
                    "Recovered terminal queue dispatch %s from %s telemetry",
                    item.id,
                    terminal_status,
                )
                continue

            if telemetry_status == "printing":
                if item.status == "dispatching":
                    if not await self._transition_or_skip(db, item, "printing", started_at=now, error_message=None):
                        continue
                    changed = True
                    effects.queue_job_started(
                        db,
                        item.id,
                        publish=self._publish_queue_job_started,
                        spawn=spawn_background_task,
                        background=True,
                    )
                    logger.info("Recovered dispatched queue item %s as printer-confirmed printing", item.id)
                try:
                    changed = await sync_print_state(db, item, printer_status) or changed
                except QueueTransitionConflict:
                    continue
                continue

            if item.status != "dispatching":
                continue
            dispatched_at = item.dispatched_at
            if dispatched_at is not None:
                if dispatched_at.tzinfo is None:
                    dispatched_at = dispatched_at.replace(tzinfo=timezone.utc)
                is_stale = dispatched_at.timestamp() <= stale_before
            else:
                # Rows from an interrupted upgrade have no attempt timestamp;
                # surface them for manual review immediately.
                is_stale = True
            if is_stale:
                if item.error_message != _DISPATCH_REVIEW_MESSAGE:
                    item.error_message = _DISPATCH_REVIEW_MESSAGE
                    changed = True
                    logger.warning(
                        "Holding stale unconfirmed queue dispatch %s for manual review (printer state=%s)",
                        item.id,
                        terminal_status,
                    )

        if changed:
            await db.commit()
        for queue_item_id, printer_id, completion_data in terminal_dispatches:
            if queue_item_id in self._terminal_dispatch_recoveries:
                continue
            self._terminal_dispatch_recoveries.add(queue_item_id)
            spawn_background_task(
                self._complete_recovered_dispatch(queue_item_id, printer_id, completion_data),
                name=f"complete-recovered-queue-dispatch-{queue_item_id}",
            )

    async def _complete_recovered_dispatch(self, queue_item_id: int, printer_id: int, completion_data: dict) -> None:
        """Finish a terminal dispatch without delaying unrelated queue checks."""
        try:
            from backend.app.main import on_print_complete

            await on_print_complete(printer_id, completion_data)
        finally:
            self._terminal_dispatch_recoveries.discard(queue_item_id)

    def _launch_uploads(
        self,
        item_ids: list[int],
        item_printers: dict[int, int | None],
        limit: int,
        bindings: dict[int, _DispatchBinding] | None = None,
    ) -> None:
        """Launch independent queue workers into the bounded upload pool."""
        bindings = bindings or {}
        occupied_printers = {printer_id for _task, printer_id in self._inflight.values() if printer_id is not None}
        candidates: list[int] = []
        reserved_printers = set(occupied_printers)
        for item_id in item_ids:
            if item_id in self._inflight:
                continue
            printer_id = item_printers.get(item_id)
            if printer_id is not None and printer_id in reserved_printers:
                logger.info(
                    "Queue item %s waiting for printer reservation %s; another dispatch is active",
                    item_id,
                    printer_id,
                )
                continue
            if printer_id is not None:
                reserved_printers.add(printer_id)
            candidates.append(item_id)

        free = max(0, limit - len(self._inflight))
        if free <= 0:
            return

        for item_id in candidates[:free]:
            task = spawn_background_task(
                self._dispatch_one(item_id, item_printers.get(item_id), binding=bindings.get(item_id)),
                name=f"queue-upload-{item_id}",
            )
            self._inflight[item_id] = (task, item_printers.get(item_id))
            task.add_done_callback(lambda _task, queue_item_id=item_id: self._inflight.pop(queue_item_id, None))

    async def _dispatch_one(
        self,
        item_id: int,
        selected_printer_id: int | None = None,
        *,
        binding: _DispatchBinding | None = None,
        from_state: str = "queued",
    ) -> None:
        """Run one entry worker with its own session and release its claim on every outcome."""
        async with async_session() as db:
            soaking = from_state == "preheating"
            if soaking:
                item = await lock_queue_item(db, item_id)
                if not item or item.status != "dispatching" or item.preheat_owner != self._heat_soak.owner:
                    await db.rollback()
                    return
                item.preheat_owner = None
                item.dispatching_at = datetime.now(timezone.utc)
                await db.commit()
            else:
                pool = binding is not None and binding.unassigned
                if not await self._claim_for_dispatch(db, item_id, selected_printer_id, pool=pool):
                    return
            try:
                item = await db.get(PrintQueueItem, item_id)
                if not item or (binding is not None and binding.edited_fields(item)):
                    return
                current_task = asyncio.current_task()
                if current_task is not None and item_id in self._inflight:
                    self._inflight[item_id] = (current_task, binding.printer_id if binding else item.printer_id)
                options = {"heat_soak_complete": True} if soaking else {"binding": binding}
                await self._start_print(db, item, **options)
            except asyncio.CancelledError:
                await self._cleanup_unsent_dispatch_upload(db, item_id)
                raise
            except QueueTransitionConflict:
                await db.rollback()
                logger.info("Queue item %s changed while dispatch was in progress", item_id)
            except Exception:
                await db.rollback()
                logger.exception("Dispatch worker failed for job %s", item_id)
                await self._recover_failed_worker(db, item_id)
            finally:
                if soaking:
                    await db.rollback()
                    item = await lock_queue_item(db, item_id)
                    if item and item.status == "dispatching" and not item.dispatch_subtask_id and not item.archive_id:
                        await abort_heat_soak(
                            db, item, item.error_message or "Heat-soak dispatch interrupted; retry required"
                        )
                await self._clear_dispatch_claim(db, item_id)

    async def _cleanup_unsent_dispatch_upload(self, db: AsyncSession, item_id: int) -> None:
        """The FTP wrapper has drained its worker; remove only an unsent attempt."""
        try:
            await db.rollback()
            job = await db.get(PrintQueueItem, item_id, populate_existing=True)
            if (
                job is None
                or job.status not in ("dispatching", "cancelled", "unsuccessful")
                or job.dispatched_at is not None
                or job.started_at is not None
            ):
                return  # A persisted send boundary leaves delivery uncertain.
            attempt = await db.get(PrintArchive, job.archive_id) if job.archive_id else None
            printer = await db.get(Printer, job.printer_id) if job.printer_id else None
            remote_name = (attempt.extra_data or {}).get("remote_filename") if attempt else None
            if not printer or not remote_name or attempt.dispatched_queue_item_id != item_id:
                return
            connection = (printer.ip_address, printer.access_code, printer.model)
            await db.commit()  # Keep the worker claim, release the read transaction.
            await delete_file_async(connection[0], connection[1], f"/{remote_name}", printer_model=connection[2])
        except Exception:
            await db.rollback()
            logger.exception("Queue item %s: cancelled-upload cleanup failed", item_id)

    async def _recover_failed_worker(self, db: AsyncSession, item_id: int) -> None:
        """Settle a job after an unexpected worker error, by where it got to."""
        try:
            item = await lock_queue_item(db, item_id)
            if item is None:
                return
            if item.status == "queued":
                await self._keep_queued(
                    db, item, "Dispatch preparation failed; check the logs, then start it again", park=True
                )
            elif item.status == "preheating":
                await abort_heat_soak(db, item, "Heat soak failed to start; inspect the printer before retrying")
            elif item.status == "dispatching":
                await self._fail_queue_item(db, item, "Dispatch failed; inspect the printer before retrying")
            else:
                await db.rollback()
        except QueueTransitionConflict:
            await db.rollback()
            logger.info("Queue item %s changed while recovering a failed dispatch worker", item_id)
        except Exception:
            await db.rollback()
            logger.exception("Could not settle queue item %s after a dispatch worker failure", item_id)

    async def _keep_queued(self, db: AsyncSession, item: PrintQueueItem, reason: str, *, park: bool = False) -> None:
        """Leave a job in the pool with a display-only reason; nothing is held."""
        values: dict[str, str | bool] = {"waiting_reason": reason}
        if park:
            values["manual_start"] = True
        conditions = () if item.dispatching_at is None else (PrintQueueItem.dispatching_at == item.dispatching_at,)
        await transition_queue_item(db, item, "queued", "queued", values=values, conditions=conditions)
        await db.commit()
        logger.info("Queue item %s stays queued: %s", item.id, reason)

    async def _notify_pool_assignment(self, db: AsyncSession, item: PrintQueueItem) -> None:
        """Announce the printer an "Any machine" job was bound to on leaving the queue."""
        try:
            job_name = await self._get_job_name(db, item)
            printer = await self._get_printer(db, item.printer_id)
            await notification_service.on_queue_job_assigned(
                job_name=job_name,
                printer_id=item.printer_id,
                printer_name=printer.name if printer else "Unknown",
                target_model=item.target_model,
                db=db,
            )
        except Exception:
            # The hold is committed; a notification failure must not fail it.
            logger.warning("Could not send assignment notification for queue item %s", item.id, exc_info=True)

    async def _abandon_attempt(self, db: AsyncSession, item: PrintQueueItem, reason: str, *, park: bool) -> None:
        """Stop before sending: keep a queued job in the pool, or fail a held attempt."""
        if item.status == "queued":
            await self._keep_queued(db, item, reason, park=park)
            return
        await self._fail_queue_item(db, item, reason)

    async def _claim_for_dispatch(
        self,
        db: AsyncSession,
        item_id: int,
        selected_printer_id: int | None = None,
        *,
        pool: bool = False,
    ) -> bool:
        """Atomically claim a pending row without accepting reassignment races."""
        claim = (
            update(PrintQueueItem)
            .where(PrintQueueItem.id == item_id)
            .where(PrintQueueItem.status == "queued")
            .where(PrintQueueItem.dispatching_at.is_(None))
        )
        if pool:
            claim = claim.where(PrintQueueItem.printer_id.is_(None))
        elif selected_printer_id is not None:
            claim = claim.where(PrintQueueItem.printer_id == selected_printer_id)
        result = await db.execute(claim.values(dispatching_at=datetime.now(timezone.utc)))
        await db.commit()
        return result.rowcount > 0

    async def _clear_dispatch_claim(self, db: AsyncSession, item_id: int) -> None:
        """Release a worker claim without changing the queue lifecycle state."""
        try:
            await db.execute(update(PrintQueueItem).where(PrintQueueItem.id == item_id).values(dispatching_at=None))
            await db.commit()
        except Exception:
            logger.exception("Failed to clear dispatch claim for queue item %s", item_id)

    def _dispatch_telemetry(self, printer_id: int, previous_id: str | None) -> bool | None:
        """True: ready; False: new activity; None: current telemetry is missing."""
        state = printer_manager.get_status(printer_id)
        if not state or not state.connected or not getattr(state, "job_telemetry_ready", False):
            return None
        current_id = telemetry_identity(state)
        if state.state in ("PREPARE", "SLICING", "RUNNING", "PAUSE") or (
            previous_id and current_id and current_id != previous_id
        ):
            return False
        return True if self._is_printer_idle(printer_id) else None

    async def _wait_for_dispatch_telemetry(
        self, printer_id: int, previous_id: str | None, *, deadline: float | None = None
    ) -> bool | None:
        """Wait through a brief reconnect; silence never proves a failed print."""
        loop = asyncio.get_running_loop()
        if deadline is None:
            deadline = loop.time() + DISPATCH_TELEMETRY_WAIT_SECONDS
        while True:
            ready = self._dispatch_telemetry(printer_id, previous_id)
            if ready is not None or loop.time() >= deadline:
                return ready
            await asyncio.sleep(min(0.5, max(0, deadline - loop.time())))

    def _is_printer_idle(self, printer_id: int, require_plate_clear: bool = True) -> bool:
        """A fresh, connected idle report and the plate-clear gate permit dispatch."""
        if not printer_manager.is_connected(printer_id):
            return False
        state = printer_manager.get_status(printer_id)
        return bool(
            state
            and state.connected
            and getattr(state, "job_telemetry_ready", False)
            and not (require_plate_clear and printer_manager.is_awaiting_plate_clear(printer_id))
            and state.state in ("IDLE", "FINISH", "FAILED")
        )

    async def _prepare_drying_for_dispatch(
        self,
        db: AsyncSession,
        item: PrintQueueItem,
        printer_id: int,
        *,
        active_ams_ids: tuple[int, ...] | None = None,
        release_dispatch_reservation: bool = False,
    ) -> bool:
        """Apply a queue item's drying policy before any print command is sent."""
        if active_ams_ids is None:
            active_ams_ids = self._active_drying_ams_ids(printer_id)
        if not active_ams_ids:
            if item.waiting_reason in _DRYING_WAITING_MESSAGES:
                item.waiting_reason = None
                await db.commit()
            return True

        wait_for_natural_completion = bool(getattr(item, "wait_for_drying_complete", False))
        if wait_for_natural_completion:
            waiting_reason = _WAITING_FOR_DRYING_MESSAGE
        else:
            stopped = await self._stop_drying(printer_id)
            waiting_reason = _STOPPING_DRYING_MESSAGE if stopped else _DRYING_STOP_FAILED_MESSAGE

        needs_commit = False
        if release_dispatch_reservation or item.status == "dispatching":
            await transition_queue_item(
                db,
                item,
                item.status,
                "failed",
                values={"error_message": waiting_reason, "completed_at": datetime.now(timezone.utc)},
            )
            item.dispatched_at = None
            item.dispatch_subtask_id = None
            item.started_at = None
            needs_commit = True
        if item.waiting_reason != waiting_reason:
            item.waiting_reason = waiting_reason
            needs_commit = True
        if needs_commit:
            await db.commit()
        logger.info(
            "Queue item %s waiting on printer %s AMS drying (%s; active AMS ids=%s)",
            item.id,
            printer_id,
            "natural completion" if wait_for_natural_completion else "stop requested",
            active_ams_ids,
        )

        return False

    async def _fail_queue_item(self, db: AsyncSession, item: PrintQueueItem, message: str, **values) -> None:
        """Commit a dispatch failure; the transition emits effects after commit."""
        await transition_queue_item(
            db,
            item,
            item.status,
            "failed",
            values={"error_message": message, "completed_at": datetime.now(timezone.utc), **values},
        )
        await db.commit()

    async def _transition_or_skip(
        self, db: AsyncSession, item: PrintQueueItem, status: str, *, action: str | None = None, **values
    ) -> bool:
        """Apply one item's transition within a scheduler pass."""
        try:
            await transition_queue_item(db, item, item.status, status, values=values, action=action)
        except QueueTransitionConflict:
            logger.info("Queue item %s changed concurrently; skipping it this pass", item.id)
            return False
        return True

    async def _propagate_owner_to_printer_manager(self, db: AsyncSession, item: PrintQueueItem) -> None:
        """Hand the queue item's owner to printer_manager so the"""
        if not item.created_by_id:
            return
        from backend.app.models.user import User

        owner = await db.get(User, item.created_by_id)
        if owner:
            printer_manager.set_current_print_user(item.printer_id, owner.id, owner.username)

    async def _dispatch_after_heat_soak(self, item_id: int) -> None:
        await self._dispatch_one(item_id, from_state="preheating")

    async def enter(
        self,
        db: AsyncSession,
        item: PrintQueueItem,
        *,
        heat_soak_complete: bool = False,
        binding: _DispatchBinding | None = None,
        from_state: str = "queued",
    ):
        """Upload file and start print for a queue item."""
        heat_soak_complete = heat_soak_complete or from_state == "preheating"

        if binding is not None and not heat_soak_complete:
            # Checks before the hold read the chosen printer and mapping; only
            # the hold transition writes them to the job.
            _bind_in_memory(item, binding.printer_id, binding.ams_mapping)

        if heat_soak_complete:
            item = await lock_queue_item(db, item.id)
            if (
                not item
                or item.status != "dispatching"
                or item.preheat_owner is not None
                or item.dispatch_subtask_id is not None
            ):
                await db.rollback()
                return
            # Release the handoff lock before slow Archive and FTP work.
            await db.commit()

        # Get printer first (needed for both paths)
        result = await db.execute(select(Printer).where(Printer.id == item.printer_id))
        printer = result.scalar_one_or_none()
        if not printer:
            await self._abandon_attempt(db, item, "Printer not found", park=False)
            return

        # Check printer is connected. A disconnected printer is simply not
        # available: the job waits in the pool rather than failing onto it.
        if item.status == "queued" and not printer_manager.is_connected(item.printer_id):
            await self._abandon_attempt(db, item, "Printer not connected", park=False)
            return

        if not heat_soak_complete:
            holding = await db.scalar(
                select(PrintQueueItem.id)
                .where(
                    PrintQueueItem.printer_id == item.printer_id,
                    PrintQueueItem.status.in_(HOLDING_STATUSES),
                    PrintQueueItem.id != item.id,
                )
                .limit(1)
            )
            if holding is not None:
                return

        # Determine source: archive or library file
        archive = None
        library_file = None

        if item.archive_id:
            # Print from archive
            result = await db.execute(
                select(PrintArchive).where(PrintArchive.id == item.archive_id).execution_options(populate_existing=True)
            )
            archive = result.scalar_one_or_none()
            if not archive or archive.deleted_at is not None:
                await self._abandon_attempt(
                    db, item, "Archive source was deleted" if archive else "Archive not found", park=True
                )
                return

        elif item.library_file_id:
            # Print from library file (file manager)
            result = await db.execute(LibraryFile.active().where(LibraryFile.id == item.library_file_id))
            library_file = result.scalar_one_or_none()
            if not library_file:
                await self._abandon_attempt(db, item, "Library file not found", park=True)
                return

        else:
            # Neither archive nor library file specified
            await self._abandon_attempt(db, item, "No source file specified", park=True)
            return

        if await _defer_incompatible_dispatch(
            db, item, printer, _sliced_for_model(archive, library_file), heat_soak_complete=heat_soak_complete
        ):
            return
        source = archive or library_file
        file_path, filename = settings.base_dir / source.file_path, source.filename

        # Check file exists on disk
        if not file_path.exists():
            await self._abandon_attempt(db, item, "Source file not found on disk", park=True)
            return

        # Reject only a positive nozzle mismatch before heating or uploading (#1899).
        library_metadata = library_file.file_metadata if library_file and library_file.file_metadata else {}
        sliced_nozzle = archive.nozzle_diameter if archive else library_metadata.get("nozzle_diameter")
        if sliced_nozzle:
            nozzle_status = printer_manager.get_status(item.printer_id)
            installed = _installed_nozzle_diameters(nozzle_status)
            rack = _rack_nozzle_diameters(nozzle_status)
            mismatch_msg = _nozzle_mismatch_message(sliced_nozzle, installed, rack)
            if mismatch_msg:
                if item.status == "queued":
                    item.waiting_reason = mismatch_msg
                    await db.commit()
                else:
                    await self._fail_queue_item(db, item, mismatch_msg)
                return

        if getattr(item, "chamber_heat_soak", False) is True and not heat_soak_complete:
            staged = await self._heat_soak.enter(
                db,
                item,
                bind_values=binding.values() if binding is not None else None,
                unassigned=binding is not None and binding.unassigned,
            )
            if staged and binding is not None and binding.unassigned:
                await self._notify_pool_assignment(db, item)
            return

        idle_identity_before_upload = telemetry_identity(printer_manager.get_status(item.printer_id))
        if not heat_soak_complete:
            # Commit the printer and tray binding before copying or uploading.
            item_id, printer_id = item.id, item.printer_id
            unassigned = binding is not None and binding.unassigned
            if not self._is_printer_idle(printer_id):
                return
            values = {"waiting_reason": None, **(binding.values() if binding is not None else {})}
            try:
                await transition_queue_item(
                    db,
                    item,
                    "queued",
                    "dispatching",
                    conditions=(
                        PrintQueueItem.printer_id.is_(None) if unassigned else PrintQueueItem.printer_id == printer_id,
                        PrintQueueItem.dispatching_at == item.dispatching_at,
                    ),
                    values=values,
                    dispatch_guard=lambda: self._is_printer_idle(printer_id),
                )
                await db.commit()
            except IntegrityError:
                await db.rollback()
                logger.info("Printer %s was reserved concurrently; job %s remains queued", printer_id, item_id)
                return

        # Only a held dispatch may copy. The guarded link below makes the
        # Archive durable before upload or any print command.
        if item.status != "dispatching":
            return
        from backend.app.services.queue_archive import (
            dispatch_copy_error,
            link_dispatch_archive,
            prepare_dispatch_archive,
        )

        claim_timestamp = item.dispatching_at
        held_item_id = item.id
        held_printer_id = item.printer_id
        source_archive_id = item.archive_id

        async def fail_held_copy(message: str) -> None:
            await db.rollback()  # Also discards an unlinked copy and its directory.
            held = await lock_queue_item(db, held_item_id)
            if held and held.status == "dispatching" and held.dispatching_at == claim_timestamp:
                await self._fail_queue_item(db, held, message)
            else:
                await db.rollback()

        async def dispatch_ready(*, deadline: float | None = None) -> bool:
            ready = await self._wait_for_dispatch_telemetry(
                held_printer_id, idle_identity_before_upload, deadline=deadline
            )
            if ready is True:
                return True
            await db.rollback()
            held = await lock_queue_item(db, held_item_id)
            if held and held.status == "dispatching" and held.dispatching_at == claim_timestamp:
                if ready is False:
                    await self._fail_queue_item(
                        db, held, "Printer activity changed during dispatch; inspect the printer"
                    )
                else:
                    await transition_queue_item(
                        db,
                        held,
                        "dispatching",
                        "dispatching",
                        values={
                            "error_message": "Printer telemetry unavailable; Stop and Retry to send this job",
                            "dispatched_at": None,
                            "dispatch_subtask_id": None,
                        },
                    )  # This worker has not published a command.
                    if held.chamber_heat_soak:
                        await request_heater_shutdown(db, held_printer_id)
                    await db.commit()
            else:
                await db.rollback()
            return False

        try:
            prepared = await prepare_dispatch_archive(db, item)
        except Exception as error:
            logger.exception("Queue item %s: failed to copy dispatch Archive", held_item_id)
            await fail_held_copy(dispatch_copy_error(error))
            return
        try:
            await link_dispatch_archive(
                db,
                item,
                prepared,
                conditions=(
                    PrintQueueItem.printer_id == item.printer_id,
                    PrintQueueItem.dispatching_at == claim_timestamp,
                    PrintQueueItem.archive_id.is_(None)
                    if source_archive_id is None
                    else PrintQueueItem.archive_id == source_archive_id,
                ),
            )
            await db.commit()
        except QueueTransitionConflict:
            await db.rollback()
            return
        if not heat_soak_complete and unassigned:
            await self._notify_pool_assignment(db, item)
        archive = await db.get(PrintArchive, item.archive_id) if item.archive_id else None
        if archive is None or archive.dispatched_queue_item_id != item.id:
            await self._fail_queue_item(db, item, "Dispatch Archive is missing; inspect and retry")
            return
        file_path = settings.base_dir / archive.file_path
        filename = archive.filename
        remote_filename = archive.extra_data["remote_filename"]
        remote_path = f"/{remote_filename}"

        await db.commit()
        if not await dispatch_ready():
            return

        # Get FTP retry settings
        ftp_retry_enabled, ftp_retry_count, ftp_retry_delay, ftp_timeout = await get_ftp_retry_settings()

        # Do not keep a queue transaction open across either FTP operation.
        await db.commit()

        logger.info(
            f"Queue item {item.id}: FTP upload starting - printer={printer.name} ({printer.model}), "
            f"ip={printer.ip_address}, file={remote_filename}, local_path={file_path}, "
            f"retry_enabled={ftp_retry_enabled}, retry_count={ftp_retry_count}, timeout={ftp_timeout}"
        )

        cooloff_before = ftps_handshake_cooloff_deadline(printer.ip_address)

        # Delete existing file if present (avoids 553 error on overwrite)
        try:
            logger.debug("Queue item %s: Deleting existing file %s if present...", item.id, remote_path)
            delete_result = await delete_file_async(
                printer.ip_address,
                printer.access_code,
                remote_path,
                socket_timeout=ftp_timeout,
                printer_model=printer.model,
                respect_handshake_cooloff=False,
            )
            logger.debug("Queue item %s: Delete result: %s", item.id, delete_result)
        except Exception as e:
            logger.debug("Queue item %s: Delete failed (may not exist): %s", item.id, e)

        upload_error: str | None = None
        try:
            if ftp_retry_enabled:
                uploaded = await with_ftp_retry(
                    upload_file_async,
                    printer.ip_address,
                    printer.access_code,
                    file_path,
                    remote_path,
                    socket_timeout=ftp_timeout,
                    printer_model=printer.model,
                    respect_handshake_cooloff=False,
                    cooloff_ip=None,
                    max_retries=ftp_retry_count,
                    retry_delay=ftp_retry_delay,
                    operation_name=f"Upload print to {printer.name}",
                )
            else:
                uploaded = await upload_file_async(
                    printer.ip_address,
                    printer.access_code,
                    file_path,
                    remote_path,
                    socket_timeout=ftp_timeout,
                    printer_model=printer.model,
                    respect_handshake_cooloff=False,
                )
        except UploadCancelled as e:
            uploaded = False
            upload_error = (
                "Upload was too slow to finish and was cancelled. The printer's connection could not sustain "
                "the transfer — check its Wi-Fi signal, or move it closer to the access point."
            )
            logger.error("Queue item %s: upload deadline exceeded: %s", item.id, e)
        except Exception as e:
            uploaded = False
            logger.error("Queue item %s: FTP error: %s (type: %s)", item.id, e, type(e).__name__)

        if not uploaded:
            # This failed dispatch retains its Archive and printer hold.
            cooloff_after = ftps_handshake_cooloff_deadline(printer.ip_address)
            error_msg = upload_error or (
                "The printer's file service did not answer over TLS; the SD card is not involved."
                if cooloff_after is not None and cooloff_after != cooloff_before
                else (
                    "Failed to upload file to printer. Check if SD card is inserted and properly formatted (FAT32/exFAT). "
                    "See server logs for detailed diagnostics."
                )
            )
            await self._fail_queue_item(db, item, error_msg)
            logger.error(
                f"Queue item {item.id}: FTP upload failed - printer={printer.name}, model={printer.model}, "
                f"ip={printer.ip_address}. Check logs above for storage diagnostics and specific error codes."
            )

            return

        # The printer can be retargeted while a long FTP transfer is running.
        # Re-read its model immediately after upload before creating a durable
        # dispatch reservation or sending project_file.
        await db.refresh(printer, attribute_names=["model"])
        if await _defer_incompatible_dispatch(
            db,
            item,
            printer,
            _sliced_for_model(archive, library_file),
            heat_soak_complete=heat_soak_complete,
            remote_path=remote_path,
            ftp_timeout=ftp_timeout,
        ):
            return

        # Parse AMS mapping if stored
        ams_mapping = None
        if item.ams_mapping:
            try:
                ams_mapping = json.loads(item.ams_mapping)
            except json.JSONDecodeError:
                logger.warning("Queue item %s: Invalid AMS mapping JSON, ignoring", item.id)

        # Drying may have started during upload; check it again before sending.
        if not await self._prepare_drying_for_dispatch(db, item, item.printer_id):
            return

        if heat_soak_complete:
            item = await lock_queue_item(db, item.id)
            if not item or item.status != "dispatching":
                await db.rollback()
                return

        # Credit the queue owner when the print-complete callback logs the job.
        await self._propagate_owner_to_printer_manager(db, item)

        # Persist the command-sent-but-unconfirmed state before publishing MQTT.
        from secrets import randbelow

        dispatch_subtask_id = str(randbelow(2_147_483_646) + 1)
        claim_timestamp = item.dispatching_at
        dispatch_item_id, dispatch_printer_id = item.id, item.printer_id
        conditions = (PrintQueueItem.printer_id == dispatch_printer_id,)
        if claim_timestamp is not None:
            conditions += (PrintQueueItem.dispatching_at == claim_timestamp,)
        # Either conditional update can lose after upload. Capture connection
        # values before rollback expires ORM state; retain the committed Archive.
        printer_ip, printer_code, printer_model = printer.ip_address, printer.access_code, printer.model

        async def cleanup_losing_upload():
            await db.rollback()
            logger.info("Queue item %s lost its dispatch claim; cleaning up uploaded file", dispatch_item_id)
            try:
                await delete_file_async(
                    printer_ip,
                    printer_code,
                    remote_path,
                    socket_timeout=ftp_timeout,
                    printer_model=printer_model,
                )
            except Exception as cleanup_err:
                logger.debug("Queue item %s: cancelled-dispatch cleanup failed: %s", dispatch_item_id, cleanup_err)

        try:
            await transition_queue_item(
                db,
                item,
                "dispatching",
                "dispatching",
                conditions=conditions,
                values={
                    "dispatched_at": None,
                    "dispatch_subtask_id": dispatch_subtask_id,
                    "started_at": None,
                    "error_message": None,
                },
            )
            await db.commit()
        except IntegrityError:
            # The partial unique index remains the authoritative reservation guard.
            await db.rollback()
            return
        except QueueTransitionConflict:
            await cleanup_losing_upload()
            return

        # Preserve the user's timelapse choice; finish photos are independent (#1721).
        effective_timelapse = bool(item.timelapse)

        # This drying check closes the window opened by the send-boundary commit.
        command_boundary_drying = self._active_drying_ams_ids(item.printer_id)
        if command_boundary_drying:
            await self._prepare_drying_for_dispatch(
                db,
                item,
                item.printer_id,
                active_ams_ids=command_boundary_drying,
                release_dispatch_reservation=True,
            )
            printer_manager.clear_current_print_user(item.printer_id)
            return

        # Start the acknowledgement window only once upload is complete.
        await db.commit()
        if not await dispatch_ready():
            printer_manager.clear_current_print_user(dispatch_printer_id)
            return
        try:
            await transition_queue_item(
                db,
                item,
                "dispatching",
                "dispatching",
                conditions=conditions,
                values={"dispatched_at": datetime.now(timezone.utc)},
            )
            await db.commit()
        except QueueTransitionConflict:
            await cleanup_losing_upload()
            return

        # Serialize the final synchronous MQTT publish with Stop. The row lock
        # is held only across this non-awaiting command; a concurrent Stop
        # either wins first (and prevents the send) or follows it with Stop.
        deadline = asyncio.get_running_loop().time() + DISPATCH_TELEMETRY_WAIT_SECONDS
        while True:
            if not await dispatch_ready(deadline=deadline):
                printer_manager.clear_current_print_user(dispatch_printer_id)
                return
            item = await lock_queue_item(db, dispatch_item_id)
            if (
                not item
                or item.status != "dispatching"
                or item.dispatch_subtask_id != dispatch_subtask_id
                or item.printer_id != dispatch_printer_id
                or item.archive_id != archive.id
            ):
                await cleanup_losing_upload()
                return
            if self._dispatch_telemetry(dispatch_printer_id, idle_identity_before_upload) is True:
                break
            await db.rollback()  # Never wait for reconnect while holding the Stop lock.

        try:
            started = printer_manager.start_print(
                item.printer_id,
                remote_filename,
                plate_id=item.plate_id or 1,
                ams_mapping=ams_mapping,
                bed_levelling=item.bed_levelling,
                flow_cali=item.flow_cali,
                vibration_cali=item.vibration_cali,
                layer_inspect=item.layer_inspect,
                timelapse=effective_timelapse,
                use_ams=item.use_ams,
                nozzle_offset_cali=item.nozzle_offset_cali,
                nozzle_mapping=item.nozzle_mapping,
                submission_id=dispatch_subtask_id,
                display_name=filename,
            )
        except Exception:
            # A transport exception does not prove whether the printer
            # received the command. Keep this attempt linked and let the
            # normal telemetry confirmation hold it for review if necessary.
            logger.exception("Queue item %s: print command raised during dispatch", dispatch_item_id)
            await db.rollback()
            self._schedule_dispatch_confirmation(
                queue_item_id=dispatch_item_id,
                printer_id=dispatch_printer_id,
                dispatch_subtask_id=dispatch_subtask_id,
            )
            return

        if started:
            await db.rollback()  # Release the send lock; the reservation is already durable.
            logger.info("Queue item %s: Print command sent successfully - %s", dispatch_item_id, filename)

            # Register the local 3MF in the cover-cache so /cover skips FTP
            # (#1166 follow-up). file_path was resolved earlier from either the
            # archive or the library file row.
            if file_path is not None:
                cache_3mf_download(dispatch_printer_id, remote_filename, file_path)

            # Confirmation deliberately runs in the background. A slow printer
            # only reserves its own durable ``dispatching`` row; it must not
            # stall dispatches to other printers for the acknowledgement window.
            self._schedule_dispatch_confirmation(
                queue_item_id=dispatch_item_id,
                printer_id=dispatch_printer_id,
                dispatch_subtask_id=dispatch_subtask_id,
            )
        else:
            await self._fail_queue_item(
                db,
                item,
                "Failed to send print command to printer",
                dispatched_at=None,
                dispatch_subtask_id=None,
                started_at=None,
            )
            logger.error(
                f"Queue item {item.id}: Failed to start print on {printer.name} ({printer.model}) - "
                f"printer_manager.start_print() returned False. "
                f"This may indicate: printer not connected, MQTT error, unsupported model configuration, or firmware issue. "
                f"Check printer status and backend logs for details."
            )

    _start_print = enter

    def _schedule_dispatch_confirmation(
        self,
        *,
        queue_item_id: int,
        printer_id: int,
        dispatch_subtask_id: str,
    ) -> None:
        """Run acknowledgement separately so one slow printer cannot block the queue."""
        spawn_background_task(
            self._confirm_dispatch(
                queue_item_id=queue_item_id,
                printer_id=printer_id,
                dispatch_subtask_id=dispatch_subtask_id,
            ),
            name=f"confirm-queue-dispatch-{queue_item_id}",
        )

    async def resolve(self, db: AsyncSession, item: PrintQueueItem, outcome: str) -> None:
        """Apply the operator's dispatch resolution and await its committed start effects."""
        state = printer_manager.get_status(item.printer_id)
        if state and state.connected:
            observed = telemetry_identity(state)
            if (
                observed
                and observed != item.dispatch_subtask_id
                and state.state in ("RUNNING", "PAUSE", "PREPARE", "SLICING")
            ):
                raise InvalidQueueTransition(
                    "The printer reports a different job. Stop or inspect it before resolving this job."
                )
            if observed == item.dispatch_subtask_id:
                known = _queue_status_from_dispatch_telemetry(state, item.dispatch_subtask_id)
                if known in ("completed", "failed") or (known == "printing" and outcome == "failed"):
                    raise InvalidQueueTransition("Printer telemetry has confirmed this job. Refresh and retry.")
        now = datetime.now(timezone.utc)
        values = {
            "error_message": "Confirmed printing by user" if outcome == "printing" else "Printer didn't start the job"
        }
        values["started_at" if outcome == "printing" else "completed_at"] = now
        await transition_queue_item(db, item, "dispatching", outcome, values=values)
        started = (
            effects.queue_job_started(db, item.id, publish=self._publish_queue_job_started)
            if outcome == "printing"
            else []
        )
        await db.commit()
        await effects.wait_for(started)

    async def _confirm_dispatch(
        self,
        *,
        queue_item_id: int,
        printer_id: int,
        dispatch_subtask_id: str,
    ) -> None:
        """Promote a durable dispatch only after printer telemetry confirms it."""
        try:
            telemetry_status, last_status = await self._wait_for_print_start_ack(
                printer_id,
                dispatch_subtask_id=dispatch_subtask_id,
            )
        except Exception:
            logger.exception("Queue item %s: dispatch confirmation crashed", queue_item_id)
            telemetry_status, last_status = None, None
        if telemetry_status == "printing":

            async def _promote(db: AsyncSession) -> bool:
                item = await db.get(PrintQueueItem, queue_item_id)
                if not item or item.status != "dispatching":
                    return False
                try:
                    await transition_queue_item(db, item, "dispatching", "printing")
                    await sync_print_state(db, item, printer_manager.get_status(printer_id))
                except QueueTransitionConflict:
                    await db.rollback()
                    return False
                item.started_at = datetime.now(timezone.utc)
                item.error_message = None
                started = effects.queue_job_started(db, queue_item_id, publish=self._publish_queue_job_started)
                await db.commit()
                await effects.wait_for(started)
                return True

            promoted = await run_with_retry(_promote, label=f"confirm queue dispatch {queue_item_id}")
            if not promoted:
                return

            return

        if telemetry_status in ("completed", "failed"):
            # The completion callback or the next recovery pass owns terminal
            # side effects; never turn a correlated terminal print into a retry.
            return

        async def _hold_for_review(db: AsyncSession) -> bool:
            item = await db.get(PrintQueueItem, queue_item_id)
            if not item or item.status != "dispatching":
                return False
            item.error_message = _DISPATCH_REVIEW_MESSAGE
            await db.commit()
            return True

        held = await run_with_retry(_hold_for_review, label=f"hold queue dispatch {queue_item_id}")
        if not held:
            return
        if telemetry_status == "dispatching":
            logger.warning(
                "Queue item %s: printer %d received project_file but did not enter a correlated active state; "
                "held for manual review",
                queue_item_id,
                printer_id,
            )
            return

        logger.warning(
            "Queue item %s: printer %d did not confirm print command; held for manual review",
            queue_item_id,
            printer_id,
        )
        client = printer_manager.get_client(printer_id)
        if client and hasattr(client, "force_reconnect_stale_session"):
            current_state = getattr(last_status, "state", None) if last_status else None
            client.force_reconnect_stale_session(
                f"queue print command unacknowledged after dispatch (state {current_state})"
            )

    _publish_queue_job_started = staticmethod(effects.publish_queue_job_started)

    async def _wait_for_print_start_ack(
        self,
        printer_id: int,
        dispatch_subtask_id: str,
        timeout: float = 90.0,
        phase_b_timeout: float = 180.0,
        poll_interval: float = 3.0,
    ) -> tuple[str | None, object | None]:
        """Wait until a dispatched queue print reaches an active printer state."""
        last_status = None
        landed_on_subtask = False
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status = printer_manager.get_status(printer_id)
            if not status:
                await asyncio.sleep(poll_interval)
                continue
            last_status = status
            telemetry_status = _queue_status_from_dispatch_telemetry(status, dispatch_subtask_id)
            if telemetry_status == "printing":
                return telemetry_status, status
            if telemetry_status in ("dispatching", "completed", "failed"):
                # A matching ID with a terminal state can mix generations; keep polling for an active state.
                landed_on_subtask = True
                break
            await asyncio.sleep(poll_interval)

        if landed_on_subtask:
            phase_b_deadline = time.monotonic() + phase_b_timeout
            while time.monotonic() < phase_b_deadline:
                await asyncio.sleep(poll_interval)
                status = printer_manager.get_status(printer_id)
                if not status:
                    continue
                last_status = status
                telemetry_status = _queue_status_from_dispatch_telemetry(status, dispatch_subtask_id)
                if telemetry_status == "printing":
                    return telemetry_status, status

        return ("dispatching" if landed_on_subtask else None), last_status


async def on_exit(change, row) -> None:
    """A failed or stopped dispatch owns its shutdown and outcome effects."""
    if change.after in ("failed", "cancelled"):
        await effects.awaiting_outcome(change, row)

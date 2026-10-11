"""Dispatching (#204): persist each bounded copy, upload, and send stage on its job."""

import asyncio
import json
import logging
from datetime import timedelta
from secrets import randbelow

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.config import settings
from backend.app.core.database import async_session
from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.bambu_ftp import (
    UploadCancelled,
    cache_3mf_download,
    delete_file_async,
    ftps_handshake_cooloff_deadline,
    get_ftp_retry_settings,
    upload_file_async,
    with_ftp_retry,
)
from backend.app.services.job_identity import telemetry_identity
from backend.app.services.lifecycle import clock, effects, preheating, printing, queued
from backend.app.services.lifecycle.engine import (
    InvalidQueueTransition,
    QueueTransitionConflict,
    lock_queue_item,
    lock_queued_item,
    transition_queue_item,
    writer,
)
from backend.app.services.lifecycle.printing import sync_print_state
from backend.app.services.printer_manager import printer_manager
from backend.app.services.printer_selection import _incompatible_sliced_model_reason, _queue_start_waiting_reason

logger = logging.getLogger(__name__)

# Bambu firmware states that mean the project_file has actually been accepted
_ACTIVE_PRINT_STATES: frozenset[str] = frozenset({"PREPARE", "SLICING", "RUNNING", "PAUSE"})
DISPATCH_TELEMETRY_WAIT_SECONDS = 30
ACK_WINDOW = timedelta(seconds=270)  # One bound for correlated telemetry to confirm the sent command.


_DISPATCH_REVIEW_MESSAGE = (
    "Printer did not provide a correlated active-state confirmation; "
    "dispatch held for manual review to avoid a duplicate print."
)


def telemetry_status(printer_status, dispatch_subtask_id: str | None) -> str | None:
    """Map telemetry for this exact dispatch to its queue lifecycle state."""
    expected_id = str(dispatch_subtask_id).strip() if dispatch_subtask_id is not None else ""
    if not expected_id or expected_id == "0" or telemetry_identity(printer_status) != expected_id:
        return None  # Includes missing telemetry.
    state = getattr(printer_status, "state", None)
    if state in _ACTIVE_PRINT_STATES:
        return "printing"
    return {"FINISH": "completed", "FAILED": "failed"}.get(state, "dispatching")


async def fail(db: AsyncSession, item: PrintQueueItem, message: str, **values) -> None:
    """Record a failed attempt; the caller commits it with the surrounding operation."""
    values = {"error_message": message, "completed_at": clock.now(), **values}
    values.setdefault("dispatch_baseline_subtask_id", None)
    dispatched_at = values.get("dispatched_at", item.dispatched_at)
    subtask_id = values.get("dispatch_subtask_id", item.dispatch_subtask_id)
    action = "dispatch_failure" if dispatched_at is None and subtask_id is None else None
    values["dispatch_stage"] = None
    await transition_queue_item(db, item, item.status, "failed", action=action, values=values)


class Dispatcher:
    """Advance one persisted dispatch stage per bounded I/O operation."""

    def __init__(self, selection, drying):
        self._selection, self._drying = selection, drying

    def schedule_stage(self, item_id: int, printer_id: int, stage: str | None) -> None:
        """Run one persisted stage; the registry tracks only active stage I/O."""
        from backend.app.services.print_scheduler import scheduler

        if stage not in ("copying", "uploading", "uploaded"):
            return
        scheduler.workers.track_io(
            item_id,
            printer_id,
            lambda: self.run_stage(item_id, stage),
            name=f"dispatch-{stage}-{item_id}",
        )

    async def enter(
        self, db: AsyncSession, item: PrintQueueItem, from_state: str, binding: queued._DispatchBinding | None = None
    ) -> None:
        """Reserve an idle printer and persist the first stage before scheduling it."""
        if from_state != "queued":
            return
        if binding is None and item.assigned_printer_id is not None:
            binding = queued._DispatchBinding.for_item(
                item, item.assigned_printer_id, item.ams_mapping, unassigned=False
            )
        if binding is not None:
            queued._bind_in_memory(item, binding.printer_id, binding.ams_mapping)
        item_id, printer_id = item.id, item.printer_id
        unassigned = bool(binding and binding.unassigned)
        async with writer(printer_id):
            held = await lock_queued_item(db, item_id)
            if (
                not held
                or held.status != "queued"
                or _queue_start_waiting_reason(held)
                or held.assigned_printer_id != (None if unassigned else printer_id)
                or (binding and binding.edited_fields(held))
                or not self._selection._is_printer_idle(printer_id)
            ):
                await db.rollback()
                return
            values = {
                "waiting_reason": None,
                "dispatch_stage": "copying",
                "dispatch_baseline_subtask_id": telemetry_identity(printer_manager.get_status(printer_id)),
                **(binding.values() if binding else {"printer_id": printer_id}),
            }
            try:
                await transition_queue_item(db, held, "queued", "dispatching", values=values)
                await db.commit()
            except IntegrityError:
                await db.rollback()
                logger.info("Printer %s was reserved concurrently; job %s remains queued", printer_id, item_id)

    async def run_stage(self, item_id: int, expected_stage: str) -> None:
        """Run one stage and persist its result before another stage is scheduled."""
        try:
            async with async_session() as db:
                item = await db.get(PrintQueueItem, item_id)
                if item is None or item.status != "dispatching":
                    return
                stage = item.dispatch_stage
                if stage != expected_stage:
                    return
            if stage == "copying":
                await self._copy_stage(item_id)
            elif stage == "uploading":
                await self._upload_stage(item_id)
            elif stage == "uploaded":
                await self._send_stage(item_id)
        except asyncio.CancelledError:
            await self._cleanup_unsent_upload(item_id)
            raise
        except QueueTransitionConflict:
            logger.debug("Dispatch stage result for job %s was stale", item_id)
            return
        except Exception as error:
            message = f"Dispatch failed; inspect the printer before retrying: {error}"
            if expected_stage == "copying":
                from backend.app.services.queue_archive import (
                    DispatchPreparationError,
                    DispatchSourceUnavailable,
                    dispatch_copy_error,
                )

                message = dispatch_copy_error(error)
                if isinstance(error, (DispatchPreparationError, DispatchSourceUnavailable, OSError)):
                    logger.warning("Dispatch copy failed for job %s: %s", item_id, message)
                else:
                    logger.exception("Dispatch copy failed for job %s", item_id)
            else:
                logger.exception("Dispatch stage failed for job %s", item_id)
            await self._fail_unsent(item_id, message, expected_stage=expected_stage)

    async def _copy_stage(self, item_id: int) -> None:
        from backend.app.services.queue_archive import (
            discard_prepared_archive,
            link_dispatch_archive,
            prepare_dispatch_archive,
        )

        async with async_session() as db:
            snapshot = await db.get(PrintQueueItem, item_id)
            printer_id = snapshot.printer_id if snapshot is not None else None
            await db.rollback()
        if printer_id is None:
            return

        async with writer(printer_id), async_session() as db:
            item = await lock_queue_item(db, item_id)
            if not self._is_stage(item, "copying"):
                await db.rollback()
                return
            source_archive_id = item.archive_id
            archive = await prepare_dispatch_archive(db, item)
            held = await lock_queue_item(db, item_id)
            if not self._is_stage(held, "copying") or held.archive_id != source_archive_id:
                discard_prepared_archive(db, archive)
                await db.rollback()
                return
            try:
                await link_dispatch_archive(db, held, archive)
                await transition_queue_item(
                    db,
                    held,
                    "dispatching",
                    "dispatching",
                    values={"dispatch_stage": "uploading"},
                    conditions=(PrintQueueItem.dispatch_stage == "copying",),
                )
                await db.commit()
            except Exception:
                await db.rollback()
                raise
        self.schedule_stage(item_id, printer_id, "uploading")

    async def _upload_stage(self, item_id: int) -> None:
        if not await self._stage_ready_or_defer(item_id, "uploading"):
            return

        async with async_session() as db:
            item = await lock_queue_item(db, item_id)
            if not self._is_stage(item, "uploading"):
                await db.rollback()
                return
            printer = await db.get(Printer, item.printer_id)
            archive = await db.get(PrintArchive, item.archive_id) if item.archive_id else None
            if (
                printer is None
                or archive is None
                or archive.dispatched_queue_item_id != item.id
                or not archive.file_path
            ):
                await db.rollback()
                raise RuntimeError("Dispatch Archive or printer is missing")
            printer_id = item.printer_id
            ip, access_code, model = printer.ip_address, printer.access_code, printer.model
            remote_filename = (archive.extra_data or {}).get("remote_filename")
            file_path = settings.base_dir / archive.file_path
            sliced_for = archive.sliced_for_model
            archive_id = archive.id
            await db.commit()

        if not remote_filename or not ip or not access_code:
            raise RuntimeError("Printer connection or remote filename is missing")

        retry, retries, delay, timeout = await get_ftp_retry_settings()
        logger.info(
            "Queue item %s: FTP upload starting - printer=%s, file=%s, retry_enabled=%s, timeout=%s",
            item_id,
            printer_id,
            remote_filename,
            retry,
            timeout,
        )
        cooloff_before = ftps_handshake_cooloff_deadline(ip)
        connection = (ip, access_code)
        options = {"socket_timeout": timeout, "printer_model": model, "respect_handshake_cooloff": False}
        try:
            try:
                await delete_file_async(*connection, f"/{remote_filename}", **options)
            except Exception as error:
                logger.debug("Queue item %s: delete before upload failed (may not exist): %s", item_id, error)
            if retry:
                upload = with_ftp_retry(
                    upload_file_async,
                    *connection,
                    file_path,
                    f"/{remote_filename}",
                    cooloff_ip=None,
                    max_retries=retries,
                    retry_delay=delay,
                    operation_name=f"Upload print to printer {printer_id}",
                    **options,
                )
            else:
                upload = upload_file_async(*connection, file_path, f"/{remote_filename}", **options)
            uploaded = await upload
        except UploadCancelled as error:
            logger.error("Queue item %s: upload deadline exceeded: %s", item_id, error)
            await self._fail_unsent(item_id, _UPLOAD_TOO_SLOW, expected_stage="uploading")
            return
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.error("Queue item %s: FTP error: %s (type: %s)", item_id, error, type(error).__name__)
            cooloff_after = ftps_handshake_cooloff_deadline(ip)
            message = _UPLOAD_FAILED
            if cooloff_after is not None and cooloff_after != cooloff_before:
                message = "The printer's file service did not answer over TLS; the SD card is not involved."
            await self._fail_unsent(item_id, message, expected_stage="uploading")
            return
        if not uploaded:
            await self._fail_unsent(item_id, _UPLOAD_FAILED, expected_stage="uploading")
            return

        async with writer(printer_id), async_session() as db:
            item = await lock_queue_item(db, item_id)
            archive = await db.get(PrintArchive, archive_id)
            printer = await db.get(Printer, printer_id)
            if (
                not self._is_stage(item, "uploading")
                or item.archive_id != archive_id
                or archive is None
                or archive.dispatched_queue_item_id != item_id
            ):
                await db.rollback()
                await self._cleanup_unsent_upload(item_id)
                return
            if printer and (reason := _incompatible_sliced_model_reason(sliced_for, printer)):
                await fail(db, item, reason)
                await db.commit()
                return
            await transition_queue_item(
                db,
                item,
                "dispatching",
                "dispatching",
                values={"dispatch_stage": "uploaded", "deadline_at": None, "deadline_kind": None},
                conditions=(PrintQueueItem.dispatch_stage == "uploading",),
            )
            await db.commit()
        cache_3mf_download(printer_id, remote_filename, file_path)
        self.schedule_stage(item_id, printer_id, "uploaded")

    async def _send_stage(self, item_id: int) -> None:
        if not await self._stage_ready_or_defer(item_id, "uploaded"):
            return

        async with async_session() as db:
            item = await db.get(PrintQueueItem, item_id)
            printer_id = item.printer_id if item is not None else None
            await db.rollback()
        if printer_id is None:
            return

        # The explicit writer begins before the write transaction and remains
        # held across the send-intent commit and the synchronous MQTT publish.
        async with writer(printer_id), async_session() as db:
            item = await lock_queue_item(db, item_id)
            if not self._is_stage(item, "uploaded"):
                await db.rollback()
                return
            printer = await db.get(Printer, printer_id)
            archive = await db.get(PrintArchive, item.archive_id) if item.archive_id else None
            if printer is None or archive is None or archive.dispatched_queue_item_id != item.id:
                await db.rollback()
                raise RuntimeError("Dispatch Archive or printer is missing")
            if not await self._ready_locked(db, item):
                await db.commit()
                return
            if reason := await self._drying._drying_reason(item, printer_id):
                await fail(db, item, reason)
                await db.commit()
                return
            if reason := _incompatible_sliced_model_reason(archive.sliced_for_model, printer):
                await fail(db, item, reason)
                await db.commit()
                return

            remote_filename = (archive.extra_data or {}).get("remote_filename")
            filename = archive.filename
            file_path = settings.base_dir / archive.file_path
            try:
                ams_mapping = json.loads(item.ams_mapping) if item.ams_mapping else None
            except (ValueError, TypeError):
                ams_mapping = None
                logger.warning("Queue item %s: Invalid AMS mapping JSON, ignoring", item.id)

            sent = clock.now()
            submission_id = str(randbelow(2_147_483_646) + 1)
            values = {
                "dispatched_at": sent,
                "dispatch_subtask_id": submission_id,
                "dispatch_stage": "awaiting_ack",
                "deadline_at": sent + ACK_WINDOW,
                "deadline_kind": "dispatch_ack",
                "started_at": None,
                "error_message": None,
                "dispatch_baseline_subtask_id": None,
            }
            await transition_queue_item(
                db,
                item,
                "dispatching",
                "dispatching",
                values=values,
                conditions=(PrintQueueItem.dispatch_stage == "uploaded",),
            )
            await db.commit()

            try:
                started = printer_manager.start_print(
                    printer_id,
                    remote_filename,
                    plate_id=item.plate_id or 1,
                    ams_mapping=ams_mapping,
                    bed_levelling=item.bed_levelling,
                    flow_cali=item.flow_cali,
                    vibration_cali=item.vibration_cali,
                    layer_inspect=item.layer_inspect,
                    timelapse=bool(item.timelapse),
                    use_ams=item.use_ams,
                    nozzle_offset_cali=item.nozzle_offset_cali,
                    nozzle_mapping=item.nozzle_mapping,
                    submission_id=submission_id,
                    display_name=filename,
                )
            except Exception:
                # The intent is durable; a transport exception cannot prove
                # whether the printer received the command.
                logger.exception("Queue item %s: print command raised during dispatch", item_id)
                return
            if not started:
                current = await lock_queue_item(db, item_id)
                if (
                    current
                    and current.status == "dispatching"
                    and current.dispatch_subtask_id == submission_id
                    and current.dispatched_at == sent
                ):
                    await fail(
                        db,
                        current,
                        "Failed to send print command to printer",
                        dispatched_at=None,
                        dispatch_subtask_id=None,
                    )
                    await db.commit()
                else:
                    await db.rollback()
                logger.error("Queue item %s: printer %s refused the print command", item_id, printer_id)
                return

        cache_3mf_download(printer_id, remote_filename, file_path)
        logger.info("Queue item %s: print command sent successfully - %s", item_id, filename)

    async def _stage_ready_or_defer(self, item_id: int, stage: str) -> bool:
        async with async_session() as db:
            snapshot = await db.get(PrintQueueItem, item_id)
            printer_id = snapshot.printer_id if snapshot is not None else None
            await db.rollback()
        if printer_id is None:
            return False
        async with writer(printer_id), async_session() as db:
            item = await lock_queue_item(db, item_id)
            if not self._is_stage(item, stage):
                await db.rollback()
                return False
            ready = await self._ready_locked(db, item)
            await db.commit()
            return ready

    async def _ready_locked(self, db: AsyncSession, item: PrintQueueItem) -> bool:
        """Apply the telemetry gate without ending the caller-owned transaction."""
        ready = self._telemetry(item.printer_id, item.dispatch_baseline_subtask_id)
        if ready is True:
            if item.deadline_kind == "dispatch_ready":
                await transition_queue_item(
                    db,
                    item,
                    "dispatching",
                    "dispatching",
                    values={"deadline_at": None, "deadline_kind": None},
                )
            return True
        if ready is False:
            await fail(db, item, "Printer activity changed before the print command")
            return False
        if item.deadline_kind == "dispatch_ready":
            if item.deadline_at is None or item.deadline_at <= clock.naive_now():
                await fail(db, item, _TELEMETRY_UNAVAILABLE)
            return False
        await self._defer_ready_locked(db, item)
        return False

    async def _defer_ready_locked(self, db: AsyncSession, item: PrintQueueItem) -> None:
        """Persist the telemetry wait in the transaction owned by the caller."""
        await transition_queue_item(
            db,
            item,
            "dispatching",
            "dispatching",
            values={
                "deadline_at": clock.now() + timedelta(seconds=DISPATCH_TELEMETRY_WAIT_SECONDS),
                "deadline_kind": "dispatch_ready",
            },
        )

    async def ready_due(self, db: AsyncSession, item_id: int) -> None:
        """Resolve the persisted wait for fresh idle telemetry before upload/send."""
        snapshot = await db.get(PrintQueueItem, item_id)
        printer_id = snapshot.printer_id if snapshot is not None else None
        await db.rollback()
        if printer_id is None:
            return
        async with writer(printer_id):
            item = await lock_queue_item(db, item_id)
            if (
                not item
                or item.status != "dispatching"
                or item.dispatch_stage not in ("uploading", "uploaded")
                or item.deadline_kind != "dispatch_ready"
            ):
                await db.rollback()
                return
            ready = await self._ready_locked(db, item)
            await db.commit()
            if ready:
                self.schedule_stage(item.id, item.printer_id, item.dispatch_stage)

    @staticmethod
    def _is_stage(item: PrintQueueItem | None, stage: str) -> bool:
        return bool(
            item and item.status == "dispatching" and item.dispatch_stage == stage and item.dispatched_at is None
        )

    def _telemetry(self, printer_id: int | None, baseline_identity: str | None = None) -> bool | None:
        """True: safe idle telemetry; False: active printer; None: stale, changed or unavailable."""
        if printer_id is None:
            return False
        state = printer_manager.get_status(printer_id)
        if not state or not state.connected or not getattr(state, "job_telemetry_ready", False):
            return None
        if state.state in _ACTIVE_PRINT_STATES:
            return False
        if state.state in ("FINISH", "FAILED"):
            identity = telemetry_identity(state)
            if not baseline_identity or identity != baseline_identity:
                return None  # Another print reached a terminal state while this job was preparing.
        elif state.state != "IDLE":
            return None
        return True if self._selection._is_printer_idle(printer_id) else None

    async def _fail_unsent(self, item_id: int, message: str, *, expected_stage: str | None = None, **values) -> None:
        async with async_session() as db:
            snapshot = await db.get(PrintQueueItem, item_id)
            printer_id = snapshot.printer_id if snapshot is not None else None
            await db.rollback()
        if printer_id is None:
            return
        async with writer(printer_id), async_session() as db:
            item = await lock_queue_item(db, item_id)
            if (
                item
                and item.status == "dispatching"
                and item.dispatched_at is None
                and (expected_stage is None or item.dispatch_stage == expected_stage)
            ):
                await fail(db, item, message, **values)
                await db.commit()
            else:
                await db.rollback()

    async def _cleanup_unsent_upload(self, item_id: int) -> None:
        """Drain a cancelled upload before removing its remote file."""
        try:
            async with async_session() as db:
                item = await db.get(PrintQueueItem, item_id, populate_existing=True)
                if item is None or item.dispatched_at is not None:
                    return
                archive = await db.get(PrintArchive, item.archive_id) if item.archive_id else None
                printer = await db.get(Printer, item.printer_id) if item and item.printer_id else None
                remote_filename = (archive.extra_data or {}).get("remote_filename") if archive else None
                if printer is None or not remote_filename:
                    return
                ip, code, model = printer.ip_address, printer.access_code, printer.model
                await db.commit()
            if ip and code:
                await delete_file_async(ip, code, f"/{remote_filename}", printer_model=model)
        except Exception:
            logger.exception("Queue item %s: cancelled-upload cleanup failed", item_id)

    async def resolve(self, db: AsyncSession, item: PrintQueueItem, outcome: str) -> None:
        """Resolve an uncertain sent attempt only after checking exact printer telemetry."""
        item_id, printer_id = item.id, item.printer_id
        await db.rollback()
        async with writer(printer_id):
            held = await lock_queue_item(db, item_id)
            if (
                not held
                or held.printer_id != printer_id
                or held.status != "dispatching"
                or held.dispatch_stage != "awaiting_ack"
            ):
                await db.rollback()
                raise InvalidQueueTransition("This dispatch is no longer awaiting confirmation")
            state = printer_manager.get_status(held.printer_id)
            if state and state.connected:
                observed = telemetry_identity(state)
                if observed and observed != held.dispatch_subtask_id and state.state in _ACTIVE_PRINT_STATES:
                    raise InvalidQueueTransition(
                        "The printer reports a different job. Stop or inspect it before resolving this job."
                    )
                known = (
                    telemetry_status(state, held.dispatch_subtask_id) if observed == held.dispatch_subtask_id else None
                )
                if known in ("completed", "failed") or (known == "printing" and outcome == "failed"):
                    raise InvalidQueueTransition("Printer telemetry has confirmed this job. Refresh and retry.")
            printing_now = outcome == "printing"
            values = {
                "error_message": "Confirmed printing by user" if printing_now else "Printer didn't start the job",
                "started_at" if printing_now else "completed_at": clock.now(),
                "deadline_at": None,
                "deadline_kind": None,
            }
            await transition_queue_item(db, held, "dispatching", outcome, values=values)
            await db.commit()
        await effects.wait_for(effects.spawned(db))

    async def withdraw(self, db: AsyncSession, item: PrintQueueItem) -> None:
        """Exit an attempt that is proven unsent; Retry creates a separate queue job."""
        async with writer(item.printer_id):
            held = await lock_queue_item(db, item.id)
            if not unsent(held):
                await db.rollback()
                raise InvalidQueueTransition("Only an attempt that was never sent can be withdrawn")
            values = {"error_message": "Nothing was sent; retried as a new job", "completed_at": clock.now()}
            await transition_queue_item(db, held, "dispatching", "unsuccessful", action="withdrawn", values=values)

    async def start(self) -> None:
        """Fail interrupted pre-send attempts; a new queue row owns any retry."""
        try:
            async with async_session() as db:
                item_ids = list(
                    await db.scalars(
                        select(PrintQueueItem.id).where(
                            PrintQueueItem.status == "dispatching",
                            PrintQueueItem.dispatched_at.is_(None),
                        )
                    )
                )
                await db.rollback()
                for item_id in item_ids:
                    await self._fail_unsent(
                        item_id,
                        _INTERRUPTED_BEFORE_SEND,
                        dispatched_at=None,
                        dispatch_subtask_id=None,
                        dispatch_stage=None,
                    )
            # Compatibility for archives created before every observed print
            # had a queue row. This is a one-time startup adoption, not a
            # recurring dispatch recovery path.
            async with async_session() as db:
                await printing.adopt_legacy_prints(db)
        except Exception:
            logger.exception("Failed to settle interrupted dispatches or adopt legacy prints")

    async def reconcile_printer_reports(self, db: AsyncSession) -> None:
        """Apply current printer reports to sent or printing jobs; never restart dispatch work."""
        active = PrintQueueItem.status.in_(("dispatching", "printing", "paused"))
        item_ids = list(await db.scalars(select(PrintQueueItem.id).where(active).order_by(PrintQueueItem.printer_id)))
        await db.rollback()
        for item_id in item_ids:
            snapshot = await db.get(PrintQueueItem, item_id)
            if snapshot is None or snapshot.printer_id is None:
                await db.rollback()
                continue
            printer_id = snapshot.printer_id
            await db.rollback()
            async with writer(printer_id):
                item = await lock_queue_item(db, item_id)
                if (
                    not item
                    or item.status not in ("dispatching", "printing", "paused")
                    or (item.status == "dispatching" and item.dispatched_at is None)
                ):
                    await db.rollback()
                    continue
                state = printer_manager.get_status(printer_id)
                if not state or not state.connected or not getattr(state, "job_telemetry_ready", False):
                    await db.rollback()
                    continue
                observed = telemetry_status(state, item.dispatch_subtask_id)
                if observed in ("completed", "failed"):
                    data = {
                        "status": observed,
                        "filename": getattr(state, "gcode_file", None) or "",
                        "subtask_name": getattr(state, "subtask_name", "") or "",
                        "submission_id": item.dispatch_subtask_id,
                        "raw_data": {
                            **(getattr(state, "raw_data", None) or {}),
                            "subtask_id": item.dispatch_subtask_id,
                        },
                    }
                    if not data["filename"] and item.archive_id is not None:
                        archive = await db.get(PrintArchive, item.archive_id)
                        data["filename"] = archive.filename if archive else ""
                    await printing.end(db, item, data, memory=printing_memory())
                    await db.commit()
                elif observed == "printing":
                    if item.status == "dispatching":
                        await transition_queue_item(
                            db,
                            item,
                            "dispatching",
                            "printing",
                            values={"started_at": clock.now(), "error_message": None},
                        )
                        await db.commit()
                    elif await sync_print_state(db, item, state):
                        await db.commit()
                    else:
                        await db.rollback()
                else:
                    await db.rollback()


def printing_memory():
    from backend.app.services.lifecycle.intake import print_memory

    return print_memory


_UPLOAD_TOO_SLOW = (
    "Upload was too slow to finish and was cancelled. The printer's connection could not sustain "
    "the transfer — check its Wi-Fi signal, or move it closer to the access point."
)
_UPLOAD_FAILED = (
    "Failed to upload file to printer. Check if SD card is inserted and properly formatted (FAT32/exFAT). "
    "See server logs for detailed diagnostics."
)
_TELEMETRY_UNAVAILABLE = "Printer telemetry unavailable before the print command was sent"
_INTERRUPTED_BEFORE_SEND = "Dispatch interrupted by a restart before the print command was sent"


def unsent(item: PrintQueueItem) -> bool:
    """An attempt held with nothing sent and no worker left to send it, which Retry withdraws."""
    return (
        item.status == "dispatching"
        and not queued.in_flight(item.id)
        and item.dispatched_at is None
        and not item.dispatch_subtask_id
    )


async def on_enter(change, row) -> None:
    """Schedule the first persisted stage after a job enters dispatching."""
    from backend.app.services.print_scheduler import scheduler

    if change.before in ("queued", "preheating") and row.printer_id is not None:
        effects.after_commit(
            change.db,
            lambda: scheduler.dispatcher.schedule_stage(change.item_id, row.printer_id, "copying"),
            key=("dispatch-stage", change.item_id),
        )


async def on_exit(change, row) -> None:
    """Exit: a failed or stopped attempt shuts down an inherited soak; a failed or withdrawn one removes its upload."""
    printing.queue_auto_off_on_report(change, row)
    await preheating.shut_down_inherited(change, row)
    if (change.after == "failed" and change.action != "printer_report") or change.action in (
        "withdrawn",
        "cancel_unsent",
    ):
        effect = effects.QueueOutcomeEffect(change.item_id, change.after, row.printer_id, clean_sd_copy=True)
        effects.queue_outcome_effect(change.db, effect)


async def acknowledgement_due(db: AsyncSession, item_id: int) -> None:
    """At the single acknowledgement deadline, confirm exact telemetry or hold for review."""
    snapshot = await db.get(PrintQueueItem, item_id)
    printer_id = snapshot.printer_id if snapshot is not None else None
    await db.rollback()
    if printer_id is None:
        return
    async with writer(printer_id):
        item = await lock_queue_item(db, item_id)
        if (
            not item
            or item.status != "dispatching"
            or item.dispatch_stage != "awaiting_ack"
            or item.deadline_kind != "dispatch_ack"
        ):
            await db.rollback()
            return
        await _acknowledgement_due_locked(db, item_id, item, printer_id)


async def _acknowledgement_due_locked(db: AsyncSession, item_id: int, item: PrintQueueItem, printer_id: int) -> None:
    state = printer_manager.get_status(printer_id)
    observed = telemetry_status(state, item.dispatch_subtask_id) if state and state.connected else None
    if observed == "printing":
        await transition_queue_item(
            db, item, "dispatching", "printing", values={"started_at": clock.now(), "error_message": None}
        )
        await sync_print_state(db, item, state)
        await db.commit()
        return
    if observed in ("completed", "failed"):
        data = {
            "status": observed,
            "filename": getattr(state, "gcode_file", None) or "",
            "subtask_name": getattr(state, "subtask_name", "") or "",
            "submission_id": item.dispatch_subtask_id,
            "raw_data": {**(getattr(state, "raw_data", None) or {}), "subtask_id": item.dispatch_subtask_id},
        }
        await printing.end(db, item, data, memory=printing_memory())
        await db.commit()
        return
    values = {"error_message": _DISPATCH_REVIEW_MESSAGE, "deadline_at": None, "deadline_kind": None}
    await transition_queue_item(db, item, "dispatching", "dispatching", values=values)
    landed = observed is not None
    await db.commit()
    logger.warning(
        "Queue item %s: printer %s %s; held for manual review",
        item_id,
        printer_id,
        "received the print but never started it" if landed else "did not confirm the print command",
    )
    client = printer_manager.get_client(printer_id)
    if not landed and client and hasattr(client, "force_reconnect_stale_session"):
        client.force_reconnect_stale_session("queue print command unacknowledged after dispatch")


async def arm_unconfirmed(db: AsyncSession) -> None:
    """At startup: arm the one acknowledgement deadline for committed send intents."""
    unconfirmed = select(PrintQueueItem.id, PrintQueueItem.printer_id).where(
        PrintQueueItem.status == "dispatching",
        PrintQueueItem.dispatched_at.is_not(None),
        PrintQueueItem.dispatch_subtask_id.is_not(None),
        PrintQueueItem.deadline_at.is_(None),
        or_(PrintQueueItem.error_message.is_(None), PrintQueueItem.error_message != _DISPATCH_REVIEW_MESSAGE),
    )
    rows = list((await db.execute(unconfirmed)).all())
    await db.rollback()
    for item_id, printer_id in rows:
        if printer_id is None:
            continue
        async with writer(printer_id):
            item = await lock_queue_item(db, item_id)
            if not item or item.status != "dispatching" or item.deadline_at is not None:
                await db.rollback()
                continue
            sent = item.dispatched_at
            values = {
                "dispatch_stage": "awaiting_ack",
                "deadline_at": sent + ACK_WINDOW,
                "deadline_kind": "dispatch_ack",
            }
            await transition_queue_item(db, item, "dispatching", "dispatching", values=values)
            await db.commit()

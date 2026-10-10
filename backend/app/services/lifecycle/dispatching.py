"""Dispatching (#204): persist each bounded copy, upload, and send stage on its job."""

import asyncio
import json
import logging
from copy import deepcopy
from datetime import timedelta
from secrets import randbelow

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.config import settings
from backend.app.core.database import async_session
from backend.app.core.tasks import spawn_background_task
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
    lock_queue_item,
    transition_queue_item,
    writer,
)
from backend.app.services.lifecycle.printing import superseded_by, sync_print_state
from backend.app.services.printer_manager import printer_manager
from backend.app.services.printer_selection import _incompatible_sliced_model_reason

logger = logging.getLogger(__name__)

# Bambu firmware states that mean the project_file has actually been accepted
_ACTIVE_PRINT_STATES: frozenset[str] = frozenset({"PREPARE", "SLICING", "RUNNING", "PAUSE"})
DISPATCH_TELEMETRY_WAIT_SECONDS = 30
ACK_WINDOW = timedelta(seconds=270)  # One bound for correlated telemetry to confirm the sent command.


_DISPATCH_REVIEW_MESSAGE = (
    "Printer did not provide a correlated active-state confirmation; "
    "dispatch held for manual review to avoid a duplicate print."
)


def is_soaking(item: PrintQueueItem) -> bool:
    return item.status == "preheating" or (
        item.status == "dispatching" and bool(item.chamber_heat_soak) and item.dispatch_subtask_id is None
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
    """Commit a failed attempt, retrying only when the print command is proven unsent."""
    values = {"error_message": message, "completed_at": clock.now(), **values}
    dispatched_at = values.get("dispatched_at", item.dispatched_at)
    subtask_id = values.get("dispatch_subtask_id", item.dispatch_subtask_id)
    action = "dispatch_failure" if dispatched_at is None and subtask_id is None else None
    values["dispatch_stage"] = None
    await transition_queue_item(db, item, item.status, "failed", action=action, values=values)
    await db.commit()


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
            held = await lock_queue_item(db, item_id)
            if (
                not held
                or held.status != "queued"
                or held.assigned_printer_id != (None if unassigned else printer_id)
                or (binding and binding.edited_fields(held))
                or not self._selection._is_printer_idle(printer_id)
            ):
                await db.rollback()
                return
            values = {
                "waiting_reason": None,
                "dispatch_stage": "copying",
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
        except Exception as error:
            logger.exception("Dispatch stage failed for job %s", item_id)
            await self._fail_unsent(
                item_id,
                f"Dispatch failed; inspect the printer before retrying: {error}",
                expected_stage=expected_stage,
            )

    async def _copy_stage(self, item_id: int) -> None:
        from backend.app.services.queue_archive import (
            discard_prepared_archive,
            dispatch_copy_error,
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
            except Exception as error:
                await db.rollback()
                raise RuntimeError(dispatch_copy_error(error)) from error
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
            ready = self._telemetry(printer_id)
            if ready is not True:
                await db.rollback()
                if ready is False:
                    await self._fail_unsent(
                        item_id,
                        "Printer activity changed before the print command",
                        expected_stage="uploaded",
                    )
                else:
                    await self._defer_ready(item_id, "uploaded")
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
            ready = self._telemetry(item.printer_id)
            if ready is True:
                if item.deadline_kind == "dispatch_ready":
                    await transition_queue_item(
                        db,
                        item,
                        "dispatching",
                        "dispatching",
                        values={"deadline_at": None, "deadline_kind": None},
                    )
                    await db.commit()
                else:
                    await db.rollback()
                return True
            if ready is False:
                await fail(db, item, "Printer activity changed before the print command")
                await db.commit()
                return False
            await self._defer_ready_locked(db, item)
            return False

    async def _defer_ready_locked(self, db: AsyncSession, item: PrintQueueItem) -> None:
        if item.deadline_kind == "dispatch_ready" and item.deadline_at is not None:
            await db.rollback()
            return
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
        await db.commit()

    async def _defer_ready(self, item_id: int, stage: str) -> None:
        async with async_session() as db:
            snapshot = await db.get(PrintQueueItem, item_id)
            printer_id = snapshot.printer_id if snapshot is not None else None
            await db.rollback()
        if printer_id is None:
            return
        async with writer(printer_id), async_session() as db:
            item = await lock_queue_item(db, item_id)
            if self._is_stage(item, stage):
                await self._defer_ready_locked(db, item)
            else:
                await db.rollback()

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
            stage = item.dispatch_stage
            ready = self._telemetry(printer_id)
            if ready is True:
                await transition_queue_item(
                    db,
                    item,
                    "dispatching",
                    "dispatching",
                    values={"deadline_at": None, "deadline_kind": None},
                )
                await db.commit()
                self.schedule_stage(item_id, printer_id, stage)
            elif ready is False:
                await fail(db, item, "Printer activity changed before the print command")
            elif item.deadline_at is None or item.deadline_at <= clock.naive_now():
                await fail(db, item, _TELEMETRY_UNAVAILABLE)
            else:
                await db.rollback()

    @staticmethod
    def _is_stage(item: PrintQueueItem | None, stage: str) -> bool:
        return bool(
            item and item.status == "dispatching" and item.dispatch_stage == stage and item.dispatched_at is None
        )

    def _telemetry(self, printer_id: int | None) -> bool | None:
        """True: fresh idle telemetry; False: printer is active; None: stale or unavailable."""
        if printer_id is None:
            return False
        state = printer_manager.get_status(printer_id)
        if not state or not state.connected or not getattr(state, "job_telemetry_ready", False):
            return None
        if state.state in _ACTIVE_PRINT_STATES:
            return False
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
        """At startup, fail every interrupted pre-send stage; it cannot resume under this job ID."""
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
        except Exception:
            logger.exception("Failed to settle dispatches interrupted by the restart")

    async def recover(self, db: AsyncSession) -> None:
        """Schedule persisted pre-send stages and reconcile sent jobs from fresh telemetry."""
        await printing.adopt_legacy_prints(db)
        active = PrintQueueItem.status.in_(("dispatching", "printing", "paused"))
        jobs = list(
            await db.scalars(
                select(PrintQueueItem).where(active).order_by(PrintQueueItem.printer_id, PrintQueueItem.id)
            )
        )
        await db.rollback()
        for job in jobs:
            if queued.in_flight(job.id):
                continue
            try:
                await self._recover(db, job.id)
            except Exception:
                await db.rollback()
                logger.exception("Queue item %s: recovery failed", job.id)
        from backend.app.services.lifecycle.intake import reconcile_print_archives

        await reconcile_print_archives()

    async def _recover(self, db: AsyncSession, item_id: int) -> None:
        snapshot = await db.get(PrintQueueItem, item_id)
        if snapshot is None or snapshot.printer_id is None:
            return await db.rollback()
        printer_id = snapshot.printer_id
        await db.rollback()
        async with writer(printer_id):
            item = await lock_queue_item(db, item_id)
            if not item or item.status not in ("dispatching", "printing", "paused"):
                return await db.rollback()
            dispatching = item.status == "dispatching"
            if dispatching and item.dispatched_at is None:
                await fail(
                    db,
                    item,
                    _INTERRUPTED_BEFORE_SEND,
                    dispatched_at=None,
                    dispatch_subtask_id=None,
                    dispatch_stage=None,
                )
                return

            state = printer_manager.get_status(item.printer_id)
            if not state or not state.connected or not getattr(state, "job_telemetry_ready", True):
                return await db.rollback()
            observed = telemetry_status(state, item.dispatch_subtask_id)
            now = clock.now()
            if observed in ("completed", "failed"):
                data = {
                    "status": observed,
                    "filename": getattr(state, "gcode_file", None) or "",
                    "subtask_name": getattr(state, "subtask_name", "") or "",
                    "subtask_id": item.dispatch_subtask_id,
                    "raw_data": {
                        **deepcopy(getattr(state, "raw_data", None) or {}),
                        "subtask_id": item.dispatch_subtask_id,
                    },
                }
                if not data["filename"] and item.archive_id is not None:
                    archive = await db.get(PrintArchive, item.archive_id)
                    data["filename"] = archive.filename if archive else ""
                await printing.end(db, item, data, memory=printing_memory())
                await db.commit()
                return
            if observed == "printing":
                if dispatching:
                    await transition_queue_item(
                        db,
                        item,
                        "dispatching",
                        "printing",
                        values={"started_at": now, "error_message": None},
                    )
                changed = await sync_print_state(db, item, state)
                if dispatching or changed:
                    await db.commit()
                else:
                    await db.rollback()
                return

            if dispatching and item.dispatch_stage in ("copying", "uploading", "uploaded"):
                stage = item.dispatch_stage
                ready = self._telemetry(item.printer_id)
                if item.deadline_kind == "dispatch_ready":
                    if ready is True:
                        await transition_queue_item(
                            db,
                            item,
                            "dispatching",
                            "dispatching",
                            values={"deadline_at": None, "deadline_kind": None},
                        )
                        await db.commit()
                        self.schedule_stage(item.id, item.printer_id, stage)
                    elif item.deadline_at is None or item.deadline_at <= clock.naive_now():
                        await fail(db, item, _TELEMETRY_UNAVAILABLE)
                    else:
                        await db.rollback()
                    return
                if ready is False:
                    await fail(db, item, "Printer activity changed before the print command")
                    return
                if ready is None and stage in ("uploading", "uploaded"):
                    await self._defer_ready_locked(db, item)
                    return
                await db.rollback()
                self.schedule_stage(item.id, item.printer_id, stage)
                return

            if not dispatching and (other := superseded_by(item, state)):
                reason = f"The printer started print {other} while this one was unobserved; its outcome is unknown"
                values = {"completed_at": now, "error_message": reason, "auto_off_after": False}
                await transition_queue_item(db, item, item.status, "failed", action="superseded", values=values)
                printer_id = item.printer_id
                await db.commit()
                if state.state in _ACTIVE_PRINT_STATES:
                    spawn_background_task(_observe_replacement(printer_id, state), name=f"observe-print-{printer_id}")
                return
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


async def _observe_replacement(printer_id: int, state) -> None:
    """Observe the print that replaced an unobserved one, as intake does for a print running at startup."""
    from backend.app.services.lifecycle.intake import print_started

    data = {
        "submission_id": telemetry_identity(state),
        "filename": state.gcode_file or getattr(state, "current_print", None),
        "subtask_name": getattr(state, "subtask_name", None),
        "raw_data": dict(state.raw_data or {}),
    }
    try:
        await print_started(printer_id, data, recovering=True)
    except Exception:
        logger.exception("Printer %s: could not observe its replacement print", printer_id)


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

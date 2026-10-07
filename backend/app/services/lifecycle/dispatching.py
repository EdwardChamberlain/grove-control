"""Dispatching (#204): hold, copy, link, upload and send one attempt; confirm it or hold it for review.

``Dispatcher.enter`` runs the steps in order from queued or preheating. A failed
or stopped attempt's exit shuts down an inherited soak and removes its unsent
upload. Recovery settles attempts from telemetry after a restart.
"""

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from secrets import randbelow

from sqlalchemy import and_, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.config import settings
from backend.app.core.database import async_session, run_with_retry
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
from backend.app.services.job_identity import sync_print_state, telemetry_identity
from backend.app.services.lifecycle import effects, preheating, queued
from backend.app.services.lifecycle.engine import (
    InvalidQueueTransition,
    QueueTransitionConflict,
    lock_queue_item,
    transition_queue_item,
)
from backend.app.services.lifecycle.preheating import abort_heat_soak, request_heater_shutdown
from backend.app.services.printer_manager import printer_manager
from backend.app.services.printer_selection import _incompatible_sliced_model_reason

logger = logging.getLogger(__name__)

# Bambu firmware states that mean the project_file has actually been accepted
_ACTIVE_PRINT_STATES: frozenset[str] = frozenset({"PREPARE", "SLICING", "RUNNING", "PAUSE"})
DISPATCH_TELEMETRY_WAIT_SECONDS = 30
_DISPATCH_REVIEW_MESSAGE = (
    "Printer did not provide a correlated active-state confirmation; "
    "dispatch held for manual review to avoid a duplicate print."
)

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
    """Commit a failed attempt; its exit and awaiting's entry queue the effects."""
    values = {"error_message": message, "completed_at": datetime.now(timezone.utc), **values}
    await transition_queue_item(db, item, item.status, "failed", values=values)
    await db.commit()


async def _transition_or_skip(db: AsyncSession, item: PrintQueueItem, status: str, *, action=None, **values) -> bool:
    try:
        await transition_queue_item(db, item, item.status, status, values=values, action=action)
    except QueueTransitionConflict:
        logger.info("Queue item %s changed concurrently; skipping it this pass", item.id)
        return False
    return True


async def credit_owner(db: AsyncSession, item: PrintQueueItem) -> None:
    """Credit the job's owner when the print-complete callback logs the print."""
    if not item.created_by_id:
        return
    from backend.app.models.user import User

    owner = await db.get(User, item.created_by_id)
    if owner:
        printer_manager.set_current_print_user(item.printer_id, owner.id, owner.username)


@dataclass
class _Attempt:
    """One held attempt, passed from step to step. Scalars survive a rollback's expiry."""

    db: AsyncSession
    item: PrintQueueItem
    printer: Printer
    identity: str | None  # The printer's job before this attempt; a different one means new activity.
    binding: queued._DispatchBinding | None
    item_id: int = 0
    printer_id: int = 0
    claim: datetime | None = None
    archive_id: int | None = None
    sliced_for: str | None = None
    filename: str = ""
    remote_filename: str = ""
    file_path: Path | None = None
    timeout: int | None = None
    connection: tuple[str, str, str | None] = ("", "", None)

    def __post_init__(self):
        self.item_id, self.printer_id, self.claim = self.item.id, self.item.printer_id, self.item.dispatching_at

    @property
    def remote_path(self) -> str:
        return f"/{self.remote_filename}"


class Dispatcher:
    """Dispatching's worker: each attempt from its hold to the printer's confirmation, and their recovery."""

    def __init__(self, heat_soak: preheating.ChamberHeatSoak, printers):
        """``heat_soak`` hands soaks over; ``printers`` reports idle printers and AMS drying (the scheduler)."""
        self._heat_soak, self._printers = heat_soak, printers
        self._started_at: datetime | None = None
        self._recovering: set[int] = set()
        self._visible_unsent: set[int] = set()

    async def take_over(self, item_id: int) -> None:
        """Enter from preheating in its own session once a soak hands off; an attempt left unsent ends failed."""
        async with async_session() as db:
            item = await lock_queue_item(db, item_id)
            if not item or item.status != "dispatching" or item.preheat_owner != self._heat_soak.owner:
                await db.rollback()
                return
            item.preheat_owner, item.dispatching_at = None, datetime.now(timezone.utc)
            await db.commit()
            try:
                await self.enter(db, item, "preheating")
            finally:
                await db.rollback()
                item = await lock_queue_item(db, item_id)
                if item and item.status == "dispatching" and not item.dispatch_subtask_id and not item.archive_id:
                    reason = item.error_message or "Heat-soak dispatch interrupted; retry required"
                    await abort_heat_soak(db, item, reason)
                await queued.release_claim(db, item_id)

    async def enter(
        self, db: AsyncSession, item: PrintQueueItem, from_state: str, binding: queued._DispatchBinding | None = None
    ) -> None:
        """Enter from queued, holding the selected printer, or from preheating, inheriting the soak's hold.

        Then copy, link, upload and send; each step ends the attempt with a
        reason or hands it on. An unexpected error after the hold fails it.
        """
        identity, item_id = telemetry_identity(printer_manager.get_status(item.printer_id)), item.id
        if from_state == "queued" and not await self._hold(db, item, binding):
            return
        try:
            if from_state == "preheating" and not (item := await self._inherit(db, item)):
                return
            attempt = _Attempt(db, item, await db.get(Printer, item.printer_id), identity, binding)
            copy = await self._copy(attempt)
            if copy is not None and await self._link(attempt, copy) and await self._upload(attempt):
                await self._send(attempt)
        except asyncio.CancelledError:
            await self._remove_unsent_upload(db, item_id)
            raise
        except QueueTransitionConflict:
            await db.rollback()
            logger.info("Queue item %s changed while dispatch was in progress", item_id)
        except Exception:
            await db.rollback()
            logger.exception("Dispatch failed for job %s", item_id)
            try:
                item = await lock_queue_item(db, item_id)
                if item and item.status == "dispatching":
                    await fail(db, item, "Dispatch failed; inspect the printer before retrying")
                else:
                    await db.rollback()
            except Exception:
                await db.rollback()
                logger.exception("Could not settle queue item %s after a dispatch failure", item_id)

    async def _hold(self, db: AsyncSession, item: PrintQueueItem, binding: queued._DispatchBinding | None) -> bool:
        """From queued: commit the printer hold, with the selected printer and mapping, before any copy."""
        item_id, printer_id, unassigned = item.id, item.printer_id, bool(binding and binding.unassigned)
        if not self._printers._is_printer_idle(printer_id):
            return False
        printer = PrintQueueItem.printer_id.is_(None) if unassigned else PrintQueueItem.printer_id == printer_id
        try:
            await transition_queue_item(
                db,
                item,
                "queued",
                "dispatching",
                conditions=(printer, PrintQueueItem.dispatching_at == item.dispatching_at),
                values={"waiting_reason": None, **(binding.values() if binding else {})},
                dispatch_guard=lambda: self._printers._is_printer_idle(printer_id),
            )
            await db.commit()
        except IntegrityError:
            await db.rollback()
            logger.info("Printer %s was reserved concurrently; job %s remains queued", printer_id, item_id)
            return False
        return True

    async def _inherit(self, db: AsyncSession, item: PrintQueueItem) -> PrintQueueItem | None:
        """From preheating: take over the soak's hold once its source still fits the printer."""
        item = await lock_queue_item(db, item.id)
        if not item or item.status != "dispatching" or item.preheat_owner or item.dispatch_subtask_id:
            await db.rollback()
            return None
        await db.commit()  # Release the handoff lock before slow Archive and FTP work.
        if problem := await queued.blocker(db, item, await db.get(Printer, item.printer_id)):
            await fail(db, item, problem[0])
            return None
        return item

    async def _copy(self, a: _Attempt) -> PrintArchive | None:
        """Copy the exact file, with current G-code injection, into a new unlinked Archive."""
        from backend.app.services.queue_archive import dispatch_copy_error, prepare_dispatch_archive

        try:
            return await prepare_dispatch_archive(a.db, a.item)
        except Exception as error:
            logger.exception("Queue item %s: failed to copy dispatch Archive", a.item_id)
            if held := await self._held(a):  # The rollback also discards the unlinked copy.
                await fail(a.db, held, dispatch_copy_error(error))
            return None

    async def _link(self, a: _Attempt, copy: PrintArchive) -> bool:
        """Link the copy to the held job and commit it; no command is ever sent without it."""
        from backend.app.services.queue_archive import link_dispatch_archive

        source = PrintQueueItem.archive_id
        source = source.is_(None) if a.item.archive_id is None else source == a.item.archive_id
        try:
            conditions = (PrintQueueItem.printer_id == a.printer_id, PrintQueueItem.dispatching_at == a.claim, source)
            await link_dispatch_archive(a.db, a.item, copy, conditions=conditions)
            await a.db.commit()
        except QueueTransitionConflict:
            await a.db.rollback()
            return False
        if a.binding and a.binding.unassigned:
            await queued.notify_assignment(a.db, a.item)
        archive = await a.db.get(PrintArchive, a.item.archive_id) if a.item.archive_id else None
        if archive is None or archive.dispatched_queue_item_id != a.item_id:
            await fail(a.db, a.item, "Dispatch Archive is missing; inspect and retry")
            return False
        a.archive_id, a.sliced_for, a.filename = archive.id, archive.sliced_for_model, archive.filename
        a.remote_filename, a.file_path = archive.extra_data["remote_filename"], settings.base_dir / archive.file_path
        await a.db.commit()
        return True

    async def _upload(self, a: _Attempt) -> bool:
        """Upload the attempt's unique SD file once telemetry is ready; no transaction stays open across FTP."""
        if not await self._ready(a):
            return False
        retry, retries, delay, a.timeout = await get_ftp_retry_settings()
        await a.db.commit()
        printer = a.printer
        logger.info(
            "Queue item %s: FTP upload starting - printer=%s (%s), ip=%s, file=%s, retry_enabled=%s, timeout=%s",
            *(a.item_id, printer.name, printer.model, printer.ip_address, a.remote_filename, retry, a.timeout),
        )
        cooloff_before = ftps_handshake_cooloff_deadline(printer.ip_address)
        connection = (printer.ip_address, printer.access_code)
        options = {"socket_timeout": a.timeout, "printer_model": printer.model, "respect_handshake_cooloff": False}
        try:
            await delete_file_async(*connection, a.remote_path, **options)  # Avoids a 553 error on overwrite.
        except Exception as error:
            logger.debug("Queue item %s: delete before upload failed (may not exist): %s", a.item_id, error)
        error_message = None
        try:
            if retry:
                operation = f"Upload print to {printer.name}"
                retry_options = {"max_retries": retries, "retry_delay": delay, "operation_name": operation}
                upload = with_ftp_retry(
                    upload_file_async,
                    *connection,
                    a.file_path,
                    a.remote_path,
                    cooloff_ip=None,
                    **retry_options,
                    **options,
                )
            else:
                upload = upload_file_async(*connection, a.file_path, a.remote_path, **options)
            uploaded = await upload
        except UploadCancelled as error:
            uploaded, error_message = False, _UPLOAD_TOO_SLOW
            logger.error("Queue item %s: upload deadline exceeded: %s", a.item_id, error)
        except Exception as error:
            uploaded = False
            logger.error("Queue item %s: FTP error: %s (type: %s)", a.item_id, error, type(error).__name__)
        if not uploaded:
            cooloff_after = ftps_handshake_cooloff_deadline(printer.ip_address)
            if error_message is None and cooloff_after is not None and cooloff_after != cooloff_before:
                error_message = "The printer's file service did not answer over TLS; the SD card is not involved."
            await fail(a.db, a.item, error_message or _UPLOAD_FAILED)  # The attempt keeps its Archive and hold.
            logger.error(
                "Queue item %s: FTP upload to printer %s failed; see the storage diagnostics above",
                a.item_id,
                a.printer_id,
            )
            return False
        return await self._still_fits(a)

    async def _still_fits(self, a: _Attempt) -> bool:
        """Whether the printer still takes the upload: it can be retargeted to another model meanwhile."""
        await a.db.refresh(a.printer, attribute_names=["model"])
        a.connection = (a.printer.ip_address, a.printer.access_code, a.printer.model)
        if not (reason := _incompatible_sliced_model_reason(a.sliced_for, a.printer)):
            return True
        held = await lock_queue_item(a.db, a.item_id)
        if held and held.status == "dispatching":
            await fail(a.db, held, reason)  # Its exit removes the upload.
        else:
            await a.db.rollback()
            await self._discard(a, respect_handshake_cooloff=False)  # Another state won the race.
        logger.info("Queue item %s: dispatch deferred - %s", a.item_id, reason)
        return False

    async def _send(self, a: _Attempt) -> None:
        """Persist a fresh submission ID and the send time, then publish under the job's lock, serialized with Stop."""
        db, item = a.db, a.item
        try:
            ams_mapping = json.loads(item.ams_mapping) if item.ams_mapping else None
        except json.JSONDecodeError:
            ams_mapping = None
            logger.warning("Queue item %s: Invalid AMS mapping JSON, ignoring", a.item_id)
        if not await self._dry(db, item):  # Drying may have started during the upload.
            return
        subtask_id = str(randbelow(2_147_483_646) + 1)
        claim = () if a.claim is None else (PrintQueueItem.dispatching_at == a.claim,)
        conditions = (PrintQueueItem.printer_id == a.printer_id, *claim)
        values = {"dispatched_at": None, "dispatch_subtask_id": subtask_id, "started_at": None, "error_message": None}
        try:
            await transition_queue_item(db, item, "dispatching", "dispatching", conditions=conditions, values=values)
            await db.commit()
        except IntegrityError:
            await db.rollback()  # The partial unique index remains the authoritative reservation guard.
            return
        except QueueTransitionConflict:
            return await self._lost(a)
        await credit_owner(db, item)
        # This drying check closes the window opened by the send-boundary commit.
        active = self._printers._active_drying_ams_ids(a.printer_id)
        if (active and not await self._dry(db, item, active)) or not await self._ready(a):
            printer_manager.clear_current_print_user(a.printer_id)
            return
        try:
            values = {"dispatched_at": datetime.now(timezone.utc)}
            await transition_queue_item(db, item, "dispatching", "dispatching", conditions=conditions, values=values)
            await db.commit()
        except QueueTransitionConflict:
            return await self._lost(a)
        # The row lock is held only across the synchronous publish: a concurrent
        # Stop either wins first, preventing the send, or follows it with Stop.
        deadline = asyncio.get_running_loop().time() + DISPATCH_TELEMETRY_WAIT_SECONDS
        while True:
            if not await self._ready(a, deadline=deadline):
                printer_manager.clear_current_print_user(a.printer_id)
                return
            item = await lock_queue_item(db, a.item_id)
            expected = ("dispatching", subtask_id, a.printer_id, a.archive_id)
            if not item or (item.status, item.dispatch_subtask_id, item.printer_id, item.archive_id) != expected:
                return await self._lost(a)
            if self._telemetry(a.printer_id, a.identity) is True:
                break
            await db.rollback()  # Never wait for reconnect while holding the Stop lock.
        try:
            started = printer_manager.start_print(
                a.printer_id,
                a.remote_filename,
                plate_id=item.plate_id or 1,
                ams_mapping=ams_mapping,
                bed_levelling=item.bed_levelling,
                flow_cali=item.flow_cali,
                vibration_cali=item.vibration_cali,
                layer_inspect=item.layer_inspect,
                timelapse=bool(item.timelapse),  # The user's choice; finish photos are independent (#1721).
                use_ams=item.use_ams,
                nozzle_offset_cali=item.nozzle_offset_cali,
                nozzle_mapping=item.nozzle_mapping,
                submission_id=subtask_id,
                display_name=a.filename,
            )
        except Exception:
            # A transport error doesn't prove the printer missed the command; confirmation decides.
            logger.exception("Queue item %s: print command raised during dispatch", a.item_id)
            await db.rollback()
            self._confirm_later(a.item_id, a.printer_id, subtask_id)
            return
        if not started:
            values = {"dispatched_at": None, "dispatch_subtask_id": None, "started_at": None}
            await fail(db, item, "Failed to send print command to printer", **values)
            logger.error(
                "Queue item %s: printer %s refused the print command (MQTT or firmware)", a.item_id, a.printer_id
            )
            return
        await db.rollback()  # Release the send lock; the reservation is already durable.
        logger.info("Queue item %s: Print command sent successfully - %s", a.item_id, a.filename)
        cache_3mf_download(a.printer_id, a.remote_filename, a.file_path)  # /cover then skips FTP (#1166).
        # Confirmation runs in the background: a slow printer only delays its own job.
        self._confirm_later(a.item_id, a.printer_id, subtask_id)

    async def _held(self, a: _Attempt) -> PrintQueueItem | None:
        """The attempt's job, locked after a rollback, while this worker still holds it."""
        await a.db.rollback()
        held = await lock_queue_item(a.db, a.item_id)
        if held and held.status == "dispatching" and held.dispatching_at == a.claim:
            return held
        await a.db.rollback()
        return None

    async def _ready(self, a: _Attempt, *, deadline: float | None = None) -> bool:
        """Whether fresh telemetry permits the next boundary; otherwise end or park the unsent attempt."""
        ready = await self._wait_for_telemetry(a.printer_id, a.identity, deadline=deadline)
        if ready is True:
            return True
        if not (held := await self._held(a)):
            return False
        if ready is False:
            await fail(a.db, held, "Printer activity changed during dispatch; inspect the printer")
            return False
        # Nothing was sent; the attempt waits for Stop and Retry, and its soak's heaters for shutdown.
        values = {"error_message": _TELEMETRY_UNAVAILABLE, "dispatched_at": None, "dispatch_subtask_id": None}
        await transition_queue_item(a.db, held, "dispatching", "dispatching", values=values)
        if held.chamber_heat_soak:
            await request_heater_shutdown(a.db, a.printer_id)
        await a.db.commit()
        return False

    async def _dry(self, db: AsyncSession, item: PrintQueueItem, active: tuple[int, ...] | None = None) -> bool:
        """Whether no AMS drying blocks the print command; otherwise the attempt fails for its reason."""
        if not (reason := await self._printers._drying_reason(item, item.printer_id, active)):
            return True
        values = {"dispatched_at": None, "dispatch_subtask_id": None, "started_at": None, "waiting_reason": reason}
        await fail(db, item, reason, **values)
        return False

    async def _lost(self, a: _Attempt) -> None:
        await a.db.rollback()
        logger.info("Queue item %s lost its dispatch claim; cleaning up uploaded file", a.item_id)
        await self._discard(a)

    async def _discard(self, a: _Attempt, **options) -> None:
        """Remove an upload this attempt no longer owns."""
        ip, code, model = a.connection
        try:
            await delete_file_async(ip, code, a.remote_path, socket_timeout=a.timeout, printer_model=model, **options)
        except Exception as error:
            logger.warning("Queue item %s: could not remove upload %s: %s", a.item_id, a.remote_path, error)

    async def _remove_unsent_upload(self, db: AsyncSession, item_id: int) -> None:
        """After Stop drains the upload, remove it unless a send boundary leaves delivery uncertain."""
        try:
            await db.rollback()
            job = await db.get(PrintQueueItem, item_id, populate_existing=True)
            if (
                job is None
                or job.status not in ("dispatching", "cancelled", "unsuccessful")
                or job.dispatched_at is not None
                or job.started_at is not None
            ):
                return
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

    def _telemetry(self, printer_id: int, previous_id: str | None) -> bool | None:
        """True: ready; False: new activity; None: current telemetry is missing."""
        state = printer_manager.get_status(printer_id)
        if not state or not state.connected or not getattr(state, "job_telemetry_ready", False):
            return None
        current_id = telemetry_identity(state)
        if state.state in _ACTIVE_PRINT_STATES or (previous_id and current_id and current_id != previous_id):
            return False
        return True if self._printers._is_printer_idle(printer_id) else None

    async def _wait_for_telemetry(
        self, printer_id: int, previous_id: str | None, *, deadline: float | None = None
    ) -> bool | None:
        """Wait through a brief reconnect; silence never proves a failed print."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + DISPATCH_TELEMETRY_WAIT_SECONDS if deadline is None else deadline
        while (ready := self._telemetry(printer_id, previous_id)) is None and loop.time() < deadline:
            await asyncio.sleep(min(0.5, max(0, deadline - loop.time())))
        return ready

    def _confirm_later(self, item_id: int, printer_id: int, subtask_id: str) -> None:
        spawn_background_task(self._confirm(item_id, printer_id, subtask_id), name=f"confirm-queue-dispatch-{item_id}")

    async def _confirm(self, item_id: int, printer_id: int, subtask_id: str) -> None:
        """Wait: promote the sent attempt once telemetry confirms it, or hold it for a person to resolve."""
        try:
            status, last_status = await self._wait_for_ack(printer_id, subtask_id)
        except Exception:
            logger.exception("Queue item %s: dispatch confirmation crashed", item_id)
            status, last_status = None, None
        if status == "printing":

            async def promote(db: AsyncSession) -> None:
                item = await db.get(PrintQueueItem, item_id)
                if not item or item.status != "dispatching":
                    return
                try:
                    await transition_queue_item(db, item, "dispatching", "printing")
                    await sync_print_state(db, item, printer_manager.get_status(printer_id))
                except QueueTransitionConflict:
                    return await db.rollback()
                item.started_at, item.error_message = datetime.now(timezone.utc), None
                started = effects.queue_job_started(db, item_id)
                await db.commit()
                await effects.wait_for(started)

            return await run_with_retry(promote, label=f"confirm queue dispatch {item_id}")
        if status in ("completed", "failed"):
            return  # Completion or recovery owns a correlated terminal print; it is never retried.

        async def hold_for_review(db: AsyncSession) -> bool:
            item = await db.get(PrintQueueItem, item_id)
            if not item or item.status != "dispatching":
                return False
            item.error_message = _DISPATCH_REVIEW_MESSAGE
            await db.commit()
            return True

        if not await run_with_retry(hold_for_review, label=f"hold queue dispatch {item_id}"):
            return
        if status == "dispatching":
            logger.warning(
                "Queue item %s: printer %d received project_file but did not enter a correlated active state; "
                "held for manual review",
                item_id,
                printer_id,
            )
            return
        logger.warning(
            "Queue item %s: printer %d did not confirm print command; held for manual review", item_id, printer_id
        )
        client = printer_manager.get_client(printer_id)
        if client and hasattr(client, "force_reconnect_stale_session"):
            state = getattr(last_status, "state", None) if last_status else None
            client.force_reconnect_stale_session(f"queue print command unacknowledged after dispatch (state {state})")

    async def _wait_for_ack(
        self,
        printer_id: int,
        subtask_id: str,
        timeout: float = 90.0,
        phase_b_timeout: float = 180.0,
        poll_interval: float = 3.0,
    ) -> tuple[str | None, object | None]:
        """Wait until the sent print reaches an active state; a matching ID alone extends the wait."""
        last_status, landed = None, False
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if status := printer_manager.get_status(printer_id):
                last_status, observed = status, telemetry_status(status, subtask_id)
                if observed == "printing":
                    return observed, status
                if observed in ("dispatching", "completed", "failed"):
                    # A matching ID with a terminal state can mix generations; keep polling for an active state.
                    landed = True
                    break
            await asyncio.sleep(poll_interval)
        if not landed:
            return None, last_status
        deadline = time.monotonic() + phase_b_timeout
        while time.monotonic() < deadline:
            await asyncio.sleep(poll_interval)
            if status := printer_manager.get_status(printer_id):
                last_status = status
                if telemetry_status(status, subtask_id) == "printing":
                    return "printing", status
        return "dispatching", last_status

    async def resolve(self, db: AsyncSession, item: PrintQueueItem, outcome: str) -> None:
        """Exit for a person's resolution of an unconfirmed attempt, awaiting its committed start effects."""
        state = printer_manager.get_status(item.printer_id)
        if state and state.connected:
            observed = telemetry_identity(state)
            if observed and observed != item.dispatch_subtask_id and state.state in _ACTIVE_PRINT_STATES:
                raise InvalidQueueTransition(
                    "The printer reports a different job. Stop or inspect it before resolving this job."
                )
            known = telemetry_status(state, item.dispatch_subtask_id) if observed == item.dispatch_subtask_id else None
            if known in ("completed", "failed") or (known == "printing" and outcome == "failed"):
                raise InvalidQueueTransition("Printer telemetry has confirmed this job. Refresh and retry.")
        printing = outcome == "printing"
        values = {"error_message": "Confirmed printing by user" if printing else "Printer didn't start the job"}
        values["started_at" if printing else "completed_at"] = datetime.now(timezone.utc)
        await transition_queue_item(db, item, "dispatching", outcome, values=values)
        started = effects.queue_job_started(db, item.id) if printing else []
        await db.commit()
        await effects.wait_for(started)

    async def wait_unsent(self, db: AsyncSession) -> None:
        """Wait: keep the heartbeat of unsent soak handoffs, holding an expired one for inspection."""
        unsent = select(PrintQueueItem.id).where(
            PrintQueueItem.status == "dispatching",
            PrintQueueItem.chamber_heat_soak.is_(True),
            PrintQueueItem.dispatch_subtask_id.is_(None),
        )
        visible = set()
        for item_id in list(await db.scalars(unsent)):
            try:
                item = await lock_queue_item(db, item_id)
                if not item or item.status != "dispatching" or not is_soaking(item):
                    await db.rollback()
                    continue
                checked = item.preheat_checked_at
                elapsed = (preheating.utcnow() - checked).total_seconds() if checked else preheating.HEARTBEAT_TIMEOUT
                live = 0 <= elapsed < preheating.HEARTBEAT_TIMEOUT
                if item.preheat_owner != self._heat_soak.owner and not live:
                    item.error_message = "Heat soak interrupted; inspect the printer, then stop or skip heat soak"
                    preheating._show_preheating(item.printer_id, True)
                    visible.add(item.printer_id)
                    await db.commit()
                elif item.preheat_owner == self._heat_soak.owner and not live:
                    await abort_heat_soak(
                        db, item, "Heat soak interrupted by restart or scheduler timeout; retry required"
                    )
                else:
                    await db.rollback()
            except Exception:
                await db.rollback()
                logger.exception("Queue item %s: unsent dispatch recovery failed", item_id)
        for printer_id in self._visible_unsent - visible:
            preheating_job = select(PrintQueueItem.id).where(
                PrintQueueItem.printer_id == printer_id, PrintQueueItem.status == "preheating"
            )
            if await db.scalar(preheating_job.limit(1)) is None:
                preheating._show_preheating(printer_id, False)
        self._visible_unsent = visible

    async def start(self) -> None:
        """Recover at startup: fail attempts left unsent, and release the previous process's worker claims."""
        self._started_at = datetime.now(timezone.utc)
        unsent = (
            PrintQueueItem.status == "dispatching",
            PrintQueueItem.dispatch_subtask_id.is_(None),
            PrintQueueItem.dispatched_at.is_(None),
        )
        try:
            async with async_session() as db:
                for item in list(await db.scalars(select(PrintQueueItem).where(*unsent))):
                    reason = "Dispatch interrupted before print command; retry required"
                    await _transition_or_skip(db, item, "failed", error_message=reason, completed_at=self._started_at)
                claims = update(PrintQueueItem).where(PrintQueueItem.dispatching_at.is_not(None))
                result = await db.execute(claims.values(dispatching_at=None))
                await db.commit()
                if result.rowcount:
                    logger.info("Cleared %d stale queue dispatch claim(s)", result.rowcount)
        except Exception:
            logger.exception("Failed to clear stale queue dispatch claims")

    async def recover(self, db: AsyncSession) -> None:
        """Recover, each pass: settle attempts that no worker or live confirmation owns, from telemetry."""
        active = PrintQueueItem.status.in_(("dispatching", "printing", "paused"))
        now = datetime.now(timezone.utc)
        changed, completions = False, []
        for item in list(await db.scalars(select(PrintQueueItem).where(active))):
            dispatching, sent = item.status == "dispatching", item.dispatched_at
            sent = sent.replace(tzinfo=timezone.utc) if sent and sent.tzinfo is None else sent
            if dispatching and (
                item.dispatching_at is not None  # A live preparation worker still owns this attempt.
                # Startup failed interrupted workers; a telemetry timeout leaves an unsent hold for Stop and Retry.
                or (sent is None and not item.dispatch_subtask_id)
                # Live acknowledgement owns a fresh dispatch.
                or (self._started_at and sent and sent >= self._started_at and (now - sent).total_seconds() < 270)
            ):
                continue
            state = printer_manager.get_status(item.printer_id) if item.printer_id is not None else None
            if state and (not getattr(state, "connected", False) or not getattr(state, "job_telemetry_ready", True)):
                state = None
            subtask_id = str(item.dispatch_subtask_id).strip() if item.dispatch_subtask_id else None
            observed = telemetry_status(state, subtask_id)
            if observed in ("completed", "failed"):
                # Commit the printer's terminal outcome before completion effects run, so a
                # restart never turns a printer-confirmed outcome back into a retry.
                if observed == "completed" and dispatching:
                    if not await _transition_or_skip(db, item, "printing", started_at=now):
                        continue
                outcome = "finished" if observed == "completed" else "failed"
                if not await _transition_or_skip(db, item, outcome, action="printer_report", completed_at=now):
                    continue
                changed = True
                completions.append((item, state, subtask_id, observed))
                logger.info("Recovered terminal queue dispatch %s from %s telemetry", item.id, state.state)
            elif observed == "printing":
                if dispatching:
                    if not await _transition_or_skip(db, item, "printing", started_at=now, error_message=None):
                        continue
                    changed = True
                    effects.queue_job_started(db, item.id, background=True)
                    logger.info("Recovered dispatched queue item %s as printer-confirmed printing", item.id)
                try:
                    changed = await sync_print_state(db, item, state) or changed
                except QueueTransitionConflict:
                    continue
            elif dispatching and (sent is None or sent.timestamp() <= now.timestamp() - 270):
                # An upgrade-interrupted row has no send time, and is held for review at once.
                if item.error_message != _DISPATCH_REVIEW_MESSAGE:
                    item.error_message, changed = _DISPATCH_REVIEW_MESSAGE, True
                    logger.warning(
                        "Holding stale unconfirmed queue dispatch %s for manual review (printer state=%s)",
                        item.id,
                        getattr(state, "state", None),
                    )
        if changed:
            await db.commit()
        for item, state, subtask_id, observed in completions:
            await self._complete_later(db, item, state, subtask_id, observed)

    async def _complete_later(self, db: AsyncSession, item, state, subtask_id: str, observed: str) -> None:
        """Run the normal completion for a recovered terminal print, without delaying the pass."""
        if item.id in self._recovering:
            return
        filename = getattr(state, "gcode_file", None)
        if not filename and item.archive_id is not None:
            archive = await db.get(PrintArchive, item.archive_id)
            filename = archive.filename if archive else None
        # Some firmware sends subtask_id=0 at FINISH/FAILED; use the matched ID.
        raw_data = {**(getattr(state, "raw_data", None) or {}), "subtask_id": subtask_id}
        data = {
            "status": observed,
            "filename": filename or f"queue-dispatch-{item.id}",
            "subtask_name": "",
            "subtask_id": subtask_id,
            "raw_data": raw_data,
            "_reconciled": True,
            "_recovered_dispatch": True,
        }
        self._recovering.add(item.id)
        name = f"complete-recovered-queue-dispatch-{item.id}"
        spawn_background_task(self._complete_recovered_dispatch(item.id, item.printer_id, data), name=name)

    async def _complete_recovered_dispatch(self, item_id: int, printer_id: int, completion_data: dict) -> None:
        try:
            from backend.app.main import on_print_complete

            await on_print_complete(printer_id, completion_data)
        finally:
            self._recovering.discard(item_id)


_UPLOAD_TOO_SLOW = (
    "Upload was too slow to finish and was cancelled. The printer's connection could not sustain "
    "the transfer — check its Wi-Fi signal, or move it closer to the access point."
)
_UPLOAD_FAILED = (
    "Failed to upload file to printer. Check if SD card is inserted and properly formatted (FAT32/exFAT). "
    "See server logs for detailed diagnostics."
)
_TELEMETRY_UNAVAILABLE = "Printer telemetry unavailable; Stop and Retry to send this job"


async def on_exit(change, row) -> None:
    """Exit: a failed or stopped attempt shuts down an inherited soak; a failed one removes its unsent upload."""
    await preheating.shut_down_inherited(change, row)
    if change.after == "failed" and change.action != "printer_report":
        effect = effects.QueueOutcomeEffect(change.item_id, "failed", row.printer_id, clean_sd_copy=True)
        effects.queue_outcome_effect(change.db, effect)

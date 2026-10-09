"""Dispatching (#204): hold, copy, link, upload and send one attempt; confirm it or hold it for review.

``Dispatcher.enter`` runs the steps in order from queued or preheating. A failed
or stopped attempt's exit shuts down an inherited soak and removes its unsent
upload. Recovery settles attempts from telemetry after a restart.
"""

import asyncio
import json
import logging
from copy import deepcopy
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from secrets import randbelow

from sqlalchemy import and_, or_, select
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
    hold_printer,
    lock_queue_item,
    transition_queue_item,
)
from backend.app.services.lifecycle.preheating import request_heater_shutdown
from backend.app.services.lifecycle.printing import superseded_by, sync_print_state
from backend.app.services.printer_manager import printer_manager
from backend.app.services.printer_selection import _incompatible_sliced_model_reason

logger = logging.getLogger(__name__)

# Bambu firmware states that mean the project_file has actually been accepted
_ACTIVE_PRINT_STATES: frozenset[str] = frozenset({"PREPARE", "SLICING", "RUNNING", "PAUSE"})
DISPATCH_TELEMETRY_WAIT_SECONDS = 30
ACK_WINDOW = timedelta(seconds=90)  # For the printer to report the sent print's ID.
ACK_LANDED_WINDOW = timedelta(seconds=180)  # Once the ID landed, for the print to become active.


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
    """Commit a failed attempt, retrying only when the print command is proven unsent."""
    values = {"error_message": message, "completed_at": clock.now(), **values}
    dispatched_at = values.get("dispatched_at", item.dispatched_at)
    subtask_id = values.get("dispatch_subtask_id", item.dispatch_subtask_id)
    action = "dispatch_failure" if dispatched_at is None and subtask_id is None else None
    await transition_queue_item(db, item, item.status, "failed", action=action, values=values)
    await db.commit()


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
    archive_id: int | None = None
    sliced_for: str | None = None
    filename: str = ""
    remote_filename: str = ""
    file_path: Path | None = None
    timeout: int | None = None
    connection: tuple[str, str, str | None] = ("", "", None)

    def __post_init__(self):
        self.item_id, self.printer_id = self.item.id, self.item.printer_id

    @property
    def remote_path(self) -> str:
        return f"/{self.remote_filename}"


class Dispatcher:
    """Dispatching's worker: each attempt from its hold to the printer's confirmation, and their recovery."""

    def __init__(self, selection, drying):
        """``selection`` reports idle printers, and ``drying`` AMS drying."""
        self._selection, self._drying = selection, drying

    async def take_over(self, item_id: int) -> None:
        """Enter from preheating in its own session once a soak hands off."""
        async with async_session() as db:
            item = await db.get(PrintQueueItem, item_id)
            if item and item.status == "dispatching" and not item.dispatch_subtask_id:
                await self.enter(db, item, "preheating")

    async def enter(
        self, db: AsyncSession, item: PrintQueueItem, from_state: str, binding: queued._DispatchBinding | None = None
    ) -> None:
        """Enter from queued, holding the selected printer, or from preheating, inheriting the soak's hold.

        Then copy, link, upload and send; each step ends the attempt with a
        reason or hands it on. An unexpected error after the hold fails it.
        """
        if from_state == "queued" and binding is None and item.assigned_printer_id is not None:
            binding = queued._DispatchBinding.for_item(
                item, item.assigned_printer_id, item.ams_mapping, unassigned=False
            )
        if from_state == "queued" and binding is not None:
            queued._bind_in_memory(item, binding.printer_id, binding.ams_mapping)
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
        """From queued: hold the selected idle printer, before any copy, if the job is unchanged since selection."""
        item_id, printer_id, unassigned = item.id, item.printer_id, bool(binding and binding.unassigned)
        await hold_printer(db, printer_id)  # The selected printer, before any write.
        held = await lock_queue_item(db, item_id)
        if (
            not held
            or held.status != "queued"
            or held.assigned_printer_id != (None if unassigned else printer_id)
            or (binding and binding.edited_fields(held))
            or not self._selection._is_printer_idle(printer_id)
        ):
            await db.rollback()
            return False
        values = {"waiting_reason": None, **(binding.values() if binding else {"printer_id": printer_id})}
        try:
            await transition_queue_item(db, held, "queued", "dispatching", values=values)
            await db.commit()
        except IntegrityError:
            await db.rollback()
            logger.info("Printer %s was reserved concurrently; job %s remains queued", printer_id, item_id)
            return False
        return True

    async def _inherit(self, db: AsyncSession, item: PrintQueueItem) -> PrintQueueItem | None:
        """From preheating: take over the soak's hold once its source still fits the printer."""
        item = await lock_queue_item(db, item.id)
        if not item or item.status != "dispatching" or item.dispatch_subtask_id:
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

        source_id = a.item.archive_id
        if not (held := await self._current(a)) or held.archive_id != source_id:
            await a.db.rollback()  # Discards the unlinked copy.
            return False
        await link_dispatch_archive(a.db, held, copy)
        await a.db.commit()
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
        values = {"dispatched_at": None, "dispatch_subtask_id": subtask_id, "started_at": None, "error_message": None}
        if not (item := await self._current(a)):
            return await self._lost(a)
        await transition_queue_item(db, item, "dispatching", "dispatching", values=values)
        await db.commit()
        # This drying check closes the window opened by the send-boundary commit.
        active = self._drying._active_drying_ams_ids(a.printer_id)
        if (active and not await self._dry(db, item, active)) or not await self._ready(a):
            return
        if not (item := await self._current(a)):
            return await self._lost(a)
        # From here the print may have been sent; the acknowledgement deadline decides.
        sent = clock.now()
        values = {"dispatched_at": sent, "deadline_at": sent + ACK_WINDOW, "deadline_kind": "ack"}
        await transition_queue_item(db, item, "dispatching", "dispatching", values=values)
        await db.commit()
        # The row lock is held only across the synchronous publish: a concurrent
        # Stop either wins first, preventing the send, or follows it with Stop.
        deadline = clock.monotonic() + DISPATCH_TELEMETRY_WAIT_SECONDS
        while True:
            if not await self._ready(a, deadline=deadline):
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

    async def _held(self, a: _Attempt) -> PrintQueueItem | None:
        """The attempt's job, locked after a rollback, while this worker still holds it."""
        await a.db.rollback()
        return await self._current(a)

    async def _current(self, a: _Attempt) -> PrintQueueItem | None:
        """Lock the attempt's job in the open transaction; None, rolled back, once Stop or recovery ended it."""
        held = await lock_queue_item(a.db, a.item_id)
        if held and held.status == "dispatching" and held.printer_id == a.printer_id:
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
        await _park(a.db, held, _TELEMETRY_UNAVAILABLE)
        return False

    async def _dry(self, db: AsyncSession, item: PrintQueueItem, active: tuple[int, ...] | None = None) -> bool:
        """Whether no AMS drying blocks the print command; otherwise the attempt fails for its reason."""
        if not (reason := await self._drying._drying_reason(item, item.printer_id, active)):
            return True
        values = {"dispatched_at": None, "dispatch_subtask_id": None, "started_at": None, "waiting_reason": reason}
        await fail(db, item, reason, **values)
        return False

    async def _lost(self, a: _Attempt) -> None:
        await a.db.rollback()
        logger.info("Queue item %s changed during dispatch; cleaning up uploaded file", a.item_id)
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
            await db.commit()  # Release the read transaction before FTP.
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
        return True if self._selection._is_printer_idle(printer_id) else None

    async def _wait_for_telemetry(
        self, printer_id: int, previous_id: str | None, *, deadline: float | None = None
    ) -> bool | None:
        """Wait through a brief reconnect; silence never proves a failed print."""
        deadline = clock.monotonic() + DISPATCH_TELEMETRY_WAIT_SECONDS if deadline is None else deadline
        while (ready := self._telemetry(printer_id, previous_id)) is None and clock.monotonic() < deadline:
            await clock.sleep(min(0.5, max(0, deadline - clock.monotonic())))
        return ready

    async def resolve(self, db: AsyncSession, item: PrintQueueItem, outcome: str) -> None:
        """Exit for a person's resolution of an unconfirmed attempt, awaiting printing's committed start effects."""
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
        values["started_at" if printing else "completed_at"] = clock.now()
        await transition_queue_item(db, item, "dispatching", outcome, values=values)
        await db.commit()
        await effects.wait_for(effects.spawned(db))

    async def withdraw(self, db: AsyncSession, item: PrintQueueItem) -> None:
        """Exit for Retry of an attempt nothing was sent for: release its hold and remove its upload."""
        if not unsent(item):
            raise InvalidQueueTransition("Only an attempt that was never sent can be withdrawn")
        values = {"error_message": "Nothing was sent; retried as a new job", "completed_at": clock.now()}
        await transition_queue_item(db, item, "dispatching", "unsuccessful", action="withdrawn", values=values)

    async def start(self) -> None:
        """At startup: an attempt interrupted before its print command sent nothing; park it for Retry."""
        unsent = (
            PrintQueueItem.status == "dispatching",
            PrintQueueItem.dispatch_subtask_id.is_(None),
            PrintQueueItem.dispatched_at.is_(None),
        )
        try:
            async with async_session() as db:
                for item in list(await db.scalars(select(PrintQueueItem).where(*unsent))):
                    await _park(db, item, _INTERRUPTED_BEFORE_SEND)
        except Exception:
            logger.exception("Failed to park dispatches interrupted by the restart")

    async def recover(self, db: AsyncSession) -> None:
        """The one recovery rule, each tick: settle every job no worker owns from fresh telemetry, as a live event would.

        Each job is read and settled under its printer's lock in its own
        transaction. Without fresh telemetry nothing is decided: a sent job is
        never resolved from missing or stale reports. A print whose printer now
        reports a different print ended unobserved; its outcome is unknown, so
        it fails without Auto Off, and the print that replaced it is then
        observed as started.
        """
        await printing.adopt_legacy_prints(db)
        active = PrintQueueItem.status.in_(("dispatching", "printing", "paused"))
        item_ids = list(await db.scalars(select(PrintQueueItem.id).where(active)))
        await db.rollback()
        for item_id in item_ids:
            if queued.in_flight(item_id):
                continue  # A live worker still owns this attempt.
            try:
                await self._recover(db, item_id)
            except Exception:
                await db.rollback()
                logger.exception("Queue item %s: recovery failed", item_id)

    async def _recover(self, db: AsyncSession, item_id: int) -> None:
        from backend.app.services.lifecycle.intake import busy as intake_busy  # Its completion may be in flight.

        item = await lock_queue_item(db, item_id)
        if not item or item.status not in ("dispatching", "printing", "paused"):
            return await db.rollback()
        dispatching = item.status == "dispatching"
        if dispatching and not item.dispatch_subtask_id:
            if item.dispatched_at is None:
                await fail(db, item, "Dispatch was interrupted before the print command was sent")
            else:
                await db.rollback()  # A send intent without printer identity is ambiguous; leave it for review.
            return
        state = printer_manager.get_status(item.printer_id) if item.printer_id is not None else None
        if not state or not getattr(state, "connected", False) or not getattr(state, "job_telemetry_ready", True):
            return await db.rollback()
        observed = telemetry_status(state, item.dispatch_subtask_id)
        now = clock.now()
        if observed in ("completed", "failed"):
            # Snapshot the report now: MQTT moves the live state on while this awaits the database.
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
            await printing.end(db, item, data, stopped=False, memory=printing_memory())
            await db.commit()
            logger.info("Recovered queue job %s from %s telemetry", item_id, state.state)
        elif observed == "printing":
            if dispatching:
                await transition_queue_item(
                    db, item, "dispatching", "printing", values={"started_at": now, "error_message": None}
                )
            changed = await sync_print_state(db, item, state)
            if dispatching or changed:
                await db.commit()
                logger.info("Recovered queue job %s as printer-confirmed printing", item_id)
            else:
                await db.rollback()
        elif not dispatching and (other := superseded_by(item, state)) and not intake_busy(item.printer_id):
            reason = f"The printer started print {other} while this one was unobserved; its outcome is unknown"
            values = {"completed_at": now, "error_message": reason, "auto_off_after": False}
            await transition_queue_item(db, item, item.status, "failed", action="superseded", values=values)
            printer_id = item.printer_id
            await db.commit()
            logger.warning("Queue item %s ended unobserved: printer %s reports %s", item_id, printer_id, other)
            if state.state in _ACTIVE_PRINT_STATES:
                spawn_background_task(_observe_replacement(printer_id, state), name=f"observe-print-{printer_id}")
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


async def _park(db: AsyncSession, item: PrintQueueItem, message: str) -> None:
    """A known-unsent attempt fails into the automatic fresh-job retry, and cools a soak's heaters."""
    values = {"error_message": message, "dispatched_at": None, "dispatch_subtask_id": None}
    await transition_queue_item(db, item, "dispatching", "failed", action="dispatch_failure", values=values)
    if item.chamber_heat_soak or item.preheat_requested_at is not None:
        await request_heater_shutdown(db, item.printer_id)
    await db.commit()


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
    """Enter from preheating: a worker takes the soak over once the handoff commits."""
    from backend.app.services.print_scheduler import scheduler

    if change.before == "preheating":
        item_id, printer_id = change.item_id, row.printer_id
        effects.after_commit(
            change.db,
            lambda: scheduler.workers.adopt(item_id, printer_id, scheduler.dispatcher.take_over(item_id)),
            key=("take_over", item_id),
        )


async def on_exit(change, row) -> None:
    """Exit: a failed or stopped attempt shuts down an inherited soak; a failed or withdrawn one removes its upload."""
    await preheating.shut_down_inherited(change, row)
    if (change.after == "failed" and change.action != "printer_report") or change.action == "withdrawn":
        effect = effects.QueueOutcomeEffect(change.item_id, change.after, row.printer_id, clean_sd_copy=True)
        effects.queue_outcome_effect(change.db, effect)


async def acknowledgement_due(db: AsyncSession, item_id: int) -> None:
    """The ``ack`` and ``ack_landed`` deadlines: confirm a sent print from telemetry, or hold it for review.

    The printer has ``ACK_WINDOW`` to report the print's ID. Once it has,
    the print has ``ACK_LANDED_WINDOW`` more to become active. Intake confirms
    an observed start at once; this settles what it never saw.
    """
    item = await lock_queue_item(db, item_id)
    if not item or item.status != "dispatching" or item.deadline_kind not in ("ack", "ack_landed"):
        await db.rollback()
        return
    state = printer_manager.get_status(item.printer_id)
    observed = telemetry_status(state, item.dispatch_subtask_id) if state and state.connected else None
    if observed == "printing":
        await transition_queue_item(
            db, item, "dispatching", "printing", values={"started_at": clock.now(), "error_message": None}
        )
        await sync_print_state(db, item, state)
        await db.commit()
        return
    if observed is not None and item.deadline_kind == "ack":
        values = {"deadline_at": clock.now() + ACK_LANDED_WINDOW, "deadline_kind": "ack_landed"}
        await transition_queue_item(db, item, "dispatching", "dispatching", values=values)
        await db.commit()
        return
    values = {"error_message": _DISPATCH_REVIEW_MESSAGE, "deadline_at": None, "deadline_kind": None}
    await transition_queue_item(db, item, "dispatching", "dispatching", values=values)
    printer_id, landed = item.printer_id, observed is not None
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
    """At startup: a sent attempt the previous process was confirming gets its final acknowledgement deadline."""
    unconfirmed = select(PrintQueueItem.id).where(
        PrintQueueItem.status == "dispatching",
        PrintQueueItem.dispatch_subtask_id.is_not(None),
        PrintQueueItem.deadline_at.is_(None),
        or_(PrintQueueItem.error_message.is_(None), PrintQueueItem.error_message != _DISPATCH_REVIEW_MESSAGE),
    )
    for item_id in list(await db.scalars(unconfirmed)):
        item = await lock_queue_item(db, item_id)
        if not item or item.status != "dispatching" or item.deadline_at is not None:
            await db.rollback()
            continue
        sent = item.dispatched_at or clock.naive_now()
        values = {"deadline_at": sent + ACK_WINDOW + ACK_LANDED_WINDOW, "deadline_kind": "ack_landed"}
        await transition_queue_item(db, item, "dispatching", "dispatching", values=values)
        await db.commit()

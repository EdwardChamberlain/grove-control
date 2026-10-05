"""Preheating (#204): hold the printer, heat it for a bounded soak, then hand off to dispatching.

Enter: ``ChamberHeatSoak.enter`` holds the printer, and once the hold has
committed the engine runs ``on_entered``, which turns the heaters on. Wait:
``ChamberHeatSoak.wait`` keeps the heartbeat, ends an interrupted soak, and
hands off when the timer has run. Exit: the engine runs ``on_exit``, which
releases the claim and shuts the heaters down unless dispatching inherits them;
``abort_heat_soak`` and ``skip_heat_soak`` request exits. Recover:
``ChamberHeatSoak.recover`` keeps an expired soak's hold until a person chooses
Stop or Skip heat soak. Database write locks serialize controls with
cancellation; no other process resumes a soak's timer or dispatches its job.
There is no material or keep-warm policy.
"""

import logging
import time
from collections.abc import Mapping
from datetime import datetime, timezone
from enum import Enum
from typing import Any
from uuid import uuid4

from sqlalchemy import and_, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.tasks import spawn_background_task
from backend.app.models.print_queue import ACTIVE_STATUSES, PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.lifecycle.engine import (
    QueueTransitionConflict,
    enter_state,
    lock_queue_item,
    transition_queue_item,
)
from backend.app.services.printer_manager import printer_manager, supports_chamber_heater

logger = logging.getLogger(__name__)
HEARTBEAT_TIMEOUT = 90
TELEMETRY_TIMEOUT = 60

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


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def supports_airduct(model: str | None) -> bool:
    return supports_chamber_heater(model) or (model or "").strip().upper() in {"P2S", "N7"}


def _reported(state, key: str, value: int, since: datetime) -> bool:
    report = getattr(state, "heat_soak_reports", {}).get(key)
    return bool(
        report
        and report[0] == value
        and report[1] >= since.replace(tzinfo=timezone.utc).timestamp()
        and 0 <= time.time() - report[1] < TELEMETRY_TIMEOUT
    )


def _show_preheating(printer_id: int, active: bool) -> None:
    state = printer_manager.get_status(printer_id)
    if state and getattr(state, "preheating", False) != active:
        state.preheating = active
        spawn_background_task(
            printer_manager._broadcast_status_change(printer_id), name=f"heat-soak-status-{printer_id}"
        )


def _dispatch_ready(printer_id: int) -> bool:
    live = printer_manager.get_status(printer_id)
    return bool(
        live
        and printer_manager.is_connected(printer_id)
        and live.connected
        and getattr(live, "job_telemetry_ready", True)
        and live.state in ("IDLE", "FINISH", "FAILED")
    )


def _heaters_off(printer: Printer) -> bool:
    client = printer_manager.get_client(printer.id)
    # A failed soak can outlive its hold. Never turn off a subsequent print's
    # heaters, including while reconnect telemetry still describes an old run.
    if not client or not _dispatch_ready(printer.id):
        return False
    # Attempt every shutdown command even if another one fails.
    commands = [(client.set_bed_temperature, 0)]
    if supports_chamber_heater(printer.model):
        commands.append((client.set_chamber_temperature, 0))
    if supports_airduct(printer.model):
        commands.append((client.set_airduct_mode, "cooling"))
    for command, value in commands:
        try:
            command(value)
        except Exception:
            logger.exception("Heat-soak heater shutdown failed for printer %s", printer.id)
    return True


async def request_heater_shutdown(db: AsyncSession, printer_id: int) -> None:
    """Record a durable heater shutdown; cleanup retries it until telemetry confirms it."""
    printer = await db.get(Printer, printer_id)
    if printer is not None:
        printer.heat_soak_shutdown_pending = True
        printer.heat_soak_shutdown_at = datetime.now(timezone.utc)


async def cleanup_heat_soak_shutdown(db: AsyncSession, printer_id: int) -> bool:
    """Retry a committed shutdown only while no new job is using the printer."""
    # Staging takes this same lock before checking pending shutdown and heating.
    await db.execute(update(Printer).where(Printer.id == printer_id).values(id=Printer.id))
    printer = await db.get(Printer, printer_id, populate_existing=True)
    if not printer or not printer.heat_soak_shutdown_pending:
        await db.commit()
        return False
    active_job = await db.scalar(
        select(PrintQueueItem.id).where(
            PrintQueueItem.printer_id == printer_id,
            PrintQueueItem.status.in_(ACTIVE_STATUSES),
            # An unsent dispatch whose worker has stopped can cool while its
            # plate hold remains. An uploading or potentially sent job cannot.
            or_(
                PrintQueueItem.status != "dispatching",
                PrintQueueItem.dispatching_at.is_not(None),
                PrintQueueItem.dispatched_at.is_not(None),
            ),
        )
    )
    if active_job is not None or not _heaters_off(printer):
        await db.commit()
        return False
    client = printer_manager.get_client(printer_id)
    if client:
        client.request_status_update()
    state = printer_manager.get_status(printer_id)
    since = printer.heat_soak_shutdown_at
    confirmed = bool(_dispatch_ready(printer_id) and since and _reported(state, "bed_target", 0, since))
    if supports_chamber_heater(printer.model):
        confirmed = confirmed and _reported(state, "chamber_target", 0, since)
    if confirmed:
        printer.heat_soak_shutdown_pending = False
        printer.heat_soak_shutdown_at = None
    await db.commit()
    return True


async def on_entered(change) -> bool:
    """Enter, once the hold has committed: turn the heaters on, and say whether they came on.

    Re-lock first, so that a Stop committed since then is never followed by
    heater-on commands.
    """
    db, item_id, printer_id = change.db, change.item_id, change.values["printer_id"]
    item = await lock_queue_item(db, item_id)
    if not item or item.status != "preheating" or item.preheat_owner != change.values["preheat_owner"]:
        await db.rollback()
        return False
    await db.execute(update(Printer).where(Printer.id == printer_id).values(id=Printer.id))
    printer = await db.get(Printer, printer_id, populate_existing=True)
    client = printer_manager.get_client(printer_id)
    if not printer or printer.heat_soak_shutdown_pending or not client or not _dispatch_ready(printer_id):
        await abort_heat_soak(db, item, "Heat soak could not start: printer unavailable or heater shutdown pending")
        return False
    # The soak duration is measured from the heater command, not from a
    # later telemetry update. Target telemetry can lag or be omitted by
    # firmware, and it should not make the wait unpredictable.
    heating_started_at = utcnow()
    try:
        accepted = True
        if supports_airduct(printer.model):
            accepted = client.set_airduct_mode("heating") and accepted
        accepted = client.set_bed_temperature(item.heat_soak_temperature) and accepted
        if supports_chamber_heater(printer.model):
            accepted = client.set_chamber_temperature(item.heat_soak_temperature) and accepted
        client.request_status_update()
        if not accepted:
            raise RuntimeError("Heating command could not be sent")
    except Exception:
        logger.exception("Could not start heat soak for queue item %s", item_id)
        await abort_heat_soak(db, item, "Heat-soak heating commands failed; retry required")
        return False
    item.preheat_started_at = heating_started_at
    await db.commit()
    _show_preheating(printer_id, True)
    return True


async def on_exit(change, row) -> None:
    """Exit: leave preheating for ``change.after``, for the reason ``change.action``.

    Dispatching inherits the soak: its heaters stay on, and its claim is the
    worker's handoff token. Any other exit releases the claim and records a
    heater shutdown that survives a disconnect or deletion of the job. A
    deleted printer has nothing left to shut down.
    """
    from backend.app.services.lifecycle import effects

    if change.after == "dispatching":
        return
    await change.write(preheat_owner=None, preheat_started_at=None, preheat_checked_at=None)
    if row.printer_id is not None and change.action != "printer_deleted":
        await request_heater_shutdown(change.db, row.printer_id)
        effects.shut_down_heaters(change.db, row.printer_id)


async def abort_heat_soak(db: AsyncSession, item: PrintQueueItem, reason: str, *, status: str = "failed") -> None:
    """Exit with a reason. Caller holds the queue write lock; heater shutdown survives deletion of the job."""
    await transition_queue_item(
        db, item, item.status, status, values={"error_message": reason, "completed_at": utcnow()}
    )
    await db.commit()


def heat_soak_dispatch_started(item: PrintQueueItem) -> bool:
    """The durable hold itself proves that this soak has handed off."""
    return item.status in ("dispatching", "printing", "paused", "finished", "successful")


class SkipHeatSoakResult(str, Enum):
    SKIPPED = "skipped"
    PRINTER_NOT_READY = "printer_not_ready"
    SOAK_CHANGED = "soak_changed"


def _changed(item: PrintQueueItem | None, owner: str | None, printer_id: int) -> SkipHeatSoakResult | None:
    """None while this is still the same soak; otherwise whether it has already handed off."""
    if item and item.status == "preheating" and item.preheat_owner == owner and item.printer_id == printer_id:
        return None
    started = bool(item and item.printer_id == printer_id and heat_soak_dispatch_started(item))
    return SkipHeatSoakResult.SKIPPED if started else SkipHeatSoakResult.SOAK_CHANGED


async def _hand_off(
    db: AsyncSession, item_id: int, owner: str | None, printer_id: int, values: Mapping[str, Any]
) -> tuple[bool, SkipHeatSoakResult]:
    """Exit to dispatching under the soak's lock, and say whether this call handed off.

    SKIPPED without a handoff means another control already handed this soak
    off. Readiness was checked before the lock, and is checked again under it
    and by the engine's guard. A changed soak is left untouched.
    """
    item = await lock_queue_item(db, item_id)
    if not (changed := _changed(item, owner, printer_id)) and _dispatch_ready(printer_id):
        try:
            await transition_queue_item(
                db,
                item,
                "preheating",
                "dispatching",
                conditions=(PrintQueueItem.preheat_owner == owner, PrintQueueItem.printer_id == printer_id),
                dispatch_guard=lambda: _dispatch_ready(printer_id),
                values=values,
            )
            await db.commit()
            _show_preheating(printer_id, False)
            return True, SkipHeatSoakResult.SKIPPED
        except QueueTransitionConflict:
            await db.rollback()
            logger.info("Queue item %s changed during heat-soak handoff", item_id)
            item = await lock_queue_item(db, item_id)
            changed = _changed(item, owner, printer_id)
    if changed:
        await db.rollback()
        return False, changed
    # The printer is not ready, or the live guard refused at the last moment.
    # Either way the same soak keeps its liveness.
    item.preheat_checked_at = utcnow()
    await db.commit()
    return False, SkipHeatSoakResult.PRINTER_NOT_READY


async def skip_heat_soak(db: AsyncSession, item: PrintQueueItem) -> SkipHeatSoakResult:
    """Exit to dispatching now, for Skip heat soak; the worker copies after commit."""
    item_id, owner, printer_id = item.id, item.preheat_owner, item.printer_id
    item.preheat_checked_at = utcnow()
    await db.commit()
    if not _dispatch_ready(printer_id):
        item = await lock_queue_item(db, item_id)
        result = _changed(item, owner, printer_id) or SkipHeatSoakResult.PRINTER_NOT_READY
        await db.rollback()
        return result
    from backend.app.services.print_scheduler import scheduler

    values = {
        "chamber_heat_soak": False,
        "manual_start": False,
        "error_message": None,
        "completed_at": None,
        "dispatching_at": utcnow(),
        "preheat_owner": scheduler._heat_soak.owner,
        "preheat_checked_at": None,
    }
    handed_off, result = await _hand_off(db, item_id, owner, printer_id, values)
    if handed_off:
        spawn_background_task(scheduler._dispatch_after_heat_soak(item_id), name=f"skip-heat-soak-dispatch-{item_id}")
    return result


class ChamberHeatSoak:
    def __init__(self):
        self.owner = str(uuid4())
        self._visible_printers: set[int] = set()

    async def enter(
        self,
        db: AsyncSession,
        item: PrintQueueItem,
        *,
        bind_values: Mapping[str, Any] | None = None,
        unassigned: bool = False,
    ) -> bool:
        """Enter: hold the printer; once that commits, ``on_entered`` turns the heaters on.

        ``bind_values`` records the scheduler's decision (printer and tray
        mapping) with the hold. With ``unassigned``, an "Any machine" job is
        assigned the printer the worker selected (``item.printer_id`` in
        memory) and the row must still be unassigned; otherwise the row must
        still require that printer.
        """
        item_id, printer_id, claim = item.id, item.printer_id, item.dispatching_at
        required_printer_id = None if unassigned else printer_id
        item = await lock_queue_item(db, item_id)
        if not item or item.status != "queued" or item.printer_id != required_printer_id:
            await db.rollback()
            return False
        # Claim only a still-queued row. Concurrent workers cannot reassign a winner.
        now = utcnow()
        try:
            entered = await enter_state(
                db,
                item,
                "queued",
                "preheating",
                conditions=(
                    PrintQueueItem.dispatching_at == claim,
                    PrintQueueItem.printer_id.is_(None)
                    if required_printer_id is None
                    else PrintQueueItem.printer_id == required_printer_id,
                ),
                values={
                    **(bind_values or {}),
                    "printer_id": printer_id,
                    "preheat_owner": self.owner,
                    "preheat_requested_at": now,
                    "preheat_checked_at": now,
                    "preheat_started_at": None,
                    "dispatched_at": None,
                    "dispatch_subtask_id": None,
                    "error_message": None,
                    "waiting_reason": None,
                },
            )
        except (IntegrityError, QueueTransitionConflict):
            await db.rollback()
            return False
        if entered:
            self._visible_printers.add(printer_id)
        return entered

    async def wait(self, db: AsyncSession) -> list[int]:
        """Wait: advance each soak once, without sleeping or blocking other printers' scheduling."""
        await self.cleanup(db)
        ids = list((await db.scalars(select(PrintQueueItem.id).where(SOAKING))).all())
        ready = []
        visible: set[int] = set()
        for item_id in ids:
            try:
                item = await lock_queue_item(db, item_id)
                # The select can be stale: Skip may have handed this soak off since.
                if not item or not is_soaking(item):
                    await db.rollback()
                    continue
                printer_id, now = item.printer_id, utcnow()
                elapsed = (
                    (now - item.preheat_checked_at).total_seconds() if item.preheat_checked_at else HEARTBEAT_TIMEOUT
                )
                if item.preheat_owner != self.owner:
                    await self.recover(db, item, elapsed, visible)
                    continue
                if elapsed < 0 or elapsed >= HEARTBEAT_TIMEOUT:
                    await abort_heat_soak(
                        db, item, "Heat soak interrupted by restart or scheduler timeout; retry required"
                    )
                    continue
                if item.status == "dispatching":
                    await db.rollback()
                    continue
                visible.add(printer_id)
                _show_preheating(printer_id, True)
                printer = await db.get(Printer, printer_id)
                state = printer_manager.get_status(printer_id)
                requested = item.preheat_requested_at
                disconnected_at = getattr(state, "heat_soak_disconnected_at", 0) if state else 0
                if (
                    not printer
                    or not printer.is_active
                    or not state
                    or not printer_manager.is_connected(printer_id)
                    or not requested
                    or disconnected_at >= requested.replace(tzinfo=timezone.utc).timestamp()
                    or state.state not in ("IDLE", "FINISH", "FAILED")
                ):
                    await abort_heat_soak(
                        db, item, "Printer disconnected or became unavailable during heat soak; retry required"
                    )
                    continue
                if item.preheat_started_at is None:
                    await abort_heat_soak(db, item, "Heat-soak start time missing; retry required")
                    continue
                client = printer_manager.get_client(printer_id)
                if client:
                    client.request_status_update()
                item.preheat_checked_at = now
                # Persist liveness and release the control lock before expensive I/O.
                await db.commit()
                if (now - item.preheat_started_at).total_seconds() < item.heat_soak_minutes * 60:
                    continue
                if not _dispatch_ready(printer_id):
                    continue
                values = {"dispatched_at": None, "dispatching_at": utcnow(), "preheat_checked_at": utcnow()}
                handed_off, _ = await _hand_off(db, item_id, self.owner, printer_id, values)
                if handed_off:
                    ready.append(item_id)
            except Exception:
                await db.rollback()
                logger.exception("Queue item %s: heat-soak handoff failed", item_id)
        for printer_id in self._visible_printers - visible:
            _show_preheating(printer_id, False)
        self._visible_printers = visible
        return ready

    async def recover(self, db: AsyncSession, item: PrintQueueItem, elapsed: float, visible: set[int]) -> None:
        """Recover: leave a live soak this worker doesn't own alone, and hold an expired one for a person."""
        if 0 <= elapsed < HEARTBEAT_TIMEOUT:
            await db.rollback()
            return
        # There is no submission ID before dispatch, so telemetry cannot prove this
        # interrupted soak. Keep the hold until the user chooses Stop or Skip heat soak.
        item.error_message = "Heat soak interrupted; inspect the printer, then stop or skip heat soak"
        _show_preheating(item.printer_id, True)
        visible.add(item.printer_id)
        await db.commit()

    async def cleanup(self, db: AsyncSession) -> None:
        printer_ids = list(
            (await db.scalars(select(Printer.id).where(Printer.heat_soak_shutdown_pending.is_(True)))).all()
        )
        for printer_id in printer_ids:
            await cleanup_heat_soak_shutdown(db, printer_id)

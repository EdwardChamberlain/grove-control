"""Preheating entry, timer decisions, reasoned exit and restart recovery (#204).

The engine writes decisions and commits before heater entry. A foreign owner
is never resumed: its hold remains for Stop or Skip heat soak after expiry.
"""

import logging
import time
from collections.abc import Mapping
from datetime import datetime, timezone
from enum import Enum
from functools import partial
from typing import Any
from uuid import uuid4

from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.tasks import spawn_background_task
from backend.app.models.print_queue import ACTIVE_STATUSES, PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.lifecycle.engine import (
    Decision,
    QueueTransitionConflict,
    apply_decision,
    lock_queue_item,
    transition_queue_item,
)
from backend.app.services.printer_manager import printer_manager, supports_chamber_heater

logger = logging.getLogger(__name__)
HEARTBEAT_TIMEOUT = 90
TELEMETRY_TIMEOUT = 60
HANDOFF_STATUSES = frozenset({"dispatching", "printing", "paused", "finished", "successful"})


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
            PrintQueueItem.status.in_(("preheating", "dispatching", "printing", "paused")),
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
    _show_preheating(printer_id, False)
    return True


def exit_values(before: str, after: str, action: str | None, item: PrintQueueItem | int | None = None) -> dict:
    """A dispatch keeps the handoff claim; ending a soak relinquishes its timer."""
    heating = action == "cancel" and before in ACTIVE_STATUSES and getattr(item, "chamber_heat_soak", False)
    if after != "dispatching" and (before == "preheating" or heating):
        return {"preheat_owner": None, "preheat_started_at": None, "preheat_checked_at": None}
    return {}


async def request_shutdown(db: AsyncSession, row) -> bool:
    """Persist cleanup before exit effects, so disconnect or job deletion cannot lose it."""
    heating = row.preheat_requested_at is not None or row.chamber_heat_soak
    if heating and row.printer_id is not None:
        printer = await db.get(Printer, row.printer_id)
        if printer is not None:
            printer.heat_soak_shutdown_pending = True
            printer.heat_soak_shutdown_at = datetime.now(timezone.utc)
    return heating


def failure(item: PrintQueueItem, reason: str, status: str = "failed") -> Decision:
    return Decision(
        item.status,
        status,
        {"error_message": reason, "completed_at": utcnow(), **exit_values("preheating", status, None)},
    )


async def abort_heat_soak(db: AsyncSession, item: PrintQueueItem, reason: str, *, status: str = "failed") -> None:
    await apply_decision(db, item, failure(item, reason, status))


class SkipHeatSoakResult(str, Enum):
    SKIPPED = "skipped"
    PRINTER_NOT_READY = "printer_not_ready"
    SOAK_CHANGED = "soak_changed"


async def _handoff(
    db: AsyncSession, item: PrintQueueItem, owner: str, *, skip: bool = False
) -> tuple[SkipHeatSoakResult, bool]:
    """Timer and Skip share the same locked, telemetry-fenced dispatch decision."""
    item_id, previous_owner, printer_id = item.id, item.preheat_owner, item.printer_id

    def same(item):
        return bool(
            item
            and item.status == "preheating"
            and item.preheat_owner == previous_owner
            and item.printer_id == printer_id
        )

    def changed(item):
        started = bool(skip and item and item.printer_id == printer_id and item.status in HANDOFF_STATUSES)
        return SkipHeatSoakResult.SKIPPED if started else SkipHeatSoakResult.SOAK_CHANGED

    ready = _dispatch_ready(printer_id)
    item = await lock_queue_item(db, item_id)
    matches = same(item)
    if not matches or not ready:
        result = changed(item) if not matches else SkipHeatSoakResult.PRINTER_NOT_READY
        await db.rollback()
        return result, False
    if not _dispatch_ready(printer_id):
        item.preheat_checked_at = utcnow()
        await db.commit()
        return SkipHeatSoakResult.PRINTER_NOT_READY, False
    now = utcnow()
    values = {"dispatched_at": None, "dispatching_at": now, "preheat_checked_at": now}
    if skip:
        values.update(
            chamber_heat_soak=False,
            manual_start=False,
            error_message=None,
            completed_at=None,
            preheat_owner=owner,
            preheat_checked_at=None,
        )
    try:
        await transition_queue_item(
            db,
            item,
            "preheating",
            "dispatching",
            conditions=(PrintQueueItem.preheat_owner == previous_owner, PrintQueueItem.printer_id == printer_id),
            dispatch_guard=lambda: _dispatch_ready(printer_id),
            values=values,
        )
        await db.commit()
    except QueueTransitionConflict:
        await db.rollback()
        item = await lock_queue_item(db, item_id)
        if same(item):
            item.preheat_checked_at = utcnow()
            await db.commit()
            return SkipHeatSoakResult.PRINTER_NOT_READY, False
        result = changed(item)
        await db.rollback()
        return result, False
    return SkipHeatSoakResult.SKIPPED, True


async def skip_heat_soak(db: AsyncSession, item: PrintQueueItem) -> SkipHeatSoakResult:
    from backend.app.services.print_scheduler import scheduler

    item_id = item.id
    item.preheat_checked_at = utcnow()
    await db.commit()
    result, handed_off = await _handoff(db, item, scheduler._heat_soak.owner, skip=True)
    if handed_off:
        spawn_background_task(scheduler._dispatch_after_heat_soak(item_id), name=f"skip-heat-soak-dispatch-{item_id}")
    return result


class ChamberHeatSoak:
    def __init__(self):
        self.owner = str(uuid4())

    async def stage(
        self,
        db: AsyncSession,
        item: PrintQueueItem,
        *,
        bind_values: Mapping[str, Any] | None = None,
        unassigned: bool = False,
    ) -> bool:
        """Bind the scheduler's printer/trays with the hold, then let the engine enter.

        An Any Machine row must still be unassigned; a fixed row must retain its target.
        """
        item_id, printer_id, claim = item.id, item.printer_id, item.dispatching_at
        required_printer_id = None if unassigned else printer_id
        item = await lock_queue_item(db, item_id)
        if not item or item.status != "queued" or item.printer_id != required_printer_id:
            await db.rollback()
            return False
        # Claim only a still-queued row. Concurrent workers cannot reassign a winner.
        now = utcnow()
        decision = Decision(
            "queued",
            "preheating",
            {
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
            conditions=(
                PrintQueueItem.dispatching_at == claim,
                PrintQueueItem.printer_id.is_(None)
                if required_printer_id is None
                else PrintQueueItem.printer_id == required_printer_id,
            ),
        )
        try:
            return await apply_decision(db, item, decision, enter=self.enter)
        except (IntegrityError, QueueTransitionConflict):
            await db.rollback()
            return False

    async def enter(self, db: AsyncSession, item: PrintQueueItem) -> Decision | None:
        """The engine calls entry after the reservation commits; recheck it before heating."""
        item_id = item.id
        item = await lock_queue_item(db, item_id)
        if not item or item.status != "preheating" or item.preheat_owner != self.owner:
            return None
        printer_id = item.printer_id
        await db.execute(update(Printer).where(Printer.id == printer_id).values(id=Printer.id))
        printer = await db.get(Printer, printer_id, populate_existing=True)
        client = printer_manager.get_client(printer_id)
        if not printer or printer.heat_soak_shutdown_pending or not client or not _dispatch_ready(printer_id):
            return failure(item, "Heat soak could not start: printer unavailable or heater shutdown pending")
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
            return failure(item, "Heat-soak heating commands failed; retry required")
        return Decision(
            "preheating",
            "preheating",
            {"preheat_started_at": heating_started_at},
            partial(_show_preheating, printer_id, True),
        )

    def recover(self, item: PrintQueueItem, now: datetime) -> Decision | None:
        """Return a hold/failure decision; never take over a foreign timer."""
        elapsed = (now - item.preheat_checked_at).total_seconds() if item.preheat_checked_at else HEARTBEAT_TIMEOUT
        if 0 <= elapsed < HEARTBEAT_TIMEOUT:
            return None
        if item.preheat_owner != self.owner:
            return Decision(
                item.status,
                item.status,
                {"error_message": "Heat soak interrupted; inspect the printer, then stop or skip heat soak"},
                partial(_show_preheating, item.printer_id, True),
            )
        return failure(item, "Heat soak interrupted by restart or scheduler timeout; retry required")

    async def on_timeout(self, db: AsyncSession) -> list[int]:
        """Handle the soak timer/heartbeat timeout, independently of queued-job selection."""
        await self.cleanup(db)
        ids = await db.scalars(
            select(PrintQueueItem.id).where(
                PrintQueueItem.status.in_(("preheating", "dispatching")),
                PrintQueueItem.dispatch_subtask_id.is_(None),
                or_(PrintQueueItem.status == "preheating", PrintQueueItem.chamber_heat_soak.is_(True)),
            )
        )
        ready = []
        for item_id in ids:
            try:
                item = await lock_queue_item(db, item_id)
                if not item or item.status not in ("preheating", "dispatching") or item.dispatch_subtask_id:
                    await db.rollback()
                    continue
                now = utcnow()
                recovery = self.recover(item, now)
                if recovery is not None:
                    await apply_decision(db, item, recovery)
                    continue
                if item.preheat_owner != self.owner or item.status == "dispatching":
                    await db.rollback()
                    continue
                printer = await db.get(Printer, item.printer_id)
                state = printer_manager.get_status(item.printer_id)
                requested = item.preheat_requested_at
                disconnected_at = getattr(state, "heat_soak_disconnected_at", 0) if state else 0
                if (
                    not printer
                    or not printer.is_active
                    or not state
                    or not printer_manager.is_connected(item.printer_id)
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
                client = printer_manager.get_client(item.printer_id)
                if client:
                    client.request_status_update()
                item.preheat_checked_at = now
                # Persist liveness and release the control lock before expensive I/O.
                await db.commit()
                if (now - item.preheat_started_at).total_seconds() < item.heat_soak_minutes * 60:
                    continue
                _result, handed_off = await _handoff(db, item, self.owner)
                if handed_off:
                    ready.append(item_id)
            except Exception:
                await db.rollback()
                logger.exception("Queue item %s: heat-soak handoff failed", item_id)
        return ready

    check = on_timeout  # Existing callers/tests; production forwards a named timeout event.

    async def cleanup(self, db: AsyncSession) -> None:
        printer_ids = await db.scalars(select(Printer.id).where(Printer.heat_soak_shutdown_pending.is_(True)))
        for printer_id in printer_ids:
            await cleanup_heat_soak_shutdown(db, printer_id)

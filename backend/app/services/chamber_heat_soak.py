"""Explicit, bounded pre-print heat soaking; no material or keep-warm policy.

Database write locks serialize controls with cancellation. A process owns a
reservation until it finishes or misses its heartbeat; another worker may only
abort an expired attempt, never resume its timer or dispatch its job.
"""

import logging
import time
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from sqlalchemy import and_, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.tasks import spawn_background_task
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.printer_manager import printer_manager, supports_chamber_heater
from backend.app.services.queue_transitions import QueueTransitionConflict, transition_queue_item

logger = logging.getLogger(__name__)
HEARTBEAT_TIMEOUT = 90
TELEMETRY_TIMEOUT = 60


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def supports_airduct(model: str | None) -> bool:
    return supports_chamber_heater(model) or (model or "").strip().upper() in {"P2S", "N7"}


async def lock_queue_item(db: AsyncSession, item_id: int) -> PrintQueueItem | None:
    """Take a write lock on both SQLite and PostgreSQL, then discard stale ORM state."""
    with db.no_autoflush:
        result = await db.execute(
            update(PrintQueueItem)
            .where(PrintQueueItem.id == item_id)
            .values(id=PrintQueueItem.id)
            .execution_options(synchronize_session=False)
        )
        if not result.rowcount:
            return None
        return await db.get(PrintQueueItem, item_id, populate_existing=True)


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


def _heaters_off(printer: Printer) -> None:
    client = printer_manager.get_client(printer.id)
    if not client or not printer_manager.is_connected(printer.id):
        return
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


async def abort_heat_soak(
    db: AsyncSession,
    item: PrintQueueItem,
    reason: str,
    *,
    status: str = "failed",
    schedule_auto_off: bool = False,
) -> None:
    """Caller holds the queue write lock. Persist cleanup even if the item is deleted."""
    await transition_queue_item(
        db, item, item.status, status, values={"error_message": reason, "completed_at": utcnow()}
    )
    printer = await db.get(Printer, item.printer_id)
    if printer:
        printer.heat_soak_shutdown_pending = True
        printer.heat_soak_shutdown_at = utcnow()
    item.error_message = reason
    item.completed_at = utcnow()
    item.preheat_owner = None
    item.preheat_started_at = None
    item.preheat_checked_at = None
    # An explicit retry must repeat the complete soak.
    item.manual_start = True
    await db.commit()
    if printer:
        _heaters_off(printer)
    _show_preheating(item.printer_id, False)
    if schedule_auto_off:
        from backend.app.services.print_scheduler import scheduler

        await scheduler._power_off_if_needed(db, item)


async def skip_heat_soak(db: AsyncSession, item: PrintQueueItem) -> None:
    """Continue an active soak into dispatch while retaining its printer hold.

    Skipping is different from stopping: keep the printer's current heater
    targets so the print can start immediately, and disable the soak for
    this queue item.
    """
    await transition_queue_item(db, item, item.status, "dispatching")
    if item.status == "failed":
        await abort_heat_soak(db, item, item.error_message, schedule_auto_off=True)
        return
    item.chamber_heat_soak = False
    item.manual_start = False
    item.error_message = None
    item.completed_at = None
    from backend.app.services.print_scheduler import scheduler

    item.preheat_owner = scheduler._heat_soak.owner
    item.preheat_requested_at = None
    item.preheat_checked_at = None
    item.preheat_started_at = None
    await db.commit()
    _show_preheating(item.printer_id, False)
    from backend.app.core.tasks import spawn_background_task

    spawn_background_task(scheduler._dispatch_after_heat_soak(item.id), name=f"skip-heat-soak-dispatch-{item.id}")


class ChamberHeatSoak:
    def __init__(self):
        self.owner = str(uuid4())
        self._visible_printers: set[int] = set()

    async def stage(
        self,
        db: AsyncSession,
        item: PrintQueueItem,
        *,
        bind_values: Mapping[str, Any] | None = None,
        unassigned: bool = False,
    ) -> bool:
        """Hold the printer and start heating.

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
            await transition_queue_item(
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
            await db.commit()
        except (IntegrityError, QueueTransitionConflict):
            await db.rollback()
            return False
        # Reservation is durable before any heater command. Re-lock to ensure
        # a cancellation during commit cannot be followed by heater-on commands.
        item = await lock_queue_item(db, item_id)
        if not item or item.status != "preheating" or item.preheat_owner != self.owner:
            await db.rollback()
            return False
        printer = await db.get(Printer, printer_id, populate_existing=True)
        state = printer_manager.get_status(printer_id)
        client = printer_manager.get_client(printer_id)
        if (
            not printer
            or printer.heat_soak_shutdown_pending
            or not client
            or not printer_manager.is_connected(printer_id)
            or not state
            or state.state not in ("IDLE", "FINISH", "FAILED")
        ):
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
        self._visible_printers.add(printer_id)
        return True

    async def check(self, db: AsyncSession) -> list[int]:
        """Advance timers without sleeping or blocking other printers' scheduling."""
        await self.cleanup(db)
        ids = list(
            (
                await db.scalars(
                    select(PrintQueueItem.id).where(
                        or_(
                            PrintQueueItem.status == "preheating",
                            and_(
                                PrintQueueItem.status == "dispatching",
                                PrintQueueItem.chamber_heat_soak.is_(True),
                                PrintQueueItem.dispatch_subtask_id.is_(None),
                            ),
                        )
                    )
                )
            ).all()
        )
        ready = []
        visible: set[int] = set()
        for item_id in ids:
            item = await lock_queue_item(db, item_id)
            if not item or item.status not in ("preheating", "dispatching") or item.dispatch_subtask_id:
                await db.rollback()
                continue
            now = utcnow()
            elapsed = (now - item.preheat_checked_at).total_seconds() if item.preheat_checked_at else HEARTBEAT_TIMEOUT
            if item.preheat_owner != self.owner:
                # There is no submission ID before dispatch, so telemetry cannot
                # prove this interrupted soak. Preserve the reservation until
                # the user chooses Stop or Skip heat soak in the Queue.
                if 0 <= elapsed < HEARTBEAT_TIMEOUT:
                    await db.rollback()
                    continue
                item.error_message = "Heat soak interrupted; inspect the printer, then stop or skip heat soak"
                _show_preheating(item.printer_id, True)
                visible.add(item.printer_id)
                await db.commit()
                continue
            if elapsed < 0 or elapsed >= HEARTBEAT_TIMEOUT:
                await abort_heat_soak(db, item, "Heat soak interrupted by restart or scheduler timeout; retry required")
                continue
            if item.status == "dispatching":
                await db.rollback()
                continue
            visible.add(item.printer_id)
            _show_preheating(item.printer_id, True)
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
            if (now - item.preheat_started_at).total_seconds() >= item.heat_soak_minutes * 60:
                _show_preheating(item.printer_id, False)
                try:
                    await transition_queue_item(
                        db,
                        item,
                        item.status,
                        "dispatching",
                        dispatch_guard=lambda item=item, state=state: (
                            printer_manager.is_connected(item.printer_id)
                            and state.state in ("IDLE", "FINISH", "FAILED")
                        ),
                    )
                except QueueTransitionConflict:
                    # Earlier handoffs already committed. Keep their IDs so a
                    # competing Stop or fresh activity on this printer cannot
                    # prevent the other printers' workers from being spawned.
                    await db.rollback()
                    logger.info("Queue item %s changed or became unavailable during heat-soak handoff", item_id)
                    continue
                if item.status == "failed":
                    await abort_heat_soak(db, item, item.error_message, schedule_auto_off=True)
                    continue
                # No acknowledgement timeout until the upload and send boundary.
                item.dispatched_at = None
                ready.append(item.id)
            client = printer_manager.get_client(item.printer_id)
            if client:
                client.request_status_update()
            item.preheat_checked_at = now
            await db.commit()
        for printer_id in self._visible_printers - visible:
            _show_preheating(printer_id, False)
        self._visible_printers = visible
        return ready

    async def cleanup(self, db: AsyncSession) -> None:
        printers = list((await db.scalars(select(Printer).where(Printer.heat_soak_shutdown_pending.is_(True)))).all())
        for printer in printers:
            # Lock the printer so cleanup cannot race a new staging attempt.
            await db.execute(
                update(Printer)
                .where(Printer.id == printer.id)
                .values(heat_soak_shutdown_pending=Printer.heat_soak_shutdown_pending)
            )
            await db.refresh(printer)
            if not printer.heat_soak_shutdown_pending:
                await db.rollback()
                continue
            _heaters_off(printer)
            client = printer_manager.get_client(printer.id)
            if client:
                client.request_status_update()
            state = printer_manager.get_status(printer.id)
            since = printer.heat_soak_shutdown_at
            confirmed = bool(
                state
                and since
                and printer_manager.is_connected(printer.id)
                and _reported(state, "bed_target", 0, since)
            )
            if supports_chamber_heater(printer.model):
                confirmed = confirmed and _reported(state, "chamber_target", 0, since)
            if confirmed:
                printer.heat_soak_shutdown_pending = False
                printer.heat_soak_shutdown_at = None
            await db.commit()

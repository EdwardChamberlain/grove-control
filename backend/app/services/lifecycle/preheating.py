"""Preheating (#204): hold the printer and heat it for a bounded soak, then hand off to dispatching.

A live soak carries a ``soak_end`` deadline (#217). When it falls due the soak
hands off to dispatching, once the printer is idle. A soak without a deadline
was interrupted by a restart: its heaters are turned off and its hold waits
for Stop or Skip heat soak. While a soak is live, each tick of the lifecycle
loop ends it if its printer becomes unavailable.
"""

import logging
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.tasks import spawn_background_task
from backend.app.models.print_queue import ACTIVE_STATUSES, PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.lifecycle import clock
from backend.app.services.lifecycle.engine import (
    hold_printer,
    lock_queue_item,
    transition_queue_item,
)
from backend.app.services.printer_manager import printer_manager, supports_chamber_heater

logger = logging.getLogger(__name__)
INTERRUPTED = "Heat soak interrupted and its heaters turned off; inspect the printer, then stop or skip heat soak"
TELEMETRY_TIMEOUT = 60
RETRY_HANDOFF = timedelta(seconds=30)  # A soak that ends while its printer is busy tries again.


def utcnow() -> datetime:
    return clock.naive_now()


def supports_airduct(model: str | None) -> bool:
    return supports_chamber_heater(model) or (model or "").strip().upper() in {"P2S", "N7"}


def _reported(state, key: str, value: int, since: datetime) -> bool:
    report = getattr(state, "heat_soak_reports", {}).get(key)
    return bool(
        report
        and report[0] == value
        and report[1] >= since.replace(tzinfo=timezone.utc).timestamp()
        and 0 <= clock.now().timestamp() - report[1] < TELEMETRY_TIMEOUT
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
    """Record a durable heater shutdown; the lifecycle loop retries it until telemetry confirms it."""
    from backend.app.services.lifecycle import deadlines, effects

    printer = await db.get(Printer, printer_id)
    if printer is not None:
        printer.heat_soak_shutdown_pending = True
        printer.heat_soak_shutdown_at = clock.now()
        effects.after_commit(db, deadlines.wake, key="lifecycle_wake")


async def shut_down_inherited(change, row) -> None:
    """A later state's exit: a failed or stopped attempt shuts down the heaters its soak left on.

    The shutdown is durable, and runs with the outcome's other effects.
    """
    from backend.app.services.lifecycle import effects

    soaked = row.preheat_requested_at is not None or row.chamber_heat_soak
    if change.after in ("failed", "cancelled", "unsuccessful") and soaked and row.printer_id is not None:
        await request_heater_shutdown(change.db, row.printer_id)
        effect = effects.QueueOutcomeEffect(change.item_id, change.after, row.printer_id, shut_down_heaters=True)
        effects.queue_outcome_effect(change.db, effect)


async def cleanup_heat_soak_shutdown(db: AsyncSession, printer_id: int) -> bool:
    """Retry a committed shutdown only while no new job is using the printer."""
    await hold_printer(db, printer_id)
    await db.execute(update(Printer).where(Printer.id == printer_id).values(id=Printer.id))
    printer = await db.get(Printer, printer_id, populate_existing=True)
    if not printer or not printer.heat_soak_shutdown_pending:
        await db.commit()
        return False
    from backend.app.services.lifecycle.queued import in_flight

    active = await db.scalars(
        select(PrintQueueItem).where(
            PrintQueueItem.printer_id == printer_id, PrintQueueItem.status.in_(ACTIVE_STATUSES)
        )
    )
    # An interrupted soak, and an unsent dispatch whose worker has stopped,
    # can cool while their hold remains. A live soak, an upload or a
    # potentially sent job cannot.
    busy = any(
        job.status not in ("preheating", "dispatching")
        or (job.status == "preheating" and job.deadline_at is not None)
        or in_flight(job.id)
        or job.dispatched_at is not None
        for job in active
    )
    if busy or not _heaters_off(printer):
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


async def start_heating(db: AsyncSession, item_id: int) -> bool:
    """Once the hold has committed: turn the heaters on and set the soak's deadline.

    Re-lock first, so that a Stop committed since then is never followed by
    heater-on commands. Only a soak that hasn't started is heated.
    """
    item = await lock_queue_item(db, item_id)
    if not item or item.status != "preheating" or item.preheat_started_at is not None:
        await db.rollback()
        return False
    printer_id = item.printer_id
    await db.execute(update(Printer).where(Printer.id == printer_id).values(id=Printer.id))
    printer = await db.get(Printer, printer_id, populate_existing=True)
    client = printer_manager.get_client(printer_id)
    if not printer or printer.heat_soak_shutdown_pending or not client or not _dispatch_ready(printer_id):
        await abort_heat_soak(db, item, "Heat soak could not start: printer unavailable or heater shutdown pending")
        return False
    # The soak duration is measured from the heater command, not from a
    # later telemetry update. Target telemetry can lag or be omitted by
    # firmware, and it should not make the wait unpredictable.
    started = utcnow()
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
    end = started + timedelta(minutes=item.heat_soak_minutes)
    values = {"preheat_started_at": started, "deadline_at": end, "deadline_kind": "soak_end"}
    await transition_queue_item(db, item, "preheating", "preheating", values=values)
    await db.commit()
    _show_preheating(printer_id, True)
    return True


async def on_exit(change, row) -> None:
    """Exit: leave preheating for ``change.after``, for the reason ``change.action``.

    Dispatching inherits the soak and its heaters. Any other exit records a
    heater shutdown that survives a disconnect or deletion of the job. A
    deleted printer has nothing left to shut down.
    """
    from backend.app.services.lifecycle import effects

    if row.printer_id is not None:
        effects.after_commit(change.db, lambda: _show_preheating(row.printer_id, False))
    if change.after == "dispatching":
        return
    await change.write(preheat_started_at=None)
    if row.printer_id is not None and change.action != "printer_deleted":
        await request_heater_shutdown(change.db, row.printer_id)
        effects.shut_down_heaters(change.db, row.printer_id)


async def abort_heat_soak(
    db: AsyncSession,
    item: PrintQueueItem,
    reason: str,
    *,
    status: str = "failed",
    commit: bool = True,
) -> None:
    """Exit with a reason. Caller holds the job's printer; heater shutdown survives deletion of the job."""
    action = (
        "dispatch_failure"
        if status == "failed" and item.dispatched_at is None and item.dispatch_subtask_id is None
        else None
    )
    await transition_queue_item(
        db,
        item,
        item.status,
        status,
        action=action,
        values={"error_message": reason, "completed_at": utcnow()},
    )
    if commit:
        await db.commit()


def heat_soak_dispatch_started(item: PrintQueueItem) -> bool:
    """The durable hold itself proves that this soak has handed off."""
    return item.status in ("dispatching", "printing", "paused", "finished", "successful")


class SkipHeatSoakResult(str, Enum):
    SKIPPED = "skipped"
    PRINTER_NOT_READY = "printer_not_ready"
    SOAK_CHANGED = "soak_changed"


async def _hand_off(db: AsyncSession, item: PrintQueueItem, values: Mapping[str, Any]) -> None:
    """Exit to dispatching; dispatching's entry starts the dispatch once this commits."""
    await transition_queue_item(db, item, "preheating", "dispatching", values={"dispatched_at": None, **values})
    await db.commit()


async def skip_heat_soak(db: AsyncSession, item: PrintQueueItem) -> SkipHeatSoakResult:
    """Exit to dispatching now, for Skip heat soak. The caller has locked the preheating job."""
    if not _dispatch_ready(item.printer_id):
        await db.rollback()
        return SkipHeatSoakResult.PRINTER_NOT_READY
    values = {"chamber_heat_soak": False, "manual_start": False, "error_message": None, "completed_at": None}
    await _hand_off(db, item, values)
    return SkipHeatSoakResult.SKIPPED


async def soak_ended(db: AsyncSession, item_id: int) -> None:
    """The ``soak_end`` deadline: hand off to dispatching once the printer is idle."""
    item = await lock_queue_item(db, item_id)
    if not item or item.status != "preheating" or item.deadline_kind != "soak_end":
        await db.rollback()
        return
    if _dispatch_ready(item.printer_id):
        await _hand_off(db, item, {})
        return
    values = {"deadline_at": utcnow() + RETRY_HANDOFF, "deadline_kind": "soak_end"}
    await transition_queue_item(db, item, "preheating", "preheating", values=values)
    await db.commit()


async def watch(db: AsyncSession) -> None:
    """Each tick: retry pending heater shutdowns, and end live soaks whose printer became unavailable."""
    shutting_down = select(Printer.id).where(Printer.heat_soak_shutdown_pending.is_(True))
    for printer_id in list(await db.scalars(shutting_down)):
        await cleanup_heat_soak_shutdown(db, printer_id)
    live = select(PrintQueueItem.id).where(
        PrintQueueItem.status == "preheating", PrintQueueItem.deadline_at.is_not(None)
    )
    for item_id in list(await db.scalars(live)):
        item = await lock_queue_item(db, item_id)
        if not item or item.status != "preheating" or item.deadline_at is None:
            await db.rollback()
            continue
        printer_id = item.printer_id
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
        await db.rollback()
        client = printer_manager.get_client(printer_id)
        if client:
            client.request_status_update()


async def interrupt(db: AsyncSession) -> None:
    """At startup: soaks the previous process was running are interrupted. Turn their heaters off, keep the hold."""
    live = select(PrintQueueItem.id).where(PrintQueueItem.status == "preheating").order_by(PrintQueueItem.id)
    for item_id in list(await db.scalars(live)):
        item = await lock_queue_item(db, item_id)
        if not item or item.status != "preheating":
            await db.rollback()
            continue
        values = {"deadline_at": None, "deadline_kind": None, "error_message": INTERRUPTED}
        await transition_queue_item(db, item, "preheating", "preheating", values=values)
        await request_heater_shutdown(db, item.printer_id)
        await db.commit()


class ChamberHeatSoak:
    """Preheating's entry from the queue."""

    async def enter(self, db: AsyncSession, item: PrintQueueItem, binding=None) -> bool:
        """Enter: hold the selected printer if the job is unchanged since selection, then turn the heaters on.

        ``binding`` is the scheduler's decision (printer and tray mapping); an
        "Any machine" job must still be unassigned, any other must still
        require that printer.
        """
        item_id, printer_id = item.id, item.printer_id
        unassigned = bool(binding and binding.unassigned)
        await hold_printer(db, printer_id)  # The selected printer, before any write.
        item = await lock_queue_item(db, item_id)
        expected_assignment = None if unassigned else printer_id
        if (
            not item
            or item.status != "queued"
            or item.printer_id is not None
            or item.assigned_printer_id != expected_assignment
            or (binding and binding.edited_fields(item))
        ):
            await db.rollback()
            return False
        values = {
            **(binding.values() if binding else {}),
            "printer_id": printer_id,
            "preheat_requested_at": utcnow(),
            "preheat_started_at": None,
            "dispatched_at": None,
            "dispatch_subtask_id": None,
            "error_message": None,
            "waiting_reason": None,
        }
        try:
            await transition_queue_item(db, item, "queued", "preheating", values=values)
            await db.commit()
        except IntegrityError:  # The holding index: another job holds the printer.
            await db.rollback()
            return False
        return await start_heating(db, item_id)

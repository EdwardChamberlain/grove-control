"""User actions shared by the Queue and printer controls."""

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.print_queue import ACTIVE_STATUSES, PrintQueueItem
from backend.app.services.lifecycle import clock
from backend.app.services.lifecycle.engine import InvalidQueueTransition, lock_queue_item, transition_queue_item, writer

logger = logging.getLogger(__name__)


async def cancel_job(db: AsyncSession, item: PrintQueueItem) -> None:
    """Cancel waiting work or stop active work, retaining every active hold.

    A print the printer has since replaced with another is stopped without
    sending Stop, which would stop the other print.
    """
    printer_id, item_id = item.printer_id, item.id
    await db.rollback()
    async with writer(printer_id):
        await _cancel_job_locked(db, item_id)


async def stop_current_job(db: AsyncSession, printer_id: int) -> tuple[PrintQueueItem, bool, bool]:
    """Adopt a directly started print if needed, then persist and send its Stop once.

    Returns the stopped job and whether it had crossed the print-command
    boundary. Every Grove Stop route uses this path so intent is durable
    before the printer command is sent.
    """
    from backend.app.services.job_identity import telemetry_identity
    from backend.app.services.lifecycle.printing import ACTIVE, observe_print
    from backend.app.services.printer_manager import printer_manager

    async with writer(printer_id):
        item = await db.scalar(
            select(PrintQueueItem)
            .where(PrintQueueItem.printer_id == printer_id, PrintQueueItem.status.in_(ACTIVE_STATUSES))
            .order_by(PrintQueueItem.id)
            .with_for_update()
        )
        if item is None:
            state = printer_manager.get_status(printer_id)
            identity = telemetry_identity(state) if state else None
            if (
                not state
                or not state.connected
                or not getattr(state, "job_telemetry_ready", False)
                or state.state not in ACTIVE
                or not identity
            ):
                raise InvalidQueueTransition("No identifiable active print is available to stop")
            item, _ = await observe_print(db, printer_id, identity, observed_state=state, active_snapshot=True)
            if item is None:
                raise InvalidQueueTransition("The active print could not be adopted safely; refresh and try again")
        item = await lock_queue_item(db, item.id)
        if item is None or item.status not in ACTIVE_STATUSES:
            raise InvalidQueueTransition("The job changed; refresh before stopping it")
        physical_attempt = item.status in ("printing", "paused") or item.dispatched_at is not None
        command_sent = await _cancel_job_locked(db, item)
        return item, physical_attempt, command_sent


async def _cancel_job_locked(db: AsyncSession, item: PrintQueueItem | int) -> bool:
    from backend.app.services.job_identity import telemetry_identity
    from backend.app.services.lifecycle.printing import ACTIVE, superseded_by
    from backend.app.services.print_scheduler import scheduler
    from backend.app.services.printer_manager import printer_manager

    item_id = item if isinstance(item, int) else item.id
    item = await lock_queue_item(db, item_id)
    if item is None:
        raise InvalidQueueTransition("The job no longer exists")

    queued = item.status == "queued"
    if not queued and item.status not in ACTIVE_STATUSES:
        raise InvalidQueueTransition(f"Cannot cancel a job in {item.status}")
    printer_id, item_id, was_sent = item.printer_id, item.id, item.dispatched_at is not None
    physical_attempt = item.status in ("printing", "paused") or was_sent
    state = printer_manager.get_status(printer_id) if physical_attempt else None
    replaced = physical_attempt and superseded_by(item, state)
    same_live_print = bool(
        physical_attempt
        and state
        and state.connected
        and getattr(state, "job_telemetry_ready", False)
        and state.state in ACTIVE
        and telemetry_identity(state) == item.dispatch_subtask_id
    )
    unsent_active = item.status in ("preheating", "dispatching") and not was_sent
    reason = "Cancelled before printing" if queued or unsent_active else "Stop requested by user"
    if replaced:
        reason = f"Stopped without a Stop command: the printer is running a different print ({replaced})"
    requested_at = clock.now()
    action = "cancel" if queued else "cancel_unsent" if unsent_active else "cancel"
    await transition_queue_item(
        db,
        item,
        item.status,
        "unsuccessful" if queued or unsent_active else "cancelled",
        action=action,
        values={
            "error_message": reason,
            "completed_at": requested_at,
            **({"stop_requested_at": requested_at} if physical_attempt else {}),
            **({"auto_off_after": False} if replaced else {}),  # Never power off the other print.
        },
    )
    # Ending a queued job releases its one-off source inside the transition;
    # the files are removed once this commit succeeds.
    await db.commit()

    await scheduler.workers.cancel_and_wait(item_id)
    # Stop only a print that may have been sent: never a soak or an unsent
    # upload, where a Stop could only reach some other print.
    sent = physical_attempt
    stop_sent = False
    if sent and printer_id is not None and not replaced:
        if same_live_print:
            try:
                stop_sent = printer_manager.stop_print(printer_id)
            except Exception:
                logger.exception("Stop command failed for cancelled job %s; printer remains held", item_id)
        else:
            logger.warning(
                "Stop command not sent for cancelled job %s without matching fresh printer identity", item_id
            )
        if not stop_sent:
            logger.warning("Stop command could not be sent for cancelled job %s; printer remains held", item_id)
            try:
                item = await lock_queue_item(db, item_id)
                if item and item.status == "cancelled" and item.physical_outcome is None:
                    message = "Stop command not sent; inspect the printer before clearing the plate"
                    await transition_queue_item(db, item, "cancelled", "cancelled", values={"error_message": message})
                    await db.commit()
                else:
                    await db.rollback()  # A printer observation already settled this job.
            except Exception:
                await db.rollback()
                logger.exception("Could not record failed Stop delivery for job %s", item_id)
    return stop_sent

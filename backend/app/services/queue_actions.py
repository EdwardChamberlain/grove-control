"""User actions shared by the Queue and printer controls."""

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.print_queue import ACTIVE_STATUSES, PrintQueueItem
from backend.app.services.lifecycle import clock
from backend.app.services.lifecycle.engine import InvalidQueueTransition, lock_queue_item, transition_queue_item

logger = logging.getLogger(__name__)


async def cancel_job(db: AsyncSession, item: PrintQueueItem) -> None:
    """Cancel waiting work or stop active work, retaining every active hold.

    A print the printer has since replaced with another is stopped without
    sending Stop, which would stop the other print.
    """
    from backend.app.services.lifecycle.printing import ACTIVE, superseded_by
    from backend.app.services.printer_manager import printer_manager

    queued = item.status == "queued"
    if not queued and item.status not in ACTIVE_STATUSES:
        raise InvalidQueueTransition(f"Cannot cancel a job in {item.status}")
    printer_id, item_id, item_status, was_sent = item.printer_id, item.id, item.status, item.dispatched_at is not None
    replaced = item.status in ("printing", "paused") and superseded_by(
        item, printer_manager.get_status(printer_id), ACTIVE
    )
    reason = "Cancelled before printing" if queued else "Stop requested by user"
    if replaced:
        reason = f"Stopped without a Stop command: the printer is running a different print ({replaced})"
    requested_at = clock.now()
    await transition_queue_item(
        db,
        item,
        item.status,
        "unsuccessful" if queued else "cancelled",
        action="cancel",
        values={
            "error_message": reason,
            "completed_at": requested_at,
            **({"stop_requested_at": requested_at} if not queued else {}),
            **({"auto_off_after": False} if replaced else {}),  # Never power off the other print.
        },
    )
    # Ending a queued job releases its one-off source inside the transition;
    # the files are removed once this commit succeeds.
    await db.commit()

    from backend.app.services.print_scheduler import scheduler

    scheduler.workers.cancel(item_id)
    # Stop only a print that may have been sent: never a soak or an unsent
    # upload, where a Stop could only reach some other print.
    sent = item_status in ("printing", "paused") or (item_status == "dispatching" and was_sent)
    if sent and printer_id is not None and not replaced:
        from backend.app.services.lifecycle.intake import mark_printer_stopped_by_user

        mark_printer_stopped_by_user(printer_id)
        try:
            stop_sent = printer_manager.stop_print(printer_id)
        except Exception:
            logger.exception("Stop command failed for cancelled job %s; printer remains held", item_id)
            stop_sent = False
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

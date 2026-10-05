"""User actions shared by the Queue and printer controls."""

import logging
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.print_queue import ACTIVE_STATUSES, PrintQueueItem
from backend.app.services.lifecycle.engine import InvalidQueueTransition, QueueTransitionConflict, transition_queue_item

logger = logging.getLogger(__name__)


async def cancel_job(db: AsyncSession, item: PrintQueueItem) -> None:
    """Cancel waiting work or stop active work, retaining every active hold."""
    from backend.app.services.printer_manager import printer_manager

    queued = item.status == "queued"
    if not queued and item.status not in ACTIVE_STATUSES:
        raise InvalidQueueTransition(f"Cannot cancel a job in {item.status}")
    printer_id, item_id = item.printer_id, item.id
    heating = not queued and item.chamber_heat_soak
    requested_at = datetime.now(timezone.utc)
    await transition_queue_item(
        db,
        item,
        item.status,
        "unsuccessful" if queued else "cancelled",
        action="cancel",
        values={
            "error_message": "Cancelled before printing" if queued else "Stop requested by user",
            "completed_at": requested_at,
            **({"stop_requested_at": requested_at} if not queued else {}),
        },
    )
    if heating:
        item.preheat_owner = None
        item.preheat_started_at = None
        item.preheat_checked_at = None
    # Ending a queued job releases its one-off source inside the transition;
    # the files are removed once this commit succeeds.
    await db.commit()

    from backend.app.services.print_scheduler import scheduler

    scheduler.cancel_inflight(item_id)
    if not queued and printer_id is not None:
        from backend.app.main import mark_printer_stopped_by_user

        mark_printer_stopped_by_user(printer_id)
        try:
            stop_sent = printer_manager.stop_print(printer_id)
        except Exception:
            logger.exception("Stop command failed for cancelled job %s; printer remains held", item_id)
            stop_sent = False
        if not stop_sent:
            logger.warning("Stop command could not be sent for cancelled job %s; printer remains held", item_id)
            try:
                await transition_queue_item(
                    db,
                    item,
                    "cancelled",
                    "cancelled",
                    conditions=(PrintQueueItem.physical_outcome.is_(None),),
                    values={"error_message": "Stop command not sent; inspect the printer before clearing the plate"},
                )
                await db.commit()
            except QueueTransitionConflict:
                await db.rollback()  # A printer observation already settled this job.
            except Exception:
                await db.rollback()
                logger.exception("Could not record failed Stop delivery for job %s", item_id)

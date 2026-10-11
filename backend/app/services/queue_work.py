"""Printer queue-work matching shared by Print/Queue and per-job Auto Off."""

from sqlalchemy import and_, func, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.print_queue import ACTIVE_STATUSES, PrintQueueItem, PrintQueueVariant
from backend.app.models.printer import Printer


def has_queue_work(printer_id, model, location):
    """Match assigned jobs and unassigned model/variant jobs at this location."""
    model_match = or_(
        func.lower(PrintQueueItem.target_model) == func.lower(model),
        select(PrintQueueVariant.id)
        .where(PrintQueueVariant.queue_item_id == PrintQueueItem.id)
        .where(func.lower(PrintQueueVariant.target_model) == func.lower(model))
        .exists(),
    )
    return (
        select(PrintQueueItem.id)
        .where(
            PrintQueueItem.status.in_(("queued", *ACTIVE_STATUSES)),
            or_(
                func.coalesce(PrintQueueItem.printer_id, PrintQueueItem.assigned_printer_id) == printer_id,
                and_(
                    func.coalesce(PrintQueueItem.printer_id, PrintQueueItem.assigned_printer_id).is_(None),
                    model != "",
                    model_match,
                    or_(
                        PrintQueueItem.target_location.is_(None),
                        PrintQueueItem.target_location == "",
                        PrintQueueItem.target_location == location,
                    ),
                ),
            ),
        )
        .exists()
        .correlate(Printer)
    )


async def printer_has_queue_work(db: AsyncSession, printer_id: int) -> bool:
    """Whether queued or active jobs are assigned to, or eligible for, a printer."""
    printer = await db.get(Printer, printer_id)
    if printer is None:
        # Unknown printer state is not evidence that powering it off is safe.
        return True
    return bool(
        await db.scalar(select(has_queue_work(literal(printer.id), literal(printer.model), literal(printer.location))))
    )

"""The printer-facing queue-work signal used by the Print/Queue action."""

from sqlalchemy import and_, func, or_, select

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

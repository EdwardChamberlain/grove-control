"""User actions shared by the Queue and printer controls."""

import logging
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.print_queue import PrintQueueItem
from backend.app.services.queue_transitions import ACTIVE_STATUSES, InvalidQueueTransition, transition_queue_item

logger = logging.getLogger(__name__)


async def cancel_job(db: AsyncSession, item: PrintQueueItem) -> None:
    """Cancel waiting work or stop active work, retaining every active hold."""
    from backend.app.models.printer import Printer
    from backend.app.services.archive import record_dispatch_outcome
    from backend.app.services.chamber_heat_soak import _heaters_off, _show_preheating, utcnow
    from backend.app.services.printer_manager import printer_manager
    from backend.app.services.queue_source_cleanup import (
        remove_queue_only_artifacts,
        remove_queue_only_source_if_unused,
    )

    queued = item.status == "queued"
    if not queued and item.status not in ACTIVE_STATUSES:
        raise InvalidQueueTransition(f"Cannot cancel a job in {item.status}")
    printer_id, item_id = item.printer_id, item.id
    heating = not queued and item.chamber_heat_soak
    printer = await db.get(Printer, printer_id) if heating else None
    await transition_queue_item(
        db,
        item,
        item.status,
        "unsuccessful" if queued else "cancelled",
        action="cancel",
        values={
            "error_message": "Cancelled before printing" if queued else "Stopped by user",
            "completed_at": datetime.now(timezone.utc),
        },
    )
    if heating:
        if printer:
            printer.heat_soak_shutdown_pending = True
            printer.heat_soak_shutdown_at = utcnow()
        item.preheat_owner = None
        item.preheat_started_at = None
        item.preheat_checked_at = None
    if not queued:
        await record_dispatch_outcome(
            db,
            status="aborted",
            dispatched_queue_item_id=item_id,
            archive_id=item.archive_id,
            completed_at=item.completed_at,
            clear_failure_reason=True,
        )
    cleanup_paths = []
    if queued and item.cleanup_library_after_dispatch and item.library_file_id:
        cleanup_paths = await remove_queue_only_source_if_unused(db, item.library_file_id)
    await db.commit()
    remove_queue_only_artifacts(cleanup_paths)

    from backend.app.services.print_scheduler import scheduler

    scheduler.cancel_inflight(item_id)
    if not queued and printer_id is not None:
        from backend.app.main import mark_printer_stopped_by_user, unregister_expected_print

        mark_printer_stopped_by_user(printer_id)
        unregister_expected_print(printer_id)
        try:
            printer_manager.stop_print(printer_id)
        except Exception:
            logger.exception("Stop command failed for cancelled job %s; printer remains held", item_id)
        if heating:
            if printer:
                _heaters_off(printer)
            _show_preheating(printer_id, False)
        if item.auto_off_after:
            from backend.app.services.smart_plug_manager import smart_plug_manager

            await smart_plug_manager.schedule_off_after_queue_job(printer_id, db)

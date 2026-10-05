"""Final (#204): the job has ended and let go of its printer; only its record remains.

Covers successful and unsuccessful. Enter: ``end`` ends a holding job (only a
finished print ends successful), and ``release_printer`` every job holding a
deleted printer. The engine then runs ``on_enter``, which releases the job's
Queue-only sources and, after Clear Plate on a failed attempt, its sent upload.
There is no wait, exit or recovery: Retry makes a new job.
"""

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.print_queue import HOLDING_STATUSES, PrintQueueItem, PrintQueueVariant
from backend.app.models.printer import Printer
from backend.app.services.lifecycle.engine import InvalidQueueTransition, transition_queue_item


async def end(db: AsyncSession, item: PrintQueueItem, action: str, **values) -> None:
    """Enter from ``item``'s holding state, for ``action``: only a finished print ends successful."""
    status = "successful" if item.status == "finished" else "unsuccessful"
    await transition_queue_item(db, item, item.status, status, action=action, values=values)


async def release_printer(db: AsyncSession, printer: Printer) -> None:
    """Enter for printer deletion: end every job holding the printer, leaving waiting jobs to retarget.

    Heat-soak heaters are shut down by a loop that retries until telemetry
    confirms zero targets, and that loop needs this printer row. While Grove
    can reach the printer, the soak must stop and its shutdown finish first. A
    disconnected printer cannot be commanded either way, so it is not held.
    """
    from backend.app.services.lifecycle.preheating import is_soaking
    from backend.app.services.printer_manager import printer_manager

    held = (PrintQueueItem.printer_id == printer.id, PrintQueueItem.status.in_(HOLDING_STATUSES))
    holding = list((await db.scalars(select(PrintQueueItem).where(*held).with_for_update())).all())
    soaking = printer.heat_soak_shutdown_pending or any(is_soaking(item) for item in holding)
    if soaking and printer_manager.is_connected(printer.id):
        raise InvalidQueueTransition(
            "Stop the heat soak and wait for heater shutdown to be confirmed before deleting this printer"
        )
    for item in holding:
        # A finished print keeps its outcome; only an unsuccessful end is
        # explained by the deletion. Jobs that already ended keep their time.
        values = {"error_message": "Printer deleted"} if item.status != "finished" else {}
        if item.completed_at is None:
            values["completed_at"] = datetime.now(timezone.utc)
        await end(db, item, "printer_deleted", **values)


async def on_enter(change, row) -> None:
    """Enter: release the job's Queue-only sources, and after a failed attempt's Clear Plate its sent upload."""
    from backend.app.services.lifecycle import effects
    from backend.app.services.queue_source_cleanup import remove_queue_only_source_if_unused

    variants = select(PrintQueueVariant.library_file_id).where(PrintQueueVariant.queue_item_id == change.item_id)
    source_ids = {*await change.db.scalars(variants), row.library_file_id}
    for source_id in sorted(source_ids - {None}):
        await remove_queue_only_source_if_unused(change.db, source_id)
    if change.action == "clear_plate" and change.after == "unsuccessful":
        # The failed attempt's sent upload is removed once its plate is clear.
        effect = effects.QueueOutcomeEffect(change.item_id, change.after, row.printer_id, clean_sd_copy=True)
        effects.queue_outcome_effect(change.db, effect)

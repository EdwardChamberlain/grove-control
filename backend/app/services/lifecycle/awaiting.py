"""Awaiting (#204): retain the ended print's hold until Clear Plate; retry final effects after commit."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.print_queue import AWAITING_PLATE_CLEAR_STATUSES, PrintQueueItem
from backend.app.models.settings import Settings
from backend.app.services.lifecycle.engine import InvalidQueueTransition
from backend.app.services.lifecycle.final import end


async def on_enter(change, row) -> None:
    """Enter: clear a finished plate at once when confirmation is off, or queue a failed or stopped job's effects.

    Those are Auto Off, and a failure notification unless the printer reported
    the failure, whose completion notifies instead.
    """
    from backend.app.services.lifecycle import effects, queued

    if change.after == "finished":
        confirmation = await change.db.scalar(select(Settings.value).where(Settings.key == "require_plate_clear"))
        if confirmation is not None and confirmation.lower() in ("false", "0"):
            await clear_job_plate(change.db, change.item, automatic=True)
        return
    if change.action == "dispatch_failure":
        item = (
            change.item
            if isinstance(change.item, PrintQueueItem)
            else await change.db.get(PrintQueueItem, change.item_id)
        )
        if item is not None and item.retry_on_failure:
            # This replacement is inserted in the failed transition's own
            # transaction. A crash cannot commit the failure without its one
            # child, and the child carries no retry history or parent link.
            await queued.create_retry_job(change.db, item)
    notify = change.after == "failed" and change.action != "printer_report"
    effects.queue_outcome_effect(
        change.db, effects.QueueOutcomeEffect(change.item_id, change.after, row.printer_id, notify_failure=notify)
    )


async def on_exit(change, row) -> None:
    """Exit: once a failed or stopped attempt's plate is cleared, remove its sent upload after commit."""
    from backend.app.services.lifecycle import effects

    if change.action == "clear_plate" and change.before in ("failed", "cancelled"):
        effect = effects.QueueOutcomeEffect(change.item_id, change.after, row.printer_id, clean_sd_copy=True)
        effects.queue_outcome_effect(change.db, effect)


async def clear_job_plate(db: AsyncSession, item: PrintQueueItem | int, *, automatic: bool = False) -> None:
    """Exit for Clear Plate, refused while the printer runs another print."""
    from backend.app.services.job_identity import printer_active

    if isinstance(item, int):
        item = await db.get(PrintQueueItem, item)
    if item is None or item.status not in AWAITING_PLATE_CLEAR_STATUSES:
        raise InvalidQueueTransition("This job is not awaiting plate clear")
    if item.status == "failed" and item.physical_outcome is None:
        raise InvalidQueueTransition("This dispatch failed before the print command; there is no plate hold to clear")
    if printer_active(item.printer_id):
        if automatic:
            return  # Keep the physical outcome and hold if another print is already active.
        raise InvalidQueueTransition("The printer is still active. Stop or finish its print before clearing the plate")
    await end(db, item, "clear_plate")

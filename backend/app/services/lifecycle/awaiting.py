"""Awaiting (#204): retain the ended print's hold until Clear Plate; retry final effects after commit."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.print_queue import AWAITING_PLATE_CLEAR_STATUSES, PrintQueueItem
from backend.app.models.settings import Settings
from backend.app.services.lifecycle.engine import InvalidQueueTransition
from backend.app.services.lifecycle.final import end


async def on_enter(change, row) -> None:
    """Enter: clear a finished plate at once when confirmation is off, or queue a failed or stopped job's effects."""
    from backend.app.services.lifecycle import effects

    if change.after == "finished":
        confirmation = await change.db.scalar(select(Settings.value).where(Settings.key == "require_plate_clear"))
        if confirmation is not None and confirmation.lower() in ("false", "0"):
            await clear_job_plate(change.db, change.item, automatic=True)
        return
    if change.before != "dispatching":
        await effects.awaiting_outcome(change, row)


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
    if printer_active(item.printer_id):
        if automatic:
            return  # Keep the physical outcome and hold if another print is already active.
        raise InvalidQueueTransition("The printer is still active. Stop or finish its print before clearing the plate")
    await end(db, item, "clear_plate")

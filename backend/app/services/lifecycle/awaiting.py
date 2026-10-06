"""Awaiting plate clear (#204): a print has ended, and its job holds the printer until the plate is clear.

Covers finished, failed and cancelled. Enter: the engine writes the physical
outcome with the status, then ``on_enter`` clears a finished plate at once when
confirmation is off, or queues a failed or stopped job's effects. Wait: for a
person. Exit, given a reason: ``clear_job_plate``, ``transfer_hold`` for a new
external print, printer deletion (``final.release_printer``), or the printer's
report that a stopped print finished. ``on_exit`` removes a failed or stopped
attempt's sent upload once its plate is cleared. Recover: the hold is durable,
and the printer manager rebuilds its plate-clear view from it at startup.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.print_queue import AWAITING_PLATE_CLEAR_STATUSES, PrintQueueItem
from backend.app.models.settings import Settings
from backend.app.services.lifecycle.engine import InvalidQueueTransition
from backend.app.services.lifecycle.final import end


async def on_enter(change, row) -> None:
    """Enter: clear a finished plate at once when confirmation is off, or queue a failed or stopped job's effects."""
    from backend.app.services.lifecycle import effects, preheating

    if change.after == "finished":
        confirmation = await change.db.scalar(select(Settings.value).where(Settings.key == "require_plate_clear"))
        if confirmation is not None and confirmation.lower() in ("false", "0"):
            await clear_job_plate(change.db, change.item, automatic=True)
        return
    # Keep shutdown retryable after disconnect, deletion of the job, or a
    # process exit before the after-commit effect gets to run. Preheating's
    # exit shuts its own heaters down; a heat-soaked job that fails later is
    # shut down here until its state has an exit (stages 5 and 6).
    heating = change.before != "preheating" and (row.preheat_requested_at is not None or row.chamber_heat_soak)
    if heating and row.printer_id is not None:
        await preheating.request_heater_shutdown(change.db, row.printer_id)
    unconfirmed = change.action != "printer_report"
    effect = effects.QueueOutcomeEffect(
        job_id=change.item_id,
        new_state=change.after,
        printer_id=row.printer_id,
        shut_down_heaters=heating,
        notify_failure=change.after == "failed" and change.before in ("preheating", "dispatching") and unconfirmed,
        clean_sd_copy=change.after == "failed" and change.before == "dispatching" and unconfirmed,
    )
    effects.queue_outcome_effect(change.db, effect)


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


async def transfer_hold(db: AsyncSession, held: PrintQueueItem, identity: str) -> bool:
    """Exit for a new external print on the held plate, and say whether the hold passed to it.

    Only an ended job passes its hold on, so the printer never becomes free.
    The job keeps its physical outcome.
    """
    if held.status not in AWAITING_PLATE_CLEAR_STATUSES:
        return False
    reason = f"Printer hold transferred to externally started print {identity}"
    message = f"{held.error_message}; {reason}" if held.error_message else reason
    await end(db, held, "hold_transferred", error_message=message)
    return True

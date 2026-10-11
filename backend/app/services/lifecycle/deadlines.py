"""The lifecycle loop: run job deadlines and the small remaining soak/archive checks."""

import asyncio
import logging
from contextlib import suppress
from functools import partial

from sqlalchemy import func, select

from backend.app.core import database
from backend.app.core.database import run_with_retry
from backend.app.models.print_queue import PrintQueueItem
from backend.app.services.lifecycle import clock

logger = logging.getLogger(__name__)
TICK = 30
_wake: asyncio.Event | None = None


def wake() -> None:
    """Run the loop now rather than at its next deadline or tick."""
    if _wake is not None:
        _wake.set()


def _handlers(dispatcher):
    from backend.app.services.lifecycle import dispatching, preheating

    return {
        "soak_end": preheating.soak_ended,
        "dispatch_ready": dispatcher.ready_due,
        "dispatch_ack": dispatching.acknowledgement_due,
    }


async def start(dispatcher) -> None:
    """At startup: settle what the previous process left mid-wait."""
    from backend.app.services.lifecycle import dispatching, preheating

    await dispatcher.start()
    for settle in (preheating.interrupt, dispatching.arm_unconfirmed):
        try:
            await run_with_retry(settle, label=f"startup {settle.__name__}", session_factory=database.async_session)
        except Exception:
            logger.exception("Startup recovery step %s failed", settle.__name__)


async def tick(dispatcher) -> None:
    """Run deadlines and reconcile printer reports without restarting dispatch work."""
    from backend.app.services.lifecycle import preheating

    handlers = _handlers(dispatcher)
    async with database.async_session() as db:
        due = (
            await db.execute(
                select(PrintQueueItem.id, PrintQueueItem.deadline_kind).where(
                    PrintQueueItem.deadline_at <= clock.naive_now()
                )
            )
        ).all()
    for item_id, kind in due:
        handler = handlers.get(kind)
        if handler is None:
            logger.error("Queue item %s has an unknown deadline kind %r", item_id, kind)
            continue
        try:
            await run_with_retry(partial(_run, handler, item_id), label=f"{kind} deadline for queue item {item_id}")
        except Exception:
            logger.exception("Queue item %s: %s deadline failed", item_id, kind)
    for step, label in (
        (dispatcher.reconcile_printer_reports, "printer-report reconciliation"),
        (preheating.watch, "heat-soak state check"),
    ):
        try:
            await run_with_retry(step, label=label, session_factory=database.async_session)
        except Exception:
            logger.exception("Lifecycle step %s failed", label)
    try:
        from backend.app.services.lifecycle.intake import reconcile_print_archives

        await reconcile_print_archives()
    except Exception:
        logger.exception("Archive reconciliation failed")


async def _run(handler, item_id: int, db) -> None:
    await handler(db, item_id)


async def _seconds_to_next_deadline() -> float:
    async with database.async_session() as db:
        upcoming = await db.scalar(select(func.min(PrintQueueItem.deadline_at)))
    if upcoming is None:
        return TICK
    return max(0.0, min(TICK, (upcoming - clock.naive_now()).total_seconds()))


async def run(dispatcher) -> None:
    """The loop: tick, then sleep until the next deadline, the next tick, or a wake."""
    global _wake
    _wake = asyncio.Event()
    while True:
        _wake.clear()
        try:
            await tick(dispatcher)
            timeout = await _seconds_to_next_deadline()
        except Exception:
            logger.exception("Lifecycle loop tick failed")
            timeout = TICK
        with suppress(TimeoutError):
            await asyncio.wait_for(_wake.wait(), timeout)

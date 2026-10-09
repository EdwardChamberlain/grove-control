"""The lifecycle loop (#217): a job's wait is a deadline on its row, and one loop serves them all.

Each tick runs the deadlines that are due, then recovery against live
telemetry and the heater-shutdown retries. The loop sleeps until the next
deadline or the 30-second recovery tick, whichever is sooner, and wakes early
when a commit sets a deadline or a printer connects or disconnects.
"""

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
ARCHIVE_REPAIR_INTERVAL = 60
_wake: asyncio.Event | None = None
_next_archive_repair = 0.0


def wake() -> None:
    """Run the loop now rather than at its next deadline or tick."""
    if _wake is not None:
        _wake.set()


def _handlers():
    from backend.app.services.lifecycle import dispatching, preheating

    return {
        "soak_end": preheating.soak_ended,
        "ack": dispatching.acknowledgement_due,
        "ack_landed": dispatching.acknowledgement_due,
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
    """Run due deadlines, then recovery and heater shutdowns."""
    global _next_archive_repair
    from backend.app.services.lifecycle import preheating

    handlers = _handlers()
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
    for step in (dispatcher.recover, preheating.watch):
        try:
            await run_with_retry(step, label=step.__qualname__, session_factory=database.async_session)
        except Exception:
            logger.exception("Lifecycle step %s failed", step.__qualname__)
    now = clock.monotonic()
    if now >= _next_archive_repair:
        from backend.app.services.lifecycle.intake import reconcile_print_archives

        _next_archive_repair = now + ARCHIVE_REPAIR_INTERVAL
        try:
            await reconcile_print_archives()
        except Exception:
            logger.exception("Archive repair failed")


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

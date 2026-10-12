"""Regression coverage for durable queue dispatch claims."""

from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401 - populate Base.metadata
import backend.app.services.print_scheduler as scheduler_module
from backend.app.core.database import Base
from backend.app.models.print_queue import PrintQueueItem
from backend.app.services.print_scheduler import PrintScheduler


@pytest.fixture
async def session_maker():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    maker = async_sessionmaker(engine, expire_on_commit=False)
    try:
        yield maker
    finally:
        await engine.dispose()


async def _queue_item(maker, *, status="pending", claimed=False):
    async with maker() as db:
        item = PrintQueueItem(status=status, dispatching_at=None)
        db.add(item)
        await db.commit()
        if claimed:
            item.dispatching_at = scheduler_module.datetime.now(scheduler_module.timezone.utc)
            await db.commit()
        return item.id


@pytest.mark.asyncio
async def test_dispatch_claim_is_released_after_worker_finishes(session_maker):
    item_id = await _queue_item(session_maker)
    scheduler = PrintScheduler()
    scheduler._start_print = AsyncMock()  # type: ignore[method-assign]

    with patch.object(scheduler_module, "async_session", session_maker):
        await scheduler._dispatch_one(item_id)

    scheduler._start_print.assert_awaited_once()
    async with session_maker() as db:
        item = await db.get(PrintQueueItem, item_id)
        assert item.dispatching_at is None


@pytest.mark.asyncio
async def test_dispatch_claim_skips_cancelled_or_removed_rows(session_maker):
    cancelled_id = await _queue_item(session_maker, status="cancelled")
    removed_id = await _queue_item(session_maker)
    async with session_maker() as db:
        item = await db.get(PrintQueueItem, removed_id)
        await db.delete(item)
        await db.commit()

    scheduler = PrintScheduler()
    scheduler._start_print = AsyncMock()  # type: ignore[method-assign]

    with patch.object(scheduler_module, "async_session", session_maker):
        await scheduler._dispatch_one(cancelled_id)
        await scheduler._dispatch_one(removed_id)

    scheduler._start_print.assert_not_awaited()


@pytest.mark.asyncio
async def test_dispatch_claim_rejects_reassigned_printer(session_maker):
    item_id = await _queue_item(session_maker)
    async with session_maker() as db:
        item = await db.get(PrintQueueItem, item_id)
        item.printer_id = 202
        await db.commit()

    scheduler = PrintScheduler()
    scheduler._start_print = AsyncMock()  # type: ignore[method-assign]

    with patch.object(scheduler_module, "async_session", session_maker):
        await scheduler._dispatch_one(item_id, selected_printer_id=101)

    scheduler._start_print.assert_not_awaited()
    async with session_maker() as db:
        item = await db.get(PrintQueueItem, item_id)
        assert item.status == "pending"
        assert item.printer_id == 202
        assert item.dispatching_at is None


@pytest.mark.asyncio
async def test_stale_dispatch_claims_are_cleared_on_startup(session_maker):
    item_id = await _queue_item(session_maker, claimed=True)
    scheduler = PrintScheduler()

    with patch.object(scheduler_module, "async_session", session_maker):
        await scheduler._clear_stale_dispatch_claims()

    async with session_maker() as db:
        item = await db.get(PrintQueueItem, item_id)
        assert item.dispatching_at is None

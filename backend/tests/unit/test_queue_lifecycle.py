"""The queue transition function is the only writer of PrintQueueItem.status (#194)."""

import ast
from pathlib import Path
from typing import get_args
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.core.database import Base
from backend.app.models.print_queue import PrintQueueItem
from backend.app.schemas.print_queue import PrintQueueItemResponse
from backend.app.services.queue_lifecycle import (
    ALLOWED_TRANSITIONS,
    InvalidQueueTransition,
    transition_queue_item,
)

APP_DIR = Path(__file__).parents[2] / "app"


@pytest.fixture
async def sessions(tmp_path):
    import backend.app.models  # noqa: F401 - populate Base.metadata

    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'queue.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


async def _add_item(sessions, status: str = "pending") -> int:
    async with sessions() as db:
        item = PrintQueueItem(printer_id=None, status=status)
        db.add(item)
        await db.commit()
        return item.id


async def _stored_status(sessions, item_id: int) -> str:
    async with sessions() as db:
        return (await db.get(PrintQueueItem, item_id)).status


def test_table_covers_every_api_status():
    api_statuses = set(get_args(PrintQueueItemResponse.model_fields["status"].annotation))
    assert api_statuses <= ALLOWED_TRANSITIONS.keys()
    for targets in ALLOWED_TRANSITIONS.values():
        assert targets <= api_statuses


@pytest.mark.asyncio
async def test_allowed_transition_writes_status_and_values(sessions):
    item_id = await _add_item(sessions)
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        assert await transition_queue_item(db, item, "failed", error_message="Printer not found")
        assert (item.status, item.error_message) == ("failed", "Printer not found")
        await db.commit()

    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        assert (item.status, item.error_message) == ("failed", "Printer not found")


@pytest.mark.asyncio
async def test_disallowed_transition_raises_and_writes_nothing(sessions):
    item_id = await _add_item(sessions, "completed")
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        with pytest.raises(InvalidQueueTransition):
            await transition_queue_item(db, item, "pending")
        await db.commit()

    assert await _stored_status(sessions, item_id) == "completed"


@pytest.mark.asyncio
async def test_stale_writer_does_not_overwrite_a_newer_status(sessions):
    item_id = await _add_item(sessions)
    async with sessions() as scheduler_db:
        stale = await scheduler_db.get(PrintQueueItem, item_id)
        await scheduler_db.commit()

        async with sessions() as user_db:
            current = await user_db.get(PrintQueueItem, item_id)
            assert await transition_queue_item(user_db, current, "cancelled")
            await user_db.commit()

        # The scheduler still believes the item is pending.
        assert not await transition_queue_item(scheduler_db, stale, "failed", error_message="Upload failed")
        assert stale.status == "pending"
        await scheduler_db.commit()

    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        assert (item.status, item.error_message) == ("cancelled", None)


@pytest.mark.asyncio
async def test_dispatch_failure_after_user_cancel_leaves_item_cancelled(sessions):
    from backend.app.services.print_scheduler import PrintScheduler

    item_id = await _add_item(sessions)
    scheduler = PrintScheduler()
    async with sessions() as scheduler_db:
        stale = await scheduler_db.get(PrintQueueItem, item_id)
        await scheduler_db.commit()

        async with sessions() as user_db:
            current = await user_db.get(PrintQueueItem, item_id)
            assert await transition_queue_item(user_db, current, "cancelled")
            await user_db.commit()

        # The item has no printer, so dispatch fails with "Printer not found".
        with patch.object(scheduler, "_power_off_if_needed", AsyncMock()) as power_off:
            await scheduler._start_print(scheduler_db, stale)
        power_off.assert_not_awaited()

    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        assert (item.status, item.error_message) == ("cancelled", None)


@pytest.mark.asyncio
async def test_extra_conditions_must_also_match(sessions):
    item_id = await _add_item(sessions)
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        assert not await transition_queue_item(
            db, item, "dispatching", where=(PrintQueueItem.dispatch_subtask_id == "123",)
        )
        await db.commit()

    assert await _stored_status(sessions, item_id) == "pending"


@pytest.mark.asyncio
async def test_staying_in_the_same_status_writes_only_values(sessions):
    item_id = await _add_item(sessions, "cancelled")
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        assert await transition_queue_item(db, item, "cancelled", error_message="Stopped by user")
        await db.commit()

    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        assert (item.status, item.error_message) == ("cancelled", "Stopped by user")


@pytest.mark.asyncio
async def test_assigning_status_on_a_stored_row_is_rejected(sessions):
    # A new row may start in any status.
    item_id = await _add_item(sessions, "printing")
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        with pytest.raises(InvalidQueueTransition):
            item.status = "completed"


def _builds_status_update_of_queue_items(call: ast.Call) -> bool:
    """True for ``update(PrintQueueItem)…values(status=…)`` or the ``__table__`` form."""
    if not (isinstance(call.func, ast.Attribute) and call.func.attr == "values"):
        return False
    if not any(keyword.arg == "status" for keyword in call.keywords):
        return False
    node = call.func.value
    while isinstance(node, ast.Call | ast.Attribute):
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id == "update":
                return bool(node.args) and ast.unparse(node.args[0]) == "PrintQueueItem"
            if isinstance(node.func, ast.Attribute) and ast.unparse(node.func) == "PrintQueueItem.__table__.update":
                return True
            node = node.func
        else:
            node = node.value
    return False


def test_no_other_module_updates_queue_status():
    offenders = []
    for path in APP_DIR.rglob("*.py"):
        if path.name == "queue_lifecycle.py":
            continue
        for node in ast.walk(ast.parse(path.read_text(), filename=str(path))):
            if isinstance(node, ast.Call) and _builds_status_update_of_queue_items(node):
                offenders.append(f"{path.relative_to(APP_DIR)}:{node.lineno}")
    assert offenders == [], "Change queue status through transition_queue_item(): " + ", ".join(offenders)

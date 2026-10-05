"""Specify preheating's exit step (#204 stage 2): what the engine writes as a job leaves preheating."""

from datetime import datetime
from importlib import import_module
from unittest.mock import MagicMock

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401
from backend.app.core.database import Base
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.lifecycle import effects, engine as lifecycle_engine
from backend.app.services.lifecycle.engine import (
    ALLOWED_TRANSITIONS,
    QueueTransitionConflict,
    transition_queue_item,
)
from backend.app.services.lifecycle.preheating import SOAKING, is_soaking

CLAIM = ("preheat_owner", "preheat_started_at", "preheat_checked_at")
REQUESTED = datetime(2026, 1, 1, 12, 0)


@pytest.fixture
async def sessions(tmp_path, monkeypatch):
    # The failure entry's outcome effect is specified elsewhere; keep it out of this transaction's tail.
    monkeypatch.setattr(effects, "queue_outcome_effect", MagicMock())
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'preheating.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


async def soak(sessions) -> int:
    async with sessions() as db:
        db.add(Printer(id=1, name="Soak", serial_number="SOAK", ip_address="127.0.0.1", access_code="code"))
        item = PrintQueueItem(
            printer_id=1,
            status="preheating",
            chamber_heat_soak=True,
            preheat_owner="worker",
            preheat_requested_at=REQUESTED,
            preheat_started_at=REQUESTED,
            preheat_checked_at=REQUESTED,
        )
        db.add(item)
        await db.commit()
        return item.id


@pytest.mark.parametrize(
    "after,action",
    [("dispatching", None), ("failed", None), ("cancelled", "cancel"), ("unsuccessful", "printer_deleted")],
)
async def test_leaving_preheating_releases_the_claim_unless_dispatching_inherits_it(sessions, after, action):
    item_id = await soak(sessions)
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        await transition_queue_item(db, item, "preheating", after, action=action)
        await db.commit()
        released = after != "dispatching"
        assert all((getattr(item, field) is None) == released for field in CLAIM)
    async with sessions() as db:
        row = await db.get(PrintQueueItem, item_id)
        assert row.status == after
        assert all((getattr(row, field) is None) == released for field in CLAIM)
        # The failure entry still knows this job heated, so it shuts the heaters down.
        assert row.preheat_requested_at == REQUESTED
        assert (await db.get(Printer, 1)).heat_soak_shutdown_pending is (after in ("failed", "cancelled"))


async def test_exit_values_are_part_of_the_conditional_write(sessions):
    item_id = await soak(sessions)
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        with pytest.raises(QueueTransitionConflict):
            await transition_queue_item(
                db, item, "preheating", "failed", conditions=(PrintQueueItem.preheat_owner == "another-worker",)
            )
        await db.rollback()
    async with sessions() as db:
        row = await db.get(PrintQueueItem, item_id)
        assert row.status == "preheating" and row.preheat_owner == "worker"


async def test_a_same_state_write_is_not_an_exit(sessions):
    item_id = await soak(sessions)
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        await transition_queue_item(db, item, "preheating", "preheating", values={"error_message": "Inspect"})
        await db.commit()
    async with sessions() as db:
        row = await db.get(PrintQueueItem, item_id)
        assert row.preheat_owner == "worker" and row.preheat_checked_at == REQUESTED


def test_every_exit_belongs_to_a_lifecycle_state_module():
    for state, module in lifecycle_engine._EXITS.items():
        assert state in ALLOWED_TRANSITIONS
        assert module.startswith("backend.app.services.lifecycle.")
        assert callable(import_module(module).exit)


async def test_soaking_query_and_row_check_agree(sessions):
    rows = [
        ("queued", True, None),
        ("preheating", True, None),
        ("dispatching", True, None),
        ("dispatching", True, "sent"),
        ("dispatching", False, None),
        ("printing", True, None),
        ("failed", True, None),
    ]
    async with sessions() as db:
        # No printer, so the holding index does not limit the rows to one per printer.
        db.add_all(PrintQueueItem(status=s, chamber_heat_soak=c, dispatch_subtask_id=d) for s, c, d in rows)
        await db.commit()
        queried = set(await db.scalars(select(PrintQueueItem.id).where(SOAKING)))
        items = list(await db.scalars(select(PrintQueueItem).order_by(PrintQueueItem.id)))
    assert queried == {item.id for item in items if is_soaking(item)}
    assert [item.status for item in items if item.id in queried] == ["preheating", "dispatching"]

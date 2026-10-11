"""Specify preheating's entry and exit (#204 stage 2).

Entry heats only a committed, still-current hold. Exit is a step the engine
runs in the transition's transaction: it releases the soak and shuts the
heaters down. A handoff to dispatching happens once, for the soak it was meant for.
"""

from datetime import datetime
from importlib import import_module
from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest
from sqlalchemy import event, inspect, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import defer

import backend.app.models  # noqa: F401
from backend.app.core.database import Base
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.lifecycle import effects, engine as lifecycle_engine, preheating
from backend.app.services.lifecycle.engine import (
    ALLOWED_TRANSITIONS,
    QueueTransitionConflict,
    transition_queue_item,
    writer,
)
from backend.app.services.print_scheduler import scheduler
from backend.tests.unit.test_chamber_heat_soak import soak  # noqa: F401

REQUESTED = datetime(2026, 1, 1, 12, 0)


async def enter_preheating(db, job, values=None) -> None:
    """Hold a queued job in preheating, for tests that start from a soak whose heaters are on, as ``values`` says."""
    async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
        await transition_queue_item(db, job, "queued", "preheating", values=values)
    await db.commit()


@pytest.fixture
async def sessions(tmp_path, monkeypatch):
    # After-commit effects are specified elsewhere; record them instead of running them.
    monkeypatch.setattr(effects, "queue_outcome_effect", MagicMock())
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'preheating.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


async def preheating_job(sessions) -> int:
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


def test_every_exit_belongs_to_a_lifecycle_state_module():
    for state, module in lifecycle_engine._EXITS.items():
        assert state in ALLOWED_TRANSITIONS
        assert module.startswith("backend.app.services.lifecycle.")
        assert callable(import_module(module).on_exit)


async def test_soaking_statuses_match_the_state_predicate(sessions):
    rows = [
        ("queued", True, None, None, None),
        ("preheating", True, None, None, None),
        ("dispatching", True, None, None, None),
        ("dispatching", True, "sent", None, REQUESTED),
        ("dispatching", False, None, None, None),
        ("dispatching", False, None, REQUESTED, None),
        ("dispatching", False, "sent", REQUESTED, REQUESTED),
        ("printing", True, None, REQUESTED, REQUESTED),
        ("failed", True, None, REQUESTED, None),
    ]
    async with sessions() as db:
        # No printer, so the holding index does not limit the rows to one per printer.
        db.add_all(
            PrintQueueItem(
                status=s, chamber_heat_soak=c, dispatch_subtask_id=d, preheat_requested_at=p, dispatched_at=t
            )
            for s, c, d, p, t in rows
        )
        await db.commit()
        items = list(await db.scalars(select(PrintQueueItem).order_by(PrintQueueItem.id)))
    soaking = {item.id for item in items if preheating.holds_heat_soak_printer(item)}
    assert [item.id for item in items if item.id in soaking] == [items[i].id for i in (1, 2, 5)]


async def test_failed_reservation_commit_never_enters_heating(soak):
    def fail_commit(_connection):
        raise OperationalError("COMMIT", {}, RuntimeError("disk unavailable"))

    engine = soak.engine.sync_engine
    event.listen(engine, "commit", fail_commit)
    try:
        with pytest.raises(OperationalError):
            await soak.service.enter(soak.db, soak.item)
    finally:
        event.remove(engine, "commit", fail_commit)
    await soak.db.rollback()
    await soak.db.refresh(soak.item)
    assert soak.item.status == "queued"
    soak.client.set_bed_temperature.assert_not_called()
    soak.client.set_chamber_temperature.assert_not_called()
    soak.client.set_airduct_mode.assert_not_called()


async def test_a_transition_outside_preheating_does_not_load_deferred_columns(soak, monkeypatch):
    monkeypatch.setattr(scheduler.dispatcher, "schedule_stage", MagicMock())
    soak.db.expunge(soak.item)
    item = await soak.db.scalar(select(PrintQueueItem).options(defer(PrintQueueItem.chamber_heat_soak)))
    assert "chamber_heat_soak" in inspect(item).unloaded
    async with writer(getattr(item, "printer_id", None) or getattr(item, "assigned_printer_id", None)):
        await transition_queue_item(soak.db, item, "queued", "dispatching")
    await soak.db.commit()
    assert item.status == "dispatching"
    soak.client.set_bed_temperature.assert_not_called()


async def test_dispatch_handoff_keeps_soak_heaters_on(soak, monkeypatch):
    shutdown = MagicMock()
    monkeypatch.setattr(preheating, "_heaters_off", shutdown)
    monkeypatch.setattr(scheduler.dispatcher, "schedule_stage", MagicMock())
    item = soak.item
    printer_id = item.printer_id or item.assigned_printer_id
    async with writer(printer_id):
        await transition_queue_item(
            soak.db,
            item,
            "queued",
            "preheating",
            values={"chamber_heat_soak": True, "preheat_requested_at": REQUESTED},
        )
    await soak.db.commit()
    async with writer(printer_id):
        await transition_queue_item(soak.db, item, "preheating", "dispatching")
    await soak.db.commit()
    shutdown.assert_not_called()


async def test_other_heat_soak_exit_turns_heaters_off_after_commit(soak, monkeypatch):
    shutdown = MagicMock()
    monkeypatch.setattr(preheating, "_heaters_off", shutdown)
    item = soak.item
    printer_id = item.printer_id or item.assigned_printer_id
    async with writer(printer_id):
        await transition_queue_item(
            soak.db,
            item,
            "queued",
            "preheating",
            values={"chamber_heat_soak": True, "preheat_requested_at": REQUESTED},
        )
    await soak.db.commit()
    async with writer(printer_id):
        await transition_queue_item(soak.db, item, "preheating", "failed", action="dispatch_failure")
    shutdown.assert_not_called()
    await soak.db.commit()
    shutdown.assert_called_once_with(item.printer_id, "H2D")

"""Specify preheating's entry and exit (#204 stage 2).

Entry heats only a committed, still-current hold. Exit is a step the engine
runs in the transition's transaction: it releases the soak and shuts the
heaters down. A handoff to dispatching happens once, for the soak it was meant for.
"""

from datetime import datetime
from importlib import import_module
from unittest.mock import AsyncMock, MagicMock, call

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
)
from backend.app.services.lifecycle.preheating import SOAKING, is_soaking
from backend.tests.unit.test_chamber_heat_soak import soak  # noqa: F401

CLAIM = ("preheat_owner", "preheat_started_at", "preheat_checked_at")
REQUESTED = datetime(2026, 1, 1, 12, 0)


@pytest.fixture
async def sessions(tmp_path, monkeypatch):
    # After-commit effects are specified elsewhere; record them instead of running them.
    monkeypatch.setattr(effects, "queue_outcome_effect", MagicMock())
    monkeypatch.setattr(effects, "shut_down_heaters", MagicMock())
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


@pytest.mark.parametrize(
    "after,action",
    [("dispatching", None), ("failed", None), ("cancelled", "cancel"), ("unsuccessful", "printer_deleted")],
)
async def test_leaving_preheating_releases_the_soak_unless_dispatching_inherits_it(sessions, after, action):
    item_id = await preheating_job(sessions)
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
        assert row.preheat_requested_at == REQUESTED
        # Exit shuts the heaters down; a deleted printer has none left to shut down.
        shut_down = after in ("failed", "cancelled")
        assert (await db.get(Printer, 1)).heat_soak_shutdown_pending is shut_down
    assert effects.shut_down_heaters.called is shut_down
    # The next state doesn't clean up after preheating.
    assert not any(outcome.args[1].shut_down_heaters for outcome in effects.queue_outcome_effect.call_args_list)


async def test_exit_runs_only_after_the_conditional_write(sessions):
    item_id = await preheating_job(sessions)
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
        assert not (await db.get(Printer, 1)).heat_soak_shutdown_pending
    effects.shut_down_heaters.assert_not_called()


async def test_a_same_state_write_is_not_an_exit(sessions):
    item_id = await preheating_job(sessions)
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
        assert callable(import_module(module).on_exit)


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


async def test_stop_after_reservation_commit_prevents_heater_entry(soak, monkeypatch):
    commit = soak.db.commit

    async def stop_after_commit():
        await commit()
        async with AsyncSession(soak.engine, expire_on_commit=False) as user:
            current = await user.get(PrintQueueItem, soak.item.id)
            await transition_queue_item(user, current, "preheating", "cancelled", action="cancel")
            await user.commit()

    monkeypatch.setattr(soak.db, "commit", stop_after_commit)
    assert not await soak.service.enter(soak.db, soak.item)
    await soak.wait_effects()
    await soak.db.refresh(soak.item)
    assert soak.item.status == "cancelled"
    assert soak.item.preheat_owner is None
    assert call(60) not in soak.client.set_bed_temperature.call_args_list
    assert call(60) not in soak.client.set_chamber_temperature.call_args_list
    assert call("heating") not in soak.client.set_airduct_mode.call_args_list


async def test_rolled_back_exit_preserves_the_timer_and_printer_view(soak):
    assert await soak.service.enter(soak.db, soak.item)
    started = soak.item.preheat_started_at
    soak.client.reset_mock()
    await transition_queue_item(soak.db, soak.item, "preheating", "failed")
    assert soak.state.preheating
    await soak.db.rollback()
    await soak.db.refresh(soak.item)
    await soak.db.refresh(soak.printer)
    assert (soak.item.status, soak.item.preheat_owner, soak.item.preheat_started_at) == (
        "preheating",
        soak.service.owner,
        started,
    )
    assert soak.state.preheating
    assert not soak.printer.heat_soak_shutdown_pending
    await soak.wait_effects()
    soak.client.set_bed_temperature.assert_not_called()
    soak.client.set_chamber_temperature.assert_not_called()


async def test_a_transition_outside_preheating_does_not_load_deferred_columns(soak):
    soak.db.expunge(soak.item)
    item = await soak.db.scalar(select(PrintQueueItem).options(defer(PrintQueueItem.chamber_heat_soak)))
    assert "chamber_heat_soak" in inspect(item).unloaded
    await transition_queue_item(soak.db, item, "queued", "dispatching")
    await soak.db.commit()
    assert item.status == "dispatching"
    soak.client.set_bed_temperature.assert_not_called()


async def test_a_pass_that_selected_a_soak_before_skip_leaves_the_handoff_alone(soak, monkeypatch):
    from backend.app.services.print_scheduler import scheduler

    assert await soak.service.enter(soak.db, soak.item)
    monkeypatch.setattr(scheduler, "_heat_soak", soak.service)
    monkeypatch.setattr(scheduler, "_dispatch_after_heat_soak", AsyncMock())
    lock = preheating.lock_queue_item

    async def skip_then_lock(db, item_id):
        # Skip commits between this pass's select and its lock of the row.
        monkeypatch.setattr(preheating, "lock_queue_item", lock)
        async with AsyncSession(soak.engine, expire_on_commit=False) as user:
            result = await preheating.skip_heat_soak(user, await lock(user, item_id))
        assert result == preheating.SkipHeatSoakResult.SKIPPED
        return await lock(db, item_id)

    monkeypatch.setattr(preheating, "lock_queue_item", skip_then_lock)
    assert await soak.service.wait(soak.db) == []
    await soak.db.refresh(soak.item)
    assert (soak.item.status, soak.item.error_message) == ("dispatching", None)
    scheduler._dispatch_after_heat_soak.assert_called_once_with(soak.item.id)


async def test_a_handoff_for_another_printer_leaves_the_soak_alone(soak):
    assert await soak.service.enter(soak.db, soak.item)
    values = {"dispatching_at": preheating.utcnow()}
    handoff = await preheating._hand_off(soak.db, soak.item.id, soak.service.owner, 2, values)
    assert handoff == (False, preheating.SkipHeatSoakResult.SOAK_CHANGED)
    await soak.db.refresh(soak.item)
    assert (soak.item.status, soak.item.printer_id) == ("preheating", 1)

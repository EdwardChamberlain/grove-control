"""Specify post-commit entry, and the awaiting and final states (#204 stage 3).

The engine runs a state's post-commit entry step only once its transition has
committed, and the writer refuses to enter such a state any other way. A
refused transition runs no step; the step's own errors are raised. Awaiting
and final own their entry and exit steps, which run in the transition's
transaction after the conditional write; a state cleans up on its own exit.
Only an ended job can pass its hold to a new external print.
"""

from importlib import import_module
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import event
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401
from backend.app.core.database import Base
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import AWAITING_PLATE_CLEAR_STATUSES, FINAL_STATUSES, PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.settings import Settings
from backend.app.services import queue_source_cleanup
from backend.app.services.lifecycle import awaiting, effects, engine as lifecycle_engine, preheating
from backend.app.services.lifecycle.engine import (
    ALLOWED_TRANSITIONS,
    InvalidQueueTransition,
    QueueTransitionConflict,
    enter_state,
    transition_queue_item,
)
from backend.tests.unit.test_chamber_heat_soak import soak  # noqa: F401


@pytest.fixture
async def sessions(tmp_path, monkeypatch):
    # After-commit effects are specified elsewhere; record them instead of running them.
    monkeypatch.setattr(effects, "queue_outcome_effect", MagicMock())
    monkeypatch.setattr(effects, "publish_printer_view", MagicMock())
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'awaiting.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        db.add(Printer(id=1, name="Printer", serial_number="TEST", ip_address="127.0.0.1", access_code="code"))
        db.add(LibraryFile(id=7, filename="source.3mf", file_path="source.3mf", file_type="3mf", file_size=1))
        await db.commit()
    yield maker
    await engine.dispose()


async def job(sessions, status: str, **values) -> int:
    async with sessions() as db:
        item = PrintQueueItem(printer_id=1, status=status, **values)
        db.add(item)
        await db.commit()
        return item.id


def test_every_step_belongs_to_its_state_module():
    modules = {state: module.rsplit(".", 1)[1] for state, module in lifecycle_engine._ENTRY.items()}
    assert all(modules[state] == "awaiting" for state in AWAITING_PLATE_CLEAR_STATUSES)
    assert all(modules[state] == "final" for state in FINAL_STATUSES)
    # Awaiting cleans up on its own exit; final has no exit.
    assert all(lifecycle_engine._EXITS[state] == awaiting.__name__ for state in AWAITING_PLATE_CLEAR_STATUSES)
    assert not set(FINAL_STATUSES) & lifecycle_engine._EXITS.keys()
    for state, module in lifecycle_engine._ENTRY.items():
        assert state in ALLOWED_TRANSITIONS
        assert module.startswith("backend.app.services.lifecycle.")
        assert any(callable(getattr(import_module(module), step, None)) for step in ("on_enter", "on_entered"))


async def test_the_writer_refuses_to_skip_a_post_commit_step(sessions):
    item_id = await job(sessions, "queued")
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        with pytest.raises(InvalidQueueTransition, match="enter_state"):
            await transition_queue_item(db, item, "queued", "preheating", values={"preheat_owner": "worker"})
        await db.rollback()
    async with sessions() as db:
        assert (await db.get(PrintQueueItem, item_id)).status == "queued"  # Refused before writing.


async def test_enter_states_permission_covers_only_its_own_transition(sessions, monkeypatch):
    item_id = await job(sessions, "queued")
    async with sessions() as db:
        other = PrintQueueItem(status="queued")  # No printer, so the holding index allows a second hold.
        db.add(other)
        await db.commit()
        other_id = other.id
    refused = []

    async def on_entered(change):
        # The step runs after enter_state's own transition, so it cannot skip another job's step.
        other = await change.db.get(PrintQueueItem, other_id)
        with pytest.raises(InvalidQueueTransition):
            await transition_queue_item(change.db, other, "queued", "preheating")
        refused.append(other_id)
        return True

    monkeypatch.setattr(preheating, "on_entered", on_entered)
    async with sessions() as db:
        assert await enter_state(db, await db.get(PrintQueueItem, item_id), "queued", "preheating")
    assert refused == [other_id]


async def test_post_commit_entry_runs_once_the_transition_has_committed(sessions, monkeypatch):
    item_id = await job(sessions, "queued")
    seen = []

    async def on_entered(change):
        async with sessions() as other:  # Another connection sees only committed data.
            seen.append((await other.get(PrintQueueItem, item_id)).status)
        seen.append((change.before, change.after, change.values["preheat_owner"]))
        return False

    monkeypatch.setattr(preheating, "on_entered", on_entered)
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        entered = await enter_state(db, item, "queued", "preheating", values={"preheat_owner": "worker"})
    assert seen == ["preheating", ("queued", "preheating", "worker")]
    assert entered is False  # The step says whether the job entered.


@pytest.mark.parametrize("refusal", ["conflict", "printer held"])
async def test_a_refused_transition_returns_false_without_its_post_commit_step(sessions, monkeypatch, refusal):
    item_id = await job(sessions, "queued")
    if refusal == "printer held":
        await job(sessions, "printing")  # The holding index refuses a second hold.
    on_entered = AsyncMock(return_value=True)
    monkeypatch.setattr(preheating, "on_entered", on_entered)
    conditions = (PrintQueueItem.printer_id == 2,) if refusal == "conflict" else ()
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        assert await enter_state(db, item, "queued", "preheating", conditions=conditions) is False
    on_entered.assert_not_awaited()
    async with sessions() as db:
        assert (await db.get(PrintQueueItem, item_id)).status == "queued"


async def test_a_failed_commit_raises_without_the_post_commit_step(sessions, monkeypatch):
    item_id = await job(sessions, "queued")
    on_entered = AsyncMock(return_value=True)
    monkeypatch.setattr(preheating, "on_entered", on_entered)

    def fail_commit(_connection):
        raise OperationalError("COMMIT", {}, RuntimeError("disk unavailable"))

    engine = sessions.kw["bind"].sync_engine
    event.listen(engine, "commit", fail_commit)
    try:
        async with sessions() as db:
            item = await db.get(PrintQueueItem, item_id)
            with pytest.raises(OperationalError):
                await enter_state(db, item, "queued", "preheating")
            await db.rollback()
    finally:
        event.remove(engine, "commit", fail_commit)
    on_entered.assert_not_awaited()
    async with sessions() as db:
        assert (await db.get(PrintQueueItem, item_id)).status == "queued"


async def test_errors_in_the_post_commit_step_are_raised_not_reported_as_refusals(sessions, monkeypatch):
    item_id = await job(sessions, "queued")
    monkeypatch.setattr(preheating, "on_entered", AsyncMock(side_effect=QueueTransitionConflict("in the step")))
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        with pytest.raises(QueueTransitionConflict, match="in the step"):
            await enter_state(db, item, "queued", "preheating")
    async with sessions() as db:
        assert (await db.get(PrintQueueItem, item_id)).status == "preheating"  # The hold had committed.


async def test_a_heat_soak_entry_raises_its_heater_steps_errors(soak, monkeypatch):
    # The hold has committed by then, so the error is not a refused hold.
    monkeypatch.setattr(preheating, "on_entered", AsyncMock(side_effect=QueueTransitionConflict("in the step")))
    with pytest.raises(QueueTransitionConflict, match="in the step"):
        await soak.service.enter(soak.db, soak.item)
    await soak.db.refresh(soak.item)
    assert soak.item.status == "preheating"


@pytest.mark.parametrize("owner", ["worker", None])
async def test_heater_entry_heats_the_held_printer_only_for_a_workers_hold(soak, owner):
    # Neither value names the printer: the step heats the one the row holds.
    values = {"preheat_owner": owner} if owner else {}
    entered = await enter_state(soak.db, soak.item, "queued", "preheating", values=values)
    await soak.db.refresh(soak.item)
    assert soak.item.status == "preheating"
    assert entered is (owner is not None)
    assert (soak.item.preheat_started_at is not None) is entered
    assert soak.client.set_bed_temperature.called is entered


async def test_a_state_without_post_commit_entry_has_entered_once_committed(sessions):
    item_id = await job(sessions, "printing")
    async with sessions() as db:
        assert await enter_state(db, await db.get(PrintQueueItem, item_id), "printing", "finished")
    async with sessions() as db:
        assert (await db.get(PrintQueueItem, item_id)).status == "finished"


@pytest.mark.parametrize(
    "before,after,action",
    [
        ("printing", "failed", None),
        ("printing", "cancelled", "cancel"),
        ("finished", "successful", "clear_plate"),
        ("failed", "unsuccessful", "clear_plate"),
    ],
)
async def test_awaiting_and_final_steps_run_only_after_the_conditional_write(
    sessions, monkeypatch, before, after, action
):
    remove = AsyncMock(return_value=[])
    monkeypatch.setattr(queue_source_cleanup, "remove_queue_only_source_if_unused", remove)
    item_id = await job(sessions, before, library_file_id=7)
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        with pytest.raises(QueueTransitionConflict):
            await transition_queue_item(
                db, item, before, after, action=action, conditions=(PrintQueueItem.printer_id == 2,)
            )
        await db.rollback()
        effects.queue_outcome_effect.assert_not_called()
        remove.assert_not_awaited()
        item = await db.get(PrintQueueItem, item_id)
        await transition_queue_item(db, item, before, after, action=action)
        await db.commit()
    if after in FINAL_STATUSES:
        remove.assert_awaited_once_with(db, 7)
    else:
        remove.assert_not_awaited()
    outcomes = [call.args[1] for call in effects.queue_outcome_effect.call_args_list]
    # Leaving failed or cancelled through Clear Plate removes the attempt's sent upload.
    assert [(outcome.new_state, outcome.clean_sd_copy) for outcome in outcomes] == (
        [] if after == "successful" else [(after, after == "unsuccessful")]
    )


@pytest.mark.parametrize(
    "before,after,action",
    [
        ("failed", "unsuccessful", "clear_plate"),
        ("cancelled", "unsuccessful", "clear_plate"),
        ("finished", "successful", "clear_plate"),
        ("failed", "unsuccessful", "printer_deleted"),
        ("cancelled", "unsuccessful", "hold_transferred"),
        ("cancelled", "finished", "printer_report"),
        ("queued", "unsuccessful", "cancel"),
    ],
)
async def test_only_clear_plate_on_an_ended_attempt_removes_its_sent_upload(
    sessions, monkeypatch, before, after, action
):
    monkeypatch.setattr(queue_source_cleanup, "remove_queue_only_source_if_unused", AsyncMock(return_value=[]))
    item_id = await job(sessions, before)
    async with sessions() as db:
        await transition_queue_item(db, await db.get(PrintQueueItem, item_id), before, after, action=action)
        await db.commit()
    removed = [call.args[1] for call in effects.queue_outcome_effect.call_args_list if call.args[1].clean_sd_copy]
    # Awaiting's exit removes it; entering final (from queued too) never does.
    assert [effect.new_state for effect in removed] == (
        [after] if action == "clear_plate" and before != "finished" else []
    )


async def test_automatic_clear_plate_belongs_to_the_finishing_transaction(sessions):
    item_id = await job(sessions, "printing")
    async with sessions() as db:
        db.add(Settings(key="require_plate_clear", value="false"))
        await db.commit()
        item = await db.get(PrintQueueItem, item_id)
        await transition_queue_item(db, item, "printing", "finished")
        assert item.status == "successful"
        await db.rollback()
    async with sessions() as db:
        row = await db.get(PrintQueueItem, item_id)
        assert (row.status, row.physical_outcome) == ("printing", None)


@pytest.mark.parametrize("status", ["dispatching", "printing", "paused", "finished", "failed", "cancelled"])
async def test_only_an_ended_job_passes_its_hold_to_a_new_external_print(sessions, status):
    ended = status in AWAITING_PLATE_CLEAR_STATUSES
    item_id = await job(sessions, "printing" if ended else status)
    async with sessions() as db:
        held = await db.get(PrintQueueItem, item_id)
        if ended:
            values = {"error_message": "Nozzle clog"} if status == "failed" else {}
            await transition_queue_item(db, held, "printing", status, values=values)
            await db.commit()
        outcome = held.physical_outcome
        assert await awaiting.transfer_hold(db, held, "new-run") is ended
        await db.commit()
    async with sessions() as db:
        row = await db.get(PrintQueueItem, item_id)
    if not ended:
        assert (row.status, row.error_message) == (status, None)
        return
    reason = "Printer hold transferred to externally started print new-run"
    assert row.status == ("successful" if status == "finished" else "unsuccessful")
    assert row.error_message == (f"Nozzle clog; {reason}" if status == "failed" else reason)
    assert outcome is not None and row.physical_outcome == outcome

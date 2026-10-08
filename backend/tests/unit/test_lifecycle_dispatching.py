"""Dispatch ownership and committed start delivery (#204 stage 5)."""

import asyncio
from datetime import timedelta
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy.exc import IntegrityError

from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.lifecycle import dispatching, effects, preheating
from backend.app.services.lifecycle.engine import transition_queue_item
from backend.app.services.print_scheduler import PrintScheduler
from backend.tests.unit.test_queue_archive_alignment import alignment  # noqa: F401
from backend.tests.unit.test_queue_dispatch_races import handoff  # noqa: F401


async def test_start_delivery_sees_committed_state_and_is_awaited(alignment):
    entered, release = asyncio.Event(), asyncio.Event()
    observed = []

    async def publish(job_id):
        async with alignment.sessions() as observer:
            observed.append((await observer.get(PrintQueueItem, job_id)).status)
        entered.set()
        await release.wait()
        observed.append("published")

    async with alignment.sessions() as db:
        item = await db.get(PrintQueueItem, alignment.job_id)
        await transition_queue_item(db, item, "queued", "dispatching")
        await db.commit()
        await transition_queue_item(db, item, "dispatching", "printing")
        started = effects.queue_job_started(db, item.id, publish=publish)
        assert started == [] and observed == []
        await db.commit()
        await asyncio.wait_for(entered.wait(), timeout=1)
        waiting = asyncio.create_task(effects.wait_for(started))
        await asyncio.sleep(0)
        assert not waiting.done() and observed == ["printing"]
        release.set()
        await waiting
        await db.commit()
    assert observed == ["printing", "published"]


@pytest.mark.parametrize("ending", ["rollback", "close", "failed_commit"])
async def test_uncommitted_dispatch_start_never_allocates_a_task(alignment, ending):
    publish, spawn = AsyncMock(), MagicMock()
    async with alignment.sessions() as db:
        started = effects.queue_job_started(db, alignment.job_id, publish=publish, spawn=spawn)
        if ending == "failed_commit":
            db.add(Printer(name="Duplicate", serial_number="TEST", ip_address="127.0.0.1", access_code="code"))
            with pytest.raises(IntegrityError):
                await db.commit()
            await db.rollback()
        elif ending == "close":
            await db.close()
        else:
            await db.rollback()
        await db.commit()
        await effects.wait_for(started)
    publish.assert_not_called()
    spawn.assert_not_called()


@pytest.mark.parametrize("action", ["confirmation", "resolution"])
async def test_failed_start_commit_keeps_dispatch_held_and_emits_no_start(alignment, monkeypatch, action):
    service = PrintScheduler()
    publish = AsyncMock()
    monkeypatch.setattr(effects, "publish_queue_job_started", publish)
    monkeypatch.setattr(service.dispatcher, "_wait_for_ack", AsyncMock(return_value=("printing", None)))
    async with alignment.sessions() as db:
        item = await db.get(PrintQueueItem, alignment.job_id)
        await transition_queue_item(db, item, "queued", "dispatching", values={"dispatch_subtask_id": "123"})
        await db.commit()

    async def failing_transaction(callback, **_):
        async with alignment.sessions() as db:
            monkeypatch.setattr(db, "commit", AsyncMock(side_effect=RuntimeError("commit unavailable")))
            return await callback(db)

    monkeypatch.setattr(dispatching, "run_with_retry", failing_transaction)
    with pytest.raises(RuntimeError, match="commit unavailable"):
        if action == "confirmation":
            await service.dispatcher._confirm(item_id=alignment.job_id, printer_id=1, subtask_id="123")
        else:
            async with alignment.sessions() as db:
                item = await db.get(PrintQueueItem, alignment.job_id)
                monkeypatch.setattr(db, "commit", AsyncMock(side_effect=RuntimeError("commit unavailable")))
                await service.dispatcher.resolve(db, item, "printing")
    async with alignment.sessions() as db:
        assert (await db.get(PrintQueueItem, alignment.job_id)).status == "dispatching"
    publish.assert_not_called()


@pytest.mark.parametrize("owner,expired", [("own", True), ("foreign", True), ("foreign", False)])
async def test_unsent_soak_liveness_belongs_to_dispatching(handoff, owner, expired):
    async with handoff.sessions() as db:
        item = await db.get(PrintQueueItem, handoff.job_id)
        await transition_queue_item(
            db,
            item,
            "preheating",
            "dispatching",
            values={
                "preheat_owner": handoff.service.owner if owner == "own" else "another-worker",
                "preheat_checked_at": preheating.utcnow() - timedelta(seconds=91 if expired else 1),
            },
        )
        await db.commit()
        assert await handoff.service.wait(db) == []
        await db.refresh(item)
        assert item.status == "dispatching" and item.error_message is None
        await handoff.scheduler.dispatcher.wait_unsent(db)
        await db.refresh(item)
        if expired and owner == "own":
            assert item.status == "failed" and "scheduler timeout" in item.error_message
        elif expired:
            assert item.status == "dispatching" and "inspect the printer" in item.error_message
            assert handoff.states[1].preheating
            item.dispatch_subtask_id = "123"
            await db.commit()
            await handoff.scheduler.dispatcher.wait_unsent(db)
            assert not handoff.states[1].preheating
        else:
            assert item.status == "dispatching" and item.error_message is None


async def test_dispatch_exit_rolls_back_its_shutdown_and_failure_effect(alignment, monkeypatch):
    run = AsyncMock()
    monkeypatch.setattr(effects, "run_queue_outcome_effects", run)
    async with alignment.sessions() as db:
        item = await db.get(PrintQueueItem, alignment.job_id)
        await transition_queue_item(db, item, "queued", "dispatching", values={"chamber_heat_soak": True})
        await db.commit()
        await transition_queue_item(db, item, "dispatching", "failed")
        assert (await db.get(Printer, 1)).heat_soak_shutdown_pending
        await db.rollback()
    async with alignment.sessions() as db:
        assert (await db.get(PrintQueueItem, alignment.job_id)).status == "dispatching"
        assert not (await db.get(Printer, 1)).heat_soak_shutdown_pending
    run.assert_not_awaited()


def test_dispatching_is_a_standalone_worker():
    from backend.app.services.lifecycle import queued
    from backend.app.services.lifecycle.dispatching import Dispatcher

    scheduler = PrintScheduler()
    assert Dispatcher not in type(scheduler).__mro__ and not hasattr(Dispatcher, "_start_print")
    assert isinstance(scheduler.dispatcher, Dispatcher) and isinstance(scheduler.workers, queued.Workers)
    # Its collaborators are explicit: the soak that hands over, printer availability and drying.
    dispatcher = scheduler.dispatcher
    assert (dispatcher._heat_soak, dispatcher._selection, dispatcher._drying) == (
        scheduler._heat_soak,
        scheduler.selection,
        scheduler.drying,
    )
    # Stage 6: none of them is the scheduler, and the scheduler mixes nothing in (#211).
    assert type(scheduler).__mro__ == (PrintScheduler, object)
    assert scheduler not in (dispatcher._selection, dispatcher._drying)


@pytest.mark.parametrize("heat_soak", [False, True])
async def test_queued_exit_starts_the_next_state(alignment, monkeypatch, heat_soak):
    from backend.app.services.lifecycle import queued
    from backend.app.services.printer_manager import printer_manager

    monkeypatch.setattr(printer_manager, "is_connected", lambda _id: True)
    preheat, dispatch = MagicMock(enter=AsyncMock(return_value=True)), MagicMock(enter=AsyncMock())
    workers = queued.Workers(preheat, dispatch)
    async with alignment.sessions() as db:
        item = await db.get(PrintQueueItem, alignment.job_id)
        item.chamber_heat_soak = heat_soak
        await db.commit()
        binding = queued._DispatchBinding.for_item(item, item.printer_id, "[2]", unassigned=False)
        await workers.leave(db, item, binding)
    if heat_soak:
        preheat.enter.assert_awaited_once()
        assert preheat.enter.await_args.kwargs == {"bind_values": binding.values(), "unassigned": False}
        dispatch.enter.assert_not_awaited()
    else:
        dispatch.enter.assert_awaited_once_with(db, item, "queued", binding)
        preheat.enter.assert_not_awaited()


@pytest.mark.parametrize("before", ["dispatching", "printing", "paused"])
@pytest.mark.parametrize("after,action", [("failed", None), ("cancelled", "cancel"), ("failed", "printer_report")])
async def test_an_outcome_runs_its_exit_and_entry_effects_together(alignment, monkeypatch, before, after, action):
    spawned = []
    monkeypatch.setattr(effects, "_spawn_outcome", lambda _engine, effect: spawned.append(effect))
    async with alignment.sessions() as db:
        item = await db.get(PrintQueueItem, alignment.job_id)
        await transition_queue_item(db, item, "queued", "dispatching", values={"chamber_heat_soak": True})
        if before != "dispatching":
            await transition_queue_item(db, item, "dispatching", "printing")
        if before == "paused":
            await transition_queue_item(db, item, "printing", "paused")
        await db.commit()
        await transition_queue_item(db, item, before, after, action=action)
        await db.commit()
        assert (await db.get(Printer, 1)).heat_soak_shutdown_pending
    # The exit shuts down the inherited soak, and a dispatch that Grove failed removes its upload;
    # awaiting's entry notifies any failure the printer didn't report, whatever the state before.
    unreported = after == "failed" and action is None
    assert [(e.shut_down_heaters, e.notify_failure, e.clean_sd_copy) for e in spawned] == [
        (True, unreported, unreported and before == "dispatching")
    ]


async def test_stop_during_the_hold_commits_nothing_but_the_claim_release(alignment, monkeypatch):
    from backend.app.services.lifecycle import queued
    from backend.app.services.printer_manager import printer_manager

    scheduler = PrintScheduler()
    monkeypatch.setattr(queued, "async_session", alignment.sessions)
    monkeypatch.setattr(printer_manager, "is_connected", lambda _id: True)
    monkeypatch.setattr(scheduler.selection, "_is_printer_idle", lambda *_args: True)
    original = dispatching.transition_queue_item

    async def cancelled_before_commit(db, item, before, after, **kwargs):
        change = await original(db, item, before, after, **kwargs)
        if (before, after) == ("queued", "dispatching"):
            raise asyncio.CancelledError  # Stop cancels the worker between the hold's write and its commit.
        return change

    monkeypatch.setattr(dispatching, "transition_queue_item", cancelled_before_commit)
    async with alignment.sessions() as db:
        item = await db.get(PrintQueueItem, alignment.job_id)
        binding = queued._DispatchBinding.for_item(item, item.printer_id, None, unassigned=False)
    with pytest.raises(asyncio.CancelledError):
        await scheduler.workers._work(alignment.job_id, binding)
    async with alignment.sessions() as db:
        item = await db.get(PrintQueueItem, alignment.job_id)
        assert (item.status, item.dispatching_at, item.archive_id) == ("queued", None, None)


async def test_recovery_completes_with_the_telemetry_that_matched(alignment, monkeypatch):
    from types import SimpleNamespace

    from backend.app.services.printer_manager import printer_manager

    state = SimpleNamespace(
        connected=True,
        job_telemetry_ready=True,
        state="FINISH",
        subtask_id="123",
        gcode_file="old.3mf",
        raw_data={"gcode_state": "FINISH", "ams": [{"id": 0}]},
    )
    monkeypatch.setattr(printer_manager, "get_status", lambda _id: state)
    original = dispatching.transition_queue_item

    async def next_print_arrives(*args, **kwargs):
        change = await original(*args, **kwargs)
        # MQTT moves the live state on to the next print while recovery awaits.
        state.subtask_id, state.gcode_file, state.state = "456", "next.3mf", "RUNNING"
        state.raw_data["gcode_state"] = "RUNNING"
        state.raw_data["ams"][0]["id"] = 1
        return change

    async with alignment.sessions() as db:
        item = await db.get(PrintQueueItem, alignment.job_id)
        values = {"dispatch_subtask_id": "123", "dispatched_at": preheating.utcnow() - timedelta(hours=1)}
        await transition_queue_item(db, item, "queued", "dispatching", values=values)
        await db.commit()
    scheduler = PrintScheduler()
    completed, spawned = AsyncMock(), []
    monkeypatch.setattr(scheduler.dispatcher, "_complete_recovered_dispatch", completed)
    monkeypatch.setattr(dispatching, "spawn_background_task", lambda coro, **_: spawned.append(coro))
    monkeypatch.setattr(dispatching, "transition_queue_item", next_print_arrives)
    async with alignment.sessions() as db:
        await scheduler.dispatcher.recover(db)
    await asyncio.gather(*spawned)
    (_item_id, _printer_id, data), _ = completed.await_args
    assert (data["status"], data["filename"], data["subtask_id"]) == ("completed", "old.3mf", "123")
    assert data["raw_data"] == {"gcode_state": "FINISH", "ams": [{"id": 0}], "subtask_id": "123"}
    async with alignment.sessions() as db:
        assert (await db.get(PrintQueueItem, alignment.job_id)).status == "finished"

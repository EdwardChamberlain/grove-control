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
    # Its collaborators are explicit: the soak that hands over, and printer availability and drying.
    assert (scheduler.dispatcher._heat_soak, scheduler.dispatcher._printers) == (scheduler._heat_soak, scheduler)


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

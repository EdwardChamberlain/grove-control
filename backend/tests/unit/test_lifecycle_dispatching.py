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
async def test_uncommitted_dispatch_start_never_allocates_a_task(alignment, monkeypatch, ending):
    from backend.app.core import tasks

    publish, spawn = AsyncMock(), MagicMock()
    monkeypatch.setattr(tasks, "spawn_background_task", spawn)
    async with alignment.sessions() as db:
        started = effects.queue_job_started(db, alignment.job_id, publish=publish)
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
    assert started == []
    publish.assert_not_called()
    spawn.assert_not_called()


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

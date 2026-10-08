"""Printing and intake (#204 stage 6): adapters, entry effects, completion credit and preheating's timer."""

import ast
import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select

from backend.app.models.archive import PrintArchive
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.user import User
from backend.app.services import print_effects
from backend.app.services.lifecycle import effects, intake, preheating
from backend.app.services.lifecycle.engine import transition_queue_item
from backend.tests.unit.test_lifecycle_preheating import enter_preheating
from backend.tests.unit.test_queue_archive_alignment import alignment  # noqa: F401

APP = Path(__file__).resolve().parents[2] / "app"


def test_mqtt_callbacks_are_thin_intake_adapters():
    tree = ast.parse((APP / "main.py").read_text())
    callbacks = {
        "on_print_start": "intake",
        "on_print_running_observed": "intake",
        "on_print_state_change": "intake",
        "on_print_complete": "intake",
        "on_finish_photo_moment": "print_effects",
    }
    found = {node.name: node for node in tree.body if isinstance(node, ast.AsyncFunctionDef)}
    for name, module in callbacks.items():
        (statement,) = found[name].body
        call = statement.value.value  # await/return of one call
        assert isinstance(call.func, ast.Attribute) and call.func.value.id == module, name


async def test_after_commit_work_runs_in_order_and_its_first_failure_reaches_the_waiter(alignment):
    ran = []

    async def first():
        ran.append("first")
        raise RuntimeError("first failed")

    async def second():
        ran.append("second")

    async with alignment.sessions() as db:
        effects.after_commit_task(db, first, key="first")
        effects.after_commit_task(db, second, key="second")
        assert ran == []
        await db.rollback()  # Discarded with the transaction.
        effects.after_commit_task(db, first, key="first")
        effects.after_commit_task(db, second, key="second")
        await db.commit()
        with pytest.raises(RuntimeError, match="first failed"):
            await effects.wait_for(effects.spawned(db))
    assert ran == ["first", "second"]  # A failure never skips the work after it.


@pytest.mark.parametrize("ends", [False, True])
async def test_printing_entry_from_dispatch_publishes_its_start_only_if_still_printing(alignment, monkeypatch, ends):
    publish = AsyncMock()
    monkeypatch.setattr(effects, "publish_queue_job_started", publish)
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        await transition_queue_item(db, job, "queued", "dispatching")
        await db.commit()
        await transition_queue_item(db, job, "dispatching", "printing")
        if ends:  # An exact terminal report for an unconfirmed dispatch ends it in the same transaction.
            await transition_queue_item(db, job, "printing", "finished", action="printer_report")
        publish.assert_not_called()
        await db.commit()
        await effects.wait_for(effects.spawned(db))
    assert publish.await_count == (0 if ends else 1)


@pytest.mark.parametrize("owner", ["this", "foreign", "rolled_back"])
async def test_dispatching_entry_from_preheating_starts_this_process_takeover(alignment, monkeypatch, owner):
    from backend.app.services.lifecycle import dispatching
    from backend.app.services.print_scheduler import scheduler

    take_over, spawned = AsyncMock(), []
    monkeypatch.setattr(scheduler.dispatcher, "take_over", take_over)
    monkeypatch.setattr(dispatching, "spawn_background_task", lambda coroutine, *, name: spawned.append(name))
    soak_owner = "another-process" if owner == "foreign" else scheduler._heat_soak.owner
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        await enter_preheating(db, job, {"chamber_heat_soak": True, "preheat_owner": soak_owner})
        await transition_queue_item(db, job, "preheating", "dispatching")
        take_over.assert_not_called()  # Never before the handoff is durable.
        await (db.rollback() if owner == "rolled_back" else db.commit())
    expected = owner == "this"
    assert spawned == ([f"heat-soak-dispatch-{alignment.job_id}"] if expected else [])
    assert take_over.call_args_list == ([((alignment.job_id,),)] if expected else [])


async def test_completion_credits_the_job_owner_from_the_job(alignment, monkeypatch):
    """No in-memory credit: the matched job's owner is read at completion, so it survives a restart."""
    monkeypatch.setattr(intake, "async_session", alignment.sessions)
    monkeypatch.setattr(print_effects, "async_session", alignment.sessions)
    monkeypatch.setattr(intake, "_completed_job_events", {})
    for effect in ("_clean_sd_card", "_queue_completed", "_await_bed_cooldown", "_publish_archive_outcome"):
        monkeypatch.setattr(print_effects, effect, AsyncMock())
    monkeypatch.setattr(print_effects, "_track_usage", AsyncMock(return_value=[]))
    monkeypatch.setattr(print_effects, "spawn_background_task", lambda coroutine, **_: coroutine.close())
    monkeypatch.setattr(print_effects.ws_manager, "send_print_complete", AsyncMock())
    async with alignment.sessions() as db:
        owner = User(username="owner", password_hash="x", is_active=True)
        db.add(owner)
        await db.flush()
        job = await db.get(PrintQueueItem, alignment.job_id)
        archive = PrintArchive(
            printer_id=job.printer_id, filename="a.3mf", file_path="", file_size=0, status="printing"
        )
        db.add(archive)
        await db.flush()
        archive.dispatched_queue_item_id = job.id
        job.created_by_id, owner_id = owner.id, owner.id
        await transition_queue_item(db, job, "queued", "dispatching", values={"dispatch_subtask_id": "123"})
        await transition_queue_item(db, job, "dispatching", "printing", values={"archive_id": archive.id})
        await db.commit()
    assert await intake.print_completed(1, {"submission_id": "123", "status": "completed"}) is None
    async with alignment.sessions() as db:
        log = await db.scalar(select(PrintLogEntry))
        assert (log.created_by_username, log.queue_item_id) == ("owner", alignment.job_id)
        assert (await db.get(PrintArchive, archive.id)).created_by_id == owner_id  # Back-filled (#730).


def _telemetry(state="IDLE", connected=True):
    return SimpleNamespace(connected=connected, state=state, job_telemetry_ready=True)


async def test_preheating_wakes_on_first_telemetry_then_only_on_watched_changes(monkeypatch):
    monkeypatch.setattr(preheating, "_wake", asyncio.Event())
    monkeypatch.setattr(preheating, "_watched", None)

    def woken(printer_id, state):
        preheating._wake.clear()
        preheating.observe(printer_id, state)
        return preheating._wake.is_set()

    assert woken(3, _telemetry())  # Before the first pass, any printer's report starts it.
    monkeypatch.setattr(preheating, "_watched", {1: None})
    assert woken(1, _telemetry())
    assert not woken(1, _telemetry())  # The same report again.
    assert woken(1, _telemetry("RUNNING"))
    assert woken(1, _telemetry("RUNNING", connected=False))
    assert not woken(2, _telemetry("RUNNING"))  # Not soaking or shutting down.


@pytest.mark.parametrize("commit", [True, False])
async def test_heater_shutdown_request_wakes_preheating_after_commit(alignment, monkeypatch, commit):
    monkeypatch.setattr(preheating, "_wake", asyncio.Event())
    async with alignment.sessions() as db:
        await preheating.request_heater_shutdown(db, 1)
        assert not preheating._wake.is_set()
        await (db.commit() if commit else db.rollback())
    assert preheating._wake.is_set() is commit


async def test_preheating_runs_its_wait_on_its_own_timer(alignment, monkeypatch):
    monkeypatch.setattr(preheating, "async_session", alignment.sessions)
    monkeypatch.setattr(preheating, "CHECK_INTERVAL", 0.01)
    soak = preheating.ChamberHeatSoak()
    soak.wait = AsyncMock(return_value=[])
    timer = asyncio.create_task(soak.run())
    try:
        await asyncio.sleep(0.05)  # The first pass, then idle: nothing soaks or shuts down.
        assert soak.wait.await_count == 1
        await asyncio.sleep(0.05)
        assert soak.wait.await_count == 1
        preheating.wake()  # A new soak, a shutdown request or watched telemetry.
        await asyncio.sleep(0.01)
        assert soak.wait.await_count == 2
    finally:
        timer.cancel()
        await asyncio.gather(timer, return_exceptions=True)
        preheating._wake = None
        preheating._watched = None

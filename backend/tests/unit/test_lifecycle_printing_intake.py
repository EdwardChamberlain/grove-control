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
        "on_finish_photo_moment": "intake",
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


async def test_dispatch_recovery_timer_confirms_a_job_without_a_scheduler_pass(alignment, monkeypatch):
    from datetime import datetime, timedelta, timezone

    from backend.app.services.lifecycle import dispatching
    from backend.app.services.print_scheduler import PrintScheduler

    service = PrintScheduler().dispatcher
    monkeypatch.setattr(dispatching, "async_session", alignment.sessions)
    live = SimpleNamespace(connected=True, job_telemetry_ready=True, state="RUNNING", submission_id="123")
    monkeypatch.setattr(dispatching.printer_manager, "get_status", lambda _: live)
    published = asyncio.Event()
    monkeypatch.setattr(effects, "publish_queue_job_started", AsyncMock(side_effect=lambda _: published.set()))
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        await transition_queue_item(
            db,
            job,
            "queued",
            "dispatching",
            values={"dispatch_subtask_id": "123", "dispatched_at": datetime.now(timezone.utc) - timedelta(minutes=5)},
        )
        await db.commit()
    await service.start()
    timer = asyncio.create_task(service.run())
    try:
        await asyncio.wait_for(published.wait(), 2)
        async with alignment.sessions() as db:
            assert (await db.get(PrintQueueItem, alignment.job_id)).status == "printing"
    finally:
        timer.cancel()
        await asyncio.gather(timer, return_exceptions=True)
        monkeypatch.setattr(dispatching, "_wake", None)


async def test_dispatch_timer_watches_an_expired_unsent_handoff(alignment, monkeypatch):
    from datetime import timedelta

    from backend.app.services.lifecycle import dispatching
    from backend.app.services.print_scheduler import PrintScheduler

    service = PrintScheduler().dispatcher
    monkeypatch.setattr(dispatching, "async_session", alignment.sessions)
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        await enter_preheating(
            db,
            job,
            {"chamber_heat_soak": True, "preheat_owner": "previous-process", "preheat_checked_at": preheating.utcnow()},
        )
        await transition_queue_item(db, job, "preheating", "dispatching")
        job.preheat_checked_at = preheating.utcnow() - timedelta(seconds=100)
        await db.commit()
    recovered = asyncio.Event()
    monkeypatch.setattr(service, "recover", AsyncMock(side_effect=lambda _: recovered.set()))
    timer = asyncio.create_task(service.run())
    try:
        await asyncio.wait_for(recovered.wait(), 2)
        async with alignment.sessions() as db:
            job = await db.get(PrintQueueItem, alignment.job_id)
            assert job.status == "dispatching"
            assert job.error_message == "Heat soak interrupted; inspect the printer, then stop or skip heat soak"
    finally:
        timer.cancel()
        await asyncio.gather(timer, return_exceptions=True)
        monkeypatch.setattr(dispatching, "_wake", None)


async def test_dispatch_timer_retries_failures_and_wakes_before_its_timeout(alignment, monkeypatch):
    from backend.app.services.lifecycle import dispatching
    from backend.app.services.print_scheduler import PrintScheduler

    service = PrintScheduler().dispatcher
    monkeypatch.setattr(dispatching, "async_session", alignment.sessions)
    monkeypatch.setattr(dispatching, "RECOVERY_INTERVAL", 0.01)
    service.wait_unsent = AsyncMock(side_effect=[RuntimeError("database busy"), None, None])
    recovered = asyncio.Event()
    service.recover = AsyncMock(side_effect=lambda _: recovered.set())
    timer = asyncio.create_task(service.run())
    try:
        await asyncio.wait_for(recovered.wait(), 2)  # A failed pass must not kill recovery.
        assert service.wait_unsent.await_count == 2
        monkeypatch.setattr(dispatching, "RECOVERY_INTERVAL", 60)
        recovered.clear()
        dispatching.wake()
        await asyncio.wait_for(recovered.wait(), 2)
        assert service.wait_unsent.await_count == 3
    finally:
        timer.cancel()
        await asyncio.gather(timer, return_exceptions=True)
        monkeypatch.setattr(dispatching, "_wake", None)


async def test_bed_cooldown_adapter_consumes_only_its_printers_intake_memory(alignment, monkeypatch):
    monkeypatch.setattr(intake, "print_memory", intake.PrintMemory())
    monkeypatch.setattr(print_effects, "async_session", alignment.sessions)
    notify = AsyncMock()
    monkeypatch.setattr(print_effects.notification_service, "on_bed_cooled", notify)
    monkeypatch.setattr(print_effects.printer_manager, "get_printer", lambda _: None)
    intake.print_memory.bed_cool_waiters.update(
        {1: {"threshold": 35, "filename": "first"}, 2: {"threshold": 30, "filename": "second"}}
    )
    await intake.bed_cooled(1, 40)
    notify.assert_not_awaited()
    await intake.bed_cooled(1, 35)
    await intake.bed_cooled(1, 20)
    assert notify.await_count == 1
    assert notify.await_args.kwargs["filename"] == "first"
    assert intake.print_memory.bed_cool_waiters == {2: {"threshold": 30, "filename": "second"}}
    assert intake.PrintMemory().bed_cool_waiters == {}  # Independent contexts never share dictionaries.


async def test_dispatch_recovery_retries_a_locked_database_within_the_pass(alignment, monkeypatch):
    from sqlalchemy.exc import OperationalError

    from backend.app.services.lifecycle import dispatching
    from backend.app.services.print_scheduler import PrintScheduler

    service = PrintScheduler().dispatcher
    monkeypatch.setattr(dispatching, "async_session", alignment.sessions)
    monkeypatch.setattr("backend.app.core.database.is_sqlite", lambda: True)
    monkeypatch.setattr("backend.app.core.database.asyncio.sleep", AsyncMock())
    locked = OperationalError("UPDATE print_queue", {}, Exception("database is locked"))
    service.wait_unsent = AsyncMock(side_effect=[locked, None])
    recovered = asyncio.Event()
    service.recover = AsyncMock(side_effect=lambda _: recovered.set())
    timer = asyncio.create_task(service.run())
    try:
        await asyncio.wait_for(recovered.wait(), 2)  # The same pass, not the next timer.
        assert service.wait_unsent.await_count == 2
    finally:
        timer.cancel()
        await asyncio.gather(timer, return_exceptions=True)
        monkeypatch.setattr(dispatching, "_wake", None)


async def test_intake_wakes_dispatch_recovery_on_each_known_connection_edge(monkeypatch):
    from backend.app.services.lifecycle import dispatching

    monkeypatch.setattr(dispatching, "_wake", asyncio.Event())
    monkeypatch.setattr(intake, "_printer_reconciled_since_connect", {})
    monkeypatch.setattr(intake, "_pending_stale_reconciliation", set())
    monkeypatch.setattr(preheating, "observe", lambda *_: None)
    await intake.printer_status(1, _telemetry("UNKNOWN"))
    assert not dispatching._wake.is_set()  # Construction defaults cannot settle a job.
    await intake.printer_status(1, _telemetry("RUNNING"))
    assert dispatching._wake.is_set()
    dispatching._wake.clear()
    await intake.printer_status(1, _telemetry("RUNNING"))
    assert not dispatching._wake.is_set()
    await intake.printer_status(1, _telemetry("RUNNING", connected=False))
    assert dispatching._wake.is_set()
    dispatching._wake.clear()
    await intake.printer_status(1, _telemetry("RUNNING"))
    assert dispatching._wake.is_set()

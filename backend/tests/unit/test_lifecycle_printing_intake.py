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
from backend.app.services.lifecycle.engine import hold_printer, transition_queue_item
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
        await hold_printer(db, 1)
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

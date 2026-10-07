"""Source eligibility, copy failures, and heat-soak dispatch contracts."""

import asyncio
import errno
from datetime import timedelta
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from backend.app.api.routes.print_queue import skip_queue_item_heat_soak
from backend.app.core.config import settings
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import HOLDING_STATUSES, PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.archive import ArchiveService
from backend.app.services.lifecycle import dispatching as scheduling, preheating as heat
from backend.app.services.lifecycle.engine import InvalidQueueTransition, transition_queue_item
from backend.app.services.print_scheduler import PrintScheduler, scheduler
from backend.app.services.queue_archive import link_dispatch_archive, prepare_dispatch_archive
from backend.tests.unit.test_lifecycle_preheating import enter_preheating
from backend.tests.unit.test_queue_archive_alignment import alignment  # noqa: F401
from backend.tests.unit.test_queue_dispatch_races import handoff  # noqa: F401


@pytest.mark.parametrize("heat_soak", [False, True])
@pytest.mark.parametrize("cached_source", [False, True])
async def test_trashed_reprint_stays_parked_without_a_printer_hold(handoff, monkeypatch, heat_soak, cached_source):
    scheduler = handoff.scheduler
    assigned, failed = AsyncMock(), AsyncMock()
    monkeypatch.setattr(scheduler, "_notify_pool_assignment", assigned)
    monkeypatch.setattr(scheduling.notification_service, "on_queue_job_failed", failed)
    async with handoff.sessions() as db:
        source = await ArchiveService(db).archive_print(None, handoff.source_path)
        if not cached_source:
            source.deleted_at = heat.utcnow()
        await db.execute(
            PrintQueueItem.__table__.update()
            .where(PrintQueueItem.id == handoff.job_id)
            .values(
                status="queued",
                printer_id=None,
                archive_id=source.id,
                library_file_id=None,
                chamber_heat_soak=heat_soak,
                preheat_owner=None,
            )
        )
        await db.commit()
        if cached_source:
            async with handoff.sessions() as trash:
                (await trash.get(PrintArchive, source.id)).deleted_at = heat.utcnow()
                await trash.commit()
            assert source.deleted_at is None  # Retained identity-map snapshot.
        job = await db.get(PrintQueueItem, handoff.job_id, populate_existing=True)
        binding = scheduling._DispatchBinding.for_item(job, 1, None, unassigned=True)
        await scheduler._start_print(db, job, binding=binding)
        await db.refresh(job)
        assert job.status == "queued" and job.printer_id is None and job.manual_start
        assert "deleted" in job.waiting_reason.lower()
        assert job.physical_outcome is None and job.archive_id == source.id
        assert await db.scalar(select(PrintQueueItem.id).where(PrintQueueItem.status.in_(HOLDING_STATUSES))) is None
        assert list(await db.scalars(select(PrintArchive.id))) == [source.id]
        assigned.assert_not_awaited()
        failed.assert_not_awaited()


@pytest.mark.parametrize("source_kind", ["archive", "library"])
@pytest.mark.parametrize("remove", ["trash", "delete"])
async def test_source_removed_after_eligibility_read_fails_the_committed_hold(
    handoff, monkeypatch, source_kind, remove
):
    from backend.app.services import queue_archive

    model = PrintArchive if source_kind == "archive" else LibraryFile
    assigned = AsyncMock()
    monkeypatch.setattr(handoff.scheduler, "_notify_pool_assignment", assigned)
    async with handoff.sessions() as db:
        source_id = handoff.source_id
        if source_kind == "archive":
            source_id = (await ArchiveService(db).archive_print(None, handoff.source_path)).id
        await db.execute(
            PrintQueueItem.__table__.update()
            .where(PrintQueueItem.id == handoff.job_id)
            .values(
                status="queued",
                printer_id=None,
                chamber_heat_soak=False,
                preheat_owner=None,
                archive_id=source_id if source_kind == "archive" else None,
                library_file_id=source_id if source_kind == "library" else None,
            )
        )
        await db.commit()
        original = queue_archive.prepare_dispatch_archive

        async def remove_before_preparation(db, item):
            async with handoff.sessions() as user:
                source = await user.get(model, source_id)
                if remove == "trash":
                    source.deleted_at = heat.utcnow()
                else:
                    await user.delete(source)
                await user.commit()
            return await original(db, item)

        monkeypatch.setattr(queue_archive, "prepare_dispatch_archive", remove_before_preparation)
        job = await db.get(PrintQueueItem, handoff.job_id, populate_existing=True)
        binding = scheduling._DispatchBinding.for_item(job, 1, None, unassigned=True)
        await handoff.scheduler._start_print(db, job, binding=binding)
        await db.refresh(job)
        assert job.status == "failed" and job.printer_id == 1
        cause = "Dispatch source was deleted" if remove == "trash" else "Dispatch source no longer exists"
        assert job.error_message == f"Failed to create Archive record for dispatch: {cause}"
        assert job.physical_outcome == "failed"
        assert await db.scalar(select(PrintQueueItem.id).where(PrintQueueItem.status.in_(HOLDING_STATUSES))) == job.id
        assert await db.scalar(select(PrintArchive.id).where(PrintArchive.dispatched_queue_item_id == job.id)) is None
        assigned.assert_not_awaited()


@pytest.mark.parametrize("path", ["ordinary", "tick", "skip"])
@pytest.mark.parametrize(
    "error,message",
    [
        (
            OSError(errno.ENOSPC, "No space left on device", "/abs/path/x.3mf"),
            "Failed to create Archive record for dispatch: Not enough disk space to copy the print file",
        ),
        (
            OSError(errno.EACCES, "Permission denied", "/abs/path/x.3mf"),
            "Failed to create Archive record for dispatch: Could not copy the print file",
        ),
        (RuntimeError("Cannot parse /abs/path/x.3mf"), "Failed to create Archive record for dispatch"),
    ],
)
async def test_copy_failure_reports_safe_cause_after_a_committed_hold(
    handoff, monkeypatch, caplog, path, error, message
):
    copy = AsyncMock(side_effect=error)
    monkeypatch.setattr(ArchiveService, "archive_print", copy)
    monkeypatch.setattr(scheduling, "async_session", handoff.sessions)
    monkeypatch.setattr("backend.app.services.print_scheduler.scheduler", handoff.scheduler)
    notified = asyncio.Event()
    notification = AsyncMock()

    async def record_failure(**kwargs):
        await notification(**kwargs)
        notified.set()

    monkeypatch.setattr(scheduling.notification_service, "on_queue_job_failed", record_failure)
    handoffs = []

    def capture(coroutine, *, name):
        if name.startswith("skip-heat-soak-dispatch"):
            handoffs.append(coroutine)
        else:
            coroutine.close()

    monkeypatch.setattr(heat, "spawn_background_task", capture)
    async with handoff.sessions() as db:
        if path == "ordinary":
            await db.execute(
                PrintQueueItem.__table__.update()
                .where(PrintQueueItem.id == handoff.job_id)
                .values(status="queued", chamber_heat_soak=False, preheat_owner=None)
            )
            await db.commit()
            job = await db.get(PrintQueueItem, handoff.job_id, populate_existing=True)
            await handoff.scheduler._start_print(db, job)
        elif path == "tick":
            assert await handoff.service.wait(db) == [handoff.job_id]
            await handoff.scheduler._dispatch_after_heat_soak(handoff.job_id)
        else:
            assert await skip_queue_item_heat_soak(handoff.job_id, db=db, auth_result=(None, True)) == {
                "message": "Heat soak skipped"
            }
            assert len(handoffs) == 1
            await handoffs.pop()
        job = await db.get(PrintQueueItem, handoff.job_id, populate_existing=True)
        assert job.status == "failed" and job.error_message == message
        assert job.physical_failure_reason == message[:100]
        assert "/abs/path" not in job.error_message
        assert await db.scalar(select(PrintArchive.id)) is None
    await asyncio.wait_for(notified.wait(), 2)
    notification.assert_awaited_once()
    assert notification.call_args.kwargs["reason"] == message
    copy.assert_awaited_once()
    assert "/abs/path" in caplog.text
    assert handoff.source_path.exists()


@pytest.mark.parametrize("phase", ["before_request", "before_readiness_check"])
@pytest.mark.parametrize("progressed", ["dispatching", "printing", "paused"])
async def test_skip_is_successful_when_the_same_soak_already_progressed(handoff, monkeypatch, phase, progressed):
    async def advance():
        async with handoff.sessions() as worker:
            assert await handoff.service.wait(worker) == [handoff.job_id]
            job = await worker.get(PrintQueueItem, handoff.job_id)
            if progressed != "dispatching":
                prepared = await prepare_dispatch_archive(worker, job)
                await link_dispatch_archive(worker, job, prepared)
                await transition_queue_item(worker, job, "dispatching", "printing")
                if progressed == "paused":
                    await transition_queue_item(worker, job, "printing", "paused")
                await worker.commit()

    if phase == "before_request":
        await advance()
    elif phase == "before_readiness_check":
        from sqlalchemy.ext.asyncio import AsyncSession

        original_commit = AsyncSession.commit
        advanced = False

        async def commit_then_advance(db):
            nonlocal advanced
            await original_commit(db)
            if not advanced:
                advanced = True
                await advance()
                handoff.states[1].state = "PAUSE" if progressed == "paused" else "RUNNING"

        monkeypatch.setattr(AsyncSession, "commit", commit_then_advance)
    spawned = []

    def collect(coroutine, **kwargs):
        spawned.append(kwargs)
        coroutine.close()

    monkeypatch.setattr(heat, "spawn_background_task", collect)
    async with handoff.sessions() as db:
        response = await skip_queue_item_heat_soak(handoff.job_id, db=db, auth_result=(None, True))
        assert response == {"message": "Heat soak skipped"}
    async with handoff.sessions() as observer:
        job = await observer.get(PrintQueueItem, handoff.job_id)
        assert job.status == progressed
        attempts = list(await observer.scalars(select(PrintArchive)))
        if progressed == "dispatching":
            assert attempts == [] and job.archive_id is None
        else:
            assert len(attempts) == 1 and attempts[0].dispatched_queue_item_id == job.id
            assert (settings.base_dir / attempts[0].file_path).exists()
    assert not any(call["name"].startswith("skip-heat-soak-dispatch-") for call in spawned)


@pytest.mark.parametrize("before", ["queued", "preheating"])
async def test_dispatch_entry_holds_the_printer_before_creating_an_attempt(alignment, before):
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        if before == "preheating":
            await enter_preheating(db, job)
        await transition_queue_item(db, job, before, "dispatching")
        await db.commit()
        await db.refresh(job)
        assert job.status == "dispatching" and job.archive_id is None
        assert await db.scalar(select(PrintArchive.id)) is None


async def test_dispatch_entry_rejects_another_jobs_prepared_archive(alignment):
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        db.add(Printer(id=2, name="Other", serial_number="OTHER", ip_address="127.0.0.2", access_code="code"))
        other = PrintQueueItem(printer_id=2, library_file_id=alignment.source_id, status="queued")
        db.add(other)
        await db.commit()
        await transition_queue_item(db, job, "queued", "dispatching")
        await transition_queue_item(db, other, "queued", "dispatching")
        await db.commit()
        attempt = await prepare_dispatch_archive(db, other)
        with pytest.raises(InvalidQueueTransition, match="does not belong"):
            await link_dispatch_archive(db, job, attempt)
        await db.rollback()
    assert not list(settings.archive_dir.rglob("*.3mf"))


async def test_dispatch_entry_rejects_explicitly_clearing_the_selected_printer(alignment):
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        with pytest.raises(InvalidQueueTransition, match="selected printer"):
            await transition_queue_item(db, job, "queued", "dispatching", values={"printer_id": None})
        await db.rollback()
    async with alignment.sessions() as observer:
        job = await observer.get(PrintQueueItem, alignment.job_id)
        assert job.status == "queued" and job.printer_id == 1 and job.archive_id is None
        assert await observer.scalar(select(PrintArchive.id)) is None
    assert not list(settings.archive_dir.rglob("*.3mf"))


@pytest.mark.parametrize("phase", ["before_handoff", "at_cas"])
@pytest.mark.parametrize("readiness", ["busy", "unready", "disconnected", "missing"])
async def test_skip_preserves_soak_when_telemetry_cannot_dispatch(handoff, monkeypatch, phase, readiness):
    now = heat.utcnow()
    monkeypatch.setattr(heat, "utcnow", lambda: now)
    copied, spawned = AsyncMock(), []
    original_ready = heat._dispatch_ready

    def make_unavailable():
        nonlocal now
        now += timedelta(seconds=10)
        state = handoff.states[1]
        if readiness == "busy":
            state.state = "RUNNING"
            state.submission_id = "another-print"
        elif readiness == "unready":
            state.job_telemetry_ready = False
        elif readiness == "disconnected":
            state.connected = False
        else:
            handoff.states.pop(1)

    if phase == "before_handoff":
        make_unavailable()

    checks = 0

    def ready(printer_id):
        nonlocal checks
        checks += 1
        if phase == "at_cas" and checks == 3:
            make_unavailable()
        return original_ready(printer_id)

    def collect(coroutine, **kwargs):
        spawned.append(kwargs["name"])
        coroutine.close()

    monkeypatch.setattr(ArchiveService, "archive_print", copied)
    monkeypatch.setattr(heat, "_dispatch_ready", ready)
    monkeypatch.setattr(heat, "spawn_background_task", collect)
    async with handoff.sessions() as db:
        with pytest.raises(HTTPException) as failure:
            await skip_queue_item_heat_soak(handoff.job_id, db=db, auth_result=(None, True))
        expected = "Printer is not ready to start; wait for it to report idle, then retry"
        assert failure.value.status_code == 409 and failure.value.detail == expected
    async with handoff.sessions() as db:
        job = await db.get(PrintQueueItem, handoff.job_id)
        assert job.status == "preheating" and job.chamber_heat_soak
        assert job.preheat_owner == handoff.service.owner and job.preheat_checked_at == now
        assert job.archive_id is None and job.physical_outcome is None
        assert await db.scalar(select(PrintArchive.id)) is None
    copied.assert_not_awaited()
    assert not any(name.startswith("skip-heat-soak-dispatch-") for name in spawned)
    assert not list(settings.archive_dir.rglob("*.3mf"))
    assert not list((settings.archive_dir / "1").glob("*"))
    assert handoff.source_path.exists()

"""Dispatch races across held jobs, heat soak, and printer upload."""

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import event, select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.config import settings
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.archive import ArchiveService
from backend.app.services.lifecycle import (
    dispatching as scheduling,
    effects as lifecycle_effects,
    preheating as heat,
    queued as lifecycle_queued,
)
from backend.app.services.lifecycle.dispatching import Dispatcher
from backend.app.services.lifecycle.engine import QueueTransitionConflict, transition_queue_item, writer
from backend.app.services.print_scheduler import PrintScheduler, scheduler
from backend.app.services.printer_manager import printer_manager
from backend.app.services.queue_actions import cancel_job
from backend.app.services.queue_archive import link_dispatch_archive, prepare_dispatch_archive
from backend.tests.unit.test_lifecycle_preheating import enter_preheating
from backend.tests.unit.test_queue_archive_alignment import alignment, hold_and_link  # noqa: F401
from backend.tests.unit.test_scheduler_cleanup_library import (
    _dispatch_library_item,
    _wait_for_dispatch,
    queue_factory,
)  # noqa: F401


@pytest.mark.parametrize("phase", ["copy", "upload"])
@pytest.mark.parametrize("telemetry", ["idle", "unavailable", "active"])
async def test_dispatch_resumes_only_after_fresh_idle_telemetry(queue_factory, monkeypatch, phase, telemetry):
    from backend.app.services.bambu_mqtt import PrinterState

    ctx = await queue_factory(cleanup=False)
    live = PrinterState(connected=True, job_telemetry_ready=True, state="IDLE", submission_id="old-print")

    async def lose_telemetry():
        live.submission_id = None
        live.subtask_id = None
        live.job_telemetry_ready = False

    if phase == "upload":

        async def upload(*args, **kwargs):
            await lose_telemetry()
            return True

        ctx.upload.side_effect = upload
    # A committed copy remains held until fresh telemetry is available again.
    from backend.app.services.lifecycle.effects import run_queue_outcome_effects as effects

    await _dispatch_library_item(ctx, printer_status=live, during_archive=lose_telemetry if phase == "copy" else None)

    async with ctx.session_maker() as db:
        job = await db.get(PrintQueueItem, ctx.queue_item_id)
        archive = await db.get(PrintArchive, job.archive_id)
        assert archive is not None and archive.dispatched_queue_item_id == job.id
        if telemetry == "unavailable":
            assert job.status == "dispatching" and job.deadline_kind == "dispatch_ready"
            assert job.dispatched_at is None and job.dispatch_subtask_id is None
            ctx.start_print.assert_not_called()
            effects.assert_not_awaited()
        else:
            live.job_telemetry_ready = True
            live.state = "IDLE" if telemetry == "idle" else "RUNNING"
            live.submission_id = None if telemetry == "idle" else "another-print"
            with monkeypatch.context() as patch:
                patch.setattr(scheduling, "async_session", ctx.session_maker)
                patch.setattr(lifecycle_queued, "async_session", ctx.session_maker)
                patch.setattr(printer_manager, "get_status", lambda _id: live)
                patch.setattr(printer_manager, "is_connected", lambda _id: True)
                patch.setattr(printer_manager, "is_awaiting_plate_clear", lambda _id: False)
                patch.setattr(printer_manager, "start_print", ctx.start_print)
                patch.setattr(scheduling, "upload_file_async", ctx.upload)
                patch.setattr(scheduling, "delete_file_async", AsyncMock(return_value=True))
                patch.setattr(scheduling, "get_ftp_retry_settings", AsyncMock(return_value=(False, 0, 0, 1.0)))
                patch.setattr(scheduling, "cache_3mf_download", MagicMock())
                if telemetry == "idle":
                    ctx.upload.side_effect = None
                await PrintScheduler().dispatcher.ready_due(db, job.id)
                if telemetry == "idle":
                    await _wait_for_dispatch(ctx)
        await db.refresh(job)
        await db.refresh(archive)
        if telemetry == "active":
            assert job.status == "failed" and archive.status == "failed"
            assert job.physical_outcome is None and job.dispatched_at is None and job.dispatch_subtask_id is None
            assert effects.await_args.args[1].new_state == "failed"
            ctx.start_print.assert_not_called()
        elif telemetry == "idle":
            assert job.status == "dispatching" and archive.status == "dispatching"
            assert job.dispatched_at is not None and job.dispatch_subtask_id is not None
            ctx.start_print.assert_called_once()
        else:
            assert job.status == "dispatching" and archive.status == "dispatching"
            assert job.dispatched_at is None and job.dispatch_subtask_id is None
            assert job.physical_outcome is None
            ctx.start_print.assert_not_called()
            effects.assert_not_awaited()


@pytest.fixture
async def handoff(alignment, monkeypatch):
    scheduler = PrintScheduler()
    states = {
        1: SimpleNamespace(
            state="IDLE", connected=True, job_telemetry_ready=True, heat_soak_disconnected_at=0, raw_data={}
        )
    }
    monkeypatch.setattr(printer_manager, "get_status", states.get)
    monkeypatch.setattr(printer_manager, "is_connected", lambda _id: True)
    monkeypatch.setattr(printer_manager, "is_awaiting_plate_clear", lambda _id: False)
    monkeypatch.setattr(printer_manager, "get_client", lambda _id: None)
    monkeypatch.setattr(printer_manager, "_broadcast_status_change", AsyncMock())
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        now = heat.utcnow()
        await enter_preheating(
            db,
            job,
            {
                "chamber_heat_soak": True,
                "heat_soak_minutes": 1,
                "preheat_requested_at": now - timedelta(minutes=2),
                "preheat_started_at": now - timedelta(minutes=2),
            },
        )
        await db.commit()
    return SimpleNamespace(**vars(alignment), scheduler=scheduler, states=states)


@pytest.mark.parametrize("status", ["dispatching", "cancelled", "unsuccessful", "printing", "paused"])
async def test_cancellation_cleanup_keeps_a_copy_after_the_persisted_send_boundary(alignment, monkeypatch, status):
    deleted = AsyncMock()
    monkeypatch.setattr(scheduling, "delete_file_async", deleted)
    monkeypatch.setattr(scheduling, "async_session", alignment.sessions)
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        await hold_and_link(db, job)
        await db.execute(
            PrintQueueItem.__table__.update()
            .where(PrintQueueItem.id == job.id)
            .values(status=status, dispatched_at=datetime.now(timezone.utc))
        )
        await db.commit()
        await PrintScheduler().dispatcher._cleanup_unsent_upload(job.id)
    deleted.assert_not_awaited()


async def test_pool_copy_failure_notifies_failure_without_assignment(alignment, monkeypatch):
    from backend.app.services.print_scheduler import scheduler as process_scheduler

    monkeypatch.setattr(
        printer_manager,
        "get_status",
        lambda _id: SimpleNamespace(state="IDLE", connected=True, job_telemetry_ready=True),
    )
    monkeypatch.setattr(printer_manager, "is_connected", lambda _id: True)
    monkeypatch.setattr(printer_manager, "is_awaiting_plate_clear", lambda _id: False)
    monkeypatch.setattr(ArchiveService, "archive_print", AsyncMock(side_effect=OSError("Disk full")))
    scheduler = PrintScheduler()
    monkeypatch.setattr(scheduling, "async_session", alignment.sessions)
    monkeypatch.setattr(process_scheduler.dispatcher, "schedule_stage", alignment.schedule_stage)
    assigned, failed, upload = AsyncMock(), AsyncMock(), AsyncMock()
    monkeypatch.setattr(lifecycle_queued, "notify_assignment", assigned)
    notified = asyncio.Event()

    async def record_failure(**kwargs):
        await failed(**kwargs)
        notified.set()

    monkeypatch.setattr(lifecycle_effects.notification_service, "on_queue_job_failed", record_failure)
    monkeypatch.setattr(scheduling, "upload_file_async", upload)
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        job.printer_id = None
        job.assigned_printer_id = None
        await db.commit()
        binding = lifecycle_queued._DispatchBinding.for_item(job, 1, None, unassigned=True)
        await scheduler.workers.leave(db, job, binding=binding)
        await _wait_for_dispatch(SimpleNamespace(queue_item_id=job.id))
        await db.refresh(job)
        assert job.status == "failed" and job.printer_id == 1
        assigned.assert_not_awaited()
        await asyncio.wait_for(notified.wait(), 2)
        failed.assert_awaited_once()
        assert failed.call_args.kwargs["reason"] == job.error_message
        upload.assert_not_awaited()


async def test_transition_uses_prepared_attempt_without_file_io(alignment, monkeypatch):
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, "queued", "dispatching")
        await db.commit()
        attempt = await prepare_dispatch_archive(db, job)
        copy = AsyncMock(side_effect=AssertionError("The writer must not prepare files"))
        monkeypatch.setattr(ArchiveService, "archive_print", copy)
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await link_dispatch_archive(db, job, attempt)
        await db.commit()
        assert job.archive_id == attempt.id and attempt.dispatched_queue_item_id == job.id
        copy.assert_not_awaited()


async def test_session_close_discards_an_attempt_before_cas(alignment):
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, "queued", "dispatching")
        await db.commit()
        attempt = await prepare_dispatch_archive(db, job)
        directory = settings.base_dir / attempt.file_path
        assert directory.exists()
    assert not directory.parent.exists()
    async with alignment.sessions() as observer:
        assert (await observer.get(PrintQueueItem, alignment.job_id)).status == "dispatching"
        assert await observer.scalar(select(PrintArchive.id)) is None


async def test_same_state_metadata_write_does_not_read_archive_or_full_job(alignment):
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        statements = []

        def capture(_conn, _cursor, statement, _parameters, _context, _executemany):
            statements.append(statement)

        engine = db.bind.sync_engine
        event.listen(engine, "before_cursor_execute", capture)
        try:
            async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
                await transition_queue_item(db, job, "queued", "queued", values={"waiting_reason": "Printer offline"})
            await db.commit()
        finally:
            event.remove(engine, "before_cursor_execute", capture)
        assert job.waiting_reason == "Printer offline"
        assert not any(
            "FROM print_archives" in statement or "print_queue.physical_outcome" in statement
            for statement in statements
        )


async def test_generic_archive_directory_tracking_is_explicit(alignment):
    async with alignment.sessions() as db:
        created_dirs = []
        first = await ArchiveService(db).archive_print(
            1, alignment.source_path, commit=False, flush=False, unique_dir=True, created_dirs=created_dirs
        )
        second = await ArchiveService(db).archive_print(
            1, alignment.source_path, commit=False, flush=False, unique_dir=True, created_dirs=created_dirs
        )
        assert first.file_path != second.file_path and len(created_dirs) == 2
        await db.rollback()  # Only queue_archive registers rollback cleanup for its own copies.
        assert all(directory.exists() for directory in created_dirs)


async def test_requested_snippets_use_settings_helper_and_warn_on_no_result(alignment, monkeypatch, caplog):
    from backend.app.api.routes import settings as settings_routes
    from backend.app.services import queue_archive

    setting = AsyncMock(return_value='{"X1C":{"start_gcode":"M400"}}')
    monkeypatch.setattr(settings_routes, "get_setting", setting)
    monkeypatch.setattr(queue_archive, "inject_gcode_into_3mf", lambda *_args: None)
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, "queued", "dispatching")
        await db.commit()
        await db.refresh(job)
        job.gcode_injection = True
        await db.commit()
        assert await prepare_dispatch_archive(db, job) is not None
        setting.assert_awaited_once_with(db, "gcode_snippets")
        assert "G-code injection returned no result" in caplog.text


@pytest.mark.parametrize("linked", [False, True])
async def test_print_start_does_not_take_association_lock_without_a_candidate(alignment, monkeypatch, linked):
    import backend.app.main as main
    from backend.app.services import print_effects
    from backend.app.services.lifecycle import intake

    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        if linked:
            async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
                await transition_queue_item(db, job, "queued", "dispatching")
            await db.commit()
            attempt = await prepare_dispatch_archive(db, job)
            async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
                await link_dispatch_archive(db, job, attempt)
            async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
                await transition_queue_item(db, job, "dispatching", "printing", values={"dispatch_subtask_id": "123"})
        else:
            async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
                await transition_queue_item(db, job, "queued", "unsuccessful", action="cancel")
        await db.commit()
    live = SimpleNamespace(state="RUNNING", connected=True, job_telemetry_ready=True, submission_id="123")
    monkeypatch.setattr(printer_manager, "get_status", lambda _id: live)
    monkeypatch.setattr(intake, "async_session", alignment.sessions)
    monkeypatch.setattr(print_effects, "async_session", alignment.sessions)
    monkeypatch.setattr(intake, "print_memory", intake.PrintMemory())
    monkeypatch.setattr(print_effects, "_archive_print_start", AsyncMock())
    monkeypatch.setattr(lifecycle_effects, "publish_queue_job_started", AsyncMock())
    lock = AsyncMock(side_effect=AssertionError("No association needs a write lock"))
    monkeypatch.setattr(heat, "lock_queue_item", lock)
    await intake._observe_print_start(1, {"submission_id": "123", "filename": "source.3mf"})
    lock.assert_not_awaited()

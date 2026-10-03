"""Dispatch races across held jobs, heat soak, and printer upload."""

import asyncio
from datetime import timedelta
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
from backend.app.services import chamber_heat_soak as heat, print_scheduler as scheduling
from backend.app.services.archive import ArchiveService
from backend.app.services.printer_manager import printer_manager
from backend.app.services.queue_actions import cancel_job
from backend.app.services.queue_archive import prepare_dispatch_archive
from backend.app.services.queue_transitions import QueueTransitionConflict, transition_queue_item
from backend.tests.unit.test_queue_archive_alignment import alignment  # noqa: F401


@pytest.fixture
async def handoff(alignment, monkeypatch):
    scheduler = scheduling.PrintScheduler()
    service = scheduler._heat_soak
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
    monkeypatch.setattr(service, "cleanup", AsyncMock())
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        now = heat.utcnow()
        await transition_queue_item(
            db,
            job,
            "queued",
            "preheating",
            values={
                "chamber_heat_soak": True,
                "heat_soak_minutes": 1,
                "preheat_owner": service.owner,
                "preheat_requested_at": now - timedelta(minutes=2),
                "preheat_started_at": now - timedelta(minutes=2),
                "preheat_checked_at": now,
            },
        )
        await db.commit()
    return SimpleNamespace(**vars(alignment), scheduler=scheduler, service=service, states=states)


@pytest.mark.parametrize("skip", [False, True])
async def test_stop_during_heat_soak_archive_copy_wins_without_rows_or_directories(handoff, monkeypatch, skip):
    original = ArchiveService.archive_print

    async def stop_during_copy(service, **kwargs):
        archive = await original(service, **kwargs)

        async def stop():
            async with handoff.sessions() as user:
                await cancel_job(user, await user.get(PrintQueueItem, handoff.job_id))

        # A held SQLite write lock prevents this independent Stop from committing.
        await asyncio.wait_for(stop(), timeout=2)
        return archive

    monkeypatch.setattr(ArchiveService, "archive_print", stop_during_copy)
    monkeypatch.setattr(scheduling, "async_session", handoff.sessions)
    monkeypatch.setattr(scheduling, "scheduler", handoff.scheduler)
    handoffs = []

    def capture(coroutine, *, name):
        if name.startswith("skip-heat-soak-dispatch"):
            handoffs.append(coroutine)
        else:
            coroutine.close()

    monkeypatch.setattr(heat, "spawn_background_task", capture)
    async with handoff.sessions() as db:
        if skip:
            job = await heat.lock_queue_item(db, handoff.job_id)
            await heat.skip_heat_soak(db, job)
            assert len(handoffs) == 1
            await handoffs.pop()
        else:
            assert await handoff.service.check(db) == [handoff.job_id]
            await handoff.scheduler._dispatch_after_heat_soak(handoff.job_id)
    async with handoff.sessions() as observer:
        job = await observer.get(PrintQueueItem, handoff.job_id)
        assert job.status == "cancelled" and job.physical_outcome is None
        assert job.archive_id is None and await observer.scalar(select(PrintArchive.id)) is None
    assert not list(settings.archive_dir.rglob("*.3mf"))
    assert not list((settings.archive_dir / "1").iterdir())


@pytest.mark.parametrize("boundary", ["submission", "acknowledgement", "command"])
@pytest.mark.parametrize("cleanup_fails", [False, True])
async def test_losing_dispatch_update_cleans_its_upload_and_retains_the_cancelled_archive(
    alignment, monkeypatch, boundary, cleanup_fails
):
    import backend.app.main as main

    scheduler = scheduling.PrintScheduler()
    live = SimpleNamespace(state="IDLE", connected=True, job_telemetry_ready=True)
    monkeypatch.setattr(printer_manager, "get_status", lambda _id: live)
    monkeypatch.setattr(printer_manager, "is_connected", lambda _id: True)
    monkeypatch.setattr(main, "_user_stopped_printers", set())
    # A control from another worker cannot cancel this process's local task.
    monkeypatch.setattr(scheduling.scheduler, "cancel_inflight", lambda _id: False)
    monkeypatch.setattr(scheduling, "async_session", alignment.sessions)
    monkeypatch.setattr(scheduling, "get_ftp_retry_settings", AsyncMock(return_value=(False, 1, 0, 30)))
    monkeypatch.setattr(scheduler, "_prepare_drying_for_dispatch", AsyncMock(return_value=True))
    monkeypatch.setattr(scheduler, "_active_drying_ams_ids", lambda _id: [])
    started, registered = MagicMock(), MagicMock()
    monkeypatch.setattr(printer_manager, "start_print", started)
    monkeypatch.setattr(main, "register_expected_print", registered)
    notified = AsyncMock()
    monkeypatch.setattr(scheduling.notification_service, "on_queue_job_failed", notified)
    remote_files = {"/another-print.3mf": b"another print"}
    uploaded = False

    async def upload(_ip, _code, local_path, remote_path, **_kwargs):
        nonlocal uploaded
        remote_files[remote_path] = local_path.read_bytes()
        uploaded = True
        return True

    async def delete(_ip, _code, remote_path, **_kwargs):
        if uploaded and cleanup_fails:
            raise OSError("Printer file service unavailable")
        remote_files.pop(remote_path, None)
        return True

    uploads, deletions = AsyncMock(side_effect=upload), AsyncMock(side_effect=delete)
    monkeypatch.setattr(scheduling, "upload_file_async", uploads)
    monkeypatch.setattr(scheduling, "delete_file_async", deletions)
    original = scheduling.transition_queue_item
    stopped = None

    async def stop_before_update(db, item, expected, destination, **kwargs):
        nonlocal stopped
        values = kwargs.get("values", {})
        target = set(values) == {"dispatched_at"} if boundary == "acknowledgement" else "dispatch_subtask_id" in values
        if expected == destination == "dispatching" and target:
            async with alignment.sessions() as user:
                job = await user.get(PrintQueueItem, alignment.job_id)
                await cancel_job(user, job)
                await user.refresh(job)
                stopped = (job.physical_outcome, job.physical_completed_at, job.physical_failure_reason)
        return await original(db, item, expected, destination, **kwargs)

    monkeypatch.setattr(scheduling, "transition_queue_item", stop_before_update)
    original_lock = scheduling.lock_queue_item

    async def stop_before_command(db, item_id):
        nonlocal stopped
        if boundary == "command" and stopped is None:
            async with alignment.sessions() as observer:
                job = await observer.get(PrintQueueItem, item_id)
                ready_to_send = bool(
                    job and job.status == "dispatching" and job.dispatched_at and job.dispatch_subtask_id
                )
            if ready_to_send:
                async with alignment.sessions() as user:
                    job = await user.get(PrintQueueItem, item_id)
                    await cancel_job(user, job)
                    await user.refresh(job)
                    stopped = (job.physical_outcome, job.physical_completed_at, job.physical_failure_reason)
        return await original_lock(db, item_id)

    monkeypatch.setattr(scheduling, "lock_queue_item", stop_before_command)
    await scheduler._dispatch_one(alignment.job_id, 1)
    assert uploaded and stopped is not None
    started.assert_not_called()
    registered.assert_not_called()
    notified.assert_not_awaited()
    uploads.assert_awaited_once()
    remote_path = uploads.call_args.args[3]
    # One delete precedes upload; the second removes only this losing copy.
    assert deletions.await_count == 2
    assert all(call.args[2] == remote_path for call in deletions.await_args_list)
    assert deletions.await_args.kwargs == {"socket_timeout": 30, "printer_model": "X1C"}
    assert remote_files["/another-print.3mf"] == b"another print"
    assert (remote_path in remote_files) == cleanup_fails
    async with alignment.sessions() as observer:
        job = await observer.get(PrintQueueItem, alignment.job_id)
        archive = await observer.get(PrintArchive, job.archive_id)
        assert job.status == "cancelled" and job.printer_id == 1 and job.dispatching_at is None
        assert (
            (job.physical_outcome, job.physical_completed_at, job.physical_failure_reason)
            == stopped
            == (None, None, None)
        )
        assert archive.status == "aborted" and archive.dispatched_queue_item_id == job.id
        assert archive.completed_at == job.completed_at and archive.failure_reason == "User cancelled"
        assert (settings.base_dir / archive.file_path).is_file()
    assert alignment.source_path.is_file()


async def test_database_error_in_second_heat_soak_preserves_first_dispatch(handoff, monkeypatch):
    async with handoff.sessions() as db:
        first = await db.get(PrintQueueItem, handoff.job_id)
        db.add(Printer(id=2, name="Second", serial_number="SECOND", ip_address="127.0.0.2", access_code="code"))
        db.add(
            PrintQueueItem(
                printer_id=2,
                library_file_id=handoff.source_id,
                status="preheating",
                chamber_heat_soak=True,
                heat_soak_minutes=1,
                preheat_owner=handoff.service.owner,
                preheat_requested_at=first.preheat_requested_at,
                preheat_started_at=first.preheat_started_at,
                preheat_checked_at=first.preheat_checked_at,
            )
        )
        await db.commit()
    handoff.states[2] = SimpleNamespace(**vars(handoff.states[1]))
    original = heat.transition_queue_item

    async def fail_second_handoff(db, item, before, after, **kwargs):
        if item.printer_id == 2 and before == "preheating" and after == "dispatching":
            raise OperationalError("UPDATE", {}, RuntimeError("database unavailable"))
        return await original(db, item, before, after, **kwargs)

    monkeypatch.setattr(heat, "transition_queue_item", fail_second_handoff)
    dispatched = []

    def collect(coroutine, *, name):
        dispatched.append(name)
        coroutine.close()

    monkeypatch.setattr(scheduling, "spawn_background_task", collect)
    async with handoff.sessions() as db:
        await handoff.scheduler._check_heat_soaks(db)
    async with handoff.sessions() as observer:
        first = await observer.get(PrintQueueItem, handoff.job_id)
        second = await observer.scalar(select(PrintQueueItem).where(PrintQueueItem.printer_id == 2))
        assert first.status == "dispatching" and first.archive_id is None
        assert second.status == "preheating" and second.archive_id is None
    assert dispatched == [f"heat-soak-dispatch-{handoff.job_id}"]


async def test_unready_telemetry_keeps_heat_soak_alive_without_copying(handoff, monkeypatch):
    handoff.states[1].job_telemetry_ready = False
    now = heat.utcnow()
    copy = AsyncMock()
    monkeypatch.setattr(ArchiveService, "archive_print", copy)
    for seconds in range(0, heat.HEARTBEAT_TIMEOUT + 31, 10):
        tick = now + timedelta(seconds=seconds)
        monkeypatch.setattr(heat, "utcnow", lambda tick=tick: tick)
        async with handoff.sessions() as db:
            assert await handoff.service.check(db) == []
        async with handoff.sessions() as observer:
            job = await observer.get(PrintQueueItem, handoff.job_id)
            assert job.status == "preheating" and job.preheat_checked_at == tick
            assert job.archive_id is None and await observer.scalar(select(PrintArchive.id)) is None
    copy.assert_not_awaited()
    assert not list(settings.archive_dir.rglob("*.3mf"))


@pytest.mark.parametrize("skip", [False, True])
@pytest.mark.parametrize("change", ["stop", "owner", "printer"])
async def test_guard_conflict_does_not_refresh_a_changed_soak(handoff, monkeypatch, change, skip):
    now = heat.utcnow()
    original_heartbeat = now
    monkeypatch.setattr(heat, "utcnow", lambda: now)
    original_copy, original_ready = ArchiveService.archive_print, heat._dispatch_ready
    checks = 0

    async def slow_copy(service, **kwargs):
        nonlocal now
        attempt = await original_copy(service, **kwargs)
        now += timedelta(seconds=heat.HEARTBEAT_TIMEOUT + 1)
        return attempt

    def ready(printer_id):
        nonlocal checks
        checks += 1
        if checks == 3:
            handoff.states[1].job_telemetry_ready = False
        return original_ready(printer_id)

    monkeypatch.setattr(ArchiveService, "archive_print", slow_copy)
    monkeypatch.setattr(heat, "_dispatch_ready", ready)
    async with handoff.sessions() as db:
        if change == "printer":
            db.add(Printer(id=2, name="Second", serial_number="SECOND", ip_address="127.0.0.2", access_code="code"))
            await db.commit()
        rollback = db.rollback
        changed = False

        async def rollback_then_change():
            nonlocal changed
            await rollback()
            if checks == 3 and not changed:
                changed = True
                # A control wins after rollback releases the handoff lock.
                async with handoff.sessions() as control:
                    job = await heat.lock_queue_item(control, handoff.job_id)
                    if change == "stop":
                        await cancel_job(control, job)
                    else:
                        values = {"preheat_checked_at": original_heartbeat}
                        values["preheat_owner" if change == "owner" else "printer_id"] = (
                            "another-owner" if change == "owner" else 2
                        )
                        await transition_queue_item(control, job, "preheating", "preheating", values=values)
                        await control.commit()

        monkeypatch.setattr(db, "rollback", rollback_then_change)
        if skip:
            job = await heat.lock_queue_item(db, handoff.job_id)
            assert await heat.skip_heat_soak(db, job) == heat.SkipHeatSoakResult.SOAK_CHANGED
        else:
            assert await handoff.service.check(db) == []
        assert changed
    async with handoff.sessions() as db:
        job = await db.get(PrintQueueItem, handoff.job_id)
        assert job.archive_id is None and await db.scalar(select(PrintArchive.id)) is None
        if change == "stop":
            assert job.status == "cancelled" and job.physical_outcome is None
            assert job.preheat_owner is None and job.preheat_checked_at is None
        else:
            assert job.status == "preheating" and job.physical_outcome is None
            assert job.preheat_checked_at == original_heartbeat
            assert job.preheat_owner == ("another-owner" if change == "owner" else handoff.service.owner)
            assert job.printer_id == (2 if change == "printer" else 1)
    assert not list(settings.archive_dir.rglob("*.3mf"))
    assert not list((settings.archive_dir / "1").glob("*"))


@pytest.mark.parametrize("source_kind", ["file", "archive"])
async def test_deleted_heat_soak_source_fails_without_an_attempt(handoff, monkeypatch, source_kind):
    monkeypatch.setattr(scheduling, "async_session", handoff.sessions)
    async with handoff.sessions() as db:
        job = await db.get(PrintQueueItem, handoff.job_id)
        if source_kind == "archive":
            source = await ArchiveService(db).archive_print(
                None, handoff.source_path, print_data={"status": "completed"}
            )
            job.archive_id = source.id
            job.library_file_id = None
        else:
            source = await db.get(LibraryFile, handoff.source_id)
        source.deleted_at = heat.utcnow()
        await db.commit()
        assert await handoff.service.check(db) == [job.id]
        await handoff.scheduler._dispatch_after_heat_soak(job.id)
        await db.refresh(job)
        assert job.status == "failed" and job.physical_outcome == "failed"
        assert job.error_message == (
            "Archive source was deleted" if source_kind == "archive" else "Library file not found"
        )
        assert await db.scalar(select(PrintArchive.id).where(PrintArchive.dispatched_queue_item_id == job.id)) is None
        await db.refresh(source)
        assert source.deleted_at is not None


async def test_skip_route_holds_job_then_copy_failure_is_recorded(handoff, monkeypatch):
    from backend.app.api.routes.print_queue import skip_queue_item_heat_soak

    monkeypatch.setattr(ArchiveService, "archive_print", AsyncMock(side_effect=OSError("Disk full")))
    monkeypatch.setattr(scheduling, "async_session", handoff.sessions)
    monkeypatch.setattr(scheduling, "scheduler", handoff.scheduler)
    handoffs = []

    def capture(coroutine, *, name):
        if name.startswith("skip-heat-soak-dispatch"):
            handoffs.append(coroutine)
        else:
            coroutine.close()

    monkeypatch.setattr(heat, "spawn_background_task", capture)
    async with handoff.sessions() as db:
        result = await skip_queue_item_heat_soak(handoff.job_id, db=db, auth_result=(None, True))
        assert result == {"message": "Heat soak skipped"}
        assert len(handoffs) == 1
        await handoffs.pop()
    async with handoff.sessions() as observer:
        job = await observer.get(PrintQueueItem, handoff.job_id)
        assert job.status == "failed" and "Archive" in job.error_message


async def test_pool_copy_failure_notifies_failure_without_assignment(alignment, monkeypatch):
    monkeypatch.setattr(
        printer_manager,
        "get_status",
        lambda _id: SimpleNamespace(state="IDLE", connected=True, job_telemetry_ready=True),
    )
    monkeypatch.setattr(printer_manager, "is_connected", lambda _id: True)
    monkeypatch.setattr(printer_manager, "is_awaiting_plate_clear", lambda _id: False)
    monkeypatch.setattr(ArchiveService, "archive_print", AsyncMock(side_effect=OSError("Disk full")))
    scheduler = scheduling.PrintScheduler()
    assigned, failed, upload = AsyncMock(), AsyncMock(), AsyncMock()
    monkeypatch.setattr(scheduler, "_notify_pool_assignment", assigned)
    notified = asyncio.Event()

    async def record_failure(**kwargs):
        await failed(**kwargs)
        notified.set()

    monkeypatch.setattr(scheduling.notification_service, "on_queue_job_failed", record_failure)
    monkeypatch.setattr(scheduling, "upload_file_async", upload)
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        job.printer_id = None
        await db.commit()
        binding = scheduling._DispatchBinding.for_item(job, 1, None, unassigned=True)
        await scheduler._start_print(db, job, binding=binding)
        assert job.status == "failed" and job.printer_id == 1
        assigned.assert_not_awaited()
        await asyncio.wait_for(notified.wait(), 2)
        failed.assert_awaited_once()
        assert failed.call_args.kwargs["reason"] == job.error_message
        upload.assert_not_awaited()


async def test_transition_uses_prepared_attempt_without_file_io(alignment, monkeypatch):
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        await transition_queue_item(db, job, "queued", "dispatching")
        await db.commit()
        attempt = await prepare_dispatch_archive(db, job)
        copy = AsyncMock(side_effect=AssertionError("The writer must not prepare files"))
        monkeypatch.setattr(ArchiveService, "archive_print", copy)
        await transition_queue_item(db, job, "dispatching", "dispatching", attempt=attempt)
        await db.commit()
        assert job.archive_id == attempt.id and attempt.dispatched_queue_item_id == job.id
        copy.assert_not_awaited()


async def test_session_close_discards_an_attempt_before_cas(alignment):
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        await transition_queue_item(db, job, "queued", "dispatching")
        await db.commit()
        attempt = await prepare_dispatch_archive(db, job)
        directory = settings.base_dir / attempt.file_path
        assert directory.exists()
    assert not directory.parent.exists()
    async with alignment.sessions() as observer:
        assert (await observer.get(PrintQueueItem, alignment.job_id)).status == "dispatching"
        assert await observer.scalar(select(PrintArchive.id)) is None


async def test_losing_preparation_does_not_discard_another_attempt(alignment):
    async with alignment.sessions() as db:
        first = await db.get(PrintQueueItem, alignment.job_id)
        db.add(Printer(id=2, name="Second", serial_number="SECOND", ip_address="127.0.0.2", access_code="code"))
        second = PrintQueueItem(printer_id=2, library_file_id=alignment.source_id, status="queued")
        db.add(second)
        await db.commit()
        await transition_queue_item(db, first, "queued", "dispatching")
        await transition_queue_item(db, second, "queued", "dispatching")
        await db.commit()
        winner = await prepare_dispatch_archive(db, first)
        loser = await prepare_dispatch_archive(db, second)
        winner_file = settings.base_dir / winner.file_path
        loser_file = settings.base_dir / loser.file_path
        with pytest.raises(QueueTransitionConflict):
            await transition_queue_item(
                db,
                second,
                "dispatching",
                "dispatching",
                conditions=(PrintQueueItem.preheat_owner == "other-owner",),
                attempt=loser,
            )
        assert winner_file.exists() and not loser_file.parent.exists()
        await transition_queue_item(db, first, "dispatching", "dispatching", attempt=winner)
        await db.commit()
        assert winner_file.exists() and await db.scalar(select(PrintArchive.id)) == winner.id


async def test_same_state_metadata_write_does_not_read_archive_or_full_job(alignment):
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        statements = []

        def capture(_conn, _cursor, statement, _parameters, _context, _executemany):
            statements.append(statement)

        engine = db.bind.sync_engine
        event.listen(engine, "before_cursor_execute", capture)
        try:
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
        assert "queue_archive_artifacts" not in db.sync_session.info


async def test_requested_snippets_use_settings_helper_and_warn_on_no_result(alignment, monkeypatch, caplog):
    from backend.app.api.routes import settings as settings_routes
    from backend.app.services import queue_archive

    setting = AsyncMock(return_value='{"X1C":{"start_gcode":"M400"}}')
    monkeypatch.setattr(settings_routes, "get_setting", setting)
    monkeypatch.setattr(queue_archive, "inject_gcode_into_3mf", lambda *_args: None)
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        job.gcode_injection = True
        await db.commit()
        assert await prepare_dispatch_archive(db, job) is not None
        setting.assert_awaited_once_with(db, "gcode_snippets")
        assert "G-code injection returned no result" in caplog.text


@pytest.mark.parametrize("linked", [False, True])
async def test_print_start_does_not_take_association_lock_without_a_candidate(alignment, monkeypatch, linked):
    import backend.app.main as main

    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        if linked:
            await transition_queue_item(db, job, "queued", "dispatching")
            await db.commit()
            attempt = await prepare_dispatch_archive(db, job)
            await transition_queue_item(db, job, "dispatching", "dispatching", attempt=attempt)
            await transition_queue_item(db, job, "dispatching", "printing", values={"dispatch_subtask_id": "123"})
        else:
            await transition_queue_item(db, job, "queued", "unsuccessful", action="cancel")
        await db.commit()
    live = SimpleNamespace(state="RUNNING", connected=True, job_telemetry_ready=True, submission_id="123")
    monkeypatch.setattr(printer_manager, "get_status", lambda _id: live)
    monkeypatch.setattr(main, "async_session", alignment.sessions)
    monkeypatch.setattr(main, "_observed_job_starts", {})
    monkeypatch.setattr(main, "_archive_print_start", AsyncMock())
    monkeypatch.setattr(main.print_scheduler, "_publish_queue_job_started", AsyncMock())
    lock = AsyncMock(side_effect=AssertionError("No association needs a write lock"))
    monkeypatch.setattr(heat, "lock_queue_item", lock)
    await main._observe_print_start(1, {"submission_id": "123", "filename": "source.3mf"})
    lock.assert_not_awaited()

import asyncio
import zipfile
from contextlib import ExitStack, suppress
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401 - populate Base.metadata
import backend.app.models.print_log  # noqa: F401
import backend.app.services.print_scheduler as scheduler_module
from backend.app.core.database import Base
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.settings import Settings
from backend.app.services.print_scheduler import PrintScheduler


@pytest.fixture
async def queue_factory(tmp_path):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    session_maker = async_sessionmaker(engine, expire_on_commit=False)
    case_counter = 0

    async def make_case(*, cleanup=True, is_external=False, thumbnail_path=None, wait_for_drying_complete=False):
        nonlocal case_counter
        case_counter += 1

        base_dir = tmp_path / f"case-{case_counter}"
        base_dir.mkdir()
        source_path = base_dir / "library" / f"source-{case_counter}.3mf"
        source_path.parent.mkdir()
        source_path.write_bytes(b"library source")

        thumbnail_actual_path = None
        thumbnail_db_path = None
        if thumbnail_path == "relative":
            thumbnail_db_path = f"thumbs/preview-{case_counter}.png"
            thumbnail_actual_path = base_dir / thumbnail_db_path
        elif thumbnail_path == "absolute":
            thumbnail_actual_path = tmp_path / f"absolute-preview-{case_counter}.png"
            thumbnail_db_path = str(thumbnail_actual_path)
        elif thumbnail_path is not None:
            thumbnail_actual_path = Path(thumbnail_path)
            thumbnail_db_path = str(thumbnail_path)

        if thumbnail_actual_path:
            thumbnail_actual_path.parent.mkdir(parents=True, exist_ok=True)
            thumbnail_actual_path.write_bytes(b"thumbnail")

        async with session_maker() as db:
            printer = Printer(
                name=f"Printer {case_counter}",
                serial_number=f"SERIAL-{case_counter}",
                ip_address="127.0.0.1",
                access_code="access-code",
                model="X1C",
            )
            library_file = LibraryFile(
                filename=f"source-{case_counter}.3mf",
                file_path=str(source_path),
                file_type="3mf",
                file_size=source_path.stat().st_size,
                file_hash=None,
                thumbnail_path=thumbnail_db_path,
                file_metadata=None,
                is_external=is_external,
                queue_only=cleanup,
            )
            db.add_all([printer, library_file])
            await db.flush()

            item = PrintQueueItem(
                printer_id=printer.id,
                library_file_id=library_file.id,
                status="queued",
                cleanup_library_after_dispatch=cleanup,
                wait_for_drying_complete=wait_for_drying_complete,
                bed_levelling="on",
                flow_cali="off",
                vibration_cali=True,
                layer_inspect=False,
                timelapse=False,
                use_ams=True,
                nozzle_offset_cali="on",
            )
            db.add(item)
            await db.commit()

            return SimpleNamespace(
                session_maker=session_maker,
                base_dir=base_dir,
                source_path=source_path,
                thumbnail_path=thumbnail_actual_path,
                printer_id=printer.id,
                library_file_id=library_file.id,
                queue_item_id=item.id,
                archive_path=None,
                upload=AsyncMock(return_value=True),
                start_print=MagicMock(return_value=True),
                stop_drying=MagicMock(return_value=True),
            )

    try:
        yield make_case
    finally:
        await engine.dispose()


async def _dispatch_library_item(
    ctx,
    *,
    archive_failure=False,
    unlink_side_effect=None,
    printer_status=None,
    printer_statuses=None,
    before_reservation=None,
    during_archive=None,
    binding=None,
    connected=True,
    assigned_notification=None,
):
    scheduler = PrintScheduler()

    async def archive_print(
        self,
        *,
        printer_id,
        source_file,
        original_filename,
        print_data=None,
        created_by_id=None,
        project_id=None,
        subtask_id=None,
        dispatched_queue_item_id=None,
        prefer_filename_for_name=False,
        commit=True,
        flush=True,
        unique_dir=False,
        created_dirs=None,
    ):
        if archive_failure:
            raise RuntimeError("archive copy failed")

        archive_rel_path = Path("archives") / f"attempt-{ctx.queue_item_id}" / "copy.3mf"
        ctx.archive_path = ctx.base_dir / archive_rel_path
        ctx.archive_path.parent.mkdir(parents=True, exist_ok=True)
        if created_dirs is not None:
            created_dirs.append(ctx.archive_path.parent)
        ctx.archive_path.write_bytes(Path(source_file).read_bytes())
        if during_archive:
            await during_archive()

        archive = PrintArchive(
            printer_id=printer_id,
            filename=original_filename,
            file_path=str(archive_rel_path),
            file_size=ctx.archive_path.stat().st_size,
            content_hash=None,
            thumbnail_path=None,
            timelapse_path=None,
            print_time_seconds=120,
            status=(print_data or {}).get("status", "completed"),
            project_id=project_id,
            created_by_id=created_by_id,
            dispatched_queue_item_id=dispatched_queue_item_id,
        )
        self.db.add(archive)
        if flush:
            await self.db.flush()
        return archive

    states = printer_statuses if printer_statuses is not None else [printer_status]
    for state in states:
        if state is not None:
            state.state = "IDLE"
            state.connected = True
    printer_status = printer_status or SimpleNamespace(state="IDLE", connected=True, raw_data={})
    status_mock = (
        MagicMock(side_effect=[printer_statuses[0], *printer_statuses])
        if printer_statuses is not None
        else MagicMock(return_value=printer_status)
    )
    patches = [
        patch.object(scheduler_module.settings, "base_dir", ctx.base_dir),
        patch("backend.app.services.archive.ArchiveService.archive_print", new=archive_print),
        patch("backend.app.services.print_scheduler.printer_manager.is_connected", MagicMock(return_value=connected)),
        patch(
            "backend.app.services.print_scheduler.printer_manager.get_status",
            status_mock,
        ),
        patch(
            "backend.app.services.print_scheduler.printer_manager.send_drying_command",
            ctx.stop_drying,
        ),
        patch("backend.app.services.print_scheduler.printer_manager.is_awaiting_plate_clear", return_value=False),
        patch("backend.app.services.print_scheduler.printer_manager.start_print", ctx.start_print),
        patch("backend.app.services.print_scheduler.printer_manager.set_awaiting_plate_clear", MagicMock()),
        patch(
            "backend.app.services.print_scheduler.get_ftp_retry_settings", AsyncMock(return_value=(False, 0, 0, 1.0))
        ),
        patch("backend.app.services.print_scheduler.delete_file_async", AsyncMock(return_value=True)),
        patch("backend.app.services.print_scheduler.upload_file_async", ctx.upload),
        patch("backend.app.services.print_scheduler.cache_3mf_download", MagicMock()),
        patch("backend.app.services.notification_service.notification_service.on_queue_job_started", AsyncMock()),
        patch("backend.app.services.notification_service.notification_service.on_queue_job_failed", AsyncMock()),
        patch(
            "backend.app.services.notification_service.notification_service.on_queue_job_assigned",
            assigned_notification or AsyncMock(),
        ),
        patch("backend.app.services.mqtt_relay.mqtt_relay.on_queue_job_started", AsyncMock()),
        patch.object(scheduler, "_propagate_owner_to_printer_manager", AsyncMock()),
        patch.object(scheduler, "_power_off_if_needed", AsyncMock()),
        patch.object(scheduler, "_schedule_dispatch_confirmation", MagicMock()),
    ]
    if unlink_side_effect:
        patches.append(patch.object(type(ctx.source_path), "unlink", unlink_side_effect))
    if binding is not None:
        patches.append(patch.object(scheduler_module, "async_session", ctx.session_maker))

    with ExitStack() as stack:
        for patcher in patches:
            stack.enter_context(patcher)

        if binding is not None:
            # The real worker path: claim, then bind only at the hold.
            await scheduler._dispatch_one(ctx.queue_item_id, binding.printer_id, binding=binding)
            return
        async with ctx.session_maker() as db:
            item = await db.get(PrintQueueItem, ctx.queue_item_id)
            if before_reservation:
                await before_reservation(db, item)
            await scheduler._start_print(db, item)


async def _finish_and_clear(ctx):
    from backend.app.services.queue_transitions import clear_job_plate, transition_queue_item

    with patch.object(scheduler_module.settings, "base_dir", ctx.base_dir):
        async with ctx.session_maker() as db:
            item = await db.get(PrintQueueItem, ctx.queue_item_id)
            await transition_queue_item(db, item, "dispatching", "printing")
            await transition_queue_item(db, item, "printing", "finished")
            await db.commit()
            assert ctx.source_path.exists()
            await clear_job_plate(db, item)
            await db.commit()


async def _queue_snapshot(ctx):
    async with ctx.session_maker() as db:
        item = await db.get(PrintQueueItem, ctx.queue_item_id)
        library_file = await db.get(LibraryFile, ctx.library_file_id)
        archive = await db.get(PrintArchive, item.archive_id) if item.archive_id else None
        return item, library_file, archive


async def test_live_upload_is_not_a_dispatch_confirmation_prompt(queue_factory):
    from datetime import datetime, timezone

    from fastapi import HTTPException

    from backend.app.api.routes.print_queue import get_queue_item, resolve_queue_dispatch
    from backend.app.schemas.print_queue import DispatchResolution

    ctx = await queue_factory(cleanup=False)

    async def claim(db, item):
        item.dispatching_at = datetime.now(timezone.utc)
        await db.commit()

    async def uploading(*_args, **_kwargs):
        ctx.start_print.assert_not_called()
        async with ctx.session_maker() as db:
            response = await get_queue_item(ctx.queue_item_id, db, (None, True))
            assert response.status == "dispatching" and not response.dispatch_needs_resolution
            with pytest.raises(HTTPException) as conflict:
                await resolve_queue_dispatch(
                    ctx.queue_item_id, DispatchResolution(outcome="printing"), db, (None, True)
                )
            assert conflict.value.status_code == 409
            await db.rollback()
            await PrintScheduler()._recover_stale_dispatches(db)
            assert (await db.get(PrintQueueItem, ctx.queue_item_id)).error_message is None
        return True

    ctx.upload.side_effect = uploading
    await _dispatch_library_item(ctx, before_reservation=claim)
    ctx.start_print.assert_called_once()
    item, _, _ = await _queue_snapshot(ctx)
    assert item.status == "dispatching" and item.started_at is None


@pytest.mark.parametrize("cancelled", [False, True])
async def test_archive_preparation_is_unsent_and_cancellation_still_fences_mqtt(queue_factory, cancelled):
    from datetime import datetime, timezone

    from backend.app.services.job_identity import needs_dispatch_resolution
    from backend.app.services.queue_transitions import transition_queue_item

    ctx = await queue_factory(cleanup=False)
    preparation_finished = None

    async def copying():
        nonlocal preparation_finished
        async with ctx.session_maker() as db:
            item = await db.get(PrintQueueItem, ctx.queue_item_id)
            assert item.status == "queued" and item.dispatch_subtask_id is None
            assert item.dispatched_at is None and not needs_dispatch_resolution(item)
            if cancelled:
                await transition_queue_item(db, item, "queued", "unsuccessful", action="cancel")
                await db.commit()
        preparation_finished = datetime.now(timezone.utc)

    if cancelled:
        from backend.app.services.queue_transitions import QueueTransitionConflict

        with pytest.raises(QueueTransitionConflict):
            await _dispatch_library_item(ctx, during_archive=copying)
    else:
        await _dispatch_library_item(ctx, during_archive=copying)
    item, _, archive = await _queue_snapshot(ctx)
    if cancelled:
        ctx.start_print.assert_not_called()
        assert item.status == "unsuccessful" and item.dispatched_at is None and archive is None
        assert not ctx.archive_path.exists()
    else:
        ctx.start_print.assert_called_once()
        assert item.dispatched_at.replace(tzinfo=timezone.utc) >= preparation_finished
        assert not needs_dispatch_resolution(item)


@pytest.mark.parametrize("recorded_path, subtask_name", [(True, "same"), (True, ""), (False, "same")])
async def test_old_completion_cannot_delete_a_later_upload(queue_factory, recorded_path, subtask_name):
    """Overlap real completion and dispatch; only the completed upload may go."""
    import backend.app.main as main
    from backend.app.services.archive import ArchiveService
    from backend.app.services.bambu_ftp import DeleteResult

    ctx = await queue_factory(cleanup=False)
    old_remote = "/same__grove_previous.3mf" if recorded_path else "/same.3mf"
    old_file = ctx.base_dir / "archives/previous/same.gcode.3mf"
    old_file.parent.mkdir(parents=True)
    old_file.write_bytes(b"old attempt")
    async with ctx.session_maker() as db:
        library = await db.get(LibraryFile, ctx.library_file_id)
        library.filename = "same.gcode.3mf"
        archive = PrintArchive(
            printer_id=ctx.printer_id,
            filename=library.filename,
            file_path=str(old_file),
            file_size=old_file.stat().st_size,
            status="printing",
            extra_data={"remote_filename": old_remote[1:]} if recorded_path else None,
        )
        db.add(archive)
        await db.flush()
        old = PrintQueueItem(
            printer_id=ctx.printer_id,
            archive_id=archive.id,
            status="printing",
            dispatch_subtask_id="123",
        )
        db.add_all([old, Settings(key="require_plate_clear", value="false")])
        await db.flush()
        archive.dispatched_queue_item_id = old.id
        await db.commit()
        old_id, archive_id = old.id, archive.id

    remote_files = {old_remote: b"old attempt"}
    if recorded_path:
        remote_files["/same.3mf"] = b"unrelated display-name file"
    entered, release = asyncio.Event(), asyncio.Event()
    deleted_paths = []

    async def delete_old(_ip, _code, path, **_kwargs):
        deleted_paths.append(path)
        if path == old_remote:
            entered.set()
            await release.wait()
        return DeleteResult.DELETED if remote_files.pop(path, None) is not None else DeleteResult.NOT_FOUND

    async def upload_new(_ip, _code, file_path, remote_path, **_kwargs):
        remote_files[remote_path] = Path(file_path).read_bytes()
        return True

    ctx.upload.side_effect = upload_new
    state = SimpleNamespace(state="FINISH", connected=True, submission_id="123", subtask_id="123", raw_data={})
    with (
        patch.object(main, "async_session", ctx.session_maker),
        patch.object(main, "_completed_job_events", {}),
        patch.object(main.printer_manager, "get_status", return_value=state),
        patch.object(main.printer_manager, "is_connected", return_value=True),
        patch.object(scheduler_module.settings, "base_dir", ctx.base_dir),
        patch.object(scheduler_module.settings, "archive_dir", ctx.base_dir / "archives"),
        patch("backend.app.services.bambu_ftp.delete_file_async", new=delete_old),
        # End the callback after SD cleanup, before unrelated completion effects.
        patch("backend.app.services.usage_tracker.on_print_complete", AsyncMock(side_effect=asyncio.CancelledError)),
    ):
        completion = asyncio.create_task(
            main._complete_identified_print(
                ctx.printer_id,
                {
                    "status": "completed",
                    "filename": "same.gcode.3mf",
                    "subtask_name": subtask_name,
                    "submission_id": "123",
                },
            )
        )
        try:
            await asyncio.wait_for(entered.wait(), 5)
            async with ctx.session_maker() as db:
                assert (await db.get(PrintQueueItem, old_id)).status == "successful"
                # Automatic Clear Plate permits Archive purge before FTP ends.
                assert await ArchiveService(db).delete_archive(archive_id)
            await _dispatch_library_item(ctx)
            ctx.start_print.assert_called_once()
            remote_path = ctx.upload.call_args.args[3]
            assert remote_path != old_remote
            assert ctx.start_print.call_args.args[1] == remote_path[1:]
            assert ctx.start_print.call_args.kwargs["display_name"] == "same.gcode.3mf"
            _, _, new_archive = await _queue_snapshot(ctx)
            assert new_archive.filename == "same.gcode.3mf"
            assert new_archive.extra_data["remote_filename"] == remote_path[1:]
            release.set()
            with suppress(asyncio.CancelledError):
                await asyncio.wait_for(completion, 5)
            assert remote_path in remote_files
            assert old_remote not in remote_files
            if recorded_path:
                assert deleted_paths == [old_remote]
                assert remote_files["/same.3mf"] == b"unrelated display-name file"
        finally:
            completion.cancel()
            with suppress(asyncio.CancelledError):
                await completion


@pytest.mark.asyncio
async def test_cleanup_unlinks_library_file_and_removes_db_row(queue_factory):
    ctx = await queue_factory(cleanup=True)

    await _dispatch_library_item(ctx)
    await _finish_and_clear(ctx)

    item, library_file, archive = await _queue_snapshot(ctx)
    assert item.status == "successful"
    assert item.library_file_id is None
    assert item.archive_id == archive.id
    assert library_file is None
    assert not ctx.source_path.exists()


@pytest.mark.asyncio
async def test_external_library_file_skips_cleanup(queue_factory):
    ctx = await queue_factory(cleanup=True, is_external=True)

    await _dispatch_library_item(ctx)

    item, library_file, archive = await _queue_snapshot(ctx)
    assert item.status == "dispatching"
    assert item.library_file_id == ctx.library_file_id
    assert item.archive_id == archive.id
    assert library_file is not None
    assert ctx.source_path.exists()


@pytest.mark.asyncio
async def test_archive_creation_failure_skips_cleanup_and_dispatch(queue_factory):
    ctx = await queue_factory(cleanup=True, thumbnail_path="relative")

    await _dispatch_library_item(ctx, archive_failure=True)

    item, library_file, archive = await _queue_snapshot(ctx)
    assert item.status == "failed"
    assert item.error_message == "Failed to create Archive record for dispatch: archive copy failed"
    assert item.archive_id is None
    assert archive is None
    assert library_file is not None
    assert ctx.source_path.exists()
    assert ctx.thumbnail_path.exists()
    ctx.upload.assert_not_awaited()
    ctx.start_print.assert_not_called()


@pytest.mark.parametrize("thumbnail_path", ["absolute", "relative"])
@pytest.mark.asyncio
async def test_cleanup_resolves_absolute_and_relative_thumbnail_paths(queue_factory, thumbnail_path):
    ctx = await queue_factory(cleanup=True, thumbnail_path=thumbnail_path)

    await _dispatch_library_item(ctx)
    await _finish_and_clear(ctx)

    item, library_file, archive = await _queue_snapshot(ctx)
    assert item.status == "successful"
    assert item.archive_id == archive.id
    assert library_file is None
    assert not ctx.source_path.exists()
    assert not ctx.thumbnail_path.exists()


@pytest.mark.asyncio
async def test_archive_copy_survives_library_cleanup(queue_factory):
    ctx = await queue_factory(cleanup=True)

    await _dispatch_library_item(ctx)
    await _finish_and_clear(ctx)

    assert not ctx.source_path.exists()
    assert ctx.archive_path.exists()
    assert ctx.archive_path.read_bytes() == b"library source"
    uploaded_path = ctx.upload.await_args.args[2]
    assert uploaded_path == ctx.archive_path


@pytest.mark.parametrize("source_kind", ["archive", "files"])
@pytest.mark.asyncio
async def test_dispatch_strips_saved_grove_snippets_with_injection_off(queue_factory, source_kind):
    """Reprints and Files copies must not replay snippets from an earlier printer."""
    ctx = await queue_factory(cleanup=False)
    source_path = ctx.source_path
    if source_kind == "archive":
        source_path = ctx.base_dir / "archives" / "saved-snapshot.3mf"
        source_path.parent.mkdir()

    with zipfile.ZipFile(source_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "Metadata/plate_1.gcode",
            "; MACHINE_START_GCODE_END\n"
            "; GROVE_INJECT_START_BEGIN\nOLD_START\n; GROVE_INJECT_START_END\n"
            "G1 X1\n"
            "; GROVE_INJECT_END_BEGIN\nOLD_END\n; GROVE_INJECT_END_END\n"
            "; EXECUTABLE_BLOCK_END\n",
        )
    original_bytes = source_path.read_bytes()

    if source_kind == "archive":
        async with ctx.session_maker() as db:
            source_archive = PrintArchive(
                printer_id=ctx.printer_id,
                filename=source_path.name,
                file_path=str(source_path.relative_to(ctx.base_dir)),
                file_size=len(original_bytes),
                status="completed",
            )
            db.add(source_archive)
            await db.flush()
            item = await db.get(PrintQueueItem, ctx.queue_item_id)
            item.archive_id = source_archive.id
            item.library_file_id = None
            await db.commit()

    uploaded_bytes = []

    async def capture_upload(*args, **kwargs):
        uploaded_bytes.append(Path(args[2]).read_bytes())
        return True

    ctx.upload.side_effect = capture_upload
    await _dispatch_library_item(ctx)

    assert ctx.upload.await_count == 1
    assert ctx.archive_path.read_bytes() == uploaded_bytes[0]
    assert source_path.read_bytes() == original_bytes
    with zipfile.ZipFile(ctx.archive_path) as zf:
        dispatched_gcode = zf.read("Metadata/plate_1.gcode").decode("utf-8")
    assert "OLD_START" not in dispatched_gcode
    assert "OLD_END" not in dispatched_gcode
    assert "GROVE_INJECT" not in dispatched_gcode
    assert "G1 X1" in dispatched_gcode


@pytest.mark.asyncio
async def test_final_dispatch_boundary_stops_new_drying_and_does_not_send_print(queue_factory):
    """Drying that begins during upload must still block project_file."""
    ctx = await queue_factory(cleanup=False)
    status = SimpleNamespace(raw_data={"ams": [{"id": 0, "dry_time": 120}]})

    await _dispatch_library_item(ctx, printer_status=status)

    item, library_file, archive = await _queue_snapshot(ctx)
    assert item.status == "failed"
    assert item.waiting_reason == "Stopping AMS drying before dispatch"
    assert library_file is not None
    assert archive.status == "failed"
    ctx.stop_drying.assert_called_once_with(ctx.printer_id, 0, 0, 0, mode=0)
    ctx.start_print.assert_not_called()


@pytest.mark.asyncio
async def test_final_dispatch_boundary_can_wait_for_natural_drying_completion(queue_factory):
    """A job held for natural drying has not crossed the dispatch boundary."""
    ctx = await queue_factory(cleanup=False, wait_for_drying_complete=True)
    status = SimpleNamespace(raw_data={"ams": [{"id": 128, "dry_time": 45}]})

    await _dispatch_library_item(ctx, printer_status=status)

    item, library_file, archive = await _queue_snapshot(ctx)
    assert item.status == "failed"
    assert item.waiting_reason == "Waiting for AMS drying to complete"
    assert library_file is not None
    assert archive.status == "failed"
    ctx.stop_drying.assert_not_called()
    ctx.start_print.assert_not_called()


@pytest.mark.parametrize(
    ("wait_for_drying_complete", "waiting_reason"),
    [
        (False, "Stopping AMS drying before dispatch"),
        (True, "Waiting for AMS drying to complete"),
    ],
)
@pytest.mark.asyncio
async def test_command_boundary_retains_reservation_if_drying_starts_after_final_check(
    queue_factory,
    wait_for_drying_complete,
    waiting_reason,
):
    """Never publish project_file when drying starts during reservation setup."""
    ctx = await queue_factory(
        cleanup=True,
        wait_for_drying_complete=wait_for_drying_complete,
    )
    clear = SimpleNamespace(raw_data={"ams": [{"id": 0, "dry_time": 0}]})
    drying = SimpleNamespace(raw_data={"ams": [{"id": 0, "dry_time": 120}]})

    with (
        patch("backend.app.main.register_expected_print") as register_expected,
        patch("backend.app.main.unregister_expected_print") as unregister_expected,
        patch(
            "backend.app.services.print_scheduler.printer_manager.clear_current_print_user"
        ) as clear_current_print_user,
    ):
        await _dispatch_library_item(
            ctx,
            # First read: clear at the post-upload check. Second read: drying
            # at the command boundary. Under the stop-first policy, a third
            # read lets _stop_drying confirm which AMS still needs the command.
            printer_statuses=[clear, drying, drying],
        )

    item, library_file, archive = await _queue_snapshot(ctx)
    assert item.status == "failed"
    assert item.dispatched_at is None
    assert item.dispatch_subtask_id is None
    assert item.waiting_reason == waiting_reason
    assert item.library_file_id == ctx.library_file_id
    assert item.archive_id == archive.id
    assert library_file is not None
    assert archive.status == "failed"
    assert ctx.source_path.exists()
    assert ctx.archive_path.exists()
    register_expected.assert_not_called()
    unregister_expected.assert_not_called()
    clear_current_print_user.assert_not_called()
    if wait_for_drying_complete:
        ctx.stop_drying.assert_not_called()
    else:
        ctx.stop_drying.assert_called_once_with(ctx.printer_id, 0, 0, 0, mode=0)
    ctx.start_print.assert_not_called()


@pytest.mark.asyncio
async def test_oserror_during_unlink_logs_orphan_path_and_does_not_crash_dispatch(queue_factory, caplog):
    ctx = await queue_factory(cleanup=True, thumbnail_path="relative")
    original_unlink = type(ctx.source_path).unlink

    def unlink_with_source_failure(path, *args, **kwargs):
        if Path(path) == ctx.source_path:
            raise OSError("permission denied")
        return original_unlink(path, *args, **kwargs)

    with caplog.at_level("WARNING", logger="backend.app.services.queue_source_cleanup"):
        await _dispatch_library_item(ctx)
        with patch.object(type(ctx.source_path), "unlink", unlink_with_source_failure):
            await _finish_and_clear(ctx)

    item, library_file, archive = await _queue_snapshot(ctx)
    assert item.status == "successful"
    assert item.archive_id == archive.id
    assert item.library_file_id is None
    assert library_file is None
    assert ctx.source_path.exists()
    assert not ctx.thumbnail_path.exists()
    assert ctx.archive_path.exists()
    assert "QUEUE_ONLY_SOURCE_ORPHAN" in caplog.text
    assert str(ctx.source_path) in caplog.text
    assert "permission denied" in caplog.text


@pytest.mark.asyncio
async def test_failed_upload_holds_printer_until_clear_even_with_confirmation_off(queue_factory):
    from backend.app.models.settings import Settings
    from backend.app.services.queue_transitions import clear_job_plate

    ctx = await queue_factory(cleanup=True)
    failed_id = ctx.queue_item_id
    async with ctx.session_maker() as db:
        db.add(Settings(key="require_plate_clear", value="false"))
        next_job = PrintQueueItem(printer_id=ctx.printer_id, library_file_id=ctx.library_file_id, status="queued")
        db.add(next_job)
        await db.commit()
        next_id = next_job.id
    ctx.upload.return_value = False
    await _dispatch_library_item(ctx)
    failed, library, _ = await _queue_snapshot(ctx)
    assert failed.status == "failed"
    assert library is not None and ctx.source_path.is_file()

    ctx.queue_item_id = next_id
    await _dispatch_library_item(ctx)
    waiting, _, _ = await _queue_snapshot(ctx)
    assert waiting.status == "queued"
    assert ctx.upload.await_count == 1
    ctx.start_print.assert_not_called()

    async with ctx.session_maker() as db:
        failed = await db.get(PrintQueueItem, failed_id)
        await clear_job_plate(db, failed)
        await db.commit()
    ctx.upload.return_value = True
    await _dispatch_library_item(ctx)
    dispatched, _, _ = await _queue_snapshot(ctx)
    assert dispatched.status == "dispatching"
    assert ctx.upload.await_count == 2
    ctx.start_print.assert_called_once()


@pytest.mark.parametrize("change", ["printer_id", "dispatching_at"])
@pytest.mark.asyncio
async def test_reservation_rejects_a_retargeted_job_or_replaced_claim_before_ftp(queue_factory, change):
    from datetime import datetime, timezone

    from backend.app.services.queue_transitions import QueueTransitionConflict

    ctx = await queue_factory(cleanup=True)

    async def change_before_reservation(db, item):
        value = None if change == "printer_id" else datetime.now(timezone.utc)
        # A second writer changes metadata while this worker holds a stale ORM snapshot.
        await db.execute(PrintQueueItem.__table__.update().where(PrintQueueItem.id == item.id).values({change: value}))
        await db.commit()

    with pytest.raises(QueueTransitionConflict):
        await _dispatch_library_item(ctx, before_reservation=change_before_reservation)
    item, library, _ = await _queue_snapshot(ctx)
    assert item.status == "queued" and library is not None
    if change == "printer_id":
        assert item.printer_id is None
    else:
        assert item.dispatching_at is not None
    ctx.upload.assert_not_awaited()
    ctx.start_print.assert_not_called()


async def _make_any_machine_job(ctx):
    """Turn the case's job into an "Any machine" job, as the Queue creates it."""
    async with ctx.session_maker() as db:
        item = await db.get(PrintQueueItem, ctx.queue_item_id)
        item.printer_id = None
        item.target_model = "X1C"
        item.ams_mapping = None
        await db.commit()


async def _row(ctx):
    async with ctx.session_maker() as db:
        return await db.get(PrintQueueItem, ctx.queue_item_id)


@pytest.mark.asyncio
async def test_any_machine_job_gets_its_printer_only_from_the_hold_transition(queue_factory):
    from backend.app.services.print_scheduler import _DispatchBinding

    ctx = await queue_factory(cleanup=False)
    await _make_any_machine_job(ctx)
    held_during_upload = []

    async def upload(*_args, **_kwargs):
        row = await _row(ctx)
        held_during_upload.append((row.status, row.printer_id, row.ams_mapping))
        return True

    ctx.upload.side_effect = upload
    assigned = AsyncMock()
    await _dispatch_library_item(
        ctx, binding=_DispatchBinding(ctx.printer_id, "[4]", unassigned=True), assigned_notification=assigned
    )

    # The printer and its tray mapping were written with the move out of the
    # queue, before the upload, and nowhere earlier.
    assert held_during_upload == [("dispatching", ctx.printer_id, "[4]")]
    row = await _row(ctx)
    assert (row.status, row.printer_id, row.target_model) == ("dispatching", ctx.printer_id, "X1C")
    assert row.dispatching_at is None
    assigned.assert_awaited_once()
    assert assigned.await_args.kwargs["printer_id"] == ctx.printer_id


@pytest.mark.parametrize("pool", [True, False], ids=["any-machine", "specific-machine"])
@pytest.mark.asyncio
async def test_disconnected_printer_leaves_the_job_queued_and_unheld(queue_factory, pool):
    from backend.app.services.print_scheduler import _DispatchBinding

    ctx = await queue_factory(cleanup=False)
    if pool:
        await _make_any_machine_job(ctx)
    binding = _DispatchBinding(ctx.printer_id, None, unassigned=True) if pool else None

    await _dispatch_library_item(ctx, binding=binding, connected=False)

    row = await _row(ctx)
    assert row.status == "queued"
    assert row.printer_id == (None if pool else ctx.printer_id), "a waiting job is never bound to a printer"
    assert row.waiting_reason == "Printer not connected"
    assert row.manual_start is False, "a transient printer problem retries on its own"
    ctx.upload.assert_not_awaited()
    async with ctx.session_maker() as db:
        # Nothing holds the printer, so the next compatible job can use it.
        held = await db.scalar(
            select(PrintQueueItem.id).where(
                PrintQueueItem.printer_id == ctx.printer_id, PrintQueueItem.status != "queued"
            )
        )
    assert held is None


@pytest.mark.parametrize("pool", [True, False], ids=["any-machine", "specific-machine"])
@pytest.mark.asyncio
async def test_missing_source_parks_the_job_in_the_queue(queue_factory, pool):
    from backend.app.services.print_scheduler import _DispatchBinding

    ctx = await queue_factory(cleanup=False)
    if pool:
        await _make_any_machine_job(ctx)
    ctx.source_path.unlink()

    await _dispatch_library_item(ctx, binding=_DispatchBinding(ctx.printer_id, None, unassigned=True) if pool else None)

    row = await _row(ctx)
    assert row.status == "queued"
    assert row.printer_id == (None if pool else ctx.printer_id)
    assert row.waiting_reason == "Source file not found on disk"
    # Parked for a manual start, so it neither fails onto a printer nor
    # blocks the jobs behind it by being retried every tick.
    assert row.manual_start is True
    ctx.upload.assert_not_awaited()


async def _selection_binding(ctx, printer_id, ams_mapping, *, unassigned):
    """The decision a selection pass hands its worker, from the row it read."""
    from backend.app.services.print_scheduler import _DispatchBinding

    async with ctx.session_maker() as db:
        item = await db.get(PrintQueueItem, ctx.queue_item_id)
        return _DispatchBinding.for_item(item, printer_id, ams_mapping, unassigned=unassigned)


@pytest.mark.parametrize(
    "edit",
    [
        {"target_model": "X1E"},
        {"ams_mapping": "[1]"},
        {"manual_start": True},
        {"scheduled_time": "future"},
    ],
    ids=["retargeted-model", "tray-mapping", "manual-start", "postponed"],
)
@pytest.mark.asyncio
async def test_edit_accepted_after_selection_is_not_dispatched_with_the_stale_decision(queue_factory, edit):
    from datetime import datetime, timedelta

    ctx = await queue_factory(cleanup=False)
    await _make_any_machine_job(ctx)
    # Selection chose this X1C printer and computed a tray mapping for it.
    binding = await _selection_binding(ctx, ctx.printer_id, "[4]", unassigned=True)
    async with ctx.session_maker() as db:
        item = await db.get(PrintQueueItem, ctx.queue_item_id)
        for name, value in edit.items():
            setattr(item, name, datetime.now() + timedelta(days=1) if value == "future" else value)
        await db.commit()

    await _dispatch_library_item(ctx, binding=binding)

    row = await _row(ctx)
    assert (row.status, row.printer_id, row.dispatching_at) == ("queued", None, None)
    for name, value in edit.items():
        if value != "future":
            assert getattr(row, name) == value, "the accepted edit is kept"
    ctx.upload.assert_not_awaited()


@pytest.mark.asyncio
async def test_specific_machine_edit_after_selection_is_honoured(queue_factory):
    ctx = await queue_factory(cleanup=False)
    binding = await _selection_binding(ctx, ctx.printer_id, "[4]", unassigned=False)
    async with ctx.session_maker() as db:
        item = await db.get(PrintQueueItem, ctx.queue_item_id)
        item.ams_mapping = "[1]"
        await db.commit()

    await _dispatch_library_item(ctx, binding=binding)

    row = await _row(ctx)
    assert (row.status, row.printer_id, row.ams_mapping) == ("queued", ctx.printer_id, "[1]")
    ctx.upload.assert_not_awaited()


@pytest.mark.asyncio
async def test_unedited_job_with_a_start_time_is_dispatched_with_its_decision(queue_factory):
    from datetime import datetime, timedelta

    ctx = await queue_factory(cleanup=False)
    await _make_any_machine_job(ctx)
    async with ctx.session_maker() as db:
        item = await db.get(PrintQueueItem, ctx.queue_item_id)
        item.scheduled_time = datetime.now() - timedelta(minutes=5)  # Due; compared after a reload.
        await db.commit()
    binding = await _selection_binding(ctx, ctx.printer_id, "[4]", unassigned=True)

    await _dispatch_library_item(ctx, binding=binding)

    row = await _row(ctx)
    assert (row.status, row.printer_id, row.ams_mapping) == ("dispatching", ctx.printer_id, "[4]")
    ctx.upload.assert_awaited_once()


async def test_printer_becoming_busy_during_archive_copy_is_rechecked_before_hold_and_ftp(queue_factory):
    from backend.app.services.queue_transitions import QueueTransitionConflict

    ctx = await queue_factory(cleanup=False)
    state = SimpleNamespace(state="IDLE", connected=True, raw_data={})

    async def external_start():
        # Fresh telemetry can precede the external-job callback's database hold.
        state.state = "RUNNING"

    with pytest.raises(QueueTransitionConflict):
        await _dispatch_library_item(ctx, printer_status=state, during_archive=external_start)
    job, _, attempt = await _queue_snapshot(ctx)
    assert job.status == "queued" and attempt is None
    assert not ctx.archive_path.exists()
    ctx.upload.assert_not_awaited()
    ctx.start_print.assert_not_called()

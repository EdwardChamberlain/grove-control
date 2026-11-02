"""on_print_complete: finishing a print's archive, queue item and side effects.

Runs the real callback against the test database. Background work (energy,
finish photo, notifications, maintenance, timelapse) is awaited with
``lifecycle.drain()`` before asserting.
"""

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from backend.app import main
from backend.app.models.archive import PrintArchive
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.print_queue import PrintQueueItem

from .conftest import make_3mf

pytestmark = pytest.mark.integration

# HMS short code 0300_8016 maps to "Clogged nozzle".
CLOGGED_NOZZLE_HMS = {"attr": 0x0300 << 16, "code": 0x8016}


def _done(status="completed", subtask="Benchy", filename="/data/Metadata/plate_1.gcode", **extra):
    data = {"status": status, "filename": filename, "subtask_name": subtask}
    data.update(extra)
    return data


async def _start(lifecycle, printer, **extra):
    """Run a real print start so completion finds the archive in memory."""
    lifecycle.storage.files["/Benchy.gcode.3mf"] = make_3mf()
    await main.on_print_start(
        printer.id, {"filename": "/data/Metadata/plate_1.gcode", "subtask_name": "Benchy", **extra}
    )
    await lifecycle.drain()
    [archive] = await lifecycle.all(PrintArchive)
    lifecycle.ws.reset_mock()
    lifecycle.notifications.reset_mock()
    lifecycle.notifications._get_providers_for_event.return_value = []
    return archive


class TestCompletingAnArchivedPrint:
    async def test_start_then_complete_finalises_archive_and_logs_run(self, lifecycle):
        printer = await lifecycle.make_printer()
        archive = await _start(lifecycle, printer)

        await main.on_print_complete(printer.id, _done())
        await lifecycle.drain()

        done = await lifecycle.get(PrintArchive, archive.id)
        assert done.status == "completed"
        assert done.completed_at is not None
        assert done.failure_reason is None
        [run] = await lifecycle.all(PrintLogEntry)
        assert run.archive_id == archive.id
        assert run.status == "completed"
        assert run.printer_name == "Lifecycle Printer"
        assert main._active_prints == {}

        lifecycle.ws.send_archive_updated.assert_awaited_once_with({"id": archive.id, "status": "completed"})
        lifecycle.relay.on_archive_updated.assert_awaited_once()
        lifecycle.printer_manager.set_awaiting_plate_clear.assert_called_once_with(printer.id, True)
        lifecycle.printer_manager.set_awaiting_plate_clear_archive_id.assert_called_with(printer.id, archive.id)
        lifecycle.plugs.on_print_complete.assert_awaited_once()

        args = lifecycle.notifications.on_print_complete.await_args
        assert args.args[2] == "completed"
        archive_data = args.kwargs["archive_data"]
        assert archive_data["print_time_seconds"] == 3600
        assert archive_data["actual_time_seconds"] is not None

    async def test_failed_print_records_hms_failure_reason_and_scales_filament(self, lifecycle):
        printer = await lifecycle.make_printer()
        archive = await _start(lifecycle, printer)
        async with lifecycle.session() as db:
            row = await db.get(PrintArchive, archive.id)
            row.filament_used_grams = 50.0
            await db.commit()

        await main.on_print_complete(printer.id, _done("failed", hms_errors=[CLOGGED_NOZZLE_HMS], progress=40))
        await lifecycle.drain()

        failed = await lifecycle.get(PrintArchive, archive.id)
        assert failed.status == "failed"
        assert failed.failure_reason == "Clogged nozzle"
        archive_data = lifecycle.notifications.on_print_complete.await_args.kwargs["archive_data"]
        assert archive_data["progress"] == 40
        assert archive_data["actual_filament_grams"] == 20.0

    async def test_stop_from_queue_ui_is_reported_as_cancelled(self, lifecycle):
        printer = await lifecycle.make_printer()
        archive = await _start(lifecycle, printer)
        main._user_stopped_printers.add(printer.id)

        await main.on_print_complete(printer.id, _done("failed"))
        await lifecycle.drain()

        cancelled = await lifecycle.get(PrintArchive, archive.id)
        assert cancelled.status == "cancelled"
        assert cancelled.failure_reason == "User cancelled"
        assert printer.id not in main._user_stopped_printers

    async def test_finds_printing_archive_in_database_after_restart(self, lifecycle):
        printer = await lifecycle.make_printer()
        # Nothing in memory: the backend restarted mid-print.
        archive = await lifecycle.make_archive(printer.id, print_name="Benchy")

        await main.on_print_complete(printer.id, _done())
        await lifecycle.drain()

        assert (await lifecycle.get(PrintArchive, archive.id)).status == "completed"

    async def test_finds_archive_by_exact_filename_when_name_differs(self, lifecycle):
        printer = await lifecycle.make_printer()
        archive = await lifecycle.make_archive(
            printer.id, print_name="Something else", filename="/data/Metadata/plate_1.gcode"
        )

        await main.on_print_complete(printer.id, _done(subtask=""))
        await lifecycle.drain()

        assert (await lifecycle.get(PrintArchive, archive.id)).status == "completed"


class TestCompletionGuards:
    async def test_reconciled_completion_is_ignored_while_printing(self, lifecycle):
        printer = await lifecycle.make_printer()
        archive = await lifecycle.make_archive(printer.id)
        lifecycle.printer_manager.get_status.return_value = SimpleNamespace(connected=True, state="RUNNING")

        result = await main.on_print_complete(printer.id, _done(_reconciled=True))

        assert result is False
        assert (await lifecycle.get(PrintArchive, archive.id)).status == "printing"
        lifecycle.ws.send_print_complete.assert_not_awaited()

    async def test_completion_without_any_name_only_clears_plate_gate(self, lifecycle):
        printer = await lifecycle.make_printer()

        await main.on_print_complete(printer.id, {"status": "completed", "filename": "", "subtask_name": ""})

        lifecycle.printer_manager.set_awaiting_plate_clear.assert_called_once_with(printer.id, True)
        lifecycle.printer_manager.set_awaiting_plate_clear_archive_id.assert_called_once_with(printer.id, None)
        assert await lifecycle.all(PrintLogEntry) == []


class TestSdCardCleanup:
    """Files Grove Control uploaded are removed so the printer can't
    auto-start them again after a power cycle (#374, #1542)."""

    async def test_deletes_uploaded_file_from_sd_root(self, lifecycle):
        printer = await lifecycle.make_printer()
        await lifecycle.make_archive(printer.id, filename="Benchy.gcode.3mf")
        lifecycle.storage.files["/Benchy.3mf"] = b"uploaded"

        await main.on_print_complete(printer.id, _done())
        await lifecycle.drain()

        assert lifecycle.storage.deleted == ["/Benchy.3mf"]

    async def test_transient_delete_errors_are_retried_three_times(self, lifecycle):
        printer = await lifecycle.make_printer()
        delete = AsyncMock(side_effect=OSError("connection reset"))

        with (
            patch("backend.app.services.bambu_ftp.delete_file_async", delete),
            patch("backend.app.main.asyncio.sleep", AsyncMock()),
        ):
            await main.on_print_complete(printer.id, _done())
            await lifecycle.drain()

        # Two candidates (/Benchy.3mf, /Benchy.gcode), three attempts each.
        assert delete.await_count == 6


class TestQueueItemCompletion:
    async def _queue_item(self, lifecycle, printer, **kwargs):
        defaults = {"printer_id": printer.id, "status": "printing", "position": 1}
        defaults.update(kwargs)
        return await lifecycle.add(PrintQueueItem(**defaults))

    async def test_marks_item_done_and_reports_empty_queue(self, lifecycle):
        printer = await lifecycle.make_printer()
        item = await self._queue_item(lifecycle, printer, auto_off_after=True)

        await main.on_print_complete(printer.id, _done())
        await lifecycle.drain()

        done = await lifecycle.get(PrintQueueItem, item.id)
        assert done.status == "completed"
        assert done.completed_at is not None
        lifecycle.ws.send_queue_work_changed.assert_awaited_once()
        assert lifecycle.relay.on_queue_job_completed.await_args.kwargs["job_id"] == item.id
        assert lifecycle.notifications.on_queue_completed.await_args.kwargs["completed_count"] == 1
        lifecycle.plugs.schedule_off_after_queue_job.assert_awaited_once()

    async def test_does_not_report_empty_queue_while_items_are_pending(self, lifecycle):
        printer = await lifecycle.make_printer()
        await self._queue_item(lifecycle, printer)
        await self._queue_item(lifecycle, printer, status="pending", position=2)

        await main.on_print_complete(printer.id, _done())
        await lifecycle.drain()

        lifecycle.notifications.on_queue_completed.assert_not_awaited()
        lifecycle.plugs.schedule_off_after_queue_job.assert_not_awaited()

    async def test_failed_item_gets_hms_error_message(self, lifecycle):
        printer = await lifecycle.make_printer()
        item = await self._queue_item(lifecycle, printer)

        await main.on_print_complete(printer.id, _done("failed", hms_errors=[{**CLOGGED_NOZZLE_HMS, "code": "0x8016"}]))
        await lifecycle.drain()

        failed = await lifecycle.get(PrintQueueItem, item.id)
        assert failed.status == "failed"
        assert "0300_8016" in failed.error_message

    async def test_aborted_is_stored_as_cancelled(self, lifecycle):
        printer = await lifecycle.make_printer()
        item = await self._queue_item(lifecycle, printer)

        await main.on_print_complete(printer.id, _done("aborted"))
        await lifecycle.drain()

        assert (await lifecycle.get(PrintQueueItem, item.id)).status == "cancelled"


class TestBedCooldownWaiter:
    async def test_registers_waiter_when_a_provider_wants_bed_cooled(self, lifecycle):
        printer = await lifecycle.make_printer()
        await lifecycle.set_setting("bed_cooled_threshold", "40")
        lifecycle.notifications._get_providers_for_event.return_value = [object()]

        await main.on_print_complete(printer.id, _done())
        await lifecycle.drain()

        waiter = main._bed_cool_waiters[printer.id]
        assert waiter["threshold"] == 40.0
        assert waiter["filename"] == "/data/Metadata/plate_1.gcode"

    async def test_no_waiter_without_providers(self, lifecycle):
        printer = await lifecycle.make_printer()

        await main.on_print_complete(printer.id, _done())
        await lifecycle.drain()

        assert printer.id not in main._bed_cool_waiters


class TestNotificationWithoutArchive:
    async def test_notifies_with_queue_owner_and_mqtt_time(self, lifecycle):
        printer = await lifecycle.make_printer(auto_archive=False)
        item = await lifecycle.add(
            PrintQueueItem(printer_id=printer.id, status="printing", position=1, created_by_id=None)
        )

        await main.on_print_complete(printer.id, _done(remaining_time=900))
        await lifecycle.drain()

        assert (await lifecycle.get(PrintQueueItem, item.id)).status == "completed"
        args = lifecycle.notifications.on_print_complete.await_args
        assert args.args[1] == "Lifecycle Printer"
        assert args.kwargs["archive_data"]["print_time_seconds"] == 900

    async def test_unknown_printer_still_notified(self, lifecycle):
        await main.on_print_complete(4242, _done())
        await lifecycle.drain()

        args = lifecycle.notifications.on_print_complete.await_args
        assert args.args[1] == "Printer 4242"
        assert args.kwargs["archive_data"] is None

    async def test_uses_library_file_print_time(self, lifecycle):
        from backend.app.models.library import LibraryFile

        printer = await lifecycle.make_printer(auto_archive=False)
        lib = await lifecycle.add(
            LibraryFile(
                filename="Benchy.3mf",
                file_path="library/Benchy.3mf",
                file_type="3mf",
                file_size=10,
                file_metadata={"print_time_seconds": 4321},
            )
        )
        await lifecycle.add(
            PrintQueueItem(printer_id=printer.id, status="printing", position=1, library_file_id=lib.id)
        )

        await main.on_print_complete(printer.id, _done())
        await lifecycle.drain()

        archive_data = lifecycle.notifications.on_print_complete.await_args.kwargs["archive_data"]
        assert archive_data["print_time_seconds"] == 4321


class TestEnergyCalculation:
    async def _setup(self, lifecycle, start_kwh):
        from backend.app.models.smart_plug import SmartPlug

        printer = await lifecycle.make_printer()
        await lifecycle.add(SmartPlug(name="Plug", plug_type="tasmota", ip_address="10.0.0.5", printer_id=printer.id))
        with patch("backend.app.main._get_plug_energy", AsyncMock(return_value=None)):
            archive = await _start(lifecycle, printer)
        async with lifecycle.session() as db:
            row = await db.get(PrintArchive, archive.id)
            row.energy_start_kwh = start_kwh
            await db.commit()
        return printer, archive

    async def test_saves_energy_and_cost_on_archive_and_run(self, lifecycle):
        printer, archive = await self._setup(lifecycle, start_kwh=100.0)
        await lifecycle.set_setting("energy_cost_per_kwh", "0.20")

        with patch("backend.app.main._get_plug_energy", AsyncMock(return_value={"total": 101.5})):
            await main.on_print_complete(printer.id, _done())
            await lifecycle.drain()

        done = await lifecycle.get(PrintArchive, archive.id)
        assert done.energy_kwh == 1.5
        assert done.energy_cost == 0.3
        [run] = await lifecycle.all(PrintLogEntry)
        assert run.energy_kwh == 1.5
        assert run.energy_cost == 0.3

    async def test_counter_reset_leaves_energy_empty(self, lifecycle):
        printer, archive = await self._setup(lifecycle, start_kwh=100.0)

        with patch("backend.app.main._get_plug_energy", AsyncMock(return_value={"total": 3.0})):
            await main.on_print_complete(printer.id, _done())
            await lifecycle.drain()

        assert (await lifecycle.get(PrintArchive, archive.id)).energy_kwh is None


class TestFinishPhoto:
    async def test_saves_pre_captured_frame_and_links_it_in_notification(self, lifecycle):
        printer = await lifecycle.make_printer()
        archive = await _start(lifecycle, printer)
        await lifecycle.set_setting("external_url", "https://grove.example/")
        main._stage22_finish_frames[printer.id] = b"\xff\xd8jpeg"

        await main.on_print_complete(printer.id, _done())
        await lifecycle.drain()

        done = await lifecycle.get(PrintArchive, archive.id)
        [photo] = done.photos
        photo_path = lifecycle.base_dir / done.file_path
        assert (photo_path.parent / "photos" / photo).read_bytes() == b"\xff\xd8jpeg"
        archive_data = lifecycle.notifications.on_print_complete.await_args.kwargs["archive_data"]
        assert archive_data["finish_photo_url"] == f"https://grove.example/api/v1/archives/{archive.id}/photos/{photo}"
        assert archive_data["image_data"] == b"\xff\xd8jpeg"

    async def test_falls_back_to_fresh_camera_capture(self, lifecycle):
        printer = await lifecycle.make_printer()
        archive = await _start(lifecycle, printer)
        capture = AsyncMock(return_value="finish_fresh.jpg")

        with patch("backend.app.services.camera.capture_finish_photo", capture):
            await main.on_print_complete(printer.id, _done())
            await lifecycle.drain()

        assert (await lifecycle.get(PrintArchive, archive.id)).photos == ["finish_fresh.jpg"]
        assert capture.await_args.kwargs["printer_id"] == printer.id
        # Relative URL when no external URL is configured.
        archive_data = lifecycle.notifications.on_print_complete.await_args.kwargs["archive_data"]
        assert archive_data["finish_photo_url"] == f"/api/v1/archives/{archive.id}/photos/finish_fresh.jpg"

    async def test_capture_disabled_in_settings(self, lifecycle):
        printer = await lifecycle.make_printer()
        archive = await _start(lifecycle, printer)
        await lifecycle.set_setting("capture_finish_photo", "false")
        main._stage22_finish_frames[printer.id] = b"jpeg"

        await main.on_print_complete(printer.id, _done())
        await lifecycle.drain()

        assert not (await lifecycle.get(PrintArchive, archive.id)).photos


class TestTimelapse:
    async def test_layer_timelapse_is_attached_to_archive(self, lifecycle, tmp_path):
        printer = await lifecycle.make_printer()
        archive = await _start(lifecycle, printer)
        video = tmp_path / "stitched.mp4"
        video.write_bytes(b"mp4-bytes")

        with patch("backend.app.services.layer_timelapse.on_print_complete", AsyncMock(return_value=video)):
            await main.on_print_complete(printer.id, _done())
            await lifecycle.drain()

        done = await lifecycle.get(PrintArchive, archive.id)
        assert done.timelapse_path
        assert (lifecycle.base_dir / done.timelapse_path).read_bytes() == b"mp4-bytes"
        assert not video.exists()

    async def test_failed_print_cancels_layer_timelapse(self, lifecycle):
        printer = await lifecycle.make_printer()
        await _start(lifecycle, printer)

        with patch("backend.app.services.layer_timelapse.cancel_session") as cancel:
            await main.on_print_complete(printer.id, _done("failed"))
            await lifecycle.drain()

        cancel.assert_called_once_with(printer.id)

    async def test_printer_timelapse_scan_scheduled_with_start_baseline(self, lifecycle):
        printer = await lifecycle.make_printer()
        archive = await _start(lifecycle, printer)
        main._timelapse_baselines[printer.id] = {"old.mp4"}
        timelapse_photo = AsyncMock(return_value="finish_from_timelapse.jpg")

        with patch("backend.app.main._capture_finish_photo_from_timelapse", timelapse_photo):
            await main.on_print_complete(printer.id, _done(timelapse_was_active=True))
            await lifecycle.drain()

        # The finish photo comes from the timelapse's last frame (#1397).
        assert (await lifecycle.get(PrintArchive, archive.id)).photos == ["finish_from_timelapse.jpg"]

        main._scan_for_timelapse_with_retries.assert_awaited_once_with(archive.id, {"old.mp4"})
        assert printer.id not in main._timelapse_baselines


class TestMaintenanceCheck:
    async def test_due_maintenance_is_notified_after_completed_print(self, lifecycle):
        printer = await lifecycle.make_printer()
        await _start(lifecycle, printer)
        overview = SimpleNamespace(
            maintenance_items=[
                SimpleNamespace(maintenance_type_name="Lubricate rods", enabled=True, is_due=True, is_warning=False),
                SimpleNamespace(maintenance_type_name="Clean nozzle", enabled=True, is_due=False, is_warning=False),
            ]
        )

        with patch("backend.app.main._get_printer_maintenance_internal", AsyncMock(return_value=overview)):
            await main.on_print_complete(printer.id, _done())
            await lifecycle.drain()

        items = lifecycle.notifications.on_maintenance_due.await_args.args[2]
        assert items == [{"name": "Lubricate rods", "is_due": True, "is_warning": False}]
        assert lifecycle.relay.on_maintenance_alert.await_args.kwargs["maintenance_type"] == "Lubricate rods"


async def test_usage_results_are_broadcast(lifecycle):
    printer = await lifecycle.make_printer()
    usage = [{"spool_id": 1, "weight_used": 12.0, "cost": 0.5}]

    with patch("backend.app.services.usage_tracker.on_print_complete", AsyncMock(return_value=usage)):
        await main.on_print_complete(printer.id, _done())
        await lifecycle.drain()

    broadcast = [c.args[0] for c in lifecycle.ws.broadcast.await_args_list if c.args[0]["type"] == "spool_usage_logged"]
    assert broadcast == [{"type": "spool_usage_logged", "printer_id": printer.id, "usage": usage}]
    # Without an archive the tracked usage still reaches the notification.
    archive_data = lifecycle.notifications.on_print_complete.await_args.kwargs["archive_data"]
    assert archive_data["actual_filament_grams"] == 12.0


async def test_drain_fails_when_a_background_task_raises(lifecycle):
    async def fail():
        raise RuntimeError("fixture should surface this task failure")

    main.spawn_background_task(fail(), name="fixture-task-failure")

    with pytest.raises(AssertionError, match="fixture should surface this task failure"):
        await lifecycle.drain()


async def test_cleanup_cancels_background_tasks_left_by_test(lifecycle):
    started = asyncio.Event()

    async def wait_forever():
        started.set()
        await asyncio.Event().wait()

    task = main.spawn_background_task(wait_forever(), name="fixture-leftover-task")
    await started.wait()
    await lifecycle.cleanup_background_tasks()

    assert task.cancelled()


async def test_cutoff_is_five_minutes_for_recent_queue_owner(lifecycle):
    """An item completed long ago doesn't lend its owner to this notification."""
    printer = await lifecycle.make_printer(auto_archive=False)
    await lifecycle.add(
        PrintQueueItem(
            printer_id=printer.id,
            status="completed",
            position=1,
            completed_at=datetime.now(timezone.utc) - timedelta(hours=2),
        )
    )

    await main.on_print_complete(printer.id, _done())
    await lifecycle.drain()

    assert lifecycle.notifications.on_print_complete.await_args.kwargs["archive_data"] is None


async def test_usage_tracking_runs_for_archived_print(lifecycle, caplog):
    printer = await lifecycle.make_printer()
    await _start(lifecycle, printer)

    await main.on_print_complete(printer.id, _done())
    await lifecycle.drain()

    assert "Usage tracker on_print_complete failed" not in caplog.text

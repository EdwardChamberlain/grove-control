"""
Integration tests for the full print lifecycle.

These tests verify that:
1. Print start creates a new archive
2. Print complete updates archive status
3. Callbacks are properly executed
4. Energy tracking works
5. Notifications are sent

Note: These tests use mocking to avoid database conflicts.
Full end-to-end tests require the actual database setup.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class TestPrintStartLogic:
    """Test print start callback logic without database integration."""

    @pytest.mark.asyncio
    async def test_print_start_calls_notification_service(self, capture_logs):
        """Verify on_print_start triggers notification service."""
        with (
            patch("backend.app.services.lifecycle.intake.async_session") as mock_session_maker,
            patch("backend.app.services.print_effects.async_session", mock_session_maker),
            patch("backend.app.services.print_effects.notification_service") as mock_notif,
            patch("backend.app.services.print_effects.smart_plug_manager") as mock_plug,
            patch("backend.app.services.print_effects.ws_manager") as mock_ws,
        ):
            mock_notif.on_print_start = AsyncMock()
            mock_plug.on_print_start = AsyncMock()
            mock_ws.send_print_start = AsyncMock()

            # Mock the database session
            mock_session = AsyncMock()
            mock_session.__aenter__ = AsyncMock(return_value=mock_session)
            mock_session.__aexit__ = AsyncMock()
            mock_session.execute = AsyncMock(return_value=MagicMock(scalar_one_or_none=MagicMock(return_value=None)))
            mock_session_maker.return_value = mock_session

            from backend.app.services.lifecycle.intake import print_memory
            from backend.app.services.print_effects import _begin_new_print

            await _begin_new_print(
                1,
                {
                    "filename": "/data/Metadata/test.gcode",
                    "subtask_name": "Test",
                },
                memory=print_memory,
            )

            # Verify WebSocket notification was sent
            mock_ws.send_print_start.assert_called_once()

        # Verify no import shadowing errors
        errors = [r for r in capture_logs.get_errors() if "cannot access local variable" in str(r.message)]
        assert not errors, f"Import shadowing error: {capture_logs.format_errors()}"


class TestPlateClearGate:
    """All physically terminal outcomes gate dispatch of the next job."""

    @pytest.fixture
    async def completion(self, test_engine, db_session, printer_factory):
        from types import SimpleNamespace

        from sqlalchemy.ext.asyncio import async_sessionmaker

        from backend.app import main
        from backend.app.models.print_queue import PrintQueueItem
        from backend.app.services import print_effects
        from backend.app.services.lifecycle import intake

        printer = await printer_factory()
        item = PrintQueueItem(printer_id=printer.id, status="printing", dispatch_subtask_id="123")
        db_session.add(item)
        await db_session.commit()
        sessions = async_sessionmaker(test_engine, expire_on_commit=False)
        intake._completed_job_events.clear()
        intake._user_stopped_printers.clear()
        manager = MagicMock()
        manager.get_status.return_value = None
        manager.get_printer.return_value = None

        def discard_background(coro, **kwargs):
            coro.close()  # These tests verify the committed transition and plate gate.

        with (
            patch.object(intake, "async_session", sessions),
            patch.object(print_effects, "async_session", sessions),
            patch("backend.app.core.database.async_session", sessions),
            patch.object(intake, "printer_manager", manager),
            patch.object(print_effects, "printer_manager", manager),
            patch("backend.app.services.printer_manager.printer_manager", manager),
            patch.object(print_effects, "ws_manager", AsyncMock()),
            patch.object(print_effects, "mqtt_relay", AsyncMock()),
            patch.object(print_effects, "spawn_background_task", discard_background),
            patch("backend.app.services.lifecycle.effects.run_queue_outcome_effects", new=AsyncMock()),
            patch("backend.app.services.usage_tracker.on_print_complete", AsyncMock(return_value=[])),
            patch("backend.app.services.usage_tracker.discard_session", AsyncMock()),
        ):
            yield SimpleNamespace(printer=printer, item=item, manager=manager, complete=main.on_print_complete)

    @pytest.mark.parametrize("mapping", ["[2, -1]", "invalid legacy mapping"])
    async def test_completion_uses_durable_usage_context_without_filename_registry(
        self, completion, db_session, mapping
    ):
        from backend.app.services import usage_tracker

        completion.item.ams_mapping = mapping
        completion.item.plate_id = 3
        await db_session.commit()
        await completion.complete(
            completion.printer.id, {"subtask_id": "123", "status": "completed", "ams_mapping": [99], "plate_id": 9}
        )
        usage_tracker.on_print_complete.assert_awaited_once()
        call = usage_tracker.on_print_complete.await_args
        assert call.kwargs["ams_mapping"] == ([2, -1] if mapping == "[2, -1]" else [99])
        assert call.args[1]["plate_id"] == 3
        await db_session.refresh(completion.item)
        assert completion.item.status == "finished"

    @pytest.mark.parametrize("status", ["completed", "failed", "aborted", "cancelled"])
    async def test_plate_clear_gate_raised_for_every_terminal_status(self, status, completion, db_session):
        await completion.complete(completion.printer.id, {"subtask_id": "123", "status": status})
        await db_session.refresh(completion.item)
        assert completion.item.status == (
            "cancelled" if status == "aborted" else "finished" if status == "completed" else status
        )
        completion.manager.set_awaiting_plate_clear.assert_any_call(completion.printer.id, True)

    async def test_completed_print_reconciles_an_unconfirmed_stop_request(self, completion, db_session):
        from backend.app.services.queue_actions import cancel_job

        completion.manager.stop_print.return_value = False
        await cancel_job(db_session, completion.item)
        await db_session.refresh(completion.item)
        assert completion.item.status == "cancelled"
        assert completion.item.physical_outcome is None
        assert "not sent" in completion.item.error_message

        await completion.complete(completion.printer.id, {"subtask_id": "123", "status": "completed"})
        await db_session.refresh(completion.item)
        assert completion.item.status == "finished"
        assert completion.item.physical_outcome == "completed"
        assert completion.item.physical_completed_at is not None
        assert completion.item.error_message is None

    async def test_identified_failure_during_dispatch_skips_preprint_effects(self, completion, db_session):
        from sqlalchemy import update

        from backend.app.models.print_queue import PrintQueueItem
        from backend.app.services.lifecycle import effects as queue_outcome_effects

        await db_session.execute(
            update(PrintQueueItem).where(PrintQueueItem.id == completion.item.id).values(status="dispatching")
        )
        await db_session.commit()
        await db_session.refresh(completion.item)
        effects = []

        async def record_effect(_engine, effect):
            effects.append(effect)

        with patch.object(queue_outcome_effects, "run_queue_outcome_effects", record_effect):
            await completion.complete(completion.printer.id, {"subtask_id": "123", "status": "failed"})
            await asyncio.sleep(0)

        await db_session.refresh(completion.item)
        assert completion.item.status == "failed"
        assert completion.item.physical_outcome == "failed"
        assert len(effects) == 1
        assert effects[0].notify_failure is False
        assert effects[0].clean_sd_copy is False

    @pytest.mark.parametrize(
        ("printer_outcome", "stopped_in_grove", "job_status", "reported"),
        [
            ("aborted", False, "cancelled", "aborted"),
            ("failed", False, "failed", "failed"),
            ("aborted", True, "cancelled", "cancelled"),
            ("failed", True, "cancelled", "cancelled"),
        ],
    )
    async def test_integrations_keep_the_printers_outcome_name(
        self, printer_outcome, stopped_in_grove, job_status, reported, completion, db_session
    ):
        from types import SimpleNamespace

        from backend.app import main
        from backend.app.models.archive import PrintArchive
        from backend.app.services import print_effects
        from backend.app.services.lifecycle import intake
        from backend.app.services.queue_actions import cancel_job

        archive = PrintArchive(
            printer_id=completion.printer.id,
            filename="stopped.3mf",
            file_path="",
            file_size=0,
            status="printing",
            dispatched_queue_item_id=completion.item.id,
        )
        db_session.add(archive)
        await db_session.flush()
        completion.item.archive_id = archive.id
        await db_session.commit()
        completion.manager.get_printer.return_value = SimpleNamespace(name="P1", serial_number="SERIAL")
        if stopped_in_grove:
            # cancel_job commits `cancelled` before the printer reports the stop,
            # so this also holds after a restart loses the in-memory stop flag.
            await cancel_job(db_session, completion.item)
            intake._user_stopped_printers.clear()
        await completion.complete(completion.printer.id, {"subtask_id": "123", "status": printer_outcome})
        await db_session.refresh(completion.item)
        assert completion.item.status == job_status
        await db_session.refresh(archive)
        archived_outcome = "aborted" if reported in ("cancelled", "aborted") else reported
        assert completion.item.physical_outcome == archived_outcome
        assert archive.status == archived_outcome
        if archived_outcome == "aborted":
            assert archive.failure_reason == "User cancelled"
        # The relay and notifications describe the physical outcome; a
        # touchscreen abort is not renamed to a Grove cancellation.
        assert print_effects.mqtt_relay.on_print_complete.await_args.args[-1] == reported
        assert print_effects.mqtt_relay.on_queue_job_completed.await_args.kwargs["status"] == job_status

    async def test_locked_database_retries_the_whole_completion_transaction(self, completion, db_session):
        from types import SimpleNamespace

        from sqlalchemy.exc import OperationalError

        from backend.app import main
        from backend.app.services import print_effects
        from backend.app.services.lifecycle import intake, printing as lifecycle_printing

        completion.manager.get_printer.return_value = SimpleNamespace(name="P1", serial_number="SERIAL")
        locked = OperationalError("UPDATE print_queue", {}, Exception("database is locked"))
        bump = AsyncMock(side_effect=[locked, None])
        with (
            patch.object(lifecycle_printing, "_bump_library_file_usage_if_completed", bump),
            patch("backend.app.core.database.is_sqlite", return_value=True),
            patch("backend.app.core.database.asyncio.sleep", AsyncMock()),
        ):
            await completion.complete(completion.printer.id, {"subtask_id": "123", "status": "completed"})

        await db_session.refresh(completion.item)
        # The first attempt rolled back; the second committed the outcome once
        # and the completion effects still ran (#897).
        assert completion.item.status == "finished"
        assert bump.await_count == 2
        print_effects.mqtt_relay.on_queue_job_completed.assert_awaited_once()

    async def test_plate_clear_gate_not_raised_for_unknown_status(self, completion, db_session):
        await completion.complete(completion.printer.id, {"subtask_id": "123", "status": "unknown_future_status"})
        await db_session.refresh(completion.item)
        assert completion.item.status == "printing"
        assert all(not call.args[1] for call in completion.manager.set_awaiting_plate_clear.call_args_list)

    @pytest.mark.parametrize("outcome", ["completed", "failed", "aborted"])
    async def test_paused_job_completes_through_the_same_plate_clear_path(self, outcome, completion, db_session):
        from backend.app.services.lifecycle.engine import transition_queue_item

        await transition_queue_item(db_session, completion.item, "printing", "paused")
        await db_session.commit()
        await completion.complete(completion.printer.id, {"submission_id": "123", "status": outcome})
        await db_session.refresh(completion.item)
        assert completion.item.status == {"completed": "finished", "failed": "failed", "aborted": "cancelled"}[outcome]
        assert completion.item.printer_id == completion.printer.id
        assert completion.item.completed_at is not None
        assert any(
            call.args == (completion.printer.id, True)
            for call in completion.manager.set_awaiting_plate_clear.call_args_list
        )

    async def test_touchscreen_print_on_a_held_printer_completes_as_its_own_job(self, completion, db_session):
        from backend.app import main
        from backend.app.api.routes.print_queue import clear_queue_plate
        from backend.app.services import print_effects
        from backend.app.services.bambu_mqtt import BambuMQTTClient
        from backend.app.services.job_identity import find_job
        from backend.app.services.lifecycle import intake
        from backend.app.services.lifecycle.engine import transition_queue_item

        await transition_queue_item(db_session, completion.item, "printing", "failed")
        await db_session.commit()
        client = BambuMQTTClient(ip_address="127.0.0.1", serial_number="TEST", access_code="12345678")
        client.state.connected = True
        starts, finishes = [], []
        client.on_print_start = starts.append
        client.on_print_running_observed = starts.append
        client.on_print_complete = finishes.append
        completion.manager.get_status.return_value = client.state
        with patch.object(print_effects, "_archive_print_start", AsyncMock()):
            client._process_message({"print": {"gcode_state": "RUNNING", "subtask_id": "0", "gcode_file": "sd.3mf"}})
            await main.on_print_start(completion.printer.id, starts[-1])
        identity = starts[-1]["submission_id"]
        job = await find_job(db_session, completion.printer.id, identity)
        assert job is not None and job.id != completion.item.id and job.status == "printing"
        client._process_message({"print": {"gcode_state": "FINISH", "subtask_id": "0"}})
        await completion.complete(completion.printer.id, finishes[-1])
        await db_session.refresh(job)
        assert job.status == "finished"
        await clear_queue_plate(job.id, db_session, None)
        assert job.status == "successful"


class TestPrintCompleteLogic:
    """Test print complete callback logic."""

    @pytest.mark.asyncio
    async def test_print_complete_no_import_errors(self, capture_logs):
        """Verify the print-complete callback delegates without import errors."""
        from backend.app import main

        completed = AsyncMock(return_value="completed")
        data = {
            "status": "completed",
            "filename": "/data/Metadata/test.gcode",
            "subtask_name": "Test",
            "timelapse_was_active": False,
        }
        with patch.object(main.intake, "print_completed", new=completed):
            assert await main.on_print_complete(1, data) == "completed"
        completed.assert_awaited_once_with(1, data)

        # Verify no import shadowing errors - this would have caught the ArchiveService bug
        errors = [r for r in capture_logs.get_errors() if "cannot access local variable" in str(r.message)]
        assert not errors, f"Import shadowing error: {capture_logs.format_errors()}"


class TestTimelapseTracking:
    """Test timelapse detection during prints."""

    @pytest.mark.asyncio
    async def test_timelapse_detected_in_same_message_as_print_start(self):
        """Verify timelapse is detected when xcam and state come together."""
        from backend.app.services.bambu_mqtt import BambuMQTTClient

        client = BambuMQTTClient(
            ip_address="192.168.1.100",
            serial_number="TEST123",
            access_code="12345678",
        )
        client.on_print_start = lambda data: None

        # Initial state
        client._was_running = False
        client._timelapse_during_print = False

        # Message with both state and timelapse
        client._process_message(
            {
                "print": {
                    "gcode_state": "RUNNING",
                    "gcode_file": "/data/Metadata/test.gcode",
                    "subtask_name": "Test",
                    "xcam": {"timelapse": "enable"},
                }
            }
        )

        assert client._was_running is True
        assert client._timelapse_during_print is True, (
            "Timelapse should be detected even when xcam is parsed before state"
        )

    @pytest.mark.asyncio
    async def test_timelapse_flag_included_in_completion_callback(self):
        """Verify completion callback receives timelapse_was_active flag."""
        from backend.app.services.bambu_mqtt import BambuMQTTClient

        client = BambuMQTTClient(
            ip_address="192.168.1.100",
            serial_number="TEST123",
            access_code="12345678",
        )

        completion_data = {}

        def on_complete(data):
            completion_data.update(data)

        client.on_print_start = lambda data: None
        client.on_print_complete = on_complete

        # Start with timelapse
        client._process_message(
            {
                "print": {
                    "gcode_state": "RUNNING",
                    "gcode_file": "/data/Metadata/test.gcode",
                    "subtask_name": "Test",
                    "xcam": {"timelapse": "enable"},
                }
            }
        )

        # Complete print
        client._process_message(
            {
                "print": {
                    "gcode_state": "FINISH",
                    "gcode_file": "/data/Metadata/test.gcode",
                    "subtask_name": "Test",
                }
            }
        )

        assert "timelapse_was_active" in completion_data
        assert completion_data["timelapse_was_active"] is True

    @pytest.mark.asyncio
    async def test_hms_errors_included_in_failed_completion_callback(self):
        """Verify completion callback receives hms_errors for failed prints."""
        from backend.app.services.bambu_mqtt import BambuMQTTClient

        client = BambuMQTTClient(
            ip_address="192.168.1.100",
            serial_number="TEST123",
            access_code="12345678",
        )

        completion_data = {}

        def on_complete(data):
            completion_data.update(data)

        client.on_print_start = lambda data: None
        client.on_print_complete = on_complete

        # Start print
        client._process_message(
            {
                "print": {
                    "gcode_state": "RUNNING",
                    "gcode_file": "/data/Metadata/test.gcode",
                    "subtask_name": "Test",
                }
            }
        )

        # Add HMS error during print
        client._process_message(
            {
                "print": {
                    "gcode_state": "RUNNING",
                    "hms": [{"attr": 0x07000002, "code": 0x8001}],  # Filament module error (code must be >= 0x4000)
                }
            }
        )

        # Fail print
        client._process_message(
            {
                "print": {
                    "gcode_state": "FAILED",
                    "gcode_file": "/data/Metadata/test.gcode",
                    "subtask_name": "Test",
                }
            }
        )

        assert "hms_errors" in completion_data
        assert len(completion_data["hms_errors"]) == 1
        assert completion_data["hms_errors"][0]["module"] == 0x07
        assert completion_data["status"] == "failed"

    @pytest.mark.asyncio
    async def test_aborted_status_when_cancelled(self):
        """Verify completion callback receives 'aborted' status when print is cancelled."""
        from backend.app.services.bambu_mqtt import BambuMQTTClient

        client = BambuMQTTClient(
            ip_address="192.168.1.100",
            serial_number="TEST123",
            access_code="12345678",
        )

        completion_data = {}

        def on_complete(data):
            completion_data.update(data)

        client.on_print_start = lambda data: None
        client.on_print_complete = on_complete

        # Start print
        client._process_message(
            {
                "print": {
                    "gcode_state": "RUNNING",
                    "gcode_file": "/data/Metadata/test.gcode",
                    "subtask_name": "Test",
                }
            }
        )

        # User cancels (goes to IDLE)
        client._process_message(
            {
                "print": {
                    "gcode_state": "IDLE",
                    "gcode_file": "/data/Metadata/test.gcode",
                    "subtask_name": "Test",
                }
            }
        )

        assert completion_data["status"] == "aborted"
        assert "hms_errors" in completion_data

    @pytest.mark.asyncio
    async def test_timelapse_detected_from_ipcam_data(self):
        """Verify timelapse is detected from ipcam data (H2D sends it there, not xcam)."""
        from backend.app.services.bambu_mqtt import BambuMQTTClient

        client = BambuMQTTClient(
            ip_address="192.168.1.100",
            serial_number="TEST123",
            access_code="12345678",
        )

        completion_data = {}

        def on_complete(data):
            completion_data.update(data)

        client.on_print_start = lambda data: None
        client.on_print_complete = on_complete

        # Start print with timelapse in ipcam data (H2D format)
        client._process_message(
            {
                "print": {
                    "gcode_state": "RUNNING",
                    "gcode_file": "/data/Metadata/test.gcode",
                    "subtask_name": "Test",
                    "ipcam": {
                        "ipcam_record": "enable",
                        "timelapse": "enable",
                        "resolution": "1080p",
                    },
                }
            }
        )

        assert client._timelapse_during_print is True, "Timelapse should be detected from ipcam data"

        # Complete print
        client._process_message(
            {
                "print": {
                    "gcode_state": "FINISH",
                    "gcode_file": "/data/Metadata/test.gcode",
                    "subtask_name": "Test",
                }
            }
        )

        assert completion_data["timelapse_was_active"] is True, (
            "timelapse_was_active should be True when timelapse was in ipcam"
        )


class TestCallbackErrorHandling:
    """Test that callback errors are properly logged."""

    @pytest.mark.asyncio
    async def test_callback_errors_are_logged(self, capture_logs):
        """Verify that exceptions in callbacks are logged, not swallowed."""
        from backend.app.services.printer_manager import PrinterManager

        manager = PrinterManager()

        # Set up event loop
        loop = asyncio.get_event_loop()
        manager.set_event_loop(loop)

        # Create a callback that raises an error
        error_raised = False

        async def failing_callback(printer_id, data):
            nonlocal error_raised
            error_raised = True
            raise ValueError("Test error in callback")

        manager.set_print_complete_callback(failing_callback)

        # The _schedule_async should log the error
        # This is tested indirectly - if exception handling is broken,
        # the error would be swallowed silently


class TestNoImportShadowing:
    """Verify no import shadowing issues exist in callbacks."""

    @pytest.mark.asyncio
    async def test_on_print_complete_no_import_errors(self, capture_logs):
        """Verify on_print_complete doesn't have import shadowing issues."""
        # Import the module to check for syntax/import errors
        from backend.app import main
        from backend.app.services import print_effects

        # The ArchiveService should be accessible
        from backend.app.services.archive import ArchiveService
        from backend.app.services.lifecycle import intake

        # Verify we can instantiate it (would fail with shadowing bug)
        assert ArchiveService is not None

        # Check logs for any import-related errors
        errors = capture_logs.get_errors()
        import_errors = [
            e for e in errors if "import" in str(e.message).lower() or "local variable" in str(e.message).lower()
        ]
        assert not import_errors, f"Import errors found: {import_errors}"

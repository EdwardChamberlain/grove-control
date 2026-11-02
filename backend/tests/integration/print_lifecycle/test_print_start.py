"""on_print_start: archiving a print when the printer reports it has started.

Runs the real callback against the test database and archive storage. The
printer's SD card is a dict of remote path -> bytes (see conftest).
"""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from backend.app import main
from backend.app.models.archive import PrintArchive
from backend.app.services import bambu_ftp

from .conftest import make_3mf

pytestmark = pytest.mark.integration


def _start_data(subtask="Benchy", filename="/data/Metadata/plate_1.gcode", **extra):
    data = {"filename": filename, "subtask_name": subtask}
    data.update(extra)
    return data


class TestArchivingAPrintStartedOutsideGroveControl:
    async def test_downloads_3mf_from_sd_root_and_creates_printing_archive(self, lifecycle):
        printer = await lifecycle.make_printer()
        lifecycle.storage.files["/Benchy.gcode.3mf"] = make_3mf(print_time=5400)

        await main.on_print_start(printer.id, _start_data(raw_data={"subtask_id": "555"}))

        [archive] = await lifecycle.all(PrintArchive)
        assert archive.status == "printing"
        assert archive.printer_id == printer.id
        assert archive.subtask_id == "555"
        assert archive.print_time_seconds == 5400
        assert archive.started_at is not None
        assert (lifecycle.base_dir / archive.file_path).is_file()
        # Root is tried first: that is where slicer uploads land on A1/P1.
        assert lifecycle.storage.download_attempts[0] == "/Benchy.gcode.3mf"
        assert main._active_prints[(printer.id, "Benchy.gcode.3mf")] == archive.id
        assert main._active_prints[(printer.id, "Benchy.3mf")] == archive.id

        lifecycle.ws.send_print_start.assert_awaited_once()
        created = lifecycle.ws.send_archive_created.await_args.args[0]
        assert created == {
            "id": archive.id,
            "printer_id": printer.id,
            "filename": archive.filename,
            "print_name": archive.print_name,
            "status": "printing",
        }
        lifecycle.relay.on_archive_created.assert_awaited_once()
        notif_kwargs = lifecycle.notifications.on_print_start.await_args.kwargs
        assert notif_kwargs["archive_data"]["print_time_seconds"] == 5400

    async def test_loads_printable_objects_for_skip_object(self, lifecycle):
        printer = await lifecycle.make_printer()
        lifecycle.storage.files["/Benchy.gcode.3mf"] = make_3mf(objects=((7, "Left"), (8, "Right")))

        await main.on_print_start(printer.id, _start_data())

        objects = lifecycle.client.state.printable_objects
        assert {oid: obj["name"] for oid, obj in objects.items()} == {7: "Left", 8: "Right"}
        assert lifecycle.client.state.printable_objects_bbox_all == [0, 0, 100, 100]
        assert lifecycle.client.state.skipped_objects == []

    async def test_tries_cache_and_model_folders_after_root(self, lifecycle):
        printer = await lifecycle.make_printer()
        lifecycle.storage.files["/model/Benchy.gcode.3mf"] = make_3mf()

        await main.on_print_start(printer.id, _start_data())

        assert len(await lifecycle.all(PrintArchive)) == 1
        assert lifecycle.storage.download_attempts[:3] == [
            "/Benchy.gcode.3mf",
            "/cache/Benchy.gcode.3mf",
            "/model/Benchy.gcode.3mf",
        ]

    async def test_retrying_download_skips_missing_paths_without_retrying(self, lifecycle):
        printer = await lifecycle.make_printer()
        lifecycle.storage.files["/cache/Benchy.gcode.3mf"] = make_3mf()

        with patch("backend.app.main.get_ftp_retry_settings", AsyncMock(return_value=(True, 3, 0.0, 5.0))):
            await main.on_print_start(printer.id, _start_data())

        assert len(await lifecycle.all(PrintArchive)) == 1
        # A "550 not found" answer moves straight on instead of using retries.
        assert lifecycle.storage.download_attempts == ["/Benchy.gcode.3mf", "/cache/Benchy.gcode.3mf"]

    async def test_finds_renamed_file_by_listing_printer_folders(self, lifecycle):
        printer = await lifecycle.make_printer()
        # Bambu Studio swapped spaces for underscores and added a suffix.
        lifecycle.storage.files["/cache/My_Benchy_v2.gcode.3mf"] = make_3mf()

        await main.on_print_start(printer.id, _start_data(subtask="My Benchy", filename="/data/Metadata/plate_1.gcode"))

        [archive] = await lifecycle.all(PrintArchive)
        assert archive.filename == "My_Benchy_v2.gcode.3mf"
        assert "/cache" in lifecycle.storage.listed_dirs
        assert main._active_prints[(printer.id, "My_Benchy_v2.gcode.3mf")] == archive.id

    async def test_reuses_3mf_already_cached_by_the_cover_endpoint(self, lifecycle, tmp_path):
        printer = await lifecycle.make_printer()
        cached = tmp_path / "cover-cache" / "Benchy.gcode.3mf"
        cached.parent.mkdir()
        cached.write_bytes(make_3mf())
        bambu_ftp.cache_3mf_download(printer.id, "Benchy.gcode.3mf", cached)

        await main.on_print_start(printer.id, _start_data())

        assert len(await lifecycle.all(PrintArchive)) == 1
        assert lifecycle.storage.download_attempts == []
        # The cached copy stays for the cover endpoint until the print ends.
        assert cached.is_file()


class TestFallbackArchiveWhenNo3mfIsFound:
    @pytest.mark.parametrize(
        ("timing", "expected_seconds"),
        [
            ({"remaining_time": 1800}, 1800),
            ({"raw_data": {"mc_remaining_time": 45}}, 45 * 60),
            ({}, None),
        ],
    )
    async def test_creates_archive_without_file(self, lifecycle, timing, expected_seconds):
        printer = await lifecycle.make_printer()

        await main.on_print_start(printer.id, _start_data(subtask="Bracket", filename="Bracket.gcode", **timing))

        [archive] = await lifecycle.all(PrintArchive)
        assert archive.status == "printing"
        assert archive.file_path == ""
        assert archive.print_name == "Bracket"
        assert archive.print_time_seconds == expected_seconds
        assert archive.extra_data["no_3mf_available"] is True
        assert archive.extra_data["original_subtask"] == "Bracket"
        assert main._active_prints[(printer.id, "Bracket")] == archive.id
        assert main._active_prints[(printer.id, "Bracket.gcode")] == archive.id
        lifecycle.ws.send_archive_created.assert_awaited_once()
        # Notification goes out without archive data.
        assert lifecycle.notifications.on_print_start.await_args.kwargs["archive_data"] is None

    async def test_unknown_print_name_when_only_a_path_is_given(self, lifecycle):
        printer = await lifecycle.make_printer()

        await main.on_print_start(printer.id, _start_data(subtask="", filename="/sdcard/Spacer.3mf"))

        [archive] = await lifecycle.all(PrintArchive)
        assert archive.print_name == "Spacer"
        assert archive.filename == "/sdcard/Spacer.3mf"


class TestPlateMismatch:
    """subtask_name lags across consecutive plates (#1204); the plate in the
    gcode path is authoritative."""

    async def test_redownloads_the_plate_the_printer_is_running(self, lifecycle):
        printer = await lifecycle.make_printer()
        lifecycle.storage.files["/Box_plate_1.gcode.3mf"] = make_3mf(plate_index=1, print_time=100)
        lifecycle.storage.files["/Box_plate_2.gcode.3mf"] = make_3mf(plate_index=2, print_time=200)

        await main.on_print_start(
            printer.id, _start_data(subtask="Box_plate_1", filename="/data/Metadata/plate_2.gcode")
        )

        [archive] = await lifecycle.all(PrintArchive)
        assert archive.filename == "Box_plate_2.gcode.3mf"
        assert archive.print_time_seconds == 200
        assert main._active_prints[(printer.id, "Box_plate_2.3mf")] == archive.id

    async def test_falls_back_to_named_archive_when_right_plate_is_missing(self, lifecycle):
        printer = await lifecycle.make_printer()
        lifecycle.storage.files["/Box_plate_1.gcode.3mf"] = make_3mf(plate_index=1)

        await main.on_print_start(
            printer.id, _start_data(subtask="Box_plate_1", filename="/data/Metadata/plate_2.gcode")
        )

        [archive] = await lifecycle.all(PrintArchive)
        assert archive.file_path == ""
        assert archive.print_name == "Box_plate_2"


class TestPrintsThatAreNotArchived:
    async def test_calibration_print_is_skipped_but_notified(self, lifecycle):
        printer = await lifecycle.make_printer()

        await main.on_print_start(
            printer.id, _start_data(subtask="", filename="/usr/etc/print/auto_cali_for_user.gcode")
        )

        assert await lifecycle.all(PrintArchive) == []
        lifecycle.notifications.on_print_start.assert_awaited_once()

    async def test_print_without_any_name_is_skipped_but_notified(self, lifecycle):
        printer = await lifecycle.make_printer()

        await main.on_print_start(printer.id, {"filename": "", "subtask_name": ""})

        assert await lifecycle.all(PrintArchive) == []
        lifecycle.notifications.on_print_start.assert_awaited_once()

    async def test_unknown_printer_is_notified_without_archive(self, lifecycle):
        await main.on_print_start(4242, _start_data())

        assert await lifecycle.all(PrintArchive) == []
        args = lifecycle.notifications.on_print_start.await_args.args
        assert args[0] == 4242
        assert args[1] == "Printer 4242"

    async def test_auto_archive_off_skips_external_print_and_credits_creator(self, lifecycle):
        printer = await lifecycle.make_printer(auto_archive=False)
        # A stale creator entry for this file is consumed and credited.
        main._expected_print_creators[(printer.id, "Benchy")] = 9

        await main.on_print_start(printer.id, _start_data())

        assert await lifecycle.all(PrintArchive) == []
        assert lifecycle.notifications.on_print_start.await_args.kwargs["archive_data"] == {"created_by_id": 9}
        assert main._expected_print_creators == {}


class TestExpectedPrintsDispatchedByGroveControl:
    async def test_reprint_reuses_archive_and_clears_stale_timelapse(self, lifecycle):
        printer = await lifecycle.make_printer()
        old_video = lifecycle.base_dir / "archive" / "old.mp4"
        old_video.write_bytes(b"video")
        archive = await lifecycle.make_archive(
            None,
            status="completed",
            timelapse_path="archive/old.mp4",
            created_by_id=None,
        )
        main.register_expected_print(printer.id, "Benchy.3mf", archive_id=archive.id, created_by_id=5)
        lifecycle.client.last_dispatch_subtask_id = "disp-1"

        await main.on_print_start(printer.id, _start_data())

        updated = await lifecycle.get(PrintArchive, archive.id)
        assert updated.status == "printing"
        assert updated.started_at is not None
        assert updated.timelapse_path is None
        assert not old_video.exists()
        # The id Grove Control dispatched with is stored for restart matching.
        assert updated.subtask_id == "disp-1"
        # Virtual-printer queue archives start with no printer (#1403).
        assert updated.printer_id == printer.id
        assert len(await lifecycle.all(PrintArchive)) == 1
        assert main._active_prints[(printer.id, "Benchy.gcode.3mf")] == archive.id
        lifecycle.ws.send_archive_updated.assert_awaited_once_with({"id": archive.id, "status": "printing"})
        # The queue owner is credited when the archive has no creator.
        archive_data = lifecycle.notifications.on_print_start.await_args.kwargs["archive_data"]
        assert archive_data["created_by_id"] == 5
        assert archive_data["owner_id"] == 5
        assert (printer.id, "Benchy") not in main._expected_prints
        assert (printer.id, "Benchy.3mf") not in main._expected_prints

    async def test_auto_archive_off_still_promotes_dispatched_print(self, lifecycle):
        printer = await lifecycle.make_printer(auto_archive=False)
        archive = await lifecycle.make_archive(printer.id, status="queued")
        main.register_expected_print(printer.id, "Benchy.3mf", archive_id=archive.id)

        await main.on_print_start(printer.id, _start_data())

        assert (await lifecycle.get(PrintArchive, archive.id)).status == "printing"

    async def test_injects_ams_mapping_and_plate_into_usage_session(self, lifecycle):
        from backend.app.services import usage_tracker

        printer = await lifecycle.make_printer()
        archive = await lifecycle.make_archive(printer.id, status="queued")
        main.register_expected_print(printer.id, "Benchy.3mf", archive_id=archive.id, ams_mapping=[2, -1])
        main._print_plate_ids[archive.id] = 3
        session = usage_tracker.PrintSession(printer_id=printer.id, print_name="Benchy", started_at=datetime.now())
        usage_tracker._active_sessions[printer.id] = session

        with patch("backend.app.services.usage_tracker.on_print_start", AsyncMock()):
            await main.on_print_start(printer.id, _start_data())

        assert session.ams_mapping == [2, -1]
        assert session.plate_id == 3


class TestResumingAfterBackendRestart:
    async def test_same_subtask_id_resumes_printing_archive(self, lifecycle):
        printer = await lifecycle.make_printer()
        archive = await lifecycle.make_archive(printer.id, subtask_id="777")

        await main.on_print_start(printer.id, _start_data(raw_data={"subtask_id": "777"}))

        assert [a.id for a in await lifecycle.all(PrintArchive)] == [archive.id]
        assert main._active_prints[(printer.id, archive.filename)] == archive.id
        assert lifecycle.storage.download_attempts == []

    async def test_same_subtask_id_revives_stale_cancelled_archive(self, lifecycle):
        printer = await lifecycle.make_printer()
        archive = await lifecycle.make_archive(
            printer.id,
            subtask_id="777",
            status="cancelled",
            failure_reason="Stale - print likely cancelled or failed without status update",
        )

        await main.on_print_start(printer.id, _start_data(raw_data={"subtask_id": "777"}))

        revived = await lifecycle.get(PrintArchive, archive.id)
        assert revived.status == "printing"
        assert revived.failure_reason is None

    async def test_name_match_resumes_when_printer_shows_progress(self, lifecycle):
        printer = await lifecycle.make_printer()
        archive = await lifecycle.make_archive(printer.id, created_at=datetime.now(timezone.utc) - timedelta(hours=9))
        lifecycle.printer_manager.get_status.return_value = SimpleNamespace(progress=64.0)

        await main.on_print_start(printer.id, _start_data(raw_data={"subtask_id": "888"}))

        resumed = await lifecycle.get(PrintArchive, archive.id)
        assert resumed.status == "printing"
        # The id is attached so the next restart can match on it.
        assert resumed.subtask_id == "888"
        assert len(await lifecycle.all(PrintArchive)) == 1

    async def test_old_archive_at_zero_progress_is_cancelled_and_replaced(self, lifecycle):
        printer = await lifecycle.make_printer()
        stale = await lifecycle.make_archive(printer.id, created_at=datetime.now(timezone.utc) - timedelta(hours=3))
        lifecycle.printer_manager.get_status.return_value = SimpleNamespace(progress=0.0)
        lifecycle.storage.files["/Benchy.gcode.3mf"] = make_3mf()

        await main.on_print_start(printer.id, _start_data())

        old = await lifecycle.get(PrintArchive, stale.id)
        assert old.status == "cancelled"
        assert old.failure_reason.startswith("Stale")
        archives = await lifecycle.all(PrintArchive)
        assert len(archives) == 2
        assert {a.status for a in archives} == {"cancelled", "printing"}


class TestEnergyTracking:
    async def test_records_plug_energy_at_start(self, lifecycle):
        from backend.app.models.smart_plug import SmartPlug

        printer = await lifecycle.make_printer()
        await lifecycle.add(SmartPlug(name="Plug", plug_type="tasmota", ip_address="10.0.0.5", printer_id=printer.id))
        lifecycle.storage.files["/Benchy.gcode.3mf"] = make_3mf()

        with patch("backend.app.main._get_plug_energy", AsyncMock(return_value={"total": 123.4})):
            await main.on_print_start(printer.id, _start_data())

        [archive] = await lifecycle.all(PrintArchive)
        assert archive.energy_start_kwh == 123.4


class TestPlateDetection:
    @staticmethod
    def _plate_result(empty):
        return SimpleNamespace(needs_calibration=False, is_empty=empty, confidence=0.93, difference_percent=12.5)

    async def test_objects_on_plate_pause_print_and_alert(self, lifecycle):
        printer = await lifecycle.make_printer(
            plate_detection_enabled=True,
            plate_detection_roi_x=0.1,
            plate_detection_roi_y=0.2,
            plate_detection_roi_w=0.5,
            plate_detection_roi_h=0.6,
        )
        check = AsyncMock(return_value=self._plate_result(empty=False))

        with patch("backend.app.services.plate_detection.check_plate_empty", check):
            await main.on_print_start(printer.id, _start_data())

        assert check.await_args.kwargs["roi"] == (0.1, 0.2, 0.5, 0.6)
        lifecycle.client.pause_print.assert_called_once()
        broadcast = lifecycle.ws.broadcast.await_args.args[0]
        assert broadcast["type"] == "plate_not_empty"
        assert broadcast["printer_id"] == printer.id
        lifecycle.notifications.on_plate_not_empty.assert_awaited_once()

    async def test_turns_light_on_for_detection_and_restores_it(self, lifecycle):
        printer = await lifecycle.make_printer(plate_detection_enabled=True)
        lifecycle.client.state.chamber_light = False

        with (
            patch(
                "backend.app.services.plate_detection.check_plate_empty",
                AsyncMock(return_value=self._plate_result(True)),
            ),
            patch("backend.app.main.asyncio.sleep", AsyncMock()),
        ):
            await main.on_print_start(printer.id, _start_data())

        assert [c.args[0] for c in lifecycle.client.set_chamber_light.call_args_list] == [True, False]
        lifecycle.client.pause_print.assert_not_called()

    async def test_detection_error_does_not_block_the_print(self, lifecycle):
        printer = await lifecycle.make_printer(plate_detection_enabled=True)
        lifecycle.storage.files["/Benchy.gcode.3mf"] = make_3mf()

        with patch(
            "backend.app.services.plate_detection.check_plate_empty", AsyncMock(side_effect=RuntimeError("no cam"))
        ):
            await main.on_print_start(printer.id, _start_data())

        assert len(await lifecycle.all(PrintArchive)) == 1
        lifecycle.client.pause_print.assert_not_called()

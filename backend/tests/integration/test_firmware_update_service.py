"""FirmwareUpdateService: the pre-flight checks and the download / upload
run that reports progress over the websocket."""

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.app.services import firmware_update as fu
from backend.app.services.firmware_update import FirmwareUploadStatus as S

pytestmark = pytest.mark.integration

MB = 1024 * 1024


@pytest.fixture(autouse=True)
def clean_states():
    fu._upload_states.clear()
    yield
    fu._upload_states.clear()


@pytest.fixture
def firmware():
    svc = MagicMock()
    svc.check_for_update = AsyncMock(return_value={"update_available": True, "latest_version": "01.09.00.00"})
    svc.get_latest_version = AsyncMock(return_value=SimpleNamespace(version="01.09.00.00"))
    svc.get_firmware_file_info = AsyncMock(return_value={"filename": "x1c-01.09.00.00.bin"})
    svc.download_firmware = AsyncMock(return_value=Path("/tmp/x1c-01.09.00.00.bin"))
    svc.download_page_unreachable = False
    with patch.object(fu, "get_firmware_service", return_value=svc):
        yield svc


@pytest.fixture
def broadcasts():
    sent = []

    async def broadcast(msg):
        sent.append(msg)

    with patch.object(fu.ws_manager, "broadcast", side_effect=broadcast):
        yield sent


def _connected(sdcard=True, firmware_version="01.08.00.00"):
    client = SimpleNamespace(state=SimpleNamespace(sdcard=sdcard, firmware_version=firmware_version))
    return patch.object(fu.printer_manager, "get_client", return_value=client)


def _storage(free_bytes=None, error=None):
    mock = (
        AsyncMock(side_effect=error)
        if error
        else AsyncMock(return_value={"free_bytes": free_bytes} if free_bytes else {})
    )
    return patch.object(fu, "get_storage_info_async", mock)


class TestPrepareUpdate:
    async def test_ready_to_update(self, db_session, printer_factory, firmware):
        printer = await printer_factory(model="X1C")

        with _connected(), _storage(2000 * MB):
            result = await fu.FirmwareUpdateService().prepare_update(printer.id, db_session)

        assert result["can_proceed"] is True
        assert (result["current_version"], result["latest_version"]) == ("01.08.00.00", "01.09.00.00")
        assert result["firmware_filename"] == "x1c-01.09.00.00.bin"
        assert result["errors"] == []

    async def test_unknown_printer_and_disconnected(self, db_session, printer_factory, firmware):
        printer = await printer_factory()
        svc = fu.FirmwareUpdateService()

        assert (await svc.prepare_update(9999, db_session))["errors"] == ["Printer not found"]
        with patch.object(fu.printer_manager, "get_client", return_value=None):
            assert (await svc.prepare_update(printer.id, db_session))["errors"] == ["Printer not connected"]

    async def test_no_sd_card(self, db_session, printer_factory, firmware):
        printer = await printer_factory()

        with _connected(sdcard=False):
            result = await fu.FirmwareUpdateService().prepare_update(printer.id, db_session)

        assert result["can_proceed"] is False
        assert "No SD card inserted in printer" in result["errors"]

    async def test_not_enough_space(self, db_session, printer_factory, firmware):
        printer = await printer_factory()

        with _connected(), _storage(150 * MB):
            result = await fu.FirmwareUpdateService().prepare_update(printer.id, db_session)

        assert result["space_sufficient"] is False
        assert any("Insufficient SD card space. Need 200MB, have 150MB" in e for e in result["errors"])

    async def test_unknown_free_space_is_assumed_sufficient(self, db_session, printer_factory, firmware):
        printer = await printer_factory()

        with _connected(), _storage(error=OSError("ftp down")):
            result = await fu.FirmwareUpdateService().prepare_update(printer.id, db_session)

        assert (result["sd_card_free_space"], result["space_sufficient"], result["can_proceed"]) == (-1, True, True)

    async def test_already_up_to_date(self, db_session, printer_factory, firmware):
        firmware.check_for_update.return_value = {"update_available": False, "latest_version": "01.08.00.00"}
        printer = await printer_factory()

        with _connected(), _storage(2000 * MB):
            result = await fu.FirmwareUpdateService().prepare_update(printer.id, db_session)

        assert result["errors"] == ["Firmware is already up to date"]

    async def test_unknown_current_version_uses_latest(self, db_session, printer_factory, firmware):
        printer = await printer_factory()

        with _connected(firmware_version=None), _storage(2000 * MB):
            result = await fu.FirmwareUpdateService().prepare_update(printer.id, db_session)

        assert (result["latest_version"], result["update_available"]) == ("01.09.00.00", True)
        firmware.check_for_update.assert_not_awaited()

    async def test_explicit_target_allows_reinstall(self, db_session, printer_factory, firmware):
        firmware.check_for_update.return_value = {"update_available": False, "latest_version": "01.08.00.00"}
        printer = await printer_factory()

        with _connected(), _storage(2000 * MB):
            result = await fu.FirmwareUpdateService().prepare_update(
                printer.id, db_session, target_version="01.07.00.00"
            )

        assert (result["can_proceed"], result["target_version"]) == (True, "01.07.00.00")
        firmware.get_firmware_file_info.assert_awaited_with("X1C", version="01.07.00.00")

    @pytest.mark.parametrize(
        ("unreachable", "message"),
        [(False, "is not available from Bambu Lab"), (True, "Could not reach Bambu Lab's firmware download page")],
    )
    async def test_missing_target_file(self, db_session, printer_factory, firmware, unreachable, message):
        firmware.get_firmware_file_info.return_value = None
        firmware.download_page_unreachable = unreachable
        printer = await printer_factory()

        with _connected(), _storage(2000 * MB):
            result = await fu.FirmwareUpdateService().prepare_update(
                printer.id, db_session, target_version="01.07.00.00"
            )

        assert result["can_proceed"] is False
        assert message in result["errors"][0]


class TestStartUpload:
    async def test_starts_a_background_upload(self, db_session, printer_factory, broadcasts):
        printer = await printer_factory(model="P1S")

        with patch.object(fu, "spawn_background_task") as spawn:
            started = await fu.FirmwareUpdateService().start_upload(printer.id, db_session, target_version="1.2")

        assert started is True
        assert spawn.call_args.kwargs["name"] == f"firmware-upload-{printer.id}"
        spawn.call_args.args[0].close()  # the coroutine is not run in this test
        assert broadcasts[-1]["status"] == "preparing"

    async def test_refuses_while_running_and_for_unknown_printer(self, db_session):
        svc = fu.FirmwareUpdateService()
        fu.get_upload_state(1).status = S.UPLOADING

        assert await svc.start_upload(1, db_session) is False
        assert await svc.start_upload(9999, db_session) is False
        assert (fu.get_upload_state(9999).status, fu.get_upload_state(9999).error) == (S.ERROR, "Printer not found")


class TestDoUpload:
    async def _run(self, retry_enabled=False, upload_result=True, **kwargs):
        async def upload(*args, progress_callback, **kw):
            progress_callback(50, 100)
            progress_callback(50, 100)  # no change: not re-broadcast
            progress_callback(100, 100)
            progress_callback(0, 0)
            return upload_result

        retry = AsyncMock(
            side_effect=lambda fn, *a, **kw: fn(
                *a, **{k: v for k, v in kw.items() if k not in ("max_retries", "retry_delay", "operation_name")}
            )
        )
        with (
            patch.object(fu, "get_ftp_retry_settings", AsyncMock(return_value=(retry_enabled, 3, 1, 30))),
            patch.object(fu, "upload_file_async", side_effect=upload),
            patch.object(fu, "with_ftp_retry", retry),
        ):
            await fu.FirmwareUpdateService()._do_upload(7, "10.0.0.7", "code", "X1C", **kwargs)
        return retry

    @pytest.mark.parametrize("retry_enabled", [False, True])
    async def test_uploads_and_completes(self, firmware, broadcasts, retry_enabled):
        retry = await self._run(retry_enabled=retry_enabled)

        state = fu.get_upload_state(7)
        assert (state.status, state.progress, state.firmware_version) == (S.COMPLETE, 100, "01.09.00.00")
        assert state.firmware_filename == "x1c-01.09.00.00.bin"
        assert [b["status"] for b in broadcasts][:2] == ["downloading", "uploading"]
        assert broadcasts[-1]["status"] == "complete"
        assert retry.await_count == (1 if retry_enabled else 0)

    async def test_uses_the_target_version(self, firmware, broadcasts):
        await self._run(target_version="01.07.00.00")

        assert fu.get_upload_state(7).firmware_version == "01.07.00.00"
        firmware.get_latest_version.assert_not_awaited()

    async def test_download_failure(self, firmware, broadcasts):
        firmware.download_firmware.return_value = None

        await self._run()

        state = fu.get_upload_state(7)
        assert (state.status, state.error) == (S.ERROR, "Failed to download firmware")
        assert broadcasts[-1]["error"] == "Failed to download firmware"

    async def test_upload_failure(self, firmware, broadcasts):
        await self._run(upload_result=False)

        assert fu.get_upload_state(7).error == "Failed to upload firmware to printer"


def test_state_helpers_and_singleton():
    fu.get_upload_state(3).progress = 40
    fu.reset_upload_state(3)

    assert fu.get_upload_state(3).progress == 0
    assert fu.get_firmware_update_service() is fu.get_firmware_update_service()

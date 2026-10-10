"""Live printer readers resolve unique Queue uploads through exact job identity."""

import zipfile
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.app.api.routes.printers import clear_cover_cache
from backend.app.core.config import settings
from backend.app.models.print_queue import PrintQueueItem
from backend.app.services.bambu_ftp import cache_3mf_download, clear_3mf_cache
from backend.app.services.bambu_mqtt import PrinterState


@pytest.fixture
async def upload_case(db_session, printer_factory, archive_factory, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "base_dir", tmp_path)
    monkeypatch.setattr(settings, "archive_dir", tmp_path / "archives")
    source = tmp_path / "attempt.3mf"
    with zipfile.ZipFile(source, "w") as zf:
        zf.writestr("Metadata/plate_1.png", b"PLATE_PNG")
        zf.writestr("Metadata/plate_1.gcode", "; gcode\n")
    printer = await printer_factory()
    remote_filename = "Cube__grove_current_attempt.3mf"
    archive = await archive_factory(
        printer.id,
        filename="Cube.gcode.3mf",
        file_path=str(source),
        with_run=False,
        extra_data={"remote_filename": remote_filename},
    )
    job = PrintQueueItem(printer_id=printer.id, archive_id=archive.id, status="printing", dispatch_subtask_id="123")
    db_session.add(job)
    await db_session.flush()
    archive.dispatched_queue_item_id = job.id
    await db_session.commit()
    state = PrinterState()
    state.connected = True
    state.state = "RUNNING"
    state.subtask_name = "Cube"
    state.subtask_id = "123"
    state.submission_id = "123"
    state.printable_objects = {}
    state.skipped_objects = []
    state.dispatched_plate_id = 1
    state.dispatched_subtask = "Cube"
    clear_cover_cache(printer.id)
    clear_3mf_cache(printer.id, delete_files=False)
    yield SimpleNamespace(printer=printer, state=state, source=source, remote_filename=remote_filename)
    clear_cover_cache(printer.id)
    clear_3mf_cache(printer.id, delete_files=False)


async def test_cover_uses_recorded_queue_upload_with_original_display_name(async_client, upload_case, cached):
    case = upload_case
    if cached:
        cache_3mf_download(case.printer.id, case.remote_filename, case.source)

    async def download(_ip, _code, paths, target, **_kwargs):
        if paths != [f"/{case.remote_filename}"]:
            return False
        target.write_bytes(case.source.read_bytes())
        return True

    ftp = AsyncMock(side_effect=download)
    with (
        patch("backend.app.api.routes.printers.printer_manager.get_status", return_value=case.state),
        patch("backend.app.api.routes.printers.download_file_try_paths_async", ftp),
    ):
        response = await async_client.get(f"/api/v1/printers/{case.printer.id}/cover")
    assert response.status_code == 200, response.text
    assert response.content == b"PLATE_PNG"
    if cached:
        ftp.assert_not_awaited()
    else:
        ftp.assert_awaited_once()
    assert case.source.is_file()


@pytest.mark.parametrize("identity_matches", [False, True])
async def test_object_reload_uses_only_the_matching_jobs_remote_path(async_client, upload_case, identity_matches):
    case = upload_case
    if not identity_matches:
        case.state.submission_id = case.state.subtask_id = "456"
    seen_paths = []

    async def download(_ip, _code, paths, target, **_kwargs):
        seen_paths.extend(paths)
        target.write_bytes(case.source.read_bytes())
        return True

    extract = MagicMock(return_value=({1: {"name": "Cube", "x": 1, "y": 2}}, None))
    with (
        patch(
            "backend.app.api.routes.printers.printer_manager.get_client", return_value=SimpleNamespace(state=case.state)
        ),
        patch("backend.app.services.bambu_ftp.download_file_try_paths_async", AsyncMock(side_effect=download)),
        patch("backend.app.services.archive.extract_printable_objects_from_3mf", extract),
    ):
        response = await async_client.get(f"/api/v1/printers/{case.printer.id}/print/objects?reload=true")
    assert response.status_code == 200, response.text
    assert response.json()["objects"][0]["name"] == "Cube"
    if identity_matches:
        assert seen_paths == [f"/{case.remote_filename}"]
    else:
        assert f"/{case.remote_filename}" not in seen_paths
        assert "/Cube.3mf" in seen_paths

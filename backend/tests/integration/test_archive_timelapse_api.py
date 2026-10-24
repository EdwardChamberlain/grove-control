"""Integration tests for attaching a printer's timelapse to an archive
(``/archives/{id}/timelapse/scan`` and ``/timelapse/select``).

The printer's FTP is mocked; the archive's directory lives under a temporary
``base_dir`` so the attached video is really written and recorded.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient

from backend.app.core.config import settings as app_settings

FTP = "backend.app.services.bambu_ftp"


@pytest.fixture
def base_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(app_settings, "base_dir", tmp_path)
    (tmp_path / "archives" / "t").mkdir(parents=True)
    return tmp_path


@pytest.fixture
def ftp():
    """Mock the FTP helpers. ``listing`` maps directory → files."""
    state = {"listing": {}, "downloads": [], "data": b"video-bytes"}

    async def list_files(ip, code, path, printer_model=None):
        if path not in state["listing"]:
            raise ConnectionError("no such dir")
        return state["listing"][path]

    async def download(ip, code, remote_path, socket_timeout=None, printer_model=None):
        state["downloads"].append(remote_path)
        return state["data"]

    with (
        patch(f"{FTP}.list_files_async", side_effect=list_files),
        patch(f"{FTP}.download_file_bytes_async", side_effect=download),
        patch(f"{FTP}.get_ftp_retry_settings", AsyncMock(return_value=(False, 0, 0.0, 5.0))),
    ):
        yield state


@pytest.fixture
async def archive_on_printer(base_dir, archive_factory, printer_factory):
    printer = await printer_factory()

    async def _make(**kwargs):
        defaults = {"filename": "Benchy.gcode.3mf", "file_path": "archives/t/Benchy.gcode.3mf"}
        defaults.update(kwargs)
        return await archive_factory(printer.id, **defaults)

    return _make


def video(name: str, path: str | None = None, mtime: datetime | None = None) -> dict:
    return {"name": name, "path": path or f"/timelapse/{name}", "size": 1000, "mtime": mtime, "is_directory": False}


@pytest.mark.integration
class TestTimelapseScan:
    async def test_matches_by_print_name_and_attaches(
        self, async_client: AsyncClient, archive_on_printer, ftp, base_dir
    ):
        archive = await archive_on_printer()
        archive_id = archive.id
        ftp["listing"]["/timelapse"] = [
            video("other_print.mp4"),
            video("benchy.gcode_2026.mp4"),
            {"name": "thumbs", "is_directory": True},
            video("notes.txt"),
        ]

        response = await async_client.post(f"/api/v1/archives/{archive_id}/timelapse/scan")
        assert response.status_code == 200
        assert response.json()["status"] == "attached"
        assert response.json()["filename"] == "benchy.gcode_2026.mp4"
        assert ftp["downloads"] == ["/timelapse/benchy.gcode_2026.mp4"]
        assert (base_dir / "archives/t/benchy.gcode_2026.mp4").read_bytes() == b"video-bytes"

        detail = await async_client.get(f"/api/v1/archives/{archive_id}")
        assert detail.json()["timelapse_path"] == "archives/t/benchy.gcode_2026.mp4"

    async def test_already_attached_is_a_no_op(self, async_client: AsyncClient, archive_on_printer, ftp):
        archive = await archive_on_printer(timelapse_path="archives/t/existing.mp4")
        response = await async_client.post(f"/api/v1/archives/{archive.id}/timelapse/scan")
        assert response.json()["status"] == "exists"
        assert ftp["downloads"] == []

    async def test_falls_through_to_later_directories(self, async_client: AsyncClient, archive_on_printer, ftp):
        archive = await archive_on_printer()
        ftp["listing"]["/record"] = [video("Benchy.mp4", path="/record/Benchy.mp4")]
        response = await async_client.post(f"/api/v1/archives/{archive.id}/timelapse/scan")
        assert response.json()["status"] == "attached"
        assert ftp["downloads"] == ["/record/Benchy.mp4"]

    async def test_matches_by_file_mtime_near_completion(self, async_client: AsyncClient, archive_on_printer, ftp):
        # The FTP listing parses ``LIST`` output into naive datetimes, and the
        # archive's timestamps come back naive from the database.
        completed = datetime(2026, 5, 1, 12, 0)
        archive = await archive_on_printer(completed_at=completed)
        ftp["listing"]["/timelapse"] = [
            video("video_a.mp4", mtime=completed - timedelta(hours=5)),
            video("video_b.mp4", mtime=completed + timedelta(minutes=3)),
        ]
        response = await async_client.post(f"/api/v1/archives/{archive.id}/timelapse/scan")
        assert response.json()["filename"] == "video_b.mp4"

    async def test_lists_candidates_when_nothing_matches(self, async_client: AsyncClient, archive_on_printer, ftp):
        old = datetime(2020, 1, 1)
        archive = await archive_on_printer(completed_at=old, created_at=old)
        newer = datetime(2026, 1, 2)
        ftp["listing"]["/timelapse"] = [video("a.mp4", mtime=newer - timedelta(days=1)), video("b.mp4", mtime=newer)]

        response = await async_client.post(f"/api/v1/archives/{archive.id}/timelapse/scan")
        body = response.json()
        assert body["status"] == "not_found"
        assert [f["name"] for f in body["available_files"]] == ["b.mp4", "a.mp4"]  # newest first
        assert ftp["downloads"] == []

    async def test_no_timelapse_directory_is_an_error(self, async_client: AsyncClient, archive_on_printer, ftp):
        archive = await archive_on_printer()
        response = await async_client.post(f"/api/v1/archives/{archive.id}/timelapse/scan")
        assert response.status_code == 500

    async def test_failed_download_is_an_error(self, async_client: AsyncClient, archive_on_printer, ftp):
        archive = await archive_on_printer()
        ftp["listing"]["/timelapse"] = [video("Benchy.mp4")]
        ftp["data"] = b""
        response = await async_client.post(f"/api/v1/archives/{archive.id}/timelapse/scan")
        assert response.status_code == 500
        assert response.json()["detail"] == "Failed to download timelapse"

    async def test_unknown_archive(self, async_client: AsyncClient, ftp):
        response = await async_client.post("/api/v1/archives/99999/timelapse/scan")
        assert response.status_code == 404


@pytest.mark.integration
class TestTimelapseSelect:
    async def test_attaches_the_chosen_file(self, async_client: AsyncClient, archive_on_printer, ftp, base_dir):
        archive = await archive_on_printer()
        ftp["listing"]["/timelapse/video"] = [video("pick-me.mp4", path="/timelapse/video/pick-me.mp4")]
        response = await async_client.post(
            f"/api/v1/archives/{archive.id}/timelapse/select", params={"filename": "pick-me.mp4"}
        )
        assert response.status_code == 200
        assert ftp["downloads"] == ["/timelapse/video/pick-me.mp4"]
        assert (base_dir / "archives/t/pick-me.mp4").exists()

    async def test_unknown_file_is_404(self, async_client: AsyncClient, archive_on_printer, ftp):
        archive = await archive_on_printer()
        ftp["listing"]["/timelapse"] = [video("other.mp4")]
        response = await async_client.post(
            f"/api/v1/archives/{archive.id}/timelapse/select", params={"filename": "missing.mp4"}
        )
        assert response.status_code == 404

    async def test_path_traversal_name_is_not_written(
        self, async_client: AsyncClient, archive_on_printer, ftp, base_dir
    ):
        archive = await archive_on_printer()
        evil = "../../escape.mp4"
        ftp["listing"]["/timelapse"] = [video(evil, path="/timelapse/x.mp4")]
        response = await async_client.post(f"/api/v1/archives/{archive.id}/timelapse/select", params={"filename": evil})
        assert response.status_code >= 400
        assert not (base_dir.parent / "escape.mp4").exists()
        assert not (base_dir / "escape.mp4").exists()

"""Integration tests for POST /archives/{id}/save-to-files.

The route copies an Archive entry's 3MF and thumbnail into Files as a new
``LibraryFile``. The Archive row and its files are never moved, linked or
modified.
"""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select

from backend.app.core.config import settings as app_settings
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile, LibraryFolder
from backend.tests.integration.test_ownership_permissions import TestOwnershipPermissionsSetup

URL = "/api/v1/archives/{}/save-to-files"


def _make_3mf(marker: str = "a") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("3D/3dmodel.model", f"<model>{marker}</model>")
        zf.writestr("Metadata/plate_1.gcode", b"G1 X1")
    return buf.getvalue()


@pytest.fixture
def storage(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(app_settings, "base_dir", tmp_path)
    monkeypatch.setattr(app_settings, "archive_dir", tmp_path / "archive")
    return tmp_path


@pytest.fixture
def make_archive(storage: Path, archive_factory, printer_factory):
    """Archive row backed by a real 3MF (+ thumbnail) under base_dir."""

    async def _make(*, with_thumbnail: bool = True, content: bytes | None = None, **kwargs):
        printer = await printer_factory()
        rel_dir = Path("archive") / str(printer.id) / "job"
        (storage / rel_dir).mkdir(parents=True, exist_ok=True)
        three_mf = rel_dir / "benchy.gcode.3mf"
        (storage / three_mf).write_bytes(content if content is not None else _make_3mf())
        defaults = {
            "filename": "benchy.gcode.3mf",
            "file_path": str(three_mf),
            "sliced_for_model": "X1C",
            "filament_color": "#FF0000",
        }
        if with_thumbnail:
            thumb = rel_dir / "thumbnail.png"
            (storage / thumb).write_bytes(b"PNGDATA")
            defaults["thumbnail_path"] = str(thumb)
        defaults.update(kwargs)
        return await archive_factory(printer.id, **defaults)

    return _make


async def _file_count(db_session) -> int:
    return (await db_session.execute(select(func.count()).select_from(LibraryFile))).scalar_one()


class TestSaveArchiveToFiles:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_saves_to_root_with_archive_metadata(
        self, async_client: AsyncClient, db_session, storage, make_archive
    ):
        archive = await make_archive()

        resp = await async_client.post(URL.format(archive.id), json={"folder_id": None})

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["filename"] == "benchy.gcode.3mf"
        assert body["file_type"] == "gcode.3mf"
        assert body["duplicate_of"] is None
        new_file = await db_session.get(LibraryFile, body["id"])
        assert new_file.folder_id is None
        assert new_file.file_metadata["print_time_seconds"] == 3600
        assert new_file.file_metadata["filament_used_g"] == 50.0
        assert new_file.file_metadata["filament_type"] == "PLA"
        assert new_file.file_metadata["filament_color"] == "#FF0000"
        assert new_file.file_metadata["sliced_for_model"] == "X1C"
        assert new_file.file_metadata["saved_from_archive_id"] == archive.id
        assert (storage / new_file.file_path).read_bytes() == _make_3mf()
        assert (storage / new_file.thumbnail_path).read_bytes() == b"PNGDATA"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_saves_into_chosen_folder(self, async_client: AsyncClient, db_session, storage, make_archive):
        folder = LibraryFolder(name="Keepers")
        db_session.add(folder)
        await db_session.commit()
        await db_session.refresh(folder)
        archive = await make_archive()

        resp = await async_client.post(URL.format(archive.id), json={"folder_id": folder.id})

        assert resp.status_code == 200, resp.text
        assert (await db_session.get(LibraryFile, resp.json()["id"])).folder_id == folder.id

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_copy_is_independent_of_the_archive(
        self, async_client: AsyncClient, db_session, storage, make_archive
    ):
        """The File owns its own bytes: removing the Archive's files (what
        retention does) leaves the File readable, and the Archive row is
        unchanged by the save."""
        archive = await make_archive()
        archive_id, archive_path, thumb_path = archive.id, archive.file_path, archive.thumbnail_path

        resp = await async_client.post(URL.format(archive_id), json={"folder_id": None})
        assert resp.status_code == 200, resp.text
        new_file = await db_session.get(LibraryFile, resp.json()["id"])
        assert new_file.file_path != archive_path
        assert new_file.thumbnail_path != thumb_path

        (storage / archive_path).unlink()
        (storage / thumb_path).unlink()
        assert (storage / new_file.file_path).read_bytes() == _make_3mf()
        assert (storage / new_file.thumbnail_path).read_bytes() == b"PNGDATA"

        db_session.expire_all()
        reloaded = await db_session.get(PrintArchive, archive_id)
        assert reloaded.file_path == archive_path
        assert reloaded.thumbnail_path == thumb_path
        assert reloaded.deleted_at is None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_flags_duplicate_content_but_still_saves(
        self, async_client: AsyncClient, db_session, storage, make_archive
    ):
        archive = await make_archive()
        first = await async_client.post(URL.format(archive.id), json={"folder_id": None})
        assert first.json()["duplicate_of"] is None

        second = await async_client.post(URL.format(archive.id), json={"folder_id": None})

        assert second.status_code == 200, second.text
        assert second.json()["duplicate_of"] == first.json()["id"]
        assert second.json()["id"] != first.json()["id"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_missing_file_on_disk_is_404_and_creates_nothing(
        self, async_client: AsyncClient, db_session, storage, make_archive
    ):
        archive = await make_archive()
        (storage / archive.file_path).unlink()

        resp = await async_client.post(URL.format(archive.id), json={"folder_id": None})

        assert resp.status_code == 404
        assert await _file_count(db_session) == 0

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_entry_without_a_3mf_is_400(self, async_client: AsyncClient, db_session, storage, make_archive):
        archive = await make_archive(file_path="", thumbnail_path=None)

        resp = await async_client.post(URL.format(archive.id), json={"folder_id": None})

        assert resp.status_code == 400
        assert await _file_count(db_session) == 0

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_unknown_folder_is_404_and_creates_nothing(
        self, async_client: AsyncClient, db_session, storage, make_archive
    ):
        archive = await make_archive()

        resp = await async_client.post(URL.format(archive.id), json={"folder_id": 99999})

        assert resp.status_code == 404
        assert await _file_count(db_session) == 0
        assert not list((storage / "archive" / "library" / "files").glob("*"))

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_unknown_archive_is_404(self, async_client: AsyncClient, storage):
        resp = await async_client.post(URL.format(424242), json={"folder_id": None})
        assert resp.status_code == 404


class TestSaveArchiveToFilesPermissions(TestOwnershipPermissionsSetup):
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_requires_files_upload_permission(
        self, async_client: AsyncClient, auth_setup, db_session, storage, make_archive
    ):
        archive = await make_archive(created_by_id=auth_setup["admin_user"]["id"])

        resp = await async_client.post(
            URL.format(archive.id),
            headers={"Authorization": f"Bearer {auth_setup['viewer_token']}"},
            json={"folder_id": None},
        )

        assert resp.status_code == 403
        assert await _file_count(db_session) == 0

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_requires_archive_read_access(
        self, async_client: AsyncClient, auth_setup, db_session, storage, make_archive
    ):
        """An operator holds the upload permission but can only see their own
        archives: someone else's reads as nonexistent, not forbidden."""
        archive = await make_archive(created_by_id=auth_setup["operator2_user"]["id"])

        resp = await async_client.post(
            URL.format(archive.id),
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
            json={"folder_id": None},
        )

        assert resp.status_code == 404
        assert await _file_count(db_session) == 0

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_owner_with_upload_permission_can_save(
        self, async_client: AsyncClient, auth_setup, db_session, storage, make_archive
    ):
        archive = await make_archive(created_by_id=auth_setup["operator_user"]["id"])

        resp = await async_client.post(
            URL.format(archive.id),
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
            json={"folder_id": None},
        )

        assert resp.status_code == 200, resp.text
        new_file = await db_session.get(LibraryFile, resp.json()["id"])
        assert new_file.created_by_id == auth_setup["operator_user"]["id"]

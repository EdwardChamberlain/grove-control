"""Regression tests for safe archive source replacement."""

import io
import zipfile
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

pytestmark = pytest.mark.integration


def _zip_bytes(marker: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(zipfile.ZipInfo("3D/3dmodel.model", date_time=(2026, 1, 1, 0, 0, 0)), f"<model>{marker}</model>")
    return buf.getvalue()


@pytest.fixture
async def archive(tmp_path, monkeypatch, printer_factory, archive_factory):
    from backend.app.core.config import settings

    monkeypatch.setattr(settings, "base_dir", tmp_path)
    printer = await printer_factory()
    relative_path = Path("archive") / str(printer.id) / "job" / "Gear.gcode.3mf"
    path = tmp_path / relative_path
    path.parent.mkdir(parents=True)
    path.write_bytes(_zip_bytes("initial"))
    return await archive_factory(
        printer.id,
        print_name="Gear box",
        filename="Gear box.gcode.3mf",
        file_path=str(relative_path),
    )


async def _upload_source(client, name, content):
    return await client.post("/api/v1/archives/upload-source", files={"file": (name, content)})


async def test_invalid_replacement_preserves_path_and_bytes(async_client: AsyncClient, archive, db_session, tmp_path):
    good = await _upload_source(async_client, "Gear box.3mf", _zip_bytes("first"))
    assert good.status_code == 200
    await db_session.refresh(archive)
    original_path = archive.source_3mf_path
    original_bytes = (tmp_path / original_path).read_bytes()

    rejected = await _upload_source(async_client, "Gear box.3mf", b"not a zip")

    assert rejected.status_code == 400
    await db_session.refresh(archive)
    assert archive.source_3mf_path == original_path
    assert (tmp_path / original_path).read_bytes() == original_bytes


async def test_same_name_commit_failure_restores_existing_source(
    async_client: AsyncClient, archive, db_session, tmp_path, monkeypatch
):
    good = await _upload_source(async_client, "Gear box.3mf", _zip_bytes("first"))
    assert good.status_code == 200
    await db_session.refresh(archive)
    original_path = archive.source_3mf_path
    original_bytes = (tmp_path / original_path).read_bytes()

    async def fail_commit(self):
        raise RuntimeError("forced commit failure")

    with monkeypatch.context() as patcher:
        patcher.setattr(AsyncSession, "commit", fail_commit)
        try:
            response = await _upload_source(async_client, "Gear box.3mf", _zip_bytes("second"))
        except RuntimeError as error:
            assert str(error) == "forced commit failure"
        else:
            assert response.status_code == 500

    await db_session.refresh(archive)
    assert archive.source_3mf_path == original_path
    assert (tmp_path / original_path).read_bytes() == original_bytes

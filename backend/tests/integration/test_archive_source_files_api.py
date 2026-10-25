"""Archive companion files: source 3MF upload by name, the slicer token
download, Fusion 360 files and project-page images."""

import io
import zipfile
from unittest.mock import patch

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration


def _zip_bytes(marker: str = "a") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(zipfile.ZipInfo("3D/3dmodel.model", date_time=(2026, 1, 1, 0, 0, 0)), f"<model>{marker}</model>")
    return buf.getvalue()


@pytest.fixture
async def archive(tmp_path, monkeypatch, printer_factory, archive_factory):
    from backend.app.core.config import settings

    monkeypatch.setattr(settings, "base_dir", tmp_path)
    (tmp_path / "archive/1/job").mkdir(parents=True)
    (tmp_path / "archive/1/job/Gear.gcode.3mf").write_bytes(_zip_bytes())
    printer = await printer_factory()
    return await archive_factory(
        printer.id, print_name="Gear box", filename="Gear box.gcode.3mf", file_path="archive/1/job/Gear.gcode.3mf"
    )


async def _upload_source(client, name, content, **params):
    return await client.post("/api/v1/archives/upload-source", files={"file": (name, content)}, params=params)


class TestUploadSourceByName:
    async def test_matches_by_print_name_from_filename(self, async_client: AsyncClient, archive, tmp_path):
        response = await _upload_source(async_client, "Gear box_source.3mf", _zip_bytes())

        body = response.json()
        assert (body["archive_id"], body["archive_name"]) == (archive.id, "Gear box")
        assert (tmp_path / body["source_3mf_path"]).read_bytes() == _zip_bytes()

    async def test_falls_back_to_filename_prefix_and_partial_name(self, async_client: AsyncClient, archive):
        by_prefix = await _upload_source(async_client, "x.3mf", _zip_bytes(), print_name="Gear box.gcode")
        by_partial = await _upload_source(async_client, "x.3mf", _zip_bytes(), print_name="gear")

        assert by_prefix.json()["archive_id"] == archive.id
        assert by_partial.json()["archive_id"] == archive.id

    async def test_replaces_previous_source(self, async_client: AsyncClient, archive, tmp_path):
        first = (await _upload_source(async_client, "Gear box.3mf", _zip_bytes("1"))).json()
        second = (await _upload_source(async_client, "Gear box v2.3mf", _zip_bytes("2"), print_name="Gear box")).json()

        assert (
            not (tmp_path / first["source_3mf_path"]).exists() or first["source_3mf_path"] == second["source_3mf_path"]
        )
        assert (tmp_path / second["source_3mf_path"]).read_bytes() == _zip_bytes("2")

    @pytest.mark.parametrize(
        ("name", "params", "status"),
        [("notes.txt", {}, 400), ("Unknown thing.3mf", {}, 404)],
    )
    async def test_errors(self, async_client: AsyncClient, archive, name, params, status):
        assert (await _upload_source(async_client, name, _zip_bytes(), **params)).status_code == status

    @pytest.mark.xfail(
        strict=True,
        reason="Bug: upload-source deletes the existing source 3MF before validating the new upload, so an "
        "invalid upload leaves the archive pointing at a deleted file",
    )
    async def test_invalid_upload_keeps_the_existing_source(self, async_client: AsyncClient, archive, tmp_path):
        good = (await _upload_source(async_client, "Gear box.3mf", _zip_bytes())).json()

        bad = await _upload_source(async_client, "Gear box.3mf", b"not a zip")

        assert bad.status_code == 400
        assert (tmp_path / good["source_3mf_path"]).exists()


class TestSourceTokenDownload:
    async def test_downloads_with_a_valid_token(self, async_client: AsyncClient, archive):
        from backend.app.core.auth import create_slicer_download_token

        await _upload_source(async_client, "Gear box.3mf", _zip_bytes())
        token = await create_slicer_download_token("source", archive.id)

        response = await async_client.get(f"/api/v1/archives/{archive.id}/source-dl/{token}/Gear box")

        assert response.status_code == 200
        assert response.content == _zip_bytes()
        assert (
            "Gear%20box.3mf" in response.headers["content-disposition"]
            or "Gear box.3mf" in response.headers["content-disposition"]
        )

    async def test_rejects_bad_tokens_and_missing_sources(self, async_client: AsyncClient, archive, archive_factory):
        from backend.app.core.auth import create_slicer_download_token

        no_source_token = await create_slicer_download_token("source", archive.id)
        wrong_kind = await create_slicer_download_token("archive", archive.id)

        assert (await async_client.get(f"/api/v1/archives/{archive.id}/source-dl/bad/x.3mf")).status_code == 403
        assert (
            await async_client.get(f"/api/v1/archives/{archive.id}/source-dl/{wrong_kind}/x.3mf")
        ).status_code == 403
        assert (
            await async_client.get(f"/api/v1/archives/{archive.id}/source-dl/{no_source_token}/x.3mf")
        ).status_code == 404


class TestF3d:
    async def test_upload_and_replace(self, async_client: AsyncClient, archive, tmp_path):
        url = f"/api/v1/archives/{archive.id}/f3d"

        first = (await async_client.post(url, files={"file": ("design.f3d", b"v1")})).json()
        second = (await async_client.post(url, files={"file": ("design-v2.f3d", b"v2")})).json()

        assert first["f3d_path"] == "archive/1/job/f3d/design.f3d"
        assert not (tmp_path / first["f3d_path"]).exists()
        assert (tmp_path / second["f3d_path"]).read_bytes() == b"v2"

    async def test_rejects_other_files(self, async_client: AsyncClient, archive):
        response = await async_client.post(f"/api/v1/archives/{archive.id}/f3d", files={"file": ("design.step", b"x")})
        assert response.status_code == 400


class TestProjectImage:
    async def test_serves_image_from_the_3mf(self, async_client: AsyncClient, archive):
        with patch("backend.app.services.archive.ProjectPageParser.get_image", return_value=(b"jpgdata", "image/jpeg")):
            response = await async_client.get(f"/api/v1/archives/{archive.id}/project-image/Auxiliaries/pic.jpg")

        assert (response.status_code, response.content, response.headers["cache-control"]) == (
            200,
            b"jpgdata",
            "max-age=3600",
        )

    async def test_missing_image_archive_or_file(self, async_client: AsyncClient, archive, tmp_path):
        with patch("backend.app.services.archive.ProjectPageParser.get_image", return_value=None):
            missing_image = await async_client.get(f"/api/v1/archives/{archive.id}/project-image/x.jpg")
        (tmp_path / archive.file_path).unlink()
        missing_file = await async_client.get(f"/api/v1/archives/{archive.id}/project-image/x.jpg")
        missing_archive = await async_client.get("/api/v1/archives/9999/project-image/x.jpg")

        assert (missing_image.status_code, missing_file.status_code, missing_archive.status_code) == (404, 404, 404)

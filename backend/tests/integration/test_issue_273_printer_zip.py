"""Regression tests for empty printer ZIP responses."""

import io
import zipfile
from unittest.mock import patch

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration


@pytest.fixture
def sd_card():
    files: dict[str, bytes] = {}

    async def download(ip, access_code, path, **kwargs):
        return files.get(path)

    with patch("backend.app.api.routes.printers.download_file_bytes_async", download):
        yield files


async def test_empty_paths_remains_a_client_error(async_client: AsyncClient, printer_factory, sd_card):
    printer = await printer_factory()
    response = await async_client.post(f"/api/v1/printers/{printer.id}/files/download-zip", json={"paths": []})
    assert response.status_code == 400


async def test_all_missing_files_return_404(async_client: AsyncClient, printer_factory, sd_card):
    printer = await printer_factory()
    response = await async_client.post(
        f"/api/v1/printers/{printer.id}/files/download-zip", json={"paths": ["/gone"]}
    )
    assert response.status_code == 404


async def test_partial_download_returns_only_available_files(
    async_client: AsyncClient, printer_factory, sd_card
):
    printer = await printer_factory()
    sd_card["/a.gcode"] = b"A"
    response = await async_client.post(
        f"/api/v1/printers/{printer.id}/files/download-zip",
        json={"paths": ["/a.gcode", "/gone"]},
    )
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert archive.namelist() == ["a.gcode"]
        assert archive.read("a.gcode") == b"A"

"""POST /firmware/updates/{id}/upload installs the version the pre-flight check validated."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

pytestmark = pytest.mark.integration


@pytest.fixture
def update_service():
    svc = MagicMock()
    svc.prepare_update = AsyncMock(return_value={"can_proceed": True, "latest_version": "01.02.10.00", "errors": []})
    svc.start_upload = AsyncMock(return_value=True)
    with patch("backend.app.api.routes.firmware.get_firmware_update_service", return_value=svc):
        yield svc


async def test_upload_without_version_installs_the_validated_release(async_client, printer_factory, update_service):
    printer = await printer_factory()

    response = await async_client.post(f"/api/v1/firmware/updates/{printer.id}/upload")

    assert response.status_code == 200
    assert update_service.start_upload.await_args.kwargs["target_version"] == "01.02.10.00"


async def test_upload_with_explicit_version_keeps_it(async_client, printer_factory, update_service):
    printer = await printer_factory()

    response = await async_client.post(f"/api/v1/firmware/updates/{printer.id}/upload?version=01.01.00.00")

    assert response.status_code == 200
    assert update_service.start_upload.await_args.kwargs["target_version"] == "01.01.00.00"

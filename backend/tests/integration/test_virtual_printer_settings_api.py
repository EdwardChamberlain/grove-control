"""PUT /settings/virtual-printer: validation, persistence and reconfiguring
the virtual printer service."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration

URL = "/api/v1/settings/virtual-printer"


@pytest.fixture
def manager():
    vp = MagicMock()
    vp.configure = AsyncMock()
    vp.get_status.return_value = {"running": False}
    with patch("backend.app.services.virtual_printer.virtual_printer_manager", vp):
        yield vp


async def test_enables_archive_mode_with_access_code(async_client: AsyncClient, manager):
    response = await async_client.put(URL, params={"enabled": True, "access_code": "12345678", "mode": "immediate"})

    body = response.json()
    assert (body["enabled"], body["access_code_set"], body["mode"]) == (True, True, "archive")
    kwargs = manager.configure.await_args.kwargs
    assert (kwargs["enabled"], kwargs["mode"], kwargs["access_code"]) == (True, "archive", "12345678")


async def test_proxy_mode_targets_a_printer(async_client: AsyncClient, manager, printer_factory):
    printer = await printer_factory(ip_address="192.168.1.77", serial_number="01P00A000000077")

    response = await async_client.put(
        URL,
        params={"enabled": True, "mode": "proxy", "target_printer_id": printer.id, "remote_interface_ip": "10.0.0.2"},
    )

    assert response.json()["target_printer_id"] == printer.id
    kwargs = manager.configure.await_args.kwargs
    assert (kwargs["target_printer_ip"], kwargs["target_printer_serial"], kwargs["remote_interface_ip"]) == (
        "192.168.1.77",
        "01P00A000000077",
        "10.0.0.2",
    )


async def test_changing_mode_without_prerequisites_disables_instead_of_failing(async_client: AsyncClient, manager):
    await async_client.put(URL, params={"enabled": True, "access_code": "12345678"})

    # Switching to proxy without a target: the printer is switched off, not rejected.
    response = await async_client.put(URL, params={"mode": "proxy"})

    assert response.status_code == 200
    assert response.json()["enabled"] is False


async def test_persists_name_source_and_tailscale(async_client: AsyncClient, manager):
    response = await async_client.put(URL, params={"archive_name_source": "filename", "tailscale_disabled": False})

    body = response.json()
    assert (body["archive_name_source"], body["tailscale_disabled"]) == ("filename", False)


@pytest.mark.parametrize(
    ("params", "detail"),
    [
        ({"mode": "teleport"}, "Mode must be one of"),
        ({"archive_name_source": "guess"}, "archive_name_source must be"),
        ({"model": "Z9000"}, "Invalid model"),
        ({"enabled": True, "mode": "proxy"}, "Target printer is required for proxy mode"),
        ({"mode": "proxy", "target_printer_id": 9999}, "Printer with ID 9999 not found"),
        ({"enabled": True, "mode": "archive"}, "Access code is required"),
        ({"access_code": "short"}, "Access code must be exactly 8 characters"),
    ],
)
async def test_validation(async_client: AsyncClient, manager, params, detail):
    response = await async_client.put(URL, params=params)

    assert response.status_code == 400
    assert detail in response.json()["detail"]
    manager.configure.assert_not_awaited()


@pytest.mark.parametrize(("error", "status"), [(ValueError("bad"), 400), (RuntimeError("boom"), 500)])
async def test_service_errors(async_client: AsyncClient, manager, error, status):
    manager.configure.side_effect = error

    response = await async_client.put(URL, params={"enabled": False})

    assert response.status_code == status

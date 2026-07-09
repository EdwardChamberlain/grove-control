"""Default force-colour behavior for webhook queue creation."""

import json
import zipfile

import pytest
from httpx import AsyncClient


def _canonical_override(slot_id: int, family: str, color: str, force_color_match: bool) -> dict:
    return {
        "slot_id": slot_id,
        "material": {
            "family": family,
            "subtype": None,
            "color_hex": f"{color}FF",
            "profile_id": None,
            "setting_id": None,
        },
        "type": family,
        "color": color,
        "tray_info_idx": "",
        "force_color_match": force_color_match,
    }


@pytest.fixture
async def webhook_queue_setup(db_session, tmp_path):
    from backend.app.core.auth import generate_api_key
    from backend.app.models.api_key import APIKey
    from backend.app.models.archive import PrintArchive
    from backend.app.models.printer import Printer

    source = tmp_path / "webhook.3mf"
    with zipfile.ZipFile(source, "w") as zf:
        zf.writestr(
            "Metadata/slice_info.config",
            '<config><plate><metadata key="index" value="1"/>'
            '<filament id="1" type="PLA" color="#00FF00" used_g="5"/>'
            "</plate></config>",
        )

    printer = Printer(
        name="Webhook Printer",
        ip_address="192.168.1.70",
        serial_number="WEBHOOK0001",
        access_code="12345678",
        model="P1S",
    )
    archive = PrintArchive(
        filename="webhook.3mf",
        print_name="Webhook",
        file_path=str(source),
        file_size=source.stat().st_size,
        content_hash="webhook-force-color",
        status="completed",
    )
    full_key, key_hash, key_prefix = generate_api_key()
    api_key = APIKey(
        name="webhook-queue-key",
        key_hash=key_hash,
        key_prefix=key_prefix,
        can_queue=True,
        enabled=True,
    )
    db_session.add_all([printer, archive, api_key])
    await db_session.commit()
    return full_key, printer, archive


@pytest.mark.asyncio
@pytest.mark.integration
async def test_webhook_queue_defaults_force_color_match(async_client: AsyncClient, db_session, webhook_queue_setup):
    from backend.app.models.print_queue import PrintQueueItem

    api_key, printer, archive = webhook_queue_setup
    response = await async_client.post(
        "/api/v1/webhook/queue/add",
        headers={"X-API-Key": api_key},
        json={"printer_id": printer.id, "archive_id": archive.id},
    )

    assert response.status_code == 200, response.text
    item = await db_session.get(PrintQueueItem, response.json()["id"], populate_existing=True)
    assert item is not None
    assert item.force_color_match is True
    assert json.loads(item.filament_overrides) == [_canonical_override(1, "PLA", "#00FF00", True)]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_webhook_queue_allows_explicit_color_opt_out(async_client: AsyncClient, db_session, webhook_queue_setup):
    from backend.app.models.print_queue import PrintQueueItem

    api_key, printer, archive = webhook_queue_setup
    response = await async_client.post(
        "/api/v1/webhook/queue/add",
        headers={"X-API-Key": api_key},
        json={"printer_id": printer.id, "archive_id": archive.id, "force_color_match": False},
    )

    assert response.status_code == 200, response.text
    item = await db_session.get(PrintQueueItem, response.json()["id"], populate_existing=True)
    assert item is not None
    assert item.force_color_match is False
    assert json.loads(item.filament_overrides) == [_canonical_override(1, "PLA", "#00FF00", False)]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_webhook_queue_rejects_cross_material_override(async_client: AsyncClient, webhook_queue_setup):
    api_key, printer, archive = webhook_queue_setup
    response = await async_client.post(
        "/api/v1/webhook/queue/add",
        headers={"X-API-Key": api_key},
        json={
            "printer_id": printer.id,
            "archive_id": archive.id,
            "filament_overrides": [{"slot_id": 1, "type": "ABS", "color": "#FFFFFF"}],
        },
    )

    assert response.status_code == 400
    assert "cannot change material family from PLA to ABS" in response.json()["detail"]

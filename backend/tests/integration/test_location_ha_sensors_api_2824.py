"""Integration coverage for Home Assistant sensors bound to storage locations."""

from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient


@pytest.fixture(autouse=True)
def _no_live_ha():
    """The create route performs a best-effort first read."""
    with patch(
        "backend.app.api.routes.location_ha_sensors.location_ha_sensor_manager.refresh_one",
        new_callable=AsyncMock,
    ):
        yield


@pytest.mark.asyncio
async def test_bind_and_list_location_sensor(async_client: AsyncClient):
    location_response = await async_client.post("/api/v1/inventory/locations", json={"name": "Drybox 1"})
    assert location_response.status_code == 201, location_response.text
    location_id = location_response.json()["id"]

    response = await async_client.post(
        "/api/v1/location-ha-sensors/",
        json={
            "location_id": location_id,
            "name": "Drybox Humidity",
            "entity_id": "sensor.drybox_humidity",
            "kind": "numeric",
            "device_class": "humidity",
            "unit": "%",
            "alert_above": 30,
            "notify_on_alert": True,
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["location_id"] == location_id

    listed = await async_client.get(f"/api/v1/location-ha-sensors/?location_id={location_id}")
    assert listed.status_code == 200
    assert [sensor["entity_id"] for sensor in listed.json()] == ["sensor.drybox_humidity"]


@pytest.mark.asyncio
async def test_duplicate_location_sensor_binding_is_rejected(async_client: AsyncClient):
    location_response = await async_client.post("/api/v1/inventory/locations", json={"name": "Drybox 2"})
    location_id = location_response.json()["id"]
    payload = {
        "location_id": location_id,
        "name": "Drybox Humidity",
        "entity_id": "sensor.drybox_humidity_2",
        "kind": "numeric",
        "device_class": "humidity",
        "unit": "%",
    }

    first = await async_client.post("/api/v1/location-ha-sensors/", json=payload)
    second = await async_client.post("/api/v1/location-ha-sensors/", json=payload)

    assert first.status_code == 200, first.text
    assert second.status_code == 400

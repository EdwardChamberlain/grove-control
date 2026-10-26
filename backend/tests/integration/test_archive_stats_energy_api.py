"""Archive stats: energy totals in each tracking mode and date filtering."""

from datetime import date, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient

from backend.app.models.settings import Settings
from backend.app.models.smart_plug import SmartPlug

pytestmark = pytest.mark.integration


async def test_all_time_total_reads_live_plug_counters(async_client: AsyncClient, db_session):
    db_session.add_all(
        [
            SmartPlug(name="Tasmota", plug_type="tasmota", ip_address="10.0.0.1"),
            SmartPlug(name="HA", plug_type="homeassistant", ha_entity_id="switch.p"),
            SmartPlug(name="MQTT", plug_type="mqtt", mqtt_topic="p/1"),
            SmartPlug(name="REST", plug_type="rest", ip_address="10.0.0.4"),
            SmartPlug(name="Silent", plug_type="tasmota", ip_address="10.0.0.5"),
            Settings(key="energy_cost_per_kwh", value="0.5"),
        ]
    )
    await db_session.commit()
    tasmota = AsyncMock(side_effect=[{"total": 10.0}, None])
    relay = MagicMock()
    relay.smart_plug_service.get_plug_data.return_value = SimpleNamespace(energy=0.5)

    with (
        patch("backend.app.services.tasmota.tasmota_service.get_energy", tasmota),
        patch(
            "backend.app.services.homeassistant.homeassistant_service.get_energy",
            AsyncMock(return_value={"total": 2.0}),
        ),
        patch(
            "backend.app.services.rest_smart_plug.rest_smart_plug_service.get_energy",
            AsyncMock(return_value={"today": 0.25}),
        ),
        patch("backend.app.services.mqtt_relay.mqtt_relay", relay),
    ):
        body = (await async_client.get("/api/v1/archives/stats")).json()

    assert body["total_energy_kwh"] == 12.75
    assert body["total_energy_cost"] == 6.375


async def test_per_print_mode_sums_run_energy(async_client: AsyncClient, db_session, printer_factory, archive_factory):
    db_session.add(Settings(key="energy_tracking_mode", value="print"))
    await db_session.commit()
    printer = await printer_factory()
    await archive_factory(printer.id, energy_kwh=1.2, energy_cost=0.3)
    await archive_factory(printer.id, energy_kwh=0.8, energy_cost=0.2)

    body = (await async_client.get("/api/v1/archives/stats")).json()

    assert (body["total_energy_kwh"], body["total_energy_cost"]) == (2.0, 0.5)


async def test_date_filtered_total_uses_snapshots(async_client: AsyncClient):
    with patch("backend.app.api.routes.archives._sum_snapshot_deltas", AsyncMock(return_value=(3.5, True))) as deltas:
        body = (
            await async_client.get(
                "/api/v1/archives/stats",
                params={"date_from": str(date.today() - timedelta(days=7)), "date_to": str(date.today())},
            )
        ).json()

    assert (body["total_energy_kwh"], body["energy_data_warming_up"]) == (3.5, True)
    assert deltas.await_args.kwargs["dt_from"] is not None


async def test_date_range_limits_print_counts(async_client: AsyncClient, printer_factory, archive_factory):
    printer = await printer_factory()
    await archive_factory(printer.id, status="completed")

    future = (
        await async_client.get("/api/v1/archives/stats", params={"date_from": str(date.today() + timedelta(days=1))})
    ).json()
    today = (
        await async_client.get("/api/v1/archives/stats", params={"date_to": str(date.today() + timedelta(days=1))})
    ).json()

    assert future["total_prints"] == 0
    assert today["total_prints"] == 1

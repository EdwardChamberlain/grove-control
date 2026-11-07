"""Archive stats: energy totals in each tracking mode and date filtering."""

from datetime import date, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient

from backend.app.models.settings import Settings
from backend.app.models.smart_plug import SmartPlug
from backend.app.models.smart_plug_energy_snapshot import SmartPlugEnergySnapshot

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


# --- energy_tracking_available (#321) ---------------------------------------
# Per-print mode keeps these tests away from live plug reads; the flag itself
# doesn't depend on the mode.


async def _stats_in_print_mode(async_client: AsyncClient, db_session, **params):
    db_session.add(Settings(key="energy_tracking_mode", value="print"))
    await db_session.commit()
    return (await async_client.get("/api/v1/archives/stats", params=params)).json()


async def test_energy_tracking_unavailable_without_plugs_or_data(async_client: AsyncClient, db_session):
    body = await _stats_in_print_mode(async_client, db_session)

    assert body["energy_tracking_available"] is False
    assert (body["total_energy_kwh"], body["total_energy_cost"]) == (0, 0)


async def test_energy_tracking_unavailable_for_plugs_without_an_energy_source(async_client: AsyncClient, db_session):
    db_session.add_all(
        [
            # A Tasmota plug that has never reported a lifetime reading.
            SmartPlug(name="Switch only", plug_type="tasmota", ip_address="10.0.0.1"),
            SmartPlug(name="HA switch", plug_type="homeassistant", ha_entity_id="switch.p", ha_energy_total_entity=""),
            SmartPlug(name="MQTT state", plug_type="mqtt", mqtt_topic="p/1"),
            SmartPlug(name="REST switch", plug_type="rest", rest_on_url="http://10.0.0.4/on"),
            # Configured for energy but disabled, so it doesn't count.
            SmartPlug(
                name="Disabled HA",
                plug_type="homeassistant",
                ha_entity_id="switch.q",
                ha_energy_total_entity="sensor.q_total",
                enabled=False,
            ),
        ]
    )
    await db_session.commit()

    body = await _stats_in_print_mode(async_client, db_session)

    assert body["energy_tracking_available"] is False


@pytest.mark.parametrize(
    "plug",
    [
        {"plug_type": "homeassistant", "ha_entity_id": "switch.p", "ha_energy_today_entity": "sensor.p_today"},
        {"plug_type": "homeassistant", "ha_entity_id": "switch.p", "ha_energy_total_entity": "sensor.p_total"},
        {"plug_type": "mqtt", "mqtt_topic": "p/1", "mqtt_energy_topic": "p/1/energy"},
        {"plug_type": "rest", "rest_energy_url": "http://10.0.0.4/energy"},
        {"plug_type": "rest", "rest_energy_path": "data.today"},
        {"plug_type": "rest", "rest_energy_total_path": "data.total"},
    ],
    ids=["ha-today", "ha-total", "mqtt", "rest-url", "rest-path", "rest-total-path"],
)
async def test_energy_tracking_available_for_configured_energy_source(
    async_client: AsyncClient, db_session, plug: dict
):
    db_session.add(SmartPlug(name="Energy plug", **plug))
    await db_session.commit()

    body = await _stats_in_print_mode(async_client, db_session)

    assert body["energy_tracking_available"] is True


async def test_energy_tracking_available_once_a_plug_records_a_snapshot(async_client: AsyncClient, db_session):
    plug = SmartPlug(name="Metering Tasmota", plug_type="tasmota", ip_address="10.0.0.1")
    db_session.add(plug)
    await db_session.commit()
    db_session.add(SmartPlugEnergySnapshot(plug_id=plug.id, recorded_at=datetime(2026, 1, 1), lifetime_kwh=3.2))
    await db_session.commit()

    body = await _stats_in_print_mode(async_client, db_session)

    assert body["energy_tracking_available"] is True


async def test_energy_tracking_available_from_past_run_energy_even_when_filtered_to_zero(
    async_client: AsyncClient, db_session, printer_factory, archive_factory
):
    # The plug that measured this run has since been removed. Filtering to a
    # range with no runs gives 0 energy, but tracking is still set up, so the
    # UI keeps the tiles rather than hiding them.
    printer = await printer_factory()
    await archive_factory(printer.id, energy_kwh=1.2, energy_cost=0.3)

    body = await _stats_in_print_mode(async_client, db_session, date_from="2000-01-01", date_to="2000-01-31")

    assert (body["total_energy_kwh"], body["total_energy_cost"]) == (0, 0)
    assert body["energy_tracking_available"] is True

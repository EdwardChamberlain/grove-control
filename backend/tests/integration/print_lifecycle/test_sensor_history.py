"""Background recorders for AMS and printer sensor history, and AMS alarms.

Each test runs one pass of the recording loop: the first sleep (startup
delay) returns, the second (the interval) raises CancelledError, which is how
the loop stops at shutdown.
"""

import asyncio
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from backend.app import main
from backend.app.models.ams_history import AMSSensorHistory
from backend.app.models.printer_sensor_history import PrinterSensorHistory

pytestmark = pytest.mark.integration


async def _one_pass(recorder):
    with patch("backend.app.main.asyncio.sleep", AsyncMock(side_effect=[None, asyncio.CancelledError()])):
        await asyncio.wait_for(recorder(), timeout=5)


def _connected(raw_data=None, temperatures=None):
    return SimpleNamespace(connected=True, raw_data=raw_data or {}, temperatures=temperatures or {})


def _ams_unit(ams_id, humidity=None, temp=None, loaded=True, tray_type="PLA"):
    unit = {"id": str(ams_id), "tray_exist_bits": "1" if loaded else "0", "tray": [{"id": "0", "tray_type": tray_type}]}
    if humidity is not None:
        unit["humidity_raw"] = str(humidity)
    if temp is not None:
        unit["temp"] = str(temp)
    return unit


class TestAmsHistory:
    async def test_records_each_ams_unit(self, lifecycle):
        printer = await lifecycle.make_printer()
        lifecycle.printer_manager.get_status.return_value = _connected(
            {"ams": [_ams_unit(0, humidity=45, temp=28), _ams_unit(128, humidity=20, temp=50)]}
        )

        await _one_pass(main.record_ams_history)

        rows = sorted(await lifecycle.all(AMSSensorHistory), key=lambda r: r.ams_id)
        assert [(r.printer_id, r.ams_id, r.humidity, r.temperature) for r in rows] == [
            (printer.id, 0, 45.0, 28.0),
            (printer.id, 128, 20.0, 50.0),
        ]

    async def test_skips_disconnected_printers_and_units_without_readings(self, lifecycle):
        await lifecycle.make_printer()
        lifecycle.printer_manager.get_status.return_value = SimpleNamespace(connected=False, raw_data={"ams": []})

        await _one_pass(main.record_ams_history)

        assert await lifecycle.all(AMSSensorHistory) == []

    async def test_humidity_and_temperature_alarms(self, lifecycle):
        printer = await lifecycle.make_printer()
        await lifecycle.set_setting("ams_humidity_fair", "50")
        await lifecycle.set_setting("ams_temp_fair", "30")
        lifecycle.printer_manager.get_status.return_value = _connected({"ams": [_ams_unit(0, humidity=70, temp=40)]})

        await _one_pass(main.record_ams_history)

        humidity = lifecycle.notifications.on_ams_humidity_high.await_args.args
        assert humidity[:5] == (printer.id, "Lifecycle Printer", "AMS-A", 70.0, 50.0)
        temperature = lifecycle.notifications.on_ams_temperature_high.await_args.args
        assert temperature[:5] == (printer.id, "Lifecycle Printer", "AMS-A", 40.0, 30.0)

    async def test_alarms_respect_hourly_cooldown(self, lifecycle):
        await lifecycle.make_printer()
        lifecycle.printer_manager.get_status.return_value = _connected({"ams": [_ams_unit(0, humidity=90)]})

        await _one_pass(main.record_ams_history)
        await _one_pass(main.record_ams_history)

        assert lifecycle.notifications.on_ams_humidity_high.await_count == 1

    async def test_ams_ht_uses_its_own_alarms(self, lifecycle):
        await lifecycle.make_printer()
        lifecycle.printer_manager.get_status.return_value = _connected({"ams": [_ams_unit(129, humidity=90, temp=80)]})

        await _one_pass(main.record_ams_history)

        assert lifecycle.notifications.on_ams_ht_humidity_high.await_args.args[2] == "HT-B"
        lifecycle.notifications.on_ams_ht_temperature_high.assert_awaited_once()
        lifecycle.notifications.on_ams_humidity_high.assert_not_awaited()

    async def test_empty_ams_records_history_without_alarming(self, lifecycle):
        """Readings from an empty AMS are ambient (#1619)."""
        await lifecycle.make_printer()
        lifecycle.printer_manager.get_status.return_value = _connected(
            {"ams": [_ams_unit(0, humidity=90, loaded=False, tray_type="")]}
        )

        await _one_pass(main.record_ams_history)

        assert len(await lifecycle.all(AMSSensorHistory)) == 1
        lifecycle.notifications.on_ams_humidity_high.assert_not_awaited()

    async def test_per_filament_threshold_overrides_global(self, lifecycle):
        await lifecycle.make_printer()
        await lifecycle.set_setting("ams_humidity_thresholds", '{"tpu": 80, "default": 40}')
        lifecycle.printer_manager.get_status.return_value = _connected(
            {"ams": [_ams_unit(0, humidity=70, tray_type="TPU")]}
        )

        await _one_pass(main.record_ams_history)

        lifecycle.notifications.on_ams_humidity_high.assert_not_awaited()

    async def test_daily_cleanup_removes_old_rows(self, lifecycle):
        printer = await lifecycle.make_printer()
        await lifecycle.set_setting("ams_history_retention_days", "7")
        await lifecycle.add(
            AMSSensorHistory(
                printer_id=printer.id, ams_id=0, humidity=40, recorded_at=datetime.utcnow() - timedelta(days=8)
            )
        )
        lifecycle.printer_manager.get_status.return_value = _connected({"ams": [_ams_unit(0, humidity=40)]})

        with patch.object(main, "_ams_cleanup_counter", 287):
            await _one_pass(main.record_ams_history)

        [row] = await lifecycle.all(AMSSensorHistory)
        assert row.recorded_at > datetime.utcnow() - timedelta(days=1)


class TestPrinterSensorHistory:
    async def test_records_known_sensors_with_targets(self, lifecycle):
        printer = await lifecycle.make_printer()
        lifecycle.printer_manager.get_status.return_value = _connected(
            temperatures={"nozzle": 210.4, "nozzle_target": 220, "bed": 60, "chamber": "n/a", "other": 1}
        )

        await _one_pass(main.record_printer_sensor_history)

        rows = {r.sensor_kind: (r.printer_id, r.value, r.target) for r in await lifecycle.all(PrinterSensorHistory)}
        assert rows == {"nozzle": (printer.id, 210.4, 220.0), "bed": (printer.id, 60.0, None)}

    async def test_skips_disconnected_printers(self, lifecycle):
        await lifecycle.make_printer()
        lifecycle.printer_manager.get_status.return_value = SimpleNamespace(connected=False, temperatures={"bed": 60})

        await _one_pass(main.record_printer_sensor_history)

        assert await lifecycle.all(PrinterSensorHistory) == []

    async def test_daily_cleanup_removes_old_rows(self, lifecycle):
        printer = await lifecycle.make_printer()
        await lifecycle.add(
            PrinterSensorHistory(
                printer_id=printer.id, sensor_kind="bed", value=20, recorded_at=datetime.utcnow() - timedelta(days=31)
            )
        )
        lifecycle.printer_manager.get_status.return_value = SimpleNamespace(connected=False, temperatures={})

        with patch.object(main, "_printer_sensor_cleanup_counter", 10_000):
            await _one_pass(main.record_printer_sensor_history)

        assert await lifecycle.all(PrinterSensorHistory) == []

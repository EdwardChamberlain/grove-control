"""App startup and shutdown (main.lifespan) with every external service stubbed.

Catches an app that fails to boot, and gives access to the printer callbacks
lifespan registers (first layer, bed cooled, drying complete, tray change).
"""

from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.app import main
from backend.app.models.print_queue import PrintQueueItem

pytestmark = pytest.mark.integration

_START_STOP_FUNCS = (
    "start_ams_history_recording",
    "stop_ams_history_recording",
    "start_printer_sensor_history_recording",
    "stop_printer_sensor_history_recording",
    "start_runtime_tracking",
    "stop_runtime_tracking",
    "start_camera_cleanup",
    "stop_camera_cleanup",
    "start_connection_watchdog",
    "stop_connection_watchdog",
    "start_expected_prints_cleanup",
    "stop_expected_prints_cleanup",
    "start_auth_cleanup",
    "stop_auth_cleanup",
)


def _service(*async_methods):
    svc = MagicMock()
    for name in async_methods:
        setattr(svc, name, AsyncMock())
    return svc


@pytest.fixture
def boot(lifecycle):
    """Patch everything lifespan starts; yield the stubs for assertions."""

    @asynccontextmanager
    async def _begin():
        yield AsyncMock()

    engine = MagicMock(dispose=AsyncMock(), begin=_begin)
    stubs = SimpleNamespace(
        init_db=AsyncMock(),
        init_printer_connections=AsyncMock(),
        init_spoolman_client=AsyncMock(),
        plugs=_service("resume_pending_auto_offs", "on_drying_complete"),
        notifications=_service("on_first_layer_complete", "on_bed_cooled"),
        scheduler=_service("run"),
        virtual_printers=_service("sync_from_db", "stop_all"),
        engine=engine,
        funcs={name: MagicMock() for name in _START_STOP_FUNCS},
    )
    lifecycle.printer_manager.load_awaiting_plate_clear_from_db = AsyncMock()

    patches = [
        patch("backend.app.main.init_db", stubs.init_db),
        patch("backend.app.main.init_debug_logging", AsyncMock()),
        patch("backend.app.main.init_printer_connections", stubs.init_printer_connections),
        patch("backend.app.main.init_spoolman_client", stubs.init_spoolman_client),
        patch("backend.app.main.close_spoolman_client", AsyncMock()),
        patch("backend.app.main.smart_plug_manager", stubs.plugs),
        patch("backend.app.main.notification_service", stubs.notifications),
        patch("backend.app.main.print_scheduler", stubs.scheduler),
        patch("backend.app.main.ha_sensor_manager", MagicMock()),
        patch("backend.app.main.location_ha_sensor_manager", MagicMock()),
        patch("backend.app.main.github_backup_service", _service("start_scheduler")),
        patch("backend.app.main.local_backup_service", _service("start_scheduler")),
        patch("backend.app.main.obico_detection_service", _service("start")),
        patch("backend.app.main.library_trash_service", _service("start_scheduler")),
        patch("backend.app.main.temporary_files_service", _service("start_scheduler")),
        patch("backend.app.main.archive_purge_service", _service("start_scheduler")),
        patch("backend.app.main.mqtt_smart_plug_service", _service("disconnect")),
        patch("backend.app.main.engine", engine),
        patch("backend.app.services.virtual_printer.virtual_printer_manager", stubs.virtual_printers),
        patch("backend.app.services.loop_watchdog.start_loop_watchdog", MagicMock()),
        patch("backend.app.services.loop_watchdog.stop_loop_watchdog", MagicMock()),
        patch("backend.app.services.camera_fanout.shutdown_all_broadcasters", AsyncMock()),
        *(patch(f"backend.app.main.{name}", mock) for name, mock in stubs.funcs.items()),
    ]
    for p in patches:
        p.start()
    try:
        yield stubs
    finally:
        for p in reversed(patches):
            p.stop()


def _callback(lifecycle, setter):
    return getattr(lifecycle.printer_manager, setter).call_args.args[0]


async def test_startup_wires_callbacks_and_shutdown_stops_everything(lifecycle, boot):
    async with main.lifespan(main.app):
        boot.init_db.assert_awaited_once()
        boot.init_printer_connections.assert_awaited_once()
        assert _callback(lifecycle, "set_print_start_callback") is main.on_print_start
        assert _callback(lifecycle, "set_print_complete_callback") is main.on_print_complete
        assert _callback(lifecycle, "set_ams_change_callback") is main.on_ams_change
        assert _callback(lifecycle, "set_status_change_callback") is main.on_printer_status_change
        boot.plugs.start_scheduler.assert_called_once()
        boot.plugs.resume_pending_auto_offs.assert_awaited_once()
        boot.virtual_printers.sync_from_db.assert_awaited_once()
        for name in _START_STOP_FUNCS:
            if name.startswith("start_"):
                boot.funcs[name].assert_called_once()
        # No MQTT relay configured by default.
        assert lifecycle.relay.configure.await_args.args[0]["mqtt_enabled"] is False

    boot.scheduler.stop.assert_called_once()
    boot.plugs.stop_scheduler.assert_called_once()
    lifecycle.printer_manager.disconnect_all.assert_called_once()
    boot.virtual_printers.stop_all.assert_awaited_once()
    lifecycle.relay.disconnect.assert_awaited_once()
    boot.engine.dispose.assert_awaited_once()
    for name in _START_STOP_FUNCS:
        if name.startswith("stop_"):
            boot.funcs[name].assert_called_once()


async def test_startup_repairs_queue_items_left_as_aborted(lifecycle, boot):
    printer = await lifecycle.make_printer()
    item = await lifecycle.add(PrintQueueItem(printer_id=printer.id, status="aborted", position=1))

    async with main.lifespan(main.app):
        pass

    assert (await lifecycle.get(PrintQueueItem, item.id)).status == "cancelled"


async def test_startup_configures_mqtt_relay_and_restores_mqtt_plugs(lifecycle, boot):
    from backend.app.models.smart_plug import SmartPlug

    await lifecycle.set_setting("mqtt_enabled", "true")
    await lifecycle.set_setting("mqtt_broker", "broker.local")
    await lifecycle.set_setting("mqtt_port", "8883")
    await lifecycle.add(SmartPlug(name="MQTT plug", plug_type="mqtt", mqtt_topic="plug/1"))
    subscribe = MagicMock(return_value=True)

    with patch("backend.app.services.mqtt_smart_plug.subscribe_plug_to_mqtt", subscribe):
        async with main.lifespan(main.app):
            pass

    settings = lifecycle.relay.configure.await_args.args[0]
    assert (settings["mqtt_enabled"], settings["mqtt_broker"], settings["mqtt_port"]) == (True, "broker.local", 8883)
    assert subscribe.call_args.args[1].name == "MQTT plug"


async def test_startup_connects_to_spoolman_and_registers_extra_fields(lifecycle, boot):
    await lifecycle.set_setting("spoolman_enabled", "true")
    await lifecycle.set_setting("spoolman_url", "http://spoolman.local:7912")
    client = _service("health_check", "ensure_tag_extra_field", "ensure_extra_field")
    client.health_check.return_value = True
    client.ensure_tag_extra_field.return_value = True
    client.ensure_extra_field.return_value = True
    boot.init_spoolman_client.return_value = client

    async with main.lifespan(main.app):
        pass

    boot.init_spoolman_client.assert_awaited_once_with("http://spoolman.local:7912")
    client.ensure_tag_extra_field.assert_awaited_once()
    assert [c.args[0] for c in client.ensure_extra_field.await_args_list] == [
        "bambu_slicer_filament",
        "bambu_slicer_filament_name",
    ]


class TestCallbacksRegisteredAtStartup:
    async def test_first_layer_notification_sent_once(self, lifecycle, boot):
        printer = await lifecycle.make_printer()
        lifecycle.client.state = SimpleNamespace(subtask_name="Benchy", gcode_file="", total_layers=120)

        with patch("backend.app.services.layer_timelapse.on_layer_change", AsyncMock()) as timelapse:
            async with main.lifespan(main.app):
                on_layer_change = _callback(lifecycle, "set_layer_change_callback")
                await on_layer_change(printer.id, 2)
                await on_layer_change(printer.id, 3)

        assert timelapse.await_count == 2
        boot.notifications.on_first_layer_complete.assert_awaited_once()
        args = boot.notifications.on_first_layer_complete.await_args.args
        assert args[:4] == (printer.id, "Lifecycle Printer", "Benchy", 120)

    async def test_bed_cooled_notification_fires_once_below_threshold(self, lifecycle, boot):
        printer = await lifecycle.make_printer()

        async with main.lifespan(main.app):
            on_bed_temp = _callback(lifecycle, "set_bed_temp_update_callback")
            main._bed_cool_waiters[printer.id] = {"threshold": 35.0, "filename": "Benchy", "registered_at": 0}
            await on_bed_temp(printer.id, 50.0)
            boot.notifications.on_bed_cooled.assert_not_awaited()
            await on_bed_temp(printer.id, 34.0)
            await on_bed_temp(printer.id, 30.0)

        kwargs = boot.notifications.on_bed_cooled.await_args.kwargs
        assert boot.notifications.on_bed_cooled.await_count == 1
        assert (kwargs["printer_id"], kwargs["bed_temp"], kwargs["filename"]) == (printer.id, 34.0, "Benchy")
        assert printer.id not in main._bed_cool_waiters

    async def test_drying_complete_schedules_plug_auto_off(self, lifecycle, boot):
        async with main.lifespan(main.app):
            on_drying_complete = _callback(lifecycle, "set_drying_complete_callback")
            await on_drying_complete(7, 0)

        assert boot.plugs.on_drying_complete.await_args.args[0] == 7

    async def test_tray_change_is_persisted(self, lifecycle, boot):
        record = AsyncMock()

        with patch("backend.app.services.usage_tracker.record_tray_change", record):
            async with main.lifespan(main.app):
                on_tray_change = _callback(lifecycle, "set_tray_change_callback")
                await on_tray_change(3, 2, 150)

        assert record.await_args.args[1:] == (3, 2, 150)

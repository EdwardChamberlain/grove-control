"""BambuMQTTClient._on_message / _process_message: routing incoming messages."""

import json
import logging
import time
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from backend.app.services.bambu_mqtt import BambuMQTTClient

SERIAL = "01P00A000000001"


@pytest.fixture
def client():
    c = BambuMQTTClient(ip_address="192.168.1.50", serial_number=SERIAL, access_code="1", model="X1C")
    c._client = MagicMock()
    return c


def _msg(payload, topic=f"device/{SERIAL}/report"):
    raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    return SimpleNamespace(topic=topic, payload=raw)


class TestOnMessage:
    def test_report_message_marks_connected_and_is_processed(self, client):
        client._on_message(None, None, _msg({"print": {"gcode_state": "RUNNING"}}))

        assert client.state.connected is True
        assert client.state.state == "RUNNING"
        assert client._report_messages_since_connect == 1
        assert client._last_message_time > 0

    def test_raw_handlers_run_and_a_crash_does_not_stop_processing(self, client):
        seen = []
        client._raw_message_handlers.append(lambda topic, payload: (_ for _ in ()).throw(RuntimeError("boom")))
        client._raw_message_handlers.append(lambda topic, payload: seen.append(topic))

        client._on_message(None, None, _msg({"print": {"gcode_state": "IDLE"}}))

        assert seen == [f"device/{SERIAL}/report"]
        assert client.state.state == "IDLE"

    def test_non_utf8_payload_is_still_parsed(self, client):
        payload = b'{"print": {"subtask_name": "Bad\xff Name"}}'

        client._on_message(None, None, _msg(payload))

        assert client.state.subtask_name == "Bad� Name"

    def test_non_json_payload_is_ignored(self, client):
        client._on_message(None, None, _msg(b"\x00\x01binary"))
        assert client.state.connected is False

    def test_request_topic_captures_ams_mapping_without_processing(self, client):
        command = {"print": {"command": "project_file", "ams_mapping": [0, 2], "sequence_id": "1", "gcode_state": "X"}}

        client._on_message(None, None, _msg(command, topic=f"device/{SERIAL}/request"))

        assert client._captured_ams_mapping == [0, 2]
        assert client.state.state != "X"
        assert client._report_messages_since_connect == 0

    def test_message_log_when_enabled(self, client):
        client._logging_enabled = True

        client._on_message(None, None, _msg({"print": {"spd_lvl": 2}}))

        [entry] = client._message_log
        assert (entry.direction, entry.payload) == ("in", {"print": {"spd_lvl": 2}})


class TestTopLevelSections:
    def test_top_level_xcam_fires_state_change(self, client):
        client.on_state_change = MagicMock()

        client._process_message({"xcam": {"printing_monitor": True}})

        assert client.state.print_options.printing_monitor is True
        client.on_state_change.assert_called_once_with(client.state)

    def test_system_and_version_info_are_dispatched(self, client):
        with (
            patch.object(client, "_handle_system_response") as system,
            patch.object(client, "_handle_version_info") as version,
        ):
            client._process_message({"system": {"command": "x"}, "info": {"command": "get_version", "module": []}})
            client._process_message({"info": {"command": "something_else"}})

        system.assert_called_once_with({"command": "x"})
        version.assert_called_once()

    @pytest.mark.parametrize(("raw", "dbm", "wired"), [(-60, -60, False), ("-90dBm", -90, True), ("weak", None, False)])
    def test_top_level_wifi_signal(self, client, raw, dbm, wired):
        client._process_message({"wifi_signal": raw})

        assert client.state.wifi_signal == dbm
        assert client.state.wired_network is wired

    @pytest.mark.parametrize(("fun", "developer"), [(0, True), ("20000000", False), ("zz", None)])
    def test_developer_mode_from_fun(self, client, fun, developer):
        client.state.developer_mode = None

        client._process_message({"fun": fun})

        assert client.state.developer_mode is developer

    def test_ams_handler_errors_do_not_break_processing(self, client):
        with patch.object(client, "_handle_ams_data", side_effect=RuntimeError("bad ams")):
            client._process_message({"ams": {}, "print": {"ams": {}, "gcode_state": "PAUSE"}})

        assert client.state.state == "PAUSE"


class TestPrintSection:
    def test_xcam_nested_in_print(self, client):
        client._process_message({"print": {"xcam": {"allow_skip_parts": True}}})
        assert client.state.print_options.allow_skip_parts is True

    def test_filament_backup_from_cfg_bit_18(self, client):
        client._process_message({"print": {"cfg": format(1 << 18, "x")}})
        assert client.state.ams_filament_backup is True

    def test_filament_backup_push_ignored_during_hold(self, client):
        client.state.ams_filament_backup = True
        client._xcam_hold_start["print_option_auto_switch_filament"] = time.time()

        client._process_message({"print": {"cfg": "0"}})

        assert client.state.ams_filament_backup is True

    def test_detects_dual_nozzle_printer(self, client):
        client._process_message({"print": {"device": {"extruder": {"info": [{"id": 0}, {"id": 1}]}}}})
        assert client._is_dual_nozzle is True

    def test_single_external_slot_is_remapped_to_254(self, client):
        client._process_message({"print": {"vir_slot": [{"id": "255", "tray_type": "PLA"}]}})
        assert client.state.raw_data["vt_tray"] == [{"id": "254", "tray_type": "PLA"}]

    def test_vt_tray_dict_does_not_overwrite_dual_external_slots(self, client):
        client._process_message({"print": {"vir_slot": [{"id": "254"}, {"id": "255"}]}})
        client._process_message({"print": {"vt_tray": {"id": "254", "tray_type": "PETG"}}})

        assert [s["id"] for s in client.state.raw_data["vt_tray"]] == ["254", "255"]

    def test_vt_tray_dict_wrapped_in_list(self, client):
        client._process_message({"print": {"vt_tray": {"id": "254", "tray_type": "PETG"}}})
        assert client.state.raw_data["vt_tray"] == [{"id": "254", "tray_type": "PETG"}]

    def test_external_spool_change_fires_ams_callback_once(self, client):
        client.on_ams_change = MagicMock()
        spool = {"id": "254", "tray_type": "PLA", "tray_color": "FF0000FF", "remain": 80}

        client._process_message({"print": {"vt_tray": spool}})
        client._process_message({"print": {"vt_tray": {**spool, "remain": 79}}})
        client._process_message({"print": {"vt_tray": {**spool, "tray_type": "PETG"}}})

        assert client.on_ams_change.call_count == 2

    @pytest.mark.parametrize(("raw", "main", "sub"), [(0x0103, 1, 3), ("259", 1, 3), ("x", 0, 0), (None, 0, 0)])
    def test_ams_status_split_into_main_and_sub(self, client, raw, main, sub):
        client._process_message({"print": {"ams_status": raw}})
        assert (client.state.ams_status_main, client.state.ams_status_sub) == (main, sub)


class TestCommandResponses:
    def test_k_profile_write_ack_is_recorded(self, client):
        client._pending_cali_acks["12"] = None
        response = {"command": "extrusion_cali_set", "result": "success", "sequence_id": "12"}

        client._process_message({"print": response})

        assert client._pending_cali_acks["12"] == response

    def test_ams_setting_response_resets_zombie_counters(self, client):
        client._last_ams_cmd_time = 123.0
        client._ams_cmd_unanswered = 1

        client._process_message({"print": {"command": "ams_filament_setting", "sequence_id": "5"}})

        assert (client._last_ams_cmd_time, client._ams_cmd_unanswered) == (0.0, 0)

    def test_developer_mode_probe_response(self, client):
        client._dev_mode_probe_seq = "999"

        with patch.object(client, "_handle_dev_mode_probe_response") as probe:
            client._process_message({"print": {"command": "ams_filament_setting", "sequence_id": "999"}})

        probe.assert_called_once()

    def test_k_profile_list_does_not_clobber_nozzle_size(self, client):
        """The response echoes the requested diameter, not the hardware (#2663)."""
        client.state.nozzles[0].nozzle_diameter = "0.4"

        client._process_message({"print": {"command": "extrusion_cali_get", "nozzle_diameter": "0.8", "filaments": []}})

        assert client.state.nozzles[0].nozzle_diameter == "0.4"

    def test_drying_response_is_logged(self, client, caplog):
        caplog.set_level(logging.INFO, logger="backend.app.services.bambu_mqtt")
        client._process_message({"print": {"command": "ams_filament_drying", "result": "fail", "reason": "x"}})
        assert "ams_filament_drying response" in caplog.text

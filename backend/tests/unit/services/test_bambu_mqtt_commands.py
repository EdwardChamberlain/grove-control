"""BambuMQTTClient commands, xcam settings, version info and K-profiles.

Commands are checked by the JSON they publish, since that is what the
printer firmware sees.
"""

import asyncio
import json
import time
from unittest.mock import MagicMock, patch

import pytest

from backend.app.services.bambu_mqtt import BambuMQTTClient


@pytest.fixture
def client():
    c = BambuMQTTClient(ip_address="192.168.1.50", serial_number="01P00A000000001", access_code="1", model="P1S")
    c._client = MagicMock()
    c.state.connected = True
    return c


def published(client):
    """Every payload published so far, decoded."""
    return [json.loads(call.args[1]) for call in client._client.publish.call_args_list]


def last(client):
    return published(client)[-1]


@pytest.mark.parametrize(
    "command",
    [
        lambda c: c.set_print_speed(2),
        lambda c: c.set_airduct_mode("cooling"),
        lambda c: c.set_chamber_light(True),
        lambda c: c.select_extruder(0),
        lambda c: c.ams_control("resume"),
        lambda c: c.ams_refresh_tray(0, 0)[0],
        lambda c: c.set_timelapse(True),
        lambda c: c.skip_objects([1]),
        lambda c: c.start_calibration(bed_leveling=True),
        lambda c: c.set_xcam_option("printing_monitor", True),
        lambda c: c.extrusion_cali_sel(0, 0, 1, "GFA00"),
        lambda c: c.set_kprofile("GFA00", "PLA", "0.02") is not None,
        lambda c: c.set_kprofiles_batch([{"name": "x"}]) is not None,
    ],
)
def test_commands_refuse_when_disconnected(client, command):
    client.state.connected = False

    assert command(client) is False
    client._client.publish.assert_not_called()


class TestSimpleCommands:
    @pytest.mark.parametrize("mode", [1, 4])
    def test_print_speed(self, client, mode):
        assert client.set_print_speed(mode) is True
        assert last(client) == {"print": {"command": "print_speed", "param": str(mode), "sequence_id": "0"}}

    def test_invalid_print_speed(self, client):
        assert client.set_print_speed(9) is False

    @pytest.mark.parametrize(("mode", "mode_id"), [("cooling", 0), ("heating", 1)])
    def test_airduct_mode(self, client, mode, mode_id):
        client.set_airduct_mode(mode)
        assert last(client)["print"]["modeId"] == mode_id
        assert last(client)["print"]["command"] == "set_airduct"

    def test_chamber_light_controls_both_light_nodes(self, client):
        client.set_chamber_light(False)
        assert [(p["system"]["led_node"], p["system"]["led_mode"]) for p in published(client)] == [
            ("chamber_light", "off"),
            ("chamber_light2", "off"),
        ]

    def test_select_extruder(self, client):
        assert client.select_extruder(1) is True
        assert last(client)["print"]["extruder_index"] == 1
        assert client.select_extruder(2) is False

    def test_ams_control(self, client):
        assert client.ams_control("pause") is True
        assert last(client)["print"] == {"command": "ams_control", "param": "pause", "sequence_id": "0"}
        assert client.ams_control("explode") is False

    def test_timelapse_sends_gcode_then_requests_status(self, client):
        client.set_timelapse(True)
        gcode, pushall = published(client)
        assert gcode["print"]["param"] == "M981 S1 P20000"
        assert pushall == {"pushing": {"command": "pushall", "sequence_id": "0"}}


class TestRfidRefresh:
    @pytest.mark.parametrize(
        ("tray_now", "loaded"),
        [(5, "AMS 2 slot 2"), (254, "external spool"), (200, "tray 200")],
    )
    def test_refuses_while_filament_is_loaded(self, client, tray_now, loaded):
        client.state.tray_now = tray_now

        ok, message = client.ams_refresh_tray(0, 1)

        assert ok is False
        assert message == f"Please unload filament first. Currently loaded: {loaded}"
        client._client.publish.assert_not_called()

    def test_requests_rfid_read(self, client):
        client.state.tray_now = 255

        ok, message = client.ams_refresh_tray(1, 3)

        assert (ok, message) == (True, "Refreshing AMS 1 tray 3")
        assert last(client)["print"] == {"command": "ams_get_rfid", "ams_id": 1, "slot_id": 3, "sequence_id": "0"}


class TestSkipObjects:
    def test_requires_a_running_print(self, client):
        client.state.state = "IDLE"
        assert client.skip_objects([1]) is False

    @pytest.mark.parametrize("ids", [[], ["abc"]])
    def test_rejects_missing_or_invalid_ids(self, client, ids):
        client.state.state = "RUNNING"
        assert client.skip_objects(ids) is False

    def test_sends_ids_and_tracks_them(self, client):
        client.state.state = "PAUSE"
        client.state.skipped_objects = [7]

        assert client.skip_objects([7, "8"]) is True

        assert last(client)["print"]["obj_list"] == [7, 8]
        assert client.state.skipped_objects == [7, 8]


class TestCalibration:
    def test_nothing_selected(self, client):
        assert client.start_calibration() is False

    def test_option_bitmask(self, client):
        client.start_calibration(
            bed_leveling=True, vibration=True, motor_noise=True, nozzle_offset=True, high_temp_heatbed=True
        )
        assert last(client)["print"]["option"] == 0b111110


class TestXcamOptions:
    def test_spaghetti_sets_both_linked_sensitivities(self, client):
        client.set_xcam_option("spaghetti_detector", True, print_halt=False, sensitivity="high")

        xcam = last(client)["xcam"]
        assert (xcam["module_name"], xcam["control"], xcam["print_halt"], xcam["halt_print_sensitivity"]) == (
            "spaghetti_detector",
            True,
            True,  # always true on the wire
            "high",
        )
        opts = client.state.print_options
        assert (opts.spaghetti_detector, opts.print_halt) == (True, False)
        assert opts.halt_print_sensitivity == opts.pileup_sensitivity == "high"
        assert {"spaghetti_detector", "halt_print_sensitivity", "pileup_sensitivity"} <= set(client._xcam_hold_start)

    def test_never_halt_omits_sensitivity(self, client):
        client.set_xcam_option("clump_detector", True, sensitivity="never_halt")
        assert "halt_print_sensitivity" not in last(client)["xcam"]

    @pytest.mark.parametrize(
        ("module", "attr"),
        [
            ("first_layer_inspector", "first_layer_inspector"),
            ("printing_monitor", "printing_monitor"),
            ("buildplate_marker_detector", "buildplate_marker_detector"),
            ("allow_skip_parts", "allow_skip_parts"),
            ("pileup_detector", "pileup_detector"),
            ("clump_detector", "nozzle_clumping_detector"),
            ("airprint_detector", "airprint_detector"),
        ],
    )
    def test_updates_local_state_immediately(self, client, module, attr):
        client.set_xcam_option(module, True, sensitivity="low")
        assert getattr(client.state.print_options, attr) is True

    def test_clump_and_airprint_sensitivities(self, client):
        client.set_xcam_option("clump_detector", True, sensitivity="low")
        client.set_xcam_option("airprint_detector", True, sensitivity="high")
        assert client.state.print_options.nozzle_clumping_sensitivity == "low"
        assert client.state.print_options.airprint_sensitivity == "high"

    def test_auto_recovery_uses_print_option_command(self, client):
        with patch.object(client, "_set_print_option", return_value=True) as print_option:
            assert client.set_xcam_option("auto_recovery_step_loss", True) is True
        print_option.assert_called_once_with("auto_recovery", True)


def _cfg(spaghetti=(True, 2), pileup=(False, 0), clump=(True, 1), airprint=(False, 2)):
    value = 0
    for start, (enabled, sens) in zip((5, 8, 11, 14), (spaghetti, pileup, clump, airprint), strict=True):
        value |= sens << start
        value |= int(enabled) << (start + 2)
    return value


class TestXcamParsing:
    def test_cfg_bitmask_is_the_source_of_truth(self, client):
        client._parse_xcam_data({"cfg": _cfg(), "spaghetti_detector": False})

        opts = client.state.print_options
        assert (opts.spaghetti_detector, opts.halt_print_sensitivity) == (True, "high")
        assert (opts.pileup_detector, opts.pileup_sensitivity) == (False, "low")
        assert (opts.nozzle_clumping_detector, opts.nozzle_clumping_sensitivity) == (True, "medium")
        assert (opts.airprint_detector, opts.airprint_sensitivity) == (False, "high")

    def test_values_held_for_three_seconds_after_a_command(self, client):
        client.set_xcam_option("spaghetti_detector", False, sensitivity="low")
        client.set_xcam_option("clump_detector", False, sensitivity="low")
        client.set_xcam_option("airprint_detector", True, sensitivity="low")

        client._parse_xcam_data({"cfg": _cfg(spaghetti=(True, 2), clump=(True, 2), airprint=(False, 2))})

        opts = client.state.print_options
        assert (opts.spaghetti_detector, opts.halt_print_sensitivity) == (False, "low")
        assert (opts.nozzle_clumping_detector, opts.nozzle_clumping_sensitivity) == (False, "low")
        assert (opts.airprint_detector, opts.airprint_sensitivity) == (True, "low")

    def test_values_accepted_once_hold_expires(self, client):
        client.set_xcam_option("spaghetti_detector", False, sensitivity="low")
        client.set_xcam_option("clump_detector", False, sensitivity="low")
        client.set_xcam_option("airprint_detector", True, sensitivity="low")
        expired = time.time() - client._xcam_hold_time - 1
        client._xcam_hold_start = dict.fromkeys(client._xcam_hold_start, expired)

        client._parse_xcam_data(
            {"cfg": _cfg(spaghetti=(True, 2), pileup=(True, 2), clump=(True, 2), airprint=(False, 2))}
        )

        opts = client.state.print_options
        assert (opts.spaghetti_detector, opts.halt_print_sensitivity, opts.pileup_sensitivity) == (True, "high", "high")
        assert (opts.nozzle_clumping_sensitivity, opts.airprint_sensitivity) == ("high", "high")
        assert client._xcam_hold_start == {}

    def test_boolean_fields_and_camera_settings(self, client):
        client._was_running = True
        client._parse_xcam_data(
            {
                "ipcam_record": "enable",
                "timelapse": "enable",
                "print_halt": 1,
                "first_layer_inspector": True,
                "printing_monitor": True,
                "buildplate_marker_detector": True,
                "allow_skip_parts": True,
                "auto_recovery_step_loss": True,
                "filament_tangle_detect": True,
            }
        )

        opts = client.state.print_options
        assert client.state.ipcam and client.state.timelapse and client._timelapse_during_print
        assert all(
            (
                opts.print_halt,
                opts.first_layer_inspector,
                opts.printing_monitor,
                opts.buildplate_marker_detector,
                opts.allow_skip_parts,
                opts.auto_recovery_step_loss,
                opts.filament_tangle_detect,
            )
        )

    def test_non_dict_is_ignored(self, client):
        client._parse_xcam_data(["not", "a", "dict"])


class TestVersionInfo:
    def test_firmware_and_ams_versions(self, client):
        client.on_state_change = MagicMock()
        client.state.raw_data = {"ams": [{"id": "0"}, {"id": "128", "sn": "EXISTING"}]}

        client._handle_version_info(
            {
                "module": [
                    {"name": "ota", "sw_ver": "01.08.05.00"},
                    {"name": "ams/0", "sw_ver": "00.00.06.96", "sn": "AMS0SN"},
                    {"name": "n3s/128", "sw_ver": "03.00.21.29", "sn": "HTSN"},
                    {"name": "ams/x"},
                    "junk",
                ]
            }
        )

        assert client.state.firmware_version == "01.08.05.00"
        ams0, ht = client.state.raw_data["ams"]
        assert (ams0["sw_ver"], ams0["sn"], ams0["module_type"]) == ("00.00.06.96", "AMS0SN", "ams")
        # An SN already reported in AMS status is kept.
        assert (ht["sw_ver"], ht["sn"], ht["module_type"]) == ("03.00.21.29", "EXISTING", "n3s")
        client.on_state_change.assert_called_once()

    def test_versions_cached_until_ams_status_arrives(self, client):
        client._handle_version_info({"module": [{"name": "n3f/1", "sw_ver": "03.00.21.29", "sn": "PROSN"}]})

        units = [{"id": "1"}, {"id": "2"}, {"id": None}, "junk"]
        client._apply_ams_version_cache(units)

        assert units[0] == {"id": "1", "sw_ver": "03.00.21.29", "sn": "PROSN", "module_type": "n3f"}
        assert units[1] == {"id": "2"}

    def test_cache_does_not_overwrite_reported_values(self, client):
        client._ams_version_cache = {0: {"sw_ver": "new", "sn": "new", "module_type": "ams"}}
        units = [{"id": 0, "sw_ver": "old", "serial_number": "kept", "module_type": "n3f"}]

        client._apply_ams_version_cache(units)

        assert units[0] == {"id": 0, "sw_ver": "old", "serial_number": "kept", "module_type": "n3f"}

    def test_missing_versions_warned_once(self, client, caplog):
        client.state.raw_data = {"ams": [{"id": "0"}]}

        client._handle_version_info({"module": []})
        client._handle_version_info({"module": []})

        assert caplog.text.count("serial number not available") == 1
        assert caplog.text.count("firmware version not available") == 1


class TestKProfiles:
    PROFILE = {
        "cali_idx": 3,
        "extruder_id": 0,
        "nozzle_id": "HS00-0.4",
        "nozzle_diameter": "0.4",
        "filament_id": "GFA00",
        "name": "PLA Basic",
        "k_value": "0.020000",
        "setting_id": "PF123",
    }

    def test_broadcast_updates_profiles_without_a_request(self, client):
        client._handle_kprofile_response({"nozzle_diameter": "0.4", "filaments": [self.PROFILE, {"ams_id": "bad"}]})

        [profile] = client.state.kprofiles
        assert (profile.slot_id, profile.name, profile.k_value) == (3, "PLA Basic", "0.020000")

    async def test_request_waits_for_matching_nozzle_response(self, client):
        def respond(topic, payload, qos):
            request = json.loads(payload)["print"]
            # The printer broadcasts 0.4 profiles constantly; ignored while waiting for 0.6.
            client._handle_kprofile_response({"nozzle_diameter": "0.4", "filaments": [self.PROFILE]})
            client._handle_kprofile_response(
                {
                    "nozzle_diameter": request["nozzle_diameter"],
                    "filaments": [{**self.PROFILE, "nozzle_diameter": "0.6"}],
                }
            )

        client._client.publish.side_effect = respond

        profiles = await client.get_kprofiles("0.6", timeout=1)

        assert [p.nozzle_diameter for p in profiles] == ["0.6"]
        assert last(client)["print"]["command"] == "extrusion_cali_get"
        assert client._pending_kprofile_response is None

    async def test_request_retries_then_gives_up(self, client):
        with patch("backend.app.services.bambu_mqtt.asyncio.sleep", side_effect=lambda _s: asyncio.sleep(0)):
            profiles = await client.get_kprofiles("0.4", timeout=0.01, max_retries=2)

        assert profiles == []
        assert client._client.publish.call_count == 2

    def test_set_kprofile_new_profile(self, client):
        seq = client.set_kprofile("GFA00", "PLA", "0.025000")

        command = last(client)["print"]
        [entry] = command["filaments"]
        assert command["sequence_id"] == seq
        assert (entry["cali_idx"], entry["tray_id"], entry["k_value"]) == (-1, 0, "0.025000")
        assert entry["setting_id"].startswith("PF") and len(entry["setting_id"]) == 19
        assert seq in client._pending_cali_acks

    def test_set_kprofile_edit_keeps_slot(self, client):
        client.set_kprofile("GFA00", "PLA", "0.03", slot_id=4, setting_id="PF1", cali_idx=6)

        [entry] = last(client)["print"]["filaments"]
        assert (entry["cali_idx"], entry["setting_id"]) == (6, "PF1")

    def test_batch(self, client):
        client.set_kprofiles_batch(
            [
                {"name": "Left", "extruder_id": 1, "slot_id": 0},
                {"name": "Right", "slot_id": 5, "setting_id": "PF9", "cali_idx": 2},
            ],
            nozzle_diameter="0.6",
        )

        left, right = last(client)["print"]["filaments"]
        assert (left["cali_idx"], left["extruder_id"], left["nozzle_id"]) == (-1, 1, "HS00-0.6")
        assert left["setting_id"].startswith("PF")
        assert (right["cali_idx"], right["setting_id"]) == (2, "PF9")

    async def test_ack_success_and_failure(self, client):
        client._pending_cali_acks["5"] = {"result": "success"}
        client._pending_cali_acks["6"] = {"result": "fail", "reason": "invalid tray_id"}

        assert await client.await_cali_ack("5", timeout=1) == (True, "")
        assert await client.await_cali_ack("6", timeout=1) == (False, "invalid tray_id")

    async def test_ack_timeout(self, client):
        client._pending_cali_acks["7"] = None
        assert await client.await_cali_ack("7", timeout=0.01) == (False, "no acknowledgement from printer")
        assert "7" not in client._pending_cali_acks


class TestExtrusionCaliSel:
    @pytest.mark.parametrize(
        ("ams_id", "tray_id", "vt_tray", "wire"),
        [
            (1, 2, [], (1, 6, 2)),  # global tray id = ams * 4 + slot
            (255, 0, [{"id": "254"}], (254, 254, 0)),  # single external slot
            (255, 1, [{"id": "254"}, {"id": "255"}], (255, 255, 0)),  # H2D right external slot
            (128, 0, [], (128, 0, 0)),  # AMS HT
        ],
    )
    def test_ids_on_the_wire(self, client, ams_id, tray_id, vt_tray, wire):
        client.state.raw_data = {"vt_tray": vt_tray}

        client.extrusion_cali_sel(ams_id, tray_id, cali_idx=4, filament_id="GFA00")

        command = last(client)["print"]
        assert (command["ams_id"], command["tray_id"], command["slot_id"]) == wire
        assert command["cali_idx"] == 4
        assert "setting_id" not in command

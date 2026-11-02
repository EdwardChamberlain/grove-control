"""BambuMQTTClient._update_state: turning raw push_status fields into state.

Covers the field decoding that the rest of the app relies on: fan levels,
encoded heater values (target * 65536 + current), dual-nozzle H2D data,
chamber and airduct, HMS and print_error codes, SD card / door flags and
assorted status fields.
"""

from unittest.mock import MagicMock

import pytest

from backend.app.services.bambu_mqtt import BambuMQTTClient


def enc(target: int, current: int) -> int:
    """Bambu's encoded heater value: target in the high word, current in the low."""
    return target * 65536 + current


@pytest.fixture
def client():
    return BambuMQTTClient(
        ip_address="192.168.1.50", serial_number="01P00A000000001", access_code="12345678", model="P1S"
    )


def _client(model):
    return BambuMQTTClient(ip_address="192.168.1.50", serial_number="00M00A000000001", access_code="1", model=model)


class TestProgressAndLayers:
    def test_layer_increase_fires_callback_and_remembers_last_layer(self, client):
        client.on_layer_change = MagicMock()

        client._update_state({"layer_num": 3})
        client._update_state({"layer_num": 4})
        client._update_state({"layer_num": 0})  # firmware reset on cancel

        assert [c.args[0] for c in client.on_layer_change.call_args_list] == [3, 4]
        assert client._last_valid_layer_num == 4

    def test_total_layers_survive_a_zero_reset(self, client):
        client._update_state({"total_layer_num": 250})
        client._update_state({"total_layer_num": 0})

        assert client.state.total_layers == 250

    def test_progress_remembers_last_non_zero_value(self, client):
        client._update_state({"mc_percent": 37})
        client._update_state({"mc_percent": 0})

        assert client._last_valid_progress == 37.0

    def test_sub_stage_and_remaining_time(self, client):
        client._update_state({"mc_print_sub_stage": 4, "mc_remaining_time": 42})

        assert client.state.mc_print_sub_stage == 4
        assert client.state.remaining_time == 42


@pytest.mark.parametrize(
    ("raw", "percent"),
    [("15", 100), ("7", 47), ("0", 0), (128, 50), (255, 100), (300, 300), ("fast", None)],
)
def test_fan_speed_levels_become_percentages(client, raw, percent):
    client._update_state(
        {"cooling_fan_speed": raw, "big_fan1_speed": raw, "big_fan2_speed": raw, "heatbreak_fan_speed": raw}
    )

    state = client.state
    assert (state.cooling_fan_speed, state.big_fan1_speed, state.big_fan2_speed, state.heatbreak_fan_speed) == (
        percent,
    ) * 4


class TestFinishPhotoMoment:
    """Stage 22 (filament unload) at the end of a print is the moment to
    grab the finish photo (#1721)."""

    def _running(self, client, **state):
        client.on_finish_photo_moment = MagicMock()
        client._was_running = True
        client.state.subtask_name = "Benchy"
        client.state.gcode_file = "/data/Metadata/plate_1.gcode"
        for key, value in state.items():
            setattr(client.state, key, value)

    def test_fires_once_at_end_of_print(self, client):
        self._running(client, progress=99.0, remaining_time=1)

        client._update_state({"stg_cur": 22})
        client._update_state({"stg_cur": 22})

        client.on_finish_photo_moment.assert_called_once()
        payload = client.on_finish_photo_moment.call_args.args[0]
        assert payload["trigger"] == "stage_22"
        assert payload["subtask_name"] == "Benchy"

    def test_ignores_mid_print_colour_swap(self, client):
        self._running(client, progress=40.0, remaining_time=30, layer_num=10, total_layers=100)

        client._update_state({"stg_cur": 22})

        client.on_finish_photo_moment.assert_not_called()

    def test_last_layer_counts_as_end_of_print(self, client):
        self._running(client, progress=90.0, remaining_time=5, layer_num=100, total_layers=100)

        client._update_state({"stg_cur": 22})

        client.on_finish_photo_moment.assert_called_once()


class TestSingleNozzleTemperatures:
    def test_nozzle_bed_and_heating_flag(self, client):
        client.on_bed_temp_update = MagicMock()

        client._update_state(
            {"nozzle_temper": 180, "nozzle_target_temper": 220, "bed_temper": 55.5, "bed_target_temper": 60}
        )

        temps = client.state.temperatures
        assert (temps["nozzle"], temps["nozzle_target"], temps["nozzle_heating"]) == (180.0, 220.0, True)
        assert (temps["bed"], temps["bed_target"]) == (55.5, 60.0)
        client.on_bed_temp_update.assert_called_once_with(55.5)

    @pytest.mark.parametrize(
        ("fields", "expected"),
        [
            ({"nozzle_temper_2": 210, "nozzle_target_temper_2": 215}, {"nozzle_2": 210.0, "nozzle_2_target": 215.0}),
            (
                {"right_nozzle_temper": 205, "right_nozzle_target_temper": 210},
                {"nozzle_2": 205.0, "nozzle_2_target": 210.0},
            ),
            ({"nozzle_temper_2": 9999, "nozzle_target_temper_2": -1}, {}),
            ({"right_nozzle_temper": -80, "right_nozzle_target_temper": 600}, {}),
        ],
    )
    def test_second_nozzle_field_variants(self, client, fields, expected):
        client._update_state(fields)

        got = {k: v for k, v in client.state.temperatures.items() if k.startswith("nozzle_2")}
        assert got == expected

    def test_left_nozzle_fields_as_primary(self, client):
        client._update_state({"left_nozzle_temper": 190, "left_nozzle_target_temper": 200})

        assert client.state.temperatures["nozzle"] == 190.0
        assert client.state.temperatures["nozzle_target"] == 200.0


class TestChamber:
    def test_direct_value_means_heater_off(self, client):
        client._update_state({"chamber_temper": 31})

        temps = client.state.temperatures
        assert (temps["chamber"], temps["chamber_target"], temps["chamber_heating"]) == (31.0, 0.0, False)

    def test_encoded_value_carries_target_and_heating(self, client):
        client._update_state({"chamber_temper": enc(45, 30)})

        temps = client.state.temperatures
        assert (temps["chamber"], temps["chamber_target"], temps["chamber_heating"]) == (30.0, 45.0, True)

    def test_mc_target_cham_sets_target_within_range(self, client):
        client._update_state({"mc_target_cham": 50})
        client._update_state({"mc_target_cham": 70})

        assert client.state.temperatures["chamber_target"] == 50.0

    @pytest.mark.parametrize(
        ("info_temp", "chamber", "target"),
        [(enc(40, 25), 25.0, 40.0), (28, 28.0, 0.0)],
    )
    def test_info_temp(self, client, info_temp, chamber, target):
        client._update_state({"info": {"temp": info_temp}})

        assert client.state.temperatures["chamber"] == chamber
        assert client.state.temperatures["chamber_target"] == target

    def test_ctc_explicit_target_wins_over_decoded(self, client):
        client._update_state({"device": {"ctc": {"info": {"target": 35, "temp": enc(50, 30)}}}})

        temps = client.state.temperatures
        assert (temps["chamber"], temps["chamber_target"], temps["chamber_heating"]) == (30.0, 35.0, True)

    def test_ctc_decoded_target_used_without_explicit_target(self, client):
        client._update_state({"device": {"ctc": {"info": {"temp": enc(50, 30)}}}})

        assert client.state.temperatures["chamber_target"] == 50.0
        assert client.state.temperatures["chamber_heating"] is True

    def test_ctc_direct_temp_means_not_heating(self, client):
        client._update_state({"device": {"ctc": {"info": {"temp": 26}}}})

        assert client.state.temperatures["chamber_heating"] is False


class TestH2DDualNozzle:
    def _push(self, client, ext0_temp, ext1_temp, **ext_extra):
        info = [{"id": 0, "temp": ext0_temp}, {"id": 1, "temp": ext1_temp}]
        for idx, extra in ext_extra.items():
            info[int(idx[-1])].update(extra)
        client._update_state({"nozzle_temper": 999, "device": {"extruder": {"info": info, "state": 0}}})

    def test_encoded_right_and_direct_left(self, client):
        self._push(client, enc(250, 200), 30)

        temps = client.state.temperatures
        assert (temps["nozzle_2"], temps["nozzle_2_target"], temps["nozzle_2_heating"]) == (200.0, 250.0, True)
        assert (temps["nozzle"], temps["nozzle_target"], temps["nozzle_heating"]) == (30.0, 0.0, False)

    def test_direct_right_and_encoded_left(self, client):
        self._push(client, 40, enc(220, 215))

        temps = client.state.temperatures
        assert (temps["nozzle_2"], temps["nozzle_2_target"], temps["nozzle_2_heating"]) == (40.0, 0.0, False)
        assert (temps["nozzle"], temps["nozzle_target"], temps["nozzle_heating"]) == (215.0, 220.0, True)

    @pytest.mark.parametrize(
        ("snow", "tray"),
        [((1 << 8) | 2, 6), ((254 << 8) | 0, 254), ((255 << 8) | 255, 255), ((129 << 8) | 0, 129)],
    )
    def test_snow_maps_to_global_tray(self, client, snow, tray):
        self._push(client, 30, 30, ext0={"snow": snow})

        assert client.state.h2d_extruder_snow[0] == tray

    def test_active_extruder_from_state_bit_8(self, client):
        client._update_state({"device": {"extruder": {"state": 1 << 8, "cur": 1}}})
        assert client.state.active_extruder == 1

        client._update_state({"device": {"extruder": {"state": 0}}})
        assert client.state.active_extruder == 0

    def test_bed_heating_from_device_bed(self, client):
        client._update_state({"device": {"bed": {"info": {"temp": enc(60, 40)}}}})
        assert client.state.temperatures["bed_heating"] is True

        client._update_state({"device": {"bed": {"info": {"temp": 40}}}})
        assert client.state.temperatures["bed_heating"] is False


class TestAirduct:
    def test_mode_and_fan_inventory(self, client):
        parts = [
            {"id": 1 << 4, "state": 80},
            {"id": 2 << 4, "state": 0},
            {"id": 3 << 4, "state": 50},
            {"id": 10 << 4, "state": 40},
            {"id": "bad"},
        ]
        client._update_state({"device": {"airduct": {"modeCur": 1, "parts": parts}}})

        assert client.state.airduct_mode == 1
        assert client.state.left_aux_fan_speed == 40
        assert client.state.exhaust_fan_present is True

    def test_full_inventory_without_exhaust_clears_it(self, client):
        client.state.exhaust_fan_present = True
        client._update_state({"device": {"airduct": {"parts": [{"id": 16, "state": 1}, {"id": 32, "state": 1}]}}})

        assert client.state.exhaust_fan_present is False
        assert client.state.left_aux_fan_speed is None

    def test_partial_update_keeps_known_aux_fan(self, client):
        client.state.left_aux_fan_speed = 60
        client._update_state({"device": {"airduct": {"parts": [{"id": 16, "state": 5}]}}})

        assert client.state.left_aux_fan_speed == 60


def test_filament_track_switch_detected(client):
    client._update_state({"device": {"fila_switch": {"in": [0, 1], "out": [1], "stat": 2, "info": 3}}})

    fts = client.state.fila_switch
    assert (fts.installed, fts.in_slots, fts.out_extruders, fts.stat, fts.info) == (True, [0, 1], [1], 2, 3)


class TestHmsAndPrintError:
    def test_hms_errors_parsed_and_status_codes_skipped(self, client):
        client.state.subtask_id = "job-9"
        client._update_state(
            {
                "hms": [
                    {"attr": 0x07000300, "code": 0x8010},  # real fault, severity 3
                    {"attr": "0x0C000200", "code": "0x0001"},  # status code < 0x4000
                    {"attr": 0x05000200, "code": 0x400E},  # user cancel echo
                    "junk",
                ]
            }
        )

        [error] = client.state.hms_errors
        assert (error.code, error.module, error.severity, error.job_id) == ("0x8010", 0x07, 3, "job-9")
        assert error.full_code == "0700030000008010"

    def test_hms_string_codes_and_default_severity(self, client):
        client._update_state({"hms": [{"attr": "0x12000000", "code": "0xC001"}]})

        [error] = client.state.hms_errors
        assert (error.module, error.severity) == (0x12, 2)

    def test_print_error_added_with_warning_severity(self, client):
        client._update_state({"print_error": 0x05008061})

        [error] = client.state.hms_errors
        assert (error.code, error.module, error.severity, error.full_code) == ("0x8061", 0x05, 3, "05008061")

    @pytest.mark.parametrize("print_error", [0, 0x05000002, 0x0500400E])
    def test_print_error_status_and_cancel_codes_ignored(self, client, print_error):
        client._update_state({"print_error": print_error})

        assert client.state.hms_errors == []

    def test_print_error_not_duplicated_when_also_in_hms(self, client):
        client._update_state({"hms": [{"attr": 0x05000300, "code": 0x8061}], "print_error": 0x05008061})

        assert len(client.state.hms_errors) == 1


class TestFlags:
    @pytest.mark.parametrize(
        ("raw", "present"),
        [("HAS_SDCARD_NORMAL", True), ("normal", True), ("NO_SDCARD", False), (True, True), (0, False)],
    )
    def test_sdcard(self, client, raw, present):
        client._update_state({"sdcard": raw})
        assert client.state.sdcard is present

    def test_store_to_sdcard_from_negative_home_flag(self, client):
        client._update_state({"home_flag": -(2**31) | (1 << 11)})
        assert client.state.store_to_sdcard is True

    def test_x1_door_comes_from_home_flag(self):
        x1 = _client("X1C")
        x1._update_state({"home_flag": 0x00800000, "stat": "0"})
        assert x1.state.door_open is True

    @pytest.mark.parametrize(("stat", "door_open"), [("00800000", True), (0, False)])
    def test_other_models_door_comes_from_stat(self, client, stat, door_open):
        client._update_state({"stat": stat})
        assert client.state.door_open is door_open

    def test_unparseable_stat_is_ignored(self, client):
        client._update_state({"stat": "zz"})
        assert client.state.door_open is False


class TestStatusFields:
    def test_timelapse_during_print_is_remembered(self, client):
        client._was_running = True
        client._update_state({"timelapse": True})
        client._update_state({"timelapse": False})

        assert client.state.timelapse is False
        assert client._timelapse_during_print is True

    def test_ipcam_record_and_timelapse(self, client):
        client._was_running = True
        client._update_state({"ipcam": {"ipcam_record": "enable", "timelapse": "enable"}})

        assert client.state.ipcam is True
        assert client.state.timelapse is True
        assert client._timelapse_during_print is True

    def test_ipcam_boolean_form(self, client):
        client._update_state({"ipcam": True})
        assert client.state.ipcam is True

    @pytest.mark.parametrize(("raw", "dbm"), [(-52, -52), ("-61dBm", -61)])
    def test_wifi_signal(self, client, raw, dbm):
        client._update_state({"wifi_signal": raw})
        assert client.state.wifi_signal == dbm

    def test_ethernet_detected_from_fixed_minus_90(self):
        x1 = _client("X1C")
        x1._update_state({"wifi_signal": "-90dBm"})
        assert x1.state.wired_network is True

    def test_speed_skipped_objects_and_light(self, client):
        client._update_state(
            {
                "spd_lvl": 3,
                "s_obj": [101, "102", None],
                "lights_report": [{"node": "work_light", "mode": "on"}, {"node": "chamber_light", "mode": "on"}],
            }
        )

        assert client.state.speed_level == 3
        assert client.state.skipped_objects == [101, 102]
        assert client.state.chamber_light is True

    def test_nozzle_hardware_fields(self, client):
        client._update_state(
            {
                "nozzle_type": "hardened_steel",
                "nozzle_diameter": "0.6",
                "nozzle_type_2": "stainless_steel",
                "nozzle_diameter_2": "0.4",
            }
        )

        assert (client.state.nozzles[0].nozzle_type, client.state.nozzles[0].nozzle_diameter) == (
            "hardened_steel",
            "0.6",
        )
        assert (client.state.nozzles[1].nozzle_type, client.state.nozzles[1].nozzle_diameter) == (
            "stainless_steel",
            "0.4",
        )

    def test_left_right_nozzle_hardware_fields(self, client):
        client._update_state(
            {
                "left_nozzle_type": "hardened_steel",
                "left_nozzle_diameter": "0.4",
                "right_nozzle_type": "stainless_steel",
                "right_nozzle_diameter": "0.2",
            }
        )

        assert client.state.nozzles[0].nozzle_diameter == "0.4"
        assert client.state.nozzles[1].nozzle_diameter == "0.2"

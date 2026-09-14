"""Regression tests for telemetry-gated P2S/X2D accessory fans."""

import pytest


@pytest.fixture
def mqtt_client():
    from backend.app.services.bambu_mqtt import BambuMQTTClient

    return BambuMQTTClient(
        ip_address="192.168.1.100",
        serial_number="TESTP2S",
        access_code="12345678",
    )


def _airduct_device(parts):
    return {
        "device": {
            "airduct": {
                "modeCur": 0,
                "parts": parts,
            },
            "type": 1,
        }
    }


FULL_WITH_ACCESSORIES = [
    {"id": 16, "state": 30},  # decoded part cooling (id 1)
    {"id": 32, "state": 40},  # decoded right aux (id 2)
    {"id": 160, "state": 80},  # decoded left aux (id 10)
    {"id": 48, "state": 70},  # decoded exhaust (id 3)
]


class TestAccessoryFanParsing:
    def test_defaults_to_unsupported(self, mqtt_client):
        assert mqtt_client.state.left_aux_fan_speed is None
        assert mqtt_client.state.exhaust_fan_present is False

    def test_decodes_accessory_parts(self, mqtt_client):
        mqtt_client._update_state(_airduct_device(FULL_WITH_ACCESSORIES))

        assert mqtt_client.state.left_aux_fan_speed == 80
        assert mqtt_client.state.exhaust_fan_present is True

    def test_masks_packed_state_and_clamps_plain_state(self, mqtt_client):
        parts = [
            {"id": 16, "state": 0},
            {"id": 32, "state": 0},
            {"id": 160, "state": (60 << 16) | 45},
            {"id": 48, "state": 0},
        ]
        mqtt_client._update_state(_airduct_device(parts))
        assert mqtt_client.state.left_aux_fan_speed == 45

        parts[2]["state"] = 250
        mqtt_client._update_state(_airduct_device(parts))
        assert mqtt_client.state.left_aux_fan_speed == 100

    def test_full_inventory_without_accessories_hides_them(self, mqtt_client):
        mqtt_client.state.left_aux_fan_speed = 80
        mqtt_client.state.exhaust_fan_present = True
        mqtt_client._update_state(
            _airduct_device(
                [
                    {"id": 16, "state": 0},
                    {"id": 32, "state": 0},
                ]
            )
        )

        assert mqtt_client.state.left_aux_fan_speed is None
        assert mqtt_client.state.exhaust_fan_present is False

    def test_partial_inventory_preserves_presence(self, mqtt_client):
        mqtt_client._update_state(_airduct_device(FULL_WITH_ACCESSORIES))
        mqtt_client._update_state(_airduct_device([{"id": 160, "state": 20}]))

        assert mqtt_client.state.left_aux_fan_speed == 20
        assert mqtt_client.state.exhaust_fan_present is True

    def test_missing_device_diff_preserves_presence(self, mqtt_client):
        mqtt_client._update_state(_airduct_device(FULL_WITH_ACCESSORIES))
        mqtt_client._update_state({"nozzle_temper": 250.0})

        assert mqtt_client.state.left_aux_fan_speed == 80
        assert mqtt_client.state.exhaust_fan_present is True

    def test_malformed_parts_are_ignored(self, mqtt_client):
        mqtt_client._update_state(
            _airduct_device(
                [
                    "not-a-dict",
                    {"id": "garbage", "state": 10},
                    {"id": 160, "state": 30},
                ]
            )
        )
        assert mqtt_client.state.left_aux_fan_speed == 30

    def test_raw_id_10_is_not_left_aux(self, mqtt_client):
        mqtt_client._update_state(_airduct_device([{"id": 10, "state": 50}]))
        assert mqtt_client.state.left_aux_fan_speed is None


class TestAccessoryFanCommands:
    def test_left_aux_helper_emits_m106_p10(self, mqtt_client, monkeypatch):
        sent = []
        monkeypatch.setattr(mqtt_client, "send_gcode", lambda gcode: sent.append(gcode) or True)

        assert mqtt_client.set_left_aux_fan(204) is True
        assert sent == ["M106 P10 S204"]

    def test_invalid_index_is_rejected(self, mqtt_client, monkeypatch):
        sent = []
        monkeypatch.setattr(mqtt_client, "send_gcode", lambda gcode: sent.append(gcode) or True)

        assert mqtt_client.set_fan_speed(4, 100) is False
        assert mqtt_client.set_fan_speed(11, 100) is False
        assert sent == []

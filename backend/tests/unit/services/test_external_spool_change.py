"""External-spool identity changes trigger assignment reconciliation."""

import pytest

from backend.app.services.bambu_mqtt import BambuMQTTClient


def _external_spool_message(tray_type: str, remain: int = 100, color: str = "000000FF"):
    return {
        "print": {
            "vt_tray": {
                "id": "254",
                "tray_type": tray_type,
                "tray_color": color,
                "tray_info_idx": "",
                "tag_uid": "0000000000000000",
                "tray_uuid": "00000000000000000000000000000000",
                "remain": remain,
            }
        }
    }


class TestExternalSpoolChangeDetection:
    @pytest.fixture
    def mqtt_client(self):
        return BambuMQTTClient(
            ip_address="192.168.1.100",
            serial_number="TEST123",
            access_code="12345678",
        )

    def test_type_swap_fires_callback(self, mqtt_client):
        calls: list = []
        mqtt_client.on_ams_change = lambda ams_data: calls.append(ams_data)

        mqtt_client._process_message(_external_spool_message("TPU"))
        mqtt_client._process_message(_external_spool_message("ABS"))

        assert len(calls) == 2
        assert all(isinstance(call, list) for call in calls)

    def test_identical_push_does_not_refire(self, mqtt_client):
        calls: list = []
        mqtt_client.on_ams_change = lambda ams_data: calls.append(ams_data)

        for _ in range(3):
            mqtt_client._process_message(_external_spool_message("ABS"))

        assert len(calls) == 1

    def test_remain_only_change_does_not_refire(self, mqtt_client):
        calls: list = []
        mqtt_client.on_ams_change = lambda ams_data: calls.append(ams_data)

        mqtt_client._process_message(_external_spool_message("PLA", remain=100))
        mqtt_client._process_message(_external_spool_message("PLA", remain=87))
        mqtt_client._process_message(_external_spool_message("PLA", remain=42))

        assert len(calls) == 1

    def test_reset_to_empty_fires_callback(self, mqtt_client):
        calls: list = []
        mqtt_client.on_ams_change = lambda ams_data: calls.append(ams_data)

        mqtt_client._process_message(_external_spool_message("TPU"))
        mqtt_client._process_message(_external_spool_message(""))

        assert len(calls) == 2

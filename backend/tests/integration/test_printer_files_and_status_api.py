"""Printer file preview endpoints and the live status endpoint.

File endpoints read 3MF/gcode straight off the printer over FTP; the printer's
storage is a dict of path -> bytes here. Status is built from a real
PrinterState as the MQTT client would leave it.
"""

import io
import json
import zipfile
from unittest.mock import MagicMock, patch

import pytest
from httpx import AsyncClient

from backend.app.services.bambu_mqtt import KProfile, PrinterState

pytestmark = pytest.mark.integration

SLICE_INFO = """<config>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="1800"/>
    <metadata key="weight" value="12.5"/>
    <object identify_id="1" name="Cube"/>
    <object identify_id="2" name="Cube"/>
    <filament id="2" type="PETG" color="#00FF00" used_g="3.04" used_m="1.0"/>
    <filament id="1" type="PLA" color="#FF0000" used_g="9.46" used_m="3.1"/>
    <filament id="3" type="TPU" color="#000000" used_g="0"/>
  </plate>
  <plate>
    <metadata key="index" value="2"/>
    <metadata key="prediction" value="bad"/>
    <object identify_id="3" name="Gear"/>
  </plate>
</config>"""

MODEL_SETTINGS = """<config>
  <plate><metadata key="plater_id" value="2"/><metadata key="plater_name" value=" Gears "/></plate>
</config>"""


def _kprofile(slot_id, k_value):
    return KProfile(
        slot_id=slot_id,
        extruder_id=0,
        nozzle_id="HS00-0.4",
        nozzle_diameter="0.4",
        filament_id="GFA00",
        name="PLA",
        k_value=k_value,
    )


def _zip(files: dict[str, str | bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    return buf.getvalue()


@pytest.fixture
def sd_card():
    files: dict[str, bytes] = {}

    async def download(ip, access_code, path, **kwargs):
        return files.get(path)

    with patch("backend.app.api.routes.printers.download_file_bytes_async", download):
        yield files


class TestFileGcode:
    async def test_plain_gcode(self, async_client: AsyncClient, printer_factory, sd_card):
        printer = await printer_factory()
        sd_card["/cache/part.gcode"] = b"G28\n"

        response = await async_client.get(
            f"/api/v1/printers/{printer.id}/files/gcode", params={"path": "/cache/part.gcode"}
        )

        assert response.status_code == 200
        assert response.text == "G28\n"

    async def test_gcode_from_inside_3mf(self, async_client: AsyncClient, printer_factory, sd_card):
        printer = await printer_factory()
        sd_card["/job.gcode.3mf"] = _zip({"Metadata/plate_1.gcode": "G1 X5"})

        response = await async_client.get(
            f"/api/v1/printers/{printer.id}/files/gcode", params={"path": "/job.gcode.3mf"}
        )

        assert response.text == "G1 X5"

    @pytest.mark.parametrize(
        ("path", "content", "status"),
        [
            ("/missing.gcode", None, 404),
            ("/source.3mf", _zip({"3D/3dmodel.model": "<model/>"}), 404),
            ("/broken.3mf", b"not a zip", 400),
            ("/photo.jpg", b"\xff\xd8", 400),
        ],
    )
    async def test_errors(self, async_client: AsyncClient, printer_factory, sd_card, path, content, status):
        printer = await printer_factory()
        if content is not None:
            sd_card[path] = content

        response = await async_client.get(f"/api/v1/printers/{printer.id}/files/gcode", params={"path": path})

        assert response.status_code == status

    async def test_unknown_printer(self, async_client: AsyncClient, sd_card):
        response = await async_client.get("/api/v1/printers/999/files/gcode", params={"path": "/x.gcode"})
        assert response.status_code == 404


class TestFilePlates:
    async def _plates(self, client, printer, path):
        response = await client.get(f"/api/v1/printers/{printer.id}/files/plates", params={"path": path})
        assert response.status_code == 200
        return response.json()

    async def test_sliced_multi_plate_file(self, async_client: AsyncClient, printer_factory, sd_card):
        printer = await printer_factory()
        sd_card["/multi.gcode.3mf"] = _zip(
            {
                "Metadata/plate_1.gcode": "G1",
                "Metadata/plate_2.gcode": "G1",
                "Metadata/plate_x.gcode": "G1",
                "Metadata/plate_1.png": b"png",
                "Metadata/slice_info.config": SLICE_INFO,
                "Metadata/model_settings.config": MODEL_SETTINGS,
            }
        )

        body = await self._plates(async_client, printer, "/multi.gcode.3mf")

        assert body["is_multi_plate"] is True
        first, second = body["plates"]
        assert first["index"] == 1
        assert first["name"] == "Cube"
        assert first["objects"] == ["Cube"]
        assert (first["print_time_seconds"], first["filament_used_grams"], first["has_thumbnail"]) == (1800, 12.5, True)
        assert [(f["slot_id"], f["type"], f["used_grams"]) for f in first["filaments"]] == [
            (1, "PLA", 9.5),
            (2, "PETG", 3.0),
        ]
        assert first["thumbnail_url"] == f"/api/v1/printers/{printer.id}/files/plate-thumbnail/1?path=/multi.gcode.3mf"
        # The custom plate name wins over the first object name.
        assert (second["name"], second["print_time_seconds"], second["has_thumbnail"]) == ("Gears", None, False)

    async def test_unsliced_file_uses_plate_json_and_png(self, async_client: AsyncClient, printer_factory, sd_card):
        printer = await printer_factory()
        sd_card["/project.3mf"] = _zip(
            {
                "Metadata/plate_1.json": json.dumps({"bbox_objects": [{"name": "Base"}, {"name": "Base"}, "junk"]}),
                "Metadata/plate_3.png": b"png",
                "Metadata/plate_3_small.png": b"png",
                "Metadata/plate_4.json": "{broken",
            }
        )

        body = await self._plates(async_client, printer, "/project.3mf")

        assert [(p["index"], p["name"], p["objects"]) for p in body["plates"]] == [
            (1, "Base", ["Base"]),
            (3, None, []),
            (4, None, []),
        ]

    @pytest.mark.parametrize(
        ("path", "content"),
        [
            ("/plain.gcode", None),  # not a 3MF: no download at all
            ("/empty.3mf", _zip({"3D/3dmodel.model": "<model/>"})),  # no plate files
            ("/broken.3mf", b"garbage"),  # unreadable: logged, empty list
        ],
    )
    async def test_files_without_plates(self, async_client: AsyncClient, printer_factory, sd_card, path, content):
        printer = await printer_factory()
        if content is not None:
            sd_card[path] = content

        body = await self._plates(async_client, printer, path)

        assert (body["plates"], body["is_multi_plate"]) == ([], False)

    async def test_missing_file(self, async_client: AsyncClient, printer_factory, sd_card):
        printer = await printer_factory()
        response = await async_client.get(f"/api/v1/printers/{printer.id}/files/plates", params={"path": "/gone.3mf"})
        assert response.status_code == 404


class TestPlateThumbnail:
    async def test_returns_png(self, async_client: AsyncClient, printer_factory, sd_card):
        printer = await printer_factory()
        sd_card["/job.3mf"] = _zip({"Metadata/plate_2.png": b"\x89PNGdata"})

        response = await async_client.get(
            f"/api/v1/printers/{printer.id}/files/plate-thumbnail/2", params={"path": "/job.3mf"}
        )

        assert response.status_code == 200
        assert response.headers["content-type"] == "image/png"
        assert response.content == b"\x89PNGdata"

    @pytest.mark.parametrize(("content", "status"), [(None, 404), (b"garbage", 404), (_zip({"a": "b"}), 404)])
    async def test_not_found(self, async_client: AsyncClient, printer_factory, sd_card, content, status):
        printer = await printer_factory()
        if content is not None:
            sd_card["/job.3mf"] = content

        response = await async_client.get(
            f"/api/v1/printers/{printer.id}/files/plate-thumbnail/1", params={"path": "/job.3mf"}
        )

        assert response.status_code == status


class TestDownloadZip:
    async def test_bundles_downloaded_files(self, async_client: AsyncClient, printer_factory, sd_card):
        printer = await printer_factory()
        sd_card["/a.gcode"] = b"A"
        sd_card["/cache/b.3mf"] = b"B"

        response = await async_client.post(
            f"/api/v1/printers/{printer.id}/files/download-zip", json={"paths": ["/a.gcode", "/cache/b.3mf", "/gone"]}
        )

        assert response.status_code == 200
        assert response.headers["content-disposition"] == 'attachment; filename="printer-files.zip"'
        with zipfile.ZipFile(io.BytesIO(response.content)) as zf:
            assert {name: zf.read(name) for name in zf.namelist()} == {"a.gcode": b"A", "b.3mf": b"B"}

    async def test_no_paths(self, async_client: AsyncClient, printer_factory, sd_card):
        printer = await printer_factory()
        response = await async_client.post(f"/api/v1/printers/{printer.id}/files/download-zip", json={"paths": []})
        assert response.status_code == 400

    @pytest.mark.xfail(
        strict=True,
        reason="Bug: download-zip checks len(zip_data) == 0, but an empty ZIP is still 22 bytes, so it "
        "returns an empty archive instead of 404 when nothing could be downloaded",
    )
    async def test_nothing_downloadable_is_404(self, async_client: AsyncClient, printer_factory, sd_card):
        printer = await printer_factory()
        response = await async_client.post(
            f"/api/v1/printers/{printer.id}/files/download-zip", json={"paths": ["/gone"]}
        )
        assert response.status_code == 404


class TestStatus:
    def _state(self, **kwargs) -> PrinterState:
        state = PrinterState()
        state.connected = True
        state.state = "IDLE"
        for key, value in kwargs.items():
            setattr(state, key, value)
        return state

    async def _status(self, client, printer, state, drying=None):
        pm = MagicMock()
        pm.get_status.return_value = state
        pm.get_drying_targets.return_value = drying or {}
        pm.get_current_print_user.return_value = None
        pm.is_awaiting_plate_clear.return_value = False
        with patch("backend.app.api.routes.printers.printer_manager", pm):
            response = await client.get(f"/api/v1/printers/{printer.id}/status")
        assert response.status_code == 200
        return response.json()

    async def test_disconnected_printer(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory(name="Garage")
        body = await self._status(async_client, printer, None)
        assert (body["name"], body["connected"]) == ("Garage", False)

    async def test_ams_units_trays_and_k_values(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory(model="X1C")
        state = self._state(
            kprofiles=[_kprofile(5, "0.025"), _kprofile(6, "bad")],
            raw_data={
                "ams": [
                    {
                        "id": "0",
                        "humidity_raw": "31",
                        "temp": "24.5",
                        "sn": "AMS-SN",
                        "sw_ver": "00.00.06.96",
                        "dry_time": 90,
                        "tray": [
                            {
                                "id": "0",
                                "tray_type": "PLA",
                                "cali_idx": 5,
                                "tag_uid": "0000000000000000",
                                "drying_temp": "55",
                            },
                            {"id": "1", "tray_type": "PETG", "k": 0.03, "tray_uuid": "ABC"},
                            {"id": "2"},
                            {"id": "3"},
                        ],
                    },
                    {"id": "128", "humidity": "2", "tray": [{"id": "0", "tray_type": "ABS"}]},
                    "junk",
                ],
                "vt_tray": [{"id": "254", "tray_type": "TPU", "cali_idx": 5, "tray_uuid": "0" * 32}],
            },
        )

        body = await self._status(async_client, printer, state)

        ams0, ht = body["ams"]
        assert (ams0["humidity"], ams0["serial_number"], ams0["sw_ver"], ams0["is_ams_ht"]) == (
            31,
            "AMS-SN",
            "00.00.06.96",
            False,
        )
        assert (ams0["dry_time"], ams0["dry_filament"], ams0["dry_target_temp"]) == (90, "PLA", 55)
        tray0, tray1 = ams0["tray"][:2]
        assert (tray0["k"], tray0["tag_uid"]) == (0.025, None)
        assert (tray1["k"], tray1["tray_uuid"]) == (0.03, "ABC")
        assert (ht["id"], ht["humidity"], ht["is_ams_ht"]) == (128, 2, True)
        [external] = body["vt_tray"]
        assert (external["id"], external["k"], external["tray_uuid"]) == (254, 0.025, None)

    async def test_cached_drying_target_wins(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()
        state = self._state(raw_data={"ams": [{"id": "1", "dry_time": 30, "tray": [{"id": "0", "tray_type": "PLA"}]}]})

        body = await self._status(async_client, printer, state, drying={1: {"filament": "PETG", "temp": "65"}})

        assert (body["ams"][0]["dry_filament"], body["ams"][0]["dry_target_temp"]) == ("PETG", 65)

    async def test_chamber_hidden_for_models_without_a_sensor(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory(model="P1S")
        state = self._state(temperatures={"bed": 60.0, "chamber": 31.0, "chamber_target": 0.0})

        body = await self._status(async_client, printer, state)

        assert "chamber" not in body["temperatures"]
        assert body["temperatures"]["bed"] == 60.0

    async def test_active_print_links_archive_and_cover(
        self, async_client: AsyncClient, printer_factory, archive_factory
    ):
        printer = await printer_factory(model="X1C")
        archive = await archive_factory(printer.id, subtask_id="777", status="printing")
        state = self._state(state="RUNNING", gcode_file="/data/Metadata/plate_2.gcode", subtask_id="777")

        body = await self._status(async_client, printer, state)

        assert body["cover_url"] == f"/api/v1/printers/{printer.id}/cover"
        assert body["current_archive_id"] == archive.id


class TestPrintableObjects:
    def _client(self, **state):
        defaults = {
            "printable_objects": {},
            "printable_objects_bbox_all": None,
            "skipped_objects": [],
            "subtask_name": "",
            "state": "RUNNING",
            "connected": True,
        }
        defaults.update(state)
        client = MagicMock()
        client.state = MagicMock(**defaults)
        return client

    async def _get(self, client, printer, mqtt_client, **params):
        pm = MagicMock()
        pm.get_client.return_value = mqtt_client
        with patch("backend.app.api.routes.printers.printer_manager", pm):
            return await client.get(f"/api/v1/printers/{printer.id}/print/objects", params=params)

    async def test_lists_objects_with_skip_status(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()
        mqtt = self._client(printable_objects={1: {"name": "Left", "x": 10, "y": 20}, 2: "Right"}, skipped_objects=[2])

        body = (await self._get(async_client, printer, mqtt)).json()

        assert body["objects"] == [
            {"id": 1, "name": "Left", "x": 10, "y": 20, "skipped": False},
            {"id": 2, "name": "Right", "x": None, "y": None, "skipped": True},
        ]
        assert (body["total"], body["skipped_count"], body["is_printing"]) == (2, 1, True)

    async def test_reloads_objects_from_the_printer(
        self, async_client: AsyncClient, printer_factory, tmp_path, monkeypatch
    ):
        from backend.app.core.config import settings

        monkeypatch.setattr(settings, "archive_dir", tmp_path)
        printer = await printer_factory()
        mqtt = self._client(subtask_name="My Part")
        slice_info = (
            '<config><plate><metadata key="index" value="1"/><object identify_id="9" name="Bolt"/></plate></config>'
        )
        tried: list[list[str]] = []

        async def download(ip, code, remote_paths, local_path, **kwargs):
            tried.append(remote_paths)
            local_path.write_bytes(_zip({"Metadata/slice_info.config": slice_info}))
            return True

        with patch("backend.app.services.bambu_ftp.download_file_try_paths_async", download):
            body = (await self._get(async_client, printer, mqtt, reload=True)).json()

        assert [o["name"] for o in body["objects"]] == ["Bolt"]
        assert tried[0][:3] == ["/My Part.gcode.3mf", "/cache/My Part.gcode.3mf", "/model/My Part.gcode.3mf"]
        assert "/My_Part.gcode.3mf" in tried[0]
        assert list((tmp_path / "temp").iterdir()) == []

    async def test_not_connected(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()
        assert (await self._get(async_client, printer, None)).status_code == 400


class TestPrintOptions:
    async def _post(self, client, printer, mqtt_client, **params):
        pm = MagicMock()
        pm.get_client.return_value = mqtt_client
        with patch("backend.app.api.routes.printers.printer_manager", pm):
            return await client.post(f"/api/v1/printers/{printer.id}/print-options", params=params)

    async def test_sets_option(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()
        mqtt = MagicMock()
        mqtt.state.connected = True
        mqtt.set_xcam_option.return_value = True

        response = await self._post(
            async_client, printer, mqtt, module_name="spaghetti_detector", enabled=True, sensitivity="high"
        )

        assert response.status_code == 200
        assert response.json()["sensitivity"] == "high"
        mqtt.set_xcam_option.assert_called_once_with(
            module_name="spaghetti_detector", enabled=True, print_halt=True, sensitivity="high"
        )

    @pytest.mark.parametrize(
        ("params", "status"),
        [
            ({"module_name": "laser_cannon", "enabled": True}, 400),
            ({"module_name": "printing_monitor", "enabled": True, "sensitivity": "extreme"}, 400),
        ],
    )
    async def test_validation(self, async_client: AsyncClient, printer_factory, params, status):
        printer = await printer_factory()
        mqtt = MagicMock()
        mqtt.state.connected = True

        assert (await self._post(async_client, printer, mqtt, **params)).status_code == status

    async def test_send_failure_and_disconnected(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()
        mqtt = MagicMock()
        mqtt.state.connected = True
        mqtt.set_xcam_option.return_value = False

        failed = await self._post(async_client, printer, mqtt, module_name="printing_monitor", enabled=False)
        mqtt.state.connected = False
        offline = await self._post(async_client, printer, mqtt, module_name="printing_monitor", enabled=False)

        assert (failed.status_code, offline.status_code) == (500, 400)

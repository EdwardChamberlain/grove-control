"""Integration tests for the archive endpoints that read the stored 3MF:
capabilities, plates, plate preview/thumbnail and filament requirements.

Each test writes a small synthetic 3MF under a temporary ``base_dir`` so the
real zip/XML/JSON parsing runs end to end.
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest
from httpx import AsyncClient

from backend.app.core.config import settings as app_settings

PNG = b"\x89PNG\r\n\x1a\nfake-image"

MESH_MODEL = '<model><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/></vertices></mesh></object></resources></model>'

TWO_PLATE_SLICE_INFO = """<config>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="3600"/>
    <metadata key="weight" value="12.5"/>
    <metadata key="curr_bed_type" value="Textured PEI Plate"/>
    <object name="Benchy"/>
    <object name="Cube"/>
    <filament id="2" type="PETG" color="#00FF00" used_g="2.04" used_m="0.7"/>
    <filament id="1" type="PLA" color="#FF0000" used_g="10.46" used_m="3.5" tray_info_idx="GFA00"/>
    <filament id="3" type="PLA" color="#0000FF" used_g="0"/>
  </plate>
  <plate>
    <metadata key="index" value="2"/>
    <metadata key="prediction" value="not-a-number"/>
    <filament id="3" type="ABS" color="#0000FF" used_g="4.0" used_m="1.2"/>
  </plate>
</config>"""

MODEL_SETTINGS = """<config>
  <object id="7"><metadata key="name" value="Gear"/></object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value="  Main plate  "/>
  </plate>
  <plate>
    <metadata key="plater_id" value="3"/>
    <model_instance><metadata key="object_id" value="7"/></model_instance>
  </plate>
</config>"""


def write_3mf(path: Path, files: dict[str, str | bytes]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        for name, data in files.items():
            zf.writestr(name, data)


@pytest.fixture
def base_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(app_settings, "base_dir", tmp_path)
    return tmp_path


@pytest.fixture
async def make_archive(base_dir, archive_factory, printer_factory):
    """Create an archive row whose file_path points at a 3MF with ``files``."""
    printer = await printer_factory()

    async def _make(files: dict[str, str | bytes] | None, *, rel: str = "archives/a/print.gcode.3mf", **kwargs):
        if files is not None:
            write_3mf(base_dir / rel, files)
        return await archive_factory(printer.id, file_path=rel, **kwargs)

    return _make


@pytest.mark.integration
class TestArchiveCapabilities:
    async def test_sliced_file_reports_gcode_mesh_colors_and_volume(self, async_client: AsyncClient, make_archive):
        archive = await make_archive(
            {
                "3D/3dmodel.model": MESH_MODEL,
                "Metadata/plate_1.gcode": "G1 X0",
                "Metadata/slice_info.config": TWO_PLATE_SLICE_INFO,
                "Metadata/project_settings.config": json.dumps(
                    {"printable_area": ["0x0", "350x0", "350x320", "0x320"], "printable_height": "325"}
                ),
            }
        )
        response = await async_client.get(f"/api/v1/archives/{archive.id}/capabilities")
        assert response.status_code == 200
        body = response.json()
        assert body["has_model"] is True
        assert body["has_gcode"] is True
        assert body["has_source"] is False
        assert body["build_volume"] == {"x": 350, "y": 320, "z": 325}
        # Colours come from used filaments, indexed by tool, gaps filled with the default.
        assert body["filament_colors"] == ["#FF0000", "#00FF00", "#0000FF"]

    async def test_source_3mf_supplies_mesh_and_colors(self, async_client: AsyncClient, make_archive, base_dir):
        write_3mf(
            base_dir / "archives/a/source.3mf",
            {
                "3D/3dmodel.model": MESH_MODEL,
                "Metadata/project_settings.config": json.dumps(
                    {"filament_colour": ["#111111", "", "#222222"], "printable_height": "250"}
                ),
            },
        )
        archive = await make_archive({"Metadata/plate_1.gcode": "G1"}, source_3mf_path="archives/a/source.3mf")
        body = (await async_client.get(f"/api/v1/archives/{archive.id}/capabilities")).json()
        assert body["has_source"] is True
        assert body["has_model"] is True
        assert body["filament_colors"] == ["#111111", "#222222"]
        assert body["build_volume"]["z"] == 250

    async def test_defaults_without_metadata(self, async_client: AsyncClient, make_archive):
        archive = await make_archive({"readme.txt": "nothing useful"})
        body = (await async_client.get(f"/api/v1/archives/{archive.id}/capabilities")).json()
        assert body == {
            "has_model": False,
            "has_gcode": False,
            "has_source": False,
            "build_volume": {"x": 256, "y": 256, "z": 256},
            "filament_colors": [],
        }

    async def test_missing_file_is_404(self, async_client: AsyncClient, make_archive):
        archive = await make_archive(None)
        response = await async_client.get(f"/api/v1/archives/{archive.id}/capabilities")
        assert response.status_code == 404

    async def test_not_a_zip_is_400(self, async_client: AsyncClient, make_archive, base_dir):
        rel = "archives/a/broken.gcode.3mf"
        (base_dir / rel).parent.mkdir(parents=True, exist_ok=True)
        (base_dir / rel).write_bytes(b"not a zip")
        archive = await make_archive(None, rel=rel)
        response = await async_client.get(f"/api/v1/archives/{archive.id}/capabilities")
        assert response.status_code == 400

    async def test_unknown_archive_is_404(self, async_client: AsyncClient):
        response = await async_client.get("/api/v1/archives/99999/capabilities")
        assert response.status_code == 404


@pytest.mark.integration
class TestArchivePlates:
    async def test_multi_plate_metadata(self, async_client: AsyncClient, make_archive):
        archive = await make_archive(
            {
                "Metadata/plate_1.gcode": "G1",
                "Metadata/plate_2.gcode": "G1",
                "Metadata/plate_1.png": PNG,
                "Metadata/slice_info.config": TWO_PLATE_SLICE_INFO,
                "Metadata/model_settings.config": MODEL_SETTINGS,
            }
        )
        response = await async_client.get(f"/api/v1/archives/{archive.id}/plates")
        assert response.status_code == 200
        body = response.json()
        assert body["is_multi_plate"] is True
        assert body["has_gcode"] is True
        first, second = body["plates"]

        assert first["index"] == 1
        assert first["name"] == "Main plate"  # custom name from model_settings, trimmed
        assert first["objects"] == ["Benchy", "Cube"]
        assert first["object_count"] == 2
        assert first["print_time_seconds"] == 3600
        assert first["filament_used_grams"] == 12.5
        assert first["bed_type"] == "Textured PEI Plate"
        assert first["has_thumbnail"] is True
        assert first["thumbnail_url"] == f"/api/v1/archives/{archive.id}/plate-thumbnail/1"
        # Unused filament dropped, sorted by slot, grams rounded.
        assert [(f["slot_id"], f["used_grams"]) for f in first["filaments"]] == [(1, 10.5), (2, 2.0)]

        assert second["index"] == 2
        assert second["print_time_seconds"] is None  # non-numeric prediction ignored
        assert second["has_thumbnail"] is False
        assert second["thumbnail_url"] is None
        assert second["name"] is None

    async def test_source_only_project_uses_plate_json_and_png(self, async_client: AsyncClient, make_archive):
        archive = await make_archive(
            {
                "Metadata/plate_2.json": json.dumps({"bbox_objects": [{"name": "Vase"}, {"name": "Vase"}, "junk"]}),
                "Metadata/plate_3.png": PNG,
                "Metadata/plate_3_small.png": PNG,
                "Metadata/model_settings.config": MODEL_SETTINGS,
            }
        )
        body = (await async_client.get(f"/api/v1/archives/{archive.id}/plates")).json()
        assert body["has_gcode"] is False
        plates = {p["index"]: p for p in body["plates"]}
        assert set(plates) == {2, 3}
        assert plates[2]["objects"] == ["Vase"]
        assert plates[2]["name"] == "Vase"
        # Plate 3 has no slice info or JSON: objects resolved from model_settings ids.
        assert plates[3]["objects"] == ["Gear"]
        assert plates[3]["has_thumbnail"] is True

    async def test_no_plates(self, async_client: AsyncClient, make_archive):
        archive = await make_archive({"3D/3dmodel.model": MESH_MODEL})
        body = (await async_client.get(f"/api/v1/archives/{archive.id}/plates")).json()
        assert body["plates"] == []
        assert body["is_multi_plate"] is False

    async def test_missing_file_is_404(self, async_client: AsyncClient, make_archive):
        archive = await make_archive(None)
        assert (await async_client.get(f"/api/v1/archives/{archive.id}/plates")).status_code == 404


@pytest.mark.integration
class TestArchivePlateImages:
    async def test_preview_prefers_the_printed_plate(self, async_client: AsyncClient, make_archive):
        archive = await make_archive(
            {
                "Metadata/slice_info.config": '<config><plate><metadata key="index" value="2"/></plate></config>',
                "Metadata/plate_1.png": b"plate-one",
                "Metadata/plate_2.png": b"plate-two",
            }
        )
        response = await async_client.get(f"/api/v1/archives/{archive.id}/plate-preview")
        assert response.status_code == 200
        assert response.headers["content-type"] == "image/png"
        assert response.content == b"plate-two"

    async def test_preview_falls_back_to_thumbnail(self, async_client: AsyncClient, make_archive):
        archive = await make_archive({"Metadata/thumbnail.png": b"thumb"})
        response = await async_client.get(f"/api/v1/archives/{archive.id}/plate-preview")
        assert response.content == b"thumb"

    async def test_preview_missing_archive_is_404(self, async_client: AsyncClient):
        assert (await async_client.get("/api/v1/archives/99999/plate-preview")).status_code == 404

    async def test_plate_thumbnail(self, async_client: AsyncClient, make_archive):
        archive = await make_archive({"Metadata/plate_3.png": b"three"})
        ok = await async_client.get(f"/api/v1/archives/{archive.id}/plate-thumbnail/3")
        assert ok.status_code == 200
        assert ok.content == b"three"
        missing = await async_client.get(f"/api/v1/archives/{archive.id}/plate-thumbnail/4")
        assert missing.status_code == 404


@pytest.mark.integration
class TestArchiveFilamentRequirements:
    async def test_all_used_filaments_sorted_by_slot(self, async_client: AsyncClient, make_archive):
        archive = await make_archive({"Metadata/slice_info.config": TWO_PLATE_SLICE_INFO})
        response = await async_client.get(f"/api/v1/archives/{archive.id}/filament-requirements")
        assert response.status_code == 200
        body = response.json()
        assert body["plate_id"] is None
        assert [(f["slot_id"], f["type"]) for f in body["filaments"]] == [(1, "PLA"), (2, "PETG"), (3, "ABS")]
        first = body["filaments"][0]
        assert first == {
            "slot_id": 1,
            "type": "PLA",
            "color": "#FF0000",
            "used_grams": 10.5,
            "used_meters": 3.5,
            "tray_info_idx": "GFA00",
            "used_in_plate": True,
        }

    async def test_filters_to_one_plate(self, async_client: AsyncClient, make_archive):
        archive = await make_archive({"Metadata/slice_info.config": TWO_PLATE_SLICE_INFO})
        body = (await async_client.get(f"/api/v1/archives/{archive.id}/filament-requirements?plate_id=2")).json()
        assert body["plate_id"] == 2
        assert [(f["slot_id"], f["type"]) for f in body["filaments"]] == [(3, "ABS")]

    async def test_missing_file_is_404(self, async_client: AsyncClient, make_archive):
        archive = await make_archive(None)
        response = await async_client.get(f"/api/v1/archives/{archive.id}/filament-requirements")
        assert response.status_code == 404


RESCAN_FILES = {
    "Metadata/plate_1.gcode": "G1",
    "Metadata/slice_info.config": (
        '<config><plate><metadata key="index" value="1"/><metadata key="prediction" value="5400"/>'
        '<metadata key="weight" value="42.5"/>'
        '<filament id="1" type="PETG" color="#00FF00" used_g="42.5" used_m="14"/></plate></config>'
    ),
    "Metadata/project_settings.config": json.dumps(
        {
            "layer_height": "0.16",
            "nozzle_diameter": ["0.6"],
            "filament_type": ["PETG"],
            "curr_bed_type": "Textured PEI Plate",
            "nozzle_temperature": ["245"],
        }
    ),
}


@pytest.mark.integration
class TestArchiveRescan:
    async def test_rescan_refreshes_metadata_from_the_file(self, async_client: AsyncClient, make_archive):
        archive = await make_archive(
            RESCAN_FILES, filament_type="PLA", filament_used_grams=1.0, print_time_seconds=60, layer_height=0.2
        )
        response = await async_client.post(f"/api/v1/archives/{archive.id}/rescan")
        assert response.status_code == 200
        body = response.json()
        assert body["filament_type"] == "PETG"
        assert body["filament_color"] == "#00FF00"
        assert body["filament_used_grams"] == 42.5
        assert body["print_time_seconds"] == 5400
        assert body["layer_height"] == 0.16
        assert body["nozzle_diameter"] == 0.6
        assert body["nozzle_temperature"] == 245
        assert body["bed_type"] == "Textured PEI Plate"
        assert body["cost"] is not None and body["cost"] > 0

    async def test_rescan_missing_archive_or_file(self, async_client: AsyncClient, make_archive):
        assert (await async_client.post("/api/v1/archives/99999/rescan")).status_code == 404
        archive = await make_archive(None)
        assert (await async_client.post(f"/api/v1/archives/{archive.id}/rescan")).status_code == 404

    async def test_rescan_all_updates_and_reports_missing_files(
        self, async_client: AsyncClient, make_archive, db_session
    ):
        good = await make_archive(RESCAN_FILES, rel="archives/good/print.gcode.3mf", filament_type="PLA")
        missing = await make_archive(None, rel="archives/missing/print.gcode.3mf")
        good_id, missing_id = good.id, missing.id

        response = await async_client.post("/api/v1/archives/rescan-all")
        assert response.status_code == 200
        body = response.json()
        assert body["updated"] == 1
        assert body["errors"] == [{"id": missing_id, "error": "File not found"}]

        db_session.expire_all()
        refreshed = await async_client.get(f"/api/v1/archives/{good_id}")
        assert refreshed.json()["filament_type"] == "PETG"

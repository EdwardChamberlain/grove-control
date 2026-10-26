"""Library file plates, plate thumbnails and filament requirements."""

import io
import json
import zipfile
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration

SLICE_INFO = """<config>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="1800"/>
    <metadata key="weight" value="12.5"/>
    <object identify_id="1" name="Cube"/>
    <filament id="2" type="PETG" color="#00FF00" used_g="3.04" used_m="1.0" tray_info_idx="GFG00"/>
    <filament id="1" type="PLA" color="#FF0000" used_g="9.46" used_m="3.1" tray_info_idx="GFA00"/>
    <filament id="4" type="TPU" color="#000000" used_g="0"/>
  </plate>
  <plate>
    <metadata key="index" value="2"/>
    <metadata key="prediction" value="x"/>
    <metadata key="weight" value="y"/>
    <filament id="3" type="ABS" color="#FFFFFF" used_g="5" used_m=""/>
  </plate>
</config>"""

MODEL_SETTINGS = """<config>
  <object id="7"><metadata key="name" value="Bracket"/></object>
  <object id="8"/>
  <plate>
    <metadata key="plater_id" value="2"/>
    <metadata key="plater_name" value=" Second plate "/>
  </plate>
  <plate>
    <metadata key="plater_id" value="3"/>
    <model_instance><metadata key="object_id" value="7"/></model_instance>
    <model_instance><metadata key="object_id" value="7"/></model_instance>
    <model_instance><metadata key="object_id" value="9"/></model_instance>
  </plate>
</config>"""

PROJECT_SETTINGS = json.dumps(
    {
        "filament_type": ["PLA", "PETG"],
        "filament_colour": ["#FF0000", "#00FF00"],
        "printer_settings_id": "Bambu Lab X1 Carbon 0.4 nozzle",
        "print_settings_id": "0.20mm Standard @BBL X1C",
    }
)


def _zip(files: dict[str, str | bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in files.items():
            # Fixed timestamp: ZIP bytes are pytest params, and test IDs must match across xdist workers.
            zf.writestr(zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0)), data)
    return buf.getvalue()


@pytest.fixture
def storage(tmp_path, monkeypatch):
    from backend.app.core.config import settings

    monkeypatch.setattr(settings, "base_dir", tmp_path)
    return tmp_path


@pytest.fixture
def make_file(db_session, storage):
    from backend.app.models.library import LibraryFile

    async def _make(filename: str, content: bytes | None):
        rel = f"library/{filename}"
        if content is not None:
            (storage / "library").mkdir(exist_ok=True)
            (storage / rel).write_bytes(content)
        row = LibraryFile(filename=filename, file_path=rel, file_type=filename.rsplit(".", 1)[-1], file_size=1)
        db_session.add(row)
        await db_session.commit()
        await db_session.refresh(row)
        return row

    return _make


class TestPlates:
    async def test_sliced_multi_plate_file(self, async_client: AsyncClient, make_file):
        lib = await make_file(
            "multi.gcode.3mf",
            _zip(
                {
                    "Metadata/plate_1.gcode": "G1",
                    "Metadata/plate_2.gcode": "G1",
                    "Metadata/plate_3.gcode": "G1",
                    "Metadata/plate_bad.gcode": "G1",
                    "Metadata/plate_1.png": b"png",
                    "Metadata/slice_info.config": SLICE_INFO,
                    "Metadata/model_settings.config": MODEL_SETTINGS,
                    "Metadata/project_settings.config": PROJECT_SETTINGS,
                }
            ),
        )

        body = (await async_client.get(f"/api/v1/library/files/{lib.id}/plates")).json()

        assert body["is_multi_plate"] is True
        assert (body["embedded_printer"], body["embedded_process"]) == (
            "Bambu Lab X1 Carbon 0.4 nozzle",
            "0.20mm Standard @BBL X1C",
        )
        one, two, three = body["plates"]
        assert (one["name"], one["print_time_seconds"], one["filament_used_grams"]) == ("Cube", 1800, 12.5)
        assert one["thumbnail_url"] == f"/api/v1/library/files/{lib.id}/plate-thumbnail/1"
        assert [(f["slot_id"], f["used_grams"]) for f in one["filaments"]] == [(1, 9.5), (2, 3.0)]
        assert (two["name"], two["print_time_seconds"], two["thumbnail_url"]) == ("Second plate", None, None)
        assert two["filaments"][0]["used_meters"] == 0
        # Objects come from model_settings when slice_info has none for the plate.
        assert three["objects"] == ["Bracket", "Object 9"]
        assert three["name"] == "Bracket"

    async def test_unsliced_project_uses_plate_json_and_png(self, async_client: AsyncClient, make_file):
        lib = await make_file(
            "project.3mf",
            _zip(
                {
                    "Metadata/plate_1.json": json.dumps({"bbox_objects": [{"name": "Base"}, {"name": "Base"}, 1]}),
                    "Metadata/plate_2.png": b"png",
                    "Metadata/plate_2_small.png": b"png",
                    "Metadata/plate_9.json": "{not json",
                    "Metadata/model_settings.config": "<not xml",
                }
            ),
        )

        body = (await async_client.get(f"/api/v1/library/files/{lib.id}/plates")).json()

        assert [(p["index"], p["name"], p["has_thumbnail"]) for p in body["plates"]] == [
            (1, "Base", False),
            (2, None, True),
            (9, None, False),
        ]

    @pytest.mark.parametrize(
        ("filename", "content"),
        [
            ("part.stl", b"solid"),
            ("empty.3mf", _zip({"3D/3dmodel.model": "<model/>"})),
            ("broken.3mf", b"not a zip"),
        ],
    )
    async def test_files_without_plates(self, async_client: AsyncClient, make_file, filename, content):
        lib = await make_file(filename, content)

        body = (await async_client.get(f"/api/v1/library/files/{lib.id}/plates")).json()

        assert (body["plates"], body["is_multi_plate"]) == ([], False)

    async def test_missing(self, async_client: AsyncClient, make_file):
        lib = await make_file("gone.3mf", None)

        assert (await async_client.get(f"/api/v1/library/files/{lib.id}/plates")).status_code == 404
        assert (await async_client.get("/api/v1/library/files/9999/plates")).status_code == 404


class TestPlateThumbnail:
    async def test_returns_png(self, async_client: AsyncClient, make_file):
        lib = await make_file("job.3mf", _zip({"Metadata/plate_3.png": b"\x89PNG"}))

        response = await async_client.get(f"/api/v1/library/files/{lib.id}/plate-thumbnail/3")

        assert (response.status_code, response.content) == (200, b"\x89PNG")

    @pytest.mark.parametrize("content", [None, b"garbage", _zip({"a": "b"})])
    async def test_not_found(self, async_client: AsyncClient, make_file, content):
        lib = await make_file("job.3mf", content)

        assert (await async_client.get(f"/api/v1/library/files/{lib.id}/plate-thumbnail/1")).status_code == 404

    async def test_unknown_file(self, async_client: AsyncClient, storage):
        assert (await async_client.get("/api/v1/library/files/9999/plate-thumbnail/1")).status_code == 404


class TestFilamentRequirements:
    async def _get(self, client, lib, **params):
        response = await client.get(f"/api/v1/library/files/{lib.id}/filament-requirements", params=params)
        assert response.status_code == 200
        return response.json()

    async def test_all_used_filaments(self, async_client: AsyncClient, make_file):
        lib = await make_file("multi.gcode.3mf", _zip({"Metadata/slice_info.config": SLICE_INFO}))

        body = await self._get(async_client, lib)

        assert [(f["slot_id"], f["type"], f["tray_info_idx"]) for f in body["filaments"]] == [
            (1, "PLA", "GFA00"),
            (2, "PETG", "GFG00"),
            (3, "ABS", ""),
        ]

    async def test_single_plate(self, async_client: AsyncClient, make_file):
        lib = await make_file("multi.gcode.3mf", _zip({"Metadata/slice_info.config": SLICE_INFO}))

        body = await self._get(async_client, lib, plate_id=2)

        assert [(f["slot_id"], f["used_in_plate"]) for f in body["filaments"]] == [(3, True)]
        assert body["plate_id"] == 2

    async def test_unsliced_project_marks_slots_used_by_preview_slice(self, async_client: AsyncClient, make_file):
        lib = await make_file("project.3mf", _zip({"Metadata/project_settings.config": PROJECT_SETTINGS}))

        with patch(
            "backend.app.api.routes.library._try_preview_slice_filaments",
            AsyncMock(return_value=[{"slot_id": 2}]),
        ) as preview:
            body = await self._get(async_client, lib, plate_id=1)

        assert preview.await_args.kwargs["plate_id"] == 1
        assert [(f["slot_id"], f["type"], f["used_in_plate"]) for f in body["filaments"]] == [
            (1, "PLA", False),
            (2, "PETG", True),
        ]

    async def test_unsliced_project_without_preview_enables_every_slot(self, async_client: AsyncClient, make_file):
        lib = await make_file("project.3mf", _zip({"Metadata/project_settings.config": PROJECT_SETTINGS}))

        with patch("backend.app.api.routes.library._try_preview_slice_filaments", AsyncMock(return_value=None)):
            body = await self._get(async_client, lib, plate_id=1)

        assert all(f["used_in_plate"] for f in body["filaments"])

    async def test_non_3mf_and_broken_files(self, async_client: AsyncClient, make_file):
        stl = await make_file("part.stl", b"solid")
        broken = await make_file("broken.3mf", b"garbage")

        assert (await self._get(async_client, stl))["filaments"] == []
        assert (await self._get(async_client, broken))["filaments"] == []

    async def test_missing_on_disk(self, async_client: AsyncClient, make_file):
        lib = await make_file("gone.3mf", None)

        response = await async_client.get(f"/api/v1/library/files/{lib.id}/filament-requirements")

        assert response.status_code == 404


class TestPreviewSliceHelper:
    async def test_skips_unknown_slicer_and_missing_url(self, db_session, tmp_path):
        from backend.app.api.routes.library import _try_preview_slice_filaments
        from backend.app.models.settings import Settings

        file = tmp_path / "x.3mf"
        file.write_bytes(b"zip")
        db_session.add(Settings(key="preferred_slicer", value="cura"))
        await db_session.commit()

        assert (
            await _try_preview_slice_filaments(db_session, kind="library_file", source_id=1, plate_id=1, file_path=file)
            is None
        )

    async def test_calls_the_configured_sidecar(self, db_session, tmp_path):
        from backend.app.api.routes.library import _try_preview_slice_filaments
        from backend.app.models.settings import Settings

        file = tmp_path / "x.3mf"
        file.write_bytes(b"zip")
        db_session.add_all(
            [
                Settings(key="preferred_slicer", value="orcaslicer"),
                Settings(key="orcaslicer_api_url", value=" http://slicer:3000 "),
            ]
        )
        await db_session.commit()
        preview = AsyncMock(return_value=[{"slot_id": 1}])

        with patch("backend.app.services.slice_preview.get_preview_filaments", preview):
            result = await _try_preview_slice_filaments(
                db_session, kind="library_file", source_id=5, plate_id=2, file_path=file, request_id="r1"
            )

        assert result == [{"slot_id": 1}]
        kwargs = preview.await_args.kwargs
        assert (kwargs["api_url"], kwargs["file_bytes"], kwargs["plate_id"], kwargs["request_id"]) == (
            "http://slicer:3000",
            b"zip",
            2,
            "r1",
        )

    async def test_unreadable_file(self, db_session, tmp_path):
        from backend.app.api.routes.library import _try_preview_slice_filaments
        from backend.app.models.settings import Settings

        db_session.add(Settings(key="bambu_studio_api_url", value="http://studio:3000"))
        await db_session.commit()

        assert (
            await _try_preview_slice_filaments(
                db_session, kind="library_file", source_id=1, plate_id=1, file_path=tmp_path / "missing.3mf"
            )
            is None
        )

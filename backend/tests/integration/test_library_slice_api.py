"""Integration tests for the slice-via-API flow.

Routes under test:
- POST /library/files/{id}/slice  (returns 202 + job_id; bg task does the work)
- POST /archives/{id}/slice        (same shape; result lands in Files)
- GET /slice-jobs/{id}             (poll for terminal state)

The synchronous validation paths (404 missing source, 400 wrong file type)
are tested directly. The bg-task paths poll until the job finishes and then
assert on the captured state.
"""

from __future__ import annotations

import asyncio
import io
import json
import zipfile
from collections.abc import Callable

import httpx
import pytest
from httpx import AsyncClient

from backend.app.api.routes.library import _slicer_rejection_message
from backend.app.core.config import settings as app_settings
from backend.app.models.library import LibraryFile
from backend.app.models.local_preset import LocalPreset
from backend.app.models.settings import Settings as SettingsModel
from backend.app.services import plate_thumbnail as plate_thumbnail_module, slicer_api as slicer_api_module
from backend.app.services.slice_dispatch import slice_dispatch

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_3mf_with_settings(settings_payload: dict | None = None, *, sliced_output: bool = False) -> bytes:
    """Build a tiny in-memory 3MF zip with all the embedded-config files
    that real-world Bambu Studio / OrcaSlicer 3MFs ship with.

    The strip-before-forwarding helper has to remove ALL of these (not
    just `project_settings.config`) — leftover entries reference printer
    / filament IDs from the original slice and trip the CLI's input
    validation when a different `--load-settings` triplet is supplied.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("3D/3dmodel.model", "<model/>")
        zf.writestr(
            "Metadata/project_settings.config",
            json.dumps(settings_payload or {"prime_tower_brim_width": "-1"}),
        )
        zf.writestr("Metadata/model_settings.config", "<config><object id='1'/></config>")
        zf.writestr(
            "Metadata/slice_info.config",
            "<config><plate><metadata key='filament' value='GFL00'/></plate></config>",
        )
        zf.writestr("Metadata/cut_information.xml", "<cut><part id='1'/></cut>")
        if sliced_output:
            zf.writestr("Metadata/plate_1.gcode", b"G1 X1")
            zf.writestr("Metadata/plate_1.gcode.md5", b"deadbeef")
            zf.writestr("Metadata/plate_1.json", b"{}")
            zf.writestr("Metadata/plate_1.png", b"PLATE_RENDER")
    return buf.getvalue()


def _install_mock_sidecar(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.AsyncClient:
    """Pin a MockTransport-backed httpx client onto the slicer_api singleton
    so per-request `SlicerApiService` instances reuse it instead of opening
    a real connection."""
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), timeout=10.0)
    slicer_api_module.set_shared_http_client(client)
    return client


def _is_slice_post(request: httpx.Request) -> bool:
    """Ignore progress-poll requests when asserting sidecar slice calls."""
    return request.method == "POST" and request.url.path.endswith("/slice")


async def _wait_for_job(client: AsyncClient, job_id: int, timeout: float = 5.0) -> dict:
    """Poll `/api/v1/slice-jobs/{id}` until the job hits a terminal state.

    The dispatcher runs work as an asyncio task on the same event loop, so
    poll-with-sleep here is enough — a few yields and the task finishes.
    """
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        r = await client.get(f"/api/v1/slice-jobs/{job_id}")
        if r.status_code != 200:
            raise AssertionError(f"slice-jobs poll failed: {r.status_code} {r.text}")
        body = r.json()
        if body["status"] in ("completed", "failed"):
            return body
        await asyncio.sleep(0.05)
    raise AssertionError(f"slice job {job_id} did not finish in {timeout}s")


async def _get_committed_row(db_session, model, row_id: int):
    """Read a row committed by a background job after ending stale reads.

    End the fixture session's read transaction, expire its identity map, and
    perform a fresh lookup so rows committed by the job session are visible.
    """
    await db_session.commit()
    db_session.expire_all()
    row = await db_session.get(model, row_id)
    assert row is not None
    return row


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def test_database_url(tmp_path):
    """Give background slice sessions independent SQLite connections.

    The default ``:memory:`` engine uses ``StaticPool``, making the request,
    polling, fixture, and background-job sessions share one physical
    connection. Their transaction cleanup can then erase a job's committed
    archive. A per-test file preserves isolation and matches production.
    """
    return f"sqlite+aiosqlite:///{tmp_path / 'slice-test.db'}"


@pytest.fixture
async def slice_test_setup(db_session, tmp_path):
    """Source LibraryFile + 3 LocalPresets + preferred_slicer=orcaslicer."""
    storage_dir = tmp_path / "library" / "files"
    storage_dir.mkdir(parents=True, exist_ok=True)
    src_path = storage_dir / "Cube.stl"
    src_path.write_bytes(b"solid Cube\nendsolid\n")

    original_base_dir = app_settings.base_dir
    app_settings.base_dir = tmp_path

    src_file = LibraryFile(
        filename="Cube.stl",
        file_path=str(src_path.relative_to(tmp_path)),
        file_type="stl",
        file_size=src_path.stat().st_size,
    )
    db_session.add(src_file)

    presets = {}
    for kind in ("printer", "process", "filament"):
        p = LocalPreset(
            name=f"Test {kind}",
            preset_type=kind,
            source="orcaslicer",
            setting=json.dumps({"name": f"Test {kind}", "type": kind}),
        )
        db_session.add(p)
        presets[kind] = p

    db_session.add(SettingsModel(key="preferred_slicer", value="orcaslicer"))
    await db_session.commit()

    for p in presets.values():
        await db_session.refresh(p)
    await db_session.refresh(src_file)

    yield {
        "src_file_id": src_file.id,
        "printer_id": presets["printer"].id,
        "process_id": presets["process"].id,
        "filament_id": presets["filament"].id,
        "tmp_path": tmp_path,
    }

    app_settings.base_dir = original_base_dir
    slicer_api_module.set_shared_http_client(None)


# ---------------------------------------------------------------------------
# POST /library/files/{id}/slice — synchronous validation paths
# ---------------------------------------------------------------------------


class TestSliceValidation:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_returns_404_when_source_missing(self, async_client: AsyncClient, slice_test_setup):
        _install_mock_sidecar(lambda r: httpx.Response(200, content=b""))
        response = await async_client.post(
            "/api/v1/library/files/999999/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
            },
        )
        assert response.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_returns_400_for_wrong_file_type(self, async_client: AsyncClient, db_session, slice_test_setup):
        gcode_path = slice_test_setup["tmp_path"] / "library" / "files" / "out.gcode"
        gcode_path.write_bytes(b"; gcode\n")
        gfile = LibraryFile(
            filename="out.gcode",
            file_path=str(gcode_path.relative_to(slice_test_setup["tmp_path"])),
            file_type="gcode",
            file_size=10,
        )
        db_session.add(gfile)
        await db_session.commit()
        await db_session.refresh(gfile)

        _install_mock_sidecar(lambda r: httpx.Response(200, content=b""))
        response = await async_client.post(
            f"/api/v1/library/files/{gfile.id}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
            },
        )
        assert response.status_code == 400
        assert "STL, 3MF, or STEP" in response.json()["detail"]


# ---------------------------------------------------------------------------
# POST /library/files/{id}/slice — async dispatch + bg job
# ---------------------------------------------------------------------------


class TestSliceLibraryFile:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_happy_path_returns_202_then_job_completes_with_library_file(
        self, async_client: AsyncClient, slice_test_setup
    ):
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["url"] = str(request.url)
            return httpx.Response(
                status_code=200,
                content=_make_3mf_with_settings(sliced_output=True),
                headers={
                    "x-print-time-seconds": "656",
                    "x-filament-used-g": "0.94",
                    "x-filament-used-mm": "302.5",
                },
            )

        _install_mock_sidecar(handler)

        response = await async_client.post(
            f"/api/v1/library/files/{slice_test_setup['src_file_id']}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
            },
        )
        assert response.status_code == 202, response.text
        body = response.json()
        assert body["status"] == "pending"
        assert body["status_url"].startswith("/api/v1/slice-jobs/")

        final = await _wait_for_job(async_client, body["job_id"])
        assert final["status"] == "completed", final
        assert final["result"]["library_file_id"] != slice_test_setup["src_file_id"]
        assert final["result"]["print_time_seconds"] == 656
        assert captured["url"].endswith("/slice")

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_bed_type_override_patches_process_profile(self, async_client: AsyncClient, slice_test_setup):
        """#1337: when SliceRequest.bed_type is set, the process JSON sent to
        the sidecar must carry curr_bed_type with that exact value. Without
        the patch, slicing high-temp filaments on a "Cool Plate" process
        preset fails inside the slicer CLI with "does not support filament 1"
        and the user has no way to switch plates from the SliceModal."""
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["body"] = bytes(request.content)
            return httpx.Response(
                status_code=200,
                content=_make_3mf_with_settings(sliced_output=True),
                headers={
                    "x-print-time-seconds": "10",
                    "x-filament-used-g": "0.1",
                    "x-filament-used-mm": "1.0",
                },
            )

        _install_mock_sidecar(handler)
        response = await async_client.post(
            f"/api/v1/library/files/{slice_test_setup['src_file_id']}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
                "bed_type": "Textured PEI Plate",
            },
        )
        assert response.status_code == 202
        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "completed", final

        # The presetProfile part of the multipart upload now carries the
        # override. Searching the raw body avoids parsing the multipart by
        # hand — the substring is unique enough since we control the JSON
        # being patched.
        assert b'"curr_bed_type": "Textured PEI Plate"' in captured["body"], (
            "bed_type override must appear in the process JSON sent to the sidecar"
        )

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_bed_type_omitted_leaves_process_profile_untouched(self, async_client: AsyncClient, slice_test_setup):
        """Companion to the override test: the patch must NOT fire when the
        client omits bed_type, so the process preset's own curr_bed_type
        (or absence thereof) is forwarded to the sidecar unchanged."""
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["body"] = bytes(request.content)
            return httpx.Response(
                status_code=200,
                content=_make_3mf_with_settings(sliced_output=True),
                headers={
                    "x-print-time-seconds": "10",
                    "x-filament-used-g": "0.1",
                    "x-filament-used-mm": "1.0",
                },
            )

        _install_mock_sidecar(handler)
        response = await async_client.post(
            f"/api/v1/library/files/{slice_test_setup['src_file_id']}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
            },
        )
        assert response.status_code == 202
        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "completed", final
        assert b"curr_bed_type" not in captured["body"], (
            "bed_type must stay out of the process JSON when no override is set"
        )

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_process_overrides_patch_selected_profile(self, async_client: AsyncClient, slice_test_setup):
        """#83: the common process controls from the slice modal are applied
        to the selected process profile before it reaches the sidecar."""
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["body"] = bytes(request.content)
            return httpx.Response(
                status_code=200,
                content=_make_3mf_with_settings(sliced_output=True),
                headers={
                    "x-print-time-seconds": "10",
                    "x-filament-used-g": "0.1",
                    "x-filament-used-mm": "1.0",
                },
            )

        _install_mock_sidecar(handler)
        response = await async_client.post(
            f"/api/v1/library/files/{slice_test_setup['src_file_id']}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
                "process_overrides": {
                    "layer_height": 0.2,
                    "wall_loops": 3,
                    "sparse_infill_density": "20%",
                    "enable_support": True,
                },
            },
        )
        assert response.status_code == 202
        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "completed", final
        assert b'"layer_height": "0.2"' in captured["body"]
        assert b'"wall_loops": "3"' in captured["body"]
        assert b'"sparse_infill_density": "20%"' in captured["body"]
        assert b'"enable_support": "1"' in captured["body"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_layout_controls_reach_sidecar(self, async_client: AsyncClient, slice_test_setup):
        """#83: auto-arrange and auto-orient are forwarded as opt-in form
        fields; the sidecar must receive no false-valued fields by default."""
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["body"] = bytes(request.content)
            return httpx.Response(
                status_code=200,
                content=_make_3mf_with_settings(sliced_output=True),
                headers={
                    "x-print-time-seconds": "10",
                    "x-filament-used-g": "0.1",
                    "x-filament-used-mm": "1.0",
                },
            )

        _install_mock_sidecar(handler)
        response = await async_client.post(
            f"/api/v1/library/files/{slice_test_setup['src_file_id']}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
                "auto_arrange": True,
                "auto_orient": True,
            },
        )
        assert response.status_code == 202
        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "completed", final
        assert b'name="arrange"' in captured["body"]
        assert b'name="orient"' in captured["body"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_invalid_preset_id_surfaces_as_failed_job_with_status_400(
        self, async_client: AsyncClient, slice_test_setup
    ):
        _install_mock_sidecar(lambda r: httpx.Response(200, content=b""))
        response = await async_client.post(
            f"/api/v1/library/files/{slice_test_setup['src_file_id']}/slice",
            json={
                # Swap printer/filament — both exist but wrong preset_type.
                "printer_preset_id": slice_test_setup["filament_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["printer_id"],
            },
        )
        assert response.status_code == 202

        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "failed"
        assert final["error_status"] == 400
        assert "preset_type" in (final["error_detail"] or "")

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_unknown_preferred_slicer_fails_with_400(
        self, async_client: AsyncClient, db_session, slice_test_setup
    ):
        await db_session.execute(
            SettingsModel.__table__.update().where(SettingsModel.key == "preferred_slicer").values(value="prusaslicer")
        )
        await db_session.commit()

        _install_mock_sidecar(lambda r: httpx.Response(200, content=b""))
        response = await async_client.post(
            f"/api/v1/library/files/{slice_test_setup['src_file_id']}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
            },
        )
        assert response.status_code == 202
        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "failed"
        assert final["error_status"] == 400
        assert "preferred_slicer" in (final["error_detail"] or "")

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_sidecar_unreachable_fails_with_502(self, async_client: AsyncClient, slice_test_setup):
        def handler(_: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        _install_mock_sidecar(handler)
        response = await async_client.post(
            f"/api/v1/library/files/{slice_test_setup['src_file_id']}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
            },
        )
        assert response.status_code == 202
        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "failed"
        assert final["error_status"] == 502
        assert "unreachable" in (final["error_detail"] or "").lower()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_slicer_stall_fails_with_504(self, async_client: AsyncClient, slice_test_setup, monkeypatch):
        """A stalled slice is a gateway timeout, not an unexpected 500."""
        from backend.app.services.slicer_api import SlicerTimeoutError

        class TimeoutService:
            def __init__(self, *_args, **_kwargs):
                pass

            async def slice_with_profiles(self, **_kwargs):
                raise SlicerTimeoutError("slicer stalled")

            async def slice_without_profiles(self, **_kwargs):
                raise AssertionError("a non-3MF slice must not use the fallback")

            async def close(self):
                pass

        monkeypatch.setattr(slicer_api_module, "SlicerApiService", TimeoutService)
        response = await async_client.post(
            f"/api/v1/library/files/{slice_test_setup['src_file_id']}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
            },
        )
        assert response.status_code == 202

        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "failed"
        assert final["error_status"] == 504
        assert final["error_detail"] == "slicer stalled"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_3mf_falls_back_to_embedded_settings_on_cli_failure(
        self, async_client: AsyncClient, db_session, slice_test_setup
    ):
        # When the slicer CLI fails on the --load-settings path (segfault
        # on complex H2D models), Grove Control retries with no profile triplet
        # so the CLI uses the file's embedded settings.
        src_3mf_path = slice_test_setup["tmp_path"] / "library" / "files" / "complex.3mf"
        src_3mf_path.write_bytes(_make_3mf_with_settings({"prime_tower_brim_width": "-1"}))
        threemf = LibraryFile(
            filename="complex.3mf",
            file_path=str(src_3mf_path.relative_to(slice_test_setup["tmp_path"])),
            file_type="3mf",
            file_size=src_3mf_path.stat().st_size,
        )
        db_session.add(threemf)
        await db_session.commit()
        await db_session.refresh(threemf)

        call_count = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            if not _is_slice_post(request):
                return httpx.Response(404)
            call_count["n"] += 1
            # First call: profile triplet present → simulate CLI 5xx
            if call_count["n"] == 1:
                return httpx.Response(
                    status_code=500,
                    json={"message": "Failed to slice the model"},
                )
            # Retry: no profile triplet → succeed with embedded settings
            return httpx.Response(
                status_code=200,
                content=_make_3mf_with_settings(sliced_output=True),
                headers={
                    "x-print-time-seconds": "100",
                    "x-filament-used-g": "1.0",
                    "x-filament-used-mm": "100",
                },
            )

        _install_mock_sidecar(handler)
        response = await async_client.post(
            f"/api/v1/library/files/{threemf.id}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
            },
        )
        assert response.status_code == 202

        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "completed", final
        assert final["result"]["used_embedded_settings"] is True
        assert call_count["n"] == 2  # primary + fallback retry

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_process_overrides_do_not_fall_back_and_get_discarded(
        self, async_client: AsyncClient, db_session, slice_test_setup
    ):
        """An explicit process edit must not silently disappear when the
        profile-driven CLI path fails and the embedded-settings fallback is
        unavailable for that request."""
        src_3mf_path = slice_test_setup["tmp_path"] / "library" / "files" / "override-failure.3mf"
        src_3mf_path.write_bytes(_make_3mf_with_settings())
        threemf = LibraryFile(
            filename="override-failure.3mf",
            file_path=str(src_3mf_path.relative_to(slice_test_setup["tmp_path"])),
            file_type="3mf",
            file_size=src_3mf_path.stat().st_size,
        )
        db_session.add(threemf)
        await db_session.commit()
        await db_session.refresh(threemf)

        call_count = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            if not _is_slice_post(request):
                return httpx.Response(404)
            call_count["n"] += 1
            return httpx.Response(status_code=500, json={"message": "Failed to slice the model"})

        _install_mock_sidecar(handler)
        response = await async_client.post(
            f"/api/v1/library/files/{threemf.id}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
                "process_overrides": {"layer_height": 0.2},
            },
        )
        assert response.status_code == 202

        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "failed", final
        assert final["error_status"] == 502
        assert call_count["n"] == 1

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_embedded_settings_require_matching_target_printer(
        self, async_client: AsyncClient, db_session, slice_test_setup
    ):
        """The embedded-settings opt-in is a printer-safety decision and must
        be enforced by the API, not only by the SliceModal checkbox."""
        src_3mf_path = slice_test_setup["tmp_path"] / "library" / "files" / "embedded-x1c.3mf"
        src_3mf_path.write_bytes(_make_3mf_with_settings({"printer_model": "Bambu Lab X1 Carbon"}))
        threemf = LibraryFile(
            filename="embedded-x1c.3mf",
            file_path=str(src_3mf_path.relative_to(slice_test_setup["tmp_path"])),
            file_type="3mf",
            file_size=src_3mf_path.stat().st_size,
        )
        target = LocalPreset(
            name="# Bambu Lab H2D 0.4 nozzle",
            preset_type="printer",
            source="orcaslicer",
            setting=json.dumps({"name": "Bambu Lab H2D 0.4 nozzle", "printer_model": "Bambu Lab H2D"}),
        )
        db_session.add_all([threemf, target])
        await db_session.commit()
        await db_session.refresh(threemf)
        await db_session.refresh(target)

        call_count = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            if _is_slice_post(request):
                call_count["n"] += 1
            return httpx.Response(status_code=500, json={"message": "sidecar must not be called"})

        _install_mock_sidecar(handler)
        response = await async_client.post(
            f"/api/v1/library/files/{threemf.id}/slice",
            json={
                "printer_preset": {"source": "local", "id": str(target.id)},
                "process_preset": {"source": "local", "id": str(slice_test_setup["process_id"])},
                "filament_presets": [{"source": "local", "id": str(slice_test_setup["filament_id"])}],
                "use_embedded_settings": True,
            },
        )
        assert response.status_code == 202

        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "failed", final
        assert final["error_status"] == 400
        assert "matches the selected target printer" in (final["error_detail"] or "")
        assert call_count["n"] == 0

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_incomplete_successful_3mf_does_not_fall_back_to_embedded_settings(
        self, async_client: AsyncClient, db_session, slice_test_setup
    ):
        """A corrupt 200 response is not a CLI crash and must not silently
        switch the requested printer/process back to the source settings."""
        src_3mf_path = slice_test_setup["tmp_path"] / "library" / "files" / "incomplete.3mf"
        src_3mf_path.write_bytes(_make_3mf_with_settings())
        threemf = LibraryFile(
            filename="incomplete.3mf",
            file_path=str(src_3mf_path.relative_to(slice_test_setup["tmp_path"])),
            file_type="3mf",
            file_size=src_3mf_path.stat().st_size,
        )
        db_session.add(threemf)
        await db_session.commit()
        await db_session.refresh(threemf)

        call_count = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            if not _is_slice_post(request):
                return httpx.Response(404)
            call_count["n"] += 1
            if call_count["n"] == 1:
                return httpx.Response(status_code=200, content=b"not a 3MF")
            return httpx.Response(
                status_code=200,
                content=_make_3mf_with_settings(sliced_output=True),
                headers={"x-print-time-seconds": "1"},
            )

        _install_mock_sidecar(handler)
        response = await async_client.post(
            f"/api/v1/library/files/{threemf.id}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
            },
        )
        assert response.status_code == 202

        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "failed"
        assert final["error_status"] == 502
        assert "not a valid" in (final["error_detail"] or "")
        assert call_count["n"] == 1

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_stl_does_not_fall_back_on_cli_failure(self, async_client: AsyncClient, slice_test_setup):
        # STL has no embedded settings — the CLI 5xx is terminal.
        call_count = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            if not _is_slice_post(request):
                return httpx.Response(404)
            call_count["n"] += 1
            return httpx.Response(
                status_code=500,
                json={"message": "Failed to slice the model"},
            )

        _install_mock_sidecar(handler)
        response = await async_client.post(
            f"/api/v1/library/files/{slice_test_setup['src_file_id']}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
            },
        )
        assert response.status_code == 202
        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "failed"
        assert final["error_status"] == 502
        assert call_count["n"] == 1  # No retry for STL

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_3mf_input_forwarded_unmodified_to_sidecar(
        self, async_client: AsyncClient, db_session, slice_test_setup
    ):
        # 3MF input must be forwarded to the sidecar verbatim — every
        # Metadata/*.config the source carries (project_settings,
        # model_settings, slice_info, cut_information) is needed by the
        # CLI to find plate definitions and baseline config; an earlier
        # version of this code stripped them and caused the CLI to
        # silently exit immediately after "Initializing StaticPrintConfigs"
        # for every 3MF slice. --load-settings overrides the specific
        # fields the user changed; the rest comes from the embedded data.
        src_3mf_path = slice_test_setup["tmp_path"] / "library" / "files" / "real.3mf"
        src_3mf_path.write_bytes(_make_3mf_with_settings({"prime_tower_brim_width": "-1"}))
        threemf = LibraryFile(
            filename="real.3mf",
            file_path=str(src_3mf_path.relative_to(slice_test_setup["tmp_path"])),
            file_type="3mf",
            file_size=src_3mf_path.stat().st_size,
        )
        db_session.add(threemf)
        await db_session.commit()
        await db_session.refresh(threemf)

        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["body"] = request.content
            return httpx.Response(
                status_code=200,
                content=_make_3mf_with_settings(sliced_output=True),
                headers={
                    "x-print-time-seconds": "1",
                    "x-filament-used-g": "0",
                    "x-filament-used-mm": "0",
                },
            )

        _install_mock_sidecar(handler)
        response = await async_client.post(
            f"/api/v1/library/files/{threemf.id}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
            },
        )
        assert response.status_code == 202
        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "completed", final

        # Recover the embedded zip from the multipart body and assert ALL
        # the source's Metadata/*.config files are still present — the
        # opposite of the previous (broken) "strip everything" test.
        body = captured["body"]
        pk = body.find(b"PK\x03\x04")
        assert pk >= 0, "3MF body not found in multipart payload"
        with zipfile.ZipFile(io.BytesIO(body[pk:]), "r") as zin:
            names = set(zin.namelist())
        assert "Metadata/project_settings.config" in names
        assert "Metadata/model_settings.config" in names
        assert "Metadata/slice_info.config" in names
        assert "Metadata/cut_information.xml" in names
        assert "3D/3dmodel.model" in names


# ---------------------------------------------------------------------------
# GET /slice-jobs/{id}
# ---------------------------------------------------------------------------


class TestSliceJobs:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_unknown_job_returns_404(self, async_client: AsyncClient):
        # Sweep dispatcher state so a fresh ID is unknown.
        slice_dispatch._jobs.clear()
        r = await async_client.get("/api/v1/slice-jobs/999999")
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# POST /archives/{id}/slice — re-sliced archive reflects the target printer
# ---------------------------------------------------------------------------


def _make_sliced_3mf(printer_model_id: str, bed_type: str | None = None) -> bytes:
    """A minimal sliced-output 3MF that embeds a printer_model_id in
    slice_info.config, the way a real Bambu Studio / OrcaSlicer export does.
    ThreeMFParser reads this into metadata['sliced_for_model']. When
    ``bed_type`` is set, also embed ``curr_bed_type`` so the parser surfaces
    ``metadata['bed_type']`` — needed for the bed-type lift assertion in
    TestSliceArchiveReslicedBedType."""
    extra_meta = f"<metadata key='curr_bed_type' value='{bed_type}'/>" if bed_type else ""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("3D/3dmodel.model", "<model/>")
        zf.writestr(
            "Metadata/slice_info.config",
            (
                "<config><plate>"
                f"<metadata key='printer_model_id' value='{printer_model_id}'/>"
                f"{extra_meta}"
                "</plate></config>"
            ),
        )
        zf.writestr("Metadata/plate_1.gcode", b"G1 X1")
        zf.writestr("Metadata/plate_1.gcode.md5", b"deadbeef")
        zf.writestr("Metadata/plate_1.json", b"{}")
        zf.writestr("Metadata/plate_1.png", b"PLATE_RENDER")
    return buf.getvalue()


class TestCrossClassSliceAllLoop:
    """#1493: when the user picks "Slice all plates" on a cross-class source
    (X1C → H2D), Grove Control must NOT send a single ``--slice 0 --arrange 1``
    call — that consolidates every plate's objects onto one bed via BS's
    project-wide arrange. Instead it loops per plate (``plate=N, arrange=true``)
    and merges the N single-plate outputs into one multi-plate 3MF locally.
    This test mocks the sidecar to assert (a) N calls happen, one per plate,
    each with arrange=true, and (b) the resulting file's stored 3MF
    contains plate_1..plate_N.gcode entries."""

    @staticmethod
    def _make_multi_plate_x1c_source(plate_count: int = 3) -> bytes:
        """Source 3MF: X1C-stamped, N plates declared via model_settings."""
        objects = "\n".join(
            f'<object id="{i}"><metadata key="extruder" value="{i}"/></object>' for i in range(1, plate_count + 1)
        )
        plate_blocks = "\n".join(
            f'<plate><metadata key="plater_id" value="{i}"/>'
            f'<model_instance><metadata key="object_id" value="{i}"/></model_instance></plate>'
            for i in range(1, plate_count + 1)
        )
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("3D/3dmodel.model", "<model/>")
            zf.writestr(
                "Metadata/project_settings.config",
                json.dumps({"printer_model": "Bambu Lab X1 Carbon"}),
            )
            zf.writestr(
                "Metadata/model_settings.config",
                f"<?xml version='1.0'?>\n<config>\n{objects}\n{plate_blocks}\n</config>\n",
            )
        return buf.getvalue()

    @staticmethod
    def _make_single_plate_sliced_output(plate_num: int) -> bytes:
        """Mock per-plate output: looks like what BS CLI returns for
        --slice N. Carries an H2D project_settings (target), a one-line
        slice_info <plate> block, and a per-plate gcode + thumbnail."""
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("3D/3dmodel.model", "<model/>")
            zf.writestr(
                "Metadata/project_settings.config",
                json.dumps({"printer_model": "Bambu Lab H2D"}),
            )
            zf.writestr("Metadata/model_settings.config", "<config/>")
            zf.writestr(
                "Metadata/slice_info.config",
                f"<config><plate><metadata key='index' value='{plate_num}'/>"
                f"<metadata key='printer_model_id' value='O1D'/></plate></config>",
            )
            zf.writestr(f"Metadata/plate_{plate_num}.gcode", f"G{plate_num}".encode())
            zf.writestr(f"Metadata/plate_{plate_num}.gcode.md5", b"deadbeef")
            zf.writestr(f"Metadata/plate_{plate_num}.json", b"{}")
            zf.writestr(f"Metadata/plate_{plate_num}.png", f"P{plate_num}".encode())
        return buf.getvalue()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_loops_per_plate_when_cross_class_with_plate_zero(
        self, async_client: AsyncClient, db_session, slice_test_setup, printer_factory, archive_factory, monkeypatch
    ):
        tmp_path = slice_test_setup["tmp_path"]

        src_dir = tmp_path / "archives" / "src"
        src_dir.mkdir(parents=True, exist_ok=True)
        src_3mf = src_dir / "mewtwo.3mf"
        src_3mf.write_bytes(self._make_multi_plate_x1c_source(plate_count=3))
        printer = await printer_factory()
        source = await archive_factory(
            printer.id,
            filename="mewtwo.3mf",
            file_path=str(src_3mf.relative_to(tmp_path)),
            sliced_for_model="X1C",
            with_run=False,
        )

        # H2D target preset — the cross-class detector reads the
        # ``printer_model`` field off the resolved JSON.
        h2d = LocalPreset(
            name="# Bambu Lab H2D 0.4 nozzle",
            preset_type="printer",
            source="orcaslicer",
            setting=json.dumps({"name": "Bambu Lab H2D 0.4 nozzle", "printer_model": "Bambu Lab H2D"}),
        )
        db_session.add(h2d)
        second_filament = LocalPreset(
            name="Test filament 2",
            preset_type="filament",
            source="orcaslicer",
            setting=json.dumps({"name": "Test filament 2", "type": "filament"}),
        )
        third_filament = LocalPreset(
            name="Test filament 3",
            preset_type="filament",
            source="orcaslicer",
            setting=json.dumps({"name": "Test filament 3", "type": "filament"}),
        )
        db_session.add(second_filament)
        db_session.add(third_filament)
        await db_session.commit()
        await db_session.refresh(h2d)
        await db_session.refresh(second_filament)
        await db_session.refresh(third_filament)

        # Mock sidecar: capture every request and respond with that
        # plate's single-plate output. We expect one request per plate
        # in the source (3 here).
        captured_requests: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            if not _is_slice_post(request):
                return httpx.Response(404)
            # Multipart bodies aren't trivially parseable here; pull
            # the plate field by string search since the helper sends
            # ``name="plate"`` immediately followed by the value.
            body = request.content
            plate = None
            marker = b'name="plate"\r\n\r\n'
            idx = body.find(marker)
            if idx != -1:
                # Find the next CRLF after the value start.
                start = idx + len(marker)
                end = body.find(b"\r\n", start)
                try:
                    plate = int(body[start:end].decode("utf-8"))
                except (UnicodeDecodeError, ValueError):
                    plate = None
            arrange_in_body = b'name="arrange"' in body
            captured_requests.append(
                {
                    "plate": plate,
                    "arrange": arrange_in_body,
                    "body": body,
                }
            )

            return httpx.Response(
                status_code=200,
                content=self._make_single_plate_sliced_output(plate or 1),
                headers={
                    "x-print-time-seconds": "600",
                    "x-filament-used-g": "5.0",
                    "x-filament-used-mm": "1600.0",
                },
            )

        _install_mock_sidecar(handler)

        # plate=0 + cross-class triplet → backend should enter the
        # per-plate loop, slice each of the 3 plates with arrange=True,
        # and merge into one archive.
        resp = await async_client.post(
            f"/api/v1/archives/{source.id}/slice",
            json={
                "printer_preset": {"source": "local", "id": str(h2d.id)},
                "process_preset": {"source": "local", "id": str(slice_test_setup["process_id"])},
                "filament_presets": [
                    {"source": "local", "id": str(slice_test_setup["filament_id"])},
                    {"source": "local", "id": str(second_filament.id)},
                    {"source": "local", "id": str(third_filament.id)},
                ],
                "plate": 0,
            },
        )
        assert resp.status_code == 202, resp.text

        final = await _wait_for_job(async_client, resp.json()["job_id"], timeout=15.0)
        assert final["status"] == "completed", final

        # Exactly one sidecar call per plate, in plate order. The
        # ``--arrange 1`` flag travels with every per-plate sub-slice
        # (it's what fixes the cross-class boundary error).
        plates_called = [c["plate"] for c in captured_requests]
        arrange_used = [c["arrange"] for c in captured_requests]
        assert plates_called == [1, 2, 3], plates_called
        assert all(arrange_used), arrange_used
        # Each per-plate slice must normalize its own unused slots. Plate 1
        # uses slot 1 and plate 2 uses slot 2; the opposite filament must not
        # be sent into either plate's CLI validation.
        assert b'"name": "Test filament 2"' not in captured_requests[0]["body"]
        assert b'"name": "Test filament 2"' in captured_requests[1]["body"]
        assert b'"name": "Test filament 3"' not in captured_requests[1]["body"]
        assert b'"name": "Test filament 3"' in captured_requests[2]["body"]

        # The merged file has plate_1..plate_3.gcode inside its one
        # output 3MF (single file in Files, three plates).
        new_file = await _get_committed_row(db_session, LibraryFile, final["result"]["library_file_id"])
        file_path = tmp_path / new_file.file_path
        with zipfile.ZipFile(file_path, "r") as zf:
            entries = set(zf.namelist())
        assert "Metadata/plate_1.gcode" in entries
        assert "Metadata/plate_2.gcode" in entries
        assert "Metadata/plate_3.gcode" in entries
        # Per-plate-result totals are summed onto the merged file.
        assert new_file.file_metadata["print_time_seconds"] == 600 * 3
        assert new_file.file_metadata["filament_used_g"] == pytest.approx(5.0 * 3)


class TestSliceArchiveSavesToFiles:
    """Slicing an Archive entry saves the output to Files, like slicing from
    Files does. Nothing has been printed, so no Archive row is created."""

    @staticmethod
    async def _slice_archive(async_client, db_session, slice_test_setup, printer_factory, archive_factory, monkeypatch):
        tmp_path = slice_test_setup["tmp_path"]
        src_dir = tmp_path / "archives" / "src"
        src_dir.mkdir(parents=True, exist_ok=True)
        src_3mf = src_dir / "cube.3mf"
        src_3mf.write_bytes(_make_3mf_with_settings())
        printer = await printer_factory()
        source = await archive_factory(
            printer.id,
            filename="cube.3mf",
            file_path=str(src_3mf.relative_to(tmp_path)),
            sliced_for_model="X1C",
            with_run=False,
        )
        source_id = source.id

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                status_code=200,
                content=_make_sliced_3mf("O1D", bed_type="Textured PEI Plate"),
                headers={
                    "x-print-time-seconds": "600",
                    "x-filament-used-g": "5.0",
                    "x-filament-used-mm": "1600.0",
                },
            )

        _install_mock_sidecar(handler)

        resp = await async_client.post(
            f"/api/v1/archives/{source_id}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
            },
        )
        assert resp.status_code == 202, resp.text
        final = await _wait_for_job(async_client, resp.json()["job_id"])
        assert final["status"] == "completed", final
        return source_id, final

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_output_is_a_root_file_that_records_its_source_archive(
        self, async_client: AsyncClient, db_session, slice_test_setup, printer_factory, archive_factory, monkeypatch
    ):
        source_id, final = await self._slice_archive(
            async_client, db_session, slice_test_setup, printer_factory, archive_factory, monkeypatch
        )

        result = final["result"]
        assert "archive_id" not in result
        new_file = await _get_committed_row(db_session, LibraryFile, result["library_file_id"])
        assert new_file.folder_id is None
        # Named after the source archive's print_name, as the Files route does.
        assert new_file.filename == "Test Print.gcode.3mf"
        assert new_file.file_type == "gcode.3mf"
        assert new_file.source_type == "sliced"
        assert new_file.file_metadata["sliced_from_archive_id"] == source_id
        assert new_file.file_metadata["print_time_seconds"] == 600
        assert new_file.file_metadata["filament_used_g"] == pytest.approx(5.0)
        # The slicer baked H2D into the output, so Files shows the model it
        # was sliced for rather than inheriting the source archive's X1C.
        assert new_file.file_metadata["sliced_for_model"] == "H2D"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_no_archive_row_is_created_and_source_is_untouched(
        self, async_client: AsyncClient, db_session, slice_test_setup, printer_factory, archive_factory, monkeypatch
    ):
        from sqlalchemy import func, select

        from backend.app.models.archive import PrintArchive

        source_id, _final = await self._slice_archive(
            async_client, db_session, slice_test_setup, printer_factory, archive_factory, monkeypatch
        )

        db_session.expire_all()
        archive_count = (await db_session.execute(select(func.count()).select_from(PrintArchive))).scalar_one()
        assert archive_count == 1
        source = await db_session.get(PrintArchive, source_id)
        assert source.sliced_for_model == "X1C"


class TestSlicerRejectionMessage:
    """_slicer_rejection_message distinguishes a real slicer content rejection
    (surface it to the user) from a CLI crash (fall back to embedded)."""

    def test_extracts_bed_boundary_reason(self):
        text = (
            "Slicer CLI failed (500): Slicing failed with error from slicer: "
            "Some objects are located over the boundary of the heated bed.: "
            "Slicer process failed (exit code 204)\nstdout: trace ..."
        )
        assert _slicer_rejection_message(text) == "Some objects are located over the boundary of the heated bed."

    def test_extracts_filament_temp_reason(self):
        text = (
            "Slicer CLI failed (500): Slicing failed with error from slicer: "
            "The temperature difference of the filaments used is too large.: "
            "Slicer process failed (exit code 194)"
        )
        assert _slicer_rejection_message(text) == "The temperature difference of the filaments used is too large."

    def test_generic_cli_failure_is_not_a_rejection(self):
        # The #1201 CLI-crash signature carries no slicer error_string, so it
        # must still fall through to the embedded-settings fallback.
        assert _slicer_rejection_message("Slicer CLI failed (500): Failed to slice the model") is None

    def test_empty_or_unrelated_text(self):
        assert _slicer_rejection_message("") is None
        assert _slicer_rejection_message("Slicer sidecar unreachable: connection reset") is None

    def test_replaces_input_preset_invalid_placeholder_with_cli_error_line(self):
        # #1851: the CLI emits its catch-all "input preset file is invalid"
        # placeholder for every -5 exit, including real preset-vs-printer
        # compatibility rejections. The actual diagnostic only appears in the
        # stdout `[error] run NNNN:` line; the function must prefer that.
        text = (
            "Slicer CLI failed (500): Slicing failed with error from slicer: "
            "The input preset file is invalid and can not be parsed.: "
            "Slicer process failed (exit code 251)\n"
            "stdout: [2026-06-29 04:12:11.952784] [trace] Initializing StaticPrintConfigs\n"
            "[2026-06-29 04:12:12.175810] [error] run 3008: filament preset "
            "Generic PLA @BBL H2C (slot 1) is not compatible with printer "
            "Bambu Lab A1 0.4 nozzle.\n"
            "run found error, return -5, exit..."
        )
        assert (
            _slicer_rejection_message(text) == "filament preset Generic PLA @BBL H2C (slot 1) is not compatible with "
            "printer Bambu Lab A1 0.4 nozzle."
        )

    def test_keeps_meaningful_reason_even_when_cli_error_line_present(self):
        # When the headline error_string is already a useful reason (here:
        # the bed-boundary rejection), don't override it with a generic
        # `[error]` line that may just be the same message restated. Avoids
        # double-text duplication in the user-facing detail.
        text = (
            "Slicer CLI failed (500): Slicing failed with error from slicer: "
            "Some objects are located over the boundary of the heated bed.: "
            "Slicer process failed (exit code 204)\n"
            "stdout: [error] some unrelated stdout chatter"
        )
        assert _slicer_rejection_message(text) == "Some objects are located over the boundary of the heated bed."

    def test_cli_error_line_without_run_prefix(self):
        # The CLI sometimes logs `[error] <msg>` without the `run NNNN:`
        # prefix (different code paths). The regex must still pick it up.
        text = (
            "Slicer CLI failed (500): Slicing failed with error from slicer: "
            "The input preset file is invalid and can not be parsed.: "
            "Slicer process failed (exit code 251)\n"
            "stdout: [2026-06-29 12:00:00.000000] [error] Configuration parse failed: missing key 'printer_settings_id'"
        )
        assert _slicer_rejection_message(text) == "Configuration parse failed: missing key 'printer_settings_id'"


class TestSliceSlicerRejection:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_3mf_surfaces_slicer_rejection_instead_of_falling_back(
        self, async_client: AsyncClient, db_session, slice_test_setup
    ):
        """A real slicer content rejection (e.g. re-slicing for a printer with
        a smaller bed) must surface as a 400 — not silently fall back to the
        source 3MF's embedded settings, which would re-slice for the original
        printer and hide the problem."""
        src_3mf_path = slice_test_setup["tmp_path"] / "library" / "files" / "toobig.3mf"
        src_3mf_path.write_bytes(_make_3mf_with_settings())
        threemf = LibraryFile(
            filename="toobig.3mf",
            file_path=str(src_3mf_path.relative_to(slice_test_setup["tmp_path"])),
            file_type="3mf",
            file_size=src_3mf_path.stat().st_size,
        )
        db_session.add(threemf)
        await db_session.commit()
        await db_session.refresh(threemf)

        call_count = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            if not _is_slice_post(request):
                return httpx.Response(404)
            call_count["n"] += 1
            return httpx.Response(
                status_code=500,
                json={
                    "message": (
                        "Slicing failed with error from slicer: Some objects are "
                        "located over the boundary of the heated bed."
                    ),
                    "details": "Slicer process failed (exit code 204)",
                },
            )

        _install_mock_sidecar(handler)
        response = await async_client.post(
            f"/api/v1/library/files/{threemf.id}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
            },
        )
        assert response.status_code == 202

        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "failed", final
        assert final["error_status"] == 400
        assert "boundary of the heated bed" in (final["error_detail"] or "")
        # The slicer rejection must NOT trigger the embedded-settings retry.
        assert call_count["n"] == 1


# ---------------------------------------------------------------------------
# Nozzle-class re-slice guard — single-nozzle <-> dual-nozzle (H2D) is blocked
# ---------------------------------------------------------------------------

from fastapi import HTTPException  # noqa: E402

from backend.app.api.routes.library import (  # noqa: E402
    _canonical_printer_model,
    guard_nozzle_class_reslice,
)


class TestCanonicalPrinterModel:
    """_canonical_printer_model strips the '# ' clone prefix and the
    ' 0.4 nozzle' variant suffix so preset names resolve to a model code."""

    def test_strips_nozzle_suffix(self):
        assert _canonical_printer_model("Bambu Lab H2D 0.4 nozzle") == "H2D"

    def test_strips_clone_prefix_and_suffix(self):
        assert _canonical_printer_model("# Bambu Lab X1 Carbon 0.4 nozzle") == "X1C"

    def test_bare_model_and_empty(self):
        assert _canonical_printer_model("Bambu Lab H2D") == "H2D"
        assert _canonical_printer_model(None) is None
        assert _canonical_printer_model("") is None


class TestNozzleClassGuard:
    """guard_nozzle_class_reslice is now a no-op (#1493). Cross-class re-slicing
    is handled by the two-pass conversion in _run_slicer_with_fallback — so the
    guard never blocks. The function is kept (and these tests with it) so
    external forks / pinned versions that call it still link, and so a future
    regression that re-introduces a raise inside the helper gets caught here."""

    @staticmethod
    def _request() -> object:
        return type("_Req", (), {})()

    @pytest.mark.asyncio
    async def test_single_to_dual_is_allowed(self, monkeypatch):
        """Cross-class re-slice: handled by the two-pass converter, so the
        guard does NOT raise."""
        import backend.app.api.routes.library as lib

        async def _target(_db, _user, _request):
            return "H2D"

        monkeypatch.setattr(lib, "_resolve_target_printer_model", _target)
        # No raise — the converter handles this case now.
        await guard_nozzle_class_reslice(None, None, self._request(), "X1C")

    @pytest.mark.asyncio
    async def test_dual_to_single_is_allowed(self, monkeypatch):
        import backend.app.api.routes.library as lib

        async def _target(_db, _user, _request):
            return "X1C"

        monkeypatch.setattr(lib, "_resolve_target_printer_model", _target)
        await guard_nozzle_class_reslice(None, None, self._request(), "H2D")

    @pytest.mark.asyncio
    async def test_same_nozzle_class_is_allowed(self, monkeypatch):
        import backend.app.api.routes.library as lib

        async def _target(_db, _user, _request):
            return "P1S"

        monkeypatch.setattr(lib, "_resolve_target_printer_model", _target)
        await guard_nozzle_class_reslice(None, None, self._request(), "X1C")

    @pytest.mark.asyncio
    async def test_no_source_model_is_a_noop(self, monkeypatch):
        import backend.app.api.routes.library as lib

        async def _target(_db, _user, _request):
            return "H2D"

        monkeypatch.setattr(lib, "_resolve_target_printer_model", _target)
        await guard_nozzle_class_reslice(None, None, self._request(), None)

    @pytest.mark.asyncio
    async def test_null_request_is_a_noop(self):
        await guard_nozzle_class_reslice(None, None, None, "X1C")

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_archive_reslice_x1c_to_h2d_preset_path_is_not_400(
        self, async_client: AsyncClient, db_session, slice_test_setup, printer_factory, archive_factory, monkeypatch
    ):
        """End to end: the preset-driven archive re-slice from X1C to H2D no
        longer gets a synchronous 400 from the guard. It may still fail
        downstream (no sidecar in test env), but it must not be rejected by
        the nozzle-class guard's old "isn't supported yet" message."""
        tmp_path = slice_test_setup["tmp_path"]
        monkeypatch.setattr(app_settings, "archive_dir", tmp_path / "archive")

        src_dir = tmp_path / "archives" / "src"
        src_dir.mkdir(parents=True, exist_ok=True)
        src_3mf = src_dir / "cube.3mf"
        src_3mf.write_bytes(_make_3mf_with_settings())
        printer = await printer_factory()
        source = await archive_factory(
            printer.id,
            filename="cube.3mf",
            file_path=str(src_3mf.relative_to(tmp_path)),
            sliced_for_model="X1C",
            with_run=False,
        )

        h2d = LocalPreset(
            name="# Bambu Lab H2D 0.4 nozzle",
            preset_type="printer",
            source="orcaslicer",
            setting=json.dumps({"name": "Bambu Lab H2D 0.4 nozzle", "printer_model": "Bambu Lab H2D"}),
        )
        db_session.add(h2d)
        await db_session.commit()
        await db_session.refresh(h2d)

        resp = await async_client.post(
            f"/api/v1/archives/{source.id}/slice",
            json={
                "printer_preset": {"source": "local", "id": str(h2d.id)},
                "process_preset": {"source": "local", "id": str(slice_test_setup["process_id"])},
                "filament_presets": [{"source": "local", "id": str(slice_test_setup["filament_id"])}],
            },
        )
        if resp.status_code == 400:
            detail = resp.json().get("detail", "")
            assert "isn't supported" not in detail, f"guard still firing on preset path: {detail!r}"

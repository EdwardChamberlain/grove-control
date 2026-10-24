"""Integration tests for Bambu Cloud preset, device and firmware routes.

``BambuCloudService`` is replaced with a fake, so these exercise the route
layer: response shaping, error mapping (auth errors clear the stored token),
and the filament-info lookup chain (cache → cloud → local presets → built-in
table).
"""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest
from httpx import AsyncClient

from backend.app.api.routes import cloud as cloud_routes
from backend.app.api.routes.cloud import get_stored_token, store_token
from backend.app.services.bambu_cloud import BambuCloudAuthError, BambuCloudError


class FakeCloud:
    """Stand-in for BambuCloudService; class attributes configure responses."""

    instances: list[FakeCloud] = []
    settings: dict = {}
    details: dict[str, dict | Exception] = {}
    devices: dict | Exception = {"devices": []}
    firmware: dict[str, dict | Exception] = {}
    error: Exception | None = None  # raised by CRUD + listing calls when set
    calls: list[tuple] = []

    def __init__(self, region="global", on_auth_failure=None):
        self.region = region
        self.token = None
        self.closed = False
        FakeCloud.instances.append(self)

    def set_token(self, token):
        self.token = token

    @property
    def is_authenticated(self):
        return bool(self.token)

    async def close(self):
        self.closed = True

    def _maybe_fail(self):
        if FakeCloud.error:
            raise FakeCloud.error

    async def get_slicer_settings(self, version=None):
        FakeCloud.calls.append(("get_slicer_settings", version))
        self._maybe_fail()
        return FakeCloud.settings

    async def get_setting_detail(self, setting_id):
        FakeCloud.calls.append(("get_setting_detail", setting_id))
        self._maybe_fail()
        detail = FakeCloud.details.get(setting_id, {})
        if isinstance(detail, Exception):
            raise detail
        return detail

    async def get_devices(self):
        self._maybe_fail()
        if isinstance(FakeCloud.devices, Exception):
            raise FakeCloud.devices
        return FakeCloud.devices

    async def get_firmware_version(self, device_id):
        info = FakeCloud.firmware.get(device_id, {})
        if isinstance(info, Exception):
            raise info
        return info

    async def create_setting(self, **kwargs):
        FakeCloud.calls.append(("create_setting", kwargs))
        self._maybe_fail()
        return {"setting_id": "PFUSnew", **kwargs}

    async def update_setting(self, **kwargs):
        FakeCloud.calls.append(("update_setting", kwargs))
        self._maybe_fail()
        return {"ok": True}

    async def delete_setting(self, setting_id):
        FakeCloud.calls.append(("delete_setting", setting_id))
        self._maybe_fail()
        return {"success": True, "message": f"deleted {setting_id}"}


@pytest.fixture(autouse=True)
def fake_cloud(monkeypatch):
    FakeCloud.instances = []
    FakeCloud.settings = {}
    FakeCloud.details = {}
    FakeCloud.devices = {"devices": []}
    FakeCloud.firmware = {}
    FakeCloud.error = None
    FakeCloud.calls = []
    # Module-level caches would leak results between tests.
    monkeypatch.setattr(cloud_routes, "_filament_cache", {})
    monkeypatch.setattr(cloud_routes, "_filament_cache_time", 0)
    monkeypatch.setattr(cloud_routes, "_filament_id_name_cache", {})
    monkeypatch.setattr(cloud_routes, "_filament_id_name_cache_time", 0)
    with patch.object(cloud_routes, "BambuCloudService", FakeCloud):
        yield FakeCloud


@pytest.fixture
async def signed_in(db_session):
    await store_token(db_session, "cloud-token", "maker@example.com", "global")


def _all_closed() -> bool:
    return all(c.closed for c in FakeCloud.instances)


@pytest.mark.integration
class TestCloudSettings:
    @pytest.mark.parametrize(
        ("method", "path", "body"),
        [
            ("GET", "/api/v1/cloud/settings", None),
            ("GET", "/api/v1/cloud/settings/PFUS1", None),
            ("POST", "/api/v1/cloud/settings", {"type": "filament", "name": "x", "base_id": "GFSA00"}),
            ("PUT", "/api/v1/cloud/settings/PFUS1", {"name": "x"}),
            ("DELETE", "/api/v1/cloud/settings/PFUS1", None),
            ("GET", "/api/v1/cloud/devices", None),
            ("GET", "/api/v1/cloud/firmware-updates", None),
        ],
    )
    async def test_requires_a_stored_token(self, async_client: AsyncClient, method, path, body):
        response = await async_client.request(method, path, json=body)
        assert response.status_code == 401
        assert response.json()["detail"] == "Not authenticated"

    async def test_lists_presets_custom_first_and_maps_print_to_process(self, async_client: AsyncClient, signed_in):
        FakeCloud.settings = {
            "filament": {
                "private": [{"setting_id": "PFUS1", "name": "My PLA", "user_id": "42"}],
                "public": [{"setting_id": "GFSA00", "name": "Bambu PLA Basic"}],
            },
            "print": {"public": [{"id": "GP004", "name": "0.20mm Standard"}]},
        }
        response = await async_client.get("/api/v1/cloud/settings?version=1.2.3")
        assert response.status_code == 200
        body = response.json()
        assert [(s["setting_id"], s["is_custom"]) for s in body["filament"]] == [("PFUS1", True), ("GFSA00", False)]
        assert body["filament"][0]["user_id"] == "42"
        # Falls back to ``id`` when ``setting_id`` is absent.
        assert [(s["setting_id"], s["type"]) for s in body["process"]] == [("GP004", "process")]
        assert body["printer"] == []
        assert ("get_slicer_settings", "1.2.3") in FakeCloud.calls
        assert _all_closed()

    async def test_filaments_endpoint_returns_only_filaments(self, async_client: AsyncClient, signed_in):
        FakeCloud.settings = {
            "filament": {"public": [{"setting_id": "GFSA00", "name": "Bambu PLA Basic"}]},
            "printer": {"public": [{"setting_id": "GM001", "name": "X1C"}]},
        }
        response = await async_client.get("/api/v1/cloud/filaments")
        assert response.status_code == 200
        assert [s["setting_id"] for s in response.json()] == ["GFSA00"]

    async def test_auth_error_clears_stored_token(self, async_client: AsyncClient, db_session, signed_in):
        FakeCloud.error = BambuCloudAuthError("token rejected")
        response = await async_client.get("/api/v1/cloud/settings")
        assert response.status_code == 401
        assert response.json()["detail"] == "Authentication expired"
        db_session.expire_all()
        token, _email, _region = await get_stored_token(db_session)
        assert token is None
        assert _all_closed()

    async def test_cloud_error_is_a_500_and_keeps_token(self, async_client: AsyncClient, db_session, signed_in):
        FakeCloud.error = BambuCloudError("bambu is down")
        response = await async_client.get("/api/v1/cloud/settings")
        assert response.status_code == 500
        assert response.json()["detail"] == "bambu is down"
        token, _email, _region = await get_stored_token(db_session)
        assert token == "cloud-token"

    async def test_setting_detail_is_passed_through(self, async_client: AsyncClient, signed_in):
        FakeCloud.details = {"PFUS1": {"name": "My PLA", "setting": {"nozzle_temperature": ["220"]}}}
        response = await async_client.get("/api/v1/cloud/settings/PFUS1")
        assert response.status_code == 200
        assert response.json()["setting"]["nozzle_temperature"] == ["220"]

    async def test_create_update_delete(self, async_client: AsyncClient, signed_in):
        created = await async_client.post(
            "/api/v1/cloud/settings",
            json={
                "type": "filament",
                "name": "My PETG",
                "base_id": "GFSG99",
                "setting": {"nozzle_temperature": ["240"]},
            },
        )
        assert created.status_code == 200
        assert created.json()["setting_id"] == "PFUSnew"
        create_call = next(c for c in FakeCloud.calls if c[0] == "create_setting")[1]
        assert create_call == {
            "preset_type": "filament",
            "name": "My PETG",
            "base_id": "GFSG99",
            "setting": {"nozzle_temperature": ["240"]},
            "version": "2.0.0.0",
        }

        updated = await async_client.put("/api/v1/cloud/settings/PFUS1", json={"name": "Renamed"})
        assert updated.status_code == 200
        assert ("update_setting", {"setting_id": "PFUS1", "name": "Renamed", "setting": None}) in FakeCloud.calls

        deleted = await async_client.delete("/api/v1/cloud/settings/PFUS1")
        assert deleted.status_code == 200
        assert deleted.json() == {"success": True, "message": "deleted PFUS1"}
        assert _all_closed()

    @pytest.mark.parametrize(
        ("method", "path", "body"),
        [
            ("POST", "/api/v1/cloud/settings", {"type": "filament", "name": "x", "base_id": "GFSA00"}),
            ("PUT", "/api/v1/cloud/settings/PFUS1", {"name": "x"}),
            ("DELETE", "/api/v1/cloud/settings/PFUS1", None),
        ],
    )
    @pytest.mark.parametrize(("error", "status"), [(BambuCloudAuthError("x"), 401), (BambuCloudError("x"), 500)])
    async def test_crud_error_mapping(self, async_client: AsyncClient, signed_in, method, path, body, error, status):
        FakeCloud.error = error
        response = await async_client.request(method, path, json=body)
        assert response.status_code == status


@pytest.mark.integration
class TestCloudDevicesAndFirmware:
    async def test_devices_are_shaped(self, async_client: AsyncClient, signed_in):
        FakeCloud.devices = {
            "devices": [{"dev_id": "D1", "name": "Workshop", "dev_model_name": "X1C", "online": True}, {"dev_id": "D2"}]
        }
        response = await async_client.get("/api/v1/cloud/devices")
        assert response.status_code == 200
        assert response.json() == [
            {"dev_id": "D1", "name": "Workshop", "dev_model_name": "X1C", "dev_product_name": None, "online": True},
            {"dev_id": "D2", "name": "Unknown", "dev_model_name": None, "dev_product_name": None, "online": False},
        ]

    async def test_firmware_updates_count_and_tolerate_per_device_errors(self, async_client: AsyncClient, signed_in):
        FakeCloud.devices = {
            "devices": [{"dev_id": "D1", "name": "A"}, {"dev_id": "D2", "name": "B"}, {"dev_id": "D3", "name": "C"}]
        }
        FakeCloud.firmware = {
            "D1": {
                "current_version": "1.0",
                "latest_version": "1.1",
                "update_available": True,
                "release_notes": "fixes",
            },
            "D2": {"current_version": "1.1", "latest_version": "1.1", "update_available": False},
            "D3": BambuCloudError("firmware lookup failed"),
        }
        response = await async_client.get("/api/v1/cloud/firmware-updates")
        assert response.status_code == 200
        body = response.json()
        assert body["updates_available"] == 1
        by_id = {u["device_id"]: u for u in body["updates"]}
        assert by_id["D1"]["update_available"] is True
        assert by_id["D1"]["release_notes"] == "fixes"
        assert by_id["D3"] == {
            "device_id": "D3",
            "device_name": "C",
            "current_version": None,
            "latest_version": None,
            "update_available": False,
            "release_notes": None,
        }

    async def test_firmware_auth_error_clears_token(self, async_client: AsyncClient, db_session, signed_in):
        FakeCloud.devices = BambuCloudAuthError("expired")
        response = await async_client.get("/api/v1/cloud/firmware-updates")
        assert response.status_code == 401
        db_session.expire_all()
        assert (await get_stored_token(db_session))[0] is None


@pytest.mark.integration
class TestFilamentInfo:
    async def test_without_cloud_falls_back_to_builtin_names(self, async_client: AsyncClient):
        response = await async_client.post("/api/v1/cloud/filament-info", json=["GFA00", "ZZZ99", ""])
        assert response.status_code == 200
        assert response.json() == {
            "GFA00": {"name": "Bambu PLA Basic", "k": None},
            "ZZZ99": {"name": "", "k": None},
        }

    async def test_cloud_name_and_k_value_win_and_are_cached(self, async_client: AsyncClient, signed_in):
        FakeCloud.details = {"GFSA00": {"name": "Bambu PLA Basic @BBL X1C", "setting": {"pressure_advance": "0.02"}}}
        first = await async_client.post("/api/v1/cloud/filament-info", json=["GFA00"])
        assert first.json() == {"GFA00": {"name": "Bambu PLA Basic @BBL X1C", "k": 0.02}}
        # The cloud is asked for the converted setting id.
        assert ("get_setting_detail", "GFSA00") in FakeCloud.calls

        FakeCloud.calls.clear()
        second = await async_client.post("/api/v1/cloud/filament-info", json=["GFA00"])
        assert second.json() == first.json()
        assert FakeCloud.calls == []  # served from cache

    async def test_cloud_failure_falls_back_to_local_preset(self, async_client: AsyncClient, db_session, signed_in):
        from backend.app.models.local_preset import LocalPreset

        FakeCloud.details = {"PFUS77": BambuCloudError("not found")}
        db_session.add(
            LocalPreset(
                name="Local Silk PLA",
                preset_type="filament",
                source="orcaslicer",
                setting=json.dumps({"setting_id": "PFUS77", "pressure_advance": ["0.031"]}),
            )
        )
        await db_session.commit()

        response = await async_client.post("/api/v1/cloud/filament-info", json=["PFUS77"])
        assert response.status_code == 200
        assert response.json() == {"PFUS77": {"name": "Local Silk PLA", "k": 0.031}}


@pytest.mark.integration
class TestFilamentIdMap:
    async def test_empty_without_cloud(self, async_client: AsyncClient):
        response = await async_client.get("/api/v1/cloud/filament-id-map")
        assert response.status_code == 200
        assert response.json() == {}

    async def test_maps_custom_preset_filament_ids_to_clean_names(self, async_client: AsyncClient, signed_in):
        FakeCloud.settings = {
            "filament": {
                "private": [
                    {"setting_id": "PFUS1"},
                    {"setting_id": "PFUS2"},
                    {"setting_id": ""},
                    {"setting_id": "PFUS3"},
                ]
            }
        }
        FakeCloud.details = {
            "PFUS1": {"filament_id": "P4d64437", "name": "Devil Design PLA Basic @Bambu Lab H2D 0.4 nozzle"},
            "PFUS2": {"filament_id": "P5aaaaaa", "name": "Plain Name"},
            "PFUS3": BambuCloudError("gone"),
        }
        response = await async_client.get("/api/v1/cloud/filament-id-map")
        assert response.status_code == 200
        assert response.json() == {"P4d64437": "Devil Design PLA Basic", "P5aaaaaa": "Plain Name"}

    async def test_builtin_filaments_lists_the_static_table(self, async_client: AsyncClient):
        response = await async_client.get("/api/v1/cloud/builtin-filaments")
        assert response.status_code == 200
        names = {row["filament_id"]: row["name"] for row in response.json()}
        assert names["GFA00"] == "Bambu PLA Basic"
        assert len(names) > 50

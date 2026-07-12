"""API-key route coverage for CRUD and owner-sensitive edge cases."""

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
@pytest.mark.integration
async def test_api_key_create_lists_gets_updates_and_deletes(async_client: AsyncClient):
    create = await async_client.post(
        "/api/v1/api-keys/",
        json={
            "name": "CI Smoke Key",
            "can_queue": True,
            "can_control_printer": True,
            "can_read_status": True,
            "can_manage_library": False,
            "can_manage_inventory": False,
            "printer_ids": [1, 2],
        },
    )
    assert create.status_code == 200
    created = create.json()
    assert created["name"] == "CI Smoke Key"
    assert created["key"].startswith("bb_")
    assert created["key"].startswith(created["key_prefix"].removesuffix("..."))
    assert created["can_manage_library"] is False
    assert created["printer_ids"] == [1, 2]

    list_response = await async_client.get("/api/v1/api-keys/")
    assert list_response.status_code == 200
    listed = list_response.json()
    assert any(key["id"] == created["id"] for key in listed)
    assert all("key" not in key for key in listed), "full API key must only be returned at creation"

    get_response = await async_client.get(f"/api/v1/api-keys/{created['id']}")
    assert get_response.status_code == 200
    assert get_response.json()["key_prefix"] == created["key_prefix"]
    assert "key" not in get_response.json()

    patch_response = await async_client.patch(
        f"/api/v1/api-keys/{created['id']}",
        json={
            "name": "Renamed CI Key",
            "enabled": False,
            "can_queue": False,
            "printer_ids": [2],
        },
    )
    assert patch_response.status_code == 200
    patched = patch_response.json()
    assert patched["name"] == "Renamed CI Key"
    assert patched["enabled"] is False
    assert patched["can_queue"] is False
    assert patched["printer_ids"] == [2]

    delete_response = await async_client.delete(f"/api/v1/api-keys/{created['id']}")
    assert delete_response.status_code == 200
    assert delete_response.json()["message"] == "API key deleted"

    missing_response = await async_client.get(f"/api/v1/api-keys/{created['id']}")
    assert missing_response.status_code == 404


@pytest.mark.asyncio
@pytest.mark.integration
async def test_api_key_cloud_scope_rejected_without_owner(async_client: AsyncClient):
    create = await async_client.post(
        "/api/v1/api-keys/",
        json={"name": "Cloudless legacy key", "can_access_cloud": True},
    )
    assert create.status_code == 400
    assert "requires authentication" in create.json()["detail"]

    legacy = await async_client.post(
        "/api/v1/api-keys/",
        json={"name": "Legacy key", "can_access_cloud": False},
    )
    assert legacy.status_code == 200

    update = await async_client.patch(
        f"/api/v1/api-keys/{legacy.json()['id']}",
        json={"can_access_cloud": True},
    )
    assert update.status_code == 400
    assert "requires the API key to have an owner" in update.json()["detail"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_api_key_missing_ids_return_404(async_client: AsyncClient):
    assert (await async_client.get("/api/v1/api-keys/999999")).status_code == 404
    assert (await async_client.patch("/api/v1/api-keys/999999", json={"name": "nope"})).status_code == 404
    assert (await async_client.delete("/api/v1/api-keys/999999")).status_code == 404

"""Regression tests for rejecting library-folder moves to missing parents."""

import pytest
from backend.app.core.config import settings
from backend.app.models.library import LibraryFolder
from httpx import AsyncClient

pytestmark = pytest.mark.integration


@pytest.fixture
def storage(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr(settings, "base_dir", data)
    monkeypatch.setattr(settings, "archive_dir", data / "archive")
    return data


async def _folder(client, name, **kwargs):
    return (await client.post("/api/v1/library/folders", json={"name": name, **kwargs})).json()


async def _update(client, folder_id, **payload):
    return await client.put(f"/api/v1/library/folders/{folder_id}", json=payload)


async def test_missing_parent_returns_404_without_changes_and_valid_moves_still_work(
    async_client: AsyncClient, db_session, storage
):
    parent = await _folder(async_client, "Parent")
    child = await _folder(async_client, "Child")
    response = await _update(async_client, child["id"], name="Should rollback", parent_id=9999)

    assert response.status_code == 404
    folder = await db_session.get(LibraryFolder, child["id"])
    await db_session.refresh(folder)
    assert (folder.name, folder.parent_id) == ("Child", None)

    moved = await _update(async_client, child["id"], parent_id=parent["id"])
    assert moved.status_code == 200
    assert moved.json()["parent_id"] == parent["id"]

    to_root = await _update(async_client, child["id"], parent_id=0)
    assert to_root.status_code == 200
    assert to_root.json()["parent_id"] is None

"""Integration tests for the Temporary Files system folder (#237)."""

import io
import zipfile
from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient

from backend.tests.integration.test_ownership_permissions import TestOwnershipPermissionsSetup

STL = b"solid test\nendsolid test"


async def _upload(client: AsyncClient, name="part.stl", headers=None, **params):
    return await client.post(
        "/api/v1/library/files",
        files={"file": (name, STL, "application/octet-stream")},
        params={"generate_stl_thumbnails": "false", **params},
        headers=headers or {},
    )


async def _temporary_folder(client: AsyncClient, headers=None) -> dict:
    folders = (await client.get("/api/v1/library/folders", headers=headers or {})).json()
    return next(f for f in folders if f["system_key"] == "temporary_files")


@pytest.fixture
async def temp_folder(db_session):
    from backend.app.services.temporary_files import ensure_temporary_folder

    return await ensure_temporary_folder(db_session)


@pytest.fixture
async def user_folder(db_session):
    from backend.app.models.library import LibraryFolder

    folder = LibraryFolder(name="Mine")
    db_session.add(folder)
    await db_session.commit()
    await db_session.refresh(folder)
    return folder


class TestTemporaryUploads:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_temporary_upload_lands_in_system_folder(self, async_client: AsyncClient):
        resp = await _upload(async_client, temporary="true")
        assert resp.status_code == 200
        file_id = resp.json()["id"]

        folder = await _temporary_folder(async_client)
        assert folder["is_system"] is True
        assert folder["name"] == "Temporary Files"
        assert folder["retention_days"] == 7
        assert folder["file_count"] == 1

        listed = (await async_client.get("/api/v1/library/files", params={"folder_id": folder["id"]})).json()
        assert [f["id"] for f in listed] == [file_id]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_ordinary_upload_stays_at_root(self, async_client: AsyncClient, temp_folder):
        resp = await _upload(async_client)
        assert resp.status_code == 200
        detail = (await async_client.get(f"/api/v1/library/files/{resp.json()['id']}")).json()
        assert detail["folder_id"] is None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_temporary_files_hidden_from_all_files_search_and_stats(self, async_client: AsyncClient):
        await _upload(async_client, name="mine.stl")
        await _upload(async_client, name="direct.stl", temporary="true")

        all_files = (
            await async_client.get("/api/v1/library/files", params={"include_root": "false", "internal_only": "true"})
        ).json()
        assert [f["filename"] for f in all_files] == ["mine.stl"]

        root = (await async_client.get("/api/v1/library/files")).json()
        assert [f["filename"] for f in root] == ["mine.stl"]

        stats = (await async_client.get("/api/v1/library/stats")).json()
        assert stats["total_files"] == 1
        assert stats["total_folders"] == 0

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_purge_preview_excludes_temporary_files(self, async_client: AsyncClient, db_session):
        from backend.app.models.library import LibraryFile

        ids = [
            (await _upload(async_client, name=n, **p)).json()["id"]
            for n, p in (("a.stl", {}), ("b.stl", {"temporary": "true"}))
        ]
        old = datetime.now(timezone.utc) - timedelta(days=200)
        for file_id in ids:
            (await db_session.get(LibraryFile, file_id)).created_at = old
        await db_session.commit()

        body = (
            await async_client.get(
                "/api/v1/library/purge/preview", params={"older_than_days": 90, "include_never_printed": True}
            )
        ).json()
        assert body["count"] == 1
        assert body["sample_filenames"] == ["a.stl"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_moving_a_file_out_keeps_it(self, async_client: AsyncClient, user_folder):
        file_id = (await _upload(async_client, temporary="true")).json()["id"]

        resp = await async_client.post(
            "/api/v1/library/files/move", json={"file_ids": [file_id], "folder_id": user_folder.id}
        )
        assert resp.status_code == 200
        assert resp.json()["moved"] == 1
        detail = (await async_client.get(f"/api/v1/library/files/{file_id}")).json()
        assert detail["folder_id"] == user_folder.id


class TestSystemFolderGuards:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_cannot_upload_into_system_folder(self, async_client: AsyncClient, temp_folder):
        resp = await _upload(async_client, folder_id=temp_folder.id)
        assert resp.status_code == 400

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_temporary_and_folder_id_are_exclusive(self, async_client: AsyncClient, user_folder):
        resp = await _upload(async_client, folder_id=user_folder.id, temporary="true")
        assert resp.status_code == 400

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_cannot_extract_zip_into_system_folder(self, async_client: AsyncClient, temp_folder):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("model.stl", STL)
        resp = await async_client.post(
            "/api/v1/library/files/extract-zip",
            files={"file": ("bundle.zip", buf.getvalue(), "application/zip")},
            params={"folder_id": temp_folder.id},
        )
        assert resp.status_code == 400

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_cannot_create_subfolder(self, async_client: AsyncClient, temp_folder):
        resp = await async_client.post("/api/v1/library/folders", json={"name": "x", "parent_id": temp_folder.id})
        assert resp.status_code == 400

    @pytest.mark.asyncio
    @pytest.mark.integration
    @pytest.mark.parametrize("payload", [{"name": "Renamed"}, {"parent_id": 0}, {"project_id": 0}])
    async def test_cannot_rename_move_or_link(self, async_client: AsyncClient, temp_folder, user_folder, payload):
        resp = await async_client.put(f"/api/v1/library/folders/{temp_folder.id}", json=payload)
        assert resp.status_code == 400

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_cannot_move_folder_into_system_folder(self, async_client: AsyncClient, temp_folder, user_folder):
        resp = await async_client.put(f"/api/v1/library/folders/{user_folder.id}", json={"parent_id": temp_folder.id})
        assert resp.status_code == 400

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_cannot_delete(self, async_client: AsyncClient, temp_folder):
        assert (await async_client.delete(f"/api/v1/library/folders/{temp_folder.id}")).status_code == 400
        resp = await async_client.post(
            "/api/v1/library/bulk-delete", json={"file_ids": [], "folder_ids": [temp_folder.id]}
        )
        assert resp.status_code == 400
        assert (await _temporary_folder(async_client))["id"] == temp_folder.id

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_cannot_move_files_into_system_folder(self, async_client: AsyncClient, temp_folder):
        file_id = (await _upload(async_client)).json()["id"]
        resp = await async_client.post(
            "/api/v1/library/files/move", json={"file_ids": [file_id], "folder_id": temp_folder.id}
        )
        assert resp.status_code == 400
        resp = await async_client.put(f"/api/v1/library/files/{file_id}", json={"folder_id": temp_folder.id})
        assert resp.status_code == 400


class TestRetentionSettings:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_and_update_retention(self, async_client: AsyncClient, temp_folder):
        assert (await async_client.get("/api/v1/library/temporary-files/settings")).json() == {"retention_days": 7}
        resp = await async_client.put("/api/v1/library/temporary-files/settings", json={"retention_days": 3})
        assert resp.json() == {"retention_days": 3}
        assert (await _temporary_folder(async_client))["retention_days"] == 3

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_rejects_out_of_range_retention(self, async_client: AsyncClient):
        resp = await async_client.put("/api/v1/library/temporary-files/settings", json={"retention_days": 0})
        assert resp.status_code == 422


class TestTemporaryFilesVisibility(TestOwnershipPermissionsSetup):
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_users_see_only_their_own_temporary_files(self, async_client: AsyncClient, auth_setup):
        op1 = {"Authorization": f"Bearer {auth_setup['operator_token']}"}
        op2 = {"Authorization": f"Bearer {auth_setup['operator2_token']}"}
        admin = {"Authorization": f"Bearer {auth_setup['admin_token']}"}

        own = (await _upload(async_client, name="op1.stl", headers=op1, temporary="true")).json()["id"]
        other = (await _upload(async_client, name="op2.stl", headers=op2, temporary="true")).json()["id"]

        folder = await _temporary_folder(async_client, headers=op1)
        assert folder["file_count"] == 1
        listed = (
            await async_client.get("/api/v1/library/files", params={"folder_id": folder["id"]}, headers=op1)
        ).json()
        assert [f["id"] for f in listed] == [own]

        admin_folder = await _temporary_folder(async_client, headers=admin)
        assert admin_folder["file_count"] == 2
        admin_listed = (
            await async_client.get("/api/v1/library/files", params={"folder_id": folder["id"]}, headers=admin)
        ).json()
        assert sorted(f["id"] for f in admin_listed) == sorted([own, other])

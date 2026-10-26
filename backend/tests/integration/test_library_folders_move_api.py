"""Library folder updates and moving files across the managed/external
storage boundary."""

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration


@pytest.fixture
def storage(tmp_path, monkeypatch):
    from backend.app.core.config import settings

    # External folders must live outside Grove's own data directory.
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr(settings, "base_dir", data)
    monkeypatch.setattr(settings, "archive_dir", data / "archive")
    return data


async def _folder(client, name, **kwargs):
    return (await client.post("/api/v1/library/folders", json={"name": name, **kwargs})).json()


async def _update(client, folder_id, **payload):
    return await client.put(f"/api/v1/library/folders/{folder_id}", json=payload)


class TestUpdateFolder:
    async def test_rename_and_move(self, async_client: AsyncClient, storage):
        parent = await _folder(async_client, "Parent")
        child = await _folder(async_client, "Child")

        moved = (await _update(async_client, child["id"], name="Renamed", parent_id=parent["id"])).json()
        to_root = (await _update(async_client, child["id"], parent_id=0)).json()

        assert (moved["name"], moved["parent_id"], moved["file_count"]) == ("Renamed", parent["id"], 0)
        assert to_root["parent_id"] is None

    async def test_cannot_create_cycles(self, async_client: AsyncClient, storage):
        top = await _folder(async_client, "Top")
        middle = await _folder(async_client, "Middle", parent_id=top["id"])
        bottom = await _folder(async_client, "Bottom", parent_id=middle["id"])

        itself = await _update(async_client, top["id"], parent_id=top["id"])
        subtree = await _update(async_client, top["id"], parent_id=bottom["id"])

        assert (itself.status_code, itself.json()["detail"]) == (400, "Folder cannot be its own parent")
        assert (subtree.status_code, subtree.json()["detail"]) == (400, "Cannot move folder into its own subtree")

    async def test_links_and_unlinks_project_and_archive(
        self, async_client: AsyncClient, storage, db_session, printer_factory, archive_factory
    ):
        from backend.app.models.project import Project

        project = Project(name="Gifts")
        db_session.add(project)
        await db_session.commit()
        printer = await printer_factory()
        archive = await archive_factory(printer.id, print_name="Box")
        folder = await _folder(async_client, "Linked")

        linked = (await _update(async_client, folder["id"], project_id=project.id, archive_id=archive.id)).json()
        unlinked = (await _update(async_client, folder["id"], project_id=0, archive_id=0)).json()

        assert (linked["project_name"], linked["archive_name"]) == ("Gifts", "Box")
        assert (unlinked["project_id"], unlinked["archive_id"]) == (None, None)

    @pytest.mark.parametrize("payload", [{"project_id": 9999}, {"archive_id": 9999}])
    async def test_unknown_links(self, async_client: AsyncClient, storage, payload):
        folder = await _folder(async_client, "F")
        assert (await _update(async_client, folder["id"], **payload)).status_code == 404

    async def test_unknown_folder(self, async_client: AsyncClient, storage):
        assert (await _update(async_client, 9999, name="x")).status_code == 404

    async def test_grove_managed_folder_is_protected(self, async_client: AsyncClient, storage, db_session):
        from backend.app.services.temporary_files import ensure_temporary_folder

        temp_folder = await ensure_temporary_folder(db_session)
        await db_session.commit()
        normal = await _folder(async_client, "Normal")

        rename = await _update(async_client, temp_folder.id, name="Mine now")
        move_into = await _update(async_client, normal["id"], parent_id=temp_folder.id)

        assert (rename.status_code, move_into.status_code) == (400, 400)

    async def test_unknown_parent(self, async_client: AsyncClient, storage):
        folder = await _folder(async_client, "Orphan")
        assert (await _update(async_client, folder["id"], parent_id=9999)).status_code == 404


class TestMoveAcrossStorage:
    async def _external(self, client, path, readonly=False):
        response = await client.post(
            "/api/v1/library/folders/external",
            json={"name": f"NAS {path.name}", "external_path": str(path), "readonly": readonly},
        )
        assert response.status_code == 200, response.text
        return response.json()

    async def _upload(self, client, name="part.stl", content=b"solid part\nendsolid\n"):
        return (await client.post("/api/v1/library/files/", files={"file": (name, content)})).json()

    async def test_managed_to_external_and_back(self, async_client: AsyncClient, storage, tmp_path, monkeypatch):
        nas = tmp_path / "nas"
        nas.mkdir()
        monkeypatch.setenv("BAMBUDDY_EXTERNAL_ROOTS", f"{nas}:{tmp_path / 'ro'}")
        external = await self._external(async_client, nas)
        file = await self._upload(async_client)

        out = (
            await async_client.post(
                "/api/v1/library/files/move", json={"file_ids": [file["id"]], "folder_id": external["id"]}
            )
        ).json()
        assert (out["moved"], (nas / "part.stl").read_bytes()) == (1, b"solid part\nendsolid\n")

        back = (
            await async_client.post("/api/v1/library/files/move", json={"file_ids": [file["id"]], "folder_id": None})
        ).json()
        assert back["moved"] == 1
        assert not (nas / "part.stl").exists()

    async def test_skips_with_reasons(self, async_client: AsyncClient, storage, tmp_path, monkeypatch):
        nas = tmp_path / "nas"
        nas.mkdir()
        readonly_dir = tmp_path / "ro"
        readonly_dir.mkdir()
        monkeypatch.setenv("BAMBUDDY_EXTERNAL_ROOTS", f"{nas}:{tmp_path / 'ro'}")
        external = await self._external(async_client, nas)
        readonly = await self._external(async_client, readonly_dir, readonly=True)
        (nas / "part.stl").write_bytes(b"already here")
        file = await self._upload(async_client)

        collision = (
            await async_client.post(
                "/api/v1/library/files/move", json={"file_ids": [file["id"]], "folder_id": external["id"]}
            )
        ).json()
        to_readonly = await async_client.post(
            "/api/v1/library/files/move", json={"file_ids": [file["id"]], "folder_id": readonly["id"]}
        )

        assert [r["code"] for r in collision["skipped_reasons"]] == ["name_collision"]
        assert to_readonly.status_code == 403

    async def test_missing_source_and_same_boundary(self, async_client: AsyncClient, storage, tmp_path, monkeypatch):
        nas = tmp_path / "nas"
        nas.mkdir()
        monkeypatch.setenv("BAMBUDDY_EXTERNAL_ROOTS", f"{nas}:{tmp_path / 'ro'}")
        external = await self._external(async_client, nas)
        managed_folder = await _folder(async_client, "Managed")
        gone = await self._upload(async_client, "gone.stl", b"solid gone\n")
        stays = await self._upload(async_client, "stays.stl", b"solid stays\n")
        for path in (storage / "archive/library/files").iterdir():
            if path.read_bytes() == b"solid gone\n":
                path.unlink()

        missing = (
            await async_client.post(
                "/api/v1/library/files/move", json={"file_ids": [gone["id"]], "folder_id": external["id"]}
            )
        ).json()
        same = (
            await async_client.post(
                "/api/v1/library/files/move", json={"file_ids": [stays["id"], 9999], "folder_id": managed_folder["id"]}
            )
        ).json()

        assert [r["code"] for r in missing["skipped_reasons"]] == ["source_missing"]
        assert (same["moved"], same["skipped"]) == (1, 0)

"""End-to-end project workflows through the API: create → update → BOM →
attachments → templates → export/import.

These rely on the test ``get_db`` committing like production, so a project
created by one request is visible to the next.
"""

from __future__ import annotations

import io
import json
import zipfile

import pytest
from httpx import AsyncClient

from backend.app.core.config import settings as app_settings


@pytest.fixture
def archive_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(app_settings, "archive_dir", tmp_path)
    return tmp_path


async def create_project(client: AsyncClient, **fields) -> dict:
    response = await client.post("/api/v1/projects/", json={"name": "Desk organiser", **fields})
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.integration
class TestProjectUpdate:
    async def test_created_project_is_readable_and_updatable(self, async_client: AsyncClient):
        project = await create_project(async_client, target_count=3)
        pid = project["id"]

        fetched = await async_client.get(f"/api/v1/projects/{pid}")
        assert fetched.status_code == 200
        assert fetched.json()["name"] == "Desk organiser"

        updated = await async_client.patch(
            f"/api/v1/projects/{pid}",
            json={
                "name": "Desk organiser v2",
                "status": "completed",
                "priority": "high",
                "notes": "Use PETG",
                "tags": "office,gift",
                "budget": 12.5,
                "url": "https://example.com/model",
            },
        )
        assert updated.status_code == 200
        body = updated.json()
        assert body["name"] == "Desk organiser v2"
        assert body["status"] == "completed"
        assert body["priority"] == "high"
        assert body["budget"] == 12.5
        assert body["url"] == "https://example.com/model"

        # Explicit null clears a nullable field that was set.
        cleared = await async_client.patch(f"/api/v1/projects/{pid}", json={"budget": None})
        assert cleared.json()["budget"] is None

    @pytest.mark.parametrize("field", [{"status": "paused"}, {"priority": "whenever"}])
    async def test_rejects_unknown_status_or_priority(self, async_client: AsyncClient, field):
        project = await create_project(async_client)
        response = await async_client.patch(f"/api/v1/projects/{project['id']}", json=field)
        assert response.status_code == 400

    async def test_parent_project_rules(self, async_client: AsyncClient):
        parent = await create_project(async_client, name="Workshop")
        child = await create_project(async_client, name="Shelf")

        own = await async_client.patch(f"/api/v1/projects/{child['id']}", json={"parent_id": child["id"]})
        assert own.status_code == 400

        missing = await async_client.patch(f"/api/v1/projects/{child['id']}", json={"parent_id": 99999})
        assert missing.status_code == 400

        linked = await async_client.patch(f"/api/v1/projects/{child['id']}", json={"parent_id": parent["id"]})
        assert linked.json()["parent_id"] == parent["id"]
        assert linked.json()["parent_name"] == "Workshop"

        unlinked = await async_client.patch(f"/api/v1/projects/{child['id']}", json={"parent_id": 0})
        assert unlinked.json()["parent_id"] is None

    async def test_update_unknown_project(self, async_client: AsyncClient):
        response = await async_client.patch("/api/v1/projects/99999", json={"name": "x"})
        assert response.status_code == 404


@pytest.mark.integration
class TestProjectBOM:
    async def test_bom_lifecycle(self, async_client: AsyncClient):
        pid = (await create_project(async_client))["id"]
        base = f"/api/v1/projects/{pid}/bom"

        screws = (
            await async_client.post(base, json={"name": "M3 screw", "quantity_needed": 8, "unit_price": 0.1})
        ).json()
        magnets = (await async_client.post(base, json={"name": "Magnet", "quantity_needed": 2})).json()
        assert screws["sort_order"] == 1
        assert magnets["sort_order"] == 2
        assert screws["is_complete"] is False

        listed = (await async_client.get(base)).json()
        assert [item["name"] for item in listed] == ["M3 screw", "Magnet"]

        done = await async_client.patch(
            f"{base}/{screws['id']}", json={"quantity_acquired": 8, "unit_price": 0, "remarks": ""}
        )
        assert done.status_code == 200
        assert done.json()["is_complete"] is True
        assert done.json()["unit_price"] is None  # 0 clears the price
        assert done.json()["remarks"] is None

        deleted = await async_client.delete(f"{base}/{magnets['id']}")
        assert deleted.status_code == 200
        assert [item["name"] for item in (await async_client.get(base)).json()] == ["M3 screw"]

    async def test_bom_item_links_archive_name(self, async_client: AsyncClient, archive_factory, printer_factory):
        printer = await printer_factory()
        archive = await archive_factory(printer.id, print_name="Hinge")
        archive_id = archive.id
        pid = (await create_project(async_client))["id"]
        item = (
            await async_client.post(f"/api/v1/projects/{pid}/bom", json={"name": "Hinge", "archive_id": archive_id})
        ).json()
        assert item["archive_name"] == "Hinge"

        unlinked = await async_client.patch(f"/api/v1/projects/{pid}/bom/{item['id']}", json={"archive_id": 0})
        assert unlinked.json()["archive_id"] is None

    async def test_bom_errors(self, async_client: AsyncClient):
        assert (await async_client.get("/api/v1/projects/99999/bom")).status_code == 404
        assert (await async_client.post("/api/v1/projects/99999/bom", json={"name": "x"})).status_code == 404
        pid = (await create_project(async_client))["id"]
        assert (await async_client.patch(f"/api/v1/projects/{pid}/bom/99999", json={"name": "x"})).status_code == 404
        assert (await async_client.delete(f"/api/v1/projects/{pid}/bom/99999")).status_code == 404


@pytest.mark.integration
class TestProjectAttachments:
    async def test_upload_download_delete(self, async_client: AsyncClient, archive_dir):
        pid = (await create_project(async_client))["id"]
        upload = await async_client.post(
            f"/api/v1/projects/{pid}/attachments",
            files={"file": ("assembly.pdf", b"%PDF-1.4 fake", "application/pdf")},
        )
        assert upload.status_code == 200
        stored = upload.json()["filename"]
        assert stored.endswith(".pdf") and stored != "assembly.pdf"  # renamed to a random name
        assert (archive_dir / "projects" / str(pid) / "attachments" / stored).read_bytes() == b"%PDF-1.4 fake"

        download = await async_client.get(f"/api/v1/projects/{pid}/attachments/{stored}")
        assert download.status_code == 200
        assert download.content == b"%PDF-1.4 fake"
        assert "assembly.pdf" in download.headers["content-disposition"]

        deleted = await async_client.delete(f"/api/v1/projects/{pid}/attachments/{stored}")
        assert deleted.status_code == 200
        assert deleted.json()["attachments"] is None
        assert not (archive_dir / "projects" / str(pid) / "attachments" / stored).exists()
        assert (await async_client.get(f"/api/v1/projects/{pid}/attachments/{stored}")).status_code == 404

    async def test_rejects_disallowed_extension(self, async_client: AsyncClient, archive_dir):
        pid = (await create_project(async_client))["id"]
        response = await async_client.post(
            f"/api/v1/projects/{pid}/attachments", files={"file": ("run.exe", b"MZ", "application/octet-stream")}
        )
        assert response.status_code == 400

    @pytest.mark.parametrize("name", ["..evil", "a\\b"])
    async def test_rejects_unsafe_attachment_names(self, async_client: AsyncClient, archive_dir, name):
        pid = (await create_project(async_client))["id"]
        assert (await async_client.get(f"/api/v1/projects/{pid}/attachments/{name}")).status_code == 400
        assert (await async_client.delete(f"/api/v1/projects/{pid}/attachments/{name}")).status_code == 400

    async def test_unknown_attachment_or_project(self, async_client: AsyncClient, archive_dir):
        pid = (await create_project(async_client))["id"]
        assert (await async_client.get(f"/api/v1/projects/{pid}/attachments/nope.pdf")).status_code == 404
        response = await async_client.post(
            "/api/v1/projects/99999/attachments", files={"file": ("a.pdf", b"x", "application/pdf")}
        )
        assert response.status_code == 404


@pytest.mark.integration
class TestProjectTemplates:
    async def test_template_round_trip_copies_bom_without_progress(self, async_client: AsyncClient):
        source = await create_project(async_client, name="Planter", notes="Water-tight", target_count=4)
        await async_client.post(
            f"/api/v1/projects/{source['id']}/bom", json={"name": "Drain plug", "quantity_needed": 4}
        )
        bom_id = (await async_client.get(f"/api/v1/projects/{source['id']}/bom")).json()[0]["id"]
        await async_client.patch(f"/api/v1/projects/{source['id']}/bom/{bom_id}", json={"quantity_acquired": 4})

        template = await async_client.post(f"/api/v1/projects/{source['id']}/create-template")
        assert template.status_code == 200
        template = template.json()
        assert template["name"] == "Planter (Template)"
        assert template["is_template"] is True
        assert template["template_source_id"] == source["id"]

        templates = (await async_client.get("/api/v1/projects/templates")).json()
        assert [t["id"] for t in templates] == [template["id"]]

        new = await async_client.post(f"/api/v1/projects/from-template/{template['id']}")
        assert new.status_code == 200
        new = new.json()
        assert new["name"] == "Planter"
        assert new["is_template"] is False
        assert new["notes"] == "Water-tight"
        bom = (await async_client.get(f"/api/v1/projects/{new['id']}/bom")).json()
        assert [(b["name"], b["quantity_needed"], b["quantity_acquired"]) for b in bom] == [("Drain plug", 4, 0)]

        named = await async_client.post(f"/api/v1/projects/from-template/{template['id']}", params={"name": "Custom"})
        assert named.json()["name"] == "Custom"

    async def test_from_template_requires_a_template(self, async_client: AsyncClient):
        plain = await create_project(async_client)
        assert (await async_client.post(f"/api/v1/projects/from-template/{plain['id']}")).status_code == 400
        assert (await async_client.post("/api/v1/projects/from-template/99999")).status_code == 404
        assert (await async_client.post("/api/v1/projects/99999/create-template")).status_code == 404


@pytest.mark.integration
class TestProjectExportImport:
    async def test_json_export_then_import(self, async_client: AsyncClient):
        source = await create_project(async_client, name="Lamp", description="Desk lamp", tags="lighting")
        await async_client.post(
            f"/api/v1/projects/{source['id']}/bom", json={"name": "LED strip", "quantity_needed": 1}
        )

        exported = await async_client.get(f"/api/v1/projects/{source['id']}/export", params={"format": "json"})
        assert exported.status_code == 200
        data = exported.json()
        assert data["name"] == "Lamp"
        assert data["bom_items"][0]["name"] == "LED strip"
        assert data["linked_folders"] == []

        imported = await async_client.post("/api/v1/projects/import", json={**data, "name": "Lamp copy"})
        assert imported.status_code == 200
        new_id = imported.json()["id"]
        assert imported.json()["description"] == "Desk lamp"
        bom = (await async_client.get(f"/api/v1/projects/{new_id}/bom")).json()
        assert [b["name"] for b in bom] == ["LED strip"]

    async def test_zip_export_then_file_import(self, async_client: AsyncClient):
        source = await create_project(async_client, name="Clock / v2")
        exported = await async_client.get(f"/api/v1/projects/{source['id']}/export")
        assert exported.status_code == 200
        assert exported.headers["content-type"] == "application/zip"
        assert "Clock _ v2" in exported.headers["content-disposition"]  # unsafe characters replaced
        with zipfile.ZipFile(io.BytesIO(exported.content)) as zf:
            assert json.loads(zf.read("project.json"))["name"] == "Clock / v2"

        imported = await async_client.post(
            "/api/v1/projects/import/file", files={"file": ("clock.zip", exported.content, "application/zip")}
        )
        assert imported.status_code == 200
        assert imported.json()["name"] == "Clock / v2"

    async def test_json_file_import(self, async_client: AsyncClient):
        payload = json.dumps({"name": "From JSON", "bom_items": [{"name": "Bolt", "quantity_needed": 2}]}).encode()
        imported = await async_client.post(
            "/api/v1/projects/import/file", files={"file": ("p.json", payload, "application/json")}
        )
        assert imported.status_code == 200
        bom = (await async_client.get(f"/api/v1/projects/{imported.json()['id']}/bom")).json()
        assert [(b["name"], b["quantity_needed"]) for b in bom] == [("Bolt", 2)]

    async def test_zip_without_project_json_is_rejected(self, async_client: AsyncClient):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as zf:
            zf.writestr("readme.txt", "hi")
        response = await async_client.post(
            "/api/v1/projects/import/file", files={"file": ("p.zip", buffer.getvalue(), "application/zip")}
        )
        assert response.status_code == 400
        assert response.json()["detail"] == "ZIP must contain project.json"

    async def test_export_unknown_project(self, async_client: AsyncClient):
        assert (await async_client.get("/api/v1/projects/99999/export")).status_code == 404

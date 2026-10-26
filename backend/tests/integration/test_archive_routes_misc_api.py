"""Archive list duplicates, full-text search, compare, photos, QR codes and
maintenance endpoints."""

import io
from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import text

pytestmark = pytest.mark.integration


@pytest.fixture
def storage(tmp_path, monkeypatch):
    from backend.app.core.config import settings

    monkeypatch.setattr(settings, "base_dir", tmp_path)
    return tmp_path


async def _create_fts(db_session):
    await db_session.execute(
        text(
            "CREATE VIRTUAL TABLE IF NOT EXISTS archive_fts USING fts5("
            "print_name, filename, tags, notes, designer, filament_type, content='print_archives', content_rowid='id')"
        )
    )
    await db_session.commit()


class TestListDuplicates:
    async def test_marks_original_and_duplicates(self, async_client: AsyncClient, printer_factory, archive_factory):
        printer = await printer_factory()
        now = datetime.now(timezone.utc)
        first = await archive_factory(
            printer.id, print_name="Gear", content_hash="h1", created_at=now - timedelta(days=2)
        )
        second = await archive_factory(
            printer.id, print_name="Gear", content_hash="h1", created_at=now - timedelta(days=1)
        )
        unique = await archive_factory(printer.id, print_name="Solo", content_hash="h2")

        body = (await async_client.get("/api/v1/archives/")).json()

        by_id = {a["id"]: a for a in body}
        assert (by_id[first.id]["duplicate_sequence"], by_id[first.id]["duplicate_count"]) == (0, 1)
        assert by_id[second.id]["duplicate_sequence"] == 1
        assert by_id[second.id]["original_archive_id"] == first.id
        assert by_id[unique.id]["duplicate_count"] == 0

    async def test_filters_and_paging(self, async_client: AsyncClient, printer_factory, archive_factory):
        printer = await printer_factory()
        other = await printer_factory(name="Other")
        for i in range(3):
            await archive_factory(printer.id, print_name=f"P{i}")
        await archive_factory(other.id, print_name="Elsewhere")

        page = (await async_client.get("/api/v1/archives/", params={"printer_id": printer.id, "limit": 2})).json()

        assert len(page) == 2
        assert all(a["printer_id"] == printer.id for a in page)


class TestSearch:
    async def test_full_text_search_with_prefix_match(
        self, async_client: AsyncClient, printer_factory, archive_factory, db_session
    ):
        await _create_fts(db_session)
        printer = await printer_factory()
        voron = await archive_factory(printer.id, print_name="Voron skirt", status="completed")
        await archive_factory(printer.id, print_name="Benchy", status="completed")
        await db_session.execute(text("INSERT INTO archive_fts(archive_fts) VALUES('rebuild')"))
        await db_session.commit()

        body = (await async_client.get("/api/v1/archives/search", params={"q": "vor"})).json()

        assert [a["id"] for a in body] == [voron.id]

    async def test_full_text_search_filters(
        self, async_client: AsyncClient, printer_factory, archive_factory, db_session
    ):
        await _create_fts(db_session)
        printer = await printer_factory()
        other = await printer_factory(name="Other")
        await archive_factory(printer.id, print_name="Clip A", status="failed")
        keep = await archive_factory(other.id, print_name="Clip B", status="completed")
        await db_session.execute(text("INSERT INTO archive_fts(archive_fts) VALUES('rebuild')"))
        await db_session.commit()

        body = (
            await async_client.get(
                "/api/v1/archives/search", params={"q": "clip*", "printer_id": other.id, "status": "completed"}
            )
        ).json()

        assert [a["id"] for a in body] == [keep.id]

    async def test_no_full_text_matches(self, async_client: AsyncClient, db_session):
        await _create_fts(db_session)

        assert (await async_client.get("/api/v1/archives/search", params={"q": "nothing"})).json() == []

    async def test_falls_back_to_like_search_without_the_index(
        self, async_client: AsyncClient, printer_factory, archive_factory
    ):
        printer = await printer_factory()
        other = await printer_factory(name="Other")
        match = await archive_factory(printer.id, print_name="Bracket", designer="Grace", status="completed")
        await archive_factory(other.id, print_name="Bracket two", status="completed")
        await archive_factory(printer.id, print_name="Unrelated")

        body = (
            await async_client.get(
                "/api/v1/archives/search", params={"q": "brack", "printer_id": printer.id, "status": "completed"}
            )
        ).json()

        assert [a["id"] for a in body] == [match.id]


class TestRebuildIndex:
    async def test_rebuilds_an_index_that_is_in_sync(
        self, async_client: AsyncClient, printer_factory, archive_factory, db_session
    ):
        await _create_fts(db_session)
        printer = await printer_factory()
        await archive_factory(printer.id)
        await archive_factory(printer.id)
        await db_session.execute(text("INSERT INTO archive_fts(archive_fts) VALUES('rebuild')"))
        await db_session.commit()

        response = await async_client.post("/api/v1/archives/search/rebuild-index")

        assert response.json() == {"message": "Search index rebuilt with 2 entries"}

    async def test_rebuilds_an_index_that_is_out_of_sync(
        self, async_client: AsyncClient, printer_factory, archive_factory, db_session
    ):
        await _create_fts(db_session)
        printer = await printer_factory()
        await archive_factory(printer.id)

        response = await async_client.post("/api/v1/archives/search/rebuild-index")

        assert response.status_code == 200

    async def test_reports_failure(self, async_client: AsyncClient):
        response = await async_client.post("/api/v1/archives/search/rebuild-index")

        assert response.status_code == 500
        assert response.json()["detail"].startswith("Failed to rebuild index")


class TestCompare:
    async def test_compares_archives(self, async_client: AsyncClient, printer_factory, archive_factory):
        printer = await printer_factory()
        a = await archive_factory(printer.id, print_name="A", layer_height=0.2)
        b = await archive_factory(printer.id, print_name="B", layer_height=0.28, status="failed")

        response = await async_client.get("/api/v1/archives/compare", params={"archive_ids": f"{a.id},{b.id}"})

        assert response.status_code == 200
        assert {x["id"] for x in response.json()["archives"]} == {a.id, b.id}

    @pytest.mark.parametrize(
        ("ids", "detail"),
        [
            ("1,x", "Invalid archive IDs format"),
            ("1", "At least 2 archives required for comparison"),
            ("1,2,3,4,5,6", "Maximum 5 archives can be compared at once"),
        ],
    )
    async def test_validation(self, async_client: AsyncClient, ids, detail):
        response = await async_client.get("/api/v1/archives/compare", params={"archive_ids": ids})

        assert (response.status_code, response.json()["detail"]) == (400, detail)

    async def test_unknown_archives(self, async_client: AsyncClient):
        response = await async_client.get("/api/v1/archives/compare", params={"archive_ids": "998,999"})
        assert response.status_code == 400


class TestPhotos:
    async def test_upload_view_and_delete(self, async_client: AsyncClient, printer_factory, archive_factory, storage):
        printer = await printer_factory()
        archive = await archive_factory(printer.id, file_path="archive/1/job/job.3mf")
        (storage / "archive/1/job").mkdir(parents=True)

        upload = await async_client.post(
            f"/api/v1/archives/{archive.id}/photos", files={"file": ("result.PNG", b"\x89PNGdata", "image/png")}
        )
        assert upload.status_code == 200
        [name] = upload.json()["photos"]
        assert name.endswith(".png")
        assert (storage / "archive/1/job/photos" / name).read_bytes() == b"\x89PNGdata"

        view = await async_client.get(f"/api/v1/archives/{archive.id}/photos/{name}")
        assert (view.status_code, view.headers["content-type"], view.content) == (200, "image/png", b"\x89PNGdata")

        deleted = await async_client.delete(f"/api/v1/archives/{archive.id}/photos/{name}")
        assert deleted.json() == {"status": "deleted", "photos": None}
        assert not (storage / "archive/1/job/photos" / name).exists()

    async def test_rejects_non_images(self, async_client: AsyncClient, printer_factory, archive_factory, storage):
        printer = await printer_factory()
        archive = await archive_factory(printer.id)

        response = await async_client.post(
            f"/api/v1/archives/{archive.id}/photos", files={"file": ("notes.txt", b"hi", "text/plain")}
        )

        assert response.status_code == 400

    async def test_photo_lookup_errors(self, async_client: AsyncClient, printer_factory, archive_factory, storage):
        printer = await printer_factory()
        archive = await archive_factory(printer.id, photos=["missing.jpg"])

        assert (await async_client.get("/api/v1/archives/9999/photos/a.jpg")).status_code == 404
        assert (await async_client.get(f"/api/v1/archives/{archive.id}/photos/other.jpg")).status_code == 404
        # Listed on the archive but gone from disk.
        assert (await async_client.get(f"/api/v1/archives/{archive.id}/photos/missing.jpg")).status_code == 404
        assert (await async_client.delete(f"/api/v1/archives/{archive.id}/photos/other.jpg")).status_code == 404


class TestQrCode:
    async def test_png_linking_to_download(self, async_client: AsyncClient, printer_factory, archive_factory):
        printer = await printer_factory()
        archive = await archive_factory(printer.id, print_name="Gear")

        response = await async_client.get(f"/api/v1/archives/{archive.id}/qrcode")

        assert response.headers["content-type"] == "image/png"
        assert 'filename="qr_Gear.png"' in response.headers["content-disposition"]
        assert Image.open(io.BytesIO(response.content)).format == "PNG"

    async def test_custom_size(self, async_client: AsyncClient, printer_factory, archive_factory):
        printer = await printer_factory()
        archive = await archive_factory(printer.id)

        response = await async_client.get(f"/api/v1/archives/{archive.id}/qrcode", params={"size": 120})

        assert Image.open(io.BytesIO(response.content)).size == (120, 120)

    async def test_unknown_archive(self, async_client: AsyncClient):
        assert (await async_client.get("/api/v1/archives/9999/qrcode")).status_code == 404


async def test_backfill_content_hashes(async_client: AsyncClient, printer_factory, archive_factory, storage):
    printer = await printer_factory()
    (storage / "archive").mkdir()
    (storage / "archive/a.3mf").write_bytes(b"contents")
    present = await archive_factory(printer.id, file_path="archive/a.3mf", content_hash=None)
    missing = await archive_factory(printer.id, file_path="archive/gone.3mf", content_hash=None)
    await archive_factory(printer.id, content_hash="already")

    response = await async_client.post("/api/v1/archives/backfill-hashes")

    assert response.json() == {"updated": 1, "errors": [{"id": missing.id, "error": "File not found"}]}
    listed = {a["id"]: a for a in (await async_client.get("/api/v1/archives/")).json()}
    assert listed[present.id]["content_hash"]

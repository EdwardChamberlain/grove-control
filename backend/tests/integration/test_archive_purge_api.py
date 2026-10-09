"""Integration tests for archive auto-purge (#1008 follow-up)."""

from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient

from backend.app.services.lifecycle.engine import HOLDING_STATUSES


@pytest.mark.parametrize("status", HOLDING_STATUSES)
@pytest.mark.parametrize("purge_stats", [False, True])
@pytest.mark.parametrize("linked", [True, False])
async def test_purge_retains_held_archives_and_excludes_them_from_preview(
    async_client, archive_factory, printer_factory, db_session, tmp_path, monkeypatch, status, purge_stats, linked
):
    from sqlalchemy import select

    from backend.app.core.config import settings
    from backend.app.models.archive import PrintArchive
    from backend.app.models.print_log import PrintLogEntry
    from backend.app.models.print_queue import PrintQueueItem

    monkeypatch.setattr(settings, "base_dir", tmp_path)
    monkeypatch.setattr(settings, "archive_dir", tmp_path / "archives")
    source = tmp_path / "archives/test/test_print.gcode.3mf"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"held attempt")
    printer = await printer_factory()
    archive = await archive_factory(printer.id)
    archive.created_at = datetime.now(timezone.utc) - timedelta(days=400)
    item = PrintQueueItem(
        printer_id=printer.id,
        archive_id=archive.id if linked else None,
        status=status,
        physical_outcome="failed" if status == "failed" else None,
    )
    db_session.add(item)
    await db_session.flush()
    archive.dispatched_queue_item_id = item.id
    await db_session.commit()
    item_id, archive_id = item.id, archive.id

    preview = await async_client.get(
        "/api/v1/archives/purge/preview",
        params={
            "older_than_days": 365,
            "purge_stats": purge_stats,
        },
    )
    assert preview.status_code == 200 and preview.json()["count"] == 0
    response = await async_client.post(
        "/api/v1/archives/purge",
        json={
            "older_than_days": 365,
            "purge_stats": purge_stats,
        },
    )
    assert response.status_code == 200 and response.json()["deleted"] == 0
    db_session.expire_all()
    assert (await db_session.get(PrintArchive, archive_id)).deleted_at is None
    assert (await db_session.get(PrintQueueItem, item_id)).status == status
    assert await db_session.scalar(select(PrintLogEntry.id).where(PrintLogEntry.archive_id == archive_id))
    assert source.read_bytes() == b"held attempt"

    if status in ("finished", "failed", "cancelled"):
        assert (await async_client.post(f"/api/v1/queue/{item_id}/clear-plate")).status_code == 200
        response = await async_client.post(
            "/api/v1/archives/purge",
            json={
                "older_than_days": 365,
                "purge_stats": purge_stats,
            },
        )
        assert response.json()["deleted"] == 1
        assert not source.exists()


@pytest.mark.parametrize("purge_stats", [False, True])
@pytest.mark.parametrize("linked", [True, False])
async def test_purge_rechecks_a_hold_acquired_after_selection(
    async_client, archive_factory, printer_factory, db_session, monkeypatch, purge_stats, linked
):
    from sqlalchemy import select

    from backend.app.models.archive import PrintArchive
    from backend.app.models.print_log import PrintLogEntry
    from backend.app.models.print_queue import PrintQueueItem
    from backend.app.services.archive import ArchiveService

    printer = await printer_factory()
    archive = await archive_factory(printer.id)
    archive.created_at = datetime.now(timezone.utc) - timedelta(days=400)
    await db_session.commit()
    archive_id, printer_id = archive.id, printer.id
    method_name = "delete_archive" if purge_stats else "soft_delete_archive"
    original = getattr(ArchiveService, method_name)

    async def acquire_hold_then_delete(service, selected_id, **kwargs):
        assert selected_id == archive_id
        item = PrintQueueItem(printer_id=printer_id, archive_id=selected_id if linked else None, status="finished")
        service.db.add(item)
        await service.db.flush()
        (await service.db.get(PrintArchive, selected_id)).dispatched_queue_item_id = item.id
        await service.db.commit()
        return await original(service, selected_id, **kwargs)

    monkeypatch.setattr(ArchiveService, method_name, acquire_hold_then_delete)
    response = await async_client.post(
        "/api/v1/archives/purge",
        json={
            "older_than_days": 365,
            "purge_stats": purge_stats,
        },
    )
    assert response.status_code == 200 and response.json()["deleted"] == 0
    db_session.expire_all()
    assert (await db_session.get(PrintArchive, archive_id)).deleted_at is None
    assert await db_session.scalar(select(PrintLogEntry.id).where(PrintLogEntry.archive_id == archive_id))
    assert await db_session.scalar(
        select(PrintQueueItem.id).where(
            PrintQueueItem.id == (await db_session.get(PrintArchive, archive_id)).dispatched_queue_item_id,
            PrintQueueItem.status == "finished",
        )
    )


@pytest.mark.asyncio
@pytest.mark.integration
async def test_settings_defaults_when_unset(async_client: AsyncClient):
    """GET /archives/purge/settings returns sensible defaults on a fresh install."""
    resp = await async_client.get("/api/v1/archives/purge/settings")
    assert resp.status_code == 200
    body = resp.json()
    assert body["enabled"] is False
    assert body["days"] == 365
    assert body["mode"] == "age"
    assert body["max_count"] == 100
    # #1390: default soft-delete — preserves Quick Stats contribution.
    assert body["purge_stats"] is False


@pytest.mark.asyncio
@pytest.mark.integration
async def test_settings_roundtrip(async_client: AsyncClient):
    """PUT persists, GET returns the saved values, days is clamped."""
    resp = await async_client.put(
        "/api/v1/archives/purge/settings",
        json={"enabled": True, "days": 180, "purge_stats": True, "mode": "count", "max_count": 20},
    )
    assert resp.status_code == 200
    assert resp.json() == {"enabled": True, "days": 180, "mode": "count", "max_count": 20, "purge_stats": True}

    resp = await async_client.get("/api/v1/archives/purge/settings")
    assert resp.json() == {"enabled": True, "days": 180, "mode": "count", "max_count": 20, "purge_stats": True}


@pytest.mark.asyncio
@pytest.mark.integration
async def test_settings_rejects_out_of_range_days(async_client: AsyncClient):
    """days below MIN or above MAX is rejected."""
    resp = await async_client.put(
        "/api/v1/archives/purge/settings",
        json={"enabled": True, "days": 1},
    )
    # Pydantic validation returns 422; explicit bound check returns 400.
    assert resp.status_code in (400, 422)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_preview_counts_old_archives(async_client: AsyncClient, archive_factory, printer_factory, db_session):
    """Preview returns the count + total bytes of archives older than the threshold."""
    printer = await printer_factory()
    old = await archive_factory(printer.id, print_name="Old", file_size=1000)
    fresh = await archive_factory(printer.id, print_name="Fresh", file_size=2000)

    old.created_at = datetime.now(timezone.utc) - timedelta(days=400)
    fresh.created_at = datetime.now(timezone.utc) - timedelta(days=10)
    await db_session.commit()

    resp = await async_client.get("/api/v1/archives/purge/preview?older_than_days=365")
    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 1
    assert body["total_bytes"] == 1000
    assert "Old" in body["sample_filenames"][0] or old.filename in body["sample_filenames"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_preview_ignores_recently_reprinted_archives(
    async_client: AsyncClient, archive_factory, printer_factory, db_session
):
    """Reprints update completed_at but leave created_at pinned; purge must honour that."""
    printer = await printer_factory()
    reprinted = await archive_factory(printer.id, print_name="Reprinted", file_size=1000)

    # Originally printed 400 days ago, but a reprint last week refreshed completed_at.
    reprinted.created_at = datetime.now(timezone.utc) - timedelta(days=400)
    reprinted.started_at = datetime.now(timezone.utc) - timedelta(days=7)
    reprinted.completed_at = datetime.now(timezone.utc) - timedelta(days=7)
    await db_session.commit()

    resp = await async_client.get("/api/v1/archives/purge/preview?older_than_days=365")
    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 0


@pytest.mark.asyncio
@pytest.mark.integration
async def test_manual_purge_soft_deletes_by_default(
    async_client: AsyncClient, archive_factory, printer_factory, db_session
):
    """#1390: POST /archives/purge with no body flag soft-deletes — files
    off disk, ``deleted_at`` set, archive row survives so Quick Stats keeps
    every contribution. Matches the single-archive delete default from #1343."""
    from backend.app.models.archive import PrintArchive

    printer = await printer_factory()
    old = await archive_factory(printer.id, print_name="Old")
    fresh = await archive_factory(printer.id, print_name="Fresh")

    old_id = old.id
    fresh_id = fresh.id
    old.created_at = datetime.now(timezone.utc) - timedelta(days=400)
    fresh.created_at = datetime.now(timezone.utc) - timedelta(days=10)
    await db_session.commit()

    resp = await async_client.post(
        "/api/v1/archives/purge",
        json={"older_than_days": 365},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["deleted"] == 1
    assert body["purge_stats"] is False

    db_session.expire_all()
    # Old row still exists in DB but is soft-deleted.
    old_row = await db_session.get(PrintArchive, old_id)
    assert old_row is not None
    assert old_row.deleted_at is not None
    fresh_row = await db_session.get(PrintArchive, fresh_id)
    assert fresh_row is not None
    assert fresh_row.deleted_at is None


@pytest.mark.asyncio
@pytest.mark.integration
async def test_manual_purge_hard_deletes_when_purge_stats_set(
    async_client: AsyncClient, archive_factory, printer_factory, db_session
):
    """#1390: when ``purge_stats=true`` is sent in the body, the bulk purge
    hard-deletes the archive AND the linked PrintLogEntry rows so the
    contribution drops from /stats — matches the single-archive route's
    ``?purge_stats=true`` semantics."""
    from backend.app.models.archive import PrintArchive

    printer = await printer_factory()
    old = await archive_factory(printer.id, print_name="Old")
    old_id = old.id
    old.created_at = datetime.now(timezone.utc) - timedelta(days=400)
    await db_session.commit()

    resp = await async_client.post(
        "/api/v1/archives/purge",
        json={"older_than_days": 365, "purge_stats": True},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["deleted"] == 1
    assert body["purge_stats"] is True

    db_session.expire_all()
    assert await db_session.get(PrintArchive, old_id) is None


@pytest.mark.asyncio
@pytest.mark.integration
async def test_auto_purge_soft_deletes_by_default(
    async_client: AsyncClient, archive_factory, printer_factory, db_session
):
    """#1390: scheduled auto-purge defaults to soft-delete — Quick Stats
    preserved unless the admin explicitly opts into hard-delete via the
    settings toggle.

    ``async_client`` is included solely so its fixture activates the module-level
    ``async_session`` patches that let :meth:`purge_older_than`'s per-row
    delete sessions reach the in-memory test database.
    """
    from backend.app.models.archive import PrintArchive
    from backend.app.services.archive_purge import archive_purge_service

    printer = await printer_factory()
    stale = await archive_factory(printer.id, print_name="Stale")
    stale_id = stale.id
    stale.created_at = datetime.now(timezone.utc) - timedelta(days=400)
    await db_session.commit()

    await archive_purge_service.set_settings(db_session, enabled=True, days=365)

    deleted = await archive_purge_service._maybe_run_auto_purge(db_session)
    assert deleted >= 1

    db_session.expire_all()
    stale_row = await db_session.get(PrintArchive, stale_id)
    assert stale_row is not None
    assert stale_row.deleted_at is not None


@pytest.mark.asyncio
@pytest.mark.integration
async def test_auto_purge_hard_deletes_when_settings_opts_in(
    async_client: AsyncClient, archive_factory, printer_factory, db_session
):
    """#1390: scheduled auto-purge honours the ``purge_stats`` setting —
    when True the sweeper hard-deletes archive rows AND linked PrintLogEntry
    rows, dropping every contribution from /stats."""
    from backend.app.models.archive import PrintArchive
    from backend.app.services.archive_purge import archive_purge_service

    printer = await printer_factory()
    stale = await archive_factory(printer.id, print_name="Stale")
    stale_id = stale.id
    stale.created_at = datetime.now(timezone.utc) - timedelta(days=400)
    await db_session.commit()

    await archive_purge_service.set_settings(db_session, enabled=True, days=365, purge_stats=True)

    deleted = await archive_purge_service._maybe_run_auto_purge(db_session)
    assert deleted >= 1

    db_session.expire_all()
    assert await db_session.get(PrintArchive, stale_id) is None


@pytest.mark.asyncio
@pytest.mark.integration
async def test_auto_purge_throttles_within_24h(async_client: AsyncClient, archive_factory, printer_factory, db_session):
    """A recent last-run timestamp blocks the sweeper for 24h."""
    from backend.app.services.archive_purge import archive_purge_service

    printer = await printer_factory()
    stale = await archive_factory(printer.id, print_name="Stale")
    stale.created_at = datetime.now(timezone.utc) - timedelta(days=400)
    await db_session.commit()

    await archive_purge_service.set_settings(db_session, enabled=True, days=365)
    # Stamp a last-run time 1h ago — should block the sweeper for another 23h.
    await archive_purge_service._stamp_last_run(db_session, datetime.now(timezone.utc) - timedelta(hours=1))

    deleted = await archive_purge_service._maybe_run_auto_purge(db_session)
    assert deleted == 0


@pytest.mark.asyncio
@pytest.mark.integration
async def test_auto_purge_skipped_when_disabled(
    async_client: AsyncClient, archive_factory, printer_factory, db_session
):
    """When the toggle is off, old archives stay put."""
    from backend.app.models.archive import PrintArchive
    from backend.app.services.archive_purge import archive_purge_service

    printer = await printer_factory()
    stale = await archive_factory(printer.id, print_name="Stale")
    stale_id = stale.id
    stale.created_at = datetime.now(timezone.utc) - timedelta(days=400)
    await db_session.commit()

    await archive_purge_service.set_settings(db_session, enabled=False, days=365)
    deleted = await archive_purge_service._maybe_run_auto_purge(db_session)
    assert deleted == 0

    db_session.expire_all()
    assert await db_session.get(PrintArchive, stale_id) is not None


@pytest.mark.asyncio
@pytest.mark.integration
async def test_count_preview_keeps_newest_with_stable_timestamp_ties_and_ignores_active_prints(
    async_client: AsyncClient,
    archive_factory,
    printer_factory,
    db_session,
):
    """Count preview is exact at the limit and breaks equal timestamps by ID."""
    printer = await printer_factory()
    same_dispatch_time = datetime.now(timezone.utc) - timedelta(hours=1)
    archives = []
    for index in range(4):
        archive = await archive_factory(
            printer.id,
            print_name=f"Same-time-{index}",
            filename=f"same-time-{index}.3mf",
            file_size=(index + 1) * 100,
        )
        archive.created_at = same_dispatch_time
        archives.append(archive)

    active = await archive_factory(
        printer.id,
        print_name="Active",
        filename="active.3mf",
        status="printing",
        created_at=same_dispatch_time - timedelta(days=3),
    )
    await db_session.commit()

    preview = await async_client.get("/api/v1/archives/purge/preview?keep_count=3")
    assert preview.status_code == 200
    assert preview.json() == {
        "count": 1,
        "total_bytes": 100,
        "sample_filenames": [archives[0].filename],
        "mode": "count",
        "older_than_days": None,
        "keep_count": 3,
    }

    at_limit = await async_client.get("/api/v1/archives/purge/preview?keep_count=5")
    assert at_limit.status_code == 200
    assert at_limit.json()["count"] == 0
    assert active.status == "printing"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_manual_count_purge_removes_oldest_excess_even_when_recent(
    async_client: AsyncClient,
    archive_factory,
    printer_factory,
    db_session,
):
    """A large recent backlog is reduced to the configured count."""
    from backend.app.models.archive import PrintArchive

    printer = await printer_factory()
    same_dispatch_time = datetime.now(timezone.utc) - timedelta(days=1)
    archives = []
    for index in range(12):
        archive = await archive_factory(
            printer.id,
            print_name=f"Recent-{index}",
            filename=f"recent-{index}.3mf",
        )
        archive.created_at = same_dispatch_time
        archives.append(archive)
    await db_session.commit()

    preview = await async_client.get("/api/v1/archives/purge/preview?keep_count=2")
    assert preview.status_code == 200
    assert preview.json()["count"] == 10
    assert preview.json()["sample_filenames"] == [archive.filename for archive in archives[:5]]

    response = await async_client.post("/api/v1/archives/purge", json={"keep_count": 2})
    assert response.status_code == 200
    assert response.json() == {"deleted": 10, "purge_stats": False}

    archive_ids = [archive.id for archive in archives]
    db_session.expire_all()
    rows = [await db_session.get(PrintArchive, archive_id) for archive_id in archive_ids]
    assert all(row is not None for row in rows)
    assert [row.deleted_at is not None for row in rows] == [True] * 10 + [False, False]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_auto_count_purge_uses_configured_limit_and_preserves_files_library_copy(
    async_client: AsyncClient,
    archive_factory,
    printer_factory,
    db_session,
    tmp_path,
    monkeypatch,
):
    """Scheduled count retention ignores age and deletes only archive-owned files."""
    from backend.app.core.config import settings
    from backend.app.models.archive import PrintArchive
    from backend.app.models.library import LibraryFile
    from backend.app.services.archive_purge import archive_purge_service

    printer = await printer_factory()
    monkeypatch.setattr(settings, "base_dir", tmp_path)
    archive_root = tmp_path / "archives"
    monkeypatch.setattr(settings, "archive_dir", archive_root)

    oldest_dir = archive_root / "oldest"
    oldest_dir.mkdir(parents=True)
    oldest_path = oldest_dir / "model.3mf"
    oldest_path.write_bytes(b"archive copy")
    oldest = await archive_factory(
        printer.id,
        filename="model.3mf",
        file_path=str(oldest_path.relative_to(tmp_path)),
        file_size=len(b"archive copy"),
    )
    oldest_id = oldest.id

    library_path = tmp_path / "files" / "model.3mf"
    library_path.parent.mkdir(parents=True)
    library_path.write_bytes(b"user-managed copy")
    library_copy = LibraryFile(
        filename="model.3mf",
        file_path=str(library_path.relative_to(tmp_path)),
        file_type="3mf",
        file_size=len(b"user-managed copy"),
    )
    db_session.add(library_copy)

    for index in range(2):
        await archive_factory(printer.id, filename=f"newer-{index}.3mf")
    await db_session.commit()

    await archive_purge_service.set_settings(
        db_session,
        enabled=True,
        days=365,
        mode="count",
        max_count=2,
    )
    library_copy_id = library_copy.id
    deleted = await archive_purge_service._maybe_run_auto_purge(db_session)
    assert deleted == 1

    db_session.expire_all()
    old_row = await db_session.get(PrintArchive, oldest_id)
    assert old_row is not None
    assert old_row.deleted_at is not None
    assert not oldest_dir.exists()
    saved_file = await db_session.get(LibraryFile, library_copy_id)
    assert saved_file is not None
    assert library_path.read_bytes() == b"user-managed copy"

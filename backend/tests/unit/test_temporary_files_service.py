"""Temporary Files sweep and existing-data migration (#237)."""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401 - populate Base.metadata
from backend.app.core.database import Base
from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.print_queue import PrintQueueItem, PrintQueueVariant
from backend.app.models.printer import Printer
from backend.app.services import temporary_files
from backend.app.services.temporary_files import (
    ensure_temporary_folder,
    migrate_abandoned_direct_uploads,
    set_retention_days,
    sweep_temporary_files,
)

NOW = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)
OLD = (NOW - timedelta(days=10)).replace(tzinfo=None)
YOUNG = (NOW - timedelta(days=2)).replace(tzinfo=None)


@pytest.fixture
async def db(tmp_path, monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    monkeypatch.setattr("backend.app.services.library_trash.app_settings.base_dir", tmp_path)
    session_maker = async_sessionmaker(engine, expire_on_commit=False)
    async with session_maker() as session:
        session.tmp_path = tmp_path
        yield session
    await engine.dispose()


@pytest.fixture
async def printer(db):
    row = Printer(name="P1", serial_number="S1", ip_address="127.0.0.1", access_code="x", model="X1C")
    db.add(row)
    await db.commit()
    return row


async def _file(db, *, folder_id=None, created_at=None, name="part.gcode.3mf") -> LibraryFile:
    path = db.tmp_path / f"{name}-{datetime.now().timestamp()}"
    path.write_bytes(b"data")
    row = LibraryFile(
        folder_id=folder_id,
        filename=name,
        file_path=str(path),
        file_type="gcode.3mf",
        file_size=4,
        created_at=created_at or OLD,
    )
    db.add(row)
    await db.commit()
    return row


async def _job(db, printer, file, *, status="pending", cleanup=False, archive_id=None, created_at=None):
    db.add(
        PrintQueueItem(
            printer_id=printer.id,
            library_file_id=file.id,
            status=status,
            cleanup_library_after_dispatch=cleanup,
            archive_id=archive_id,
            created_at=created_at or OLD,
        )
    )
    await db.commit()


async def _archive(db, printer) -> int:
    from backend.app.models.archive import PrintArchive

    row = PrintArchive(
        printer_id=printer.id, filename="a.gcode.3mf", file_path="archives/a", file_size=1, status="completed"
    )
    db.add(row)
    await db.commit()
    return row.id


async def _exists(db, file_id) -> bool:
    db.expire_all()
    return (await db.scalar(select(LibraryFile.id).where(LibraryFile.id == file_id))) is not None


class TestEnsureFolder:
    @pytest.mark.asyncio
    async def test_recovers_when_another_request_created_it_first(self, db, monkeypatch):
        existing = await ensure_temporary_folder(db)
        existing_id = existing.id
        # Simulate the race: the lookup misses, then the insert hits the unique index.
        real_get = temporary_files.get_temporary_folder
        calls = {"n": 0}

        async def miss_once(session):
            calls["n"] += 1
            return None if calls["n"] == 1 else await real_get(session)

        monkeypatch.setattr(temporary_files, "get_temporary_folder", miss_once)
        folder = await ensure_temporary_folder(db)
        assert folder.id == existing_id

    @pytest.mark.asyncio
    async def test_creates_once(self, db):
        first = await ensure_temporary_folder(db)
        second = await ensure_temporary_folder(db)
        assert first.id == second.id
        assert first.is_system
        rows = (await db.execute(select(LibraryFolder))).scalars().all()
        assert len(rows) == 1


class TestSweep:
    @pytest.mark.asyncio
    async def test_removes_abandoned_files_past_retention(self, db):
        folder = await ensure_temporary_folder(db)
        old = await _file(db, folder_id=folder.id, created_at=OLD)
        young = await _file(db, folder_id=folder.id, created_at=YOUNG)
        old_id, young_id, path = old.id, young.id, old.file_path

        assert await sweep_temporary_files(db, now=NOW) == 1
        assert not await _exists(db, old_id)
        assert await _exists(db, young_id)
        assert not (db.tmp_path / path).exists()

    @pytest.mark.asyncio
    async def test_respects_configured_retention(self, db):
        folder = await ensure_temporary_folder(db)
        young = await _file(db, folder_id=folder.id, created_at=YOUNG)
        await set_retention_days(db, 1)

        assert await sweep_temporary_files(db, now=NOW) == 1
        assert not await _exists(db, young.id)

    @pytest.mark.asyncio
    async def test_never_touches_files_outside_temporary(self, db):
        await ensure_temporary_folder(db)
        kept = await _file(db, folder_id=None, created_at=OLD)

        assert await sweep_temporary_files(db, now=NOW) == 0
        assert await _exists(db, kept.id)

    @pytest.mark.parametrize("status", ["pending", "skipped", "preheating", "dispatching"])
    @pytest.mark.asyncio
    async def test_keeps_files_a_live_job_needs(self, db, printer, status):
        folder = await ensure_temporary_folder(db)
        needed = await _file(db, folder_id=folder.id, created_at=OLD)
        await _job(db, printer, needed, status=status)

        assert await sweep_temporary_files(db, now=NOW) == 0
        assert await _exists(db, needed.id)

    @pytest.mark.asyncio
    async def test_keeps_files_a_pending_variant_needs(self, db, printer):
        folder = await ensure_temporary_folder(db)
        candidate = await _file(db, folder_id=folder.id, created_at=OLD)
        item = PrintQueueItem(printer_id=None, target_model="X1C", status="pending")
        db.add(item)
        await db.flush()
        db.add(PrintQueueVariant(queue_item_id=item.id, library_file_id=candidate.id, target_model="X1C"))
        await db.commit()

        assert await sweep_temporary_files(db, now=NOW) == 0
        assert await _exists(db, candidate.id)

    @pytest.mark.parametrize("status", ["completed", "cancelled", "failed"])
    @pytest.mark.asyncio
    async def test_removes_files_only_finished_jobs_reference(self, db, printer, status):
        folder = await ensure_temporary_folder(db)
        stale = await _file(db, folder_id=folder.id, created_at=OLD)
        await _job(db, printer, stale, status=status)

        assert await sweep_temporary_files(db, now=NOW) == 1
        assert not await _exists(db, stale.id)
        item = (await db.execute(select(PrintQueueItem))).scalar_one()
        assert item.library_file_id is None


class TestPostDispatchSweep:
    """Files kept at dispatch during the grace window go on the next sweep."""

    @pytest.mark.asyncio
    async def test_removes_young_file_already_sent_to_a_printer(self, db, printer):
        folder = await ensure_temporary_folder(db)
        sent = await _file(db, folder_id=folder.id, created_at=YOUNG)
        sent_id = sent.id
        await _job(db, printer, sent, status="printing", archive_id=await _archive(db, printer), created_at=YOUNG)

        assert await sweep_temporary_files(db, now=NOW) == 1
        assert not await _exists(db, sent_id)

    @pytest.mark.asyncio
    async def test_waits_out_the_grace_window(self, db, printer):
        folder = await ensure_temporary_folder(db)
        sent = await _file(db, folder_id=folder.id, created_at=YOUNG)
        just_queued = (NOW - timedelta(seconds=30)).replace(tzinfo=None)
        await _job(db, printer, sent, status="printing", archive_id=await _archive(db, printer), created_at=just_queued)

        assert await sweep_temporary_files(db, now=NOW) == 0

    @pytest.mark.asyncio
    async def test_keeps_young_file_never_sent(self, db, printer):
        folder = await ensure_temporary_folder(db)
        unsent = await _file(db, folder_id=folder.id, created_at=YOUNG)
        await _job(db, printer, unsent, status="cancelled", created_at=YOUNG)

        assert await sweep_temporary_files(db, now=NOW) == 0

    @pytest.mark.asyncio
    async def test_keeps_sent_file_another_job_still_needs(self, db, printer):
        folder = await ensure_temporary_folder(db)
        shared = await _file(db, folder_id=folder.id, created_at=YOUNG)
        await _job(db, printer, shared, status="printing", archive_id=await _archive(db, printer), created_at=YOUNG)
        await _job(db, printer, shared, status="pending", created_at=YOUNG)

        assert await sweep_temporary_files(db, now=NOW) == 0


class TestMigration:
    @pytest.mark.parametrize("status", ["cancelled", "failed"])
    @pytest.mark.asyncio
    async def test_moves_abandoned_direct_uploads(self, db, printer, status):
        abandoned = await _file(db)
        abandoned_id = abandoned.id
        await _job(db, printer, abandoned, status=status, cleanup=True)

        moved = await migrate_abandoned_direct_uploads(db)

        folder_id = (await temporary_files.get_temporary_folder(db)).id
        assert moved == [abandoned_id]
        db.expire_all()
        assert (await db.get(LibraryFile, abandoned_id)).folder_id == folder_id

    @pytest.mark.asyncio
    async def test_leaves_root_files_without_queue_history(self, db):
        deliberate_id = (await _file(db)).id
        assert await migrate_abandoned_direct_uploads(db) == []
        db.expire_all()
        assert (await db.get(LibraryFile, deliberate_id)).folder_id is None

    @pytest.mark.asyncio
    async def test_leaves_files_used_by_ordinary_jobs(self, db, printer):
        shared = await _file(db)
        await _job(db, printer, shared, status="cancelled", cleanup=True)
        await _job(db, printer, shared, status="completed", cleanup=False)

        assert await migrate_abandoned_direct_uploads(db) == []

    @pytest.mark.asyncio
    async def test_leaves_files_with_a_pending_direct_upload_job(self, db, printer):
        queued = await _file(db)
        await _job(db, printer, queued, status="cancelled", cleanup=True)
        await _job(db, printer, queued, status="pending", cleanup=True)

        assert await migrate_abandoned_direct_uploads(db) == []

    @pytest.mark.asyncio
    async def test_leaves_files_the_user_already_filed(self, db, printer):
        folder = LibraryFolder(name="Mine")
        db.add(folder)
        await db.commit()
        filed = await _file(db, folder_id=folder.id)
        await _job(db, printer, filed, status="cancelled", cleanup=True)

        assert await migrate_abandoned_direct_uploads(db) == []

    @pytest.mark.asyncio
    async def test_is_idempotent(self, db, printer):
        abandoned = await _file(db)
        await _job(db, printer, abandoned, status="failed", cleanup=True)

        assert await migrate_abandoned_direct_uploads(db) == [abandoned.id]
        assert await migrate_abandoned_direct_uploads(db) == []
        folders = (await db.execute(select(LibraryFolder))).scalars().all()
        assert len(folders) == 1

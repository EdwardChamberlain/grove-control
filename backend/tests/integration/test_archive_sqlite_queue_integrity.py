"""SQLite archive deletion must preserve the archive-backed queue contract."""

import asyncio
import logging

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from backend.app.core.database import _ensure_sqlite_archive_queue_integrity, run_migrations
from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.services.archive import ArchiveDeletionBlockedError, ArchiveService


@pytest.fixture
def test_database_url(tmp_path):
    return f"sqlite+aiosqlite:///{tmp_path / 'archive-queue-integrity.sqlite'}"


@pytest.fixture(autouse=True)
async def install_sqlite_archive_queue_triggers(test_engine, monkeypatch):
    # Install the migration's schema objects after create_all(); a separate
    # startup test below exercises run_migrations() and its orphan report.
    monkeypatch.setattr("backend.app.core.database.is_sqlite", lambda: True)
    async with test_engine.begin() as conn:
        await _ensure_sqlite_archive_queue_integrity(conn)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_hard_delete_removes_queue_rows_for_every_non_active_status(db_session, archive_factory, printer_factory):
    printer = await printer_factory()
    archive = await archive_factory(printer.id, with_run=False)
    statuses = ("pending", "completed", "failed", "cancelled")
    db_session.add_all(
        PrintQueueItem(archive_id=archive.id, printer_id=printer.id, position=position, status=status)
        for position, status in enumerate(statuses)
    )
    await db_session.commit()

    assert await ArchiveService(db_session).delete_archive(archive.id) is True

    remaining = await db_session.scalars(select(PrintQueueItem).where(PrintQueueItem.archive_id == archive.id))
    assert list(remaining) == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_bulk_purge_with_statistics_cascades_queue_rows(
    async_client, db_session, archive_factory, printer_factory
):
    """The scheduled/bulk hard-delete path uses the same SQLite cascade."""
    from datetime import datetime, timedelta, timezone

    from backend.app.services.archive_purge import archive_purge_service

    printer = await printer_factory()
    archive = await archive_factory(printer.id, with_run=False)
    archive_id = archive.id
    archive.created_at = datetime.now(timezone.utc) - timedelta(days=400)
    db_session.add(PrintQueueItem(archive_id=archive_id, printer_id=printer.id, position=1, status="pending"))
    await db_session.commit()

    deleted = await archive_purge_service.purge_older_than(db_session, 365, purge_stats=True)

    assert deleted == 1
    assert await db_session.get(PrintArchive, archive_id) is None
    remaining = await db_session.scalars(select(PrintQueueItem).where(PrintQueueItem.archive_id == archive_id))
    assert list(remaining) == []


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize("status", ["preheating", "dispatching", "printing"])
async def test_hard_delete_preserves_active_queue_rows(status, db_session, archive_factory, printer_factory):
    printer = await printer_factory()
    archive = await archive_factory(printer.id, with_run=False)
    item = PrintQueueItem(archive_id=archive.id, printer_id=printer.id, position=1, status=status)
    db_session.add(item)
    await db_session.commit()
    archive_id = archive.id
    item_id = item.id

    with pytest.raises(ArchiveDeletionBlockedError):
        await ArchiveService(db_session).delete_archive(archive_id)

    assert await db_session.get(PrintArchive, archive_id) is not None
    assert await db_session.get(PrintQueueItem, item_id) is not None


@pytest.mark.asyncio
@pytest.mark.integration
async def test_late_queue_insert_cannot_recreate_an_orphan(
    test_engine, async_client, db_session, archive_factory, printer_factory
):
    """An enqueue that validated before a concurrent purge must fail at write time."""
    printer = await printer_factory()
    archive = await archive_factory(printer.id, with_run=False)
    archive_id = archive.id
    enqueue_validated = asyncio.Event()
    allow_enqueue = asyncio.Event()

    async def enqueue_after_validation():
        session_factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
        async with session_factory() as queue_db:
            assert await queue_db.scalar(select(PrintArchive.id).where(PrintArchive.id == archive_id)) == archive_id
            await queue_db.commit()
            enqueue_validated.set()
            await allow_enqueue.wait()
            queue_db.add(PrintQueueItem(archive_id=archive_id, printer_id=printer.id, position=1, status="pending"))
            with pytest.raises(IntegrityError, match="missing archive"):
                await queue_db.commit()
            await queue_db.rollback()

    enqueue_task = asyncio.create_task(enqueue_after_validation())
    await enqueue_validated.wait()
    response = await async_client.delete(f"/api/v1/archives/{archive_id}?purge_stats=true")
    assert response.status_code == 200, response.text
    allow_enqueue.set()
    await enqueue_task

    orphan_count = await db_session.scalar(
        text(
            "SELECT COUNT(*) FROM print_queue q "
            "LEFT JOIN print_archives a ON a.id = q.archive_id "
            "WHERE q.archive_id IS NOT NULL AND a.id IS NULL"
        )
    )
    assert orphan_count == 0


@pytest.mark.asyncio
@pytest.mark.integration
async def test_startup_reports_existing_orphans_and_triggers_survive_reconnect(
    caplog, test_engine, test_database_url, db_session
):
    # Simulate a row left by a previous app version before the migration added
    # the targeted insert guard.
    async with test_engine.begin() as conn:
        await conn.execute(text("DROP TRIGGER trg_print_queue_archive_insert"))
    db_session.add(PrintQueueItem(archive_id=987654, status="failed", position=1))
    await db_session.commit()

    with caplog.at_level(logging.WARNING, logger="backend.app.core.database"):
        async with test_engine.begin() as conn:
            await run_migrations(conn)

    assert "SQLite found 1 print_queue row(s) referencing missing archives" in caplog.text
    assert "archive=987654, status=failed" in caplog.text

    await test_engine.dispose()
    reconnected = create_async_engine(test_database_url, echo=False)
    try:
        async with reconnected.connect() as conn:
            triggers = await conn.scalars(
                text("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_print_%archive%'")
            )
            assert {
                "trg_print_queue_archive_insert",
                "trg_print_queue_archive_update",
                "trg_print_archive_block_active_queue_delete",
                "trg_print_archive_delete_queue",
            }.issubset(set(triggers))
            orphan = await conn.execute(text("SELECT archive_id, status FROM print_queue WHERE archive_id = 987654"))
            assert orphan.one() == (987654, "failed")

        session_factory = async_sessionmaker(reconnected, class_=AsyncSession, expire_on_commit=False)
        async with session_factory() as session:
            session.add(PrintQueueItem(archive_id=987655, status="pending", position=2))
            with pytest.raises(IntegrityError, match="missing archive"):
                await session.commit()
            await session.rollback()
    finally:
        await reconnected.dispose()

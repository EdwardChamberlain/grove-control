"""Versioned preservation of physical outcomes for delayed external Archives."""

from datetime import datetime

import pytest
from sqlalchemy import event, select, text
from sqlalchemy.ext.asyncio import create_async_engine

import backend.app.models  # noqa: F401
from backend.app.core.database import Base, _migrate_queue_archive_outcomes, ensure_queue_insert_schema
from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.settings import Settings


async def test_upgrade_backfills_only_proven_outcomes_and_runs_once():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            await conn.execute(Settings.__table__.insert().values(key="queue_archive_outcome_version", value="1"))
            # Model a pre-stage-5 database, then use the startup repair path.
            await conn.execute(text("DROP INDEX uq_print_queue_holding_printer"))
            for column in ("physical_outcome", "physical_completed_at", "physical_failure_reason"):
                await conn.execute(text(f"ALTER TABLE print_queue DROP COLUMN {column}"))
            completed = datetime(2026, 10, 1, 12)
            await conn.execute(
                PrintQueueItem.__table__.insert(),
                [
                    {
                        "id": i,
                        "status": status,
                        "completed_at": completed if status != "printing" else None,
                        "error_message": reason,
                    }
                    for i, status, reason in (
                        (1, "failed", "Printer error"),
                        (2, "cancelled", "Stopped"),
                        (3, "successful", None),
                        (4, "unsuccessful", "Stopped"),
                        (5, "unsuccessful", "Misleading display reason"),
                        (6, "unsuccessful", "Print failed"),
                        (7, "unsuccessful", "Stopped"),
                        (8, "printing", None),
                        (9, "failed", "Confirmed printer failure"),
                    )
                ],
            )
            await conn.execute(text("UPDATE print_queue SET dispatched_at = :sent WHERE id = 9"), {"sent": completed})
            archives = PrintArchive.__table__
            await conn.execute(
                archives.insert(),
                [
                    {
                        "id": 1,
                        "filename": "attempt.3mf",
                        "file_path": "attempt.3mf",
                        "file_size": 1,
                        "status": "failed",
                        "completed_at": completed,
                        "failure_reason": "HMS 0700_8012",
                        "dispatched_queue_item_id": 5,
                    },
                    {
                        "id": 2,
                        "filename": "source.3mf",
                        "file_path": "source.3mf",
                        "file_size": 1,
                        "status": "failed",
                        "completed_at": completed,
                        "failure_reason": "Other job",
                        "dispatched_queue_item_id": None,
                    },
                    {
                        "id": 3,
                        "filename": "stopped.3mf",
                        "file_path": "stopped.3mf",
                        "file_size": 1,
                        "status": "aborted",
                        "completed_at": completed,
                        "failure_reason": "User cancelled",
                        "dispatched_queue_item_id": 7,
                    },
                    {
                        "id": 4,
                        "filename": "confirmed-failure.3mf",
                        "file_path": "confirmed-failure.3mf",
                        "file_size": 1,
                        "status": "failed",
                        "completed_at": completed,
                        "failure_reason": "HMS 0700_8012",
                        "dispatched_queue_item_id": 9,
                    },
                ],
            )
            await conn.execute(
                text(
                    "UPDATE print_queue SET archive_id = CASE id "
                    "WHEN 5 THEN 1 WHEN 6 THEN 2 WHEN 7 THEN 3 WHEN 9 THEN 4 END"
                )
            )
            await ensure_queue_insert_schema(conn)
            await _migrate_queue_archive_outcomes(conn)
            rows = {row.id: row for row in (await conn.execute(select(PrintQueueItem.__table__))).all()}
            assert {i: row.physical_outcome for i, row in rows.items()} == {
                1: None,
                2: None,
                3: "completed",
                4: None,
                5: None,
                6: None,
                7: None,
                8: None,
                9: "failed",
            }
            assert rows[9].physical_failure_reason == "HMS 0700_8012"
            assert rows[9].physical_completed_at == completed
            assert await conn.scalar(select(PrintArchive.status).where(PrintArchive.id == 3)) == "cancelled"
            assert (
                await conn.scalar(select(Settings.value).where(Settings.key == "queue_archive_outcome_version")) == "2"
            )
            await conn.execute(text("UPDATE print_queue SET physical_outcome = NULL, status = 'failed' WHERE id = 8"))
            await _migrate_queue_archive_outcomes(conn)
            assert await conn.scalar(select(PrintQueueItem.physical_outcome).where(PrintQueueItem.id == 8)) is None
    finally:
        await engine.dispose()


async def test_backfill_reads_attempts_together_without_rewriting_queue_to_lock():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    statements = []

    def capture(_conn, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement)

    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            await conn.execute(
                PrintQueueItem.__table__.insert(),
                [{"id": i, "status": "unsuccessful", "archive_id": i} for i in range(1, 11)],
            )
            await conn.execute(
                PrintArchive.__table__.insert(),
                [
                    {
                        "id": i,
                        "filename": "attempt.3mf",
                        "file_path": "attempt.3mf",
                        "file_size": 1,
                        "status": "failed",
                        "dispatched_queue_item_id": i,
                    }
                    for i in range(1, 11)
                ],
            )
            event.listen(engine.sync_engine, "before_cursor_execute", capture)
            try:
                await _migrate_queue_archive_outcomes(conn)
            finally:
                event.remove(engine.sync_engine, "before_cursor_execute", capture)
            assert len([sql for sql in statements if "LEFT OUTER JOIN print_archives" in sql]) == 1
            assert not any(
                "FROM print_archives" in sql or "SET id=print_queue.id" in sql or "SET id = id" in sql
                for sql in statements
            )
            assert set(await conn.scalars(select(PrintQueueItem.physical_outcome))) == {None}
    finally:
        await engine.dispose()

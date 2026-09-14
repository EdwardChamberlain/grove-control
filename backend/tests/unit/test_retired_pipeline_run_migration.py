"""Regression coverage for retiring slicer-pipeline orchestration."""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.database import _migrate_retired_pipeline_runs


@pytest.fixture(autouse=True)
def force_sqlite_dialect(monkeypatch):
    """Run the SQLite branch against the isolated test database."""
    from backend.app.core import database as database_module

    monkeypatch.setattr(database_module, "is_sqlite", lambda: True)


@pytest.fixture
async def engine():
    eng = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with eng.begin() as conn:
        await conn.execute(
            text(
                "CREATE TABLE pipeline_runs ("
                "id INTEGER PRIMARY KEY, "
                "status VARCHAR(20) NOT NULL, "
                "sliced_library_file_id INTEGER, "
                "slice_job_id INTEGER, "
                "started_at DATETIME, "
                "completed_at DATETIME, "
                "error_message TEXT"
                ")"
            )
        )
    yield eng
    await eng.dispose()


@pytest.mark.asyncio
async def test_interrupted_runs_become_explicitly_terminal_without_touching_sliced_runs(engine):
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO pipeline_runs "
                "(id, status, sliced_library_file_id, slice_job_id, started_at) VALUES "
                "(1, 'queued', NULL, 101, '2026-09-14 12:00:00'), "
                "(2, 'slicing', NULL, 102, '2026-09-14 12:01:00'), "
                "(3, 'dispatching', 77, 103, '2026-09-14 12:02:00'), "
                "(4, 'failed', NULL, 104, '2026-09-14 12:03:00')"
            )
        )
        await _migrate_retired_pipeline_runs(conn)

    async with engine.connect() as conn:
        rows = (
            (
                await conn.execute(
                    text(
                        "SELECT id, status, sliced_library_file_id, slice_job_id, started_at, "
                        "completed_at, error_message FROM pipeline_runs ORDER BY id"
                    )
                )
            )
            .mappings()
            .all()
        )

    assert rows[0]["status"] == "failed"
    assert rows[0]["slice_job_id"] is None
    assert rows[0]["started_at"] is None
    assert rows[0]["completed_at"] is not None
    assert "retired" in rows[0]["error_message"]
    assert rows[1]["status"] == "failed"
    assert rows[2]["status"] == "dispatching"
    assert rows[2]["sliced_library_file_id"] == 77
    assert rows[3]["status"] == "failed"


@pytest.mark.asyncio
async def test_interrupted_run_migration_is_idempotent(engine):
    async with engine.begin() as conn:
        await conn.execute(text("INSERT INTO pipeline_runs (id, status, slice_job_id) VALUES (1, 'queued', 101)"))
        await _migrate_retired_pipeline_runs(conn)

    async with engine.connect() as conn:
        first = (
            (await conn.execute(text("SELECT status, completed_at, error_message FROM pipeline_runs WHERE id = 1")))
            .mappings()
            .one()
        )

    async with engine.begin() as conn:
        await _migrate_retired_pipeline_runs(conn)

    async with engine.connect() as conn:
        second = (
            (await conn.execute(text("SELECT status, completed_at, error_message FROM pipeline_runs WHERE id = 1")))
            .mappings()
            .one()
        )

    assert second == first


@pytest.mark.asyncio
async def test_fresh_database_without_legacy_pipeline_table_is_a_noop():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await _migrate_retired_pipeline_runs(conn)
    await engine.dispose()

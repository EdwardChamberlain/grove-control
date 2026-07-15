"""Regression coverage for startup repair of queue columns.

An interrupted Grove Control upgrade used to leave a persistent database
compatible enough to start but missing fields used by POST /queue/. The first
print submission then failed with an opaque 500.
"""

from unittest.mock import patch

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.database import _QUEUE_INSERT_COLUMN_DEFINITIONS, ensure_queue_insert_schema
from backend.app.models.print_queue import PrintQueueItem


@pytest.mark.asyncio
async def test_queue_schema_repair_adds_missing_insert_columns(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'legacy.db'}")
    try:
        async with engine.begin() as conn:
            await conn.execute(text("CREATE TABLE print_queue (id INTEGER PRIMARY KEY)"))

            await ensure_queue_insert_schema(conn)

            rows = await conn.execute(text("PRAGMA table_info(print_queue)"))
            columns = {row[1] for row in rows}

        assert set(_QUEUE_INSERT_COLUMN_DEFINITIONS) <= columns
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_queue_schema_repair_is_idempotent(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'current.db'}")
    try:
        async with engine.begin() as conn:
            await conn.execute(text("CREATE TABLE print_queue (id INTEGER PRIMARY KEY)"))
            await ensure_queue_insert_schema(conn)
            await ensure_queue_insert_schema(conn)
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_queue_schema_repair_reports_columns_that_could_not_be_added(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'unrepairable.db'}")
    try:
        async with engine.begin() as conn:
            await conn.execute(text("CREATE TABLE print_queue (id INTEGER PRIMARY KEY)"))

            with (
                patch(
                    "backend.app.core.database._safe_execute",
                    side_effect=OperationalError("ALTER TABLE", {}, RuntimeError("read-only database")),
                ),
                pytest.raises(RuntimeError, match="printer_id.*read-only database"),
            ):
                await ensure_queue_insert_schema(conn)
    finally:
        await engine.dispose()


def test_queue_schema_repair_tracks_every_non_primary_model_column():
    """A new ORM column must be added to the startup repair map deliberately."""
    model_columns = {column.name for column in inspect(PrintQueueItem).columns} - {"id"}
    assert set(_QUEUE_INSERT_COLUMN_DEFINITIONS) == model_columns

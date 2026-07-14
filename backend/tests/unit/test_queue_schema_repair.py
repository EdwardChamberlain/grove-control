"""Regression coverage for startup repair of queue columns.

An interrupted Grove Control upgrade used to leave a persistent database
compatible enough to start but missing fields used by POST /queue/. The first
print submission then failed with an opaque 500.
"""

from unittest.mock import patch

import pytest
from sqlalchemy import text
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.database import ensure_queue_insert_schema


@pytest.mark.asyncio
async def test_queue_schema_repair_adds_missing_insert_columns(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'legacy.db'}")
    try:
        async with engine.begin() as conn:
            await conn.execute(text("CREATE TABLE print_queue (id INTEGER PRIMARY KEY)"))

            await ensure_queue_insert_schema(conn)

            rows = await conn.execute(text("PRAGMA table_info(print_queue)"))
            columns = {row[1] for row in rows}

        assert {
            "filament_short",
            "skip_filament_check",
            "cleanup_library_after_dispatch",
            "nozzle_mapping",
            "nozzles_info",
            "gate_acknowledged",
            "force_color_match",
        } <= columns
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
                pytest.raises(RuntimeError, match="filament_short.*read-only database"),
            ):
                await ensure_queue_insert_schema(conn)
    finally:
        await engine.dispose()

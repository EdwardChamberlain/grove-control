"""Regression coverage for the dispatch Archive-to-queue schema migration."""

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine


@pytest.mark.asyncio
async def test_archive_dispatch_queue_link_backfills_only_unambiguous_rows(monkeypatch):
    from backend.app.core import database

    monkeypatch.setattr(database, "is_sqlite", lambda: True)
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as conn:
            await conn.execute(text("CREATE TABLE print_queue (id INTEGER PRIMARY KEY)"))
            await conn.execute(text("CREATE TABLE print_archives (id INTEGER PRIMARY KEY, extra_data JSON)"))
            await conn.execute(text("INSERT INTO print_queue (id) VALUES (10), (20)"))
            await conn.execute(
                text(
                    "INSERT INTO print_archives (id, extra_data) VALUES "
                    "(1, '{\"queue_item_id\":10}'), "
                    "(2, '{\"queue_item_id\":20}'), "
                    "(3, '{\"queue_item_id\":20}'), "
                    "(4, '{\"queue_item_id\":99}'), "
                    '(5, \'{"queue_item_id":"10"}\'), '
                    "(6, 'not-json')"
                )
            )

            await database._migrate_archive_dispatch_queue_link(conn)
            await database._migrate_archive_dispatch_queue_link(conn)

            links = dict((await conn.execute(text("SELECT id, dispatched_queue_item_id FROM print_archives"))).all())
            assert links == {1: 10, 2: None, 3: None, 4: None, 5: None, 6: None}

            indexes = {row[1] for row in await conn.execute(text("PRAGMA index_list(print_archives)"))}
            assert "uq_print_archives_dispatched_queue_item_id" in indexes

            foreign_keys = await conn.execute(text("PRAGMA foreign_key_list(print_archives)"))
            assert any(row[2] == "print_queue" and row[6] == "SET NULL" for row in foreign_keys)
    finally:
        await engine.dispose()

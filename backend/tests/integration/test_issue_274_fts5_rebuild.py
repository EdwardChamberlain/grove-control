"""Regression tests for rebuilding an out-of-sync archive FTS index."""

import pytest
from httpx import AsyncClient
from sqlalchemy import text

pytestmark = pytest.mark.integration


@pytest.fixture
def fts_table(db_session):
    async def create():
        await db_session.execute(
            text(
                "CREATE VIRTUAL TABLE IF NOT EXISTS archive_fts USING fts5("
                "print_name, filename, tags, notes, designer, filament_type, "
                "content='print_archives', content_rowid='id')"
            )
        )
        await db_session.commit()

    return create


async def test_rebuild_restores_searchable_entries(
    async_client: AsyncClient, printer_factory, archive_factory, db_session, fts_table
):
    await fts_table()
    await db_session.execute(text("DROP TRIGGER IF EXISTS archive_fts_insert"))
    await db_session.commit()

    printer = await printer_factory()
    archive = await archive_factory(printer.id, print_name="recoverabletoken")

    before = await db_session.execute(
        text("SELECT rowid FROM archive_fts WHERE archive_fts MATCH :query"),
        {"query": "recoverabletoken"},
    )
    assert before.scalars().all() == []

    await db_session.execute(
        text(
            "CREATE TRIGGER IF NOT EXISTS archive_fts_insert AFTER INSERT ON print_archives BEGIN "
            "INSERT INTO archive_fts(rowid, print_name, filename, tags, notes, designer, filament_type) "
            "VALUES (new.id, new.print_name, new.filename, new.tags, new.notes, new.designer, new.filament_type); "
            "END"
        )
    )
    await db_session.commit()

    response = await async_client.post("/api/v1/archives/search/rebuild-index")

    assert response.status_code == 200
    matches = await db_session.execute(
        text("SELECT rowid FROM archive_fts WHERE archive_fts MATCH :query"),
        {"query": "recoverabletoken"},
    )
    assert matches.scalars().all() == [archive.id]

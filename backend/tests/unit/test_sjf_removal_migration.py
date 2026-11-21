"""Upgrading an install that had Shortest Job First enabled.

The mode was removed. ``run_migrations`` drops the saved ``queue_shortest_first``
setting, and the settings API neither returns nor accepts it, so the mode cannot
be reactivated. Queued jobs keep their positions and print-time estimates.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.core.database import run_migrations
from backend.app.models.print_queue import PrintQueueItem
from backend.app.schemas.settings import AppSettings, AppSettingsUpdate


@pytest.fixture(autouse=True)
def force_sqlite_dialect(monkeypatch):
    from backend.app.core import database as database_module, db_dialect

    monkeypatch.setattr(db_dialect, "is_sqlite", lambda: True)
    monkeypatch.setattr(db_dialect, "is_postgres", lambda: False)
    monkeypatch.setattr(database_module, "is_sqlite", lambda: True)


@pytest.mark.asyncio
async def test_upgrade_drops_setting_and_keeps_queue():
    from backend.app.core.database import Base
    from backend.app.models import (  # noqa: F401
        ams_history,
        ams_label,
        api_key,
        archive,
        color_catalog,
        external_link,
        filament,
        group,
        kprofile_note,
        maintenance,
        notification,
        notification_template,
        print_queue,
        printer,
        project,
        project_bom,
        settings,
        slot_preset,
        smart_plug,
        smart_plug_energy_snapshot,
        spool,
        spool_assignment,
        spool_catalog,
        spool_k_profile,
        spool_usage_history,
        user,
        user_email_pref,
        virtual_printer,
    )

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            await conn.execute(text("INSERT INTO settings (key, value) VALUES ('queue_shortest_first', 'true')"))
        async with async_sessionmaker(engine, expire_on_commit=False)() as db:
            db.add(PrintQueueItem(position=1, status="pending", print_time_seconds=7200, been_jumped=True))
            db.add(PrintQueueItem(position=2, status="pending", print_time_seconds=600))
            await db.commit()
        async with engine.begin() as conn:
            await run_migrations(conn)
        async with engine.connect() as conn:
            left = (await conn.execute(text("SELECT COUNT(*) FROM settings WHERE key='queue_shortest_first'"))).scalar()
            rows = (
                await conn.execute(text("SELECT id, position, print_time_seconds FROM print_queue ORDER BY id"))
            ).all()
        assert left == 0
        assert [tuple(r) for r in rows] == [(1, 1, 7200), (2, 2, 600)]
    finally:
        await engine.dispose()


def test_settings_schema_no_longer_exposes_the_mode():
    assert "queue_shortest_first" not in AppSettings.model_fields
    # An old client that still sends the key is ignored rather than applied.
    update = AppSettingsUpdate(**{"queue_shortest_first": True})
    assert "queue_shortest_first" not in update.model_dump(exclude_unset=True)

"""Regression coverage for the native-camera migration.

Existing installations may contain external-camera settings in the printer
row. The native-camera cutover must clear those values without changing other
printer configuration, and repeated startup migrations must remain safe.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.database import run_migrations


@pytest.fixture(autouse=True)
def force_sqlite_dialect(monkeypatch):
    """Use the SQLite migration path for this in-memory regression test."""
    from backend.app.core import database as database_module, db_dialect

    monkeypatch.setattr(db_dialect, "is_sqlite", lambda: True)
    monkeypatch.setattr(db_dialect, "is_postgres", lambda: False)
    monkeypatch.setattr(database_module, "is_sqlite", lambda: True)


def _register_all_models():
    """run_migrations touches tables beyond printers; register the full schema."""
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
        print_log,
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


@pytest.fixture
async def engine():
    from backend.app.core.database import Base

    _register_all_models()
    eng = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    await eng.dispose()


@pytest.mark.asyncio
async def test_legacy_camera_settings_are_cleared_without_touching_printer_state(engine):
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO printers "
                "(id, name, serial_number, ip_address, access_code, model, nozzle_count, "
                "is_active, auto_archive, print_hours_offset, runtime_seconds, "
                "camera_rotation, plate_detection_enabled, awaiting_plate_clear, "
                "external_camera_url, external_camera_type, "
                "external_camera_enabled, external_camera_snapshot_url) "
                "VALUES (1, 'P1S', 'ABC123', '192.168.1.10', 'secret', 'P1S', 1, "
                "1, 1, 0, 0, 90, 1, 0, 'rtsp://camera.invalid/live', 'rtsp', 1, "
                "'http://camera.invalid/frame.jpg')"
            )
        )

    async with engine.begin() as conn:
        await run_migrations(conn)

    async with engine.connect() as conn:
        row = (
            await conn.execute(
                text(
                    "SELECT external_camera_url, external_camera_type, external_camera_enabled, "
                    "external_camera_snapshot_url, camera_rotation, plate_detection_enabled "
                    "FROM printers WHERE id = 1"
                )
            )
        ).one()

    assert tuple(row) == (None, None, False, None, 90, True)


@pytest.mark.asyncio
async def test_legacy_camera_cleanup_is_idempotent(engine):
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO printers "
                "(id, name, serial_number, ip_address, access_code, nozzle_count, is_active, "
                "auto_archive, print_hours_offset, runtime_seconds, awaiting_plate_clear, "
                "external_camera_url) "
                "VALUES (1, 'P1S', 'ABC123', '192.168.1.10', 'secret', 1, 1, 1, 0, 0, 0, "
                "'http://camera.invalid/frame.jpg')"
            )
        )

    async with engine.begin() as conn:
        await run_migrations(conn)
    async with engine.begin() as conn:
        await run_migrations(conn)

    async with engine.connect() as conn:
        result = await conn.execute(text("SELECT external_camera_url FROM printers WHERE id = 1"))
        assert result.scalar_one() is None

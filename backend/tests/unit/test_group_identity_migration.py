"""Regression coverage for the stable built-in group identity migration."""

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.database import Base, run_migrations
from backend.app.models import (
    active_print_session,  # noqa: F401
    ams_history,  # noqa: F401
    ams_label,  # noqa: F401
    api_key,  # noqa: F401
    archive,  # noqa: F401
    auth_ephemeral,  # noqa: F401
    color_catalog,  # noqa: F401
    external_link,  # noqa: F401
    filament,  # noqa: F401
    group,  # noqa: F401
    kprofile_note,  # noqa: F401
    maintenance,  # noqa: F401
    notification,  # noqa: F401
    notification_template,  # noqa: F401
    oidc_provider,  # noqa: F401
    print_log,  # noqa: F401
    print_queue,  # noqa: F401
    printer,  # noqa: F401
    project,  # noqa: F401
    project_bom,  # noqa: F401
    scheduled_drying,  # noqa: F401
    settings,  # noqa: F401
    slot_preset,  # noqa: F401
    smart_plug,  # noqa: F401
    smart_plug_energy_snapshot,  # noqa: F401
    spool,  # noqa: F401
    spool_assignment,  # noqa: F401
    spool_catalog,  # noqa: F401
    spool_filament_preset,  # noqa: F401
    spool_k_profile,  # noqa: F401
    spool_usage_history,  # noqa: F401
    spoolman_k_profile,  # noqa: F401
    spoolman_slot_assignment,  # noqa: F401
    user,  # noqa: F401
    user_email_pref,  # noqa: F401
    user_otp_code,  # noqa: F401
    user_totp,  # noqa: F401
    virtual_printer,  # noqa: F401
)


@pytest.mark.asyncio
async def test_run_migrations_adds_group_system_key_to_legacy_schema():
    """An old groups table gains the nullable stable-key column and index."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")

    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            await conn.execute(text("DROP TABLE groups"))
            await conn.execute(
                text(
                    "CREATE TABLE groups ("
                    "id INTEGER PRIMARY KEY, "
                    "name VARCHAR(100) NOT NULL UNIQUE, "
                    "description VARCHAR(500), "
                    "permissions JSON NOT NULL, "
                    "is_system BOOLEAN NOT NULL DEFAULT 0, "
                    "created_at DATETIME, "
                    "updated_at DATETIME"
                    ")"
                )
            )

            await run_migrations(conn)
            await run_migrations(conn)

            columns = await conn.execute(text("PRAGMA table_info(groups)"))
            assert "system_key" in {row[1] for row in columns}

            indexes = await conn.execute(text("PRAGMA index_list(groups)"))
            assert any(row[1] == "uq_groups_system_key" and row[2] for row in indexes)
    finally:
        await engine.dispose()

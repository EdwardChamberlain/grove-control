"""Regression coverage for the #180 maintenance-history backfill."""

from datetime import datetime, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401  # Register the complete mapped schema for Base.metadata.
from backend.app.core.database import Base, _backfill_maintenance_log_entries
from backend.app.models.maintenance import MaintenanceHistory, MaintenanceLogEntry, MaintenanceType, PrinterMaintenance
from backend.app.models.printer import Printer


@pytest.mark.asyncio
async def test_backfill_promotes_legacy_history_once():
    """Repeated startup migration keeps the original completed-task record exactly once."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    performed_at = datetime(2025, 1, 2, 3, 4, tzinfo=timezone.utc)

    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

        async with session_factory() as session:
            printer = Printer(
                name="Legacy maintenance printer",
                serial_number="LEGACY-LOG-001",
                ip_address="192.168.1.50",
                access_code="12345678",
                model="X1C",
            )
            maintenance_type = MaintenanceType(
                name="Clean nozzle",
                description="Legacy scheduled task",
                default_interval_hours=100,
                interval_type="hours",
                is_system=True,
                is_deleted=False,
            )
            session.add_all([printer, maintenance_type])
            await session.flush()
            assignment = PrinterMaintenance(
                printer_id=printer.id,
                maintenance_type_id=maintenance_type.id,
                last_performed_hours=0,
            )
            session.add(assignment)
            await session.flush()
            history = MaintenanceHistory(
                printer_maintenance_id=assignment.id,
                performed_at=performed_at,
                hours_at_maintenance=42.5,
                notes="Historic maintenance note",
            )
            session.add(history)
            await session.flush()
            history_id = history.id
            await session.commit()

        async with engine.begin() as conn:
            await _backfill_maintenance_log_entries(conn)
        async with engine.begin() as conn:
            await _backfill_maintenance_log_entries(conn)

        async with session_factory() as session:
            entries = (await session.execute(select(MaintenanceLogEntry))).scalars().all()
            assert len(entries) == 1
            entry = entries[0]
            assert entry.entry_type == "scheduled"
            assert entry.title == "Clean nozzle"
            assert entry.notes == "Historic maintenance note"
            assert entry.hours_at_maintenance == 42.5
            assert entry.source_history_id == history_id
            assert entry.created_by_id is None
            assert entry.created_by_username is None
    finally:
        await engine.dispose()

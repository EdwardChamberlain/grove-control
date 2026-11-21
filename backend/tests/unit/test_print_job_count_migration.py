"""Migration coverage for print-job based maintenance intervals (#337).

An existing database has no ``printers.print_job_count`` column. The migration
has to add it, seed it from the print log exactly once, and add the snapshot
columns that let a completed maintenance task remember the job count.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401  # Register the complete mapped schema for Base.metadata.
from backend.app.core.database import Base, run_migrations
from backend.app.models.maintenance import MaintenanceHistory, MaintenanceLogEntry, MaintenanceType, PrinterMaintenance
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.printer import Printer


@pytest.fixture(autouse=True)
def force_sqlite_dialect(monkeypatch):
    """Force the SQLite branch regardless of test env settings."""
    from backend.app.core import database as database_module, db_dialect

    monkeypatch.setattr(db_dialect, "is_sqlite", lambda: True)
    monkeypatch.setattr(db_dialect, "is_postgres", lambda: False)
    monkeypatch.setattr(database_module, "is_sqlite", lambda: True)


def _printer(serial: str, name: str) -> Printer:
    return Printer(name=name, serial_number=serial, ip_address="192.168.1.50", access_code="12345678", model="X1C")


async def _legacy_database(session_factory, engine):
    """Seed rows, then strip the new columns so the schema looks pre-#337."""
    async with session_factory() as session:
        busy, idle = _printer("JOBS-BUSY", "Busy"), _printer("JOBS-IDLE", "Idle")
        task = MaintenanceType(name="Clean nozzle", default_interval_hours=100, interval_type="hours", is_system=True)
        session.add_all([busy, idle, task])
        await session.flush()

        for status in ("completed", "failed", "cancelled", "stopped", "skipped"):
            session.add(PrintLogEntry(printer_id=busy.id, status=status))
        # Rows that must never be attributed to a printer in the table.
        session.add(PrintLogEntry(printer_id=None, status="completed"))
        session.add(PrintLogEntry(printer_id=9999, status="completed"))

        assignment = PrinterMaintenance(printer_id=busy.id, maintenance_type_id=task.id, last_performed_hours=0)
        session.add(assignment)
        await session.flush()
        performed_at = datetime(2025, 1, 2, 3, 4, tzinfo=timezone.utc)
        session.add(MaintenanceHistory(printer_maintenance_id=assignment.id, performed_at=performed_at))
        session.add(
            MaintenanceLogEntry(
                printer_id=busy.id, entry_type="manual", title="Replaced hotend", occurred_at=performed_at
            )
        )
        await session.commit()
        ids = (busy.id, idle.id)

    async with engine.begin() as conn:
        for table, column in (
            ("printers", "print_job_count"),
            ("printer_maintenance", "last_performed_jobs"),
            ("maintenance_history", "jobs_at_maintenance"),
            ("maintenance_log_entries", "jobs_at_maintenance"),
        ):
            await conn.execute(text(f"ALTER TABLE {table} DROP COLUMN {column}"))
    return ids


@pytest.fixture
async def legacy_engine():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


async def _job_counts(engine) -> dict[str, int]:
    async with engine.connect() as conn:
        rows = (await conn.execute(text("SELECT serial_number, print_job_count FROM printers"))).fetchall()
    return dict(rows)


@pytest.mark.asyncio
async def test_adds_columns_and_backfills_job_counts_from_the_print_log(legacy_engine):
    """Every non-skipped run counts; skipped runs and unattributable rows do not."""
    session_factory = async_sessionmaker(legacy_engine, expire_on_commit=False)
    await _legacy_database(session_factory, legacy_engine)

    async with legacy_engine.begin() as conn:
        await run_migrations(conn)

    assert await _job_counts(legacy_engine) == {"JOBS-BUSY": 4, "JOBS-IDLE": 0}


@pytest.mark.asyncio
async def test_new_snapshot_columns_default_sensibly_for_existing_rows(legacy_engine):
    """Existing tasks start from 0 jobs; old log entries stay NULL (no job count recorded)."""
    session_factory = async_sessionmaker(legacy_engine, expire_on_commit=False)
    await _legacy_database(session_factory, legacy_engine)

    async with legacy_engine.begin() as conn:
        await run_migrations(conn)

    async with legacy_engine.connect() as conn:
        assert (await conn.execute(text("SELECT last_performed_jobs FROM printer_maintenance"))).scalar() == 0
        assert (await conn.execute(text("SELECT jobs_at_maintenance FROM maintenance_history"))).scalar() == 0
        assert (await conn.execute(text("SELECT jobs_at_maintenance FROM maintenance_log_entries"))).scalar() is None


@pytest.mark.asyncio
async def test_backfill_only_runs_when_the_column_is_first_added(legacy_engine):
    """Later startups must keep the live counter, not recompute it from the (clearable) log."""
    session_factory = async_sessionmaker(legacy_engine, expire_on_commit=False)
    await _legacy_database(session_factory, legacy_engine)

    async with legacy_engine.begin() as conn:
        await run_migrations(conn)
    async with legacy_engine.begin() as conn:
        await conn.execute(text("UPDATE printers SET print_job_count = 250 WHERE serial_number = 'JOBS-BUSY'"))
        await conn.execute(text("DELETE FROM print_log_entries"))

    async with legacy_engine.begin() as conn:
        await run_migrations(conn)

    assert (await _job_counts(legacy_engine))["JOBS-BUSY"] == 250

"""Migration coverage for filament-change based maintenance intervals (#337).

An existing database has no ``printers.filament_change_count``. The migration adds it,
seeds it once from the archived prints' real 3MF files, and adds the snapshot columns
that let a completed maintenance task remember the change count.
"""

from __future__ import annotations

import shutil
from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401  # Register the complete mapped schema for Base.metadata.
from backend.app.core.config import settings
from backend.app.core.database import Base, run_migrations
from backend.app.models.archive import PrintArchive
from backend.app.models.maintenance import MaintenanceHistory, MaintenanceLogEntry, MaintenanceType, PrinterMaintenance
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.printer import Printer

FIXTURES = Path(__file__).resolve().parent.parent / "_fixtures" / "threemf"


@pytest.fixture(autouse=True)
def force_sqlite_dialect(monkeypatch):
    """Force the SQLite branch regardless of test env settings."""
    from backend.app.core import database as database_module, db_dialect

    monkeypatch.setattr(db_dialect, "is_sqlite", lambda: True)
    monkeypatch.setattr(db_dialect, "is_postgres", lambda: False)
    monkeypatch.setattr(database_module, "is_sqlite", lambda: True)


@pytest.fixture
def base_dir(tmp_path, monkeypatch):
    """Point archive storage at a temp dir holding real sliced plates."""
    monkeypatch.setattr(settings, "base_dir", tmp_path)
    (tmp_path / "archives").mkdir()
    for name in ("cylinder_2_changes.3mf", "cylinder_painted_74_changes.3mf"):
        shutil.copy(FIXTURES / name, tmp_path / "archives" / name)
    return tmp_path


@pytest.fixture
async def legacy_engine():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


def _printer(serial: str, name: str) -> Printer:
    return Printer(name=name, serial_number=serial, ip_address="192.168.1.50", access_code="12345678", model="X1C")


def _archive(printer_id: int, file_path: str) -> PrintArchive:
    return PrintArchive(
        printer_id=printer_id, filename=Path(file_path).name, file_path=file_path, file_size=1, status="completed"
    )


async def _legacy_database(legacy_engine):
    """Seed prints, then strip the new columns so the schema looks pre-filament-change."""
    session_factory = async_sessionmaker(legacy_engine, expire_on_commit=False)
    async with session_factory() as session:
        busy, other, idle = (_printer("CH-BUSY", "Busy"), _printer("CH-OTHER", "Other"), _printer("CH-IDLE", "Idle"))
        session.add_all([busy, other, idle])
        await session.flush()
        two = _archive(busy.id, "archives/cylinder_2_changes.3mf")  # 3 loads
        painted = _archive(other.id, "archives/cylinder_painted_74_changes.3mf")  # 75 loads
        missing = _archive(busy.id, "archives/deleted.3mf")
        session.add_all([two, painted, missing])
        await session.flush()

        runs = [
            (busy.id, two.id, "completed"),  # +3
            (busy.id, two.id, "completed"),  # a reprint shares the archive: +3
            (busy.id, two.id, "failed"),  # stopped early, layer unknown: initial load only, +1
            (busy.id, two.id, "skipped"),  # never ran: +0
            (busy.id, missing.id, "completed"),  # file is gone: unknown, +0
            (busy.id, None, "completed"),  # no archive at all: +0
            (other.id, painted.id, "completed"),  # +75
            (other.id, painted.id, "cancelled"),  # +1
        ]
        for printer_id, archive_id, status in runs:
            session.add(PrintLogEntry(printer_id=printer_id, archive_id=archive_id, status=status))

        task = MaintenanceType(name="Clean nozzle", default_interval_hours=100, interval_type="hours", is_system=True)
        session.add(task)
        await session.flush()
        assignment = PrinterMaintenance(printer_id=busy.id, maintenance_type_id=task.id, last_performed_hours=0)
        session.add(assignment)
        await session.flush()
        performed_at = datetime(2025, 1, 2, 3, 4, tzinfo=timezone.utc)
        session.add(MaintenanceHistory(printer_maintenance_id=assignment.id, performed_at=performed_at))
        session.add(
            MaintenanceLogEntry(printer_id=busy.id, entry_type="manual", title="Replaced", occurred_at=performed_at)
        )
        await session.commit()

    async with legacy_engine.begin() as conn:
        for table, column in (
            ("printers", "filament_change_count"),
            ("printer_maintenance", "last_performed_changes"),
            ("maintenance_history", "changes_at_maintenance"),
            ("maintenance_log_entries", "changes_at_maintenance"),
        ):
            await conn.execute(text(f"ALTER TABLE {table} DROP COLUMN {column}"))


async def _change_counts(engine) -> dict[str, int]:
    async with engine.connect() as conn:
        rows = (await conn.execute(text("SELECT serial_number, filament_change_count FROM printers"))).fetchall()
    return dict(rows)


@pytest.mark.asyncio
async def test_backfills_changes_from_the_archived_3mf_files(legacy_engine, base_dir):
    """Completed runs count every load; other runs the initial load; unknown runs nothing."""
    await _legacy_database(legacy_engine)

    async with legacy_engine.begin() as conn:
        await run_migrations(conn)

    assert await _change_counts(legacy_engine) == {"CH-BUSY": 3 + 3 + 1, "CH-OTHER": 75 + 1, "CH-IDLE": 0}


@pytest.mark.asyncio
async def test_new_snapshot_columns_default_sensibly_for_existing_rows(legacy_engine, base_dir):
    await _legacy_database(legacy_engine)

    async with legacy_engine.begin() as conn:
        await run_migrations(conn)

    async with legacy_engine.connect() as conn:
        assert (await conn.execute(text("SELECT last_performed_changes FROM printer_maintenance"))).scalar() == 0
        assert (await conn.execute(text("SELECT changes_at_maintenance FROM maintenance_history"))).scalar() == 0
        assert (await conn.execute(text("SELECT changes_at_maintenance FROM maintenance_log_entries"))).scalar() is None


@pytest.mark.asyncio
async def test_backfill_only_runs_when_the_column_is_first_added(legacy_engine, base_dir):
    """Later startups keep the live counter rather than recomputing it from archives."""
    await _legacy_database(legacy_engine)
    async with legacy_engine.begin() as conn:
        await run_migrations(conn)
    async with legacy_engine.begin() as conn:
        await conn.execute(text("UPDATE printers SET filament_change_count = 500 WHERE serial_number = 'CH-BUSY'"))
        await conn.execute(text("DELETE FROM print_log_entries"))

    async with legacy_engine.begin() as conn:
        await run_migrations(conn)

    assert (await _change_counts(legacy_engine))["CH-BUSY"] == 500


@pytest.mark.asyncio
async def test_unreadable_3mf_does_not_block_startup(legacy_engine, base_dir):
    """A corrupt archive file is skipped; the migration still completes for the rest."""
    await _legacy_database(legacy_engine)
    (base_dir / "archives" / "cylinder_2_changes.3mf").write_bytes(b"corrupt")

    async with legacy_engine.begin() as conn:
        await run_migrations(conn)

    assert await _change_counts(legacy_engine) == {"CH-BUSY": 0, "CH-OTHER": 75 + 1, "CH-IDLE": 0}

#!/usr/bin/env python3
"""Rebuild a Grove Control SQLite database while preserving compatible data.

This is a last-resort recovery tool for a legacy BambuBuddy-to-Grove Control
database whose schema is too inconsistent for normal migrations. It never
modifies the live database until it has built and verified a replacement next
to it, and it always writes a ``.backup`` copy first.

The application must be stopped. The tool builds a new database using the
current migrations, then restores durable compatible data while preserving
IDs. Queue and other explicitly transient state are reset. Known
BambuBuddy-only tables are exported beside the backup, and an unknown source
table stops the conversion rather than being silently discarded.

Docker usage (from the directory containing docker-compose.yml)::

    docker compose down
    docker compose run --rm --no-deps grove-control \
      python /app/scripts/rebuild_database.py --yes
    docker compose up -d
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import sqlite3
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))


# These tables hold the operator's identity, access, configuration, and core
# print data. Their row counts must survive exactly or the rebuilt database is
# discarded. The same row-count check also applies to every other copied table.
_CRITICAL_TABLES = {
    "printers",
    "users",
    "groups",
    "user_groups",
    "settings",
    "print_archives",
    "library_files",
    "filaments",
    "spool",
    "print_log_entries",
}

# A Grove conversion starts these tables clean. They are runtime state,
# histories, or short-lived security/notification records rather than the
# customer's printer, user, archive, library, or inventory configuration.
# ``print_log_entries`` is intentionally *not* listed: it is retained as requested.
_TRANSIENT_TABLES = {
    "active_print_spoolman",
    "ams_sensor_history",
    "auth_ephemeral_tokens",
    "auth_rate_limit_events",
    "notification_digest_queue",
    "notification_logs",
    "pending_uploads",
    "print_queue",
    "printer_sensor_history",
    "smart_plug_energy_snapshots",
}

# These tables exist in current BambuBuddy but have no Grove Control feature
# equivalent. They are exported to JSON and remain intact in the SQLite backup.
# Any *other* source-only table is treated as unknown and aborts the conversion.
_BAMBUDDY_EXPORT_TABLES = {
    "bug_reports",
    "pipeline_jobs",
    "pipeline_runs",
    "slicer_pipelines",
    "sponsor_toast_state",
}


@dataclass(frozen=True)
class CopyResult:
    copied_counts: dict[str, int]
    omitted_columns: dict[str, list[str]]
    reset_counts: dict[str, int]
    export_tables: set[str]


def _default_database_path() -> Path:
    data_dir = Path(os.environ.get("DATA_DIR", "/app/data"))
    current = data_dir / "bambuddy.db"
    legacy = data_dir / "bambutrack.db"
    return legacy if not current.exists() and legacy.exists() else current


def _timestamped_path(database: Path, suffix: str) -> Path:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return database.with_name(f"{database.name}.{timestamp}.{uuid.uuid4().hex[:8]}.{suffix}")


def _quote_identifier(identifier: str) -> str:
    """Quote a SQLite identifier obtained from sqlite_master / PRAGMA output."""
    return '"' + identifier.replace('"', '""') + '"'


def _verify_sqlite_database(database: Path) -> None:
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
        result = connection.execute("PRAGMA quick_check").fetchone()
    if result != ("ok",):
        raise RuntimeError(f"SQLite quick_check failed for {database}: {result}")


def _create_backup(database: Path, backup: Path) -> None:
    """Create a consistent backup, including any committed WAL frames."""
    source = sqlite3.connect(str(database))
    destination = sqlite3.connect(str(backup))
    try:
        source.backup(destination)
    finally:
        destination.close()
        source.close()


def _checkpoint(database: Path) -> None:
    """Flush WAL frames before an atomic replacement of the main database file."""
    with sqlite3.connect(str(database)) as connection:
        busy, _, _ = connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
    if busy:
        raise RuntimeError(f"Could not checkpoint {database}; ensure Grove Control is stopped")


def _regular_tables(connection: sqlite3.Connection) -> set[str]:
    rows = connection.execute(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    virtual_tables = {name for name, sql in rows if (sql or "").lstrip().upper().startswith("CREATE VIRTUAL TABLE")}
    return {
        name
        for name, sql in rows
        if name not in virtual_tables
        # FTS virtual tables have ordinary-looking shadow tables. They are
        # derived data and are rebuilt by the application triggers as the
        # source tables are copied, so never restore them directly.
        and not any(name.startswith(f"{virtual_table}_") for virtual_table in virtual_tables)
    }


def _table_columns(connection: sqlite3.Connection, table: str) -> list[str]:
    return [row[1] for row in connection.execute(f"PRAGMA table_info({_quote_identifier(table)})")]


async def _build_current_schema(staging: Path) -> None:
    """Run the normal current schema creation and migrations on an empty DB."""
    from backend.app.core import database as database_module
    from backend.app.core.config import settings

    settings.database_url = f"sqlite+aiosqlite:///{staging}"
    await database_module.reinitialize_database()
    try:
        await database_module.init_db()
    finally:
        await database_module.close_all_connections()


def _json_default(value: object) -> object:
    """Encode SQLite values JSON cannot represent without losing information."""
    if isinstance(value, bytes):
        return {"encoding": "base64", "data": base64.b64encode(value).decode("ascii")}
    raise TypeError(f"Cannot export value of type {type(value).__name__}")


def _export_source_tables(source_path: Path, tables: set[str], export_path: Path) -> Path | None:
    """Write known unsupported BambuBuddy tables to an atomic JSON sidecar."""
    if not tables:
        return None

    temporary_path = export_path.with_name(f".{export_path.name}.{uuid.uuid4().hex}.tmp")
    source = sqlite3.connect(str(source_path))
    source.row_factory = sqlite3.Row
    try:
        exported: dict[str, object] = {
            "format_version": 1,
            "source_database": source_path.name,
            "tables": {},
        }
        for table in sorted(tables):
            quoted_table = _quote_identifier(table)
            columns = _table_columns(source, table)
            rows = [dict(row) for row in source.execute(f"SELECT * FROM {quoted_table}")]
            exported["tables"][table] = {"columns": columns, "rows": rows}

        with temporary_path.open("w", encoding="utf-8") as export_file:
            json.dump(exported, export_file, default=_json_default, ensure_ascii=False, indent=2)
            export_file.write("\n")
        os.replace(temporary_path, export_path)
        return export_path
    finally:
        temporary_path.unlink(missing_ok=True)
        source.close()


def _copy_compatible_data(source_path: Path, destination_path: Path) -> CopyResult:
    """Restore durable shared tables and reset explicitly transient state."""
    source = sqlite3.connect(str(source_path))
    destination = sqlite3.connect(str(destination_path))
    source.row_factory = sqlite3.Row
    copied_counts: dict[str, int] = {}
    omitted_columns: dict[str, list[str]] = {}
    reset_counts: dict[str, int] = {}
    try:
        source_tables = _regular_tables(source)
        destination_tables = _regular_tables(destination)
        unsupported = source_tables - destination_tables
        export_tables = unsupported & _BAMBUDDY_EXPORT_TABLES
        unknown_tables = unsupported - export_tables
        if unknown_tables:
            raise RuntimeError(
                "Current schema has no replacement for source table(s): " + ", ".join(sorted(unknown_tables))
            )
        tables_to_copy = source_tables - export_tables - _TRANSIENT_TABLES
        tables_to_reset = _TRANSIENT_TABLES & destination_tables

        destination.execute("PRAGMA foreign_keys = OFF")
        try:
            destination.execute("BEGIN")
            for table in sorted(tables_to_reset):
                if table in source_tables:
                    reset_counts[table] = source.execute(f"SELECT COUNT(*) FROM {_quote_identifier(table)}").fetchone()[
                        0
                    ]
                destination.execute(f"DELETE FROM {_quote_identifier(table)}")

            for table in sorted(tables_to_copy):
                source_columns = _table_columns(source, table)
                destination_columns = _table_columns(destination, table)
                common_columns = [column for column in destination_columns if column in source_columns]
                missing_from_destination = sorted(set(source_columns) - set(destination_columns))
                if missing_from_destination:
                    omitted_columns[table] = missing_from_destination
                if not common_columns:
                    raise RuntimeError(f"No compatible columns available to restore table {table}")

                quoted_table = _quote_identifier(table)
                column_list = ", ".join(_quote_identifier(column) for column in common_columns)
                placeholders = ", ".join("?" for _ in common_columns)
                destination.execute(f"DELETE FROM {quoted_table}")
                cursor = source.execute(f"SELECT {column_list} FROM {quoted_table}")
                row_count = 0
                while rows := cursor.fetchmany(500):
                    destination.executemany(
                        f"INSERT INTO {quoted_table} ({column_list}) VALUES ({placeholders})",
                        [tuple(row[column] for column in common_columns) for row in rows],
                    )
                    row_count += len(rows)
                copied_counts[table] = row_count
            destination.commit()
        except Exception:
            destination.rollback()
            raise
        finally:
            destination.execute("PRAGMA foreign_keys = ON")

        for table, expected_count in copied_counts.items():
            actual_count = destination.execute(f"SELECT COUNT(*) FROM {_quote_identifier(table)}").fetchone()[0]
            if actual_count != expected_count:
                raise RuntimeError(
                    f"Row-count mismatch for {table}: copied {expected_count}, rebuilt database has {actual_count}"
                )
        # Very old BambuBuddy databases can predate some of these tables. A
        # current table that existed in the source must be restored exactly;
        # a genuinely absent legacy table will be created empty by the new
        # schema instead of making this recovery path unusable.
        missing_critical = (_CRITICAL_TABLES & source_tables) - set(copied_counts)
        if missing_critical:
            raise RuntimeError("Critical table(s) were not restored: " + ", ".join(sorted(missing_critical)))

        foreign_key_errors = destination.execute("PRAGMA foreign_key_check").fetchmany(10)
        if foreign_key_errors:
            raise RuntimeError(f"Foreign-key verification failed (first rows): {foreign_key_errors!r}")
    finally:
        destination.close()
        source.close()
    return CopyResult(copied_counts, omitted_columns, reset_counts, export_tables)


def _remove_wal_sidecars(database: Path) -> None:
    for suffix in ("-wal", "-shm"):
        database.with_name(database.name + suffix).unlink(missing_ok=True)


async def rebuild(database: Path) -> tuple[Path, Path | None, CopyResult]:
    """Build, verify, and atomically install a replacement database."""
    backup = _timestamped_path(database, "backup")
    staging = _timestamped_path(database, "rebuild")
    export_path = _timestamped_path(database, "bambuddy-unsupported.json")
    _create_backup(database, backup)
    _verify_sqlite_database(backup)
    _checkpoint(database)

    try:
        await _build_current_schema(staging)
        copy_result = _copy_compatible_data(database, staging)
        exported_path = _export_source_tables(database, copy_result.export_tables, export_path)
        _checkpoint(staging)
        _verify_sqlite_database(staging)
        _remove_wal_sidecars(database)
        os.replace(staging, database)
        _verify_sqlite_database(database)
        return backup, exported_path, copy_result
    except Exception:
        staging.unlink(missing_ok=True)
        _remove_wal_sidecars(staging)
        export_path.unlink(missing_ok=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Rebuild a SQLite Grove Control database while preserving compatible data."
    )
    parser.add_argument("--database", type=Path, default=_default_database_path(), help="SQLite database path")
    parser.add_argument("--yes", action="store_true", help="Confirm the database rebuild after a verified backup")
    args = parser.parse_args()

    database = args.database.expanduser().resolve()
    if not database.is_file():
        parser.error(f"SQLite database does not exist: {database}")
    _verify_sqlite_database(database)

    print(f"Database: {database}")
    print("The Grove Control service must be stopped before continuing.")
    print("A verified .backup copy is created before the live database is replaced.")
    print("Queued and other transient runtime state is reset; print logs are retained.")
    if not args.yes:
        print("No changes made. Re-run with --yes after stopping the service.")
        return 2

    backup, exported_path, copy_result = asyncio.run(rebuild(database))
    print(f"Created verified backup: {backup}")
    if exported_path:
        print(f"Exported BambuBuddy-only tables: {exported_path}")
    print(
        "Rebuilt database successfully; restored "
        f"{sum(copy_result.copied_counts.values())} rows across {len(copy_result.copied_counts)} tables."
    )
    if copy_result.reset_counts:
        print("Reset transient rows:")
        for table, count in sorted(copy_result.reset_counts.items()):
            print(f"  {table}: {count}")
    if copy_result.omitted_columns:
        print("Legacy-only columns not present in the current schema were not copied:")
        for table, columns in sorted(copy_result.omitted_columns.items()):
            print(f"  {table}: {', '.join(columns)}")
    print("You can now start Grove Control again.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

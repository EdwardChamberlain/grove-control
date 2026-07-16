#!/usr/bin/env python3
"""Rebuild a Grove Control SQLite database while preserving compatible data.

This is a last-resort recovery tool for a legacy BambuBuddy-to-Grove Control
database whose schema is too inconsistent for normal migrations. It never
modifies the live database until it has built and verified a replacement next
to it, and it always writes a ``.backup`` copy first.

The application must be stopped. The tool builds a new database using the
current migrations, then copies every compatible non-virtual table while
preserving IDs. It refuses to replace the original if a source table cannot be
represented in the current schema, if row counts differ, or if foreign-key
checks fail.

Docker usage (from the directory containing docker-compose.yml)::

    docker compose down
    docker compose run --rm --no-deps grove-control \
      python /app/scripts/rebuild_database.py --yes
    docker compose up -d
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sqlite3
import sys
import uuid
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
}


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


def _copy_compatible_data(source_path: Path, destination_path: Path) -> tuple[dict[str, int], dict[str, list[str]]]:
    """Copy every current table by its shared columns, retaining primary keys."""
    source = sqlite3.connect(str(source_path))
    destination = sqlite3.connect(str(destination_path))
    source.row_factory = sqlite3.Row
    copied_counts: dict[str, int] = {}
    omitted_columns: dict[str, list[str]] = {}
    try:
        source_tables = _regular_tables(source)
        destination_tables = _regular_tables(destination)
        unsupported = source_tables - destination_tables
        if unsupported:
            raise RuntimeError(
                "Current schema has no replacement for source table(s): " + ", ".join(sorted(unsupported))
            )

        destination.execute("PRAGMA foreign_keys = OFF")
        try:
            destination.execute("BEGIN")
            for table in sorted(source_tables):
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
    return copied_counts, omitted_columns


def _remove_wal_sidecars(database: Path) -> None:
    for suffix in ("-wal", "-shm"):
        database.with_name(database.name + suffix).unlink(missing_ok=True)


async def rebuild(database: Path) -> tuple[Path, dict[str, int], dict[str, list[str]]]:
    """Build, verify, and atomically install a replacement database."""
    backup = _timestamped_path(database, "backup")
    staging = _timestamped_path(database, "rebuild")
    _create_backup(database, backup)
    _verify_sqlite_database(backup)
    _checkpoint(database)

    try:
        await _build_current_schema(staging)
        copied_counts, omitted_columns = _copy_compatible_data(database, staging)
        _checkpoint(staging)
        _verify_sqlite_database(staging)
        _remove_wal_sidecars(database)
        os.replace(staging, database)
        _verify_sqlite_database(database)
        return backup, copied_counts, omitted_columns
    except Exception:
        staging.unlink(missing_ok=True)
        _remove_wal_sidecars(staging)
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
    if not args.yes:
        print("No changes made. Re-run with --yes after stopping the service.")
        return 2

    backup, copied_counts, omitted_columns = asyncio.run(rebuild(database))
    print(f"Created verified backup: {backup}")
    print(
        f"Rebuilt database successfully; restored {sum(copied_counts.values())} rows across {len(copied_counts)} tables."
    )
    if omitted_columns:
        print("Legacy-only columns not present in the current schema were not copied:")
        for table, columns in sorted(omitted_columns.items()):
            print(f"  {table}: {', '.join(columns)}")
    print("You can now start Grove Control again.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

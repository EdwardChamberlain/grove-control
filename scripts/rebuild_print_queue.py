#!/usr/bin/env python3
"""Hard-reset a legacy SQLite ``print_queue`` table.

Use this only when queue submissions fail because an older BambuBuddy database
was not fully migrated to Grove Control.  The script deletes queued jobs, but
does not touch printers, archives, library files, or print history.

It always creates a consistent SQLite backup before dropping the table.

Docker usage (run from the directory containing docker-compose.yml)::

    docker compose down
    docker compose run --rm --no-deps grove-control \
      python /app/scripts/rebuild_print_queue.py --yes
    docker compose up -d
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from sqlalchemy import create_engine, inspect  # noqa: E402
from sqlalchemy.engine import URL  # noqa: E402

from backend.app.models.print_queue import PrintQueueItem  # noqa: E402


def _default_database_path() -> Path:
    data_dir = Path(os.environ.get("DATA_DIR", "/app/data"))
    current = data_dir / "bambuddy.db"
    legacy = data_dir / "bambutrack.db"
    return legacy if not current.exists() and legacy.exists() else current


def _backup_path(database: Path) -> Path:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return database.with_name(f"{database.name}.{timestamp}.backup")


def _create_backup(database: Path, backup: Path) -> None:
    """Make a transactionally consistent SQLite backup, including WAL data."""
    source = sqlite3.connect(str(database))
    destination = sqlite3.connect(str(backup))
    try:
        source.backup(destination)
    finally:
        destination.close()
        source.close()


def _verify_sqlite_database(database: Path) -> None:
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
        result = connection.execute("PRAGMA quick_check").fetchone()
    if result != ("ok",):
        raise RuntimeError(f"SQLite quick_check failed for {database}: {result}")


def _rebuild_queue_table(database: Path) -> set[str]:
    """Drop only print_queue, then recreate it from the current ORM schema."""
    engine = create_engine(URL.create("sqlite", database=str(database)))
    try:
        with engine.begin() as connection:
            inspector = inspect(connection)
            if not inspector.has_table("print_queue"):
                raise RuntimeError(f"No print_queue table exists in {database}")

            PrintQueueItem.__table__.drop(connection, checkfirst=False)
            PrintQueueItem.__table__.create(connection, checkfirst=False)

            columns = {column["name"] for column in inspect(connection).get_columns("print_queue")}
            expected = {column.name for column in PrintQueueItem.__table__.columns}
            missing = expected - columns
            if missing:
                raise RuntimeError(f"Rebuilt print_queue is missing columns: {', '.join(sorted(missing))}")
            return columns
    finally:
        engine.dispose()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Back up and hard-reset the SQLite print_queue table after a failed legacy migration."
    )
    parser.add_argument(
        "--database",
        type=Path,
        default=_default_database_path(),
        help="SQLite database path (default: $DATA_DIR/bambuddy.db)",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Confirm deletion of all existing queue items after the backup succeeds",
    )
    args = parser.parse_args()

    database = args.database.expanduser().resolve()
    if not database.is_file():
        parser.error(f"SQLite database does not exist: {database}")

    _verify_sqlite_database(database)
    backup = _backup_path(database)

    print(f"Database: {database}")
    print(f"Backup:   {backup}")
    print("This deletes every queued job from print_queue. Other application data is unchanged.")
    print("The Grove Control service must be stopped before continuing.")
    if not args.yes:
        print("No changes made. Re-run with --yes after stopping the service.")
        return 2

    _create_backup(database, backup)
    _verify_sqlite_database(backup)
    print(f"Created verified backup: {backup}")

    columns = _rebuild_queue_table(database)
    _verify_sqlite_database(database)
    print(f"Rebuilt print_queue successfully with {len(columns)} columns.")
    print("You can now start Grove Control again.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

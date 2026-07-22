"""Regression coverage for the full SQLite recovery script."""

import json
import sqlite3

import pytest

from scripts.rebuild_database import _CRITICAL_TABLES, _copy_compatible_data, _export_source_tables


def _create_database(path, *, include_legacy_column: bool, include_fts_row: bool, source: bool) -> None:
    with sqlite3.connect(path) as connection:
        for table in _CRITICAL_TABLES:
            legacy_column = ", legacy_value TEXT" if include_legacy_column and table == "printers" else ""
            connection.execute(f'CREATE TABLE "{table}" (id INTEGER PRIMARY KEY, value TEXT{legacy_column})')
            if table == "printers":
                columns = "id, value, legacy_value" if include_legacy_column else "id, value"
                placeholders = "?, ?, ?" if include_legacy_column else "?, ?"
                values = (42, "preserved", "old-only") if include_legacy_column else (42, "preserved")
                connection.execute(f'INSERT INTO "{table}" ({columns}) VALUES ({placeholders})', values)
            else:
                connection.execute(f'INSERT INTO "{table}" (id, value) VALUES (1, ?)', (table,))

        connection.execute('CREATE TABLE "print_queue" (id INTEGER PRIMARY KEY, value TEXT)')
        connection.execute('INSERT INTO "print_queue" (id, value) VALUES (1, "reset")')
        if source:
            connection.execute('CREATE TABLE "pipeline_runs" (id INTEGER PRIMARY KEY, name TEXT)')
            connection.execute('INSERT INTO "pipeline_runs" (id, name) VALUES (7, "legacy pipeline")')

        # This is derived search-index state rather than source data. The
        # script must let current application triggers recreate it instead of
        # copying its FTS shadow tables directly.
        connection.execute("CREATE VIRTUAL TABLE archive_fts USING fts5(value)")
        if include_fts_row:
            connection.execute("INSERT INTO archive_fts (value) VALUES ('derived index row')")


def test_copy_compatible_data_preserves_rows_and_omits_legacy_only_columns(tmp_path):
    source = tmp_path / "legacy.db"
    destination = tmp_path / "rebuilt.db"
    _create_database(source, include_legacy_column=True, include_fts_row=True, source=True)
    _create_database(destination, include_legacy_column=False, include_fts_row=False, source=False)

    result = _copy_compatible_data(source, destination)

    assert result.copied_counts == dict.fromkeys(_CRITICAL_TABLES, 1)
    assert result.omitted_columns == {"printers": ["legacy_value"]}
    assert result.reset_counts == {"print_queue": 1}
    assert result.export_tables == {"pipeline_runs"}
    with sqlite3.connect(destination) as connection:
        assert connection.execute('SELECT id, value FROM "printers"').fetchone() == (42, "preserved")
        assert connection.execute('SELECT COUNT(*) FROM "print_log_entries"').fetchone() == (1,)
        assert connection.execute('SELECT COUNT(*) FROM "print_queue"').fetchone() == (0,)
        assert connection.execute("SELECT COUNT(*) FROM archive_fts").fetchone() == (0,)


def test_export_source_tables_preserves_bambuddy_only_data(tmp_path):
    source = tmp_path / "legacy.db"
    destination = tmp_path / "rebuilt.db"
    export = tmp_path / "unsupported.json"
    _create_database(source, include_legacy_column=False, include_fts_row=False, source=True)
    _create_database(destination, include_legacy_column=False, include_fts_row=False, source=False)

    result = _copy_compatible_data(source, destination)
    exported = _export_source_tables(source, result.export_tables, export)

    assert exported == export
    assert json.loads(export.read_text())["tables"]["pipeline_runs"]["rows"] == [{"id": 7, "name": "legacy pipeline"}]


def test_copy_compatible_data_rejects_unknown_source_tables(tmp_path):
    source = tmp_path / "legacy.db"
    destination = tmp_path / "rebuilt.db"
    _create_database(source, include_legacy_column=False, include_fts_row=False, source=False)
    _create_database(destination, include_legacy_column=False, include_fts_row=False, source=False)
    with sqlite3.connect(source) as connection:
        connection.execute('CREATE TABLE "future_bambuddy_data" (id INTEGER PRIMARY KEY)')

    with pytest.raises(RuntimeError, match="future_bambuddy_data"):
        _copy_compatible_data(source, destination)

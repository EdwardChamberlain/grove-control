"""Regression coverage for the full SQLite recovery script."""

import json
import sqlite3

import pytest

from scripts.rebuild_database import _CRITICAL_TABLES, _copy_compatible_data, _export_source_tables


def _create_database(path, *, include_legacy_column: bool, include_fts_row: bool, source: bool) -> None:
    with sqlite3.connect(path) as connection:
        for table in _CRITICAL_TABLES:
            legacy_column = ", legacy_value TEXT" if include_legacy_column and table == "printers" else ""
            if table == "print_log_entries":
                connection.execute(
                    'CREATE TABLE "print_log_entries" ('
                    "id INTEGER PRIMARY KEY, value TEXT, created_by_id INTEGER, "
                    'FOREIGN KEY (created_by_id) REFERENCES "users" (id) ON DELETE SET NULL)'
                )
                connection.execute(
                    'INSERT INTO "print_log_entries" (id, value, created_by_id) VALUES (1, ?, ?)',
                    (table, 999 if source else None),
                )
                continue

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
        connection.execute(
            'CREATE TABLE "orphan_children" ('
            "id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, "
            'FOREIGN KEY (user_id) REFERENCES "users" (id) ON DELETE CASCADE)'
        )
        connection.execute(
            'INSERT INTO "orphan_children" (id, user_id) VALUES (1, ?)',
            (999 if source else 1,),
        )
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

    expected_counts = dict.fromkeys(_CRITICAL_TABLES, 1)
    expected_counts["orphan_children"] = 1
    assert result.copied_counts == expected_counts
    assert result.omitted_columns == {"printers": ["legacy_value"]}
    assert result.reset_counts == {"print_queue": 1}
    assert result.export_tables == {"pipeline_runs"}
    assert result.nullified_foreign_keys == {"print_log_entries.created_by_id": 1}
    assert result.deleted_orphan_rows == {"orphan_children": 1}
    with sqlite3.connect(destination) as connection:
        assert connection.execute('SELECT id, value FROM "printers"').fetchone() == (42, "preserved")
        assert connection.execute('SELECT id, created_by_id FROM "print_log_entries"').fetchone() == (1, None)
        assert connection.execute('SELECT COUNT(*) FROM "orphan_children"').fetchone() == (0,)
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


def test_copy_compatible_data_rejects_unsafe_orphan_relationships(tmp_path):
    source = tmp_path / "legacy.db"
    destination = tmp_path / "rebuilt.db"
    _create_database(source, include_legacy_column=False, include_fts_row=False, source=False)
    _create_database(destination, include_legacy_column=False, include_fts_row=False, source=False)
    for path, user_id in ((source, 999), (destination, 1)):
        with sqlite3.connect(path) as connection:
            connection.execute(
                'CREATE TABLE "unsafe_orphans" ('
                "id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, "
                'FOREIGN KEY (user_id) REFERENCES "users" (id))'
            )
            connection.execute('INSERT INTO "unsafe_orphans" (id, user_id) VALUES (1, ?)', (user_id,))

    with pytest.raises(RuntimeError, match="safe orphan repair.*unsafe_orphans"):
        _copy_compatible_data(source, destination)

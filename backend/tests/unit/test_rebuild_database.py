"""Regression coverage for the full SQLite recovery script."""

import sqlite3

from scripts.rebuild_database import _CRITICAL_TABLES, _copy_compatible_data


def _create_database(path, *, include_legacy_column: bool, include_fts_row: bool) -> None:
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

        # This is derived search-index state rather than source data. The
        # script must let current application triggers recreate it instead of
        # copying its FTS shadow tables directly.
        connection.execute("CREATE VIRTUAL TABLE archive_fts USING fts5(value)")
        if include_fts_row:
            connection.execute("INSERT INTO archive_fts (value) VALUES ('derived index row')")


def test_copy_compatible_data_preserves_rows_and_omits_legacy_only_columns(tmp_path):
    source = tmp_path / "legacy.db"
    destination = tmp_path / "rebuilt.db"
    _create_database(source, include_legacy_column=True, include_fts_row=True)
    _create_database(destination, include_legacy_column=False, include_fts_row=False)

    copied_counts, omitted_columns = _copy_compatible_data(source, destination)

    assert copied_counts == dict.fromkeys(_CRITICAL_TABLES, 1)
    assert omitted_columns == {"printers": ["legacy_value"]}
    with sqlite3.connect(destination) as connection:
        assert connection.execute('SELECT id, value FROM "printers"').fetchone() == (42, "preserved")
        assert connection.execute("SELECT COUNT(*) FROM archive_fts").fetchone() == (0,)

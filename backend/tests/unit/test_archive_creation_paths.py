"""Archive is a record of prints: only print lifecycle code may create entries (#232).

If this fails you are adding a new way to put something into Archive. Archive
entries must come from a print starting (printer-reported or queue dispatch),
not from a user-supplied file. Save user files to Files (``/library/files``)
or add them to the Queue instead.
"""

import ast
from pathlib import Path

import pytest

APP_DIR = Path(__file__).resolve().parents[2] / "app"

# Files allowed to create Archive entries.
ALLOWED = {
    "api/routes/pending_uploads.py",  # virtual printer; goes away with the VP upload route
    "main.py",  # printer-reported print start (incl. fallback entry)
    "services/archive.py",  # ArchiveService.archive_print
    "services/print_scheduler.py",  # queue dispatch
    "services/virtual_printer/manager.py",  # virtual printer; goes away with the VP upload route
}


def _creates_archive(source: str) -> bool:
    """True if the source calls ``archive_print``, constructs ``PrintArchive``,
    or hands ``PrintArchive`` to a bulk insert helper."""
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", None)
        if name in ("archive_print", "PrintArchive"):
            return True
        if name in ("insert", "bulk_insert_mappings", "add_all"):
            if any(isinstance(a, ast.Name) and a.id == "PrintArchive" for a in node.args):
                return True
    return False


def _creators() -> set[str]:
    return {
        path.relative_to(APP_DIR).as_posix() for path in APP_DIR.rglob("*.py") if _creates_archive(path.read_text())
    }


def test_only_print_lifecycle_code_creates_archives():
    assert _creators() <= ALLOWED


def test_allowlist_has_no_stale_entries():
    """A file that no longer creates archives should leave the allowlist."""
    assert _creators() >= ALLOWED


class TestScanner:
    @pytest.mark.parametrize(
        "source",
        [
            "await service.archive_print(printer_id=1, source_file=p)",
            "archive_print(printer_id=1)",
            "db.add(PrintArchive(filename='x'))",
            "await db.execute(insert(PrintArchive).values(filename='x'))",
            "session.bulk_insert_mappings(PrintArchive, rows)",
        ],
    )
    def test_flags_archive_creation(self, source):
        assert _creates_archive(source)

    @pytest.mark.parametrize(
        "source",
        [
            "# service.archive_print(printer_id=1)",
            "msg = 'PrintArchive( is mentioned in a string'",
            "await db.execute(select(PrintArchive).where(PrintArchive.id == 1))",
            "db.delete(archive)",
            "await db.execute(insert(LibraryFile).values(filename='x'))",
        ],
    )
    def test_ignores_reads_and_unrelated_code(self, source):
        assert not _creates_archive(source)

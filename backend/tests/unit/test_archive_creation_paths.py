"""Archive is a record of prints: only print lifecycle code may create entries (#232).

If this fails you are adding a new way to put something into Archive. Archive
entries must come from a print starting (printer-reported or queue dispatch),
not from a user-supplied file. Save user files to Files (``/library/files``)
or add them to the Queue instead.
"""

import ast
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2] / "app"

# Files allowed to create Archive entries.
ALLOWED = {
    "api/routes/pending_uploads.py",  # virtual printer; goes away with the VP upload route
    "main.py",  # printer-reported print start (incl. fallback entry)
    "models/archive.py",  # the model itself
    "services/archive.py",  # ArchiveService.archive_print
    "services/print_scheduler.py",  # queue dispatch
    "services/virtual_printer/manager.py",  # virtual printer; goes away with the VP upload route
}


def _creators() -> set[str]:
    found = set()
    for path in APP_DIR.rglob("*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", None)
            if name in ("archive_print", "PrintArchive"):
                found.add(path.relative_to(APP_DIR).as_posix())
    return found


def test_only_print_lifecycle_code_creates_archives():
    assert _creators() <= ALLOWED

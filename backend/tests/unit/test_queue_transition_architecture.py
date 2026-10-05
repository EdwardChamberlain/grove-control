"""Keep queue status writes centralized as the codebase grows."""

import ast
import inspect
import re
from pathlib import Path
from typing import get_args

from backend.app.schemas.print_queue import PrintQueueItemResponse
from backend.app.services.lifecycle.engine import ALLOWED_TRANSITIONS, transition_queue_item

APP_DIR = Path(__file__).parents[2] / "app"
# Only the module that defines the writer is exempt, wherever it lives.
WRITER = Path(inspect.getsourcefile(transition_queue_item)).resolve()


def test_table_covers_every_api_status():
    api_statuses = set(get_args(PrintQueueItemResponse.model_fields["status"].annotation))
    assert api_statuses <= ALLOWED_TRANSITIONS.keys()
    for targets in ALLOWED_TRANSITIONS.values():
        assert targets <= api_statuses


def _queue_targets(tree: ast.AST) -> set[str]:
    """The queue model, its table, and local names bound to the table (assignment, unpacking, walrus)."""
    names = {"PrintQueueItem", "PrintQueueItem.__table__"}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            bindings = []
            for target in node.targets:
                unpacked = isinstance(target, ast.Tuple) and isinstance(node.value, ast.Tuple)
                bindings += zip(target.elts, node.value.elts, strict=False) if unpacked else [(target, node.value)]
        elif isinstance(node, ast.AnnAssign | ast.NamedExpr) and node.value is not None:
            bindings = [(node.target, node.value)]
        else:
            continue
        names.update(
            name.id
            for name, value in bindings
            if isinstance(name, ast.Name) and ast.unparse(value) == "PrintQueueItem.__table__"
        )
    return names


def _update_functions(tree: ast.AST) -> set[str]:
    """``update`` and any local alias of SQLAlchemy's ``update``."""
    return {"update"} | {
        alias.asname
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and (node.module or "").startswith("sqlalchemy")
        for alias in node.names
        if alias.name == "update" and alias.asname
    }


def _builds_status_update_of_queue_items(call: ast.Call, targets: set[str], updates: set[str]) -> bool:
    """True for ``update(PrintQueueItem or its table)…values(status=…)`` or ``<table>.update()…``."""
    if not (isinstance(call.func, ast.Attribute) and call.func.attr == "values"):
        return False
    if not any(keyword.arg == "status" for keyword in call.keywords):
        return False
    node = call.func.value
    while isinstance(node, ast.Call | ast.Attribute):
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id in updates:
                return bool(node.args) and ast.unparse(node.args[0]) in targets
            if isinstance(node.func, ast.Attribute) and node.func.attr == "update":
                if ast.unparse(node.func.value) in targets - {"PrintQueueItem"}:
                    return True
            node = node.func
        else:
            node = node.value
    return False


def _status_updates(path: Path) -> list[int]:
    tree = ast.parse(path.read_text(), filename=str(path))
    targets, updates = _queue_targets(tree), _update_functions(tree)
    return [
        node.lineno
        for node in ast.walk(tree)
        if (
            isinstance(node, ast.Constant)
            and isinstance(node.value, str)
            and re.search(r"\bUPDATE\s+print_queue\s+SET\s+[^;]*?\bstatus\s*=", node.value, re.I | re.S)
        )
        or (isinstance(node, ast.Call) and _builds_status_update_of_queue_items(node, targets, updates))
    ]


def test_no_other_module_updates_queue_status():
    offenders = [
        f"{path.relative_to(APP_DIR)}:{line}"
        for path in APP_DIR.rglob("*.py")
        if path.resolve() != WRITER
        for line in _status_updates(path)
    ]
    assert offenders == [], "Change queue status through transition_queue_item(): " + ", ".join(offenders)


def test_guard_recognizes_the_writers_own_status_update():
    # Otherwise the exemption would hide nothing and the guard could miss this form elsewhere.
    assert _status_updates(WRITER)

"""Keep queue status writes centralized as the codebase grows."""

import ast
import re
from pathlib import Path
from typing import get_args

from backend.app.schemas.print_queue import PrintQueueItemResponse
from backend.app.services.queue_transitions import ALLOWED_TRANSITIONS

APP_DIR = Path(__file__).parents[2] / "app"


def test_table_covers_every_api_status():
    api_statuses = set(get_args(PrintQueueItemResponse.model_fields["status"].annotation))
    assert api_statuses <= ALLOWED_TRANSITIONS.keys()
    for targets in ALLOWED_TRANSITIONS.values():
        assert targets <= api_statuses


def _builds_status_update_of_queue_items(call: ast.Call) -> bool:
    """True for ``update(PrintQueueItem)…values(status=…)`` or the ``__table__`` form."""
    if not (isinstance(call.func, ast.Attribute) and call.func.attr == "values"):
        return False
    if not any(keyword.arg == "status" for keyword in call.keywords):
        return False
    node = call.func.value
    while isinstance(node, ast.Call | ast.Attribute):
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id == "update":
                return bool(node.args) and ast.unparse(node.args[0]) == "PrintQueueItem"
            if isinstance(node.func, ast.Attribute) and ast.unparse(node.func) == "PrintQueueItem.__table__.update":
                return True
            node = node.func
        else:
            node = node.value
    return False


def test_no_other_module_updates_queue_status():
    offenders = []
    for path in APP_DIR.rglob("*.py"):
        if path.name == "queue_transitions.py":
            continue
        for node in ast.walk(ast.parse(path.read_text(), filename=str(path))):
            raw_status_update = (
                isinstance(node, ast.Constant)
                and isinstance(node.value, str)
                and re.search(r"\bUPDATE\s+print_queue\s+SET\s+[^;]*?\bstatus\s*=", node.value, re.I | re.S)
            )
            if raw_status_update or (isinstance(node, ast.Call) and _builds_status_update_of_queue_items(node)):
                offenders.append(f"{path.relative_to(APP_DIR)}:{node.lineno}")
    assert offenders == [], "Change queue status through transition_queue_item(): " + ", ".join(offenders)

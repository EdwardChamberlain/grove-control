"""Regression test for the print-queue path of the #1397 force-timelapse fix.

The first round of #1397 only wired the override into ``background_dispatch.py``,
which covers Print Now / Reprint Now flows. The print *queue* uses a separate
scheduler at ``print_scheduler.py:_start_print`` that calls
``printer_manager.start_print`` directly — and the first attempt skipped that
call site, so queued prints' timelapse setting passed through unchanged and
the finish-photo path had nothing to draw from. Field-test caught this when
Martin queued two prints (H2D + X1C); neither got a forced timelapse and
``archive.bambuddy_forced_timelapse`` stayed False on both.

This test pins the wiring at the source level: the helper is imported AND
its return value is what ``start_print(timelapse=...)`` receives. We can't
exercise the full ``_start_print`` method without standing up a real DB +
printer_manager + ams_assignment fixture stack, but the structural assert
is enough to catch regression at the dispatch hook.
"""

import ast
from pathlib import Path

SCHEDULER_PATH = Path(__file__).resolve().parent.parent.parent / "app" / "services" / "print_scheduler.py"


def _find_call_to_start_print(tree: ast.AST) -> ast.Call:
    """Walk the AST and return the printer_manager.start_print(...) Call node
    inside _start_print. Should be exactly one."""
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not isinstance(func, ast.Attribute):
            continue
        if func.attr != "start_print":
            continue
        value = func.value
        if not isinstance(value, ast.Name) or value.id != "printer_manager":
            continue
        return node
    raise AssertionError("Could not find printer_manager.start_print(...) call in print_scheduler.py")


def test_start_print_timelapse_kwarg_uses_resolved_value():
    """``timelapse=`` kwarg passed to start_print must reference
    ``effective_timelapse`` (the resolved value) — not ``item.timelapse``
    (the user's raw choice). If a refactor drops the resolver call and
    restores ``item.timelapse``, this test fails."""
    source = SCHEDULER_PATH.read_text()
    tree = ast.parse(source)

    call = _find_call_to_start_print(tree)
    timelapse_kw = next((kw for kw in call.keywords if kw.arg == "timelapse"), None)
    assert timelapse_kw is not None, "start_print(timelapse=...) kwarg is missing"

    # The value must be the resolved variable, not item.timelapse.
    value = timelapse_kw.value
    assert isinstance(value, ast.Name) and value.id == "effective_timelapse", (
        f"timelapse= must be the resolver's return value (effective_timelapse), "
        f"got {ast.dump(value)}. The queue path must apply the same #1397 "
        f"override as background_dispatch.py — otherwise queued prints' "
        f"finish-photo extractor has nothing to pull from."
    )


def test_scheduler_imports_resolve_effective_timelapse():
    """The import must exist somewhere in print_scheduler.py — guards against
    a future refactor removing it and falling back to item.timelapse."""
    source = SCHEDULER_PATH.read_text()
    assert "from backend.app.services.background_dispatch import resolve_effective_timelapse" in source, (
        "print_scheduler.py must import resolve_effective_timelapse from background_dispatch"
    )

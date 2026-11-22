"""Which waiting reasons need a person to act, and which clear by themselves."""

import pytest

from backend.app.services.queue_waiting import (
    BUSY_PREFIX,
    DRYING_STOP_FAILED_MESSAGE,
    PRINTER_RESERVATION_PREFIX,
    STOPPING_DRYING_MESSAGE,
    UPLOAD_POOL_WAITING_PREFIX,
    WAITING_FOR_DRYING_MESSAGE,
    waiting_reason_needs_action,
)


@pytest.mark.parametrize("reason", [None, ""])
def test_no_reason_needs_no_action(reason):
    assert waiting_reason_needs_action(reason) is False


@pytest.mark.parametrize(
    "reason",
    [
        f"{PRINTER_RESERVATION_PREFIX} on P1S - 2",
        f"{UPLOAD_POOL_WAITING_PREFIX} (1 of 1 in use)",
        WAITING_FOR_DRYING_MESSAGE,
        STOPPING_DRYING_MESSAGE,
        # Contains the "; " that separates clauses of a cross-model reason.
        DRYING_STOP_FAILED_MESSAGE,
        f"{BUSY_PREFIX} P1S - 1, P1S - 2",
        f"{BUSY_PREFIX} P1S - 1 | {BUSY_PREFIX} X1C",
        # Every candidate busy, labelled with its model.
        f"H2S: {BUSY_PREFIX} Bay 1; H2C: {BUSY_PREFIX} Bay 2",
    ],
)
def test_self_resolving_waits_need_no_action(reason):
    assert waiting_reason_needs_action(reason) is False


@pytest.mark.parametrize(
    "reason",
    [
        "No matching material. Waiting on PETG",
        "No matching material/colour. Waiting on Black",
        "Waiting for filament: P1S (needs PLA)",
        "Waiting for filament: P1S (needs PLA); X1C (needs PETG)",
        "Material/colour metadata unavailable; cannot verify a safe filament match",
        "Incompatible sliced file: sliced for X1C, printer is P1S",
        "Waiting on door sensor interlock",
        "Offline: P1S - 1",
        "No available P1S printers",
        # A busy printer does not hide a clause that still needs attention.
        f"Waiting for filament: P1S (needs PLA) | {BUSY_PREFIX} X1C",
        f"{BUSY_PREFIX} Bay 1 | Offline: Bay 2",
        f"H2S: {BUSY_PREFIX} Bay 1; H2C: No matching material. Waiting on PETG",
        # Unknown text is treated as needing attention rather than hidden.
        "Something the scheduler has not said before",
    ],
)
def test_reasons_needing_a_person_are_flagged(reason):
    assert waiting_reason_needs_action(reason) is True

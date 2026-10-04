"""Transition table, guards and conditional write; public entry is the engine."""

from contextlib import nullcontext

from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from backend.app.models.print_queue import (
    ACTIVE_STATUSES,
    AWAITING_PLATE_CLEAR_STATUSES,
    HOLDING_STATUSES as HOLDING_STATUSES,
)

FINAL_STATUSES = ("successful", "unsuccessful")
ARCHIVE_OUTCOMES = {"finished": "completed", "failed": "failed", "cancelled": "aborted"}


def physical_failure_reason(outcome: str, error_message: str | None, override: str | None = None) -> str | None:
    if outcome == "failed":
        return (override or error_message or "Print failed")[:100]
    return "User cancelled" if outcome == "aborted" else None


ALLOWED_TRANSITIONS = {
    "queued": frozenset({"preheating", "dispatching", "unsuccessful"}),
    "preheating": frozenset({"dispatching", "failed", "cancelled", "unsuccessful"}),
    "dispatching": frozenset({"printing", "failed", "cancelled", "unsuccessful"}),
    "printing": frozenset({"paused", "finished", "failed", "cancelled", "unsuccessful"}),
    "paused": frozenset({"printing", "finished", "failed", "cancelled", "unsuccessful"}),
    "finished": frozenset({"successful"}),
    "failed": frozenset({"unsuccessful"}),
    "cancelled": frozenset({"finished", "unsuccessful"}),
    "successful": frozenset(),
    "unsuccessful": frozenset(),
}

# Only the versioned upgrade on an AsyncConnection may use these edges.
LEGACY_TRANSITIONS = {
    "pending": {"queued"},
    "skipped": {"queued"},
    "completed": {"successful", "finished"},
    "failed": {"unsuccessful"},
    "cancelled": {"unsuccessful"},
    "aborted": {"cancelled", "unsuccessful"},
    **{state: {"unsuccessful"} for state in ACTIVE_STATUSES},
}


class InvalidQueueTransition(ValueError):
    """A caller requested an edge outside the current lifecycle."""


class QueueTransitionConflict(RuntimeError):
    """The expected row/status/claim no longer exists; abort this transaction."""


async def _write_transition(
    db, item, expected_status, status, *, metadata, conditions=(), action=None, migration=False, dispatch_guard=None
) -> None:
    """Validate an edge and conditionally write status and metadata; never commit."""
    from backend.app.models.print_queue import PrintQueueItem

    upgrading = migration and isinstance(db, AsyncConnection) and status in LEGACY_TRANSITIONS.get(expected_status, ())
    if not upgrading and (
        expected_status not in ALLOWED_TRANSITIONS
        or (status != expected_status and status not in ALLOWED_TRANSITIONS[expected_status])
    ):
        raise InvalidQueueTransition(f"Invalid queue transition: {expected_status} -> {status}")
    confirmed = action == "printer_report"
    if confirmed and status not in AWAITING_PLATE_CLEAR_STATUSES:
        raise InvalidQueueTransition("A confirmed physical outcome requires an awaiting-plate-clear job")
    if not upgrading and status != expected_status:
        if expected_status == "cancelled" and status == "finished" and not confirmed:
            raise InvalidQueueTransition("Only an identified printer completion may finish a cancelled job")
        if expected_status == "queued" and status == "unsuccessful" and action != "cancel":
            raise InvalidQueueTransition("Only a user cancellation may end a queued job")
        if expected_status in ACTIVE_STATUSES and status == "unsuccessful" and action != "printer_deleted":
            raise InvalidQueueTransition("Only printer deletion may release an active job")
        if expected_status in AWAITING_PLATE_CLEAR_STATUSES and action not in (
            "clear_plate",
            "printer_deleted",
            "hold_transferred",
            "printer_report",
        ):
            raise InvalidQueueTransition(
                "A holding job requires Clear Plate, printer deletion, or an observed hold transfer"
            )
    if "status" in metadata or "id" in metadata:
        raise ValueError("Transition metadata cannot override status or id")
    item_id = item if isinstance(item, int) else item.id

    table = PrintQueueItem.__table__
    if status == "dispatching" and expected_status != status and not upgrading:
        printer_id = metadata.get("printer_id", item.printer_id if not isinstance(item, int) else None)
        if printer_id is None:
            raise InvalidQueueTransition("Dispatch requires a selected printer")
    # Suppress SQLAlchemy 2.1 Core autoflush so a losing CAS cannot flush stale metadata.
    if dispatch_guard is not None and not dispatch_guard():
        raise QueueTransitionConflict("Printer is no longer available for dispatch")
    with db.no_autoflush if isinstance(db, AsyncSession) else nullcontext():
        outcome_condition = (table.c.physical_outcome.is_(None),) if confirmed else ()
        result = await db.execute(
            table.update()
            .where(table.c.id == item_id, table.c.status == expected_status, *conditions, *outcome_condition)
            .values(status=status, **metadata)
            .execution_options(autoflush=False)
        )
    if result.rowcount != 1:
        raise QueueTransitionConflict(f"Queue item {item_id} no longer matches expected status {expected_status}")
    if not isinstance(item, int):
        set_committed_value(item, "status", status)
        for key, value in metadata.items():
            set_committed_value(item, key, value)


# Existing callers and migrations share the engine entry point.
from backend.app.services.print_lifecycle.engine import clear_job_plate, transition_queue_item  # noqa: E402, F401

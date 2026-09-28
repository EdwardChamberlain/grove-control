"""The single writer for existing queue-item statuses (issue #194, stage 1).

This deliberately describes today's lifecycle, including returns to pending.
Callers still own transactions, metadata and side effects. A successful call is
not a commit; callers must commit before publishing their existing effects.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Any

from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession
from sqlalchemy.orm.attributes import set_committed_value
from sqlalchemy.sql.elements import ColumnElement

if TYPE_CHECKING:
    from backend.app.models.print_queue import PrintQueueItem


ALLOWED_TRANSITIONS = {
    "pending": frozenset({"preheating", "dispatching", "failed", "skipped", "cancelled"}),
    "preheating": frozenset({"pending", "dispatching", "failed", "cancelled"}),
    "dispatching": frozenset({"pending", "printing", "completed", "failed", "cancelled"}),
    "printing": frozenset({"completed", "failed", "cancelled"}),
    "skipped": frozenset({"pending", "cancelled"}),
    # The heat-soak dispatch finally block currently restores failed attempts
    # to pending/manual-start after shutting down their heaters.
    "failed": frozenset({"pending"}),
    "completed": frozenset(),
    "cancelled": frozenset(),
    # Legacy startup repair only; no current flow creates this status.
    "aborted": frozenset({"cancelled"}),
}


class InvalidQueueTransition(ValueError):
    """A caller requested an edge outside the current lifecycle."""


class QueueTransitionConflict(RuntimeError):
    """The expected row/status/claim no longer exists; abort this transaction."""


async def transition_queue_item(
    db: AsyncSession | AsyncConnection,
    item: PrintQueueItem | int,
    expected_status: str,
    status: str,
    *,
    values: Mapping[str, Any] | None = None,
    conditions: Sequence[ColumnElement[bool]] = (),
) -> None:
    """Conditionally change a persisted item, or raise without writing it.

    Same-status reapplication is supported for existing heat-soak handoffs,
    heater cleanup and recovered completion callbacks. It still checks the
    database status. Extra conditions preserve dispatch-claim fencing; values
    are metadata that must change atomically with the status. Integer IDs let
    legacy migrations use this same writer on their existing connection.

    On conflict the caller must roll back (or let its session context close)
    and must not run effects. This function never commits or rolls back the
    caller's transaction. ORM status is synchronized without a second,
    unconditional status UPDATE at flush time.
    """
    from backend.app.models.print_queue import PrintQueueItem

    if expected_status not in ALLOWED_TRANSITIONS or (
        status != expected_status and status not in ALLOWED_TRANSITIONS[expected_status]
    ):
        raise InvalidQueueTransition(f"Invalid queue transition: {expected_status} -> {status}")
    metadata = dict(values or {})
    if "status" in metadata or "id" in metadata:
        raise ValueError("Transition metadata cannot override status or id")
    item_id = item if isinstance(item, int) else item.id
    if not isinstance(item, int) and inspect(item).attrs.status.history.has_changes():
        raise ValueError("Queue status must only be changed through transition_queue_item")

    table = PrintQueueItem.__table__
    result = await db.execute(
        table.update()
        .where(table.c.id == item_id, table.c.status == expected_status, *conditions)
        .values(status=status, **metadata)
        .execution_options(autoflush=False)
    )
    if result.rowcount != 1:
        raise QueueTransitionConflict(f"Queue item {item_id} no longer matches expected status {expected_status}")
    if not isinstance(item, int):
        set_committed_value(item, "status", status)
        for key, value in metadata.items():
            set_committed_value(item, key, value)

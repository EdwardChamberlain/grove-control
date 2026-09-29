"""The single writer for existing queue-item statuses (issue #194, stage 1).

This deliberately describes today's lifecycle, including returns to pending.
Callers still own transactions, metadata and side effects. A successful call is
not a commit; callers must commit before publishing their existing effects.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from contextlib import nullcontext
from typing import TYPE_CHECKING, Any

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

    On conflict nothing is written and the caller must not run effects. It
    either rolls back (or lets its session context close) or, when handling
    several items in one transaction, skips this item and continues. This
    function never commits or rolls back the caller's transaction. ORM status
    is synchronized without a second, unconditional status UPDATE at flush
    time.
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

    table = PrintQueueItem.__table__
    # SQLAlchemy 2.1 autoflushes Core statements regardless of their statement
    # execution options. Suppress it at the session boundary so a losing CAS
    # cannot flush stale metadata first. Startup repairs use AsyncConnection.
    with db.no_autoflush if isinstance(db, AsyncSession) else nullcontext():
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

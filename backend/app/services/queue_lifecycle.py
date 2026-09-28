"""The single writer of ``PrintQueueItem.status`` (#194).

Every status change goes through :func:`transition_queue_item`. It checks the
move against ``ALLOWED_TRANSITIONS`` and applies it as one conditional update
(``UPDATE … WHERE id = :id AND status IN (:expected)``). A writer acting on a
status that another writer has already changed updates nothing, instead of
overwriting the newer status.

The table records the moves Grove makes today, under today's status names.
This includes the backward moves (for example ``preheating -> pending``) that
a later phase of #194 removes. A new row may be created in any status. After
that, its status changes only here: assigning ``status`` on a stored row
raises :class:`InvalidQueueTransition`.
"""

import logging
from collections.abc import Collection
from typing import Any

from sqlalchemy import event, inspect, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value
from sqlalchemy.sql.elements import ColumnElement

from backend.app.models.print_queue import PrintQueueItem

logger = logging.getLogger(__name__)

ALLOWED_TRANSITIONS: dict[str, frozenset[str]] = {
    # Heat-soak staging, dispatch, a pre-send failure, the previous-success
    # gate and user cancellation.
    "pending": frozenset({"preheating", "dispatching", "failed", "skipped", "cancelled"}),
    # The soak finished, was skipped or aborted (back to pending), or was
    # cancelled by the user.
    "preheating": frozenset({"pending", "dispatching", "cancelled"}),
    # The printer confirmed the job or reported its end; a pre-send failure;
    # drying or an aborted heat soak released the reservation; the user stopped it.
    "dispatching": frozenset({"pending", "printing", "completed", "failed", "cancelled"}),
    "printing": frozenset({"completed", "failed", "cancelled"}),
    # "Resume after failure" restores the item; deleting its source file cancels it.
    "skipped": frozenset({"pending", "cancelled"}),
    # The heat-soak finalizer returns a failed heat-soak dispatch to pending
    # for a manual retry.
    "failed": frozenset({"pending"}),
    "completed": frozenset(),
    "cancelled": frozenset(),
    # Rows written before print completion normalised "aborted"; repaired at startup.
    "aborted": frozenset({"cancelled"}),
}


class InvalidQueueTransition(RuntimeError):
    """A status change that the lifecycle does not allow. Always a bug."""


async def transition_queue_item(
    db: AsyncSession,
    item: PrintQueueItem,
    to_status: str,
    *,
    from_status: str | Collection[str] | None = None,
    where: Collection[ColumnElement[bool]] = (),
    **values: Any,
) -> bool:
    """Move ``item`` to ``to_status`` if its row is still in ``from_status``.

    ``from_status`` defaults to the status on ``item``: the one the caller
    acted on. ``where`` adds conditions to the update, and ``values`` are
    other columns written with the status. Staying in the same status is
    allowed and writes only ``values``.

    Returns False, changing nothing, when the row has left ``from_status`` or
    no longer exists. On success, ``item`` is updated to match the row. The
    caller owns the transaction and commits it.
    """
    if from_status is None:
        sources = (item.status,)
    elif isinstance(from_status, str):
        sources = (from_status,)
    else:
        sources = tuple(from_status)
    for source in sources:
        if to_status != source and to_status not in ALLOWED_TRANSITIONS.get(source, ()):
            raise InvalidQueueTransition(f"Queue item {item.id}: {source} -> {to_status} is not allowed")

    result = await db.execute(
        update(PrintQueueItem)
        .where(PrintQueueItem.id == item.id, PrintQueueItem.status.in_(sources), *where)
        .values(status=to_status, **values)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        logger.info("Queue item %s: %s -> %s skipped; the row has changed", item.id, "|".join(sources), to_status)
        return False

    for key, value in {"status": to_status, **values}.items():
        set_committed_value(item, key, value)
    logger.debug("Queue item %s: %s -> %s", item.id, "|".join(sources), to_status)
    return True


async def lock_queue_item(db: AsyncSession, item_id: int) -> PrintQueueItem | None:
    """Take a write lock on both SQLite and PostgreSQL, then discard stale ORM state."""
    with db.no_autoflush:
        result = await db.execute(
            update(PrintQueueItem)
            .where(PrintQueueItem.id == item_id)
            .values(status=PrintQueueItem.status)
            .execution_options(synchronize_session=False)
        )
        if not result.rowcount:
            return None
        return await db.get(PrintQueueItem, item_id, populate_existing=True)


@event.listens_for(PrintQueueItem.status, "set")
def _reject_direct_status_write(target: PrintQueueItem, value, oldvalue, initiator) -> None:
    if inspect(target).has_identity:
        raise InvalidQueueTransition(
            f"Queue item {target.id}: set status through transition_queue_item(), not by assignment"
        )

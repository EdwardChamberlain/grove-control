"""The single conditional writer for the print job lifecycle (#194).

Callers own the transaction. Printer views are updated only after commit;
the holding index, rather than the view, is the reservation authority.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from contextlib import nullcontext
from typing import TYPE_CHECKING, Any

from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import set_committed_value
from sqlalchemy.sql.elements import ColumnElement

if TYPE_CHECKING:
    from backend.app.models.print_queue import PrintQueueItem


ACTIVE_STATUSES = ("preheating", "dispatching", "printing", "paused")
AWAITING_PLATE_CLEAR_STATUSES = ("finished", "failed", "cancelled")
HOLDING_STATUSES = ACTIVE_STATUSES + AWAITING_PLATE_CLEAR_STATUSES
FINAL_STATUSES = ("successful", "unsuccessful")
ALLOWED_TRANSITIONS = {
    "queued": frozenset({"preheating", "dispatching", "unsuccessful"}),
    "preheating": frozenset({"dispatching", "failed", "cancelled", "unsuccessful"}),
    "dispatching": frozenset({"printing", "failed", "cancelled", "unsuccessful"}),
    "printing": frozenset({"paused", "finished", "failed", "cancelled", "unsuccessful"}),
    "paused": frozenset({"printing", "finished", "failed", "cancelled", "unsuccessful"}),
    "finished": frozenset({"successful"}),
    "failed": frozenset({"unsuccessful"}),
    "cancelled": frozenset({"unsuccessful"}),
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


@event.listens_for(Session, "after_commit")
def _publish_printer_views(session: Session) -> None:
    paths = session.info.pop("queue_source_artifacts", [])
    if paths:
        from backend.app.services.queue_source_cleanup import remove_queue_only_artifacts

        remove_queue_only_artifacts(paths)
    updates = session.info.pop("queue_printer_views", {})
    if not updates:
        return
    from backend.app.services.printer_manager import printer_manager

    for printer_id, (status, archive_id) in updates.items():
        awaiting = status in AWAITING_PLATE_CLEAR_STATUSES
        printer_manager.set_awaiting_plate_clear(printer_id, awaiting)
        printer_manager.set_awaiting_plate_clear_archive_id(printer_id, archive_id if awaiting else None)


@event.listens_for(Session, "after_rollback")
def _discard_printer_views(session: Session) -> None:
    session.info.pop("queue_printer_views", None)
    session.info.pop("queue_source_artifacts", None)


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
    action: str | None = None,
    migration: bool = False,
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

    upgrading = migration and isinstance(db, AsyncConnection) and status in LEGACY_TRANSITIONS.get(expected_status, ())
    if not upgrading and (
        expected_status not in ALLOWED_TRANSITIONS
        or (status != expected_status and status not in ALLOWED_TRANSITIONS[expected_status])
    ):
        raise InvalidQueueTransition(f"Invalid queue transition: {expected_status} -> {status}")
    if not upgrading and status != expected_status:
        if expected_status == "queued" and status == "unsuccessful" and action != "cancel":
            raise InvalidQueueTransition("Only a user cancellation may end a queued job")
        if expected_status in ACTIVE_STATUSES and status == "unsuccessful" and action != "printer_deleted":
            raise InvalidQueueTransition("Only printer deletion may release an active job")
        if expected_status in AWAITING_PLATE_CLEAR_STATUSES and action not in (
            "clear_plate",
            "printer_deleted",
            "hold_transferred",
        ):
            raise InvalidQueueTransition(
                "A holding job requires Clear Plate, printer deletion, or an observed hold transfer"
            )
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
    if isinstance(db, AsyncSession):
        if status in FINAL_STATUSES and expected_status != status:
            from backend.app.services.queue_source_cleanup import remove_queue_only_source_if_unused

            source_id = await db.scalar(select(table.c.library_file_id).where(table.c.id == item_id))
            if source_id is not None:
                paths = await remove_queue_only_source_if_unused(db, source_id)
                db.sync_session.info.setdefault("queue_source_artifacts", []).extend(paths)
        row = (await db.execute(select(table.c.printer_id, table.c.archive_id).where(table.c.id == item_id))).one()
        if row.printer_id is not None and (expected_status in HOLDING_STATUSES or status in HOLDING_STATUSES):
            db.sync_session.info.setdefault("queue_printer_views", {})[row.printer_id] = (status, row.archive_id)
        if status == "finished" and expected_status != "finished":
            from backend.app.models.settings import Settings

            confirmation = await db.scalar(select(Settings.value).where(Settings.key == "require_plate_clear"))
            if confirmation is not None and confirmation.lower() in ("false", "0"):
                await clear_job_plate(db, item, automatic=True)


async def clear_job_plate(db: AsyncSession, item: PrintQueueItem | int, *, automatic: bool = False) -> None:
    from backend.app.models.print_queue import PrintQueueItem as QueueItemModel

    if isinstance(item, int):
        item = await db.get(QueueItemModel, item)
    if item is None or item.status not in AWAITING_PLATE_CLEAR_STATUSES:
        raise InvalidQueueTransition("This job is not awaiting plate clear")
    from backend.app.services.printer_manager import printer_manager

    live = printer_manager.get_status(item.printer_id) if item.printer_id is not None else None
    if (
        live
        and live.connected
        and getattr(live, "job_telemetry_ready", True)
        and live.state in ("PREPARE", "SLICING", "RUNNING", "PAUSE")
    ):
        if automatic:
            return  # Keep the physical outcome and hold if another print is already active.
        raise InvalidQueueTransition("The printer is still active. Stop or finish its print before clearing the plate")
    await transition_queue_item(
        db, item, item.status, "successful" if item.status == "finished" else "unsuccessful", action="clear_plate"
    )

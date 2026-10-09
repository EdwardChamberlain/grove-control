"""The print job lifecycle engine (#204): the transition table, its guards and the one conditional write.

Callers own the transaction; queued effects run only after it commits. The
holding index, not the printer view, is the reservation authority. Effects and
state modules are imported on use because they import this module.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Mapping, Sequence
from contextlib import nullcontext
from dataclasses import dataclass
from functools import partial
from importlib import import_module
from pathlib import Path
from typing import Any

from sqlalchemy import event, select, update
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import set_committed_value
from sqlalchemy.sql.elements import ColumnElement

from backend.app.models.print_queue import (
    ACTIVE_STATUSES,
    AWAITING_PLATE_CLEAR_STATUSES,
    FINAL_STATUSES,
    HOLDING_STATUSES,
    PrintQueueItem,
)
from backend.app.models.printer import Printer
from backend.app.services.lifecycle import clock

logger = logging.getLogger(__name__)

# One writer per printer (#217). A transaction takes a printer's lock when it
# first locks or writes a job holding that printer, and keeps it until the
# transaction ends, so no two transactions ever write one printer's job at once.
_printer_locks: dict[int, asyncio.Lock] = {}
_holders: dict[int, Session] = {}
# Scenarios collect lifecycle conflicts and late locks here instead of logging them.
violations: list[str] | None = None


async def hold_printer(db: AsyncSession, printer_id: int | None) -> None:
    """Make ``db``'s transaction the printer's only writer until the transaction ends.

    Take it before the transaction's first write: a transaction that has
    written holds SQLite's single write lock, and the printer's current
    holder may be waiting for that.
    """
    session = db.sync_session
    if printer_id is None or _holders.get(printer_id) is session:
        return
    if session.info.get("wrote"):
        _violation(f"printer {printer_id}'s lock taken after this transaction wrote")
    await _printer_locks.setdefault(printer_id, asyncio.Lock()).acquire()
    _holders[printer_id] = session


def printer_busy(printer_id: int) -> bool:
    """Whether a transaction is writing the printer's job now."""
    return printer_id in _holders


@event.listens_for(Session, "after_transaction_end")
def _release(session: Session, transaction) -> None:
    if transaction.parent is not None:
        return
    session.info.pop("wrote", None)
    for printer_id, holder in list(_holders.items()):
        if holder is session:
            del _holders[printer_id]
            _printer_locks[printer_id].release()


@event.listens_for(Session, "do_orm_execute")
def _note_write(state) -> None:
    if state.is_update or state.is_insert or state.is_delete:
        state.session.info["wrote"] = True


@event.listens_for(Session, "after_flush")
def _note_flush(session: Session, _context) -> None:
    session.info["wrote"] = True


def _violation(message: str) -> None:
    if violations is None:
        logger.warning("lifecycle: %s", message)
        return
    import traceback

    frames = [f for f in traceback.extract_stack()[:-2] if "/app/" in f.filename]
    violations.append(
        message + " via " + " < ".join(f"{Path(f.filename).stem}.{f.name}" for f in reversed(frames[-4:]))
    )


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


ARCHIVE_OUTCOMES = {"finished": "completed", "failed": "failed", "cancelled": "aborted"}


def physical_failure_reason(outcome: str, error_message: str | None, override: str | None = None) -> str | None:
    if outcome == "failed":
        return (override or error_message or "Print failed")[:100]
    return "User cancelled" if outcome == "aborted" else None


class InvalidQueueTransition(ValueError):
    """A caller requested an edge outside the current lifecycle."""


class QueueTransitionConflict(RuntimeError):
    """The expected row/status/claim no longer exists; abort this transaction."""


# Only these actions may move a job out of an awaiting-plate-clear state.
_RELEASE_ACTIONS = ("clear_plate", "printer_deleted", "hold_transferred", "printer_report")

# Each state's steps live in its module. In the caller's transaction, after the
# conditional write: the old state's on_exit(change, row), then the new state's
# on_enter(change, row). State modules import this one, so they are named here
# and imported on use.
_LIFECYCLE = "backend.app.services.lifecycle"
_EXITS = {
    "preheating": f"{_LIFECYCLE}.preheating",
    "dispatching": f"{_LIFECYCLE}.dispatching",
    **dict.fromkeys(("printing", "paused"), f"{_LIFECYCLE}.printing"),
    **dict.fromkeys(AWAITING_PLATE_CLEAR_STATUSES, f"{_LIFECYCLE}.awaiting"),
}
_ENTRY = {
    "dispatching": f"{_LIFECYCLE}.dispatching",
    "printing": f"{_LIFECYCLE}.printing",
    **dict.fromkeys(AWAITING_PLATE_CLEAR_STATUSES, f"{_LIFECYCLE}.awaiting"),
    **dict.fromkeys(FINAL_STATUSES, f"{_LIFECYCLE}.final"),
}


@dataclass(frozen=True)
class Transition:
    db: AsyncSession
    item: PrintQueueItem | int
    item_id: int
    before: str
    after: str
    action: str | None
    values: Mapping[str, Any]

    async def write(self, **values: Any) -> None:
        """Write more of the job in this transaction; steps run after the conditional write."""
        table = PrintQueueItem.__table__
        with self.db.no_autoflush:  # As in the conditional write.
            await self.db.execute(table.update().where(table.c.id == self.item_id).values(**values))
        for key, value in values.items() if not isinstance(self.item, int) else ():
            set_committed_value(self.item, key, value)


def _check(before: str, after: str, action: str | None, upgrading: bool) -> None:
    if not upgrading and (
        before not in ALLOWED_TRANSITIONS or (after != before and after not in ALLOWED_TRANSITIONS[before])
    ):
        raise InvalidQueueTransition(f"Invalid queue transition: {before} -> {after}")
    confirmed = action == "printer_report"
    if confirmed and after not in AWAITING_PLATE_CLEAR_STATUSES:
        raise InvalidQueueTransition("A confirmed physical outcome requires an awaiting-plate-clear job")
    if upgrading or after == before:
        return
    if before == "cancelled" and after == "finished" and not confirmed:
        raise InvalidQueueTransition("Only an identified printer completion may finish a cancelled job")
    if before == "queued" and after == "unsuccessful" and action != "cancel":
        raise InvalidQueueTransition("Only a user cancellation may end a queued job")
    if before in ACTIVE_STATUSES and after == "unsuccessful" and action != "printer_deleted":
        if not (before == "dispatching" and action == "withdrawn"):
            raise InvalidQueueTransition(
                "Only printer deletion, or Retry of an unsent attempt, may release an active job"
            )
    if before in AWAITING_PLATE_CLEAR_STATUSES and action not in _RELEASE_ACTIONS:
        raise InvalidQueueTransition(
            "A holding job requires Clear Plate, printer deletion, or an observed hold transfer"
        )


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
    archive_failure_reason: str | None = None,
) -> Transition | None:
    """Conditionally change a persisted item, or raise without writing it.

    The caller's transaction takes the job's printer lock here, if it hasn't
    already. Same-status writes still check the stored status; ``conditions``
    add further checks, and ``values`` change atomically with the status.
    Integer IDs let the legacy upgrade use its own connection. On conflict
    nothing is written or queued. This never commits or rolls back, and ORM
    sync never flushes a second status UPDATE. A session gets back the
    written change.
    """
    upgrading = migration and isinstance(db, AsyncConnection) and status in LEGACY_TRANSITIONS.get(expected_status, ())
    _check(expected_status, status, action, upgrading)
    confirmed = action == "printer_report"
    metadata = dict(values or {})
    if "status" in metadata or "id" in metadata:
        raise ValueError("Transition metadata cannot override status or id")
    if any(key.startswith("physical_") for key in metadata):
        raise ValueError("Physical outcomes are recorded only on entry to an awaiting-plate-clear state")
    if expected_status != status and not migration:
        # A deadline belongs to one state: leaving it ends the wait.
        metadata.setdefault("deadline_at", None)
        metadata.setdefault("deadline_kind", None)
    item_id = item if isinstance(item, int) else item.id
    if isinstance(db, AsyncSession) and not isinstance(item, int):
        if expected_status in HOLDING_STATUSES or status in HOLDING_STATUSES:
            await hold_printer(db, metadata.get("printer_id", item.printer_id))
    if status == "dispatching" and expected_status != status and not upgrading:
        if metadata.get("printer_id", item.printer_id if not isinstance(item, int) else None) is None:
            raise InvalidQueueTransition("Dispatch requires a selected printer")
    session = isinstance(db, AsyncSession)
    if session and (expected_status != status or confirmed):
        if status in AWAITING_PLATE_CLEAR_STATUSES and action != "cancel":
            await _record_physical_outcome(db, item_id, status, metadata, confirmed, archive_failure_reason)
    # SQLAlchemy 2.1 autoflushes Core statements regardless of their statement
    # execution options. Suppress it at the session boundary so a losing CAS
    # cannot flush stale metadata first. Startup repairs use AsyncConnection.
    table = PrintQueueItem.__table__
    with db.no_autoflush if session else nullcontext():
        outcome_condition = (table.c.physical_outcome.is_(None),) if confirmed else ()
        result = await db.execute(
            table.update()
            .where(table.c.id == item_id, table.c.status == expected_status, *conditions, *outcome_condition)
            .values(status=status, **metadata)
            .execution_options(autoflush=False)
        )
    if result.rowcount != 1:
        if expected_status in HOLDING_STATUSES:
            _violation(f"conflict: queue job {item_id} left {expected_status} under another writer")
        raise QueueTransitionConflict(f"Queue item {item_id} no longer matches expected status {expected_status}")
    if not isinstance(item, int):
        set_committed_value(item, "status", status)
        for key, value in metadata.items():
            set_committed_value(item, key, value)
    if not session:
        return None
    if metadata.get("deadline_at") is not None:
        from backend.app.services.lifecycle import deadlines, effects

        effects.after_commit(db, deadlines.wake, key="lifecycle_wake")
    change = Transition(db, item, item_id, expected_status, status, action, metadata)
    await _written(change)
    return change


async def _written(change: Transition) -> None:
    """Align the Archive attempt, queue the log and printer view, then run the exit and entry steps."""
    from backend.app.services.lifecycle import effects
    from backend.app.services.queue_archive import align_attempt

    db, table, entered = change.db, PrintQueueItem.__table__, change.before != change.after
    linked = change.values.keys() & {"archive_id", "dispatch_subtask_id"}
    if entered or linked or change.after in (*AWAITING_PLATE_CLEAR_STATUSES, *FINAL_STATUSES):
        await align_attempt(change)
    holding = change.before in HOLDING_STATUSES or change.after in HOLDING_STATUSES
    if not (entered or holding or change.action):
        return  # No log, printer view or entry step applies (e.g. a waiting reason).
    names = (
        "printer_id",
        "archive_id",
        "library_file_id",
        "preheat_requested_at",
        "chamber_heat_soak",
    )
    row = (await db.execute(select(*(table.c[name] for name in names)).where(table.c.id == change.item_id))).one()
    if entered or change.action is not None:
        log = "Queue job %s: %s -> %s (printer=%s, archive=%s, action=%s)"
        args = (change.item_id, change.before, change.after, row.printer_id, row.archive_id, change.action)
        effects.after_commit(db, partial(logger.info, log, *args))
    if row.printer_id is not None and holding:
        effects.publish_printer_view(db, row.printer_id, change.after, row.archive_id)
    if entered and change.before in _EXITS:
        await import_module(_EXITS[change.before]).on_exit(change, row)
    if entered and (enter := _step(change.after, "on_enter")):
        await enter(change, row)


def _step(state: str, name: str) -> Callable | None:
    return getattr(import_module(_ENTRY[state]), name, None) if state in _ENTRY else None


async def _record_physical_outcome(
    db: AsyncSession, item_id: int, status: str, metadata: dict, confirmed: bool, override: str | None
) -> None:
    """Capture facts before Clear Plate collapses them; no state decision reads them."""
    metadata.setdefault("completed_at", clock.now())
    reason = metadata.get("error_message")
    if reason is None:
        with db.no_autoflush:
            table = PrintQueueItem.__table__
            reason = await db.scalar(select(table.c.error_message).where(table.c.id == item_id))
    outcome = ARCHIVE_OUTCOMES[status]
    metadata.update(
        physical_outcome=outcome,
        physical_completed_at=clock.now() if confirmed else metadata["completed_at"],
        physical_failure_reason=physical_failure_reason(outcome, reason, override),
    )


async def lock_queue_item(db: AsyncSession, item_id: int) -> PrintQueueItem | None:
    """Take the job's printer lock and a row write lock on both SQLite and PostgreSQL, then discard stale ORM state."""
    with db.no_autoflush:  # Pending work, such as an unlinked copy, stays unflushed until the caller's write.
        printer_id = await db.scalar(select(PrintQueueItem.printer_id).where(PrintQueueItem.id == item_id))
        await hold_printer(db, printer_id)
        result = await db.execute(
            update(PrintQueueItem)
            .where(PrintQueueItem.id == item_id)
            .values(id=PrintQueueItem.id)
            .execution_options(synchronize_session=False)
        )
        if not result.rowcount:
            return None
        return await db.get(PrintQueueItem, item_id, populate_existing=True)


async def transfer_hold(db: AsyncSession, held: PrintQueueItem, identity: str) -> bool:
    """Transfer hold under the lifecycle transition rules."""
    from backend.app.services.lifecycle.final import end

    if held.status not in AWAITING_PLATE_CLEAR_STATUSES:
        return False
    reason = f"Printer hold transferred to externally started print {identity}"
    message = f"{held.error_message}; {reason}" if held.error_message else reason
    await end(db, held, "hold_transferred", error_message=message)
    return True


async def release_printer(db: AsyncSession, printer: Printer) -> None:
    """Release printer under the lifecycle transition rules."""
    from backend.app.services.lifecycle.dispatching import is_soaking
    from backend.app.services.lifecycle.final import end
    from backend.app.services.printer_manager import printer_manager

    held = (PrintQueueItem.printer_id == printer.id, PrintQueueItem.status.in_(HOLDING_STATUSES))
    holding = list((await db.scalars(select(PrintQueueItem).where(*held).with_for_update())).all())
    soaking = printer.heat_soak_shutdown_pending or any(is_soaking(item) for item in holding)
    if soaking and printer_manager.is_connected(printer.id):
        raise InvalidQueueTransition(
            "Stop the heat soak and wait for heater shutdown to be confirmed before deleting this printer"
        )
    for item in holding:
        # A finished print keeps its outcome; only an unsuccessful end is
        # explained by the deletion. Jobs that already ended keep their time.
        values = {"error_message": "Printer deleted"} if item.status != "finished" else {}
        if item.completed_at is None:
            values["completed_at"] = clock.now()
        await end(db, item, "printer_deleted", **values)

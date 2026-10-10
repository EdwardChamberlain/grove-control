"""The print job lifecycle engine (#204): the transition table, its guards and the one conditional write.

Callers own the transaction; queued effects run only after it commits. The
holding index, not the printer view, is the reservation authority. Effects and
state modules are imported on use because they import this module.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Mapping, Sequence
from contextlib import asynccontextmanager, nullcontext
from contextvars import ContextVar
from dataclasses import dataclass
from functools import partial
from importlib import import_module
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession
from sqlalchemy.orm.attributes import set_committed_value
from sqlalchemy.sql.elements import ColumnElement

from backend.app.models.print_queue import (
    ACTIVE_STATUSES,
    AWAITING_PLATE_CLEAR_STATUSES,
    FINAL_STATUSES,
    PrintQueueItem,
    is_physical_holding,
    physical_holding_clause,
)
from backend.app.models.printer import Printer
from backend.app.services.lifecycle import clock

logger = logging.getLogger(__name__)

# A lifecycle writer is an explicit scope around work that may affect a
# printer. The database CAS and holding index remain the durable safeguards;
# this lock orders in-process effects and the send-command boundary.
_printer_locks: dict[int, asyncio.Lock] = {}


@dataclass(frozen=True)
class _WriterState:
    task: asyncio.Task
    printer_ids: frozenset[int]


_writer_state: ContextVar[_WriterState | None] = ContextVar("lifecycle_writer", default=None)


@asynccontextmanager
async def writer(printer_ids: int | Sequence[int | None] | None):
    """Serialize lifecycle work for one or more printers in ascending ID order.

    Use this before a lifecycle transaction and keep it through any synchronous
    printer command whose authorization comes from that transaction. Nested
    calls by the same task are reentrant; child tasks must acquire their own
    writer even when they inherit the context variable.
    """
    requested = {printer_ids} if isinstance(printer_ids, int) else set(printer_ids or ())
    requested.discard(None)
    task = asyncio.current_task()
    if task is None:
        raise RuntimeError("Lifecycle writers require an asyncio task")
    previous = _writer_state.get()
    inherited = previous.printer_ids if previous is not None and previous.task is task else frozenset()
    acquired: list[tuple[int, asyncio.Lock]] = []
    try:
        for printer_id in sorted(requested - inherited):
            lock = _printer_locks.setdefault(printer_id, asyncio.Lock())
            await lock.acquire()
            acquired.append((printer_id, lock))
        token = _writer_state.set(_WriterState(task, inherited | requested))
        try:
            yield
        finally:
            _writer_state.reset(token)
    finally:
        for _printer_id, lock in reversed(acquired):
            lock.release()


def owns_writer(printer_id: int | None) -> bool:
    """Whether the current task owns the lifecycle writer for ``printer_id``."""
    state = _writer_state.get()
    task = asyncio.current_task()
    return bool(printer_id is not None and state is not None and state.task is task and printer_id in state.printer_ids)


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
_RELEASE_ACTIONS = ("clear_plate", "printer_deleted", "external_replacement", "printer_report")

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
        if not (before == "dispatching" and action == "withdrawn") and not (
            before in ("preheating", "dispatching") and action == "cancel_unsent"
        ):
            raise InvalidQueueTransition(
                "Only printer deletion, cancellation of an unsent job, or Retry of an unsent attempt may release an active job"
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

    A lifecycle writer orders writes for the bound printer. Same-status writes
    still check the stored status; ``conditions`` add further checks, and
    ``values`` change atomically with the status.
    Integer IDs let the legacy upgrade use its own connection. On conflict
    nothing is written or queued. This never commits or rolls back, and ORM
    sync never flushes a second status UPDATE. A session gets back the
    written change. Callers changing a printer-bound job must already own its
    explicit lifecycle writer; this helper never acquires one after the
    database transaction has begun.
    """
    upgrading = migration and isinstance(db, AsyncConnection) and status in LEGACY_TRANSITIONS.get(expected_status, ())
    _check(expected_status, status, action, upgrading)
    confirmed = action == "printer_report"
    metadata = dict(values or {})
    if "status" in metadata or "id" in metadata:
        raise ValueError("Transition metadata cannot override status or id")
    if any(key.startswith("physical_") for key in metadata):
        raise ValueError("Physical outcomes are recorded only on entry to an awaiting-plate-clear state")
    if (
        expected_status == "queued"
        and status in ("preheating", "dispatching")
        and not isinstance(item, int)
        and "printer_id" not in metadata
        and item.assigned_printer_id is not None
    ):
        # A fixed queue preference becomes the immutable binding at the point
        # the job leaves the queue. Pool selection supplies this explicitly.
        metadata["printer_id"] = item.assigned_printer_id
    if expected_status != status and not migration:
        # A deadline belongs to one state: leaving it ends the wait.
        metadata.setdefault("deadline_at", None)
        metadata.setdefault("deadline_kind", None)
    if expected_status == "dispatching" and status != "dispatching":
        metadata.setdefault("dispatch_stage", None)
    item_id = item if isinstance(item, int) else item.id
    session = isinstance(db, AsyncSession)
    printer_id = metadata.get("printer_id", item.printer_id if not isinstance(item, int) else None)
    if session and printer_id is not None and not owns_writer(printer_id):
        raise RuntimeError(f"Lifecycle writes for printer {printer_id} require lifecycle.writer()")
    if status == "dispatching" and expected_status != status and not upgrading:
        if metadata.get("printer_id", item.printer_id if not isinstance(item, int) else None) is None:
            raise InvalidQueueTransition("Dispatch requires a selected printer")
    if action == "cancel_unsent" and expected_status in ("preheating", "dispatching"):
        conditions = (*conditions, PrintQueueItem.dispatched_at.is_(None))
    if session and (expected_status != status or confirmed):
        if status in AWAITING_PLATE_CLEAR_STATUSES and action not in ("cancel", "dispatch_failure"):
            await _record_physical_outcome(db, item_id, status, metadata, confirmed, archive_failure_reason)
    # SQLAlchemy 2.1 autoflushes Core statements regardless of their statement
    # execution options. Suppress it at the session boundary so a losing CAS
    # cannot flush stale metadata first. Startup repairs use AsyncConnection.
    table = PrintQueueItem.__table__
    if not isinstance(item, int) and item.printer_id is not None:
        requested_printer_id = metadata.get("printer_id", item.printer_id)
        if requested_printer_id != item.printer_id:
            raise InvalidQueueTransition("A bound job cannot move to another printer; retry it as a fresh queue job")
    with db.no_autoflush if session else nullcontext():
        outcome_condition = (table.c.physical_outcome.is_(None),) if confirmed else ()
        binding_condition = (
            (table.c.printer_id == item.printer_id,)
            if session and not isinstance(item, int) and item.printer_id is not None
            else ()
        )
        result = await db.execute(
            table.update()
            .where(
                table.c.id == item_id,
                table.c.status == expected_status,
                *conditions,
                *outcome_condition,
                *binding_condition,
            )
            .values(status=status, **metadata)
            .execution_options(autoflush=False)
        )
    if result.rowcount != 1:
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
    if expected_status != status or metadata.keys() & {"printer_id", "target_model", "target_location"}:
        from backend.app.services.lifecycle import effects

        effects.publish_queue_work_changed(db)
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
    before_outcome = getattr(change.item, "physical_outcome", None)
    after_outcome = change.values.get("physical_outcome", before_outcome)
    holding = is_physical_holding(change.before, before_outcome) or is_physical_holding(change.after, after_outcome)
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
        effects.publish_printer_view(
            db,
            row.printer_id,
            change.after,
            row.archive_id,
            physical_outcome=after_outcome,
        )
    # Auto Off is a job outcome, and only a printer-confirmed end can request
    # it. An unsent dispatch failure or an unconfirmed Stop is not proof that
    # the printer has finished this job.
    confirmed_end = (
        change.action == "printer_report"
        and change.before == change.after
        and change.values.get("physical_outcome") is not None
    )
    if after_outcome is not None and (
        (entered and change.after in ("finished", "failed", "cancelled")) or confirmed_end
    ):
        effects.queue_auto_off(change.db, change.item_id, row.printer_id)
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


async def lock_queue_items(
    db: AsyncSession,
    expected_printers: Mapping[int, int | None],
) -> dict[int, PrintQueueItem | None]:
    """Conditionally lock and refresh queue-edit targets in ID order.

    The conditional no-op UPDATE is a row lock on PostgreSQL and SQLite's write
    lock. Bulk queue edits retain this database safeguard until their callers
    use fully conditional queued/unbound writes. The printer predicate makes a
    changed assignment a conflict. Missing rows remain missing.
    """
    locked: dict[int, PrintQueueItem | None] = {}
    with db.no_autoflush:  # Pending work, such as an unlinked copy, stays unflushed until the caller's write.
        for item_id in sorted(expected_printers):
            expected_printer_id = expected_printers[item_id]
            effective_printer = func.coalesce(PrintQueueItem.printer_id, PrintQueueItem.assigned_printer_id)
            assigned = (
                effective_printer.is_(None) if expected_printer_id is None else effective_printer == expected_printer_id
            )
            result = await db.execute(
                update(PrintQueueItem)
                .where(PrintQueueItem.id == item_id, assigned)
                .values(id=PrintQueueItem.id)
                .execution_options(synchronize_session=False)
            )
            if result.rowcount != 1:
                current = await db.execute(
                    select(PrintQueueItem.id, effective_printer).where(PrintQueueItem.id == item_id)
                )
                row = current.first()
                if row is not None:
                    raise QueueTransitionConflict(f"Queue item {item_id} changed printers while it was being locked")
                locked[item_id] = None
                continue
            locked[item_id] = await db.get(PrintQueueItem, item_id, populate_existing=True)
    return locked


async def lock_queue_item(db: AsyncSession, item_id: int) -> PrintQueueItem | None:
    """Refresh one job under a database row lock; writes still use conditional transitions."""
    return await db.scalar(
        select(PrintQueueItem)
        .where(PrintQueueItem.id == item_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )


async def settle_replaced_hold(db: AsyncSession, held: PrintQueueItem, identity: str) -> bool:
    """End an old plate hold before adopting a different external print."""
    from backend.app.services.lifecycle.final import end

    if held.status not in AWAITING_PLATE_CLEAR_STATUSES or (held.status == "failed" and held.physical_outcome is None):
        return False
    reason = f"Plate hold released after external print {identity} replaced this job"
    message = f"{held.error_message}; {reason}" if held.error_message else reason
    await end(db, held, "external_replacement", error_message=message)
    return True


async def release_printer(db: AsyncSession, printer: Printer) -> None:
    """Release printer under the lifecycle transition rules."""
    async with writer(printer.id):
        await _release_printer_locked(db, printer)


async def _release_printer_locked(db: AsyncSession, printer: Printer) -> None:
    from backend.app.services.lifecycle.dispatching import is_soaking
    from backend.app.services.lifecycle.final import end
    from backend.app.services.printer_manager import printer_manager

    held = (
        PrintQueueItem.printer_id == printer.id,
        physical_holding_clause(PrintQueueItem.status, PrintQueueItem.physical_outcome),
    )
    holding = list(
        (await db.scalars(select(PrintQueueItem).where(*held).order_by(PrintQueueItem.id).with_for_update())).all()
    )
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

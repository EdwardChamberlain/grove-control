"""The print job lifecycle engine (#204): the transition table, its guards and the one conditional write.

Callers own the transaction; queued effects run only after it commits. The
holding index, not the printer view, is the reservation authority. Effects are
imported on use because their services import this module.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Mapping, Sequence
from contextlib import nullcontext
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import partial
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession
from sqlalchemy.orm.attributes import set_committed_value
from sqlalchemy.sql.elements import ColumnElement

from backend.app.models.print_queue import (
    ACTIVE_STATUSES,
    AWAITING_PLATE_CLEAR_STATUSES,
    FINAL_STATUSES,
    HOLDING_STATUSES,
    PrintQueueItem,
)

logger = logging.getLogger(__name__)

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


@dataclass(frozen=True)
class Decision:
    before: str
    after: str
    values: Mapping[str, Any]
    effect: Callable[[], object] | None = None
    conditions: Sequence[ColumnElement[bool]] = ()


async def apply_decision(
    db: AsyncSession,
    item: PrintQueueItem,
    decision: Decision,
    *,
    enter: Callable[[AsyncSession, PrintQueueItem], Awaitable[Decision | None]] | None = None,
) -> bool:
    """Commit a state's decision before entering it; entry returns its own next decision."""
    from backend.app.services.lifecycle import effects

    requested = decision.after
    while decision is not None:
        await transition_queue_item(
            db, item, decision.before, decision.after, values=decision.values, conditions=decision.conditions
        )
        if decision.effect is not None:
            effects.after_commit(db, decision.effect)
        await db.commit()
        if enter is None:
            return decision.after == requested
        decision, enter = await enter(db, item), None
    await db.rollback()
    return False


async def lock_queue_item(db: AsyncSession, item_id: int) -> PrintQueueItem | None:
    """Take a write lock on SQLite or PostgreSQL and discard stale ORM state."""
    with db.no_autoflush:
        result = await db.execute(
            update(PrintQueueItem)
            .where(PrintQueueItem.id == item_id)
            .values(id=PrintQueueItem.id)
            .execution_options(synchronize_session=False)
        )
        return await db.get(PrintQueueItem, item_id, populate_existing=True) if result.rowcount else None


# Only these actions may move a job out of an awaiting-plate-clear state.
_RELEASE_ACTIONS = ("clear_plate", "printer_deleted", "hold_transferred", "printer_report")


@dataclass(frozen=True)
class Transition:
    db: AsyncSession
    item: PrintQueueItem | int
    item_id: int
    before: str
    after: str
    action: str | None
    values: Mapping[str, Any]


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
        raise InvalidQueueTransition("Only printer deletion may release an active job")
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
    dispatch_guard: Callable[[], bool] | None = None,
) -> None:
    """Conditionally change a persisted item, or raise without writing it.

    Same-status writes (heat-soak handoffs, heater cleanup, recovered
    completions) still check the stored status. ``conditions`` fence dispatch
    claims; ``values`` change atomically with the status. Integer IDs let the
    legacy upgrade use its own connection. On conflict nothing is written or
    queued: the caller rolls back, or skips this item and continues. This never
    commits or rolls back, and ORM sync never flushes a second status UPDATE.
    Entry into dispatching reserves the printer before any file copy.
    """
    upgrading = migration and isinstance(db, AsyncConnection) and status in LEGACY_TRANSITIONS.get(expected_status, ())
    _check(expected_status, status, action, upgrading)
    confirmed = action == "printer_report"
    metadata = dict(values or {})
    if "status" in metadata or "id" in metadata:
        raise ValueError("Transition metadata cannot override status or id")
    if any(key.startswith("physical_") for key in metadata):
        raise ValueError("Physical outcomes are recorded only on entry to an awaiting-plate-clear state")
    item_id = item if isinstance(item, int) else item.id
    session = isinstance(db, AsyncSession)
    if session and expected_status != status:
        from backend.app.services.lifecycle.preheating import exit_values

        metadata.update(exit_values(expected_status, status, action, item))
    if status == "dispatching" and expected_status != status and not upgrading:
        if metadata.get("printer_id", item.printer_id if not isinstance(item, int) else None) is None:
            raise InvalidQueueTransition("Dispatch requires a selected printer")
    if session and (expected_status != status or confirmed):
        if status in AWAITING_PLATE_CLEAR_STATUSES and action != "cancel":
            await _record_physical_outcome(db, item_id, status, metadata, confirmed, archive_failure_reason)
    if dispatch_guard is not None and not dispatch_guard():
        raise QueueTransitionConflict("Printer is no longer available for dispatch")
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
        raise QueueTransitionConflict(f"Queue item {item_id} no longer matches expected status {expected_status}")
    if not isinstance(item, int):
        set_committed_value(item, "status", status)
        for key, value in metadata.items():
            set_committed_value(item, key, value)
    if session:
        await _written(Transition(db, item, item_id, expected_status, status, action, metadata))


async def _written(change: Transition) -> None:
    """Align the Archive attempt, queue the log and printer view, then enter the new state."""
    from backend.app.services.lifecycle import effects
    from backend.app.services.queue_archive import align_attempt

    db, table, entered = change.db, PrintQueueItem.__table__, change.before != change.after
    linked = change.values.keys() & {"archive_id", "dispatch_subtask_id"}
    if entered or linked or change.after in (*AWAITING_PLATE_CLEAR_STATUSES, *FINAL_STATUSES):
        await align_attempt(change)
    holding = change.before in HOLDING_STATUSES or change.after in HOLDING_STATUSES
    if not (entered or holding or change.action):
        return  # No log, printer view or entry step applies (e.g. a waiting reason).
    names = ("printer_id", "archive_id", "library_file_id", "preheat_requested_at", "chamber_heat_soak")
    row = (await db.execute(select(*(table.c[name] for name in names)).where(table.c.id == change.item_id))).one()
    if entered or change.action is not None:
        log = "Queue job %s: %s -> %s (printer=%s, archive=%s, action=%s)"
        args = (change.item_id, change.before, change.after, row.printer_id, row.archive_id, change.action)
        effects.after_commit(db, partial(logger.info, log, *args))
    if row.printer_id is not None and holding:
        effects.publish_printer_view(db, row.printer_id, change.after, row.archive_id)
    if entered and change.before == "preheating" and row.printer_id is not None:
        from backend.app.services.lifecycle.preheating import _show_preheating

        effects.after_commit(db, partial(_show_preheating, row.printer_id, False))
    for enter in _ENTRY.get(change.after, ()) if entered else ():
        await enter(change, row)


# State entry, in the caller's transaction. The physical outcome is written with
# the status; the other steps run after the write.


async def _record_physical_outcome(
    db: AsyncSession, item_id: int, status: str, metadata: dict, confirmed: bool, override: str | None
) -> None:
    """Capture facts before Clear Plate collapses them; no state decision reads them."""
    metadata.setdefault("completed_at", datetime.now(timezone.utc))
    reason = metadata.get("error_message")
    if reason is None:
        with db.no_autoflush:
            table = PrintQueueItem.__table__
            reason = await db.scalar(select(table.c.error_message).where(table.c.id == item_id))
    outcome = ARCHIVE_OUTCOMES[status]
    metadata.update(
        physical_outcome=outcome,
        physical_completed_at=datetime.now(timezone.utc) if confirmed else metadata["completed_at"],
        physical_failure_reason=physical_failure_reason(outcome, reason, override),
    )


async def _enter_failure(change: Transition, row) -> None:
    from backend.app.services.lifecycle import effects
    from backend.app.services.lifecycle.preheating import request_shutdown

    heating = await request_shutdown(change.db, row)
    unconfirmed = change.action != "printer_report"
    effect = effects.QueueOutcomeEffect(
        job_id=change.item_id,
        new_state=change.after,
        printer_id=row.printer_id,
        shut_down_heaters=heating,
        notify_failure=change.after == "failed" and change.before in ("preheating", "dispatching") and unconfirmed,
        clean_sd_copy=change.after == "failed" and change.before == "dispatching" and unconfirmed,
    )
    effects.queue_outcome_effect(change.db, effect)


async def _enter_finished(change: Transition, row) -> None:
    from backend.app.models.settings import Settings

    confirmation = await change.db.scalar(select(Settings.value).where(Settings.key == "require_plate_clear"))
    if confirmation is not None and confirmation.lower() in ("false", "0"):
        await clear_job_plate(change.db, change.item, automatic=True)


async def _enter_final(change: Transition, row) -> None:
    from backend.app.models.print_queue import PrintQueueVariant
    from backend.app.services.lifecycle import effects
    from backend.app.services.queue_source_cleanup import remove_queue_only_source_if_unused

    variants = select(PrintQueueVariant.library_file_id).where(PrintQueueVariant.queue_item_id == change.item_id)
    source_ids = {*await change.db.scalars(variants), row.library_file_id}
    for source_id in sorted(source_ids - {None}):
        await remove_queue_only_source_if_unused(change.db, source_id)
    if change.action == "clear_plate" and change.after == "unsuccessful":
        # The failed attempt's sent upload is removed once its plate is clear.
        effect = effects.QueueOutcomeEffect(
            job_id=change.item_id,
            new_state=change.after,
            printer_id=row.printer_id,
            shut_down_heaters=False,
            notify_failure=False,
            clean_sd_copy=True,
        )
        effects.queue_outcome_effect(change.db, effect)


_ENTRY = {
    "failed": (_enter_failure,),
    "cancelled": (_enter_failure,),
    "finished": (_enter_finished,),
    "successful": (_enter_final,),
    "unsuccessful": (_enter_final,),
}


async def clear_job_plate(db: AsyncSession, item: PrintQueueItem | int, *, automatic: bool = False) -> None:
    from backend.app.services.job_identity import printer_active

    if isinstance(item, int):
        item = await db.get(PrintQueueItem, item)
    if item is None or item.status not in AWAITING_PLATE_CLEAR_STATUSES:
        raise InvalidQueueTransition("This job is not awaiting plate clear")
    if printer_active(item.printer_id):
        if automatic:
            return  # Keep the physical outcome and hold if another print is already active.
        raise InvalidQueueTransition("The printer is still active. Stop or finish its print before clearing the plate")
    await transition_queue_item(
        db, item, item.status, "successful" if item.status == "finished" else "unsuccessful", action="clear_plate"
    )

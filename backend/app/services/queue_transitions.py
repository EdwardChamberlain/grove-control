"""The single conditional writer for the print job lifecycle (#194).

Callers own the transaction. Printer views are updated only after commit;
the holding index, rather than the view, is the reservation authority.
"""

from __future__ import annotations

import logging
import shutil
from collections.abc import Callable, Mapping, Sequence
from contextlib import nullcontext
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from sqlalchemy import event, inspect, select
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import set_committed_value
from sqlalchemy.sql.elements import ColumnElement

from backend.app.models.print_queue import ACTIVE_STATUSES, AWAITING_PLATE_CLEAR_STATUSES, HOLDING_STATUSES

if TYPE_CHECKING:
    from backend.app.models.archive import PrintArchive
    from backend.app.models.print_queue import PrintQueueItem


FINAL_STATUSES = ("successful", "unsuccessful")
ARCHIVE_OUTCOMES = {"finished": "completed", "failed": "failed", "cancelled": "aborted"}
logger = logging.getLogger(__name__)


def physical_failure_reason(outcome: str, error_message: str | None, override: str | None = None) -> str | None:
    if outcome == "failed":
        return (override or error_message or "Print failed")[:100]
    return "User cancelled" if outcome == "aborted" else None


ALLOWED_TRANSITIONS = {
    "queued": frozenset({"preheating", "dispatching", "failed", "unsuccessful"}),
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
    session.info.pop("queue_archive_artifacts", None)
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
    for directory in session.info.pop("queue_archive_artifacts", []):
        shutil.rmtree(directory, ignore_errors=True)
    session.info.pop("queue_printer_views", None)
    session.info.pop("queue_source_artifacts", None)


@event.listens_for(Session, "after_transaction_end")
def _discard_closed_transaction(session: Session, transaction) -> None:
    # Session.close() rolls back without the explicit after_rollback event.
    # Committed transactions already removed their pending data above.
    if transaction.parent is None:
        _discard_printer_views(session)


class InvalidQueueTransition(ValueError):
    """A caller requested an edge outside the current lifecycle."""


class QueueTransitionConflict(RuntimeError):
    """The expected row/status/claim no longer exists; abort this transaction."""


async def _link_legacy_archive_attempt(db: AsyncSession, row, previous_identity: str | None) -> bool:
    """Repair a proven active legacy link while the transition holds its job.

    A referenced Archive alone might be a reprint source. Require a still-active
    Archive with the same printer/run ID, and reject reused IDs or another exact
    attempt. The conditional Archive update serializes competing associations;
    its link and the physical outcome share the caller's commit or rollback.
    """
    from backend.app.models.archive import PrintArchive
    from backend.app.models.print_queue import PrintQueueItem
    from backend.app.services.job_identity import normalize_id

    current_identity = normalize_id(row.dispatch_subtask_id)
    identity = normalize_id(previous_identity) or current_identity
    if (
        row.archive_id is None
        or row.printer_id is None
        or identity is None
        or current_identity is None
        or (row.status not in ("dispatching", "printing", "paused") and row.physical_outcome is None)
    ):
        return False
    identities = {identity, current_identity}
    archives = PrintArchive.__table__
    other_archives = archives.alias("other_legacy_archives")
    other_jobs = PrintQueueItem.__table__.alias("other_legacy_jobs")
    with db.no_autoflush:
        result = await db.execute(
            archives.update()
            .where(
                archives.c.id == row.archive_id,
                archives.c.printer_id == row.printer_id,
                archives.c.subtask_id == identity,
                archives.c.dispatched_queue_item_id.is_(None),
                archives.c.status == "printing",
                archives.c.completed_at.is_(None),
                archives.c.deleted_at.is_(None),
                ~select(other_jobs.c.id)
                .where(
                    other_jobs.c.id != row.id,
                    other_jobs.c.printer_id == row.printer_id,
                    other_jobs.c.dispatch_subtask_id.in_(identities),
                )
                .exists(),
                ~select(other_archives.c.id)
                .where(
                    other_archives.c.id != row.archive_id,
                    other_archives.c.printer_id == row.printer_id,
                    other_archives.c.subtask_id.in_(identities),
                )
                .exists(),
                ~select(other_archives.c.id).where(other_archives.c.dispatched_queue_item_id == row.id).exists(),
            )
            .values(dispatched_queue_item_id=row.id, subtask_id=row.dispatch_subtask_id)
        )
    return result.rowcount == 1


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
    attempt: PrintArchive | None = None,
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
    time. Callers prepare any dispatch Archive before taking a write lock;
    a supplied attempt is flushed and linked only after the conditional update.
    Entry into dispatching requires this job's unflushed prepared attempt.
    An explicit copy failure can instead take a failed hold directly from
    queued; it never enters dispatching without an Archive.
    """
    from backend.app.models.print_queue import PrintQueueItem

    upgrading = migration and isinstance(db, AsyncConnection) and status in LEGACY_TRANSITIONS.get(expected_status, ())
    if not upgrading and (
        expected_status not in ALLOWED_TRANSITIONS
        or (status != expected_status and status not in ALLOWED_TRANSITIONS[expected_status])
    ):
        raise InvalidQueueTransition(f"Invalid queue transition: {expected_status} -> {status}")
    if not upgrading and status != expected_status:
        if (
            expected_status == "queued"
            and status == "failed"
            and (action != "archive_preparation_failed" or not (values or {}).get("error_message"))
        ):
            raise InvalidQueueTransition("Only an explicit Archive preparation failure may hold a queued job as failed")
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
    if any(key.startswith("physical_") for key in metadata):
        raise ValueError("Physical outcomes are recorded only on entry to an awaiting-plate-clear state")
    item_id = item if isinstance(item, int) else item.id

    table = PrintQueueItem.__table__
    previous_identity = None
    if isinstance(db, AsyncSession) and expected_status in ("printing", "paused") and "dispatch_subtask_id" in metadata:
        # A firmware ID can arrive after a session-local ID. Preserve the
        # proven old Archive identity until the job's conditional rebind wins.
        with db.no_autoflush:
            previous_identity = await db.scalar(
                select(table.c.dispatch_subtask_id).where(
                    table.c.id == item_id, table.c.status == expected_status, *conditions
                )
            )
    from backend.app.services.queue_archive import discard_prepared_archive

    archive = attempt
    if status == "dispatching" and expected_status != status:
        if not isinstance(db, AsyncSession) or archive is None:
            raise InvalidQueueTransition("Entry into dispatching requires a prepared Archive")
        printer_id = metadata.get("printer_id")
        if printer_id is None:
            if isinstance(item, int):
                with db.no_autoflush:
                    printer_id = await db.scalar(select(table.c.printer_id).where(table.c.id == item_id))
            else:
                printer_id = item.printer_id
        if (
            archive not in db
            or not inspect(archive).pending
            or archive.dispatched_queue_item_id != item_id
            or archive.printer_id != printer_id
            or archive.status != "dispatching"
            or archive.deleted_at is not None
            or not archive.file_path
        ):
            raise InvalidQueueTransition("Entry into dispatching requires this job's prepared Archive")
    if archive is not None and (
        not isinstance(db, AsyncSession) or status != "dispatching" or expected_status == status
    ):
        raise ValueError("A prepared Archive requires entry into dispatching on a session")
    if isinstance(db, AsyncSession) and expected_status != status:
        if status in AWAITING_PLATE_CLEAR_STATUSES:
            metadata.setdefault("completed_at", datetime.now(timezone.utc))
            # Capture facts before finalization collapses failed/cancelled into
            # unsuccessful. No state decision ever reads this projection.
            reason = metadata.get("error_message")
            if reason is None:
                with db.no_autoflush:
                    reason = await db.scalar(select(table.c.error_message).where(table.c.id == item_id))
            metadata.update(
                physical_outcome=ARCHIVE_OUTCOMES[status],
                physical_completed_at=metadata["completed_at"],
                physical_failure_reason=physical_failure_reason(
                    ARCHIVE_OUTCOMES[status], reason, archive_failure_reason
                ),
            )
    # SQLAlchemy 2.1 autoflushes Core statements regardless of their statement
    # execution options. Suppress it at the session boundary so a losing CAS
    # cannot flush stale metadata first. Startup repairs use AsyncConnection.
    if dispatch_guard is not None and not dispatch_guard():
        if isinstance(db, AsyncSession):
            discard_prepared_archive(db, archive)
        raise QueueTransitionConflict("Printer is no longer available after Archive preparation")
    with db.no_autoflush if isinstance(db, AsyncSession) else nullcontext():
        result = await db.execute(
            table.update()
            .where(table.c.id == item_id, table.c.status == expected_status, *conditions)
            .values(status=status, **metadata)
            .execution_options(autoflush=False)
        )
    if result.rowcount != 1:
        if isinstance(db, AsyncSession):
            discard_prepared_archive(db, archive)
        raise QueueTransitionConflict(f"Queue item {item_id} no longer matches expected status {expected_status}")
    if not isinstance(item, int):
        set_committed_value(item, "status", status)
        for key, value in metadata.items():
            set_committed_value(item, key, value)
    if isinstance(db, AsyncSession):
        if archive is not None:
            await db.flush()
            await db.execute(table.update().where(table.c.id == item_id).values(archive_id=archive.id))
            if not isinstance(item, int):
                set_committed_value(item, "archive_id", archive.id)
                # Existing loaded source relationships must follow the attempt.
                set_committed_value(item, "archive", archive)
        if (
            expected_status != status
            or "archive_id" in metadata
            or "dispatch_subtask_id" in metadata
            or status in (*AWAITING_PLATE_CLEAR_STATUSES, *FINAL_STATUSES)
        ):
            from backend.app.models.archive import PrintArchive as ArchiveModel

            # Only the exact attempt, never the Archive used as a reprint source.
            row = (await db.execute(select(table).where(table.c.id == item_id))).one()
            attempt = (
                await db.scalar(
                    select(ArchiveModel).where(
                        ArchiveModel.id == row.archive_id, ArchiveModel.dispatched_queue_item_id == item_id
                    )
                )
                if row.archive_id is not None
                else None
            )
            linked_legacy = attempt is None and await _link_legacy_archive_attempt(db, row, previous_identity)
            if linked_legacy:
                attempt = await db.scalar(
                    select(ArchiveModel)
                    .where(ArchiveModel.id == row.archive_id, ArchiveModel.dispatched_queue_item_id == item_id)
                    .execution_options(populate_existing=True)
                )
            if attempt is not None:
                attaching = "archive_id" in metadata or linked_legacy
                if status == "dispatching" and "dispatch_subtask_id" in metadata:
                    attempt.subtask_id = metadata["dispatch_subtask_id"]
                if (expected_status == "dispatching" and status == "printing") or (
                    attaching and status in ("printing", "paused")
                ):
                    attempt.status = "printing"
                    attempt.started_at = row.started_at or datetime.now(timezone.utc)
                if (status in AWAITING_PLATE_CLEAR_STATUSES and expected_status != status) or (
                    attaching and status in (*AWAITING_PLATE_CLEAR_STATUSES, *FINAL_STATUSES)
                ):
                    outcome = row.physical_outcome or ARCHIVE_OUTCOMES.get(status)
                    if outcome is None and status == "successful":
                        outcome = "completed"  # Unambiguous legacy final state.
                    if outcome is not None:
                        attempt.status = outcome
                        attempt.completed_at = row.physical_completed_at or row.completed_at
                        attempt.failure_reason = (
                            row.physical_failure_reason
                            if row.physical_outcome is not None
                            else physical_failure_reason(outcome, row.error_message)
                        )
                        if attaching and row.started_at is not None:
                            attempt.started_at = row.started_at
        if status in FINAL_STATUSES and expected_status != status:
            from backend.app.models.print_queue import PrintQueueVariant
            from backend.app.services.queue_source_cleanup import remove_queue_only_source_if_unused

            source_ids = set(
                await db.scalars(
                    select(PrintQueueVariant.library_file_id).where(PrintQueueVariant.queue_item_id == item_id)
                )
            )
            source_ids.add(row.library_file_id)
            for source_id in sorted(source_ids - {None}):
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

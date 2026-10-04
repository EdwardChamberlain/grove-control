"""Own every transition, transactional projection and effect registration."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timezone
from functools import partial
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from backend.app.models.print_queue import (
    AWAITING_PLATE_CLEAR_STATUSES,
    HOLDING_STATUSES,
    PrintQueueItem,
    PrintQueueVariant,
)
from backend.app.services.print_lifecycle.effects import after_commit, log_transition, publish_printer_view


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
    """Apply an edge or same-state repair; a conflict must discard the caller's observation."""
    from backend.app.services.queue_transitions import (
        ARCHIVE_OUTCOMES,
        FINAL_STATUSES,
        _write_transition,
        physical_failure_reason,
    )

    metadata = dict(values or {})
    if any(key.startswith("physical_") for key in metadata):
        raise ValueError("Physical outcomes are recorded only on entry to an awaiting-plate-clear state")
    item_id = item if isinstance(item, int) else item.id
    table = PrintQueueItem.__table__
    confirmed = action == "printer_report"
    if isinstance(db, AsyncSession) and (expected_status != status or confirmed):
        if status in AWAITING_PLATE_CLEAR_STATUSES and action != "cancel":
            metadata.setdefault("completed_at", datetime.now(timezone.utc))
            reason = metadata.get("error_message")
            if reason is None:
                with db.no_autoflush:
                    reason = await db.scalar(select(table.c.error_message).where(table.c.id == item_id))
            outcome = ARCHIVE_OUTCOMES[status]
            metadata.update(
                physical_outcome=outcome,
                physical_completed_at=datetime.now(timezone.utc) if confirmed else metadata["completed_at"],
                physical_failure_reason=physical_failure_reason(outcome, reason, archive_failure_reason),
            )
    await _write_transition(
        db,
        item,
        expected_status,
        status,
        metadata=metadata,
        conditions=conditions,
        action=action,
        migration=migration,
        dispatch_guard=dispatch_guard,
    )
    if not isinstance(db, AsyncSession):
        return
    project_archive = (
        expected_status != status
        or "archive_id" in metadata
        or "dispatch_subtask_id" in metadata
        or status in (*AWAITING_PLATE_CLEAR_STATUSES, *FINAL_STATUSES)
    )
    columns = (
        (table,)
        if project_archive
        else (table.c.printer_id, table.c.archive_id, table.c.preheat_requested_at, table.c.chamber_heat_soak)
    )
    row = (await db.execute(select(*columns).where(table.c.id == item_id))).one()
    if project_archive:
        from backend.app.services.queue_archive import sync_job_archive

        archive_id = await sync_job_archive(db, item, row, expected_status, status, metadata, confirmed)
    else:
        archive_id = row.archive_id
    if status in FINAL_STATUSES and expected_status != status:
        from backend.app.services.queue_source_cleanup import (
            remove_queue_only_artifacts,
            remove_queue_only_source_if_unused,
        )

        source_ids = set(
            await db.scalars(
                select(PrintQueueVariant.library_file_id).where(PrintQueueVariant.queue_item_id == item_id)
            )
        )
        source_ids.add(row.library_file_id)
        for source_id in sorted(source_ids - {None}):
            paths = await remove_queue_only_source_if_unused(db, source_id)
            after_commit(db, ("release", item_id, source_id), partial(remove_queue_only_artifacts, paths))
    if expected_status != status:
        log_transition(db, item_id, expected_status, status, row.printer_id, archive_id, action)
    clearing_failed_plate = action == "clear_plate" and status == "unsuccessful" and expected_status != status
    if (status in ("failed", "cancelled") and expected_status != status) or clearing_failed_plate:
        from backend.app.models.printer import Printer
        from backend.app.services.queue_outcome_effects import QueueOutcomeEffect, run_queue_outcome_effects

        heating = not clearing_failed_plate and (row.preheat_requested_at is not None or row.chamber_heat_soak)
        if heating and row.printer_id is not None:
            printer = await db.get(Printer, row.printer_id)
            if printer is not None:
                printer.heat_soak_shutdown_pending = True
                printer.heat_soak_shutdown_at = datetime.now(timezone.utc)
        effect = QueueOutcomeEffect(
            job_id=item_id,
            new_state=status,
            printer_id=row.printer_id,
            shut_down_heaters=heating,
            notify_failure=status == "failed" and expected_status in ("preheating", "dispatching") and not confirmed,
            clean_sd_copy=clearing_failed_plate
            or (status == "failed" and expected_status == "dispatching" and not confirmed),
        )
        after_commit(
            db, (status, "effects", item_id), partial(run_queue_outcome_effects, db.bind, effect), delivery="background"
        )
    if row.printer_id is not None and (expected_status in HOLDING_STATUSES or status in HOLDING_STATUSES):
        after_commit(db, ("view", row.printer_id), partial(publish_printer_view, row.printer_id, status, archive_id))
    if status == "finished" and expected_status != "finished":
        from backend.app.models.settings import Settings

        confirmation = await db.scalar(select(Settings.value).where(Settings.key == "require_plate_clear"))
        if confirmation is not None and confirmation.lower() in ("false", "0"):
            await clear_job_plate(db, item, automatic=True)


async def clear_job_plate(db: AsyncSession, item: PrintQueueItem | int, *, automatic: bool = False) -> None:
    from backend.app.services.queue_transitions import InvalidQueueTransition

    if isinstance(item, int):
        item = await db.get(PrintQueueItem, item)
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

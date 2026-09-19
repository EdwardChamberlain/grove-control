"""Authoritative durable lifecycle operations for user print jobs.

The existing physical ``print_queue`` table is the PrintJob store.  This
module deliberately keeps lifecycle state, printer reservation, operation
identity and evidence together so a late worker cannot affect a later print.
"""

import json
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.inspection import inspect

from backend.app.models.print_queue import (
    PrinterSafetyHold,
    PrintJobBinding,
    PrintJobEffect,
    PrintJobEvent,
    PrintJobQuarantinedEvent,
    PrintJobReservation,
    PrintQueueItem,
)

QUEUED = "queued"
HEAT_SOAKING = "heat_soaking"
DISPATCHING = "dispatching"
PRINTING = "printing"
COMPLETED = "completed"
FAILED = "failed"
CANCELLED = "cancelled"

ACTIVE_STATES = frozenset({HEAT_SOAKING, DISPATCHING, PRINTING})
TERMINAL_STATES = frozenset({COMPLETED, FAILED, CANCELLED})

STATUS_TO_LIFECYCLE = {
    "pending": QUEUED,
    "preheating": HEAT_SOAKING,
    "dispatching": DISPATCHING,
    "printing": PRINTING,
    "completed": COMPLETED,
    "failed": FAILED,
    "cancelled": CANCELLED,
    # A predecessor-failure skip is a scheduling gate, not a physical print
    # attempt. It remains queue-visible but is never a lifecycle terminal.
    "skipped": QUEUED,
    "aborted": CANCELLED,
}
LIFECYCLE_TO_STATUS = {
    QUEUED: "pending",
    HEAT_SOAKING: "preheating",
    DISPATCHING: "dispatching",
    PRINTING: "printing",
    COMPLETED: "completed",
    FAILED: "failed",
    CANCELLED: "cancelled",
}

ALLOWED_TRANSITIONS = {
    QUEUED: frozenset({HEAT_SOAKING, DISPATCHING, FAILED, CANCELLED}),
    HEAT_SOAKING: frozenset({QUEUED, DISPATCHING, FAILED, CANCELLED}),
    DISPATCHING: frozenset({QUEUED, PRINTING, COMPLETED, FAILED, CANCELLED}),
    PRINTING: frozenset({COMPLETED, FAILED, CANCELLED}),
    COMPLETED: frozenset(),
    FAILED: frozenset(),
    CANCELLED: frozenset(),
}


class LifecycleError(RuntimeError):
    """The requested change violates PrintJob lifecycle invariants."""


class StaleLifecycleVersion(LifecycleError):
    """Another worker changed the job while this worker was acting."""


class ReservationConflict(LifecycleError):
    """Another durable job owns this printer."""


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def new_operation_id() -> str:
    return str(uuid4())


def lifecycle_state(item: PrintQueueItem) -> str:
    """Return canonical state while tolerating rows created before migration."""
    return item.lifecycle_state or STATUS_TO_LIFECYCLE.get(item.status, QUEUED)


def _json(value: dict | None) -> str | None:
    return json.dumps(value, sort_keys=True, default=str) if value else None


async def admit_job(
    db: AsyncSession,
    item: PrintQueueItem,
    *,
    source: str = "queue_admission",
    evidence: dict | None = None,
) -> PrintJobEvent:
    """Assign identity and append immutable admission evidence for a new row."""
    if not item.job_id:
        item.job_id = str(uuid4())
    item.lifecycle_version = item.lifecycle_version or 0
    await db.flush()

    existing = await db.scalar(
        select(PrintJobEvent).where(
            PrintJobEvent.job_id == item.job_id,
            PrintJobEvent.event_type == "job_admitted",
        )
    )
    if existing:
        return existing

    # SQLAlchemy client defaults mean a raw legacy fixture (or an interrupted
    # upgrade) can present as ``lifecycle_state=queued`` alongside a legacy
    # active status. It has no admission evidence yet, so adopt the old status
    # once and establish the same reservation/op identity that migration does.
    legacy_state = STATUS_TO_LIFECYCLE.get(item.status, QUEUED)
    if not item.lifecycle_state or (item.lifecycle_state == QUEUED and legacy_state != QUEUED):
        item.lifecycle_state = legacy_state
    if item.lifecycle_state in ACTIVE_STATES:
        item.active_operation_id = item.active_operation_id or new_operation_id()
        await _assert_or_prepare_reservation(
            db,
            item,
            target_state=item.lifecycle_state,
            operation_id=item.active_operation_id,
            next_version=item.lifecycle_version,
        )
    if item.status != "skipped":
        item.status = LIFECYCLE_TO_STATUS[item.lifecycle_state]
    await db.flush()

    event = PrintJobEvent(
        job_id=item.job_id,
        queue_item_id=item.id,
        lifecycle_version=item.lifecycle_version,
        event_type="job_admitted",
        to_state=item.lifecycle_state,
        source=source,
        evidence_json=_json(evidence),
    )
    db.add(event)
    await db.flush()
    return event


async def _reservation_for_printer(db: AsyncSession, printer_id: int) -> PrintJobReservation | None:
    return await db.get(PrintJobReservation, printer_id)


async def _assert_or_prepare_reservation(
    db: AsyncSession,
    item: PrintQueueItem,
    *,
    target_state: str,
    operation_id: str | None,
    next_version: int,
) -> PrintJobReservation | None:
    if target_state not in ACTIVE_STATES:
        return None
    if item.printer_id is None:
        raise LifecycleError(f"Cannot enter {target_state} without a printer reservation")

    reservation = await _reservation_for_printer(db, item.printer_id)
    if reservation and reservation.job_id != item.job_id:
        raise ReservationConflict(f"Printer {item.printer_id} is reserved by job {reservation.job_id}")
    if reservation is None:
        reservation = PrintJobReservation(
            printer_id=item.printer_id,
            job_id=item.job_id,
            operation_id=operation_id,
            lifecycle_version=next_version,
        )
        db.add(reservation)
        await db.flush()
    return reservation


async def create_safety_hold(
    db: AsyncSession,
    *,
    printer_id: int,
    hold_type: str,
    job_id: str | None,
    operation_id: str | None,
    reason: str | None = None,
    evidence: dict | None = None,
) -> PrinterSafetyHold:
    """Persist a scheduling block before the related external safety action."""
    hold = PrinterSafetyHold(
        printer_id=printer_id,
        job_id=job_id,
        operation_id=operation_id,
        hold_type=hold_type,
        reason=reason,
        evidence_json=_json(evidence),
    )
    db.add(hold)
    await db.flush()
    return hold


async def transition_job(
    db: AsyncSession,
    item: PrintQueueItem,
    *,
    to_state: str,
    source: str,
    reason: str | None = None,
    evidence: dict | None = None,
    uncertainty_status: str | None = None,
    allow_pre_send_requeue: bool = False,
    allow_pre_send_terminal: bool = False,
    allow_missed_start_terminal: bool = False,
    physical_execution_observed: bool | None = None,
    safety_hold_type: str | None = None,
    resolve_safety_hold_types: tuple[str, ...] = (),
) -> PrintJobEvent:
    """Atomically transition a job, append evidence, and maintain reservation.

    The caller owns the transaction and commits only after its related state is
    durable.  Version compare-and-set is authoritative even on SQLite.
    """
    current = lifecycle_state(item)
    if to_state not in ALLOWED_TRANSITIONS.get(current, frozenset()):
        raise LifecycleError(f"Transition {current} -> {to_state} is not permitted")
    if current in TERMINAL_STATES:
        raise LifecycleError(f"Terminal job {item.job_id} cannot transition")
    if current == DISPATCHING and to_state == QUEUED:
        if not allow_pre_send_requeue or item.dispatch_attempted_at is not None:
            raise LifecycleError("Dispatching jobs may return to queued only before a possible command send")
    if current == DISPATCHING and to_state in TERMINAL_STATES:
        if item.dispatch_attempted_at is None and allow_pre_send_terminal:
            pass
        elif not allow_missed_start_terminal:
            raise LifecycleError("Direct terminal dispatch reconciliation requires strict attributed evidence")

    old_operation_id = item.active_operation_id
    entering_operation = to_state in {HEAT_SOAKING, DISPATCHING} and current != to_state
    operation_id = new_operation_id() if entering_operation else old_operation_id
    next_version = item.lifecycle_version + 1

    reservation = await _assert_or_prepare_reservation(
        db,
        item,
        target_state=to_state,
        operation_id=operation_id,
        next_version=next_version,
    )
    if safety_hold_type:
        if item.printer_id is None:
            raise LifecycleError("Cannot create a printer safety hold without a printer")
        await create_safety_hold(
            db,
            printer_id=item.printer_id,
            hold_type=safety_hold_type,
            job_id=item.job_id,
            operation_id=old_operation_id,
            reason=reason,
            evidence=evidence,
        )

    now = utcnow()
    values: dict[str, object] = {
        "lifecycle_state": to_state,
        "status": LIFECYCLE_TO_STATUS[to_state],
        "lifecycle_version": next_version,
        "active_operation_id": operation_id if to_state in ACTIVE_STATES else None,
        "terminal_reason": reason if to_state in TERMINAL_STATES else item.terminal_reason,
        "uncertainty_status": uncertainty_status,
        # Terminal PrintJobs remain durable audit/recovery records, but cease
        # to be queue-view candidates. A retry creates a new visible job.
        "queue_visible": False if to_state in TERMINAL_STATES else item.queue_visible,
    }
    if to_state in TERMINAL_STATES:
        values["completed_at"] = now
    if physical_execution_observed is not None:
        values["physical_execution_observed"] = physical_execution_observed
    elif to_state == PRINTING:
        values["physical_execution_observed"] = True

    result = await db.execute(
        update(PrintQueueItem)
        .where(
            PrintQueueItem.id == item.id,
            PrintQueueItem.lifecycle_version == item.lifecycle_version,
        )
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        raise StaleLifecycleVersion(f"Job {item.job_id} changed before {current} -> {to_state}")

    if reservation:
        reservation.operation_id = operation_id
        reservation.lifecycle_version = next_version
    if current in ACTIVE_STATES and to_state not in ACTIVE_STATES and item.printer_id is not None:
        current_reservation = await _reservation_for_printer(db, item.printer_id)
        if current_reservation and current_reservation.job_id == item.job_id:
            await db.delete(current_reservation)
        if resolve_safety_hold_types:
            await db.execute(
                update(PrinterSafetyHold)
                .where(
                    PrinterSafetyHold.printer_id == item.printer_id,
                    PrinterSafetyHold.job_id == item.job_id,
                    PrinterSafetyHold.operation_id == old_operation_id,
                    PrinterSafetyHold.hold_type.in_(resolve_safety_hold_types),
                    PrinterSafetyHold.state == "active",
                )
                .values(state="resolved", resolved_at=now)
            )

    event = PrintJobEvent(
        job_id=item.job_id,
        queue_item_id=item.id,
        operation_id=operation_id,
        lifecycle_version=next_version,
        event_type="lifecycle_transition",
        from_state=current,
        to_state=to_state,
        source=source,
        evidence_json=_json(evidence),
    )
    db.add(event)
    await db.flush()
    await db.refresh(item)
    return event


async def mark_job_uncertain(
    db: AsyncSession,
    item: PrintQueueItem,
    *,
    uncertainty_status: str,
    source: str,
    safety_hold_type: str,
    reason: str | None = None,
    evidence: dict | None = None,
) -> PrintJobEvent:
    """Record an unresolved external operation without inventing a transition.

    A stop or dispatch whose device outcome is unknown remains in its last
    meaningful lifecycle state, keeps its printer reservation, and acquires a
    durable scheduling hold before the external command is issued.
    """
    current = lifecycle_state(item)
    if current not in ACTIVE_STATES or item.printer_id is None or not item.active_operation_id:
        raise LifecycleError("Only an owned active job may become uncertain")

    next_version = item.lifecycle_version + 1
    await create_safety_hold(
        db,
        printer_id=item.printer_id,
        hold_type=safety_hold_type,
        job_id=item.job_id,
        operation_id=item.active_operation_id,
        reason=reason,
        evidence=evidence,
    )
    result = await db.execute(
        update(PrintQueueItem)
        .where(
            PrintQueueItem.id == item.id,
            PrintQueueItem.lifecycle_version == item.lifecycle_version,
            PrintQueueItem.lifecycle_state == current,
        )
        .values(lifecycle_version=next_version, uncertainty_status=uncertainty_status)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        raise StaleLifecycleVersion(f"Job {item.job_id} changed before uncertainty was recorded")
    reservation = await _reservation_for_printer(db, item.printer_id)
    if not reservation or reservation.job_id != item.job_id or reservation.operation_id != item.active_operation_id:
        raise ReservationConflict(f"Job {item.job_id} no longer owns printer {item.printer_id}")
    reservation.lifecycle_version = next_version
    event = PrintJobEvent(
        job_id=item.job_id,
        queue_item_id=item.id,
        operation_id=item.active_operation_id,
        lifecycle_version=next_version,
        event_type="operation_uncertain",
        from_state=current,
        to_state=current,
        source=source,
        evidence_json=_json(evidence),
    )
    db.add(event)
    await db.flush()
    await db.refresh(item)
    return event


async def mark_dispatch_attempted(
    db: AsyncSession,
    item: PrintQueueItem,
    *,
    source: str,
    evidence: dict | None = None,
) -> PrintJobEvent:
    """Persist the non-replayable print-command boundary before publishing it."""
    if lifecycle_state(item) != DISPATCHING:
        raise LifecycleError("Only dispatching jobs may cross the command-attempt boundary")
    if item.dispatch_attempted_at is not None:
        raise LifecycleError("Dispatch command was already attempted for this job")
    if not item.active_operation_id:
        raise LifecycleError("Dispatching job has no active operation identity")

    next_version = item.lifecycle_version + 1
    now = utcnow()
    result = await db.execute(
        update(PrintQueueItem)
        .where(
            PrintQueueItem.id == item.id,
            PrintQueueItem.lifecycle_version == item.lifecycle_version,
            PrintQueueItem.lifecycle_state == DISPATCHING,
            PrintQueueItem.dispatch_attempted_at.is_(None),
        )
        .values(dispatch_attempted_at=now, lifecycle_version=next_version)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        raise StaleLifecycleVersion(f"Dispatch boundary for {item.job_id} was already changed")
    if item.printer_id is not None:
        reservation = await _reservation_for_printer(db, item.printer_id)
        if not reservation or reservation.job_id != item.job_id or reservation.operation_id != item.active_operation_id:
            raise ReservationConflict(f"Job {item.job_id} no longer owns printer {item.printer_id}")
        reservation.lifecycle_version = next_version

    event = PrintJobEvent(
        job_id=item.job_id,
        queue_item_id=item.id,
        operation_id=item.active_operation_id,
        lifecycle_version=next_version,
        event_type="dispatch_command_attempted",
        from_state=DISPATCHING,
        to_state=DISPATCHING,
        source=source,
        evidence_json=_json(evidence),
    )
    db.add(event)
    await db.flush()
    await db.refresh(item)
    return event


async def operation_is_current(
    db: AsyncSession,
    *,
    item_id: int,
    job_id: str,
    operation_id: str,
    lifecycle_version: int,
) -> bool:
    """Check worker authority immediately before an external action."""
    item = await db.get(PrintQueueItem, item_id)
    if (
        not item
        or item.job_id != job_id
        or item.active_operation_id != operation_id
        or item.lifecycle_version != lifecycle_version
        or lifecycle_state(item) not in ACTIVE_STATES
        or item.printer_id is None
    ):
        return False
    reservation = await _reservation_for_printer(db, item.printer_id)
    return bool(
        reservation
        and reservation.job_id == job_id
        and reservation.operation_id == operation_id
        and reservation.lifecycle_version == lifecycle_version
    )


async def enqueue_effect(
    db: AsyncSession,
    *,
    job_id: str,
    operation_id: str | None,
    source_event_id: str,
    effect_type: str,
    delivery_policy: str,
    payload: dict | None = None,
) -> PrintJobEffect:
    """Insert a deduplicated durable effect for committed lifecycle evidence."""
    operation_key = operation_id or ""
    existing = await db.scalar(
        select(PrintJobEffect).where(
            PrintJobEffect.job_id == job_id,
            PrintJobEffect.operation_id == operation_key,
            PrintJobEffect.source_event_id == source_event_id,
            PrintJobEffect.effect_type == effect_type,
        )
    )
    if existing:
        return existing
    effect = PrintJobEffect(
        job_id=job_id,
        operation_id=operation_key,
        source_event_id=source_event_id,
        effect_type=effect_type,
        delivery_policy=delivery_policy,
        payload_json=_json(payload),
    )
    db.add(effect)
    await db.flush()
    return effect


async def claim_effect(
    db: AsyncSession,
    *,
    effect_id: str,
    lease_owner: str,
    lease_seconds: int = 60,
) -> PrintJobEffect | None:
    """Atomically lease a pending (or expired) effect to one delivery worker."""
    now = utcnow()
    lease_expires_at = now + timedelta(seconds=lease_seconds)
    result = await db.execute(
        update(PrintJobEffect)
        .where(PrintJobEffect.id == effect_id)
        .where(
            or_(
                PrintJobEffect.state == "pending",
                (PrintJobEffect.state == "processing")
                & (PrintJobEffect.lease_expires_at.is_not(None))
                & (PrintJobEffect.lease_expires_at < now),
            )
        )
        .values(
            state="processing",
            lease_owner=lease_owner,
            lease_expires_at=lease_expires_at,
            attempt_count=PrintJobEffect.attempt_count + 1,
            last_error=None,
        )
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        return None
    effect = await db.get(PrintJobEffect, effect_id)
    if effect is not None:
        await db.refresh(effect)
    return effect


async def complete_effect(db: AsyncSession, *, effect_id: str, lease_owner: str) -> bool:
    """Mark an effect delivered only for its current worker lease."""
    result = await db.execute(
        update(PrintJobEffect)
        .where(
            PrintJobEffect.id == effect_id,
            PrintJobEffect.state == "processing",
            PrintJobEffect.lease_owner == lease_owner,
        )
        .values(state="delivered", lease_owner=None, lease_expires_at=None, last_error=None)
        .execution_options(synchronize_session=False)
    )
    return result.rowcount == 1


async def fail_effect(
    db: AsyncSession,
    *,
    effect_id: str,
    lease_owner: str,
    error: str,
) -> bool:
    """Release a failed effect for a later idempotent retry."""
    result = await db.execute(
        update(PrintJobEffect)
        .where(
            PrintJobEffect.id == effect_id,
            PrintJobEffect.state == "processing",
            PrintJobEffect.lease_owner == lease_owner,
        )
        .values(state="pending", lease_owner=None, lease_expires_at=None, last_error=error)
        .execution_options(synchronize_session=False)
    )
    return result.rowcount == 1


async def effect_health(db: AsyncSession) -> dict[str, int | datetime | None]:
    """Return the small operational health surface for effect delivery."""
    now = utcnow()
    pending = await db.scalar(select(func.count(PrintJobEffect.id)).where(PrintJobEffect.state == "pending"))
    processing = await db.scalar(select(func.count(PrintJobEffect.id)).where(PrintJobEffect.state == "processing"))
    expired = await db.scalar(
        select(func.count(PrintJobEffect.id)).where(
            PrintJobEffect.state == "processing",
            PrintJobEffect.lease_expires_at.is_not(None),
            PrintJobEffect.lease_expires_at < now,
        )
    )
    oldest_pending = await db.scalar(
        select(func.min(PrintJobEffect.created_at)).where(PrintJobEffect.state == "pending")
    )
    return {
        "pending": pending or 0,
        "processing": processing or 0,
        "expired_leases": expired or 0,
        "oldest_pending_at": oldest_pending,
    }


async def purge_delivered_effects(db: AsyncSession, *, retention_days: int = 30) -> int:
    """Remove delivered effects only after the declared retention interval."""
    if retention_days < 0:
        raise ValueError("retention_days must not be negative")
    cutoff = utcnow() - timedelta(days=retention_days)
    result = await db.execute(
        delete(PrintJobEffect).where(
            PrintJobEffect.state == "delivered",
            PrintJobEffect.updated_at < cutoff,
        )
    )
    return result.rowcount or 0


async def bind_device_task(
    db: AsyncSession,
    *,
    item: PrintQueueItem,
    device_subtask_id: str,
    connection_epoch: str | None,
    event_sequence: int | None,
) -> PrintJobBinding:
    """Persist the immutable task-id generation that attributes device events."""
    if item.printer_id is None:
        raise LifecycleError("Cannot bind a device task without a printer")
    existing = await db.scalar(
        select(PrintJobBinding)
        .where(
            PrintJobBinding.job_id == item.job_id,
            PrintJobBinding.printer_id == item.printer_id,
            PrintJobBinding.device_subtask_id == device_subtask_id,
        )
        .order_by(PrintJobBinding.generation.desc())
    )
    if existing:
        existing.last_connection_epoch = connection_epoch
        existing.last_event_sequence = event_sequence
        return existing

    max_generation = await db.scalar(
        select(func.max(PrintJobBinding.generation)).where(
            PrintJobBinding.printer_id == item.printer_id,
            PrintJobBinding.device_subtask_id == device_subtask_id,
        )
    )
    binding = PrintJobBinding(
        job_id=item.job_id,
        printer_id=item.printer_id,
        device_subtask_id=device_subtask_id,
        generation=(max_generation or 0) + 1,
        first_connection_epoch=connection_epoch,
        last_connection_epoch=connection_epoch,
        first_event_sequence=event_sequence,
        last_event_sequence=event_sequence,
    )
    db.add(binding)
    await db.flush()
    return binding


async def resolve_job_for_device_event(
    db: AsyncSession,
    *,
    printer_id: int,
    device_subtask_id: str | None,
    permitted_states: tuple[str, ...] = tuple(ACTIVE_STATES),
) -> PrintQueueItem | None:
    """Resolve a device event only from persisted device-task identity.

    A filename is content metadata, not print identity, and same-connection
    causality is only valid when a caller supplies durable connection sequence
    evidence.  Until that evidence exists, an event without a usable task id
    stays unowned.  Multiple matches are deliberately ambiguous.
    """
    task_id = str(device_subtask_id).strip() if device_subtask_id is not None else ""
    if not task_id or task_id == "0":
        return None
    result = await db.execute(
        select(PrintQueueItem)
        .outerjoin(PrintJobBinding, PrintJobBinding.job_id == PrintQueueItem.job_id)
        .where(PrintQueueItem.printer_id == printer_id)
        .where(PrintQueueItem.lifecycle_state.in_(permitted_states))
        .where(
            or_(
                PrintJobBinding.device_subtask_id == task_id,
                PrintQueueItem.dispatch_subtask_id == task_id,
            )
        )
        .distinct()
    )
    matches = list(result.scalars().all())
    return matches[0] if len(matches) == 1 else None


async def quarantine_device_event(
    db: AsyncSession,
    *,
    printer_id: int,
    event_type: str,
    device_subtask_id: str | None,
    reason: str,
    evidence: dict | None = None,
) -> PrintJobQuarantinedEvent:
    """Record an unowned device event once for later operator resolution."""
    correlation_key = str(device_subtask_id).strip() if device_subtask_id is not None else "missing-task-id"
    existing = await db.scalar(
        select(PrintJobQuarantinedEvent).where(
            PrintJobQuarantinedEvent.printer_id == printer_id,
            PrintJobQuarantinedEvent.event_type == event_type,
            PrintJobQuarantinedEvent.correlation_key == correlation_key,
        )
    )
    if existing:
        return existing
    event = PrintJobQuarantinedEvent(
        printer_id=printer_id,
        event_type=event_type,
        correlation_key=correlation_key,
        reason=reason,
        evidence_json=_json(evidence),
    )
    db.add(event)
    await db.flush()
    return event


async def adopt_observed_user_print(
    db: AsyncSession,
    *,
    printer_id: int,
    device_subtask_id: str | None,
    evidence: dict | None = None,
) -> PrintQueueItem | None:
    """Adopt a user-started physical print without inventing content identity.

    A device task ID proves the observed execution. If Grove already owns that
    ID, the existing job is returned. If another job reserves the printer or
    the printer omitted its task ID, record a quarantined event instead of
    attaching the print to an arbitrary archive or queue item.
    """
    task_id = str(device_subtask_id).strip() if device_subtask_id is not None else ""
    existing = await resolve_job_for_device_event(
        db,
        printer_id=printer_id,
        device_subtask_id=task_id,
        permitted_states=tuple(ACTIVE_STATES),
    )
    if existing:
        return existing
    if not task_id or task_id == "0":
        await quarantine_device_event(
            db,
            printer_id=printer_id,
            event_type="observed_print_start",
            device_subtask_id=None,
            reason="Cannot adopt an out-of-band print without device task identity",
            evidence=evidence,
        )
        return None
    if await _reservation_for_printer(db, printer_id):
        await quarantine_device_event(
            db,
            printer_id=printer_id,
            event_type="observed_print_start",
            device_subtask_id=task_id,
            reason="Printer is reserved by a different PrintJob",
            evidence=evidence,
        )
        return None

    item = PrintQueueItem(
        printer_id=printer_id,
        status=LIFECYCLE_TO_STATUS[PRINTING],
        lifecycle_state=PRINTING,
        queue_visible=False,
        dispatch_subtask_id=task_id,
        physical_execution_observed=True,
    )
    db.add(item)
    event = await admit_job(db, item, source="out_of_band_print_adoption", evidence=evidence)
    await bind_device_task(
        db,
        item=item,
        device_subtask_id=task_id,
        connection_epoch=None,
        event_sequence=None,
    )
    db.add(
        PrintJobEvent(
            job_id=item.job_id,
            queue_item_id=item.id,
            operation_id=item.active_operation_id,
            lifecycle_version=item.lifecycle_version,
            event_type="observed_print_adopted",
            to_state=PRINTING,
            source="out_of_band_print_adoption",
            evidence_json=_json({"admission_event_id": event.id, **(evidence or {})}),
        )
    )
    await db.flush()
    return item


async def create_retry_job(
    db: AsyncSession,
    item: PrintQueueItem,
    *,
    source: str,
    evidence: dict | None = None,
) -> PrintQueueItem:
    """Create a fresh attempt instead of ever rewinding a terminal PrintJob."""
    if lifecycle_state(item) not in TERMINAL_STATES:
        raise LifecycleError("Only a terminal PrintJob may be retried")
    if item.dispatch_attempted_at is None and not item.physical_execution_observed:
        raise LifecycleError("Only a dispatched PrintJob may be retried as a new attempt")

    reset = {
        "id",
        "job_id",
        "previous_job_id",
        "lifecycle_state",
        "lifecycle_version",
        "uncertainty_status",
        "terminal_reason",
        "queue_visible",
        "active_operation_id",
        "dispatch_attempted_at",
        "physical_execution_observed",
        "status",
        "dispatching_at",
        "dispatched_at",
        "dispatch_subtask_id",
        "started_at",
        "completed_at",
        "error_message",
        "preheat_owner",
        "preheat_requested_at",
        "preheat_checked_at",
        "preheat_started_at",
        "gate_acknowledged",
        "filament_short",
        "created_at",
    }
    copied = {
        column.name: getattr(item, column.name)
        for column in inspect(PrintQueueItem).columns
        if column.name not in reset
    }
    retry = PrintQueueItem(
        **copied,
        previous_job_id=item.job_id,
        status=LIFECYCLE_TO_STATUS[QUEUED],
        lifecycle_state=QUEUED,
        lifecycle_version=0,
        queue_visible=True,
    )
    db.add(retry)
    await admit_job(
        db,
        retry,
        source=source,
        evidence={"previous_job_id": item.job_id, **(evidence or {})},
    )
    return retry

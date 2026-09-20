"""Authoritative durable lifecycle operations for user print jobs.

The existing physical ``print_queue`` table is the PrintJob store.  This
module deliberately keeps lifecycle state, printer reservation, operation
identity and evidence together so a late worker cannot affect a later print.
"""

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError
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
from backend.app.models.printer import Printer

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


@dataclass(frozen=True)
class TerminalResolution:
    """The only authority result permitted to start terminal consequences."""

    resolved: bool
    changed: bool
    job_id: str | None = None
    queue_item_id: int | None = None
    archive_id: int | None = None
    owner_id: int | None = None
    auto_off_after: bool = False
    status: str | None = None
    effect_id: str | None = None
    reason: str | None = None
    physical_execution_observed: bool = False
    plate_id: int | None = None
    ams_mapping: list[int] | None = None


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


def _terminal_state(status: str) -> tuple[str, str] | None:
    normalized = (status or "completed").lower()
    if normalized == "aborted":
        normalized = "cancelled"
    state = {
        "completed": COMPLETED,
        "failed": FAILED,
        "cancelled": CANCELLED,
    }.get(normalized)
    return (normalized, state) if state else None


async def settle_terminal_event(
    db: AsyncSession,
    *,
    printer_id: int,
    status: str,
    device_subtask_id: str | None,
    connection_epoch: str | None,
    event_sequence: int | None,
    evidence: dict | None,
    effect_payload: dict | None,
    user_stopped_job_id: str | None = None,
) -> TerminalResolution:
    """Attribute and commit one terminal device event.

    This is the single entry point from which identity-sensitive completion
    work may proceed.  It refuses filename/name inference, preserves the last
    meaningful state when attribution is uncertain, and creates the durable
    consequence before returning to the caller.
    """
    terminal = _terminal_state(status)
    if terminal is None:
        return TerminalResolution(resolved=False, changed=False, reason="not_terminal")
    normalized_status, target_state = terminal
    task_id = str(device_subtask_id).strip() if device_subtask_id is not None else ""
    if task_id in {"", "0"}:
        task_id = None

    item = await resolve_job_for_device_event(
        db,
        printer_id=printer_id,
        device_subtask_id=task_id,
        connection_epoch=connection_epoch,
        event_sequence=event_sequence,
        permitted_states=(DISPATCHING, PRINTING),
    )
    if item is None:
        # A retransmitted terminal event may arrive after the transition has
        # committed.  Resolve it only by the same strong task/connection
        # evidence and reuse the already-created effect; never append a new
        # transition or quarantine a harmless duplicate.
        terminal_item = await resolve_job_for_device_event(
            db,
            printer_id=printer_id,
            device_subtask_id=task_id,
            connection_epoch=connection_epoch,
            event_sequence=event_sequence,
            permitted_states=tuple(TERMINAL_STATES),
        )
        if terminal_item is not None:
            existing_effect = await db.scalar(
                select(PrintJobEffect)
                .where(
                    PrintJobEffect.job_id == terminal_item.job_id,
                    PrintJobEffect.effect_type == "terminal_consequences",
                )
                .order_by(PrintJobEffect.created_at.desc())
            )
            if existing_effect is not None:
                durable_mapping = None
                if terminal_item.ams_mapping:
                    try:
                        parsed_mapping = json.loads(terminal_item.ams_mapping)
                    except (TypeError, ValueError):
                        parsed_mapping = None
                    if isinstance(parsed_mapping, list):
                        durable_mapping = parsed_mapping
                await db.commit()
                return TerminalResolution(
                    resolved=True,
                    changed=False,
                    job_id=terminal_item.job_id,
                    queue_item_id=terminal_item.id,
                    archive_id=terminal_item.archive_id,
                    owner_id=terminal_item.created_by_id,
                    auto_off_after=terminal_item.auto_off_after,
                    status=normalized_status,
                    effect_id=existing_effect.id,
                    physical_execution_observed=terminal_item.physical_execution_observed,
                    plate_id=terminal_item.plate_id,
                    ams_mapping=durable_mapping,
                )
        await quarantine_device_event(
            db,
            printer_id=printer_id,
            event_type="terminal_print_event",
            device_subtask_id=task_id,
            connection_epoch=connection_epoch,
            event_sequence=event_sequence,
            reason=("No unique durable PrintJob binding or same-connection sequence for terminal device event"),
            evidence=evidence,
        )
        await db.commit()
        return TerminalResolution(resolved=False, changed=False, reason="ambiguous_device_identity")

    current = lifecycle_state(item)
    # A queue stop is recorded against the durable job before the external
    # command.  If the printer reports the expected failed/aborted terminal
    # status, resolve that uncertainty as a user cancellation without using a
    # printer-wide flag that could belong to a later job.
    if (
        user_stopped_job_id == item.job_id or item.uncertainty_status == "stop_resolution_pending"
    ) and normalized_status in ("failed", "aborted"):
        normalized_status, target_state = "cancelled", CANCELLED
    if current == DISPATCHING:
        # A task-id match is necessary but not sufficient for a missed-start
        # reconciliation.  The immutable binding proves Grove minted this task
        # and crossed the dispatch boundary for this exact PrintJob.
        binding_result = await db.execute(
            select(PrintJobBinding)
            .where(
                PrintJobBinding.job_id == item.job_id,
                PrintJobBinding.printer_id == printer_id,
                *([PrintJobBinding.device_subtask_id == task_id] if task_id else []),
                *(
                    [PrintJobBinding.last_connection_epoch == connection_epoch]
                    if connection_epoch and not task_id
                    else []
                ),
                *(
                    [PrintJobBinding.last_event_sequence <= event_sequence]
                    if event_sequence is not None and not task_id
                    else []
                ),
            )
            .order_by(PrintJobBinding.generation.desc())
        )
        bindings = list(binding_result.scalars().all())
        binding = bindings[0] if len(bindings) == 1 else None
        if item.dispatch_attempted_at is None or binding is None:
            await quarantine_device_event(
                db,
                printer_id=printer_id,
                event_type="terminal_print_event",
                device_subtask_id=task_id,
                connection_epoch=connection_epoch,
                event_sequence=event_sequence,
                reason="Dispatch terminal event lacks strict command-attempt binding",
                evidence=evidence,
            )
            await db.commit()
            return TerminalResolution(resolved=False, changed=False, reason="missing_dispatch_binding")

    changed = current != target_state
    physical_observed = current == PRINTING or bool((evidence or {}).get("physical_execution_observed"))
    event: PrintJobEvent | None = None
    if changed:
        event = await transition_job(
            db,
            item,
            to_state=target_state,
            source="mqtt_terminal_event",
            evidence={**(evidence or {}), "connection_epoch": connection_epoch},
            # A terminal device event with the exact Grove task binding can
            # reconcile a dispatch where the start push was missed. The
            # terminal device observation is itself evidence that execution
            # reached the printer, even though the start callback was missed.
            allow_missed_start_terminal=current == DISPATCHING,
            physical_execution_observed=physical_observed,
            resolve_safety_hold_types=("dispatch_resolution", "stop_resolution"),
        )
        if normalized_status == "failed" and not item.error_message:
            item.error_message = (evidence or {}).get("error_message")
    else:
        # A duplicate callback must find the already-created effect.  No second
        # lifecycle event or Print Log projection is allowed.
        event = await db.scalar(
            select(PrintJobEvent)
            .where(PrintJobEvent.job_id == item.job_id)
            .where(PrintJobEvent.event_type == "lifecycle_transition")
            .where(PrintJobEvent.to_state == target_state)
            .order_by(PrintJobEvent.created_at.desc())
        )

    if event is None:
        await db.rollback()
        return TerminalResolution(resolved=False, changed=False, reason="missing_terminal_event")

    effect = await db.scalar(
        select(PrintJobEffect)
        .where(
            PrintJobEffect.job_id == item.job_id,
            PrintJobEffect.effect_type == "terminal_consequences",
        )
        .order_by(PrintJobEffect.created_at.desc())
    )
    if effect is None:
        durable_payload = dict(effect_payload or {})
        # Persist the lifecycle-resolved status, not the raw firmware status.
        # In particular, an exact-job user stop resolves a firmware
        # ``failed``/``aborted`` report as ``cancelled`` and recovery must see
        # the same consequence after a process restart.
        durable_payload["status"] = normalized_status
        if "plate_id" not in durable_payload and item.plate_id is not None:
            durable_payload["plate_id"] = item.plate_id
        if "ams_mapping" not in durable_payload and item.ams_mapping:
            try:
                parsed_mapping = json.loads(item.ams_mapping)
            except (TypeError, ValueError):
                parsed_mapping = None
            if isinstance(parsed_mapping, list):
                durable_payload["ams_mapping"] = parsed_mapping
        effect = await enqueue_effect(
            db,
            job_id=item.job_id,
            operation_id=event.operation_id,
            source_event_id=event.id,
            effect_type="terminal_consequences",
            delivery_policy="idempotent_retry",
            payload=durable_payload,
        )

    if changed and item.printer_id is not None:
        # The boolean and ownership ID are one database projection of the
        # committed terminal transition.  The in-memory manager projection is
        # refreshed by the caller only after this commit succeeds.
        await db.execute(
            update(Printer)
            .where(Printer.id == item.printer_id)
            .values(
                awaiting_plate_clear=True,
                awaiting_plate_clear_archive_id=item.archive_id,
                awaiting_plate_clear_job_id=item.job_id,
            )
        )

    durable_mapping = None
    if item.ams_mapping:
        try:
            parsed_mapping = json.loads(item.ams_mapping)
        except (TypeError, ValueError):
            parsed_mapping = None
        if isinstance(parsed_mapping, list):
            durable_mapping = parsed_mapping

    await db.commit()
    return TerminalResolution(
        resolved=True,
        changed=changed,
        job_id=item.job_id,
        queue_item_id=item.id,
        archive_id=item.archive_id,
        owner_id=item.created_by_id,
        auto_off_after=item.auto_off_after,
        status=normalized_status,
        effect_id=effect.id,
        physical_execution_observed=item.physical_execution_observed,
        plate_id=item.plate_id,
        ams_mapping=durable_mapping,
    )


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
        .where(
            PrintJobEffect.state != "dead_letter",
            or_(PrintJobEffect.next_attempt_at.is_(None), PrintJobEffect.next_attempt_at <= now),
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
        .values(
            state="delivered",
            lease_owner=None,
            lease_expires_at=None,
            next_attempt_at=None,
            last_error=None,
        )
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
    """Retry with bounded backoff, then retain a dead-lettered consequence."""
    effect = await db.get(PrintJobEffect, effect_id)
    if effect is None or effect.state != "processing" or effect.lease_owner != lease_owner:
        return False
    now = utcnow()
    if effect.attempt_count >= 10:
        values = {
            "state": "dead_letter",
            "lease_owner": None,
            "lease_expires_at": None,
            "dead_lettered_at": now,
            "next_attempt_at": None,
            "last_error": error,
        }
    else:
        delay_seconds = min(3600, 2 ** max(0, effect.attempt_count - 1))
        values = {
            "state": "pending",
            "lease_owner": None,
            "lease_expires_at": None,
            "next_attempt_at": now + timedelta(seconds=delay_seconds),
            "last_error": error,
        }
    result = await db.execute(
        update(PrintJobEffect)
        .where(
            PrintJobEffect.id == effect_id,
            PrintJobEffect.state == "processing",
            PrintJobEffect.lease_owner == lease_owner,
        )
        .values(**values)
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
    dead_letter = await db.scalar(select(func.count(PrintJobEffect.id)).where(PrintJobEffect.state == "dead_letter"))
    oldest_pending = await db.scalar(
        select(func.min(PrintJobEffect.created_at)).where(PrintJobEffect.state == "pending")
    )
    return {
        "pending": pending or 0,
        "processing": processing or 0,
        "expired_leases": expired or 0,
        "dead_letter": dead_letter or 0,
        "oldest_pending_at": oldest_pending,
    }


async def purge_delivered_effects(db: AsyncSession, *, retention_days: int = 30) -> int:
    """Remove delivered effects only after the declared retention interval."""
    if retention_days < 0:
        raise ValueError("retention_days must not be negative")
    cutoff = utcnow() - timedelta(days=retention_days)
    result = await db.execute(
        delete(PrintJobEffect).where(
            PrintJobEffect.state.in_(["delivered", "dead_letter"]),
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
    connection_epoch: str | None = None,
    event_sequence: int | None = None,
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
        # Same-connection causality is a deliberately narrow fallback: both
        # the connection epoch and an ordered device event sequence must be
        # present, and exactly one active job may carry that evidence.
        if not connection_epoch or event_sequence is None:
            return None
        fallback = (
            select(PrintQueueItem)
            .join(PrintJobBinding, PrintJobBinding.job_id == PrintQueueItem.job_id)
            .where(
                PrintQueueItem.printer_id == printer_id,
                PrintQueueItem.lifecycle_state.in_(permitted_states),
                PrintJobBinding.last_connection_epoch == connection_epoch,
                PrintJobBinding.last_event_sequence.is_not(None),
                PrintJobBinding.last_event_sequence <= event_sequence,
            )
        )
        matches = list((await db.execute(fallback)).scalars().all())
        return matches[0] if len(matches) == 1 else None
    # A usable device task ID is the primary identity evidence. It survives a
    # Grove reconnect, so do not additionally require the event to carry the
    # connection epoch or sequence in which the command was originally sent.
    # Those fields are only the fallback causality proof when the device omits
    # its task ID below.
    query = (
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
    )
    result = await db.execute(query.distinct())
    matches = list(result.scalars().all())
    return matches[0] if len(matches) == 1 else None


async def quarantine_device_event(
    db: AsyncSession,
    *,
    printer_id: int,
    event_type: str,
    device_subtask_id: str | None,
    connection_epoch: str | None = None,
    event_sequence: int | None = None,
    reason: str,
    evidence: dict | None = None,
) -> PrintJobQuarantinedEvent:
    """Record one unowned device event for later operator resolution.

    Missing task IDs are not collapsed into one permanent bucket: without a
    device identity each observation is separate evidence and must remain
    reviewable.
    """
    task_id = str(device_subtask_id).strip() if device_subtask_id is not None else ""
    if task_id in {"", "0"}:
        correlation_key = f"missing-task-id:{uuid4()}"
    else:
        correlation_key = f"task:{task_id}:epoch:{connection_epoch or 'unknown'}:sequence:{event_sequence or 'unknown'}"
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
    connection_epoch: str | None = None,
    event_sequence: int | None = None,
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
        connection_epoch=connection_epoch,
        event_sequence=event_sequence,
        permitted_states=tuple(ACTIVE_STATES | TERMINAL_STATES | {QUEUED}),
    )
    if existing:
        if lifecycle_state(existing) in ACTIVE_STATES:
            return existing
        await quarantine_device_event(
            db,
            printer_id=printer_id,
            event_type="observed_print_start",
            device_subtask_id=task_id,
            connection_epoch=connection_epoch,
            event_sequence=event_sequence,
            reason="Device task identity is already attributed to a non-active PrintJob",
            evidence=evidence,
        )
        return None
    if not task_id or task_id == "0":
        await quarantine_device_event(
            db,
            printer_id=printer_id,
            event_type="observed_print_start",
            device_subtask_id=None,
            connection_epoch=connection_epoch,
            event_sequence=event_sequence,
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
            connection_epoch=connection_epoch,
            event_sequence=event_sequence,
            reason="Printer is reserved by a different PrintJob",
            evidence=evidence,
        )
        return None

    try:
        # The reservation primary key is the final concurrent-adoption fence.
        # Keep the speculative insert inside a savepoint so a second start
        # callback can recover the committed winner without poisoning the
        # caller's transaction.
        async with db.begin_nested():
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
                connection_epoch=connection_epoch,
                event_sequence=event_sequence,
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
    except IntegrityError:
        existing = await resolve_job_for_device_event(
            db,
            printer_id=printer_id,
            device_subtask_id=task_id,
            connection_epoch=connection_epoch,
            event_sequence=event_sequence,
            permitted_states=tuple(ACTIVE_STATES),
        )
        if existing is not None:
            return existing
        await quarantine_device_event(
            db,
            printer_id=printer_id,
            event_type="observed_print_start",
            device_subtask_id=task_id,
            connection_epoch=connection_epoch,
            event_sequence=event_sequence,
            reason="Concurrent physical print adoption lost the durable reservation race",
            evidence=evidence,
        )
        return None


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

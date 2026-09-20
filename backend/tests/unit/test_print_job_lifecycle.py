"""Focused invariants for Issue #168's durable PrintJob lifecycle."""

from datetime import timedelta

import pytest
from sqlalchemy import select, update

from backend.app.models.print_queue import (
    PrinterSafetyHold,
    PrintJobEffect,
    PrintJobEvent,
    PrintJobQuarantinedEvent,
    PrintJobReservation,
    PrintQueueItem,
)
from backend.app.models.printer import Printer
from backend.app.services.print_job_lifecycle import (
    CANCELLED,
    COMPLETED,
    DISPATCHING,
    HEAT_SOAKING,
    QUEUED,
    LifecycleError,
    ReservationConflict,
    StaleLifecycleVersion,
    admit_job,
    adopt_observed_user_print,
    bind_device_task,
    claim_effect,
    complete_effect,
    create_retry_job,
    effect_health,
    enqueue_effect,
    fail_effect,
    mark_dispatch_attempted,
    mark_job_uncertain,
    operation_is_current,
    purge_delivered_effects,
    quarantine_device_event,
    resolve_job_for_device_event,
    resolve_uncertain_job,
    settle_terminal_event,
    transition_job,
)


async def _item(db_session, *, printer_id: int | None = 1) -> PrintQueueItem:
    if printer_id is not None and await db_session.get(Printer, printer_id) is None:
        db_session.add(
            Printer(
                id=printer_id,
                name=f"Printer {printer_id}",
                serial_number=f"TEST-{printer_id}",
                ip_address="127.0.0.1",
                access_code="12345678",
                model="H2D",
            )
        )
    item = PrintQueueItem(printer_id=printer_id, status="pending")
    db_session.add(item)
    await admit_job(db_session, item)
    return item


@pytest.mark.asyncio
async def test_admission_assigns_one_durable_identity_and_event(db_session):
    item = await _item(db_session, printer_id=None)

    assert item.job_id
    assert item.lifecycle_state == QUEUED
    assert item.status == "pending"
    assert item.lifecycle_version == 0
    events = list((await db_session.scalars(select(PrintJobEvent).where(PrintJobEvent.job_id == item.job_id))).all())
    assert [(event.event_type, event.to_state) for event in events] == [("job_admitted", QUEUED)]

    second = await admit_job(db_session, item)
    assert second.id == events[0].id


@pytest.mark.asyncio
async def test_each_heat_soak_entry_has_a_new_fenced_operation_and_reservation(db_session):
    item = await _item(db_session)

    await transition_job(db_session, item, to_state=HEAT_SOAKING, source="test")
    first_operation = item.active_operation_id
    assert first_operation
    assert await operation_is_current(
        db_session,
        item_id=item.id,
        job_id=item.job_id,
        operation_id=first_operation,
        lifecycle_version=item.lifecycle_version,
    )

    await transition_job(db_session, item, to_state=QUEUED, source="test", reason="heater_stopped")
    assert item.active_operation_id is None
    assert await db_session.get(PrintJobReservation, item.printer_id) is None

    await transition_job(db_session, item, to_state=HEAT_SOAKING, source="test")
    assert item.active_operation_id and item.active_operation_id != first_operation
    assert not await operation_is_current(
        db_session,
        item_id=item.id,
        job_id=item.job_id,
        operation_id=first_operation,
        lifecycle_version=item.lifecycle_version - 1,
    )


@pytest.mark.asyncio
async def test_one_printer_has_one_durable_execution_reservation(db_session):
    first = await _item(db_session)
    second = await _item(db_session)
    await transition_job(db_session, first, to_state=HEAT_SOAKING, source="test")

    with pytest.raises(ReservationConflict):
        await transition_job(db_session, second, to_state=DISPATCHING, source="test")

    reservation = await db_session.get(PrintJobReservation, first.printer_id)
    assert reservation and reservation.job_id == first.job_id


@pytest.mark.asyncio
async def test_compare_and_set_rejects_a_stale_worker(db_session):
    item = await _item(db_session)
    old_version = item.lifecycle_version
    await db_session.execute(
        update(PrintQueueItem)
        .where(PrintQueueItem.id == item.id)
        .values(lifecycle_version=old_version + 1)
        .execution_options(synchronize_session=False)
    )

    with pytest.raises(StaleLifecycleVersion):
        await transition_job(db_session, item, to_state=HEAT_SOAKING, source="stale_worker")


@pytest.mark.asyncio
async def test_dispatch_can_requeue_only_before_command_attempt(db_session):
    item = await _item(db_session)
    await transition_job(db_session, item, to_state=DISPATCHING, source="test")
    await transition_job(db_session, item, to_state=QUEUED, source="test", allow_pre_send_requeue=True)
    assert item.lifecycle_state == QUEUED

    await transition_job(db_session, item, to_state=DISPATCHING, source="test")
    await mark_dispatch_attempted(db_session, item, source="test")
    with pytest.raises(LifecycleError, match="possible command send"):
        await transition_job(db_session, item, to_state=QUEUED, source="test", allow_pre_send_requeue=True)


@pytest.mark.asyncio
async def test_direct_terminal_dispatch_recovery_requires_explicit_strict_evidence(db_session):
    item = await _item(db_session)
    await transition_job(db_session, item, to_state=DISPATCHING, source="test")
    await mark_dispatch_attempted(db_session, item, source="test")

    with pytest.raises(LifecycleError, match="strict attributed evidence"):
        await transition_job(db_session, item, to_state=COMPLETED, source="reconnect")

    await transition_job(
        db_session,
        item,
        to_state=COMPLETED,
        source="reconnect",
        allow_missed_start_terminal=True,
        physical_execution_observed=True,
    )
    assert item.lifecycle_state == COMPLETED
    assert item.physical_execution_observed is True
    assert await db_session.get(PrintJobReservation, item.printer_id) is None


@pytest.mark.asyncio
async def test_effects_deduplicate_even_when_the_effect_is_job_scoped(db_session):
    item = await _item(db_session)
    event = await transition_job(db_session, item, to_state=CANCELLED, source="test")

    first = await enqueue_effect(
        db_session,
        job_id=item.job_id,
        operation_id=None,
        source_event_id=event.id,
        effect_type="notify_cancelled",
        delivery_policy="idempotent_retry",
    )
    second = await enqueue_effect(
        db_session,
        job_id=item.job_id,
        operation_id=None,
        source_event_id=event.id,
        effect_type="notify_cancelled",
        delivery_policy="idempotent_retry",
    )
    assert first.id == second.id
    assert (await db_session.scalars(select(PrintJobEffect))).all() == [first]


@pytest.mark.asyncio
async def test_effect_leases_retry_and_expose_operational_health(db_session):
    item = await _item(db_session)
    event = await transition_job(db_session, item, to_state=CANCELLED, source="test")
    effect = await enqueue_effect(
        db_session,
        job_id=item.job_id,
        operation_id=None,
        source_event_id=event.id,
        effect_type="notify_cancelled",
        delivery_policy="idempotent_retry",
    )

    claimed = await claim_effect(db_session, effect_id=effect.id, lease_owner="worker-a")
    assert claimed and claimed.state == "processing" and claimed.attempt_count == 1
    assert await claim_effect(db_session, effect_id=effect.id, lease_owner="worker-b") is None
    assert await fail_effect(db_session, effect_id=effect.id, lease_owner="worker-a", error="network timeout")

    health = await effect_health(db_session)
    assert health["pending"] == 1
    assert health["processing"] == 0
    assert health["oldest_pending_at"] is not None

    # Backoff is durable. Advance the persisted retry window rather than
    # assuming a failed effect is immediately claimable.
    await db_session.refresh(effect)
    effect.next_attempt_at = effect.next_attempt_at - timedelta(seconds=2)
    await db_session.flush()
    claimed = await claim_effect(db_session, effect_id=effect.id, lease_owner="worker-b")
    assert claimed and claimed.attempt_count == 2
    assert await complete_effect(db_session, effect_id=effect.id, lease_owner="worker-b")
    await db_session.flush()
    assert await purge_delivered_effects(db_session, retention_days=0) == 1


@pytest.mark.asyncio
async def test_device_binding_uses_task_identity_and_retains_generations(db_session):
    item = await _item(db_session)
    binding = await bind_device_task(
        db_session,
        item=item,
        device_subtask_id="subtask-1",
        connection_epoch="connection-a",
        event_sequence=11,
    )
    same = await bind_device_task(
        db_session,
        item=item,
        device_subtask_id="subtask-1",
        connection_epoch="connection-b",
        event_sequence=12,
    )
    assert same.id == binding.id
    assert same.generation == 1
    assert same.last_connection_epoch == "connection-b"


@pytest.mark.asyncio
async def test_device_events_require_one_durable_task_binding_and_quarantine_the_rest(db_session):
    item = await _item(db_session)
    await transition_job(db_session, item, to_state=DISPATCHING, source="test")
    await bind_device_task(
        db_session,
        item=item,
        device_subtask_id="subtask-1",
        connection_epoch="connection-a",
        event_sequence=11,
    )

    resolved = await resolve_job_for_device_event(
        db_session,
        printer_id=item.printer_id,
        device_subtask_id="subtask-1",
        permitted_states=(DISPATCHING,),
    )
    assert resolved and resolved.job_id == item.job_id
    assert (
        await resolve_job_for_device_event(
            db_session,
            printer_id=item.printer_id,
            device_subtask_id=None,
            permitted_states=(DISPATCHING,),
        )
        is None
    )

    first = await quarantine_device_event(
        db_session,
        printer_id=item.printer_id,
        event_type="terminal_print_event",
        device_subtask_id=None,
        reason="missing device identity",
    )
    duplicate = await quarantine_device_event(
        db_session,
        printer_id=item.printer_id,
        event_type="terminal_print_event",
        device_subtask_id=None,
        reason="missing device identity",
    )
    # Missing task identity is append-only evidence: two observations are not
    # silently collapsed into one ambiguous bucket.
    assert duplicate.id != first.id
    assert len((await db_session.scalars(select(PrintJobQuarantinedEvent))).all()) == 2


@pytest.mark.asyncio
async def test_terminal_task_identity_survives_reconnect_and_duplicate_delivery(db_session):
    item = await _item(db_session)
    await transition_job(db_session, item, to_state=DISPATCHING, source="test")
    await mark_dispatch_attempted(db_session, item, source="test")
    await bind_device_task(
        db_session,
        item=item,
        device_subtask_id="subtask-reconnect",
        connection_epoch="old-connection",
        event_sequence=None,
    )
    await db_session.commit()

    first = await settle_terminal_event(
        db_session,
        printer_id=item.printer_id,
        status="completed",
        device_subtask_id="subtask-reconnect",
        connection_epoch="new-connection",
        event_sequence=42,
        evidence={"physical_execution_observed": True},
        effect_payload={"printer_id": item.printer_id, "status": "completed"},
    )
    assert first.resolved and first.changed and first.effect_id
    assert first.physical_execution_observed is True

    event_count = len(
        (await db_session.scalars(select(PrintJobEvent).where(PrintJobEvent.job_id == item.job_id))).all()
    )
    effect_count = len(
        (await db_session.scalars(select(PrintJobEffect).where(PrintJobEffect.job_id == item.job_id))).all()
    )

    duplicate = await settle_terminal_event(
        db_session,
        printer_id=item.printer_id,
        status="completed",
        device_subtask_id="subtask-reconnect",
        connection_epoch="new-connection",
        event_sequence=43,
        evidence={"physical_execution_observed": True},
        effect_payload={"printer_id": item.printer_id, "status": "completed"},
    )
    assert duplicate.resolved and duplicate.changed is False
    assert duplicate.effect_id == first.effect_id
    assert (
        len((await db_session.scalars(select(PrintJobEvent).where(PrintJobEvent.job_id == item.job_id))).all())
        == event_count
    )
    assert (
        len((await db_session.scalars(select(PrintJobEffect).where(PrintJobEffect.job_id == item.job_id))).all())
        == effect_count
    )


@pytest.mark.asyncio
async def test_user_stop_resolution_is_scoped_to_the_exact_job(db_session):
    item = await _item(db_session)
    await transition_job(db_session, item, to_state=DISPATCHING, source="test")
    await mark_dispatch_attempted(db_session, item, source="test")
    await bind_device_task(
        db_session,
        item=item,
        device_subtask_id="stop-task",
        connection_epoch="connection-a",
        event_sequence=1,
    )

    resolution = await settle_terminal_event(
        db_session,
        printer_id=item.printer_id,
        status="failed",
        device_subtask_id="stop-task",
        connection_epoch="connection-b",
        event_sequence=2,
        evidence={"physical_execution_observed": True},
        effect_payload={"printer_id": item.printer_id, "status": "failed"},
        user_stopped_job_id=item.job_id,
    )

    assert resolution.status == "cancelled"
    assert item.lifecycle_state == "cancelled"


@pytest.mark.asyncio
async def test_manual_resolution_closes_uncertain_job_and_its_reservation(db_session):
    item = await _item(db_session)
    await transition_job(db_session, item, to_state=DISPATCHING, source="test")
    await mark_dispatch_attempted(db_session, item, source="test")
    await mark_job_uncertain(
        db_session,
        item,
        uncertainty_status="stop_resolution_pending",
        source="test_stop",
        safety_hold_type="stop_resolution",
        reason="device acknowledgement missing",
    )

    effect = await resolve_uncertain_job(
        db_session,
        item,
        outcome=CANCELLED,
        reason="Operator confirmed the physical attempt was stopped",
        operator_id=7,
    )

    assert item.lifecycle_state == CANCELLED
    assert item.uncertainty_status is None
    assert await db_session.get(PrintJobReservation, item.printer_id) is None
    assert effect.delivery_policy == "reconcile_before_retry"
    hold = await db_session.scalar(
        select(PrinterSafetyHold).where(
            PrinterSafetyHold.job_id == item.job_id,
            PrinterSafetyHold.hold_type == "stop_resolution",
        )
    )
    assert hold is not None and hold.state == "resolved"


@pytest.mark.asyncio
async def test_observed_print_hands_off_only_a_pre_send_reservation(db_session):
    item = await _item(db_session)
    item.chamber_heat_soak = True
    await transition_job(db_session, item, to_state=HEAT_SOAKING, source="test")
    old_job_id = item.job_id

    adopted = await adopt_observed_user_print(
        db_session,
        printer_id=item.printer_id,
        device_subtask_id="manual-task-handoff",
        evidence={"source": "printer-panel"},
    )

    assert adopted is not None and adopted.lifecycle_state == "printing"
    await db_session.refresh(item)
    assert item.job_id == old_job_id
    assert item.lifecycle_state == QUEUED
    assert item.queue_visible is True
    assert item.manual_start is True
    reservation = await db_session.get(PrintJobReservation, item.printer_id)
    assert reservation is not None and reservation.job_id == adopted.job_id
    hold = await db_session.scalar(
        select(PrinterSafetyHold).where(
            PrinterSafetyHold.job_id == item.job_id,
            PrinterSafetyHold.hold_type == "heat_soak_shutdown",
        )
    )
    assert hold is not None and hold.state == "active"


@pytest.mark.asyncio
async def test_out_of_band_print_is_adopted_as_hidden_durable_job(db_session):
    await _item(db_session)  # Creates the printer without reserving it.

    adopted = await adopt_observed_user_print(
        db_session,
        printer_id=1,
        device_subtask_id="manual-task-1",
        evidence={"source": "printer-panel"},
    )
    assert adopted is not None
    assert adopted.queue_visible is False
    assert adopted.lifecycle_state == "printing"
    assert adopted.physical_execution_observed is True
    assert adopted.dispatch_subtask_id == "manual-task-1"

    same = await adopt_observed_user_print(
        db_session,
        printer_id=1,
        device_subtask_id="manual-task-1",
    )
    assert same is not None and same.job_id == adopted.job_id

    terminal = await settle_terminal_event(
        db_session,
        printer_id=1,
        status="completed",
        device_subtask_id="manual-task-1",
        connection_epoch=None,
        event_sequence=None,
        evidence={"physical_execution_observed": True},
        effect_payload={"printer_id": 1, "status": "completed"},
    )
    assert terminal.resolved

    duplicate_start = await adopt_observed_user_print(
        db_session,
        printer_id=1,
        device_subtask_id="manual-task-1",
    )
    assert duplicate_start is None
    quarantined = await db_session.scalars(
        select(PrintJobQuarantinedEvent).where(PrintJobQuarantinedEvent.event_type == "observed_print_start")
    )
    assert len(quarantined.all()) == 1


@pytest.mark.asyncio
async def test_retry_creates_a_new_job_with_explicit_lineage(db_session):
    item = await _item(db_session)
    await transition_job(db_session, item, to_state=DISPATCHING, source="test")
    await mark_dispatch_attempted(db_session, item, source="test")
    await transition_job(
        db_session,
        item,
        to_state=COMPLETED,
        source="test",
        allow_missed_start_terminal=True,
        physical_execution_observed=True,
    )

    retry = await create_retry_job(db_session, item, source="manual_retry")
    assert retry.job_id != item.job_id
    assert retry.previous_job_id == item.job_id
    assert retry.lifecycle_state == QUEUED
    assert retry.status == "pending"

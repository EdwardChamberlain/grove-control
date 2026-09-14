"""Regression coverage for finance and queue-run identity boundaries."""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from backend.app.api.routes.finance import delete_cost_center
from backend.app.main import _matches_cancelled_queue_completion, _select_queue_completion_item
from backend.app.models.archive import PrintArchive
from backend.app.models.finance import BudgetReservation, CostCenter, UserWallet, WalletTransaction
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.settings import Settings
from backend.app.models.user import User
from backend.app.schemas.finance import ManualPrintRequest
from backend.app.services.finance_billing import apply_print_charge_for_archive
from backend.app.services.finance_budget import validate_print_budget


@pytest.mark.asyncio
async def test_print_charge_consumes_only_the_matching_queue_reservation(db_session):
    """Reprints sharing an archive must keep each physical run's budget hold separate."""
    user = User(username="finance-run-owner")
    center = CostCenter(name="Shared finance test center")
    settings = Settings(key="billing_enabled", value="true")
    db_session.add_all([user, center, settings])
    await db_session.flush()

    archive = PrintArchive(
        filename="repeat.gcode.3mf",
        file_path="archives/repeat.gcode.3mf",
        file_size=1,
        content_hash="finance-integrity-repeat",
        status="completed",
        cost=4.0,
        created_by_id=user.id,
        cost_center_id=center.id,
    )
    db_session.add(archive)
    await db_session.flush()

    first_item = PrintQueueItem(
        archive_id=archive.id,
        cost_center_id=center.id,
        estimated_cost=4.0,
        status="printing",
        billing_run_id="first-run",
        created_by_id=user.id,
    )
    second_item = PrintQueueItem(
        archive_id=archive.id,
        cost_center_id=center.id,
        estimated_cost=4.0,
        status="printing",
        billing_run_id="second-run",
        created_by_id=user.id,
    )
    db_session.add_all([first_item, second_item])
    await db_session.flush()

    first_reservation = BudgetReservation(
        cost_center_id=center.id,
        amount=4.0,
        status="active",
        source_type="queue_item",
        source_id=first_item.id,
        print_archive_id=archive.id,
    )
    second_reservation = BudgetReservation(
        cost_center_id=center.id,
        amount=4.0,
        status="active",
        source_type="queue_item",
        source_id=second_item.id,
        print_archive_id=archive.id,
    )
    db_session.add_all([first_reservation, second_reservation])
    await db_session.commit()

    charged = await apply_print_charge_for_archive(
        db_session,
        archive.id,
        charged_user_id=user.id,
        cost_center_id=center.id,
        print_queue_id=first_item.id,
        print_run_id="first-run",
    )
    await db_session.commit()

    assert charged is True
    assert first_reservation.status == "consumed"
    assert second_reservation.status == "active"

    transaction = (
        await db_session.execute(select(WalletTransaction).where(WalletTransaction.print_run_id == "first-run"))
    ).scalar_one()
    assert transaction.print_queue_id == first_item.id
    assert transaction.cost_center_id == center.id
    assert transaction.user_id == user.id
    assert await db_session.scalar(select(UserWallet.id).where(UserWallet.user_id == user.id)) is not None


@pytest.mark.asyncio
async def test_cost_center_delete_rejects_active_budget_reservation(db_session):
    user = User(username="finance-delete-reservation", role="admin")
    center = CostCenter(name="Reserved center")
    db_session.add_all([user, center])
    await db_session.flush()
    db_session.add(
        BudgetReservation(
            cost_center_id=center.id,
            amount=2.0,
            status="active",
            source_type="queue_item",
            source_id=1001,
        )
    )
    await db_session.commit()

    with pytest.raises(HTTPException) as exc_info:
        await delete_cost_center(center.id, db_session, user)

    assert exc_info.value.status_code == 400
    assert "active budget reservations" in exc_info.value.detail
    assert await db_session.get(CostCenter, center.id) is not None


@pytest.mark.asyncio
async def test_cost_center_delete_rejects_active_queue_item(db_session):
    user = User(username="finance-delete-queue", role="admin")
    center = CostCenter(name="Queued center")
    db_session.add_all([user, center])
    await db_session.flush()
    db_session.add(
        PrintQueueItem(
            cost_center_id=center.id,
            status="printing",
            created_by_id=user.id,
        )
    )
    await db_session.commit()

    with pytest.raises(HTTPException) as exc_info:
        await delete_cost_center(center.id, db_session, user)

    assert exc_info.value.status_code == 400
    assert "active queue items" in exc_info.value.detail
    assert await db_session.get(CostCenter, center.id) is not None


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["preheating", "dispatching"])
async def test_pre_dispatch_heat_soak_states_hold_budget(db_session, status):
    """A heat-soak handoff remains a budget hold until command dispatch."""
    center = CostCenter(name=f"Heat-soak {status} center", total_budget=10.0)
    db_session.add_all([center, Settings(key="billing_enabled", value="true")])
    await db_session.flush()
    db_session.add(PrintQueueItem(cost_center_id=center.id, estimated_cost=10.0, status=status))
    await db_session.commit()

    with pytest.raises(HTTPException) as exc_info:
        await validate_print_budget(
            db_session,
            cost_center_id=center.id,
            estimated_cost=1.0,
            current_user=None,
        )

    assert "exceeds available" in exc_info.value.detail


def test_cancelled_queue_completion_requires_persisted_run_identity():
    item = SimpleNamespace(status="cancelled", dispatch_subtask_id="dispatch-1", archive_id=42)

    assert _matches_cancelled_queue_completion(item, archive_id=42, event_subtask_id="dispatch-1")
    assert not _matches_cancelled_queue_completion(item, archive_id=43, event_subtask_id="dispatch-1")
    assert not _matches_cancelled_queue_completion(item, archive_id=42, event_subtask_id="dispatch-2")
    assert not _matches_cancelled_queue_completion(item, archive_id=42, event_subtask_id=None)


def test_terminal_event_selects_the_matching_run_when_an_old_run_is_cancelled():
    cancelled_run = SimpleNamespace(
        id=1,
        status="cancelled",
        dispatch_subtask_id="old-run",
        archive_id=42,
        library_file_id=None,
    )
    current_run = SimpleNamespace(
        id=2,
        status="printing",
        dispatch_subtask_id="current-run",
        archive_id=84,
        library_file_id=None,
    )

    selected = _select_queue_completion_item(
        [cancelled_run, current_run],
        possible_keys=[],
        archive_id=42,
        event_subtask_id="old-run",
        recovered_dispatch=False,
        event_status="completed",
    )

    assert selected is cancelled_run

    selected = _select_queue_completion_item(
        [cancelled_run, current_run],
        possible_keys=[],
        archive_id=84,
        event_subtask_id="current-run",
        recovered_dispatch=False,
        event_status="completed",
    )

    assert selected is current_run


def test_terminal_event_refuses_ambiguous_printing_rows_without_run_identity():
    items = [
        SimpleNamespace(
            id=1,
            status="printing",
            dispatch_subtask_id="first",
            archive_id=42,
            library_file_id=None,
        ),
        SimpleNamespace(
            id=2,
            status="printing",
            dispatch_subtask_id="second",
            archive_id=84,
            library_file_id=None,
        ),
    ]

    selected = _select_queue_completion_item(
        items,
        possible_keys=[],
        archive_id=None,
        event_subtask_id=None,
        recovered_dispatch=False,
        event_status="completed",
    )

    assert selected is None


def test_manual_print_request_uses_positive_api_amount():
    request = ManualPrintRequest(user_id=1, cost_center_id=2, amount=3.50)

    assert request.amount == 3.50
    with pytest.raises(ValueError):
        ManualPrintRequest(user_id=1, cost_center_id=2, amount=-3.50)

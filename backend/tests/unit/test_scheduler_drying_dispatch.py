"""Regression coverage for the pre-dispatch AMS drying policy."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest

from backend.app.services.print_scheduler import PrintScheduler


def _status(*ams_units: dict) -> SimpleNamespace:
    return SimpleNamespace(raw_data={"ams": list(ams_units)})


def _item(*, wait: bool = False, printer_id: int | None = 1, target_model: str | None = None):
    return SimpleNamespace(
        id=10,
        printer_id=printer_id,
        target_model=target_model,
        target_location=None,
        archive_id=20,
        library_file_id=None,
        scheduled_time=None,
        manual_start=False,
        force_color_match=None,
        required_filament_types=None,
        filament_overrides=None,
        ams_mapping="[0]",
        require_previous_success=False,
        waiting_reason=None,
        wait_for_drying_complete=wait,
    )


@pytest.mark.asyncio
async def test_default_policy_stops_every_live_dryer_and_waits_for_telemetry():
    scheduler = PrintScheduler()
    item = _item()
    db = SimpleNamespace(commit=AsyncMock())
    printer_status = _status(
        {"id": 0, "dry_time": 120},
        {"id": 1, "dry_time": 0},
        {"id": 128, "dry_time": "45"},
    )

    with (
        patch(
            "backend.app.services.print_scheduler.printer_manager.get_status",
            return_value=printer_status,
        ),
        patch(
            "backend.app.services.print_scheduler.printer_manager.send_drying_command",
            return_value=True,
        ) as send_drying,
    ):
        ready = await scheduler._prepare_drying_for_dispatch(db, item, 1)

    assert ready is False
    assert item.waiting_reason == "Stopping AMS drying before dispatch"
    assert send_drying.call_args_list == [
        call(1, 0, 0, 0, mode=0),
        call(1, 128, 0, 0, mode=0),
    ]
    db.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_wait_policy_leaves_live_dryer_running():
    scheduler = PrintScheduler()
    item = _item(wait=True)
    db = SimpleNamespace(commit=AsyncMock())

    with (
        patch(
            "backend.app.services.print_scheduler.printer_manager.get_status",
            return_value=_status({"id": 0, "dry_time": 120}),
        ),
        patch(
            "backend.app.services.print_scheduler.printer_manager.send_drying_command",
        ) as send_drying,
    ):
        ready = await scheduler._prepare_drying_for_dispatch(db, item, 1)

    assert ready is False
    assert item.waiting_reason == "Waiting for AMS drying to complete"
    send_drying.assert_not_called()


@pytest.mark.asyncio
async def test_dispatch_becomes_ready_only_after_live_drying_telemetry_clears():
    scheduler = PrintScheduler()
    item = _item()
    item.waiting_reason = "Stopping AMS drying before dispatch"
    db = SimpleNamespace(commit=AsyncMock())

    with patch(
        "backend.app.services.print_scheduler.printer_manager.get_status",
        return_value=_status({"id": 0, "dry_time": 0}),
    ):
        ready = await scheduler._prepare_drying_for_dispatch(db, item, 1)

    assert ready is True
    assert item.waiting_reason is None
    db.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_failed_stop_submission_is_visible_and_remains_pending():
    scheduler = PrintScheduler()
    item = _item()
    db = SimpleNamespace(commit=AsyncMock())

    with (
        patch(
            "backend.app.services.print_scheduler.printer_manager.get_status",
            return_value=_status({"id": 0, "dry_time": 120}),
        ),
        patch(
            "backend.app.services.print_scheduler.printer_manager.send_drying_command",
            return_value=False,
        ),
    ):
        ready = await scheduler._prepare_drying_for_dispatch(db, item, 1)

    assert ready is False
    assert item.waiting_reason == "Unable to stop AMS drying; waiting to retry"


def _queue_results(items):
    pending_result = MagicMock()
    pending_result.scalars.return_value.all.return_value = items
    busy_result = MagicMock()
    busy_result.all.return_value = []
    return pending_result, busy_result


@pytest.mark.asyncio
async def test_printer_targeted_route_applies_drying_gate_before_dispatch():
    scheduler = PrintScheduler()
    item = _item(printer_id=1)
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=_queue_results([item]))

    with (
        patch("backend.app.services.print_scheduler.async_session") as session_ctx,
        patch.object(scheduler, "_recover_stale_dispatches", new=AsyncMock()),
        patch.object(scheduler, "_check_heat_soaks", new=AsyncMock(return_value=set())),
        patch.object(scheduler, "_get_bool_setting", new=AsyncMock(return_value=False)),
        patch.object(scheduler, "_is_printer_idle", return_value=True),
        patch.object(scheduler, "_ams_mapping_uses_compatible_materials", return_value=True),
        patch.object(scheduler, "_block_on_filament_deficit", new=AsyncMock(return_value=False)),
        patch.object(scheduler, "_prepare_drying_for_dispatch", new=AsyncMock(return_value=False)) as prepare,
        patch.object(scheduler, "_start_print", new=AsyncMock()) as start_print,
        patch.object(scheduler, "_check_auto_drying", new=AsyncMock()),
        patch(
            "backend.app.services.print_scheduler.printer_manager.is_connected",
            return_value=True,
        ),
    ):
        session_ctx.return_value.__aenter__ = AsyncMock(return_value=db)
        session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)
        await scheduler.check_queue()

    prepare.assert_awaited_once_with(db, item, 1)
    start_print.assert_not_awaited()


@pytest.mark.asyncio
async def test_model_selected_route_applies_drying_gate_after_assignment_before_dispatch():
    scheduler = PrintScheduler()
    item = _item(printer_id=None, target_model="X1C")
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=_queue_results([item]))

    with (
        patch("backend.app.services.print_scheduler.async_session") as session_ctx,
        patch.object(scheduler, "_recover_stale_dispatches", new=AsyncMock()),
        patch.object(scheduler, "_check_heat_soaks", new=AsyncMock(return_value=set())),
        patch.object(scheduler, "_get_bool_setting", new=AsyncMock(return_value=False)),
        patch.object(
            scheduler,
            "_find_idle_printer_for_model",
            new=AsyncMock(return_value=(2, None)),
        ),
        patch.object(scheduler, "_get_job_name", new=AsyncMock(return_value="Test print")),
        patch.object(
            scheduler,
            "_get_printer",
            new=AsyncMock(return_value=SimpleNamespace(name="Printer 2")),
        ),
        patch.object(scheduler, "_ams_mapping_uses_compatible_materials", return_value=True),
        patch.object(scheduler, "_block_on_filament_deficit", new=AsyncMock(return_value=False)),
        patch.object(scheduler, "_prepare_drying_for_dispatch", new=AsyncMock(return_value=False)) as prepare,
        patch.object(scheduler, "_start_print", new=AsyncMock()) as start_print,
        patch.object(scheduler, "_check_auto_drying", new=AsyncMock()),
        patch(
            "backend.app.services.print_scheduler.notification_service.on_queue_job_assigned",
            new=AsyncMock(),
        ),
    ):
        session_ctx.return_value.__aenter__ = AsyncMock(return_value=db)
        session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)
        await scheduler.check_queue()

    prepare.assert_awaited_once_with(db, item, 2)
    start_print.assert_not_awaited()
    assert item.printer_id == 2

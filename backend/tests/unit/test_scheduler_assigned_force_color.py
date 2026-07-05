"""Force-colour enforcement for queue items assigned to a specific printer."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.app.services.print_scheduler import PrintScheduler


def _queue_item(*, force_color_match: bool = True):
    return SimpleNamespace(
        id=17,
        printer_id=3,
        target_model=None,
        archive_id=11,
        library_file_id=None,
        scheduled_time=None,
        manual_start=False,
        require_previous_success=False,
        ams_mapping=None,
        filament_overrides=(
            '[{"slot_id": 1, "type": "PLA", "color": "#FF0000", '
            f'"color_name": "Red", "force_color_match": {str(force_color_match).lower()}}}]'
        ),
        waiting_reason=None,
        print_time_seconds=None,
    )


def _queue_results(item):
    items_result = MagicMock()
    items_result.scalars.return_value.all.return_value = [item]
    busy_result = MagicMock()
    busy_result.all.return_value = []
    return items_result, busy_result


@pytest.fixture
def scheduler():
    return PrintScheduler()


def test_strict_colour_mapping_never_falls_back_across_nozzles(scheduler):
    required = [{"slot_id": 1, "type": "PLA", "color": "#FF0000", "nozzle_id": 1}]
    loaded = [
        {"global_tray_id": 0, "type": "PLA", "color": "#FF0000", "tray_info_idx": "", "extruder_id": 0},
        {"global_tray_id": 4, "type": "PLA", "color": "#0000FF", "tray_info_idx": "", "extruder_id": 1},
    ]

    mapping = scheduler._match_filaments_to_slots(required, loaded, strict_color_slot_ids={1})

    assert mapping == [-1]


@pytest.mark.asyncio
@patch("backend.app.services.print_scheduler.printer_manager")
async def test_assigned_job_waits_when_forced_colour_is_missing(mock_pm, scheduler):
    item = _queue_item()
    items_result, busy_result = _queue_results(item)
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[items_result, busy_result])
    mock_pm.is_connected.return_value = True

    with (
        patch("backend.app.services.print_scheduler.async_session") as session_ctx,
        patch.object(scheduler, "_get_bool_setting", new=AsyncMock(return_value=False)),
        patch.object(scheduler, "_is_printer_idle", return_value=True),
        patch.object(scheduler, "_get_missing_force_color_slots", return_value=["PLA (Red)"]),
        patch.object(scheduler, "_compute_ams_mapping_for_printer", new=AsyncMock()) as compute_mapping,
        patch.object(scheduler, "_start_print", new=AsyncMock()) as start_print,
        patch.object(scheduler, "_check_auto_drying", new=AsyncMock()),
    ):
        session_ctx.return_value.__aenter__ = AsyncMock(return_value=db)
        session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)
        await scheduler.check_queue()

    start_print.assert_not_awaited()
    compute_mapping.assert_not_awaited()
    assert item.waiting_reason == "No matching material/color. Waiting on PLA (Red)"


@pytest.mark.asyncio
@patch("backend.app.services.print_scheduler.printer_manager")
async def test_assigned_job_recomputes_mapping_and_starts_on_exact_colour(mock_pm, scheduler):
    item = _queue_item()
    item.ams_mapping = "[0]"  # stale mapping to a different-colour tray
    items_result, busy_result = _queue_results(item)
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[items_result, busy_result])
    mock_pm.is_connected.return_value = True

    with (
        patch("backend.app.services.print_scheduler.async_session") as session_ctx,
        patch.object(scheduler, "_get_bool_setting", new=AsyncMock(return_value=False)),
        patch.object(scheduler, "_is_printer_idle", return_value=True),
        patch.object(scheduler, "_get_missing_force_color_slots", return_value=[]),
        patch.object(scheduler, "_compute_ams_mapping_for_printer", new=AsyncMock(return_value=[2])),
        patch.object(scheduler, "_block_on_filament_deficit", new=AsyncMock(return_value=False)),
        patch.object(scheduler, "_start_print", new=AsyncMock()) as start_print,
        patch.object(scheduler, "_check_auto_drying", new=AsyncMock()),
    ):
        session_ctx.return_value.__aenter__ = AsyncMock(return_value=db)
        session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)
        await scheduler.check_queue()

    start_print.assert_awaited_once_with(db, item)
    assert item.ams_mapping == "[2]"


@pytest.mark.asyncio
@patch("backend.app.services.print_scheduler.printer_manager")
async def test_assigned_job_allows_different_colour_when_force_is_disabled(mock_pm, scheduler):
    item = _queue_item(force_color_match=False)
    item.ams_mapping = "[0]"
    items_result, busy_result = _queue_results(item)
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[items_result, busy_result])
    mock_pm.is_connected.return_value = True

    with (
        patch("backend.app.services.print_scheduler.async_session") as session_ctx,
        patch.object(scheduler, "_get_bool_setting", new=AsyncMock(return_value=False)),
        patch.object(scheduler, "_is_printer_idle", return_value=True),
        patch.object(scheduler, "_get_missing_force_color_slots") as missing_colors,
        patch.object(scheduler, "_block_on_filament_deficit", new=AsyncMock(return_value=False)),
        patch.object(scheduler, "_start_print", new=AsyncMock()) as start_print,
        patch.object(scheduler, "_check_auto_drying", new=AsyncMock()),
    ):
        session_ctx.return_value.__aenter__ = AsyncMock(return_value=db)
        session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)
        await scheduler.check_queue()

    missing_colors.assert_not_called()
    start_print.assert_awaited_once_with(db, item)

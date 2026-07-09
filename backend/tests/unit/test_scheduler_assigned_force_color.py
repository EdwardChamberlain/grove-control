"""Force-colour enforcement for queue items assigned to a specific printer."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.app.services.print_scheduler import PrintScheduler


def _queue_item(*, force_color_match: bool = True):
    return SimpleNamespace(
        id=17,
        printer_id=3,
        target_model=None,
        target_location=None,
        required_filament_types='["PLA"]',
        archive_id=11,
        library_file_id=None,
        scheduled_time=None,
        manual_start=False,
        force_color_match=force_color_match,
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


def test_strict_colour_mapping_rejects_different_material_variant(scheduler):
    required = [{"slot_id": 1, "type": "PAHT-CF", "color": "#000000"}]
    loaded = [
        {"global_tray_id": 0, "type": "PA12-CF", "color": "#000000", "tray_info_idx": ""},
    ]

    mapping = scheduler._match_filaments_to_slots(required, loaded, strict_color_slot_ids={1})

    assert mapping == [-1]


def test_strict_colour_mapping_accepts_compatible_basic_white_for_matte_white(scheduler):
    required = [{"slot_id": 1, "type": "PLA", "color": "#FFFFFF", "tray_info_idx": "GFA01"}]
    loaded = [
        {"global_tray_id": 0, "type": "PLA", "color": "#FFFFFF", "tray_info_idx": "GFA00"},
    ]

    mapping = scheduler._match_filaments_to_slots(required, loaded, strict_color_slot_ids={1})

    assert mapping == [0]


def test_strict_colour_mapping_accepts_matte_white_for_matte_white(scheduler):
    required = [{"slot_id": 1, "type": "PLA", "color": "#FFFFFF", "tray_info_idx": "GFA01"}]
    loaded = [
        {"global_tray_id": 0, "type": "PLA", "color": "#FFFFFF", "tray_info_idx": "GFA01"},
    ]

    mapping = scheduler._match_filaments_to_slots(required, loaded, strict_color_slot_ids={1})

    assert mapping == [0]


def test_unforced_mapping_never_crosses_material_family(scheduler):
    required = [{"slot_id": 1, "type": "PLA", "color": "#FF0000", "tray_info_idx": "shared"}]
    loaded = [
        {"global_tray_id": 0, "type": "ABS", "color": "#FF0000", "tray_info_idx": "shared"},
    ]

    mapping = scheduler._match_filaments_to_slots(required, loaded)

    assert mapping == [-1]


def test_unforced_mapping_never_substitutes_a_known_subtype(scheduler):
    required = [{"slot_id": 1, "type": "PLA-S", "color": "#FFFFFF"}]
    loaded = [
        {"global_tray_id": 0, "type": "PLA", "color": "#FFFFFF", "tray_info_idx": "GFA00"},
    ]

    mapping = scheduler._match_filaments_to_slots(required, loaded)

    assert mapping == [-1]


def test_missing_per_slot_flag_inherits_safe_queue_default(scheduler):
    item = _queue_item()
    item.filament_overrides = '[{"slot_id": 1, "type": "PLA", "color": "#FF0000"}]'

    overrides = scheduler._get_force_color_overrides(item)
    assert len(overrides) == 1
    assert overrides[0]["slot_id"] == 1
    assert overrides[0]["type"] == "PLA"
    assert overrides[0]["color"] == "#FF0000"
    assert overrides[0]["force_color_match"] is True
    assert overrides[0]["material"]["color_hex"] == "#FF0000FF"


@pytest.mark.parametrize("invalid_value", [None, 0, 1, "false", "true", ""])
def test_malformed_persisted_slot_flag_inherits_safe_queue_default(scheduler, invalid_value):
    item = _queue_item()
    item.filament_overrides = (
        f'[{{"slot_id": 1, "type": "PLA", "color": "#FF0000", "force_color_match": {json.dumps(invalid_value)}}}]'
    )

    overrides = scheduler._get_force_color_overrides(item)
    assert len(overrides) == 1
    assert overrides[0]["slot_id"] == 1
    assert overrides[0]["type"] == "PLA"
    assert overrides[0]["color"] == "#FF0000"
    assert overrides[0]["force_color_match"] is True
    assert overrides[0]["material"]["color_hex"] == "#FF0000FF"


@pytest.mark.asyncio
@patch("backend.app.services.print_scheduler.printer_manager")
async def test_model_unforced_job_accepts_same_material_without_exact_colour(mock_pm, scheduler):
    printer = SimpleNamespace(id=3, name="P1S")
    result = MagicMock()
    result.scalars.return_value.all.return_value = [printer]
    db = AsyncMock()
    db.execute = AsyncMock(return_value=result)
    mock_pm.is_connected.return_value = True

    with (
        patch.object(scheduler, "_is_printer_idle", return_value=True),
        patch.object(scheduler, "_get_missing_filament_materials", return_value=[]),
        patch.object(scheduler, "_count_override_color_matches", return_value=0),
    ):
        printer_id, waiting_reason = await scheduler._find_idle_printer_for_model(
            db,
            "P1S",
            set(),
            ["PLA"],
            filament_overrides=[{"slot_id": 1, "type": "PLA", "color": "#FFFFFF", "force_color_match": False}],
        )

    assert printer_id == 3
    assert waiting_reason is None


@pytest.mark.asyncio
@patch("backend.app.services.print_scheduler.printer_manager")
async def test_model_unforced_job_recomputes_cross_material_mapping(mock_pm, scheduler):
    item = _queue_item(force_color_match=False)
    item.printer_id = None
    item.target_model = "P1S"
    item.ams_mapping = "[2]"  # Client supplied a tray that contains ABS on the selected printer.
    items_result, busy_result = _queue_results(item)
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[items_result, busy_result])
    printer = SimpleNamespace(id=3, name="P1S")

    with (
        patch("backend.app.services.print_scheduler.async_session") as session_ctx,
        patch.object(scheduler, "_get_bool_setting", new=AsyncMock(return_value=False)),
        patch.object(scheduler, "_find_idle_printer_for_model", new=AsyncMock(return_value=(3, None))),
        patch.object(scheduler, "_get_job_name", new=AsyncMock(return_value="Benchy")),
        patch.object(scheduler, "_get_printer", new=AsyncMock(return_value=printer)),
        patch.object(
            scheduler,
            "_ams_mapping_uses_compatible_materials",
            return_value=False,
        ) as mapping_is_safe,
        patch.object(scheduler, "_compute_ams_mapping_for_printer", new=AsyncMock(return_value=[0])) as compute,
        patch.object(scheduler, "_block_on_filament_deficit", new=AsyncMock(return_value=False)),
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

    mapping_args = mapping_is_safe.call_args.args
    assert mapping_args[0] == 3
    assert mapping_args[1] == "[2]"
    assert mapping_args[2][0]["slot_id"] == 1
    assert mapping_args[2][0]["type"] == "PLA"
    assert mapping_args[2][0]["color"] == "#FF0000"
    assert mapping_args[2][0]["force_color_match"] is False
    assert mapping_args[2][0]["material"]["color_hex"] == "#FF0000FF"
    compute.assert_awaited_once_with(db, 3, item)
    assert item.ams_mapping == "[0]"
    start_print.assert_awaited_once_with(db, item)


@pytest.mark.asyncio
@patch("backend.app.services.print_scheduler.printer_manager")
async def test_forced_job_waits_when_material_metadata_is_missing(mock_pm, scheduler):
    item = _queue_item()
    item.filament_overrides = None
    items_result, busy_result = _queue_results(item)
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[items_result, busy_result])
    mock_pm.is_connected.return_value = True

    with (
        patch("backend.app.services.print_scheduler.async_session") as session_ctx,
        patch.object(scheduler, "_get_bool_setting", new=AsyncMock(return_value=False)),
        patch.object(scheduler, "_start_print", new=AsyncMock()) as start_print,
        patch.object(scheduler, "_check_auto_drying", new=AsyncMock()),
    ):
        session_ctx.return_value.__aenter__ = AsyncMock(return_value=db)
        session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)
        await scheduler.check_queue()

    start_print.assert_not_awaited()
    assert item.waiting_reason == "Material/colour metadata unavailable; cannot verify a safe filament match"
    db.commit.assert_awaited_once()


@pytest.mark.asyncio
@patch("backend.app.services.print_scheduler.printer_manager")
async def test_unforced_job_waits_when_material_metadata_is_missing(mock_pm, scheduler):
    item = _queue_item(force_color_match=False)
    item.filament_overrides = None
    items_result, busy_result = _queue_results(item)
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[items_result, busy_result])
    mock_pm.is_connected.return_value = True

    with (
        patch("backend.app.services.print_scheduler.async_session") as session_ctx,
        patch.object(scheduler, "_get_bool_setting", new=AsyncMock(return_value=False)),
        patch.object(scheduler, "_start_print", new=AsyncMock()) as start_print,
        patch.object(scheduler, "_check_auto_drying", new=AsyncMock()),
    ):
        session_ctx.return_value.__aenter__ = AsyncMock(return_value=db)
        session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)
        await scheduler.check_queue()

    start_print.assert_not_awaited()
    assert item.waiting_reason == "Material/colour metadata unavailable; cannot verify a safe filament match"


@pytest.mark.asyncio
@patch("backend.app.services.print_scheduler.printer_manager")
async def test_forced_job_waits_when_material_metadata_is_malformed(mock_pm, scheduler):
    item = _queue_item()
    item.filament_overrides = "not-json"
    items_result, busy_result = _queue_results(item)
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[items_result, busy_result])
    mock_pm.is_connected.return_value = True

    with (
        patch("backend.app.services.print_scheduler.async_session") as session_ctx,
        patch.object(scheduler, "_get_bool_setting", new=AsyncMock(return_value=False)),
        patch.object(scheduler, "_start_print", new=AsyncMock()) as start_print,
        patch.object(scheduler, "_check_auto_drying", new=AsyncMock()),
    ):
        session_ctx.return_value.__aenter__ = AsyncMock(return_value=db)
        session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)
        await scheduler.check_queue()

    start_print.assert_not_awaited()
    assert item.waiting_reason == "Material/colour metadata unavailable; cannot verify a safe filament match"


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
        patch.object(scheduler, "_get_missing_filament_materials", return_value=[]),
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
    assert item.waiting_reason == "No matching material/colour. Waiting on PLA (Red)"


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
        patch.object(scheduler, "_get_missing_filament_materials", return_value=[]),
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
        patch.object(scheduler, "_get_missing_filament_materials", return_value=[]),
        patch.object(scheduler, "_ams_mapping_uses_compatible_materials", return_value=True),
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


@pytest.mark.asyncio
@patch("backend.app.services.print_scheduler.printer_manager")
async def test_assigned_unforced_job_waits_when_material_is_missing(mock_pm, scheduler):
    item = _queue_item(force_color_match=False)
    items_result, busy_result = _queue_results(item)
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[items_result, busy_result])
    mock_pm.is_connected.return_value = True

    with (
        patch("backend.app.services.print_scheduler.async_session") as session_ctx,
        patch.object(scheduler, "_get_bool_setting", new=AsyncMock(return_value=False)),
        patch.object(scheduler, "_is_printer_idle", return_value=True),
        patch.object(scheduler, "_get_missing_filament_materials", return_value=["PLA - White"]),
        patch.object(scheduler, "_start_print", new=AsyncMock()) as start_print,
        patch.object(scheduler, "_check_auto_drying", new=AsyncMock()),
    ):
        session_ctx.return_value.__aenter__ = AsyncMock(return_value=db)
        session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)
        await scheduler.check_queue()

    start_print.assert_not_awaited()
    assert item.waiting_reason == "No matching material. Waiting on PLA - White"

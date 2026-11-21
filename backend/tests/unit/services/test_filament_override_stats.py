import pytest

from backend.app.services.filament_override_stats import effective_filament_metadata


def test_override_replaces_sliced_material_and_color_for_used_slot():
    filament_slots = [
        {"slot_id": 1, "used_g": 12.0, "type": "PLA", "color": "#000000"},
        {"slot_id": 2, "used_g": 0.0, "type": "PLA", "color": "#FFFFFF"},
    ]

    assert effective_filament_metadata(
        filament_slots,
        [],
        [{"slot_id": 1, "type": "PLA", "color": "0000FF"}],
    ) == ("PLA", "#0000FF")


def test_inventory_usage_wins_over_requested_override():
    filament_slots = [
        {"slot_id": 1, "used_g": 10.0, "type": "PLA", "color": "#000000"},
        {"slot_id": 2, "used_g": 20.0, "type": "PETG", "color": "#FFFFFF"},
    ]
    usage_results = [
        {"slot_id": 1, "material": "PLA", "color": "#0000FF"},
        {"slot_id": 2, "material": "PETG", "color": "#FF0000"},
    ]

    assert effective_filament_metadata(
        filament_slots,
        usage_results,
        [{"slot_id": 1, "type": "PLA", "color": "#00FF00"}],
    ) == ("PLA, PETG", "#0000FF,#FF0000")


def test_persisted_sliced_defaults_do_not_replace_actual_spool_metadata():
    filament_slots = [{"slot_id": 1, "used_g": 10.0, "type": "PLA", "color": "#000000"}]
    usage_results = [{"slot_id": 1, "material": "PLA", "color": "#0000FF"}]

    assert effective_filament_metadata(
        filament_slots,
        usage_results,
        [{"slot_id": 1, "type": "PLA", "color": "#000000"}],
    ) == ("PLA", "#0000FF")


def test_no_override_leaves_sliced_metadata_unchanged():
    assert effective_filament_metadata(
        [{"slot_id": 1, "used_g": 10.0, "type": "PLA", "color": "#000000"}],
        [],
        None,
    ) == (None, None)


def test_override_metadata_ignores_unused_slots_and_deduplicates_values():
    filament_slots = [
        {"slot_id": 1, "used_g": 10.0, "type": "PLA", "color": "#000000"},
        {"slot_id": 2, "used_g": 4.0, "type": "PLA", "color": "#000000"},
        {"slot_id": 3, "used_g": 0.0, "type": "ABS", "color": "#FFFFFF"},
    ]

    assert effective_filament_metadata(
        filament_slots,
        [],
        [
            {"slot_id": 1, "type": "PLA", "color": "FF0000"},
            {"slot_id": 2, "type": "PLA", "color": "#FF0000"},
            {"slot_id": 3, "type": "ABS", "color": "#FFFFFF"},
        ],
    ) == ("PLA", "#FF0000")


@pytest.mark.parametrize("overrides", ["broken-json", "null", "{}", None])
def test_invalid_overrides_preserve_existing_fallback(overrides):
    assert effective_filament_metadata(
        [{"slot_id": 1, "used_g": 10, "type": "PLA", "color": "#000000"}], [], overrides
    ) == (None, None)


def test_malformed_and_unused_slot_metadata_does_not_hide_valid_usage():
    slots = [
        None,
        {"slot_id": "bad", "used_g": 10},
        {"slot_id": 0, "used_g": 10},
        {"slot_id": 2, "used_g": "bad"},
        {"slot_id": 3, "used_g": 0},
        {"slot_id": 1, "used_g": 10, "type": "PLA", "color": "#000000"},
    ]
    assert effective_filament_metadata(
        slots,
        [None, {"slot_id": None}, {"slot_id": 1, "material": "PLA", "color": "0000ffff"}],
        [None, {"slot_id": 1, "type": "PLA", "color": "#00FF00"}],
    ) == ("PLA", "#0000FF")


def test_slot_that_switches_spools_keeps_both_actual_colors():
    assert effective_filament_metadata(
        [{"slot_id": 1, "used_g": 10, "type": "PLA", "color": "#000000"}],
        [
            {"slot_id": 1, "material": "PLA", "color": "#FF0000"},
            {"slot_id": 1, "material": "PLA", "color": "#0000FF"},
        ],
        '[{"slot_id": 1, "type": "PLA", "color": "#00FF00", "force_color_match": false}]',
    ) == ("PLA", "#FF0000,#0000FF")


def test_missing_metadata_stays_unknown():
    assert effective_filament_metadata([{"slot_id": 1, "used_g": 10}], [], []) == (None, None)


def test_oversized_metadata_does_not_truncate_filament_names_or_colors():
    slots = [{"slot_id": i + 1, "used_g": 10, "type": "PLA" * 20, "color": f"#{i:06x}"} for i in range(7)]
    assert effective_filament_metadata(slots, [], []) == (None, None)


def test_oversized_colours_discard_materials_too():
    slots = [{"slot_id": i + 1, "used_g": 10, "type": "PLA", "color": f"#{i:06x}"} for i in range(8)]
    assert effective_filament_metadata(slots, [], [{"slot_id": 1, "type": "PLA", "color": "#FFFFFF"}]) == (None, None)


@pytest.mark.parametrize("overrides", [None, "broken-json", "[]"])
def test_tracked_usage_applies_without_valid_overrides(overrides):
    slots = [{"slot_id": 1, "used_g": 10, "type": "PLA", "color": "#000000"}]
    usage = [{"slot_id": 1, "material": "PETG", "color": "#FF0000"}]
    assert effective_filament_metadata(slots, usage, overrides) == ("PETG", "#FF0000")


@pytest.mark.parametrize("color", ["red", "#", "12345", "#GGGGGG"])
def test_non_hex_colours_are_not_recorded(color):
    slots = [{"slot_id": 1, "used_g": 10, "type": "PLA", "color": color}]
    assert effective_filament_metadata(slots, [], [{"slot_id": 1, "type": "PLA", "color": color}]) == (None, None)


def test_slotless_usage_is_ignored():
    usage = [{"slot_id": None, "material": "PETG", "color": "#FF0000"}]
    assert effective_filament_metadata([{"slot_id": 1, "used_g": 10}], usage, None) == (None, None)

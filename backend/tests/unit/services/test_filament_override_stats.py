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


def test_explicit_override_wins_over_inventory_usage_result():
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
    ) == ("PLA, PETG", "#00FF00,#FF0000")


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

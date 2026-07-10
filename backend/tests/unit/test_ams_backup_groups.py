from types import SimpleNamespace

from backend.app.services.ams_backup_groups import build_ams_backup_groups


def _status(ams, ams_extruder_map=None):
    return SimpleNamespace(raw_data={"ams": ams}, ams_extruder_map=ams_extruder_map or {})


def test_groups_same_profile_and_colour_only():
    result = build_ams_backup_groups(
        _status(
            [
                {"id": 0, "tray": [{"id": 0, "tray_type": "PLA", "tray_color": "000000FF", "tray_info_idx": "GFA00"}]},
                {"id": 1, "tray": [{"id": 0, "tray_type": "PLA", "tray_color": "000000", "tray_info_idx": "GFA00"}]},
                {"id": 2, "tray": [{"id": 0, "tray_type": "PLA", "tray_color": "FFFFFF", "tray_info_idx": "GFA00"}]},
            ]
        ),
        is_dual_nozzle=False,
    )

    assert [len(group["members"]) for group in result["groups"]] == [2, 1]
    assert result["groups"][0]["material"]["display_name"] == "PLA - Black"


def test_scopes_identical_materials_by_dual_nozzle_extruder():
    result = build_ams_backup_groups(
        _status(
            [
                {"id": 0, "tray": [{"id": 0, "tray_type": "PLA", "tray_color": "000000", "tray_info_idx": "GFA00"}]},
                {"id": 1, "tray": [{"id": 0, "tray_type": "PLA", "tray_color": "000000", "tray_info_idx": "GFA00"}]},
            ],
            {"0": 0, "1": 1},
        ),
        is_dual_nozzle=True,
    )

    assert result["effective_dual_nozzle"] is True
    assert [len(group["members"]) for group in result["groups"]] == [1, 1]

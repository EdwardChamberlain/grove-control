"""Backend-owned AMS backup grouping for presentation and safety views."""

from __future__ import annotations

from backend.app.services.filament_material import FilamentMaterial


def build_ams_backup_groups(status, *, is_dual_nozzle: bool) -> dict:
    """Group live AMS trays by exact profile, RGB colour, and extruder."""
    raw_ams = status.raw_data.get("ams", []) if status else []
    extruder_map = getattr(status, "ams_extruder_map", {}) or {}
    distinct_extruders = {
        int(extruder_map[str(ams.get("id", 0))]) for ams in raw_ams if str(ams.get("id", 0)) in extruder_map
    }
    effective_dual = is_dual_nozzle and len(distinct_extruders) > 1
    groups: dict[str, dict] = {}
    for ams in raw_ams:
        ams_id = int(ams.get("id", 0))
        trays = ams.get("tray", [])
        extruder = int(extruder_map.get(str(ams_id), 0)) if effective_dual else 0
        for tray_index, tray in enumerate(trays):
            if not tray.get("tray_type"):
                continue
            material = FilamentMaterial.from_ams_tray(tray)
            profile_id = material.profile_id
            if not profile_id or not material.rgb_hex:
                continue
            tray_id = int(tray.get("id", tray_index))
            key = f"profile:{profile_id}|color:{material.rgb_hex}|extruder:{extruder}"
            group = groups.setdefault(
                key,
                {
                    "key": key,
                    "profile_id": profile_id,
                    "extruder": extruder,
                    "material": material.to_api_json(),
                    "members": [],
                },
            )
            group["members"].append(
                {
                    "ams_id": ams_id,
                    "tray_id": tray_id,
                    "is_ht": len(trays) == 1 or ams_id >= 128,
                }
            )
    return {
        "effective_dual_nozzle": effective_dual,
        "groups": sorted(groups.values(), key=lambda group: (group["extruder"], group["key"])),
    }

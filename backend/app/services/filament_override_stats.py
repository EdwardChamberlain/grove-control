"""Resolve per-run filament metadata for explicit queued material overrides.

Archive metadata describes the sliced 3MF. A queue override changes the
material/color sent for a filament slot, so the archive metadata used by the
Stats page and completion log must be corrected for that print.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any


def effective_filament_metadata(
    filament_slots: Sequence[dict[str, Any]] | None,
    usage_results: Sequence[dict[str, Any]] | None,
    filament_overrides: str | Sequence[dict[str, Any]] | None,
) -> tuple[str | None, str | None]:
    """Return comma-separated material and color lists after applying overrides.

    Slot IDs in 3MF metadata and queue overrides are one-based. Usage results
    provide the inventory filament actually consumed when available; explicit
    queue overrides take precedence because they are the user's chosen
    substitution even when that filament has no inventory spool record.
    """
    if isinstance(filament_overrides, str):
        try:
            filament_overrides = json.loads(filament_overrides)
        except (TypeError, ValueError):
            return None, None
    if not isinstance(filament_overrides, Sequence) or isinstance(filament_overrides, (str, bytes)):
        return None, None

    overrides_by_slot: dict[int, dict[str, Any]] = {}
    for item in filament_overrides:
        if not isinstance(item, dict):
            continue
        try:
            slot_id = int(item.get("slot_id"))
        except (TypeError, ValueError):
            continue
        overrides_by_slot[slot_id] = item

    if not overrides_by_slot or not filament_slots:
        return None, None

    actual_by_slot: dict[int, dict[str, Any]] = {}
    for item in usage_results or ():
        if not isinstance(item, dict) or item.get("slot_id") is None:
            continue
        try:
            slot_id = int(item["slot_id"])
        except (TypeError, ValueError):
            continue
        actual_by_slot[slot_id] = item

    types: list[str] = []
    colors: list[str] = []
    for slot in sorted(filament_slots, key=lambda value: int(value.get("slot_id", 0) or 0)):
        if not isinstance(slot, dict):
            continue
        try:
            slot_id = int(slot.get("slot_id"))
        except (TypeError, ValueError):
            continue
        try:
            if float(slot.get("used_g") or 0) <= 0:
                continue
        except (TypeError, ValueError):
            continue

        actual = actual_by_slot.get(slot_id, {})
        override = overrides_by_slot.get(slot_id, {})
        material = (override.get("type") or actual.get("material") or slot.get("type") or "").strip()
        color = (override.get("color") or actual.get("color") or slot.get("color") or "").strip()
        if material and material not in types:
            types.append(material)
        if color and color not in colors:
            # Slicer and spool metadata store colors as hex; normalize colors
            # selected from an AMS tray into CSS-compatible hex for the chart.
            color = color if color.startswith("#") else f"#{color}"
            if len(color) >= 9 and all(c in "0123456789abcdefABCDEF" for c in color[1:]):
                color = color[:7]
            color = color.upper()
            if color not in colors:
                colors.append(color)

    if not types and not colors:
        return None, None
    return (", ".join(types)[:50] or None, ",".join(colors)[:200] or None)

"""Resolve per-run filament metadata for explicit queued material overrides.

Archive metadata describes the sliced 3MF. A queue override changes the
material/color sent for a filament slot, so the archive metadata used by the
Stats page and completion log must be corrected for that print.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any


def _normalized_color(value: Any) -> str:
    """Return the six-digit CSS hex form used by archive color statistics."""
    color = str(value or "").strip()
    if not color:
        return ""
    if not color.startswith("#"):
        color = f"#{color}"
    if len(color) >= 9 and all(c in "0123456789abcdefABCDEF" for c in color[1:]):
        color = color[:7]
    return color.upper()


def _slot_id(slot: dict[str, Any]) -> int:
    try:
        return int(slot.get("slot_id"))
    except (TypeError, ValueError):
        return 0


def effective_filament_metadata(
    filament_slots: Sequence[dict[str, Any]] | None,
    usage_results: Sequence[dict[str, Any]] | None,
    filament_overrides: str | Sequence[dict[str, Any]] | None,
) -> tuple[str | None, str | None]:
    """Return effective per-run material and color metadata.

    Queue rows persist the resolved filament mapping, including untouched
    sliced defaults. Only values that differ from the sliced slot are explicit
    overrides. Inventory usage results provide actual spool metadata for other
    slots; explicit overrides take precedence even if no inventory spool is
    assigned.
    """
    if isinstance(filament_overrides, str):
        try:
            filament_overrides = json.loads(filament_overrides)
        except (TypeError, ValueError):
            return None, None
    if not isinstance(filament_overrides, Sequence) or isinstance(filament_overrides, (str, bytes)):
        return None, None
    if not filament_slots:
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

    if not overrides_by_slot:
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
    valid_slots = [slot for slot in filament_slots if isinstance(slot, dict)]
    for slot in sorted(valid_slots, key=_slot_id):
        slot_id = _slot_id(slot)
        if slot_id <= 0:
            continue
        try:
            if float(slot.get("used_g") or 0) <= 0:
                continue
        except (TypeError, ValueError):
            continue

        source_type = str(slot.get("type") or "").strip()
        source_color = _normalized_color(slot.get("color"))
        actual = actual_by_slot.get(slot_id, {})
        override = overrides_by_slot.get(slot_id, {})

        override_type = str(override.get("type") or "").strip()
        override_color = _normalized_color(override.get("color"))
        is_explicit_override = bool(
            (override_type and override_type != source_type)
            or (override_color and override_color != source_color)
        )

        if is_explicit_override:
            material = override_type or source_type
            color = override_color or source_color
        else:
            material = str(actual.get("material") or source_type).strip()
            color = _normalized_color(actual.get("color")) or source_color

        if material and material not in types:
            types.append(material)
        if color and color not in colors:
            colors.append(color)

    if not types and not colors:
        return None, None
    return (", ".join(types)[:50] or None, ",".join(colors)[:200] or None)

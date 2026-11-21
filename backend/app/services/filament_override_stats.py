"""Resolve the filament used by a queued run for print logs and statistics."""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.config import settings
from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.utils.safe_path import PathTraversalError, safe_join_under
from backend.app.utils.threemf_tools import extract_filament_usage_from_3mf


def _normalized_color(value: Any) -> str:
    """Use the six-digit CSS hex form expected by the color chart."""
    color = str(value or "").strip().lstrip("#")
    return f"#{color[:6].upper()}" if color else ""


def _slot_id(slot: dict[str, Any]) -> int:
    try:
        return int(slot.get("slot_id"))
    except (TypeError, ValueError):
        return 0


def effective_filament_metadata(
    filament_slots: Sequence[dict[str, Any]],
    usage_results: Sequence[dict[str, Any]],
    filament_overrides: str | Sequence[dict[str, Any]] | None,
) -> tuple[str | None, str | None]:
    """Prefer measured spool metadata, then the override, then sliced values.

    The caller supplies only slots used on the dispatched plate. Overrides
    are requests: relaxed color matching and filament switches can consume a
    different spool. Keep every tracked color when a slot used several spools.
    """
    if isinstance(filament_overrides, str):
        try:
            filament_overrides = json.loads(filament_overrides)
        except ValueError:
            return None, None
    if not isinstance(filament_overrides, (list, tuple)):
        return None, None

    overrides = {_slot_id(item): item for item in filament_overrides if isinstance(item, dict)}
    actuals: dict[int, list[dict]] = {}
    for item in usage_results:
        if isinstance(item, dict) and _slot_id(item) > 0:
            actuals.setdefault(_slot_id(item), []).append(item)

    types: list[str] = []
    colors: list[str] = []
    slots = sorted((slot for slot in filament_slots if isinstance(slot, dict)), key=_slot_id)
    for slot in slots:
        slot_id = _slot_id(slot)
        try:
            used = float(slot.get("used_g") or 0) > 0
        except (TypeError, ValueError):
            continue
        if slot_id <= 0 or not used:
            continue
        override = overrides.get(slot_id, {})
        for actual in actuals.get(slot_id, [{}]):
            material = str(actual.get("material") or override.get("type") or slot.get("type") or "").strip()
            color = _normalized_color(actual.get("color") or override.get("color") or slot.get("color"))
            if material and material not in types:
                types.append(material)
            if color and color not in colors:
                colors.append(color)

    # PrintLogEntry stores both fields in VARCHAR(50). Avoid partial tokens
    # and leave unknown/oversized metadata to the caller's existing fallback.
    material_list = ", ".join(types)
    color_list = ",".join(colors)
    return (
        material_list if material_list and len(material_list) <= 50 else None,
        color_list if color_list and len(color_list) <= 50 else None,
    )


async def resolve_run_filament_metadata(
    db: AsyncSession,
    archive: PrintArchive,
    printer_id: int,
    usage_results: list[dict],
    *,
    queue_item_id: int | None = None,
    dispatch_subtask_id: str | None = None,
) -> tuple[str | None, str | None]:
    """Resolve an exact queue run without changing the shared source archive.

    A stopped run is already terminal in the queue. Match its captured item
    ID, or the durable dispatch ID after a restart, rather than guessing from
    the archive's most recent queue row. Missing source/plate metadata keeps
    the existing fallback instead of attributing another plate's filaments.
    """
    fallback = (archive.filament_type, archive.filament_color)
    if queue_item_id is None and not dispatch_subtask_id:
        return fallback

    query = select(PrintQueueItem).where(
        PrintQueueItem.printer_id == printer_id,
        PrintQueueItem.archive_id == archive.id,
    )
    if queue_item_id is not None:
        query = query.where(PrintQueueItem.id == queue_item_id)
    else:
        query = query.where(PrintQueueItem.dispatch_subtask_id == dispatch_subtask_id)
    item = (await db.execute(query)).scalar_one_or_none()
    if item is None or not item.filament_overrides or not archive.file_path:
        return fallback

    try:
        path = safe_join_under(settings.base_dir, archive.file_path, http=False)
    except PathTraversalError:
        return fallback
    # The dispatcher sends plate_id or 1. Archive.extra_data contains every
    # plate's slots, so it cannot supply this run's material attribution.
    slots = extract_filament_usage_from_3mf(path, item.plate_id or 1)
    material, color = effective_filament_metadata(slots, usage_results, item.filament_overrides)
    return material or fallback[0], color or fallback[1]

"""Trusted server-side estimates for finance-aware queue admission."""

import json
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.core.config import settings
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.spool_assignment import SpoolAssignment
from backend.app.utils.threemf_tools import extract_filament_usage_from_3mf


def _source_path(library_file: LibraryFile) -> Path:
    path = Path(library_file.file_path)
    return (
        path if path.is_absolute() else settings.base_dir / path
    )  # SEC-PATH-OK: DB-stored library path; absolute external paths are intentional


def _parse_mapping(mapping: list[int] | str | None) -> list[int] | None:
    if isinstance(mapping, list):
        return mapping
    if isinstance(mapping, str):
        try:
            parsed = json.loads(mapping)
        except (TypeError, json.JSONDecodeError):
            return None
        return parsed if isinstance(parsed, list) else None
    return None


def _global_tray_id(assignment: SpoolAssignment) -> int:
    if assignment.ams_id == 255:
        return 254 + assignment.tray_id
    if assignment.ams_id >= 128:
        return assignment.ams_id
    return assignment.ams_id * 4 + assignment.tray_id


def plate_scoped_run_estimate(
    archive: PrintArchive,
    full_path: Path | None,
    plate_id: int | None = None,
) -> tuple[float | None, float | None]:
    """Return ``(grams, cost)`` for the selected plate, when available."""

    whole_grams = archive.filament_used_grams
    selected_plate = plate_id
    if selected_plate is None or full_path is None or not full_path.exists():
        return whole_grams, archive.cost
    try:
        usage = extract_filament_usage_from_3mf(full_path, selected_plate)
    except Exception:
        return whole_grams, archive.cost
    plate_grams = sum(float(entry.get("used_g") or 0) for entry in usage)
    if plate_grams <= 0:
        return whole_grams, archive.cost
    plate_cost = archive.cost
    if archive.cost and whole_grams and whole_grams > 0:
        plate_cost = round(float(archive.cost) * (plate_grams / float(whole_grams)), 2)
    return round(plate_grams, 2), plate_cost


async def _default_cost_per_kg(db: AsyncSession) -> float:
    from backend.app.api.routes.settings import get_setting

    raw = await get_setting(db, "default_filament_cost")
    try:
        return float(raw) if raw is not None else 25.0
    except (TypeError, ValueError):
        return 25.0


async def estimate_queue_source_cost(
    db: AsyncSession,
    *,
    archive: PrintArchive | None = None,
    library_file: LibraryFile | None = None,
    plate_id: int | None = None,
    ams_mapping: list[int] | str | None = None,
    printer_id: int | None = None,
) -> float | None:
    """Compute a queue cost from persisted source metadata, not request input."""

    if archive is not None:
        archive_path = Path(archive.file_path)
        archive_path = (
            archive_path if archive_path.is_absolute() else settings.base_dir / archive_path
        )  # SEC-PATH-OK: DB-stored archive path; absolute external paths are intentional
        _grams, cost = plate_scoped_run_estimate(archive, archive_path, plate_id)
        return float(cost) if cost is not None and cost > 0 else None

    if library_file is None:
        return None

    metadata = library_file.file_metadata or {}
    path = _source_path(library_file)
    try:
        usage = extract_filament_usage_from_3mf(path, plate_id) if path.exists() else []
    except Exception:
        usage = []
    if not usage:
        try:
            grams = float(metadata.get("filament_used_grams") or 0)
        except (TypeError, ValueError):
            grams = 0.0
        if grams <= 0:
            return None
        metadata_cost = metadata.get("cost")
        try:
            return (
                round(float(metadata_cost), 2)
                if metadata_cost and float(metadata_cost) > 0
                else round(grams / 1000.0 * await _default_cost_per_kg(db), 2)
            )
        except (TypeError, ValueError):
            return round(grams / 1000.0 * await _default_cost_per_kg(db), 2)

    default_cost = await _default_cost_per_kg(db)
    mapping = _parse_mapping(ams_mapping)
    cost_by_tray: dict[int, float | None] = {}
    if printer_id is not None and mapping:
        assignments = (
            (
                await db.execute(
                    select(SpoolAssignment)
                    .options(selectinload(SpoolAssignment.spool))
                    .where(SpoolAssignment.printer_id == printer_id)
                )
            )
            .scalars()
            .all()
        )
        cost_by_tray = {_global_tray_id(assignment): assignment.spool.cost_per_kg for assignment in assignments}

    total = 0.0
    for entry in usage:
        try:
            slot_id = int(entry.get("slot_id") or 0)
            grams = float(entry.get("used_g") or 0)
        except (TypeError, ValueError):
            continue
        tray_id = mapping[slot_id - 1] if mapping and 0 < slot_id <= len(mapping) else None
        cost_per_kg = cost_by_tray.get(tray_id) if tray_id is not None else None
        if cost_per_kg is None or cost_per_kg <= 0:
            cost_per_kg = default_cost
        total += grams / 1000.0 * cost_per_kg
    return round(total, 2) if total > 0 else None

"""API routes for print queue management."""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from sqlalchemy import and_, func, inspect, or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.api.routes.library_variants import normalize_model_name, resolve_variant_model
from backend.app.core.auth import RequirePermissionIfAuthEnabled, require_ownership_permission, resolve_api_key_owner
from backend.app.core.config import settings
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.core.websocket import ws_manager
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import FINAL_STATUSES, HOLDING_STATUSES, PrintQueueItem, PrintQueueVariant
from backend.app.models.printer import Printer
from backend.app.models.project import Project
from backend.app.models.user import User
from backend.app.schemas.library import FileUploadResponse
from backend.app.schemas.print_queue import (
    DispatchResolution,
    PrintQueueBulkUpdate,
    PrintQueueBulkUpdateResponse,
    PrintQueueItemCreate,
    PrintQueueItemResponse,
    PrintQueueItemUpdate,
    PrintQueueReorder,
    QueueVariantCreate,
    QueueVariantSummary,
)
from backend.app.services.filament_deficit import compute_deficit_for_queue_item
from backend.app.services.filament_requirements import (
    build_queue_filament_overrides,
    extract_filament_requirements,
    overrides_for_plate,
)
from backend.app.services.job_identity import needs_dispatch_resolution, telemetry_identity
from backend.app.services.lifecycle.awaiting import clear_job_plate
from backend.app.services.lifecycle.engine import InvalidQueueTransition, lock_queue_item, transition_queue_item
from backend.app.services.lifecycle.preheating import SkipHeatSoakResult, heat_soak_dispatch_started, skip_heat_soak
from backend.app.services.lifecycle.queued import create_job, filament_contract
from backend.app.services.notification_service import notification_service
from backend.app.services.queue_source_cleanup import (
    remove_queue_only_source_if_unused,
)
from backend.app.utils.printer_models import is_gcode_compatible
from backend.app.utils.safe_path import safe_join_under
from backend.app.utils.threemf_tools import (
    extract_bed_type_from_3mf,
    extract_filament_usage_from_3mf,
    extract_print_time_from_3mf,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/queue", tags=["queue"])


@router.post("/upload-source", response_model=FileUploadResponse)
async def upload_queue_source(
    file: UploadFile = File(...),
    generate_stl_thumbnails: bool = Query(default=True),
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
    api_key_owner: User | None = Depends(resolve_api_key_owner),
):
    """Upload a one-off print source for the Queue without adding it to Files."""
    from backend.app.api.routes.library import upload_file

    response = await upload_file(
        file=file,
        folder_id=None,
        generate_stl_thumbnails=generate_stl_thumbnails,
        db=db,
        current_user=current_user,
        api_key_owner=api_key_owner,
        queue_only=True,
        queue_source_sealed=False,
    )
    return response


@router.delete("/upload-source/{file_id}")
async def discard_queue_source(
    file_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
    api_key_owner: User | None = Depends(resolve_api_key_owner),
):
    """Discard an unqueued temporary print source after closing the print modal."""
    actor = current_user or api_key_owner
    library_file = await db.get(LibraryFile, file_id)
    if library_file is None:
        return {"deleted": True}
    if not library_file.queue_only:
        raise HTTPException(status_code=404, detail="Queue source not found")
    if actor is not None and library_file.created_by_id != actor.id:
        raise HTTPException(status_code=404, detail="Queue source not found")

    # Closing the setup modal means no more fan-out requests can arrive. The
    # cleanup helper still protects any queue items already using this source.
    library_file.queue_source_sealed = True
    await remove_queue_only_source_if_unused(db, file_id)
    await db.flush()
    deleted = await db.get(LibraryFile, file_id) is None
    await db.commit()
    return {"deleted": deleted}


def _variant_summaries(item: PrintQueueItem) -> list[QueueVariantSummary]:
    """Cross-model candidates for display (#671), or [] if they weren't loaded.

    Every route that builds a queue response eager-loads ``variants``. Reading
    the attribute unguarded would still be a landmine for the next one that
    doesn't: a lazy load on an async session raises rather than degrading, so a
    forgotten ``selectinload`` would turn a card render into a 500.
    """
    if "variants" in inspect(item).unloaded:
        return []
    return [
        QueueVariantSummary(
            library_file_id=v.library_file_id,
            filename=v.library_file.filename if v.library_file else "",
            target_model=v.target_model,
            position=v.position,
        )
        for v in item.variants
    ]


def _assert_can_queue_archive(archive: PrintArchive, current_user: User | None) -> None:
    """Gate turning *archive* into a print, for every route that queues one.

    Without ARCHIVES_READ_ALL, only the caller's own archive is found (404, so
    IDs can't be probed). Reprinting needs REPRINT_ALL, or REPRINT_OWN for one's
    own archive; an ownerless archive needs REPRINT_ALL (#1625).
    """
    if current_user is None:
        return
    if not current_user.has_permission(Permission.ARCHIVES_READ_ALL.value) and archive.created_by_id != current_user.id:
        raise HTTPException(404, "Archive not found")
    owns_archive = archive.created_by_id is not None and archive.created_by_id == current_user.id
    has_reprint = current_user.has_permission(Permission.ARCHIVES_REPRINT_ALL.value) or (
        owns_archive and current_user.has_permission(Permission.ARCHIVES_REPRINT_OWN.value)
    )
    if not has_reprint:
        raise HTTPException(
            status_code=403,
            detail="Permission archives:reprint_own or archives:reprint_all required",
        )


def _assert_can_queue_library_file(library_file: LibraryFile, current_user: User | None) -> None:
    """Gate turning *library_file* into a print — LIBRARY_READ_ALL or ownership."""
    if current_user is None:
        return
    if (
        not current_user.has_permission(Permission.LIBRARY_READ_ALL.value)
        and library_file.created_by_id != current_user.id
    ):
        raise HTTPException(404, "Library file not found")


def _enrich_response(item: PrintQueueItem) -> PrintQueueItemResponse:
    """Add nested archive/printer/library_file info to response."""
    # Parse ams_mapping from JSON string BEFORE model_validate
    ams_mapping_parsed = None
    if item.ams_mapping:
        try:
            ams_mapping_parsed = json.loads(item.ams_mapping)
        except json.JSONDecodeError:
            ams_mapping_parsed = None

    # Parse required_filament_types from JSON string
    required_filament_types_parsed = None
    if item.required_filament_types:
        try:
            required_filament_types_parsed = json.loads(item.required_filament_types)
        except json.JSONDecodeError:
            required_filament_types_parsed = None

    # Parse filament_overrides from JSON string
    filament_overrides_parsed = None
    if item.filament_overrides:
        try:
            filament_overrides_parsed = json.loads(item.filament_overrides)
        except json.JSONDecodeError:
            filament_overrides_parsed = None

    # Parse nozzle_mapping from JSON string (#1780 — H2C rack slicer-pick
    # preservation). Nullable opaque JSON blob stored verbatim from
    # BambuStudio's project_file; surface it parsed for the response model
    # and any future "edit print → nozzle" UI.
    nozzle_mapping_parsed = None
    if item.nozzle_mapping:
        try:
            nozzle_mapping_parsed = json.loads(item.nozzle_mapping)
        except json.JSONDecodeError:
            nozzle_mapping_parsed = None

    nozzles_info_parsed = None
    if item.nozzles_info:
        try:
            nozzles_info_parsed = json.loads(item.nozzles_info)
        except json.JSONDecodeError:
            nozzles_info_parsed = None

    # Create response with parsed ams_mapping
    item_dict = {
        "id": item.id,
        "printer_id": item.printer_id,
        "target_model": item.target_model,
        "target_location": item.target_location,
        "required_filament_types": required_filament_types_parsed,
        "filament_overrides": filament_overrides_parsed,
        "force_color_match": bool(item.force_color_match),
        "waiting_reason": item.waiting_reason,
        "archive_id": item.archive_id,
        "library_file_id": item.library_file_id,
        "position": item.position,
        "scheduled_time": item.scheduled_time,
        "auto_off_after": item.auto_off_after,
        "manual_start": item.manual_start,
        "wait_for_drying_complete": bool(item.wait_for_drying_complete),
        "chamber_heat_soak": bool(item.chamber_heat_soak),
        "heat_soak_temperature": item.heat_soak_temperature,
        "heat_soak_minutes": item.heat_soak_minutes,
        "preheat_started_at": item.preheat_started_at,
        "filament_short": bool(item.filament_short),
        "skip_filament_check": bool(item.skip_filament_check),
        "ams_mapping": ams_mapping_parsed,
        "plate_id": item.plate_id,
        "bed_levelling": item.bed_levelling,
        "flow_cali": item.flow_cali,
        "vibration_cali": item.vibration_cali,
        "layer_inspect": item.layer_inspect,
        "timelapse": item.timelapse,
        "use_ams": item.use_ams,
        "nozzle_offset_cali": item.nozzle_offset_cali,
        "status": item.status,
        "dispatched_at": item.dispatched_at,
        "dispatch_needs_resolution": needs_dispatch_resolution(item),
        "started_at": item.started_at,
        "completed_at": item.completed_at,
        "error_message": item.error_message,
        "created_at": item.created_at,
        # User tracking (Issue #206)
        "created_by_id": item.created_by_id,
        "created_by_username": item.created_by.username if item.created_by else None,
        # SJF scheduling
        "been_jumped": item.been_jumped,
        # Auto-print G-code injection
        "gcode_injection": item.gcode_injection,
        # H2C rack-swap nozzle pick (#1780)
        "nozzle_mapping": nozzle_mapping_parsed,
        "nozzles_info": nozzles_info_parsed,
        # Cross-model alternatives (#671). Guarded rather than read directly:
        # every route that reaches here eager-loads the relationship, but a
        # caller that forgets would trigger a lazy load, and a lazy load on an
        # async session raises rather than degrading. An empty list is the
        # correct answer for the ordinary item this would most likely be.
        "variants": _variant_summaries(item),
    }
    response = PrintQueueItemResponse(**item_dict)
    if item.archive:
        # Soft-deleted archive: files are gone from disk but the row stays
        # (its filament/cost contribution still flows into stats per #1343).
        # Suppress the archive-derived UI surface so the queue page doesn't
        # 404-storm the thumbnail / plates / plate-thumbnail endpoints — the
        # frontend's existing truthy gate on archive_thumbnail covers it
        # (#1348 follow-up). The archive_deleted flag lets the UI render a
        # "source deleted" badge on these rows.
        if item.archive.deleted_at is not None:
            response.archive_deleted = True
        else:
            response.archive_name = item.archive.print_name or item.archive.filename
            response.archive_thumbnail = item.archive.thumbnail_path
            response.print_time_seconds = item.archive.print_time_seconds
            response.filament_used_grams = item.archive.filament_used_grams
            response.filament_type = item.archive.filament_type
            response.filament_color = item.archive.filament_color
            response.layer_height = item.archive.layer_height
            response.nozzle_diameter = item.archive.nozzle_diameter
            response.sliced_for_model = item.archive.sliced_for_model
            response.bed_type = item.archive.bed_type
            if item.plate_id:
                archive_path = settings.base_dir / item.archive.file_path
                if archive_path.exists():
                    plate_time = extract_print_time_from_3mf(archive_path, item.plate_id)
                    plate_weight = sum(
                        f["used_g"] for f in extract_filament_usage_from_3mf(archive_path, item.plate_id)
                    )
                    plate_bed = extract_bed_type_from_3mf(archive_path, item.plate_id)
                    if plate_time is not None:
                        response.print_time_seconds = plate_time
                    if plate_weight > 0:
                        response.filament_used_grams = plate_weight
                    if plate_bed:
                        response.bed_type = plate_bed
    if item.library_file:
        response.library_file_name = (
            item.library_file.file_metadata.get("print_name") if item.library_file.file_metadata else None
        )
        if not response.library_file_name:
            response.library_file_name = item.library_file.filename
        response.library_file_thumbnail = item.library_file.thumbnail_path
        # Get metadata from library file if no archive
        if not item.archive and item.library_file.file_metadata:
            response.print_time_seconds = item.library_file.file_metadata.get("print_time_seconds")
            response.filament_used_grams = item.library_file.file_metadata.get("filament_used_grams")
            response.filament_type = item.library_file.file_metadata.get("filament_type")
            response.filament_color = item.library_file.file_metadata.get("filament_color")
            response.layer_height = item.library_file.file_metadata.get("layer_height")
            response.nozzle_diameter = item.library_file.file_metadata.get("nozzle_diameter")
            response.sliced_for_model = item.library_file.file_metadata.get("sliced_for_model")
            response.bed_type = item.library_file.file_metadata.get("bed_type")
        if item.plate_id:
            lib_path = Path(item.library_file.file_path)
            library_file_path = lib_path if lib_path.is_absolute() else settings.base_dir / item.library_file.file_path
            if library_file_path.exists():
                plate_time = extract_print_time_from_3mf(library_file_path, item.plate_id)
                plate_weight = sum(
                    f["used_g"] for f in extract_filament_usage_from_3mf(library_file_path, item.plate_id)
                )
                plate_bed = extract_bed_type_from_3mf(library_file_path, item.plate_id)
                if plate_time is not None:
                    response.print_time_seconds = plate_time
                if plate_weight > 0:
                    response.filament_used_grams = plate_weight
                if plate_bed:
                    response.bed_type = plate_bed
    if item.printer:
        response.printer_name = item.printer.name
    return response


@router.get("/", response_model=list[PrintQueueItemResponse])
async def list_queue(
    printer_id: int | None = Query(None, description="Filter by printer (-1 for unassigned)"),
    status: str | None = Query(None, description="Filter by status"),
    target_model: str | None = Query(
        None, description="Filter by target model (also includes model-based items when combined with printer_id)"
    ),
    db: AsyncSession = Depends(get_db),
    auth_result: tuple[User | None, bool] = Depends(
        require_ownership_permission(
            Permission.QUEUE_READ_ALL,
            Permission.QUEUE_READ_OWN,
        )
    ),
):
    """List all queue items, optionally filtered by printer or status."""
    user, can_read_all = auth_result
    query = (
        select(PrintQueueItem)
        .options(
            selectinload(PrintQueueItem.archive),
            selectinload(PrintQueueItem.printer),
            selectinload(PrintQueueItem.library_file),
            selectinload(PrintQueueItem.created_by),
            # Cross-model candidates (#671) and their files, for the card label.
            selectinload(PrintQueueItem.variants).selectinload(PrintQueueVariant.library_file),
        )
        .order_by(PrintQueueItem.printer_id.nulls_first(), PrintQueueItem.position)
    )
    if user is not None and not can_read_all:
        query = query.where(PrintQueueItem.created_by_id == user.id)

    if printer_id is not None:
        if printer_id == -1:
            # Special value: filter for unassigned items
            query = query.where(PrintQueueItem.printer_id.is_(None))
        else:
            # Resolve effective model: prefer explicit param, fall back to printer's DB model.
            # This ensures model-based "Any X" items are returned even when the frontend
            # doesn't send target_model (e.g. printer.model is NULL on the client side).
            effective_model = target_model
            if not effective_model:
                printer_row = (
                    await db.execute(select(Printer.model).where(Printer.id == printer_id))
                ).scalar_one_or_none()
                effective_model = printer_row

            if effective_model:
                # Include both printer-specific items AND model-based (unassigned) items
                query = query.where(
                    or_(
                        PrintQueueItem.printer_id == printer_id,
                        and_(
                            PrintQueueItem.printer_id.is_(None),
                            func.lower(PrintQueueItem.target_model) == effective_model.lower(),
                        ),
                    )
                )
            else:
                query = query.where(PrintQueueItem.printer_id == printer_id)
    elif target_model:
        query = query.where(func.lower(PrintQueueItem.target_model) == target_model.lower())
    if status:
        query = query.where(PrintQueueItem.status == status)
    else:
        query = query.where(PrintQueueItem.status.not_in(FINAL_STATUSES))

    result = await db.execute(query)
    items = result.scalars().all()
    return [_enrich_response(item) for item in items]


async def _resolve_queue_variants(
    db: AsyncSession,
    specs: list[QueueVariantCreate],
    current_user: User | None,
) -> list[tuple[QueueVariantCreate, LibraryFile, str]]:
    """Validate a cross-model candidate set and pair each file with its model (#671).

    Validated as a set, not file by file, because the failure modes are about the
    set: two candidates for the same printer give the resolver no basis to choose,
    and a set where nothing can ever run is a job that waits forever.

    At least one candidate must have an active printer — the rest may not, which
    is deliberate. Grouping the H2C slice before the H2C arrives is a reasonable
    thing to do, and refusing the whole queue action over it would be worse than
    letting that candidate simply never match.
    """
    file_ids = [s.library_file_id for s in specs]
    if len(set(file_ids)) != len(file_ids):
        raise HTTPException(400, "The same file cannot be listed twice as a variant")

    rows = (await db.execute(LibraryFile.active().where(LibraryFile.id.in_(file_ids)))).scalars().all()
    by_id = {f.id: f for f in rows}

    resolved: list[tuple[QueueVariantCreate, LibraryFile, str]] = []
    seen_models: dict[str, str] = {}
    any_active_printer = False

    for spec in specs:
        library_file = by_id.get(spec.library_file_id)
        # Same IDOR posture as the single-file path: a file the caller cannot read
        # is reported as missing rather than forbidden.
        if not library_file or (
            current_user
            and not current_user.has_permission(Permission.LIBRARY_READ_ALL.value)
            and library_file.created_by_id != current_user.id
        ):
            raise HTTPException(404, f"Library file not found: {spec.library_file_id}")
        if library_file.queue_only:
            raise HTTPException(400, "Queue-only upload sources cannot be used as cross-model variants")

        from backend.app.utils.filename import InvalidFilenameError, validate_print_filename

        try:
            validate_print_filename(library_file.filename)
        except InvalidFilenameError as e:
            raise HTTPException(400, str(e)) from e

        model = resolve_variant_model(library_file, spec.target_model)
        if not model:
            raise HTTPException(
                400,
                f"{library_file.filename} does not say which printer it was sliced for — "
                "set its target model explicitly",
            )

        # Cross-model safety gate (#2578), per candidate. A set is only as safe as
        # its worst member, and model-based dispatch has no human in the loop.
        sliced_for = (library_file.file_metadata or {}).get("sliced_for_model")
        if not is_gcode_compatible(sliced_for, model):
            raise HTTPException(
                400,
                f"{library_file.filename} was sliced for {sliced_for} and cannot be dispatched to {model} printers",
            )

        if model in seen_models:
            raise HTTPException(
                400,
                f"{library_file.filename} and {seen_models[model]} are both for {model} — "
                "variants must target different printers",
            )
        seen_models[model] = library_file.filename

        has_printer = (
            (
                await db.execute(
                    select(Printer).where(Printer.model == model).where(Printer.is_active == True)  # noqa: E712
                )
            )
            .scalars()
            .first()
        )
        any_active_printer = any_active_printer or bool(has_printer)

        resolved.append((spec, library_file, model))

    if not any_active_printer:
        raise HTTPException(400, f"No active printers for any of: {', '.join(seen_models)}")

    return resolved


def _variant_values(
    spec: QueueVariantCreate,
    library_file: LibraryFile,
    model: str,
    position: int,
) -> dict:
    """Column values for one candidate, from its own 3MF: each candidate is a different slice."""
    file_path = (
        settings.base_dir / library_file.file_path
    )  # SEC-PATH-OK: DB-stored; external-library rows may be absolute
    print_time = (library_file.file_metadata or {}).get("print_time_seconds")
    types, overrides = set(), None
    if file_path.exists():
        requirements = extract_filament_requirements(file_path, spec.plate_id)
        types = {requirement["type"] for requirement in requirements if requirement["type"]}
        plate_time = extract_print_time_from_3mf(file_path, spec.plate_id) if spec.plate_id else None
        print_time = print_time if plate_time is None else plate_time
        if spec.filament_overrides:
            overrides = overrides_for_plate(spec.filament_overrides, file_path, spec.plate_id)
            types |= {override["type"] for override in overrides if "type" in override}
    return {
        "position": position,
        "library_file_id": library_file.id,
        "target_model": model,
        "plate_id": spec.plate_id,
        "ams_mapping": json.dumps(spec.ams_mapping) if spec.ams_mapping else None,
        "nozzle_mapping": json.dumps(spec.nozzle_mapping) if spec.nozzle_mapping else None,
        "filament_overrides": json.dumps(overrides) if overrides else None,
        "required_filament_types": json.dumps(sorted(types)) if types else None,
        "print_time_seconds": print_time,
    }


@router.post("/", response_model=PrintQueueItemResponse)
async def add_to_queue(
    data: PrintQueueItemCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
    api_key_owner: User | None = Depends(resolve_api_key_owner),
):
    """Add an item to the print queue."""
    actor = current_user or api_key_owner
    # Inserting a new item ahead of pending work is a separate privilege from
    # simply creating a queue item.  Keep the check here (rather than only in
    # the modal) so API callers cannot bypass the queue policy.
    if (
        (data.insert_at_top or data.insert_position is not None)
        and actor is not None
        and not actor.has_permission(Permission.QUEUE_INSERT_TOP.value)
    ):
        raise HTTPException(status_code=403, detail="Missing required permission: queue:insert_top")
    # Normalize target_model (e.g., "Bambu Lab X1E" / "C13" -> "X1E").
    # normalize_model_name resolves internal codes first: the previous
    # `normalize_printer_model(x) or normalize_printer_model_id(x)` chain never
    # reached the code map, because the first call returns unknown input
    # unchanged — so a "C13" target stayed "C13", matched no printer row and
    # left the item waiting forever. Identical result for every other spelling.
    target_model_norm = normalize_model_name(data.target_model)

    # Cross-model alternatives (#671): several sliced files, whichever printer
    # frees up first. The whole candidate set is validated before anything is
    # written — a half-valid set would produce a job that can only reach some of
    # the printers the user asked for, with nothing to say which.
    variant_specs: list[tuple[QueueVariantCreate, LibraryFile, str]] = []
    if data.variants:
        if data.printer_id:
            raise HTTPException(
                400, "Cannot specify both printer_id and variants — pick a printer or offer alternatives"
            )
        if data.archive_id or data.library_file_id:
            raise HTTPException(
                400, "Cannot combine variants with archive_id or library_file_id — the variants are the files"
            )
        variant_specs = await _resolve_queue_variants(db, data.variants, actor)
        # Mirror the first candidate onto the item so the queue listing, the SJF
        # grouping and the "Any H2S" label have something before a printer is
        # picked. Resolution overwrites it with whichever candidate actually runs.
        target_model_norm = variant_specs[0][2]

    # Validate that either archive_id or library_file_id is provided.
    # A cross-model item deliberately holds neither: its files live on the
    # variant rows. Pointing library_file_id at one of them would be worse than
    # useless — that FK is ON DELETE CASCADE, so deleting a single alternative
    # would take the whole queue item with it.
    if not data.archive_id and not data.library_file_id and not data.variants:
        raise HTTPException(400, "Either archive_id or library_file_id must be provided")

    # Cannot specify both printer_id and target_model
    if data.printer_id and target_model_norm:
        raise HTTPException(400, "Cannot specify both printer_id and target_model")

    # Validate printer exists (if assigned)
    target_printer = None
    if data.printer_id is not None:
        result = await db.execute(select(Printer).where(Printer.id == data.printer_id))
        target_printer = result.scalar_one_or_none()
        if not target_printer:
            raise HTTPException(400, "Printer not found")

    # Validate target_model has active printers. Skipped for cross-model items:
    # target_model there is just the first candidate, and _resolve_queue_variants
    # has already required that *some* candidate has a printer.
    if target_model_norm and not data.variants:
        result = await db.execute(
            select(Printer).where(Printer.model == target_model_norm).where(Printer.is_active == True)  # noqa: E712
        )
        if not result.scalars().first():
            raise HTTPException(400, f"No active printers for model: {target_model_norm}")

    # Validate archive exists (if provided) and get it for filament extraction
    archive = None
    if data.archive_id:
        result = await db.execute(select(PrintArchive).where(PrintArchive.id == data.archive_id))
        archive = result.scalar_one_or_none()
        if not archive:
            raise HTTPException(400, "Archive not found")
        _assert_can_queue_archive(archive, actor)

    # Validate library file exists (if provided) and get it for filament extraction
    library_file = None
    if data.library_file_id:
        result = await db.execute(LibraryFile.active().where(LibraryFile.id == data.library_file_id))
        library_file = result.scalar_one_or_none()
        if not library_file:
            raise HTTPException(400, "Library file not found")
        _assert_can_queue_library_file(library_file, actor)
        if library_file.queue_only:
            # Serialize new queue references against discard/stale-source
            # cleanup. Once intake is sealed, no more fan-out items may attach.
            result = await db.execute(
                LibraryFile.active()
                .where(LibraryFile.id == data.library_file_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
            library_file = result.scalar_one_or_none()
            if not library_file:
                raise HTTPException(400, "Library file not found")
            _assert_can_queue_library_file(library_file, actor)
            if not library_file.queue_only:
                raise HTTPException(400, "Library file not found")
            if library_file.queue_source_sealed:
                retryable_failed_item = await db.scalar(
                    select(PrintQueueItem.id)
                    .where(
                        PrintQueueItem.library_file_id == library_file.id,
                        PrintQueueItem.status == "failed",
                        PrintQueueItem.archive_id.is_(None),
                    )
                    .limit(1)
                )
                if retryable_failed_item is None:
                    raise HTTPException(400, "Queue upload source is no longer accepting queue items")
        # Bambu SD card is FAT32/exFAT — illegal filename chars would 553 at
        # FTP upload time (#1540). Reject at queue time so the user gets the
        # actionable error before waiting in queue.
        from backend.app.utils.filename import InvalidFilenameError, validate_print_filename

        try:
            validate_print_filename(library_file.filename)
        except InvalidFilenameError as e:
            raise HTTPException(400, str(e)) from e

    # Explicit printer assignment must respect the same slice compatibility
    # boundary as model-based queueing. The scheduler repeats this check for
    # older rows and printer-model changes after queue creation.
    if target_printer:
        sliced_for_model = None
        if archive:
            sliced_for_model = archive.sliced_for_model
        elif library_file:
            sliced_for_model = (library_file.file_metadata or {}).get("sliced_for_model")
        if sliced_for_model and not is_gcode_compatible(sliced_for_model, target_printer.model):
            raise HTTPException(
                400,
                f"File was sliced for {sliced_for_model} and cannot be dispatched to {target_printer.model} printers",
            )

    # Model-based assignment checks the sliced materials while selecting a printer.
    source = archive or library_file
    file_path = settings.base_dir / source.file_path if source else None  # SEC-PATH-OK: DB-stored paths
    provided = [override.model_dump(exclude_unset=True) for override in data.filament_overrides or ()]
    try:
        required_types, filament_overrides = filament_contract(
            file_path, data.plate_id, provided or None, force_color_match=data.force_color_match
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    # Cached for shortest-job-first ordering.
    if archive:
        print_time = archive.print_time_seconds
    else:
        print_time = (library_file.file_metadata or {}).get("print_time_seconds") if library_file else None
    if data.plate_id and file_path and file_path.exists():
        plate_time = extract_print_time_from_3mf(file_path, data.plate_id)
        print_time = print_time if plate_time is None else plate_time

    # Validate project exists before insert so a bogus ID yields 404, not an FK-constraint 500
    if data.project_id is not None:
        project_result = await db.execute(select(Project).where(Project.id == data.project_id))
        if not project_result.scalar_one_or_none():
            raise HTTPException(status_code=404, detail="Project not found")

    quantity = max(1, data.quantity)
    values = {
        "printer_id": data.printer_id,
        "target_model": target_model_norm,
        "target_location": data.target_location,
        "required_filament_types": required_types if target_model_norm else None,
        "filament_overrides": filament_overrides,
        "force_color_match": data.force_color_match,
        "archive_id": data.archive_id,
        "library_file_id": data.library_file_id,
        "scheduled_time": data.scheduled_time,
        "auto_off_after": data.auto_off_after,
        "manual_start": data.manual_start,
        "wait_for_drying_complete": data.wait_for_drying_complete,
        "chamber_heat_soak": data.chamber_heat_soak,
        "heat_soak_temperature": data.heat_soak_temperature,
        "heat_soak_minutes": data.heat_soak_minutes,
        "skip_filament_check": data.skip_filament_check,
        "ams_mapping": json.dumps(data.ams_mapping) if data.ams_mapping else None,
        "plate_id": data.plate_id,
        "bed_levelling": data.bed_levelling,
        "flow_cali": data.flow_cali,
        "vibration_cali": data.vibration_cali,
        "layer_inspect": data.layer_inspect,
        "timelapse": data.timelapse,
        "use_ams": data.use_ams,
        "nozzle_offset_cali": data.nozzle_offset_cali,
        "gcode_injection": data.gcode_injection,
        # Queue-only uploads are removed once all queued jobs have made
        # Archive copies. Never let a caller mark a user-managed File for
        # automatic deletion.
        "cleanup_library_after_dispatch": bool(library_file and library_file.queue_only),
        "project_id": data.project_id,
        "created_by_id": actor.id if actor else None,
        "print_time_seconds": print_time,
    }
    try:
        items = await create_job(
            db,
            [values] * quantity,
            at=(data.insert_position or 1) if data.insert_at_top or data.insert_position is not None else None,
            variants=[
                _variant_values(spec, file, model, position)
                for position, (spec, file, model) in enumerate(variant_specs)
            ],
        )
        await db.commit()
    except SQLAlchemyError:
        # Keep a compact queue-specific breadcrumb alongside the traceback
        # emitted by the HTTP exception boundary. IDs are enough to identify
        # the operation; avoid logging the request body or source filenames.
        logger.error(
            "Queue insert database commit failed "
            "(archive_id=%s, library_file_id=%s, printer_id=%s, target_model=%s, quantity=%s)",
            data.archive_id,
            data.library_file_id,
            data.printer_id,
            target_model_norm,
            quantity,
        )
        raise

    await ws_manager.send_queue_work_changed()

    # Refresh the first item for the response
    item = items[0]
    await db.refresh(item)
    await db.refresh(item, ["archive", "printer", "library_file", "created_by"])

    source_name = f"archive {data.archive_id}" if data.archive_id else f"library file {data.library_file_id}"
    target_desc = data.printer_id or (f"model {target_model_norm}" if target_model_norm else "unassigned")
    qty_desc = f" (×{quantity})" if quantity > 1 else ""
    logger.info("Added %s to queue for %s%s", source_name, target_desc, qty_desc)

    # MQTT relay - publish queue job added
    try:
        from backend.app.services.mqtt_relay import mqtt_relay

        await mqtt_relay.on_queue_job_added(
            job_id=item.id,
            filename=item.archive.filename if item.archive else "",
            printer_id=item.printer_id,
            printer_name=item.printer.name if item.printer else None,
        )
    except Exception:
        pass  # Don't fail queue add if MQTT fails

    # Send notification for job added
    try:
        job_name = (
            item.archive.filename
            if item.archive
            else item.library_file.filename
            if item.library_file
            else f"Job #{item.id}"
        )
        job_name = job_name.replace(".gcode.3mf", "").replace(".3mf", "")
        if quantity > 1:
            job_name = f"{job_name} ×{quantity}"
        target = (
            item.printer.name if item.printer else (f"Any {item.target_model}" if target_model_norm else "Unassigned")
        )
        await notification_service.on_queue_job_added(
            job_name=job_name,
            target=target,
            db=db,
            printer_id=item.printer_id,
            printer_name=item.printer.name if item.printer else None,
        )
    except Exception:
        pass  # Don't fail queue add if notification fails

    return _enrich_response(item)


@router.patch("/bulk", response_model=PrintQueueBulkUpdateResponse)
async def bulk_update_queue_items(
    data: PrintQueueBulkUpdate,
    db: AsyncSession = Depends(get_db),
    auth_result: tuple[User | None, bool] = Depends(
        require_ownership_permission(
            Permission.QUEUE_UPDATE_ALL,
            Permission.QUEUE_UPDATE_OWN,
        )
    ),
):
    """Bulk update multiple queue items with the same values.

    Only pending items can be updated. Non-pending items are skipped.
    Items not owned by the user are also skipped (unless user has *_all permission).
    """
    user, can_modify_all = auth_result

    if not data.item_ids:
        raise HTTPException(400, "No item IDs provided")

    # Get fields to update (exclude item_ids and unset fields)
    update_data = data.model_dump(exclude={"item_ids"}, exclude_unset=True)
    if not update_data:
        raise HTTPException(400, "No fields to update")

    # Validate printer_id if being changed
    if "printer_id" in update_data and update_data["printer_id"] is not None:
        result = await db.execute(select(Printer).where(Printer.id == update_data["printer_id"]))
        if not result.scalar_one_or_none():
            raise HTTPException(400, "Printer not found")

    # Fetch all items
    result = await db.execute(select(PrintQueueItem).where(PrintQueueItem.id.in_(data.item_ids)))
    items = result.scalars().all()

    updated_count = 0
    skipped_count = 0

    for item in items:
        item = await lock_queue_item(db, item.id)
        if not item or item.status != "queued" or item.dispatching_at is not None:
            skipped_count += 1
            continue

        # Ownership check
        if not can_modify_all and item.created_by_id != user.id:
            skipped_count += 1
            continue

        for field, value in update_data.items():
            setattr(item, field, value)
        updated_count += 1

    await db.commit()
    if updated_count:
        await ws_manager.send_queue_work_changed()

    logger.info("Bulk updated %s queue items, skipped %s", updated_count, skipped_count)
    return PrintQueueBulkUpdateResponse(
        updated_count=updated_count,
        skipped_count=skipped_count,
        message=f"Updated {updated_count} items"
        + (f", skipped {skipped_count} non-pending/not-owned" if skipped_count else ""),
    )


@router.get("/{item_id}", response_model=PrintQueueItemResponse)
async def get_queue_item(
    item_id: int,
    db: AsyncSession = Depends(get_db),
    auth_result: tuple[User | None, bool] = Depends(
        require_ownership_permission(
            Permission.QUEUE_READ_ALL,
            Permission.QUEUE_READ_OWN,
        )
    ),
):
    """Get a specific queue item."""
    current_user, can_read_all = auth_result
    result = await db.execute(
        select(PrintQueueItem)
        .options(
            selectinload(PrintQueueItem.archive),
            selectinload(PrintQueueItem.printer),
            selectinload(PrintQueueItem.library_file),
            selectinload(PrintQueueItem.created_by),
            # Cross-model candidates (#671) and their files, for the card label.
            selectinload(PrintQueueItem.variants).selectinload(PrintQueueVariant.library_file),
        )
        .where(PrintQueueItem.id == item_id)
    )
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(404, "Queue item not found")
    if (
        current_user is not None
        and not can_read_all
        and (item.created_by_id is None or item.created_by_id != current_user.id)
    ):
        raise HTTPException(404, "Queue item not found")
    return _enrich_response(item)


@router.patch("/{item_id}", response_model=PrintQueueItemResponse)
async def update_queue_item(
    item_id: int,
    data: PrintQueueItemUpdate,
    db: AsyncSession = Depends(get_db),
    auth_result: tuple[User | None, bool] = Depends(
        require_ownership_permission(
            Permission.QUEUE_UPDATE_ALL,
            Permission.QUEUE_UPDATE_OWN,
        )
    ),
):
    """Update a queue item."""
    user, can_modify_all = auth_result

    item = await lock_queue_item(db, item_id)
    if item:
        # Keep the write lock from above while eager-loading candidates for the
        # edit guard and response payload.
        result = await db.execute(
            select(PrintQueueItem)
            .options(selectinload(PrintQueueItem.variants).selectinload(PrintQueueVariant.library_file))
            .where(PrintQueueItem.id == item_id)
        )
        item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(404, "Queue item not found")

    # Ownership check
    if not can_modify_all:
        if item.created_by_id != user.id:
            raise HTTPException(403, "You can only update your own queue items")

    if item.status != "queued":
        raise HTTPException(400, "Can only update pending items")

    if item.status == "queued" and item.dispatching_at is not None:
        raise HTTPException(409, "Item is being dispatched — cancel it first to make changes")

    update_data = data.model_dump(exclude_unset=True)

    # Normalize target_model if being updated (see add_to_queue for why the
    # code map has to run first).
    if "target_model" in update_data and update_data["target_model"]:
        update_data["target_model"] = normalize_model_name(update_data["target_model"])

    # A cross-model item (#671) owns its own printer decision: each candidate
    # carries its model, and the resolver folds the winner onto the row at
    # dispatch. Assigning a printer here would leave a row with variants *and* a
    # printer_id, and the fixed-printer branch of the scheduler wins that race —
    # so it would dispatch a row whose library_file_id is still null and die in
    # the upload. Narrowing target_model is refused for the same reason: it
    # would silently discard every alternative the user queued.
    #
    # Compared against the current value rather than merely present, because the
    # edit dialog re-sends target_model unchanged on every save.
    if item.variants:
        for field in ("printer_id", "target_model"):
            if field in update_data and update_data[field] != getattr(item, field):
                raise HTTPException(
                    400,
                    "This job has printer alternatives — remove them before assigning a printer or model",
                )

    # Cannot specify both printer_id and target_model
    new_printer_id = update_data.get("printer_id", item.printer_id)
    new_target_model = update_data.get("target_model", item.target_model)
    if new_printer_id and new_target_model:
        raise HTTPException(400, "Cannot specify both printer_id and target_model")

    # Validate new printer_id if being changed (and not None)
    if "printer_id" in update_data and update_data["printer_id"] is not None:
        result = await db.execute(select(Printer).where(Printer.id == update_data["printer_id"]))
        if not result.scalar_one_or_none():
            raise HTTPException(400, "Printer not found")

    # Validate target_model has active printers
    if "target_model" in update_data and update_data["target_model"]:
        result = await db.execute(
            select(Printer).where(Printer.model == update_data["target_model"]).where(Printer.is_active == True)  # noqa: E712
        )
        if not result.scalars().first():
            raise HTTPException(400, f"No active printers for model: {update_data['target_model']}")

    # "Print Anyway" acknowledged while editing: persist it and clear any
    # existing deficit block, as the start route does, so the scheduler does
    # not re-flag the edited item on its next tick (#184).
    if update_data.get("skip_filament_check"):
        update_data["filament_short"] = False

    # Serialize ams_mapping to JSON for TEXT column storage
    if "ams_mapping" in update_data:
        update_data["ams_mapping"] = json.dumps(update_data["ams_mapping"]) if update_data["ams_mapping"] else None

    async def _queue_source_path() -> Path | None:
        if item.archive_id:
            archive_result = await db.execute(select(PrintArchive).where(PrintArchive.id == item.archive_id))
            archive = archive_result.scalar_one_or_none()
            if archive:
                archive_path = Path(archive.file_path)
                return (
                    archive_path if archive_path.is_absolute() else settings.base_dir / archive_path
                )  # SEC-PATH-OK: archive.file_path is DB-stored and internally generated; legacy rows may be absolute
        elif item.library_file_id:
            library_result = await db.execute(select(LibraryFile).where(LibraryFile.id == item.library_file_id))
            library_file = library_result.scalar_one_or_none()
            if library_file:
                library_path = Path(library_file.file_path)
                return (
                    library_path if library_path.is_absolute() else settings.base_dir / library_path
                )  # SEC-PATH-OK: library_file.file_path is DB-stored and may refer to configured external libraries
        return None

    async def _resolved_filament_overrides(provided_overrides: list[dict] | None) -> list[dict]:
        source_path = await _queue_source_path()
        plate_id = update_data.get("plate_id", item.plate_id)
        requirements = (
            extract_filament_requirements(source_path, plate_id) if source_path and source_path.exists() else []
        )
        return build_queue_filament_overrides(
            requirements,
            provided_overrides,
            force_color_match=update_data.get("force_color_match", item.force_color_match),
        )

    # A plate change points at a different sliced filament set. If the client
    # did not provide explicit overrides, rebuild them from the new plate so the
    # scheduler does not enforce the previous plate's colour requirements.
    if "plate_id" in update_data and "filament_overrides" not in update_data:
        try:
            resolved_overrides = await _resolved_filament_overrides(None)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        update_data["filament_overrides"] = json.dumps(resolved_overrides) if resolved_overrides else None

    # A queue-level toggle is an explicit all-slot preference. Keep the
    # persisted per-slot flags in sync even when the client omits the mapping
    # payload (for example a direct PATCH from an API client).
    if "force_color_match" in update_data and "filament_overrides" not in update_data and item.filament_overrides:
        try:
            current_overrides = json.loads(item.filament_overrides)
        except (json.JSONDecodeError, TypeError) as e:
            raise HTTPException(status_code=400, detail="Existing filament metadata is invalid") from e
        if not isinstance(current_overrides, list):
            raise HTTPException(status_code=400, detail="Existing filament metadata is invalid")
        update_data["filament_overrides"] = [
            {**override, "force_color_match": update_data["force_color_match"]}
            for override in current_overrides
            if isinstance(override, dict)
        ]

    # Serialize filament_overrides to JSON for TEXT column storage
    if "filament_overrides" in update_data:
        provided_overrides = update_data["filament_overrides"]
        if isinstance(provided_overrides, str):
            pass
        elif provided_overrides:
            try:
                resolved_overrides = await _resolved_filament_overrides(provided_overrides)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e)) from e
            update_data["filament_overrides"] = json.dumps(resolved_overrides) if resolved_overrides else None
        else:
            update_data["filament_overrides"] = None

    # Serialize H2C rack-swap nozzle pick (#1780) to JSON for TEXT column
    # storage; same Text-as-opaque-blob convention as ams_mapping above.
    if "nozzle_mapping" in update_data:
        update_data["nozzle_mapping"] = (
            json.dumps(update_data["nozzle_mapping"]) if update_data["nozzle_mapping"] else None
        )

    # Validation above contains awaits, so a scheduler worker may have claimed
    # this row after the initial guard. Re-check immediately before mutating it.
    if item.status == "queued":
        claimed = (
            await db.execute(select(PrintQueueItem.dispatching_at).where(PrintQueueItem.id == item_id))
        ).scalar_one_or_none()
        if claimed is not None:
            raise HTTPException(409, "Item is being dispatched — cancel it first to make changes")

    for field, value in update_data.items():
        setattr(item, field, value)

    await db.commit()
    await ws_manager.send_queue_work_changed()
    await db.refresh(item, ["archive", "printer", "library_file", "created_by"])

    logger.info("Updated queue item %s", item_id)
    return _enrich_response(item)


@router.delete("/{item_id}")
async def delete_queue_item(
    item_id: int,
    db: AsyncSession = Depends(get_db),
    auth_result: tuple[User | None, bool] = Depends(
        require_ownership_permission(
            Permission.QUEUE_DELETE_ALL,
            Permission.QUEUE_DELETE_OWN,
        )
    ),
):
    """Remove an item, preserving the last source for an active order plate."""
    user, can_modify_all = auth_result

    item = await lock_queue_item(db, item_id)
    if not item:
        raise HTTPException(404, "Queue item not found")

    # Ownership check
    if not can_modify_all:
        if item.created_by_id != user.id:
            raise HTTPException(403, "You can only delete your own queue items")

    if item.status in HOLDING_STATUSES:
        raise HTTPException(409, "Stop the job and clear its plate before removing it")
    if item.status == "queued":
        await transition_queue_item(db, item, "queued", "unsuccessful", action="cancel")
    library_file_id = item.library_file_id if item.cleanup_library_after_dispatch else None
    from backend.app.services.archive import detach_dispatch_archive_links

    await detach_dispatch_archive_links(db, [item.id])
    await db.delete(item)
    if library_file_id is not None:
        # Remove an auto-uploaded Queue source once no queue item needs it.
        await remove_queue_only_source_if_unused(db, library_file_id, exclude_item_id=item_id)
    await db.commit()

    from backend.app.services.print_scheduler import scheduler

    scheduler.cancel_inflight(item_id)

    logger.info("Deleted queue item %s", item_id)
    return {"message": "Queue item deleted", "deleted": True}


@router.post("/reorder")
async def reorder_queue(
    data: PrintQueueReorder,
    db: AsyncSession = Depends(get_db),
    auth_result: tuple[User | None, bool] = Depends(
        require_ownership_permission(
            Permission.QUEUE_UPDATE_ALL,
            Permission.QUEUE_UPDATE_OWN,
        )
    ),
):
    """Bulk update positions for pending queue items within the caller's scope."""
    user, can_modify_all = auth_result
    if user is not None and not user.has_permission(Permission.QUEUE_REORDER.value):
        raise HTTPException(403, "You do not have permission to reorder queue items")

    item_ids = [reorder_item.id for reorder_item in data.items]
    if len(item_ids) != len(set(item_ids)):
        raise HTTPException(400, "Duplicate queue item IDs are not allowed")
    if not item_ids:
        return {"message": "Reordered 0 items"}

    result = await db.execute(select(PrintQueueItem).where(PrintQueueItem.id.in_(item_ids)).with_for_update())
    items_by_id = {item.id: item for item in result.scalars().all()}

    if user is not None and not can_modify_all:
        requested_items = [items_by_id.get(item_id) for item_id in item_ids]
        if any(item is None for item in requested_items):
            raise HTTPException(404, "Queue item not found")
        if any(item.status != "queued" for item in requested_items if item is not None):
            raise HTTPException(400, "Only pending queue items can be reordered")
        if any(item.created_by_id != user.id for item in requested_items if item is not None):
            raise HTTPException(403, "You can only reorder your own queue items")

        # An own-only caller may rearrange an owned contiguous block, but must
        # not be able to jump it over another user's item by submitting an
        # arbitrary position.  The submitted positions therefore have to be
        # the same positions currently occupied by the requested items, and
        # every pending item in that interval must be part of the request.
        requested_positions = {
            item_id: reorder_item.position for item_id, reorder_item in zip(item_ids, data.items, strict=True)
        }
        current_positions = {item.id: item.position for item in requested_items if item is not None}
        if set(requested_positions.values()) != set(current_positions.values()):
            raise HTTPException(403, "You can only reorder your own contiguous queue items")

        queue_printer_id = requested_items[0].printer_id
        if any(item.printer_id != queue_printer_id for item in requested_items):
            raise HTTPException(400, "Queue items must belong to the same printer")
        pending_query = (
            select(PrintQueueItem)
            .where(PrintQueueItem.status == "queued")
            .where(
                PrintQueueItem.printer_id.is_(None)
                if queue_printer_id is None
                else PrintQueueItem.printer_id == queue_printer_id
            )
            .where(PrintQueueItem.position >= min(current_positions.values()))
            .where(PrintQueueItem.position <= max(current_positions.values()))
            .with_for_update()
        )
        pending_result = await db.execute(pending_query)
        blocked_items = [item for item in pending_result.scalars().all() if item.id not in items_by_id]
        if blocked_items:
            raise HTTPException(403, "You can only reorder your own contiguous queue items")

    updated_count = 0
    for reorder_item in data.items:
        item = items_by_id.get(reorder_item.id)
        if item and item.status == "queued":
            item.position = reorder_item.position
            updated_count += 1

    await db.commit()
    logger.info("Reordered %s queue items", len(data.items))
    return {"message": f"Reordered {len(data.items)} items"}


@router.post("/{item_id}/cancel")
@router.post("/{item_id}/stop")
async def cancel_queue_item(
    item_id: int,
    db: AsyncSession = Depends(get_db),
    auth_result: tuple[User | None, bool] = Depends(
        require_ownership_permission(Permission.QUEUE_UPDATE_ALL, Permission.QUEUE_UPDATE_OWN)
    ),
):
    from backend.app.services.queue_actions import cancel_job

    user, can_modify_all = auth_result
    item = await lock_queue_item(db, item_id)
    if item is None:
        raise HTTPException(404, "Queue item not found")
    if user is not None and not can_modify_all and item.created_by_id != user.id:
        raise HTTPException(403, "You can only cancel your own queue items")
    try:
        await cancel_job(db, item)
    except InvalidQueueTransition as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"message": "Job cancelled"}


# Keep the established import name and /stop URL for existing clients.
stop_queue_item = cancel_queue_item


@router.post("/{item_id}/clear-plate")
async def clear_queue_plate(
    item_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PRINTERS_CLEAR_PLATE),
):
    item = await lock_queue_item(db, item_id)
    if item is None:
        raise HTTPException(404, "Queue item not found")
    try:
        await clear_job_plate(db, item)
    except InvalidQueueTransition as exc:
        raise HTTPException(409, str(exc)) from exc
    await db.commit()
    return {"message": "Plate cleared"}


@router.post("/{item_id}/retry", response_model=PrintQueueItemResponse)
async def retry_queue_item(
    item_id: int,
    db: AsyncSession = Depends(get_db),
    auth_result: tuple[User | None, bool] = Depends(
        require_ownership_permission(Permission.QUEUE_UPDATE_ALL, Permission.QUEUE_UPDATE_OWN)
    ),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
):
    user, can_modify_all = auth_result
    if user is not None and not user.has_permission(Permission.QUEUE_INSERT_TOP.value):
        raise HTTPException(403, "Retry requires permission to insert at the top of the queue")
    old = await lock_queue_item(db, item_id)
    if old is None:
        raise HTTPException(404, "Queue item not found")
    if user is not None and not can_modify_all and old.created_by_id != user.id:
        raise HTTPException(403, "You can only retry your own queue items")
    if old.status not in ("failed", "cancelled"):
        raise HTTPException(409, "Only failed or cancelled jobs awaiting plate clear can be retried")
    excluded = {
        "id",
        "status",
        "created_at",
        "position",
        "started_at",
        "completed_at",
        "physical_outcome",
        "physical_completed_at",
        "physical_failure_reason",
        "stop_requested_at",
        "manual_start",
        "dispatched_at",
        "dispatch_subtask_id",
        "dispatching_at",
        "error_message",
        "waiting_reason",
        "been_jumped",
        "preheat_owner",
        "preheat_requested_at",
        "preheat_checked_at",
        "preheat_started_at",
    }
    values = {
        column.name: getattr(old, column.name)
        for column in PrintQueueItem.__table__.columns
        if column.name not in excluded
    }

    def source_available(source: LibraryFile | PrintArchive | None) -> bool:
        if source is None or source.deleted_at is not None:
            return False
        path = Path(source.file_path)
        path = path if path.is_absolute() else safe_join_under(settings.base_dir, source.file_path, http=False)
        return path.is_file()

    candidates = list(
        (
            await db.scalars(
                select(PrintQueueVariant)
                .where(PrintQueueVariant.queue_item_id == old.id)
                .options(selectinload(PrintQueueVariant.library_file))
                .order_by(PrintQueueVariant.position)
            )
        ).all()
    )
    candidates = [candidate for candidate in candidates if source_available(candidate.library_file)]
    if candidates:
        # Retry the user's original choices, rather than only the winning
        # slice folded onto the old job at dispatch. Keep per-file snapshots
        # intact; a new job starts with fresh candidate attempt counts.
        values.update(
            library_file_id=None,
            archive_id=None,
            printer_id=None,
            target_model=candidates[0].target_model,
            cleanup_library_after_dispatch=False,
        )
        for field in ("plate_id", "ams_mapping", "nozzle_mapping", "filament_overrides", "required_filament_types"):
            values[field] = getattr(candidates[0], field)
    else:
        library = await db.get(LibraryFile, old.library_file_id) if old.library_file_id is not None else None
        if source_available(library):
            values["archive_id"] = None
        else:
            archive = await db.get(PrintArchive, old.archive_id) if old.archive_id is not None else None
            if not source_available(archive):
                raise HTTPException(409, "The print source is no longer available")
            values["library_file_id"] = None
            values["cleanup_library_after_dispatch"] = False
        if old.target_model:
            # An "Any machine" retry returns to the pool. The printer and the
            # tray mapping bound for it at dispatch are chosen again.
            values["printer_id"] = None
            values["ams_mapping"] = None

    variants = [
        {
            column.name: getattr(candidate, column.name)
            for column in PrintQueueVariant.__table__.columns
            if column.name not in {"id", "queue_item_id", "created_at", "attempt_count"}
        }
        for candidate in candidates
    ]
    [new] = await create_job(db, [values], at="top", variants=variants)
    await db.commit()
    await ws_manager.send_queue_work_changed()
    return await get_queue_item(new.id, db, (user, can_modify_all))


@router.post("/{item_id}/resolve-dispatch")
async def resolve_queue_dispatch(
    item_id: int,
    data: DispatchResolution,
    db: AsyncSession = Depends(get_db),
    auth_result: tuple[User | None, bool] = Depends(
        require_ownership_permission(Permission.QUEUE_UPDATE_ALL, Permission.QUEUE_UPDATE_OWN)
    ),
):
    """Resolve an unconfirmed dispatch after checking the physical printer."""
    from backend.app.services.print_scheduler import scheduler
    from backend.app.services.printer_manager import printer_manager

    user, can_modify_all = auth_result
    item = await lock_queue_item(db, item_id)
    if not item:
        raise HTTPException(404, "Queue item not found")
    if not can_modify_all and user is not None and item.created_by_id != user.id:
        raise HTTPException(403, "You can only resolve your own queue items")
    if not needs_dispatch_resolution(item):
        raise HTTPException(409, "This job is no longer awaiting dispatch confirmation. Refresh and retry.")
    state = printer_manager.get_status(item.printer_id)
    if state and state.connected:
        observed = telemetry_identity(state)
        if (
            observed
            and observed != item.dispatch_subtask_id
            and state.state in ("RUNNING", "PAUSE", "PREPARE", "SLICING")
        ):
            raise HTTPException(
                409, "The printer reports a different job. Stop or inspect it before resolving this job."
            )
        if observed == item.dispatch_subtask_id:
            from backend.app.services.print_scheduler import _queue_status_from_dispatch_telemetry

            known = _queue_status_from_dispatch_telemetry(state, item.dispatch_subtask_id)
            if known in ("completed", "failed") or (known == "printing" and data.outcome == "failed"):
                raise HTTPException(409, "Printer telemetry has confirmed this job. Refresh and retry.")
    now = datetime.now(timezone.utc)
    values = {
        "error_message": "Confirmed printing by user" if data.outcome == "printing" else "Printer didn't start the job"
    }
    values["started_at" if data.outcome == "printing" else "completed_at"] = now
    await transition_queue_item(db, item, "dispatching", data.outcome, values=values)
    await db.commit()
    if data.outcome == "printing":
        await scheduler._publish_queue_job_started(item.id)
    return {"message": "Dispatch resolved"}


@router.post("/{item_id}/skip-heat-soak")
async def skip_queue_item_heat_soak(
    item_id: int,
    db: AsyncSession = Depends(get_db),
    auth_result: tuple[User | None, bool] = Depends(
        require_ownership_permission(
            Permission.QUEUE_UPDATE_ALL,
            Permission.QUEUE_UPDATE_OWN,
        )
    ),
):
    """Skip the active heat-soak stage and return the item to dispatchable state."""
    user, can_modify_all = auth_result

    item = await lock_queue_item(db, item_id)
    if not item:
        raise HTTPException(404, "Queue item not found")

    if not can_modify_all and user is not None:
        if item.created_by_id is None or item.created_by_id != user.id:
            raise HTTPException(403, "You can only update your own queue items")

    if item.status != "preheating":
        if heat_soak_dispatch_started(item):
            await db.rollback()
            return {"message": "Heat soak skipped"}
        raise HTTPException(400, f"Can only skip heat soak for preheating items, current status: '{item.status}'")

    result = await skip_heat_soak(db, item)
    if result == SkipHeatSoakResult.PRINTER_NOT_READY:
        raise HTTPException(409, "Printer is not ready to start; wait for it to report idle, then retry")
    if result != SkipHeatSoakResult.SKIPPED:
        raise HTTPException(409, "Heat soak changed during preparation; refresh and retry")
    logger.info("Skipped heat soak for queue item %s", item_id)
    return {"message": "Heat soak skipped"}


@router.post("/{item_id}/start")
async def start_queue_item(
    item_id: int,
    skip_filament_check: bool = Query(default=False),
    db: AsyncSession = Depends(get_db),
    auth_result: tuple[User | None, bool] = Depends(
        require_ownership_permission(
            Permission.QUEUE_UPDATE_ALL,
            Permission.QUEUE_UPDATE_OWN,
        )
    ),
):
    """Manually start a staged (manual_start) queue item.

    Ownership-scoped (#1625-followup): callers with QUEUE_UPDATE_OWN can
    start their own items + claim ownership of NULL-owner items (VP-uploaded
    items arrive unattributed per #1670). Callers with QUEUE_UPDATE_ALL can
    start any item. Pre-fix this required QUEUE_UPDATE_OWN with no ownership
    check, so _OWN holders could start anyone's queue items via direct API.

    Clears the manual_start flag so the scheduler picks it up. When
    ``skip_filament_check`` is false (the default) the live filament
    deficit (#1496) is checked first — if the assigned spool can't satisfy
    a slot's required grams, the route returns ``409`` with the deficit
    payload so the caller can show a confirm dialog and retry with
    ``skip_filament_check=true``.
    """
    user, can_modify_all = auth_result

    result = await db.execute(
        select(PrintQueueItem)
        .options(
            selectinload(PrintQueueItem.archive),
            selectinload(PrintQueueItem.printer),
            selectinload(PrintQueueItem.library_file),
            selectinload(PrintQueueItem.variants).selectinload(PrintQueueVariant.library_file),
        )
        .where(PrintQueueItem.id == item_id)
    )
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(404, "Queue item not found")

    # Ownership check — softer than /cancel because /start is the entry point
    # for #1670's VP-import flow: an unowned item is claimable by the first
    # _OWN holder who clicks ▶, and the route below credits them as owner.
    # An item with a DIFFERENT owner → 403.
    if not can_modify_all and user is not None:
        if item.created_by_id is not None and item.created_by_id != user.id:
            raise HTTPException(403, "You can only start your own queue items")

    if item.status != "queued":
        raise HTTPException(400, f"Can only start queued items, current status: '{item.status}'")

    # Live deficit check — re-evaluated against current spool state, so a
    # spool swap between scheduler flagging and the user clicking ▶ clears
    # the block automatically.
    if not skip_filament_check:
        deficit = await compute_deficit_for_queue_item(db, item)
        if deficit:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "insufficient_filament",
                    "deficit": [d.to_dict() for d in deficit],
                },
            )

    # Print Anyway / no deficit: clear the flags and let the scheduler dispatch.
    item.manual_start = False
    item.filament_short = False
    # Persist the user's "Print Anyway" decision so the scheduler does not
    # immediately re-flag this item on the next tick (#1698-followup). The
    # pre-fix behaviour bounced between "user said anyway" and
    # "scheduler re-blocked on same deficit" forever.
    if skip_filament_check:
        item.skip_filament_check = True
    # Credit the clicker as the item's owner when no prior owner is set —
    # VP-uploaded queue items arrive over FTP unattributed, so without this
    # the print log's User column stays blank even when auth is on
    # (#1670). An item that already has a creator (UI-added queue items)
    # keeps that attribution; the dispatcher is not promoted over the
    # original uploader.
    if user is not None and item.created_by_id is None:
        item.created_by_id = user.id
    await db.commit()
    await db.refresh(item, ["archive", "printer", "library_file", "created_by"])

    logger.info(
        "Manually started queue item %s (cleared manual_start; skip_filament_check=%s)",
        item_id,
        skip_filament_check,
    )
    return _enrich_response(item)

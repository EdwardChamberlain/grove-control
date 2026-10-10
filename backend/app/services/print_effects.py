"""What happens around a print's start and end: Archive, notifications, usage, photos, energy and cleanup.

The lifecycle runs print_started and print_completed once the
transition that observed the print commits; intake waits for them before the
printer's next event. Each effect fails on its own, without undoing the
transition or skipping the others.
"""

import asyncio
import logging
import posixpath
import time
import uuid
from contextlib import suppress
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

from sqlalchemy import func, or_, select

from backend.app.api.routes.maintenance import _get_printer_maintenance_internal, ensure_default_types
from backend.app.core.config import settings as app_settings
from backend.app.core.database import async_session
from backend.app.core.tasks import spawn_background_task
from backend.app.core.websocket import ws_manager
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.smart_plug import SmartPlug
from backend.app.services.archive import ArchiveService, peek_plate_index_in_3mf, swap_plate_suffix
from backend.app.services.bambu_ftp import (
    FileNotOnPrinterError,
    cache_3mf_download,
    clear_3mf_cache,
    download_file_async,
    get_cached_3mf,
    get_ftp_retry_settings,
    with_ftp_retry,
)
from backend.app.services.homeassistant import homeassistant_service
from backend.app.services.job_identity import event_identity, telemetry_identity
from backend.app.services.lifecycle.engine import lock_queue_item, transition_queue_item, writer
from backend.app.services.mqtt_relay import mqtt_relay
from backend.app.services.notification_service import notification_service
from backend.app.services.printer_manager import parse_plate_id, printer_manager
from backend.app.services.smart_plug_manager import smart_plug_manager
from backend.app.services.spool_assignment_notifications import notify_missing_spool_assignments_on_print_start
from backend.app.services.spoolman_tracking import (
    cleanup_tracking as _cleanup_spoolman_tracking,
    report_usage as _report_spoolman_usage,
    store_print_data as _store_spoolman_print_data,
)
from backend.app.services.tasmota import tasmota_service
from backend.app.utils.safe_path import PathTraversalError, safe_join_under

logger = logging.getLogger(__name__)


# HMS short-code → human-readable failure reason. Used by _dispatch_archive_update
# when status="failed" to label the print's failure_reason in archives.
#
# Earlier code matched on `module` alone (e.g. "any module 0x0C HMS → Layer shift"),
# which is wrong on two counts:
#   1. Real layer-shift codes live in module 0x03 (see Bambu wiki), not 0x0C.
#   2. Module 0x0C is "Motion Controller" — broad category that also covers cameras
#      and visual markers, AND the H2D firmware emits a 0x0C HMS (0C00_001B, not in
#      the public wiki) as part of its user-cancel sequence. Matching on the module
#      alone caused user-cancellations to be archived as "Layer shift" failures.
# We now match by full short code only — anything not in this map leaves
# failure_reason=None rather than guessing.
_HMS_FAILURE_REASONS: dict[str, str] = {
    # Layer shift / step loss
    "0300_4057": "Layer shift",
    "0300_4068": "Layer shift",
    "0300_800C": "Layer shift",
    # Filament runout (printer-side & per-AMS-slot)
    "0300_8004": "Filament runout",
    "0700_8011": "Filament runout",
    "0701_8011": "Filament runout",
    "0702_8011": "Filament runout",
    "0703_8011": "Filament runout",
    "0704_8011": "Filament runout",
    "0705_8011": "Filament runout",
    "0706_8011": "Filament runout",
    "0707_8011": "Filament runout",
    "07FF_8011": "Filament runout",
    # Clogged nozzle / extruder
    "0300_4006": "Clogged nozzle",
    "0300_8016": "Clogged nozzle",
    "0300_801C": "Clogged nozzle",
    "0700_8003": "Clogged nozzle",
    "0700_8007": "Clogged nozzle",
    "0700_8013": "Clogged nozzle",
    "0701_8003": "Clogged nozzle",
    "0701_8007": "Clogged nozzle",
    "0701_8013": "Clogged nozzle",
    "0702_8003": "Clogged nozzle",
}


async def _one(db, query):
    """Read one optional row for a print effect."""
    return (await db.execute(query)).scalar_one_or_none()


def _hms_short_code(attr: int, code: int | str) -> str:
    """Build the canonical "MMMM_CCCC" HMS short code from raw attr/code values."""
    if isinstance(code, str):
        code_int = int(code.replace("0x", ""), 16) if code else 0
    else:
        code_int = int(code or 0)
    attr_int = int(attr or 0)
    return f"{(attr_int >> 16) & 0xFFFF:04X}_{code_int & 0xFFFF:04X}"


def derive_failure_reason(status: str, hms_errors: list[dict] | None) -> str | None:
    """Derive a human-readable failure_reason for an archived print.

    Returns "User cancelled" for cancelled/aborted prints; for failed prints,
    returns the first matching reason from _HMS_FAILURE_REASONS, or None when
    no HMS code matches (don't guess — null is honest).
    """
    if status in ("aborted", "cancelled"):
        return "User cancelled"
    if status != "failed":
        return None
    for err in hms_errors or []:
        short_code = _hms_short_code(err.get("attr", 0), err.get("code", 0))
        if short_code in _HMS_FAILURE_REASONS:
            return _HMS_FAILURE_REASONS[short_code]
    return None


async def _get_plug_energy(plug, db) -> dict | None:
    """Get energy from plug regardless of type (Tasmota, Home Assistant, MQTT, or REST).

    For HA plugs, configures the service with current settings from DB.
    For MQTT plugs, returns data from the subscription service.
    For REST plugs, polls the status URL with JSON path extraction.
    """
    if plug.plug_type == "homeassistant":
        from backend.app.api.routes.settings import get_homeassistant_settings

        ha_settings = await get_homeassistant_settings(db)
        homeassistant_service.configure(ha_settings["ha_url"], ha_settings["ha_token"])
        return await homeassistant_service.get_energy(plug)
    elif plug.plug_type == "mqtt":
        # MQTT plugs report "today" energy, not lifetime total
        # For per-print tracking, we use "today" as the counter (resets at midnight)
        mqtt_data = mqtt_relay.smart_plug_service.get_plug_data(plug.id)
        if mqtt_data:
            return {
                "power": mqtt_data.power,
                "today": mqtt_data.energy,
                "total": mqtt_data.energy,  # Use today as total for per-print calculations
            }
        return None
    elif plug.plug_type == "rest":
        from backend.app.services.rest_smart_plug import rest_smart_plug_service

        return await rest_smart_plug_service.get_energy(plug)
    else:
        return await tasmota_service.get_energy(plug)


async def _record_energy_start(archive, printer_id: int, db, *, context: str = "") -> bool:
    """Capture the smart plug lifetime counter on the archive at print start.

    Persists `energy_start_kwh` on the archive row (#941) so per-print energy
    tracking survives a backend restart mid-print. The print-end handler reads
    this value back from the DB and computes the delta against the current
    plug counter.
    """
    _logger = logging.getLogger(__name__)
    try:
        plug = await _one(db, select(SmartPlug).where(SmartPlug.printer_id == printer_id))
        if not plug:
            _logger.info("[ENERGY] No smart plug for printer %s (archive %s)", printer_id, archive.id)
            return False
        energy = await _get_plug_energy(plug, db)
        if not energy or energy.get("total") is None:
            _logger.warning("[ENERGY] No 'total' in energy response for archive %s", archive.id)
            return False
        archive.energy_start_kwh = float(energy["total"])
        await db.commit()
        _logger.info(
            "[ENERGY] Recorded starting energy%s for archive %s: %s kWh",
            f" ({context})" if context else "",
            archive.id,
            energy["total"],
        )
        return True
    except Exception as e:
        _logger.warning("[ENERGY] Failed to record starting energy for archive %s: %s", archive.id, e)
        return False


def _compute_run_filament_grams(
    status: str,
    archive_filament_used_grams: float | None,
    progress: float | int | None,
    usage_results: list[dict] | None,
) -> float | None:
    """Per-run filament for PrintLogEntry, partial- and tracker-aware (#1378, #1390).

    Priority for every status:
        1. Sum of tracked spool deltas in ``usage_results`` (AMS-measured
           weight delta — same source that drives "Total Consumed" on the
           Inventory page, so Stats and Inventory totals stay aligned).
        2. For ``completed``: the slicer estimate (no tracker available, fall
           back to the canonical "this print used X" value).
        3. For partial statuses: ``estimate * progress%``.
        4. ``None`` if nothing is known.
    """
    tracked_grams = sum(r.get("weight_used") or 0 for r in (usage_results or []))
    if tracked_grams > 0:
        return round(tracked_grams, 1)

    if status == "completed":
        return archive_filament_used_grams

    if archive_filament_used_grams:
        scale = max(0.0, min(((progress or 0) / 100.0), 1.0))
        if scale > 0:
            return round(archive_filament_used_grams * scale, 1)

    return None


def _partial_progress_scale(progress: int | float | None) -> float:
    """Clamp ``progress / 100`` into [0.0, 1.0] for partial-print scaling.

    Used by every site that multiplies a "would-have-used" slicer estimate
    down to "actually-used" for failed / cancelled / stopped prints. Centralised
    so the three sites in ``_background_notifications`` (and the per-plate
    override helper) can't drift apart on the coercion shape.
    """
    return max(0.0, min((progress or 0) / 100.0, 1.0))


def _scope_notification_archive_data_to_plate(
    archive_data: dict,
    archive_file_path: str | None,
    plate_id: int | None,
    print_status: str,
    progress: int | float | None,
    base_dir: Path,
) -> dict:
    """Override summed-across-plates totals in ``archive_data`` with the values
    for ``plate_id`` so the completion notification reports what was actually
    printed, not the whole project (#1785).

    The 3MF parser at services/archive.py:200-264 sums ``prediction`` and
    ``weight`` across every plate of a multi-plate file (#1593) — correct for
    the archive card's "whole project" headline, wrong for the completion
    notification of a single-plate print. The queue UI already re-reads the
    3MF per-plate at print_queue.py:272-285; this helper mirrors that for the
    notification payload (filament grams, time estimate, per-slot breakdown).

    No-ops when ``plate_id`` is None, the file is missing, or the 3MF carries
    no per-plate values — in every fail case the original ``archive_data`` is
    returned unchanged so the notification still sends.
    """
    if plate_id is None or not archive_file_path:
        return archive_data

    from backend.app.utils.threemf_tools import (
        extract_filament_usage_from_3mf,
        extract_print_time_from_3mf,
    )

    archive_path = base_dir / archive_file_path  # SEC-PATH-OK: an Archive's file_path is written by Grove
    if not archive_path.exists():
        return archive_data

    plate_slots = extract_filament_usage_from_3mf(archive_path, plate_id)
    plate_grams = sum(f.get("used_g", 0) for f in plate_slots)
    plate_time = extract_print_time_from_3mf(archive_path, plate_id)

    scale = 1.0 if print_status == "completed" else _partial_progress_scale(progress)

    if plate_time:
        archive_data["print_time_seconds"] = plate_time

    # Gate both the grams headline AND the per-slot breakdown on the same
    # `plate_grams > 0` signal: if the 3MF carries per-plate filament rows but
    # they all sum to zero (slicer bug / re-slice without estimate), drop back
    # to the project-level grams the archive columns already provide rather
    # than ship a project-level headline next to an all-zero per-plate
    # breakdown.
    if plate_grams > 0:
        archive_data["actual_filament_grams"] = round(plate_grams * scale, 1)
        archive_data["filament_slots"] = [
            {
                "slot_id": s.get("slot_id"),
                "used_g": round((s.get("used_g") or 0) * scale, 1),
                "type": s.get("type", ""),
                "color": s.get("color", ""),
            }
            for s in plate_slots
        ]

    return archive_data


def _extract_filament_data_from_mqtt(data: dict, ams_mapping: list[int] | None = None) -> dict[str, str]:
    """Best-effort filament metadata from the MQTT print-start snapshot.

    Used when the 3MF can't be downloaded (P1S/A1/P2S firmwares lock the
    file during print, see #1533) so the fallback PrintArchive still has
    enough filament info to support the inventory views and AMS-expansion
    planning the operator opens it for. Returns a dict with optional
    ``filament_type`` and ``filament_color`` keys in the same
    comma-separated format the 3MF extractor produces, so the rest of the
    codebase treats the fallback archive identically to a normal one.

    ``ams_mapping`` is the slicer's slot-per-print-filament list captured
    from the MQTT print payload (global tray IDs, possibly -1 for VT-tray
    entries). When supplied, only the slots actually consumed by this
    print contribute. Without it the function falls back to every loaded
    AMS slot — less accurate but still useful.

    Accepts both the raw inner payload (``{"ams": {"ams": [...]}, ...}``)
    that the unit tests pass directly, AND the on_print_start callback
    shape (``{"raw_data": {"ams": {"ams": [...]}, ...}, ...}``) the
    bambu_mqtt service hands to main.py at runtime. The original
    ``_extract_filament_data_from_mqtt(data)`` shipped in #1533 only
    handled the inner shape and silently returned ``{}`` for every real
    print start, leaving fallback archives' filament fields NULL — the
    exact regression the fix was meant to close. Reported with a log
    proving the AMS state was right there at
    ``data["raw_data"]["ams"]["ams"][0]["tray"][0]`` (#1533 follow-up).
    """
    result: dict[str, str] = {}
    # Look at the on_print_start wrapper first, then the inner shape.
    raw_data = (data or {}).get("raw_data")
    ams_root = (raw_data or {}).get("ams") if isinstance(raw_data, dict) else None
    if not isinstance(ams_root, dict):
        ams_root = (data or {}).get("ams") or {}
    ams_units = ams_root.get("ams") if isinstance(ams_root, dict) else None
    if not isinstance(ams_units, list) or not ams_units:
        return result

    # Map global tray id (unit * 4 + tray) → (type, color).
    loaded: dict[int, tuple[str, str]] = {}
    for unit in ams_units:
        if not isinstance(unit, dict):
            continue
        try:
            unit_id = int(unit.get("id", 0))
        except (TypeError, ValueError):
            continue
        for tray in unit.get("tray") or []:
            if not isinstance(tray, dict):
                continue
            try:
                tray_id = int(tray.get("id", 0))
            except (TypeError, ValueError):
                continue
            ttype = (tray.get("tray_type") or "").strip()
            tcolor = (tray.get("tray_color") or "").strip().upper()
            if not ttype:
                continue  # Empty / unloaded slot.
            loaded[unit_id * 4 + tray_id] = (ttype, tcolor)

    if not loaded:
        return result

    if ams_mapping:
        used_ids = [int(x) for x in ams_mapping if isinstance(x, (int, float)) and int(x) >= 0]
        filaments = [loaded[g] for g in used_ids if g in loaded]
        if not filaments:
            return result  # Mapping points entirely at slots we have no data for.
    else:
        filaments = [loaded[g] for g in sorted(loaded.keys())]

    types_joined = ",".join(f[0] for f in filaments)
    colors_joined = ",".join(f[1] for f in filaments if f[1])

    # Column limits per backend/app/models/archive.py: filament_type=50,
    # filament_color=200.
    if types_joined:
        result["filament_type"] = types_joined[:50]
    if colors_joined:
        result["filament_color"] = colors_joined[:200]
    return result


def _maybe_start_layer_timelapse(printer, printer_id: int, archive_id: int) -> bool:
    """Start a layer-timelapse session for *archive_id* when the printer has
    an external camera configured. Returns True if a session was started.

    Three call sites in on_print_start (expected-archive promotion, fallback
    archive creation, fresh-archive creation) used to inline this same
    if-block; the inline copies kept drifting (#1353 fixed only one of them
    on the first pass). Centralising the conditional + call here makes the
    contract testable in isolation and keeps the three sites locked in step.
    """
    if not (printer.external_camera_enabled and printer.external_camera_url):
        return False
    from backend.app.services.layer_timelapse import start_session

    start_session(
        printer_id,
        archive_id,
        printer.external_camera_url,
        printer.external_camera_type or "mjpeg",
        snapshot_url=printer.external_camera_snapshot_url,
    )
    logger.info("Started layer timelapse for printer %s, archive %s", printer_id, archive_id)
    return True


def _format_hms_error_summary(hms_errors: list[dict]) -> str | None:
    """Build a human-readable failure reason from MQTT hms_errors for PrintQueueItem.error_message.

    Each entry has keys: code ('0x4038'), attr (32-bit int), module, severity, and
    — since #2926 — the description the parser already resolved, which is preferred
    when present so the queue's failure reason reads the same as the status
    response. The short code still produces the bracketed label, and still
    resolves the sentence for a caller whose entries predate the field. Falls back
    to the bare short code when no description is on file. Returns None for an
    empty list so callers can leave error_message unset.
    """
    if not hms_errors:
        return None
    from backend.app.services.hms_errors import get_error_description

    parts: list[str] = []
    for err in hms_errors:
        try:
            # `_hms_short_code` rather than a local derivation: this one used to
            # format the error without masking it to 16 bits, so an `hms[]` entry
            # whose code carries an alert-level group produced a five-digit label
            # like "0500_3000A" — not a code the user can look up, and never a
            # catalogue key, so the sentence was lost with it.
            short_code = _hms_short_code(err.get("attr", 0), err.get("code", 0))
        except (TypeError, ValueError):
            continue
        description = err.get("description") or get_error_description(short_code)
        parts.append(f"[{short_code}] {description}" if description else f"[{short_code}]")
    return "; ".join(parts) if parts else None


async def _capture_snapshot_for_notification(printer_id: int, printer, logger) -> bytes | None:
    """Capture a camera snapshot for notification image attachment.

    Returns JPEG bytes (max 2.5MB) or None if capture fails or is unavailable.
    Uses: external camera > buffered frame > fresh capture.
    """
    if not printer:
        return None

    try:
        from backend.app.api.routes.settings import get_setting

        async with async_session() as db:
            capture_enabled = await get_setting(db, "capture_finish_photo")

        if capture_enabled is not None and capture_enabled.lower() != "true":
            return None

        # Try external camera first
        if printer.external_camera_enabled and printer.external_camera_url:
            logger.info("[SNAPSHOT] Capturing from external camera for printer %s", printer_id)
            frame_data = await _external_frame(printer_id, printer)
            if frame_data and len(frame_data) <= 2_500_000:
                logger.info("[SNAPSHOT] External camera frame: %s bytes", len(frame_data))
                return _apply_camera_rotation(frame_data, printer, logger)

        if buffered_frame := _stream_frame(printer_id):
            logger.info("[SNAPSHOT] Using buffered frame for printer %s: %s bytes", printer_id, len(buffered_frame))
            if len(buffered_frame) <= 2_500_000:
                return _apply_camera_rotation(buffered_frame, printer, logger)

        # Fresh capture from printer camera
        logger.info("[SNAPSHOT] Capturing fresh frame for printer %s", printer_id)
        from backend.app.services.camera import capture_camera_frame_bytes

        frame_data = await capture_camera_frame_bytes(
            printer.ip_address, printer.access_code, printer.model, timeout=15
        )
        if frame_data and len(frame_data) <= 2_500_000:
            logger.info("[SNAPSHOT] Fresh camera frame: %s bytes", len(frame_data))
            return _apply_camera_rotation(frame_data, printer, logger)

    except Exception as e:
        logger.warning("[SNAPSHOT] Failed to capture snapshot for printer %s: %s", printer_id, e)

    return None


def _apply_camera_rotation(image_data: bytes, printer, logger) -> bytes:
    """Apply camera rotation to snapshot image if configured."""
    rotation = getattr(printer, "camera_rotation", 0)
    if not rotation or rotation == 0:
        return image_data

    try:
        from io import BytesIO

        from PIL import Image

        img = Image.open(BytesIO(image_data))
        # PIL rotate is counter-clockwise, so negate for clockwise rotation
        img = img.rotate(-rotation, expand=True)
        buf = BytesIO()
        img.save(buf, format="JPEG", quality=90)
        rotated = buf.getvalue()
        logger.info("[SNAPSHOT] Applied %d° rotation: %s → %s bytes", rotation, len(image_data), len(rotated))
        return rotated
    except Exception as e:
        logger.warning("[SNAPSHOT] Failed to apply rotation: %s", e)
        return image_data


async def _send_print_start_notification(
    printer_id: int,
    data: dict,
    archive_data: dict | None = None,
    logger=logger,
):
    """Helper to send print start notification with optional archive data."""
    try:
        async with async_session() as db:
            printer = await _one(db, select(Printer).where(Printer.id == printer_id))
            printer_name = printer.name if printer else f"Printer {printer_id}"

            # Capture camera snapshot for notification image attachment
            image_data = await _capture_snapshot_for_notification(printer_id, printer, logger)
            if image_data:
                if archive_data is None:
                    archive_data = {}
                archive_data["image_data"] = image_data

            await notification_service.on_print_start(printer_id, printer_name, data, db, archive_data=archive_data)

            filename = data.get("subtask_name") or data.get("filename", "Unknown")
            owner = archive_data.get("created_by_id") if archive_data else None
            await _dispatch_user_print_email("started", owner, printer_name, filename, db)
    except Exception as e:
        logger.warning("Notification on_print_start failed: %s", e)


_USER_PRINT_EMAILS = {
    "started": "user_print_start",
    "completed": "user_print_complete",
    "failed": "user_print_failed",
    **dict.fromkeys(("stopped", "aborted", "cancelled"), "user_print_stopped"),
}


async def _dispatch_user_print_email(
    status: str,
    created_by_id: int | None,
    printer_name: str,
    filename: str,
    db,
) -> None:
    """Email the print's owner the event for ``status``; nobody for an ownerless print."""
    event_type = _USER_PRINT_EMAILS.get(status)
    if created_by_id is None or event_type is None:
        return
    await notification_service.send_user_print_email(
        event_type=event_type,
        created_by_id=created_by_id,
        printer_name=printer_name,
        filename=filename,
        db=db,
    )


def _load_objects_from_archive(archive, printer_id: int, logger, *, reset_skipped: bool = True) -> None:
    """Extract printable objects from an archive's 3MF file and store in printer state."""
    try:
        from backend.app.services.archive import extract_printable_objects_from_3mf

        file_path = app_settings.base_dir / archive.file_path
        if file_path.is_file() and str(file_path).endswith(".3mf"):
            with open(file_path, "rb") as f:
                threemf_data = f.read()
            # Extract with positions for UI overlay
            printable_objects, bbox_all = extract_printable_objects_from_3mf(threemf_data, include_positions=True)
            if printable_objects:
                client = printer_manager.get_client(printer_id)
                if client:
                    client.state.printable_objects = printable_objects
                    client.state.printable_objects_bbox_all = bbox_all
                    if reset_skipped:
                        client.state.skipped_objects = []
                    logger.info("Loaded %s printable objects for printer %s", len(printable_objects), printer_id)
    except Exception as e:
        logger.debug("Failed to extract printable objects from archive: %s", e)


async def _link_observed_archive(printer_id: int, item_id: int, identity: str) -> int | None:
    """Link the owned attempt, or a single unowned legacy Archive with this ID."""
    async with writer(printer_id), async_session() as db:
        item = await db.get(PrintQueueItem, item_id)
        if item is None:
            return None
        if item.archive_id is not None:
            return item.archive_id
        archive = await db.scalar(
            select(PrintArchive).where(
                PrintArchive.printer_id == printer_id, PrintArchive.dispatched_queue_item_id == item_id
            )
        )
        if archive is None:
            candidates = list(
                await db.scalars(
                    select(PrintArchive).where(
                        PrintArchive.printer_id == printer_id,
                        PrintArchive.subtask_id == identity,
                        PrintArchive.dispatched_queue_item_id.is_(None),
                        PrintArchive.status == "printing",
                    )
                )
            )
            if len(candidates) != 1:
                return None
            archive = candidates[0]
        archive_id = archive.id
        item = await lock_queue_item(db, item_id)
        if item is None:
            return None
        if item.archive_id is not None:
            return item.archive_id
        archive = await db.scalar(
            select(PrintArchive)
            .where(
                PrintArchive.id == archive_id,
                PrintArchive.printer_id == printer_id,
                or_(PrintArchive.dispatched_queue_item_id.is_(None), PrintArchive.dispatched_queue_item_id == item_id),
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if archive is None:
            return None
        archive.dispatched_queue_item_id = item_id
        await transition_queue_item(db, item, item.status, item.status, values={"archive_id": archive.id})
        await db.commit()
        return archive.id


async def _begin_new_print(printer_id: int, data: dict, *, memory) -> None:
    """Run new-print actions once, independently of Archive recovery."""
    client = printer_manager.get_client(printer_id)
    if client:
        client.state.skipped_objects = []
    memory.finish_frames.pop(printer_id, None)
    memory.timelapse_baselines.pop(printer_id, None)
    if memory.bed_cool_waiters.pop(printer_id, None):
        logger.info("[BED-COOL] Cancelled bed cooldown waiter for printer %s (new print started)", printer_id)
    from backend.app.api.routes.printers import clear_cover_cache

    clear_cover_cache(printer_id)
    await ws_manager.send_print_start(printer_id, data)
    await notify_missing_spool_assignments_on_print_start(printer_id, data, logger)
    with suppress(Exception):
        printer_info = printer_manager.get_printer(printer_id)
        if printer_info:
            await mqtt_relay.on_print_start(
                printer_id,
                printer_info.name,
                printer_info.serial_number,
                data.get("filename", ""),
                data.get("subtask_name", ""),
            )
    try:
        async with async_session() as db:
            from backend.app.services.usage_tracker import on_print_start as usage_on_print_start

            owned = await _spoolman_owns_usage(db)
            await usage_on_print_start(printer_id, data, printer_manager, db=db, spoolman_owns_usage=owned)
    except Exception as e:
        logger.warning("Usage tracker on_print_start failed: %s", e)
    try:
        async with async_session() as db:
            await smart_plug_manager.on_print_start(printer_id, db)
    except Exception as e:
        logger.warning("Smart plug on_print_start failed: %s", e)


async def _finish_new_print(printer_id: int, data: dict, archive_id: int | None) -> None:
    """Initialize Archive tracking and notify once for a new print."""
    archive_data = None
    async with async_session() as db:
        archive = await db.get(PrintArchive, archive_id) if archive_id is not None else None
        if archive is not None:
            archive_data = {
                "print_time_seconds": archive.print_time_seconds,
                "created_by_id": archive.created_by_id,
                "owner_id": data.get("owner_id") or archive.created_by_id,
            }
            # Legacy reprints may reuse a row. Modern attempts already have fresh media.
            if archive.timelapse_path:
                stale_path = app_settings.base_dir / archive.timelapse_path
                archive.timelapse_path = None
                await db.commit()
                try:
                    stale_path.unlink(missing_ok=True)
                except OSError:
                    logger.warning("Could not remove old timelapse for Archive %s", archive_id)
            if archive.energy_start_kwh is None:
                await _record_energy_start(archive, printer_id, db, context="print-start")
            try:
                await _store_spoolman_print_data(
                    printer_id,
                    archive.id,
                    archive.file_path,
                    db,
                    printer_manager,
                    ams_mapping=data.get("ams_mapping"),
                    plate_id=data.get("plate_id"),
                )
            except Exception:
                logger.exception("Could not initialize filament tracking for Archive %s", archive_id)
    await _send_print_start_notification(printer_id, data, archive_data, logger)


async def _archive_print_start(
    printer_id: int, data: dict, *, memory, queue_archive_id: int | None = None, queue_job_id: int | None = None
) -> bool:
    """Associate the exact job Archive and restore its metadata.

    FTP names locate files; job IDs identify attempts. Cached downloads are reused,
    and this path never repeats new-print notifications, plate checks or usage resets.
    """
    async with async_session() as db:
        printer = await _one(db, select(Printer).where(Printer.id == printer_id))
        if queue_archive_id is None and queue_job_id is not None:
            owned_archive = await db.scalar(
                select(PrintArchive).where(
                    PrintArchive.dispatched_queue_item_id == queue_job_id, PrintArchive.printer_id == printer_id
                )
            )
            if owned_archive is not None:
                queue_archive_id = owned_archive.id
        if not printer:
            logger.info("[CALLBACK] Skipping archive - printer not found in database")
            return True
        if not printer.auto_archive and queue_archive_id is None:
            logger.info("[CALLBACK] Skipping Archive for external print: auto_archive is disabled")
            return True
        filename = data.get("filename", "")
        subtask_name = data.get("subtask_name", "")
        subtask_id = event_identity(data)
        logger.info("[CALLBACK] Print start detected - filename: %s, subtask: %s", filename, subtask_name)
        if filename and filename.startswith("/usr/"):
            logger.info("[CALLBACK] Skipping archive — internal printer file detected: %s", filename)
            return True
        if not filename and (not subtask_name):
            logger.info("[CALLBACK] Skipping archive - no filename or subtask_name")
            return True
        expected_archive_id = queue_archive_id
        if expected_archive_id:
            logger.info("Using expected archive %s for print (skipping duplicate)", expected_archive_id)
            archive = await _one(db, select(PrintArchive).where(PrintArchive.id == expected_archive_id))
            if archive:
                if archive.dispatched_queue_item_id is None:
                    archive.status = "printing"
                    archive.started_at = datetime.now(timezone.utc)
                    archive.completed_at = None
                    archive.failure_reason = None
                if subtask_id and archive.subtask_id != subtask_id:
                    archive.subtask_id = subtask_id
                if archive.printer_id != printer_id:
                    archive.printer_id = printer_id
                await db.commit()
                await ws_manager.send_archive_updated({"id": archive.id, "status": archive.status})
                await _restore_archive_print_context(db, printer, archive, data, memory=memory)
            return True
        existing_archive: PrintArchive | None = None
        if subtask_id:
            by_id = await db.execute(
                select(PrintArchive)
                .where(PrintArchive.printer_id == printer_id)
                .where(PrintArchive.subtask_id == subtask_id)
                .where(PrintArchive.status == "printing")
            )
            candidates = list(by_id.scalars().all())
            if len(candidates) == 1:
                existing_archive = candidates[0]
        if existing_archive:
            logger.info("Resuming archive %s on subtask_id match (%s)", existing_archive.id, subtask_id)
            await _restore_archive_print_context(db, printer, existing_archive, data, memory=memory)
            return True
        # FTP can take a while. Close the session before waiting so no SQLite
        # connection stays open across the network request. AsyncSession can
        # be reused below to load the printer and persist the Archive.
        download_printer = SimpleNamespace(
            id=printer.id,
            ip_address=printer.ip_address,
            access_code=printer.access_code,
            model=printer.model,
        )
        await db.close()
        retry = await get_ftp_retry_settings()
        temp_path, downloaded_filename = await _fetch_print_3mf(download_printer, filename, subtask_name, retry)
        if downloaded_filename:
            expected_plate = parse_plate_id(filename)
            actual_plate = peek_plate_index_in_3mf(temp_path) if expected_plate is not None else None
            if expected_plate is not None and actual_plate is not None and (actual_plate != expected_plate):
                logger.warning(
                    "[CALLBACK] 3MF plate mismatch: downloaded %s reports plate %s but printer is running plate %s — subtask_name=%r appears stale, retrying with corrected name",
                    downloaded_filename,
                    actual_plate,
                    expected_plate,
                    subtask_name,
                )
                corrected_subtask = swap_plate_suffix(subtask_name, expected_plate)
                retried = None
                if corrected_subtask and corrected_subtask != subtask_name:
                    for try_filename in (f"{corrected_subtask}.gcode.3mf", f"{corrected_subtask}.3mf"):
                        retry_path = _temp_3mf(try_filename)
                        if retry_path and await _download_from_dirs(
                            download_printer, try_filename, retry_path, retry, plate=expected_plate
                        ):
                            retried = try_filename, retry_path
                            break
                with suppress(OSError):
                    temp_path.unlink(missing_ok=True)
                if retried:
                    logger.info(
                        "[CALLBACK] Re-download succeeded with corrected name %s (plate %s) — replacing wrong file",
                        retried[0],
                        expected_plate,
                    )
                    downloaded_filename, temp_path = retried
                    subtask_name = corrected_subtask
                    cache_3mf_download(printer_id, downloaded_filename, temp_path)
                else:
                    logger.warning(
                        "[CALLBACK] Could not re-download correct plate %s — falling back to no-3MF archive",
                        expected_plate,
                    )
                    temp_path = downloaded_filename = None
                    subtask_name = corrected_subtask or ""
        # Re-read after the network wait; rollback expired the ORM instance and
        # the printer may have been removed while the callback was suspended.
        printer = await _one(db, select(Printer).where(Printer.id == printer_id))
        if not printer:
            if temp_path and temp_path.exists():
                with suppress(OSError):
                    temp_path.unlink()
            logger.info("Skipping delayed Archive start - printer %s no longer exists", printer_id)
            return True
        if not downloaded_filename or not temp_path:
            logger.warning("Could not find 3MF file for print: %s", filename or subtask_name)
            try:
                print_name = (subtask_name or filename).split("/")[-1]
                for suffix in (".gcode.3mf", ".gcode", ".3mf"):
                    print_name = print_name.replace(suffix, "")
                print_name = print_name if (subtask_name or filename) else "Unknown Print"
                # The remaining time at start: seconds, or the printer's minutes.
                remaining = data.get("remaining_time")
                minutes = (data.get("raw_data") or {}).get("mc_remaining_time")
                fallback_print_time = None
                if isinstance(remaining, (int, float)) and remaining > 0:
                    fallback_print_time = int(remaining)
                elif isinstance(minutes, (int, float)) and minutes > 0:
                    fallback_print_time = int(minutes * 60)
                mqtt_filament_meta = _extract_filament_data_from_mqtt(data, data.get("ams_mapping"))
                fallback_archive = PrintArchive(
                    printer_id=printer_id,
                    filename=filename or f"{print_name}.3mf",
                    file_path="",
                    file_size=0,
                    print_name=print_name,
                    print_time_seconds=fallback_print_time,
                    status="printing",
                    started_at=datetime.now(timezone.utc),
                    subtask_id=subtask_id,
                    dispatched_queue_item_id=queue_job_id,
                    filament_type=mqtt_filament_meta.get("filament_type"),
                    filament_color=mqtt_filament_meta.get("filament_color"),
                    extra_data={"no_3mf_available": True, "original_subtask": subtask_name, "_print_data": data},
                )
                db.add(fallback_archive)
                await db.commit()
                await db.refresh(fallback_archive)
                logger.info("Created fallback archive %s for %s (no 3MF available)", fallback_archive.id, print_name)
                await _restore_archive_print_context(db, printer, fallback_archive, data, memory=memory)
                await _announce_archive(printer, fallback_archive)
                return True
            except Exception as e:
                logger.error("Failed to create fallback archive: %s", e)
                return False
        try:
            service = ArchiveService(db)
            archive = await service.archive_print(
                printer_id=printer_id,
                source_file=temp_path,
                print_data={**data, "status": "printing"},
                subtask_id=subtask_id,
                dispatched_queue_item_id=queue_job_id,
            )
            if archive:
                logger.info("Created archive %s for %s", archive.id, downloaded_filename)
                await _restore_archive_print_context(db, printer, archive, data, memory=memory)
                await _announce_archive(printer, archive)
            return archive is not None
        finally:
            cached_now = get_cached_3mf(printer_id, downloaded_filename) if downloaded_filename else None
            if temp_path and temp_path.exists() and (cached_now != temp_path):
                temp_path.unlink()


def _candidate_3mf_names(filename: str, subtask_name: str) -> list[str]:
    """The SD-card names the print's 3MF may have, from its subtask and file names, with spaces as underscores too."""
    names = [f"{subtask_name}.gcode.3mf", f"{subtask_name}.3mf"] if subtask_name else []
    if filename:
        base = filename.split("/")[-1]
        if base.endswith(".3mf"):
            names.append(base)
        else:
            base = base.rsplit(".", 1)[0] if base.endswith(".gcode") else base
            names += [f"{base}.gcode.3mf", f"{base}.3mf"]
    names += [name.replace(" ", "_") for name in names if " " in name]
    return list(dict.fromkeys(names))


def _temp_3mf(name: str) -> Path | None:
    """Where a printer-named 3MF downloads to; None for a name that would leave the temp directory."""
    try:
        path = safe_join_under(app_settings.archive_dir / "temp", name, http=False)
    except PathTraversalError:
        logger.warning("Skipping printer file with an unsafe name: %r", name)
        return None
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


async def _download_3mf(printer, remote_path: str, local_path: Path, retry: tuple, *, skip_on_550: bool = True) -> bool:
    enabled, count, delay, timeout = retry
    args = (printer.ip_address, printer.access_code, remote_path, local_path)
    options = {"timeout": timeout, "socket_timeout": timeout, "printer_model": printer.model}
    if not enabled:
        return await download_file_async(*args, **options)
    if skip_on_550:
        options["non_retry_exceptions"] = (FileNotOnPrinterError,)
    return await with_ftp_retry(
        download_file_async,
        *args,
        **options,
        max_retries=count,
        retry_delay=delay,
        operation_name=f"Download 3MF from {remote_path}",
        cooloff_ip=printer.ip_address,
    )


async def _download_from_dirs(printer, name: str, local_path: Path, retry: tuple, *, plate: int | None = None) -> bool:
    """Download ``name`` from the first printer directory that has it, and for ``plate``, that plate's copy."""
    for directory in ("", "/cache", "/model", "/data", "/data/Metadata"):
        remote_path = f"{directory}/{name}"
        try:
            if await _download_3mf(printer, remote_path, local_path, retry):
                if plate is None or peek_plate_index_in_3mf(local_path) == plate:
                    logger.info("Downloaded: %s", remote_path)
                    return True
                with suppress(OSError):
                    local_path.unlink(missing_ok=True)
        except FileNotOnPrinterError:
            logger.debug("3MF not at %s (550), trying next path", remote_path)
        except Exception as e:
            logger.debug("FTP download failed for %s: %s", remote_path, e)
    return False


async def _fetch_print_3mf(printer, filename: str, subtask_name: str, retry: tuple) -> tuple[Path | None, str | None]:
    """The print's 3MF and its name: a cached download, a likely name, then a search of the printer's directories."""
    names = [name for name in _candidate_3mf_names(filename, subtask_name) if name.endswith(".3mf")]
    logger.info("Trying filenames: %s", names)
    for name in names:
        if cached := get_cached_3mf(printer.id, name):
            logger.info("Reusing cached 3MF from %s (avoided duplicate FTP)", cached)
            return cached, name
    for name in names:
        if (path := _temp_3mf(name)) and await _download_from_dirs(printer, name, path, retry):
            cache_3mf_download(printer.id, name, path)
            return path, name
    from backend.app.services.bambu_ftp import list_files_async

    search = (subtask_name or filename).lower().replace(".gcode", "").replace(".3mf", "").replace(" ", "_")
    logger.info("Direct FTP download failed, searching directories for '%s'", search)
    for directory in ("/cache", "/model", "/data", "/data/Metadata", "/"):
        try:
            listing = await list_files_async(
                printer.ip_address, printer.access_code, directory, printer_model=printer.model
            )
            found = [f.get("name", "") for f in listing if not f.get("is_directory")]
            found = [name for name in found if name.endswith(".3mf")]
            if found:
                logger.info("Found %s 3MF files in %s: %s", len(found), directory, found[:5])
            for name in found:
                if search not in name.lower().replace(" ", "_") or not (path := _temp_3mf(name)):
                    continue
                logger.info("Found matching file in %s: %s", directory, name)
                if await _download_3mf(printer, posixpath.join(directory, name), path, retry, skip_on_550=False):
                    logger.info("Found and downloaded from %s: %s", directory, name)
                    cache_3mf_download(printer.id, name, path)
                    return path, name
        except Exception as e:
            logger.debug("Failed to list %s: %s", directory, e)
    return None, None


async def _announce_archive(printer, archive) -> None:
    """Tell the UI and the MQTT relay about a new Archive."""
    fields = ("id", "printer_id", "filename", "print_name", "status")
    await ws_manager.send_archive_created({field: getattr(archive, field) for field in fields})
    with suppress(Exception):
        await mqtt_relay.on_archive_created(
            archive_id=archive.id, print_name=archive.print_name, printer_name=printer.name, status=archive.status
        )


async def _restore_archive_print_context(db, printer, archive, data: dict, *, memory) -> None:
    """Restore runtime context only while this exact print is still active."""
    if archive.dispatched_queue_item_id is not None:
        job = await db.get(PrintQueueItem, archive.dispatched_queue_item_id)
        if job is None or job.status not in ("printing", "paused"):
            return
    live = printer_manager.get_status(printer.id)
    if (
        not live
        or not live.connected
        or not live.job_telemetry_ready
        or live.state not in ("PREPARE", "SLICING", "RUNNING", "PAUSE")
        or telemetry_identity(live) != event_identity(data)
    ):
        return  # A completion or another print overtook slow Archive I/O.
    from backend.app.services.usage_tracker import _active_sessions, update_persisted_session_context

    usage_session = _active_sessions.get(printer.id)
    if usage_session:
        if not usage_session.ams_mapping:
            usage_session.ams_mapping = data.get("ams_mapping")
        if usage_session.plate_id is None:
            usage_session.plate_id = data.get("plate_id")
    await update_persisted_session_context(
        db, printer.id, ams_mapping=data.get("ams_mapping"), plate_id=data.get("plate_id")
    )
    _maybe_start_layer_timelapse(printer, printer.id, archive.id)
    _load_objects_from_archive(archive, printer.id, logger, reset_skipped=False)
    await _capture_timelapse_baseline_at_start(printer, printer.id, logger, memory=memory)


_TIMELAPSE_VIDEO_EXTENSIONS = (".mp4", ".avi")


async def _list_timelapse_videos(printer) -> tuple[list[dict], str | None]:
    """List video files from printer's timelapse directory.

    Finds MP4 (X1/A1 series) and AVI (P1 series) timelapse files.
    Returns (video_files, found_path) where video_files is a list of file dicts
    and found_path is the directory where they were found, or ([], None).
    """
    from backend.app.services.bambu_ftp import list_files_async

    for timelapse_path in ["/timelapse", "/timelapse/video", "/record", "/recording"]:
        try:
            found_files = await list_files_async(
                printer.ip_address, printer.access_code, timelapse_path, printer_model=printer.model
            )
            if found_files:
                video_files = [
                    f
                    for f in found_files
                    if not f.get("is_directory") and f.get("name", "").lower().endswith(_TIMELAPSE_VIDEO_EXTENSIONS)
                ]
                if video_files:
                    return video_files, timelapse_path
        except Exception as e:
            logger.debug("[TIMELAPSE] Path %s failed: %s", timelapse_path, e)
            continue

    return [], None


async def _capture_timelapse_baseline_at_start(printer, printer_id: int, logger: logging.Logger, *, memory) -> None:
    """Snapshot the printer's timelapse directory at print start so the
    completion-time scan can pick the new file by set-difference.

    Must be called from every on_print_start path that proceeds to a real
    print — both the new-archive branch and the expected-archive branch (which
    queue / VP-dispatched prints take). Without a baseline,
    _scan_for_timelapse_with_retries falls into its "take baseline now"
    fallback that runs AFTER the new MP4 has already landed on the SD card,
    so the new file ends up in the "baseline" set and no diff ever matches.

    Bambu printers in LAN-only mode don't sync NTP, so mtime ordering is
    unreliable — the snapshot-diff approach sidesteps that entirely.
    """
    if printer_id in memory.timelapse_baselines:
        return
    try:
        baseline_files, _ = await _list_timelapse_videos(printer)
        memory.timelapse_baselines[printer_id] = {f.get("name", "") for f in baseline_files}
        logger.info(
            "Printer %s: timelapse baseline has %s files", printer_id, len(memory.timelapse_baselines[printer_id])
        )
    except Exception as e:
        logger.warning("[TIMELAPSE] Failed to capture baseline at print start: %s", e)


async def _scan_for_timelapse_with_retries(archive_id: int, baseline_names: set[str] | None = None):
    """Attach the print's timelapse: the video that appears after the print-start baseline (#1485).

    The printer clock is unreliable in LAN-only mode, so a new video is found
    by difference, not by time. Without a start baseline (a restart mid-print)
    one is taken now. If no new video appears, one named after the print is used.
    """
    try:
        async with async_session() as db:
            archive = await ArchiveService(db).get_archive(archive_id)
            if not archive or archive.timelapse_path or not archive.printer_id:
                logger.info(
                    "[TIMELAPSE] Archive %s is missing, has a timelapse or no printer; not scanning", archive_id
                )
                return
            if baseline_names is None:
                printer = await _one(db, select(Printer).where(Printer.id == archive.printer_id))
                if not printer:
                    logger.warning("[TIMELAPSE] Printer not found for archive %s, aborting", archive_id)
                    return
                baseline_files, _ = await _list_timelapse_videos(printer)
                baseline_names = {f.get("name", "") for f in baseline_files}
            logger.info("[TIMELAPSE] Baseline: %s existing video files for archive %s", len(baseline_names), archive_id)
            base_name = Path(archive.filename).stem.removesuffix(".gcode") if archive.filename else ""
    except Exception as e:
        logger.warning("[TIMELAPSE] Failed to take baseline snapshot for archive %s: %s", archive_id, e)
        return
    for attempt, delay in enumerate((5, 10, 20, 30), 1):
        logger.info("[TIMELAPSE] Attempt %s/4: waiting %ss before scanning for archive %s", attempt, delay, archive_id)
        await asyncio.sleep(delay)
        try:
            if await _attach_found_timelapse(archive_id, lambda name: name not in baseline_names):
                return
        except Exception as e:
            logger.warning("[TIMELAPSE] Attempt %s failed with error: %s", attempt, e)
    if base_name:
        logger.info("[TIMELAPSE] Retries exhausted, trying name-match fallback for '%s'", base_name)
        try:
            if await _attach_found_timelapse(archive_id, lambda name: base_name.lower() in name.lower()):
                return
        except Exception as e:
            logger.warning("[TIMELAPSE] Name-match fallback failed: %s", e)
    logger.warning("[TIMELAPSE] All attempts exhausted for archive %s, giving up", archive_id)


async def _attach_found_timelapse(archive_id: int, pick) -> bool:
    """Attach the first listed video ``pick`` accepts; True once nothing is left to try."""
    from backend.app.services.bambu_ftp import download_file_bytes_async

    async with async_session() as db:
        service = ArchiveService(db)
        archive = await service.get_archive(archive_id)
        if not archive or archive.timelapse_path:
            logger.info("[TIMELAPSE] Archive %s is gone or has a timelapse, stopping", archive_id)
            return True
        if not (printer := await _one(db, select(Printer).where(Printer.id == archive.printer_id))):
            logger.warning("[TIMELAPSE] Printer not found for archive %s, stopping", archive_id)
            return True
        video_files, found_path = await _list_timelapse_videos(printer)
        logger.info("[TIMELAPSE] Found %s video files in %s", len(video_files), found_path)
        if not (target := next((f for f in video_files if pick(f.get("name", ""))), None)):
            return False
        name = target.get("name")
        remote_path = target.get("path") or f"/timelapse/{name}"
        data = await download_file_bytes_async(
            printer.ip_address, printer.access_code, remote_path, printer_model=printer.model
        )
        if data and await service.attach_timelapse(archive_id, data, name):
            logger.info("[TIMELAPSE] Attached %s to archive %s", name, archive_id)
            await ws_manager.send_archive_updated({"id": archive_id, "timelapse_attached": True})
            return True
        logger.warning("[TIMELAPSE] Could not download or attach %s for archive %s", name, archive_id)
        return False


# Defaults for the finish-photo-from-timelapse polling loop (#1397). These are
# module-level so tests can monkeypatch them down to ~0 without timing out.
_FINISH_PHOTO_TIMELAPSE_POLL_INTERVAL_SECONDS: float = 3.0


_FINISH_PHOTO_TIMELAPSE_POLL_TIMEOUT_SECONDS: float = 60.0


async def _capture_finish_photo_from_timelapse(
    archive_id: int,
    archive_dir: Path,
) -> str | None:
    """Wait for the per-print timelapse to land on the archive and extract its
    last frame as the finish photo (#1397).

    Bambu firmware stops timelapse recording after the toolhead parks but
    before the bed-drop end-gcode runs, so the last frame frames the finished
    print correctly. A live camera grab at gcode_state=FINISH captures the
    bed already lowered.

    ``_scan_for_timelapse_with_retries`` runs in parallel and writes
    ``archive.timelapse_path`` when the file lands. This function polls for
    that field. Returns the saved photo filename on success, or None if the
    timelapse never arrives within the timeout / extraction fails / no
    timelapse path was set — in which case the caller falls back to the
    existing live-camera capture chain.
    """
    from backend.app.services.camera import extract_video_last_frame

    loop = asyncio.get_event_loop()
    deadline = loop.time() + _FINISH_PHOTO_TIMELAPSE_POLL_TIMEOUT_SECONDS
    while True:
        async with async_session() as db:
            archive = await _one(db, select(PrintArchive).where(PrintArchive.id == archive_id))
        # SEC-PATH-OK: timelapse_path is written by attach_timelapse.
        video_path = app_settings.base_dir / archive.timelapse_path if archive and archive.timelapse_path else None
        if video_path and video_path.exists() and video_path.stat().st_size > 0:
            filename, output_path = _new_photo(archive_dir)
            if await extract_video_last_frame(video_path, output_path):
                logger.info(
                    "[PHOTO-BG] Extracted finish photo from timelapse %s for archive %s", video_path.name, archive_id
                )
                return filename
            logger.warning(
                "[PHOTO-BG] Timelapse %s landed but last-frame extraction failed for archive %s; falling back",
                video_path.name,
                archive_id,
            )
            return None
        if loop.time() >= deadline:
            logger.info(
                "[PHOTO-BG] Timelapse for archive %s didn't land within %.0fs; falling back to live camera",
                archive_id,
                _FINISH_PHOTO_TIMELAPSE_POLL_TIMEOUT_SECONDS,
            )
            return None
        await asyncio.sleep(_FINISH_PHOTO_TIMELAPSE_POLL_INTERVAL_SECONDS)


async def _spoolman_owns_usage(db) -> bool:
    """Whether Spoolman tracks filament usage, rather than the AMS remain% tracker."""
    from backend.app.api.routes.settings import get_setting

    value = await get_setting(db, "spoolman_enabled")
    return bool(value) and value.lower() == "true"


async def _restore_usage_tracking_session(printer_id: int, state, db, logger) -> None:
    """Restore filament-attribution context after a restart mid-print."""
    try:
        from backend.app.services.usage_tracker import (
            clear_persisted_session,
            get_persisted_print_name,
            restore_session,
        )

        persisted_name = await get_persisted_print_name(db, printer_id)
        current_name = (state.subtask_name or "").strip()
        if persisted_name and current_name and persisted_name.strip() != current_name:
            logger.info(
                "[RESTART] Discarding stale print session for printer %s (%r != running %r)",
                printer_id,
                persisted_name,
                current_name,
            )
            await clear_persisted_session(db, printer_id)
            persisted_log = None
        else:
            owned = await _spoolman_owns_usage(db)
            persisted_log = await restore_session(db, printer_id, register_active=not owned)

        if persisted_log:
            restored = [tuple(entry) for entry in persisted_log if isinstance(entry, (list, tuple)) and len(entry) == 2]
            for entry in state.tray_change_log or []:
                if tuple(entry) not in restored:
                    restored.append(tuple(entry))
            state.tray_change_log = restored

        tray_now = state.tray_now
        if 0 <= tray_now <= 254:
            if not state.tray_change_log:
                state.tray_change_log = [(tray_now, state.layer_num)]
                logger.info(
                    "[RESTART] Seeded tray change log for printer %s: tray=%d at layer=%d",
                    printer_id,
                    tray_now,
                    state.layer_num,
                )
            state.last_loaded_tray = tray_now
    except Exception:
        logger.exception("[RESTART] Failed to restore usage-tracking session for printer %s", printer_id)


async def on_finish_photo_moment(printer_id: int, data: dict, *, memory):
    """Pre-capture a finish photo when the printer enters stage 22 / FINISH (#1721).

    Fires either at the stage-22 ("Filament unloading") edge — toolhead
    parked, bed not yet dropped, optimal framing — or as a FINISH-state
    fallback for prints that skip stage 22 (cancel, external-spool-only,
    HMS halt, firmware variants). Grabs one frame via the same
    external-camera / RTSP path the post-completion fallback uses, stores
    the JPEG bytes in ``memory.finish_frames[printer_id]``, and lets
    ``_background_finish_photo`` consume the cached bytes when it runs.

    Replaces the #1397 "force timelapse on at dispatch" mechanism, which
    caused per-layer nozzle parking on slicer profiles with Timelapse Type
    set to Smooth (#1721). No force-on now means the user's explicit
    timelapse=off in the slicer send dialog is respected.
    """
    trigger = data.get("trigger", "unknown")
    timelapse_was_active = bool(data.get("timelapse_was_active"))
    logger.info(
        "[FINISH-PHOTO-MOMENT] printer=%s trigger=%s timelapse_active=%s", printer_id, trigger, timelapse_was_active
    )

    # If a timelapse is actively recording, skip the pre-capture — the
    # post-completion path will extract the last frame from the recorded
    # video, which still provides the best framing (toolhead parked,
    # before bed drop) without the per-layer parking side effects.
    if timelapse_was_active:
        logger.info(
            "[FINISH-PHOTO-MOMENT] timelapse active for printer %s — skipping pre-capture (last-frame extraction will run post-completion)",
            printer_id,
        )
        return

    # #1790: register the producer-done event BEFORE the first await so the
    # consumer in `_background_finish_photo` — which is dispatched back-to-back
    # with us on the FINISH-state fallback path — sees it as soon as it polls.
    # The `finally` below guarantees `set()` runs on every exit, including
    # early returns and exceptions, so the consumer's bounded wait can't hang.
    producer_done = asyncio.Event()
    memory.finish_in_flight[printer_id] = producer_done

    try:
        async with async_session() as db:
            from backend.app.api.routes.settings import get_setting

            capture_setting = await get_setting(db, "capture_finish_photo")
            if capture_setting is not None and capture_setting.lower() != "true":
                logger.info("[FINISH-PHOTO-MOMENT] capture_finish_photo disabled — skipping pre-capture")
                return

            printer = await _one(db, select(Printer).where(Printer.id == printer_id))
            if printer is None:
                logger.warning("[FINISH-PHOTO-MOMENT] printer %s not found in DB", printer_id)
                return

        from backend.app.api.routes.camera import get_buffered_frame
        from backend.app.services.camera import capture_camera_frame_bytes

        if printer.external_camera_enabled and printer.external_camera_url:
            source, frame_bytes = "external-camera", await _external_frame(printer_id, printer)
        elif buffered := get_buffered_frame(printer_id):
            source, frame_bytes = "buffered RTSP", buffered
        else:
            source, frame_bytes = (
                "RTSP",
                await capture_camera_frame_bytes(
                    ip_address=printer.ip_address, access_code=printer.access_code, model=printer.model, timeout=15
                ),
            )
        if frame_bytes:
            logger.info("[FINISH-PHOTO-MOMENT] captured %s frame (%d bytes)", source, len(frame_bytes))
            memory.finish_frames[printer_id] = frame_bytes
        else:
            logger.warning(
                "[FINISH-PHOTO-MOMENT] no frame captured for printer %s — post-completion fallback will retry",
                printer_id,
            )
    except Exception as e:
        logger.warning("[FINISH-PHOTO-MOMENT] pre-capture failed for printer %s: %s", printer_id, e)
    finally:
        # #1790: always unblock the consumer's bounded wait — whether we stored
        # a frame, gave up, or hit an exception. Local ref means cleanup of the
        # dict entry by the consumer doesn't affect signalling.
        producer_done.set()


async def print_started(printer_id: int, data: dict, job_id: int, archive_id: int | None, *, new: bool, memory) -> None:
    """A print's start effects: new-print actions once per print, its Archive, then the start notification."""
    linked = archive_id
    has_archive_source = bool(data.get("filename") or data.get("subtask_name"))
    repair_task = memory.archive_repairs_in_flight.get(job_id) if job_id is not None else None
    owns_archive_start = has_archive_source and job_id is not None and repair_task is None
    if owns_archive_start:
        # Register before any other awaited start effect, so recovery cannot
        # launch a duplicate acquisition while _begin_new_print is running.
        memory.archive_starts_in_flight.add(job_id)
    try:
        if new:
            await _begin_new_print(printer_id, data, memory=memory)
        if repair_task is not None:
            await repair_task
        elif has_archive_source:
            await _archive_print_start(
                printer_id, data, queue_archive_id=archive_id, queue_job_id=job_id, memory=memory
            )
        if job_id is not None:
            linked = await _link_observed_archive(printer_id, job_id, data["submission_id"])
    finally:
        if owns_archive_start:
            memory.archive_starts_in_flight.discard(job_id)
        if new:
            await _finish_new_print(printer_id, data, linked)


async def print_resumed(printer_id: int, *, memory) -> None:
    """After a restart mid-print, restore usage tracking and capture the timelapse baseline.

    The first RUNNING push after startup reports no print start (#1304), so
    without this the completion scan would take its baseline after the
    printer uploaded the new video, and never find it (#1485). The printer
    uploads only after completion, so any baseline taken mid-print is safe.
    """
    if printer_id in memory.timelapse_baselines:
        return
    async with async_session() as db:
        state = printer_manager.get_status(printer_id)
        if state is not None:
            await _restore_usage_tracking_session(printer_id, state, db, logger)
        printer = await _one(db, select(Printer).where(Printer.id == printer_id))
        if not printer:
            logger.warning("[TIMELAPSE] on_print_running_observed: printer %s not found in DB", printer_id)
            return
    await _capture_timelapse_baseline_at_start(printer, printer_id, logger, memory=memory)


async def print_completed(c, *, memory) -> None:
    """A print's completion effects, once its job's awaiting state has committed (``c`` is a printing.Completion)."""
    printer_id, data, archive_id = c.printer_id, c.data, c.archive_id
    status = data.get("status", "completed")
    name = data.get("filename") or data.get("subtask_name") or ""
    logger.info("[CALLBACK] on_print_complete started for printer %s", printer_id)
    # The print is over; a cached 3MF could be handed to a next print reusing its name (#972).
    clear_3mf_cache(printer_id)
    try:
        ws_data = {key: data.get(key) for key in ("status", "filename", "subtask_name", "timelapse_was_active")}
        await ws_manager.send_print_complete(printer_id, ws_data)
    except Exception as e:
        logger.warning("[CALLBACK] WebSocket send_print_complete failed: %s", e)
    with suppress(Exception):
        if info := printer_manager.get_printer(printer_id):
            await mqtt_relay.on_print_complete(
                printer_id,
                info.name,
                info.serial_number,
                data.get("filename", ""),
                data.get("subtask_name", ""),
                status,
            )
    logger.info("Printer %s: print %s ended as %s", printer_id, name, status)
    await _clean_sd_card(c)
    await _queue_completed(c, name)
    if status == "completed":
        await _await_bed_cooldown(printer_id, name, memory=memory)
    usage_results = await _track_usage(c)
    if not archive_id:
        logger.warning(
            "Could not find archive for print complete: filename=%s, subtask=%s",
            data.get("filename", ""),
            data.get("subtask_name", ""),
        )
        spawn_background_task(_notify_completion(c, usage_results), name="notify-no-archive")
        return
    await _publish_archive_outcome(archive_id, status, data, name)
    await _write_print_log(c, usage_results)
    # Slow work runs in the background, so the next event is not held up.
    spawn_background_task(_record_print_energy(printer_id, archive_id), name="background-energy-calc")
    photo = spawn_background_task(
        _capture_finish_photo(printer_id, archive_id, data, memory=memory), name="background-finish-photo"
    )
    spawn_background_task(_check_maintenance(printer_id, status), name="background-maintenance-check")
    spawn_background_task(_notify_after_photo(c, usage_results, photo), name="photo-then-notify")
    spawn_background_task(_finish_layer_timelapse(printer_id, archive_id, status), name="background-layer-timelapse")
    if data.get("timelapse_was_active") and status == "completed":
        # The printer needs time to encode the video after completion.
        logger.info("[TIMELAPSE] Timelapse was active during print, scheduling auto-scan for archive %s", archive_id)
        scan = _scan_for_timelapse_with_retries(archive_id, memory.timelapse_baselines.pop(printer_id, None))
        spawn_background_task(scan, name=f"scan-timelapse-{archive_id}")
    logger.info("[CALLBACK] on_print_complete finished for printer %s, archive %s", printer_id, archive_id)


async def _clean_sd_card(c) -> None:
    """Delete the print's upload from the SD card, so a power cycle can't replay it (#374, #1542).

    Runs for every print, archived or not. A Queue attempt removes only its
    recorded upload; display names may be reused meanwhile. Legacy and
    external prints fall back to their naming conventions. Only a failed
    delete is retried: a 550 "not found" never recovers, and the A1 firmware
    cleans its own card, so every candidate says so (#1721).
    """
    subtask_name = c.data.get("subtask_name", "")
    if not (c.remote_filename or subtask_name):
        return
    try:
        async with async_session() as db:
            printer = await _one(db, select(Printer).where(Printer.id == c.printer_id))
        if not printer:
            return
        from backend.app.services.bambu_ftp import DeleteResult, delete_file_async
        from backend.app.utils.filename import derive_remote_filename

        candidates = [f"/{c.remote_filename}"] if c.remote_filename else []
        if not c.remote_filename and c.archive_filename:
            candidates.append(f"/{derive_remote_filename(c.archive_filename)}")
        if not c.remote_filename:
            candidates += [
                path for path in (f"/{subtask_name}.3mf", f"/{subtask_name}.gcode") if path not in candidates
            ]
        outcomes = set()
        for remote_path in candidates:
            for attempt in range(1, 4):
                try:
                    result = await delete_file_async(
                        printer.ip_address, printer.access_code, remote_path, printer_model=printer.model
                    )
                except Exception as e:
                    result = DeleteResult.FAILED
                    logger.warning("SD card cleanup attempt %d/3 raised for %s: %s", attempt, remote_path, e)
                if result == DeleteResult.DELETED:
                    logger.info("Deleted %s from printer %s SD card", remote_path, printer.name)
                if result in (DeleteResult.DELETED, DeleteResult.NOT_FOUND):
                    outcomes.add(result)
                    break
                if attempt < 3:
                    await asyncio.sleep(2)
                else:
                    outcomes.add(DeleteResult.FAILED)
                    logger.warning(
                        "SD card cleanup failed after 3 attempts for %s "
                        "(network/auth/transient error — file may linger on SD card)",
                        remote_path,
                    )
        if outcomes == {DeleteResult.NOT_FOUND}:
            logger.debug(
                "SD card cleanup: nothing to delete on %s — every candidate returned 550 (printer likely self-cleaned)",
                printer.name,
            )
    except Exception as e:
        logger.warning("SD card file cleanup failed for printer %s: %s", c.printer_id, e)


async def _queue_completed(c, name: str) -> None:
    """Publish the job's end and notify once the queue empties."""
    with suppress(Exception):
        info = printer_manager.get_printer(c.printer_id)
        await mqtt_relay.on_queue_job_completed(
            job_id=c.job_id,
            filename=name,
            printer_id=c.printer_id,
            printer_name=info.name if info else "Unknown",
            status=c.queue_status,
        )
    with suppress(Exception):
        async with async_session() as db:
            pending = await db.execute(select(func.count(PrintQueueItem.id)).where(PrintQueueItem.status == "queued"))
            if not (pending.scalar() or 0):
                today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
                ended = ("finished", "successful", "failed", "cancelled", "unsuccessful")
                completed = await db.execute(
                    select(func.count(PrintQueueItem.id)).where(
                        PrintQueueItem.status.in_(ended), PrintQueueItem.completed_at >= today
                    )
                )
                await notification_service.on_queue_completed(completed_count=completed.scalar() or 1, db=db)


async def _await_bed_cooldown(printer_id: int, name: str, *, memory) -> None:
    """Register a bed-cooled waiter, fired by bed temperature updates, when a provider wants the event."""
    try:
        from backend.app.api.routes.settings import get_setting

        async with async_session() as db:
            threshold_str = await get_setting(db, "bed_cooled_threshold")
            providers = await notification_service._get_providers_for_event(db, "on_bed_cooled", printer_id)
        threshold = float(threshold_str) if threshold_str else 35.0
        if not providers:
            logger.debug("[BED-COOL] No providers enabled for bed_cooled on printer %s", printer_id)
            return
        memory.bed_cool_waiters[printer_id] = {"threshold": threshold, "filename": name, "registered_at": time.time()}
        logger.info("[BED-COOL] Registered waiter for printer %s (threshold: %.0f°C)", printer_id, threshold)
    except Exception as e:
        logger.warning("[BED-COOL] Failed to register waiter: %s", e)


async def bed_cooled(printer_id: int, bed_temp: float, *, memory) -> None:
    """Bed temperature: notify once a completed print's bed has cooled to its waiter's threshold."""
    waiter = memory.bed_cool_waiters.get(printer_id)
    if not waiter or bed_temp > waiter["threshold"] or not memory.bed_cool_waiters.pop(printer_id, None):
        return  # Not waiting, still warm, or another update already notified.
    threshold = waiter["threshold"]
    logger.info("[BED-COOL] Bed cooled to %.1f°C on printer %s (threshold: %.0f°C)", bed_temp, printer_id, threshold)
    try:
        info = printer_manager.get_printer(printer_id)
        async with async_session() as db:
            await notification_service.on_bed_cooled(
                printer_id=printer_id,
                printer_name=info.name if info else "Unknown",
                bed_temp=bed_temp,
                threshold=threshold,
                filename=waiter["filename"],
                db=db,
            )
    except Exception as e:
        logger.warning("[BED-COOL] Failed to send notification: %s", e)


async def _track_usage(c) -> list[dict]:
    """Record filament use, archived or not: AMS remain% deltas, or Spoolman's report; returns the tracked spools.

    Queue jobs carry their committed tray mapping; external prints use the one
    their MQTT event reported.
    """
    printer_id, data, archive_id = c.printer_id, c.data, c.archive_id
    usage_results: list[dict] = []
    try:
        async with async_session() as db:
            owned = await _spoolman_owns_usage(db)
        if not owned:
            from backend.app.services.usage_tracker import on_print_complete as usage_on_print_complete

            async with async_session() as db:
                usage_results = await usage_on_print_complete(
                    printer_id, data, printer_manager, db, archive_id=archive_id, ams_mapping=data.get("ams_mapping")
                )
                if usage_results:
                    await ws_manager.broadcast(
                        {"type": "spool_usage_logged", "printer_id": printer_id, "usage": usage_results}
                    )
    except Exception as e:
        logger.warning("Usage tracker on_print_complete failed: %s", e)
    # Clear the persisted print-start context for both inventory backends. The
    # Spoolman path skips the internal tracker, so cannot clear it as a side effect.
    try:
        from backend.app.services.usage_tracker import discard_session

        async with async_session() as db:
            await discard_session(db, printer_id)
    except Exception as e:
        logger.warning("Failed to clear persisted print session for printer %s: %s", printer_id, e)
    if archive_id and data.get("status") == "completed":
        try:
            await _report_spoolman_usage(printer_id, archive_id)
        except Exception as e:
            logger.warning("Spoolman usage reporting failed: %s", e)
    elif archive_id:
        # Partial usage, from tracking data stored only while weight sync is off.
        try:
            async with async_session() as db:
                await _cleanup_spoolman_tracking(
                    printer_id,
                    archive_id,
                    db,
                    last_layer_num=data.get("last_layer_num"),
                    last_progress=data.get("last_progress"),
                )
        except Exception as e:
            logger.debug("[SPOOLMAN] Cleanup failed: %s", e)
    return usage_results


async def _job_notification_data(c, usage_results: list[dict], db) -> dict:
    """Notification data for a print with no Archive, from its job, so its owner can still be emailed."""
    data = {"owner_id": c.owner_id}  # The persisted job owns this run, also after a restart.
    try:
        if job := await db.get(PrintQueueItem, c.job_id):
            data["created_by_id"] = job.created_by_id
            if job.library_file_id:
                source = await _one(db, select(LibraryFile).where(LibraryFile.id == job.library_file_id))
                if source and source.print_time_seconds:
                    data["print_time_seconds"] = source.print_time_seconds
    except Exception as lookup_err:
        logger.debug("[NOTIFY-BG] Could not look up queue item for no-archive notification: %s", lookup_err)
    if usage_results:
        grams = sum(r.get("weight_used", 0) for r in usage_results)
        if grams > 0:
            data["actual_filament_grams"] = round(grams, 1)
        data["usage_results"] = usage_results
    remaining = c.data.get("remaining_time")
    if not data.get("print_time_seconds") and isinstance(remaining, (int, float)) and remaining > 0:
        data["print_time_seconds"] = int(remaining)
    return data


async def _publish_archive_outcome(archive_id: int, status: str, data: dict, name: str) -> None:
    """Show the Archive's outcome, which committed with the job; effects never overwrite it, even after a Stop."""
    try:
        async with async_session() as db:
            attempt = await ArchiveService(db).get_archive(archive_id)
            if attempt is not None:
                archive_status, failure_reason = attempt.status, attempt.failure_reason
            else:
                hms_errors = data.get("hms_errors", []) if status == "failed" else None
                archive_status = "aborted" if status == "cancelled" else status
                failure_reason = derive_failure_reason(status, hms_errors)
            logger.info("[ARCHIVE] Archive %s status %s, failure_reason=%s", archive_id, archive_status, failure_reason)
            await ws_manager.send_archive_updated({"id": archive_id, "status": archive_status})
            with suppress(Exception):
                await mqtt_relay.on_archive_updated(archive_id=archive_id, print_name=name, status=archive_status)
    except Exception as e:
        logger.error("[ARCHIVE] Failed to update archive %s status: %s", archive_id, e, exc_info=True)


async def _write_print_log(c, usage_results: list[dict]) -> None:
    """Record this run in the print log, apart from the Archive, with what this run used (#1378)."""
    try:
        from backend.app.services.print_log import write_log_entry

        async with async_session() as db:
            archive = await db.get(PrintArchive, c.archive_id)
            if not archive:
                return
            # A reprint reuses its source Archive (#730): credit the job's owner
            # to one that has no owner yet, never replacing the uploader.
            if archive.created_by_id is None and c.owner is not None:
                archive.created_by_id = c.owner[0]
            status = c.data.get("status", "completed")
            grams = _compute_run_filament_grams(
                status, archive.filament_used_grams, c.data.get("progress"), usage_results
            )
            # Tracked spools are closer to this run's cost than an estimate,
            # which assumes the print completed.
            cost = (sum(r.get("cost") or 0 for r in usage_results) or None) if usage_results else None
            if cost is None and status == "completed":
                cost = archive.cost
            info = printer_manager.get_printer(c.printer_id)
            await write_log_entry(
                db,
                archive_id=archive.id,
                queue_item_id=c.job_id,  # Batch cost and energy roll-ups join on it (#342).
                status=status,
                print_name=archive.print_name,
                printer_name=info.name if info else None,
                printer_id=c.printer_id,
                started_at=archive.started_at,
                completed_at=archive.completed_at,
                filament_type=archive.filament_type,
                filament_color=archive.filament_color,
                filament_used_grams=grams,
                cost=cost,
                failure_reason=archive.failure_reason,
                thumbnail_path=archive.thumbnail_path,
                created_by_id=archive.created_by_id,
                created_by_username=c.owner[1] if c.owner else None,
            )
            await db.commit()
            logger.info("[PRINT_LOG] Log entry written for archive %s", c.archive_id)
    except Exception as e:
        logger.warning("[PRINT_LOG] Failed to write log entry for archive %s: %s", c.archive_id, e)


async def _record_print_energy(printer_id: int, archive_id: int) -> None:
    """The run's energy from the smart plug's counter, against the start kWh persisted on the Archive (#941)."""
    try:
        logger.info("[ENERGY-BG] Starting energy calculation for archive %s", archive_id)
        async with async_session() as db:
            archive = await db.get(PrintArchive, archive_id)
            if archive is None:
                logger.warning("[ENERGY-BG] Archive %s no longer exists", archive_id)
                return
            starting_kwh = archive.energy_start_kwh
            if starting_kwh is None:
                logger.info("[ENERGY-BG] No start kWh recorded for archive %s", archive_id)
                return
            plug = await _one(db, select(SmartPlug).where(SmartPlug.printer_id == printer_id))
            if plug is None:
                logger.info("[ENERGY-BG] No smart plug for printer %s", printer_id)
                return
            energy = await _get_plug_energy(plug, db)
            logger.info("[ENERGY-BG] Energy response: %s", energy)
            if not energy or energy.get("total") is None:
                logger.warning("[ENERGY-BG] No 'total' in energy response")
                return
            energy_used = round(energy["total"] - starting_kwh, 4)
            logger.info("[ENERGY-BG] Per-print energy: %s kWh", energy_used)
            if energy_used < 0:
                logger.warning(
                    "[ENERGY-BG] Negative energy delta for archive %s (start=%s, end=%s) — counter reset?",
                    archive_id,
                    starting_kwh,
                    energy["total"],
                )
                return
            from backend.app.api.routes.settings import get_setting

            energy_cost_per_kwh = await get_setting(db, "energy_cost_per_kwh")
            cost_per_kwh = float(energy_cost_per_kwh) if energy_cost_per_kwh else 0.15
            energy_cost_value = round(energy_used * cost_per_kwh, 3)
            # Only the first run sets the Archive's energy, so a reprint keeps
            # the source's (#1378). Each run's energy is on its log entry.
            existing_runs = await db.scalar(
                select(func.count(PrintLogEntry.id)).where(PrintLogEntry.archive_id == archive_id)
            )
            if (existing_runs or 0) <= 1:
                archive.energy_kwh = energy_used
                archive.energy_cost = energy_cost_value
            # The log entry for this run was written before this task finished.
            latest_run = await db.execute(
                select(PrintLogEntry)
                .where(PrintLogEntry.archive_id == archive_id)
                .order_by(PrintLogEntry.id.desc())
                .limit(1)
            )
            run_row = latest_run.scalar_one_or_none()
            if run_row is not None:
                run_row.energy_kwh = energy_used
                run_row.energy_cost = energy_cost_value
            await db.commit()
            logger.info("[ENERGY-BG] Saved: %s kWh, cost=%s", energy_used, energy_cost_value)
    except Exception as e:
        logger.warning("[ENERGY-BG] Failed: %s", e)


def _new_photo(archive_dir: Path) -> tuple[str, Path]:
    """A fresh finish-photo filename and its path in the Archive's photos directory."""
    photos_dir = archive_dir / "photos"
    photos_dir.mkdir(parents=True, exist_ok=True)
    filename = f"finish_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}.jpg"
    return filename, photos_dir / filename  # SEC-PATH-OK: a generated name


async def _save_photo(archive_dir: Path, frame: bytes) -> str:
    filename, path = _new_photo(archive_dir)
    await asyncio.to_thread(path.write_bytes, frame)
    return filename


async def _external_frame(printer_id: int, printer) -> bytes | None:
    """A frame from the printer's external camera, reusing a live stream's frame when one owns the camera."""
    from backend.app.api.routes.camera import live_frame_for_capture
    from backend.app.services.external_camera import capture_frame

    defer, buffered = live_frame_for_capture(printer_id)
    if defer:
        return buffered
    return await capture_frame(
        printer.external_camera_url,
        printer.external_camera_type or "mjpeg",
        snapshot_url=printer.external_camera_snapshot_url,
    )


def _stream_frame(printer_id: int) -> bytes | None:
    """The buffered frame of an active camera or chamber-image stream, which a fresh grab would freeze."""
    from backend.app.api.routes.camera import _active_chamber_streams, _active_streams, get_buffered_frame

    prefix = f"{printer_id}-"
    streaming = any(key.startswith(prefix) for key in (*_active_streams, *_active_chamber_streams))
    return get_buffered_frame(printer_id) if streaming else None


async def _capture_finish_photo(printer_id: int, archive_id: int, data: dict, *, memory) -> str | None:
    """Capture the finish photo into the Archive; returns its filename for the notification.

    Sources, best framing first: the timelapse's last frame (#1397), the frame
    pre-captured at stage 22 (#1721), then the external camera, a live stream's
    frame, or a fresh capture.
    """
    try:
        logger.info("[PHOTO-BG] Starting finish photo capture for archive %s", archive_id)
        async with async_session() as db:
            from backend.app.api.routes.settings import get_setting

            capture_enabled = await get_setting(db, "capture_finish_photo")
            if capture_enabled is not None and capture_enabled.lower() != "true":
                return None
            if not (printer := await _one(db, select(Printer).where(Printer.id == printer_id))):
                return None
            if not (archive := await _one(db, select(PrintArchive).where(PrintArchive.id == archive_id))):
                return None
            if archive.file_path:
                archive_dir = app_settings.base_dir / Path(archive.file_path).parent
            else:
                logger.warning("[PHOTO-BG] Archive %s has no file_path, using fallback dir", archive_id)
                archive_dir = app_settings.archive_dir / str(archive.id)
            external = printer.external_camera_enabled and printer.external_camera_url
            photo_filename = None
            # The timelapse frames the moment after the toolhead parks, before the
            # bed drops (#1397). Only a timelapse the user enabled, never an
            # external camera's: #1721 removed forcing timelapse on at dispatch.
            if data.get("timelapse_was_active") and not external:
                photo_filename = await _capture_finish_photo_from_timelapse(
                    archive_id=archive_id, archive_dir=archive_dir
                )
            if not photo_filename:
                # #1790: the stage-22 producer may still be grabbing over the
                # camera's single RTSP client; wait for it before any fallback.
                in_flight = memory.finish_in_flight.pop(printer_id, None)
                if in_flight is not None:
                    try:
                        await asyncio.wait_for(in_flight.wait(), timeout=20.0)
                    except asyncio.TimeoutError:
                        logger.warning(
                            "[PHOTO-BG] timed out waiting for stage-22 producer for printer %s — proceeding to fallback",
                            printer_id,
                        )
                if cached_frame := memory.finish_frames.pop(printer_id, None):
                    photo_filename = await _save_photo(archive_dir, cached_frame)
                    logger.info(
                        "[PHOTO-BG] Saved stage-22 pre-captured frame: %s (%d bytes)", photo_filename, len(cached_frame)
                    )
            if not photo_filename and external:
                logger.info("[PHOTO-BG] Using external camera")
                if frame := await _external_frame(printer_id, printer):
                    photo_filename = await _save_photo(archive_dir, frame)
                    logger.info("[PHOTO-BG] Saved external camera frame: %s", photo_filename)
            elif not photo_filename and (frame := _stream_frame(printer_id)):
                logger.info("[PHOTO-BG] Using buffered frame from active stream")
                photo_filename = await _save_photo(archive_dir, frame)
                logger.info("[PHOTO-BG] Saved buffered frame: %s", photo_filename)
            elif not photo_filename:
                from backend.app.services.camera import capture_finish_photo

                photo_filename = await capture_finish_photo(
                    printer_id=printer_id,
                    ip_address=printer.ip_address,
                    access_code=printer.access_code,
                    model=printer.model,
                    archive_dir=archive_dir,
                )
            if photo_filename:
                archive.photos = [*(archive.photos or []), photo_filename]
                await db.commit()
                logger.info("[PHOTO-BG] Saved: %s", photo_filename)
            return photo_filename
    except Exception as e:
        logger.warning("[PHOTO-BG] Failed: %s", e)
        return None


async def _check_maintenance(printer_id: int, status: str) -> None:
    """After a completed print, notify the maintenance it made due."""
    if status != "completed":
        return
    try:
        logger.info("[MAINT-BG] Starting maintenance check for printer %s", printer_id)
        async with async_session() as db:
            printer = await _one(db, select(Printer).where(Printer.id == printer_id))
            printer_name = printer.name if printer else f"Printer {printer_id}"
            await ensure_default_types(db)
            overview = await _get_printer_maintenance_internal(printer_id, db, commit=True)
            due = [
                {"name": item.maintenance_type_name, "is_due": item.is_due, "is_warning": item.is_warning}
                for item in overview.maintenance_items
                if item.enabled and (item.is_due or item.is_warning)
            ]
            if not due:
                logger.info("[MAINT-BG] Completed (no items need attention)")
                return
            await notification_service.on_maintenance_due(printer_id, printer_name, due, db)
            logger.info("[MAINT-BG] Sent notification: %s items need attention", len(due))
            for item in due:
                with suppress(Exception):
                    await mqtt_relay.on_maintenance_alert(
                        printer_id=printer_id,
                        printer_name=printer_name,
                        maintenance_type=item["name"],
                        current_value=0,  # Not easily available here
                        threshold=0,  # Not easily available here
                    )
    except Exception as e:
        logger.warning("[MAINT-BG] Failed: %s", e)


async def _notify_after_photo(c, usage_results: list[dict], photo: asyncio.Task) -> None:
    """Send the completion notification once the finish photo is ready, or without it after a timeout.

    A recording timelapse is polled for up to 60 s for its photo (#1397), so it gets a longer budget.
    """
    timeout = 75 if c.data.get("timelapse_was_active") else 45
    finish_photo = None
    try:
        finish_photo = await asyncio.wait_for(photo, timeout=timeout)
        logger.info("[PHOTO-NOTIFY] Photo task returned: %s", finish_photo)
    except TimeoutError:
        logger.warning("[PHOTO-NOTIFY] Photo capture timed out after %ss, sending notification without photo", timeout)
    except Exception as e:
        logger.warning("[PHOTO-NOTIFY] Photo task failed: %s", e)
    try:
        await _notify_completion(c, usage_results, finish_photo)
    except Exception as e:
        logger.error("[PHOTO-NOTIFY] Notification sending failed: %s", e, exc_info=True)


async def _notify_completion(c, usage_results: list[dict], finish_photo: str | None = None) -> None:
    """Notify the completion with its actual time, filament and finish photo, and email its owner."""
    printer_id, data, archive_id = c.printer_id, c.data, c.archive_id
    status = data.get("status", "completed")
    try:
        logger.info("[NOTIFY-BG] Starting notifications for printer %s, photo=%s", printer_id, finish_photo)
        async with async_session() as db:
            printer = await _one(db, select(Printer).where(Printer.id == printer_id))
            printer_name = printer.name if printer else f"Printer {printer_id}"
            if archive_id:
                archive = await _one(db, select(PrintArchive).where(PrintArchive.id == archive_id))
                archive_data = archive and await _archive_notification_data(c, archive, usage_results, finish_photo, db)
            else:
                archive_data = await _job_notification_data(c, usage_results, db)
            await notification_service.on_print_complete(
                printer_id, printer_name, status, data, db, archive_data=archive_data
            )
            if archive_data:
                filename = data.get("subtask_name") or data.get("filename", "Unknown")
                await _dispatch_user_print_email(status, archive_data.get("created_by_id"), printer_name, filename, db)
            logger.info("[NOTIFY-BG] Completed")
    except Exception as e:
        logger.error("[NOTIFY-BG] Failed: %s", e, exc_info=True)


async def _archive_notification_data(c, archive, usage_results: list[dict], finish_photo: str | None, db) -> dict:
    data, status = c.data, c.data.get("status", "completed")
    # Every terminal status sets completed_at (#1198); without both times the
    # notification may fall back to the slicer estimate.
    elapsed = (
        (archive.completed_at - archive.started_at).total_seconds()
        if archive.started_at and archive.completed_at
        else 0
    )
    archive_data = {
        "print_time_seconds": archive.print_time_seconds,
        "actual_time_seconds": int(elapsed) if elapsed > 0 else None,
        "actual_filament_grams": archive.filament_used_grams,
        "failure_reason": archive.failure_reason,
        "created_by_id": archive.created_by_id,
        # The persisted job owns this run, also after a restart.
        "owner_id": c.owner_id,
    }
    if status != "completed" and archive.filament_used_grams:
        progress = data.get("progress") or 0
        archive_data["actual_filament_grams"] = round(
            archive.filament_used_grams * _partial_progress_scale(progress), 1
        )
        archive_data["progress"] = progress
    if archive.extra_data and archive.extra_data.get("filament_slots"):
        slots = archive.extra_data["filament_slots"]
        if status != "completed":
            scale = _partial_progress_scale(data.get("progress"))
            slots = [{**s, "used_g": round(s["used_g"] * scale, 1)} for s in slots]
        archive_data["filament_slots"] = slots
    # Report the printed plate, not the whole project (#1785).
    archive_data = _scope_notification_archive_data_to_plate(
        archive_data, archive.file_path, data.get("plate_id"), status, data.get("progress"), app_settings.base_dir
    )
    if not archive_data.get("actual_filament_grams") and usage_results:
        grams = sum(r.get("weight_used", 0) for r in usage_results)
        if grams > 0:
            archive_data["actual_filament_grams"] = round(grams, 1)
    if usage_results:
        archive_data["usage_results"] = usage_results  # AMS slot info for notifications.
    if finish_photo:
        from backend.app.api.routes.settings import get_setting

        url = f"/api/v1/archives/{c.archive_id}/photos/{finish_photo}"
        # A relative URL won't work for external services.
        external_url = await get_setting(db, "external_url")
        archive_data["finish_photo_url"] = f"{external_url.rstrip('/')}{url}" if external_url else url
        try:  # The bytes, for providers that attach images (e.g. Pushover).
            folder = app_settings.base_dir / Path(archive.file_path).parent  # SEC-PATH-OK: the Archive's own
            photo_path = folder / "photos" / finish_photo  # SEC-PATH-OK: a generated name
            if photo_path.exists():
                photo_bytes = await asyncio.to_thread(photo_path.read_bytes)
                if len(photo_bytes) <= 2_500_000:
                    archive_data["image_data"] = photo_bytes
                    logger.info("[NOTIFY-BG] Loaded finish photo bytes: %s bytes", len(photo_bytes))
                else:
                    logger.warning("[NOTIFY-BG] Finish photo too large for attachment: %s bytes", len(photo_bytes))
        except Exception as e:
            logger.warning("[NOTIFY-BG] Failed to read finish photo bytes: %s", e)
    return archive_data


async def _finish_layer_timelapse(printer_id: int, archive_id: int, status: str) -> None:
    """Stitch a completed print's external-camera layer timelapse into its Archive, or cancel the session."""
    from backend.app.services.layer_timelapse import cancel_session, on_print_complete as tl_complete

    try:
        if status != "completed":
            cancel_session(printer_id)
            logger.info("[LAYER-TL] Cancelled layer timelapse for printer %s (status: %s)", printer_id, status)
            return
        logger.info("[LAYER-TL] Stitching layer timelapse for printer %s", printer_id)
        timelapse_path = await tl_complete(printer_id)
        if timelapse_path and archive_id:
            logger.info("[LAYER-TL] Attaching timelapse %s to archive %s", timelapse_path, archive_id)
            async with async_session() as db:
                timelapse_data = await asyncio.to_thread(timelapse_path.read_bytes)
                await ArchiveService(db).attach_timelapse(archive_id, timelapse_data, "layer_timelapse.mp4")
            logger.info("[LAYER-TL] Layer timelapse attached successfully")
        if timelapse_path:
            await asyncio.to_thread(timelapse_path.unlink, missing_ok=True)
    except Exception as e:
        logger.warning("[LAYER-TL] Failed: %s", e)
        with suppress(Exception):
            cancel_session(printer_id)

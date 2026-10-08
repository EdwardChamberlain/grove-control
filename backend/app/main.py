import asyncio
import json
import logging
import mimetypes as _mimetypes
import os
import secrets
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from logging.handlers import RotatingFileHandler
from urllib.parse import urlparse

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import delete, select, text

from backend.app.api.routes import (
    ams_history,
    api_keys,
    archive_purge,
    archives,
    auth,
    camera,
    cloud,
    discovery,
    external_links,
    filaments,
    firmware,
    github_backup,
    groups,
    ha_sensors,
    inventory,
    kprofiles,
    labels,
    library,
    library_tags,
    library_trash,
    library_variants,
    local_backup,
    local_presets,
    location_ha_sensors,
    maintenance,
    makerworld,
    metrics,
    mfa,
    notification_templates,
    notifications,
    obico,
    orca_cloud,
    pending_uploads,
    print_log,
    print_queue,
    printer_sensor_history,
    printers,
    projects,
    scheduled_dryings,
    settings as settings_routes,
    slice_jobs,
    slicer_presets,
    smart_plugs,
    spoolman,
    spoolman_inventory,
    support,
    system,
    updates,
    user_notifications,
    users,
    virtual_printers,
    webhook,
    websocket,
)
from backend.app.api.routes.support import init_debug_logging
from backend.app.core.config import APP_VERSION, settings as app_settings
from backend.app.core.database import async_session, engine, init_db
from backend.app.core.tasks import cancel_background_tasks, spawn_background_task
from backend.app.core.websocket import ws_manager
from backend.app.services.archive_purge import archive_purge_service
from backend.app.services.bambu_mqtt import PrinterState
from backend.app.services.github_backup import github_backup_service
from backend.app.services.ha_sensor_manager import ha_sensor_manager
from backend.app.services.library_trash import library_trash_service
from backend.app.services.lifecycle import intake
from backend.app.services.lifecycle.engine import QueueTransitionConflict
from backend.app.services.local_backup import local_backup_service
from backend.app.services.location_ha_sensor_manager import location_ha_sensor_manager
from backend.app.services.mqtt_relay import mqtt_relay
from backend.app.services.mqtt_smart_plug import mqtt_smart_plug_service
from backend.app.services.notification_service import notification_service
from backend.app.services.obico_detection import obico_detection_service
from backend.app.services.print_effects import _capture_snapshot_for_notification
from backend.app.services.print_scheduler import scheduler as print_scheduler
from backend.app.services.printer_manager import (
    init_printer_connections,
    printer_manager,
    printer_state_to_dict,
)
from backend.app.services.queue_source_cleanup import start_queue_source_cleanup, stop_queue_source_cleanup
from backend.app.services.slot_nozzle import (
    resolve_slot_nozzle,
)
from backend.app.services.smart_plug_manager import smart_plug_manager
from backend.app.services.spoolman import close_spoolman_client, get_spoolman_client, init_spoolman_client
from backend.app.utils.fts_routing import extruder_for_inlet


# =============================================================================
# Dependency Check - runs before other imports to give helpful error messages
# =============================================================================
def _start_error_server(missing_packages: list):
    """Start a minimal HTTP server to display dependency errors in browser."""
    import os
    import signal
    from http.server import BaseHTTPRequestHandler, HTTPServer

    packages_html = "".join(f"<li><code>{p}</code></li>" for p in missing_packages)

    html = f"""<!DOCTYPE html>
<html>
<head>
    <title>Grove Control - Setup Required</title>
    <style>
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0f172a; color: #e2e8f0;
            display: flex; justify-content: center; align-items: center;
            min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box;
        }}
        .container {{
            background: #1e293b; border-radius: 12px; padding: 40px;
            max-width: 600px; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        }}
        h1 {{ color: #f87171; margin-bottom: 10px; }}
        h2 {{ color: #94a3b8; font-weight: normal; margin-top: 0; }}
        .packages {{
            background: #0f172a; border-radius: 8px; padding: 20px;
            margin: 20px 0; text-align: left;
        }}
        .packages ul {{ margin: 0; padding-left: 20px; }}
        .packages li {{ color: #fbbf24; margin: 8px 0; }}
        .command {{
            background: #0f172a; border-radius: 8px; padding: 15px 20px;
            margin: 15px 0; font-family: monospace; color: #4ade80;
            text-align: left; overflow-x: auto;
        }}
        .note {{ color: #94a3b8; font-size: 14px; margin-top: 20px; }}
    </style>
</head>
<body>
    <div class="container">
        <h1>Setup Required</h1>
        <h2>Missing Python packages</h2>
        <div class="packages"><ul>{packages_html}</ul></div>
        <p>To fix, run this command on your server:</p>
        <div class="command">pip install -r requirements.txt</div>
        <p>Or if using a virtual environment:</p>
        <div class="command">./venv/bin/pip install -r requirements.txt</div>
        <p class="note">After installing, restart Grove Control:<br>
        <code>sudo systemctl restart bambuddy</code></p>
    </div>
</body>
</html>"""

    class ErrorHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(503)
            self.send_header("Content-type", "text/html")
            self.end_headers()
            self.wfile.write(html.encode())

        def log_message(self, format, *args):
            print(f"[Error Server] {args[0]}")

    port = int(os.environ.get("PORT", 8000))
    print(f"\nStarting error server on http://0.0.0.0:{port}")
    print("Visit this URL in your browser to see the error details.\n")

    server = HTTPServer(("0.0.0.0", port), ErrorHandler)  # nosec B104

    def shutdown(signum, frame):
        print("\nShutting down error server...")
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    server.serve_forever()


def check_dependencies():
    """Check that all required packages are installed."""
    missing = []

    # Map of import name -> package name (for pip install)
    required = {
        "jwt": "PyJWT",
        "fastapi": "fastapi",
        "uvicorn": "uvicorn",
        "sqlalchemy": "sqlalchemy",
        "aiosqlite": "aiosqlite",
        "pydantic": "pydantic",
        "paho.mqtt": "paho-mqtt",
    }

    for module, package in required.items():
        try:
            __import__(module)
        except ImportError:
            missing.append(package)

    if missing:
        print("\n" + "=" * 60)
        print("ERROR: Missing required Python packages!")
        print("=" * 60)
        print(f"\nMissing packages: {', '.join(missing)}")
        print("\nTo fix, run:")
        print("  pip install -r requirements.txt")
        print("\nOr if using a virtual environment:")
        print("  ./venv/bin/pip install -r requirements.txt")
        print("=" * 60 + "\n")
        _start_error_server(missing)


check_dependencies()
# =============================================================================


# Import settings first for logging configuration

# Configure logging based on settings
# DEBUG=true -> DEBUG level, else use LOG_LEVEL setting
log_level_str = "DEBUG" if app_settings.debug else app_settings.log_level.upper()
log_level = getattr(logging, log_level_str, logging.INFO)
# Trace ID column ([-] when no request scope is active — startup, MQTT
# callbacks, scheduled tasks not chained from a request — so the column
# stays visually aligned and missing values are obvious in grep). See
# backend/app/core/trace.py for the ContextVar that feeds this slot.
log_format = "%(asctime)s %(levelname)s [%(name)s] [%(trace_id)s] %(message)s"

# Create root logger
root_logger = logging.getLogger()
root_logger.setLevel(log_level)

# Trace-ID injection: this filter populates record.trace_id from the
# per-request ContextVar so the format string above can reference it.
# Attached to each HANDLER (not the root logger) because Python's
# logging semantics only invoke a logger's filters on records that
# *originated* at that logger — records propagated up from child
# loggers (every named logger in the app) never trigger root's filter.
# Putting it on the handlers means every record any handler emits gets
# trace_id injected just before the formatter runs, regardless of which
# logger created the record. Without this, the formatter raises
# KeyError on every child-logger record and the record is silently
# dropped — which is exactly the "logs/bambuddy.log only shows logs
# partially" bug we hit. See backend/app/core/trace.py for the
# ContextVar the filter reads.
from backend.app.core.trace import TraceIDFilter

_trace_id_filter = TraceIDFilter()

# Console handler - always enabled
console_handler = logging.StreamHandler()
console_handler.setLevel(log_level)
console_handler.setFormatter(logging.Formatter(log_format))
console_handler.addFilter(_trace_id_filter)
root_logger.addHandler(console_handler)

# File handler - only in production or if explicitly enabled
if app_settings.log_to_file:
    log_file = app_settings.log_dir / "bambuddy.log"
    file_handler = RotatingFileHandler(
        log_file,
        maxBytes=5 * 1024 * 1024,  # 5MB
        backupCount=3,
        encoding="utf-8",
    )
    file_handler.setLevel(log_level)
    file_handler.setFormatter(logging.Formatter(log_format))
    file_handler.addFilter(_trace_id_filter)
    root_logger.addHandler(file_handler)
    logging.info("Logging to file: %s", log_file)

    # Pipe uvicorn's HTTP access log to bambuddy.log too. Uvicorn ships its
    # access logger with propagate=False by default, so without this attach
    # there is no on-disk record of which endpoint triggered a server-state
    # change — the rogue stop_print mystery on 2026-04-26 was untraceable
    # for exactly this reason. Filtered to write methods only
    # (POST/PUT/PATCH/DELETE) so the high-volume status-poll GETs from the
    # frontend don't churn the rotation window faster than it's useful.
    from backend.app.core.logging_filters import (
        CancelledPoolNoiseFilter,
        WriteRequestsOnlyFilter,
    )

    uvicorn_access_logger = logging.getLogger("uvicorn.access")
    uvicorn_access_logger.addHandler(file_handler)
    uvicorn_access_logger.addFilter(WriteRequestsOnlyFilter())
    # Uvicorn's access logger has propagate=False (its own default), so the
    # root-attached TraceIDFilter never sees these records. Attach a
    # second instance directly so HTTP access lines carry the same trace
    # ID column as the application logs they correlate with.
    uvicorn_access_logger.addFilter(TraceIDFilter())

    # Drop SQLAlchemy connection-pool log noise that's caused by Starlette's
    # BaseHTTPMiddleware cancelling the inner task scope on client
    # disconnect (#1112). The cancel-safe `get_db` already prevents the
    # underlying transaction leak; this filter only suppresses the residual
    # log records that pre-existing pools still emit during their cleanup.
    logging.getLogger("sqlalchemy.pool").addFilter(CancelledPoolNoiseFilter())

# Reduce noise from third-party libraries in production
if not app_settings.debug:
    logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("paho.mqtt").setLevel(logging.WARNING)

logging.info("Grove Control starting - debug=%s, log_level=%s", app_settings.debug, log_level_str)


# Track active prints: {(printer_id, filename): archive_id}


# Track progress milestones for notifications: {printer_id: last_milestone_notified}
# Milestones are 25, 50, 75. Value of 0 means no milestone notified yet for current print.
_last_progress_milestone: dict[int, int] = {}

# Track whether first layer complete notification has been sent for current print
_first_layer_notified: dict[int, bool] = {}

# Track HMS errors that have been notified: {printer_id: set of error codes}
# This prevents sending duplicate notifications for the same error
_notified_hms_errors: dict[int, set[str]] = {}
# Track when HMS errors were last seen: {printer_id: timestamp}
# Used to debounce clearing — prevents flapping errors from re-triggering notifications
_hms_last_seen: dict[int, float] = {}
_HMS_CLEAR_GRACE_SECONDS = 30.0


# Offline-notification edge state (#1752): fire `on_printer_offline` exactly
# once when a printer transitions connected → disconnected. `_printer_last_connected`
# holds the previous observation so we only fire on the True → False edge (a
# False → False repeat doesn't notify; an initial False at startup doesn't
# notify either, since there's no prior True). `_printer_offline_notify_tasks`
# holds the per-printer pending asyncio task that fires the notification
# after a debounce window — cancelled if the printer reconnects before the
# window elapses, so transient MQTT blips don't flood the user.
_printer_last_connected: dict[int, bool] = {}
_printer_offline_notify_tasks: dict[int, asyncio.Task] = {}
# Debounce: a printer must stay offline this long before we notify. Sized
# against the staleness path (`bambu_mqtt.py::STALE_RECONNECT_COOLDOWN = 30s`)
# so a single stale-trigger cooldown isn't enough to fire — only a real
# offline that survives one reconnect attempt notifies.
_PRINTER_OFFLINE_NOTIFY_DEBOUNCE_SECONDS = 60.0


# Per-printer lock that serialises the spool-assignment side of on_ams_change
# (auto-unlink stale + auto-assign new) when MQTT bursts deliver multiple AMS
# updates for the same printer in quick succession (~30 ms apart, observed in
# the wild on H2D + dual AMS).
#
# Without this serialisation, two concurrent on_ams_change callbacks each read
# "no assignment for (printer, ams, tray)", each call auto_assign_spool, and
# the second commit hits
#   IntegrityError: duplicate key value violates unique constraint
#                   "spool_assignment_printer_id_ams_id_tray_id_key"
# SQLite's WAL serial-write semantics had been silently swallowing the race
# until optional Postgres support landed (asyncpg allows true concurrent
# transactions and surfaces the constraint violation).
#
# Scope is intentionally narrow: only the two DB-mutating blocks (unlink +
# assign) are inside the lock. The Spoolman sync block further down stays
# concurrent because it's network-bound and idempotent.
_ams_assignment_locks: dict[int, asyncio.Lock] = {}


def _get_ams_assignment_lock(printer_id: int) -> asyncio.Lock:
    """Return the per-printer assignment lock, creating it on first use."""
    lock = _ams_assignment_locks.get(printer_id)
    if lock is None:
        lock = asyncio.Lock()
        _ams_assignment_locks[printer_id] = lock
    return lock


# Per-printer dedup for unknown_tag WS broadcasts. Keyed by
# (ams_id, tray_id) -> (tag_uid, tray_uuid); we only re-broadcast when the
# tag tuple changes for the slot. Cleared when the slot is reported empty
# so remove + reinsert reliably re-prompts the UI.
_unknown_tag_last_broadcast: dict[int, dict[tuple[int, int], tuple[str, str]]] = {}


async def _broadcast_unknown_tag(
    *,
    printer_id: int,
    ams_id: int,
    tray_id: int,
    tag_uid: str,
    tray_uuid: str,
    tray_type: str | None = None,
    tray_color: str | None = None,
    tray_sub_brands: str | None = None,
    tray_count: int | None = None,
) -> None:
    """Broadcast unknown_tag, deduped so repeated MQTT pushes for the same slot+tag don't spam the UI."""
    _logger = logging.getLogger(__name__)
    slot_key = (ams_id, tray_id)
    tag_key = (tag_uid or "", tray_uuid or "")
    per_printer = _unknown_tag_last_broadcast.setdefault(printer_id, {})
    if per_printer.get(slot_key) == tag_key:
        _logger.debug(
            "unknown_tag deduped for printer=%d AMS=%d slot=%d tag=%s",
            printer_id,
            ams_id,
            tray_id,
            tag_key[0][:8] or tag_key[1][:8] or "(none)",
        )
        return
    _logger.info(
        "unknown_tag broadcast: printer=%d AMS=%d slot=%d type=%r color=%r tag=%s",
        printer_id,
        ams_id,
        tray_id,
        tray_type,
        tray_color,
        tag_key[0][:8] or tag_key[1][:8] or "(none)",
    )
    # Broadcast first; only commit the dedup if the WS write succeeds.
    # If broadcast raises, the next MQTT push retries instead of being
    # permanently silenced by a poisoned dedup entry.
    await ws_manager.broadcast(
        {
            "type": "unknown_tag",
            "printer_id": printer_id,
            "ams_id": ams_id,
            "tray_id": tray_id,
            "tag_uid": tag_uid,
            "tray_uuid": tray_uuid,
            "tray_type": tray_type,
            "tray_color": tray_color,
            "tray_sub_brands": tray_sub_brands,
            "tray_count": tray_count,
        }
    )
    per_printer[slot_key] = tag_key


def _clear_unknown_tag_dedup(printer_id: int, ams_id: int, tray_id: int) -> None:
    """Drop the cached last-broadcast tag for a slot (called when slot reports empty or gets matched)."""
    per_printer = _unknown_tag_last_broadcast.get(printer_id)
    if per_printer is None:
        return
    per_printer.pop((ams_id, tray_id), None)


_last_status_broadcast: dict[int, str] = {}
# Track printers where we've updated nozzle_count
_nozzle_count_updated: set[int] = set()


async def _maybe_notify_printer_offline(printer_id: int) -> None:
    """Wait the debounce window then fire `on_printer_offline` if the printer
    is still offline.

    Scheduled by `on_printer_status_change` on the connected → disconnected
    edge (#1752). Cancelled by the same handler if the printer reconnects
    before the window elapses, so a single MQTT blip + recovery doesn't
    notify. Both the staleness-detector path (`bambu_mqtt.py::check_staleness`)
    and the smart-plug power-off path (`printer_manager.mark_printer_offline`)
    route through the same status-change callback, so this covers both.
    """
    logger = logging.getLogger(__name__)
    try:
        await asyncio.sleep(_PRINTER_OFFLINE_NOTIFY_DEBOUNCE_SECONDS)
        still_offline = not printer_manager.is_connected(printer_id)
        logger.info(
            "[#1752] Printer %s offline debounce elapsed: still_offline=%s",
            printer_id,
            still_offline,
        )
        if not still_offline:
            return
        async with async_session() as db:
            from backend.app.models.printer import Printer

            result = await db.execute(select(Printer).where(Printer.id == printer_id))
            printer = result.scalar_one_or_none()
            if not printer:
                logger.warning(
                    "[#1752] Printer %s missing from DB at offline-notify time; skipping",
                    printer_id,
                )
                return
            logger.info(
                "[#1752] Dispatching on_printer_offline for printer %s (%s)",
                printer_id,
                printer.name,
            )
            await notification_service.on_printer_offline(printer_id, printer.name, db)
    except asyncio.CancelledError:
        raise
    except Exception as e:
        logger.warning("Printer offline notification failed for printer %s: %s", printer_id, e)
    finally:
        _printer_offline_notify_tasks.pop(printer_id, None)


async def on_printer_status_change(printer_id: int, state: PrinterState):
    """Handle printer status changes - broadcast via WebSocket."""
    await intake.printer_status(printer_id, state)

    # Offline-notification edge (#1752): schedule `on_printer_offline` on
    # connected → disconnected. The "back online" channel is already covered
    # by the print-failure notification (firmware reports gcode_state=FAILED
    # on reconnect of an interrupted print), so we don't add a symmetric
    # online event here.
    prev_connected = _printer_last_connected.get(printer_id)
    _printer_last_connected[printer_id] = state.connected
    if prev_connected is True and not state.connected:
        existing = _printer_offline_notify_tasks.get(printer_id)
        if existing is None or existing.done():
            logging.getLogger(__name__).info(
                "[#1752] Printer %s connected→disconnected edge; scheduling offline notification in %.0fs",
                printer_id,
                _PRINTER_OFFLINE_NOTIFY_DEBOUNCE_SECONDS,
            )
            _printer_offline_notify_tasks[printer_id] = asyncio.create_task(
                _maybe_notify_printer_offline(printer_id),
                name=f"printer-offline-notify-{printer_id}",
            )
    elif state.connected:
        pending = _printer_offline_notify_tasks.pop(printer_id, None)
        if pending is not None and not pending.done():
            logging.getLogger(__name__).info(
                "[#1752] Printer %s reconnected before debounce; cancelling pending offline notification",
                printer_id,
            )
            pending.cancel()

    # Only broadcast if something meaningful changed (reduce WebSocket spam)
    # Include rounded temperatures to detect meaningful temp changes (within 1 degree)
    temps = state.temperatures or {}
    nozzle_temp = round(temps.get("nozzle", 0))
    bed_temp = round(temps.get("bed", 0))
    nozzle_2_temp = round(temps.get("nozzle_2", 0)) if "nozzle_2" in temps else ""
    chamber_temp = round(temps.get("chamber", 0)) if "chamber" in temps else ""

    # Auto-detect dual-nozzle printers from MQTT temperature data
    if "nozzle_2" in temps and printer_id not in _nozzle_count_updated:
        _nozzle_count_updated.add(printer_id)
        # Update nozzle_count in database
        async with async_session() as db:
            from backend.app.models.printer import Printer

            result = await db.execute(select(Printer).where(Printer.id == printer_id))
            printer = result.scalar_one_or_none()
            if printer and printer.nozzle_count != 2:
                printer.nozzle_count = 2
                await db.commit()
                logging.getLogger(__name__).info(
                    f"Auto-detected dual-nozzle printer {printer_id}, updated nozzle_count=2"
                )

    # Include target temps for heating phase detection
    bed_target = round(temps.get("bed_target", 0))
    nozzle_target = round(temps.get("nozzle_target", 0))

    # Include tray_now and vt_tray hash so external spool changes trigger broadcasts
    vt_tray_key = hash(str(state.raw_data.get("vt_tray", []))) if state.raw_data else 0
    # Include AMS dry_time and tray state values so drying/slot changes trigger broadcasts
    ams_dry_key = tuple(a.get("dry_time", 0) for a in (state.raw_data.get("ams") or [])) if state.raw_data else ()
    # Include tray states so load/unload transitions (state 11→10) trigger broadcasts (#784)
    ams_tray_key = (
        tuple(
            (t.get("id"), t.get("tray_type", ""), t.get("state"))
            for a in (state.raw_data.get("ams") or [])
            for t in a.get("tray", [])
        )
        if state.raw_data
        else ()
    )
    status_key = (
        f"{state.connected}:{state.state}:{state.progress}:{state.layer_num}:"
        f"{nozzle_temp}:{bed_temp}:{nozzle_2_temp}:{chamber_temp}:"
        f"{state.stg_cur}:{bed_target}:{nozzle_target}:"
        f"{state.cooling_fan_speed}:{state.big_fan1_speed}:{state.big_fan2_speed}:"
        f"{state.chamber_light}:{state.active_extruder}:{state.tray_now}:{vt_tray_key}:"
        f"{ams_dry_key}:{ams_tray_key}:{state.door_open}:{state.ams_filament_backup}"
    )

    # MQTT relay - publish status (before dedup check - always publish to MQTT)
    try:
        printer_info = printer_manager.get_printer(printer_id)
        if printer_info:
            await mqtt_relay.on_printer_status(printer_id, state, printer_info.name, printer_info.serial_number)
    except Exception:
        pass  # Don't fail status callback if MQTT fails

    if _last_status_broadcast.get(printer_id) == status_key:
        return  # No change, skip WebSocket broadcast

    _last_status_broadcast[printer_id] = status_key

    # Check for progress milestone notifications (25%, 50%, 75%)
    progress = state.progress or 0
    is_printing = state.state in ("RUNNING", "PRINTING")

    if is_printing and progress > 0:
        # Determine which milestone we've reached
        current_milestone = 0
        if progress >= 75:
            current_milestone = 75
        elif progress >= 50:
            current_milestone = 50
        elif progress >= 25:
            current_milestone = 25

        last_milestone = _last_progress_milestone.get(printer_id, 0)

        # If we've crossed a new milestone, send notification
        if current_milestone > last_milestone:
            _last_progress_milestone[printer_id] = current_milestone
            try:
                from backend.app.models.printer import Printer

                # Read the printer in a short session and release the connection
                # BEFORE the ~15s camera snapshot below — holding it across the grab
                # pinned a pooled connection per milestone, per printer (issue #2572).
                async with async_session() as db:
                    result = await db.execute(select(Printer).where(Printer.id == printer_id))
                    printer = result.scalar_one_or_none()

                printer_name = printer.name if printer else f"Printer {printer_id}"
                filename = state.subtask_name or state.gcode_file or "Unknown"
                # remaining_time is in minutes, convert to seconds for notification
                remaining_time_seconds = state.remaining_time * 60 if state.remaining_time else None

                # Capture camera snapshot for notification image attachment (no DB held).
                image_data = await _capture_snapshot_for_notification(printer_id, printer, logging.getLogger(__name__))

                # Notification send needs a session (provider/template lookups).
                async with async_session() as db:
                    await notification_service.on_print_progress(
                        printer_id,
                        printer_name,
                        filename,
                        current_milestone,
                        db,
                        remaining_time_seconds,
                        image_data=image_data,
                    )
            except Exception as e:
                logging.getLogger(__name__).warning(f"Progress milestone notification failed: {e}")
    elif progress < 5:
        # Reset milestone tracking when print restarts or new print begins
        _last_progress_milestone[printer_id] = 0
        _first_layer_notified[printer_id] = False

    # HMS error codes that should not trigger notifications even though they
    # have known descriptions (e.g. user-initiated actions, not real errors).
    _HMS_NOTIFICATION_SUPPRESS = {
        "0500_400E",  # Printing was cancelled (user action, not an error)
    }

    # Check for new HMS errors and send notifications
    current_hms_errors = getattr(state, "hms_errors", []) or []
    if current_hms_errors:
        # Build set of current error codes (using attr for uniqueness)
        current_error_codes = {f"{e.attr:08x}" for e in current_hms_errors}
        previously_notified = _notified_hms_errors.get(printer_id, set())

        # Find new errors that haven't been notified yet
        new_error_codes = current_error_codes - previously_notified

        # Update tracking immediately to prevent duplicate notifications from concurrent callbacks
        _notified_hms_errors[printer_id] = current_error_codes
        _hms_last_seen[printer_id] = time.time()

        if new_error_codes:
            # Get the actual new errors for the notification
            # Filter to severity >= 2 (skip informational/status messages like H2D sends)
            new_errors = [e for e in current_hms_errors if f"{e.attr:08x}" in new_error_codes and e.severity >= 2]

            try:
                from backend.app.models.printer import Printer

                # Read the printer in a short session and release the connection
                # BEFORE the ~15s camera snapshot below (issue #2572).
                async with async_session() as db:
                    result = await db.execute(select(Printer).where(Printer.id == printer_id))
                    printer = result.scalar_one_or_none()

                printer_name = printer.name if printer else f"Printer {printer_id}"

                # Format error details for notification
                # Module 0x07 = AMS/Filament, 0x05 = Nozzle, 0x0C = Motion Controller, etc.
                module_names = {
                    0x03: "Print/Task",
                    0x05: "Nozzle/Extruder",
                    0x07: "AMS/Filament",
                    0x0C: "Motion Controller",
                    0x12: "Chamber",
                }

                # Capture camera snapshot once for all error notifications (no DB held).
                error_image_data = await _capture_snapshot_for_notification(
                    printer_id, printer, logging.getLogger(__name__)
                )

                # Notification sends need a session (provider/template lookups).
                async with async_session() as db:
                    sent_count = 0
                    for error in new_errors:
                        module_name = module_names.get(error.module, f"Module 0x{error.module:02X}")
                        # Build short code like "0700_8010"
                        # Mask to 16 bits to handle printers that send larger values
                        error_code_int = int(error.code.replace("0x", ""), 16) if error.code else 0
                        error_code_masked = error_code_int & 0xFFFF
                        short_code = f"{(error.attr >> 16) & 0xFFFF:04X}_{error_code_masked:04X}"

                        # Only notify for errors with known descriptions — printers
                        # send many undocumented/phantom codes that aren't real errors.
                        # Resolved at parse time (#2926); short_code is still needed
                        # for the suppression set below.
                        description = error.description
                        if not description or short_code in _HMS_NOTIFICATION_SUPPRESS:
                            continue

                        error_type = f"{module_name} Error"
                        error_detail = description

                        await notification_service.on_printer_error(
                            printer_id, printer_name, error_type, db, error_detail, image_data=error_image_data
                        )
                        sent_count += 1

                    if sent_count:
                        logging.getLogger(__name__).info(
                            f"[HMS] Sent notification for {sent_count} error(s) on printer {printer_id}"
                        )

                # Also publish to MQTT relay (no DB).
                printer_info = printer_manager.get_printer(printer_id)
                if printer_info:
                    errors_data = [
                        {
                            "code": e.code,
                            "attr": e.attr,
                            "module": e.module,
                            "severity": e.severity,
                        }
                        for e in new_errors
                    ]
                    await mqtt_relay.on_printer_error(
                        printer_id, printer_info.name, printer_info.serial_number, errors_data
                    )

            except Exception as e:
                logging.getLogger(__name__).warning(f"HMS error notification failed: {e}")

    else:
        # No HMS errors — only clear tracking after a grace period to prevent
        # flapping errors (brief hms:[] gaps) from re-triggering notifications.
        # Some HMS codes (e.g. chamber temp regulation during PETG prints) toggle
        # on/off every few seconds as conditions fluctuate around thresholds.
        if printer_id in _notified_hms_errors:
            last_seen = _hms_last_seen.get(printer_id, 0)
            if time.time() - last_seen >= _HMS_CLEAR_GRACE_SECONDS:
                _notified_hms_errors.pop(printer_id, None)
                _hms_last_seen.pop(printer_id, None)

    await ws_manager.send_printer_status(
        printer_id,
        printer_state_to_dict(
            state,
            printer_id,
            printer_manager.get_model(printer_id),
            printer_manager.get_drying_targets(printer_id),
        ),
    )


async def on_print_start(printer_id: int, data: dict):
    await intake.print_started(printer_id, data)


async def on_print_running_observed(printer_id: int, data: dict):
    await intake.print_running_observed(printer_id, data)


async def on_print_state_change(printer_id: int, data: dict):
    await intake.print_state_changed(printer_id, data)


async def on_print_complete(printer_id: int, data: dict):
    return await intake.print_completed(printer_id, data)


async def on_finish_photo_moment(printer_id: int, data: dict):
    await intake.finish_photo_moment(printer_id, data)


def _is_bambu_uuid(tray_uuid: str) -> bool:
    """Check if a tray UUID looks like a valid Bambu Lab RFID UUID (non-empty, non-zero)."""
    return bool(tray_uuid) and tray_uuid not in ("", "0" * len(tray_uuid))


async def on_fts_inlet_change(printer_id: int, ams_id: int, inlet: str):
    """Re-apply a moved AMS's filament and calibration settings.

    An FTS move changes the nozzle behind every tray in the AMS. The slot's
    filament preset is model-and-nozzle aware, and its calibration index is
    nozzle-specific, but the printer does not reconfigure either one when the
    switch binding changes. Reusing the normal assignment paths keeps both
    pieces together and also resets a stale K-profile when the target nozzle
    has no stored calibration for that spool.

    A slot with no known inventory assignment is left untouched. The callback
    runs only after the MQTT parser has updated ``ams_switch_inlet``, so the
    shared assignment helpers resolve the new target nozzle.
    """
    logger = logging.getLogger(__name__)

    if extruder_for_inlet(inlet) is None:
        return

    client = printer_manager.get_client(printer_id)
    state = printer_manager.get_status(printer_id)
    if not client or not state or not state.raw_data:
        return

    ams_raw = state.raw_data.get("ams")
    ams_list = ams_raw.get("ams", []) if isinstance(ams_raw, dict) else ams_raw if isinstance(ams_raw, list) else []
    unit = next((u for u in ams_list if str(u.get("id")) == str(ams_id)), None)
    if not unit:
        return

    try:
        async with async_session() as db:
            from backend.app.services.inventory_mode import spoolman_owns_assignments

            if await spoolman_owns_assignments(db):
                from backend.app.api.routes.spoolman_inventory import (
                    SpoolSlotAssignmentRequest,
                    assign_spoolman_slot,
                )
                from backend.app.models.spoolman_slot_assignment import SpoolmanSlotAssignment

                result = await db.execute(
                    select(SpoolmanSlotAssignment).where(
                        SpoolmanSlotAssignment.printer_id == printer_id,
                        SpoolmanSlotAssignment.ams_id == ams_id,
                    )
                )
                assignments = {row.tray_id: row for row in result.scalars().all()}
                for tray in unit.get("tray", []):
                    tray_id = int(tray.get("id", -1))
                    assignment = assignments.get(tray_id)
                    if assignment is None or not tray.get("tray_type"):
                        continue
                    await assign_spoolman_slot(
                        SpoolSlotAssignmentRequest(
                            spoolman_spool_id=assignment.spoolman_spool_id,
                            printer_id=printer_id,
                            ams_id=ams_id,
                            tray_id=tray_id,
                        ),
                        db=db,
                        current_user=None,
                    )
                return

            from sqlalchemy.orm import selectinload

            from backend.app.api.routes.inventory import apply_spool_to_slot_via_mqtt
            from backend.app.models.spool import Spool
            from backend.app.models.spool_assignment import SpoolAssignment

            result = await db.execute(
                select(SpoolAssignment).where(
                    SpoolAssignment.printer_id == printer_id,
                    SpoolAssignment.ams_id == ams_id,
                )
            )
            assignments = {row.tray_id: row for row in result.scalars().all()}
            for tray in unit.get("tray", []):
                tray_id = int(tray.get("id", -1))
                assignment = assignments.get(tray_id)
                if assignment is None or not tray.get("tray_type"):
                    continue
                spool = (
                    await db.execute(
                        select(Spool).options(selectinload(Spool.k_profiles)).where(Spool.id == assignment.spool_id)
                    )
                ).scalar_one_or_none()
                if spool is None:
                    continue
                await apply_spool_to_slot_via_mqtt(
                    db=db,
                    current_user=None,
                    spool=spool,
                    printer_id=printer_id,
                    ams_id=ams_id,
                    tray_id=tray_id,
                    current_tray_info_idx=str(tray.get("tray_info_idx") or ""),
                    current_tray_type=str(tray.get("tray_type") or ""),
                )
    except Exception as e:
        logger.warning("[Printer %s] Could not re-apply slot settings after inlet move: %s", printer_id, e)


async def on_ams_change(printer_id: int, ams_data: list):
    """Handle AMS data changes - sync to Spoolman if enabled and auto mode."""
    logger = logging.getLogger(__name__)

    # Snapshot BEFORE any await: if a print is active, skip weight sync later.
    # on_print_complete may pop _active_sessions during our awaits (#880).
    from backend.app.services.usage_tracker import _active_sessions

    _print_active = printer_id in _active_sessions
    _current_state = printer_manager.get_status(printer_id)
    printing_now = (getattr(_current_state, "state", "") or "").upper() in ("RUNNING", "PAUSE")

    # MQTT relay - publish AMS change
    try:
        printer_info = printer_manager.get_printer(printer_id)
        if printer_info:
            await mqtt_relay.on_ams_change(printer_id, printer_info.name, printer_info.serial_number, ams_data)
    except Exception:
        pass  # Don't fail AMS callback if MQTT fails

    # Broadcast AMS change via WebSocket (bypasses status_key deduplication)
    # This ensures frontend gets immediate updates when AMS slots are configured
    try:
        state = printer_manager.get_status(printer_id)
        if state:
            logger.info("[Printer %s] Broadcasting AMS change via WebSocket", printer_id)
            await ws_manager.send_printer_status(
                printer_id,
                printer_state_to_dict(
                    state,
                    printer_id,
                    printer_manager.get_model(printer_id),
                    printer_manager.get_drying_targets(printer_id),
                ),
            )
    except Exception as e:
        logger.warning("Failed to broadcast AMS change for printer %s: %s", printer_id, e)

    from backend.app.utils.color_utils import colors_similar as _colors_similar

    # Auto-unlink spool assignments with stale fingerprints
    try:
        async with async_session() as db:
            from sqlalchemy.orm import selectinload

            from backend.app.api.routes.inventory import _find_tray_in_ams_data
            from backend.app.models.spool import Spool as _Spool
            from backend.app.models.spool_assignment import SpoolAssignment as SA
            from backend.app.services.inventory_mode import spoolman_owns_assignments

            # Built-in assignments only. Since #2812 they survive a switch to
            # Spoolman mode rather than being deleted by it, and this pass ends
            # in ``db.delete`` — left ungated it would unlink them one slot at a
            # time as the AMS contents changed under the other mode, undoing the
            # preservation more slowly but just as completely.
            assignments = []
            if not await spoolman_owns_assignments(db):
                result = await db.execute(
                    select(SA)
                    .where(SA.printer_id == printer_id)
                    .options(selectinload(SA.spool).selectinload(_Spool.k_profiles))
                )
                assignments = result.scalars().all()
            # ``printing_now`` (top of this function) keeps a runout from
            # unlinking the spool that fed the print — the next idle-time pass
            # unlinks it if the user really did take it out.
            stale = []
            for assignment in assignments:
                # External spool assignments (ams_id=255) live in vt_tray, not AMS data
                if assignment.ams_id == 255:
                    ps = printer_manager.get_status(printer_id)
                    vt_tray_raw = ps.raw_data.get("vt_tray", []) if ps else []
                    ext_id = assignment.tray_id + 254  # 0→254, 1→255
                    current_tray = None
                    for vt in vt_tray_raw:
                        if isinstance(vt, dict) and int(vt.get("id", 254)) == ext_id:
                            current_tray = vt
                            break
                    if not current_tray:
                        # vt_tray data may not have arrived yet — keep assignment
                        continue
                else:
                    current_tray = _find_tray_in_ams_data(ams_data, assignment.ams_id, assignment.tray_id)
                if not current_tray:
                    if printing_now:
                        logger.info(
                            "Auto-unlink skipped: spool %d AMS%d-T%d — slot empty during a running print (runout?)",
                            assignment.spool_id,
                            assignment.ams_id,
                            assignment.tray_id,
                        )
                        continue
                    logger.info(
                        "Auto-unlink: spool %d AMS%d-T%d — tray not found in AMS data (slot empty?)",
                        assignment.spool_id,
                        assignment.ams_id,
                        assignment.tray_id,
                    )
                    stale.append(assignment)  # Slot empty
                elif _is_bambu_uuid(current_tray.get("tray_uuid", "")):
                    # A Bambu Lab spool is in this slot — check if it's the same spool
                    # that's currently assigned. If yes, keep the assignment (avoids
                    # unnecessary unlink/re-assign/ams_filament_setting cycle that clears
                    # the printer's filament preset on every startup).
                    tray_uuid = current_tray.get("tray_uuid", "")
                    tag_uid = current_tray.get("tag_uid", "")
                    spool = assignment.spool
                    spool_matches = False
                    if spool:
                        if (spool.tray_uuid and spool.tray_uuid.upper() == tray_uuid.upper()) or (
                            spool.tag_uid
                            and tag_uid
                            and tag_uid != "0000000000000000"
                            and spool.tag_uid.upper() == tag_uid.upper()
                        ):
                            spool_matches = True
                    if spool_matches:
                        # Same BL spool still in slot — keep assignment, update fingerprint if needed
                        cur_color = current_tray.get("tray_color", "")
                        cur_type = current_tray.get("tray_type", "")
                        fp_color = assignment.fingerprint_color or ""
                        fp_type = assignment.fingerprint_type or ""
                        if cur_color.upper() != fp_color.upper() or cur_type.upper() != fp_type.upper():
                            assignment.fingerprint_color = cur_color
                            assignment.fingerprint_type = cur_type
                            logger.debug(
                                "Auto-unlink: spool %d AMS%d-T%d — same BL spool, updated fingerprint",
                                assignment.spool_id,
                                assignment.ams_id,
                                assignment.tray_id,
                            )
                        continue
                    # Different BL spool or unrecognized — unlink so auto-assign can match
                    logger.info(
                        "Auto-unlink: spool %d AMS%d-T%d — different Bambu Lab spool detected (uuid=%s)",
                        assignment.spool_id,
                        assignment.ams_id,
                        assignment.tray_id,
                        tray_uuid,
                    )
                    stale.append(assignment)
                else:
                    cur_color = current_tray.get("tray_color", "")
                    cur_type = current_tray.get("tray_type", "")
                    cur_state = current_tray.get("state")
                    fp_color = assignment.fingerprint_color or ""
                    fp_type = assignment.fingerprint_type or ""

                    # Pre-config replay: fingerprint_type empty means the slot
                    # was empty when the user pre-assigned the spool
                    # (the firmware drops ams_filament_setting on empty slots, so
                    # MQTT was deferred). The moment any filament gets inserted
                    # — Bambu RFID, 3rd-party, or even an existing-but-now-
                    # reconfigured spool — fire the deferred configuration.
                    # The "loaded" signal is state == 11 (Bambu's "filament fed to
                    # extruder" code) OR, on firmwares that don't use the state
                    # enum meaningfully, a non-empty tray_type when state is
                    # NOT one of the firmware's explicit empty signals (9, 10).
                    # state-only was wrong for firmwares that never set 11 — A1
                    # Mini BMCU 01.07.02.00 and P1S Standard AMS 00.00.06.75 both
                    # always report state=3 — so the replay never fired for them
                    # (#1322). The state ∉ {9,10} guard keeps the firmware's
                    # explicit "empty" signals authoritative over any stale
                    # tray_type that might survive the relay's auto-clearing.
                    loaded = cur_state == 11 or (cur_state not in (9, 10) and cur_type.strip())
                    if not fp_type.strip() and loaded and assignment.spool:
                        try:
                            from backend.app.api.routes.inventory import (
                                apply_spool_to_slot_via_mqtt,
                            )

                            await apply_spool_to_slot_via_mqtt(
                                db=db,
                                current_user=None,
                                spool=assignment.spool,
                                printer_id=printer_id,
                                ams_id=assignment.ams_id,
                                tray_id=assignment.tray_id,
                                current_tray_info_idx=current_tray.get("tray_info_idx", ""),
                                current_tray_type=cur_type,
                            )
                            logger.info(
                                "Pre-config applied on insert: spool %d → printer %d AMS%d-T%d",
                                assignment.spool_id,
                                printer_id,
                                assignment.ams_id,
                                assignment.tray_id,
                            )
                        except Exception:
                            logger.exception(
                                "Pre-config apply failed for spool %d on printer %d AMS%d-T%d",
                                assignment.spool_id,
                                printer_id,
                                assignment.ams_id,
                                assignment.tray_id,
                            )
                        assignment.fingerprint_color = cur_color
                        assignment.fingerprint_type = cur_type
                        continue

                    if not _colors_similar(cur_color, fp_color) or cur_type.upper() != fp_type.upper():
                        # Firmware clears colour and type when it unloads a
                        # spool it just consumed. During a print that is a
                        # runout, not evidence that the assignment is stale.
                        if printing_now and not cur_color.strip() and not cur_type.strip():
                            logger.info(
                                "Auto-unlink skipped: spool %d AMS%d-T%d — tray data cleared during a running print "
                                "(runout?)",
                                assignment.spool_id,
                                assignment.ams_id,
                                assignment.tray_id,
                            )
                            continue
                        # Fingerprint mismatch — but check if tray now matches the
                        # assigned spool (e.g. auto-configure changed the tray).
                        spool = assignment.spool
                        if spool:
                            spool_color = (spool.rgba or "FFFFFFFF").upper()
                            spool_type = (spool.material or "").upper()
                            if _colors_similar(cur_color, spool_color) and cur_type.upper() == spool_type:
                                logger.info(
                                    "Auto-unlink: spool %d AMS%d-T%d — fingerprint mismatch but tray matches spool, updating fp",
                                    assignment.spool_id,
                                    assignment.ams_id,
                                    assignment.tray_id,
                                )
                                assignment.fingerprint_color = cur_color
                                assignment.fingerprint_type = cur_type
                                continue
                        logger.info(
                            "Auto-unlink: spool %d AMS%d-T%d — fingerprint mismatch (cur=%s/%s fp=%s/%s spool=%s/%s)",
                            assignment.spool_id,
                            assignment.ams_id,
                            assignment.tray_id,
                            cur_color,
                            cur_type,
                            fp_color,
                            fp_type,
                            spool.rgba if spool else "?",
                            spool.material if spool else "?",
                        )
                        stale.append(assignment)  # Spool changed
            unlinked_slots = [(a.ams_id, a.tray_id) for a in stale]
            for a in stale:
                await db.delete(a)
            if stale:
                logger.info("Auto-unlinked %d stale spool assignments for printer %d", len(stale), printer_id)
            # Commit any changes (stale deletions and/or fingerprint updates)
            await db.commit()
            for ams_id, tray_id in unlinked_slots:
                await ws_manager.broadcast(
                    {
                        "type": "spool_assignment_changed",
                        "printer_id": printer_id,
                        "ams_id": ams_id,
                        "tray_id": tray_id,
                    }
                )
    except Exception as e:
        logger.warning("Spool assignment cleanup failed: %s", e, exc_info=True)

    # Auto-manage inventory spools from AMS tray data (skip if Spoolman manages AMS).
    # Serialised per-printer via _ams_assignment_locks: MQTT bursts can deliver
    # two AMS pushes ~30 ms apart, and without the lock both callbacks read
    # "no existing assignment" for the same (printer, ams, tray) and race to
    # INSERT, hitting the spool_assignment_printer_id_ams_id_tray_id_key
    # unique constraint on Postgres. SQLite's WAL serialises writes so the
    # bug stayed latent there. See _ams_assignment_locks comment for details.
    try:
        async with _get_ams_assignment_lock(printer_id), async_session() as db:
            from backend.app.api.routes.settings import get_setting
            from backend.app.models.spool import Spool
            from backend.app.models.spool_assignment import SpoolAssignment as SA
            from backend.app.services.spool_tag_matcher import (
                auto_assign_spool,
                create_spool_from_tray,
                find_matching_untagged_spool,
                get_spool_by_tag,
                is_bambu_tag,
                is_valid_tag,
                link_tag_to_inventory_spool,
            )

            _spoolman_on = await get_setting(db, "spoolman_enabled")
            _auto_add_raw = await get_setting(db, "auto_add_unknown_rfid")
            _auto_add_unknown = _auto_add_raw is None or _auto_add_raw.lower() == "true"
            if not _spoolman_on or _spoolman_on.lower() != "true":
                for ams_unit in ams_data:
                    if not isinstance(ams_unit, dict):
                        continue
                    ams_id = int(ams_unit.get("id", 0))
                    for tray in ams_unit.get("tray", []):
                        if not isinstance(tray, dict):
                            continue
                        tray_id = int(tray.get("id", 0))
                        tag_uid = tray.get("tag_uid", "")
                        tray_uuid = tray.get("tray_uuid", "")
                        tray_info_idx = tray.get("tray_info_idx", "")
                        if not tray.get("tray_type"):
                            # Slot reported empty — drop any cached unknown-tag
                            # broadcast so reinserting the same spool re-prompts.
                            _clear_unknown_tag_dedup(printer_id, ams_id, tray_id)
                            continue  # Empty slot
                        # Check if assignment already exists for this slot
                        existing = await db.execute(
                            select(SA)
                            .options(selectinload(SA.spool).selectinload(Spool.k_profiles))
                            .where(SA.printer_id == printer_id, SA.ams_id == ams_id, SA.tray_id == tray_id)
                        )
                        existing_assignment = existing.scalar_one_or_none()
                        if existing_assignment:
                            # Sync spool weight_used from AMS remain — only INCREASE, never decrease.
                            # The AMS remain% is low-resolution (integer %, i.e. 10g steps for 1kg spool)
                            # and must not overwrite precise values from the usage tracker (3MF/G-code).
                            # Skip during active prints: the usage tracker handles deduction
                            # precisely via 3MF data on print completion. Without this guard the
                            # AMS remain% SET and the usage tracker ADD both fire from the same
                            # MQTT message, doubling the deduction (#880).
                            if _print_active:
                                continue
                            remain_raw = tray.get("remain")
                            if (
                                remain_raw is not None
                                and existing_assignment.spool
                                and not existing_assignment.spool.weight_locked
                            ):
                                try:
                                    remain_val = int(remain_raw)
                                except (TypeError, ValueError):
                                    remain_val = -1
                                if 1 <= remain_val <= 100:
                                    lw = existing_assignment.spool.label_weight or 1000
                                    new_used = round(lw * (100 - remain_val) / 100.0, 1)
                                    current_used = existing_assignment.spool.weight_used or 0
                                    if new_used > current_used + 1:
                                        logger.info(
                                            "Weight sync: spool %d weight_used %s -> %s (remain=%d)",
                                            existing_assignment.spool_id,
                                            current_used,
                                            new_used,
                                            remain_val,
                                        )
                                        existing_assignment.spool.weight_used = new_used
                                        await db.commit()

                            # Re-apply stored K-profile when the live tray's
                            # cali_idx drifted from the spool's stored profile.
                            # This catches "reset slot → re-read" and any other
                            # path where the firmware loses the user's K-profile
                            # selection while the SpoolAssignment row persists.
                            # Per the maintainer's rule: any time a spool tag is
                            # identified and matches inventory, the slot must be
                            # configured with the spool's stored settings. Without
                            # this block the existing-assignment branch only ran
                            # weight-sync and let the firmware-default cali_idx win.
                            try:
                                spool = existing_assignment.spool
                                if (
                                    spool is not None
                                    and is_bambu_tag(tag_uid, tray_uuid, tray_info_idx)
                                    and spool.k_profiles
                                ):
                                    state = printer_manager.get_status(printer_id)
                                    slot_nozzle = resolve_slot_nozzle(
                                        state, ams_id, tray_id, printer_manager.get_model(printer_id)
                                    )
                                    nozzle_diameter = slot_nozzle.diameter
                                    slot_extruder = slot_nozzle.extruder
                                    # Prefer exact extruder match, fall back to
                                    # extruder-agnostic kp for the same printer +
                                    # nozzle. Avoids hard-skipping when the AMS is
                                    # mapped differently than at calibration time.
                                    matching_kp = None
                                    fallback_kp = None
                                    for kp in spool.k_profiles:
                                        if (
                                            kp.printer_id != printer_id
                                            or kp.nozzle_diameter != nozzle_diameter
                                            or kp.cali_idx is None
                                            or not slot_nozzle.flow_matches(kp.nozzle_type)
                                        ):
                                            continue
                                        if (
                                            slot_extruder is not None
                                            and kp.extruder is not None
                                            and kp.extruder == slot_extruder
                                        ):
                                            matching_kp = kp
                                            break
                                        if fallback_kp is None:
                                            fallback_kp = kp
                                    chosen_kp = matching_kp or fallback_kp
                                    if chosen_kp is not None:
                                        live_cali_idx = tray.get("cali_idx")
                                        # Only fire MQTT when the printer's live
                                        # cali_idx differs from the stored value.
                                        # Avoids spamming the broker on every
                                        # MQTT push during steady-state operation.
                                        if live_cali_idx != chosen_kp.cali_idx:
                                            client = printer_manager.get_client(printer_id)
                                            if client:
                                                cali_filament_id = spool.slicer_filament or tray_info_idx or ""
                                                client.extrusion_cali_sel(
                                                    ams_id=ams_id,
                                                    tray_id=tray_id,
                                                    cali_idx=chosen_kp.cali_idx,
                                                    filament_id=cali_filament_id,
                                                    nozzle_diameter=nozzle_diameter,
                                                )
                                                logger.info(
                                                    "Re-applied K-profile cali_idx=%d for spool %d "
                                                    "on printer %d AMS%d-T%d (live=%s drift detected)",
                                                    chosen_kp.cali_idx,
                                                    spool.id,
                                                    printer_id,
                                                    ams_id,
                                                    tray_id,
                                                    live_cali_idx,
                                                )
                            except Exception:
                                logger.exception(
                                    "K-profile re-apply failed for printer %d AMS%d-T%d",
                                    printer_id,
                                    ams_id,
                                    tray_id,
                                )
                            continue

                        if is_bambu_tag(tag_uid, tray_uuid, tray_info_idx):
                            # BL spool with RFID tag: auto-match → inventory match → auto-create
                            spool = await get_spool_by_tag(db, tag_uid, tray_uuid)
                            if not spool:
                                # Try matching an untagged inventory spool (same material/color)
                                spool = await find_matching_untagged_spool(db, tray)
                                if spool:
                                    await link_tag_to_inventory_spool(db, spool, tray)
                                elif _auto_add_unknown:
                                    spool = await create_spool_from_tray(db, tray)
                                else:
                                    # Auto-add disabled: surface the slot so the
                                    # user can add it manually via the UI.
                                    await _broadcast_unknown_tag(
                                        printer_id=printer_id,
                                        ams_id=ams_id,
                                        tray_id=tray_id,
                                        tag_uid=tag_uid,
                                        tray_uuid=tray_uuid,
                                        tray_type=tray.get("tray_type"),
                                        tray_color=tray.get("tray_color"),
                                        tray_sub_brands=tray.get("tray_sub_brands"),
                                        tray_count=len(ams_unit.get("tray", [])),
                                    )
                                    continue
                            # Slot matched (existing tag, untagged inventory
                            # match, or freshly auto-created spool) — drop any
                            # stale dedup so a future tag swap re-prompts.
                            _clear_unknown_tag_dedup(printer_id, ams_id, tray_id)
                            await auto_assign_spool(
                                printer_id,
                                ams_id,
                                tray_id,
                                spool,
                                printer_manager,
                                db,
                                tray_info_idx=tray_info_idx,
                            )
                            await db.commit()
                            await ws_manager.broadcast(
                                {
                                    "type": "spool_auto_assigned",
                                    "printer_id": printer_id,
                                    "ams_id": ams_id,
                                    "tray_id": tray_id,
                                    "spool_id": spool.id,
                                }
                            )
                            logger.info(
                                "RFID auto-assigned spool %d to printer %d AMS%d-T%d",
                                spool.id,
                                printer_id,
                                ams_id,
                                tray_id,
                            )
                        elif is_valid_tag(tag_uid, tray_uuid):
                            # Non-BL spool with some tag — let user choose
                            await _broadcast_unknown_tag(
                                printer_id=printer_id,
                                ams_id=ams_id,
                                tray_id=tray_id,
                                tag_uid=tag_uid,
                                tray_uuid=tray_uuid,
                                tray_type=tray.get("tray_type"),
                                tray_color=tray.get("tray_color"),
                                tray_sub_brands=tray.get("tray_sub_brands"),
                                tray_count=len(ams_unit.get("tray", [])),
                            )
                        # No-tag slots (generic non-RFID filament) are left alone:
                        # nothing to identify, prompting "+ Add" would just create
                        # ghost spools with empty tags on every confirm.
    except Exception as e:
        logger.warning("RFID spool auto-assign failed: %s", e, exc_info=True)

    try:
        async with async_session() as db:
            from backend.app.api.routes.settings import get_setting
            from backend.app.models.printer import Printer

            # Check if Spoolman is enabled
            spoolman_enabled = await get_setting(db, "spoolman_enabled")
            if not spoolman_enabled or spoolman_enabled.lower() != "true":
                return

            # Check sync mode
            sync_mode = await get_setting(db, "spoolman_sync_mode")
            if sync_mode and sync_mode != "auto":
                return  # Only sync on auto mode

            _auto_add_raw_sm = await get_setting(db, "auto_add_unknown_rfid")
            auto_add_unknown_rfid = _auto_add_raw_sm is None or _auto_add_raw_sm.lower() == "true"

            # `spoolman_disable_weight_sync` is deprecated (#1119) — weight is now
            # always owned by per-print tracking, never by AMS auto-sync. The
            # setting is still read by the settings UI for backwards compat but
            # has no effect on the sync path here.

            # Get Spoolman URL
            spoolman_url = await get_setting(db, "spoolman_url")
            if not spoolman_url:
                return

            # Get or create Spoolman client
            client = await get_spoolman_client()
            if not client:
                try:
                    client = await init_spoolman_client(spoolman_url)
                except ValueError as exc:
                    logger.warning("Spoolman URL %r rejected by SSRF guard: %s", spoolman_url, exc)
                    return

            # Check if Spoolman is reachable
            if not await client.health_check():
                logger.warning("Spoolman not reachable at %s", spoolman_url)
                return

            # Get printer name for location
            result = await db.execute(select(Printer).where(Printer.id == printer_id))
            printer = result.scalar_one_or_none()
            printer_name = printer.name if printer else f"Printer {printer_id}"

            # OPTIMIZATION: Fetch all spools once before processing trays
            # This eliminates redundant API calls (one per tray) when syncing multiple trays
            logger.debug("[Printer %s] Fetching spools cache for AMS sync...", printer_id)
            try:
                cached_spools = await client.get_spools()
                logger.debug("[Printer %s] Cached %d spools for batch sync", printer_id, len(cached_spools))
            except Exception as e:
                logger.error(
                    "[Printer %s] Failed to fetch spools cache after retries, aborting AMS sync: %s",
                    printer_id,
                    e,
                )
                return

            # Load inventory weights as fallback (when AMS MQTT data lacks remain values)
            from sqlalchemy.orm import selectinload

            from backend.app.models.spool_assignment import SpoolAssignment
            from backend.app.models.spoolman_slot_assignment import SpoolmanSlotAssignment
            from backend.app.services.inventory_mode import spoolman_owns_assignments

            # Built-in remaining weight, used by sync_ams_tray only when the
            # firmware reports an unusable remain%/tray_weight for a slot.
            #
            # Left empty since #2812. This block runs in Spoolman mode only,
            # and until then the built-in table was emptied on the switch, so
            # there was never anything here to read and the fallback was inert.
            # Preserving those rows makes it live again, and it is keyed by slot
            # rather than by spool: after a mode switch the tray may well hold
            # different filament, and ``create_spool`` writes ``remaining_weight``
            # unconditionally, so a stale figure would be seeded into a brand new
            # Spoolman spool. Deliberately kept inert rather than deleted, so the
            # intent survives for whoever revisits the cross-mode fallback.
            inventory_weights: dict[tuple[int, int], float] = {}
            if not await spoolman_owns_assignments(db):
                try:
                    assign_result = await db.execute(
                        select(SpoolAssignment)
                        .options(selectinload(SpoolAssignment.spool))
                        .where(SpoolAssignment.printer_id == printer_id)
                    )
                    for assignment in assign_result.scalars().all():
                        spool = assignment.spool
                        if spool and spool.label_weight > 0:
                            remaining = max(0.0, spool.label_weight - (spool.weight_used or 0))
                            inventory_weights[(assignment.ams_id, assignment.tray_id)] = remaining
                except Exception as e:
                    logger.warning("Could not load inventory weights for printer %s: %s", printer_id, e)

            # Load existing Spoolman slot assignments for the no-RFID fallback path
            spoolman_slot_map: dict[tuple[int, int], int] = {}
            try:
                slot_result = await db.execute(
                    select(SpoolmanSlotAssignment).where(SpoolmanSlotAssignment.printer_id == printer_id)
                )
                for slot in slot_result.scalars().all():
                    spoolman_slot_map[(slot.ams_id, slot.tray_id)] = slot.spoolman_spool_id
            except Exception as e:
                logger.warning("Could not load Spoolman slot assignments for printer %s: %s", printer_id, e)

            # Sync each AMS tray and collect slot changes for DB persistence
            synced = 0
            slot_changes: list[tuple[int, int, int]] = []  # (ams_id, tray_id, spoolman_spool_id) to upsert
            empty_slots: list[tuple[int, int]] = []  # (ams_id, tray_id) whose tray is now empty
            for ams_unit in ams_data:
                if not isinstance(ams_unit, dict):
                    continue
                ams_id = int(ams_unit.get("id", 0))
                trays = ams_unit.get("tray", [])

                for tray_data in trays:
                    if not isinstance(tray_data, dict):
                        continue
                    tray_id_raw = int(tray_data.get("id", 0))
                    tray = client.parse_ams_tray(ams_id, tray_data)
                    if not tray:
                        # Empty tray slot — record for local assignment cleanup
                        # and drop any cached unknown-tag broadcast so a
                        # reinserted spool re-prompts.
                        if not printing_now:
                            empty_slots.append((ams_id, tray_id_raw))
                        _clear_unknown_tag_dedup(printer_id, ams_id, tray_id_raw)
                        continue

                    spool_tag = (
                        tray.tray_uuid
                        if tray.tray_uuid and tray.tray_uuid != "00000000000000000000000000000000"
                        else tray.tag_uid
                    )

                    # Provide the hint only when no RFID is available
                    hint = spoolman_slot_map.get((ams_id, tray.tray_id)) if not spool_tag else None

                    try:
                        inv_remaining = inventory_weights.get((ams_id, tray.tray_id))
                        result = await client.sync_ams_tray(
                            tray,
                            printer_name,
                            # Per-print tracking is the only weight writer (#1119).
                            # AMS auto-sync still maintains spool metadata / slot
                            # assignments but no longer touches remaining_weight.
                            disable_weight_sync=True,
                            cached_spools=cached_spools,
                            inventory_remaining=inv_remaining,
                            spoolman_spool_id_hint=hint,
                            auto_add_unknown_rfid=auto_add_unknown_rfid,
                        )
                        if result is None and spool_tag and not auto_add_unknown_rfid:
                            # Spoolman skipped auto-create per user setting — surface
                            # the slot so the UI can offer "+ Add to inventory".
                            await _broadcast_unknown_tag(
                                printer_id=printer_id,
                                ams_id=ams_id,
                                tray_id=tray.tray_id,
                                tag_uid=tray.tag_uid or "",
                                tray_uuid=tray.tray_uuid or "",
                                tray_type=tray.tray_type,
                                tray_color=tray.tray_color,
                                tray_sub_brands=tray.tray_sub_brands,
                                tray_count=len(trays),
                            )
                        elif result:
                            _clear_unknown_tag_dedup(printer_id, ams_id, tray.tray_id)
                        if result:
                            synced += 1
                            if result.get("id"):
                                slot_changes.append((ams_id, tray.tray_id, result["id"]))
                                # If a new spool was created, add it to the cache
                                # so subsequent trays can find it if they reference the same tag
                                spool_exists = any(s.get("id") == result["id"] for s in cached_spools)
                                if not spool_exists:
                                    cached_spools.append(result)
                                    logger.debug(
                                        "[Printer %s] Added newly created spool %s to cache",
                                        printer_id,
                                        result["id"],
                                    )
                                # Reconcile slot_preset_mappings (the same row internal
                                # mode keeps in sync via inventory + spool_tag_matcher).
                                # Without this the slot card surfaces the previous spool's
                                # preset name — same bug shape, different inventory mode.
                                from backend.app.services.slot_preset_writer import (
                                    upsert_slot_preset_for_spoolman_spool,
                                )

                                await upsert_slot_preset_for_spoolman_spool(
                                    db=db,
                                    spoolman_spool=result,
                                    tray_info_idx=tray.tray_info_idx or "",
                                    tray_sub_brands=tray.tray_sub_brands or "",
                                    tray_type=tray.tray_type or "",
                                    printer_id=printer_id,
                                    ams_id=ams_id,
                                    tray_id=tray.tray_id,
                                )
                    except Exception as e:
                        logger.error("Error syncing AMS %s tray %s: %s", ams_id, tray.tray_id, e)

            if synced > 0:
                logger.info("Auto-synced %s AMS trays to Spoolman for printer %s", synced, printer_id)

            # Persist slot assignment changes to the local table
            if slot_changes or empty_slots:
                try:
                    for ams_id, tray_id, spool_id in slot_changes:
                        await db.execute(
                            text(
                                "INSERT INTO spoolman_slot_assignments"
                                " (printer_id, ams_id, tray_id, spoolman_spool_id)"
                                " VALUES (:printer_id, :ams_id, :tray_id, :spool_id)"
                                " ON CONFLICT(printer_id, ams_id, tray_id)"
                                " DO UPDATE SET spoolman_spool_id = excluded.spoolman_spool_id"
                            ),
                            {
                                "printer_id": printer_id,
                                "ams_id": ams_id,
                                "tray_id": tray_id,
                                "spool_id": spool_id,
                            },
                        )
                    for ams_id, tray_id in empty_slots:
                        await db.execute(
                            delete(SpoolmanSlotAssignment).where(
                                SpoolmanSlotAssignment.printer_id == printer_id,
                                SpoolmanSlotAssignment.ams_id == ams_id,
                                SpoolmanSlotAssignment.tray_id == tray_id,
                            )
                        )
                    await db.commit()
                except Exception as e:
                    await db.rollback()
                    logger.error("Error persisting Spoolman slot assignments for printer %s: %s", printer_id, e)

    except Exception as e:
        logging.getLogger(__name__).error("Spoolman AMS sync failed for printer %s: %s", printer_id, e)


# AMS sensor history recording
_ams_history_task: asyncio.Task | None = None
AMS_HISTORY_INTERVAL = 300  # Record every 5 minutes
AMS_HISTORY_RETENTION_DAYS = 30  # Keep data for 30 days
_ams_cleanup_counter = 0  # Track recordings to trigger periodic cleanup
# Track alarm cooldowns (printer_id:ams_id:type -> last_alarm_time)
_ams_alarm_cooldown: dict[str, datetime] = {}
AMS_ALARM_COOLDOWN_MINUTES = 60  # Don't send same alarm more than once per hour


def _ams_has_filament(ams_data: dict) -> bool:
    """True if this AMS unit has at least one tray slot holding filament.

    Bambu firmware reports loaded slots via `tray_exist_bits`, a per-AMS hex
    bitmap (one bit per tray slot — bit set = spool present). Empty AMS units
    still report sensor readings, but those readings are ambient and not
    actionable: no filament to dry, no humidity to push down. #1619 — gate
    humidity/temperature alarms on this check so empty units don't generate
    hourly noise. Sensor history still records regardless so the UI charts
    stay continuous.

    Fallback path inspects the `tray` array's `tray_type` fields for setups
    where `tray_exist_bits` is missing (some early-connection pushall shapes).
    """
    bits = ams_data.get("tray_exist_bits")
    if isinstance(bits, str) and bits.strip():
        try:
            return int(bits, 16) > 0
        except ValueError:
            pass
    trays = ams_data.get("tray")
    if isinstance(trays, list):
        return any(
            isinstance(t, dict) and isinstance(t.get("tray_type"), str) and t["tray_type"].strip() for t in trays
        )
    return False


async def record_ams_history():
    """Background task to record AMS humidity and temperature data."""
    logger = logging.getLogger(__name__)

    # Wait a short time for MQTT connections to establish on startup
    await asyncio.sleep(10)

    while True:
        try:
            from backend.app.models.ams_history import AMSSensorHistory
            from backend.app.models.printer import Printer
            from backend.app.models.settings import Settings

            async with async_session() as db:
                # Get all active printers
                result = await db.execute(select(Printer).where(Printer.is_active.is_(True)))
                printers = result.scalars().all()

                # Get alarm thresholds from settings
                humidity_threshold = 60.0  # Default: fair threshold
                temp_threshold = 35.0  # Default: fair threshold
                result = await db.execute(select(Settings).where(Settings.key == "ams_humidity_fair"))
                setting = result.scalar_one_or_none()
                if setting:
                    try:
                        humidity_threshold = float(setting.value)
                    except (ValueError, TypeError):
                        pass  # Keep default threshold if stored value is invalid
                result = await db.execute(select(Settings).where(Settings.key == "ams_temp_fair"))
                setting = result.scalar_one_or_none()
                if setting:
                    try:
                        temp_threshold = float(setting.value)
                    except (ValueError, TypeError):
                        pass  # Keep default threshold if stored value is invalid

                # Per-filament humidity threshold overrides (#1605) — resolved
                # per-AMS below from the loaded tray types. Reuses the same
                # resolver as the auto-drying scheduler so behavior stays in
                # lockstep across both consumers.
                from backend.app.services.ams_drying import AmsDrying

                per_type_humidity_thresholds: dict[str, int] = {}
                result = await db.execute(select(Settings).where(Settings.key == "ams_humidity_thresholds"))
                setting = result.scalar_one_or_none()
                if setting and setting.value:
                    try:
                        raw = json.loads(setting.value)
                        if isinstance(raw, dict):
                            for k, v in raw.items():
                                try:
                                    per_type_humidity_thresholds[str(k).upper() if k != "default" else "default"] = int(
                                        v
                                    )
                                except (TypeError, ValueError):
                                    continue
                    except (ValueError, TypeError):
                        pass  # Invalid JSON → no overrides, fall through to global threshold

                recorded_count = 0
                for printer in printers:
                    # Get current state from printer manager
                    state = printer_manager.get_status(printer.id)
                    if not state or not state.connected or not state.raw_data:
                        continue  # Skip disconnected printers - don't use stale data

                    raw_data = state.raw_data
                    if "ams" not in raw_data or not isinstance(raw_data["ams"], list):
                        continue

                    # Record data for each AMS unit
                    for ams_data in raw_data["ams"]:
                        ams_id = int(ams_data.get("id", 0))

                        # Get humidity (prefer humidity_raw)
                        humidity_raw = ams_data.get("humidity_raw")
                        humidity_idx = ams_data.get("humidity")
                        humidity = None
                        if humidity_raw is not None:
                            try:
                                humidity = float(humidity_raw)
                            except (ValueError, TypeError):
                                pass  # Skip unparseable humidity; will try fallback
                        if humidity is None and humidity_idx is not None:
                            try:
                                humidity = float(humidity_idx)
                            except (ValueError, TypeError):
                                pass  # Skip unparseable humidity index value

                        # Get temperature
                        temperature = None
                        temp_str = ams_data.get("temp")
                        if temp_str is not None:
                            try:
                                temperature = float(temp_str)
                            except (ValueError, TypeError):
                                pass  # Skip unparseable temperature value

                        # Skip if no data
                        if humidity is None and temperature is None:
                            continue

                        # Record the data point
                        history = AMSSensorHistory(
                            printer_id=printer.id,
                            ams_id=ams_id,
                            humidity=humidity,
                            humidity_raw=float(humidity_raw) if humidity_raw else None,
                            temperature=temperature,
                        )
                        db.add(history)
                        recorded_count += 1

                        # Generate AMS label and determine if it's AMS-HT (A, B, C, D or HT-A for AMS-Lite/Hub)
                        is_ams_ht = ams_id >= 128
                        if is_ams_ht:
                            ams_label = f"HT-{chr(65 + (ams_id - 128))}"
                        else:
                            ams_label = f"AMS-{chr(65 + ams_id)}"

                        # Skip alarm dispatch for empty AMS units — humidity /
                        # temperature readings are ambient with no filament to
                        # protect, and the hourly notification just becomes
                        # noise. Sensor history was already recorded above so
                        # the UI charts stay continuous (#1619). Per-AMS check
                        # so a multi-AMS setup with one loaded + one empty
                        # still alarms on the loaded unit.
                        if not _ams_has_filament(ams_data):
                            continue

                        # Resolve per-filament humidity threshold for this AMS
                        # unit (#1605). Falls back to the global ams_humidity_fair
                        # when no per-type overrides are configured.
                        trays = ams_data.get("tray", []) or []
                        effective_humidity_threshold = float(
                            AmsDrying.resolve_humidity_threshold(
                                trays, per_type_humidity_thresholds, int(humidity_threshold)
                            )
                        )

                        # Check humidity alarm (only if above threshold)
                        if humidity is not None and humidity > effective_humidity_threshold:
                            cooldown_key = f"{printer.id}:{ams_id}:humidity"
                            last_alarm = _ams_alarm_cooldown.get(cooldown_key)
                            now = datetime.now(timezone.utc)
                            if (
                                last_alarm is None
                                or (now - last_alarm).total_seconds() >= AMS_ALARM_COOLDOWN_MINUTES * 60
                            ):
                                _ams_alarm_cooldown[cooldown_key] = now
                                logger.info(
                                    f"Sending humidity alarm for {printer.name} {ams_label}: {humidity}% > {effective_humidity_threshold}%"
                                )
                                try:
                                    # Call different notification method based on AMS type
                                    if is_ams_ht:
                                        await notification_service.on_ams_ht_humidity_high(
                                            printer.id,
                                            printer.name,
                                            ams_label,
                                            humidity,
                                            effective_humidity_threshold,
                                            db,
                                        )
                                    else:
                                        await notification_service.on_ams_humidity_high(
                                            printer.id,
                                            printer.name,
                                            ams_label,
                                            humidity,
                                            effective_humidity_threshold,
                                            db,
                                        )
                                except Exception as e:
                                    logger.warning("Failed to send humidity alarm: %s", e)

                        # Check temperature alarm (only if above threshold)
                        if temperature is not None and temperature > temp_threshold:
                            cooldown_key = f"{printer.id}:{ams_id}:temperature"
                            last_alarm = _ams_alarm_cooldown.get(cooldown_key)
                            now = datetime.now(timezone.utc)
                            if (
                                last_alarm is None
                                or (now - last_alarm).total_seconds() >= AMS_ALARM_COOLDOWN_MINUTES * 60
                            ):
                                _ams_alarm_cooldown[cooldown_key] = now
                                logger.info(
                                    f"Sending temperature alarm for {printer.name} {ams_label}: {temperature}°C > {temp_threshold}°C"
                                )
                                try:
                                    # Call different notification method based on AMS type
                                    if is_ams_ht:
                                        await notification_service.on_ams_ht_temperature_high(
                                            printer.id, printer.name, ams_label, temperature, temp_threshold, db
                                        )
                                    else:
                                        await notification_service.on_ams_temperature_high(
                                            printer.id, printer.name, ams_label, temperature, temp_threshold, db
                                        )
                                except Exception as e:
                                    logger.warning("Failed to send temperature alarm: %s", e)

                await db.commit()
                if recorded_count > 0:
                    logger.info("Recorded %s AMS sensor history entries", recorded_count)

                # Periodic cleanup of old data (every ~288 recordings = ~24 hours at 5min interval)
                global _ams_cleanup_counter
                _ams_cleanup_counter += 1
                if _ams_cleanup_counter >= 288:
                    _ams_cleanup_counter = 0
                    # Get retention days from settings
                    from backend.app.models.settings import Settings

                    result = await db.execute(select(Settings).where(Settings.key == "ams_history_retention_days"))
                    setting = result.scalar_one_or_none()
                    retention_days = int(setting.value) if setting else AMS_HISTORY_RETENTION_DAYS

                    cutoff = datetime.utcnow() - timedelta(days=retention_days)
                    result = await db.execute(delete(AMSSensorHistory).where(AMSSensorHistory.recorded_at < cutoff))
                    await db.commit()
                    if result.rowcount > 0:
                        logger.info(
                            f"Cleaned up {result.rowcount} old AMS sensor history entries (older than {retention_days} days)"
                        )

            # Wait until next recording interval
            await asyncio.sleep(AMS_HISTORY_INTERVAL)

        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.warning("AMS history recording failed: %s", e)
            await asyncio.sleep(60)  # Wait a bit before retrying


def start_ams_history_recording():
    """Start the AMS history recording background task."""
    global _ams_history_task
    if _ams_history_task is None:
        _ams_history_task = asyncio.create_task(record_ams_history())
        logging.getLogger(__name__).info("AMS history recording started")


def stop_ams_history_recording():
    """Stop the AMS history recording background task."""
    global _ams_history_task
    if _ams_history_task:
        _ams_history_task.cancel()
        _ams_history_task = None
        logging.getLogger(__name__).info("AMS history recording stopped")


# Printer sensor history recording (nozzle / bed / chamber)
_printer_sensor_history_task: asyncio.Task | None = None
PRINTER_SENSOR_HISTORY_INTERVAL = 60  # Record every minute — heaters move faster than AMS humidity
PRINTER_SENSOR_HISTORY_RETENTION_DAYS = 30
_printer_sensor_cleanup_counter = 0
# Sensor kinds tracked in state.temperatures — these are the normalised keys the
# MQTT parser writes, so we don't need to handle per-model field aliases here
# (nozzle_temper / left_nozzle_temper / right_nozzle_temper / chamber_temper
# are all collapsed by services/bambu_mqtt.py before they reach this loop).
_SENSOR_KINDS = ("nozzle", "nozzle_2", "bed", "chamber")
_SENSOR_TARGET_KEYS = {
    "nozzle": "nozzle_target",
    "nozzle_2": "nozzle_2_target",
    "bed": "bed_target",
    "chamber": "chamber_target",
}


async def record_printer_sensor_history():
    """Background task to record nozzle / bed / chamber readings.

    Pulls from `state.temperatures` (already normalised across all printer
    models by the MQTT parser) rather than re-parsing raw_data, so we get
    free coverage of dual-nozzle H2D, sensor-only X1C chamber, etc.
    """
    logger = logging.getLogger(__name__)

    await asyncio.sleep(10)

    while True:
        try:
            from backend.app.models.printer import Printer
            from backend.app.models.printer_sensor_history import PrinterSensorHistory
            from backend.app.models.settings import Settings

            async with async_session() as db:
                result = await db.execute(select(Printer).where(Printer.is_active.is_(True)))
                printers = result.scalars().all()

                recorded_count = 0
                for printer in printers:
                    state = printer_manager.get_status(printer.id)
                    if not state or not state.connected:
                        continue

                    temps = getattr(state, "temperatures", None) or {}
                    if not isinstance(temps, dict):
                        continue

                    for kind in _SENSOR_KINDS:
                        if kind not in temps:
                            continue
                        try:
                            value = float(temps[kind])
                        except (ValueError, TypeError):
                            continue

                        target_raw = temps.get(_SENSOR_TARGET_KEYS[kind])
                        target_val: float | None = None
                        if target_raw is not None:
                            try:
                                target_val = float(target_raw)
                            except (ValueError, TypeError):
                                target_val = None

                        db.add(
                            PrinterSensorHistory(
                                printer_id=printer.id,
                                sensor_kind=kind,
                                value=value,
                                target=target_val,
                            )
                        )
                        recorded_count += 1

                await db.commit()
                if recorded_count > 0:
                    logger.debug("Recorded %s printer sensor history entries", recorded_count)

                # Periodic cleanup — once every ~24h at this interval.
                global _printer_sensor_cleanup_counter
                _printer_sensor_cleanup_counter += 1
                cleanup_every = max(1, (24 * 60 * 60) // PRINTER_SENSOR_HISTORY_INTERVAL)
                if _printer_sensor_cleanup_counter >= cleanup_every:
                    _printer_sensor_cleanup_counter = 0
                    result = await db.execute(
                        select(Settings).where(Settings.key == "printer_sensor_history_retention_days")
                    )
                    setting = result.scalar_one_or_none()
                    retention_days = int(setting.value) if setting else PRINTER_SENSOR_HISTORY_RETENTION_DAYS

                    cutoff = datetime.utcnow() - timedelta(days=retention_days)
                    cleanup = await db.execute(
                        delete(PrinterSensorHistory).where(PrinterSensorHistory.recorded_at < cutoff)
                    )
                    await db.commit()
                    if cleanup.rowcount > 0:
                        logger.info(
                            "Cleaned up %s old printer sensor history entries (older than %s days)",
                            cleanup.rowcount,
                            retention_days,
                        )

            await asyncio.sleep(PRINTER_SENSOR_HISTORY_INTERVAL)

        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.warning("Printer sensor history recording failed: %s", e)
            await asyncio.sleep(60)


def start_printer_sensor_history_recording():
    global _printer_sensor_history_task
    if _printer_sensor_history_task is None:
        _printer_sensor_history_task = asyncio.create_task(record_printer_sensor_history())
        logging.getLogger(__name__).info("Printer sensor history recording started")


def stop_printer_sensor_history_recording():
    global _printer_sensor_history_task
    if _printer_sensor_history_task:
        _printer_sensor_history_task.cancel()
        _printer_sensor_history_task = None
        logging.getLogger(__name__).info("Printer sensor history recording stopped")


# Printer runtime tracking
_runtime_tracking_task: asyncio.Task | None = None
RUNTIME_TRACKING_INTERVAL = 30  # Update every 30 seconds


async def track_printer_runtime():
    """Background task to track printer active runtime (RUNNING state only).

    PAUSE is intentionally excluded — the runtime counter feeds hours-based
    maintenance intervals (rod lubrication, belt checks, nozzle cleaning)
    which track mechanical wear. Pause time has no motion and no wear, so
    counting it inflates maintenance warnings (#1521).
    """
    logger = logging.getLogger(__name__)

    # Wait for MQTT connections to establish on startup
    await asyncio.sleep(15)

    while True:
        try:
            from backend.app.models.printer import Printer

            # Fetch printer IDs in a short-lived read-only session
            async with async_session() as db:
                result = await db.execute(
                    select(Printer.id, Printer.name, Printer.runtime_seconds, Printer.last_runtime_update).where(
                        Printer.is_active.is_(True)
                    )
                )
                printer_rows = result.all()

            now = datetime.now(timezone.utc)
            updated_count = 0

            # Update each printer in its own short session to minimise write-lock
            # hold time and avoid blocking critical commits like queue status
            # updates (#897).
            for pid, pname, runtime_secs, last_update in printer_rows:
                state = printer_manager.get_status(pid)
                if not state:
                    logger.debug("[%s] Runtime tracking: no state available", pname)
                    continue
                if not state.connected:
                    logger.debug("[%s] Runtime tracking: not connected", pname)
                    continue

                needs_commit = False
                new_runtime = runtime_secs
                new_last_update = last_update

                if state.state == "RUNNING":
                    if last_update:
                        lu = last_update if last_update.tzinfo else last_update.replace(tzinfo=timezone.utc)
                        elapsed = (now - lu).total_seconds()
                        if elapsed > 0:
                            new_runtime = runtime_secs + int(elapsed)
                            updated_count += 1
                            needs_commit = True
                            logger.debug(
                                f"[{pname}] Runtime tracking: added {int(elapsed)}s, "
                                f"total={new_runtime}s ({new_runtime / 3600:.2f}h)"
                            )
                    else:
                        needs_commit = True
                        logger.debug("[%s] Runtime tracking: first active detection", pname)
                    new_last_update = now
                else:
                    if last_update is not None:
                        logger.debug(f"[{pname}] Runtime tracking: state={state.state}, clearing last_runtime_update")
                        new_last_update = None
                        needs_commit = True

                if needs_commit:
                    try:
                        async with async_session() as db:
                            result = await db.execute(select(Printer).where(Printer.id == pid))
                            printer = result.scalar_one_or_none()
                            if printer:
                                printer.runtime_seconds = new_runtime
                                printer.last_runtime_update = new_last_update
                                await db.commit()
                    except Exception as e:
                        logger.warning("[%s] Runtime tracking commit failed: %s", pname, e)

            if updated_count > 0:
                logger.debug("Updated runtime for %s printer(s)", updated_count)

        except asyncio.CancelledError:
            logger.info("Runtime tracking cancelled")
            break
        except Exception as e:
            logger.warning("Runtime tracking failed: %s", e)

        await asyncio.sleep(RUNTIME_TRACKING_INTERVAL)


def start_runtime_tracking():
    """Start the printer runtime tracking background task."""
    global _runtime_tracking_task
    if _runtime_tracking_task is None:
        _runtime_tracking_task = asyncio.create_task(track_printer_runtime())
        logging.getLogger(__name__).info("Printer runtime tracking started")


def stop_runtime_tracking():
    """Stop the printer runtime tracking background task."""
    global _runtime_tracking_task
    if _runtime_tracking_task:
        _runtime_tracking_task.cancel()
        _runtime_tracking_task = None
        logging.getLogger(__name__).info("Printer runtime tracking stopped")


# Dead-MQTT-session recovery
#
# check_staleness() covers the "connected but silent" half-broken session. It
# does nothing once ``state.connected`` is False, and paho's own auto-reconnect
# is the only thing left watching at that point. When paho stops making
# progress there is no backstop at all: the #2732 bundle has a P1S drop on a
# keep-alive timeout at 02:19 and not reconnect until 11:24 — nine hours
# offline with the UI open the whole time, recovered only when something
# happened to nudge it.
#
# This loop is that backstop. It only touches printers that had a working
# session and lost it, and only when the MQTT port still answers — a printer
# that is simply switched off is left to paho, since rebuilding a client
# against an unreachable host achieves nothing and would fill the log every
# night.
_connection_watchdog_task: asyncio.Task | None = None
CONNECTION_WATCHDOG_INTERVAL = 60
# How long a printer must have been silent before we stop trusting paho.
# Comfortably above STALE_TIMEOUT (60 s) and the max reconnect backoff (30 s),
# so a session that is recovering on its own is never interrupted.
CONNECTION_WATCHDOG_OFFLINE_GRACE = 300
# Per-printer floor between rebuild attempts.
CONNECTION_WATCHDOG_RETRY_INTERVAL = 300
_connection_watchdog_last_attempt: dict[int, float] = {}


async def _recover_dead_printer_sessions() -> int:
    """Rebuild MQTT clients that have been offline too long to still be trying.

    Returns the number of printers a rebuild was attempted for (for tests and
    for the caller's logging). Never raises: one unreachable printer must not
    stop the sweep for the rest of the farm.
    """
    logger = logging.getLogger(__name__)
    from backend.app.services.printer_diagnostic import PORT_MQTT, check_port

    now = time.monotonic()
    recovered = 0

    for printer_id, client in list(printer_manager._clients.items()):
        try:
            if client.state.connected:
                _connection_watchdog_last_attempt.pop(printer_id, None)
                continue

            # Time since the last inbound message is the age of the last known
            # good session — no extra bookkeeping needed, and it is the same
            # clock is_stale() reads. 0 means this client has never had one:
            # that is the initial-connect path, where paho retrying is the
            # correct and only behaviour, so leave it be.
            last_msg = client._last_message_time
            if not last_msg:
                continue
            offline_for = time.time() - last_msg
            if offline_for < CONNECTION_WATCHDOG_OFFLINE_GRACE:
                continue

            last_attempt = _connection_watchdog_last_attempt.get(printer_id)
            if last_attempt is not None and now - last_attempt < CONNECTION_WATCHDOG_RETRY_INTERVAL:
                continue

            if not await check_port(client.ip_address, PORT_MQTT):
                # Switched off, unplugged, or off the network. Paho's retry is
                # the right handler; say so at debug level and move on.
                logger.debug(
                    "[#2732] Printer %s offline for %.0fs and its MQTT port is not answering "
                    "— leaving the reconnect to paho",
                    printer_id,
                    offline_for,
                )
                _connection_watchdog_last_attempt[printer_id] = now
                continue

            _connection_watchdog_last_attempt[printer_id] = now
            recovered += 1
            logger.warning(
                "[#2732] Printer %s has been offline for %.0fs but answers on MQTT port %d — "
                "rebuilding the client with a fresh session (last connect error: %s)",
                printer_id,
                offline_for,
                PORT_MQTT,
                client.last_connect_error or "none recorded",
            )
            # Async context, so this takes the hard-reset path: fresh client_id,
            # paho's QoS 1 queue dropped. That matters — a project_file left
            # unacked on the dead session would otherwise replay into the new
            # one and trip 0500_4003 on the printer (#1136).
            client.force_reconnect_stale_session(f"offline for {offline_for:.0f}s, port still answering")
        except Exception as e:
            logger.warning("[#2732] Connection watchdog failed for printer %s: %s", printer_id, e)

    return recovered


async def _connection_watchdog_loop():
    logger = logging.getLogger(__name__)
    # Let the initial connects settle before judging anyone offline.
    await asyncio.sleep(CONNECTION_WATCHDOG_OFFLINE_GRACE)
    while True:
        try:
            await _recover_dead_printer_sessions()
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.warning("Connection watchdog sweep failed: %s", e)
        await asyncio.sleep(CONNECTION_WATCHDOG_INTERVAL)


def start_connection_watchdog():
    global _connection_watchdog_task
    if _connection_watchdog_task is None:
        _connection_watchdog_task = asyncio.create_task(_connection_watchdog_loop())
        logging.getLogger(__name__).info("Printer connection watchdog started")


def stop_connection_watchdog():
    global _connection_watchdog_task
    if _connection_watchdog_task:
        _connection_watchdog_task.cancel()
        _connection_watchdog_task = None
        _connection_watchdog_last_attempt.clear()
        logging.getLogger(__name__).info("Printer connection watchdog stopped")


# Camera stream orphan cleanup
_camera_cleanup_task: asyncio.Task | None = None
CAMERA_CLEANUP_INTERVAL = 60


async def _camera_cleanup_loop():
    """Periodically clean up orphaned ffmpeg processes."""
    from backend.app.api.routes.camera import cleanup_orphaned_streams

    while True:
        try:
            await cleanup_orphaned_streams()
        except asyncio.CancelledError:
            break
        except Exception as e:
            logging.getLogger(__name__).warning("Camera stream cleanup failed: %s", e)
        await asyncio.sleep(CAMERA_CLEANUP_INTERVAL)


def start_camera_cleanup():
    global _camera_cleanup_task
    if _camera_cleanup_task is None:
        _camera_cleanup_task = asyncio.create_task(_camera_cleanup_loop())
        logging.getLogger(__name__).info("Camera stream cleanup started")


def stop_camera_cleanup():
    global _camera_cleanup_task
    if _camera_cleanup_task:
        _camera_cleanup_task.cancel()
        _camera_cleanup_task = None
        logging.getLogger(__name__).info("Camera stream cleanup stopped")


# ---------------------------------------------------------------------------
# L-2: Periodic auth-token cleanup (stale TOTP + expired revoked JTIs)
# ---------------------------------------------------------------------------

_auth_cleanup_task: asyncio.Task | None = None
_AUTH_CLEANUP_INTERVAL = 3600  # seconds (hourly)


async def _run_auth_cleanup() -> None:
    """Single cleanup pass: remove stale TOTP records, expired revoked JTIs, and old rate-limit events."""
    from backend.app.core.database import async_session
    from backend.app.models.auth_ephemeral import AuthEphemeralToken, AuthRateLimitEvent
    from backend.app.models.user_totp import UserTOTP

    now = datetime.now(timezone.utc)

    # Remove unconfirmed (is_enabled=False) TOTP records older than 1 hour.
    try:
        async with async_session() as db:
            stale_cutoff = now - timedelta(hours=1)
            result = await db.execute(
                select(UserTOTP).where(
                    UserTOTP.is_enabled.is_(False),
                    UserTOTP.created_at < stale_cutoff,
                )
            )
            stale_records = result.scalars().all()
            if stale_records:
                for rec in stale_records:
                    await db.delete(rec)
                await db.commit()
                logging.info("Auth cleanup: removed %d stale unconfirmed TOTP record(s)", len(stale_records))
    except Exception as e:
        logging.warning("Auth cleanup: failed to purge stale TOTP records: %s", e)

    # Remove expired revoked-JTI entries (they are no longer needed once the
    # original token's exp has passed — the token would be rejected by JWT
    # signature verification regardless).
    try:
        async with async_session() as db:
            await db.execute(
                delete(AuthEphemeralToken).where(
                    AuthEphemeralToken.token_type == "revoked_jti",
                    AuthEphemeralToken.expires_at < now,
                )
            )
            await db.commit()
    except Exception as e:
        logging.warning("Auth cleanup: failed to purge expired revoked JTIs: %s", e)

    # L-R6-B: Purge AuthRateLimitEvent rows older than the lockout window (15 min).
    # Events outside this window can never affect rate-limit decisions — they only
    # consume DB space.  Use the same window constant as the rate limiter so the
    # two are always in sync.
    try:
        from backend.app.api.routes.mfa import LOCKOUT_WINDOW

        async with async_session() as db:
            await db.execute(
                delete(AuthRateLimitEvent).where(
                    AuthRateLimitEvent.occurred_at < now - LOCKOUT_WINDOW,
                )
            )
            await db.commit()
    except Exception as e:
        logging.warning("Auth cleanup: failed to purge stale rate-limit events: %s", e)


async def _auth_cleanup_loop() -> None:
    """Periodic background task: run auth cleanup every hour."""
    while True:
        try:
            await _run_auth_cleanup()
        except asyncio.CancelledError:
            break
        except Exception as e:
            logging.warning("Auth cleanup loop error: %s", e)
        await asyncio.sleep(_AUTH_CLEANUP_INTERVAL)


def start_auth_cleanup() -> None:
    global _auth_cleanup_task
    if _auth_cleanup_task is None:
        _auth_cleanup_task = asyncio.create_task(_auth_cleanup_loop())
        logging.getLogger(__name__).info("Auth periodic cleanup started")


def stop_auth_cleanup() -> None:
    global _auth_cleanup_task
    if _auth_cleanup_task:
        _auth_cleanup_task.cancel()
        _auth_cleanup_task = None
        logging.getLogger(__name__).info("Auth periodic cleanup stopped")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    # Install Windows-only asyncio Proactor cleanup-RST filter (#1113) before
    # anything else can spawn tasks that might trip it.
    from backend.app.core.asyncio_handlers import install_proactor_reset_filter

    install_proactor_reset_filter()

    await init_db()

    # Register an app-scoped httpx client for Bambu Cloud services so
    # per-request BambuCloudService instances reuse the same connection pool
    # (important for routes like /cloud/filament-info that chain many
    # get_setting_detail calls). The shared client stores no region/token
    # state, so the per-request ownership pattern that fixed the region-bleed
    # bug is preserved.
    import httpx as _httpx

    from backend.app.services.bambu_cloud import set_shared_http_client
    from backend.app.services.makerworld import (
        set_shared_http_client as set_shared_makerworld_http_client,
    )

    _shared_cloud_http_client = _httpx.AsyncClient(timeout=30.0)
    set_shared_http_client(_shared_cloud_http_client)
    # Reuse the same connection pool for MakerWorld — different host, same
    # keep-alive pool saves a TLS handshake per request.
    set_shared_makerworld_http_client(_shared_cloud_http_client)

    # Fix queue items stuck with invalid "aborted" status (should be "cancelled").
    # This can happen when a print was cancelled mid-print on versions before this fix.
    # Restore debug logging state from previous session
    await init_debug_logging()

    # Set up printer manager callbacks
    loop = asyncio.get_event_loop()
    printer_manager.set_event_loop(loop)
    printer_manager.set_status_change_callback(on_printer_status_change)
    printer_manager.set_print_start_callback(on_print_start)
    printer_manager.set_print_complete_callback(on_print_complete)
    printer_manager.set_print_running_observed_callback(on_print_running_observed)
    printer_manager.set_print_state_change_callback(on_print_state_change)
    printer_manager.set_finish_photo_moment_callback(on_finish_photo_moment)
    printer_manager.set_ams_change_callback(on_ams_change)
    printer_manager.set_fts_inlet_change_callback(on_fts_inlet_change)

    async def on_tray_change(printer_id: int, tray_global: int, layer_num: int):
        """Persist tray boundaries used to split usage after restart recovery."""
        try:
            from backend.app.services.usage_tracker import record_tray_change

            async with async_session() as db:
                await record_tray_change(db, printer_id, tray_global, layer_num)
        except Exception as e:
            logging.getLogger(__name__).warning(
                "Failed to persist tray change for printer %d (tray=%d, layer=%d): %s",
                printer_id,
                tray_global,
                layer_num,
                e,
            )

    printer_manager.set_tray_change_callback(on_tray_change)

    # Rehydrate persisted awaiting-plate-clear gate (#961) so prompts survive restarts
    await printer_manager.load_awaiting_plate_clear_from_db()

    # Layer change callback for external camera timelapse
    async def on_layer_change(printer_id: int, layer_num: int):
        """Capture timelapse frame on layer change + first layer notification."""
        from backend.app.services.layer_timelapse import on_layer_change as tl_layer_change

        await tl_layer_change(printer_id, layer_num)

        # First layer complete notification (layer_num >= 2 means layer 1 is done)
        if 2 <= layer_num <= 5 and not _first_layer_notified.get(printer_id, False):
            _first_layer_notified[printer_id] = True
            try:
                async with async_session() as db:
                    from backend.app.models.printer import Printer

                    result = await db.execute(select(Printer).where(Printer.id == printer_id))
                    printer = result.scalar_one_or_none()
                    if not printer:
                        return
                    printer_name = printer.name
                    client = printer_manager.get_client(printer_id)
                    state = client.state if client else None
                    filename = (state.subtask_name or state.gcode_file or "Unknown") if state else "Unknown"
                    total_layers = state.total_layers if state else 0

                    image_data = await _capture_snapshot_for_notification(
                        printer_id, printer, logging.getLogger(__name__)
                    )
                    await notification_service.on_first_layer_complete(
                        printer_id, printer_name, filename, total_layers, db, image_data=image_data
                    )
            except Exception as e:
                logging.getLogger(__name__).warning("First layer notification failed: %s", e)

    printer_manager.set_layer_change_callback(on_layer_change)

    printer_manager.set_bed_temp_update_callback(intake.bed_cooled)

    async def on_drying_complete(printer_id: int, ams_id: int):
        """Smart-plug auto-off-after-drying trigger (#1349).

        Fires once per AMS unit when ``dry_time`` falls from >0 to 0. The
        manager walks all plugs linked to this printer and turns off only
        the ones with ``auto_off_after_drying`` enabled, after their
        per-plug delay. Multiple AMS units finishing close together (e.g. a
        dual-AMS dry that ends within the same MQTT push) call this once
        per unit — the manager's ``_cancel_pending_off`` collapses
        repeated scheduling on the same plug to one timer, so duplicate
        fires are safe.
        """
        try:
            async with async_session() as db:
                await smart_plug_manager.on_drying_complete(printer_id, db)
        except Exception as e:
            logging.getLogger(__name__).warning(
                "Failed to schedule auto-off-after-drying for printer %d (AMS %d): %s",
                printer_id,
                ams_id,
                e,
            )

    printer_manager.set_drying_complete_callback(on_drying_complete)

    # Initialize MQTT relay from settings
    async with async_session() as db:
        from backend.app.api.routes.settings import get_setting

        mqtt_settings = {
            "mqtt_enabled": (await get_setting(db, "mqtt_enabled") or "false") == "true",
            "mqtt_broker": await get_setting(db, "mqtt_broker") or "",
            "mqtt_port": int(await get_setting(db, "mqtt_port") or "1883"),
            "mqtt_username": await get_setting(db, "mqtt_username") or "",
            "mqtt_password": await get_setting(db, "mqtt_password") or "",
            "mqtt_topic_prefix": await get_setting(db, "mqtt_topic_prefix") or "bambuddy",
            "mqtt_use_tls": (await get_setting(db, "mqtt_use_tls") or "false") == "true",
        }
        await mqtt_relay.configure(mqtt_settings)

        # Restore MQTT smart plug subscriptions
        if mqtt_settings.get("mqtt_enabled"):
            from backend.app.models.smart_plug import SmartPlug
            from backend.app.services.mqtt_smart_plug import subscribe_plug_to_mqtt

            result = await db.execute(select(SmartPlug).where(SmartPlug.plug_type == "mqtt"))
            mqtt_plugs = result.scalars().all()
            restored = 0
            for plug in mqtt_plugs:
                if subscribe_plug_to_mqtt(mqtt_relay.smart_plug_service, plug):
                    restored += 1
            if restored:
                logging.info("Restored %s MQTT smart plug subscriptions", restored)

    # Connect to all active printers
    async with async_session() as db:
        await init_printer_connections(db)

    # Auto-connect to Spoolman if enabled
    async with async_session() as db:
        from backend.app.api.routes.settings import get_setting

        spoolman_enabled = await get_setting(db, "spoolman_enabled")
        spoolman_url = await get_setting(db, "spoolman_url")

        if spoolman_enabled and spoolman_enabled.lower() == "true" and spoolman_url:
            try:
                client = await init_spoolman_client(spoolman_url)
                if await client.health_check():
                    logging.info("Auto-connected to Spoolman at %s", spoolman_url)
                    # Ensure the 'tag' extra field exists for RFID/UUID storage
                    field_ok = await client.ensure_tag_extra_field()
                    if not field_ok:
                        logging.error("Spoolman tag extra field registration failed — NFC tag links may not persist")
                    # Register the BambuStudio slicer-preset fields used by the
                    # spool-edit / assign flow. Spoolman rejects PATCHes with
                    # unknown extra keys, so these must exist before any update
                    # that touches them.
                    for field_name in ("bambu_slicer_filament", "bambu_slicer_filament_name"):
                        if not await client.ensure_extra_field(field_name):
                            logging.warning(
                                "Spoolman extra field %r registration failed — "
                                "spool slicer-preset edits will return 502",
                                field_name,
                            )
                else:
                    logging.warning("Spoolman at %s is not reachable", spoolman_url)
            except Exception as e:
                logging.warning("Failed to auto-connect to Spoolman: %s", e)

    # Start the print scheduler
    spawn_background_task(print_scheduler.run(), name="print-scheduler")

    # Start the smart plug scheduler for time-based on/off
    smart_plug_manager.start_scheduler()

    # Start the Home Assistant sensor poller (#1148)
    ha_sensor_manager.start()
    location_ha_sensor_manager.start()

    # Resume any pending auto-offs that were interrupted by restart
    await smart_plug_manager.resume_pending_auto_offs()

    # Start the notification digest scheduler
    notification_service.start_digest_scheduler()

    # Start the GitHub backup scheduler
    await github_backup_service.start_scheduler()

    # Start the local backup scheduler
    await local_backup_service.start_scheduler()
    await obico_detection_service.start()

    # Start the library trash sweeper (#1008)
    await library_trash_service.start_scheduler()

    # Start the archive auto-purge sweeper (#1008 follow-up)
    await archive_purge_service.start_scheduler()

    # Start AMS history recording
    start_ams_history_recording()

    # Start printer sensor (nozzle / bed / chamber) history recording
    start_printer_sensor_history_recording()

    # Start printer runtime tracking
    start_runtime_tracking()

    # Start camera stream orphan cleanup
    start_camera_cleanup()

    # Start the backstop for MQTT sessions paho has stopped recovering (#2732)
    start_connection_watchdog()

    # L-2: Start periodic auth cleanup (stale TOTP + expired revoked JTIs)
    start_auth_cleanup()

    # Seal abandoned Queue upload intake after 24 hours and clean its source
    # File if no active or retryable queue item still needs it.
    start_queue_source_cleanup()

    # Event-loop stall watchdog: dumps all thread stacks to stderr if the loop
    # freezes (#1486 — silent "container hangs after adding a printer" reports).
    from backend.app.services.loop_watchdog import start_loop_watchdog

    start_loop_watchdog()

    # Initialize virtual printer manager and sync from DB
    from backend.app.services.virtual_printer import virtual_printer_manager

    virtual_printer_manager.set_session_factory(async_session)
    virtual_printer_manager.set_printer_manager(printer_manager)
    try:
        await virtual_printer_manager.sync_from_db()
        logging.info("Virtual printer manager synced from database")
    except Exception as e:
        logging.warning("Failed to sync virtual printers: %s", e)

    yield

    # Shutdown
    print_scheduler.stop()
    smart_plug_manager.stop_scheduler()
    ha_sensor_manager.stop()
    location_ha_sensor_manager.stop()
    notification_service.stop_digest_scheduler()
    github_backup_service.stop_scheduler()
    local_backup_service.stop_scheduler()
    library_trash_service.stop_scheduler()
    archive_purge_service.stop_scheduler()
    obico_detection_service.stop()
    stop_ams_history_recording()
    stop_printer_sensor_history_recording()
    stop_runtime_tracking()
    stop_camera_cleanup()
    stop_connection_watchdog()
    from backend.app.services.loop_watchdog import stop_loop_watchdog

    stop_loop_watchdog()
    # Tear down all camera fan-out broadcasters (#1089) so subscribers exit
    # cleanly rather than waiting on a queue that nothing will ever fill.
    try:
        from backend.app.services.camera_fanout import shutdown_all_broadcasters

        await shutdown_all_broadcasters()
    except Exception as e:
        logging.warning("Failed to shut down camera broadcasters: %s", e)
    stop_auth_cleanup()
    stop_queue_source_cleanup()
    printer_manager.disconnect_all()
    await close_spoolman_client()

    # Stop all virtual printer services
    await virtual_printer_manager.stop_all()

    await mqtt_smart_plug_service.disconnect(timeout=2)

    await mqtt_relay.disconnect(timeout=2)

    # Drop the shared Bambu Cloud HTTP client we registered at startup.
    set_shared_http_client(None)
    set_shared_makerworld_http_client(None)
    await _shared_cloud_http_client.aclose()

    # Fire-and-forget tasks may still own aiosqlite worker threads. Cancel and
    # await them while the event loop is alive, before disposing the engine.
    await cancel_background_tasks()

    # Checkpoint WAL (SQLite only) and close all database connections
    from backend.app.core.db_dialect import is_sqlite

    if is_sqlite():
        try:
            async with engine.begin() as conn:
                await conn.execute(text("PRAGMA wal_checkpoint(TRUNCATE)"))
            logging.info("WAL checkpoint completed")
        except Exception as e:
            logging.warning("WAL checkpoint failed: %s", e)
    await engine.dispose()


app = FastAPI(
    title=app_settings.app_name,
    description="Archive and manage Bambu Lab 3MF files",
    version=APP_VERSION,
    lifespan=lifespan,
)


@app.exception_handler(QueueTransitionConflict)
async def queue_transition_conflict_handler(request: Request, exc: QueueTransitionConflict):
    return JSONResponse(status_code=409, content={"detail": "Queue item changed concurrently; refresh and try again"})


# =============================================================================
# Authentication Middleware - Secures ALL API routes by default
# =============================================================================
# Public routes that don't require authentication even when auth is enabled
PUBLIC_API_ROUTES = {
    # Auth routes needed before/during login
    "/api/v1/auth/status",
    "/api/v1/auth/login",
    "/api/v1/auth/setup",  # Needed for initial setup and recovery
    # Advanced auth status needed for login page
    "/api/v1/auth/advanced-auth/status",
    "/api/v1/auth/forgot-password",  # Password reset for advanced auth
    "/api/v1/auth/forgot-password/confirm",  # Complete password reset with token (H-6)
    # 2FA routes that are called BEFORE a JWT is issued (pre-auth flow)
    "/api/v1/auth/2fa/verify",  # Exchange pre_auth_token + 2FA code for JWT
    "/api/v1/auth/2fa/email/send",  # Send OTP email (pre_auth_token based)
    # OIDC routes that must be reachable without a JWT
    "/api/v1/auth/oidc/providers",  # Public list of enabled providers
    "/api/v1/auth/oidc/callback",  # Redirect target from OIDC provider
    "/api/v1/auth/oidc/exchange",  # Exchange short-lived OIDC token for JWT
    # Version check for updates (no sensitive data)
    "/api/v1/updates/version",
    # Metrics endpoint handles its own prometheus_token authentication
    "/api/v1/metrics",
    # Appliance bootstrap (#1589 follow-up): the SPA's i18n setup polls
    # this BEFORE a JWT is available to pick up the firstboot wizard's
    # hostname / timezone / locale and the chrony NTP-gate state. The
    # response contains user-set defaults and a public sync flag — no
    # secrets. Without this entry the global auth middleware returns 401
    # before the route handler runs, regardless of the route's own
    # "no auth required" intent.
    "/api/v1/system/appliance",
}

# Route prefixes that are public (for routes with dynamic segments)
PUBLIC_API_PREFIXES = [
    # WebSocket connections handle their own auth
    "/api/v1/ws",
    # OIDC authorize redirects — include provider_id in path
    "/api/v1/auth/oidc/authorize/",
]

# Route patterns that are public (read-only display data)
# These are checked with "in path" - needed because browsers load images/videos
# via <img src> and <video src> which don't include Authorization headers
PUBLIC_API_PATTERNS = [
    # Thumbnails
    "/thumbnail",  # /archives/{id}/thumbnail, /library/files/{id}/thumbnail
    "/plate-thumbnail/",  # /archives/{id}/plate-thumbnail/{plate_id}
    # Images and media
    "/photos/",  # /archives/{id}/photos/{filename}
    "/project-image/",  # /archives/{id}/project-image/{path}
    "/qrcode",  # /archives/{id}/qrcode
    "/timelapse",  # /archives/{id}/timelapse (video)
    "/cover",  # /printers/{id}/cover
    "/icon",  # /external-links/{id}/icon
    # Camera (streams loaded via <img> tag)
    "/camera/stream",  # /printers/{id}/camera/stream
    "/camera/snapshot",  # /printers/{id}/camera/snapshot
    # Slicer token-authenticated downloads — protocol handlers (bambustudioopen://,
    # orcaslicer://) cannot send auth headers. These endpoints validate a short-lived
    # download token in the URL path instead.
    "/dl/",  # /archives/{id}/dl/{token}/{filename}, /library/files/{id}/dl/{token}/{filename}
    # Obico ML API fetches JPEG frames by one-shot nonce (issue #172 follow-up).
    # The nonce itself is the credential: 32-byte random, single-use, ~30s TTL.
    "/obico/cached-frame/",  # /obico/cached-frame/{nonce}
]


_security_headers_logger = logging.getLogger("backend.app.main.security_headers")


def _parse_trusted_frame_origins() -> tuple[str, ...]:
    """Parse TRUSTED_FRAME_ORIGINS env var into a validated allowlist (#1191).

    Format: comma-separated list of ``scheme://host[:port]`` origins.

    Used by ``security_headers_middleware`` to relax ``frame-ancestors`` for
    trusted same-LAN deployments (e.g. Home Assistant Webpage panel embedding
    Grove Control from a different port). Defaults to empty — strict ``'none'``.

    Invalid entries are dropped with a warning rather than failing startup, so
    a typo in one origin doesn't take the whole deployment down.
    """
    raw = os.environ.get("TRUSTED_FRAME_ORIGINS", "").strip()
    if not raw:
        return ()
    valid: list[str] = []
    for item in raw.split(","):
        candidate = item.strip()
        if not candidate:
            continue
        try:
            parsed = urlparse(candidate)
        except ValueError as e:
            _security_headers_logger.warning("TRUSTED_FRAME_ORIGINS: dropping %r — %s", candidate, e)
            continue
        if parsed.scheme not in ("http", "https"):
            _security_headers_logger.warning("TRUSTED_FRAME_ORIGINS: dropping %r — must be http(s)", candidate)
            continue
        if not parsed.netloc:
            _security_headers_logger.warning("TRUSTED_FRAME_ORIGINS: dropping %r — missing host", candidate)
            continue
        if parsed.path and parsed.path != "/":
            _security_headers_logger.warning("TRUSTED_FRAME_ORIGINS: dropping %r — paths not allowed", candidate)
            continue
        if parsed.query or parsed.fragment:
            _security_headers_logger.warning(
                "TRUSTED_FRAME_ORIGINS: dropping %r — query/fragment not allowed", candidate
            )
            continue
        if "*" in parsed.netloc:
            _security_headers_logger.warning("TRUSTED_FRAME_ORIGINS: dropping %r — wildcards not allowed", candidate)
            continue
        valid.append(f"{parsed.scheme}://{parsed.netloc}")
    if valid:
        _security_headers_logger.info("TRUSTED_FRAME_ORIGINS: %s", ", ".join(valid))
    return tuple(valid)


_TRUSTED_FRAME_ORIGINS: tuple[str, ...] = _parse_trusted_frame_origins()


def _frame_ancestors(default_value: str) -> str:
    """Compose the ``frame-ancestors`` CSP directive (#1191).

    ``default_value`` is the strict directive used when the operator has not
    configured ``TRUSTED_FRAME_ORIGINS`` — typically ``'none'`` (catch-all and
    docs) or ``'self'`` (gcode-viewer, served same-origin). When trusted origins
    are configured, ``'self'`` is always included so same-origin embedding never
    breaks even if an operator forgets to add their own origin to the list.
    """
    if _TRUSTED_FRAME_ORIGINS:
        return "frame-ancestors 'self' " + " ".join(_TRUSTED_FRAME_ORIGINS) + ";"
    return f"frame-ancestors {default_value};"


@app.middleware("http")
async def security_headers_middleware(request, call_next):
    """Add standard HTTP security headers to every response."""
    # Per-request nonce stamped into `script-src` (#1460). On its own this
    # changes nothing for Grove Control's own pages — index.html has no inline
    # scripts since the SW registration moved to /sw-register.js. The reason
    # it's here is Cloudflare: a CF-fronted deployment has the bot-detection
    # script injected into the HTML on the edge, with a fresh hash on every
    # load (so hashes can't be allowlisted). When CF sees a nonce in our CSP,
    # it clones the same nonce onto its injected <script>, and the inline
    # script passes the policy without us needing 'unsafe-inline'. See
    # https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/#if-you-have-a-content-security-policy-csp
    csp_nonce = secrets.token_urlsafe(16)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    # X-Frame-Options is the legacy cross-origin embedding control. Modern
    # browsers honour CSP frame-ancestors instead, and the legacy
    # `ALLOW-FROM <url>` syntax is deprecated and inconsistent across vendors.
    # When operators have explicitly allowlisted trusted frame origins (#1191
    # — typically Home Assistant on a different port), drop X-Frame-Options
    # and let the CSP-side frame-ancestors directive govern embedding.
    if not _TRUSTED_FRAME_ORIGINS:
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    # Content-Security-Policy for the React SPA.
    # Notes:
    #   - 'unsafe-inline' for style-src: React and UI libs inject inline styles at runtime.
    #   - connect-src ws:/wss:: MQTT/printer WebSocket connections.
    #   - img-src data: / blob:: base64 thumbnails and Blob-URL timelapse previews.
    #   - media-src blob:: timelapse video player uses Blob URLs.
    #   - font-src data:: some icon fonts are embedded as data URIs.
    if request.url.path.startswith("/gcode-viewer"):
        # The gcode viewer is embedded in an iframe served by this same origin,
        # so frame-ancestors must allow 'self'.  prettygcode.js also uses eval()
        # internally, so script-src needs 'unsafe-eval'.
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self' 'unsafe-eval'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; "
            "media-src 'self' blob:; "
            "connect-src 'self' ws: wss:; "
            "font-src 'self' data:; "
            "object-src 'none'; "
            "base-uri 'self'; "
            "frame-src 'self' http: https:; " + _frame_ancestors("'self'")
        )
    elif request.url.path in ("/docs", "/redoc", "/docs/oauth2-redirect"):
        # FastAPI's built-in Swagger UI / ReDoc pages load assets from
        # cdn.jsdelivr.net and bootstrap with an inline <script>, so the
        # default CSP would render a blank page.
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
            "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; "
            "img-src 'self' data: blob: https://fastapi.tiangolo.com https://cdn.redoc.ly; "
            "connect-src 'self'; "
            "font-src 'self' data: https://fonts.gstatic.com; "
            "worker-src 'self' blob:; "
            "object-src 'none'; "
            "base-uri 'self'; " + _frame_ancestors("'none'")
        )
    else:
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            f"script-src 'self' 'nonce-{csp_nonce}'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; "
            "media-src 'self' blob:; "
            "connect-src 'self' ws: wss:; "
            "font-src 'self' data:; "
            "object-src 'none'; "
            "base-uri 'self'; "
            "frame-src 'self' http: https:; " + _frame_ancestors("'none'")
        )
    if request.url.scheme == "https":
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


@app.middleware("http")
async def auth_middleware(request, call_next):
    """Enforce authentication on all API routes when auth is enabled.

    This middleware provides defense-in-depth by checking auth at the API gateway level,
    regardless of whether individual routes have auth dependencies.
    """
    from starlette.responses import JSONResponse

    path = request.url.path

    # Only apply to API routes
    if not path.startswith("/api/"):
        return await call_next(request)

    # Allow public routes
    if path in PUBLIC_API_ROUTES:
        return await call_next(request)

    # Allow public prefixes
    for prefix in PUBLIC_API_PREFIXES:
        if path.startswith(prefix):
            return await call_next(request)

    # Allow public patterns (read-only display data like thumbnails)
    for pattern in PUBLIC_API_PATTERNS:
        if pattern in path:
            return await call_next(request)

    # Check if auth is enabled. Fail CLOSED on any exception during the
    # probe — GHSA-6mf4-q26m-47pv: the previous fail-open path here let
    # an attacker who could force a DB exception (e.g. file-descriptor
    # exhaustion via login flood) bypass auth on every protected endpoint.
    try:
        async with async_session() as db:
            from backend.app.core.auth import is_auth_enabled

            auth_enabled = await is_auth_enabled(db)

        if not auth_enabled:
            # Auth disabled, allow all requests
            return await call_next(request)
    except Exception:
        logging.getLogger(__name__).exception("auth_middleware: failing closed on auth-probe error from %s", path)
        return JSONResponse(
            status_code=503,
            content={"detail": "Authentication service temporarily unavailable"},
        )

    # Auth is enabled - require valid token
    auth_header = request.headers.get("Authorization")
    x_api_key = request.headers.get("X-API-Key")

    # Check for API key auth first
    if x_api_key or (auth_header and auth_header.startswith("Bearer bb_")):
        # API key authentication - let the request through to be validated by route handler
        # API keys are validated per-route since they have different permission levels
        return await call_next(request)

    # Check for JWT auth
    if not auth_header or not auth_header.startswith("Bearer "):
        return JSONResponse(
            status_code=401,
            content={"detail": "Authentication required"},
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Validate JWT token
    import jwt

    try:
        from backend.app.core.auth import (
            ALGORITHM,
            SECRET_KEY,
            _is_token_fresh,
            get_user_by_username,
            is_jti_revoked,
        )

        token = auth_header.replace("Bearer ", "")
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username = payload.get("sub")
        if not username:
            raise ValueError("No username in token")
        jti = payload.get("jti")
        if not jti:
            raise ValueError("No jti in token")
        iat = payload.get("iat")

        # Verify user exists, is active, and token is still fresh (L-R8-A).
        # Reject revoked tokens first (defense-in-depth gateway check), reusing
        # this session so the gateway adds a single pooled checkout, not two (#2572).
        async with async_session() as db:
            if await is_jti_revoked(jti, db):
                return JSONResponse(
                    status_code=401,
                    content={"detail": "Token has been revoked"},
                    headers={"WWW-Authenticate": "Bearer"},
                )
            user = await get_user_by_username(db, username)
            if not user or not user.is_active:
                return JSONResponse(
                    status_code=401,
                    content={"detail": "User not found or inactive"},
                    headers={"WWW-Authenticate": "Bearer"},
                )
            if not _is_token_fresh(iat, user):
                return JSONResponse(
                    status_code=401,
                    content={"detail": "Token no longer valid"},
                    headers={"WWW-Authenticate": "Bearer"},
                )
    except jwt.ExpiredSignatureError:
        return JSONResponse(
            status_code=401,
            content={"detail": "Token has expired"},
            headers={"WWW-Authenticate": "Bearer"},
        )
    except (jwt.InvalidTokenError, ValueError, Exception):
        return JSONResponse(
            status_code=401,
            content={"detail": "Invalid token"},
            headers={"WWW-Authenticate": "Bearer"},
        )

    return await call_next(request)


@app.middleware("http")
async def unhandled_http_exception_logger(request, call_next):
    """Persist actionable details for unexpected 5xx request failures.

    Uvicorn normally writes these tracebacks to stderr, which is not part of
    the application support bundle.  Keep the record intentionally small:
    method and path are enough to identify the failing endpoint, while
    ``logger.exception`` preserves the traceback and request trace ID without
    risking request bodies, query values, credentials, or cookies in logs.
    Expected HTTPException responses are converted to responses by FastAPI
    before reaching this boundary, so routine 4xx/intentional errors stay
    quiet.
    """
    try:
        return await call_next(request)
    except Exception:
        logging.getLogger(__name__).exception("Unhandled HTTP request failure: %s %s", request.method, request.url.path)
        raise


@app.middleware("http")
async def trace_id_middleware(request, call_next):
    """Stamp every HTTP request with a trace ID and echo it back.

    Decorated AFTER auth_middleware on purpose: Starlette stacks
    @app.middleware decorators LIFO, so the last-decorated runs first
    inbound. Putting the trace stamp last makes it the OUTERMOST layer,
    which means auth-middleware log lines (and every line emitted on the
    way down to and back from the route handler) all carry the same
    trace ID. If we put it before auth, auth's logs would be stamped
    with the *previous* request's ID — useless for correlation.

    Honours an inbound ``X-Trace-Id`` header so callers running their
    own tracing can correlate their span IDs with our log lines, but
    only if the value passes the whitelist gate in
    ``backend.app.core.trace.normalise_inbound_trace_id`` — anything
    rejected (too long, contains control chars, etc.) silently triggers
    a freshly minted server-side ID rather than failing the request.

    The minted (or echoed) ID is set on a ContextVar so that every log
    record emitted during the request — application logs *and* uvicorn's
    access log — carries it via TraceIDFilter, and is also written to
    the ``X-Trace-Id`` response header so clients can pin a server-side
    log search to the exact request they made.
    """
    from backend.app.core.trace import (
        generate_trace_id,
        normalise_inbound_trace_id,
        trace_id_var,
    )

    inbound = normalise_inbound_trace_id(request.headers.get("X-Trace-Id"))
    trace_id = inbound if inbound is not None else generate_trace_id()

    token = trace_id_var.set(trace_id)
    try:
        response = await call_next(request)
    finally:
        # Reset the ContextVar so a record emitted in a totally
        # unrelated background task that just happens to inherit this
        # context doesn't keep referencing this request's ID forever.
        # In practice ContextVar.reset is best-effort under asyncio
        # task-spawn semantics, but the cost is one attribute write so
        # we may as well do it.
        trace_id_var.reset(token)

    response.headers["X-Trace-Id"] = trace_id
    return response


# API routes
app.include_router(auth.router, prefix=app_settings.api_prefix)
app.include_router(mfa.router, prefix=app_settings.api_prefix)
app.include_router(users.router, prefix=app_settings.api_prefix)
app.include_router(groups.router, prefix=app_settings.api_prefix)
app.include_router(printers.router, prefix=app_settings.api_prefix)
app.include_router(archives.router, prefix=app_settings.api_prefix)
app.include_router(filaments.router, prefix=app_settings.api_prefix)
app.include_router(inventory.router, prefix=app_settings.api_prefix)
app.include_router(labels.router, prefix=app_settings.api_prefix)
app.include_router(settings_routes.router, prefix=app_settings.api_prefix)
app.include_router(cloud.router, prefix=app_settings.api_prefix)
app.include_router(orca_cloud.router, prefix=app_settings.api_prefix)
app.include_router(local_presets.router, prefix=app_settings.api_prefix)
app.include_router(smart_plugs.router, prefix=app_settings.api_prefix)
app.include_router(ha_sensors.router, prefix=app_settings.api_prefix)
app.include_router(location_ha_sensors.router, prefix=app_settings.api_prefix)
app.include_router(print_log.router, prefix=app_settings.api_prefix)
app.include_router(print_queue.router, prefix=app_settings.api_prefix)
app.include_router(scheduled_dryings.router, prefix=app_settings.api_prefix)
app.include_router(kprofiles.router, prefix=app_settings.api_prefix)
app.include_router(notifications.router, prefix=app_settings.api_prefix)
app.include_router(notification_templates.router, prefix=app_settings.api_prefix)
app.include_router(user_notifications.router, prefix=app_settings.api_prefix)
app.include_router(spoolman.router, prefix=app_settings.api_prefix)
app.include_router(spoolman_inventory.router, prefix=app_settings.api_prefix)
app.include_router(updates.router, prefix=app_settings.api_prefix)
app.include_router(maintenance.router, prefix=app_settings.api_prefix)
app.include_router(camera.router, prefix=app_settings.api_prefix)
app.include_router(external_links.router, prefix=app_settings.api_prefix)
app.include_router(projects.router, prefix=app_settings.api_prefix)
app.include_router(library.router, prefix=app_settings.api_prefix)
app.include_router(library_tags.router, prefix=app_settings.api_prefix)
app.include_router(library_trash.router, prefix=app_settings.api_prefix)
app.include_router(library_variants.router, prefix=app_settings.api_prefix)
app.include_router(slice_jobs.router, prefix=app_settings.api_prefix)
app.include_router(slicer_presets.router, prefix=app_settings.api_prefix)
app.include_router(archive_purge.router, prefix=app_settings.api_prefix)
app.include_router(makerworld.router, prefix=app_settings.api_prefix)
app.include_router(api_keys.router, prefix=app_settings.api_prefix)
app.include_router(webhook.router, prefix=app_settings.api_prefix)
app.include_router(ams_history.router, prefix=app_settings.api_prefix)
app.include_router(printer_sensor_history.router, prefix=app_settings.api_prefix)
app.include_router(system.router, prefix=app_settings.api_prefix)
app.include_router(support.router, prefix=app_settings.api_prefix)
app.include_router(websocket.router, prefix=app_settings.api_prefix)
app.include_router(discovery.router, prefix=app_settings.api_prefix)
app.include_router(pending_uploads.router, prefix=app_settings.api_prefix)
app.include_router(firmware.router, prefix=app_settings.api_prefix)
app.include_router(github_backup.router, prefix=app_settings.api_prefix)
app.include_router(local_backup.router, prefix=app_settings.api_prefix)
app.include_router(obico.router, prefix=app_settings.api_prefix)
app.include_router(metrics.router, prefix=app_settings.api_prefix)
app.include_router(virtual_printers.router, prefix=app_settings.api_prefix)


# Serve static files (React build)
if app_settings.static_dir.exists() and any(app_settings.static_dir.iterdir()):
    app.mount(
        "/assets",
        StaticFiles(directory=app_settings.static_dir / "assets"),
        name="assets",
    )
    if (app_settings.static_dir / "img").exists():
        app.mount(
            "/img",
            StaticFiles(directory=app_settings.static_dir / "img"),
            name="img",
        )
    if (app_settings.static_dir / "icons").exists():
        app.mount(
            "/icons",
            StaticFiles(directory=app_settings.static_dir / "icons"),
            name="icons",
        )
    # Self-hosted Inter woff2 files (#1460). Without this mount /fonts/*.woff2
    # falls through to the SPA catch-all and returns index.html, which the
    # browser's font sanitizer rejects ("downloadable font: rejected by
    # sanitizer").
    if (app_settings.static_dir / "fonts").exists():
        app.mount(
            "/fonts",
            StaticFiles(directory=app_settings.static_dir / "fonts"),
            name="fonts",
        )


@app.get("/")
async def serve_frontend():
    """Serve the React frontend."""
    index_file = app_settings.static_dir / "index.html"
    if index_file.exists():
        return FileResponse(index_file, headers=_HTML_CACHE_HEADERS)
    return {
        "message": "Grove Control API",
        "docs": "/docs",
        "frontend": "Build and place React app in /static directory",
    }


# index.html must always be revalidated — Vite emits content-hashed JS/CSS
# bundles (e.g. `index-JRaF_JhW.js`), so the JS itself is safe to cache
# forever, but the HTML wrapping it is the only file that knows which hash
# is current. Without explicit cache-control headers Chromium decides
# heuristically (typically 10% of the time since Last-Modified) and on
# long-running kiosks happily serves stale HTML across browser restarts.
# That stale HTML references an old bundle hash, the old bundle is also
# in the disk cache, and the user ends up running pre-update JS forever
# without ever knowing why. ``no-cache`` (revalidate every time, but a
# 304 is cheap) is the correct setting for an SPA's entry HTML.
_HTML_CACHE_HEADERS = {"Cache-Control": "no-cache, must-revalidate"}


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy"}


# GET + HEAD on the three PWA bootstrap routes (#1460). Scanners and a plain
# `curl -I` use HEAD; FastAPI's @app.get only registers GET, so HEAD answers
# with 405 Method Not Allowed and shows up as a "broken manifest" red herring
# in deployment debugging.
@app.api_route("/manifest.json", methods=["GET", "HEAD"])
async def serve_manifest():
    """Serve PWA manifest."""
    manifest_file = app_settings.static_dir / "manifest.json"
    if manifest_file.exists():
        return FileResponse(manifest_file, media_type="application/manifest+json")
    return {"error": "Manifest not found"}


@app.api_route("/sw.js", methods=["GET", "HEAD"])
async def serve_service_worker():
    """Serve service worker."""
    sw_file = app_settings.static_dir / "sw.js"
    if sw_file.exists():
        return FileResponse(
            sw_file,
            media_type="application/javascript",
            headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
        )
    return {"error": "Service worker not found"}


@app.api_route("/sw-register.js", methods=["GET", "HEAD"])
async def serve_sw_register():
    """Serve the service-worker registration bootstrap script.

    Served as a real JS file so the strict `script-src 'self'` CSP covers it
    without needing 'unsafe-inline' or per-build hashes on the inline tag.
    """
    reg_file = app_settings.static_dir / "sw-register.js"
    if reg_file.exists():
        return FileResponse(reg_file, media_type="application/javascript")
    return {"error": "sw-register.js not found"}


# ── GCode viewer static files ────────────────────────────────────────────────
# Served via explicit routes so ordering is guaranteed (app.mount() loses
# to the /{full_path:path} catch-all in some Starlette versions).
_gcode_viewer_dir = (app_settings.static_dir.parent / "gcode_viewer").resolve()

# Surface packaging gaps at startup instead of as silent runtime 404s. If the
# directory is missing the explicit @app.get("/gcode-viewer/...") routes below
# return bare HTTPException(404) which renders as {"detail":"Not Found"} in
# the 3D Preview iframe (#1218) — easy to miss in normal operation, easy to
# spot if the operator scans the startup log or a support bundle.
if not (_gcode_viewer_dir / "index.html").is_file():
    logging.getLogger(__name__).error(
        "Embedded GCode viewer assets missing at %s — /gcode-viewer/ will return 404 "
        "and 3D Preview will fail. This indicates a packaging bug; the gcode_viewer/ "
        "directory must be present alongside static/.",
        _gcode_viewer_dir,
    )


def _gcode_viewer_response(rel: str) -> FileResponse:
    from fastapi import HTTPException as _HTTPException

    safe = (_gcode_viewer_dir / rel).resolve()
    if not safe.is_relative_to(_gcode_viewer_dir):
        raise _HTTPException(status_code=403)
    if safe.is_file():
        mt, _ = _mimetypes.guess_type(str(safe))
        return FileResponse(str(safe), media_type=mt or "application/octet-stream")
    raise _HTTPException(status_code=404)


@app.get("/gcode-viewer/")
async def serve_gcode_viewer_index() -> FileResponse:
    """Raw PrettyGCode viewer for the iframe. The bare ``/gcode-viewer``
    (no trailing slash) intentionally falls through to the SPA catch-all so a
    full-page reload re-enters the React layout instead of serving the iframe
    contents standalone."""
    return _gcode_viewer_response("index.html")


@app.get("/gcode-viewer/{file_path:path}")
async def serve_gcode_viewer_file(file_path: str) -> FileResponse:
    return _gcode_viewer_response(file_path)


# Catch-all route for React Router (must be last)
@app.get("/{full_path:path}")
async def serve_spa(full_path: str):
    """Serve React app for client-side routing."""
    # Don't intercept API routes - raise proper 404 so FastAPI can handle redirects
    if full_path.startswith("api/"):
        from fastapi import HTTPException

        raise HTTPException(status_code=404, detail="Not found")

    index_file = app_settings.static_dir / "index.html"
    if index_file.exists():
        return FileResponse(index_file, headers=_HTML_CACHE_HEADERS)

    return {"error": "Frontend not built"}

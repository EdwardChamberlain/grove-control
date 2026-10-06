"""AMS drying (#204): automatic drying between and during prints, and scheduled drying (#71).

Mixed into the print scheduler, which checks both every pass.
"""

import json
import logging
import time
from datetime import datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.scheduled_drying import ScheduledDrying
from backend.app.models.settings import Settings
from backend.app.services import drying_preflight
from backend.app.services.printer_manager import printer_manager, supports_drying, supports_drying_while_printing
from backend.app.utils.local_time import utcnow_naive

logger = logging.getLogger(__name__)

SCHEDULED_DRYING_RETENTION_DAYS = 7
SCHEDULED_DRYING_PRUNE_INTERVAL_SECONDS = 60 * 60


class AmsDrying:
    """Starts, stops and tracks AMS drying; mixed into ``PrintScheduler``."""

    # Built-in drying presets per filament type (from BambuStudio filament profiles)
    # Format: { n3f_temp, n3s_temp, n3f_hours, n3s_hours }
    DEFAULT_DRYING_PRESETS: dict[str, dict[str, int]] = {
        "PLA": {"n3f": 45, "n3s": 45, "n3f_hours": 12, "n3s_hours": 12},
        "PETG": {"n3f": 65, "n3s": 65, "n3f_hours": 12, "n3s_hours": 12},
        "TPU": {"n3f": 65, "n3s": 75, "n3f_hours": 12, "n3s_hours": 18},
        "ABS": {"n3f": 65, "n3s": 80, "n3f_hours": 12, "n3s_hours": 8},
        "ASA": {"n3f": 65, "n3s": 80, "n3f_hours": 12, "n3s_hours": 8},
        "PA": {"n3f": 65, "n3s": 85, "n3f_hours": 12, "n3s_hours": 12},
        "PC": {"n3f": 65, "n3s": 80, "n3f_hours": 12, "n3s_hours": 8},
        "PVA": {"n3f": 65, "n3s": 85, "n3f_hours": 12, "n3s_hours": 18},
    }

    def __init__(self):
        super().__init__()
        # Track which printers are currently auto-drying (printer_id -> start timestamp)
        self._drying_in_progress: dict[int, float] = {}
        # Printers with a running manual scheduled-drying row. Auto-drying must
        # not stop a cycle the user explicitly scheduled.
        self._scheduled_drying_printer_ids: set[int] = set()
        self._last_scheduled_drying_prune: float | None = None

    @staticmethod
    def _active_drying_ams_ids_from_state(state) -> tuple[int, ...]:
        """Return AMS ids whose live telemetry reports an active dry cycle."""
        raw_data = getattr(state, "raw_data", None)
        if not isinstance(raw_data, dict):
            return ()
        ams_list = raw_data.get("ams") or []
        if not isinstance(ams_list, list):
            return ()

        active_ids: set[int] = set()
        for ams_data in ams_list:
            if not isinstance(ams_data, dict):
                continue
            try:
                dry_time = int(ams_data.get("dry_time") or 0)
                ams_id = int(ams_data.get("id", 0))
            except (TypeError, ValueError):
                continue
            if dry_time > 0:
                active_ids.add(ams_id)
        return tuple(sorted(active_ids))

    def _active_drying_ams_ids(self, printer_id: int) -> tuple[int, ...]:
        """Read canonical drying state directly from the printer status cache."""
        state = printer_manager.get_status(printer_id)
        return self._active_drying_ams_ids_from_state(state) if state else ()

    async def _get_drying_presets(self, db: AsyncSession) -> dict[str, dict[str, int]]:
        """Get drying presets (user-configured or built-in defaults)."""
        result = await db.execute(select(Settings).where(Settings.key == "drying_presets"))
        setting = result.scalar_one_or_none()
        if setting and setting.value:
            try:
                presets = json.loads(setting.value)
                if isinstance(presets, dict) and presets:
                    return presets
            except json.JSONDecodeError:
                pass
        return self.DEFAULT_DRYING_PRESETS

    async def _get_humidity_thresholds(self, db: AsyncSession) -> dict[str, int]:
        """Per-filament humidity thresholds (#1605), by upper-case base type plus ``default``; empty when unset."""
        result = await db.execute(select(Settings).where(Settings.key == "ams_humidity_thresholds"))
        setting = result.scalar_one_or_none()
        if not setting or not setting.value:
            return {}
        try:
            data = json.loads(setting.value)
        except json.JSONDecodeError:
            return {}
        if not isinstance(data, dict):
            return {}
        out: dict[str, int] = {}
        for key, value in data.items():
            try:
                out[str(key).upper() if key != "default" else "default"] = int(value)
            except (TypeError, ValueError):
                continue
        return out

    @staticmethod
    def resolve_humidity_threshold(trays: list[dict], thresholds: dict[str, int], fallback: int) -> int:
        """An AMS unit's humidity threshold (#1605): the lowest for its loaded filament types.

        Unknown types use the ``default`` entry; with no per-type map, ``fallback``.
        """
        default = thresholds.get("default", fallback)
        if not thresholds:
            return fallback
        candidates: list[int] = []
        for tray in trays:
            tray_type = str(tray.get("tray_type") or "").strip()
            if not tray_type:
                continue
            base_type = tray_type.split()[0].upper()
            candidates.append(thresholds.get(base_type, default))
        if not candidates:
            return default
        return min(candidates)

    def _get_conservative_drying_params(
        self, trays: list[dict], module_type: str, presets: dict[str, dict[str, int]]
    ) -> tuple[int, int, str] | None:
        """(temp, hours, filament type) for one AMS unit's mixed filaments: lowest temperature, longest time."""
        temp_key = module_type if module_type in ("n3f", "n3s") else "n3f"
        hours_key = f"{temp_key}_hours"

        min_temp = None
        max_hours = None
        filament_type = ""

        for tray in trays:
            tray_type = tray.get("tray_type", "")
            if not tray_type:
                continue
            # Normalize filament type for preset lookup (e.g., "PLA Basic" -> "PLA")
            base_type = tray_type.split()[0].upper()
            preset = presets.get(base_type)
            if not preset:
                continue

            temp = preset.get(temp_key, 55)
            hours = preset.get(hours_key, 12)

            # Conservative: lowest temp, longest duration
            if min_temp is None or temp < min_temp:
                min_temp = temp
            if max_hours is None or hours > max_hours:
                max_hours = hours
            if not filament_type:
                filament_type = base_type

        if min_temp is None:
            return None
        return (min_temp, max_hours or 12, filament_type)

    async def _check_auto_drying(
        self,
        db: AsyncSession,
        queue_items: list[PrintQueueItem],
        busy_printers: set[int],
        *,
        require_plate_clear: bool = True,
    ):
        """Start drying idle printers' AMS units above their humidity threshold, and stop unwanted drying.

        Queue, ambient and print-time drying are enabled separately. Print-time drying
        needs Print While Drying support, and runs 5°C cooler, at 40°C or more.
        """
        queue_drying_enabled = await self._get_bool_setting(db, "queue_drying_enabled")
        ambient_drying_enabled = await self._get_bool_setting(db, "ambient_drying_enabled")
        print_drying_enabled = await self._get_bool_setting(db, "print_drying_enabled")
        if not queue_drying_enabled and not ambient_drying_enabled:
            # Stop active drying on all printers if both features disabled
            if self._drying_in_progress:
                for pid in list(self._drying_in_progress):
                    if pid in self._scheduled_drying_printer_ids:
                        continue
                    logger.info("Auto-drying: printer %d — stopping, auto-drying disabled", pid)
                    await self._stop_drying(pid)
            return

        # Update drying state from printer status (handles backend restart)
        self._sync_drying_state()

        # Find printers with scheduled items (for queue drying mode)
        printers_with_scheduled: set[int] = set()
        printers_with_items: set[int] = set()
        for item in queue_items:
            if item.printer_id:
                printers_with_items.add(item.printer_id)
                if item.scheduled_time and not item.manual_start:
                    printers_with_scheduled.add(item.printer_id)

        # If only queue mode is on and no printers have scheduled items, stop drying
        # (but skip this short-circuit when print_drying_enabled is on — busy printers
        # may still be eligible for mid-print drying regardless of queue state).
        if not ambient_drying_enabled and not printers_with_scheduled and not print_drying_enabled:
            for pid in list(self._drying_in_progress):
                if pid in self._scheduled_drying_printer_ids:
                    continue
                logger.info("Auto-drying: printer %d — stopping, no scheduled prints in queue", pid)
                await self._stop_drying(pid)
            return

        # Get humidity threshold (global fallback)
        result = await db.execute(select(Settings).where(Settings.key == "ams_humidity_fair"))
        setting = result.scalar_one_or_none()
        global_humidity_threshold = int(setting.value) if setting else 60

        # Per-filament humidity threshold overrides (#1605). Empty → fall back
        # to the global threshold for every AMS unit.
        per_type_thresholds = await self._get_humidity_thresholds(db)

        # Get drying presets
        presets = await self._get_drying_presets(db)

        # Determine if drying should be skipped for printers with pending items
        block_for_drying = await self._get_bool_setting(db, "queue_drying_block")

        # Get all active printers
        all_printers = await db.execute(select(Printer).where(Printer.is_active.is_(True)))
        for printer in all_printers.scalars():
            pid = printer.id

            if pid in self._scheduled_drying_printer_ids:
                continue

            # Resolve model+firmware up front — needed to decide whether this printer
            # qualifies for mid-print drying (busy printer on capable hardware).
            state = printer_manager.get_status(pid)
            if not state:
                logger.debug("Auto-drying: printer %d skipped — no state", pid)
                continue
            if getattr(state, "preheating", False) is True or printer.heat_soak_shutdown_pending is True:
                continue
            model = printer_manager.get_model(pid)
            firmware = state.firmware_version

            mid_print = (
                pid in busy_printers and print_drying_enabled and supports_drying_while_printing(model, firmware)
            )

            if pid in busy_printers and not mid_print:
                logger.debug("Auto-drying: printer %d skipped — busy", pid)
                continue

            if not mid_print:
                # In queue-only mode, only dry printers that have scheduled prints
                if not ambient_drying_enabled and pid not in printers_with_scheduled:
                    if self._drying_in_progress.get(pid):
                        logger.info("Auto-drying: printer %d — stopping, no scheduled prints for this printer", pid)
                        await self._stop_drying(pid)
                    logger.debug("Auto-drying: printer %d skipped — no scheduled prints", pid)
                    continue
                # When block mode is on, don't START new drying on printers with pending items.
                # But allow already-drying printers through so humidity auto-stop logic still runs.
                if block_for_drying and pid in printers_with_items and not self._drying_in_progress.get(pid):
                    logger.debug("Auto-drying: printer %d skipped — has pending items (block mode)", pid)
                    continue
            if not printer_manager.is_connected(pid):
                logger.debug("Auto-drying: printer %d skipped — not connected", pid)
                continue
            if not mid_print and not self._is_printer_idle(pid, require_plate_clear):
                logger.debug("Auto-drying: printer %d skipped — not idle", pid)
                continue

            # Check drying capability. For mid-print path, supports_drying_while_printing
            # was already verified when computing mid_print above.
            if not mid_print and not supports_drying(model, firmware):
                logger.debug("Auto-drying: printer %d skipped — model %s does not support drying", pid, model)
                continue

            # Check each AMS unit from raw_data
            ams_list = state.raw_data.get("ams", [])
            logger.debug("Auto-drying: printer %d — checking %d AMS units", pid, len(ams_list))
            for ams_data in ams_list:
                module_type = str(ams_data.get("module_type") or "")
                ams_id = int(ams_data.get("id", 0))
                # Only n3f/n3s support drying
                if module_type not in ("n3f", "n3s"):
                    logger.debug("Auto-drying: printer %d AMS %d skipped — module_type=%s", pid, ams_id, module_type)
                    continue

                # Resolve per-filament humidity threshold for this AMS unit (#1605).
                # Most-restrictive of all loaded tray types; falls back to the
                # global threshold when no overrides are configured.
                trays = ams_data.get("tray", []) or []
                humidity_threshold = self.resolve_humidity_threshold(
                    trays, per_type_thresholds, global_humidity_threshold
                )

                dry_time = int(ams_data.get("dry_time") or 0)

                # Read humidity — prefer humidity_raw (actual %) over humidity (index 1-5)
                humidity = None
                h_raw = ams_data.get("humidity_raw")
                if h_raw is not None:
                    try:
                        humidity = int(h_raw)
                    except (ValueError, TypeError):
                        pass
                if humidity is None:
                    h_idx = ams_data.get("humidity")
                    if h_idx is not None:
                        try:
                            humidity = int(h_idx)
                        except (ValueError, TypeError):
                            pass
                # Already drying — let it run to its configured duration (#1892).
                #
                # We deliberately do NOT stop drying from a humidity re-check here.
                # Relative humidity drops steeply in heated air, so the AMS sensor
                # reads ~15-20% within minutes of the dryer starting even while the
                # filament is still saturated. A humidity-based early-stop therefore
                # always fires at the minimum-time floor, truncating both user-started
                # manual cycles and Bambuddy's own preset-duration dries to ~30 min.
                # The firmware stops when the configured duration elapses; scheduling
                # stops (print takes priority, queue no longer needs drying) are
                # handled separately via _stop_drying().
                if dry_time > 0:
                    if pid not in self._drying_in_progress:
                        # Drying we didn't start (manual or from before restart) —
                        # track it so scheduling stops still apply; never auto-stop it.
                        self._drying_in_progress[pid] = time.monotonic()
                    logger.debug(
                        "Auto-drying: printer %d AMS %d — drying (%dm left, humidity %s%%), letting it run",
                        pid,
                        ams_id,
                        dry_time,
                        humidity,
                    )
                    continue

                # Humidity below threshold — no need to start drying
                if humidity is None or humidity <= humidity_threshold:
                    logger.debug(
                        "Auto-drying: printer %d AMS %d skipped — humidity %s <= threshold %d",
                        pid,
                        ams_id,
                        humidity,
                        humidity_threshold,
                    )
                    continue

                # Check cannot-dry reasons (power constraints etc.)
                sf_reasons = ams_data.get("dry_sf_reason", [])
                if sf_reasons:
                    logger.debug(
                        "Auto-drying: printer %d AMS %d skipped — cannot dry reasons: %s",
                        pid,
                        ams_id,
                        sf_reasons,
                    )
                    continue

                # Get conservative drying params for mixed filaments
                params = self._get_conservative_drying_params(trays, module_type, presets)
                if not params:
                    logger.debug(
                        "Auto-drying: printer %d AMS %d skipped — no drying-eligible filaments in trays", pid, ams_id
                    )
                    continue

                temp, duration_hours, filament_type = params

                # Mid-print drying: cap drying temperature to protect spools (Bambu warns
                # "drying temperature must not exceed the filament's softening temperature"
                # for Print While Drying). Floor at 40 degC — below that the dryer is
                # ineffective and firmware will reject anyway.
                if mid_print:
                    temp = max(40, temp - 5)

                # Start drying
                logger.info(
                    "Auto-drying: printer %d AMS %d — humidity %d%% > threshold %d%%, "
                    "starting %s drying at %d°C for %dh%s",
                    pid,
                    ams_id,
                    humidity,
                    humidity_threshold,
                    filament_type,
                    temp,
                    duration_hours,
                    " (mid-print)" if mid_print else "",
                )
                success = printer_manager.send_drying_command(
                    pid, ams_id, temp, duration_hours, mode=1, filament=filament_type
                )
                if success:
                    self._drying_in_progress[pid] = time.monotonic()

    def _sync_drying_state(self):
        """Forget auto-drying that printers no longer report."""
        to_remove = []
        for pid in self._drying_in_progress:
            state = printer_manager.get_status(pid)
            if not state:
                to_remove.append(pid)
                continue
            # Check if any AMS unit is still drying
            ams_list = state.raw_data.get("ams", [])
            any_drying = any(int(a.get("dry_time") or 0) > 0 for a in ams_list)
            if not any_drying:
                to_remove.append(pid)
        for pid in to_remove:
            self._drying_in_progress.pop(pid, None)

    async def _stop_drying(self, printer_id: int) -> bool:
        """Stop all live drying cycles; return whether every command was queued."""
        active_ams_ids = self._active_drying_ams_ids(printer_id)
        if not active_ams_ids:
            self._drying_in_progress.pop(printer_id, None)
            return True

        all_sent = True
        for ams_id in active_ams_ids:
            logger.info(
                "Drying: stopping drying on printer %d AMS %d — print takes priority",
                printer_id,
                ams_id,
            )
            if not printer_manager.send_drying_command(printer_id, ams_id, 0, 0, mode=0):
                all_sent = False
                logger.warning(
                    "Could not queue drying stop for printer %d AMS %d",
                    printer_id,
                    ams_id,
                )
        self._drying_in_progress.pop(printer_id, None)
        return all_sent

    # Scheduled manual drying (#71) -------------------------------------

    SCHEDULED_DRYING_GRACE_SECONDS = 120
    SCHEDULED_DRYING_COMPLETE_FRACTION = 0.9

    async def _check_scheduled_dryings(self, db: AsyncSession) -> None:
        """Dispatch due scheduled drying runs and reconcile running rows."""
        now = utcnow_naive()
        monotonic_now = time.monotonic()
        if (
            self._last_scheduled_drying_prune is None
            or monotonic_now - self._last_scheduled_drying_prune >= SCHEDULED_DRYING_PRUNE_INTERVAL_SECONDS
        ):
            self._last_scheduled_drying_prune = monotonic_now
            await db.execute(
                delete(ScheduledDrying).where(
                    ScheduledDrying.status.in_(("completed", "cancelled", "failed")),
                    ScheduledDrying.completed_at.is_not(None),
                    ScheduledDrying.completed_at < now - timedelta(days=SCHEDULED_DRYING_RETENTION_DAYS),
                )
            )

        result = await db.execute(
            select(ScheduledDrying)
            .where(ScheduledDrying.status.in_(("pending", "running")))
            .order_by(ScheduledDrying.start_after.asc().nullsfirst(), ScheduledDrying.id.asc())
        )
        rows = list(result.scalars().all())
        previously_running = self._scheduled_drying_printer_ids
        self._scheduled_drying_printer_ids = {row.printer_id for row in rows if row.status == "running"}
        running_printer_ids = set(self._scheduled_drying_printer_ids)

        printer_ids = {row.printer_id for row in rows}
        printers_by_id: dict[int, Printer] = {}
        if printer_ids:
            printer_result = await db.execute(select(Printer).where(Printer.id.in_(printer_ids)))
            printers_by_id = {printer.id: printer for printer in printer_result.scalars()}

        for row in rows:
            if row.status == "running":
                self._update_running_scheduled_drying(row, now)
                continue
            if row.start_after is not None and row.start_after > now:
                continue

            state = printer_manager.get_status(row.printer_id)
            if not state:
                row.waiting_reason = "printer_offline"
                continue

            printer = printers_by_id.get(row.printer_id)
            unsupported = drying_preflight.check_drying_supported(
                printer.model if printer else None, state.firmware_version
            )
            if unsupported:
                row.status = "failed"
                row.error_message = unsupported
                row.completed_at = now
                continue
            if self._drying_in_progress.get(row.printer_id) or row.printer_id in running_printer_ids:
                row.waiting_reason = "already_drying"
                continue
            if not self._is_printer_idle(row.printer_id, require_plate_clear=False):
                row.waiting_reason = "printer_busy"
                continue

            target = drying_preflight.find_ams_unit(state, row.ams_id)
            if target is None:
                row.waiting_reason = "ams_not_found"
                continue
            blocking = drying_preflight.blocking_reason_codes(target)
            if blocking:
                row.waiting_reason = drying_preflight.waiting_reason_for_codes(blocking)
                continue

            filament = drying_preflight.resolve_filament(target, row.filament)
            success = printer_manager.send_drying_command(
                row.printer_id,
                row.ams_id,
                row.temp,
                row.duration_hours,
                mode=1,
                filament=filament,
                rotate_tray=row.rotate_tray,
            )
            if success:
                row.status = "running"
                row.started_at = now
                row.waiting_reason = None
                row.filament = filament
                self._drying_in_progress[row.printer_id] = time.monotonic()
                self._scheduled_drying_printer_ids.add(row.printer_id)
                running_printer_ids.add(row.printer_id)
            else:
                row.waiting_reason = "printer_offline"

        self._scheduled_drying_printer_ids = {row.printer_id for row in rows if row.status == "running"}
        for printer_id in (previously_running | running_printer_ids) - self._scheduled_drying_printer_ids:
            self._drying_in_progress.pop(printer_id, None)
        await db.commit()

    def _update_running_scheduled_drying(self, row: ScheduledDrying, now: datetime) -> None:
        """Mark a running schedule complete, cancelled, or ready to retry."""
        if row.started_at is None:
            row.started_at = now
            return
        elapsed = (now - row.started_at).total_seconds()
        if elapsed < self.SCHEDULED_DRYING_GRACE_SECONDS:
            return
        state = printer_manager.get_status(row.printer_id)
        if not state:
            return
        target = drying_preflight.find_ams_unit(state, row.ams_id)
        if target is None:
            # A missing AMS entry is not the same thing as a completed cycle:
            # status payloads can be partial while the printer reconnects.
            # Keep the row running until we have telemetry for its target.
            row.waiting_reason = "ams_not_found"
            return
        try:
            dry_time = int(target.get("dry_time") or 0)
        except (TypeError, ValueError):
            # Do not turn malformed telemetry into a terminal state either.
            row.waiting_reason = "ams_not_found"
            return
        row.waiting_reason = None
        if dry_time > 0:
            return
        if elapsed >= row.duration_hours * 3600 * self.SCHEDULED_DRYING_COMPLETE_FRACTION:
            row.status = "completed"
            row.completed_at = now
        elif not self._is_printer_idle(row.printer_id, require_plate_clear=False):
            row.status = "pending"
            row.started_at = None
            row.waiting_reason = "interrupted"
        else:
            row.status = "cancelled"
            row.completed_at = now

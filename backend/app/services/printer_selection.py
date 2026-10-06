"""Printer selection (#204): the printer and tray mapping each waiting job takes, and why others wait.

This is the queued state's wait. It is mixed into the print scheduler, which
runs it every pass and dispatches what it selects.
"""

import asyncio
import json
import logging
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.print_queue import PrintQueueItem, PrintQueueVariant
from backend.app.models.printer import Printer
from backend.app.models.smart_plug import SmartPlug
from backend.app.services.filament_requirements import canonical_filament_type
from backend.app.services.lifecycle.engine import lock_queue_item
from backend.app.services.notification_service import notification_service
from backend.app.services.printer_manager import printer_manager
from backend.app.services.smart_plug_manager import smart_plug_manager
from backend.app.utils.printer_models import is_gcode_compatible, normalize_printer_model

logger = logging.getLogger(__name__)

_UPLOAD_POOL_WAITING_PREFIX = "Waiting for upload slot"
# H2C tool-changer dock positions reported by ``device.nozzle.info``.  The
# same payload contains hotends under ids 0/1; keeping the ids here means the
# scheduler can recognise rack stock without depending on a printer-model
# registry.
_RACK_NOZZLE_IDS: frozenset[int] = frozenset(range(16, 22))
_EMPTY_NOZZLE_SERIAL = "N/A"


def _parse_nozzle_diameter(raw) -> float | None:
    """Return a positive nozzle diameter, or ``None`` for unknown values."""
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


@dataclass(slots=True)
class _ModelCandidate:
    """One (file, printer model) pair the model-based matcher may try.

    Model-based assignment used to have exactly one of these per item, held
    directly in the item's own columns. Cross-model queue items (#671) have
    several, held in ``print_queue_variants``. Both shapes are normalised into
    this so the matching, the cross-model gate and the waiting-reason handling
    are written once and an item without variants provably takes the same path
    it took before variants existed.

    ``variant`` is None for the item's own columns and set for a real variant
    row, which is what :meth:`PrinterSelection._resolve_variant` writes onto the
    item once that candidate wins.
    """

    target_model: str | None
    sliced_for: str | None
    required_filament_types: str | None
    filament_overrides: str | None
    variant: "PrintQueueVariant | None" = None


def _sliced_for_model(archive, library_file) -> str | None:
    """Model a 3MF declares it was sliced for, from whichever source holds it."""
    if archive is not None:
        return archive.sliced_for_model
    if library_file is not None and library_file.file_metadata:
        return library_file.file_metadata.get("sliced_for_model")
    return None


def _incompatible_sliced_model_reason(sliced_for_model: str | None, printer) -> str | None:
    """Return an actionable reason when a sliced file cannot target a printer."""
    if not sliced_for_model or not printer or is_gcode_compatible(sliced_for_model, printer.model):
        return None
    return f"Incompatible sliced file: was sliced for {sliced_for_model}, but printer {printer.name} is {printer.model}"


def _source_nozzle_mismatch(archive, library_file, printer_id: int) -> str | None:
    metadata = library_file.file_metadata if library_file and library_file.file_metadata else {}
    diameter = _parse_nozzle_diameter(archive.nozzle_diameter if archive else metadata.get("nozzle_diameter"))
    state = printer_manager.get_status(printer_id)
    return (
        _nozzle_mismatch_message(diameter, _installed_nozzle_diameters(state), _rack_nozzle_diameters(state))
        if diameter
        else None
    )


def _candidates_for(item: PrintQueueItem) -> list[_ModelCandidate]:
    """Candidate files for ``item``, best first.

    An item with no variant rows yields exactly one candidate built from its own
    columns — the pre-#671 behaviour, unchanged.

    Variants come back least-attempted first, ties broken by the user's
    ``position``. On the first pass every count is zero, so this is purely the
    user's priority order. After a start-watchdog bounce the printer that failed
    drops behind, so the next lap tries the other machine rather than spending the
    item's whole retry budget on the one that is wedged. Once every candidate has
    been tried equally often they cycle again, which keeps the item-level
    ``DISPATCH_MAX_ATTEMPTS`` bound from #2555 intact — a job with alternatives
    still gives up, it just does not give up without trying them.
    """
    variants = getattr(item, "variants", None) or []
    if not variants:
        if not item.archive_id and not item.library_file_id:
            # Nothing to print at all. Dispatching would fail deep in the upload
            # on "No archive_id or library_file_id"; the caller holds the item
            # with an explanation instead.
            return []
        return [
            _ModelCandidate(
                target_model=item.target_model,
                sliced_for=_sliced_for_model(getattr(item, "archive", None), getattr(item, "library_file", None)),
                required_filament_types=item.required_filament_types,
                filament_overrides=item.filament_overrides,
            )
        ]

    # Drop candidates whose file is gone or in the trash. Both are reachable and
    # neither is covered by the schema: library deletes are soft (the row lives
    # on with ``deleted_at`` set, which no foreign key can express), and SQLite
    # ships with ``PRAGMA foreign_keys`` off, so the ON DELETE CASCADE never
    # fires there and a hard delete leaves the variant row pointing at nothing.
    usable = [v for v in variants if v.library_file is not None and v.library_file.deleted_at is None]

    ordered = sorted(usable, key=lambda v: (v.attempt_count or 0, v.position, v.id))
    return [
        _ModelCandidate(
            target_model=v.target_model,
            sliced_for=_sliced_for_model(None, v.library_file),
            required_filament_types=v.required_filament_types,
            filament_overrides=v.filament_overrides,
            variant=v,
        )
        for v in ordered
    ]


def _collapse_waiting_reasons(per_model: list[tuple[str | None, str]]) -> str | None:
    """Fold one waiting reason per candidate into a single line for the item.

    A cross-model item produces a reason per candidate, and pasting them
    together unlabelled reads as gibberish ("No idle printer; PETG not loaded"
    — on which machine?). Each reason is prefixed with its model, except in the
    single-candidate case where the item already displays its target model and
    the prefix would be noise.

    Identical reasons collapse rather than repeat, so three idle-less models
    read as one clause.

    When *every* candidate is merely busy the parts are joined with the ``" | "``
    separator :meth:`PrinterSelection._is_busy_only` already parses, and left
    unprefixed. That case must keep testing busy-only: a fleet that is simply
    printing needs no user action, and labelling the clauses would turn each pass
    over a two-model item into a "job waiting" notification.
    """
    reasons = [(model, reason) for model, reason in per_model if reason]
    if not reasons:
        return None
    if len(reasons) == 1:
        return reasons[0][1]

    distinct = list(dict.fromkeys(reason for _model, reason in reasons))
    if len(distinct) == 1:
        return distinct[0]

    if all(PrinterSelection._is_busy_only(reason) for _model, reason in reasons):
        return " | ".join(distinct)

    return "; ".join(f"{model or 'unassigned'}: {reason}" for model, reason in reasons)


def _candidate_model_label(candidates: list[_ModelCandidate]) -> str | None:
    """Human label for the models an item is waiting on ("H2S or H2C").

    Notifications take a single target model. For a cross-model item the item's
    own ``target_model`` is whichever variant happens to be first, which reads as
    a lie once it is the H2C that actually runs — so name all of them.
    """
    models = list(dict.fromkeys(c.target_model for c in candidates if c.target_model))
    if not models:
        return None
    return " or ".join(models)


def _nozzle_info_by_id(status) -> dict[int, dict]:
    """Index the H2 ``nozzle.info`` telemetry by its physical nozzle id."""
    by_id: dict[int, dict] = {}
    for entry in getattr(status, "nozzle_rack", None) or []:
        if not isinstance(entry, dict):
            continue
        try:
            by_id[int(entry.get("id"))] = entry
        except (TypeError, ValueError):
            continue
    return by_id


def _nozzle_is_mounted(entry: dict | None) -> bool:
    """Conservatively determine whether an H2 hotend entry has a nozzle.

    H2 firmware can retain the previous diameter after a hotend has parked its
    nozzle.  Only the explicit ``serial_number=N/A`` plus a zero temperature
    rating identifies that state; incomplete telemetry must remain fail-safe.
    """
    if entry is None:
        return True
    serial = str(entry.get("serial_number") or "").strip().upper()
    if serial != _EMPTY_NOZZLE_SERIAL:
        return True
    try:
        max_temp = float(entry.get("max_temp") or 0)
    except (TypeError, ValueError):
        return True
    return max_temp > 0


def _installed_nozzle_diameters(status) -> list[float]:
    """Parse the mounted hotend diameters from a PrinterState (#1899).

    Returns the diameters the printer actually reports (e.g. [0.4] single-nozzle,
    [0.4, 0.6] dual-nozzle), skipping the empty-string defaults that populate a
    NozzleInfo before MQTT fills it in. An empty list means "the printer hasn't
    told us its nozzle hardware" — callers must treat that as unknown, not as a
    mismatch, so we never block a print on missing data.
    """
    info = _nozzle_info_by_id(status)
    diameters: list[float] = []
    for index, nozzle in enumerate(getattr(status, "nozzles", None) or []):
        raw = getattr(nozzle, "nozzle_diameter", "") or ""
        value = _parse_nozzle_diameter(raw)
        if value is not None and _nozzle_is_mounted(info.get(index)):
            diameters.append(value)
    return diameters


def _rack_nozzle_diameters(status) -> list[float]:
    """Return positive diameters currently parked in H2C rack slots."""
    diameters: list[float] = []
    for nozzle_id, entry in sorted(_nozzle_info_by_id(status).items()):
        if nozzle_id not in _RACK_NOZZLE_IDS:
            continue
        value = _parse_nozzle_diameter(entry.get("diameter") or entry.get("nozzle_diameter"))
        if value is not None:
            diameters.append(value)
    return diameters


def _format_nozzle_diameters(diameters: list[float]) -> str:
    """Format diameters once each, preserving telemetry order."""
    return " / ".join(f"{d:g}mm" for d in dict.fromkeys(diameters))


def _nozzle_mismatch_message(
    sliced_nozzle: float | None,
    installed: list[float],
    rack: list[float] | None = None,
) -> str | None:
    """Return an actionable error message when the sliced nozzle can't be
    printed on any installed nozzle, else None (#1899).

    Fail-safe: returns None whenever we lack the data to judge — no sliced
    diameter, or the printer reported no nozzles — so a print is only ever
    blocked on a POSITIVE mismatch. On dual-nozzle printers a match against
    EITHER installed nozzle passes (a 0.6 slice is fine if one hotend is 0.6).
    The 0.05 tolerance absorbs float noise while staying well inside the 0.2
    gap between adjacent nozzle sizes (0.2/0.4/0.6/0.8).
    """
    reachable = [*installed, *(rack or [])]
    if not sliced_nozzle or not reachable:
        return None
    if any(abs(d - sliced_nozzle) < 0.05 for d in reachable):
        return None
    where = f"{_format_nozzle_diameters(installed)} installed" if installed else "no nozzle mounted"
    if rack:
        where += f" and {_format_nozzle_diameters(rack)} in the nozzle rack"
    return (
        f"File sliced for a {sliced_nozzle:g}mm nozzle, but the printer has "
        f"{where}. Re-slice for an available nozzle, or fit the matching "
        f"nozzle before printing."
    )


@dataclass
class Selection:
    """Each selected job's printer and tray mapping, in selection order, for its dispatch worker."""

    printers: dict[int, int] = field(default_factory=dict)
    mappings: dict[int, str | None] = field(default_factory=dict)
    changed: bool = False  # Resolved candidates or waiting reasons to commit.


async def _wait(db: AsyncSession, item: PrintQueueItem, reason: str) -> None:
    """Show why ``item`` still waits, committing only a change."""
    if item.waiting_reason != reason:
        item.waiting_reason = reason
        await db.commit()


class PrinterSelection:
    """Selects printers for queued jobs; mixed into ``PrintScheduler``."""

    _power_on_wait_time = 180  # seconds to wait for printer after power on (3 min)
    _power_on_check_interval = 10  # seconds between connection checks

    async def _select_printers(
        self,
        db: AsyncSession,
        items: list[PrintQueueItem],
        busy_printers: set[int],
        interlocked: dict[int, str],
        *,
        require_plate_clear: bool,
        sjf_enabled: bool,
        slots: int,
        pool_reason: str,
    ) -> Selection:
        """Choose a printer and tray mapping for each waiting job that can start now.

        Jobs keep no choice: their dispatch workers write it with the hold.
        """
        selection = Selection()
        skipped: Counter[str] = Counter()
        # Queue-only uploads consume their source row after Archive copies
        # exist. Do not let workers dispatch multiple consumers at once.
        # Ordinary user-managed Files may still fan out concurrently.
        dispatch_libs: set[int] = set()
        consumed_libs: set[int] = set()

        def library_row_conflict(candidate: PrintQueueItem) -> bool:
            library_id = candidate.library_file_id
            if library_id is None:
                return False
            if candidate.cleanup_library_after_dispatch:
                return library_id in dispatch_libs
            return library_id in consumed_libs

        def select(candidate: PrintQueueItem, printer_id: int, mapping: str | None) -> None:
            if candidate.library_file_id is not None:
                dispatch_libs.add(candidate.library_file_id)
                if candidate.cleanup_library_after_dispatch:
                    consumed_libs.add(candidate.library_file_id)
            selection.printers[candidate.id] = printer_id
            selection.mappings[candidate.id] = mapping
            busy_printers.add(printer_id)

        def pool_full(candidate: PrintQueueItem) -> bool:
            if len(selection.printers) < slots:
                return False
            if candidate.waiting_reason != pool_reason:
                candidate.waiting_reason = pool_reason
                selection.changed = True
            skipped["upload_pool_full"] += 1
            return True

        async def jumped(candidate: PrintQueueItem, same_queue: Callable[[PrintQueueItem], bool]) -> None:
            """SJF starvation guard: mark the longer jobs ahead of it in its queue."""
            for other in items:
                if (
                    other.id != candidate.id
                    and other.status == "queued"
                    and same_queue(other)
                    and not other.been_jumped
                    and other.position < candidate.position
                    and (other.print_time_seconds is None or other.print_time_seconds > candidate.print_time_seconds)
                ):
                    other.been_jumped = True
            await db.commit()

        for item in items:
            # Check scheduled time first (scheduled_time is stored in UTC from ISO string)
            if item.scheduled_time:
                sched = item.scheduled_time
                if sched.tzinfo is None:
                    sched = sched.replace(tzinfo=timezone.utc)
                if sched > datetime.now(timezone.utc):
                    skipped["scheduled_future"] += 1
                    continue

            # Skip items that require manual start
            if item.manual_start:
                skipped["manual_start"] += 1
                continue

            # A safe-default job without readable per-slot metadata cannot
            # prove material/colour compatibility. Keep it pending rather
            # than silently degrading to the legacy type-only mapper.
            match_preference = getattr(item, "force_color_match", None)
            has_source_row = bool(getattr(item, "archive", None) or getattr(item, "library_file", None))
            metadata_required = match_preference is True or (
                match_preference is False
                and bool(getattr(item, "archive_id", None) or getattr(item, "library_file_id", None))
                and not has_source_row
            )
            if (
                type(match_preference) is bool
                and not getattr(item, "variants", None)
                and metadata_required
                and not self._has_verifiable_filament_metadata(item)
            ):
                await _wait(db, item, "Material/colour metadata unavailable; cannot verify a safe filament match")
                continue

            if item.printer_id:
                sliced_for_model = _sliced_for_model(item.archive, item.library_file)
                waiting_reason = _incompatible_sliced_model_reason(
                    sliced_for_model, item.printer
                ) or _source_nozzle_mismatch(item.archive, item.library_file, item.printer_id)
                if waiting_reason:
                    await _wait(db, item, waiting_reason)
                    skipped["sliced_model_mismatch"] += 1
                    continue
                if item.waiting_reason and item.waiting_reason.startswith("Incompatible sliced file:"):
                    item.waiting_reason = None
                    await db.commit()

                interlock_reason = interlocked.get(item.printer_id)
                if interlock_reason:
                    await _wait(db, item, f"Waiting on {interlock_reason}")
                    skipped["sensor_interlock"] += 1
                    continue

                # Only clear a reason previously written by this
                # interlock. Preserve unrelated queue explanations such
                # as filament shortages and drying holds for the gates
                # below to maintain.
                cleared_sensor_interlock_reason = bool(
                    item.waiting_reason and item.waiting_reason.startswith("Waiting on ")
                )
                if cleared_sensor_interlock_reason:
                    item.waiting_reason = None
                    await db.commit()

                # Specific printer assignment (existing behavior)
                if item.printer_id in busy_printers:
                    if not cleared_sensor_interlock_reason:
                        item.waiting_reason = f"Waiting for printer reservation on printer {item.printer_id}"
                        await db.commit()
                    continue

                # Check if printer is idle
                printer_idle = self._is_printer_idle(item.printer_id, require_plate_clear)
                printer_connected = printer_manager.is_connected(item.printer_id)

                # If printer not connected, try to power on via smart plug
                if not printer_connected:
                    plugs = await self._get_smart_plugs(db, item.printer_id)
                    auto_on_plugs = [p for p in plugs if p.auto_on and p.enabled]
                    if auto_on_plugs:
                        logger.info("Printer %s offline, attempting to power on via smart plug(s)", item.printer_id)
                        # Power on using the plug that actually feeds the printer,
                        # and wait for that plug to boot it (#2629).
                        primary_plug = self._pick_power_plug(auto_on_plugs)
                        powered_on = await self._power_on_and_wait(primary_plug, item.printer_id, db)
                        if powered_on:
                            # Also turn on any remaining auto_on plugs (e.g., filter)
                            for extra_plug in [p for p in auto_on_plugs if p.id != primary_plug.id]:
                                try:
                                    service = await smart_plug_manager.get_service_for_plug(extra_plug, db)
                                    await service.turn_on(extra_plug)
                                    logger.info(
                                        "Also powered on plug '%s' for printer %s", extra_plug.name, item.printer_id
                                    )
                                except Exception as e:
                                    logger.warning("Failed to power on extra plug '%s': %s", extra_plug.name, e)
                            printer_connected = True
                            printer_idle = self._is_printer_idle(item.printer_id, require_plate_clear)
                        else:
                            logger.warning("Could not power on printer %s via smart plug", item.printer_id)
                            busy_printers.add(item.printer_id)
                            continue
                    else:
                        # No plug or auto_on disabled
                        busy_printers.add(item.printer_id)
                        continue

                # Check if printer is idle (busy with another print)
                if not printer_idle:
                    if not cleared_sensor_interlock_reason:
                        item.waiting_reason = f"Waiting for printer reservation on printer {item.printer_id}"
                    busy_printers.add(item.printer_id)
                    await db.commit()
                    continue

                # Printer-targeted jobs must honour the same exact-colour
                # contract as model-assigned jobs. Without this gate the
                # normal AMS mapper can fall back to a same-material,
                # different-colour tray and silently print the wrong colour.
                filament_overrides = self._get_filament_overrides(item)
                required_materials = sorted(
                    {override["type"] for override in filament_overrides if override.get("type")}
                )
                if required_materials:
                    missing_materials = self._get_missing_filament_types(item.printer_id, required_materials)
                    if missing_materials:
                        await _wait(db, item, f"No matching material. Waiting on {', '.join(missing_materials)}")
                        continue

                force_overrides = [override for override in filament_overrides if override.get("force_color_match")]
                if force_overrides:
                    missing_colors = self._get_missing_force_color_slots(item.printer_id, force_overrides)
                    if missing_colors:
                        await _wait(db, item, self._force_color_waiting_reason(missing_colors))
                        logger.info(
                            "Queue item %s blocked on printer %s by force-colour mismatch: %s",
                            item.id,
                            item.printer_id,
                            missing_colors,
                        )
                        continue
                    if item.waiting_reason:
                        item.waiting_reason = None
                        await db.commit()

                mapped, bound_mapping = await self._bind_mapping(
                    db, item, item.printer_id, filament_overrides, force_overrides
                )
                if not mapped:
                    continue

                # Filament-deficit pre-dispatch check (#1496). If the
                # assigned spool can't satisfy any required slot grams,
                # promote the item to manual_start so the user must
                # acknowledge via the ▶ button (which re-checks live).
                if await self._block_on_filament_deficit(
                    db, item, printer_id=item.printer_id, ams_mapping=bound_mapping
                ):
                    continue

                # Apply drying policy only after every other dispatch gate
                # has passed. Drying is orthogonal to gcode state (often
                # still IDLE), so this uses canonical AMS telemetry rather
                # than scheduler-owned auto-drying bookkeeping.
                if not await self._prepare_drying_for_dispatch(db, item, item.printer_id):
                    busy_printers.add(item.printer_id)
                    continue

                if pool_full(item):
                    continue

                # Queue-only sources are shared by one queue fan-out. Hold
                # a conflicting item for the next pass so this source is
                # not removed until every consumer has an Archive copy.
                if library_row_conflict(item):
                    skipped["library_row_in_use"] += 1
                    busy_printers.add(item.printer_id)
                    continue

                if item.waiting_reason and (
                    item.waiting_reason.startswith("Waiting for printer reservation")
                    or item.waiting_reason.startswith(_UPLOAD_POOL_WAITING_PREFIX)
                ):
                    item.waiting_reason = None
                    selection.changed = True
                select(item, item.printer_id, bound_mapping)
                if sjf_enabled and item.print_time_seconds is not None:
                    await jumped(item, lambda other, job=item: other.printer_id == job.printer_id)

            elif item.target_model or getattr(item, "variants", None):
                # Model-based assignment - find any idle printer of matching model.
                # A plain model-based item has exactly one candidate, built from
                # its own columns. A cross-model item (#671) has one per sliced
                # variant and takes the first that matches, walking them in the
                # user's priority order so the pick is reproducible when more
                # than one printer is free in the same pass.
                candidates = _candidates_for(item)
                printer_id = None
                chosen: _ModelCandidate | None = None
                per_model_reasons: list[tuple[str | None, str]] = []

                if not candidates:
                    # Every candidate file has been deleted or trashed out from
                    # under this item. Hold it with something the user can act
                    # on rather than letting it look dispatchable forever.
                    per_model_reasons.append(
                        (
                            item.target_model,
                            "Every file for this job has been deleted — add a file back or remove the item",
                        )
                    )

                for candidate in candidates:
                    # Parse required filament types if present
                    required_types = None
                    if candidate.required_filament_types:
                        try:
                            required_types = json.loads(candidate.required_filament_types)
                        except json.JSONDecodeError:
                            pass  # Ignore malformed filament types; treat as no constraint

                    # Parse filament overrides if present
                    filament_overrides = None
                    if candidate.filament_overrides:
                        try:
                            filament_overrides = json.loads(candidate.filament_overrides)
                        except json.JSONDecodeError:
                            pass

                    # If overrides exist, use override types for validation instead
                    effective_types = required_types
                    if filament_overrides:
                        override_types = sorted({o["type"] for o in filament_overrides if "type" in o})
                        if override_types:
                            # Merge: keep original types for non-overridden slots, add override types
                            effective_types = sorted(set(required_types or []) | set(override_types))

                    # Cross-model safety gate (#2578): never hand a 3MF sliced
                    # for an incompatible model to a printer, no matter how the
                    # row got into the DB (old rows, direct API writes). Held
                    # as pending with an actionable waiting_reason — the user
                    # fixes it by editing the item's target model.
                    if not is_gcode_compatible(candidate.sliced_for, candidate.target_model):
                        per_model_reasons.append(
                            (
                                candidate.target_model,
                                f"File was sliced for {candidate.sliced_for}, which is not compatible with "
                                f"{candidate.target_model} — edit the item and fix its target model",
                            )
                        )
                        skipped["sliced_model_mismatch"] += 1
                        continue

                    excluded = busy_printers | set(interlocked)
                    nozzle_reason = None
                    while True:
                        match_id, match_reason = await self._find_idle_printer_for_model(
                            db,
                            candidate.target_model,
                            excluded,
                            effective_types,
                            item.target_location,
                            filament_overrides=filament_overrides,
                            require_plate_clear=require_plate_clear,
                        )
                        if not match_id or match_id in excluded:
                            match_id = None
                            match_reason = nozzle_reason or match_reason
                            break
                        nozzle_reason = _source_nozzle_mismatch(
                            None if candidate.variant else item.archive,
                            candidate.variant.library_file if candidate.variant else item.library_file,
                            match_id,
                        )
                        if not nozzle_reason:
                            break
                        excluded.add(match_id)
                    if match_id:
                        printer_id = match_id
                        chosen = candidate
                        break
                    per_model_reasons.append((candidate.target_model, match_reason or ""))

                waiting_reason = None if printer_id else _collapse_waiting_reasons(per_model_reasons)

                # Fold the winning variant's file and settings onto the item
                # before anything else looks at them — the guards below and
                # every step of the dispatch read the item's own columns.
                if chosen is not None:
                    self._resolve_variant(item, chosen)
                    selection.changed = selection.changed or chosen.variant is not None

                # The selected variant carries its own filament contract.
                # Re-read it after resolving so the dispatch gates below
                # cannot accidentally use the last candidate inspected.
                filament_overrides = self._get_filament_overrides(item)
                force_overrides = [override for override in filament_overrides if override.get("force_color_match")]

                # Update waiting_reason if changed and send notification when first waiting
                if item.waiting_reason != waiting_reason:
                    was_waiting = item.waiting_reason is not None
                    item.waiting_reason = waiting_reason
                    await db.commit()

                    # Send waiting notification only when transitioning to waiting state
                    # and the reason requires user action (not just "all printers busy")
                    if waiting_reason and not was_waiting and not self._is_busy_only(waiting_reason):
                        job_name = await self._get_job_name(db, item)
                        await notification_service.on_queue_job_waiting(
                            job_name=job_name,
                            target_model=_candidate_model_label(candidates) or item.target_model,
                            waiting_reason=waiting_reason,
                            db=db,
                        )

                if printer_id:
                    if pool_full(item):
                        continue

                    # Re-read under a write lock before assigning a model job.
                    # A different scheduler may already have reserved this row.
                    if getattr(item, "chamber_heat_soak", False) is True:
                        item = await lock_queue_item(db, item.id)
                        if not item or item.status != "queued":
                            await db.rollback()
                            continue

                    # The job stays in the pool: its printer and tray mapping
                    # are bound only when the dispatch worker moves it out of
                    # `queued`. A deferred attempt leaves no printer behind.
                    item.waiting_reason = None
                    logger.info("Model-based selection: queue item %s selected printer %s", item.id, printer_id)

                    # A model-targeted item can carry an AMS mapping supplied before
                    # its eventual printer is known. Validate that mapping against the
                    # selected printer just as we do for printer-targeted jobs: opting
                    # out of exact colour matching must never permit a different
                    # material family.
                    mapped, bound_mapping = await self._bind_mapping(
                        db, item, printer_id, filament_overrides, force_overrides
                    )
                    if not mapped:
                        continue

                    # Filament-deficit pre-dispatch check (#1496), against the
                    # selected printer's trays.
                    if await self._block_on_filament_deficit(
                        db, item, printer_id=printer_id, ams_mapping=bound_mapping
                    ):
                        continue

                    if not await self._prepare_drying_for_dispatch(db, item, printer_id):
                        busy_printers.add(printer_id)
                        continue

                    if library_row_conflict(item):
                        skipped["library_row_in_use"] += 1
                        continue

                    select(item, printer_id, bound_mapping)
                    if sjf_enabled and item.print_time_seconds is not None:
                        await jumped(
                            item,
                            lambda other, job=item: (
                                other.printer_id is None
                                and other.target_model
                                and other.target_model.upper() == job.target_model.upper()
                            ),
                        )

        # Log summary of skip reasons (helps diagnose why queue items aren't starting)
        if skipped:
            logger.info("Queue skip summary: %s", dict(skipped))
        return selection

    async def _bind_mapping(
        self,
        db: AsyncSession,
        item: PrintQueueItem,
        printer_id: int,
        overrides: list[dict],
        force_overrides: list[dict],
    ) -> tuple[bool, str | None]:
        """The tray mapping ``item`` will be sent with on ``printer_id``, or False while forced colours can't map.

        The scheduler never overwrites a waiting job's mapping, so a tray edit
        made meanwhile is not lost; the worker writes this one with the hold.
        """
        mapping = item.ams_mapping
        material_safe = self._ams_mapping_uses_compatible_materials(printer_id, item.ams_mapping, overrides)
        # Recompute forced jobs even with a stored mapping, so the tray also has the required colour.
        if force_overrides or not item.ams_mapping or not material_safe:
            computed = await self._compute_ams_mapping_for_printer(db, printer_id, item)
            missing = self._get_missing_force_mapping_slots(computed, force_overrides)
            if missing:
                item.waiting_reason = self._force_color_waiting_reason(missing)
                await db.commit()
                return False, None
            if computed:
                mapping = json.dumps(computed)
                logger.info("Queue item %s: Computed AMS mapping for printer %s: %s", item.id, printer_id, computed)
        return True, mapping

    async def _find_idle_printer_for_model(
        self,
        db: AsyncSession,
        model: str,
        exclude_ids: set[int],
        required_filament_types: list[str] | None = None,
        target_location: str | None = None,
        filament_overrides: list[dict] | None = None,
        require_plate_clear: bool = True,
    ) -> tuple[int | None, str | None]:
        """Find an idle, connected printer matching the model with compatible filaments.

        Args:
            db: Database session
            model: Printer model to match (e.g., "X1C", "P1S")
            exclude_ids: Printer IDs to exclude (already busy)
            required_filament_types: Optional list of filament types needed (e.g., ["PLA", "PETG"])
                                     If provided, only printers with all required types loaded will match.
            target_location: Optional location filter. If provided, only printers in this location are considered.
            filament_overrides: Optional list of override dicts. Each entry may include
                                 ``force_color_match: true`` to require an exact type+color match
                                 on the printer for that slot. Without the flag the existing
                                 colour-preference logic applies.

        Returns:
            Tuple of (printer_id, waiting_reason):
            - (printer_id, None) if a matching printer was found
            - (None, reason) if no printer is available, with explanation
        """
        # Normalize model name and use case-insensitive matching
        normalized_model = normalize_printer_model(model) or model
        query = (
            select(Printer)
            .where(func.lower(Printer.model) == normalized_model.lower())
            .where(Printer.is_active == True)  # noqa: E712
        )

        # Add location filter if specified
        if target_location:
            query = query.where(Printer.location == target_location)

        result = await db.execute(query)
        printers = list(result.scalars().all())

        location_suffix = f" in {target_location}" if target_location else ""
        if not printers:
            return None, f"No active {normalized_model} printers{location_suffix} configured"

        # Separate force-matched overrides from preference-only overrides
        force_overrides = [o for o in (filament_overrides or []) if o.get("force_color_match")]
        pref_overrides = [o for o in (filament_overrides or []) if not o.get("force_color_match")]

        # Track reasons for skipping printers
        printers_busy = []
        printers_offline = []
        printers_missing_filament: list[tuple[str, list[str]]] = []
        candidates: list[tuple[int, int]] = []  # (printer_id, color_match_count)

        for printer in printers:
            if printer.id in exclude_ids:
                # Printer is already claimed by another job in this scheduling run.
                # For force-color jobs, still check if the color would match — if not,
                # report it as a color mismatch rather than plain "Busy" so the user
                # knows the job needs a filament change, not just to wait for availability.
                if force_overrides and not pref_overrides:
                    missing_colors = self._get_missing_force_color_slots(printer.id, force_overrides)
                    if missing_colors:
                        printers_missing_filament.append((printer.name, missing_colors))
                        continue
                printers_busy.append(printer.name)
                continue

            is_connected = printer_manager.is_connected(printer.id)
            is_idle = self._is_printer_idle(printer.id, require_plate_clear) if is_connected else False

            if not is_connected:
                printers_offline.append(printer.name)
                continue

            if not is_idle:
                # Printer is currently printing.  For force-color jobs, check whether the
                # loaded color would satisfy the requirement — if not, surface it as a
                # color-mismatch reason rather than plain "Busy" so the user understands
                # that the job is waiting for a filament change, not just printer availability.
                if force_overrides and not pref_overrides:
                    missing_colors = self._get_missing_force_color_slots(printer.id, force_overrides)
                    if missing_colors:
                        printers_missing_filament.append((printer.name, missing_colors))
                        logger.debug(
                            "Printer %s (%s) is busy but also has wrong force-color: %s",
                            printer.id,
                            printer.name,
                            missing_colors,
                        )
                        continue
                printers_busy.append(printer.name)
                continue

            # Validate filament compatibility if required types are specified
            if required_filament_types:
                missing = self._get_missing_filament_types(printer.id, required_filament_types)
                if missing:
                    # When force_overrides are present, enrich missing entries with color info
                    # so the "Waiting on" message includes "TYPE (color)" instead of just "TYPE"
                    if force_overrides:
                        force_color_map = {
                            (o.get("type") or "").upper(): o.get("color_name") or o.get("color", "?")
                            for o in force_overrides
                        }
                        missing_enriched = [
                            f"{t} ({force_color_map[t_upper]})" if (t_upper := t.upper()) in force_color_map else t
                            for t in missing
                        ]
                        printers_missing_filament.append((printer.name, missing_enriched))
                    else:
                        printers_missing_filament.append((printer.name, missing))
                    logger.debug("Skipping printer %s (%s) - missing filaments: %s", printer.id, printer.name, missing)
                    continue

            # Force color match: ALL flagged slots must have an exact type+color match
            if force_overrides:
                missing_colors = self._get_missing_force_color_slots(printer.id, force_overrides)
                if missing_colors:
                    printers_missing_filament.append((printer.name, missing_colors))
                    logger.debug(
                        "Skipping printer %s (%s) - missing force-matched colors: %s",
                        printer.id,
                        printer.name,
                        missing_colors,
                    )
                    continue

            # If preference-only overrides exist, rank by color matches (existing behaviour)
            if pref_overrides:
                color_matches = self._count_override_color_matches(printer.id, pref_overrides)
                # An unchecked match option makes colour a preference, not a
                # dispatch requirement. Material compatibility was validated
                # above; keep every eligible printer and rank exact colours
                # ahead of other same-material shades.
                candidates.append((printer.id, color_matches))
            elif force_overrides:
                # Passed all force checks — immediately eligible (no preference ordering needed)
                return printer.id, None
            else:
                # No overrides at all - take first available (existing behavior)
                return printer.id, None

        # If we have candidates from preference override matching, pick the one with most color matches
        if candidates:
            candidates.sort(key=lambda c: c[1], reverse=True)
            return candidates[0][0], None

        # Build waiting reason from what we found
        reasons = []
        if printers_missing_filament:
            # Filament/color mismatch is most actionable - show first
            if force_overrides and not pref_overrides:
                # All mismatches are force-color failures — use descriptive message only;
                # but only if there are no busy printers that DO have the matching color.
                # If a printer has the right color but is busy, surface "Busy" instead so
                # the user knows the job will start automatically once that printer is free.
                if not printers_busy:
                    all_missing = sorted({c for _, cols in printers_missing_filament for c in cols})
                    return None, f"No matching material/colour. Waiting on {', '.join(all_missing)}"
                # else: fall through — printers_busy will be appended below
            else:
                names_and_missing = [
                    f"{name} (needs {', '.join(missing)})" for name, missing in printers_missing_filament
                ]
                reasons.append(f"Waiting for filament: {'; '.join(names_and_missing)}")
        if printers_busy:
            reasons.append(f"Busy: {', '.join(printers_busy)}")
        if printers_offline:
            reasons.append(f"Offline: {', '.join(printers_offline)}")

        return None, " | ".join(reasons) if reasons else f"No available {model} printers{location_suffix}"

    @staticmethod
    def _is_busy_only(waiting_reason: str) -> bool:
        """Check if the waiting reason only contains 'Busy' entries.

        When all matching printers are simply busy printing, the queued job
        will start automatically once a printer finishes — no user action
        is required, so we skip the notification.
        """
        parts = [p.strip() for p in waiting_reason.split(" | ")]
        return all(p.startswith("Busy:") for p in parts)

    def _get_missing_force_color_slots(self, printer_id: int, force_overrides: list[dict]) -> list[str]:
        """Return descriptive strings for force_color_match slots not satisfied by the printer.

        Each entry in ``force_overrides`` must have ``type`` and ``color`` fields and is expected
        to carry ``force_color_match: True``.  The printer must have **every** such slot loaded
        with an exact type+color match.

        Returns:
            List of ``"TYPE (color)"`` strings for unmatched slots (empty list means all match).
        """
        status = printer_manager.get_status(printer_id)
        if not status:
            return [f"{o.get('type', '?')} ({o.get('color_name') or o.get('color', '?')})" for o in force_overrides]

        # Build set of loaded type+colour pairs from AMS and external spool
        loaded: set[tuple[str, str]] = set()
        for ams_unit in status.raw_data.get("ams", []):
            for tray in ams_unit.get("tray", []):
                tray_type = tray.get("tray_type")
                tray_color = tray.get("tray_color", "")
                if tray_type:
                    color_norm = tray_color.replace("#", "").lower()[:6]
                    loaded.add((tray_type.strip().upper(), color_norm))
        for vt in status.raw_data.get("vt_tray") or []:
            vt_type = vt.get("tray_type")
            if vt_type:
                color_norm = (vt.get("tray_color", "") or "").replace("#", "").lower()[:6]
                loaded.add((vt_type.strip().upper(), color_norm))

        missing = []
        for o in force_overrides:
            o_type = (o.get("type") or "").strip().upper()
            o_color = (o.get("color") or "").replace("#", "").lower()[:6]
            if (o_type, o_color) not in loaded:
                color_label = o.get("color_name") or o.get("color", "?")
                missing.append(f"{o_type} ({color_label})")
        return missing

    @staticmethod
    def _has_verifiable_filament_metadata(item: PrintQueueItem) -> bool:
        """Return whether a safe-default job has usable per-slot requirements."""
        if not item.filament_overrides:
            return False
        try:
            overrides = json.loads(item.filament_overrides)
        except (json.JSONDecodeError, TypeError):
            return False
        return (
            bool(overrides)
            and isinstance(overrides, list)
            and all(
                isinstance(override, dict)
                and isinstance(override.get("slot_id"), int)
                and bool(override.get("type"))
                and bool(override.get("color"))
                for override in overrides
            )
        )

    @staticmethod
    def _force_color_waiting_reason(missing_colors: list[str]) -> str:
        return f"No matching material/colour. Waiting on {', '.join(sorted(set(missing_colors)))}"

    def _get_missing_filament_types(self, printer_id: int, required_types: list[str]) -> list[str]:
        """Get the list of required filament types that are not loaded on the printer.

        Args:
            printer_id: The printer ID
            required_types: List of filament types needed (e.g., ["PLA", "PETG"])

        Returns:
            List of missing filament types (empty if all are loaded)
        """
        status = printer_manager.get_status(printer_id)
        if not status:
            return required_types  # Can't determine, assume all missing

        # Collect all filament types loaded on this printer (AMS units + external spool)
        # Use canonical types so equivalence groups (e.g. PA-CF/PA12-CF/PAHT-CF) match.
        loaded_types: set[str] = set()

        # Check AMS units (stored in raw_data["ams"])
        ams_data = status.raw_data.get("ams", [])
        if ams_data:
            for ams_unit in ams_data:
                for tray in ams_unit.get("tray", []):
                    tray_type = tray.get("tray_type")
                    if tray_type:
                        loaded_types.add(canonical_filament_type(tray_type))

        # Check external spool(s) (virtual tray, stored in raw_data["vt_tray"] as list)
        for vt in status.raw_data.get("vt_tray") or []:
            vt_type = vt.get("tray_type")
            if vt_type:
                loaded_types.add(canonical_filament_type(vt_type))

        # Find which required types are missing (using canonical type for equivalence)
        missing = []
        for req_type in required_types:
            if canonical_filament_type(req_type) not in loaded_types:
                missing.append(req_type)

        return missing

    def _count_override_color_matches(self, printer_id: int, overrides: list[dict]) -> int:
        """Count how many filament overrides have an exact color match on the printer.

        Used to prefer printers that already have the desired override colors loaded.
        """
        status = printer_manager.get_status(printer_id)
        if not status:
            return 0

        # Collect loaded filaments' type+color pairs
        loaded: set[tuple[str, str]] = set()
        for ams_unit in status.raw_data.get("ams", []):
            for tray in ams_unit.get("tray", []):
                tray_type = tray.get("tray_type")
                tray_color = tray.get("tray_color", "")
                if tray_type:
                    color_norm = tray_color.replace("#", "").lower()[:6]
                    loaded.add((tray_type.upper(), color_norm))
        for vt in status.raw_data.get("vt_tray") or []:
            vt_type = vt.get("tray_type")
            if vt_type:
                color_norm = (vt.get("tray_color", "") or "").replace("#", "").lower()[:6]
                loaded.add((vt_type.upper(), color_norm))

        matches = 0
        for o in overrides:
            o_type = (o.get("type") or "").upper()
            o_color = (o.get("color") or "").replace("#", "").lower()[:6]
            if (o_type, o_color) in loaded:
                matches += 1
        return matches

    def _resolve_variant(self, item: PrintQueueItem, candidate: _ModelCandidate) -> None:
        """Fold the winning candidate's file and settings onto the queue row (#671).

        This is the whole trick that keeps cross-model items cheap: the many-to-many
        never escapes the selection loop. By the time the pass commits, the row
        looks exactly like an ordinary single-file model-based item, so the upload,
        archive creation, expected-print registration, print history and reprint
        paths need no knowledge that variants exist.

        No-ops for a non-variant candidate, which is already the item's own columns.

        Safe to run and re-run: the item's file columns are only ever *read* when it
        has no variants, so an item that gets resolved and then skipped (library-row
        conflict, previous-print gate) is simply resolved again on the next pass.
        """
        variant = candidate.variant
        if variant is None:
            return

        item.library_file_id = variant.library_file_id
        item.library_file = variant.library_file
        # The dispatcher checks archive_id first and would print that instead of
        # the file we just picked. Creation refuses to combine the two, so this
        # only ever fires on a hand-written row — clear it rather than silently
        # dispatch something the matcher never considered.
        item.archive_id = None
        item.archive = None

        item.target_model = variant.target_model
        item.plate_id = variant.plate_id
        item.ams_mapping = variant.ams_mapping
        item.nozzle_mapping = variant.nozzle_mapping
        item.filament_overrides = variant.filament_overrides
        item.required_filament_types = variant.required_filament_types
        if variant.print_time_seconds is not None:
            # The row carried the shortest candidate's estimate so SJF could order
            # it before a printer was known; now that one is chosen, record what is
            # actually going to run so history and the ETA agree with reality.
            item.print_time_seconds = variant.print_time_seconds

    async def _get_smart_plugs(self, db: AsyncSession, printer_id: int) -> list[SmartPlug]:
        """Get all smart plugs associated with a printer."""
        result = await db.execute(select(SmartPlug).where(SmartPlug.printer_id == printer_id))
        return list(result.scalars().all())

    @staticmethod
    def _pick_power_plug(auto_on_plugs: list[SmartPlug]) -> SmartPlug:
        """Pick the auto-on plug that actually feeds the printer (#2629)."""
        for plug in auto_on_plugs:
            if plug.controls_printer_power:
                return plug
        # Preserve the pre-#2629 fallback for legacy rows with no flag.
        return auto_on_plugs[0]

    async def _power_on_and_wait(self, plug: SmartPlug, printer_id: int, db: AsyncSession) -> bool:
        """Turn on smart plug and wait for printer to connect.

        Returns True if printer connected successfully within timeout.
        """
        # Get the appropriate service for the plug type (Tasmota or Home Assistant)
        service = await smart_plug_manager.get_service_for_plug(plug, db)

        # Check current plug state
        status = await service.get_status(plug)
        if not status.get("reachable"):
            logger.warning("Smart plug '%s' is not reachable", plug.name)
            return False

        # Turn on if not already on
        if status.get("state") != "ON":
            success = await service.turn_on(plug)
            if not success:
                logger.warning("Failed to turn on smart plug '%s'", plug.name)
                return False
            logger.info("Powered on smart plug '%s' for printer %s", plug.name, printer_id)

        # Get printer from database for connection
        result = await db.execute(select(Printer).where(Printer.id == printer_id))
        printer = result.scalar_one_or_none()
        if not printer:
            logger.error("Printer %s not found in database", printer_id)
            return False

        # Wait for printer to boot (give it some time before trying to connect)
        logger.info("Waiting 30s for printer %s to boot...", printer_id)
        await asyncio.sleep(30)

        # Try to connect to the printer periodically
        elapsed = 30  # Already waited 30s
        while elapsed < self._power_on_wait_time:
            # Try to connect
            logger.info("Attempting to connect to printer %s...", printer_id)
            try:
                connected = await printer_manager.connect_printer(printer)
                if connected:
                    logger.info("Printer %s connected after %ss", printer_id, elapsed)
                    # Give it a moment to stabilize and get status
                    await asyncio.sleep(5)
                    return True
            except Exception as e:
                logger.debug("Connection attempt failed: %s", e)

            await asyncio.sleep(self._power_on_check_interval)
            elapsed += self._power_on_check_interval
            logger.debug("Waiting for printer %s to connect... (%ss)", printer_id, elapsed)

        logger.warning("Printer %s did not connect within %ss after power on", printer_id, self._power_on_wait_time)
        return False

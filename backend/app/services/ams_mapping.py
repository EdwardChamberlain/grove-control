"""AMS tray mapping (#204): which loaded tray feeds each sliced filament slot of a queue job.

Printer selection maps a job when it selects a printer for it.
"""

import json
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.core.config import settings
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.settings import bool_setting
from backend.app.models.spool_assignment import SpoolAssignment
from backend.app.models.spoolman_slot_assignment import SpoolmanSlotAssignment
from backend.app.services.filament_requirements import canonical_filament_type, extract_filament_requirements
from backend.app.services.printer_manager import printer_manager

logger = logging.getLogger(__name__)


def unresolved(mapping: list | str | None) -> bool:
    """Whether a tray mapping maps no slot to a tray: a stored [-1] is an artifact, never the external spool (#2589).

    Padding -1s beside a mapped slot, and an explicit external spool (254 and up), are resolved.
    """
    if isinstance(mapping, str):
        try:
            mapping = json.loads(mapping)
        except ValueError:
            return False
    return (
        bool(mapping)
        and isinstance(mapping, list)
        and all(tray is None or (isinstance(tray, int) and tray < 0) for tray in mapping)
    )


class AmsMapping:
    """Maps a queue job's filaments to a printer's trays."""

    _get_bool_setting = staticmethod(bool_setting)

    @staticmethod
    def _get_filament_overrides(item: PrintQueueItem) -> list[dict]:
        """Parse valid per-slot filament requirements persisted on a queue item."""
        if not item.filament_overrides:
            return []
        try:
            overrides = json.loads(item.filament_overrides)
        except (json.JSONDecodeError, TypeError):
            return []
        if not isinstance(overrides, list):
            return []
        queue_default = getattr(item, "force_color_match", True) is not False
        normalized = []
        for override in overrides:
            if not isinstance(override, dict):
                continue
            slot_preference = override.get("force_color_match", queue_default)
            # Legacy or externally-written rows may contain null/string/int
            # values. Only a literal boolean is authoritative; malformed
            # values inherit the queue-level safe default.
            if type(slot_preference) is not bool:
                slot_preference = queue_default
            normalized.append({**override, "force_color_match": slot_preference})
        return normalized

    @classmethod
    def _get_force_color_overrides(cls, item: PrintQueueItem) -> list[dict]:
        """Parse the exact-colour requirements persisted on a queue item."""
        return [override for override in cls._get_filament_overrides(item) if override.get("force_color_match")]

    def _ams_mapping_uses_compatible_materials(
        self,
        printer_id: int,
        raw_mapping: str | None,
        overrides: list[dict],
    ) -> bool:
        """Validate a client-supplied AMS mapping against required material families."""
        if not overrides:
            return True
        try:
            mapping = json.loads(raw_mapping) if raw_mapping else None
        except (json.JSONDecodeError, TypeError):
            return False
        if not isinstance(mapping, list):
            return False

        status = printer_manager.get_status(printer_id)
        if not status:
            return False
        loaded_by_id = {
            filament.get("global_tray_id"): filament.get("type", "")
            for filament in self._build_loaded_filaments(status)
        }
        for override in overrides:
            slot_id = override.get("slot_id")
            if not isinstance(slot_id, int) or slot_id <= 0 or slot_id > len(mapping):
                return False
            loaded_type = loaded_by_id.get(mapping[slot_id - 1])
            if not loaded_type or canonical_filament_type(loaded_type) != canonical_filament_type(
                override.get("type") or ""
            ):
                return False
        return True

    @staticmethod
    def _get_missing_force_mapping_slots(mapping: list[int] | None, force_overrides: list[dict]) -> list[str]:
        """Return forced slots that did not receive an exact-colour AMS mapping."""
        missing = []
        for override in force_overrides:
            slot_id = override.get("slot_id")
            mapped_tray = (
                mapping[slot_id - 1] if isinstance(slot_id, int) and mapping and slot_id <= len(mapping) else -1
            )
            if mapped_tray < 0:
                missing.append(
                    f"{(override.get('type') or '').strip().upper()} "
                    f"({override.get('color_name') or override.get('color', '?')})"
                )
        return missing

    async def _compute_ams_mapping_for_printer(
        self, db: AsyncSession, printer_id: int, item: PrintQueueItem
    ) -> list[int] | None:
        """A tray mapping for ``item`` on ``printer_id``, from its sliced filaments and the printer's trays, or None."""
        # Get printer status
        status = printer_manager.get_status(printer_id)
        if not status:
            logger.warning("Cannot compute AMS mapping: printer %s status unavailable", printer_id)
            return None

        # Filament Track Switch (FTS): when installed it routes any AMS slot to
        # either extruder, so the per-nozzle hard filter below must NOT apply.
        # Otherwise a print on one nozzle can't use a spool physically loaded in
        # an AMS on the *other* nozzle, and the matcher falls through to a
        # same-type wrong-colour spool on the target nozzle — the H2C + FTS
        # wrong-filament bug (#2186). Mirrors the frontend skip added for #1162.
        fts_installed = bool(getattr(getattr(status, "fila_switch", None), "installed", False))

        # Get filament requirements from source file
        filament_reqs = await self._get_filament_requirements(db, item)
        if not filament_reqs:
            # When the 3MF can't be read but persisted overrides are present,
            # build a direct mapping from them. Exact-colour flags stay strict;
            # preference-only entries still enforce the material family.
            if item.filament_overrides:
                try:
                    overrides = self._get_filament_overrides(item)
                    if overrides:
                        logger.info(
                            "Queue item %s: No filament reqs from 3MF; building AMS mapping from %d "
                            "persisted override(s)",
                            item.id,
                            len(overrides),
                        )
                        return self._build_override_direct_mapping(overrides, status)
                except (json.JSONDecodeError, KeyError, TypeError) as e:
                    logger.warning("Queue item %s: Override fallback mapping failed: %s", item.id, e)
            logger.debug("No filament requirements found for queue item %s", item.id)
            return None

        # Apply filament overrides if present. Forced slots are passed into the
        # matcher so they cannot degrade to similar-colour or type-only trays.
        force_color_slot_ids: set[int] = set()
        if item.filament_overrides:
            try:
                overrides = self._get_filament_overrides(item)
                override_map = {o["slot_id"]: o for o in overrides}
                for req in filament_reqs:
                    if req["slot_id"] in override_map:
                        override = override_map[req["slot_id"]]
                        req["type"] = override["type"]
                        req["color"] = override["color"]
                        if override.get("force_color_match"):
                            force_color_slot_ids.add(req["slot_id"])
                        # Clear tray_info_idx so matching uses type+color instead of
                        # the original 3MF's tray_info_idx (which would match the old filament)
                        req["tray_info_idx"] = ""
                        logger.debug(
                            "Queue item %s: Override slot %d -> %s %s",
                            item.id,
                            req["slot_id"],
                            override["type"],
                            override["color"],
                        )
            except (json.JSONDecodeError, KeyError, TypeError) as e:
                logger.warning("Failed to apply filament overrides for queue item %s: %s", item.id, e)

        # Build loaded filaments from printer status
        loaded_filaments = self._build_loaded_filaments(status)
        if not loaded_filaments:
            logger.debug("No filaments loaded on printer %s", printer_id)
            return None

        # Check if user prefers lowest remaining filament when multiple spools match
        prefer_lowest = await self._get_bool_setting(db, "prefer_lowest_filament")

        # Gate prefer_lowest on the printer's AMS Filament Backup state (#1766).
        # Without backup, the printer will not switch to a second spool when the
        # picked one runs out — so sorting toward the lowest leaves the print
        # at risk of running dry mid-job. None (unknown / A1 family) preserves
        # today's behaviour intentionally.
        if prefer_lowest and status.ams_filament_backup is False:
            logger.info("[prefer-lowest] skipped (AMS Backup OFF on printer %s)", printer_id)
            prefer_lowest = False

        # When the preference is on, surface Grove Control's inventory-side
        # remaining for each slot that's bound to a tracked spool, so the
        # sort beats the MQTT-only blind spot (#1508). Skip the lookup
        # entirely when the preference is off — no behaviour change for
        # users who haven't opted in.
        inventory_remain_overrides: dict[int, float] | None = None
        if prefer_lowest:
            inventory_remain_overrides = await self._build_inventory_remain_overrides(db, printer_id, loaded_filaments)

        # Compute mapping: match required filaments to available slots
        match_kwargs = {"strict_color_slot_ids": force_color_slot_ids} if force_color_slot_ids else {}
        return self._match_filaments_to_slots(
            filament_reqs,
            loaded_filaments,
            prefer_lowest,
            inventory_remain_overrides,
            **match_kwargs,
            fts_installed=fts_installed,
        )

    def _build_override_direct_mapping(self, overrides: list[dict], status) -> list[int] | None:
        """A mapping from the job's stored overrides alone, for when its 3MF can't be read; None with no trays."""
        loaded = self._build_loaded_filaments(status)
        if not loaded:
            return None

        reqs = [
            {
                "slot_id": o["slot_id"],
                "type": o.get("type", ""),
                "color": o.get("color", ""),
                "tray_info_idx": "",
            }
            for o in overrides
        ]
        fts_installed = bool(getattr(getattr(status, "fila_switch", None), "installed", False))
        return self._match_filaments_to_slots(
            reqs,
            loaded,
            strict_color_slot_ids={
                o["slot_id"] for o in overrides if o.get("force_color_match") and isinstance(o.get("slot_id"), int)
            },
            fts_installed=fts_installed,
        )

    async def _get_filament_requirements(self, db: AsyncSession, item: PrintQueueItem) -> list[dict] | None:
        """The per-slot filament requirements of ``item``'s source 3MF, or None."""
        source = None
        if item.archive_id:
            source = (
                await db.execute(select(PrintArchive).where(PrintArchive.id == item.archive_id))
            ).scalar_one_or_none()
        elif item.library_file_id:
            query = LibraryFile.active().where(LibraryFile.id == item.library_file_id)
            source = (await db.execute(query)).scalar_one_or_none()
        if source is None:
            return None
        # An absolute (external library) path replaces the base directory.
        return extract_filament_requirements(settings.base_dir / source.file_path, plate_id=item.plate_id) or None

    def _build_loaded_filaments(self, status) -> list[dict]:
        """The printer's loaded AMS trays and external spools, with their global tray ids."""
        filaments = []

        # Get ams_extruder_map for dual-nozzle printers (H2D, H2D Pro)
        ams_extruder_map = status.raw_data.get("ams_extruder_map", {})

        # Parse AMS units from raw_data
        ams_data = status.raw_data.get("ams", [])
        for ams_unit in ams_data:
            ams_id = int(ams_unit.get("id", 0))
            trays = ams_unit.get("tray", [])
            is_ht = len(trays) == 1  # AMS-HT has single tray

            for tray in trays:
                tray_type = tray.get("tray_type")
                if tray_type:
                    tray_id = int(tray.get("id", 0))
                    tray_color = tray.get("tray_color", "")
                    # tray_info_idx identifies the specific spool (e.g., "GFA00", "P4d64437")
                    tray_info_idx = tray.get("tray_info_idx", "")
                    # Normalize color: remove alpha, add hash
                    color = self._normalize_color(tray_color)
                    # Calculate global tray ID
                    # AMS-HT units have IDs starting at 128 with a single tray
                    global_tray_id = ams_id if ams_id >= 128 else ams_id * 4 + tray_id

                    filaments.append(
                        {
                            "type": tray_type,
                            "color": color,
                            "tray_info_idx": tray_info_idx,
                            "ams_id": ams_id,
                            "tray_id": tray_id,
                            "is_ht": is_ht,
                            "is_external": False,
                            "global_tray_id": global_tray_id,
                            "extruder_id": ams_extruder_map.get(str(ams_id)),
                            "remain": tray.get("remain", -1),
                        }
                    )

        # Check external spool(s) (vt_tray is a list)
        for idx, vt in enumerate(status.raw_data.get("vt_tray") or []):
            if vt.get("tray_type"):
                color = self._normalize_color(vt.get("tray_color", ""))
                tray_id = int(vt.get("id", 254))
                filaments.append(
                    {
                        "type": vt["tray_type"],
                        "color": color,
                        "tray_info_idx": vt.get("tray_info_idx", ""),
                        "ams_id": -1,
                        "tray_id": idx,
                        "is_ht": False,
                        "is_external": True,
                        "global_tray_id": tray_id,
                        "extruder_id": (255 - tray_id) if ams_extruder_map else None,
                        "remain": vt.get("remain", -1),
                    }
                )

        return filaments

    def _normalize_color(self, color: str | None) -> str:
        """Normalize color to #RRGGBB format."""
        if not color:
            return "#808080"
        hex_color = color.replace("#", "")[:6]
        return f"#{hex_color}"

    def _normalize_color_for_compare(self, color: str | None) -> str:
        """Normalize color for comparison (lowercase, no hash)."""
        if not color:
            return ""
        return color.replace("#", "").lower()[:6]

    def _colors_are_similar(self, color1: str | None, color2: str | None, threshold: int = 40) -> bool:
        """Check if two colors are visually similar within a threshold."""
        hex1 = self._normalize_color_for_compare(color1)
        hex2 = self._normalize_color_for_compare(color2)
        if not hex1 or not hex2 or len(hex1) < 6 or len(hex2) < 6:
            return False

        try:
            r1 = int(hex1[0:2], 16)
            g1 = int(hex1[2:4], 16)
            b1 = int(hex1[4:6], 16)
            r2 = int(hex2[0:2], 16)
            g2 = int(hex2[2:4], 16)
            b2 = int(hex2[4:6], 16)
            return abs(r1 - r2) <= threshold and abs(g1 - g2) <= threshold and abs(b1 - b2) <= threshold
        except ValueError:
            return False

    async def _build_inventory_remain_overrides(
        self, db: AsyncSession, printer_id: int, loaded: list[dict]
    ) -> dict[int, float]:
        """Remaining grams for AMS slots bound to an inventory spool, Grove's or Spoolman's (#1508).

        The user's inventory beats the firmware's ``remain``, which only RFID spools
        report. Unbound slots and external spools are absent, and fall back to ``remain``.
        """
        if not loaded:
            return {}
        # External / virtual-tray slots are tracked separately from AMS — skip
        # them so a VT-loaded spool doesn't accidentally inherit a tracked
        # AMS binding (the tables use ams_id 254/255 for VT, but the cross
        # match is fiddly and out of scope for this fix).
        tracked_slots = [(f["ams_id"], f["tray_id"], f["global_tray_id"]) for f in loaded if not f.get("is_external")]
        if not tracked_slots:
            return {}

        is_spoolman = await self._is_spoolman_mode(db)
        overrides: dict[int, float] = {}

        if is_spoolman:
            result = await db.execute(
                select(SpoolmanSlotAssignment).where(SpoolmanSlotAssignment.printer_id == printer_id)
            )
            assignments = list(result.scalars().all())
            by_slot = {(a.ams_id, a.tray_id): a.spoolman_spool_id for a in assignments}
            from backend.app.services.filament_deficit import _spoolman_remaining_grams

            for ams_id, tray_id, gtid in tracked_slots:
                spoolman_id = by_slot.get((ams_id, tray_id))
                if spoolman_id is None:
                    continue
                grams = await _spoolman_remaining_grams(spoolman_id)
                if grams is not None:
                    overrides[gtid] = grams
            return overrides

        # Internal inventory mode (default). selectinload matches the pattern
        # used elsewhere (inventory.py, spoolman.py routes) — a single query
        # plus an eager-loaded relationship rather than an explicit join, so
        # the row-attribute shape is exactly what those routes already rely on.
        result = await db.execute(
            select(SpoolAssignment)
            .options(selectinload(SpoolAssignment.spool))
            .where(SpoolAssignment.printer_id == printer_id)
        )
        assignments = list(result.scalars().all())
        by_slot = {(a.ams_id, a.tray_id): a.spool for a in assignments}
        for ams_id, tray_id, gtid in tracked_slots:
            spool = by_slot.get((ams_id, tray_id))
            if spool is None:
                continue
            label = float(spool.label_weight or 0)
            used = float(spool.weight_used or 0)
            overrides[gtid] = max(0.0, label - used)
        return overrides

    @staticmethod
    async def _is_spoolman_mode(db: AsyncSession) -> bool:
        """Whether Spoolman tracks inventory; like ``filament_deficit``'s, false on any error."""
        try:
            from backend.app.api.routes.settings import get_setting

            v = await get_setting(db, "spoolman_enabled")
            return bool(v) and v.lower() == "true"
        except Exception:
            return False

    @staticmethod
    def _slot_priority(ams_id: int | None, tray_id: int | None) -> int:
        """Tie-breaker for the prefer-lowest sort: regular AMS, then AMS-HT, then external, in emission order."""
        if ams_id is None or ams_id < 0:
            return 10_000
        if ams_id >= 128:
            return 1_000 + (ams_id - 128) * 4 + (tray_id or 0)
        return ams_id * 4 + (tray_id or 0)

    @staticmethod
    def _prefer_lowest_sort_key(f: dict, overrides: dict[int, float] | None) -> tuple[int, float, int]:
        """Sort key for Prefer Lowest Remaining Filament: inventory-tracked spools first, then lowest remaining.

        Grams (tracked) and firmware percent (the rest, unknown last) are never
        compared across tiers. Slot position breaks ties.
        """
        gtid = f.get("global_tray_id")
        slot_order = AmsMapping._slot_priority(f.get("ams_id"), f.get("tray_id"))
        if overrides and gtid in overrides:
            return (0, overrides[gtid], slot_order)
        remain = f.get("remain", -1)
        return (1, float(remain) if remain is not None and remain >= 0 else 101.0, slot_order)

    def _match_filaments_to_slots(
        self,
        required: list[dict],
        loaded: list[dict],
        prefer_lowest: bool = False,
        inventory_remain_overrides: dict[int, float] | None = None,
        strict_color_slot_ids: set[int] | None = None,
        fts_installed: bool = False,
    ) -> list[int] | None:
        """An AMS mapping (index slot_id - 1, value global tray id or -1) for the required filaments.

        A tray is chosen by unique ``tray_info_idx``, then exact, similar and type-only colour.
        Another material family, or the wrong nozzle without an FTS, is never used;
        forced slots take only an exact colour.
        """
        if not required:
            return None

        # Track used trays to avoid duplicate assignment
        used_tray_ids: set[int] = set()
        comparisons = []

        for req in required:
            req_type = (req.get("type") or "").upper()
            req_color = req.get("color", "")
            req_tray_info_idx = req.get("tray_info_idx", "")
            strict_color = req.get("slot_id") in (strict_color_slot_ids or set())

            # Find best match: unique tray_info_idx > exact color > similar color > type-only
            idx_match = None
            exact_match = None
            similar_match = None
            type_only_match = None

            # Get available trays (not already used)
            available = [f for f in loaded if f["global_tray_id"] not in used_tray_ids]

            # Nozzle-aware filtering: restrict to trays on the correct nozzle.
            # Hard filter — cross-nozzle assignment causes print failures
            # ("position of left hotend is abnormal"), so never fall back.
            # Skipped when an FTS is installed: it routes any AMS slot to either
            # extruder, so restricting to one nozzle would wrongly exclude the
            # correct spool sitting in the other nozzle's AMS (#2186).
            req_nozzle_id = req.get("nozzle_id")
            if req_nozzle_id is not None and not fts_installed:
                available = [f for f in available if f.get("extruder_id") == req_nozzle_id]

            # Material is always a hard boundary. Disabling colour matching may
            # select a different shade or compatible subtype, but must never
            # map PLA to ABS (or any other unrelated material). Forced slots
            # additionally require the exact material type string.
            available = [
                f
                for f in available
                if (
                    (f.get("type") or "").upper() == req_type
                    if strict_color
                    else canonical_filament_type(f.get("type") or "") == canonical_filament_type(req_type)
                )
            ]

            # Sort by remaining filament (ascending) so lowest-remain spool wins .find().
            # Inventory-tracked spools sort before MQTT-only ones (#1508); see
            # _prefer_lowest_sort_key for the full rationale.
            if prefer_lowest:
                available.sort(key=lambda f: self._prefer_lowest_sort_key(f, inventory_remain_overrides))
                # INFO-level decision trace for "Prefer Lowest Filament" #1766.
                # One line per filament req so a bug report can be diagnosed
                # without enabling debug logging: shows what the matcher saw
                # (req shape + sorted candidate trays with their remain values
                # and any inventory override that was applied). Mirrored by
                # the picked-match log at the bottom of the loop.
                logger.info(
                    "[prefer-lowest] req slot=%s type=%r color=%r tii=%r nozzle=%s; available (sorted lowest-first): %s",
                    req.get("slot_id"),
                    req_type,
                    req_color,
                    req_tray_info_idx,
                    req_nozzle_id,
                    [
                        {
                            "gtid": f.get("global_tray_id"),
                            "type": f.get("type"),
                            "color": f.get("color"),
                            "tii": f.get("tray_info_idx"),
                            "remain": f.get("remain"),
                            "inv_g": (
                                inventory_remain_overrides.get(f.get("global_tray_id"))
                                if inventory_remain_overrides
                                else None
                            ),
                        }
                        for f in available
                    ],
                )

            # Check if tray_info_idx is unique among available trays
            if req_tray_info_idx and not strict_color:
                idx_matches = [f for f in available if f.get("tray_info_idx") == req_tray_info_idx]
                if len(idx_matches) == 1:
                    # Unique tray_info_idx - use it as definitive match
                    idx_match = idx_matches[0]
                    logger.debug(
                        f"Matched filament slot {req.get('slot_id')} by unique tray_info_idx={req_tray_info_idx} "
                        f"-> tray {idx_match['global_tray_id']}"
                    )
                elif len(idx_matches) > 1:
                    # Multiple trays with same tray_info_idx - use color matching among them
                    logger.debug(
                        f"Non-unique tray_info_idx={req_tray_info_idx} found in {len(idx_matches)} trays, "
                        f"using color matching among trays: {[f['global_tray_id'] for f in idx_matches]}"
                    )
                    if prefer_lowest:
                        idx_matches.sort(key=lambda f: self._prefer_lowest_sort_key(f, inventory_remain_overrides))
                    # Use color matching within this subset
                    for f in idx_matches:
                        f_color = f.get("color", "")
                        if self._normalize_color_for_compare(f_color) == self._normalize_color_for_compare(req_color):
                            if not exact_match:
                                exact_match = f
                        elif self._colors_are_similar(f_color, req_color):
                            if not similar_match:
                                similar_match = f
                        elif not type_only_match:
                            type_only_match = f

            # If no idx_match yet, do standard type/color matching on all available trays
            if not idx_match and not exact_match and not similar_match and not type_only_match:
                for f in available:
                    # Type matches - check color
                    f_color = f.get("color", "")
                    if self._normalize_color_for_compare(f_color) == self._normalize_color_for_compare(req_color):
                        if not exact_match:
                            exact_match = f
                    elif self._colors_are_similar(f_color, req_color):
                        if not similar_match:
                            similar_match = f
                    elif not type_only_match:
                        type_only_match = f

            # Forced slots are exact by definition: never degrade to a similar
            # or type-only colour, even when the material itself matches.
            match = exact_match if strict_color else idx_match or exact_match or similar_match or type_only_match
            if match:
                used_tray_ids.add(match["global_tray_id"])
                comparisons.append({"slot_id": req.get("slot_id", 0), "global_tray_id": match["global_tray_id"]})
            else:
                comparisons.append({"slot_id": req.get("slot_id", 0), "global_tray_id": -1})
            if prefer_lowest:
                # Pair with the "available (sorted)" log above so the reporter
                # bundle shows BOTH what the matcher saw AND which match bucket
                # won — fast triage when "Prefer Lowest Filament" picks the
                # wrong slot (#1766).
                if match:
                    bucket = (
                        "idx"
                        if idx_match is not None
                        else "exact_color"
                        if exact_match is not None
                        else "similar_color"
                        if similar_match is not None
                        else "type_only"
                    )
                    logger.info(
                        "[prefer-lowest] picked gtid=%s via %s for req slot=%s",
                        match["global_tray_id"],
                        bucket,
                        req.get("slot_id"),
                    )
                else:
                    logger.info(
                        "[prefer-lowest] NO MATCH for req slot=%s (type=%r color=%r tii=%r)",
                        req.get("slot_id"),
                        req_type,
                        req_color,
                        req_tray_info_idx,
                    )

        # Build mapping array
        if not comparisons:
            return None

        max_slot_id = max(c["slot_id"] for c in comparisons)
        if max_slot_id <= 0:
            return None

        mapping = [-1] * max_slot_id
        for c in comparisons:
            slot_id = c["slot_id"]
            if slot_id and slot_id > 0:
                mapping[slot_id - 1] = c["global_tray_id"]

        return mapping

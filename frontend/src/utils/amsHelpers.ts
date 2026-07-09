/**
 * AMS (Automatic Material System) helper utilities for Bambu Lab printers.
 * These functions handle color normalization, slot labeling, and tray ID calculations
 * for AMS, AMS-HT, and external spool configurations.
 */
import { parseUTCDate } from './date';

function normalizeRgbaHex(value: string | null | undefined): string {
  let raw = (value || '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(raw)) raw = '808080FF';
  if (raw.length === 6) raw += 'FF';
  return `#${raw.toUpperCase()}`;
}

/**
 * Normalize color format from various sources for CSS rendering.
 * API returns "RRGGBBAA" (8-char), 3MF uses "#RRGGBB" (7-char with hash).
 * Result is "#RRGGBB" for opaque colors and "#RRGGBBAA" when alpha < FF —
 * CSS accepts both forms on `fill` / `backgroundColor`, and preserving alpha
 * lets transparent filaments render translucent instead of collapsing to
 * solid black (#1545). Comparison helpers use normalizeColorForCompare which
 * still strips alpha, so type/colour matching is unaffected.
 */
export function normalizeColor(color: string | null | undefined): string {
  const normalized = normalizeRgbaHex(color);
  return normalized.slice(7, 9).toLowerCase() === 'ff' ? normalized.slice(0, 7) : normalized;
}

/**
 * Normalize color for comparison (case-insensitive, strip hash and alpha).
 */
export function normalizeColorForCompare(color: string | undefined): string {
  if (!color) return '';
  return normalizeRgbaHex(color).replace('#', '').toLowerCase().substring(0, 6);
}

/**
 * AMS unit label using the codebase convention: "AMS-A / AMS-B / ..." for
 * regular AMS, "HT-A / HT-B / ..." for AMS-HT (single-tray modules with
 * IDs starting at 128). `trayCount` is required because the type can't be
 * inferred from the id alone — regular AMS IDs 0-3 can collide with the
 * normalized HT range otherwise.
 */
export function getAmsLabel(amsId: number | string, trayCount: number): string {
  const id = typeof amsId === 'string' ? parseInt(amsId, 10) : amsId;
  const safeId = isNaN(id) ? 0 : id;
  if (safeId === 255) return 'External';
  const isHt = trayCount === 1;
  const normalizedId = safeId >= 128 ? safeId - 128 : safeId;
  const letter = String.fromCharCode(65 + normalizedId);
  return isHt ? `HT-${letter}` : `AMS-${letter}`;
}

/**
 * Check if two colors are visually similar within a threshold.
 * Uses RGB component comparison with configurable tolerance.
 * @param color1 - First hex color
 * @param color2 - Second hex color
 * @param threshold - Maximum difference per RGB component (default: 40)
 */
export function colorsAreSimilar(
  color1: string | undefined,
  color2: string | undefined,
  threshold = 40
): boolean {
  const c1 = normalizeRgbaHex(color1);
  const c2 = normalizeRgbaHex(color2);
  return [1, 3, 5].every((index) =>
    Math.abs(parseInt(c1.slice(index, index + 2), 16) - parseInt(c2.slice(index, index + 2), 16)) <= threshold,
  );
}

/**
 * Format slot label for display in the UI.
 * @param amsId - AMS unit ID (0-3 for regular AMS, 128+ for AMS-HT)
 * @param trayId - Tray/slot ID within the AMS unit (0-3)
 * @param isHt - Whether this is an AMS-HT unit (single tray)
 * @param isExternal - Whether this is the external spool holder
 */
export function formatSlotLabel(
  amsId: number,
  trayId: number,
  isHt: boolean,
  isExternal: boolean
): string {
  if (isExternal) return 'Ext';
  // Convert AMS ID to letter (A, B, C, D)
  // AMS-HT uses IDs starting at 128
  const letter = String.fromCharCode(65 + (amsId >= 128 ? amsId - 128 : amsId));
  if (isHt) return `HT-${letter}`;
  return `${letter}${trayId + 1}`;
}

/**
 * Calculate global tray ID for MQTT command.
 * Used in the ams_mapping array sent to the printer.
 * @param amsId - AMS unit ID (0-3 for regular AMS, 128+ for AMS-HT)
 * @param trayId - Tray/slot ID within the AMS unit
 * @param isExternal - Whether this is the external spool holder
 * @returns Global tray ID (0-15 for AMS, 128+ for AMS-HT, 254 for external)
 */
export function getGlobalTrayId(
  amsId: number,
  trayId: number,
  isExternal: boolean
): number {
  if (isExternal) return 254 + trayId;
  // AMS-HT units have IDs starting at 128 with a single tray — use ID directly
  if (amsId >= 128) return amsId;
  return amsId * 4 + trayId;
}

/**
 * Resolve the extruder/nozzle that owns an AMS slot.
 * Regular and HT units use the printer-reported AMS mapping. Dual-nozzle
 * external slots are fixed: logical slot 0 is left (extruder 1), slot 1 is
 * right (extruder 0). Single-nozzle external slots do not need a filter.
 */
export function getAmsSlotExtruderId({
  amsId,
  trayId,
  isDualNozzle,
  amsExtruderMap,
}: {
  amsId: number;
  trayId: number;
  isDualNozzle: boolean;
  amsExtruderMap?: Record<string, number>;
}): number | undefined {
  if (amsId === 255) {
    if (!isDualNozzle) return undefined;
    return trayId === 0 ? 1 : 0;
  }
  return amsExtruderMap?.[String(amsId)];
}

/**
 * Calculate the key used by the slot-presets API response.
 * Unlike MQTT global tray IDs, external slots retain ams_id=255 and are
 * therefore keyed as 1020/1021. AMS-HT units use their unit ID directly.
 */
export function getSlotPresetKey(amsId: number, trayId: number): number {
  if (amsId >= 128 && amsId <= 135) return amsId;
  return amsId * 4 + trayId;
}

/**
 * Get fill bar color based on spool fill level.
 * Matches PrintersPage thresholds and Bambu Lab brand green.
 */
export function getFillBarColor(fillLevel: number): string {
  if (fillLevel > 50) return '#00ae42'; // Green - good
  if (fillLevel >= 15) return '#f59e0b'; // Amber - warning (<= 50%)
  return '#ef4444'; // Red - critical (< 15%)
}

/**
 * Calculate fill level from Spoolman weight data.
 * Used as the first source in the Spoolman → Inventory → AMS fill chain.
 */
export function getSpoolmanFillLevel(
  linkedSpool: { remaining_weight: number | null; filament_weight: number | null } | undefined
): number | null {
  if (!linkedSpool?.remaining_weight || !linkedSpool?.filament_weight
      || linkedSpool.filament_weight <= 0) return null;
  return Math.min(100, Math.round(
    (linkedSpool.remaining_weight / linkedSpool.filament_weight) * 100
  ));
}

function toFixedHex(value: number, width: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  return safe.toString(16).toUpperCase().padStart(width, '0').slice(-width);
}

// 32-bit FNV-1a hash -> 8-char hex (stable for alphanumeric serials)
function hashSerialToHex32(serial: string): string {
  const input = (serial || '').trim().toUpperCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

/**
 * Generate a stable fallback spool tag for slots without RFID identifiers.
 * Returns a 16-char hex string derived from the printer serial + slot position.
 */
export function getFallbackSpoolTag(printerSerial: string, amsId: number, trayId: number): string {
  return `${hashSerialToHex32(printerSerial)}${toFixedHex(amsId, 4)}${toFixedHex(trayId, 4)}`;
}

/**
 * Get minimum datetime for scheduling (now + 1 minute).
 * Returns ISO string format for datetime-local input.
 */
export function getMinDateTime(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() + 1);
  return now.toISOString().slice(0, 16);
}

/**
 * Check if a scheduled time is a placeholder far-future date.
 * Placeholder dates (more than 6 months out) are treated as ASAP.
 */
export function isPlaceholderDate(scheduledTime: string | null | undefined): boolean {
  if (!scheduledTime) return false;
  const sixMonthsFromNow = Date.now() + 180 * 24 * 60 * 60 * 1000;
  return (parseUTCDate(scheduledTime)?.getTime() ?? 0) > sixMonthsFromNow;
}

/**
 * Detect Bambu Lab RFID-tagged spool by tray_uuid (32 hex) or tag_uid (16 hex).
 *
 * Permissive zero-string check: any non-zero non-empty value returns true. The
 * function exists to suppress assign/unassign actions on RFID-managed slots
 * whose state is owned by the printer firmware — manual changes there would be
 * overwritten on the next RFID re-read (eye → pen icon in BambuStudio).
 */
export function isBambuLabSpool(tray: {
  tray_uuid?: string | null;
  tag_uid?: string | null;
} | null | undefined): boolean {
  if (!tray) return false;
  if (tray.tray_uuid && tray.tray_uuid !== '00000000000000000000000000000000') return true;
  if (tray.tag_uid && tray.tag_uid !== '0000000000000000') return true;
  return false;
}

export interface AmsTrayLike {
  id: number;
  tray_type: string | null | undefined;
  tray_sub_brands: string | null | undefined;
  tray_color: string | null | undefined;
  tray_info_idx: string | null | undefined;
}

export interface AmsUnitLike {
  id: number;
  tray: AmsTrayLike[];
}

/**
 * One row in the AMS Backup modal: a group of slots that back each other up
 * (length >= 2), or a single non-empty slot with no peer (length === 1).
 */
export interface BackupGroup {
  /** Stable key — same across renders for the same material+extruder. */
  key: string;
  /** Bambu preset ID (tray_info_idx) when matched on preset; null otherwise. */
  presetId: string | null;
  /** 0 = right / single, 1 = left. Scoping field for dual-nozzle. */
  extruder: number;
  /** Display name from the first slot's tray_sub_brands (or tray_type). */
  displayName: string;
  /** Tray colour from the first slot, for the swatch in the modal. */
  trayColor: string | null;
  /** Member slots, in (ams_id, slot_idx) order. */
  members: Array<{ amsId: number; slotIdx: number; globalTrayId: number }>;
}

/**
 * Canonicalise a hex colour for identity comparison. Mirrors the backend
 * `_normalize_color_for_id`. Strips the leading `#`, uppercases, and drops
 * the alpha channel when 8 chars long so `1A1A1AFF` matches `1A1A1A`.
 */
function normalizeColorForId(raw: string | null | undefined): string {
  let s = (raw || '').trim().replace(/^#/, '').toUpperCase();
  if (s.length === 8) s = s.slice(0, 6);
  return s;
}

/**
 * Compute backup pairs for the AMS Backup modal (#1762).
 *
 * Strict identity rule (mirrors backend `_material_identity_internal` /
 * `_material_identity_spoolman`): slots pair ONLY when they share the same
 * Bambu preset ID (`tray_info_idx`, e.g. "GFA00") AND the same colour. The
 * preset identifies the filament profile (PETG HF, PLA Basic, etc.); the
 * colour pins the variant — three PETG HF spools in different colours
 * absolutely don't back each other up. User-tagged spools without a preset
 * never pair — Bambu's firmware backup logic relies on the preset, and
 * pairing on cosmetic name/colour match alone would let two visually-
 * identical but materially-different spools be treated as backups.
 *
 * Empty slots are skipped entirely. Every non-empty slot is returned — slots
 * without a peer come back as 1-member entries so the modal can list them as
 * "Slots without a backup peer".
 *
 * On dual-extruder printers (H2D / H2C / X2D), pairs are scoped per extruder
 * side — the firmware can't cross extruders even with the global backup bit
 * set.
 */
export function computeBackupGroups(
  amsUnits: AmsUnitLike[] | undefined,
  amsExtruderMap: Record<string, number> | undefined,
  isDualNozzle: boolean,
): BackupGroup[] {
  if (!amsUnits || amsUnits.length === 0) return [];

  // Defensive dedup: ``status.ams`` is expected to be unique by `ams.id`, but
  // observed in the wild to occasionally contain duplicate entries (e.g. on
  // VP-aggregated switch printers or during MQTT partial-update merges). A
  // duplicate would surface as "AMS-A slot 1" rendered twice with different
  // materials, which is impossible physically and visually broken. First
  // occurrence per `ams.id` wins.
  const seenIds = new Set<number>();
  const uniqueAms: AmsUnitLike[] = [];
  for (const ams of amsUnits) {
    if (seenIds.has(ams.id)) continue;
    seenIds.add(ams.id);
    uniqueAms.push(ams);
  }

  const byKey = new Map<string, BackupGroup>();

  for (const ams of uniqueAms) {
    const extruder = isDualNozzle ? Number(amsExtruderMap?.[String(ams.id)] ?? 0) : 0;
    ams.tray.forEach((tray, slotIdx) => {
      if (!tray?.tray_type) return; // empty slot
      const preset = (tray.tray_info_idx || '').trim();
      const globalTrayId = getGlobalTrayId(ams.id, slotIdx, false);
      const member = { amsId: ams.id, slotIdx, globalTrayId };

      let key: string;
      let presetId: string | null;
      if (preset) {
        // Same Bambu profile is necessary but NOT sufficient — different colours
        // of the same PETG HF profile can't back each other up. Bake the colour
        // into the identity key, normalised to strip alpha and case.
        const color = normalizeColorForId(tray.tray_color);
        key = `preset:${preset}|color:${color}#${extruder}`;
        presetId = preset;
      } else {
        // No preset → never group with anything else. Unique-per-slot key.
        key = `unmatched:${ams.id}:${slotIdx}#${extruder}`;
        presetId = null;
      }

      const existing = byKey.get(key);
      if (existing) {
        existing.members.push(member);
      } else {
        byKey.set(key, {
          key,
          presetId,
          extruder,
          displayName: tray.tray_sub_brands || tray.tray_type || '',
          trayColor: tray.tray_color ?? null,
          members: [member],
        });
      }
    });
  }

  // Stable sort: extruder first (so the modal can section per side on
  // dual-nozzle), then pairs before lone slots, then by name, then by first
  // member's global tray id for deterministic rendering.
  return Array.from(byKey.values()).sort((a, b) => {
    if (a.extruder !== b.extruder) return a.extruder - b.extruder;
    const aLone = a.members.length === 1 ? 1 : 0;
    const bLone = b.members.length === 1 ? 1 : 0;
    if (aLone !== bLone) return aLone - bLone;
    if (a.displayName !== b.displayName) return a.displayName.localeCompare(b.displayName);
    return a.members[0].globalTrayId - b.members[0].globalTrayId;
  });
}

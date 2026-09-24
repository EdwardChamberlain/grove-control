export function getPrinterImage(model: string | null | undefined): string {
  if (!model) return '/img/printers/default.png';
  const m = model.toLowerCase().replace(/\s+/g, '');
  if (m.includes('x1e')) return '/img/printers/x1e.png';
  if (m.includes('x1c') || m.includes('x1carbon')) return '/img/printers/x1c.png';
  if (m.includes('x1')) return '/img/printers/x1c.png';
  if (m.includes('x2d') || m === 'n6') return '/img/printers/x2d.png';
  if (m.includes('h2dpro') || m.includes('h2d-pro')) return '/img/printers/h2dpro.png';
  if (m.includes('h2d')) return '/img/printers/h2d.png';
  if (m.includes('h2c')) return '/img/printers/h2c.png';
  if (m.includes('h2s')) return '/img/printers/h2d.png';
  if (m.includes('p2s')) return '/img/printers/p1s.png';
  if (m.includes('p1s')) return '/img/printers/p1s.png';
  if (m.includes('p1p')) return '/img/printers/p1p.png';
  if (m.includes('a2l') || m === 'n9') return '/img/printers/a2l.png';
  if (m.includes('a1mini')) return '/img/printers/a1mini.png';
  if (m.includes('a1')) return '/img/printers/a1.png';
  return '/img/printers/default.png';
}

export function getWifiStrength(rssi: number): { labelKey: string; color: string; bars: number } {
  if (rssi >= -50) return { labelKey: 'printers.wifiSignal.excellent', color: 'text-bambu-green', bars: 4 };
  if (rssi >= -60) return { labelKey: 'printers.wifiSignal.good', color: 'text-bambu-green', bars: 3 };
  if (rssi >= -70) return { labelKey: 'printers.wifiSignal.fair', color: 'text-yellow-400', bars: 2 };
  if (rssi >= -80) return { labelKey: 'printers.wifiSignal.weak', color: 'text-orange-400', bars: 1 };
  return { labelKey: 'printers.wifiSignal.veryWeak', color: 'text-red-400', bars: 1 };
}

const SLICED_MODEL_CODES: Record<string, string> = {
  C11: 'X1C', C12: 'X1', C13: 'X1E',
  BLP001: 'X1C', BLP002: 'X1', BLP003: 'X1E',
  O1D: 'H2D', O1E: 'H2DPRO', O2D: 'H2DPRO', O1C: 'H2C', O1C2: 'H2C', O1S: 'H2S',
  N6: 'X2D', N9: 'A2L', N2S: 'A1', N1: 'A1MINI', A11: 'A1', A12: 'A1MINI', A04: 'A1MINI',
};

const PRINTER_MODEL_CODES: Record<string, string> = {
  ...SLICED_MODEL_CODES,
  // Printer rows can store their SSDP model code. These differ from the
  // slicer's internal IDs for C11/C12/C13, so use the printer-page mapping.
  C11: 'P1S', C12: 'P1P', C13: 'P2S',
};

const PRINTER_DISPLAY_MODEL_NAMES: Record<string, string> = {
  BAMBULABX1CARBON: 'X1C', X1CARBON: 'X1C',
  BAMBULABX1: 'X1', BAMBULABX1E: 'X1E',
  BAMBULABP1S: 'P1S', BAMBULABP1P: 'P1P', BAMBULABP2S: 'P2S',
  BAMBULABA1: 'A1', BAMBULABA1MINI: 'A1MINI', BAMBULABA1M: 'A1MINI',
  BAMBULABH2D: 'H2D', BAMBULABH2DPRO: 'H2DPRO', BAMBULABH2C: 'H2C',
  BAMBULABH2S: 'H2S', BAMBULABX2D: 'X2D', BAMBULABA2L: 'A2L',
};

/** Return whether a sliced file may be sent to the selected printer model. */
export function isGcodeCompatible(slicedForModel: string | null | undefined, targetModel: string | null | undefined): boolean {
  if (!slicedForModel || !targetModel) return true;

  const normalize = (model: string, isTarget: boolean) => {
    const code = model.trim().toUpperCase().replace(/[ -]/g, '');
    const aliases = isTarget ? PRINTER_MODEL_CODES : SLICED_MODEL_CODES;
    return aliases[code] ?? PRINTER_DISPLAY_MODEL_NAMES[code] ?? code;
  };
  const sliced = normalize(slicedForModel, false);
  const target = normalize(targetModel, true);
  if (sliced === target) return true;

  const interchangeable = new Set(['X1', 'X1C', 'X1E', 'P1P', 'P1S']);
  return interchangeable.has(sliced) && interchangeable.has(target);
}

import type { PrintQueueItem } from '../api/client';
import { canonicalFilamentType } from './amsHelpers';

/**
 * Filters queue items based on printer compatibility (filament types and colors).
 * Mirrors backend _find_idle_printer_for_model() logic.
 * @param items - Array of queue items to filter
 * @param loadedFilamentTypes - Set of loaded filament types (e.g., "PLA", "PETG")
 * @param loadedFilaments - Set of loaded filament type+color pairs (e.g., "PLA:ffffff", "PETG:ff0000")
 * @returns Array of compatible queue items
 */
export function filterCompatibleQueueItems(
  items: PrintQueueItem[],
  loadedFilamentTypes?: Set<string>,
  loadedFilaments?: Set<string>
): PrintQueueItem[] {
  return items.filter(item => {
    // Type check: all required filament types must be loaded
    if (item.required_filament_types && item.required_filament_types.length > 0 && loadedFilamentTypes !== undefined) {
      if (!item.required_filament_types.every((t: string) => loadedFilamentTypes.has(t.toUpperCase()))) {
        return false;
      }
    }

    // Color check: evaluate force_color_match per slot
    // Only apply when loadedFilaments is provided (not undefined).
    // An empty Set means no filaments are loaded — force-matched slots cannot match.
    if (item.filament_overrides && item.filament_overrides.length > 0 && loadedFilaments !== undefined) {
      const loadedOverrideTypes = new Set(
        Array.from(loadedFilaments, (filament) => canonicalFilamentType(filament.split(':', 1)[0])),
      );
      const materialsAvailable = item.filament_overrides.every((override) =>
        loadedOverrideTypes.has(canonicalFilamentType(override.type)),
      );
      if (!materialsAvailable) return false;

      const forceOverrides = item.filament_overrides.filter(o => o.force_color_match === true);

      // All force-matched slots must have exact type+color on this printer
      if (forceOverrides.length > 0) {
        const allForceMatch = forceOverrides.every(o => {
          const oType = (o.type || '').toUpperCase();
          const oColor = (o.color || '').replace('#', '').toLowerCase().slice(0, 6);
          return loadedFilaments.has(`${oType}:${oColor}`);
        });
        if (!allForceMatch) return false;
      }

      // Preference-only overrides do not filter by colour. The material type
      // check above remains mandatory; dispatch chooses the closest available
      // colour within that material family.
    }

    return true;
  });
}

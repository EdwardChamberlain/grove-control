import type { FilamentMaterialPayload } from '../api/client';

/**
 * Data sent by the backend when a sliced file requires a filament slot.
 *
 * Matching is deliberately not implemented in the browser. Use
 * `api.previewFilamentMapping` for an authoritative mapping decision.
 */
export interface FilamentRequirement {
  slot_id: number;
  type: string;
  color: string;
  material?: FilamentMaterialPayload;
  used_grams: number;
  used_meters: number;
  nozzle_id?: number;
  tray_info_idx?: string;
}

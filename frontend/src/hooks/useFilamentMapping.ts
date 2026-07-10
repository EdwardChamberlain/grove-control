import type { FilamentRequirementPayload } from '../api/client';

/**
 * Data sent by the backend when a sliced file requires a filament slot.
 *
 * Matching is deliberately not implemented in the browser. Use
 * `api.previewFilamentMapping` for an authoritative mapping decision.
 */
export type FilamentRequirement = FilamentRequirementPayload;

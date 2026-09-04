import type { PrinterStatus } from '../api/client';

type ActivePrintStatus = Pick<
  PrinterStatus,
  | 'state'
  | 'current_print_identity'
  | 'current_archive_id'
  | 'subtask_name'
  | 'current_print'
  | 'gcode_file'
>;

export function getActivePrintIdentity(status: ActivePrintStatus | null | undefined): string | null {
  if (!status || (status.state !== 'RUNNING' && status.state !== 'PAUSE')) return null;
  // WebSocket updates carry the printer-assigned subtask ID, so prefer it over
  // a REST-only archive ID that may still belong to the previous print.
  if (status.current_print_identity) return `subtask:${status.current_print_identity}`;
  if (status.current_archive_id != null) return `archive:${status.current_archive_id}`;
  return status.subtask_name || status.current_print || status.gcode_file || null;
}

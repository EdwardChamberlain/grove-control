import type { Printer, PrinterStatus } from '../api/client';

/** A printer shows in the Queue's plate-clear lines while it waits for the plate to be cleared. */
export function needsPlateClear(printer: Printer, status: PrinterStatus | undefined): boolean {
  const printing = status?.preheating === true || status?.state === 'RUNNING' || status?.state === 'PAUSE';
  return printer.is_active !== false && status?.connected === true && status.awaiting_plate_clear === true && !printing;
}

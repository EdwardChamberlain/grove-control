import type { Printer, PrinterStatus } from '../api/client';

/** A printer waits in the Queue and on the kiosk, in service and not printing, until its plate is marked cleared. */
export function needsPlateClear(printer: Printer, status: PrinterStatus | undefined): boolean {
  const printing = status?.preheating === true || status?.state === 'RUNNING' || status?.state === 'PAUSE';
  return printer.is_active !== false && status?.awaiting_plate_clear === true && !printing;
}

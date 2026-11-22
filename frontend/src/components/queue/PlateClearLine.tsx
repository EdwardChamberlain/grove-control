import { Hand, Loader2 } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Printer, type PrinterStatus } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { formatPrintName } from '../../utils/printName';
import { PlateClearedIcon } from '../icons/PlateClearedIcon';
import { QueueJobLine, type QueueJobLineItem, type QueueJobLineStatus } from './QueueJobLine';
import { QUEUE_TONES } from './queueTones';
import type { TimeFormat } from '../../utils/date';

interface PlateClearLineProps {
  printer: Printer;
  status: PrinterStatus;
  /** Name of the next queued job for this printer, shown in the hint. */
  nextJobName?: string;
  canClearPlate: boolean;
  timeFormat?: TimeFormat;
  t: (key: string, options?: Record<string, unknown>) => string;
}

/**
 * A finished or failed job that keeps its place in the Queue until its printer's
 * plate is marked cleared. Uses the yellow plate-clear tone and the hand icon.
 */
export function PlateClearLine({ printer, status, nextJobName, canClearPlate, timeFormat, t }: PlateClearLineProps) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const finished = status.awaiting_plate_clear_print ?? null;

  const clearPlateMutation = useMutation({
    mutationFn: () => api.clearPlate(printer.id),
    onSuccess: () => {
      showToast(t('queue.clearPlateSuccess'));
      queryClient.setQueryData(['printerStatus', printer.id], (old: PrinterStatus | undefined) =>
        old ? { ...old, awaiting_plate_clear: false, awaiting_plate_clear_print: null } : old,
      );
      queryClient.invalidateQueries({ queryKey: ['printerStatus', printer.id] });
      queryClient.invalidateQueries({ queryKey: ['queue'] });
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });

  const item: QueueJobLineItem = {
    status: 'completed',
    printer_id: printer.id,
    printer_name: printer.name,
    target_model: null,
    target_location: null,
    required_filament_types: null,
    archive_id: finished?.archive_id ?? null,
    library_file_id: null,
    archive_thumbnail: finished?.thumbnail_path ?? null,
    library_file_thumbnail: null,
    plate_id: null,
    bed_type: null,
    created_by_username: finished?.created_by_username ?? null,
    scheduled_time: null,
    manual_start: false,
    waiting_reason: null,
    print_time_seconds: null,
    filament_used_grams: null,
    require_previous_success: false,
    auto_off_after: false,
    gcode_injection: false,
    filament_short: false,
    error_message: null,
    preheat_started_at: null,
  };
  const lineStatus: QueueJobLineStatus = { tone: QUEUE_TONES.plateClear, Icon: Hand, label: t('kiosk.clearPlate') };
  const displayName =
    finished?.print_name
    || formatPrintName(status.subtask_name || status.current_print || status.gcode_file || null, status.gcode_file, (key, fallback, opts) => t(key, { defaultValue: fallback, ...opts }))
    || t('kiosk.noJob');
  const clearTitle = canClearPlate ? t('printers.plateStatus.markCleared') : t('printers.permission.noControl');

  return (
    <div data-testid={`plate-clear-${printer.id}`}>
      <QueueJobLine
        item={item}
        displayName={displayName}
        timeFormat={timeFormat}
        t={t}
        status={lineStatus}
        extraFooter={(
          <>
            <Hand className="h-3 w-3 flex-shrink-0" />
            <span className="flex-1">
              {t('kiosk.clearPlateHint')}
              {nextJobName ? ` ${t('kiosk.nextJob', { name: nextJobName })}` : ''}
            </span>
            <button
              type="button"
              onClick={() => clearPlateMutation.mutate()}
              disabled={clearPlateMutation.isPending || !canClearPlate}
              title={clearTitle}
              className="-my-0.5 inline-flex h-5 items-center gap-1.5 rounded-md border border-yellow-400 bg-yellow-400/15 px-2.5 text-xs font-semibold text-yellow-700 transition-colors hover:bg-yellow-400/25 disabled:cursor-not-allowed disabled:opacity-50 dark:text-yellow-300"
            >
              {clearPlateMutation.isPending
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : <PlateClearedIcon className="h-3 w-3" />}
              {t('printers.plateStatus.markCleared')}
            </button>
          </>
        )}
      />
    </div>
  );
}

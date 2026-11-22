import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Hand } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { api, type Printer as PrinterRecord, type PrinterStatus } from '../api/client';
import { QueueJobLine, type QueueJobLineItem, type QueueJobLineStatus } from '../components/queue/QueueJobLine';
import { QueueSectionHeading } from '../components/queue/QueueSectionHeading';
import {
  QUEUE_TONES,
  jobProgressFromStatus,
  pauseReasonKeyFor,
  type QueueJobProgress,
} from '../components/queue/queueTones';
import { useTheme } from '../contexts/ThemeContext';
import { type TimeFormat } from '../utils/date';
import { formatPrintName } from '../utils/printName';
import { needsPlateClear } from '../utils/plateClear';
import { queueItemDisplayName } from '../utils/queueItemName';

type Translate = TFunction;

/** Idle printers named in the footer before the rest collapse into a "+N" cell. */
const MAX_FOOTER_PRINTERS = 6;

function isActivePrint(status: PrinterStatus | undefined): boolean {
  return status?.preheating === true || status?.state === 'RUNNING' || status?.state === 'PAUSE';
}

/** Connected, in service and with nothing to do. */
function isIdle(printer: PrinterRecord, status: PrinterStatus | undefined): boolean {
  return printer.is_active !== false && status?.connected === true && !isActivePrint(status) && !status.awaiting_plate_clear;
}

function getActiveJobName(status: PrinterStatus | undefined, t: Translate): string {
  return formatPrintName(
    status?.subtask_name || status?.current_print || status?.gcode_file || null,
    status?.gcode_file,
    t,
  ) || t('kiosk.noJob');
}

function useOverflowing(dependencies: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  const [hiddenItemCount, setHiddenItemCount] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const checkOverflow = () => {
      const containerBottom = element.getBoundingClientRect().bottom;
      const hiddenCount = Array.from(element.children).filter((child) =>
        child.getBoundingClientRect().bottom > containerBottom + 1
      ).length;
      setHiddenItemCount(hiddenCount);
    };
    checkOverflow();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(checkOverflow);
    observer.observe(element);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);

  return { ref, hiddenItemCount };
}

/** A job line for a printer's current print, which may have no queue row behind it. */
function kioskLineItem(overrides: Partial<QueueJobLineItem> & Pick<QueueJobLineItem, 'printer_id'>): QueueJobLineItem {
  return {
    status: 'printing',
    printer_name: null,
    target_model: null,
    target_location: null,
    required_filament_types: null,
    archive_id: null,
    library_file_id: null,
    archive_thumbnail: null,
    library_file_thumbnail: null,
    plate_id: null,
    bed_type: null,
    created_by_username: null,
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
    ...overrides,
  };
}

interface KioskRow {
  key: string;
  item: QueueJobLineItem;
  displayName: string;
  printerState?: string | null;
  progress?: QueueJobProgress | null;
  pauseReasonKey?: string;
  status?: QueueJobLineStatus;
  alert?: boolean;
  extraFooter?: ReactNode;
}

const STAT_TONES = {
  plate: 'border-t-yellow-500 text-yellow-700 dark:text-yellow-300',
  printing: 'border-t-bambu-green text-green-700 dark:text-green-400',
  paused: 'border-t-orange-500 text-orange-700 dark:text-orange-300',
  queued: 'border-t-bambu-gray-light text-white',
  idle: 'border-t-bambu-gray-dark text-bambu-gray-light',
} as const;

function KioskStat({ id, tone, count, label }: { id: string; tone: keyof typeof STAT_TONES; count: number; label: string }) {
  return (
    <div
      data-testid={`kiosk-stat-${id}`}
      className={`flex items-baseline gap-3 border-l border-t-[3px] border-l-bambu-dark-tertiary bg-bambu-dark-secondary px-[18px] py-2 first:border-l-0 ${STAT_TONES[tone]}`}
    >
      <b className="text-3xl font-semibold tabular-nums leading-tight">{count}</b>
      <span className="text-[13px] font-semibold uppercase tracking-[0.06em] text-bambu-gray-light">{label}</span>
    </div>
  );
}

export function KioskPage() {
  const { t } = useTranslation();
  const { resolvedMode } = useTheme();
  const [now, setNow] = useState(() => new Date());
  const { data: printers = [] } = useQuery({ queryKey: ['printers'], queryFn: api.getPrinters, refetchInterval: 30_000 });
  const { data: queue = [] } = useQuery({ queryKey: ['queue', 'kiosk'], queryFn: () => api.getQueue(), refetchInterval: 5_000 });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 5 * 60 * 1000 });
  const timeFormat: TimeFormat = settings?.time_format || 'system';

  const printerStatusQueries = useQueries({
    queries: printers.map((printer) => ({
      queryKey: ['printerStatus', printer.id],
      queryFn: () => api.getPrinterStatus(printer.id),
      refetchInterval: 30_000,
    })),
  });
  const statuses = useMemo(() => new Map(printers.map((printer, index) => [printer.id, printerStatusQueries[index]?.data])), [printers, printerStatusQueries]);
  const currentPrintUserQueries = useQueries({
    queries: printers.map((printer, index) => {
      const status = printerStatusQueries[index]?.data;
      const printIdentity = status?.current_print_identity || status?.subtask_name || status?.current_print || status?.gcode_file || null;
      return {
        queryKey: ['currentPrintUser', printer.id, printIdentity],
        queryFn: () => api.getCurrentPrintUser(printer.id),
        enabled: status?.state === 'RUNNING' || status?.state === 'PAUSE',
        refetchInterval: 30_000,
      };
    }),
  });

  const printingItems = useMemo(
    () => queue.filter((item) => item.status === 'preheating' || item.status === 'dispatching' || item.status === 'printing'),
    [queue],
  );
  const pendingItems = useMemo(() => queue.filter((item) => item.status === 'pending').sort((a, b) => a.position - b.position), [queue]);
  const printingItemsByPrinter = useMemo(() => new Map(printingItems.filter((item) => item.printer_id != null).map((item) => [item.printer_id!, item])), [printingItems]);

  const owners = useMemo(() => new Map(printers.map((printer, index) => {
    const status = statuses.get(printer.id);
    const queueOwner = printingItemsByPrinter.get(printer.id)?.created_by_username ?? undefined;
    const currentPrintUser = currentPrintUserQueries[index]?.data?.username;
    const plateClearOwner = status?.awaiting_plate_clear_print?.created_by_username ?? undefined;
    const owner = isActivePrint(status)
      ? status?.current_queue_owner || currentPrintUser || queueOwner
      : status?.awaiting_plate_clear
        ? plateClearOwner
        : undefined;
    return [printer.id, owner];
  })), [currentPrintUserQueries, printers, printingItemsByPrinter, statuses]);

  // Order: plate clear, paused, printing (heat soak included), then the queue.
  const { plateRows, pausedRows, printingRows, queueRows } = useMemo(() => {
    const plusMore = (count: number) => t('common.plusNMore', { count });

    const plate: KioskRow[] = [...printers]
      .filter((printer) => needsPlateClear(printer, statuses.get(printer.id)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((printer) => {
        const status = statuses.get(printer.id);
        const next = pendingItems.find((item) => item.printer_id === printer.id);
        const clearPlate: QueueJobLineStatus = { tone: QUEUE_TONES.plateClear, Icon: Hand, label: t('kiosk.clearPlate') };
        return {
          key: `plate-clear-${printer.id}`,
          item: kioskLineItem({
            printer_id: printer.id,
            printer_name: printer.name,
            created_by_username: owners.get(printer.id) ?? null,
            archive_id: status?.awaiting_plate_clear_print?.archive_id ?? null,
          }),
          displayName: status?.awaiting_plate_clear_print?.print_name || getActiveJobName(status, t),
          status: clearPlate,
          alert: true,
          extraFooter: (
            <>
              <Hand className="h-4 w-4 flex-shrink-0" />
              <span className="flex-1">
                {t('kiosk.clearPlateHint')}
                {next ? ` ${t('kiosk.nextJob', { name: queueItemDisplayName(next, plusMore) })}` : ''}
              </span>
            </>
          ),
        };
      });

    const printing: KioskRow[] = printingItems.map((item) => {
      const status = item.printer_id ? statuses.get(item.printer_id) : undefined;
      const state = status?.state;
      return {
        key: `job-${item.id}`,
        item,
        displayName: queueItemDisplayName(item, plusMore),
        printerState: state,
        progress: status ? jobProgressFromStatus(status) : null,
        pauseReasonKey: state === 'PAUSE' ? pauseReasonKeyFor(status) : undefined,
      };
    });
    // A printer running a job that is not in the queue response still gets a line.
    for (const printer of printers) {
      const status = statuses.get(printer.id);
      if (!isActivePrint(status) || printingItemsByPrinter.has(printer.id) || printer.is_active === false) continue;
      printing.push({
        key: `printer-${printer.id}`,
        item: kioskLineItem({
          printer_id: printer.id,
          printer_name: printer.name,
          status: status?.preheating ? 'preheating' : 'printing',
          archive_id: status?.current_archive_id ?? null,
          created_by_username: owners.get(printer.id) ?? null,
        }),
        displayName: getActiveJobName(status, t),
        printerState: status?.state,
        progress: status ? jobProgressFromStatus(status) : null,
        pauseReasonKey: status?.state === 'PAUSE' ? pauseReasonKeyFor(status) : undefined,
      });
    }

    const queued: KioskRow[] = pendingItems.map((item) => ({
      key: `job-${item.id}`,
      item,
      displayName: queueItemDisplayName(item, plusMore),
    }));
    return {
      plateRows: plate,
      pausedRows: printing.filter((row) => row.printerState === 'PAUSE'),
      printingRows: printing.filter((row) => row.printerState !== 'PAUSE'),
      queueRows: queued,
    };
  }, [owners, pendingItems, printers, printingItems, printingItemsByPrinter, statuses, t]);

  // Plate clear, paused and printing jobs form the "Printing" group; the rest are "Up next".
  const printingGroupCount = plateRows.length + pausedRows.length + printingRows.length;

  const rows = useMemo(
    () => [...plateRows, ...pausedRows, ...printingRows, ...queueRows],
    [plateRows, pausedRows, printingRows, queueRows],
  );
  const idlePrinters = useMemo(
    () => printers.filter((printer) => isIdle(printer, statuses.get(printer.id))).sort((a, b) => a.name.localeCompare(b.name)),
    [printers, statuses],
  );
  const footerPrinters = idlePrinters.length > MAX_FOOTER_PRINTERS ? idlePrinters.slice(0, MAX_FOOTER_PRINTERS - 1) : idlePrinters;
  const footerOverflow = idlePrinters.length - footerPrinters.length;

  const { ref: listRef, hiddenItemCount } = useOverflowing([rows, idlePrinters.length]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 10_000);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <div data-testid="kiosk-page" className="flex h-screen flex-col overflow-hidden bg-bambu-dark px-4 py-4 sm:px-6 lg:px-8">
      <header className="mx-auto flex w-full shrink-0 max-w-[1920px] items-center justify-between pb-3">
        <img src={resolvedMode === 'dark' ? '/img/grove_control_logo_dark_transparent.png' : '/img/grove_control_logo_light.png'} alt="Grove Control" className="h-9 w-auto sm:h-10" />
        <time className="text-lg font-medium tabular-nums text-white sm:text-xl">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
      </header>

      <main className="mx-auto flex min-h-0 w-full max-w-[1920px] flex-1 flex-col overflow-hidden pb-2">
        {printers.length === 0 ? (
          <p className="border border-dashed border-bambu-dark-tertiary px-4 py-8 text-center text-bambu-gray">{t('kiosk.noPrinters')}</p>
        ) : (
          <>
            <section
              data-testid="kiosk-stats"
              aria-label={t('nav.printers')}
              className="grid shrink-0 grid-cols-5 overflow-hidden rounded-lg border border-bambu-dark-tertiary"
            >
              <KioskStat id="clear-plate" tone="plate" count={plateRows.length} label={t('kiosk.clearPlate')} />
              <KioskStat id="printing" tone="printing" count={printingRows.length} label={t('queue.status.printing')} />
              <KioskStat id="paused" tone="paused" count={pausedRows.length} label={t('queue.status.paused')} />
              <KioskStat id="queued" tone="queued" count={queueRows.length} label={t('queue.sections.queued')} />
              <KioskStat id="idle" tone="idle" count={idlePrinters.length} label={t('printers.status.idle', 'Idle')} />
            </section>

            <section data-testid="kiosk-jobs" aria-label={t('nav.queue')} className="relative mt-3 min-h-0 flex-1">
              {rows.length === 0 ? (
                <p className="border border-dashed border-bambu-dark-tertiary px-3 py-4 text-sm text-bambu-gray">{t('kiosk.noJobs')}</p>
              ) : (
                <>
                  <div data-testid="kiosk-job-list" ref={listRef} className="flex h-full flex-col gap-2 overflow-hidden">
                    {rows.map((row, index) => (
                      <div key={row.key} className="flex-none">
                        {/* Headings ride inside the first line of their group so overflow still counts jobs only. */}
                        {index === 0 && printingGroupCount > 0 && (
                          <QueueSectionHeading
                            size="kiosk"
                            testId="kiosk-section-printing"
                            label={t('queue.sections.printing')}
                            count={printingGroupCount}
                            className="mb-2"
                          />
                        )}
                        {index === printingGroupCount && queueRows.length > 0 && (
                          <QueueSectionHeading
                            size="kiosk"
                            testId="kiosk-section-up-next"
                            label={t('queue.sections.upNext')}
                            count={queueRows.length}
                            className={`mb-2 ${printingGroupCount > 0 ? 'mt-2' : ''}`}
                          />
                        )}
                        <div data-testid={`kiosk-job-${row.key}`}>
                          <QueueJobLine
                            size="kiosk"
                            item={row.item}
                            displayName={row.displayName}
                            printerState={row.printerState}
                            timeFormat={timeFormat}
                            t={t as unknown as (key: string, options?: Record<string, unknown>) => string}
                            progress={row.progress}
                            pauseReasonKey={row.pauseReasonKey}
                            status={row.status}
                            alert={row.alert}
                            extraFooter={row.extraFooter}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  {hiddenItemCount > 0 && (
                    <div data-testid="kiosk-job-overflow" className="pointer-events-none absolute inset-x-0 bottom-0 flex h-16 items-end justify-center bg-gradient-to-t from-bambu-dark to-transparent pb-0.5" aria-label={t('kiosk.moreJobs', { count: hiddenItemCount })}>
                      <span className="rounded-md bg-bambu-dark-tertiary px-3.5 py-0.5 text-base font-semibold text-white">{t('kiosk.moreJobs', { count: hiddenItemCount })}</span>
                    </div>
                  )}
                </>
              )}
            </section>

            {idlePrinters.length > 0 && (
              <footer
                data-testid="kiosk-idle-printers"
                aria-label={t('kiosk.idlePrinters')}
                className="mt-2.5 flex shrink-0 items-stretch overflow-hidden rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary"
              >
                <span className="flex items-center whitespace-nowrap border-r border-bambu-dark-tertiary px-[18px] text-[13px] font-semibold uppercase tracking-[0.06em] text-bambu-gray-light">
                  {t('kiosk.idlePrinters')}
                </span>
                {footerPrinters.map((printer) => (
                  <div
                    key={printer.id}
                    data-testid={`kiosk-idle-printer-${printer.id}`}
                    className="flex min-w-0 flex-1 flex-col justify-center border-l border-t-[3px] border-l-bambu-dark-tertiary border-t-bambu-gray-dark px-4 py-1.5 first:border-l-0"
                  >
                    <b className="truncate text-[17px] font-semibold text-white">{printer.name}</b>
                    <small className="truncate text-sm text-bambu-gray-light">{t('kiosk.ready')}</small>
                  </div>
                ))}
                {footerOverflow > 0 && (
                  <div
                    data-testid="kiosk-idle-overflow"
                    className="flex flex-none items-center border-l border-t-[3px] border-l-bambu-dark-tertiary border-t-bambu-gray-dark px-4 text-[17px] font-semibold text-bambu-gray-light"
                  >
                    {t('kiosk.morePrinters', { count: footerOverflow })}
                  </div>
                )}
              </footer>
            )}
          </>
        )}
      </main>
    </div>
  );
}

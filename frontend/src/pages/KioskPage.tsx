import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { AlertCircle, Calendar, Clock, Layers, ListOrdered, Pause, Play, Printer, User } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { api, type Printer as PrinterRecord, type PrinterStatus, type PrintQueueItem } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { type TimeFormat, formatDate, formatDuration, formatETA, parseUTCDate } from '../utils/date';
import { formatPrintName } from '../utils/printName';

type Translate = TFunction;

function isActivePrint(status: PrinterStatus | undefined): boolean {
  return status?.state === 'RUNNING' || status?.state === 'PAUSE';
}

function getPrinterStateLabel(status: PrinterStatus | undefined, t: Translate): string {
  if (!status) return t('common.loading');
  if (!status.connected) return t('printers.connection.offline');
  if (status.awaiting_plate_clear && !isActivePrint(status)) return t('kiosk.plateClearRequired');

  switch (status.state) {
    case 'RUNNING': return t('queue.status.printing');
    case 'PAUSE': return t('queue.status.paused');
    case 'FINISH': return t('queue.status.completed');
    case 'FAILED': return t('queue.status.failed');
    case 'IDLE': return t('printers.status.idle', 'Idle');
    default: return status.state ? status.state.charAt(0) + status.state.slice(1).toLowerCase() : t('printers.status.idle', 'Idle');
  }
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
  }, dependencies);

  return { ref, hiddenItemCount };
}

function KioskPrinterTile({
  printer,
  status,
  owner,
  timeFormat,
  t,
  className,
  style,
}: {
  printer: PrinterRecord;
  status: PrinterStatus | undefined;
  owner: string | undefined;
  timeFormat: TimeFormat;
  t: Translate;
  className?: string;
  style?: CSSProperties;
}) {
  const active = isActivePrint(status);
  const plateClearRequired = status?.awaiting_plate_clear === true && !active;
  const progress = plateClearRequired ? 100 : Math.max(0, Math.min(100, active ? status?.progress ?? 0 : 0));
  const jobName = active || plateClearRequired
    ? formatPrintName(status?.subtask_name || status?.current_print || status?.gcode_file || null, status?.gcode_file, t) || t('kiosk.noJob')
    : t('kiosk.noJob');
  const eta = active && status?.remaining_time != null && status.remaining_time > 0
    ? formatETA(status.remaining_time, timeFormat, t)
    : null;

  return (
    <article data-testid={`kiosk-printer-${printer.id}`} className={`h-full min-w-0 border border-bambu-dark-tertiary bg-bambu-dark-secondary p-3 ${plateClearRequired ? 'border-yellow-400/60 kiosk-plate-clear-alert' : ''} ${className || ''}`} style={style}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-white">{printer.name}</h2>
          <p className="truncate text-xs text-bambu-gray">{printer.model || t('common.unknown')}</p>
        </div>
        <span className={`shrink-0 text-[11px] font-medium ${plateClearRequired ? 'text-yellow-300' : status?.connected ? 'text-bambu-gray' : 'text-status-error'}`}>
          {getPrinterStateLabel(status, t)}
        </span>
      </div>

      <div className="mt-3 min-w-0">
        <p className="truncate text-sm text-white" title={jobName}>{jobName}</p>
        <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-bambu-gray" title={owner || t('kiosk.unknownOwner')}>
          <User className="h-3 w-3 shrink-0" />
          {owner || t('kiosk.unknownOwner')}
        </p>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-bambu-dark-tertiary">
          <div
            className={`h-full rounded-full transition-[width] duration-500 ${plateClearRequired ? 'bg-yellow-400' : 'bg-bambu-green'}`}
            data-testid={`kiosk-progress-${printer.id}`}
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="w-9 shrink-0 text-right text-xs font-medium tabular-nums text-white">{Math.round(progress)}%</span>
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-bambu-gray">
        <span>{active && status?.remaining_time != null && status.remaining_time > 0 ? formatDuration(status.remaining_time * 60) : plateClearRequired ? t('kiosk.plateClearRequired') : '—'}</span>
        {eta && <span className="shrink-0 text-bambu-green">{t('printers.eta', 'ETA')} {eta}</span>}
      </div>
    </article>
  );
}

function KioskQueueCard({
  item,
  status,
  timeFormat,
  t,
}: {
  item: PrintQueueItem;
  status: PrinterStatus | undefined;
  timeFormat: TimeFormat;
  t: Translate;
}) {
  const printing = item.status === 'printing';
  const active = printing && isActivePrint(status);
  const progress = active ? Math.max(0, Math.min(100, status?.progress ?? 0)) : 0;
  const title = item.archive_name || item.library_file_name || `${t('common.print')} #${item.id}`;
  const thumbnail = item.archive_thumbnail && item.archive_id
    ? api.getArchiveThumbnail(item.archive_id)
    : item.library_file_thumbnail && item.library_file_id
      ? api.getLibraryFileThumbnailUrl(item.library_file_id)
      : null;

  return (
    <article className={`border border-bambu-dark-tertiary border-l-[3px] bg-bambu-dark-secondary p-3 pr-5 ${printing ? 'border-l-blue-500' : 'border-l-yellow-500'}`}>
      <div className="flex min-w-0 gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-md bg-bambu-dark text-bambu-gray">
          {thumbnail ? <img src={thumbnail} alt="" className="h-full w-full object-cover" /> : <Layers className="h-5 w-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white" title={title}>{title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-bambu-gray">
            <span className="flex min-w-0 items-center gap-1"><Printer className="h-3 w-3 shrink-0" />{item.printer_name || (item.printer_id ? `${t('common.printer')} #${item.printer_id}` : t('queue.filter.unassigned'))}</span>
            {item.created_by_username && <span className="flex items-center gap-1"><User className="h-3 w-3" />{item.created_by_username}</span>}
            {item.print_time_seconds && <span>{formatDuration(item.print_time_seconds)}</span>}
          </div>
        </div>
        <KioskQueueStatusPill item={item} status={status} t={t} />
      </div>

      {printing && (
        <div className="mt-3">
          <div className="flex items-center gap-3">
            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-bambu-dark-tertiary">
              <div className="h-full rounded-full bg-bambu-green transition-[width] duration-500" style={{ width: `${progress}%` }} />
            </div>
            <span className="text-xs font-medium tabular-nums text-white">{Math.round(progress)}%</span>
          </div>
          {active && status?.remaining_time != null && status.remaining_time > 0 && (
            <div className="mt-1 flex items-center gap-2 text-[11px] text-bambu-gray">
              <Clock className="h-3 w-3" />
              <span>{formatDuration(status.remaining_time * 60)}</span>
              <span className="text-bambu-green">{t('printers.eta', 'ETA')} {formatETA(status.remaining_time, timeFormat, t)}</span>
            </div>
          )}
        </div>
      )}

    </article>
  );
}

/** Compact kiosk equivalent of the main Queue page's status badge. */
function KioskQueueStatusPill({
  item,
  status,
  t,
}: {
  item: PrintQueueItem;
  status: PrinterStatus | undefined;
  t: Translate;
}) {
  const scheduled = item.status === 'pending' && item.scheduled_time && (parseUTCDate(item.scheduled_time)?.getTime() ?? 0) > Date.now();
  const className = 'flex max-w-[48%] shrink-0 items-center gap-1 self-center truncate rounded-full border px-2 py-1 text-right text-xs';

  if (scheduled) {
    return (
      <p data-testid={`kiosk-queue-status-${item.id}`} className={`${className} border-yellow-500/20 bg-yellow-500/10 text-yellow-300`} title={formatDate(item.scheduled_time)}>
        <Calendar className="h-3 w-3 shrink-0" />
        <span className="truncate">{t('queue.status.scheduled')} · {formatDate(item.scheduled_time)}</span>
      </p>
    );
  }

  if (item.status === 'pending' && item.waiting_reason) {
    return (
      <p data-testid={`kiosk-queue-status-${item.id}`} className={`${className} border-purple-400/30 bg-purple-400/10 text-purple-400`} title={item.waiting_reason}>
        <AlertCircle className="h-3 w-3 shrink-0" />
        <span className="truncate">{t('queue.status.waiting')} · {item.waiting_reason}</span>
      </p>
    );
  }

  if (item.status === 'printing') {
    const paused = status?.state === 'PAUSE';
    return (
      <p data-testid={`kiosk-queue-status-${item.id}`} className={`${className} ${paused ? 'border-yellow-400/20 bg-yellow-400/10 text-yellow-400' : 'border-blue-400/20 bg-blue-400/10 text-blue-400'}`}>
        {paused ? <Pause className="h-3 w-3 shrink-0" /> : <Play className="h-3 w-3 shrink-0" />}
        <span className="truncate">{paused ? t('queue.status.paused') : t('queue.status.printing')}</span>
      </p>
    );
  }

  if (item.status === 'dispatching') {
    return (
      <p data-testid={`kiosk-queue-status-${item.id}`} className={`${className} border-purple-500/20 bg-purple-500/10 text-purple-300`}>
        <Clock className="h-3 w-3 shrink-0 animate-pulse" />
        <span className="truncate">{t('queue.status.dispatching')}</span>
      </p>
    );
  }

  return (
    <p data-testid={`kiosk-queue-status-${item.id}`} className={`${className} border-status-warning/20 bg-status-warning/10 text-status-warning`}>
      <Clock className="h-3 w-3 shrink-0" />
      <span className="truncate">{t('queue.status.pending')}</span>
    </p>
  );
}

function KioskQueueSection({
  title,
  items,
  statuses,
  timeFormat,
  t,
  className,
  testId,
  fillAvailableHeight = false,
  listClassName,
}: {
  title: string;
  items: PrintQueueItem[];
  statuses: Map<number, PrinterStatus | undefined>;
  timeFormat: TimeFormat;
  t: Translate;
  className?: string;
  testId: string;
  fillAvailableHeight?: boolean;
  listClassName?: string;
}) {
  const { ref, hiddenItemCount } = useOverflowing([items, statuses]);

  return (
    <section data-testid={testId} className={`${fillAvailableHeight ? 'flex min-h-0 flex-col' : ''} ${className || ''}`} aria-label={title}>
      <div className="mb-2 flex shrink-0 items-center gap-2">
        <ListOrdered className="h-4 w-4 text-bambu-green" />
        <h2 className="text-base font-semibold text-white">{title}</h2>
        <span className="text-xs text-bambu-gray">({items.length})</span>
      </div>
      {items.length === 0 ? (
        <p className="border border-dashed border-bambu-dark-tertiary px-3 py-4 text-sm text-bambu-gray">{title === t('queue.sections.activeJobs') ? t('kiosk.noPrinting') : t('kiosk.noQueue')}</p>
      ) : (
        <div className={`relative min-h-0 ${fillAvailableHeight ? 'flex-1' : ''}`}>
          <div data-testid={`${testId}-list`} ref={ref} className={`${fillAvailableHeight ? 'h-full' : ''} space-y-2 overflow-hidden ${listClassName || ''}`}>
            {items.map((item) => <KioskQueueCard key={item.id} item={item} status={item.printer_id ? statuses.get(item.printer_id) : undefined} timeFormat={timeFormat} t={t} />)}
          </div>
          {hiddenItemCount > 0 && (
            <div data-testid={`${testId}-overflow`} className="pointer-events-none absolute inset-x-0 bottom-0 flex h-12 items-end justify-center bg-gradient-to-t from-bambu-dark to-transparent pb-1" aria-label={t('kiosk.moreJobs', { count: hiddenItemCount })}>
              <span className="rounded-full bg-bambu-dark-tertiary px-2 py-0.5 text-sm font-medium text-white">{t('kiosk.moreJobs', { count: hiddenItemCount })}</span>
            </div>
          )}
        </div>
      )}
    </section>
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
  const printingItems = useMemo(
    () => queue.filter((item) => item.status === 'dispatching' || item.status === 'printing'),
    [queue],
  );
  const pendingItems = useMemo(() => queue.filter((item) => item.status === 'pending').sort((a, b) => a.position - b.position), [queue]);
  const printingItemsByPrinter = useMemo(() => new Map(printingItems.filter((item) => item.printer_id != null).map((item) => [item.printer_id!, item])), [printingItems]);

  const ownerQueries = useQueries({
    queries: printers.map((printer) => {
      const status = statuses.get(printer.id);
      const queueItem = printingItemsByPrinter.get(printer.id);
      return {
        queryKey: ['currentPrintUser', printer.id],
        queryFn: () => api.getCurrentPrintUser(printer.id),
        enabled: isActivePrint(status) && !queueItem?.created_by_username,
        staleTime: 30_000,
      };
    }),
  });
  const owners = useMemo(() => new Map(printers.map((printer, index) => {
    const queueOwner = printingItemsByPrinter.get(printer.id)?.created_by_username;
    return [printer.id, queueOwner || ownerQueries[index]?.data?.username];
  })), [ownerQueries, printers, printingItemsByPrinter]);

  const prioritizedPrinters = useMemo(() => [...printers].sort((a, b) => {
    const priority = (printer: PrinterRecord) => {
      const status = statuses.get(printer.id);
      if (status?.awaiting_plate_clear && !isActivePrint(status)) return 0;
      if (isActivePrint(status)) return 1;
      return 2;
    };
    const priorityDifference = priority(a) - priority(b);
    return priorityDifference || a.name.localeCompare(b.name);
  }), [printers, statuses]);
  const hasPrinterOverflow = prioritizedPrinters.length > 3;
  const visiblePrinters = prioritizedPrinters.slice(0, hasPrinterOverflow ? 4 : 3);
  const overflowPrinterCount = Math.max(0, prioritizedPrinters.length - 3);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 10_000);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <div data-testid="kiosk-page" className="flex h-screen flex-col overflow-hidden bg-bambu-dark px-4 py-4 sm:px-6 lg:px-8">
      <header className="mx-auto flex w-full shrink-0 max-w-[1920px] items-center justify-between border-b border-bambu-dark-tertiary pb-3">
        <img src={resolvedMode === 'dark' ? '/img/grove_control_logo_dark_transparent.png' : '/img/grove_control_logo_light.png'} alt="Grove Control" className="h-9 w-auto sm:h-10" />
        <time className="text-lg font-medium tabular-nums text-white sm:text-xl">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
      </header>

      <main className="mx-auto flex min-h-0 w-full max-w-[1920px] flex-1 flex-col overflow-hidden pb-4">
        <section className="shrink-0 py-3" aria-labelledby="kiosk-fleet-heading">
          <div className="mb-3 flex items-center gap-2">
            <Printer className="h-5 w-5 text-bambu-green" />
            <h1 id="kiosk-fleet-heading" className="text-lg font-semibold text-white">{t('nav.printers')}</h1>
          </div>
          {printers.length === 0 ? (
            <p className="border border-dashed border-bambu-dark-tertiary px-4 py-8 text-center text-bambu-gray">{t('kiosk.noPrinters')}</p>
          ) : (
            <div className="relative overflow-hidden">
              <div data-testid="kiosk-fleet-grid" className="flex h-[154px] gap-3">
                {visiblePrinters.map((printer) => (
                  <KioskPrinterTile
                    key={printer.id}
                    printer={printer}
                    status={statuses.get(printer.id)}
                    owner={owners.get(printer.id)}
                    timeFormat={timeFormat}
                    t={t}
                    className={hasPrinterOverflow ? 'shrink-0' : 'flex-1'}
                    style={hasPrinterOverflow ? { flexBasis: 'calc((100% - 2.25rem) / 3.25)' } : undefined}
                  />
                ))}
              </div>
              {overflowPrinterCount > 0 && (
                <div data-testid="kiosk-fleet-overflow" className="pointer-events-none absolute inset-y-0 right-0 flex w-[10%] items-center justify-end bg-gradient-to-l from-bambu-dark via-bambu-dark/85 to-transparent pr-3" aria-label={t('kiosk.morePrinters', { count: overflowPrinterCount })}>
                  <span className="rounded-full bg-bambu-dark-tertiary px-2 py-0.5 text-sm font-medium text-white">{t('kiosk.morePrinters', { count: overflowPrinterCount })}</span>
                </div>
              )}
            </div>
          )}
        </section>

        <div data-testid="kiosk-queue-area" className="flex min-h-0 flex-1 flex-col border-t border-bambu-dark-tertiary pt-3">
          <KioskQueueSection title={t('queue.sections.activeJobs')} items={printingItems} statuses={statuses} timeFormat={timeFormat} t={t} testId="kiosk-printing-section" className="mb-4 shrink-0" listClassName="max-h-52" />
          <KioskQueueSection title={t('queue.sections.queued')} items={pendingItems} statuses={statuses} timeFormat={timeFormat} t={t} testId="kiosk-pending-section" fillAvailableHeight />
        </div>
      </main>
    </div>
  );
}

import { useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Wrench,
  Loader2,
  Check,
  AlertTriangle,
  Clock,
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
  Droplet,
  Flame,
  Ruler,
  Sparkles,
  Square,
  Cable,
  Edit3,
  Calendar,
  CalendarCheck,
  Timer,
  Cog,
  Fan,
  Zap,
  Wind,
  Thermometer,
  Layers,
  Box,
  Target,
  RefreshCw,
  Settings,
  Filter,
  CircleDot,
  ScanLine,
  Printer,
  ExternalLink,
  ListChecks,
  Power,
} from 'lucide-react';
import { api } from '../api/client';
import type {
  MaintenanceLogEntry,
  MaintenanceLogEntryInput,
  MaintenanceIntervalType,
  MaintenanceLogEntryType,
  MaintenanceStatus,
  PrinterMaintenanceOverview,
  MaintenanceType,
  Permission,
} from '../api/client';
import { getMaintenanceWikiUrl } from '../utils/maintenanceWikiUrls';
import { parseUTCDate, formatDateInput, type DateFormat } from '../utils/date';
import { Card, CardContent } from '../components/Card';
import { Button } from '../components/Button';
import { Toggle } from '../components/Toggle';
import { ConfirmModal } from '../components/ConfirmModal';
import { useToast } from '../contexts/ToastContext';
import { useAuth } from '../contexts/AuthContext';
import { ReactSelect } from '../components/ToolbarControls';
import { DateTimePicker } from '../components/DateTimePicker';

// Icon mapping for maintenance types
const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  Droplet,
  Flame,
  Ruler,
  Sparkles,
  Square,
  Cable,
  Wrench,
  Calendar,
  Timer,
  Cog,
  Fan,
  Zap,
  Wind,
  Thermometer,
  Layers,
  Box,
  Target,
  RefreshCw,
  Settings,
  Filter,
  CircleDot,
  ScanLine,
};

const logGridClass =
  'grid grid-cols-[110px_minmax(0,1fr)_150px_140px_130px_100px_100px] items-center gap-x-4 px-5';

const maintenanceFieldClass =
  'w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none';

function getIcon(iconName: string | null) {
  if (!iconName) return Wrench;
  return iconMap[iconName] || Wrench;
}

type TFunction = (key: string, options?: Record<string, unknown>) => string;

// Icon for an interval type: calendar for time-based, printer for job-based, timer for print hours
function IntervalTypeIcon({ type, className }: { type: MaintenanceIntervalType; className: string }) {
  if (type === 'days') return <Calendar className={className} />;
  if (type === 'jobs') return <Printer className={className} />;
  if (type === 'changes') return <RefreshCw className={className} />;
  return <Timer className={className} />;
}

function formatChanges(value: number, t?: TFunction): string {
  const changes = Math.max(0, Math.round(value));
  if (changes === 1) return t ? t('maintenance.change') : '1 change';
  return t ? t('maintenance.changes', { count: changes }) : `${changes} changes`;
}

function formatJobs(value: number, t?: TFunction): string {
  const jobs = Math.max(0, Math.round(value));
  if (jobs === 1) return t ? t('maintenance.job') : '1 job';
  return t ? t('maintenance.jobs', { count: jobs }) : `${jobs} jobs`;
}

function formatIntervalLabel(value: number, type: MaintenanceIntervalType, t?: TFunction): string {
  if (type === 'jobs') return formatJobs(value, t);
  if (type === 'changes') return formatChanges(value, t);
  if (type === 'days') {
    if (value === 1) return t ? t('maintenance.day') : '1 day';
    if (value === 7) return t ? t('maintenance.week') : '1 week';
    if (value === 14) return t ? t('maintenance.weeks', { count: 2 }) : '2 weeks';
    if (value === 30) return t ? t('maintenance.month') : '1 month';
    if (value === 60) return t ? t('maintenance.months', { count: 2 }) : '2 months';
    if (value === 90) return t ? t('maintenance.months', { count: 3 }) : '3 months';
    if (value === 180) return t ? t('maintenance.months', { count: 6 }) : '6 months';
    if (value === 365) return t ? t('maintenance.year') : '1 year';
    return t ? t('maintenance.days', { count: value }) : `${value} days`;
  }
  return `${value}h`;
}

function toDateTimeLocal(value: string | Date = new Date()): string {
  const date = typeof value === 'string' ? (parseUTCDate(value) ?? new Date(value)) : value;
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}


// ---------------------------------------------------------------------------
// Status tab: a machine rail on the left and either the fleet-wide to-do list
// ("All machines") or the detail for one printer on the right.
// ---------------------------------------------------------------------------

type TaskStatus = 'overdue' | 'soon' | 'ok' | 'off';

interface TaskMetrics {
  status: TaskStatus;
  intervalType: MaintenanceIntervalType;
  /** Units left until due; negative once overdue. */
  remaining: number;
  used: number;
  interval: number;
  /** Share of the interval used, 0-100 for drawing the meter. */
  percent: number;
  /** Unclamped share of the interval used, so a task twice overdue sorts first. */
  ratio: number;
}

function getTaskMetrics(item: MaintenanceStatus): TaskMetrics {
  const intervalType = item.interval_type || 'hours';
  const interval = item.interval_hours;
  let used: number;
  let remaining: number;
  if (intervalType === 'jobs') {
    used = item.jobs_since_maintenance ?? 0;
    remaining = item.jobs_until_due ?? 0;
  } else if (intervalType === 'changes') {
    used = item.changes_since_maintenance ?? 0;
    remaining = item.changes_until_due ?? 0;
  } else if (intervalType === 'days') {
    used = item.days_since_maintenance ?? 0;
    remaining = item.days_until_due ?? 0;
  } else {
    used = interval - item.hours_until_due;
    remaining = item.hours_until_due;
  }
  const ratio = interval > 0 ? used / interval : 0;
  const status: TaskStatus = !item.enabled ? 'off' : item.is_due ? 'overdue' : item.is_warning ? 'soon' : 'ok';
  return {
    status,
    intervalType,
    remaining,
    used,
    interval,
    percent: Math.max(0, Math.min(100, ratio * 100)),
    ratio,
  };
}

/** Time left on an hours interval; under an hour reads in minutes. */
function formatRemainingHours(value: number): string {
  if (value < 1) return `${Math.round(value * 60)}m`;
  return `${Math.round(value)}h`;
}

/** Plain amount in an interval's own unit, e.g. "214h", "27 jobs". */
function formatAmount(value: number, type: MaintenanceIntervalType, t: TFunction): string {
  const amount = Math.max(0, Math.round(value));
  if (type === 'jobs') return formatJobs(amount, t);
  if (type === 'changes') return formatChanges(amount, t);
  if (type === 'days') return amount === 1 ? t('maintenance.day') : t('maintenance.days', { count: amount });
  return `${amount}h`;
}

const STATUS_STYLES: Record<TaskStatus, { text: string; bar: string; chip: string; border: string }> = {
  overdue: { text: 'text-red-400', bar: 'bg-red-400', chip: 'bg-red-500/15 text-red-400', border: 'border-red-500/40' },
  soon: { text: 'text-amber-400', bar: 'bg-amber-400', chip: 'bg-amber-500/15 text-amber-400', border: 'border-bambu-dark-tertiary' },
  ok: { text: 'text-bambu-green', bar: 'bg-bambu-green', chip: 'bg-bambu-green/15 text-bambu-green', border: 'border-bambu-dark-tertiary' },
  off: { text: 'text-bambu-gray-light', bar: 'bg-bambu-gray', chip: 'bg-bambu-dark-tertiary text-bambu-gray-light', border: 'border-bambu-dark-tertiary' },
};

function summariseTasks(items: MaintenanceStatus[]) {
  const counts = { overdue: 0, soon: 0, ok: 0, off: 0 };
  for (const item of items) counts[getTaskMetrics(item).status] += 1;
  return counts;
}

function statusLabel(status: TaskStatus, t: TFunction): string {
  if (status === 'overdue') return t('common.overdue');
  if (status === 'soon') return t('maintenance.dueSoon');
  if (status === 'ok') return t('maintenance.onTrack');
  return t('common.disabled');
}

function HealthBar({ overdue, soon, ok }: { overdue: number; soon: number; ok: number }) {
  const segment = (count: number, color: string) =>
    count > 0 ? <span className={`h-full rounded-full ${color}`} style={{ flexGrow: count, flexBasis: 0 }} /> : null;
  return (
    <span aria-hidden="true" className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full bg-bambu-dark-tertiary">
      {segment(overdue, 'bg-red-400')}
      {segment(soon, 'bg-amber-400')}
      {segment(ok, 'bg-bambu-green')}
    </span>
  );
}

function HealthSummary({ counts, t }: { counts: { overdue: number; soon: number; ok: number }; t: TFunction }) {
  const parts: string[] = [];
  if (counts.overdue > 0) parts.push(t('maintenance.overdueCount', { count: counts.overdue }));
  if (counts.soon > 0) parts.push(t('maintenance.dueSoonCount', { count: counts.soon }));
  if (counts.overdue === 0 && counts.soon === 0) {
    parts.push(counts.ok > 0 ? t('maintenance.allOnTrack') : t('maintenance.noTasks'));
  } else if (counts.ok > 0) {
    parts.push(t('maintenance.onTrackCount', { count: counts.ok }));
  }
  return <>{parts.join(' · ')}</>;
}

function MachineRail({
  overview,
  selected,
  onSelect,
  t,
}: {
  overview: PrinterMaintenanceOverview[];
  selected: number | 'all';
  onSelect: (selection: number | 'all') => void;
  t: TFunction;
}) {
  const printers = [...overview]
    .map((printer) => ({ printer, counts: summariseTasks(printer.maintenance_items) }))
    .sort((a, b) => {
      const aScore = a.counts.overdue * 10 + a.counts.soon;
      const bScore = b.counts.overdue * 10 + b.counts.soon;
      if (aScore !== bScore) return bScore - aScore;
      return a.printer.printer_name.localeCompare(b.printer.printer_name);
    });
  const fleet = printers.reduce(
    (sum, { counts }) => ({ overdue: sum.overdue + counts.overdue, soon: sum.soon + counts.soon, ok: sum.ok + counts.ok }),
    { overdue: 0, soon: 0, ok: 0 },
  );

  const itemClass = (isSelected: boolean) =>
    `flex min-w-[230px] shrink-0 flex-col gap-2.5 rounded-xl border p-4 text-left transition-colors lg:min-w-0 ${
      isSelected
        ? 'border-bambu-green bg-bambu-dark-secondary'
        : 'border-bambu-dark-tertiary hover:bg-bambu-dark-secondary/60'
    }`;

  return (
    <nav aria-label={t('maintenance.machinesNav')} className="flex gap-2 overflow-x-auto pb-1 lg:w-72 lg:shrink-0 lg:flex-col lg:overflow-visible lg:pb-0">
      <button
        type="button"
        aria-current={selected === 'all' ? 'true' : undefined}
        onClick={() => onSelect('all')}
        className={itemClass(selected === 'all')}
      >
        <span className="flex items-center gap-2.5 font-semibold text-white">
          <ListChecks className="h-[18px] w-[18px]" aria-hidden="true" />
          {t('maintenance.allMachines')}
        </span>
        <HealthBar {...fleet} />
        <span className="text-xs text-bambu-gray-light"><HealthSummary counts={fleet} t={t} /></span>
      </button>
      <div aria-hidden="true" className="my-1 hidden h-px bg-bambu-dark-tertiary lg:block" />
      {printers.map(({ printer, counts }) => {
        const isSelected = selected === printer.printer_id;
        return (
          <button
            key={printer.printer_id}
            type="button"
            aria-current={isSelected ? 'true' : undefined}
            onClick={() => onSelect(printer.printer_id)}
            className={itemClass(isSelected)}
          >
            <span className="flex items-baseline justify-between gap-2">
              <span className="truncate font-semibold text-white">{printer.printer_name}</span>
              {printer.printer_model && <span className="shrink-0 text-xs text-bambu-gray-light">{printer.printer_model}</span>}
            </span>
            <HealthBar {...counts} />
            <span className="flex items-center justify-between gap-2 text-xs text-bambu-gray-light">
              <span><HealthSummary counts={counts} t={t} /></span>
              {printer.is_active === false && (
                <span className="shrink-0 font-semibold text-blue-400">{t('printers.maintenance.modeLabel')}</span>
              )}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

function TaskRow({
  item,
  printerName,
  dateFormat,
  onPerform,
  onToggle,
  hasPermission,
  t,
}: {
  item: MaintenanceStatus;
  dateFormat: DateFormat;
  /** Set on the all-machines list, where rows from every printer are mixed. */
  printerName?: string;
  onPerform: (id: number) => void;
  onToggle?: (id: number, enabled: boolean) => void;
  hasPermission: (permission: Permission) => boolean;
  t: TFunction;
}) {
  const metrics = getTaskMetrics(item);
  const styles = STATUS_STYLES[metrics.status];
  const canUpdate = hasPermission('maintenance:update');
  const wikiUrl = item.maintenance_type_wiki_url || getMaintenanceWikiUrl(item.maintenance_type_name, item.printer_model);

  const magnitude = Math.abs(metrics.remaining);
  const isToday = metrics.intervalType === 'days' && metrics.status !== 'overdue' && magnitude < 1;
  const countdown = metrics.status === 'off'
    ? '—'
    : isToday
      ? t('common.today')
      : metrics.intervalType === 'hours'
        ? formatRemainingHours(magnitude)
        : formatAmount(metrics.status === 'overdue' && metrics.intervalType === 'days' ? Math.max(1, magnitude) : magnitude, metrics.intervalType, t);
  const caption = metrics.status === 'off'
    ? t('common.disabled')
    : isToday
      ? ''
      : metrics.status === 'overdue'
        ? t('maintenance.countdownOverdue')
        : t('maintenance.countdownLeft');

  const lastPerformed = parseUTCDate(item.last_performed_at);
  const lastDone = lastPerformed
    ? t('maintenance.lastDone', { date: formatDateInput(lastPerformed, dateFormat) })
    : t('maintenance.neverDone');
  const rule = t('maintenance.everyInterval', { interval: formatIntervalLabel(metrics.interval, metrics.intervalType, t) });
  const actionLabel = `${t('maintenance.markDone')}: ${item.maintenance_type_name}${printerName ? ` (${printerName})` : ''}`;

  return (
    <div
      role="group"
      aria-label={printerName ? `${item.maintenance_type_name} (${printerName})` : item.maintenance_type_name}
      className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-bambu-dark-tertiary/60 px-5 py-3.5 last:border-b-0"
    >
      <div className="w-28 shrink-0">
        <div className={`whitespace-nowrap text-xl font-bold leading-tight tabular-nums ${metrics.status === 'ok' || metrics.status === 'soon' ? 'text-white' : styles.text}`}>
          {countdown}
        </div>
        {caption && <div className="text-xs text-bambu-gray-light">{caption}</div>}
      </div>

      <div className="min-w-[200px] flex-1">
        <div className="flex items-center gap-2">
          <h3 className={`font-semibold ${item.enabled ? 'text-white' : 'text-bambu-gray-light'}`}>{item.maintenance_type_name}</h3>
          {wikiUrl && (
            <a
              href={wikiUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 text-bambu-gray-light transition-colors hover:text-bambu-green"
              title={t('maintenance.viewDocumentation')}
              aria-label={t('maintenance.viewDocumentation')}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-bambu-gray-light">
          {printerName && (
            <span className="rounded-md bg-bambu-dark-tertiary px-2 py-0.5 text-xs font-medium text-white">{printerName}</span>
          )}
          <span>{printerName ? rule : `${rule} · ${lastDone}`}</span>
        </div>
      </div>

      <div className="min-w-[150px] flex-[0_1_200px]">
        <div className="mb-1.5 text-xs tabular-nums text-bambu-gray-light">
          {formatAmount(metrics.used, metrics.intervalType, t)} / {formatAmount(metrics.interval, metrics.intervalType, t)}
        </div>
        <div
          role="progressbar"
          aria-label={item.maintenance_type_name}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(metrics.percent)}
          className="h-1.5 overflow-hidden rounded-full bg-bambu-dark-tertiary"
        >
          <div className={`h-full rounded-full transition-all duration-500 ${styles.bar}`} style={{ width: `${metrics.percent}%` }} />
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {onToggle && (
          <span title={!canUpdate ? t('maintenance.noPermissionUpdate') : undefined}>
            <Toggle checked={item.enabled} onChange={(checked) => onToggle(item.id, checked)} disabled={!canUpdate} />
          </span>
        )}
        <Button
          size="sm"
          variant={metrics.status === 'overdue' ? 'primary' : 'secondary'}
          onClick={() => onPerform(item.id)}
          disabled={!item.enabled || !canUpdate}
          title={!canUpdate ? t('maintenance.noPermissionPerform') : undefined}
          aria-label={actionLabel}
        >
          <Check className="h-4 w-4" />
          {t('maintenance.markDone')}
        </Button>
      </div>
    </div>
  );
}

const MAX_ON_TRACK_COLLAPSED = 8;

function AllMachinesView({
  overview,
  dateFormat,
  onPerform,
  hasPermission,
  t,
}: {
  overview: PrinterMaintenanceOverview[];
  dateFormat: DateFormat;
  onPerform: (id: number) => void;
  hasPermission: (permission: Permission) => boolean;
  t: TFunction;
}) {
  const [filter, setFilter] = useState<'all' | 'attention'>('all');
  const [showAllOnTrack, setShowAllOnTrack] = useState(false);

  const tasks = useMemo(() => {
    return overview
      .flatMap((printer) =>
        printer.maintenance_items
          .filter((item) => item.enabled)
          .map((item) => ({ item, printerName: printer.printer_name, metrics: getTaskMetrics(item) })),
      )
      .sort((a, b) => {
        const rank = (status: TaskStatus) => (status === 'overdue' ? 0 : status === 'soon' ? 1 : 2);
        if (rank(a.metrics.status) !== rank(b.metrics.status)) return rank(a.metrics.status) - rank(b.metrics.status);
        if (a.metrics.ratio !== b.metrics.ratio) return b.metrics.ratio - a.metrics.ratio;
        return a.item.maintenance_type_name.localeCompare(b.item.maintenance_type_name);
      });
  }, [overview]);

  const overdue = tasks.filter((task) => task.metrics.status === 'overdue');
  const soon = tasks.filter((task) => task.metrics.status === 'soon');
  const onTrack = tasks.filter((task) => task.metrics.status === 'ok');
  const attentionCount = overdue.length + soon.length;
  const visibleOnTrack = filter === 'attention' ? [] : showAllOnTrack ? onTrack : onTrack.slice(0, MAX_ON_TRACK_COLLAPSED);
  const hiddenOnTrack = filter === 'attention' ? 0 : onTrack.length - visibleOnTrack.length;

  const bands: { status: TaskStatus; rows: typeof tasks }[] = [
    { status: 'overdue', rows: overdue },
    { status: 'soon', rows: soon },
    { status: 'ok', rows: visibleOnTrack },
  ];

  const segment = (value: 'all' | 'attention', label: string) => (
    <button
      type="button"
      aria-pressed={filter === value}
      onClick={() => setFilter(value)}
      className={`min-h-[36px] rounded-md px-3.5 text-sm font-medium transition-colors ${
        filter === value ? 'bg-bambu-dark-tertiary text-white' : 'text-bambu-gray-light hover:text-white'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="min-w-0 flex-1 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-white">{t('maintenance.allMachines')}</h2>
          <p className="text-sm text-bambu-gray-light">{t('maintenance.allMachinesDescription')}</p>
        </div>
        <div role="group" aria-label={t('maintenance.taskFilter')} className="flex rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary p-0.5">
          {segment('attention', t('maintenance.needsAttentionCount', { count: attentionCount }))}
          {segment('all', t('maintenance.allTasksCount', { count: tasks.length }))}
        </div>
      </div>

      {tasks.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Wrench className="mx-auto mb-3 h-12 w-12 text-bambu-gray/30" />
            <p className="font-medium text-white">{t('maintenance.noTasks')}</p>
            <p className="mt-1 text-sm text-bambu-gray-light">{t('maintenance.configureSettings')}</p>
          </CardContent>
        </Card>
      ) : filter === 'attention' && attentionCount === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Check className="mx-auto mb-3 h-12 w-12 text-bambu-green" />
            <p className="font-medium text-white">{t('maintenance.nothingNeedsAttention')}</p>
            <p className="mt-1 text-sm text-bambu-gray-light">{t('maintenance.nothingNeedsAttentionDescription')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary">
          {bands.filter((band) => band.rows.length > 0).map((band) => (
            <section key={band.status} aria-label={statusLabel(band.status, t)}>
              <h3 className={`flex h-9 items-center gap-2 border-b border-bambu-dark-tertiary/60 bg-bambu-dark/40 px-5 text-xs font-semibold uppercase tracking-wide ${STATUS_STYLES[band.status].text}`}>
                {statusLabel(band.status, t)}
                <span className="font-medium normal-case tracking-normal text-bambu-gray-light">
                  {band.status === 'ok' && hiddenOnTrack > 0 ? `${band.rows.length} / ${onTrack.length}` : band.rows.length}
                </span>
              </h3>
              {band.rows.map(({ item, printerName }) => (
                <TaskRow
                  key={item.id}
                  item={item}
                  printerName={printerName}
                  dateFormat={dateFormat}
                  onPerform={onPerform}
                  hasPermission={hasPermission}
                  t={t}
                />
              ))}
            </section>
          ))}
          {filter === 'all' && onTrack.length > MAX_ON_TRACK_COLLAPSED && (
            <button
              type="button"
              onClick={() => setShowAllOnTrack((value) => !value)}
              className="flex min-h-[52px] w-full items-center justify-center gap-2 text-sm font-medium text-bambu-gray-light transition-colors hover:text-white"
            >
              {showAllOnTrack
                ? t('maintenance.showFewerOnTrack')
                : t('maintenance.showMoreOnTrack', { count: hiddenOnTrack })}
              {showAllOnTrack ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PrinterView({
  overview,
  dateFormat,
  onPerform,
  onToggle,
  onSetHours,
  onLogRepair,
  onToggleMaintenanceMode,
  maintenanceModePending,
  hasPermission,
  t,
}: {
  overview: PrinterMaintenanceOverview;
  dateFormat: DateFormat;
  onPerform: (id: number) => void;
  onToggle: (id: number, enabled: boolean) => void;
  onSetHours: (printerId: number, hours: number) => void;
  onLogRepair: (printerId: number) => void;
  onToggleMaintenanceMode: (printerId: number, enterMaintenance: boolean) => void;
  maintenanceModePending: boolean;
  hasPermission: (permission: Permission) => boolean;
  t: TFunction;
}) {
  const [editingHours, setEditingHours] = useState(false);
  const [hoursInput, setHoursInput] = useState(overview.total_print_hours.toFixed(1));
  const canUpdate = hasPermission('maintenance:update');

  const sections = useMemo(() => {
    const decorated = overview.maintenance_items.map((item) => ({ item, metrics: getTaskMetrics(item) }));
    decorated.sort((a, b) => {
      if (a.metrics.ratio !== b.metrics.ratio && a.metrics.status !== 'off' && b.metrics.status !== 'off') {
        return b.metrics.ratio - a.metrics.ratio;
      }
      return a.item.maintenance_type_id - b.item.maintenance_type_id;
    });
    return (['overdue', 'soon', 'ok', 'off'] as TaskStatus[])
      .map((status) => ({ status, rows: decorated.filter((task) => task.metrics.status === status) }))
      .filter((section) => section.rows.length > 0);
  }, [overview.maintenance_items]);

  const counts = summariseTasks(overview.maintenance_items);

  const handleSaveHours = () => {
    const hours = parseFloat(hoursInput);
    if (!isNaN(hours) && hours >= 0) {
      onSetHours(overview.printer_id, hours);
      setEditingHours(false);
    }
  };

  const tile = 'flex items-center justify-between gap-3 rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary px-4 py-3';

  return (
    <div className="min-w-0 flex-1 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-bold text-white">{overview.printer_name}</h2>
          {overview.printer_model && <span className="text-sm text-bambu-gray-light">{overview.printer_model}</span>}
          {overview.is_active === false && (
            <span className="flex items-center gap-1.5 rounded-full bg-blue-500/20 px-2.5 py-1 text-xs font-medium text-blue-400">
              <Wrench className="h-3 w-3" />
              {t('printers.maintenance.modeLabel')}
            </span>
          )}
          {counts.overdue > 0 && (
            <span className="flex items-center gap-1.5 rounded-full bg-red-500/20 px-2.5 py-1 text-xs font-medium text-red-400">
              <AlertTriangle className="h-3 w-3" />
              {t('maintenance.overdueCount', { count: counts.overdue })}
            </span>
          )}
          {counts.soon > 0 && (
            <span className="flex items-center gap-1.5 rounded-full bg-amber-500/20 px-2.5 py-1 text-xs font-medium text-amber-400">
              <Clock className="h-3 w-3" />
              {t('maintenance.dueSoonCount', { count: counts.soon })}
            </span>
          )}
          {counts.overdue === 0 && counts.soon === 0 && (
            <span className="flex items-center gap-1.5 rounded-full bg-bambu-green/20 px-2.5 py-1 text-xs font-medium text-bambu-green">
              <Check className="h-3 w-3" />
              {t('maintenance.allGood')}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hasPermission('printers:update') && (
            <Button
              variant="secondary"
              disabled={maintenanceModePending}
              onClick={() => onToggleMaintenanceMode(overview.printer_id, overview.is_active !== false)}
            >
              <Power className="h-4 w-4" />
              {overview.is_active === false
                ? t('printers.maintenance.menuExit')
                : t('printers.maintenance.menuEnter')}
            </Button>
          )}
          {hasPermission('maintenance:create') && (
            <Button variant="secondary" onClick={() => onLogRepair(overview.printer_id)}>
              <Wrench className="h-4 w-4" />
              {t('maintenance.logRepair')}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className={tile}>
          <div>
            <div className="text-xs text-bambu-gray-light">{t('maintenance.totalPrintTime')}</div>
            {editingHours ? (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <input
                  type="number"
                  aria-label={t('maintenance.editPrintHours')}
                  value={hoursInput}
                  onChange={(e) => setHoursInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveHours();
                    if (e.key === 'Escape') setEditingHours(false);
                  }}
                  className="w-24 rounded border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1 text-sm text-white"
                  min="0"
                  step="1"
                  autoFocus
                />
                <span className="text-xs text-bambu-gray-light">{t('common.hours')}</span>
                <Button size="sm" onClick={handleSaveHours}>{t('common.save')}</Button>
                <Button size="sm" variant="secondary" onClick={() => setEditingHours(false)}>{t('common.cancel')}</Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  if (!canUpdate) return;
                  setHoursInput(Math.round(overview.total_print_hours).toString());
                  setEditingHours(true);
                }}
                className={`group mt-0.5 flex items-center gap-2 text-2xl font-bold tabular-nums text-white ${canUpdate ? '' : 'cursor-not-allowed opacity-60'}`}
                title={!canUpdate ? t('maintenance.noPermissionEditHours') : t('maintenance.editPrintHours')}
              >
                <span>{Math.round(overview.total_print_hours).toLocaleString()} {t('common.hours')}</span>
                <Edit3 className={`h-3.5 w-3.5 text-bambu-gray-light ${canUpdate ? 'group-hover:text-bambu-green' : ''}`} />
              </button>
            )}
          </div>
        </div>
        <div className={tile}>
          <div>
            <div className="text-xs text-bambu-gray-light">{t('maintenance.printJobs')}</div>
            <div className="mt-0.5 text-2xl font-bold tabular-nums text-white">{overview.total_print_jobs ?? 0}</div>
          </div>
        </div>
        <div className={tile}>
          <div>
            <div className="text-xs text-bambu-gray-light">{t('maintenance.filamentChanges')}</div>
            <div className="mt-0.5 text-2xl font-bold tabular-nums text-white">{overview.total_filament_changes ?? 0}</div>
          </div>
        </div>
      </div>

      {sections.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Wrench className="mx-auto mb-3 h-12 w-12 text-bambu-gray/30" />
            <p className="font-medium text-white">{t('maintenance.noTasks')}</p>
            <p className="mt-1 text-sm text-bambu-gray-light">{t('maintenance.noTasksAssigned')}</p>
          </CardContent>
        </Card>
      ) : (
        sections.map((section) => (
          <section key={section.status} aria-label={statusLabel(section.status, t)} className="space-y-2.5">
            <h3 className={`flex items-center gap-2 text-sm font-semibold ${STATUS_STYLES[section.status].text}`}>
              {statusLabel(section.status, t)}
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLES[section.status].chip}`}>
                {counts[section.status]}
              </span>
            </h3>
            <div className={`overflow-hidden rounded-xl border bg-bambu-dark-secondary ${STATUS_STYLES[section.status].border}`}>
              {section.rows.map(({ item }) => (
                <TaskRow
                  key={item.id}
                  item={item}
                  dateFormat={dateFormat}
                  onPerform={onPerform}
                  onToggle={onToggle}
                  hasPermission={hasPermission}
                  t={t}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

function StatusTab({
  overview,
  dateFormat,
  onPerform,
  onToggle,
  onSetHours,
  onLogRepair,
  onToggleMaintenanceMode,
  maintenanceModePending,
  hasPermission,
  t,
}: {
  overview: PrinterMaintenanceOverview[] | undefined;
  dateFormat: DateFormat;
  onPerform: (id: number) => void;
  onToggle: (id: number, enabled: boolean) => void;
  onSetHours: (printerId: number, hours: number) => void;
  onLogRepair: (printerId: number) => void;
  onToggleMaintenanceMode: (printerId: number, enterMaintenance: boolean) => void;
  maintenanceModePending: boolean;
  hasPermission: (permission: Permission) => boolean;
  t: TFunction;
}) {
  const [selection, setSelection] = useState<number | 'all'>('all');

  if (!overview || overview.length === 0) {
    return (
      <Card>
        <CardContent className="py-16 text-center">
          <Wrench className="mx-auto mb-4 h-16 w-16 text-bambu-gray/30" />
          <p className="mb-2 text-lg font-medium text-white">{t('common.noPrinters')}</p>
          <p className="text-bambu-gray">{t('maintenance.configureSettings')}</p>
        </CardContent>
      </Card>
    );
  }

  // A printer that disappears (removed, or no longer in the overview) falls back to the fleet list.
  const selectedPrinter = selection === 'all' ? undefined : overview.find((printer) => printer.printer_id === selection);

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <MachineRail overview={overview} selected={selectedPrinter ? selection : 'all'} onSelect={setSelection} t={t} />
      {selectedPrinter ? (
        <PrinterView
          key={selectedPrinter.printer_id}
          overview={selectedPrinter}
          dateFormat={dateFormat}
          onPerform={onPerform}
          onToggle={onToggle}
          onSetHours={onSetHours}
          onLogRepair={onLogRepair}
          onToggleMaintenanceMode={onToggleMaintenanceMode}
          maintenanceModePending={maintenanceModePending}
          hasPermission={hasPermission}
          t={t}
        />
      ) : (
        <AllMachinesView overview={overview} dateFormat={dateFormat} onPerform={onPerform} hasPermission={hasPermission} t={t} />
      )}
    </div>
  );
}

// Settings section - maintenance types configuration
function SettingsSection({
  overview,
  types,
  onUpdateInterval,
  onAddType,
  onUpdateType,
  onDeleteType,
  onRestoreDefaults,
  isRestoringDefaults,
  onAssignType,
  onRemoveItem,
  hasPermission,
  t,
}: {
  overview: PrinterMaintenanceOverview[] | undefined;
  types: MaintenanceType[];
  onUpdateInterval: (id: number, data: { custom_interval_hours?: number | null; custom_interval_type?: MaintenanceIntervalType | null }) => void;
  onAddType: (data: { name: string; description?: string; default_interval_hours: number; interval_type: MaintenanceIntervalType; icon?: string; wiki_url?: string | null }, printerIds: number[]) => void;
  onUpdateType: (id: number, data: { name?: string; default_interval_hours?: number; interval_type?: MaintenanceIntervalType; icon?: string; wiki_url?: string | null }) => void;
  onDeleteType: (id: number) => void;
  onRestoreDefaults: () => void;
  isRestoringDefaults: boolean;
  onAssignType: (printerId: number, typeId: number) => void;
  onRemoveItem: (itemId: number) => void;
  hasPermission: (permission: Permission) => boolean;
  t: TFunction;
}) {
  const [editingInterval, setEditingInterval] = useState<number | null>(null);
  const [intervalInput, setIntervalInput] = useState('');
  const [intervalTypeInput, setIntervalTypeInput] = useState<MaintenanceIntervalType>('hours');
  const [showAddType, setShowAddType] = useState(false);
  const [newTypeName, setNewTypeName] = useState('');
  const [newTypeInterval, setNewTypeInterval] = useState('100');
  const [newTypeIntervalType, setNewTypeIntervalType] = useState<MaintenanceIntervalType>('hours');
  const [newTypeIcon, setNewTypeIcon] = useState('Wrench');
  const [newTypeWikiUrl, setNewTypeWikiUrl] = useState('');
  const [selectedPrinters, setSelectedPrinters] = useState<Set<number>>(new Set());
  const [expandedType, setExpandedType] = useState<number | null>(null);
  const [pendingSystemDelete, setPendingSystemDelete] = useState<MaintenanceType | null>(null);

  // Get unique printers from overview
  const printers = useMemo(() => {
    if (!overview) return [];
    return overview.map(o => ({ id: o.printer_id, name: o.printer_name }));
  }, [overview]);

  // Get which printers have a specific maintenance type assigned
  const getAssignedPrinters = (typeId: number) => {
    if (!overview) return [];
    return overview
      .filter(p => p.maintenance_items.some(item => item.maintenance_type_id === typeId))
      .map(p => ({
        printerId: p.printer_id,
        printerName: p.printer_name,
        itemId: p.maintenance_items.find(item => item.maintenance_type_id === typeId)?.id,
      }));
  };

  // Get printers that DON'T have a specific type assigned
  const getUnassignedPrinters = (typeId: number) => {
    if (!overview) return [];
    const assignedIds = new Set(getAssignedPrinters(typeId).map(p => p.printerId));
    return printers.filter(p => !assignedIds.has(p.id));
  };

  // Edit type state
  const [editingType, setEditingType] = useState<MaintenanceType | null>(null);
  const [editTypeName, setEditTypeName] = useState('');
  const [editTypeInterval, setEditTypeInterval] = useState('');
  const [editTypeIntervalType, setEditTypeIntervalType] = useState<MaintenanceIntervalType>('hours');
  const [editTypeIcon, setEditTypeIcon] = useState('Wrench');
  const [editTypeWikiUrl, setEditTypeWikiUrl] = useState('');

  const startEditType = (type: MaintenanceType) => {
    setEditingType(type);
    setEditTypeName(type.name);
    setEditTypeInterval(type.default_interval_hours.toString());
    setEditTypeIntervalType(type.interval_type || 'hours');
    setEditTypeIcon(type.icon || 'Wrench');
    setEditTypeWikiUrl(type.wiki_url || '');
  };

  const handleSaveEditType = () => {
    if (editingType && editTypeName.trim() && parseFloat(editTypeInterval) > 0) {
      onUpdateType(editingType.id, {
        name: editTypeName.trim(),
        default_interval_hours: parseFloat(editTypeInterval),
        interval_type: editTypeIntervalType,
        icon: editTypeIcon,
        wiki_url: editTypeWikiUrl.trim() || null,
      });
      setEditingType(null);
    }
  };

  const handleSaveInterval = (itemId: number, defaultInterval: number, defaultIntervalType: MaintenanceIntervalType) => {
    const newInterval = parseFloat(intervalInput);
    if (!isNaN(newInterval) && newInterval > 0) {
      const customInterval = Math.abs(newInterval - defaultInterval) < 0.01 ? null : newInterval;
      const customIntervalType = intervalTypeInput !== defaultIntervalType ? intervalTypeInput : null;
      onUpdateInterval(itemId, {
        custom_interval_hours: customInterval,
        custom_interval_type: customIntervalType
      });
    }
    setEditingInterval(null);
  };

  const handleAddType = (e: React.FormEvent) => {
    e.preventDefault();
    if (newTypeName.trim() && parseFloat(newTypeInterval) > 0 && selectedPrinters.size > 0) {
      onAddType({
        name: newTypeName.trim(),
        default_interval_hours: parseFloat(newTypeInterval),
        interval_type: newTypeIntervalType,
        icon: newTypeIcon,
        wiki_url: newTypeWikiUrl.trim() || null,
      }, Array.from(selectedPrinters));
      setNewTypeName('');
      setNewTypeInterval('100');
      setNewTypeIntervalType('hours');
      setNewTypeWikiUrl('');
      setSelectedPrinters(new Set());
      setShowAddType(false);
    }
  };

  const togglePrinterSelection = (printerId: number) => {
    setSelectedPrinters(prev => {
      const next = new Set(prev);
      if (next.has(printerId)) {
        next.delete(printerId);
      } else {
        next.add(printerId);
      }
      return next;
    });
  };

  const printerItems = overview?.map(p => ({
    printerId: p.printer_id,
    printerName: p.printer_name,
    items: p.maintenance_items.sort((a, b) => a.maintenance_type_id - b.maintenance_type_id),
  })).sort((a, b) => a.printerName.localeCompare(b.printerName)) || [];

  const systemTypes = types.filter(t => t.is_system);
  const customTypes = types.filter(t => !t.is_system);

  return (
    <div className="space-y-8">
      {/* Maintenance Types */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-white">{t('maintenance.maintenanceTypes')}</h2>
            <p className="text-sm text-bambu-gray mt-1">{t('maintenance.maintenanceTypesDescription')}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={onRestoreDefaults}
              disabled={!hasPermission('maintenance:delete') || isRestoringDefaults}
              title={!hasPermission('maintenance:delete') ? t('maintenance.noPermissionDeleteTypes') : undefined}
            >
              {t('maintenance.restoreDefaults')}
            </Button>
            <Button
              onClick={() => setShowAddType(!showAddType)}
              disabled={!hasPermission('maintenance:create')}
              title={!hasPermission('maintenance:create') ? t('maintenance.noPermissionEditTypes') : undefined}
            >
              <Plus className="w-4 h-4" />
              {t('maintenance.addCustomType')}
            </Button>
          </div>
        </div>

        {/* Add custom type form */}
        {showAddType && (
          <Card className="mb-6">
            <CardContent className="py-4">
              <form onSubmit={handleAddType}>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="lg:col-span-2">
                    <label className="block text-xs text-bambu-gray mb-1.5">{t('common.name')}</label>
                    <input
                      type="text"
                      value={newTypeName}
                      onChange={(e) => setNewTypeName(e.target.value)}
                      className={maintenanceFieldClass}
                      placeholder={t('maintenance.exampleName')}
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-bambu-gray mb-1.5">{t('maintenance.intervalType')}</label>
                    <ReactSelect
                      value={newTypeIntervalType}
                      onChange={(e) => {
                        setNewTypeIntervalType(e.target.value as MaintenanceIntervalType);
                        // Set sensible default based on type
                        if (e.target.value === 'days') {
                          setNewTypeInterval('30');
                        } else if (e.target.value === 'jobs') {
                          setNewTypeInterval('50');
                        } else if (e.target.value === 'changes') {
                          setNewTypeInterval('20');
                        } else {
                          setNewTypeInterval('100');
                        }
                      }}
                      className={maintenanceFieldClass}
                    >
                      <option value="hours">{t('maintenance.printHours')}</option>
                      <option value="days">{t('maintenance.calendarDays')}</option>
                      <option value="jobs">{t('maintenance.printJobs')}</option>
                      <option value="changes">{t('maintenance.filamentChanges')}</option>
                    </ReactSelect>
                  </div>
                  <div>
                    <label className="block text-xs text-bambu-gray mb-1.5">
                      {t('maintenance.intervalValue', { type: newTypeIntervalType === 'days' ? t('maintenance.calendarDays').toLowerCase() : newTypeIntervalType === 'jobs' ? t('maintenance.printJobs').toLowerCase() : newTypeIntervalType === 'changes' ? t('maintenance.filamentChanges').toLowerCase() : t('common.hours') })}
                    </label>
                    <input
                      type="number"
                      value={newTypeInterval}
                      onChange={(e) => setNewTypeInterval(e.target.value)}
                      className={maintenanceFieldClass}
                      min="1"
                    />
                  </div>
                </div>
                <div className="mt-4 flex items-end justify-between">
                  <div>
                    <label className="block text-xs text-bambu-gray mb-1.5">{t('maintenance.icon')}</label>
                    <div className="flex gap-1">
                      {Object.keys(iconMap).map((iconName) => {
                        const IconComp = iconMap[iconName];
                        return (
                          <button
                            key={iconName}
                            type="button"
                            onClick={() => setNewTypeIcon(iconName)}
                            className={`p-2 rounded-lg transition-colors ${
                              newTypeIcon === iconName
                                ? 'bg-bambu-green text-white'
                                : 'bg-bambu-dark text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary'
                            }`}
                          >
                            <IconComp className="w-4 h-4" />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
                {/* Wiki URL */}
                <div className="mt-4">
                  <label className="block text-xs text-bambu-gray mb-1.5">{t('maintenance.documentationLink')}</label>
                  <input
                    type="url"
                    value={newTypeWikiUrl}
                    onChange={(e) => setNewTypeWikiUrl(e.target.value)}
                    className={maintenanceFieldClass}
                    placeholder="https://wiki.bambulab.com/..."
                  />
                </div>
                {/* Printer selection */}
                <div className="mt-4">
                  <label className="block text-xs text-bambu-gray mb-1.5">{t('maintenance.assignToPrinters')}</label>
                  <div className="flex flex-wrap gap-2">
                    {printers.map(p => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => togglePrinterSelection(p.id)}
                        className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                          selectedPrinters.has(p.id)
                            ? 'bg-bambu-green text-white'
                            : 'bg-bambu-dark text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary'
                        }`}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                  {selectedPrinters.size === 0 && (
                    <p className="text-xs text-orange-400 mt-1">{t('maintenance.selectAtLeastOnePrinter')}</p>
                  )}
                </div>
                <div className="mt-4 flex justify-end gap-2">
                  <Button type="button" variant="secondary" onClick={() => { setShowAddType(false); setSelectedPrinters(new Set()); }}>
                    {t('common.cancel')}
                  </Button>
                  <Button type="submit" disabled={!newTypeName.trim() || selectedPrinters.size === 0}>
                    {t('maintenance.addType')}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {/* Types grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {/* System types */}
          {systemTypes.map((type) => {
            const Icon = getIcon(type.icon);
            const intervalType = type.interval_type || 'hours';
            return (
              <div key={type.id} className="bg-bambu-dark-secondary rounded-xl p-4 border border-bambu-dark-tertiary">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 bg-bambu-dark rounded-lg">
                    <Icon className="w-5 h-5 text-bambu-gray" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-white truncate">{type.name}</div>
                    <div className="text-xs text-bambu-gray mt-0.5 flex items-center gap-1">
                      <IntervalTypeIcon type={intervalType} className="w-3 h-3" />
                      {formatIntervalLabel(type.default_interval_hours, intervalType, t)}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      if (!hasPermission('maintenance:delete')) return;
                      setPendingSystemDelete(type);
                    }}
                    disabled={!hasPermission('maintenance:delete')}
                    title={!hasPermission('maintenance:delete') ? t('maintenance.noPermissionDeleteTypes') : undefined}
                    className={`p-2 rounded-lg hover:bg-bambu-dark text-bambu-gray hover:text-red-400 transition-colors ${!hasPermission('maintenance:delete') ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
          {/* Custom types */}
          {customTypes.map((type) => {
            const Icon = getIcon(type.icon);
            const intervalType = type.interval_type || 'hours';
            const isEditing = editingType?.id === type.id;

            if (isEditing) {
              return (
                <div key={type.id} className="bg-bambu-dark-secondary rounded-xl p-4 border border-bambu-green">
                  <div className="space-y-3">
                    <input
                      type="text"
                      value={editTypeName}
                      onChange={(e) => setEditTypeName(e.target.value)}
                      className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none"
                      placeholder={t('common.name')}
                      autoFocus
                    />
                    <div className="flex gap-2">
                      <ReactSelect
                        value={editTypeIntervalType}
                        onChange={(e) => setEditTypeIntervalType(e.target.value as MaintenanceIntervalType)}
                        className={`flex-1 ${maintenanceFieldClass}`}
                      >
                        <option value="hours">{t('maintenance.printHours')}</option>
                        <option value="days">{t('maintenance.calendarDays')}</option>
                      <option value="jobs">{t('maintenance.printJobs')}</option>
                      <option value="changes">{t('maintenance.filamentChanges')}</option>
                      </ReactSelect>
                      <input
                        type="number"
                        value={editTypeInterval}
                        onChange={(e) => setEditTypeInterval(e.target.value)}
                        className="w-24 px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none"
                        min="1"
                      />
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {Object.keys(iconMap).map((iconName) => {
                        const IconComp = iconMap[iconName];
                        return (
                          <button
                            key={iconName}
                            type="button"
                            onClick={() => setEditTypeIcon(iconName)}
                            className={`p-1.5 rounded transition-colors ${
                              editTypeIcon === iconName
                                ? 'bg-bambu-green text-white'
                                : 'bg-bambu-dark text-bambu-gray hover:text-white'
                            }`}
                          >
                            <IconComp className="w-3.5 h-3.5" />
                          </button>
                        );
                      })}
                    </div>
                    <input
                      type="url"
                      value={editTypeWikiUrl}
                      onChange={(e) => setEditTypeWikiUrl(e.target.value)}
                      className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none"
                      placeholder={t('maintenance.documentationLink')}
                    />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={handleSaveEditType} disabled={!editTypeName.trim()}>
                        {t('common.save')}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setEditingType(null)}>
                        {t('common.cancel')}
                      </Button>
                    </div>
                  </div>
                </div>
              );
            }

            const assignedPrinters = getAssignedPrinters(type.id);
            const unassignedPrinters = getUnassignedPrinters(type.id);
            const isExpanded = expandedType === type.id;

            return (
              <div key={type.id} className="bg-bambu-dark-secondary rounded-xl p-4 border border-bambu-green/30">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 bg-bambu-green/20 rounded-lg">
                    <Icon className="w-5 h-5 text-bambu-green" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-white truncate">{type.name}</span>
                      <span className="px-1.5 py-0.5 bg-bambu-green/20 text-bambu-green text-[10px] font-medium rounded">
                        {t('maintenance.custom')}
                      </span>
                    </div>
                    <div className="text-xs text-bambu-gray mt-0.5 flex items-center gap-1">
                      <IntervalTypeIcon type={intervalType} className="w-3 h-3" />
                      {formatIntervalLabel(type.default_interval_hours, intervalType, t)}
                    </div>
                  </div>
                  <button
                    onClick={() => setExpandedType(isExpanded ? null : type.id)}
                    className={`px-2 py-1 rounded-lg border transition-colors flex items-center gap-1 ${
                      assignedPrinters.length > 0
                        ? 'border-bambu-green/50 bg-bambu-green/10 text-bambu-green hover:bg-bambu-green/20'
                        : 'border-orange-400/50 bg-orange-400/10 text-orange-400 hover:bg-orange-400/20'
                    }`}
                    title={t('maintenance.printersAssignedClick', { count: assignedPrinters.length })}
                  >
                    <Printer className="w-3 h-3" />
                    <span className="text-xs font-medium">{assignedPrinters.length}</span>
                    <ChevronDown className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                  </button>
                  <button
                    onClick={() => startEditType(type)}
                    disabled={!hasPermission('maintenance:update')}
                    title={!hasPermission('maintenance:update') ? t('maintenance.noPermissionEditTypes') : undefined}
                    className={`p-2 rounded-lg hover:bg-bambu-dark text-bambu-gray hover:text-white transition-colors ${!hasPermission('maintenance:update') ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    <Edit3 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(t('maintenance.deleteTypeConfirm', { name: type.name }))) {
                        onDeleteType(type.id);
                      }
                    }}
                    disabled={!hasPermission('maintenance:delete')}
                    title={!hasPermission('maintenance:delete') ? t('maintenance.noPermissionDeleteTypes') : undefined}
                    className={`p-2 rounded-lg hover:bg-bambu-dark text-bambu-gray hover:text-red-400 transition-colors ${!hasPermission('maintenance:delete') ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                {/* Printer assignment management */}
                {isExpanded && (
                  <div className="mt-3 pt-3 border-t border-bambu-dark-tertiary">
                    <p className="text-xs text-bambu-gray mb-2">{t('maintenance.assignedToPrinters')}</p>
                    {assignedPrinters.length === 0 ? (
                      <p className="text-xs text-orange-400">{t('maintenance.noPrintersAssigned')}</p>
                    ) : (
                      <div className="flex flex-wrap gap-1 mb-2">
                        {assignedPrinters.map(p => (
                          <span
                            key={p.printerId}
                            className="inline-flex items-center gap-1 px-2 py-1 bg-bambu-dark rounded text-xs text-white"
                          >
                            {p.printerName}
                            <button
                              onClick={() => p.itemId && onRemoveItem(p.itemId)}
                              disabled={!hasPermission('maintenance:delete')}
                              title={!hasPermission('maintenance:delete') ? t('maintenance.noPermissionRemovePrinter') : t('maintenance.removeFromPrinter')}
                              className={`ml-1 ${hasPermission('maintenance:delete') ? 'hover:text-red-400' : 'opacity-50 cursor-not-allowed'}`}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    {unassignedPrinters.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        <span className="text-xs text-bambu-gray mr-1">{t('maintenance.addPrinterShort')}</span>
                        {unassignedPrinters.map(p => (
                          <button
                            key={p.id}
                            onClick={() => onAssignType(p.id, type.id)}
                            disabled={!hasPermission('maintenance:create')}
                            title={!hasPermission('maintenance:create') ? t('maintenance.noPermissionAssignPrinter') : undefined}
                            className={`px-2 py-1 bg-bambu-dark rounded text-xs transition-colors ${hasPermission('maintenance:create') ? 'hover:bg-bambu-green/20 text-bambu-gray hover:text-bambu-green' : 'opacity-50 cursor-not-allowed text-bambu-gray'}`}
                          >
                            + {p.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Per-printer interval overrides */}
      {printerItems.length > 0 && (
        <div>
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-white">{t('maintenance.intervalOverrides')}</h2>
            <p className="text-sm text-bambu-gray mt-1">{t('maintenance.intervalOverridesDescription')}</p>
          </div>
          <div className="space-y-4">
            {printerItems.map((printer) => (
              <Card key={printer.printerId}>
                <CardContent className="py-4">
                  <h3 className="text-sm font-medium text-white mb-3">{printer.printerName}</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                    {printer.items.map((item) => {
                      const Icon = getIcon(item.maintenance_type_icon);
                      const typeInfo = types.find(t => t.id === item.maintenance_type_id);
                      const defaultInterval = typeInfo?.default_interval_hours || item.interval_hours;
                      const defaultIntervalType = typeInfo?.interval_type || 'hours';
                      const intervalType = item.interval_type || 'hours';
                      const isEditing = editingInterval === item.id;

                      return (
                        <div key={item.id} className="flex items-center gap-2 p-2.5 bg-bambu-dark rounded-lg">
                          <Icon className="w-4 h-4 text-bambu-gray shrink-0" />
                          <span className="text-xs text-bambu-gray flex-1 truncate">{item.maintenance_type_name}</span>

                          {isEditing ? (
                            <div className="flex items-center gap-1">
                              <IntervalTypeIcon type={intervalTypeInput} className="w-3.5 h-3.5 text-bambu-gray shrink-0" />
                              <ReactSelect
                                value={intervalTypeInput}
                                onChange={(e) => setIntervalTypeInput(e.target.value as MaintenanceIntervalType)}
                                className="px-1.5 py-1 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded text-white text-xs"
                              >
                                <option value="hours">{t('maintenance.printHours')}</option>
                                <option value="days">{t('maintenance.calendarDays')}</option>
                      <option value="jobs">{t('maintenance.printJobs')}</option>
                      <option value="changes">{t('maintenance.filamentChanges')}</option>
                              </ReactSelect>
                              <input
                                type="number"
                                value={intervalInput}
                                onChange={(e) => setIntervalInput(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleSaveInterval(item.id, defaultInterval, defaultIntervalType);
                                  if (e.key === 'Escape') setEditingInterval(null);
                                }}
                                className="w-16 px-2 py-1 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded text-white text-xs"
                                min="1"
                              />
                              <Button size="sm" onClick={() => handleSaveInterval(item.id, defaultInterval, defaultIntervalType)}>OK</Button>
                            </div>
                          ) : (
                            <button
                              onClick={() => {
                                if (!hasPermission('maintenance:update')) return;
                                setEditingInterval(item.id);
                                setIntervalInput(item.interval_hours.toString());
                                setIntervalTypeInput(intervalType);
                              }}
                              disabled={!hasPermission('maintenance:update')}
                              title={!hasPermission('maintenance:update') ? t('maintenance.noPermissionEditIntervals') : undefined}
                              className={`px-2 py-1 bg-bambu-dark-tertiary border border-bambu-dark-tertiary rounded text-xs font-medium text-white transition-colors flex items-center gap-1 ${hasPermission('maintenance:update') ? 'hover:bg-bambu-dark-secondary hover:border-bambu-green' : 'opacity-50 cursor-not-allowed'}`}
                            >
                              <IntervalTypeIcon type={intervalType} className="w-3 h-3" />
                              {formatIntervalLabel(item.interval_hours, intervalType, t)}
                              <Edit3 className="w-3 h-3 text-bambu-gray" />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {printerItems.length === 0 && (
        <Card>
          <CardContent className="text-center py-12">
            <Clock className="w-12 h-12 mx-auto mb-4 text-bambu-gray/30" />
            <p className="text-bambu-gray">{t('common.noPrinters')}</p>
            <p className="text-sm text-bambu-gray/70 mt-1">
              {t('maintenance.intervalOverridesDescription')}
            </p>
          </CardContent>
        </Card>
      )}

      {pendingSystemDelete && (
        <ConfirmModal
          title={t('maintenance.deleteSystemTypeTitle')}
          message={t('maintenance.deleteSystemTypeMessage', { name: pendingSystemDelete.name })}
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          variant="danger"
          cancelVariant="primary"
          cardClassName="bg-red-950/70 border border-red-800/70"
          onConfirm={() => {
            onDeleteType(pendingSystemDelete.id);
            setPendingSystemDelete(null);
          }}
          onCancel={() => setPendingSystemDelete(null)}
        />
      )}
    </div>
  );
}

type MaintenanceLogForm = {
  printerId: string;
  title: string;
  notes: string;
  occurredAt: string;
  hours: string;
};

type MaintenanceLogFilter = MaintenanceLogEntryType | null;

function MaintenanceLogSection({
  overview,
  entries,
  isLoading,
  isFetchingMore,
  hasMore,
  selectedPrinterId,
  selectedEntryType,
  onSelectPrinter,
  onSelectEntryType,
  composePrinterId,
  onComposeHandled,
  onLoadMore,
  onCreate,
  onUpdate,
  onDelete,
  isSaving,
  hasPermission,
  dateFormat,
  t,
}: {
  overview: PrinterMaintenanceOverview[] | undefined;
  entries: MaintenanceLogEntry[];
  isLoading: boolean;
  isFetchingMore: boolean;
  hasMore: boolean;
  selectedPrinterId: number | null;
  selectedEntryType: MaintenanceLogFilter;
  onSelectPrinter: (printerId: number | null) => void;
  onSelectEntryType: (entryType: MaintenanceLogFilter) => void;
  /** A printer whose "Log a repair" button was used; opens the form for it once. */
  composePrinterId: number | null;
  onComposeHandled: () => void;
  onLoadMore: () => void;
  onCreate: (data: MaintenanceLogEntryInput) => Promise<MaintenanceLogEntry>;
  onUpdate: (id: number, data: MaintenanceLogEntryInput) => Promise<MaintenanceLogEntry>;
  onDelete: (id: number) => Promise<unknown>;
  isSaving: boolean;
  hasPermission: (permission: Permission) => boolean;
  dateFormat: DateFormat;
  t: TFunction;
}) {
  const printers = useMemo(
    () => [...(overview || [])].sort((a, b) => a.printer_name.localeCompare(b.printer_name)),
    [overview],
  );
  const [editingEntry, setEditingEntry] = useState<MaintenanceLogEntry | null | undefined>(undefined);
  const [form, setForm] = useState<MaintenanceLogForm>({
    printerId: '',
    title: '',
    notes: '',
    occurredAt: toDateTimeLocal(),
    hours: '',
  });
  const [pendingDelete, setPendingDelete] = useState<MaintenanceLogEntry | null>(null);

  const openCreate = (printerId?: number) => {
    setEditingEntry(null);
    setForm({
      printerId: printerId?.toString() || selectedPrinterId?.toString() || printers[0]?.printer_id.toString() || '',
      title: '',
      notes: '',
      occurredAt: toDateTimeLocal(),
      hours: '',
    });
  };

  useEffect(() => {
    if (composePrinterId === null) return;
    openCreate(composePrinterId);
    onComposeHandled();
    // openCreate only reads state that is current on the render this effect runs in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composePrinterId]);

  const openEdit = (entry: MaintenanceLogEntry) => {
    setEditingEntry(entry);
    setForm({
      printerId: entry.printer_id.toString(),
      title: entry.title,
      notes: entry.notes || '',
      occurredAt: toDateTimeLocal(entry.occurred_at),
      hours: entry.hours_at_maintenance?.toString() || '',
    });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const printerId = Number(form.printerId);
    const hours = form.hours === '' ? null : Number(form.hours);
    if (!printerId || !form.title.trim() || Number.isNaN(hours) || (hours !== null && hours < 0)) return;

    const occurredAt = new Date(form.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) return;

    const data: MaintenanceLogEntryInput = {
      printer_id: printerId,
      title: form.title.trim(),
      notes: form.notes.trim() || null,
      occurred_at: occurredAt.toISOString(),
      hours_at_maintenance: hours,
    };
    if (editingEntry) {
      await onUpdate(editingEntry.id, data);
    } else {
      await onCreate(data);
    }
    setEditingEntry(undefined);
  };

  // Entries arrive newest first, so each month's group is contiguous.
  const groupedEntries = useMemo(() => {
    const groups: { key: string; label: string; entries: MaintenanceLogEntry[] }[] = [];
    for (const entry of entries) {
      const date = parseUTCDate(entry.occurred_at);
      const valid = date && !Number.isNaN(date.getTime()) ? date : null;
      const key = valid ? `${valid.getFullYear()}-${valid.getMonth()}` : 'unknown';
      const label = valid ? valid.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : entry.occurred_at;
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.entries.push(entry);
      else groups.push({ key, label, entries: [entry] });
    }
    return groups;
  }, [entries]);

  const authorLine = (entry: MaintenanceLogEntry) => {
    const created = entry.created_by_username
      ? `${t('maintenance.recordedBy')} ${entry.created_by_username}`
      : null;
    const updated = entry.updated_by_username && entry.updated_at !== entry.created_at
      ? `${t('maintenance.updatedBy')} ${entry.updated_by_username}`
      : null;
    return [created, updated].filter(Boolean).join(' · ');
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <ReactSelect
            aria-label={t('maintenance.filterByPrinter')}
            value={selectedPrinterId?.toString() || ''}
            onChange={(event) => onSelectPrinter(event.target.value ? Number(event.target.value) : null)}
            className="min-w-48"
          >
            <option value="">{t('maintenance.allPrinters')}</option>
            {printers.map((printer) => (
              <option key={printer.printer_id} value={printer.printer_id}>{printer.printer_name}</option>
            ))}
          </ReactSelect>
          <div role="group" aria-label={t('maintenance.filterByType')} className="flex rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary p-0.5">
            {([
              [null, t('maintenance.allLogEntries')],
              ['scheduled', t('maintenance.scheduledLogs')],
              ['manual', t('maintenance.unscheduledLogs')],
            ] as [MaintenanceLogFilter, string][]).map(([value, label]) => (
              <button
                key={value ?? 'all'}
                type="button"
                aria-pressed={selectedEntryType === value}
                onClick={() => onSelectEntryType(value)}
                className={`min-h-[36px] rounded-md px-3.5 text-sm font-medium transition-colors ${
                  selectedEntryType === value ? 'bg-bambu-dark-tertiary text-white' : 'text-bambu-gray-light hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {hasPermission('maintenance:create') && (
          <Button onClick={() => openCreate()} disabled={printers.length === 0}>
            <Plus className="w-4 h-4 mr-2" />
            {t('maintenance.addLogEntry')}
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-7 h-7 animate-spin text-bambu-green" /></div>
      ) : entries.length === 0 ? (
        <Card>
          <CardContent className="py-14 text-center">
            <Clock className="mx-auto mb-4 h-12 w-12 text-bambu-gray/30" />
            <p className="text-lg font-medium text-white">{t('maintenance.noLogEntries')}</p>
            <p className="mt-1 text-bambu-gray">{t('maintenance.logDescription')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary/60">
          <div className="min-w-[960px]">
            <div className={`${logGridClass} h-11 border-b border-bambu-dark-tertiary bg-bambu-dark-secondary text-xs font-semibold uppercase tracking-wide text-bambu-gray-light`}>
              <div>{t('maintenance.logDate')}</div>
              <div>{t('maintenance.logEntry')}</div>
              <div>{t('maintenance.printer')}</div>
              <div>{t('maintenance.logType')}</div>
              <div>{t('maintenance.logRecordedAt')}</div>
              <div>{t('maintenance.logBy')}</div>
              <div />
            </div>
            {groupedEntries.map((group) => (
              <section key={group.key} aria-label={group.label}>
                <h3 className="flex h-9 items-center justify-between border-b border-bambu-dark-tertiary/60 bg-bambu-dark/40 px-5 text-xs font-semibold uppercase tracking-wide text-bambu-gray-light">
                  {group.label}
                  <span className="font-medium normal-case tracking-normal">{t('maintenance.logEntryCount', { count: group.entries.length })}</span>
                </h3>
                {group.entries.map((entry) => {
                  const isManual = entry.entry_type === 'manual';
                  const author = authorLine(entry);
                  const occurredAt = parseUTCDate(entry.occurred_at);
                  const validDate = occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt : null;
                  const recordedAt = [
                    entry.hours_at_maintenance !== null ? `${entry.hours_at_maintenance.toFixed(1)}h` : null,
                    entry.jobs_at_maintenance != null ? formatJobs(entry.jobs_at_maintenance, t) : null,
                    entry.changes_at_maintenance != null ? formatChanges(entry.changes_at_maintenance, t) : null,
                  ].filter(Boolean).join(' · ');
                  return (
                    <div key={entry.id} className={`${logGridClass} min-h-[60px] border-b border-bambu-dark-tertiary/60 py-2 last:border-b-0`}>
                      <div>
                        <div className="text-sm font-semibold text-white">
                          {validDate ? validDate.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }) : entry.occurred_at}
                        </div>
                        {validDate && (
                          <div className="text-xs text-bambu-gray-light">
                            {validDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                          </div>
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-white" title={entry.title}>{entry.title}</div>
                        {entry.notes && (
                          <div className="truncate text-sm text-bambu-gray-light" title={entry.notes}>{entry.notes}</div>
                        )}
                      </div>
                      <div className="truncate text-sm text-bambu-gray-light">{entry.printer_name}</div>
                      <div>
                        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${isManual ? 'bg-blue-500/15 text-blue-300' : 'bg-bambu-green/15 text-bambu-green'}`}>
                          {isManual ? <Wrench className="h-3.5 w-3.5" /> : <CalendarCheck className="h-3.5 w-3.5" />}
                          {isManual ? t('maintenance.unscheduledLogs') : t('maintenance.scheduledLogs')}
                        </span>
                      </div>
                      <div className="text-sm tabular-nums text-bambu-gray-light">{recordedAt}</div>
                      <div className="truncate text-sm text-bambu-gray-light" title={author || undefined}>
                        {entry.created_by_username ?? ''}
                      </div>
                      <div className="flex justify-end">
                        {isManual && hasPermission('maintenance:update') && (
                          <Button variant="ghost" size="sm" onClick={() => openEdit(entry)} aria-label={t('common.edit')}>
                            <Edit3 className="h-4 w-4" />
                          </Button>
                        )}
                        {isManual && hasPermission('maintenance:delete') && (
                          <Button variant="ghost" size="sm" onClick={() => setPendingDelete(entry)} aria-label={t('common.delete')}>
                            <Trash2 className="h-4 w-4 text-red-400" />
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </section>
            ))}
          </div>
        </div>
      )}

      {hasMore && (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={onLoadMore} disabled={isFetchingMore}>
            {isFetchingMore && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('maintenance.loadMore')}
          </Button>
        </div>
      )}

      {editingEntry !== undefined && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <Card className="w-full max-w-lg">
            <CardContent className="p-6">
              <h2 className="text-lg font-semibold text-white">
                {editingEntry ? t('maintenance.editLogEntry') : t('maintenance.addLogEntry')}
              </h2>
              <form className="mt-5 space-y-4" onSubmit={submit}>
                <label className="block text-sm text-bambu-gray">
                  {t('maintenance.printer')}
                  <ReactSelect
                    required
                    value={form.printerId}
                    aria-label={t('maintenance.printer')}
                    onChange={(event) => setForm({ ...form, printerId: event.target.value })}
                    className={`mt-1 ${maintenanceFieldClass}`}
                  >
                    <option value="" disabled>{t('maintenance.selectPrinter')}</option>
                    {printers.map((printer) => (
                      <option key={printer.printer_id} value={printer.printer_id}>{printer.printer_name}</option>
                    ))}
                  </ReactSelect>
                </label>
                <label className="block text-sm text-bambu-gray">
                  {t('maintenance.entryTitle')}
                  <input
                    required
                    maxLength={200}
                    value={form.title}
                    onChange={(event) => setForm({ ...form, title: event.target.value })}
                    placeholder={t('maintenance.entryTitlePlaceholder')}
                    className="mt-1 w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary px-3 py-2 text-white"
                  />
                </label>
                <div className="block text-sm text-bambu-gray">
                  <label htmlFor="maintenance-occurred-at">{t('maintenance.occurredAt')}</label>
                  <DateTimePicker
                    required
                    value={form.occurredAt}
                    onChange={(occurredAt) => setForm({ ...form, occurredAt })}
                    dateInputId="maintenance-occurred-at"
                    dateFormat={dateFormat}
                    className="mt-1"
                  />
                </div>
                <label className="block text-sm text-bambu-gray">
                  {t('maintenance.recordPrintHours')}
                  <input
                    min="0"
                    step="0.1"
                    type="number"
                    value={form.hours}
                    onChange={(event) => setForm({ ...form, hours: event.target.value })}
                    className="mt-1 w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary px-3 py-2 text-white"
                  />
                </label>
                <label className="block text-sm text-bambu-gray">
                  {t('maintenance.notes')}
                  <textarea
                    maxLength={10000}
                    rows={4}
                    value={form.notes}
                    onChange={(event) => setForm({ ...form, notes: event.target.value })}
                    className="mt-1 w-full resize-y rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary px-3 py-2 text-white"
                  />
                </label>
                <div className="flex justify-end gap-3 pt-2">
                  <Button type="button" variant="secondary" onClick={() => setEditingEntry(undefined)}>
                    {t('common.cancel')}
                  </Button>
                  <Button type="submit" disabled={isSaving}>
                    {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t('maintenance.saveLogEntry')}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      )}

      {pendingDelete && (
        <ConfirmModal
          title={t('maintenance.deleteLogEntryTitle')}
          message={t('maintenance.deleteLogEntryMessage', { title: pendingDelete.title })}
          confirmText={t('common.delete')}
          variant="danger"
          onConfirm={async () => {
            await onDelete(pendingDelete.id);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

type TabType = 'status' | 'log' | 'settings';

export function MaintenancePage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const [activeTab, setActiveTab] = useState<TabType>('status');
  const [logPrinterId, setLogPrinterId] = useState<number | null>(null);
  const [logEntryType, setLogEntryType] = useState<MaintenanceLogFilter>(null);
  // Set by "Log a repair" on a printer's Status view; the Log tab opens its form for that printer.
  const [logComposePrinterId, setLogComposePrinterId] = useState<number | null>(null);

  const { data: overview, isLoading } = useQuery({
    queryKey: ['maintenanceOverview'],
    queryFn: api.getMaintenanceOverview,
  });

  const { data: types } = useQuery({
    queryKey: ['maintenanceTypes'],
    queryFn: api.getMaintenanceTypes,
  });

  const { data: uiPreferences } = useQuery({
    queryKey: ['ui-preferences'],
    queryFn: api.getUiPreferences,
  });

  const dateFormat: DateFormat = uiPreferences?.date_format === 'us' ||
    uiPreferences?.date_format === 'eu' ||
    uiPreferences?.date_format === 'iso'
    ? uiPreferences.date_format
    : 'system';

  const {
    data: logPages,
    isLoading: isLogsLoading,
    isFetchingNextPage: isFetchingMoreLogs,
    hasNextPage: hasMoreLogs,
    fetchNextPage: fetchMoreLogs,
  } = useInfiniteQuery({
    queryKey: ['maintenanceLogs', logPrinterId, logEntryType],
    queryFn: ({ pageParam }) => api.getMaintenanceLogs({
      printerId: logPrinterId,
      entryType: logEntryType,
      cursor: pageParam,
      limit: 50,
    }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
    enabled: activeTab === 'log',
  });

  const logEntries = logPages?.pages.flatMap((page) => page.items) || [];

  const performMutation = useMutation({
    mutationFn: ({ id, notes }: { id: number; notes?: string }) =>
      api.performMaintenance(id, notes),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['maintenanceOverview'] });
      queryClient.invalidateQueries({ queryKey: ['maintenanceSummary'] });
      queryClient.invalidateQueries({ queryKey: ['maintenanceLogs'] });
      showToast(t('maintenance.maintenanceComplete'));
    },
    onError: (error: Error) => {
      showToast(error.message, 'error');
    },
  });

  // Maintenance Mode wraps the printer's `is_active` flag, as on the Printers page.
  const [confirmEnterMaintenance, setConfirmEnterMaintenance] = useState<{ id: number; name: string } | null>(null);
  const maintenanceModeMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: number; name: string; isActive: boolean }) =>
      api.updatePrinter(id, { is_active: isActive }),
    onSuccess: (_data, { id, name, isActive }) => {
      queryClient.invalidateQueries({ queryKey: ['maintenanceOverview'] });
      queryClient.invalidateQueries({ queryKey: ['maintenanceSummary'] });
      queryClient.invalidateQueries({ queryKey: ['printers'] });
      queryClient.invalidateQueries({ queryKey: ['printerStatus', id] });
      showToast(
        isActive
          ? t('printers.maintenance.toastExited', { name })
          : t('printers.maintenance.toastEntered', { name }),
      );
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const handleToggleMaintenanceMode = async (printerId: number, enterMaintenance: boolean) => {
    const name = overview?.find((printer) => printer.printer_id === printerId)?.printer_name ?? '';
    if (!enterMaintenance) {
      maintenanceModeMutation.mutate({ id: printerId, name, isActive: true });
      return;
    }
    // Entering mode disconnects MQTT, so confirm first when a job is in flight.
    let printing = false;
    try {
      const status = await queryClient.fetchQuery({
        queryKey: ['printerStatus', printerId],
        queryFn: () => api.getPrinterStatus(printerId),
        staleTime: 0,
      });
      printing = status?.state === 'RUNNING' || status?.state === 'PAUSE';
    } catch {
      printing = false;
    }
    if (printing) {
      setConfirmEnterMaintenance({ id: printerId, name });
    } else {
      maintenanceModeMutation.mutate({ id: printerId, name, isActive: false });
    }
  };

  const createLogMutation = useMutation({
    mutationFn: api.createMaintenanceLog,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['maintenanceLogs'] });
      showToast(t('maintenance.logEntryCreated'));
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const updateLogMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: MaintenanceLogEntryInput }) => api.updateMaintenanceLog(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['maintenanceLogs'] });
      showToast(t('maintenance.logEntryUpdated'));
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const deleteLogMutation = useMutation({
    mutationFn: api.deleteMaintenanceLog,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['maintenanceLogs'] });
      showToast(t('maintenance.logEntryDeleted'));
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: { custom_interval_hours?: number | null; custom_interval_type?: MaintenanceIntervalType | null; enabled?: boolean } }) =>
      api.updateMaintenanceItem(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['maintenanceOverview'] });
    },
    onError: (error: Error) => {
      showToast(error.message, 'error');
    },
  });

  // addTypeMutation removed - we now handle type creation with printer assignment
  // directly in onAddType callback

  const updateTypeMutation = useMutation({
    // `wiki_url` is part of `MaintenanceTypeCreate` and reaches the API
    // correctly at runtime (the api helper takes `Partial<MaintenanceTypeCreate>`),
    // but the inline shape on this mutation used to omit it — making the
    // type lie about what the payload carries (#1596 nit).
    mutationFn: ({ id, data }: { id: number; data: Partial<{ name: string; default_interval_hours: number; interval_type: MaintenanceIntervalType; icon: string; wiki_url: string | null }> }) =>
      api.updateMaintenanceType(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['maintenanceTypes'] });
      queryClient.invalidateQueries({ queryKey: ['maintenanceOverview'] });
      showToast(t('maintenance.typeUpdated'));
    },
    onError: (error: Error) => {
      showToast(error.message, 'error');
    },
  });

  const deleteTypeMutation = useMutation({
    mutationFn: api.deleteMaintenanceType,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['maintenanceTypes'] });
      queryClient.invalidateQueries({ queryKey: ['maintenanceOverview'] });
      showToast(t('maintenance.typeDeleted'));
    },
    onError: (error: Error) => {
      showToast(error.message, 'error');
    },
  });

  const restoreDefaultsMutation = useMutation({
    mutationFn: api.restoreDefaultMaintenanceTypes,
    onSuccess: (data: { restored: number }) => {
      queryClient.invalidateQueries({ queryKey: ['maintenanceTypes'] });
      queryClient.invalidateQueries({ queryKey: ['maintenanceOverview'] });
      showToast(t('maintenance.defaultsRestored', { count: data.restored }));
    },
    onError: (error: Error) => {
      showToast(error.message, 'error');
    },
  });

  const setHoursMutation = useMutation({
    mutationFn: ({ printerId, hours }: { printerId: number; hours: number }) =>
      api.setPrinterHours(printerId, hours),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['maintenanceOverview'] });
      queryClient.invalidateQueries({ queryKey: ['maintenanceSummary'] });
      showToast(t('maintenance.printHoursUpdated'));
    },
    onError: (error: Error) => {
      showToast(error.message, 'error');
    },
  });

  const assignTypeMutation = useMutation({
    mutationFn: ({ printerId, typeId }: { printerId: number; typeId: number }) =>
      api.assignMaintenanceType(printerId, typeId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['maintenanceOverview'] });
      showToast(t('maintenance.printerAssigned'));
    },
    onError: (error: Error) => {
      showToast(error.message, 'error');
    },
  });

  const removeItemMutation = useMutation({
    mutationFn: api.removeMaintenanceItem,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['maintenanceOverview'] });
      showToast(t('maintenance.printerRemoved'));
    },
    onError: (error: Error) => {
      showToast(error.message, 'error');
    },
  });

  const handlePerform = (id: number) => {
    performMutation.mutate({ id });
  };

  const handleToggle = (id: number, enabled: boolean) => {
    updateMutation.mutate({ id, data: { enabled } });
  };

  const handleSetHours = (printerId: number, hours: number) => {
    setHoursMutation.mutate({ printerId, hours });
  };

  if (isLoading) {
    return (
      <div className="p-4 md:p-8 flex justify-center">
        <Loader2 className="w-8 h-8 text-bambu-green animate-spin" />
      </div>
    );
  }

  // Counted from the tasks, like the rail and lists, so every number on the page agrees.
  const fleetCounts = summariseTasks((overview ?? []).flatMap((p) => p.maintenance_items));
  const totalDue = fleetCounts.overdue;
  const totalWarning = fleetCounts.soon;

  return (
    <div className="p-4 md:p-8">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white flex items-center gap-3">
          <Wrench className="w-7 h-7 text-bambu-green" />
          {t('maintenance.title')}
        </h1>
        <p className="text-bambu-gray mt-1">
          {activeTab === 'status' ? (
            <>
              {totalDue > 0 && <span className="text-red-400">{t('maintenance.overdueCount', { count: totalDue })}</span>}
              {totalDue > 0 && totalWarning > 0 && ' · '}
              {totalWarning > 0 && <span className="text-amber-400">{t('maintenance.dueSoonCount', { count: totalWarning })}</span>}
              {totalDue === 0 && totalWarning === 0 && <span className="text-bambu-green">{t('maintenance.allOk')}</span>}
            </>
          ) : activeTab === 'log' ? (
            t('maintenance.logDescription')
          ) : (
            t('maintenance.configureSettings')
          )}
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-bambu-dark-tertiary">
        <button
          onClick={() => setActiveTab('status')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            activeTab === 'status'
              ? 'text-bambu-green border-bambu-green'
              : 'text-bambu-gray border-transparent hover:text-white'
          }`}
        >
          {t('maintenance.statusTab')}
        </button>
        <button
          onClick={() => setActiveTab('log')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            activeTab === 'log'
              ? 'text-bambu-green border-bambu-green'
              : 'text-bambu-gray border-transparent hover:text-white'
          }`}
        >
          {t('maintenance.logTab')}
        </button>
        <button
          onClick={() => setActiveTab('settings')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            activeTab === 'settings'
              ? 'text-bambu-green border-bambu-green'
              : 'text-bambu-gray border-transparent hover:text-white'
          }`}
        >
          {t('maintenance.settingsTab')}
        </button>
      </div>

      {/* Tab content */}
      {activeTab === 'status' ? (
        <StatusTab
          overview={overview}
          dateFormat={dateFormat}
          onPerform={handlePerform}
          onToggle={handleToggle}
          onSetHours={handleSetHours}
          onLogRepair={(printerId) => {
            setLogComposePrinterId(printerId);
            setActiveTab('log');
          }}
          onToggleMaintenanceMode={handleToggleMaintenanceMode}
          maintenanceModePending={maintenanceModeMutation.isPending}
          hasPermission={hasPermission}
          t={t}
        />
      ) : activeTab === 'log' ? (
        <MaintenanceLogSection
          overview={overview}
          entries={logEntries}
          isLoading={isLogsLoading}
          isFetchingMore={isFetchingMoreLogs}
          hasMore={Boolean(hasMoreLogs)}
          selectedPrinterId={logPrinterId}
          selectedEntryType={logEntryType}
          onSelectPrinter={setLogPrinterId}
          onSelectEntryType={setLogEntryType}
          composePrinterId={logComposePrinterId}
          onComposeHandled={() => setLogComposePrinterId(null)}
          onLoadMore={() => fetchMoreLogs()}
          onCreate={(data) => createLogMutation.mutateAsync(data)}
          onUpdate={(id, data) => updateLogMutation.mutateAsync({ id, data })}
          onDelete={(id) => deleteLogMutation.mutateAsync(id)}
          isSaving={createLogMutation.isPending || updateLogMutation.isPending}
          hasPermission={hasPermission}
          dateFormat={dateFormat}
          t={t}
        />
      ) : (
        <SettingsSection
          overview={overview}
          types={types || []}
          onUpdateInterval={(id, data) =>
            updateMutation.mutate({ id, data })
          }
          onAddType={async (data, printerIds) => {
            // Create the type first, then assign to selected printers
            const newType = await api.createMaintenanceType(data);
            // Assign to each selected printer
            for (const printerId of printerIds) {
              await api.assignMaintenanceType(printerId, newType.id);
            }
            queryClient.invalidateQueries({ queryKey: ['maintenanceTypes'] });
            queryClient.invalidateQueries({ queryKey: ['maintenanceOverview'] });
            showToast(t('maintenance.typeUpdated'));
          }}
          onUpdateType={(id, data) => updateTypeMutation.mutate({ id, data })}
          onDeleteType={(id) => deleteTypeMutation.mutate(id)}
          onRestoreDefaults={() => restoreDefaultsMutation.mutate()}
          isRestoringDefaults={restoreDefaultsMutation.isPending}
          onAssignType={(printerId, typeId) => assignTypeMutation.mutate({ printerId, typeId })}
          onRemoveItem={(itemId) => removeItemMutation.mutate(itemId)}
          hasPermission={hasPermission}
          t={t}
        />
      )}

      {confirmEnterMaintenance && (
        <ConfirmModal
          title={t('printers.maintenance.confirmMidPrintTitle')}
          message={t('printers.maintenance.confirmMidPrintMessage', { name: confirmEnterMaintenance.name })}
          confirmText={t('printers.maintenance.menuEnter')}
          variant="danger"
          onConfirm={() => {
            maintenanceModeMutation.mutate({ id: confirmEnterMaintenance.id, name: confirmEnterMaintenance.name, isActive: false });
            setConfirmEnterMaintenance(null);
          }}
          onCancel={() => setConfirmEnterMaintenance(null)}
        />
      )}
    </div>
  );
}

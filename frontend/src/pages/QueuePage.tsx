import { useState, useMemo, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { LucideIcon } from 'lucide-react';
import { queueItemDisplayName } from '../utils/queueItemName';
import {
  Clock,
  Trash2,
  Play,
  X,
  AlertCircle,
  Calendar,
  Printer,
  GripVertical,
  SkipForward,
  ExternalLink,
  Power,
  Pencil,
  Timer,
  ListOrdered,
  Layers,
  ArrowUp,
  ArrowDown,
  Hand,
  Check,
  CheckSquare,
  Square,
  User,
  Pause,
  Weight,
  List,
  GanttChart,
  Code,
  Snail,
  Package,
  PlayCircle,
  ChevronDown,
  ChevronUp,
  Plus,
} from 'lucide-react';
import { api, ApiError } from '../api/client';
import { type TimeFormat, formatDate, formatETA, formatDuration, formatRelativeTime, parseUTCDate } from '../utils/date';
import { getBedTypeInfo } from '../utils/bedType';
import type { PrintQueueItem, PrintQueueBulkUpdate, Permission, CalibrationMode } from '../api/client';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { ConfirmModal } from '../components/ConfirmModal';
import { PrintModal } from '../components/PrintModal';
import { DirectPrintUploadModal } from '../components/DirectPrintUploadModal';
import { useToast } from '../contexts/ToastContext';
import { useAuth } from '../contexts/AuthContext';
import { QueueStatsBar } from '../components/QueueStatsBar';
import { CompactHistoryRow } from '../components/CompactHistoryRow';
import { QueueTimelineView } from '../components/QueueTimelineView';
import { ToolbarDropdown, ReactSelect, toolbarControlClass, toolbarIconButtonClass } from '../components/ToolbarControls';

function formatWeight(g: number, useKg = false): string {
  if (useKg && g >= 1000) return `${(g / 1000).toFixed(1)}kg`;
  return `${Math.round(g)}g`;
}

function formatHeatSoakCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

type QueueTone = {
  /** Gutter label/icon colour. */
  text: string;
  /** Gutter background + divider. */
  gutter: string;
  /** Card border colour. */
  border: string;
  /** Faint wash laid over the card, or '' for none. */
  wash: string;
  /** Footer strip background, border and text colour. */
  footer: string;
  /** Ring drawn around a selected card. */
  ring: string;
};

// Coloured text uses a dark shade in the light theme and a light shade in the
// dark theme; neutral text uses theme tokens so it follows the active theme.
const QUEUE_TONES = {
  waiting: {
    text: 'text-purple-700 dark:text-purple-300',
    gutter: 'bg-purple-400/20 border-purple-400/40',
    border: 'border-purple-400/45',
    wash: 'bg-purple-400/[0.07]',
    footer: 'bg-purple-400/10 border-purple-400/25 text-purple-700 dark:text-purple-300',
    ring: 'ring-1 ring-purple-400',
  },
  active: {
    text: 'text-green-700 dark:text-green-400',
    gutter: 'bg-bambu-green/20 border-bambu-green/45',
    border: 'border-bambu-green/50',
    wash: 'bg-bambu-green/[0.07]',
    footer: 'bg-bambu-green/10 border-bambu-green/30 text-bambu-gray-light',
    ring: 'ring-1 ring-bambu-green',
  },
  neutral: {
    text: 'text-white',
    gutter: 'bg-bambu-gray-light/15 border-bambu-gray-dark',
    border: 'border-bambu-gray-dark',
    wash: '',
    footer: 'bg-bambu-dark/40 border-bambu-dark-tertiary',
    ring: 'ring-1 ring-bambu-gray-light',
  },
  scheduled: {
    text: 'text-yellow-700 dark:text-yellow-300',
    gutter: 'bg-yellow-400/15 border-yellow-400/40',
    border: 'border-yellow-400/40',
    wash: 'bg-yellow-400/[0.06]',
    footer: 'bg-yellow-400/10 border-yellow-400/25 text-yellow-700 dark:text-yellow-300',
    ring: 'ring-1 ring-yellow-400',
  },
  preheating: {
    text: 'text-amber-700 dark:text-amber-300',
    gutter: 'bg-amber-400/15 border-amber-400/40',
    border: 'border-amber-400/40',
    wash: 'bg-amber-400/[0.06]',
    footer: 'bg-amber-400/10 border-amber-400/25 text-amber-700 dark:text-amber-300',
    ring: 'ring-1 ring-amber-400',
  },
} satisfies Record<string, QueueTone>;

/**
 * Status colour, icon and label for a queue card's gutter. Only statuses that
 * render as a SortableQueueItem are handled; finished jobs use CompactHistoryRow.
 */
function resolveQueueTone(
  item: PrintQueueItem,
  printerState: string | null | undefined,
  t: (key: string) => string,
): { tone: QueueTone; Icon: LucideIcon; label: string } {
  const { status } = item;
  // A future pending job has its own explicit status.
  if (status === 'pending' && item.scheduled_time && (parseUTCDate(item.scheduled_time)?.getTime() ?? 0) > Date.now()) {
    return { tone: QUEUE_TONES.scheduled, Icon: Calendar, label: t('queue.status.scheduled') };
  }
  // Pending with a waiting_reason is blocked on something (filament, printer).
  if (status === 'pending' && item.waiting_reason) {
    return { tone: QUEUE_TONES.waiting, Icon: Clock, label: t('queue.status.waiting') };
  }
  if (status === 'printing' && printerState === 'PAUSE') {
    return { tone: QUEUE_TONES.scheduled, Icon: Pause, label: t('queue.status.paused') };
  }
  switch (status) {
    case 'preheating': return { tone: QUEUE_TONES.preheating, Icon: Timer, label: t('heatSoak.status') };
    case 'dispatching': return { tone: QUEUE_TONES.waiting, Icon: Timer, label: t('queue.status.dispatching') };
    case 'printing': return { tone: QUEUE_TONES.active, Icon: Printer, label: t('queue.status.printing') };
    default: return { tone: QUEUE_TONES.neutral, Icon: List, label: t('queue.status.pending') };
  }
}

/** The square cancel/stop button at the right of a queue card. */
function QueueActionButton({
  onClick,
  disabled,
  title,
  label,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      className="flex h-11 w-11 items-center justify-center rounded-[10px] border border-red-400/25 bg-red-400/10 text-red-600 transition-colors hover:border-red-400/50 hover:bg-red-400/20 disabled:cursor-not-allowed disabled:opacity-40 dark:text-red-400"
    >
      {children}
    </button>
  );
}

// Bulk edit modal for multiple queue items
function BulkEditModal({
  selectedCount,
  printers,
  onSave,
  onClose,
  isSaving,
  canControlPrinter,
  t,
}: {
  selectedCount: number;
  printers: { id: number; name: string; nozzle_count?: number }[];
  onSave: (data: Partial<PrintQueueBulkUpdate>) => void;
  onClose: () => void;
  isSaving: boolean;
  canControlPrinter: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const [printerId, setPrinterId] = useState<number | null | 'unchanged'>('unchanged');
  const [manualStart, setManualStart] = useState<boolean | 'unchanged'>('unchanged');
  const [autoOffAfter, setAutoOffAfter] = useState<boolean | 'unchanged'>('unchanged');
  const [requirePreviousSuccess, setRequirePreviousSuccess] = useState<boolean | 'unchanged'>('unchanged');
  const [bedLevelling, setBedLevelling] = useState<CalibrationMode | 'unchanged'>('unchanged');
  const [flowCali, setFlowCali] = useState<CalibrationMode | 'unchanged'>('unchanged');
  const [vibrationCali, setVibrationCali] = useState<boolean | 'unchanged'>('unchanged');
  const [layerInspect, setLayerInspect] = useState<boolean | 'unchanged'>('unchanged');
  const [timelapse, setTimelapse] = useState<boolean | 'unchanged'>('unchanged');
  const [useAms, setUseAms] = useState<boolean | 'unchanged'>('unchanged');
  const [nozzleOffsetCali, setNozzleOffsetCali] = useState<CalibrationMode | 'unchanged'>('unchanged');

  // Show the dual-nozzle-only toggle when the user has at least one
  // dual-nozzle printer registered (H2D/H2D Pro/H2C/X2D). Single-nozzle
  // queues never see it — the MQTT layer ignores the field anyway.
  const hasDualNozzlePrinter = printers.some(p => p.nozzle_count === 2);

  const handleSave = () => {
    const data: Partial<PrintQueueBulkUpdate> = {};
    if (printerId !== 'unchanged') data.printer_id = printerId;
    if (manualStart !== 'unchanged') data.manual_start = manualStart;
    if (autoOffAfter !== 'unchanged') data.auto_off_after = autoOffAfter;
    if (requirePreviousSuccess !== 'unchanged') data.require_previous_success = requirePreviousSuccess;
    if (bedLevelling !== 'unchanged') data.bed_levelling = bedLevelling;
    if (flowCali !== 'unchanged') data.flow_cali = flowCali;
    if (vibrationCali !== 'unchanged') data.vibration_cali = vibrationCali;
    if (layerInspect !== 'unchanged') data.layer_inspect = layerInspect;
    if (timelapse !== 'unchanged') data.timelapse = timelapse;
    if (useAms !== 'unchanged') data.use_ams = useAms;
    if (nozzleOffsetCali !== 'unchanged') data.nozzle_offset_cali = nozzleOffsetCali;
    onSave(data);
  };

  const hasChanges = printerId !== 'unchanged' || manualStart !== 'unchanged' || autoOffAfter !== 'unchanged' ||
    requirePreviousSuccess !== 'unchanged' || bedLevelling !== 'unchanged' || flowCali !== 'unchanged' ||
    vibrationCali !== 'unchanged' || layerInspect !== 'unchanged' || timelapse !== 'unchanged' || useAms !== 'unchanged' ||
    nozzleOffsetCali !== 'unchanged';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="bg-bambu-dark-secondary rounded-xl border border-bambu-dark-tertiary w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-bambu-dark-tertiary">
          <h2 className="text-lg font-semibold text-white">
            {t('queue.bulkEdit.title', { count: selectedCount })}
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-bambu-dark rounded">
            <X className="w-5 h-5 text-bambu-gray" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <p className="text-sm text-bambu-gray">
            {t('queue.bulkEdit.description')}
          </p>

          {/* Printer Assignment */}
          <div>
            <label className="block text-sm font-medium text-white mb-2">{t('queue.bulkEdit.printer')}</label>
            <ReactSelect
              value={printerId === null ? 'null' : printerId === 'unchanged' ? 'unchanged' : String(printerId)}
              onChange={(e) => {
                const val = e.target.value;
                if (val === 'unchanged') setPrinterId('unchanged');
                else if (val === 'null') setPrinterId(null);
                else setPrinterId(Number(val));
              }}
              className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
            >
              <option value="unchanged">{t('queue.bulkEdit.noChange')}</option>
              <option value="null">{t('queue.filter.unassigned')}</option>
              {printers.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </ReactSelect>
          </div>

          {/* Queue Options */}
          <div>
            <label className="block text-sm font-medium text-white mb-2">{t('queue.bulkEdit.queueOptions')}</label>
            <div className="space-y-2">
              <TriStateToggle label={t('queue.bulkEdit.staged')} value={manualStart} onChange={setManualStart} t={t} />
              <TriStateToggle label={t('queue.bulkEdit.autoPowerOff')} value={autoOffAfter} onChange={setAutoOffAfter} disabled={!canControlPrinter} t={t} />
              <TriStateToggle label={t('queue.bulkEdit.requirePrevious')} value={requirePreviousSuccess} onChange={setRequirePreviousSuccess} t={t} />
            </div>
          </div>

          {/* Print Options */}
          <div>
            <label className="block text-sm font-medium text-white mb-2">{t('queue.bulkEdit.printOptions')}</label>
            <div className="space-y-2">
              <CalibrationModeToggle label={t('queue.bulkEdit.bedLevelling')} value={bedLevelling} onChange={setBedLevelling} t={t} />
              <CalibrationModeToggle label={t('queue.bulkEdit.flowCalibration')} value={flowCali} onChange={setFlowCali} t={t} />
              <TriStateToggle label={t('queue.bulkEdit.vibrationCalibration')} value={vibrationCali} onChange={setVibrationCali} t={t} />
              <TriStateToggle label={t('queue.bulkEdit.layerInspection')} value={layerInspect} onChange={setLayerInspect} t={t} />
              <TriStateToggle label={t('queue.bulkEdit.timelapse')} value={timelapse} onChange={setTimelapse} t={t} />
              <TriStateToggle label={t('queue.bulkEdit.useAms')} value={useAms} onChange={setUseAms} t={t} />
              {hasDualNozzlePrinter && (
                <CalibrationModeToggle label={t('queue.bulkEdit.nozzleOffsetCali')} value={nozzleOffsetCali} onChange={setNozzleOffsetCali} t={t} />
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 p-4 border-t border-bambu-dark-tertiary">
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            onClick={handleSave}
            disabled={!hasChanges || isSaving}
          >
            {isSaving ? t('common.saving') : t('queue.bulkEdit.applyChanges')}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Tri-state toggle for bulk edit (unchanged / on / off)
function TriStateToggle({
  label,
  value,
  onChange,
  disabled,
  t,
}: {
  label: string;
  value: boolean | 'unchanged';
  onChange: (val: boolean | 'unchanged') => void;
  disabled?: boolean;
  t: (key: string) => string;
}) {
  return (
    <div className={`flex items-center justify-between py-1 ${disabled ? 'opacity-50' : ''}`}>
      <span className="text-sm text-bambu-gray">{label}</span>
      <div className="flex items-center gap-1 bg-bambu-dark rounded-lg p-0.5">
        <button
          onClick={() => onChange('unchanged')}
          disabled={disabled}
          className={`px-2 py-1 text-xs rounded ${value === 'unchanged' ? 'bg-bambu-dark-tertiary text-white' : 'text-bambu-gray hover:text-white'} disabled:cursor-not-allowed`}
        >
          —
        </button>
        <button
          onClick={() => onChange(false)}
          disabled={disabled}
          className={`px-2 py-1 text-xs rounded ${value === false ? 'bg-red-500/20 text-red-400' : 'text-bambu-gray hover:text-white'} disabled:cursor-not-allowed`}
        >
          {t('common.off')}
        </button>
        <button
          onClick={() => onChange(true)}
          disabled={disabled}
          className={`px-2 py-1 text-xs rounded ${value === true ? 'bg-bambu-green/20 text-bambu-green' : 'text-bambu-gray hover:text-white'} disabled:cursor-not-allowed`}
        >
          {t('common.on')}
        </button>
      </div>
    </div>
  );
}

// Four-state selector for the tri-state calibration options in bulk edit
// (unchanged / off / auto / on). Mirrors TriStateToggle's chrome.
function CalibrationModeToggle({
  label,
  value,
  onChange,
  t,
}: {
  label: string;
  value: CalibrationMode | 'unchanged';
  onChange: (val: CalibrationMode | 'unchanged') => void;
  t: (key: string) => string;
}) {
  const modes: Array<{ key: CalibrationMode | 'unchanged'; label: string; active: string }> = [
    { key: 'unchanged', label: '—', active: 'bg-bambu-dark-tertiary text-white' },
    { key: 'off', label: t('settings.calibrationMode_off'), active: 'bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-400' },
    { key: 'auto', label: t('settings.calibrationMode_auto'), active: 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400' },
    { key: 'on', label: t('settings.calibrationMode_on'), active: 'bg-bambu-green/20 text-bambu-green' },
  ];
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-sm text-bambu-gray">{label}</span>
      <div className="flex items-center gap-1 bg-bambu-dark rounded-lg p-0.5">
        {modes.map(({ key, label: modeLabel, active }) => (
          <button
            key={key}
            onClick={() => onChange(key)}
            className={`px-2 py-1 text-xs rounded ${value === key ? active : 'text-bambu-gray hover:text-white'}`}
          >
            {modeLabel}
          </button>
        ))}
      </div>
    </div>
  );
}

// Sortable queue item for drag and drop
function SortableQueueItem({
  item,
  onEdit,
  onCancel,
  onStop,
  onSkipHeatSoak,
  isSkippingHeatSoak = false,
  onStart,
  timeFormat = 'system',
  isSelected = false,
  selectionActive = false,
  onToggleSelect,
  hasPermission,
  canModify,
  printerState,
  onMoveUp,
  onMoveDown,
  t,
}: {
  item: PrintQueueItem;
  onEdit: () => void;
  onCancel: () => void;
  onStop: () => void;
  onSkipHeatSoak?: () => void;
  isSkippingHeatSoak?: boolean;
  onStart: () => void;
  timeFormat?: TimeFormat;
  isSelected?: boolean;
  /** True while any job is ticked: every card then shows its checkbox. */
  selectionActive?: boolean;
  onToggleSelect?: () => void;
  hasPermission: (permission: Permission) => boolean;
  canModify: (resource: 'queue' | 'archives' | 'library', action: 'update' | 'delete' | 'reprint', createdById: number | null | undefined) => boolean;
  printerState?: string | null;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  // Fetch printer status every 30 seconds while printing to monitor progress
  const { data: status } = useQuery({
    queryKey: ['printerStatus', item.printer_id],
    queryFn: () => api.getPrinterStatus(item.printer_id!),
    refetchInterval: 30000,
    enabled: item.printer_id != null && printerState === 'printing',
  });

  // Determine if we're printing a library file
  const isLibraryFile = !!item.library_file_id && !item.archive_id;
  // Fetch archive plate details. Skip when the linked archive has been
  // soft-deleted (#1348 follow-up): its 3MF is gone from disk so the
  // /plates endpoint just 404-storms the queue page.
  const { data: archivePlatesData } = useQuery({
    queryKey: ['archive-plates', item.archive_id],
    queryFn: () => api.getArchivePlates(item.archive_id!),
    enabled: !!item.archive_id && !isLibraryFile && !item.archive_deleted,
  });

  // Fetch library file plate details
  const { data: libraryPlatesData } = useQuery({
    queryKey: ['library-file-plates', item.library_file_id],
    queryFn: () => api.getLibraryFilePlates(item.library_file_id!),
    enabled: isLibraryFile && !!item.library_file_id,
  });

  // Combine plates data from either source
  const platesData = isLibraryFile ? libraryPlatesData : archivePlatesData;
  const plates = platesData?.plates ?? [];

  const canReorder =
    hasPermission('queue:reorder') &&
    canModify('queue', 'update', item.created_by_id);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, disabled: item.status !== 'pending' || !canReorder });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const isPrinting = item.status === 'printing' || item.status === 'preheating';
  const isDispatching = item.status === 'dispatching';
  const isPending = item.status === 'pending';

  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  useEffect(() => {
    if (item.status !== 'preheating') return;

    const interval = window.setInterval(() => setCountdownNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [item.status]);

  const preheatStartedAt = item.preheat_started_at ? parseUTCDate(item.preheat_started_at) : null;
  const heatSoakRemainingSeconds = item.status === 'preheating' && preheatStartedAt && item.heat_soak_minutes
    ? Math.max(0, item.heat_soak_minutes * 60 - Math.floor((countdownNow - preheatStartedAt.getTime()) / 1000))
    : null;

  const displayName = `${queueItemDisplayName(item, (n) => t('common.plusNMore', { count: n }))}${
    (platesData?.is_multi_plate ?? false) && item.plate_id !== undefined && item.plate_id !== null
      ? ` • ${plates.find(plate => plate.index === item.plate_id)?.name || t('queue.plateNumber', { index: item.plate_id })}`
      : ''
  }`;
  const { tone, Icon: StatusIcon, label: statusLabel } = resolveQueueTone(item, printerState, t);
  const canUpdate = canModify('queue', 'update', item.created_by_id);
  const canDelete = canModify('queue', 'delete', item.created_by_id);
  const canEditItem = isPending && canUpdate;
  const showCheckbox = isPending && !!onToggleSelect;
  const checkboxAlwaysVisible = isSelected || selectionActive;
  const bed = getBedTypeInfo(item.bed_type);
  const showStartButton = isPending && item.manual_start;
  const showWaitingReason = isPending && !!item.waiting_reason;
  const showStagedFooter = showStartButton || showWaitingReason;
  const stopTitle = !canUpdate ? t('queue.permissions.noStopPrint') : t('queue.actions.stopPrint');

  const optionIcons = (
    <>
      {item.require_previous_success && (
        <span
          role="img"
          aria-label={t('queue.badges.requiresPrevious')}
          title={t('queue.badges.requiresPrevious')}
          className="inline-flex shrink-0 text-orange-600 dark:text-orange-400"
        >
          <Check className="w-3.5 h-3.5" />
        </span>
      )}
      {item.auto_off_after && (
        <span
          role="img"
          aria-label={t('queue.badges.autoPowerOff')}
          title={t('queue.badges.autoPowerOff')}
          className="inline-flex shrink-0 text-blue-600 dark:text-blue-400"
        >
          <Power className="w-3.5 h-3.5" />
        </span>
      )}
      {item.gcode_injection && (
        <span
          role="img"
          aria-label={t('queue.badges.gcodeInjection')}
          title={t('queue.badges.gcodeInjection')}
          className="inline-flex shrink-0 text-emerald-600 dark:text-emerald-400"
        >
          <Code className="w-3.5 h-3.5" />
        </span>
      )}
    </>
  );

  const printerLabel =
    (item.variants?.length ?? 0) > 1 && !item.printer_id
      ? // A cross-model item (#671) is waiting on several models at once.
        // Showing only target_model would name whichever candidate is
        // first and read as a lie the moment the other one runs.
        `${t('queue.filter.any')} ${item.variants!.map(v => v.target_model).join(' / ')}${item.target_location ? ` @ ${item.target_location}` : ''}`
      : item.target_model && !item.printer_id
        ? `${t('queue.filter.any')} ${item.target_model}${item.target_location ? ` @ ${item.target_location}` : ''}${item.required_filament_types?.length ? ` (${item.required_filament_types.join(', ')})` : ''}`
        : item.printer_id === null
          ? t('queue.filter.unassigned')
          : (item.printer_name || `${t('common.printer')} #${item.printer_id}`);
  const printerTone =
    item.printer_id === null && !item.target_model ? 'text-orange-600 dark:text-orange-400'
    : item.target_model && !item.printer_id ? 'text-blue-600 dark:text-blue-400'
    : isPrinting ? 'text-bambu-green-light'
    : 'text-bambu-gray-light';

  const isFutureSchedule = !!item.scheduled_time && (parseUTCDate(item.scheduled_time)?.getTime() ?? 0) > Date.now();
  const scheduleText = isPending && !item.manual_start
    ? (item.scheduled_time
        ? ((parseUTCDate(item.scheduled_time)?.getTime() ?? 0) - Date.now() < -60000
            ? t('queue.time.overdue')
            : isFutureSchedule
              ? formatDate(item.scheduled_time)
              : formatRelativeTime(item.scheduled_time, timeFormat, t))
        : t('queue.time.asap'))
    : null;

  const heatSoakText = item.status === 'preheating'
    ? (heatSoakRemainingSeconds !== null
        ? t('heatSoak.remaining', { time: formatHeatSoakCountdown(heatSoakRemainingSeconds) })
        : t('heatSoak.waitingForConfirmation'))
    : null;

  const printingProgress = isPrinting && status
    ? (() => {
        // Gate progress/remaining/layer on printer actually running this print.
        // Between dispatch and RUNNING transition (H2D/P1 MQTT lag), status.progress
        // is stale from the previous print — showing 100% then snapping back to 0%
        // once the new print starts. Only trust these fields when state is active.
        const isActive = status.state === 'RUNNING' || status.state === 'PAUSE';
        return {
          progress: isActive ? (status.progress || 0) : 0,
          remaining: isActive ? status.remaining_time : null,
          layerNum: isActive ? status.layer_num : null,
          totalLayers: isActive ? status.total_layers : null,
        };
      })()
    : null;

  const handleCardClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!canEditItem) return;
    // Links, buttons, inputs and the drag handle keep their own behaviour.
    if ((e.target as HTMLElement).closest('a, button, input, label, [data-no-card-click]')) return;
    onEdit();
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={handleCardClick}
      className={`
        group relative flex overflow-hidden rounded-xl border bg-bambu-dark-secondary transition-all duration-200
        ${tone.border}
        ${canEditItem ? 'cursor-pointer hover:brightness-110' : ''}
        ${isSelected ? tone.ring : ''}
        ${isDragging ? 'opacity-50 scale-[1.02] shadow-xl z-50' : ''}
      `}
    >
      {tone.wash && <div aria-hidden="true" className={`pointer-events-none absolute inset-0 ${tone.wash}`} />}

      {/* Status gutter: status icon + label. For pending jobs it doubles as the
          drag handle — the icon swaps for a grip on hover. */}
      <div className={`relative z-10 flex w-12 sm:w-[80px] flex-none flex-col items-center justify-center border-r ${tone.gutter} ${tone.text}`} data-no-card-click>
        {isPending && canReorder ? (
          <div
            {...attributes}
            {...listeners}
            aria-label={`${statusLabel}, ${t('queue.dragToReorder')}`}
            title={t('queue.dragToReorder')}
            className="group/grip hidden sm:flex h-full w-full cursor-grab flex-col items-center justify-center gap-1.5 px-1 transition-colors hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bambu-green active:cursor-grabbing touch-manipulation dark:hover:bg-white/10"
          >
            <StatusIcon className="h-6 w-6 group-hover/grip:hidden group-focus-visible/grip:hidden" />
            <GripVertical className="hidden h-6 w-6 group-hover/grip:block group-focus-visible/grip:block" />
            <span className="break-words text-center text-[10px] font-bold uppercase tracking-[0.04em]">{statusLabel}</span>
          </div>
        ) : (
          <div className="hidden sm:flex flex-col items-center justify-center gap-1.5 px-1">
            <StatusIcon className="h-6 w-6" />
            <span className="break-words text-center text-[10px] font-bold uppercase tracking-[0.04em]">{statusLabel}</span>
          </div>
        )}
        {/* Mobile: compact gutter with the status icon and up/down reorder buttons */}
        <div className="sm:hidden flex flex-col items-center gap-1">
          <StatusIcon className="h-5 w-5" aria-hidden="true" />
          {isPending && (onMoveUp || onMoveDown) && (
            <>
              <button
                type="button"
                aria-label={t('queue.moveUp')}
                disabled={!onMoveUp}
                onClick={(e) => {
                  e.stopPropagation();
                  onMoveUp?.();
                }}
                className="flex h-5 w-6 items-center justify-center rounded hover:bg-black/5 disabled:opacity-25 dark:hover:bg-white/10"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label={t('queue.moveDown')}
                disabled={!onMoveDown}
                onClick={(e) => {
                  e.stopPropagation();
                  onMoveDown?.();
                }}
                className="flex h-5 w-6 items-center justify-center rounded hover:bg-black/5 disabled:opacity-25 dark:hover:bg-white/10"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      </div>

      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 sm:gap-3.5 px-3 py-2.5 sm:pl-[18px] sm:pr-3">
          {/* Thumbnail with hover-revealed selection checkbox */}
          <div className="relative h-11 w-11 flex-none">
            <div className={`h-11 w-11 overflow-hidden rounded-lg bg-bambu-dark ${isSelected ? 'ring-2 ring-bambu-green' : ''}`}>
              {item.archive_thumbnail ? (
                <img
                  src={
                    item.plate_id != null
                      ? api.getArchivePlateThumbnail(item.archive_id!, item.plate_id)
                      : api.getArchiveThumbnail(item.archive_id!)
                  }
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : item.library_file_thumbnail ? (
                <img
                  src={
                    item.plate_id != null
                      ? api.getLibraryFilePlateThumbnail(item.library_file_id!, item.plate_id)
                      : api.getLibraryFileThumbnailUrl(item.library_file_id!)
                  }
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-bambu-gray">
                  <Layers className="h-5 w-5" />
                </div>
              )}
            </div>
            {showCheckbox && (
              <label
                className={`absolute -left-2 -top-2 flex h-6 w-6 cursor-pointer items-center justify-center rounded-[7px] border bg-bambu-dark shadow-md transition-opacity ${
                  isSelected ? 'border-bambu-green' : 'border-bambu-gray-dark'
                } ${
                  checkboxAlwaysVisible
                    ? 'opacity-100'
                    : 'can-hover:opacity-0 group-hover:opacity-100 focus-within:opacity-100'
                }`}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggleSelect?.()}
                  aria-label={t('queue.selectJob', { name: displayName })}
                  className="m-0 h-4 w-4 cursor-pointer accent-bambu-green"
                />
              </label>
            )}
          </div>

          {/* Info */}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex min-w-0 items-center gap-2">
              {canEditItem ? (
                <button
                  type="button"
                  onClick={onEdit}
                  title={t('common.edit')}
                  className="min-w-0 truncate text-left text-sm font-semibold text-white hover:underline hover:decoration-bambu-gray-light hover:underline-offset-[3px] focus-visible:underline sm:text-[15px]"
                >
                  {displayName}
                </button>
              ) : (
                <p className="min-w-0 truncate text-sm font-semibold text-white sm:text-[15px]">{displayName}</p>
              )}
              {item.archive_id ? (
                <Link
                  to={`/archives?highlight=${item.archive_id}`}
                  className="flex-shrink-0 text-bambu-gray transition-colors hover:text-bambu-green"
                  title={t('queue.viewArchive')}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </Link>
              ) : item.library_file_id ? (
                <Link
                  to={`/library?highlight=${item.library_file_id}`}
                  className="flex-shrink-0 text-bambu-gray transition-colors hover:text-bambu-green"
                  title={t('queue.viewInFileManager')}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </Link>
              ) : null}
              {optionIcons}
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-bambu-gray-light sm:text-[13px]">
              <span className={`text-[10px] font-bold uppercase tracking-[0.04em] sm:hidden ${tone.text}`}>{statusLabel}</span>
              <span className={`flex items-center gap-1.5 ${printerTone}`}>
                <Printer className="h-3.5 w-3.5" />
                <span className="max-w-[160px] truncate sm:max-w-none">{printerLabel}</span>
              </span>
              {bed && (
                <span className="flex items-center gap-1.5" title={bed.label}>
                  <img src={bed.icon} alt="" className="h-4 w-4 object-contain" />
                  <span className="max-w-[140px] truncate">{bed.label}</span>
                </span>
              )}
              {item.created_by_username && (
                <span className="hidden items-center gap-1.5 sm:flex" title={t('queue.addedBy', { name: item.created_by_username })}>
                  <User className="h-3.5 w-3.5" />
                  {item.created_by_username}
                </span>
              )}
              {scheduleText && (
                <span className="flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" />
                  {scheduleText}
                </span>
              )}
              {/* Time and weight sit in the right-hand column on wider screens */}
              <span className="flex items-center gap-3 sm:hidden">
                {item.print_time_seconds ? (
                  <span className="flex items-center gap-1">
                    <Timer className="h-3 w-3" />
                    {formatDuration(item.print_time_seconds)}
                  </span>
                ) : null}
                {item.filament_used_grams ? (
                  <span className="flex items-center gap-1">
                    <Weight className="h-3 w-3" />
                    {formatWeight(item.filament_used_grams)}
                  </span>
                ) : null}
              </span>
            </div>
          </div>

          {/* Time + weight */}
          <div className="hidden min-w-[72px] flex-none flex-col items-end gap-0.5 sm:flex">
            {item.print_time_seconds ? (
              <span className="text-[15px] font-semibold text-white">{formatDuration(item.print_time_seconds)}</span>
            ) : null}
            {item.filament_used_grams ? (
              <span className="text-xs text-bambu-gray-light">{formatWeight(item.filament_used_grams)}</span>
            ) : null}
          </div>

          {/* Single action slot */}
          <div className="flex flex-none items-center gap-2" data-no-card-click>
            {(isDispatching || isPrinting) && (
              <QueueActionButton
                onClick={onStop}
                disabled={!canUpdate}
                title={stopTitle}
                label={t('queue.actions.stopPrint')}
              >
                <X className="h-[18px] w-[18px]" />
              </QueueActionButton>
            )}
            {isPending && (
              <QueueActionButton
                onClick={onCancel}
                disabled={!canDelete}
                title={!canDelete ? t('queue.permissions.noCancel') : t('common.cancel')}
                label={t('common.cancel')}
              >
                <X className="h-[18px] w-[18px]" />
              </QueueActionButton>
            )}
          </div>
        </div>

        {/* Footer strips: only rendered when there is something to say */}
        {showStagedFooter && (
          <div className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t px-4 py-1.5 text-xs ${tone.footer}`}>
            {showWaitingReason ? (
              <span className="flex min-w-0 flex-1 items-start gap-2">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                <span>{item.waiting_reason}</span>
              </span>
            ) : (
              <span className="flex-1" />
            )}
            {item.manual_start && (
              <span className="flex items-center gap-1.5">
                <Hand className="h-3 w-3" />
                {t('queue.badges.staged')}
              </span>
            )}
            {showStartButton && (
              <button
                type="button"
                onClick={onStart}
                disabled={!canUpdate}
                title={!canUpdate ? t('queue.permissions.noStartPrint') : t('queue.actions.startPrint')}
                className="inline-flex h-[26px] items-center gap-1.5 rounded-md border border-bambu-green bg-bambu-green/15 px-3 text-xs font-semibold text-green-700 dark:text-green-400 transition-colors hover:bg-bambu-green/25 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Play className="h-3 w-3 fill-current" />
                {t('queue.startNow')}
              </button>
            )}
          </div>
        )}

        {/* Filament-short flag from the dispatch pre-flight (#1496). */}
        {item.filament_short && item.status === 'pending' && (
          <div
            className="flex items-start gap-2 border-t border-yellow-400/25 bg-yellow-400/10 px-4 py-1.5 text-xs text-yellow-700 dark:text-yellow-300"
            title={t('queue.filamentShort.rowTooltip')}
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span>{t('queue.filamentShort.rowBadge')}</span>
          </div>
        )}

        {/* Progress for printing items */}
        {printingProgress && (
          <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-4 py-2 text-xs ${tone.footer}`}>
            <div className="h-1.5 min-w-[120px] flex-1 rounded-full bg-bambu-dark-tertiary">
              <div
                className="h-1.5 rounded-full bg-bambu-green-light transition-all"
                style={{ width: `${printingProgress.progress}%` }}
              />
            </div>
            <span className="text-[13px] font-bold text-white">{Math.round(printingProgress.progress)}%</span>
            {printingProgress.remaining != null && printingProgress.remaining > 0 && (
              <>
                <span>{formatDuration(printingProgress.remaining * 60)}</span>
                <span className="font-medium text-green-700 dark:text-green-400" title={t('printers.estimatedCompletion')}>
                  ETA {formatETA(printingProgress.remaining, timeFormat, t)}
                </span>
              </>
            )}
            {printingProgress.layerNum != null && printingProgress.totalLayers != null && printingProgress.totalLayers > 0 && (
              <span className="flex items-center gap-1">
                <Layers className="h-3 w-3" />
                {printingProgress.layerNum}/{printingProgress.totalLayers}
              </span>
            )}
          </div>
        )}

        {item.status === 'preheating' && (
          <div className={`flex items-center gap-2 border-t px-4 py-1.5 text-xs ${tone.footer}`}>
            <Timer className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="flex-1">{heatSoakText}</span>
            {onSkipHeatSoak && (
              <button
                type="button"
                onClick={onSkipHeatSoak}
                disabled={isSkippingHeatSoak || !canUpdate}
                aria-label={t('heatSoak.skip')}
                title={!canUpdate ? t('queue.permissions.noStopPrint') : t('heatSoak.skip')}
                className="inline-flex h-[26px] items-center gap-1.5 rounded-md border border-amber-400/40 bg-amber-400/15 px-2.5 text-amber-800 dark:text-amber-200 transition-colors hover:bg-amber-400/25 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <SkipForward className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}

        {/* Error message */}
        {item.error_message && (
          <div className="flex items-center gap-2 border-t border-red-400/25 bg-red-400/10 px-4 py-1.5 text-xs text-red-600 dark:text-red-400">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
            {item.error_message}
          </div>
        )}
      </div>
    </div>
  );
}

type QueueRow = { kind: 'item'; item: PrintQueueItem };

interface QueueRowRenderProps {
  row: QueueRow;
  setEditItem: (item: PrintQueueItem) => void;
  setConfirmAction: (a: { type: 'cancel' | 'remove' | 'stop'; item: PrintQueueItem }) => void;
  startMutation: { mutate: (vars: { id: number; skipFilamentCheck?: boolean }) => void };
  selectedItems: number[];
  handleToggleSelect: (id: number) => void;
  timeFormat: TimeFormat;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hasPermission: (p: any) => boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  canModify: (resource: any, action: any, createdById?: number | null) => boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

function QueueRowRender({
  row,
  setEditItem,
  setConfirmAction,
  startMutation,
  selectedItems,
  handleToggleSelect,
  timeFormat,
  hasPermission,
  canModify,
  t,
  onMoveUp,
  onMoveDown,
}: QueueRowRenderProps) {
  return (
    <SortableQueueItem
      item={row.item}
      onEdit={() => setEditItem(row.item)}
      onCancel={() => setConfirmAction({ type: 'cancel', item: row.item })}
      onStop={() => {}}
      onStart={() => startMutation.mutate({ id: row.item.id })}
      timeFormat={timeFormat}
      isSelected={selectedItems.includes(row.item.id)}
      selectionActive={selectedItems.length > 0}
      onToggleSelect={() => handleToggleSelect(row.item.id)}
      hasPermission={hasPermission}
      canModify={canModify}
      onMoveUp={onMoveUp}
      onMoveDown={onMoveDown}
      t={t}
    />
  );
}
type HistoryRow = { kind: 'item'; item: PrintQueueItem };

interface HistorySectionProps {
  items: PrintQueueItem[];
  visibleCount: number;
  onShowMore: () => void;
  collapsed: boolean;
  sortBy: 'date' | 'name' | 'printer';
  sortAsc: boolean;
  onSortByChange: (v: 'date' | 'name' | 'printer') => void;
  onSortAscToggle: () => void;
  onRemove: (item: PrintQueueItem) => void;
  onRequeue: (item: PrintQueueItem) => void;
  timeFormat: TimeFormat;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hasPermission: (p: any) => boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  canModify: (resource: any, action: any, createdById?: number | null) => boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
}

function HistorySection({
  items,
  visibleCount,
  onShowMore,
  sortBy,
  sortAsc,
  onSortByChange,
  onSortAscToggle,
  onRemove,
  onRequeue,
  timeFormat,
  hasPermission,
  canModify,
  t,
}: HistorySectionProps) {
  if (items.length === 0) {
    return (
      <Card className="p-12 text-center border-dashed">
        <ListOrdered className="w-16 h-16 text-bambu-gray mx-auto mb-4 opacity-50" />
        <h3 className="text-xl font-medium text-white mb-2">{t('queue.history.emptyTitle')}</h3>
        <p className="text-bambu-gray max-w-md mx-auto">{t('queue.history.emptyDescription')}</p>
      </Card>
    );
  }

  // History is also a flat list: legacy batch metadata must not hide or merge
  // the independent rows that users can remove or requeue.
  const rows: HistoryRow[] = items.slice(0, visibleCount).map((item) => ({ kind: 'item', item }));

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3 sm:mb-4">
        <h2 className="text-base sm:text-lg font-semibold text-white flex items-center gap-2">
          {t('queue.sections.history')}
          <span className="text-xs sm:text-sm font-normal text-bambu-gray">
            ({t('queue.itemCount', { count: items.length })})
          </span>
        </h2>
        <div className="flex items-center gap-2">
          <ToolbarDropdown
            value={sortBy}
            onChange={(value) => onSortByChange(value as 'date' | 'name' | 'printer')}
            minWidthClass="min-w-32"
            options={[
              { value: 'date', label: t('queue.sort.byDate') },
              { value: 'name', label: t('queue.sort.byName') },
              { value: 'printer', label: t('queue.sort.byPrinter') },
            ]}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={onSortAscToggle}
            title={sortAsc ? t('queue.sort.ascendingOldest') : t('queue.sort.descendingNewest')}
            className="px-2"
          >
            {sortAsc ? <ArrowUp className="w-4 h-4" /> : <ArrowDown className="w-4 h-4" />}
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
        {rows.map((row) => {
          if (row.kind === 'item') {
            return (
              <CompactHistoryRow
                key={row.item.id}
                item={row.item}
                onRemove={() => onRemove(row.item)}
                onRequeue={() => onRequeue(row.item)}
                timeFormat={timeFormat}
                hasPermission={hasPermission}
                canModify={canModify}
                t={t}
              />
            );
          }
        })}
      </div>
      {visibleCount < items.length && (
        <div className="mt-4 flex flex-col items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onShowMore}>
            {t('queue.history.showMore')}
          </Button>
          <span className="text-xs text-bambu-gray">
            {t('queue.history.showingCount', { shown: Math.min(visibleCount, items.length), total: items.length })}
          </span>
        </div>
      )}
    </div>
  );
}

export function QueuePage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { hasPermission, hasAnyPermission, canModify } = useAuth();
  const HISTORY_PAGE_SIZE = 50;
  const [filterPrinter, setFilterPrinter] = useState<number | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [filterLocation, setFilterLocation] = useState<string>('');
  const [showClearHistoryConfirm, setShowClearHistoryConfirm] = useState(false);
  const [editItem, setEditItem] = useState<PrintQueueItem | null>(null);
  const [requeueItem, setRequeueItem] = useState<PrintQueueItem | null>(null);
  const [showQueueUpload, setShowQueueUpload] = useState(false);
  const [uploadedQueueFile, setUploadedQueueFile] = useState<{ id: number; filename: string } | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    type: 'cancel' | 'remove' | 'stop';
    item: PrintQueueItem;
  } | null>(null);
  const [selectedItems, setSelectedItems] = useState<number[]>([]);
  const [showBulkEditModal, setShowBulkEditModal] = useState(false);
  // #1818: per-printer Resume-after-failure confirm modal. Tracks which
  // printer's gate the user is about to clear; null when no modal is open.
  const [resumeConfirm, setResumeConfirm] = useState<{
    printerId: number;
    printerName: string;
    skippedCount: number;
  } | null>(null);
  const [historySortBy, setHistorySortBy] = useState<'date' | 'name' | 'printer'>(() => {
    const saved = localStorage.getItem('queue.historySortBy');
    return (saved as 'date' | 'name' | 'printer') || 'date';
  });
  const [historySortAsc, setHistorySortAsc] = useState(() => {
    const saved = localStorage.getItem('queue.historySortAsc');
    return saved !== null ? saved === 'true' : false;
  });
  const [historyVisibleCount, setHistoryVisibleCount] = useState(HISTORY_PAGE_SIZE);
  const [pendingSortBy, setPendingSortBy] = useState<'position' | 'name' | 'printer' | 'time'>(() => {
    const saved = localStorage.getItem('queue.pendingSortBy');
    return (saved as 'position' | 'name' | 'printer' | 'time') || 'position';
  });
  const [pendingSortAsc, setPendingSortAsc] = useState(() => {
    const saved = localStorage.getItem('queue.pendingSortAsc');
    return saved !== null ? saved === 'true' : true;
  });
  // historyCollapsed legacy state retained only for localStorage migration; the
  // History tab renders unconditionally so this no longer drives the UI.
  // Tabbed page structure: Active queue stays as the main view; History
  // and Timeline split off. Persists per-user via localStorage.
  const [activeTab, setActiveTab] = useState<'queue' | 'history' | 'timeline'>(() => {
    const search = new URLSearchParams(window.location.search);
    const url = search.get('tab');
    if (url === 'history' || url === 'timeline' || url === 'queue') {
      return url;
    }
    const saved = localStorage.getItem('queue.activeTab');
    if (saved === 'history' || saved === 'timeline') return saved;
    return 'queue';
  });
  // Active-tab layout toggle. "position" = today's flat list; "printer"
  // groups items under per-printer section headers with aggregate stats.
  const [activeLayout, setActiveLayout] = useState<'position' | 'printer'>(() => {
    const saved = localStorage.getItem('queue.activeLayout');
    return saved === 'printer' ? 'printer' : 'position';
  });
  const [activeDragId, setActiveDragId] = useState<number | null>(null);

  // Persist sort settings to localStorage
  useEffect(() => {
    localStorage.setItem('queue.historySortBy', historySortBy);
  }, [historySortBy]);

  useEffect(() => {
    localStorage.setItem('queue.historySortAsc', String(historySortAsc));
  }, [historySortAsc]);

  useEffect(() => {
    setHistoryVisibleCount(HISTORY_PAGE_SIZE);
  }, [historySortBy, historySortAsc, filterLocation]);

  useEffect(() => {
    localStorage.setItem('queue.pendingSortBy', pendingSortBy);
  }, [pendingSortBy]);

  useEffect(() => {
    localStorage.setItem('queue.pendingSortAsc', String(pendingSortAsc));
  }, [pendingSortAsc]);

  useEffect(() => {
    localStorage.setItem('queue.activeTab', activeTab);
  }, [activeTab]);

  useEffect(() => {
    localStorage.setItem('queue.activeLayout', activeLayout);
  }, [activeLayout]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
  });

  const timeFormat: TimeFormat = settings?.time_format || 'system';

  const { data: queue, isLoading } = useQuery({
    queryKey: ['queue', filterPrinter, filterStatus],
    queryFn: () => api.getQueue(filterPrinter || undefined, filterStatus || undefined),
    refetchInterval: 5000,
  });

  const { data: printers } = useQuery({
    queryKey: ['printers'],
    queryFn: () => api.getPrinters(),
  });

  const sjfMutation = useMutation({
    mutationFn: (enabled: boolean) => api.updateSettings({ queue_shortest_first: enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (id: number) => api.cancelQueueItem(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      queryClient.invalidateQueries({ queryKey: ['printerQueueWork'] });
      showToast(t('queue.toast.cancelled'));
    },
    onError: () => showToast(t('queue.toast.cancelFailed'), 'error'),
  });

  const removeMutation = useMutation({
    mutationFn: (id: number) => api.removeFromQueue(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      queryClient.invalidateQueries({ queryKey: ['printerQueueWork'] });
      showToast(t('queue.toast.removed'));
    },
    onError: () => showToast(t('queue.toast.removeFailed'), 'error'),
  });

  const stopMutation = useMutation({
    mutationFn: (id: number) => api.stopQueueItem(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      queryClient.invalidateQueries({ queryKey: ['printerQueueWork'] });
      showToast(t('queue.toast.stopped'));
    },
    onError: () => showToast(t('queue.toast.stopFailed'), 'error'),
  });

  const skipHeatSoakMutation = useMutation({
    mutationFn: (id: number) => api.skipQueueHeatSoak(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      queryClient.invalidateQueries({ queryKey: ['printerQueueWork'] });
      showToast(t('heatSoak.skipped'));
    },
    onError: () => showToast(t('heatSoak.skipFailed'), 'error'),
  });

  // Filament-deficit confirmation state (#1496). When the backend returns
  // 409 with `code=insufficient_filament` we stash the deficit + item id
  // here; the modal at the bottom of the page reads it and the "Print
  // Anyway" path re-issues the start with `skipFilamentCheck=true`.
  const [filamentShortConfirm, setFilamentShortConfirm] = useState<{
    itemId: number;
    deficit: Array<{
      slot_id: number;
      required_grams: number;
      remaining_grams: number | null;
      filament_type?: string | null;
    }>;
  } | null>(null);

  const startMutation = useMutation({
    mutationFn: ({ id, skipFilamentCheck }: { id: number; skipFilamentCheck?: boolean }) =>
      api.startQueueItem(id, { skipFilamentCheck }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      queryClient.invalidateQueries({ queryKey: ['printerQueueWork'] });
      showToast(t('queue.toast.released'));
      setFilamentShortConfirm(null);
    },
    onError: (error: unknown, variables) => {
      if (error instanceof ApiError && error.status === 409 && error.code === 'insufficient_filament') {
        const deficitRaw = (error.detail?.deficit ?? []) as Array<{
          slot_id: number;
          required_grams: number;
          remaining_grams: number | null;
          filament_type?: string | null;
        }>;
        setFilamentShortConfirm({ itemId: variables.id, deficit: deficitRaw });
        return;
      }
      showToast(t('queue.toast.startFailed'), 'error');
    },
  });

  const reorderMutation = useMutation({
    mutationFn: (items: { id: number; position: number }[]) => api.reorderQueue(items),
    // Apply the new order to the cache immediately so the row stays where it
    // was dropped instead of snapping back until the server round-trip and
    // the following refetch complete.
    onMutate: async (items) => {
      // Stop in-flight/polled refetches from overwriting the optimistic state.
      await queryClient.cancelQueries({ queryKey: ['queue'] });
      const previous = queryClient.getQueriesData<PrintQueueItem[]>({ queryKey: ['queue'] });
      const newPositions = new Map(items.map((i) => [i.id, i.position]));
      queryClient.setQueriesData<PrintQueueItem[]>({ queryKey: ['queue'] }, (old) =>
        old?.map((item) =>
          newPositions.has(item.id) ? { ...item, position: newPositions.get(item.id)! } : item,
        ),
      );
      return { previous };
    },
    onError: (_error, _items, context) => {
      context?.previous.forEach(([key, data]) => queryClient.setQueryData(key, data));
      showToast(t('queue.toast.reorderFailed'), 'error');
    },
    // Refetch either way so the cache converges on the server's truth.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      queryClient.invalidateQueries({ queryKey: ['printerQueueWork'] });
    },
  });

  const clearHistoryMutation = useMutation({
    mutationFn: async () => {
      const historyItems = queue?.filter(i =>
        ['completed', 'failed', 'skipped', 'cancelled'].includes(i.status)
      ) || [];
      for (const item of historyItems) {
        await api.removeFromQueue(item.id);
      }
      return historyItems.length;
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      queryClient.invalidateQueries({ queryKey: ['printerQueueWork'] });
      showToast(t('queue.toast.historyCleared', { count }));
    },
    onError: () => showToast(t('queue.toast.clearHistoryFailed'), 'error'),
  });

  const bulkUpdateMutation = useMutation({
    mutationFn: (data: PrintQueueBulkUpdate) => api.bulkUpdateQueue(data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      queryClient.invalidateQueries({ queryKey: ['printerQueueWork'] });
      setSelectedItems([]);
      setShowBulkEditModal(false);
      showToast(result.message);
    },
    onError: () => showToast(t('queue.toast.updateFailed'), 'error'),
  });

  const bulkCancelMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      for (const id of ids) {
        await api.cancelQueueItem(id);
      }
      return ids.length;
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      queryClient.invalidateQueries({ queryKey: ['printerQueueWork'] });
      setSelectedItems([]);
      showToast(t('queue.toast.bulkCancelled', { count }));
    },
    onError: () => showToast(t('queue.toast.bulkCancelFailed'), 'error'),
  });

  const resumeAfterFailureMutation = useMutation({
    mutationFn: (printerId: number) => api.resumeQueueAfterFailure(printerId),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      queryClient.invalidateQueries({ queryKey: ['printerQueueWork'] });
      setResumeConfirm(null);
      showToast(
        t('queue.toast.resumedAfterFailure', {
          restored: result.restored,
          acknowledged: result.acknowledged,
        }),
      );
    },
    onError: () => showToast(t('queue.toast.resumeAfterFailureFailed'), 'error'),
  });

  const handleToggleSelect = (id: number) => {
    setSelectedItems(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  // Get unique locations from printers for the filter dropdown
  const uniqueLocations = useMemo(() => {
    const locations = new Set<string>();
    printers?.forEach(p => {
      if (p.location) locations.add(p.location);
    });
    // Also include locations from queue items (for model-based assignments)
    queue?.forEach(item => {
      if (item.target_location) locations.add(item.target_location);
    });
    return Array.from(locations).sort();
  }, [printers, queue]);

  // Helper to check if a queue item matches the location filter
  const matchesLocationFilter = useCallback((item: PrintQueueItem): boolean => {
    if (!filterLocation) return true;
    // For model-based assignments, check target_location
    if (item.target_location) return item.target_location === filterLocation;
    // For printer-based assignments, check the printer's location
    if (item.printer_id) {
      const printer = printers?.find(p => p.id === item.printer_id);
      return printer?.location === filterLocation;
    }
    return false;
  }, [filterLocation, printers]);

  const pendingItems = useMemo(() => {
    let items = queue?.filter(i => i.status === 'pending') || [];

    // Apply location filter
    if (filterLocation) {
      items = items.filter(matchesLocationFilter);
    }

    // Helper to get scheduled time as timestamp (ASAP = 0 for earliest)
    const getScheduledTime = (item: PrintQueueItem): number => {
      if (!item.scheduled_time) return 0;
      return parseUTCDate(item.scheduled_time)?.getTime() ?? 0;
    };

    // When SJF is enabled, override sort to match scheduler order
    if (settings?.queue_shortest_first) {
      return [...items].sort((a, b) => {
        // Group by printer first (nulls = model-based, grouped by target_model)
        const aPrinter = a.printer_id ?? -(a.target_model?.charCodeAt(0) ?? 0);
        const bPrinter = b.printer_id ?? -(b.target_model?.charCodeAt(0) ?? 0);
        if (aPrinter !== bPrinter) return aPrinter - bPrinter;
        // Within same printer/model: jumped items first (starvation guard)
        const aJumped = a.been_jumped ? 1 : 0;
        const bJumped = b.been_jumped ? 1 : 0;
        if (aJumped !== bJumped) return bJumped - aJumped;
        // Shortest print time next (nulls last)
        const aTime = a.print_time_seconds ?? Infinity;
        const bTime = b.print_time_seconds ?? Infinity;
        if (aTime !== bTime) return aTime - bTime;
        // Position as tiebreaker
        return a.position - b.position;
      });
    }

    return [...items].sort((a, b) => {
      let cmp: number;
      if (pendingSortBy === 'name') {
        const aName = a.archive_name || a.library_file_name || '';
        const bName = b.archive_name || b.library_file_name || '';
        cmp = aName.localeCompare(bName);
      } else if (pendingSortBy === 'printer') {
        cmp = (a.printer_name || '').localeCompare(b.printer_name || '');
      } else if (pendingSortBy === 'time') {
        // Sort by scheduled start time (when print will begin)
        cmp = getScheduledTime(a) - getScheduledTime(b);
      } else {
        cmp = a.position - b.position;
      }
      return pendingSortAsc ? cmp : -cmp;
    });
  }, [queue, pendingSortBy, pendingSortAsc, matchesLocationFilter, filterLocation, settings?.queue_shortest_first]);

  const handleSelectAll = () => {
    const allPendingIds = pendingItems.map(i => i.id);
    if (selectedItems.length === allPendingIds.length) {
      setSelectedItems([]);
    } else {
      setSelectedItems(allPendingIds);
    }
  };

  const activeItems = useMemo(() => {
    let items = queue?.filter(i => i.status === 'preheating' || i.status === 'dispatching' || i.status === 'printing') || [];
    if (filterLocation) {
      items = items.filter(matchesLocationFilter);
    }
    return items;
  }, [queue, filterLocation, matchesLocationFilter]);
  const dispatchingItems = useMemo(
    () => activeItems.filter((item) => item.status === 'dispatching'),
    [activeItems],
  );
  const printingCount = activeItems.length - dispatchingItems.length;

  // Get unique printer IDs from active items to fetch their statuses
  const activePrinterIds = useMemo(() => {
    const ids = new Set<number>();
    activeItems.forEach(item => {
      if (item.printer_id) ids.add(item.printer_id);
    });
    return Array.from(ids);
  }, [activeItems]);

  // Fetch printer statuses for printers with active jobs
  const printerStatusQueries = useQueries({
    queries: activePrinterIds.map(printerId => ({
      queryKey: ['printerStatus', printerId],
      queryFn: () => api.getPrinterStatus(printerId),
      refetchInterval: 5000,
    })),
  });

  // Build a map of printer_id -> state for quick lookup
  const printerStateMap = useMemo(() => {
    const map: Record<number, string | null> = {};
    activePrinterIds.forEach((printerId, index) => {
      const result = printerStatusQueries[index];
      if (result?.data?.state) {
        map[printerId] = result.data.state;
      }
    });
    return map;
  }, [activePrinterIds, printerStatusQueries]);

  // Build a map of printer_id -> full status for timeline view
  const printerStatusMap = useMemo(() => {
    const map: Record<number, { progress?: number; remaining_time?: number; state?: string }> = {};
    activePrinterIds.forEach((printerId, index) => {
      const result = printerStatusQueries[index];
      if (result?.data) {
        map[printerId] = {
          progress: result.data.progress ?? undefined,
          remaining_time: result.data.remaining_time ?? undefined,
          state: result.data.state ?? undefined,
        };
      }
    });
    return map;
  }, [activePrinterIds, printerStatusQueries]);

  const historyItems = useMemo(() => {
    let items = queue?.filter(i => ['completed', 'failed', 'skipped', 'cancelled'].includes(i.status)) || [];
    if (filterLocation) {
      items = items.filter(matchesLocationFilter);
    }
    return [...items].sort((a, b) => {
      let cmp: number;
      if (historySortBy === 'name') {
        const aName = a.archive_name || a.library_file_name || '';
        const bName = b.archive_name || b.library_file_name || '';
        cmp = aName.localeCompare(bName);
      } else if (historySortBy === 'printer') {
        cmp = (a.printer_name || '').localeCompare(b.printer_name || '');
      } else {
        // Default: by date - most recent first (desc) is the natural order
        cmp = (parseUTCDate(b.completed_at || b.created_at)?.getTime() ?? 0) - (parseUTCDate(a.completed_at || a.created_at)?.getTime() ?? 0);
      }
      return historySortAsc ? -cmp : cmp;
    });
  }, [queue, historySortBy, historySortAsc, matchesLocationFilter, filterLocation]);

  // Calculate total queue time
  const totalQueueTime = useMemo(() => {
    return [...pendingItems, ...dispatchingItems].reduce(
      (acc, item) => acc + (item.print_time_seconds || 0),
      0,
    );
  }, [pendingItems, dispatchingItems]);

  // Calculate total material weight
  const totalWeight = useMemo(() => {
    return [...pendingItems, ...dispatchingItems].reduce(
      (acc, item) => acc + (item.filament_used_grams || 0),
      0,
    );
  }, [pendingItems, dispatchingItems]);

  const handleDragStart = (event: DragStartEvent) => {
    const id = event.active.id;
    setActiveDragId(typeof id === 'number' ? id : null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragId(null);
    if (!over || active.id === over.id) return;

    // Resolve dragged source → movingIds (preserving order from pendingItems).
    // A quantity submission is represented by ordinary rows, so each row is
    // independently reorderable; selected rows still move as one block.
    const activeId = active.id;
    const draggedId = activeId as number;
    const movingIds = selectedItems.includes(draggedId) && selectedItems.length > 1
      ? selectedItems.slice().sort((a, b) => {
          const ai = pendingItems.findIndex((i) => i.id === a);
          const bi = pendingItems.findIndex((i) => i.id === b);
          return ai - bi;
        })
      : [draggedId];
    if (movingIds.length === 0) return;

    // Resolve drop target → index inside pendingItems.
    const overId = over.id;
    const overIndex = pendingItems.findIndex((i) => i.id === overId);
    if (overIndex === -1) return;

    // Remove the moving items, then re-insert at overIndex (adjusted).
    const overAnchor = pendingItems[overIndex];
    const remaining = pendingItems.filter((i) => !movingIds.includes(i.id));
    let insertAt = remaining.findIndex((i) => i.id === overAnchor.id);
    if (insertAt === -1) insertAt = overIndex;
    // If dragging downward across the drop target, insert AFTER it; upward
    // = before. dnd-kit's `over` is the row under the pointer, not the gap.
    const firstMovingIndex = pendingItems.findIndex((i) => i.id === movingIds[0]);
    if (firstMovingIndex < overIndex) insertAt += 1;
    const reordered = [
      ...remaining.slice(0, insertAt),
      ...movingIds
        .map((id) => pendingItems.find((i) => i.id === id))
        .filter((x): x is PrintQueueItem => !!x),
      ...remaining.slice(insertAt),
    ];

    if (movingIds.includes(overAnchor.id)) return;
    submitReorder(reordered, movingIds, overAnchor.id, firstMovingIndex < overIndex);
  };

  // Every pending row is rendered independently.
  const groupedRows = useMemo<QueueRow[]>(() => {
    return pendingItems.map((item) => ({ kind: 'item', item }));
  }, [pendingItems]);

  const canReorderManually =
    hasPermission('queue:reorder') &&
    hasAnyPermission('queue:update_own', 'queue:update_all') &&
    pendingSortBy === 'position' &&
    !settings?.queue_shortest_first;

  const rowCanMove = (row: QueueRow | undefined): row is QueueRow =>
    !!row &&
    row.item.status === 'pending' &&
    canModify('queue', 'update', row.item.created_by_id);

  const rowsSharePrinter = (left: QueueRow, right: QueueRow): boolean =>
    left.item.printer_id === right.item.printer_id;

  const submitReorder = (
    reordered: PrintQueueItem[],
    movingIds: number[],
    anchorId: number,
    placeAfter: boolean,
  ) => {
    if (!canReorderManually) return;

    if (hasPermission('queue:update_all')) {
      reorderMutation.mutate(reordered.map((item, index) => ({ id: item.id, position: index + 1 })));
      return;
    }

    const movingItems = movingIds
      .map((id) => pendingItems.find((item) => item.id === id))
      .filter((item): item is PrintQueueItem => !!item);
    const anchor = pendingItems.find((item) => item.id === anchorId);
    if (
      !anchor ||
      movingItems.length !== movingIds.length ||
      !canModify('queue', 'update', anchor.created_by_id) ||
      !movingItems.every((item) => canModify('queue', 'update', item.created_by_id)) ||
      !movingItems.every((item) => item.printer_id === anchor.printer_id)
    ) return;

    const queueItems = pendingItems.filter((item) => item.printer_id === anchor.printer_id);
    const remaining = queueItems.filter((item) => !movingIds.includes(item.id));
    let insertAt = remaining.findIndex((item) => item.id === anchorId);
    if (insertAt === -1) return;
    if (placeAfter) insertAt += 1;
    const scopedReordered = [
      ...remaining.slice(0, insertAt),
      ...movingItems,
      ...remaining.slice(insertAt),
    ];
    const currentPositions = new Map(queueItems.map((item) => [item.id, item.position]));
    const updates = scopedReordered
      .map((item, index) => ({
        id: item.id,
        position: currentPositions.get(queueItems[index].id)!,
      }))
      .filter((update) => update.position !== currentPositions.get(update.id));
    if (updates.length > 0) reorderMutation.mutate(updates);
  };

  const moveRowRelativeTo = (movingId: number, anchorId: number, placeAfter: boolean) => {
    if (!canReorderManually || movingId === anchorId) return;
    const movingItem = pendingItems.find((item) => item.id === movingId);
    if (!movingItem || !canModify('queue', 'update', movingItem.created_by_id)) return;

    const remaining = pendingItems.filter((item) => item.id !== movingId);
    let insertAt = remaining.findIndex((item) => item.id === anchorId);
    if (insertAt === -1) return;
    if (placeAfter) insertAt += 1;
    const reordered = [
      ...remaining.slice(0, insertAt),
      movingItem,
      ...remaining.slice(insertAt),
    ];
    submitReorder(reordered, [movingId], anchorId, placeAfter);
  };

  const rowMovers = (rows: QueueRow[], index: number) => {
    if (!canReorderManually || !rowCanMove(rows[index])) return {};
    return {
      onMoveUp: index > 0 && rowCanMove(rows[index - 1]) &&
        (hasPermission('queue:update_all') || rowsSharePrinter(rows[index], rows[index - 1]))
        ? () => moveRowRelativeTo(rows[index].item.id, rows[index - 1].item.id, false)
        : undefined,
      onMoveDown: index < rows.length - 1 && rowCanMove(rows[index + 1]) &&
        (hasPermission('queue:update_all') || rowsSharePrinter(rows[index], rows[index + 1]))
        ? () => moveRowRelativeTo(rows[index].item.id, rows[index + 1].item.id, true)
        : undefined,
    };
  };

  // SortableContext ID list.
  const sortableIds = useMemo<number[]>(() => pendingItems.map((item) => item.id), [pendingItems]);

  // Group by printer view. Items are bucketed by printer_id (null = model
  // assignment or unassigned, keyed by target_model or "unassigned").
  type PrinterBucket = {
    key: string;
    printerId: number | null;
    targetModel: string | null;
    label: string;
    isUnassigned: boolean;
    rows: QueueRow[];
  };

  const printerBuckets = useMemo<PrinterBucket[]>(() => {
    const buckets = new Map<string, PrinterBucket>();
    const bucketForItem = (item: PrintQueueItem): { key: string; label: string; printerId: number | null; targetModel: string | null; isUnassigned: boolean } => {
      if (item.printer_id) {
        return {
          key: `printer:${item.printer_id}`,
          label: item.printer_name || `Printer #${item.printer_id}`,
          printerId: item.printer_id,
          targetModel: null,
          isUnassigned: false,
        };
      }
      // A cross-model item (#671) is waiting on several models. Its own
      // target_model is just the first candidate mirrored onto the row, so
      // bucketing on it would file the job under one printer it might never
      // run on — and the row underneath already says "Any H2D / X1C".
      if ((item.variants?.length ?? 0) > 1) {
        const models = item.variants!.map((v) => v.target_model).join(' / ');
        return {
          key: `models:${models}`,
          label: `${t('queue.filter.any')} ${models}`,
          printerId: null,
          targetModel: null,
          isUnassigned: false,
        };
      }
      if (item.target_model) {
        return {
          key: `model:${item.target_model}`,
          label: `${t('queue.filter.any')} ${item.target_model}`,
          printerId: null,
          targetModel: item.target_model,
          isUnassigned: false,
        };
      }
      return {
        key: 'unassigned',
        label: t('queue.filter.unassigned'),
        printerId: null,
        targetModel: null,
        isUnassigned: true,
      };
    };

    for (const row of groupedRows) {
      const meta = bucketForItem(row.item);
      if (!buckets.has(meta.key)) {
        buckets.set(meta.key, { ...meta, rows: [] });
      }
      buckets.get(meta.key)!.rows.push(row);
    }
    return Array.from(buckets.values()).sort((a, b) => {
      if (a.isUnassigned && !b.isUnassigned) return 1;
      if (!a.isUnassigned && b.isUnassigned) return -1;
      return a.label.localeCompare(b.label);
    });
  }, [groupedRows, t]);

  // #1818: printers whose queue is gated by a prior failure that's poisoning
  // downstream `require_previous_success` items. We surface a per-printer
  // Resume banner above the active queue so the user can clear the gate +
  // restore the skipped jobs in one click, without re-queuing each one.
  // Detection key: skipped + the scheduler's exact gate string. Other skip
  // reasons (filament deficit, etc.) get their own UX and stay untouched.
  const gateBlockedPrinters = useMemo<
    Array<{ printerId: number; printerName: string; skippedCount: number }>
  >(() => {
    const counts = new Map<number, { name: string; count: number }>();
    queue?.forEach((item) => {
      if (
        item.status === 'skipped' &&
        item.error_message === 'Previous print failed or was aborted' &&
        item.printer_id
      ) {
        const existing = counts.get(item.printer_id);
        if (existing) {
          existing.count += 1;
        } else {
          counts.set(item.printer_id, {
            name: item.printer_name || `Printer #${item.printer_id}`,
            count: 1,
          });
        }
      }
    });
    return Array.from(counts.entries())
      .map(([printerId, { name, count }]) => ({
        printerId,
        printerName: name,
        skippedCount: count,
      }))
      .sort((a, b) => a.printerName.localeCompare(b.printerName));
  }, [queue]);

  const aggregateForRows = (rows: QueueRow[]) => {
    let count = 0;
    let time = 0;
    let weight = 0;
    for (const row of rows) {
      count += 1;
      time += row.item.print_time_seconds || 0;
      weight += row.item.filament_used_grams || 0;
    }
    return { count, time, weight };
  };

  return (
    <div className="p-4 md:p-8">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white flex items-center gap-3">
          <ListOrdered className="w-7 h-7 text-bambu-green" />
          {t('queue.title')}
        </h1>
        <p className="text-bambu-gray mt-1">{t('queue.subtitle')}</p>
      </div>

      {/* Tab strip — Active queue is the main view; History and Timeline
          live in their own tabs so the queue page stays focused. */}
      <div className="flex gap-1 border-b border-bambu-dark-tertiary mb-6 overflow-x-auto">
        {([
          { id: 'queue' as const, label: t('queue.tabs.queue'), icon: Clock, count: pendingItems.length + activeItems.length },
          { id: 'history' as const, label: t('queue.tabs.history'), icon: ListOrdered, count: historyItems.length },
          { id: 'timeline' as const, label: t('queue.tabs.timeline'), icon: GanttChart, count: null as number | null },
        ]).map(({ id, label, icon: Icon, count }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`px-4 py-2.5 text-sm flex items-center gap-2 border-b-2 -mb-px transition-colors whitespace-nowrap ${
              activeTab === id
                ? 'text-white border-bambu-green font-medium'
                : 'text-bambu-gray border-transparent hover:text-white'
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
            {count !== null && count > 0 && (
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                activeTab === id ? 'bg-bambu-green/20 text-bambu-green' : 'bg-bambu-dark-tertiary text-bambu-gray'
              }`}>
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Summary Stats — about the print queue. */}
      <QueueStatsBar
        printingCount={printingCount}
        queuedCount={pendingItems.length + dispatchingItems.length}
        totalTime={totalQueueTime}
        totalWeight={totalWeight}
        historyCount={historyItems.length}
        t={t}
        action={(
          <Button
            onClick={() => setShowQueueUpload(true)}
            disabled={!hasPermission('queue:create') || !hasPermission('library:upload')}
            title={
              !hasPermission('library:upload')
                ? t('fileManager.noPermissionUpload')
                : !hasPermission('queue:create')
                  ? t('fileManager.noPermissionAddToQueue')
                  : undefined
            }
            size="sm"
            className="shrink-0"
          >
            <Plus className="w-4 h-4" />
            {t('queue.actions.addJob')}
          </Button>
        )}
      />

      {/* #1818: Resume-after-failure banner. One row per printer whose queue
          is gated by a prior failed/aborted print. Visible regardless of
          tab/layout so the user can clear the gate without hunting for
          skipped items. Hidden entirely when no gates are active. */}
      {activeTab === 'queue' && gateBlockedPrinters.length > 0 && hasPermission('queue:update_all' as Permission) && (
        <div className="mb-4 space-y-2">
          {gateBlockedPrinters.map(({ printerId, printerName, skippedCount }) => (
            <div
              key={printerId}
              className="flex items-center gap-3 px-4 py-3 bg-orange-500/10 border border-orange-500/30 rounded-lg"
            >
              <AlertCircle className="w-5 h-5 text-orange-400 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-orange-200">
                  {t('queue.resumeAfterFailure.banner', {
                    printer: printerName,
                    count: skippedCount,
                  })}
                </div>
                <div className="text-xs text-orange-200/70 mt-0.5">
                  {t('queue.resumeAfterFailure.bannerHint')}
                </div>
              </div>
              <button
                onClick={() =>
                  setResumeConfirm({ printerId, printerName, skippedCount })
                }
                className="flex items-center gap-1.5 px-3 py-1.5 bg-orange-500/20 hover:bg-orange-500/30 text-orange-100 text-sm rounded-md border border-orange-500/40 transition-colors flex-shrink-0"
              >
                <PlayCircle className="w-4 h-4" />
                {t('queue.resumeAfterFailure.button')}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Single toolbar line. Filters apply to every tab; the layout, sort,
          SJF and selection controls only apply to the Queue tab. */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <ToolbarDropdown
          value={filterPrinter === -1 ? 'unassigned' : filterPrinter ? String(filterPrinter) : 'all'}
          onChange={(val) => {
            if (val === 'unassigned') setFilterPrinter(-1);
            else if (val === 'all') setFilterPrinter(null);
            else setFilterPrinter(Number(val));
          }}
          minWidthClass="min-w-36"
          options={[
            { value: 'all', label: t('queue.filter.allPrinters') },
            { value: 'unassigned', label: t('queue.filter.unassigned') },
            ...(printers?.map((p) => ({ value: String(p.id), label: p.name })) ?? []),
          ]}
        />

        <ToolbarDropdown
          value={filterStatus}
          onChange={setFilterStatus}
          minWidthClass="min-w-32"
          options={[
            { value: '', label: t('queue.filter.allStatus') },
            { value: 'pending', label: t('queue.status.pending') },
            { value: 'preheating', label: t('heatSoak.status') },
            { value: 'dispatching', label: t('queue.status.dispatching') },
            { value: 'printing', label: t('queue.status.printing') },
            { value: 'completed', label: t('queue.status.completed') },
            { value: 'failed', label: t('queue.status.failed') },
            { value: 'skipped', label: t('queue.status.skipped') },
            { value: 'cancelled', label: t('queue.status.cancelled') },
          ]}
        />

        {uniqueLocations.length > 0 && (
          <ToolbarDropdown
            value={filterLocation}
            onChange={setFilterLocation}
            minWidthClass="min-w-36"
            options={[
              { value: '', label: t('queue.filter.allLocations') },
              ...uniqueLocations.map((loc) => ({ value: loc, label: loc })),
            ]}
          />
        )}

        {activeTab === 'queue' && (
          <>
            <div className="hidden sm:block h-5 w-px bg-bambu-dark-tertiary mx-1" aria-hidden="true" />

            {/* Layout toggle — same segmented control as the Inventory page. */}
            <div className="flex h-8 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg overflow-hidden">
              <button
                type="button"
                aria-pressed={activeLayout === 'position'}
                className={`flex items-center gap-1.5 px-3 text-sm font-medium transition-colors ${
                  activeLayout === 'position' ? 'bg-bambu-green text-white' : 'text-bambu-gray hover:bg-bambu-dark-tertiary'
                }`}
                onClick={() => setActiveLayout('position')}
                title={t('queue.layout.flatList')}
              >
                <List className="w-4 h-4" />
                <span className="hidden sm:inline">{t('queue.layout.flatList')}</span>
              </button>
              <button
                type="button"
                aria-pressed={activeLayout === 'printer'}
                className={`flex items-center gap-1.5 px-3 text-sm font-medium transition-colors ${
                  activeLayout === 'printer' ? 'bg-bambu-green text-white' : 'text-bambu-gray hover:bg-bambu-dark-tertiary'
                }`}
                onClick={() => setActiveLayout('printer')}
                title={t('queue.layout.groupByPrinter')}
              >
                <Printer className="w-4 h-4" />
                <span className="hidden sm:inline">{t('queue.layout.byPrinter')}</span>
              </button>
            </div>

            {pendingItems.length > 0 && (
              <>
                <ToolbarDropdown
                  value={pendingSortBy}
                  onChange={(value) => setPendingSortBy(value as 'position' | 'name' | 'printer' | 'time')}
                  minWidthClass="min-w-36"
                  options={[
                    { value: 'position', label: t('queue.sort.byPosition') },
                    { value: 'name', label: t('queue.sort.byName') },
                    { value: 'printer', label: t('queue.sort.byPrinter') },
                    { value: 'time', label: t('queue.sort.bySchedule') },
                  ]}
                />
                <button
                  type="button"
                  onClick={() => setPendingSortAsc(!pendingSortAsc)}
                  title={pendingSortAsc ? t('common.ascending') : t('common.descending')}
                  aria-label={pendingSortAsc ? t('common.ascending') : t('common.descending')}
                  className={toolbarIconButtonClass}
                >
                  {pendingSortAsc ? <ArrowUp className="w-4 h-4" /> : <ArrowDown className="w-4 h-4" />}
                </button>
              </>
            )}

            <button
              onClick={() => {
                const newValue = !(settings?.queue_shortest_first ?? false);
                sjfMutation.mutate(newValue);
              }}
              className={`h-8 flex items-center gap-1 px-2 text-xs rounded-lg border transition-colors ${
                settings?.queue_shortest_first
                  ? 'bg-bambu-green/20 border-bambu-green text-bambu-green'
                  : 'bg-bambu-dark-secondary border-bambu-dark-tertiary text-bambu-gray hover:text-white hover:border-bambu-gray'
              }`}
              title={t('queue.sjf.tooltip', 'Shortest Job First — scheduler prioritizes shorter prints')}
            >
              <Snail className="w-4 h-4" />
              <span className="hidden sm:inline">{t('queue.sjf.label', 'SJF')}</span>
              <span className={`w-1.5 h-1.5 rounded-full ${settings?.queue_shortest_first ? 'bg-bambu-green' : 'bg-bambu-gray'}`} />
            </button>
          </>
        )}

        {activeTab === 'queue' && pendingItems.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 ml-auto">
            {selectedItems.length > 0 && (
              <>
                <span className="text-xs sm:text-sm text-bambu-gray">
                  {t('queue.bulkEdit.selected', { count: selectedItems.length })}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowBulkEditModal(true)}
                  className="flex items-center gap-1.5 text-xs sm:text-sm text-bambu-green hover:text-bambu-green-light"
                  disabled={!hasAnyPermission('queue:update_own', 'queue:update_all')}
                  title={!hasAnyPermission('queue:update_own', 'queue:update_all') ? t('queue.permissions.noEditItems') : t('queue.bulkEdit.editSelected')}
                  aria-label={t('queue.bulkEdit.editSelected')}
                >
                  <Pencil className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                  <span className="hidden 2xl:inline">{t('queue.bulkEdit.editSelected')}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => bulkCancelMutation.mutate(selectedItems)}
                  className="flex items-center gap-1.5 text-xs sm:text-sm text-red-400 hover:text-red-300"
                  disabled={bulkCancelMutation.isPending || !hasAnyPermission('queue:delete_own', 'queue:delete_all')}
                  title={!hasAnyPermission('queue:delete_own', 'queue:delete_all') ? t('queue.permissions.noCancelItems') : t('queue.bulkEdit.cancelSelected')}
                  aria-label={t('queue.bulkEdit.cancelSelected')}
                >
                  <X className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                  <span className="hidden 2xl:inline">{t('queue.bulkEdit.cancelSelected')}</span>
                </Button>
              </>
            )}
            <button
              type="button"
              onClick={handleSelectAll}
              className={`${toolbarControlClass} flex items-center gap-2`}
            >
              {selectedItems.length === pendingItems.length ? (
                <CheckSquare className="w-4 h-4 text-bambu-green" />
              ) : (
                <Square className="w-4 h-4 text-bambu-gray" />
              )}
              {selectedItems.length === pendingItems.length ? t('queue.bulkEdit.deselectAll') : t('queue.bulkEdit.selectAll')}
            </button>
          </div>
        )}

        {activeTab === 'history' && historyItems.length > 0 && (
          <Button
            className="w-full sm:w-auto sm:ml-auto"
            variant="secondary"
            size="sm"
            onClick={() => setShowClearHistoryConfirm(true)}
            disabled={!hasPermission('queue:delete_all')}
            title={!hasPermission('queue:delete_all') ? t('queue.permissions.noClearHistory') : undefined}
          >
            <Trash2 className="w-4 h-4" />
            {t('queue.clearHistory')}
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-bambu-gray">{t('common.loading')}</div>
      ) : queue?.length === 0 ? (
        <div className="py-16 text-center">
          <Calendar className="w-14 h-14 text-bambu-gray mx-auto mb-4 opacity-40" />
          <h3 className="text-lg font-medium text-white mb-2">{t('queue.empty.title')}</h3>
          <p className="text-bambu-gray max-w-md mx-auto">
            {t('queue.empty.description')}
          </p>
        </div>
      ) : activeTab === 'timeline' ? (
        <QueueTimelineView
          queueItems={queue || []}
          printers={printers || []}
          printerStatuses={printerStatusMap}
          onItemClick={(item) => {
            if (['completed', 'failed', 'skipped', 'cancelled'].includes(item.status)) {
              setRequeueItem(item);
            } else if (item.status === 'pending') {
              setEditItem(item);
            } else if (item.status === 'preheating' || item.status === 'dispatching' || item.status === 'printing') {
              setConfirmAction({ type: 'stop', item });
            }
          }}
          t={t}
        />
      ) : activeTab === 'history' ? (
        <HistorySection
          items={historyItems}
          visibleCount={historyVisibleCount}
          onShowMore={() => setHistoryVisibleCount((count) => Math.min(count + HISTORY_PAGE_SIZE, historyItems.length))}
          collapsed={false}
          sortBy={historySortBy}
          sortAsc={historySortAsc}
          onSortByChange={setHistorySortBy}
          onSortAscToggle={() => setHistorySortAsc(!historySortAsc)}
          onRemove={(item) => setConfirmAction({ type: 'remove', item })}
          onRequeue={setRequeueItem}
          timeFormat={timeFormat}
          hasPermission={hasPermission}
          canModify={canModify}
          t={t}
        />
      ) : (
        <div className="space-y-2 sm:space-y-3">
          {/* Active prints: no heading, the card status gutter says what they are. */}
          {activeItems.length > 0 && (
            <div>
              <div className="space-y-2 sm:space-y-3">
                {activeItems.map((item) => (
                  <SortableQueueItem
                    key={item.id}
                    item={item}
                    onEdit={() => {}}
                    onCancel={() => {}}
                    onStop={() => setConfirmAction({ type: 'stop', item })}
                    onSkipHeatSoak={() => skipHeatSoakMutation.mutate(item.id)}
                    isSkippingHeatSoak={skipHeatSoakMutation.isPending}
                    onStart={() => {}}
                    timeFormat={timeFormat}
                    hasPermission={hasPermission}
                    canModify={canModify}
                    printerState={item.printer_id ? printerStateMap[item.printer_id] : null}
                    t={t}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Pending Queue */}
          {pendingItems.length > 0 && (
            <div>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={sortableIds}
                  strategy={verticalListSortingStrategy}
                >
                  {activeLayout === 'position' ? (
                    <div className="space-y-2 sm:space-y-3">
                      {groupedRows.map((row, index) => (
                        <QueueRowRender
                          key={`item-${row.item.id}`}
                          row={row}
                          setEditItem={setEditItem}
                          setConfirmAction={setConfirmAction}
                          startMutation={startMutation}
                          selectedItems={selectedItems}
                          handleToggleSelect={handleToggleSelect}
                          timeFormat={timeFormat}
                          hasPermission={hasPermission}
                          canModify={canModify}
                          t={t}
                          {...rowMovers(groupedRows, index)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {printerBuckets.map((bucket) => {
                        const agg = aggregateForRows(bucket.rows);
                        return (
                          <div key={bucket.key}>
                            <div className="flex items-center gap-3 px-3 py-2 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-t-lg">
                              <Printer className={`w-4 h-4 ${bucket.isUnassigned ? 'text-orange-400' : bucket.targetModel ? 'text-blue-400' : 'text-bambu-green'}`} />
                              <span className="font-semibold text-white text-sm">{bucket.label}</span>
                              <span className="text-xs text-bambu-gray flex flex-wrap gap-x-3">
                                <span>{t('queue.itemCount', { count: agg.count })}</span>
                                {agg.time > 0 && <span>{formatDuration(agg.time)}</span>}
                                {agg.weight > 0 && <span>{formatWeight(agg.weight)}</span>}
                              </span>
                            </div>
                            <div className="bg-bambu-dark/40 border border-t-0 border-bambu-dark-tertiary rounded-b-lg p-2 space-y-2">
                              {bucket.rows.map((row, index) => (
                                <QueueRowRender
                                  key={`item-${row.item.id}`}
                                  row={row}
                                  setEditItem={setEditItem}
                                  setConfirmAction={setConfirmAction}
                                  startMutation={startMutation}
                                  selectedItems={selectedItems}
                                  handleToggleSelect={handleToggleSelect}
                                  timeFormat={timeFormat}
                                  hasPermission={hasPermission}
                                  canModify={canModify}
                                  t={t}
                                  {...rowMovers(bucket.rows, index)}
                                />
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </SortableContext>
                <DragOverlay>
                  {(() => {
                    if (activeDragId === null) return null;
                    // Multi-row drag — show the N-item ghost.
                    if (typeof activeDragId === 'number' && selectedItems.includes(activeDragId) && selectedItems.length > 1) {
                      return (
                        <div className="flex items-center gap-3 px-3 py-2 bg-bambu-dark-secondary border-2 border-cyan-400 rounded-lg shadow-2xl">
                          <Package className="w-4 h-4 text-cyan-300" />
                          <span className="text-sm text-white font-medium">
                            {t('queue.dragGhost.multiCount', { count: selectedItems.length })}
                          </span>
                        </div>
                      );
                    }
                    return null;
                  })()}
                </DragOverlay>
              </DndContext>
            </div>
          )}
        </div>
      )}

      {/* Add Job: upload a sliced file, then configure it in the print modal. */}
      {showQueueUpload && (
        <DirectPrintUploadModal
          onClose={() => setShowQueueUpload(false)}
          onFileUploaded={(uploadedFile) => {
            setShowQueueUpload(false);
            setUploadedQueueFile({ id: uploadedFile.id, filename: uploadedFile.filename });
          }}
        />
      )}

      {uploadedQueueFile && (
        <PrintModal
          mode="create"
          libraryFileId={uploadedQueueFile.id}
          archiveName={uploadedQueueFile.filename}
          onClose={() => setUploadedQueueFile(null)}
          onSuccess={() => setUploadedQueueFile(null)}
        />
      )}

      {/* Edit Modal */}
      {editItem && (
        <PrintModal
          mode="edit-queue-item"
          archiveId={editItem.archive_id ?? undefined}
          libraryFileId={editItem.library_file_id ?? undefined}
          archiveName={queueItemDisplayName(editItem, (n) => t('common.plusNMore', { count: n }))}
          queueItem={editItem}
          onClose={() => setEditItem(null)}
        />
      )}

      {/* Re-queue Modal */}
      {requeueItem && (
        <PrintModal
          mode="create"
          archiveId={requeueItem.archive_id ?? undefined}
          libraryFileId={requeueItem.library_file_id ?? undefined}
          archiveName={queueItemDisplayName(requeueItem, (n) => t('common.plusNMore', { count: n }))}
          onClose={() => setRequeueItem(null)}
        />
      )}

      {/* Confirm Action Modal */}
      {filamentShortConfirm && (
        <ConfirmModal
          title={t('queue.filamentShort.confirmTitle')}
          message={
            t('queue.filamentShort.confirmIntro') + '\n\n' +
            filamentShortConfirm.deficit
              .map((d) =>
                t('queue.filamentShort.lineItem', {
                  slot: d.slot_id,
                  required: Math.round(d.required_grams),
                  remaining:
                    d.remaining_grams == null
                      ? t('queue.filamentShort.unknown')
                      : Math.round(d.remaining_grams),
                }),
              )
              .join('\n')
          }
          confirmText={t('queue.filamentShort.printAnyway')}
          variant="warning"
          onConfirm={() => {
            startMutation.mutate({ id: filamentShortConfirm.itemId, skipFilamentCheck: true });
          }}
          onCancel={() => setFilamentShortConfirm(null)}
        />
      )}

      {confirmAction && (
        <ConfirmModal
          title={
            confirmAction.type === 'cancel' ? t('queue.confirm.cancelTitle') :
            confirmAction.type === 'stop' ? t('queue.confirm.stopTitle') :
            t('queue.confirm.removeTitle')
          }
          message={
            confirmAction.type === 'cancel'
              ? t('queue.confirm.cancelMessage', { name: confirmAction.item.archive_name || confirmAction.item.library_file_name || t('queue.confirm.thisPrint') })
              : confirmAction.type === 'stop'
              ? t('queue.confirm.stopMessage', { name: confirmAction.item.archive_name || confirmAction.item.library_file_name || t('queue.confirm.thisPrint') })
              : t('queue.confirm.removeMessage', { name: confirmAction.item.archive_name || confirmAction.item.library_file_name || t('queue.confirm.thisItem') })
          }
          confirmText={
            confirmAction.type === 'cancel' ? t('queue.confirm.cancelButton') :
            confirmAction.type === 'stop' ? t('queue.confirm.stopButton') :
            t('common.remove')
          }
          variant="danger"
          onConfirm={() => {
            if (confirmAction.type === 'cancel') {
              cancelMutation.mutate(confirmAction.item.id);
            } else if (confirmAction.type === 'stop') {
              stopMutation.mutate(confirmAction.item.id);
            } else {
              removeMutation.mutate(confirmAction.item.id);
            }
            setConfirmAction(null);
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}

      {/* #1818: Resume-after-failure confirm */}
      {resumeConfirm && (
        <ConfirmModal
          title={t('queue.resumeAfterFailure.confirmTitle')}
          message={t('queue.resumeAfterFailure.confirmMessage', {
            printer: resumeConfirm.printerName,
            count: resumeConfirm.skippedCount,
          })}
          confirmText={t('queue.resumeAfterFailure.button')}
          variant="warning"
          onConfirm={() => resumeAfterFailureMutation.mutate(resumeConfirm.printerId)}
          onCancel={() => setResumeConfirm(null)}
        />
      )}

      {/* Clear History Confirm Modal */}
      {showClearHistoryConfirm && (
        <ConfirmModal
          title={t('queue.confirm.clearHistoryTitle')}
          message={t('queue.confirm.clearHistoryMessage', { count: historyItems.length })}
          confirmText={t('queue.clearHistory')}
          variant="danger"
          onConfirm={() => {
            clearHistoryMutation.mutate();
            setShowClearHistoryConfirm(false);
          }}
          onCancel={() => setShowClearHistoryConfirm(false)}
        />
      )}

      {/* Bulk Edit Modal */}
      {showBulkEditModal && (
        <BulkEditModal
          selectedCount={selectedItems.length}
          printers={printers?.map(p => ({ id: p.id, name: p.name, nozzle_count: p.nozzle_count })) || []}
          onSave={(data) => {
            if (Object.keys(data).length > 0) {
              bulkUpdateMutation.mutate({ item_ids: selectedItems, ...data });
            }
          }}
          onClose={() => setShowBulkEditModal(false)}
          isSaving={bulkUpdateMutation.isPending}
          canControlPrinter={hasPermission('printers:control')}
          t={t}
        />
      )}

    </div>
  );
}

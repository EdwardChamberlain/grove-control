import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { formatPrintName } from '../utils/printName';
import { computePopoverPosition } from '../utils/popoverPosition';
import {
  BED_TEMP_DEFAULTS,
  CHAMBER_TEMP_DEFAULTS,
  FAN_SPEED_DEFAULTS,
  NOZZLE_TEMP_DEFAULTS,
  parsePresetTriple,
} from '../utils/temperatureFanPresets';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../contexts/ThemeContext';
import { useAuth } from '../contexts/AuthContext';
import {
  Plus,
  Link,
  Unlink,
  Signal,
  Clock,
  Timer,
  MoreVertical,
  Trash2,
  RefreshCw,
  RotateCw,
  Box,
  HardDrive,
  AlertTriangle,
  Terminal,
  Power,
  Wrench,
  ChevronDown,
  Filter,
  Pencil,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  Layers,
  Video,
  Search,
  Loader2,
  Square,
  Pause,
  Play,
  X,
  Download,
  CheckCircle,
  CheckSquare,
  User,
  Home,
  Printer as PrinterIcon,
  Info,
  Cable,
  Repeat,
  Gauge,
  DoorOpen,
  DoorClosed,
  Move,
  MoreHorizontal,
  SlidersHorizontal,
  Stethoscope,
  Activity,
  MonitorPlay,
  List,
  BarChart3,
  Package,
} from 'lucide-react';

import { useNavigate } from 'react-router-dom';
import { api, discoveryApi, firmwareApi, getAuthToken, withStreamToken, ApiError } from '../api/client';
import { formatDateOnly, formatETA, formatDuration } from '../utils/date';
import { getCurrencySymbol } from '../utils/currency';
import type { Printer, PrinterCreate, PrinterStatus, AMSUnit, DiscoveredPrinter, LinkedSpoolInfo, SpoolAssignment, HMSError, InventorySpool, PrinterDiagnosticResult, PrintLogEntry } from '../api/client';
import { Card, CardContent } from '../components/Card';
import { Button } from '../components/Button';
import { ToolbarDropdown, ToolbarMenu, ReactSelect } from '../components/ToolbarControls';
import { ConfirmModal } from '../components/ConfirmModal';
import { BulkPrinterToolbar, type PrinterState } from '../components/BulkPrinterToolbar';
import { FileManagerModal } from '../components/FileManagerModal';
import { EmbeddedCameraViewer } from '../components/EmbeddedCameraViewer';
import { CameraWall } from '../components/CameraWall';
import { CameraPlaceholder } from '../components/CameraPlaceholder';
import { MQTTDebugModal } from '../components/MQTTDebugModal';
import { HMSErrorModal, filterKnownHMSErrors } from '../components/HMSErrorModal';
import { PrinterQueueWidget } from '../components/PrinterQueueWidget';
import { AMSHistoryModal } from '../components/AMSHistoryModal';
import { AmsBackupModal } from '../components/AmsBackupModal';
import { useToast } from '../contexts/ToastContext';
import { ChamberLight } from '../components/icons/ChamberLight';
import { PlateClearedIcon } from '../components/icons/PlateClearedIcon';
import { SkipObjectsModal, SkipObjectsIcon } from '../components/SkipObjectsModal';
import { FileUploadModal } from '../components/FileUploadModal';
import { PrintModal } from '../components/PrintModal';
import { PrinterPowerControls } from '../components/printer/PrinterPowerControls';
import { PrinterHealthMenu } from '../components/printer/PrinterHealthMenu';
import { FirmwareUpdateModal } from '../components/printer/FirmwareUpdateModal';
import { PrinterThermalControls } from '../components/printer/PrinterThermalControls';
import { PrinterAirductControl } from '../components/printer/PrinterAirductControl';
import { PrinterPlateDetectionControl } from '../components/printer/PrinterPlateDetectionControl';
import { PrinterStopPrintConfirmation } from '../components/printer/PrinterStopPrintConfirmation';
import {
  AmsDryingControl,
  AmsDryingPopover,
  AmsDryingStatus,
} from '../components/printer/AmsDryingControls';
import {
  AmsEnvironmentIndicators,
  AmsNameHoverCard,
  AmsSlotActions,
  AmsSlotGrid,
  AmsUnitHeader,
  CompactAmsUnitCard,
  ExpandedAmsUnitCard,
  HtAmsUnitCard,
} from '../components/printer/AmsCardParts';
import { resolveAmsSlotModel } from '../components/printer/amsSlotModel';
import { AmsSlot, AmsSlotControllerModals, useAmsSlotController } from '../hooks/useAmsSlotController';
import { DRYING_PRESETS, useAmsDryingControls } from '../hooks/useAmsDryingControls';
import type { DryingPresets } from '../hooks/useAmsDryingControls';
import { PrinterInfoModal } from '../components/PrinterInfoModal';
import { getAmsLabel, getGlobalTrayId, getSlotPresetKey, getFillBarColor } from '../utils/amsHelpers';
import { getPrinterImage, getWifiStrength, filterCompatibleQueueItems } from '../utils/printer';
import { FilamentSlotCircle } from '../components/FilamentSlotCircle';
import { Collapsible } from '../components/Collapsible';
import { ConnectionDiagnosticModal, DiagnosticChecklist } from '../components/ConnectionDiagnostic';

export interface SpoolmanSlotAssignmentRow {
  printer_id: number;
  ams_id: number;
  tray_id: number;
  spoolman_spool_id: number;
}

// Nozzle side indicators (Bambu Lab style - square badge with L/R)
function NozzleBadge({ side }: { side: 'L' | 'R' }) {
  const { mode } = useTheme();
  // Light mode: #e7f5e9 (light green), Dark mode: #1a4d2e (dark green)
  const bgColor = mode === 'dark' ? '#1a4d2e' : '#e7f5e9';
  return (
    <span
      className="inline-flex items-center justify-center w-4 h-4 text-[10px] font-bold rounded"
      style={{ backgroundColor: bgColor, color: '#00ae42' }}
    >
      {side}
    </span>
  );
}

// Expand nozzle type codes to material names
// Handles full text ("hardened_steel"), 2-char codes ("HS"/"HH"), and 4-char codes ("HS01")
// Material mapping: 00=stainless steel, 01=hardened steel, 05=tungsten carbide

// Nozzle icon - schematic hot-end view (filament body + heater block + tip).
// Added for visual parity with the thermometer icons on the dual-nozzle card
// that previously had no icon at all (#1115, design by @m4rtini2).

// AMS Filament Backup tri-state indicator + toggle.
// state=true  → ON, click to disable
// state=false → OFF, click opens modal
// state=null  → unknown/unsupported (e.g. A1 family), click disabled
interface AmsBackupBadgeProps {
  state: boolean | null;
  onClick: () => void;
}

function AmsBackupBadge({ state, onClick }: AmsBackupBadgeProps) {
  const { t } = useTranslation();
  const known = state !== null;

  let className = 'flex items-center justify-center w-[18px] h-[18px] rounded text-[10px] transition-colors ';
  let title: string;
  if (state === true) {
    className += known
      ? 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 cursor-pointer'
      : 'bg-blue-500/20 text-blue-400 cursor-default';
    title = t('printers.amsBackup.titleOn');
  } else if (state === false) {
    className += known
      ? 'bg-bambu-dark text-bambu-gray hover:text-white hover:bg-bambu-dark/80 cursor-pointer'
      : 'bg-bambu-dark text-bambu-gray cursor-default';
    title = t('printers.amsBackup.titleOff');
  } else {
    className += 'bg-bambu-dark text-bambu-gray/50 cursor-default';
    title = t('printers.amsBackup.titleUnknown');
  }

  return (
    <button
      type="button"
      disabled={!known}
      onClick={() => known && onClick()}
      className={className}
      title={title}
      aria-label={title}
    >
      {known ? <Repeat className="w-3 h-3" /> : <span>?</span>}
    </button>
  );
}

/** Classify an empty AMS slot for UI rendering (#1322 follow-up).
 *
 *  "physical" — firmware positively confirmed no spool (state 9 or 10). The
 *  bambu_mqtt handler now promotes tray_exist_bits=0 slots to state=9, so
 *  every empty-by-bitmask slot lands here regardless of firmware payload
 *  shape.
 *
 *  "reset" — tray_type is missing/empty but firmware hasn't confirmed
 *  emptiness (state is null, 3, or any non-9/10 value). Typically a slot
 *  the user cleared with "Reset Slot" where a physical spool may still be
 *  loaded but unassigned.
 *
 *  Returns null when the slot is loaded (tray_type is present).
 */
function getEmptySlotKind(tray: { tray_type?: string | null; state?: number | null } | null | undefined): 'physical' | 'reset' | null {
  if (tray?.tray_type) return null;
  return (tray?.state === 9 || tray?.state === 10) ? 'physical' : 'reset';
}


function CoverImage({
  url,
  printName,
  className = 'w-20 h-20',
  radiusClass = 'rounded-lg',
}: {
  url: string | null;
  printName?: string;
  className?: string;
  radiusClass?: string;
}) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);

  // Cache-bust the image URL when the print name changes so the browser
  // fetches the new cover instead of serving the stale cached image.
  const cacheBustedUrl = useMemo(() => {
    if (!url) return null;
    const sep = url.includes('?') ? '&' : '?';
    return withStreamToken(`${url}${sep}v=${encodeURIComponent(printName || Date.now().toString())}`);
  }, [url, printName]);

  // Reset loaded/error state when the image URL changes
  useEffect(() => {
    setLoaded(false);
    setError(false);
  }, [cacheBustedUrl]);

  return (
    <>
      <div
        className={`${className} flex-shrink-0 ${radiusClass} overflow-hidden bg-bambu-dark-tertiary flex items-center justify-center ${cacheBustedUrl && loaded ? 'cursor-pointer' : ''}`}
        onClick={() => cacheBustedUrl && loaded && setShowOverlay(true)}
      >
        {cacheBustedUrl && !error ? (
          <>
            <img
              src={cacheBustedUrl}
              alt={t('printers.printPreview')}
              className={`w-full h-full object-cover ${loaded ? 'block' : 'hidden'}`}
              onLoad={() => setLoaded(true)}
              onError={() => setError(true)}
            />
            {!loaded && <Box className="w-8 h-8 text-bambu-gray" />}
          </>
        ) : (
          <Box className="w-8 h-8 text-bambu-gray" />
        )}
      </div>

      {/* Cover Image Overlay */}
      {showOverlay && cacheBustedUrl && (
        <div
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-8"
          onClick={() => setShowOverlay(false)}
        >
          <div className="relative max-w-2xl max-h-full">
            <img
              src={cacheBustedUrl}
              alt={t('printers.printPreview')}
              className="max-w-full max-h-[80vh] rounded-lg shadow-2xl"
            />
            {printName && (
              <p className="text-white text-center mt-4 text-lg">{printName}</p>
            )}
          </div>
        </div>
      )}
    </>
  );
}

interface PrinterMaintenanceInfo {
  due_count: number;
  warning_count: number;
  total_print_hours: number;
}

type PrinterHealthMeta = {
  level: 'healthy' | 'attention' | 'error';
  label: string;
  className: string;
};

function getPrinterHealthMeta({
  connected,
  knownErrors,
  maintenanceInfo,
  needsPlateClear,
  wifiSignal,
  firmwareUpdateAvailable,
  hasDoorSensor,
  doorOpen,
  labels,
}: {
  connected: boolean | undefined;
  knownErrors: HMSError[];
  maintenanceInfo?: PrinterMaintenanceInfo;
  needsPlateClear: boolean;
  wifiSignal: number | null | undefined;
  firmwareUpdateAvailable: boolean;
  hasDoorSensor: boolean;
  doorOpen: boolean | undefined;
  labels: {
    healthy: string;
    attentionRequired: string;
    error: string;
  };
}): PrinterHealthMeta {
  if (!connected) {
    return {
      level: 'error',
      label: labels.error,
      className: 'bg-status-error/20 text-status-error',
    };
  }

  const hasSevereHms = knownErrors.some(e => e.severity <= 2);
  if (hasSevereHms || (maintenanceInfo?.due_count ?? 0) > 0 || (wifiSignal != null && wifiSignal < -80)) {
    return {
      level: 'error',
      label: labels.error,
      className: 'bg-status-error/20 text-status-error',
    };
  }

  if (
    knownErrors.length > 0 ||
    needsPlateClear ||
    (maintenanceInfo?.warning_count ?? 0) > 0 ||
    firmwareUpdateAvailable ||
    (hasDoorSensor && doorOpen) ||
    (wifiSignal != null && wifiSignal < -60)
  ) {
    return {
      level: 'attention',
      label: labels.attentionRequired,
      className: 'bg-status-warning/20 text-status-warning',
    };
  }

  return {
    level: 'healthy',
    label: labels.healthy,
    className: 'bg-status-ok/20 text-status-ok',
  };
}

// Status summary bar component - uses queryClient to read cached statuses
function StatusSummaryBar({ printers }: { printers: Printer[] | undefined }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // Subscribe to query cache changes to re-render when status updates
  // Throttled to prevent rapid re-renders from causing tab crashes
  const [cacheTick, setCacheTick] = useState(0);
  useEffect(() => {
    let pending = false;
    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      if (!pending) {
        pending = true;
        requestAnimationFrame(() => {
          setCacheTick(t => t + 1);
          pending = false;
        });
      }
    });
    return () => unsubscribe();
  }, [queryClient]);

  const { counts, nextFinish } = useMemo(() => {
    let printing = 0;
    let paused = 0;
    let finished = 0;
    let idle = 0;
    let offline = 0;
    let loading = 0;
    let error = 0;
    let nextPrinterName: string | null = null;
    let nextRemainingMin: number | null = null;
    let nextProgress: number = 0;

    printers?.forEach((printer) => {
      const status = queryClient.getQueryData<{ connected: boolean; state: string | null; remaining_time: number | null; progress: number | null; hms_errors?: HMSError[] }>(['printerStatus', printer.id]);
      if (status === undefined) {
        // Status not yet loaded - don't count as offline yet
        loading++;
      } else if (!status.connected) {
        offline++;
      } else {
        // Count printers with active HMS errors as problems
        const knownHmsCount =
          status.hms_errors ? filterKnownHMSErrors(status.hms_errors).length : 0;
        if (knownHmsCount > 0) {
          error++;
        }
        switch (status.state) {
          case 'RUNNING':
            printing++;
            if (status.remaining_time != null && status.remaining_time > 0) {
              if (nextRemainingMin === null || status.remaining_time < nextRemainingMin) {
                nextRemainingMin = status.remaining_time;
                nextPrinterName = printer.name;
                nextProgress = status.progress || 0;
              }
            }
            break;
          case 'PAUSE':
            paused++;
            break;
          case 'FINISH':
            finished++;
            break;
          case 'FAILED':
            // FAILED is the printer's terminal gcode_state after a print stops —
            // including user cancellations, where there's no actual fault. Only
            // count it as a "problem" when an HMS error is also active; otherwise
            // it's just a print that ended unsuccessfully and the plate needs
            // clearing (same as FINISH from the operator's perspective).
            if (knownHmsCount > 0) {
              // Already counted above
            } else {
              finished++;
            }
            break;
          default:
            idle++;
            break;
        }
      }
    });

    return {
      counts: { printing, paused, finished, idle, offline, loading, error, total: (printers?.length || 0) },
      nextFinish: nextPrinterName && nextRemainingMin ? { name: nextPrinterName, remainingMin: nextRemainingMin, progress: nextProgress } : null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printers, queryClient, cacheTick]);

  if (!printers?.length) return null;

  const badges: { count: number; dot: string; label: string }[] = [
    { count: counts.printing, dot: 'bg-bambu-green animate-pulse', label: t('printers.status.printing').toLowerCase() },
    { count: counts.paused, dot: 'bg-status-warning', label: t('printers.status.paused', 'paused').toLowerCase() },
    { count: counts.finished, dot: 'bg-blue-400', label: t('printers.status.finished', 'finished').toLowerCase() },
    { count: counts.idle, dot: counts.idle > 0 ? 'bg-bambu-green' : 'bg-gray-500', label: t('printers.status.available').toLowerCase() },
    { count: counts.error, dot: 'bg-status-error', label: t('printers.status.problem').toLowerCase() },
    { count: counts.offline, dot: 'bg-gray-400', label: t('printers.status.offline').toLowerCase() },
  ];

  return (
    <div className="mt-1 flex flex-wrap items-center gap-4 gap-y-2 text-bambu-gray">
      {badges.map(({ count, dot, label }) => count > 0 && (
        <div key={label} className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${dot}`} />
          <span className="text-bambu-gray">
            <span className="text-white font-medium">{count}</span> {label}
          </span>
        </div>
      ))}
      {nextFinish && (
        <>
          <div className="w-px h-4 bg-bambu-dark-tertiary" />
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
            <div className="flex items-center gap-2">
              <span className="text-bambu-green font-medium">{t('printers.nextAvailable')}:</span>
              <span className="text-white font-medium">{nextFinish.name}</span>
            </div>
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <div className="w-full sm:w-16 bg-bambu-dark-tertiary rounded-full h-1.5">
                <div
                  className="bg-bambu-green h-1.5 rounded-full transition-all"
                  style={{ width: `${nextFinish.progress}%` }}
                />
              </div>
              <span className="text-white font-medium">{Math.round(nextFinish.progress)}%</span>
              <span className="text-bambu-gray">({formatDuration(nextFinish.remainingMin * 60)})</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

type SortOption = 'name' | 'status' | 'model' | 'location' | 'eta';
type PrinterPageViewMode = 'detail' | 'single' | 'list' | 'camwall';

const PRINTER_PAGE_VIEW_MODES: PrinterPageViewMode[] = ['detail', 'single', 'list', 'camwall'];

function normalizePrinterPageViewMode(value: string | null, legacyCardSize: string | null, legacyPageView: string | null): PrinterPageViewMode {
  if (legacyPageView === 'camwall') {
    return 'camwall';
  }
  if (value === 'cards') {
    return 'list';
  }
  if (value && PRINTER_PAGE_VIEW_MODES.includes(value as PrinterPageViewMode)) {
    return value as PrinterPageViewMode;
  }

  switch (legacyCardSize) {
    case '1':
      return 'list';
    case '4':
      return 'single';
    default:
      return 'detail';
  }
}

function IndicatorControlPopover({
  title,
  options = [],
  unit,
  customMin,
  customMax,
  customStep = 1,
  widthClass = 'w-[240px]',
  popoverWidth = 240,
  popoverHeight = 280,
  isPending,
  onClose,
  onSubmit,
  children,
}: {
  title: string;
  options?: Array<{ label: string; value: number }>;
  unit?: string;
  customMin?: number;
  customMax?: number;
  customStep?: number;
  widthClass?: string;
  popoverWidth?: number;
  popoverHeight?: number;
  isPending?: boolean;
  onClose: () => void;
  onSubmit?: (value: number) => void;
  children?: React.ReactNode;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const [customValue, setCustomValue] = useState('');

  // Anchor to the trigger (the popover's DOM parent before portaling) so we
  // can position via fixed coords. Portaling to document.body escapes
  // ancestor stacking contexts — sibling PrinterCard wrappers create their
  // own contexts and would otherwise cover the popover even at z-[60].
  useLayoutEffect(() => {
    const trigger = anchorRef.current?.parentElement;
    if (!trigger) return;
    const measure = () => {
      const rect = trigger.getBoundingClientRect();
      setCoords(computePopoverPosition({
        triggerRect: rect,
        popoverWidth,
        estimatedHeight: popoverHeight,
        horizontalAlign: 'center',
      }));
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [popoverWidth, popoverHeight]);

  const showCustomInput = unit !== undefined;
  const submitCustom = () => {
    const value = Number(customValue);
    if (!Number.isFinite(value)) return;
    const bounded = Math.min(customMax ?? value, Math.max(customMin ?? value, value));
    onSubmit?.(Math.round(bounded));
  };

  return (
    <>
      <span ref={anchorRef} className="hidden" aria-hidden="true" />
      {createPortal(
        <>
          <div className="fixed inset-0 z-[1000]" onClick={onClose} />
          <div
            className={`fixed z-[1001] flex ${widthClass} flex-col overflow-hidden rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-2xl`}
            style={{
              top: coords?.top ?? -9999,
              left: coords?.left ?? -9999,
              visibility: coords ? 'visible' : 'hidden',
            }}
            onClick={e => e.stopPropagation()}
          >
        <div className="shrink-0 px-3 py-2.5 text-center text-sm font-medium text-white">{title}</div>
        <div className="shrink-0 h-px bg-bambu-dark-tertiary" />
        {options.length > 0 && (
          <div className="px-3 py-2.5">
            <div className="grid grid-cols-2 gap-1.5">
              {options.map(option => (
                <button
                  key={`${option.label}-${option.value}`}
                  type="button"
                  disabled={isPending}
                  onClick={() => onSubmit?.(option.value)}
                  className="h-8 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-2 text-xs font-medium text-white transition-colors hover:bg-bambu-dark-tertiary disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {children}
        {showCustomInput && (
          <>
            <div className="shrink-0 h-px bg-bambu-dark-tertiary" />
            <form
              className="flex gap-1.5 px-3 pt-2.5 pb-3"
              onSubmit={(e) => {
                e.preventDefault();
                submitCustom();
              }}
            >
              <input
                type="number"
                min={customMin}
                max={customMax}
                step={customStep}
                value={customValue}
                onChange={e => setCustomValue(e.target.value)}
                placeholder="Custom"
                className="h-8 min-w-0 flex-1 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-2 text-xs text-white placeholder:text-bambu-gray/60 focus:border-bambu-green focus:outline-none"
              />
              <button
                type="submit"
                disabled={isPending || customValue.trim() === ''}
                className="h-8 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-2 text-xs font-medium text-white transition-colors hover:bg-bambu-dark-tertiary disabled:cursor-not-allowed disabled:opacity-50"
              >
                Set
              </button>
            </form>
          </>
        )}
          </div>
        </>,
        document.body
      )}
    </>
  );
}


const STATUS_GROUP_ORDER: string[] = ['error', 'printing', 'paused', 'finished', 'idle', 'offline'];

const STATUS_GROUP_META: Record<string, { labelKey: string; dot: string }> = {
  error:    { labelKey: 'printers.status.problem',   dot: 'bg-status-error' },
  printing: { labelKey: 'printers.status.printing',  dot: 'bg-bambu-green animate-pulse' },
  paused:   { labelKey: 'printers.status.paused',    dot: 'bg-status-warning' },
  finished: { labelKey: 'printers.status.finished',  dot: 'bg-blue-400' },
  idle:     { labelKey: 'printers.status.idle',       dot: 'bg-bambu-green' },
  offline:  { labelKey: 'printers.status.offline',   dot: 'bg-gray-400' },
};

/** Classify a printer into one of the UI status buckets. */
function classifyPrinterStatus(
  status: { connected: boolean; state: string | null; hms_errors?: HMSError[] } | undefined,
): PrinterState {
  if (!status?.connected) return 'offline';
  const hmsErrors = status.hms_errors ? filterKnownHMSErrors(status.hms_errors) : [];
  if (hmsErrors.length > 0) return 'error';
  switch (status.state) {
    case 'RUNNING': return 'printing';
    case 'PAUSE':   return 'paused';
    case 'FINISH':  return 'finished';
    // FAILED without an active HMS error is the printer's terminal state after
    // any unsuccessful end — including user-cancellations. Treat the same as
    // FINISH for grouping/badging purposes; only escalate to "error" when an
    // HMS code is actually attached (handled by the early-return above).
    case 'FAILED':  return 'finished';
    default:        return 'idle';
  }
}

/**
 * Get human-readable status display text for a printer.
 * Uses stg_cur_name for detailed calibration/preparation stages,
 * otherwise formats the gcode_state nicely.
 */
function getStatusDisplay(state: string | null | undefined, stg_cur_name: string | null | undefined): string {
  // If we have a specific stage name (calibration, heating, etc.), use it
  if (stg_cur_name) {
    return stg_cur_name;
  }

  // Format the gcode_state nicely
  switch (state) {
    case 'RUNNING':
      return 'Printing';
    case 'PAUSE':
      return 'Paused';
    case 'FINISH':
      return 'Finished';
    case 'FAILED':
      return 'Failed';
    case 'IDLE':
      return 'Idle';
    default:
      return state ? state.charAt(0) + state.slice(1).toLowerCase() : 'Idle';
  }
}

// Map SSDP model codes to display names
function mapModelCode(ssdpModel: string | null): string {
  if (!ssdpModel) return '';
  const modelMap: Record<string, string> = {
    // H2 Series
    'O1D': 'H2D',
    'O1E': 'H2D Pro',
    'O2D': 'H2D Pro',
    'O1C': 'H2C',
    'O1C2': 'H2C',
    'O1S': 'H2S',
    // X1 Series
    'BL-P001': 'X1C',
    'BL-P002': 'X1',
    'BL-P003': 'X1E',
    // X2 Series
    'N6': 'X2D',
    // A2 Series
    'N9': 'A2L',
    // P Series
    'C11': 'P1S',
    'C12': 'P1P',
    'C13': 'P2S',
    // A1 Series
    'N2S': 'A1',
    'N1': 'A1 Mini',
    // Direct matches
    'X1C': 'X1C',
    'X1': 'X1',
    'X1E': 'X1E',
    'X2D': 'X2D',
    'P1S': 'P1S',
    'P1P': 'P1P',
    'P2S': 'P2S',
    'A1': 'A1',
    'A1 Mini': 'A1 Mini',
    'A2L': 'A2L',
    'H2D': 'H2D',
    'H2D Pro': 'H2D Pro',
    'H2C': 'H2C',
    'H2S': 'H2S',
  };
  return modelMap[ssdpModel] || ssdpModel;
}


function PrinterListRow({
  printer,
  hideIfDisconnected,
  maintenanceInfo,
  requirePlateClear,
  selectionMode,
  isSelected,
  onToggleSelect,
  onOpenSinglePrinter,
  timeFormat = 'system',
  checkPrinterFirmware = true,
}: {
  printer: Printer;
  hideIfDisconnected?: boolean;
  maintenanceInfo?: PrinterMaintenanceInfo;
  requirePlateClear?: boolean;
  selectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (id: number) => void;
  onOpenSinglePrinter: (id: number) => void;
  timeFormat?: 'system' | '12h' | '24h';
  checkPrinterFirmware?: boolean;
}) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const { data: status } = useQuery({
    queryKey: ['printerStatus', printer.id],
    queryFn: () => api.getPrinterStatus(printer.id),
    refetchInterval: 30000,
  });
  const { data: firmwareInfo } = useQuery({
    queryKey: ['firmwareUpdate', printer.id],
    queryFn: () => firmwareApi.checkPrinterUpdate(printer.id),
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    enabled: checkPrinterFirmware && hasPermission('firmware:read'),
  });

  const knownHmsErrors = status?.hms_errors ? filterKnownHMSErrors(status.hms_errors) : [];
  const isPrintingOrPaused = status?.state === 'RUNNING' || status?.state === 'PAUSE';
  const progress = Math.max(0, Math.min(100, status?.progress ?? 0));
  const needsPlateClear = !!requirePlateClear && status?.awaiting_plate_clear === true && !isPrintingOrPaused;
  const showClearPlateButton = status?.connected === true && needsPlateClear;
  const clearPlateMutation = useMutation({
    mutationFn: () => api.clearPlate(printer.id),
    onSuccess: () => {
      showToast(t('queue.clearPlateSuccess'));
      queryClient.setQueryData(['printerStatus', printer.id], (old: PrinterStatus | undefined) =>
        old ? { ...old, awaiting_plate_clear: false } : old
      );
      queryClient.invalidateQueries({ queryKey: ['printerStatus', printer.id] });
      queryClient.invalidateQueries({ queryKey: ['queue', printer.id] });
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });
  const renderClearPlateButton = () => showClearPlateButton ? (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        clearPlateMutation.mutate();
      }}
      disabled={clearPlateMutation.isPending || !hasPermission('printers:clear_plate')}
      className="pointer-events-auto inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-yellow-400/40 bg-yellow-500/20 text-yellow-400 transition-colors hover:bg-yellow-500/30 disabled:cursor-not-allowed disabled:opacity-50"
      title={!hasPermission('printers:clear_plate') ? t('printers.permission.noControl') : t('printers.plateStatus.markCleared')}
      aria-label={t('printers.plateStatus.markCleared')}
    >
      {clearPlateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlateClearedIcon className="h-4 w-4" />}
    </button>
  ) : null;
  const hasDoorSensor = ['X1C', 'X1', 'X1E', 'X2D', 'P2S', 'H2D', 'H2D Pro', 'H2C', 'H2S'].includes(printer.model ?? '');
  const printerHealth = getPrinterHealthMeta({
    connected: status?.connected,
    knownErrors: knownHmsErrors,
    maintenanceInfo,
    needsPlateClear,
    wifiSignal: status?.wifi_signal,
    firmwareUpdateAvailable: !!firmwareInfo?.update_available,
    hasDoorSensor,
    doorOpen: status?.door_open,
    labels: {
      healthy: t('printers.health.healthy', 'Healthy'),
      attentionRequired: t('printers.health.attentionRequired', 'Requires attention'),
      error: t('printers.health.error', 'Error'),
    },
  });
  const jobStatusLabel = !status
    ? t('common.loading', 'Loading')
    : !status.connected
    ? t('printers.connection.offline')
    : getStatusDisplay(status.state, status.stg_cur_name);
  const activePrintName = status?.current_print && isPrintingOrPaused
    ? formatPrintName(status.subtask_name || status.current_print || null, status.gcode_file, t)
    : null;
  const showPrintProgress = isPrintingOrPaused;
  const etaLabel = showPrintProgress && status?.remaining_time != null && status.remaining_time > 0
    ? `${formatDuration(status.remaining_time * 60)} - ${formatETA(status.remaining_time, timeFormat, t)}`
    : null;
  const location = printer.location || t('printers.location.unassigned', 'Ungrouped');
  const printStatusClass = !status?.connected || knownHmsErrors.length > 0 || status?.state === 'FAILED'
    ? 'bg-status-error'
    : status?.state === 'RUNNING'
    ? 'bg-bambu-green animate-pulse'
    : 'bg-gray-500';
  const mobilePrintStatusLabel = activePrintName
    ? t('printers.list.printingJob', 'Printing: {{job}}', { job: activePrintName })
    : jobStatusLabel;
  const printStatusTitle = t('printers.list.printStatus', 'Print status: {{status}}', { status: jobStatusLabel });

  if (hideIfDisconnected && status?.connected === false) {
    return null;
  }

  const activateRow = () => {
    if (selectionMode) {
      onToggleSelect?.(printer.id);
      return;
    }
    onOpenSinglePrinter(printer.id);
  };

  return (
    <div
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('button')) return;
        activateRow();
      }}
      className={`relative border-b border-bambu-dark-tertiary text-sm transition-colors last:border-b-0 hover:bg-bambu-dark ${isSelected ? 'bg-bambu-green/10' : ''}`}
    >
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          activateRow();
        }}
        className="absolute inset-0 z-0 w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bambu-green"
        aria-label={printer.name}
        aria-pressed={selectionMode ? !!isSelected : undefined}
      />
      <div className="pointer-events-none relative z-10 flex min-w-0 items-center gap-3 px-3 py-2.5 md:hidden">
        {selectionMode && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect?.(printer.id);
            }}
            className="pointer-events-auto shrink-0 text-bambu-gray hover:text-bambu-green"
            aria-label={isSelected ? t('printers.bulk.deselectPrinter', 'Deselect printer') : t('printers.bulk.selectPrinter', 'Select printer')}
          >
            {isSelected ? <CheckSquare className="h-4 w-4 text-bambu-green" /> : <Square className="h-4 w-4" />}
          </button>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium text-white">{printer.name}</div>
            <div className="truncate text-xs text-bambu-gray">{printer.model || jobStatusLabel}</div>
          </div>
          {renderClearPlateButton()}
        </div>
        <div className="flex min-w-0 max-w-[58%] shrink-0 items-center gap-2">
          <span className="min-w-0 max-w-28 truncate text-right text-xs font-medium text-white" title={mobilePrintStatusLabel}>
            {mobilePrintStatusLabel}
          </span>
          <span
            className={`h-2.5 w-2.5 shrink-0 rounded-full ${printStatusClass}`}
            title={printStatusTitle}
            aria-label={printStatusTitle}
          />
          {etaLabel && (
            <span className="min-w-12 shrink-0 text-right text-xs font-medium tabular-nums text-white">{etaLabel}</span>
          )}
          <PrinterHealthMenu
            printer={printer}
            status={status}
            printerHealth={printerHealth}
            knownHmsErrors={knownHmsErrors}
            maintenanceInfo={maintenanceInfo}
            requirePlateClear={requirePlateClear}
            needsPlateClear={needsPlateClear}
            firmwareInfo={firmwareInfo}
            hasDoorSensor={hasDoorSensor}
            checkPrinterFirmware={checkPrinterFirmware}
          />
        </div>
      </div>

      <div className="pointer-events-none relative z-10 hidden min-w-[820px] grid-cols-[minmax(15rem,1.5fr)_minmax(8rem,0.8fr)_minmax(9rem,0.9fr)_minmax(13rem,1.25fr)_minmax(10rem,0.85fr)] items-center gap-3 px-3 py-2.5 md:grid">
        <div className="flex min-w-0 items-center gap-3">
          {selectionMode && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleSelect?.(printer.id);
              }}
              className="pointer-events-auto shrink-0 text-bambu-gray hover:text-bambu-green"
              aria-label={isSelected ? t('printers.bulk.deselectPrinter', 'Deselect printer') : t('printers.bulk.selectPrinter', 'Select printer')}
            >
              {isSelected ? <CheckSquare className="h-4 w-4 text-bambu-green" /> : <Square className="h-4 w-4" />}
            </button>
          )}
          <img
            src={getPrinterImage(printer.model)}
            alt={printer.model || t('common.printer')}
            className="h-10 w-10 shrink-0 rounded-lg object-contain"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium text-white">{printer.name}</div>
            <div className="truncate text-xs text-bambu-gray">{printer.model || t('common.unknown', 'Unknown')}</div>
          </div>
          {renderClearPlateButton()}
        </div>
        <div className="min-w-0">
          <span className="inline-flex max-w-full items-center gap-2">
            <PrinterHealthMenu
              printer={printer}
              status={status}
              printerHealth={printerHealth}
              knownHmsErrors={knownHmsErrors}
              maintenanceInfo={maintenanceInfo}
              requirePlateClear={requirePlateClear}
              needsPlateClear={needsPlateClear}
              firmwareInfo={firmwareInfo}
              hasDoorSensor={hasDoorSensor}
              checkPrinterFirmware={checkPrinterFirmware}
            />
            <span className={`truncate text-sm font-medium ${status ? 'text-white' : 'text-bambu-gray'}`}>{printerHealth.label}</span>
          </span>
        </div>
        <div className="truncate text-bambu-gray">{location}</div>
        <div className="min-w-0">
          <div className="truncate text-white">{activePrintName || jobStatusLabel}</div>
          {showPrintProgress && (
            <div className="mt-1 flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bambu-dark-tertiary">
                <div className="h-full rounded-full bg-bambu-green transition-all" style={{ width: `${progress}%` }} />
              </div>
              <span className="w-9 shrink-0 text-right text-xs tabular-nums text-bambu-gray">{`${Math.round(progress)}%`}</span>
            </div>
          )}
        </div>
        <div className="min-w-0 text-right">
          {etaLabel && <div className="truncate text-white">{etaLabel}</div>}
        </div>
      </div>
    </div>
  );
}

function SinglePrinterSwitcherItem({
  printer,
  isSelected,
  maintenanceInfo,
  requirePlateClear,
  checkPrinterFirmware = true,
  onSelect,
}: {
  printer: Printer;
  isSelected: boolean;
  maintenanceInfo?: PrinterMaintenanceInfo;
  requirePlateClear?: boolean;
  checkPrinterFirmware?: boolean;
  onSelect: (id: number) => void;
}) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { data: status } = useQuery({
    queryKey: ['printerStatus', printer.id],
    queryFn: () => api.getPrinterStatus(printer.id),
    refetchInterval: 30000,
  });
  const { data: firmwareInfo } = useQuery({
    queryKey: ['firmwareUpdate', printer.id],
    queryFn: () => firmwareApi.checkPrinterUpdate(printer.id),
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    enabled: checkPrinterFirmware && hasPermission('firmware:read'),
  });

  const knownHmsErrors = status?.hms_errors ? filterKnownHMSErrors(status.hms_errors) : [];
  const isPrintingOrPaused = status?.state === 'RUNNING' || status?.state === 'PAUSE';
  const needsPlateClear = !!requirePlateClear && status?.awaiting_plate_clear === true && !isPrintingOrPaused;
  const hasDoorSensor = ['X1C', 'X1', 'X1E', 'X2D', 'P2S', 'H2D', 'H2D Pro', 'H2C', 'H2S'].includes(printer.model ?? '');
  const printerHealth = getPrinterHealthMeta({
    connected: status?.connected,
    knownErrors: knownHmsErrors,
    maintenanceInfo,
    needsPlateClear,
    wifiSignal: status?.wifi_signal,
    firmwareUpdateAvailable: !!firmwareInfo?.update_available,
    hasDoorSensor,
    doorOpen: status?.door_open,
    labels: {
      healthy: t('printers.health.healthy', 'Healthy'),
      attentionRequired: t('printers.health.attentionRequired', 'Requires attention'),
      error: t('printers.health.error', 'Error'),
    },
  });

  return (
    <button
      type="button"
      onClick={() => onSelect(printer.id)}
      className={`group flex w-full min-w-0 items-center gap-2 rounded-lg border p-2 text-left transition-colors ${
        isSelected
          ? 'border-bambu-green/60 bg-bambu-green/10'
          : 'border-bambu-dark-tertiary bg-bambu-dark hover:border-bambu-green/40 hover:bg-bambu-dark-tertiary/60'
      }`}
      title={printer.name}
      aria-pressed={isSelected}
    >
      <img
        src={getPrinterImage(printer.model)}
        alt={printer.model || t('common.printer')}
        className="h-10 w-10 shrink-0 rounded-lg bg-bambu-dark-secondary object-contain"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold text-white">{printer.name}</div>
        <div className="mt-0.5 truncate text-[11px] text-bambu-gray">{printer.model || t('common.unknown', 'Unknown')}</div>
      </div>
      <span
        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${printerHealth.className}`}
        title={t('printers.health.title', 'Machine health: {{status}}', { status: printerHealth.label })}
        aria-label={t('printers.health.title', 'Machine health: {{status}}', { status: printerHealth.label })}
      >
        <Activity className="h-3.5 w-3.5" />
      </span>
    </button>
  );
}

function formatCockpitWeight(grams: number): string {
  if (grams >= 1000) return `${(grams / 1000).toFixed(2)}kg`;
  return `${Math.round(grams)}g`;
}

function CockpitMetricCard({
  icon: Icon,
  label,
  value,
  detail,
  compact = false,
  className = '',
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  detail?: string;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-white/10 bg-bambu-dark-secondary/95 shadow-sm shadow-black/25 ring-1 ring-black/10 ${compact ? 'min-w-0 p-2' : 'p-3'} ${className}`}>
      <div className={`flex items-center font-medium uppercase tracking-wide text-bambu-gray ${compact ? 'gap-1 text-[9px]' : 'gap-2 text-xs'}`}>
        <Icon className={`${compact ? 'h-3 w-3' : 'h-4 w-4'} shrink-0 text-bambu-green`} />
        <span className="truncate">{label}</span>
      </div>
      <div className={`${compact ? 'mt-1 text-base' : 'mt-2 text-2xl'} truncate font-semibold tabular-nums text-white`}>{value}</div>
      {detail && <div className={`mt-1 truncate text-bambu-gray ${compact ? 'text-[9px]' : 'text-xs'}`}>{detail}</div>}
    </div>
  );
}

type PrinterActionsMenuProps = {
  printer: Printer;
  isOpen: boolean;
  menuRef: React.RefObject<HTMLDivElement | null>;
  triggerClassName: string;
  menuClassName: string;
  iconClassName?: string;
  maintenancePending?: boolean;
  forceRefreshPending?: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onInfo: () => void;
  onToggleMaintenance: () => void;
  onReconnect: () => void;
  onForceRefresh: () => void;
  onMqttDebug: () => void;
  onDiagnostic: () => void;
  onDelete: () => void;
};

function PrinterActionsMenu({
  printer,
  isOpen,
  menuRef,
  triggerClassName,
  menuClassName,
  iconClassName = 'h-4 w-4',
  maintenancePending = false,
  forceRefreshPending = false,
  onToggle,
  onEdit,
  onInfo,
  onToggleMaintenance,
  onReconnect,
  onForceRefresh,
  onMqttDebug,
  onDiagnostic,
  onDelete,
}: PrinterActionsMenuProps) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const itemClass = 'flex w-full items-center gap-2 px-4 py-2 text-left text-sm';

  return (
    <div ref={menuRef} className="relative flex-shrink-0">
      <Button
        variant="secondary"
        size="sm"
        onClick={onToggle}
        title={t('common.more', 'More')}
        className={triggerClassName}
      >
        <MoreVertical className={iconClassName} />
      </Button>
      {isOpen && (
        <div className={menuClassName}>
          <button
            className={`${itemClass} ${
              hasPermission('printers:update')
                ? 'hover:bg-bambu-dark-tertiary'
                : 'cursor-not-allowed opacity-50'
            }`}
            onClick={() => {
              if (!hasPermission('printers:update')) return;
              onEdit();
            }}
            title={!hasPermission('printers:update') ? t('printers.permission.noEdit') : undefined}
          >
            <Pencil className={iconClassName} />
            {t('common.edit')}
          </button>
          <button className={`${itemClass} hover:bg-bambu-dark-tertiary`} onClick={onInfo}>
            <Info className={iconClassName} />
            {t('printers.printerInformation')}
          </button>
          <button
            className={`${itemClass} ${
              hasPermission('printers:update')
                ? 'hover:bg-bambu-dark-tertiary'
                : 'cursor-not-allowed opacity-50'
            }`}
            disabled={maintenancePending || !hasPermission('printers:update')}
            onClick={() => {
              if (!hasPermission('printers:update')) return;
              onToggleMaintenance();
            }}
            title={!hasPermission('printers:update') ? t('printers.permission.noEdit') : undefined}
          >
            <Wrench className={iconClassName} />
            {printer.is_active !== false
              ? t('printers.maintenance.menuEnter')
              : t('printers.maintenance.menuExit')}
          </button>
          <button className={`${itemClass} hover:bg-bambu-dark-tertiary`} onClick={onReconnect}>
            <RefreshCw className={iconClassName} />
            {t('printers.reconnect')}
          </button>
          <button
            className={`${itemClass} hover:bg-bambu-dark-tertiary disabled:opacity-50`}
            disabled={forceRefreshPending}
            onClick={onForceRefresh}
          >
            <RotateCw className={`${iconClassName} ${forceRefreshPending ? 'animate-spin' : ''}`} />
            {t('printers.forceRefresh')}
          </button>
          <button className={`${itemClass} hover:bg-bambu-dark-tertiary`} onClick={onMqttDebug}>
            <Terminal className={iconClassName} />
            {t('printers.mqttDebug')}
          </button>
          <button className={`${itemClass} hover:bg-bambu-dark-tertiary`} onClick={onDiagnostic}>
            <Stethoscope className={iconClassName} />
            {t('diagnostic.runButton')}
          </button>
          <button
            className={`${itemClass} ${
              hasPermission('printers:delete')
                ? 'text-red-400 hover:bg-bambu-dark-tertiary'
                : 'cursor-not-allowed text-red-400/50'
            }`}
            onClick={() => {
              if (!hasPermission('printers:delete')) return;
              onDelete();
            }}
            title={!hasPermission('printers:delete') ? t('printers.permission.noDelete') : undefined}
          >
            <Trash2 className={iconClassName} />
            {t('common.delete')}
          </button>
        </div>
      )}
    </div>
  );
}

function PrinterDeleteConfirmModal({
  printer,
  deleteArchives,
  onDeleteArchivesChange,
  onCancel,
  onConfirm,
}: {
  printer: Printer;
  deleteArchives: boolean;
  onDeleteArchivesChange: (deleteArchives: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <Card className="mx-4 w-full max-w-md">
        <CardContent>
          <div className="mb-4 flex items-start gap-3">
            <div className="rounded-full bg-red-500/20 p-2">
              <AlertTriangle className="h-5 w-5 text-red-400" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-white">{t('printers.confirm.deleteTitle')}</h3>
              <p className="mt-1 text-sm text-bambu-gray">
                {t('printers.confirm.deleteMessage', { name: printer.name })}
              </p>
            </div>
          </div>

          <div className="mb-4 rounded-lg bg-bambu-dark p-3">
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={deleteArchives}
                onChange={(e) => onDeleteArchivesChange(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-bambu-gray bg-bambu-dark-secondary text-bambu-green focus:ring-bambu-green focus:ring-offset-0"
              />
              <div>
                <span className="text-sm text-white">{t('printers.deleteArchives')}</span>
                <p className="mt-0.5 text-xs text-bambu-gray">
                  {deleteArchives
                    ? t('printers.confirm.deleteArchivesNote')
                    : t('printers.confirm.keepArchivesNote')}
                </p>
              </div>
            </label>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onCancel}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={onConfirm}>
              {t('common.delete')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function useCurrentPrintOwner(printerId: number, isPrintingOrPaused: boolean) {
  const { data: printingQueueItems } = useQuery({
    queryKey: ['queue', printerId, 'printing'],
    queryFn: () => api.getQueue(printerId, 'printing'),
    enabled: isPrintingOrPaused,
  });
  const { data: reprintUser } = useQuery({
    queryKey: ['currentPrintUser', printerId],
    queryFn: () => api.getCurrentPrintUser(printerId),
    enabled: isPrintingOrPaused,
  });

  return printingQueueItems?.[0]?.created_by_username || reprintUser?.username;
}

function SinglePrinterCockpit({
  printer,
  maintenanceInfo,
  requirePlateClear,
  checkPrinterFirmware = true,
  currencySymbol,
  nozzleTempPresets = NOZZLE_TEMP_DEFAULTS,
  bedTempPresets = BED_TEMP_DEFAULTS,
  chamberTempPresets = CHAMBER_TEMP_DEFAULTS,
  fanSpeedPresets = FAN_SPEED_DEFAULTS,
  dryingPresets = DRYING_PRESETS,
  amsThresholds,
  spoolmanEnabled = false,
  linkedSpools,
  spoolmanUrl,
  spoolmanSyncMode,
  onGetAssignment,
  onUnassignSpool,
  spoolmanSpools,
  spoolmanSlotAssignments,
  spoolmanLoading = false,
  onUnassignSpoolmanSpool,
}: {
  printer: Printer;
  maintenanceInfo?: PrinterMaintenanceInfo;
  requirePlateClear?: boolean;
  checkPrinterFirmware?: boolean;
  currencySymbol: string;
  nozzleTempPresets?: readonly [number, number, number];
  bedTempPresets?: readonly [number, number, number];
  chamberTempPresets?: readonly [number, number, number];
  fanSpeedPresets?: readonly [number, number, number];
  dryingPresets?: DryingPresets;
  amsThresholds?: {
    humidityGood: number;
    humidityFair: number;
    tempGood: number;
    tempFair: number;
  };
  spoolmanEnabled?: boolean;
  linkedSpools?: Record<string, LinkedSpoolInfo>;
  spoolmanUrl?: string | null;
  spoolmanSyncMode?: string | null;
  onGetAssignment?: (printerId: number, amsId: number, trayId: number) => SpoolAssignment | undefined;
  onUnassignSpool?: (printerId: number, amsId: number, trayId: number) => void;
  spoolmanSpools?: InventorySpool[];
  spoolmanSlotAssignments?: SpoolmanSlotAssignmentRow[];
  spoolmanLoading?: boolean;
  onUnassignSpoolmanSpool?: (spoolmanSpoolId: number) => void;
}) {
  const { t } = useTranslation();
  const cockpitDetailRef = useRef<HTMLDivElement>(null);
  const cockpitDetailGridRef = useRef<HTMLDivElement>(null);
  const cockpitMachineControlsRef = useRef<HTMLDivElement>(null);
  const cockpitMachineControlsContentRef = useRef<HTMLElement>(null);
  const cockpitMachineControlsInnerRef = useRef<HTMLDivElement>(null);
  const cockpitMachineControlsPrimaryRef = useRef<HTMLDivElement>(null);
  const cockpitJogControlsRef = useRef<HTMLDivElement>(null);
  const [cockpitCameraColumnWidth, setCockpitCameraColumnWidth] = useState<number | null>(null);
  const [cockpitControlsHeight, setCockpitControlsHeight] = useState<number | null>(null);
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [statusControlMenu, setStatusControlMenu] = useState<string | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteArchives, setDeleteArchives] = useState(true);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showMQTTDebug, setShowMQTTDebug] = useState(false);
  const [showPrinterInfo, setShowPrinterInfo] = useState(false);
  const [showDiagnostic, setShowDiagnostic] = useState(false);
  const [showHMSModal, setShowHMSModal] = useState(false);
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [showFirmwareModal, setShowFirmwareModal] = useState(false);
  const [confirmMaintenanceEnter, setConfirmMaintenanceEnter] = useState(false);
  const [jogStep, setJogStep] = useState(10);
  const [showUploadForPrint, setShowUploadForPrint] = useState(false);
  const [printAfterUpload, setPrintAfterUpload] = useState<{ id: number; filename: string } | null>(null);
  const [reprintEntry, setReprintEntry] = useState<PrintLogEntry | null>(null);
  const [showSkipObjectsModal, setShowSkipObjectsModal] = useState(false);
  const [amsBackupModalOpen, setAmsBackupModalOpen] = useState(false);
  const [showNotHomedModal, setShowNotHomedModal] = useState<null | { distance: number }>(null);
  const [loadedCameraPrinterId, setLoadedCameraPrinterId] = useState<number | null>(null);
  const [failedCameraPrinterId, setFailedCameraPrinterId] = useState<number | null>(null);
  const cameraImageRef = useRef<HTMLImageElement>(null);
  const printerActionsMenuRef = useRef<HTMLDivElement>(null);
  const { data: status } = useQuery({
    queryKey: ['printerStatus', printer.id],
    queryFn: () => api.getPrinterStatus(printer.id),
    refetchInterval: 30000,
  });
  const { data: firmwareInfo } = useQuery({
    queryKey: ['firmwareUpdate', printer.id],
    queryFn: () => firmwareApi.checkPrinterUpdate(printer.id),
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    enabled: checkPrinterFirmware && hasPermission('firmware:read'),
  });
  const { data: printLog } = useQuery({
    queryKey: ['single-printer-print-log', printer.id],
    queryFn: () => api.getPrintLog({ printerId: printer.id, limit: 250 }),
    staleTime: 60 * 1000,
  });
  const dryingControls = useAmsDryingControls({
    printerId: printer.id,
    amsUnits: status?.ams ?? [],
    presets: dryingPresets,
  });
  const [amsHistoryModal, setAmsHistoryModal] = useState<{
    amsId: number;
    amsLabel: string;
    mode: 'humidity' | 'temperature';
  } | null>(null);
  const { data: amsLabels, refetch: refetchAmsLabels } = useQuery({
    queryKey: ['amsLabels', printer.id],
    queryFn: () => api.getAmsLabels(printer.id),
    staleTime: 5 * 60 * 1000,
  });
  const cockpitTrayInfoIds = useMemo(() => Array.from(new Set(
    [
      ...(status?.ams ?? []).flatMap(ams => ams.tray.map(tray => tray.tray_info_idx)),
      ...(status?.vt_tray ?? []).map(tray => tray.tray_info_idx),
    ].filter((id): id is string => !!id),
  )).sort(), [status?.ams, status?.vt_tray]);
  const { data: cockpitFilamentInfo } = useQuery({
    queryKey: ['filamentInfo', cockpitTrayInfoIds],
    queryFn: () => api.getFilamentInfo(cockpitTrayInfoIds),
    enabled: cockpitTrayInfoIds.length > 0,
    staleTime: 5 * 60 * 1000,
  });
  const loadedFilamentTypes = useMemo(() => {
    const types = new Set<string>();
    for (const ams of status?.ams ?? []) {
      for (const tray of ams.tray ?? []) {
        if (tray.tray_type) types.add(tray.tray_type.toUpperCase());
      }
    }
    for (const tray of status?.vt_tray ?? []) {
      if (tray.tray_type) types.add(tray.tray_type.toUpperCase());
    }
    return types;
  }, [status?.ams, status?.vt_tray]);
  const loadedFilaments = useMemo(() => {
    const filaments = new Set<string>();
    for (const ams of status?.ams ?? []) {
      for (const tray of ams.tray ?? []) {
        if (tray.tray_type && tray.tray_color) {
          filaments.add(`${tray.tray_type.toUpperCase()}:${tray.tray_color.replace('#', '').toLowerCase().slice(0, 6)}`);
        }
      }
    }
    for (const tray of status?.vt_tray ?? []) {
      if (tray.tray_type && tray.tray_color) {
        filaments.add(`${tray.tray_type.toUpperCase()}:${tray.tray_color.replace('#', '').toLowerCase().slice(0, 6)}`);
      }
    }
    return filaments;
  }, [status?.ams, status?.vt_tray]);
  const { data: cockpitSlotPresets } = useQuery({
    queryKey: ['slotPresets', printer.id],
    queryFn: () => api.getSlotPresets(printer.id),
    staleTime: 2 * 60 * 1000,
  });
  const [refreshingSlot, setRefreshingSlot] = useState<{ amsId: number; slotId: number } | null>(null);
  const refreshAmsSlotMutation = useMutation({
    mutationFn: ({ amsId, slotId }: { amsId: number; slotId: number }) => api.refreshAmsSlot(printer.id, amsId, slotId),
    onMutate: ({ amsId, slotId }) => setRefreshingSlot({ amsId, slotId }),
    onSuccess: (data) => {
      showToast(data.message || t('printers.toast.rfidRereadInitiated'));
      window.setTimeout(() => setRefreshingSlot(null), 2000);
    },
    onError: (error: Error) => {
      setRefreshingSlot(null);
      showToast(error.message || t('printers.toast.failedToRereadRfid'), 'error');
    },
  });
  const loadAmsTrayMutation = useMutation({
    mutationFn: (trayId: number) => api.loadAmsTray(printer.id, trayId),
    onSuccess: data => showToast(data.message || t('printers.toast.loadInitiated')),
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToLoad'), 'error'),
  });
  const unloadAmsMutation = useMutation({
    mutationFn: () => api.unloadAms(printer.id),
    onSuccess: data => showToast(data.message || t('printers.toast.unloadInitiated')),
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToUnload'), 'error'),
  });
  const unlinkSpoolMutation = useMutation({
    mutationFn: (spoolId: number) => api.unlinkSpool(spoolId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['linked-spools'] });
      queryClient.invalidateQueries({ queryKey: ['unlinked-spools'] });
      queryClient.invalidateQueries({ queryKey: ['spoolman-slot-assignments'] });
    },
    onError: (error: Error) => showToast(error.message || t('spoolman.unlinkFailed'), 'error'),
  });
  const amsSlotController = useAmsSlotController({
    printerId: printer.id,
    printerModel: mapModelCode(printer.model) || undefined,
    spoolmanEnabled: !!spoolmanEnabled,
    spoolmanUrl,
    spoolmanSyncMode,
    canConfigure: hasPermission('printers:control'),
    isDualNozzle: printer.nozzle_count === 2 || status?.temperatures?.nozzle_2 !== undefined,
    amsExtruderMap: status?.ams_extruder_map,
    onUnlinkSpool: spoolId => unlinkSpoolMutation.mutate(spoolId),
    onUnassignSpoolmanSpool,
    onUnassignInventorySpool: (amsId, trayId) => onUnassignSpool?.(printer.id, amsId, trayId),
  });
  const isPrintingWithObjects = (status?.state === 'RUNNING' || status?.state === 'PAUSE') && (status?.printable_objects_count ?? 0) >= 2;
  const { data: objectsData } = useQuery({
    queryKey: ['printableObjects', printer.id],
    queryFn: () => api.getPrintableObjects(printer.id),
    enabled: showSkipObjectsModal || isPrintingWithObjects,
    refetchInterval: showSkipObjectsModal ? 5000 : (isPrintingWithObjects ? 30000 : false),
  });
  const cameraStreamUrl = useMemo(
    () => withStreamToken(`/api/v1/printers/${printer.id}/camera/stream?fps=15`),
    [printer.id],
  );
  const cameraLoaded = loadedCameraPrinterId === printer.id;
  const cameraFailed = failedCameraPrinterId === printer.id;

  useEffect(() => {
    if (!status?.connected) return;
    const cameraImage = cameraImageRef.current;
    return () => {
      if (cameraImage) cameraImage.src = '';
      const headers: Record<string, string> = {};
      const token = getAuthToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      fetch(`/api/v1/printers/${printer.id}/camera/stop`, {
        method: 'POST',
        keepalive: true,
        headers,
      }).catch(() => {});
    };
  }, [printer.id, status?.connected]);

  useEffect(() => {
    if (!showMenu) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && !printerActionsMenuRef.current?.contains(target)) {
        setShowMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMenu]);

  const invalidateStatus = () => queryClient.invalidateQueries({ queryKey: ['printerStatus', printer.id] });
  const deleteMutation = useMutation({
    mutationFn: (options: { deleteArchives: boolean }) =>
      api.deletePrinter(printer.id, options.deleteArchives),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['printers'] });
      queryClient.invalidateQueries({ queryKey: ['archives'] });
      queryClient.invalidateQueries({ queryKey: ['maintenanceOverview'] });
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToDelete'), 'error'),
  });
  const connectMutation = useMutation({
    mutationFn: () => api.connectPrinter(printer.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['printerStatus', printer.id] });
    },
  });
  const forceRefreshMutation = useMutation({
    mutationFn: () => api.refreshPrinterStatus(printer.id),
    onSuccess: () => {
      invalidateStatus();
      showToast(t('printers.forceRefreshSuccess'), 'success');
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });
  const maintenanceMutation = useMutation({
    mutationFn: (isActive: boolean) => api.updatePrinter(printer.id, { is_active: isActive }),
    onSuccess: (_data, isActive) => {
      queryClient.invalidateQueries({ queryKey: ['printers'] });
      invalidateStatus();
      showToast(
        isActive
          ? t('printers.maintenance.toastExited', { name: printer.name })
          : t('printers.maintenance.toastEntered', { name: printer.name }),
        'success',
      );
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToUpdateSetting'), 'error'),
  });
  const handleEnterMaintenance = () => {
    if (status?.state === 'RUNNING' || status?.state === 'PAUSE') {
      setConfirmMaintenanceEnter(true);
    } else {
      maintenanceMutation.mutate(false);
    }
  };
  const stopPrintMutation = useMutation({
    mutationFn: () => api.stopPrint(printer.id),
    onSuccess: () => {
      showToast(t('printers.toast.printStopped'));
      invalidateStatus();
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToStopPrint'), 'error'),
  });
  const pausePrintMutation = useMutation({
    mutationFn: () => api.pausePrint(printer.id),
    onSuccess: () => {
      showToast(t('printers.toast.printPaused'));
      invalidateStatus();
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToPausePrint'), 'error'),
  });
  const resumePrintMutation = useMutation({
    mutationFn: () => api.resumePrint(printer.id),
    onSuccess: () => {
      showToast(t('printers.toast.printResumed'));
      invalidateStatus();
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToResumePrint'), 'error'),
  });
  const clearPlateMutation = useMutation({
    mutationFn: () => api.clearPlate(printer.id),
    onSuccess: () => {
      showToast(t('queue.clearPlateSuccess'));
      queryClient.setQueryData(['printerStatus', printer.id], (old: PrinterStatus | undefined) =>
        old ? { ...old, awaiting_plate_clear: false } : old
      );
      invalidateStatus();
      queryClient.invalidateQueries({ queryKey: ['queue', printer.id] });
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });
  const setAmsBackupMutation = useMutation({
    mutationFn: (enabled: boolean) => api.setAmsFilamentBackup(printer.id, enabled),
    onSuccess: (_data, enabled) => {
      queryClient.invalidateQueries({ queryKey: ['printerStatus', printer.id] });
      queryClient.invalidateQueries({ queryKey: ['printer-status', printer.id] });
      showToast(t(enabled ? 'printers.amsBackup.toastEnabled' : 'printers.amsBackup.toastDisabled'), 'success');
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });
  const chamberLightMutation = useMutation({
    mutationFn: (on: boolean) => api.setChamberLight(printer.id, on),
    onMutate: async (on) => {
      await queryClient.cancelQueries({ queryKey: ['printerStatus', printer.id] });
      const previousStatus = queryClient.getQueryData(['printerStatus', printer.id]);
      queryClient.setQueryData(['printerStatus', printer.id], (old: PrinterStatus | undefined) =>
        old ? { ...old, chamber_light: on } : old
      );
      return { previousStatus };
    },
    onSuccess: (_result, on) => {
      showToast(t('printers.single.chamberLightState', { state: t(on ? 'common.on' : 'common.off') }));
    },
    onError: (error: Error, _on, context) => {
      if (context?.previousStatus) {
        queryClient.setQueryData(['printerStatus', printer.id], context.previousStatus);
      }
      showToast(error.message || t('printers.toast.failedToControlChamberLight'), 'error');
    },
  });
  const printSpeedMutation = useMutation({
    mutationFn: (mode: number) => api.setPrintSpeed(printer.id, mode),
    onSuccess: invalidateStatus,
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSetSpeed'), 'error'),
  });
  const airductMutation = useMutation({
    mutationFn: (mode: 'cooling' | 'heating') => api.setAirductMode(printer.id, mode),
    onMutate: async (mode) => {
      await queryClient.cancelQueries({ queryKey: ['printerStatus', printer.id] });
      const previousStatus = queryClient.getQueryData(['printerStatus', printer.id]);
      queryClient.setQueryData(['printerStatus', printer.id], (old: PrinterStatus | undefined) =>
        old ? { ...old, airduct_mode: mode === 'cooling' ? 0 : 1 } : old
      );
      return { previousStatus };
    },
    onError: (error: Error, _mode, context) => {
      if (context?.previousStatus) {
        queryClient.setQueryData(['printerStatus', printer.id], context.previousStatus);
      }
      showToast(error.message || t('printers.toast.failedToSendCommand'), 'error');
    },
  });
  const plateDetectionMutation = useMutation({
    mutationFn: (enabled: boolean) => api.updatePrinter(printer.id, { plate_detection_enabled: enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['printers'] });
      showToast(plateDetectionMutation.variables ? t('printers.toast.plateCheckEnabled') : t('printers.toast.plateCheckDisabled'));
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToUpdateSetting'), 'error'),
  });
  const xyJogMutation = useMutation({
    mutationFn: ({ x, y }: { x: number; y: number }) => api.xyJog(printer.id, x, y),
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });
  const bedJogMutation = useMutation({
    mutationFn: ({ distance, force }: { distance: number; force?: boolean }) =>
      api.bedJog(printer.id, distance, force ?? false),
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });
  const extruderJogMutation = useMutation({
    mutationFn: (distance: number) => api.extruderJog(printer.id, distance),
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });
  const homeAxesMutation = useMutation({
    mutationFn: (axes: 'z' | 'xy' | 'all') => api.homeAxes(printer.id, axes),
    onSuccess: () => {
      try {
        sessionStorage.setItem(`bambuddy.bedJog.warned.${printer.id}`, '1');
      } catch {
        // Session storage can be unavailable in privacy-restricted browsers.
      }
      showToast(t('printers.bedJog.homingStarted'));
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });

  const knownHmsErrors = status?.hms_errors ? filterKnownHMSErrors(status.hms_errors) : [];
  const isPrintingOrPaused = status?.state === 'RUNNING' || status?.state === 'PAUSE';
  const isPaused = status?.state === 'PAUSE';
  const progress = Math.max(0, Math.min(100, status?.progress ?? 0));
  const needsPlateClear = !!requirePlateClear && status?.awaiting_plate_clear === true && !isPrintingOrPaused;
  const showClearPlateButton = !!status?.connected && needsPlateClear && !isPrintingOrPaused;
  const hasDoorSensor = ['X1C', 'X1', 'X1E', 'X2D', 'P2S', 'H2D', 'H2D Pro', 'H2C', 'H2S'].includes(printer.model ?? '');
  const printerHealth = getPrinterHealthMeta({
    connected: status?.connected,
    knownErrors: knownHmsErrors,
    maintenanceInfo,
    needsPlateClear,
    wifiSignal: status?.wifi_signal,
    firmwareUpdateAvailable: !!firmwareInfo?.update_available,
    hasDoorSensor,
    doorOpen: status?.door_open,
    labels: {
      healthy: t('printers.health.healthy', 'Healthy'),
      attentionRequired: t('printers.health.attentionRequired', 'Requires attention'),
      error: t('printers.health.error', 'Error'),
    },
  });

  const activePrintName = status?.current_print && isPrintingOrPaused
    ? formatPrintName(status.subtask_name || status.current_print || null, status.gcode_file, t)
    : null;
  const currentPrintUser = useCurrentPrintOwner(printer.id, isPrintingOrPaused);
  const printEntries = useMemo(() => printLog?.items ?? [], [printLog?.items]);
  const printerStats = useMemo(() => {
    const completed = printEntries.filter(entry => entry.status === 'completed').length;
    const failed = printEntries.filter(entry => entry.status === 'failed').length;
    const cancelled = printEntries.filter(entry => ['cancelled', 'stopped', 'skipped'].includes(entry.status)).length;
    const outcomeTotal = completed + failed;
    const filamentByType = new Map<string, number>();
    let durationSeconds = 0;
    let completedDurationSeconds = 0;
    let completedDurationCount = 0;
    let filamentGrams = 0;
    let totalCost = 0;
    let longestPrintSeconds = 0;
    let longestPrintName: string | null = null;

    printEntries.forEach(entry => {
      durationSeconds += entry.duration_seconds ?? 0;
      if (entry.status === 'completed' && entry.duration_seconds != null && entry.duration_seconds > 0) {
        completedDurationSeconds += entry.duration_seconds;
        completedDurationCount += 1;
      }
      filamentGrams += entry.filament_used_grams ?? 0;
      totalCost += entry.cost ?? 0;
      if (entry.status === 'completed' && (entry.duration_seconds ?? 0) > longestPrintSeconds) {
        longestPrintSeconds = entry.duration_seconds ?? 0;
        longestPrintName = entry.print_name || null;
      }
      if (entry.filament_type) {
        filamentByType.set(entry.filament_type, (filamentByType.get(entry.filament_type) ?? 0) + 1);
      }
    });

    const topFilament = Array.from(filamentByType.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '---';

    return {
      completed,
      failed,
      cancelled,
      successRate: outcomeTotal ? Math.round((completed / outcomeTotal) * 100) : 0,
      durationHours: durationSeconds / 3600,
      averageDurationSeconds: completedDurationCount > 0 ? completedDurationSeconds / completedDurationCount : null,
      filamentGrams,
      totalCost,
      longestPrintSeconds,
      longestPrintName,
      topFilament,
    };
  }, [printEntries]);

  const cockpitStatusPillBase = 'flex min-h-8 w-full items-center gap-2 rounded-lg border px-2.5 py-1 text-xs font-semibold leading-none shadow-[0_2px_10px_rgba(0,0,0,0.55)] backdrop-blur-md';
  const cockpitStatusOkClass = 'border-status-ok/50 bg-[linear-gradient(rgba(4,12,8,0.78),rgba(4,12,8,0.78)),linear-gradient(rgba(34,197,94,0.32),rgba(34,197,94,0.32))] text-status-ok';
  const cockpitStatusWarningClass = 'border-status-warning/60 bg-[linear-gradient(rgba(18,12,4,0.8),rgba(18,12,4,0.8)),linear-gradient(rgba(245,158,11,0.38),rgba(245,158,11,0.38))] text-status-warning';
  const cockpitStatusErrorClass = 'border-status-error/60 bg-[linear-gradient(rgba(18,6,6,0.82),rgba(18,6,6,0.82)),linear-gradient(rgba(239,68,68,0.38),rgba(239,68,68,0.38))] text-status-error';
  const cockpitStatusRowLabel = (title: string, state: string) => `${title}: ${state}`;
  const CockpitStatusRowText = ({ title, state }: { title: string; state: React.ReactNode }) => (
    <>
      <span className="shrink-0 leading-none">{title}:</span>
      <span className="min-w-0 truncate leading-none">{state}</span>
    </>
  );
  const connectionTitle = t('printers.status.connection', 'Connection');
  const plateTitle = t('printers.plateStatus.title', 'Plate');
  const networkTitle = t('printers.status.network', 'Network');
  const errorsTitle = t('printers.status.errors', 'Errors');
  const maintenanceTitle = t('maintenance.title', 'Maintenance');
  const firmwareTitle = t('printers.status.firmware', 'Firmware');
  const doorTitle = t('printers.status.door', 'Door');
  const wifiSignal = status?.wifi_signal;
  const maintenanceDueCount = maintenanceInfo?.due_count ?? 0;
  const maintenanceWarningCount = maintenanceInfo?.warning_count ?? 0;
  const maintenanceStateLabel = maintenanceDueCount > 0
    ? t('maintenance.dueCount', { count: maintenanceDueCount })
    : maintenanceWarningCount > 0
    ? t('maintenance.warningCount', { count: maintenanceWarningCount })
    : t('common.ok', 'OK');
  const networkStateLabel = !status?.connected
    ? t('printers.connection.offline')
    : status.wired_network
    ? t('printers.connection.ethernet', 'Ethernet')
    : wifiSignal != null
    ? `${wifiSignal}dBm`
    : t('common.unknown', 'Unknown');
  const networkTitleLabel = status?.connected && !status.wired_network && wifiSignal != null
    ? `${wifiSignal} dBm - ${t(getWifiStrength(wifiSignal).labelKey)}`
    : networkStateLabel;
  const networkClassName = !status?.connected
    ? cockpitStatusErrorClass
    : status.wired_network || wifiSignal == null || wifiSignal >= -60
    ? cockpitStatusOkClass
    : wifiSignal >= -80
    ? cockpitStatusWarningClass
    : cockpitStatusErrorClass;
  const isMaintenanceMode = printer.is_active === false;
  const cockpitPlateStatus = (() => {
    if (!requirePlateClear || !status?.connected || !needsPlateClear) return null;
    return {
      label: t('printers.plateStatus.notCleared'),
      className: cockpitStatusWarningClass,
    };
  })();
  const showConnectionPill = !isMaintenanceMode && !status?.connected;
  const showPlateStatusPill = !!cockpitPlateStatus;
  const showNetworkPill = !isMaintenanceMode && (!status?.connected || (!status?.wired_network && wifiSignal != null && wifiSignal < -60));
  const showHmsPill = !isMaintenanceMode && (!status?.connected || knownHmsErrors.length > 0);
  const showMaintenancePill = maintenanceDueCount > 0 || maintenanceWarningCount > 0;
  const showFirmwarePill = !!(checkPrinterFirmware && firmwareInfo?.current_version && firmwareInfo?.latest_version && firmwareInfo.update_available);
  const showDoorPill = !!(status?.connected && hasDoorSensor && status.door_open);
  const hasCockpitStatusPills = isMaintenanceMode ||
    showConnectionPill ||
    showPlateStatusPill ||
    showNetworkPill ||
    showHmsPill ||
    showMaintenancePill ||
    showFirmwarePill ||
    showDoorPill;
  const cockpitConnectionStatusPill = (
    <span
      className={`${cockpitStatusPillBase} ${
        status?.connected
          ? cockpitStatusOkClass
          : cockpitStatusErrorClass
      }`}
      title={cockpitStatusRowLabel(connectionTitle, status?.connected ? t('printers.connection.connected') : t('printers.connection.offline'))}
    >
      {status?.connected ? <Link className="h-3 w-3 shrink-0" /> : <Unlink className="h-3 w-3 shrink-0" />}
      <CockpitStatusRowText title={connectionTitle} state={status?.connected ? t('printers.connection.connected') : t('printers.connection.offline')} />
    </span>
  );
  const cockpitPlateStatusPill = showPlateStatusPill && cockpitPlateStatus ? (
    <span className={`${cockpitStatusPillBase} ${cockpitPlateStatus.className}`} title={cockpitStatusRowLabel(plateTitle, cockpitPlateStatus.label)}>
      <PlateClearedIcon className="h-3 w-3 shrink-0" />
      <CockpitStatusRowText title={plateTitle} state={cockpitPlateStatus.label} />
    </span>
  ) : null;
  const cockpitNetworkStatusPill = (
    <span
      className={`${cockpitStatusPillBase} ${networkClassName}`}
      title={cockpitStatusRowLabel(networkTitle, networkTitleLabel)}
    >
      {status?.wired_network ? <Cable className="h-3 w-3 shrink-0" /> : <Signal className="h-3 w-3 shrink-0" />}
      <CockpitStatusRowText title={networkTitle} state={networkStateLabel} />
    </span>
  );
  const cockpitHmsStatusPill = (
    <button
      type="button"
      onClick={() => status?.connected && setShowHMSModal(true)}
      className={`${cockpitStatusPillBase} text-left ${status?.connected ? 'cursor-pointer hover:opacity-80 transition-opacity' : 'cursor-default'} ${
        !status?.connected
          ? cockpitStatusErrorClass
          : knownHmsErrors.length > 0
          ? knownHmsErrors.some(e => e.severity <= 2)
            ? cockpitStatusErrorClass
            : cockpitStatusWarningClass
          : cockpitStatusOkClass
      }`}
      title={cockpitStatusRowLabel(errorsTitle, status?.connected ? (knownHmsErrors.length > 0 ? t('printers.status.errorCount', '{{count}} active', { count: knownHmsErrors.length }) : t('common.ok', 'OK')) : t('common.unknown', 'Unknown'))}
    >
      <AlertTriangle className="h-3 w-3 shrink-0" />
      <CockpitStatusRowText title={errorsTitle} state={status?.connected ? (knownHmsErrors.length > 0 ? t('printers.status.errorCount', '{{count}} active', { count: knownHmsErrors.length }) : t('common.ok', 'OK')) : t('common.unknown', 'Unknown')} />
    </button>
  );
  const cockpitMaintenanceStatusPill = (
    <button
      type="button"
      onClick={() => navigate('/maintenance')}
      className={`${cockpitStatusPillBase} cursor-pointer text-left hover:opacity-80 transition-opacity ${
        maintenanceDueCount > 0
          ? cockpitStatusErrorClass
          : maintenanceWarningCount > 0
          ? cockpitStatusWarningClass
          : cockpitStatusOkClass
      }`}
      title={cockpitStatusRowLabel(maintenanceTitle, maintenanceStateLabel)}
    >
      <Wrench className="h-3 w-3 shrink-0" />
      <CockpitStatusRowText title={maintenanceTitle} state={maintenanceStateLabel} />
    </button>
  );
  const cockpitFirmwareStatusPill = checkPrinterFirmware && firmwareInfo?.current_version && firmwareInfo?.latest_version ? (
    <button
      type="button"
      onClick={() => setShowFirmwareModal(true)}
      className={`${cockpitStatusPillBase} text-left hover:opacity-80 transition-opacity ${
        firmwareInfo.update_available
          ? cockpitStatusWarningClass
          : cockpitStatusOkClass
      }`}
      title={
        firmwareInfo.update_available
          ? t('printers.firmwareUpdateAvailable', { current: firmwareInfo.current_version, latest: firmwareInfo.latest_version })
          : t('printers.firmwareUpToDate', { version: firmwareInfo.current_version })
      }
    >
      {firmwareInfo.update_available ? <Download className="h-3 w-3 shrink-0" /> : <CheckCircle className="h-3 w-3 shrink-0" />}
      <CockpitStatusRowText title={firmwareTitle} state={firmwareInfo.update_available ? t('printers.status.updateAvailable', 'Update available') : t('common.ok', 'OK')} />
    </button>
  ) : null;
  const cockpitDoorStatusPill = status?.connected && hasDoorSensor ? (
    <span
      className={`${cockpitStatusPillBase} ${
        status?.door_open
          ? cockpitStatusWarningClass
          : cockpitStatusOkClass
      }`}
      title={cockpitStatusRowLabel(doorTitle, status?.door_open ? t('printers.door.open') : t('printers.door.closed'))}
    >
      {status?.door_open ? <DoorOpen className="h-3 w-3 shrink-0" /> : <DoorClosed className="h-3 w-3 shrink-0" />}
      <CockpitStatusRowText title={doorTitle} state={status?.door_open ? t('printers.door.open') : t('printers.door.closed')} />
    </span>
  ) : null;

  const recentPrints = printEntries.slice(0, 4);
  const reprintableRecentPrints = recentPrints.filter(entry => entry.archive_id != null).slice(0, 3);
  const controlBusy = stopPrintMutation.isPending || pausePrintMutation.isPending || resumePrintMutation.isPending;
  const canControl = !!status?.connected && hasPermission('printers:control');
  const canUseMachineTools = !!status?.connected && canControl;
  const canJog = canUseMachineTools && !isPrintingOrPaused;
  const isAirductCapable = ['P2S', 'X2D', 'H2D', 'H2D Pro', 'H2C', 'H2S'].includes(printer.model ?? '');
  const speedModes = [
    { mode: 1, label: t('printers.speed.silent', 'Silent') },
    { mode: 2, label: t('printers.speed.standard', 'Standard') },
    { mode: 3, label: t('printers.speed.sport', 'Sport') },
    { mode: 4, label: t('printers.speed.ludicrous', 'Ludicrous') },
  ];
  const iconControlClass = 'relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';
  const jogButtonClass = 'flex h-7 w-7 shrink-0 items-center justify-center rounded bg-indigo-500/15 text-indigo-300 transition-colors hover:bg-indigo-500/30 disabled:cursor-not-allowed disabled:opacity-50';
  const currentPrintLabel = activePrintName || t('printers.noActiveJob', 'No active job');
  const plateDetectionEnabled = plateDetectionMutation.isPending && plateDetectionMutation.variables != null
    ? plateDetectionMutation.variables
    : printer.plate_detection_enabled;
  const requestBedJog = (distance: number) => {
    const warnedKey = `bambuddy.bedJog.warned.${printer.id}`;
    let warned = false;
    try {
      warned = sessionStorage.getItem(warnedKey) === '1';
    } catch {
      // Session storage can be unavailable in privacy-restricted browsers.
    }
    if (warned) {
      bedJogMutation.mutate({ distance, force: true });
    } else {
      setShowNotHomedModal({ distance });
    }
  };
  const jogPanel = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-bambu-gray">{t('printers.single.jog')}</span>
        <div className="h-[2px] flex-1 bg-bambu-dark-tertiary" />
      </div>
      <div className="flex flex-1 items-center justify-center gap-3 px-3 py-2">
        <div className="flex items-center justify-center gap-3">
          <div className="grid grid-cols-3 gap-1">
            <div />
            <button type="button" className={jogButtonClass} disabled={!canJog || xyJogMutation.isPending} onClick={() => xyJogMutation.mutate({ x: 0, y: jogStep })} aria-label={t('printers.single.moveYForward')}><ArrowUp className="h-4 w-4" /></button>
            <div />
            <button type="button" className={jogButtonClass} disabled={!canJog || xyJogMutation.isPending} onClick={() => xyJogMutation.mutate({ x: -jogStep, y: 0 })} aria-label={t('printers.single.moveXLeft')}><ArrowLeft className="h-4 w-4" /></button>
            <button type="button" className={jogButtonClass} disabled={!canJog || homeAxesMutation.isPending} onClick={() => homeAxesMutation.mutate('all')} aria-label={t('printers.bedJog.homeZ')}><Home className="h-4 w-4" /></button>
            <button type="button" className={jogButtonClass} disabled={!canJog || xyJogMutation.isPending} onClick={() => xyJogMutation.mutate({ x: jogStep, y: 0 })} aria-label={t('printers.single.moveXRight')}><ArrowRight className="h-4 w-4" /></button>
            <div />
            <button type="button" className={jogButtonClass} disabled={!canJog || xyJogMutation.isPending} onClick={() => xyJogMutation.mutate({ x: 0, y: -jogStep })} aria-label={t('printers.single.moveYBack')}><ArrowDown className="h-4 w-4" /></button>
            <div />
          </div>
          <div className="flex flex-col items-center gap-1">
            <button type="button" className={jogButtonClass} disabled={!canJog || bedJogMutation.isPending} onClick={() => requestBedJog(-jogStep)} aria-label={t('printers.bedJog.up')}><ArrowUp className="h-4 w-4" /></button>
            <div className="flex h-7 w-7 items-center justify-center text-bambu-gray/80"><Layers className="h-4 w-4" /></div>
            <button type="button" className={jogButtonClass} disabled={!canJog || bedJogMutation.isPending} onClick={() => requestBedJog(jogStep)} aria-label={t('printers.bedJog.down')}><ArrowDown className="h-4 w-4" /></button>
          </div>
          <div className="flex flex-col items-center gap-1">
            <button type="button" className={jogButtonClass} disabled={!canJog || extruderJogMutation.isPending} onClick={() => extruderJogMutation.mutate(-jogStep)} aria-label={t('printers.single.retractFilament')}><ArrowUp className="h-4 w-4" /></button>
            <div className="flex h-7 w-7 items-center justify-center text-bambu-gray/80"><span className="text-sm font-semibold leading-none">E</span></div>
            <button type="button" className={jogButtonClass} disabled={!canJog || extruderJogMutation.isPending} onClick={() => extruderJogMutation.mutate(jogStep)} aria-label={t('printers.single.extrudeFilament')}><ArrowDown className="h-4 w-4" /></button>
          </div>
        </div>
        <div className="self-stretch border-l border-bambu-dark-tertiary" />
        <div className="flex min-w-20 flex-col gap-1">
          <div className="text-center text-[10px] font-semibold uppercase leading-tight tracking-wider text-white">{t('printers.bedJog.step')}</div>
          <div className="grid gap-1">
            {[1, 10, 50, 100].map((step) => (
              <button key={step} type="button" onClick={() => setJogStep(step)} className={`rounded px-2 py-1 text-[10px] transition-colors ${jogStep === step ? 'bg-indigo-500/20 text-indigo-300' : 'bg-bambu-dark text-bambu-gray hover:bg-bambu-dark-tertiary'}`}>
                {step}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  const renderCockpitFilamentSlot = (tray: AMSUnit['tray'][number] | undefined, amsId: number, trayId: number, trayCount: number) => {
    const isEmpty = !tray?.tray_type;
    const emptyKind = getEmptySlotKind(tray);
    const globalTrayId = getGlobalTrayId(amsId, trayId, amsId === 255);
    const isActive = status?.tray_now === globalTrayId;
    const cloudInfo = tray?.tray_info_idx ? cockpitFilamentInfo?.[tray.tray_info_idx] : null;
    const slotPreset = cockpitSlotPresets?.[getSlotPresetKey(amsId, trayId)];
    const isRefreshing = refreshingSlot?.amsId === amsId && refreshingSlot.slotId === trayId;
    const localAssignment = onGetAssignment?.(printer.id, amsId, trayId);
    const slotModel = resolveAmsSlotModel({
      tray,
      printerId: printer.id,
      printerSerial: printer.serial_number,
      amsId,
      trayId,
      slotPreset,
      cloudInfo,
      spoolmanEnabled,
      spoolmanLoading,
      linkedSpools,
      spoolmanSpools,
      spoolmanSlotAssignments,
      inventoryAssignment: localAssignment,
    });
    const { fillLevel } = slotModel;
    const slotActions = <AmsSlotActions
      includeRfid={amsId !== 255}
      isPrinting={status?.state === 'RUNNING'}
      isRefreshing={isRefreshing}
      canReadRfid={hasPermission('printers:ams_rfid')}
      canControl={hasPermission('printers:control')}
      onRefresh={() => refreshAmsSlotMutation.mutate({ amsId, slotId: trayId })}
      onLoad={() => loadAmsTrayMutation.mutate(globalTrayId)}
      onUnload={() => unloadAmsMutation.mutate()}
    />;
    return (
      <div key={trayId} className="relative min-w-14">
        {isRefreshing && <div className="absolute inset-0 z-20 flex items-center justify-center rounded bg-bambu-dark-tertiary/80"><RefreshCw className="h-4 w-4 animate-spin text-bambu-green" /></div>}
        <AmsSlot
          controller={amsSlotController}
          slot={{
            amsId,
            trayId,
            trayCount,
            tray,
            slotPreset,
            location: `${getAmsLabel(amsId, trayCount)} Slot ${trayId + 1}`,
            model: slotModel,
          }}
          emptyKind={emptyKind}
          actions={slotActions}
        >
          {bindings => <button
              type="button"
              onClick={bindings.configureSlot.onConfigure}
              disabled={!hasPermission('printers:control')}
              className={`w-full rounded-lg bg-bambu-dark-secondary p-1 text-center transition-colors hover:bg-bambu-dark-tertiary disabled:cursor-not-allowed ${isEmpty ? 'opacity-60' : ''} ${isActive ? 'ring-2 ring-bambu-green ring-offset-1 ring-offset-bambu-dark' : ''}`}
            >
              <FilamentSlotCircle trayColor={tray?.tray_color} trayType={tray?.tray_type} isEmpty={isEmpty} emptyKind={emptyKind} slotNumber={trayId + 1} />
              <div className="truncate text-[9px] font-bold text-white">{tray?.tray_type || t(emptyKind === 'reset' ? 'ams.slotUnconfigured' : 'ams.slotEmpty')}</div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-black/30">
                {fillLevel != null && !isEmpty && <div className="h-full rounded-full" style={{ width: `${fillLevel}%`, backgroundColor: getFillBarColor(fillLevel) }} />}
              </div>
            </button>}
        </AmsSlot>
        </div>
    );
  };

  const filamentPanel = ((status?.ams?.length ?? 0) > 0 || (status?.vt_tray?.length ?? 0) > 0) ? (
    <section data-testid="cockpit-filament-pane" className="flex min-w-0 flex-col">
      <div className="mb-2 flex shrink-0 items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-bambu-gray">{t('printers.filaments')}</span>
        <AmsBackupBadge
          state={status?.ams_filament_backup ?? null}
          onClick={() => setAmsBackupModalOpen(true)}
        />
        <div className="h-[2px] flex-1 bg-bambu-dark-tertiary" />
      </div>
      <div data-testid="cockpit-filament-scroll" className="grid min-w-0 gap-2">
        {status?.ams?.map((ams) => (
          <CompactAmsUnitCard key={ams.id} amsId={ams.id}>
            <div className="mb-1.5">
              <AmsUnitHeader
                testId={`cockpit-ams-header-${ams.id}`}
                controlsTestId={`cockpit-ams-indicators-${ams.id}`}
                label={<AmsNameHoverCard
                  ams={ams}
                  printerId={printer.id}
                  label={getAmsLabel(ams.id, ams.tray.length)}
                  amsLabels={amsLabels}
                  canEdit={hasPermission('printers:update')}
                  onSaved={refetchAmsLabels}
                >
                  <span className="block truncate text-[10px] font-medium text-white cursor-default select-none">
                    {amsLabels?.[ams.id] || getAmsLabel(ams.id, ams.tray.length)}
                  </span>
                </AmsNameHoverCard>}
                environment={<AmsEnvironmentIndicators
                  ams={ams}
                  thresholds={amsThresholds}
                  onHumidityClick={() => setAmsHistoryModal({ amsId: ams.id, amsLabel: getAmsLabel(ams.id, ams.tray.length), mode: 'humidity' })}
                  onTemperatureClick={() => setAmsHistoryModal({ amsId: ams.id, amsLabel: getAmsLabel(ams.id, ams.tray.length), mode: 'temperature' })}
                />}
                dryingControl={<AmsDryingControl
                  ams={ams}
                  supportsDrying={status?.supports_drying === true}
                  canControl={hasPermission('printers:control')}
                  controller={dryingControls}
                />}
              />
            </div>
            {ams.dry_time > 0 && <div className="mb-1.5"><AmsDryingStatus ams={ams} controller={dryingControls} canControl={hasPermission('printers:control')} /></div>}
            <AmsSlotGrid ams={ams} variant="compact" renderSlot={(tray, slotIdx) => renderCockpitFilamentSlot(tray, ams.id, slotIdx, ams.tray.length)} />
          </CompactAmsUnitCard>
        ))}
        {(status?.vt_tray?.length ?? 0) > 0 && (
          <div className="rounded-lg bg-bambu-dark p-2">
            <div className="mb-1.5 flex min-h-7 items-center rounded-lg bg-bambu-dark-secondary px-2 py-1">
              <span className="truncate text-[10px] font-medium text-white">{t('printers.external')}</span>
            </div>
            <div className={`grid gap-1 ${status!.vt_tray.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
              {[...status!.vt_tray].sort((a, b) => (a.id ?? 254) - (b.id ?? 254)).map((tray) => renderCockpitFilamentSlot(tray, 255, (tray.id ?? 254) - 254, status!.vt_tray.length))}
            </div>
          </div>
        )}
      </div>
    </section>
  ) : null;

  const printerActionsMenu = (
    <PrinterActionsMenu
      printer={printer}
      isOpen={showMenu}
      menuRef={printerActionsMenuRef}
      triggerClassName="h-9 min-h-9 w-9 px-0 py-0"
      menuClassName="absolute right-0 top-full z-30 mt-2 w-48 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-lg"
      maintenancePending={maintenanceMutation.isPending}
      forceRefreshPending={forceRefreshMutation.isPending}
      onToggle={() => setShowMenu(!showMenu)}
      onEdit={() => {
        setShowEditModal(true);
        setShowMenu(false);
      }}
      onInfo={() => {
        setShowPrinterInfo(true);
        setShowMenu(false);
      }}
      onToggleMaintenance={() => {
        setShowMenu(false);
        if (printer.is_active !== false) {
          handleEnterMaintenance();
        } else {
          maintenanceMutation.mutate(true);
        }
      }}
      onReconnect={() => {
        connectMutation.mutate();
        setShowMenu(false);
      }}
      onForceRefresh={() => {
        forceRefreshMutation.mutate();
        setShowMenu(false);
      }}
      onMqttDebug={() => {
        setShowMQTTDebug(true);
        setShowMenu(false);
      }}
      onDiagnostic={() => {
        setShowDiagnostic(true);
        setShowMenu(false);
      }}
      onDelete={() => {
        setShowDeleteConfirm(true);
        setShowMenu(false);
      }}
    />
  );

  const stateActionPanel = showClearPlateButton ? (
    <button
      type="button"
      onClick={() => clearPlateMutation.mutate()}
      disabled={clearPlateMutation.isPending || !hasPermission('printers:clear_plate')}
      className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-yellow-500/20 px-3 text-sm font-medium text-yellow-400 transition-colors hover:bg-yellow-500/30 disabled:cursor-not-allowed disabled:opacity-50"
      title={!hasPermission('printers:clear_plate') ? t('printers.permission.noControl') : t('printers.plateStatus.markCleared')}
    >
      {clearPlateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlateClearedIcon className="h-4 w-4" />}
      {t('printers.plateStatus.markCleared')}
    </button>
  ) : isPrintingOrPaused ? (
    <div className="grid grid-cols-2 gap-2">
      <button
        type="button"
        onClick={() => (isPaused ? resumePrintMutation.mutate() : pausePrintMutation.mutate())}
        disabled={!canControl || controlBusy}
        className={`flex h-10 items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          isPaused
            ? 'bg-bambu-green/20 text-bambu-green hover:bg-bambu-green/30'
            : 'bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30'
        }`}
      >
        {isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
        {isPaused ? t('printers.resume') : t('printers.pause')}
      </button>
      <button
        type="button"
        onClick={() => setShowStopConfirm(true)}
        disabled={!canControl || controlBusy}
        className="flex h-10 items-center justify-center gap-2 rounded-lg bg-red-500/20 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/30 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Square className="h-4 w-4" />
        {t('printers.stop')}
      </button>
    </div>
  ) : null;

  const primaryActionPanel = (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setShowUploadForPrint(true)}
        disabled={!hasPermission('queue:create')}
        className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-bambu-green px-3 text-sm font-medium text-white transition-colors hover:bg-bambu-green-light disabled:cursor-not-allowed disabled:opacity-50"
      >
        <PrinterIcon className="h-4 w-4" />
        {t('common.print')}
      </button>
      {stateActionPanel}
    </div>
  );

  const quickControlsPanel = (
    <div className="mt-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-bambu-gray">
          {t('printers.controls')}
        </span>
        <div className="h-[2px] flex-1 bg-bambu-dark-tertiary" />
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button
          type="button"
          className={`${iconControlClass} ${
            status?.chamber_light
              ? 'bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20'
              : 'bg-bambu-dark-tertiary/70 text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white'
          }`}
          onClick={() => chamberLightMutation.mutate(!status?.chamber_light)}
          disabled={!canUseMachineTools || chamberLightMutation.isPending}
          aria-label={status?.chamber_light ? t('printers.chamberLightOff') : t('printers.chamberLightOn')}
          title={status?.chamber_light ? t('printers.chamberLightOff') : t('printers.chamberLightOn')}
        >
          <ChamberLight on={!!status?.chamber_light} className="h-4 w-4" />
        </button>
        <PrinterPlateDetectionControl
          printer={printer}
          status={status}
          enabled={plateDetectionEnabled}
          connected={!!status?.connected}
          canUpdate={hasPermission('printers:update')}
          togglePending={plateDetectionMutation.isPending}
          iconControlClass={iconControlClass}
          inactiveClassName="bg-bambu-dark-tertiary/70 text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white"
          onToggle={() => plateDetectionMutation.mutate(!plateDetectionEnabled)}
        />
        <button
          type="button"
          onClick={() => canControl && isPrintingOrPaused && setStatusControlMenu(statusControlMenu === 'speed' ? null : 'speed')}
          disabled={!isPrintingOrPaused || !canControl || printSpeedMutation.isPending}
          className={`${iconControlClass} ${
            isPrintingOrPaused && canControl
              ? 'bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'
              : 'bg-bambu-dark-tertiary/70 text-bambu-gray disabled:opacity-60'
          }`}
          aria-label={t('printers.speed.title')}
          title={t('printers.speed.title')}
        >
          <Gauge className="h-4 w-4" />
          {statusControlMenu === 'speed' && (
            <IndicatorControlPopover
              title={t('printers.speed.title')}
              isPending={printSpeedMutation.isPending}
              options={speedModes.map(({ mode, label }) => ({ label, value: mode }))}
              onClose={() => setStatusControlMenu(null)}
              onSubmit={(mode) => printSpeedMutation.mutate(mode)}
            />
          )}
        </button>
        <button
          type="button"
          onClick={() => setShowSkipObjectsModal(true)}
          disabled={!isPrintingOrPaused || (status?.printable_objects_count ?? 0) < 2 || !canControl}
          className={`${iconControlClass} ${
            isPrintingOrPaused && (status?.printable_objects_count ?? 0) >= 2 && canControl
              ? 'bg-bambu-dark-tertiary/70 text-white hover:bg-bambu-dark-tertiary'
              : 'bg-bambu-dark-tertiary/70 text-bambu-gray disabled:opacity-60'
          }`}
          aria-label={
            !hasPermission('printers:control')
              ? t('printers.permission.noControl')
              : !isPrintingOrPaused
                ? t('printers.skipObjects.onlyWhilePrinting')
                : (status?.printable_objects_count ?? 0) >= 2
                  ? t('printers.skipObjects.tooltip')
                  : t('printers.skipObjects.requiresMultiple')
          }
          title={
            !hasPermission('printers:control')
              ? t('printers.permission.noControl')
              : !isPrintingOrPaused
                ? t('printers.skipObjects.onlyWhilePrinting')
                : (status?.printable_objects_count ?? 0) >= 2
                  ? t('printers.skipObjects.tooltip')
              : t('printers.skipObjects.requiresMultiple')
          }
        >
          <SkipObjectsIcon className="h-4 w-4" />
          {objectsData && objectsData.skipped_count > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
              {objectsData.skipped_count}
            </span>
          )}
        </button>
        <PrinterAirductControl
          isCapable={isAirductCapable}
          mode={status?.airduct_mode}
          isOpen={statusControlMenu === 'airduct'}
          disabled={!canUseMachineTools || airductMutation.isPending}
          buttonClassName={iconControlClass}
          onToggleMenu={() => setStatusControlMenu(statusControlMenu === 'airduct' ? null : 'airduct')}
          onCloseMenu={() => setStatusControlMenu(null)}
          onSelectMode={(mode) => airductMutation.mutate(mode)}
        />
      </div>
    </div>
  );

  const machineControlsPanel = (
    <section ref={cockpitMachineControlsContentRef} data-testid="cockpit-machine-controls-content" className="h-full min-h-0 rounded-xl border border-white/10 bg-bambu-dark/80 p-3">
      <div ref={cockpitMachineControlsInnerRef} className="grid h-full min-h-0 gap-3 xl:grid-cols-[minmax(0,3fr)_1px_minmax(0,2fr)]">
        <div ref={cockpitMachineControlsPrimaryRef} className="min-w-0 self-start">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-bambu-gray">
              {t('printers.status.title', 'Status')}
            </span>
            <div className="h-[2px] flex-1 bg-bambu-dark-tertiary" />
          </div>
          <PrinterThermalControls
            printer={printer}
            status={status}
            variant="elevated"
            nozzleTempPresets={nozzleTempPresets}
            bedTempPresets={bedTempPresets}
            chamberTempPresets={chamberTempPresets}
            fanSpeedPresets={fanSpeedPresets}
          />
          {quickControlsPanel}
        </div>
        <div className="hidden self-stretch bg-bambu-dark-tertiary xl:block" />
        <div className="min-w-0 xl:h-full">
          <div ref={cockpitJogControlsRef} className="w-full xl:h-full">{jogPanel}</div>
        </div>
      </div>
    </section>
  );

  const statsPanel = (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-bambu-gray">
          {t('stats.title')}
        </span>
        <div className="h-[2px] flex-1 bg-bambu-dark-tertiary" />
      </div>
      <div className="grid min-h-0 grid-cols-2 gap-1.5 sm:grid-cols-3 xl:grid-cols-2 2xl:grid-cols-3">
        <CockpitMetricCard compact icon={BarChart3} label={t('stats.successRate', 'Success rate')} value={`${printerStats.successRate}%`} detail={`${printerStats.completed} / ${printerStats.failed} / ${printerStats.cancelled}`} />
        <CockpitMetricCard compact icon={Package} label={t('stats.totalPrints', 'Total prints')} value={`${printLog?.total ?? printEntries.length}`} detail={t('stats.topFilament', 'Top filament: {{filament}}', { filament: printerStats.topFilament })} />
        <CockpitMetricCard compact icon={Clock} label={t('stats.printTime', 'Print time')} value={`${printerStats.durationHours.toFixed(1)}h`} detail={`${maintenanceInfo?.total_print_hours?.toFixed(1) ?? '0.0'}h ${t('maintenance.title', 'Maintenance')}`} />
        <CockpitMetricCard compact icon={Package} label={t('stats.filamentUsed', 'Filament used')} value={formatCockpitWeight(printerStats.filamentGrams)} detail={`${currencySymbol}${printerStats.totalCost.toFixed(2)} ${t('stats.filamentCost', 'filament cost')}`} />
        <CockpitMetricCard compact icon={Clock} label={t('stats.longestPrint', 'Longest Print')} value={printerStats.longestPrintSeconds > 0 ? formatDuration(printerStats.longestPrintSeconds) : '---'} detail={printerStats.longestPrintName || t('stats.fromPrintHistory', 'From print history')} />
        <CockpitMetricCard compact icon={Timer} label={t('stats.averagePrintTime', 'Average time')} value={printerStats.averageDurationSeconds != null ? formatDuration(Math.round(printerStats.averageDurationSeconds)) : '---'} detail={t('stats.completedPrintAverage', 'Completed prints')} />
      </div>
    </section>
  );

  useLayoutEffect(() => {
    const detail = cockpitDetailRef.current;
    const grid = cockpitDetailGridRef.current;
    const controls = cockpitMachineControlsRef.current;
    const controlsContent = cockpitMachineControlsContentRef.current;
    const controlsInner = cockpitMachineControlsInnerRef.current;
    const controlsPrimary = cockpitMachineControlsPrimaryRef.current;
    const jogControls = cockpitJogControlsRef.current;
    if (!detail || !grid || !controls || !controlsContent || !controlsInner || !controlsPrimary || !jogControls) return;
    if (typeof ResizeObserver === 'undefined') return;

    const measureCameraColumn = () => {
      // The camera and controls share one column. The camera stays 16:9, while
      // the controls use their natural content height and the status pane takes
      // the remaining horizontal space.
      if (detail.clientWidth < 640) {
        setCockpitCameraColumnWidth(null);
        setCockpitControlsHeight(null);
        return;
      }

      const gridStyles = window.getComputedStyle(grid);
      const cameraControlsStyles = window.getComputedStyle(controls.parentElement!);
      const horizontalPadding = Number.parseFloat(gridStyles.paddingLeft) + Number.parseFloat(gridStyles.paddingRight);
      const verticalPadding = Number.parseFloat(gridStyles.paddingTop) + Number.parseFloat(gridStyles.paddingBottom);
      const columnGap = Number.parseFloat(gridStyles.columnGap) || 0;
      const cameraControlsGap = Number.parseFloat(cameraControlsStyles.rowGap) || 0;
      const controlsContentStyles = window.getComputedStyle(controlsContent);
      const controlsInnerStyles = window.getComputedStyle(controlsInner);
      const isTwoColumnControls = controlsInnerStyles.gridTemplateColumns.trim().split(/\s+/).length > 1;
      const naturalInnerHeight = isTwoColumnControls
        ? controlsPrimary.getBoundingClientRect().height
        : controlsPrimary.getBoundingClientRect().height + jogControls.getBoundingClientRect().height + (Number.parseFloat(controlsInnerStyles.rowGap) || 0);
      const naturalControlsHeight = Math.ceil(
        naturalInnerHeight
        + Number.parseFloat(controlsContentStyles.paddingTop)
        + Number.parseFloat(controlsContentStyles.paddingBottom)
        + Number.parseFloat(controlsContentStyles.borderTopWidth)
        + Number.parseFloat(controlsContentStyles.borderBottomWidth),
      );
      const controlsHeight = Math.max(
        naturalControlsHeight,
        Math.ceil((grid.clientHeight - verticalPadding) * 0.3),
      );
      const availableWidth = grid.clientWidth - horizontalPadding - columnGap;
      const availableCameraHeight = grid.clientHeight - verticalPadding - controlsHeight - cameraControlsGap;
      const nextWidth = Math.max(0, Math.min(availableWidth, availableCameraHeight * (16 / 9)));

      setCockpitCameraColumnWidth((currentWidth) => (
        currentWidth !== null && Math.abs(currentWidth - nextWidth) < 1 ? currentWidth : nextWidth
      ));
      setCockpitControlsHeight((currentHeight) => (
        currentHeight !== null && Math.abs(currentHeight - controlsHeight) < 1 ? currentHeight : controlsHeight
      ));
    };

    const observer = new ResizeObserver(measureCameraColumn);
    observer.observe(detail);
    observer.observe(controls);
    observer.observe(controlsContent);
    observer.observe(controlsInner);
    observer.observe(controlsPrimary);
    observer.observe(jogControls);
    measureCameraColumn();
    return () => observer.disconnect();
  }, []);

  return (
    <>
    <div
      ref={cockpitDetailRef}
      className="cockpit-detail-container relative h-full min-h-0 overflow-hidden rounded-xl border border-bambu-dark-tertiary bg-gradient-to-br from-bambu-dark-secondary via-bambu-dark to-bambu-dark-secondary shadow-xl"
      style={{
        ...(cockpitCameraColumnWidth === null ? {} : { '--cockpit-camera-column-width': `${cockpitCameraColumnWidth}px` }),
        ...(cockpitControlsHeight === null ? {} : { '--cockpit-controls-height': `${cockpitControlsHeight}px` }),
      } as CSSProperties}
    >
      <div ref={cockpitDetailGridRef} data-testid="cockpit-detail-grid" className="cockpit-detail-grid relative grid h-full min-h-0 gap-3 p-3">
        <div className="cockpit-camera-controls grid min-h-0 gap-3">
          <section data-testid="cockpit-camera-panel" className="relative h-full min-h-0 w-full overflow-hidden rounded-xl border border-white/10 bg-bambu-dark">
            <CameraPlaceholder
              model={printer.model}
              className="absolute inset-0 h-full w-full object-cover"
            />
            {status?.connected && !cameraFailed && (
              <img
                ref={cameraImageRef}
                key={printer.id}
                src={cameraStreamUrl}
                alt={t('printers.cameraFeed', '{{printer}} camera', { printer: printer.name })}
                className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${cameraLoaded ? 'opacity-100' : 'opacity-0'}`}
                style={{ transform: printer.camera_rotation ? `rotate(${printer.camera_rotation}deg)` : undefined }}
                onLoad={() => setLoadedCameraPrinterId(printer.id)}
                onError={() => setFailedCameraPrinterId(printer.id)}
              />
            )}
            <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/65 via-black/30 to-transparent" />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-black/70 via-black/35 to-transparent" />
            <div className="relative flex h-full min-h-0 flex-col gap-3 p-4">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-3">
                  <h2 className="min-w-0 flex-1 truncate text-3xl font-semibold leading-none text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)]">{printer.name}</h2>
                  {printerActionsMenu}
                  <div className="relative flex shrink-0 flex-col items-end">
                    <PrinterHealthMenu
                      printer={printer}
                      status={status}
                      printerHealth={printerHealth}
                      knownHmsErrors={knownHmsErrors}
                      maintenanceInfo={maintenanceInfo}
                      requirePlateClear={requirePlateClear}
                      needsPlateClear={needsPlateClear}
                      firmwareInfo={firmwareInfo}
                      hasDoorSensor={hasDoorSensor}
                      checkPrinterFirmware={checkPrinterFirmware}
                      triggerClassName="h-9 w-9"
                    />
                    {hasCockpitStatusPills && (
                      <div className="absolute right-0 top-full z-20 mt-2 w-48 space-y-1.5">
                        {isMaintenanceMode && (
                          <span className={`${cockpitStatusPillBase} border-amber-400/50 text-amber-400`}>
                            <Wrench className="h-3 w-3 shrink-0" />
                            <CockpitStatusRowText title={maintenanceTitle} state={t('printers.maintenance.pillLabel', 'Maintenance')} />
                          </span>
                        )}
                        {showConnectionPill && cockpitConnectionStatusPill}
                        {cockpitPlateStatusPill}
                        {!isMaintenanceMode && !status?.connected && (
                          <button
                            type="button"
                            onClick={() => setShowDiagnostic(true)}
                            className={`${cockpitStatusPillBase} ${cockpitStatusWarningClass} cursor-pointer text-left hover:opacity-80 transition-opacity`}
                            title={cockpitStatusRowLabel(t('diagnostic.title', 'Diagnostic'), t('diagnostic.runButton'))}
                          >
                            <Stethoscope className="h-3 w-3 shrink-0" />
                            <CockpitStatusRowText title={t('diagnostic.title', 'Diagnostic')} state={t('diagnostic.runButton')} />
                          </button>
                        )}
                        {showNetworkPill && cockpitNetworkStatusPill}
                        {showHmsPill && cockpitHmsStatusPill}
                        {showMaintenancePill && cockpitMaintenanceStatusPill}
                        {showFirmwarePill && cockpitFirmwareStatusPill}
                        {showDoorPill && cockpitDoorStatusPill}
                      </div>
                    )}
                  </div>
                </div>
                <p className="truncate pl-0.5 text-base leading-tight text-white/80 drop-shadow-[0_2px_5px_rgba(0,0,0,0.9)]">
                  {printer.model || t('common.unknown', 'Unknown')}
                  {printer.location ? ` - ${printer.location}` : ''}
                </p>
              </div>

              <div className="min-h-0 flex-1" />

              <div className="min-w-0">
                {currentPrintUser && isPrintingOrPaused && (
                  <div data-testid="cockpit-print-owner" className="mb-1 flex items-center gap-1.5 text-xs font-medium text-white/90 drop-shadow-[0_2px_5px_rgba(0,0,0,0.9)]" title={`Started by ${currentPrintUser}`}>
                    <User className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{currentPrintUser}</span>
                  </div>
                )}
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p data-testid="cockpit-current-print" className="min-w-0 flex-1 truncate text-xl font-semibold text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)]">{currentPrintLabel}</p>
                  <span className="shrink-0 text-3xl font-semibold tabular-nums text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)]">
                    {isPrintingOrPaused ? `${Math.round(progress)}%` : '---'}
                  </span>
                </div>
                <div className="h-3 overflow-hidden rounded-full bg-black/60 shadow-[0_1px_8px_rgba(0,0,0,0.45)] ring-1 ring-white/15">
                  <div className="h-full rounded-full bg-gradient-to-r from-bambu-green to-emerald-300 transition-all" style={{ width: `${isPrintingOrPaused ? progress : 0}%` }} />
                </div>
              </div>
            </div>
          </section>

          <div ref={cockpitMachineControlsRef} data-testid="cockpit-machine-controls-panel" className="min-h-0 h-full">
            {machineControlsPanel}
          </div>
        </div>

        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3">
          <section data-testid="cockpit-actions-panel" className="rounded-xl border border-white/10 bg-bambu-dark/80 p-3">
            {primaryActionPanel}
            <PrinterQueueWidget
              printerId={printer.id}
              printerModel={printer.model}
              loadedFilamentTypes={loadedFilamentTypes}
              loadedFilaments={loadedFilaments}
              variant="panelExtension"
            />
          </section>

          <div data-testid="cockpit-status-pane" className="min-h-0 overflow-y-auto overscroll-contain rounded-xl border border-white/10 bg-bambu-dark/80 p-3">
            <div className="grid gap-4">
              <PrinterPowerControls key={printer.id} printer={printer} isPrintingOrPaused={isPrintingOrPaused} />
              {filamentPanel}
              {statsPanel}
            </div>
          </div>
        </div>
        </div>
      </div>
    {showUploadForPrint && (
      <FileUploadModal
        folderId={null}
        onClose={() => setShowUploadForPrint(false)}
        onUploadComplete={() => {}}
        autoUpload
        accept=".gcode,.3mf"
        validateFile={(file) => {
          const lower = file.name.toLowerCase();
          if (!lower.endsWith('.gcode') && !lower.includes('.gcode.')) {
            return t('printers.dropNotPrintable', 'Only .gcode and .gcode.3mf files can be printed');
          }
        }}
        onFileUploaded={(uploadedFile) => {
          const slicedFor = (uploadedFile.metadata as Record<string, unknown>)?.sliced_for_model as string | undefined;
          const printerModel = mapModelCode(printer.model);
          if (slicedFor && printerModel && slicedFor.toLowerCase() !== printerModel.toLowerCase()) {
            api.deleteLibraryFile(uploadedFile.id).catch(() => {});
            return t('printers.incompatibleFile', 'This file was sliced for {{slicedFor}}, but this printer is a {{printerModel}}', { slicedFor, printerModel });
          }
          setShowUploadForPrint(false);
          setPrintAfterUpload({ id: uploadedFile.id, filename: uploadedFile.filename });
        }}
        beforeDropZone={reprintableRecentPrints.length > 0 ? (
          <section>
            <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-bambu-gray">
              {t('printers.single.quickReprint', 'Quick reprint')}
            </div>
            <div className="grid gap-1.5">
              {reprintableRecentPrints.map(entry => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => {
                    setShowUploadForPrint(false);
                    setReprintEntry(entry);
                  }}
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-md bg-bambu-dark px-2.5 py-2 text-left transition-colors hover:bg-bambu-dark-tertiary"
                >
                  <span className="truncate text-xs text-white">{entry.print_name || t('archives.untitledPrint', 'Untitled print')}</span>
                  <span className="text-[11px] text-bambu-gray">{formatDateOnly(entry.completed_at || entry.started_at || entry.created_at, { month: 'short', day: 'numeric' })}</span>
                </button>
              ))}
            </div>
          </section>
        ) : undefined}
      />
    )}
    {printAfterUpload && (
      <PrintModal
        mode="create"
        libraryFileId={printAfterUpload.id}
        archiveName={printAfterUpload.filename}
        initialSelectedPrinterIds={[printer.id]}
        onClose={() => setPrintAfterUpload(null)}
        onSuccess={() => setPrintAfterUpload(null)}
        cleanupLibraryAfterDispatch
      />
    )}
    {reprintEntry?.archive_id && (
      <PrintModal
        mode="create"
        archiveId={reprintEntry.archive_id}
        archiveName={reprintEntry.print_name || t('archives.untitledPrint', 'Untitled print')}
        initialSelectedPrinterIds={[printer.id]}
        onClose={() => setReprintEntry(null)}
        onSuccess={() => setReprintEntry(null)}
      />
    )}
    {showDeleteConfirm && (
      <PrinterDeleteConfirmModal
        printer={printer}
        deleteArchives={deleteArchives}
        onDeleteArchivesChange={setDeleteArchives}
        onCancel={() => {
          setShowDeleteConfirm(false);
          setDeleteArchives(true);
        }}
        onConfirm={() => {
          deleteMutation.mutate({ deleteArchives });
          setShowDeleteConfirm(false);
          setDeleteArchives(true);
        }}
      />
    )}
    {showMQTTDebug && (
      <MQTTDebugModal
        printerId={printer.id}
        printerName={printer.name}
        onClose={() => setShowMQTTDebug(false)}
      />
    )}
    {showDiagnostic && (
      <ConnectionDiagnosticModal
        printerId={printer.id}
        printerName={printer.name}
        onClose={() => setShowDiagnostic(false)}
      />
    )}
    {showHMSModal && (
      <HMSErrorModal
        printerName={printer.name}
        errors={status?.hms_errors || []}
        onClose={() => setShowHMSModal(false)}
        printerId={printer.id}
        hasPermission={hasPermission}
      />
    )}
    {showFirmwareModal && firmwareInfo && (
      <FirmwareUpdateModal
        printer={printer}
        firmwareInfo={firmwareInfo}
        onClose={() => setShowFirmwareModal(false)}
      />
    )}
    {showPrinterInfo && (
      <PrinterInfoModal
        printer={printer}
        status={status}
        totalPrintHours={maintenanceInfo?.total_print_hours}
        onClose={() => setShowPrinterInfo(false)}
      />
    )}
    {showEditModal && (
      <EditPrinterModal
        printer={printer}
        onClose={() => setShowEditModal(false)}
      />
    )}
    {confirmMaintenanceEnter && (
      <ConfirmModal
        title={t('printers.maintenance.confirmMidPrintTitle')}
        message={t('printers.maintenance.confirmMidPrintMessage', { name: printer.name })}
        confirmText={t('printers.maintenance.menuEnter')}
        variant="danger"
        onConfirm={() => {
          maintenanceMutation.mutate(false);
          setConfirmMaintenanceEnter(false);
        }}
        onCancel={() => setConfirmMaintenanceEnter(false)}
      />
    )}
    <PrinterStopPrintConfirmation
      printerName={printer.name}
      isOpen={showStopConfirm}
      onStop={() => stopPrintMutation.mutate()}
      onClose={() => setShowStopConfirm(false)}
    />
    <AmsSlotControllerModals controller={amsSlotController} />
    {showNotHomedModal && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
        <div className="w-full max-w-sm rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary p-5 shadow-xl">
          <div className="mb-4 flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-yellow-400" />
            <div>
              <h3 className="mb-1 text-sm font-semibold text-white">{t('printers.bedJog.notHomedTitle')}</h3>
              <p className="text-xs leading-relaxed text-bambu-gray">{t('printers.bedJog.notHomedMessage')}</p>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => {
                homeAxesMutation.mutate('all');
                setShowNotHomedModal(null);
              }}
              className="w-full rounded-lg bg-bambu-green/20 px-3 py-2 text-xs font-medium text-bambu-green transition-colors hover:bg-bambu-green/30"
            >
              {t('printers.bedJog.homeZ')}
            </button>
            <button
              type="button"
              onClick={() => {
                const distance = showNotHomedModal.distance;
                try {
                  sessionStorage.setItem(`bambuddy.bedJog.warned.${printer.id}`, '1');
                } catch {
                  // Session storage can be unavailable in privacy-restricted browsers.
                }
                bedJogMutation.mutate({ distance, force: true });
                setShowNotHomedModal(null);
              }}
              className="w-full rounded-lg bg-yellow-500/20 px-3 py-2 text-xs font-medium text-yellow-400 transition-colors hover:bg-yellow-500/30"
            >
              {t('printers.bedJog.moveAnyway')}
            </button>
            <button
              type="button"
              onClick={() => setShowNotHomedModal(null)}
              className="w-full rounded-lg bg-bambu-dark px-3 py-2 text-xs font-medium text-bambu-gray transition-colors hover:bg-bambu-dark-tertiary"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      </div>
    )}
    <SkipObjectsModal
      printerId={printer.id}
      isOpen={showSkipObjectsModal}
      onClose={() => setShowSkipObjectsModal(false)}
    />
    {amsBackupModalOpen && status && (
      <AmsBackupModal
        isOpen={amsBackupModalOpen}
        state={status.ams_filament_backup}
        amsUnits={status.ams}
        amsExtruderMap={status.ams_extruder_map}
        isDualNozzle={printer.nozzle_count === 2 || status.temperatures?.nozzle_2 !== undefined}
        canToggle={hasPermission('printers:control')}
        pending={setAmsBackupMutation.isPending}
        onToggle={(next) => setAmsBackupMutation.mutate(next)}
        onClose={() => setAmsBackupModalOpen(false)}
      />
    )}
    {amsHistoryModal && (
      <AMSHistoryModal
        isOpen
        onClose={() => setAmsHistoryModal(null)}
        printerId={printer.id}
        printerName={printer.name}
        amsId={amsHistoryModal.amsId}
        amsLabel={amsHistoryModal.amsLabel}
        initialMode={amsHistoryModal.mode}
        thresholds={amsThresholds}
      />
    )}
    <AmsDryingPopover controller={dryingControls} />
    </>
  );
}

function PrinterCard({
  printer,
  hideIfDisconnected,
  maintenanceInfo,
  amsThresholds,
  spoolmanEnabled = false,
  linkedSpools,
  spoolmanUrl,
  spoolmanSyncMode,
  onGetAssignment,
  onUnassignSpool,
  spoolmanSpools,
  spoolmanSlotAssignments,
  spoolmanLoading = false,
  onUnassignSpoolmanSpool,
  timeFormat = 'system',
  cameraViewMode = 'window',
  onOpenEmbeddedCamera,
  checkPrinterFirmware = true,
  dryingPresets = DRYING_PRESETS,
  requirePlateClear = false,
  selectionMode = false,
  isSelected = false,
  onToggleSelect,
  onOpenSinglePrinter,
  nozzleTempPresets = NOZZLE_TEMP_DEFAULTS,
  bedTempPresets = BED_TEMP_DEFAULTS,
  chamberTempPresets = CHAMBER_TEMP_DEFAULTS,
  fanSpeedPresets = FAN_SPEED_DEFAULTS,
}: {
  printer: Printer;
  hideIfDisconnected?: boolean;
  maintenanceInfo?: PrinterMaintenanceInfo;
  amsThresholds?: {
    humidityGood: number;
    humidityFair: number;
    tempGood: number;
    tempFair: number;
  };
  spoolmanEnabled?: boolean;
  hasUnlinkedSpools?: boolean;
  linkedSpools?: Record<string, LinkedSpoolInfo>;
  spoolmanUrl?: string | null;
  spoolmanSyncMode?: string | null;
  spoolAssignments?: SpoolAssignment[];
  onGetAssignment?: (printerId: number, amsId: number, trayId: number) => SpoolAssignment | undefined;
  onUnassignSpool?: (printerId: number, amsId: number, trayId: number) => void;
  spoolmanSpools?: InventorySpool[];
  spoolmanSlotAssignments?: SpoolmanSlotAssignmentRow[];
  spoolmanLoading?: boolean;
  onUnassignSpoolmanSpool?: (spoolmanSpoolId: number) => void;
  timeFormat?: 'system' | '12h' | '24h';
  cameraViewMode?: 'window' | 'embedded';
  onOpenEmbeddedCamera?: (printerId: number, printerName: string) => void;
  checkPrinterFirmware?: boolean;
  dryingPresets?: DryingPresets;
  requirePlateClear?: boolean;
  selectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (id: number) => void;
  onOpenSinglePrinter?: (id: number) => void;
  nozzleTempPresets?: readonly [number, number, number];
  bedTempPresets?: readonly [number, number, number];
  chamberTempPresets?: readonly [number, number, number];
  fanSpeedPresets?: readonly [number, number, number];
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const [showMenu, setShowMenu] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteArchives, setDeleteArchives] = useState(true);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showFileManager, setShowFileManager] = useState(false);
  const [showMQTTDebug, setShowMQTTDebug] = useState(false);
  const [showHMSModal, setShowHMSModal] = useState(false);
  // #1762: AMS Filament Backup status / control modal — opens from the badge.
  const [amsBackupModalOpen, setAmsBackupModalOpen] = useState(false);
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [showPauseConfirm, setShowPauseConfirm] = useState(false);
  const [showSpeedMenu, setShowSpeedMenu] = useState<number | null>(null);
  const [showAirductMenu, setShowAirductMenu] = useState<number | null>(null);
  const [showBedJogMenu, setShowBedJogMenu] = useState<number | null>(null);
  const [bedJogStep, setBedJogStep] = useState<number>(10);
  const [showNotHomedModal, setShowNotHomedModal] = useState<null | { distance: number }>(null);
  const [showResumeConfirm, setShowResumeConfirm] = useState(false);
  const [showSkipObjectsModal, setShowSkipObjectsModal] = useState(false);
  const [showUploadForPrint, setShowUploadForPrint] = useState(false);
  const [showPrinterInfo, setShowPrinterInfo] = useState(false);
  const [showDiagnostic, setShowDiagnostic] = useState(false);
  const closePrinterInfo = useCallback(() => setShowPrinterInfo(false), []);
  const [printAfterUpload, setPrintAfterUpload] = useState<{ id: number; filename: string } | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [isDropUploading, setIsDropUploading] = useState(false);
  const printerActionsMenuRef = useRef<HTMLDivElement>(null);
  const dragCounterRef = useRef(0);
  const [amsHistoryModal, setAmsHistoryModal] = useState<{
    amsId: number;
    amsLabel: string;
    mode: 'humidity' | 'temperature';
  } | null>(null);
  const [showFirmwareModal, setShowFirmwareModal] = useState(false);

  const { data: status } = useQuery({
    queryKey: ['printerStatus', printer.id],
    queryFn: () => api.getPrinterStatus(printer.id),
    refetchInterval: 30000, // Fallback polling, WebSocket handles real-time
  });

  // Check for firmware updates (cached for 5 minutes, can be disabled in settings)
  const { data: firmwareInfo } = useQuery({
    queryKey: ['firmwareUpdate', printer.id],
    queryFn: () => firmwareApi.checkPrinterUpdate(printer.id),
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    enabled: checkPrinterFirmware && hasPermission('firmware:read'),
  });

  // Collect unique tray_info_idx values for cloud filament info lookup
  const trayInfoIds = useMemo(() => {
    const ids = new Set<string>();
    if (status?.ams) {
      for (const ams of status.ams) {
        for (const tray of ams.tray || []) {
          if (tray.tray_info_idx) {
            ids.add(tray.tray_info_idx);
          }
        }
      }
    }
    for (const vt of status?.vt_tray ?? []) {
      if (vt.tray_info_idx) ids.add(vt.tray_info_idx);
    }
    if (status?.nozzle_rack) {
      for (const slot of status.nozzle_rack) {
        if (slot.filament_id) {
          ids.add(slot.filament_id);
        }
      }
    }
    return Array.from(ids);
  }, [status?.ams, status?.vt_tray, status?.nozzle_rack]);

  // Collect loaded filament types for queue widget filtering
  const loadedFilamentTypes = useMemo(() => {
    const types = new Set<string>();
    if (status?.ams) {
      for (const ams of status.ams) {
        for (const tray of ams.tray || []) {
          if (tray.tray_type) types.add(tray.tray_type.toUpperCase());
        }
      }
    }
    for (const vt of status?.vt_tray ?? []) {
      if (vt.tray_type) types.add(vt.tray_type.toUpperCase());
    }
    return types;
  }, [status?.ams, status?.vt_tray]);

  // Collect loaded filament type+color pairs for queue widget override matching
  // Format: "TYPE:rrggbb" (e.g., "PETG:ffffff") — mirrors backend _count_override_color_matches()
  const loadedFilaments = useMemo(() => {
    const filaments = new Set<string>();
    if (status?.ams) {
      for (const ams of status.ams) {
        for (const tray of ams.tray || []) {
          if (tray.tray_type && tray.tray_color) {
            const color = tray.tray_color.replace('#', '').toLowerCase().slice(0, 6);
            filaments.add(`${tray.tray_type.toUpperCase()}:${color}`);
          }
        }
      }
    }
    for (const vt of status?.vt_tray ?? []) {
      if (vt.tray_type && vt.tray_color) {
        const color = vt.tray_color.replace('#', '').toLowerCase().slice(0, 6);
        filaments.add(`${vt.tray_type.toUpperCase()}:${color}`);
      }
    }
    return filaments;
  }, [status?.ams, status?.vt_tray]);

  // Fetch cloud filament info for tooltips (name includes color, also has K value)
  const { data: filamentInfo } = useQuery({
    queryKey: ['filamentInfo', trayInfoIds],
    queryFn: () => api.getFilamentInfo(trayInfoIds),
    enabled: trayInfoIds.length > 0,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  // Fetch slot preset mappings (stores preset name for user-configured slots)
  const { data: slotPresets } = useQuery({
    queryKey: ['slotPresets', printer.id],
    queryFn: () => api.getSlotPresets(printer.id),
    staleTime: 2 * 60 * 1000, // 2 minutes
  });

  // Fetch plate list for the archive linked to the active print (#881 follow-up).
  // Only queried when there's a running print backed by an archive; shared
  // React Query cache with the Queue / Archives pages keeps it cheap.
  const activeArchiveId =
    (status?.state === 'RUNNING' || status?.state === 'PAUSE') ? status?.current_archive_id ?? null : null;
  const { data: activeArchivePlates } = useQuery({
    queryKey: ['archive-plates', activeArchiveId],
    queryFn: () => api.getArchivePlates(activeArchiveId!),
    enabled: activeArchiveId != null,
    staleTime: 5 * 60 * 1000,
  });
  const activePlateLabel = (() => {
    if (!activeArchivePlates?.is_multi_plate || status?.current_plate_id == null) return null;
    const plate = activeArchivePlates.plates.find(p => p.index === status.current_plate_id);
    return plate?.name || t('printers.plateNumber', 'Plate {{number}}', { number: status.current_plate_id });
  })();

  // Fetch user-defined AMS friendly names from the database
  const { data: amsLabels, refetch: refetchAmsLabels } = useQuery({
    queryKey: ['amsLabels', printer.id],
    queryFn: () => api.getAmsLabels(printer.id),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  // Cache WiFi signal to prevent it disappearing on updates
  const [cachedWifiSignal, setCachedWifiSignal] = useState<number | null>(null);
  useEffect(() => {
    if (status?.wifi_signal != null) {
      setCachedWifiSignal(status.wifi_signal);
    }
  }, [status?.wifi_signal]);
  const wifiSignal = status?.wifi_signal ?? cachedWifiSignal;

  // Cache connected state to prevent flicker when status briefly becomes undefined
  const cachedConnected = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (status?.connected !== undefined) {
      cachedConnected.current = status.connected;
    }
  }, [status?.connected]);
  const isConnected = status?.connected ?? cachedConnected.current;

  // Cache ams_extruder_map to prevent L/R indicators bouncing on updates
  const cachedAmsExtruderMap = useRef<Record<string, number>>({});
  useEffect(() => {
    if (status?.ams_extruder_map && Object.keys(status.ams_extruder_map).length > 0) {
      cachedAmsExtruderMap.current = status.ams_extruder_map;
    }
  }, [status?.ams_extruder_map]);
  const amsExtruderMap = (status?.ams_extruder_map && Object.keys(status.ams_extruder_map).length > 0)
    ? status.ams_extruder_map
    : cachedAmsExtruderMap.current;

  // Cache AMS data to prevent it disappearing on idle/offline printers
  const cachedAmsData = useRef<AMSUnit[]>([]);
  useEffect(() => {
    if (status?.ams && status.ams.length > 0) {
      cachedAmsData.current = status.ams;
    }
  }, [status?.ams]);
  const amsData = (status?.ams && status.ams.length > 0) ? status.ams : cachedAmsData.current;
  const dryingControls = useAmsDryingControls({
    printerId: printer.id,
    amsUnits: amsData,
    presets: dryingPresets,
  });

  // Cache tray_now to prevent flickering when undefined values come in
  // Valid tray IDs: 0-253 for AMS, 254 for external spool
  // tray_now=255 means "no tray loaded" (Bambu protocol sentinel) — never active
  const cachedTrayNow = useRef<number | undefined>(undefined);
  const currentTrayNow = status?.tray_now;
  // Update cache: 255 means "no tray" so clear cache; valid values get cached
  if (currentTrayNow !== undefined && currentTrayNow !== 255) {
    cachedTrayNow.current = currentTrayNow;
  } else if (currentTrayNow === 255) {
    cachedTrayNow.current = undefined;
  }
  const effectiveTrayNow = (currentTrayNow !== undefined && currentTrayNow !== 255)
    ? currentTrayNow
    : cachedTrayNow.current;

  // Fetch queue count for this printer
  const { data: queueItems } = useQuery({
    queryKey: ['queue', printer.id, 'pending'],
    queryFn: () => api.getQueue(printer.id, 'pending'),
  });
  // Filter queue items by filament compatibility (same logic as PrinterQueueWidget)
  // so the badge only shows on printers that can actually run the queued jobs.
  // An empty Set means no filaments are loaded — jobs requiring specific types are incompatible.
  const queueCount = useMemo(() => {
    if (!queueItems?.length) return 0;
    return filterCompatibleQueueItems(queueItems, loadedFilamentTypes, loadedFilaments).length;
  }, [queueItems, loadedFilamentTypes, loadedFilaments]);

  // Fetch last completed print for this printer
  const { data: lastPrints } = useQuery({
    queryKey: ['archives', printer.id, 'last'],
    queryFn: () => api.getArchives(printer.id, 1, 0),
    enabled: status?.connected && status?.state !== 'RUNNING',
  });
  const lastPrint = lastPrints?.[0];
  const isPrintingOrPaused = status?.state === 'RUNNING' || status?.state === 'PAUSE';
  const currentPrintUser = useCurrentPrintOwner(printer.id, isPrintingOrPaused);
  const needsPlateClear = requirePlateClear && status?.awaiting_plate_clear === true && !isPrintingOrPaused;
  const showClearPlateButton = status?.connected && needsPlateClear && !isPrintingOrPaused;
  const activePrintName = status?.current_print && isPrintingOrPaused
    ? formatPrintName(status.subtask_name || status.current_print || null, status.gcode_file, t, activePlateLabel)
    : null;
  const [retainedPrintJob, setRetainedPrintJob] = useState<{ name: string; coverUrl: string | null } | null>(null);
  useEffect(() => {
    if (activePrintName) {
      setRetainedPrintJob({ name: activePrintName, coverUrl: status?.cover_url ?? null });
    } else if (!needsPlateClear) {
      setRetainedPrintJob(null);
    }
  }, [activePrintName, needsPlateClear, status?.cover_url]);
  const plateStatus = (() => {
    if (!requirePlateClear || !status?.connected) return null;
    if (isPrintingOrPaused) {
      return {
        label: t('printers.plateStatus.inUse'),
        className: 'bg-status-ok/20 text-status-ok',
      };
    }
    if (status.awaiting_plate_clear) {
      return {
        label: t('printers.plateStatus.notCleared'),
        className: 'bg-status-warning/20 text-status-warning',
      };
    }
    return {
      label: t('printers.plateStatus.cleared'),
      className: 'bg-status-ok/20 text-status-ok',
    };
  })();
  const statusPillBase = 'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium';
  const statusRowLabel = (title: string, state: string) => `${title}: ${state}`;
  const StatusRowText = ({ title, state }: { title: string; state: React.ReactNode }) => (
    <>
      <span>{title}:</span>
      <span>{state}</span>
    </>
  );
  const connectionTitle = t('printers.status.connection', 'Connection');
  const plateTitle = t('printers.plateStatus.title', 'Plate');
  const networkTitle = t('printers.status.network', 'Network');
  const errorsTitle = t('printers.status.errors', 'Errors');
  const maintenanceTitle = t('maintenance.title', 'Maintenance');
  const queueTitle = t('printers.status.queue', 'Queue');
  const firmwareTitle = t('printers.status.firmware', 'Firmware');
  const doorTitle = t('printers.status.door', 'Door');
  const knownHmsErrors = status?.hms_errors ? filterKnownHMSErrors(status.hms_errors) : [];
  const hmsStateLabel = knownHmsErrors.length > 0
    ? t('printers.status.errorCount', '{{count}} active', { count: knownHmsErrors.length })
    : t('common.ok', 'OK');
  const maintenanceDueCount = maintenanceInfo?.due_count ?? 0;
  const maintenanceWarningCount = maintenanceInfo?.warning_count ?? 0;
  const maintenanceStateLabel = maintenanceDueCount > 0
    ? t('maintenance.dueCount', { count: maintenanceDueCount })
    : maintenanceWarningCount > 0
    ? t('maintenance.warningCount', { count: maintenanceWarningCount })
    : t('common.ok', 'OK');
  const networkStateLabel = !status?.connected
    ? t('printers.connection.offline')
    : status.wired_network
    ? t('printers.connection.ethernet', 'Ethernet')
    : wifiSignal != null
    ? `${wifiSignal}dBm`
    : t('common.unknown', 'Unknown');
  const networkTitleLabel = status?.connected && !status.wired_network && wifiSignal != null
    ? `${wifiSignal} dBm - ${t(getWifiStrength(wifiSignal).labelKey)}`
    : networkStateLabel;
  const networkClassName = !status?.connected
    ? 'bg-status-error/20 text-status-error'
    : status.wired_network || wifiSignal == null || wifiSignal >= -60
    ? 'bg-status-ok/20 text-status-ok'
    : wifiSignal >= -80
    ? 'bg-status-warning/20 text-status-warning'
    : 'bg-status-error/20 text-status-error';
  const hasDoorSensor = ['X1C', 'X1', 'X1E', 'X2D', 'P2S', 'H2D', 'H2D Pro', 'H2C', 'H2S'].includes(printer.model ?? '');
  const isMaintenanceMode = printer.is_active === false;
  const showConnectionPill = !isMaintenanceMode && !status?.connected;
  const showPlateStatusPill = !!plateStatus && needsPlateClear;
  const showNetworkPill = !isMaintenanceMode && (!status?.connected || (!status?.wired_network && wifiSignal != null && wifiSignal < -60));
  const showHmsPill = !isMaintenanceMode && (!status?.connected || knownHmsErrors.length > 0);
  const showMaintenancePill = maintenanceDueCount > 0 || maintenanceWarningCount > 0;
  const showQueuePill = false;
  const showFirmwarePill = !!(checkPrinterFirmware && firmwareInfo?.current_version && firmwareInfo?.latest_version && firmwareInfo.update_available);
  const showFirmwareVersionPill = false;
  const showDoorPill = !!(status?.connected && hasDoorSensor && status.door_open);
  const hasVisibleStatusPills = isMaintenanceMode ||
    showConnectionPill ||
    showPlateStatusPill ||
    !status?.connected ||
    showNetworkPill ||
    showHmsPill ||
    showMaintenancePill ||
    showQueuePill ||
    showFirmwarePill ||
    (showFirmwareVersionPill && !!status?.firmware_version) ||
    showDoorPill;
  const connectionStatusPill = (
    <span
      className={`${statusPillBase} ${
        status?.connected
          ? 'bg-status-ok/20 text-status-ok'
          : 'bg-status-error/20 text-status-error'
      }`}
      title={statusRowLabel(connectionTitle, status?.connected ? t('printers.connection.connected') : t('printers.connection.offline'))}
    >
      {status?.connected ? (
        <Link className="w-3 h-3" />
      ) : (
        <Unlink className="w-3 h-3" />
      )}
      <StatusRowText title={connectionTitle} state={status?.connected ? t('printers.connection.connected') : t('printers.connection.offline')} />
    </span>
  );
  const plateStatusPill = showPlateStatusPill && plateStatus ? (
    <span className={`${statusPillBase} ${plateStatus.className}`} title={statusRowLabel(plateTitle, plateStatus.label)}>
      <PlateClearedIcon className="w-3 h-3" />
      <StatusRowText title={plateTitle} state={plateStatus.label} />
    </span>
  ) : null;
  const networkStatusPill = (
    <span
      className={`${statusPillBase} ${networkClassName}`}
      title={statusRowLabel(networkTitle, networkTitleLabel)}
    >
      {status?.wired_network ? <Cable className="w-3 h-3" /> : <Signal className="w-3 h-3" />}
      <StatusRowText title={networkTitle} state={networkStateLabel} />
    </span>
  );
  const hmsStatusPill = (
    <button
      type="button"
      onClick={() => status?.connected && setShowHMSModal(true)}
      className={`${statusPillBase} ${status?.connected ? 'cursor-pointer hover:opacity-80 transition-opacity' : 'cursor-default'} ${
        !status?.connected
          ? 'bg-status-error/20 text-status-error'
          : knownHmsErrors.length > 0
          ? knownHmsErrors.some(e => e.severity <= 2)
            ? 'bg-status-error/20 text-status-error'
            : 'bg-status-warning/20 text-status-warning'
          : 'bg-status-ok/20 text-status-ok'
      }`}
      title={statusRowLabel(errorsTitle, status?.connected ? hmsStateLabel : t('common.unknown', 'Unknown'))}
    >
      <AlertTriangle className="w-3 h-3" />
      <StatusRowText title={errorsTitle} state={status?.connected ? hmsStateLabel : t('common.unknown', 'Unknown')} />
    </button>
  );
  const maintenanceStatusPill = (
    <button
      type="button"
      onClick={() => navigate('/maintenance')}
      className={`${statusPillBase} cursor-pointer hover:opacity-80 transition-opacity ${
        maintenanceDueCount > 0
          ? 'bg-status-error/20 text-status-error'
          : maintenanceWarningCount > 0
          ? 'bg-status-warning/20 text-status-warning'
          : 'bg-status-ok/20 text-status-ok'
      }`}
      title={statusRowLabel(maintenanceTitle, maintenanceStateLabel)}
    >
      <Wrench className="w-3 h-3" />
      <StatusRowText title={maintenanceTitle} state={maintenanceStateLabel} />
    </button>
  );
  const queueStatusPill = (
    <button
      type="button"
      onClick={() => navigate('/queue')}
      className={`${statusPillBase} bg-status-ok/20 text-status-ok hover:opacity-80 transition-opacity`}
      title={statusRowLabel(queueTitle, t('printers.queue.inQueue', { count: queueCount }))}
    >
      <Layers className="w-3 h-3" />
      <StatusRowText title={queueTitle} state={t('printers.queue.inQueue', { count: queueCount })} />
    </button>
  );
  const firmwareStatusPill = checkPrinterFirmware && firmwareInfo?.current_version && firmwareInfo?.latest_version ? (
    <button
      type="button"
      onClick={() => setShowFirmwareModal(true)}
      className={`${statusPillBase} hover:opacity-80 transition-opacity ${
        firmwareInfo.update_available
          ? 'bg-status-warning/20 text-status-warning'
          : 'bg-status-ok/20 text-status-ok'
      }`}
      title={
        firmwareInfo.update_available
          ? t('printers.firmwareUpdateAvailable', { current: firmwareInfo.current_version, latest: firmwareInfo.latest_version })
          : t('printers.firmwareUpToDate', { version: firmwareInfo.current_version })
      }
    >
      {firmwareInfo.update_available ? <Download className="w-3 h-3" /> : <CheckCircle className="w-3 h-3" />}
      <StatusRowText title={firmwareTitle} state={firmwareInfo.current_version} />
      <span>
        {firmwareInfo.update_available
          ? t('printers.status.updateAvailable', 'Update available')
          : t('common.ok', 'OK')
        }
      </span>
    </button>
  ) : status?.firmware_version ? (
    <span
      className={`${statusPillBase} bg-status-ok/20 text-status-ok`}
      title={statusRowLabel(firmwareTitle, status.firmware_version)}
    >
      <StatusRowText title={firmwareTitle} state={status.firmware_version} />
    </span>
  ) : null;
  const doorStatusPill = status?.connected && hasDoorSensor ? (
    <span
      className={`${statusPillBase} ${
        status?.door_open
          ? 'bg-status-warning/20 text-status-warning'
          : 'bg-status-ok/20 text-status-ok'
      }`}
      title={statusRowLabel(doorTitle, status?.door_open ? t('printers.door.open') : t('printers.door.closed'))}
    >
      {status?.door_open ? <DoorOpen className="w-3 h-3" /> : <DoorClosed className="w-3 h-3" />}
      <StatusRowText title={doorTitle} state={status?.door_open ? t('printers.door.open') : t('printers.door.closed')} />
    </span>
  ) : null;
  const printerHealth = getPrinterHealthMeta({
    connected: status?.connected,
    knownErrors: knownHmsErrors,
    maintenanceInfo,
    needsPlateClear,
    wifiSignal,
    firmwareUpdateAvailable: !!firmwareInfo?.update_available,
    hasDoorSensor,
    doorOpen: status?.door_open,
    labels: {
      healthy: t('printers.health.healthy', 'Healthy'),
      attentionRequired: t('printers.health.attentionRequired', 'Requires attention'),
      error: t('printers.health.error', 'Error'),
    },
  });

  // Determine if this card should be hidden (use cached connected state to prevent flicker)
  const shouldHide = hideIfDisconnected && isConnected === false;

  const deleteMutation = useMutation({
    mutationFn: (options: { deleteArchives: boolean }) =>
      api.deletePrinter(printer.id, options.deleteArchives),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['printers'] });
      queryClient.invalidateQueries({ queryKey: ['archives'] });
      queryClient.invalidateQueries({ queryKey: ['maintenanceOverview'] });
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToDelete'), 'error'),
  });

  const connectMutation = useMutation({
    mutationFn: () => api.connectPrinter(printer.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['printerStatus', printer.id] });
    },
  });

  const forceRefreshMutation = useMutation({
    mutationFn: () => api.refreshPrinterStatus(printer.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['printerStatus', printer.id] });
      showToast(t('printers.forceRefreshSuccess'), 'success');
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });

  const unlinkSpoolMutation = useMutation({
    mutationFn: (spoolId: number) => api.unlinkSpool(spoolId),
    onSuccess: (result) => {
      showToast(t('spoolman.unlinkSuccess') || result?.message, 'success');
      queryClient.invalidateQueries({ queryKey: ['linked-spools'] });
      queryClient.invalidateQueries({ queryKey: ['unlinked-spools'] });
      queryClient.invalidateQueries({ queryKey: ['spoolman-slot-assignments'] });
    },
    onError: (error: Error) => {
      showToast(error.message || t('spoolman.unlinkFailed'), 'error');
    },
  });
  const amsSlotController = useAmsSlotController({
    printerId: printer.id,
    printerModel: mapModelCode(printer.model) || undefined,
    spoolmanEnabled: !!spoolmanEnabled,
    spoolmanUrl,
    spoolmanSyncMode,
    canConfigure: hasPermission('printers:control'),
    isDualNozzle: printer.nozzle_count === 2 || status?.temperatures?.nozzle_2 !== undefined,
    amsExtruderMap,
    onUnlinkSpool: spoolId => unlinkSpoolMutation.mutate(spoolId),
    onUnassignSpoolmanSpool,
    onUnassignInventorySpool: (amsId, trayId) => onUnassignSpool?.(printer.id, amsId, trayId),
  });

  // AMS Filament Backup toggle (auto-switch to a backup spool when one runs out).
  // Invalidate BOTH printer-status cache keys — the codebase has two conventions
  // ('printerStatus' camelCase + 'printer-status' kebab-case used by PrintModal /
  // useMultiPrinterFilamentMapping). Hitting only one would leave PrintModal
  // showing the old backup state until the user reopens it.
  const setAmsBackupMutation = useMutation({
    mutationFn: (enabled: boolean) => api.setAmsFilamentBackup(printer.id, enabled),
    onSuccess: (_data, enabled) => {
      queryClient.invalidateQueries({ queryKey: ['printerStatus', printer.id] });
      queryClient.invalidateQueries({ queryKey: ['printer-status', printer.id] });
      showToast(t(enabled ? 'printers.amsBackup.toastEnabled' : 'printers.amsBackup.toastDisabled'), 'success');
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });

  // Print control mutations
  const stopPrintMutation = useMutation({
    mutationFn: () => api.stopPrint(printer.id),
    onSuccess: () => {
      showToast(t('printers.toast.printStopped'));
      queryClient.invalidateQueries({ queryKey: ['printerStatus', printer.id] });
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToStopPrint'), 'error'),
  });

  const pausePrintMutation = useMutation({
    mutationFn: () => api.pausePrint(printer.id),
    onSuccess: () => {
      showToast(t('printers.toast.printPaused'));
      queryClient.invalidateQueries({ queryKey: ['printerStatus', printer.id] });
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToPausePrint'), 'error'),
  });

  const resumePrintMutation = useMutation({
    mutationFn: () => api.resumePrint(printer.id),
    onSuccess: () => {
      showToast(t('printers.toast.printResumed'));
      queryClient.invalidateQueries({ queryKey: ['printerStatus', printer.id] });
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToResumePrint'), 'error'),
  });

  const clearPlateMutation = useMutation({
    mutationFn: () => api.clearPlate(printer.id),
    onSuccess: () => {
      showToast(t('queue.clearPlateSuccess'));
      queryClient.setQueryData(['printerStatus', printer.id], (old: PrinterStatus | undefined) =>
        old ? { ...old, awaiting_plate_clear: false } : old
      );
      queryClient.invalidateQueries({ queryKey: ['printerStatus', printer.id] });
      queryClient.invalidateQueries({ queryKey: ['queue', printer.id] });
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });


  // Chamber light mutation with optimistic update
  const chamberLightMutation = useMutation({
    mutationFn: (on: boolean) => api.setChamberLight(printer.id, on),
    onMutate: async (on) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['printerStatus', printer.id] });
      // Snapshot the previous value
      const previousStatus = queryClient.getQueryData(['printerStatus', printer.id]);
      // Optimistically update
      queryClient.setQueryData(['printerStatus', printer.id], (old: typeof status) => ({
        ...old,
        chamber_light: on,
      }));
      return { previousStatus };
    },
    onSuccess: (_, on) => {
      showToast(`Chamber light ${on ? 'on' : 'off'}`);
    },
    onError: (error: Error, _, context) => {
      // Rollback on error
      if (context?.previousStatus) {
        queryClient.setQueryData(['printerStatus', printer.id], context.previousStatus);
      }
      showToast(error.message || t('printers.toast.failedToControlChamberLight'), 'error');
    },
  });

  // Print speed mutation with optimistic update
  const printSpeedMutation = useMutation({
    mutationFn: (mode: number) => api.setPrintSpeed(printer.id, mode),
    onMutate: async (mode) => {
      await queryClient.cancelQueries({ queryKey: ['printerStatus', printer.id] });
      const previousStatus = queryClient.getQueryData(['printerStatus', printer.id]);
      queryClient.setQueryData(['printerStatus', printer.id], (old: typeof status) => ({
        ...old,
        speed_level: mode,
      }));
      return { previousStatus };
    },
    onError: (error: Error, _, context) => {
      if (context?.previousStatus) {
        queryClient.setQueryData(['printerStatus', printer.id], context.previousStatus);
      }
      showToast(error.message || t('printers.toast.failedToSetSpeed'), 'error');
    },
  });

  const airductMutation = useMutation({
    mutationFn: (mode: 'cooling' | 'heating') => api.setAirductMode(printer.id, mode),
    onMutate: async (mode) => {
      await queryClient.cancelQueries({ queryKey: ['printerStatus', printer.id] });
      const previousStatus = queryClient.getQueryData(['printerStatus', printer.id]);
      queryClient.setQueryData(['printerStatus', printer.id], (old: typeof status) => ({
        ...old,
        airduct_mode: mode === 'cooling' ? 0 : 1,
      }));
      return { previousStatus };
    },
    onError: (error: Error, _, context) => {
      if (context?.previousStatus) {
        queryClient.setQueryData(['printerStatus', printer.id], context.previousStatus);
      }
      showToast(error.message || t('printers.toast.failedToSendCommand'), 'error');
    },
  });

  const bedJogMutation = useMutation({
    mutationFn: ({ distance, force }: { distance: number; force?: boolean }) =>
      api.bedJog(printer.id, distance, force ?? false),
    onError: (error: Error) =>
      showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });

  const xyJogMutation = useMutation({
    mutationFn: ({ x, y }: { x: number; y: number }) =>
      api.xyJog(printer.id, x, y),
    onError: (error: Error) =>
      showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });

  const extruderJogMutation = useMutation({
    mutationFn: (distance: number) =>
      api.extruderJog(printer.id, distance),
    onError: (error: Error) =>
      showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });

  const homeAxesMutation = useMutation({
    mutationFn: (axes: 'z' | 'xy' | 'all') => api.homeAxes(printer.id, axes),
    onSuccess: () => {
      // Flip the session-scoped "warned" flag so the next bed-jog click doesn't re-prompt
      // the not-homed modal. The flag is the same one "Move anyway" sets; after a successful
      // auto-home request the printer is (or will shortly be) in a known-homed state, so
      // prompting again in the same session is noise — #1052 follow-up.
      try { sessionStorage.setItem(`bambuddy.bedJog.warned.${printer.id}`, '1'); } catch { /* ignore */ }
      showToast(t('printers.bedJog.homingStarted'));
    },
    onError: (error: Error) =>
      showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });

  // Plate detection setting mutation
  const plateDetectionMutation = useMutation({
    mutationFn: (enabled: boolean) => api.updatePrinter(printer.id, { plate_detection_enabled: enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['printers'] });
      showToast(plateDetectionMutation.variables ? t('printers.toast.plateCheckEnabled') : t('printers.toast.plateCheckDisabled'));
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToUpdateSetting'), 'error'),
  });

  // Maintenance mode toggle (#1476). Wraps the `is_active` backend field that
  // already gates MQTT connection, queue dispatch, scheduler eligibility,
  // metrics, and the print picker — so flipping this flag puts the printer
  // out of service across every consumer in one place. Used from the
  // overflow menu and EditPrinterModal.
  const maintenanceMutation = useMutation({
    mutationFn: (isActive: boolean) => api.updatePrinter(printer.id, { is_active: isActive }),
    onSuccess: (_data, isActive) => {
      queryClient.invalidateQueries({ queryKey: ['printers'] });
      queryClient.invalidateQueries({ queryKey: ['printerStatus', printer.id] });
      showToast(
        isActive
          ? t('printers.maintenance.toastExited', { name: printer.name })
          : t('printers.maintenance.toastEntered', { name: printer.name }),
        'success',
      );
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToUpdateSetting'), 'error'),
  });

  // Confirm before entering maintenance on a printing printer (entering mode
  // disconnects MQTT, which stops progress tracking + completion notifications
  // for the in-flight job).
  const [confirmMaintenanceEnter, setConfirmMaintenanceEnter] = useState(false);
  const handleEnterMaintenance = () => {
    if (status?.state === 'RUNNING' || status?.state === 'PAUSE') {
      setConfirmMaintenanceEnter(true);
    } else {
      maintenanceMutation.mutate(false);
    }
  };

  // Query for printable objects (for skip functionality)
  // Fetch when printing with 2+ objects OR when modal is open
  const isPrintingWithObjects = (status?.state === 'RUNNING' || status?.state === 'PAUSE') && (status?.printable_objects_count ?? 0) >= 2;
  const { data: objectsData } = useQuery({
    queryKey: ['printableObjects', printer.id],
    queryFn: () => api.getPrintableObjects(printer.id),
    enabled: showSkipObjectsModal || isPrintingWithObjects,
    refetchInterval: showSkipObjectsModal ? 5000 : (isPrintingWithObjects ? 30000 : false), // 5s when modal open, 30s otherwise
  });

  // State for tracking which AMS slot is being refreshed
  const [refreshingSlot, setRefreshingSlot] = useState<{ amsId: number; slotId: number } | null>(null);
  // Track if we've seen the printer enter "busy" state (ams_status_main !== 0)
  const seenBusyStateRef = useRef<boolean>(false);
  // Fallback timeout ref
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Minimum display time passed
  const minTimePassedRef = useRef<boolean>(false);

  // AMS slot refresh mutation
  const refreshAmsSlotMutation = useMutation({
    mutationFn: ({ amsId, slotId }: { amsId: number; slotId: number }) =>
      api.refreshAmsSlot(printer.id, amsId, slotId),
    onMutate: ({ amsId, slotId }) => {
      // Clear any existing timeout
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
      }
      // Reset state
      seenBusyStateRef.current = false;
      minTimePassedRef.current = false;
      setRefreshingSlot({ amsId, slotId });
      // Minimum display time (2 seconds)
      setTimeout(() => {
        minTimePassedRef.current = true;
      }, 2000);
      // Fallback timeout (30 seconds max)
      refreshTimeoutRef.current = setTimeout(() => {
        setRefreshingSlot(null);
      }, 30000);
    },
    onSuccess: (data) => {
      showToast(data.message || t('printers.toast.rfidRereadInitiated'));
    },
    onError: (error: Error) => {
      showToast(error.message || t('printers.toast.failedToRereadRfid'), 'error');
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
      }
      setRefreshingSlot(null);
    },
  });

  // AMS load/unload mutations (#891)
  const loadAmsTrayMutation = useMutation({
    mutationFn: ({ trayId }: { trayId: number }) => api.loadAmsTray(printer.id, trayId),
    onSuccess: (data) => {
      showToast(data.message || t('printers.toast.loadInitiated'));
    },
    onError: (error: Error) => {
      showToast(error.message || t('printers.toast.failedToLoad'), 'error');
    },
  });

  const unloadAmsMutation = useMutation({
    mutationFn: () => api.unloadAms(printer.id),
    onSuccess: (data) => {
      showToast(data.message || t('printers.toast.unloadInitiated'));
    },
    onError: (error: Error) => {
      showToast(error.message || t('printers.toast.failedToUnload'), 'error');
    },
  });

  // Toggle plate detection enabled/disabled
  const handleTogglePlateDetection = () => {
    plateDetectionMutation.mutate(!printer.plate_detection_enabled);
  };

  // Watch ams_status_main to detect when RFID read completes
  // ams_status_main: 0=idle, 2=rfid_identifying
  const deferredClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!refreshingSlot) return;

    const amsStatus = status?.ams_status_main ?? 0;

    // Track when we see non-idle state (printer is working)
    if (amsStatus !== 0) {
      seenBusyStateRef.current = true;
      // Cancel any deferred clear since we're back to busy
      if (deferredClearRef.current) {
        clearTimeout(deferredClearRef.current);
        deferredClearRef.current = null;
      }
    }

    // When we've seen busy and now idle, clear (with min time check)
    if (seenBusyStateRef.current && amsStatus === 0) {
      if (minTimePassedRef.current) {
        // Min time passed - clear now
        if (refreshTimeoutRef.current) {
          clearTimeout(refreshTimeoutRef.current);
        }
        setRefreshingSlot(null);
      } else {
        // Schedule clear after min time (2 seconds from start)
        if (!deferredClearRef.current) {
          deferredClearRef.current = setTimeout(() => {
            if (refreshTimeoutRef.current) {
              clearTimeout(refreshTimeoutRef.current);
            }
            setRefreshingSlot(null);
          }, 2000);
        }
      }
    }

    return () => {
      if (deferredClearRef.current) {
        clearTimeout(deferredClearRef.current);
      }
    };
  }, [status?.ams_status_main, refreshingSlot]);

  useEffect(() => {
    if (!showMenu) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!printerActionsMenuRef.current?.contains(target)) {
        setShowMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMenu]);

  if (shouldHide) {
    return null;
  }

  // Dropping a file follows the same queue-first flow as the Print button: it
  // uploads the file to the library, then opens PrintModal to enqueue it. A
  // currently running or paused print must not prevent that workflow.
  const canDrop = isConnected
    && hasPermission('library:upload')
    && hasPermission('queue:create');

  const handleCardDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setIsDraggingFile(true);
  };

  const handleCardDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = canDrop ? 'copy' : 'none';
  };

  const handleCardDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setIsDraggingFile(false);
  };

  const handleCardDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDraggingFile(false);

    if (!canDrop) return;

    const droppedFiles = Array.from(e.dataTransfer.files);
    const file = droppedFiles[0];
    if (!file) return;

    // Only accept sliced/printable files (.gcode, .gcode.3mf, etc.)
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.gcode') && !lower.includes('.gcode.')) {
      showToast(t('printers.dropNotPrintable', 'Only .gcode and .gcode.3mf files can be printed'), 'error');
      return;
    }

    setIsDropUploading(true);
    try {
      const result = await api.uploadLibraryFile(file, null);

      // Check printer compatibility if sliced_for_model is available in metadata
      const slicedFor = (result.metadata as Record<string, unknown>)?.sliced_for_model as string | undefined;
      const printerModel = mapModelCode(printer.model);
      if (slicedFor && printerModel && slicedFor.toLowerCase() !== printerModel.toLowerCase()) {
        await api.deleteLibraryFile(result.id).catch(() => {});
        showToast(
          t('printers.incompatibleFile', 'This file was sliced for {{slicedFor}}, but this printer is a {{printerModel}}', { slicedFor, printerModel }),
          'error'
        );
        return;
      }

      setPrintAfterUpload({ id: result.id, filename: result.filename });
    } catch {
      showToast(t('common.uploadFailed', 'Upload failed'), 'error');
    } finally {
      setIsDropUploading(false);
    }
  };

  const footerActionButtonClass = '!h-8 !min-h-8 !px-2 !py-0';
  const footerIconButtonClass = '!h-8 !min-h-8 !w-8 !px-0 !py-0';
  const renderAmsSlotActions = ({
    amsId,
    slotId,
    loadTrayId,
    isRefreshing,
    includeRfid = true,
  }: {
    amsId: number;
    slotId: number;
    loadTrayId: number;
    isRefreshing?: boolean;
    includeRfid?: boolean;
  }) => {
    const printerBusy = status?.state === 'RUNNING';
    return <AmsSlotActions
      includeRfid={includeRfid}
      isPrinting={printerBusy}
      isRefreshing={isRefreshing}
      canReadRfid={hasPermission('printers:ams_rfid')}
      canControl={hasPermission('printers:control')}
      onRefresh={() => refreshAmsSlotMutation.mutate({ amsId, slotId })}
      onLoad={() => loadAmsTrayMutation.mutate({ trayId: loadTrayId })}
      onUnload={() => unloadAmsMutation.mutate()}
    />;
  };

  const printerActionsMenu = (
    <PrinterActionsMenu
      printer={printer}
      isOpen={showMenu}
      menuRef={printerActionsMenuRef}
      triggerClassName={footerIconButtonClass}
      menuClassName="absolute left-0 bottom-full z-20 mb-2 w-48 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-lg"
      iconClassName="w-4 h-4"
      maintenancePending={maintenanceMutation.isPending}
      forceRefreshPending={forceRefreshMutation.isPending}
      onToggle={() => setShowMenu(!showMenu)}
      onEdit={() => {
        setShowEditModal(true);
        setShowMenu(false);
      }}
      onInfo={() => {
        setShowPrinterInfo(true);
        setShowMenu(false);
      }}
      onToggleMaintenance={() => {
        setShowMenu(false);
        if (printer.is_active !== false) {
          handleEnterMaintenance();
        } else {
          maintenanceMutation.mutate(true);
        }
      }}
      onReconnect={() => {
        connectMutation.mutate();
        setShowMenu(false);
      }}
      onForceRefresh={() => {
        forceRefreshMutation.mutate();
        setShowMenu(false);
      }}
      onMqttDebug={() => {
        setShowMQTTDebug(true);
        setShowMenu(false);
      }}
      onDiagnostic={() => {
        setShowDiagnostic(true);
        setShowMenu(false);
      }}
      onDelete={() => {
        setShowDeleteConfirm(true);
        setShowMenu(false);
      }}
    />
  );

  return (
    <Card
      id={`printer-card-${printer.id}`}
      className={`relative flex h-full flex-col ${isSelected ? 'ring-2 ring-bambu-green' : ''}`}
      onDragEnter={handleCardDragEnter}
      onDragOver={handleCardDragOver}
      onDragLeave={handleCardDragLeave}
      onDrop={handleCardDrop}
    >
      {/* Selection mode click overlay — captures all clicks, preventing nested interactions */}
      {selectionMode && (
        <div
          className="absolute inset-0 z-20 flex items-start p-2"
          onClick={(e) => { e.stopPropagation(); onToggleSelect?.(printer.id); }}
        >
          {isSelected ? (
            <CheckSquare className="w-5 h-5 text-bambu-green" />
          ) : (
            <Square className="w-5 h-5 text-bambu-gray" />
          )}
        </div>
      )}
      {/* Drop zone overlay */}
      {(isDraggingFile || isDropUploading) && (
        <div
          className={`absolute inset-0 z-10 rounded-xl border-2 border-dashed flex items-center justify-center transition-colors ${
            isDropUploading
              ? 'bg-bambu-green/10 border-bambu-green/50'
              : canDrop
                ? 'bg-bambu-green/10 border-bambu-green'
                : 'bg-red-500/10 border-red-500/50'
          }`}
        >
          <div className="text-center">
            {isDropUploading ? (
              <>
                <Loader2 className="w-8 h-8 mx-auto mb-2 text-bambu-green animate-spin" />
                <p className="text-sm font-medium text-bambu-green">{t('common.uploading', 'Uploading...')}</p>
              </>
            ) : canDrop ? (
              <>
                <PrinterIcon className="w-8 h-8 mx-auto mb-2 text-bambu-green" />
                <p className="text-sm font-medium text-bambu-green">{t('printers.dropToPrint', 'Drop to print')}</p>
              </>
            ) : (
              <>
                <X className="w-8 h-8 mx-auto mb-2 text-red-400" />
                <p className="text-sm font-medium text-red-400">{t('printers.cannotPrint', 'Printer busy')}</p>
              </>
            )}
          </div>
        </div>
      )}
      <CardContent className="flex flex-1 flex-col">
        {/* Header */}
        <div className="mb-4 rounded-lg bg-bambu-dark p-3">
          {/* Top row: Image, Name, Menu */}
          <div className="flex items-stretch justify-between gap-2">
            <div className="flex items-center gap-3 min-w-0 flex-1">
              {/* Printer Model Image */}
              <img
                src={getPrinterImage(printer.model)}
                alt={printer.model || t('common.printer')}
                className="h-14 w-14 flex-shrink-0 rounded-lg object-contain"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    {onOpenSinglePrinter ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenSinglePrinter(printer.id);
                        }}
                        className="min-w-0 text-left text-lg font-semibold text-white transition-colors hover:text-bambu-green focus:text-bambu-green focus:outline-none"
                        title={t('printers.viewSinglePrinter', 'View single printer')}
                      >
                        {printer.name}
                      </button>
                    ) : (
                      <h3 className="text-lg font-semibold text-white">{printer.name}</h3>
                    )}
                  </div>
                </div>
                <p className="text-sm text-bambu-gray">
                  {printer.model || 'Unknown Model'}
                  {/* Nozzle Info - only in expanded */}
                  {status?.nozzles && status.nozzles[0]?.nozzle_diameter && (
                    <span className="ml-1.5 text-bambu-gray" title={status.nozzles[0].nozzle_type || 'Nozzle'}>
                      • {status.nozzles[0].nozzle_diameter}mm
                    </span>
                  )}
                  {maintenanceInfo && maintenanceInfo.total_print_hours > 0 && (
                    <span className="ml-2 text-bambu-gray">
                      <Clock className="w-3 h-3 inline-block mr-1" />
                      {Math.round(maintenanceInfo.total_print_hours)}h
                    </span>
                  )}
                </p>
              </div>
            </div>
            <div className="relative flex flex-shrink-0 self-stretch gap-2">
              <PrinterHealthMenu
                printer={printer}
                status={status}
                printerHealth={printerHealth}
                knownHmsErrors={knownHmsErrors}
                maintenanceInfo={maintenanceInfo}
                requirePlateClear={requirePlateClear}
                needsPlateClear={needsPlateClear}
                firmwareInfo={firmwareInfo}
                hasDoorSensor={hasDoorSensor}
                checkPrinterFirmware={checkPrinterFirmware}
                queueCount={queueCount}
                triggerClassName="h-full min-h-7 w-8"
              />
            </div>
          </div>

          {hasVisibleStatusPills && (
            <div className="mt-2">
              <div className="space-y-1.5">
              {isMaintenanceMode && (
                <span className={`${statusPillBase} bg-amber-500/20 text-amber-400`}>
                  <Wrench className="w-3 h-3" />
                  <StatusRowText title={maintenanceTitle} state={t('printers.maintenance.pillLabel', 'Maintenance')} />
                </span>
              )}
              {/* Connection status badge */}
              {showConnectionPill && connectionStatusPill}
              {plateStatusPill}
              {/* Run connection diagnostic — offered when the printer is offline */}
              {!isMaintenanceMode && !status?.connected && (
                <button
                  onClick={() => setShowDiagnostic(true)}
                  className={`${statusPillBase} cursor-pointer bg-status-warning/20 text-status-warning hover:opacity-80 transition-opacity`}
                  title={statusRowLabel(t('diagnostic.title', 'Diagnostic'), t('diagnostic.runButton'))}
                >
                  <Stethoscope className="w-3 h-3" />
                  <StatusRowText title={t('diagnostic.title', 'Diagnostic')} state={t('diagnostic.runButton')} />
                </button>
              )}
              {/* Network connection indicator */}
              {showNetworkPill && networkStatusPill}
              {/* HMS Status Indicator */}
              {showHmsPill && hmsStatusPill}
              {/* Maintenance Status Indicator */}
              {showMaintenancePill && maintenanceStatusPill}
              {/* Queue Count Badge */}
              {showQueuePill && queueStatusPill}
              {/* Firmware Version Badge */}
              {showFirmwarePill ? firmwareStatusPill : showFirmwareVersionPill && status?.firmware_version ? firmwareStatusPill : null}
              {/* Enclosure Door Badge */}
              {showDoorPill && doorStatusPill}
              </div>
            </div>
          )}
        </div>

        {showDeleteConfirm && (
          <PrinterDeleteConfirmModal
            printer={printer}
            deleteArchives={deleteArchives}
            onDeleteArchivesChange={setDeleteArchives}
            onCancel={() => {
              setShowDeleteConfirm(false);
              setDeleteArchives(true);
            }}
            onConfirm={() => {
              deleteMutation.mutate({ deleteArchives });
              setShowDeleteConfirm(false);
              setDeleteArchives(true);
            }}
          />
        )}

        {/* Status — see the equivalent defensive `=== false` check on the
            header pill above for why this is not `!printer.is_active`. */}
        {printer.is_active === false ? (
          <>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] uppercase tracking-wider text-bambu-gray font-medium">
                {t('printers.status.title', 'Status')}
              </span>
              <div className="flex-1 h-[2px] bg-bambu-dark-tertiary" />
            </div>
            <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-[10px] flex items-center gap-3">
              <Wrench className="w-6 h-6 text-amber-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-amber-400 font-medium">
                  {t('printers.maintenance.title')}
                </p>
                <p className="text-xs text-bambu-gray mt-0.5">
                  {t('printers.maintenance.subtitle')}
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                disabled={maintenanceMutation.isPending || !hasPermission('printers:update')}
                onClick={() => maintenanceMutation.mutate(true)}
                title={!hasPermission('printers:update') ? t('printers.permission.noEdit') : undefined}
              >
                {t('printers.maintenance.exitButton')}
              </Button>
            </div>
          </>
        ) : status?.connected && (
          <>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] uppercase tracking-wider text-bambu-gray font-medium">
                    {t('printers.status.title', 'Status')}
                  </span>
                  <div className="flex-1 h-[2px] bg-bambu-dark-tertiary" />
                </div>

                {/* Current Print or Idle Placeholder */}
                {(() => {
                  const isActivePrint = !!(status.current_print && (status.state === 'RUNNING' || status.state === 'PAUSE'));
                  const showRetainedPrint = !isActivePrint && needsPlateClear && retainedPrintJob;
                  const printName = isActivePrint ? activePrintName : showRetainedPrint ? retainedPrintJob.name : null;
                  const coverUrl = isActivePrint ? status.cover_url : showRetainedPrint ? retainedPrintJob.coverUrl : null;
                  const progress = isActivePrint ? (status.progress || 0) : showRetainedPrint ? 100 : 0;

                  return (
                    <div className="p-2 bg-bambu-dark rounded-[10px] relative overflow-hidden">
                      <button
                        onClick={() => setShowSkipObjectsModal(true)}
                        disabled={!isActivePrint || (status.printable_objects_count ?? 0) < 2 || !hasPermission('printers:control')}
                        className={`absolute top-2 right-2 p-1.5 rounded transition-colors z-10 ${
                          isActivePrint && (status.printable_objects_count ?? 0) >= 2 && hasPermission('printers:control')
                            ? 'text-bambu-gray hover:text-white hover:bg-white/10'
                            : 'text-bambu-gray/30 cursor-not-allowed'
                        }`}
                        title={
                          !hasPermission('printers:control')
                            ? t('printers.permission.noControl')
                            : !isActivePrint
                              ? t('printers.skipObjects.onlyWhilePrinting')
                              : (status.printable_objects_count ?? 0) >= 2
                                ? t('printers.skipObjects.tooltip')
                                : t('printers.skipObjects.requiresMultiple')
                        }
                      >
                        <SkipObjectsIcon className="w-4 h-4" />
                        {objectsData && objectsData.skipped_count > 0 && (
                          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 flex items-center justify-center text-[10px] font-bold bg-red-500 text-white rounded-full">
                            {objectsData.skipped_count}
                          </span>
                        )}
                      </button>
                      <div className="flex items-stretch gap-2">
                        <CoverImage
                          url={coverUrl}
                          printName={printName || undefined}
                          className="w-24 h-24 max-[520px]:w-20 max-[520px]:h-20"
                        />
                        <div className="flex h-24 max-[520px]:h-20 min-w-0 flex-1 flex-col justify-between pt-1">
                          <div className="flex min-h-[18px] items-center gap-2 pr-8">
                            <p className="min-w-0 truncate text-sm text-bambu-gray">{getStatusDisplay(status.state, status.stg_cur_name)}</p>
                          </div>
                          <p className={`min-h-[18px] truncate pr-8 text-sm ${printName ? 'text-white' : 'text-bambu-gray/70'}`}>
                            {printName || t('printers.noActiveJob', 'No active job')}
                          </p>
                          {isActivePrint && (
                            <div className="flex h-3 items-center gap-2 text-sm">
                              <div className="h-1.5 min-w-0 flex-1 rounded-full bg-bambu-dark-tertiary">
                                <div
                                  className={`${status.state === 'PAUSE' ? 'bg-status-warning' : 'bg-bambu-green'} h-1.5 rounded-full transition-all`}
                                  style={{ width: `${progress}%` }}
                                />
                              </div>
                              <span className="w-9 shrink-0 pr-1 text-right text-[11px] leading-none text-white">{Math.round(progress)}%</span>
                            </div>
                          )}
                          <div className="flex min-h-[16px] items-center gap-2 text-xs text-bambu-gray">
                            {isActivePrint ? (
                              <>
                                {status.remaining_time != null && status.remaining_time > 0 && (
                                  <>
                                    <span className="flex items-center gap-1">
                                      <Clock className="w-3 h-3" />
                                      {formatDuration(status.remaining_time * 60)}
                                    </span>
                                    <span className="text-bambu-green font-medium" title={t('printers.estimatedCompletion')}>
                                      ETA {formatETA(status.remaining_time, timeFormat, t)}
                                    </span>
                                  </>
                                )}
                                {status.layer_num != null && status.total_layers != null && status.total_layers > 0 && (
                                  <span className="flex items-center gap-1">
                                    <Layers className="w-3 h-3" />
                                    {status.layer_num}/{status.total_layers}
                                  </span>
                                )}
                                {currentPrintUser && (
                                  <span className="flex items-center gap-1" title={`Started by ${currentPrintUser}`}>
                                    <User className="w-3 h-3" />
                                    {currentPrintUser}
                                  </span>
                                )}
                              </>
                            ) : lastPrint ? (
                              <p className="truncate" title={lastPrint.print_name || lastPrint.filename}>
                                Last: {lastPrint.print_name || lastPrint.filename}
                                {lastPrint.completed_at && (
                                  <span className="ml-1 text-bambu-gray/60">
                                    • {formatDateOnly(lastPrint.completed_at, { month: 'short', day: 'numeric' })}
                                  </span>
                                )}
                              </p>
                            ) : (
                              <span>{t('printers.readyToPrint')}</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <PrinterQueueWidget
                        printerId={printer.id}
                        printerModel={printer.model}
                        loadedFilamentTypes={loadedFilamentTypes}
                        loadedFilaments={loadedFilaments}
                        variant="panelExtension"
                      />
                    </div>
                  );
                })()}

            <PrinterThermalControls
              printer={printer}
              status={status}
              filamentInfo={filamentInfo}
              nozzleTempPresets={nozzleTempPresets}
              bedTempPresets={bedTempPresets}
              chamberTempPresets={chamberTempPresets}
              fanSpeedPresets={fanSpeedPresets}
              className="mt-2"
            />

            {showClearPlateButton && (
              <button
                type="button"
                onClick={() => clearPlateMutation.mutate()}
                disabled={clearPlateMutation.isPending || !hasPermission('printers:clear_plate')}
                className="mt-2 w-full inline-flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg bg-yellow-500/20 border border-yellow-400/40 text-yellow-400 hover:bg-yellow-500/30 transition-colors text-xs font-medium disabled:opacity-50"
                title={!hasPermission('printers:clear_plate') ? t('printers.permission.noControl') : t('printers.plateStatus.markCleared')}
              >
                {clearPlateMutation.isPending ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <PlateClearedIcon className="w-4 h-4" />
                )}
                {t('printers.plateStatus.markCleared')}
              </button>
            )}

            {/* Controls */}
            {(() => {
              // Determine print state for control buttons
              const isRunning = status.state === 'RUNNING';
              const isPaused = status.state === 'PAUSE';
              const isPrinting = isRunning || isPaused;
              const isControlBusy = stopPrintMutation.isPending || pausePrintMutation.isPending || resumePrintMutation.isPending;
              const unavailablePrintActionClass = 'bg-bambu-dark text-bambu-gray/50 cursor-not-allowed opacity-50';
              const iconControlClass = 'flex h-8 w-8 items-center justify-center rounded-lg text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
              const printControlClass = 'flex h-8 w-20 items-center justify-center gap-1 px-2 rounded-lg text-xs font-medium transition-colors';

              return (
                <div className="mt-3">
                  {/* Section Header */}
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[10px] uppercase tracking-wider text-bambu-gray font-medium">
                      {t('printers.controls')}
                    </span>
                    <div className="flex-1 h-[2px] bg-bambu-dark-tertiary" />
                  </div>

                  <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-2">
                    {/* Left: Secondary controls */}
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <button
                        onClick={() => chamberLightMutation.mutate(!status.chamber_light)}
                        disabled={!status.connected || chamberLightMutation.isPending || !hasPermission('printers:control')}
                        className={`${iconControlClass} ${
                          status.chamber_light
                            ? 'bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20'
                            : 'bg-bambu-dark text-bambu-gray/50 hover:bg-bambu-dark-tertiary hover:text-white'
                        }`}
                        title={!hasPermission('printers:control') ? t('printers.permission.noControl') : (status.chamber_light ? t('printers.chamberLightOff') : t('printers.chamberLightOn'))}
                      >
                        <ChamberLight on={status.chamber_light ?? false} className="w-4 h-4" />
                      </button>

                      <PrinterAirductControl
                        isCapable={['P2S', 'X2D', 'H2D', 'H2C', 'H2S'].includes(printer.model ?? '')}
                        mode={status.airduct_mode}
                        isOpen={showAirductMenu === printer.id}
                        disabled={!hasPermission('printers:control') || airductMutation.isPending}
                        buttonClassName={iconControlClass}
                        iconClassName="w-4 h-4"
                        onToggleMenu={() => setShowAirductMenu(showAirductMenu === printer.id ? null : printer.id)}
                        onCloseMenu={() => setShowAirductMenu(null)}
                        onSelectMode={(mode) => airductMutation.mutate(mode)}
                      />

                      {/* Movement — compact badge, popover holds XY, Z, and home controls */}
                      {(() => {
                        const canControl = hasPermission('printers:control');
                        const disabled = isPrinting || !canControl;
                        const bambuIsPlateBelow = true; // positive Z moves plate away from nozzle
                        const jogButtonClass = 'flex h-8 w-8 items-center justify-center rounded bg-indigo-500/15 text-indigo-300 transition-colors hover:bg-indigo-500/30 disabled:cursor-not-allowed disabled:opacity-50';
                        const requestZJog = (direction: 1 | -1) => {
                          const signed = direction * bedJogStep * (bambuIsPlateBelow ? 1 : -1);
                          const warnedKey = `bambuddy.bedJog.warned.${printer.id}`;
                          const warned = (() => {
                            try { return sessionStorage.getItem(warnedKey) === '1'; }
                            catch { return false; }
                          })();
                          if (warned) {
                            bedJogMutation.mutate({ distance: signed, force: true });
                          } else {
                            setShowNotHomedModal({ distance: signed });
                          }
                        };
                        const requestXyJog = (x: number, y: number) => {
                          xyJogMutation.mutate({ x, y });
                        };
                        const requestExtruderJog = (distance: number) => {
                          extruderJogMutation.mutate(distance);
                        };
                        return (
                          <div className="relative">
                            <button
                              onClick={() => setShowBedJogMenu(showBedJogMenu === printer.id ? null : printer.id)}
                              disabled={disabled}
                              className={`${iconControlClass} ${
                                disabled
                                  ? 'bg-bambu-dark text-bambu-gray/50 cursor-not-allowed'
                                  : 'bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20'
                              }`}
                              title={!canControl ? t('printers.permission.noControl') : isPrinting ? t('printers.bedJog.disabledWhilePrinting') : t('printers.bedJog.title')}
                            >
                              <Move className="w-4 h-4" />
                            </button>
                            {showBedJogMenu === printer.id && (
                              <>
                                <div className="fixed inset-0 z-40" onClick={() => setShowBedJogMenu(null)} />
                                <div className="absolute bottom-full left-0 mb-1 z-50 flex w-[216px] flex-col overflow-hidden rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-2xl">
                                  <div className="shrink-0 px-3 py-2.5 text-center text-sm font-medium text-white">
                                    {t('printers.bedJog.title')}
                                  </div>
                                  <div className="h-px bg-bambu-dark-tertiary" />
                                  <div className="flex justify-center px-3 py-2.5">
                                    <div className="flex items-center justify-center gap-3">
                                    <div className="grid grid-cols-3 gap-1">
                                      <div />
                                      <button
                                        onClick={() => requestXyJog(0, bedJogStep)}
                                        disabled={xyJogMutation.isPending}
                                        className={jogButtonClass}
                                        aria-label="Move Y forward"
                                      >
                                        <ArrowUp className="w-4 h-4" />
                                      </button>
                                      <div />
                                      <button
                                        onClick={() => requestXyJog(-bedJogStep, 0)}
                                        disabled={xyJogMutation.isPending}
                                        className={jogButtonClass}
                                        aria-label="Move X left"
                                      >
                                        <ArrowLeft className="w-4 h-4" />
                                      </button>
                                      <button
                                        onClick={() => {
                                          setShowBedJogMenu(null);
                                          homeAxesMutation.mutate('all');
                                        }}
                                        disabled={homeAxesMutation.isPending}
                                        className={jogButtonClass}
                                        aria-label={t('printers.bedJog.homeZ')}
                                      >
                                        <Home className="w-4 h-4" />
                                      </button>
                                      <button
                                        onClick={() => requestXyJog(bedJogStep, 0)}
                                        disabled={xyJogMutation.isPending}
                                        className={jogButtonClass}
                                        aria-label="Move X right"
                                      >
                                        <ArrowRight className="w-4 h-4" />
                                      </button>
                                      <div />
                                      <button
                                        onClick={() => requestXyJog(0, -bedJogStep)}
                                        disabled={xyJogMutation.isPending}
                                        className={jogButtonClass}
                                        aria-label="Move Y back"
                                      >
                                        <ArrowDown className="w-4 h-4" />
                                      </button>
                                      <div />
                                    </div>
                                    <div className="flex flex-col items-center gap-1">
                                      <button
                                        onClick={() => requestZJog(-1)}
                                        disabled={bedJogMutation.isPending}
                                        className={jogButtonClass}
                                        aria-label={t('printers.bedJog.up')}
                                      >
                                        <ArrowUp className="w-4 h-4" />
                                      </button>
                                      <div className="flex h-8 w-8 items-center justify-center text-bambu-gray/80">
                                        <Layers className="w-4 h-4" />
                                      </div>
                                      <button
                                        onClick={() => requestZJog(1)}
                                        disabled={bedJogMutation.isPending}
                                        className={jogButtonClass}
                                        aria-label={t('printers.bedJog.down')}
                                      >
                                        <ArrowDown className="w-4 h-4" />
                                      </button>
                                    </div>
                                    <div className="flex flex-col items-center gap-1">
                                      <button
                                        onClick={() => requestExtruderJog(-bedJogStep)}
                                        disabled={extruderJogMutation.isPending}
                                        className={jogButtonClass}
                                        aria-label="Retract filament"
                                      >
                                        <ArrowUp className="w-4 h-4" />
                                      </button>
                                      <div className="flex h-8 w-8 items-center justify-center text-bambu-gray/80">
                                        <span className="text-sm font-semibold leading-none">E</span>
                                      </div>
                                      <button
                                        onClick={() => requestExtruderJog(bedJogStep)}
                                        disabled={extruderJogMutation.isPending}
                                        className={jogButtonClass}
                                        aria-label="Extrude filament"
                                      >
                                        <ArrowDown className="w-4 h-4" />
                                      </button>
                                    </div>
                                    </div>
                                  </div>
                                  <div className="h-px bg-bambu-dark-tertiary" />
                                  <div className="px-3 pt-2.5 pb-3">
                                    <div className="mb-1 text-[9px] uppercase tracking-wider text-bambu-gray/70">
                                      {t('printers.bedJog.step')}
                                    </div>
                                    <div className="flex gap-1">
                                    {[1, 10, 50].map((step) => (
                                      <button
                                        key={step}
                                        onClick={() => setBedJogStep(step)}
                                        className={`flex-1 px-1 py-1 rounded text-[10px] transition-colors ${
                                          bedJogStep === step
                                            ? 'bg-bambu-green/20 text-bambu-green'
                                            : 'bg-bambu-dark text-bambu-gray hover:bg-bambu-dark-tertiary'
                                        }`}
                                      >
                                        {step}
                                      </button>
                                    ))}
                                    </div>
                                  </div>
                                </div>
                              </>
                            )}
                          </div>
                        );
                      })()}

                      <PrinterPlateDetectionControl
                        printer={printer}
                        status={status}
                        enabled={printer.plate_detection_enabled}
                        connected={status.connected}
                        canUpdate={hasPermission('printers:update')}
                        togglePending={plateDetectionMutation.isPending}
                        iconControlClass={iconControlClass}
                        iconClassName="w-4 h-4"
                        onToggle={handleTogglePlateDetection}
                      />

                      {/* Print Speed */}
                      {(() => (
                        <div className="relative">
                          <button
                            data-testid="speed-control"
                            onClick={() => setShowSpeedMenu(showSpeedMenu === printer.id ? null : printer.id)}
                            disabled={!isPrinting || !hasPermission('printers:control')}
                            className={`${iconControlClass} ${
                              isPrinting
                                ? 'bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'
                                : 'bg-bambu-dark text-bambu-gray/50 cursor-not-allowed'
                            }`}
                            aria-label={t('printers.speed.title')}
                            title={isPrinting ? t('printers.speed.title') : undefined}
                          >
                            <Gauge className="w-4 h-4" />
                          </button>
                          {showSpeedMenu === printer.id && (
                            <>
                              <div className="fixed inset-0 z-40" onClick={() => setShowSpeedMenu(null)} />
                              <div className="absolute bottom-full left-0 mb-1 z-50 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-lg py-1 min-w-[130px]">
                                {([
                                  { mode: 1, label: t('printers.speed.silent') },
                                  { mode: 2, label: t('printers.speed.standard') },
                                  { mode: 3, label: t('printers.speed.sport') },
                                  { mode: 4, label: t('printers.speed.ludicrous') },
                                ] as const).map(({ mode, label }) => (
                                  <button
                                    key={mode}
                                    onClick={() => {
                                      printSpeedMutation.mutate(mode);
                                      setShowSpeedMenu(null);
                                    }}
                                    className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                                      status.speed_level === mode
                                        ? 'text-bambu-green bg-bambu-green/10'
                                        : 'text-white hover:bg-bambu-dark-tertiary'
                                    }`}
                                  >
                                    {label}
                                  </button>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      ))()}

                    </div>

                    {/* Right: Print Control Buttons */}
                    <div className="ml-auto flex items-center justify-end gap-2 flex-shrink-0">
                      {/* Pause/Resume button */}
                      {(() => {
                        const pauseUnavailable = !isPrinting || isControlBusy || !hasPermission('printers:control');
                        return (
                      <button
                        onClick={() => isPaused ? setShowResumeConfirm(true) : setShowPauseConfirm(true)}
                        disabled={pauseUnavailable}
                        className={`
                          ${printControlClass}
                          ${pauseUnavailable
                            ? unavailablePrintActionClass
                            : isPaused
                              ? 'bg-bambu-green/20 text-bambu-green hover:bg-bambu-green/30'
                              : 'bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30'
                          }
                        `}
                        title={!hasPermission('printers:control') ? t('printers.permission.noControl') : (isPaused ? t('printers.resume') : t('printers.pause'))}
                      >
                        {isPaused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                        {isPaused ? t('printers.resume') : t('printers.pause')}
                      </button>
                        );
                      })()}

                      {/* Stop button */}
                      {(() => {
                        const stopUnavailable = !isPrinting || isControlBusy || !hasPermission('printers:control');
                        return (
                      <button
                        onClick={() => setShowStopConfirm(true)}
                        disabled={stopUnavailable}
                        className={`
                          ${printControlClass}
                          ${stopUnavailable
                            ? unavailablePrintActionClass
                            : 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                          }
                        `}
                        title={!hasPermission('printers:control') ? t('printers.permission.noControl') : t('printers.stop')}
                      >
                        <Square className="w-3 h-3" />
                        {t('printers.stop')}
                      </button>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* AMS Units - 2-Column Grid Layout */}
            {(amsData?.length > 0 || status.vt_tray.length > 0) && (() => {
              // Separate regular AMS (4-tray) from HT AMS (1-tray)
              const regularAms = amsData.filter(ams => ams.tray.length > 1);
              const htAms = amsData.filter(ams => ams.tray.length === 1);
              const isDualNozzle = printer.nozzle_count === 2 || status?.temperatures?.nozzle_2 !== undefined;
              const filamentSlotClass = 'min-w-14';
              // #1762 (comment 2): while a print is running/paused, overlay a small
              // "P1 / P2 / P3" pill on each slot referenced by the active print's
              // mapping. Catches the reporter's scenario — "any X1C" queue job
              // staged to a printer with mismatched filament: the wrong-slot pill
              // is visible the instant printing starts.
              const isPrintingForMapping = status.state === 'RUNNING' || status.state === 'PAUSE';
              const activeMapping: number[] = isPrintingForMapping && Array.isArray(status.ams_mapping)
                ? status.ams_mapping
                : [];
              const getAmsCardStyle = (slotCount: number): React.CSSProperties => {
                const boundedSlotCount = Math.max(1, slotCount);
                const gapCount = Math.max(0, boundedSlotCount - 1);
                const minWidth = `calc(${boundedSlotCount} * 3.5rem + ${gapCount} * 0.25rem + 1rem)`;
                return {
                  flex: `1 1 ${minWidth}`,
                  minWidth,
                };
              };

              return (
                <div className="mt-3">
                  {/* Section Header */}
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[10px] uppercase tracking-wider text-bambu-gray font-medium">
                      {t('printers.filaments')}
                    </span>
                    <AmsBackupBadge
                      state={status.ams_filament_backup}
                      onClick={() => setAmsBackupModalOpen(true)}
                    />
                    <div className="flex-1 h-[2px] bg-bambu-dark-tertiary" />
                  </div>

                  {/* AMS Content */}
                  <div className="flex flex-wrap gap-2">
                    {/* Regular AMS units */}
                    {regularAms.map((ams) => {
                      const mappedExtruderId = amsExtruderMap[String(ams.id)];
                      const normalizedId = ams.id >= 128 ? ams.id - 128 : ams.id;
                      const extruderId = mappedExtruderId !== undefined ? mappedExtruderId : normalizedId;
                      const isLeftNozzle = extruderId === 1;
                      const isRightNozzle = extruderId === 0;

                      const historyLabel = getAmsLabel(ams.id, ams.tray.length);
                      return (
                        <ExpandedAmsUnitCard key={ams.id} amsId={ams.id} style={getAmsCardStyle(4)}>
                            <AmsUnitHeader
                              label={<AmsNameHoverCard
                                  ams={ams}
                                  printerId={printer.id}
                                  label={historyLabel}
                                  amsLabels={amsLabels}
                                  canEdit={hasPermission('printers:update')}
                                  onSaved={refetchAmsLabels}
                                >
                                  <span className="block truncate text-[10px] text-white font-medium cursor-default select-none">
                                    {amsLabels?.[ams.id] || getAmsLabel(ams.id, ams.tray.length)}
                                  </span>
                                </AmsNameHoverCard>}
                              badge={isDualNozzle && (isLeftNozzle || isRightNozzle) ? <NozzleBadge side={isLeftNozzle ? 'L' : 'R'} /> : undefined}
                              environment={<AmsEnvironmentIndicators
                                ams={ams}
                                thresholds={amsThresholds}
                                onHumidityClick={() => setAmsHistoryModal({ amsId: ams.id, amsLabel: historyLabel, mode: 'humidity' })}
                                onTemperatureClick={() => setAmsHistoryModal({ amsId: ams.id, amsLabel: historyLabel, mode: 'temperature' })}
                              />}
                              dryingControl={<AmsDryingControl ams={ams} supportsDrying={status.supports_drying === true} canControl={hasPermission('printers:control')} controller={dryingControls} />}
                            />
                            <AmsDryingStatus ams={ams} controller={dryingControls} canControl={hasPermission('printers:control')} />
                            <AmsSlotGrid ams={ams} variant="expanded" renderSlot={(tray, slotIdx) => {
                                const isEmpty = !tray?.tray_type;
                                const emptyKind = getEmptySlotKind(tray);
                                // Check if this is the currently loaded tray
                                // Global tray ID = ams.id * 4 + slot index (for standard AMS)
                                const globalTrayId = ams.id * 4 + slotIdx;
                                const isActive = effectiveTrayNow === globalTrayId;
                                // Get cloud preset info if available
                                const cloudInfo = tray?.tray_info_idx ? filamentInfo?.[tray.tray_info_idx] : null;
                                // Get saved slot preset mapping (for user-configured slots)
                                const slotPreset = slotPresets?.[getSlotPresetKey(ams.id, slotIdx)];

                                const inventoryAssignment = onGetAssignment?.(printer.id, ams.id, slotIdx);
                                const slotModel = resolveAmsSlotModel({
                                  tray,
                                  printerId: printer.id,
                                  printerSerial: printer.serial_number,
                                  amsId: ams.id,
                                  trayId: slotIdx,
                                  slotPreset,
                                  cloudInfo,
                                  spoolmanEnabled,
                                  spoolmanLoading,
                                  linkedSpools,
                                  spoolmanSpools,
                                  spoolmanSlotAssignments,
                                  inventoryAssignment,
                                });
                                const { fillLevel: effectiveFill } = slotModel;

                                // Check if this specific slot is being refreshed
                                const isRefreshing = refreshingSlot?.amsId === ams.id &&
                                  refreshingSlot?.slotId === slotIdx;

                                // #1762 (comment 2): which print-slot is mapped to THIS AMS slot.
                                const activePrintSlotIdx = activeMapping.indexOf(globalTrayId);
                                const activePrintSlotLabel = activePrintSlotIdx >= 0
                                  ? `P${activePrintSlotIdx + 1}`
                                  : null;
                                // Slot visual content (goes inside hover card)
                                const slotVisual = (
                                  <div
                                    className={`relative w-full bg-bambu-dark-secondary rounded-lg p-1 text-center ${isEmpty ? 'opacity-50' : ''} ${isActive ? 'ring-2 ring-bambu-green ring-offset-1 ring-offset-bambu-dark' : ''}`}
                                  >
                                    {activePrintSlotLabel && (
                                      <span
                                        aria-label={t('printers.activeJobSlot.ariaLabel', { n: activePrintSlotIdx + 1 })}
                                        title={t('printers.activeJobSlot.title', { n: activePrintSlotIdx + 1 })}
                                        className="absolute top-0.5 right-0.5 px-1 py-px text-[8px] font-bold text-bambu-dark bg-bambu-green rounded pointer-events-none leading-none"
                                      >
                                        {activePrintSlotLabel}
                                      </span>
                                    )}
                                    {/* Filament color circle with 1-based slot number centered inside */}
                                    <FilamentSlotCircle
                                      trayColor={tray?.tray_color}
                                      trayType={tray?.tray_type}
                                      isEmpty={isEmpty}
                                      emptyKind={emptyKind}
                                      slotNumber={slotIdx + 1}
                                    />
                                    <div className="text-[9px] text-white font-bold truncate">
                                      {tray?.tray_type || t(emptyKind === 'reset' ? 'ams.slotUnconfigured' : 'ams.slotEmpty')}
                                    </div>
                                    {/* Fill bar */}
                                    <div className="mt-1 h-1.5 bg-black/30 rounded-full overflow-hidden">
                                      {effectiveFill !== null && effectiveFill >= 0 && !isEmpty && tray && (
                                        <div
                                          className="h-full rounded-full transition-all"
                                          style={{
                                            width: `${effectiveFill}%`,
                                            backgroundColor: getFillBarColor(effectiveFill),
                                          }}
                                        />
                                      )}
                                    </div>
                                  </div>
                                );

                                // Wrapper with menu button, dropdown, and loading overlay (outside hover card)
                                return (
                                  <div key={slotIdx} className={`relative group w-full ${filamentSlotClass}`}>
                                    {/* Loading overlay during RFID re-read */}
                                    {isRefreshing && (
                                      <div className="absolute inset-0 bg-bambu-dark-tertiary/80 rounded flex items-center justify-center z-20">
                                        <RefreshCw className="w-4 h-4 text-bambu-green animate-spin" />
                                      </div>
                                    )}
                                    <AmsSlot
                                      controller={amsSlotController}
                                      slot={{
                                        amsId: ams.id,
                                        trayId: slotIdx,
                                        trayCount: ams.tray.length,
                                        tray,
                                        slotPreset,
                                        location: `${getAmsLabel(ams.id, ams.tray.length)} Slot ${slotIdx + 1}`,
                                        model: slotModel,
                                      }}
                                      emptyKind={emptyKind}
                                      actions={renderAmsSlotActions({
                                        amsId: ams.id,
                                        slotId: slotIdx,
                                        loadTrayId: ams.id * 4 + slotIdx,
                                        isRefreshing,
                                      })}
                                    >
                                      {slotVisual}
                                    </AmsSlot>
                                  </div>
                                );
                              }} />
                        </ExpandedAmsUnitCard>
                      );
                    })}
                    {/* HT AMS units */}
                    {htAms.map((ams) => {
                      const mappedExtruderId = amsExtruderMap[String(ams.id)];
                      const normalizedId = ams.id >= 128 ? ams.id - 128 : ams.id;
                      const extruderId = mappedExtruderId !== undefined ? mappedExtruderId : normalizedId;
                      const isLeftNozzle = extruderId === 1;
                      const isRightNozzle = extruderId === 0;
                      const tray = ams.tray[0];
                      const htSlotId = tray?.id ?? 0;
                      const isEmpty = !tray?.tray_type;
                      const emptyKind = getEmptySlotKind(tray);
                      // Check if this is the currently loaded tray
                      const globalTrayId = getGlobalTrayId(ams.id, tray?.id ?? 0, false);
                      const isActive = effectiveTrayNow === globalTrayId;
                      // Get cloud preset info if available
                      const cloudInfo = tray?.tray_info_idx ? filamentInfo?.[tray.tray_info_idx] : null;
                      // Get saved slot preset mapping (for user-configured slots)
                      const slotPreset = slotPresets?.[getSlotPresetKey(ams.id, htSlotId)];

                        const htInventoryAssignment = onGetAssignment?.(printer.id, ams.id, htSlotId);
                        const htSlotModel = resolveAmsSlotModel({
                          tray,
                          printerId: printer.id,
                          printerSerial: printer.serial_number,
                          amsId: ams.id,
                          trayId: htSlotId,
                          slotPreset,
                          cloudInfo,
                          spoolmanEnabled,
                          spoolmanLoading,
                          linkedSpools,
                          spoolmanSpools,
                          spoolmanSlotAssignments,
                          inventoryAssignment: htInventoryAssignment,
                        });
                        const { fillLevel: htEffectiveFill } = htSlotModel;

                        // Check if this specific slot is being refreshed
                        const isHtRefreshing = refreshingSlot?.amsId === ams.id &&
                          refreshingSlot?.slotId === htSlotId;

                        // #1762 (comment 2): active print-slot index for this HT slot.
                        const htActivePrintSlotIdx = activeMapping.indexOf(globalTrayId);
                        const htActivePrintSlotLabel = htActivePrintSlotIdx >= 0
                          ? `P${htActivePrintSlotIdx + 1}`
                          : null;
                        // Slot visual content (goes inside hover card)
                        const slotVisual = (
                          <div
                            className={`relative w-full bg-bambu-dark-secondary rounded-lg p-1 text-center ${isEmpty ? 'opacity-50' : ''} ${isActive ? 'ring-2 ring-bambu-green ring-offset-1 ring-offset-bambu-dark' : ''}`}
                          >
                            {htActivePrintSlotLabel && (
                              <span
                                aria-label={t('printers.activeJobSlot.ariaLabel', { n: htActivePrintSlotIdx + 1 })}
                                title={t('printers.activeJobSlot.title', { n: htActivePrintSlotIdx + 1 })}
                                className="absolute top-0.5 right-0.5 px-1 py-px text-[8px] font-bold text-bambu-dark bg-bambu-green rounded pointer-events-none leading-none"
                              >
                                {htActivePrintSlotLabel}
                              </span>
                            )}
                            {/* Filament color circle with 1-based slot number centered inside */}
                            <FilamentSlotCircle
                              trayColor={tray?.tray_color}
                              trayType={tray?.tray_type}
                              isEmpty={isEmpty}
                              emptyKind={emptyKind}
                              slotNumber={1}
                            />
                            <div className="text-[9px] text-white font-bold truncate">
                              {tray?.tray_type || t(emptyKind === 'reset' ? 'ams.slotUnconfigured' : 'ams.slotEmpty')}
                            </div>
                            {/* Fill bar */}
                            <div className="mt-1 h-1.5 bg-black/30 rounded-full overflow-hidden">
                              {htEffectiveFill !== null && htEffectiveFill >= 0 && !isEmpty && (
                                <div
                                  className="h-full rounded-full transition-all"
                                  style={{
                                    width: `${htEffectiveFill}%`,
                                    backgroundColor: getFillBarColor(htEffectiveFill),
                                  }}
                                />
                              )}
                            </div>
                          </div>
                        );

                        // HT cards lay out slot + stats side-by-side in Row 2 (not stats-in-header
                        // like regular AMS), so they need more horizontal room than a 1-slot basis.
                        // Without this override, the L view squishes HT into a sliver next to the
                        // 4-slot AMS neighbors.
                        const htCardStyle: React.CSSProperties = { flex: '1 1 11rem', minWidth: '11rem' };
                        const historyLabel = getAmsLabel(ams.id, ams.tray.length);
                        return (
                          <HtAmsUnitCard key={ams.id} amsId={ams.id} style={htCardStyle}>
                            <AmsUnitHeader
                              label={<AmsNameHoverCard
                                  ams={ams}
                                  printerId={printer.id}
                                  label={historyLabel}
                                  amsLabels={amsLabels}
                                  canEdit={hasPermission('printers:update')}
                                  onSaved={refetchAmsLabels}
                                >
                                  <span className="block truncate text-[10px] text-white font-medium cursor-default select-none">
                                    {amsLabels?.[ams.id] || getAmsLabel(ams.id, ams.tray.length)}
                                  </span>
                                </AmsNameHoverCard>}
                              badge={isDualNozzle && (isLeftNozzle || isRightNozzle) ? <NozzleBadge side={isLeftNozzle ? 'L' : 'R'} /> : undefined}
                              dryingControl={<AmsDryingControl ams={ams} supportsDrying={status.supports_drying === true} canControl={hasPermission('printers:control')} controller={dryingControls} />}
                            />
                            <AmsDryingStatus ams={ams} controller={dryingControls} canControl={hasPermission('printers:control')} />
                            {/* Row 2: Slot (left) + Stats (right stacked) */}
                            <div className="flex gap-1.5 max-[550px]:flex-col max-[550px]:items-start">
                              {/* Slot wrapper with loading overlay */}
                              <div className="relative group min-w-14 flex-1">
                                {/* Loading overlay during RFID re-read */}
                                {isHtRefreshing && (
                                  <div className="absolute inset-0 bg-bambu-dark-tertiary/80 rounded flex items-center justify-center z-20">
                                    <RefreshCw className="w-4 h-4 text-bambu-green animate-spin" />
                                  </div>
                                )}
                                <AmsSlot
                                  controller={amsSlotController}
                                  slot={{
                                    amsId: ams.id,
                                    trayId: htSlotId,
                                    trayCount: ams.tray.length,
                                    tray,
                                    slotPreset,
                                    location: getAmsLabel(ams.id, ams.tray.length),
                                    model: htSlotModel,
                                  }}
                                  emptyKind={emptyKind}
                                  actions={renderAmsSlotActions({
                                    amsId: ams.id,
                                    slotId: htSlotId,
                                    loadTrayId: ams.id * 4 + htSlotId,
                                    isRefreshing: isHtRefreshing,
                                  })}
                                >
                                  {slotVisual}
                                </AmsSlot>
                              </div>
                              <AmsEnvironmentIndicators
                                ams={ams}
                                thresholds={amsThresholds}
                                layout="stacked"
                                onHumidityClick={() => setAmsHistoryModal({ amsId: ams.id, amsLabel: historyLabel, mode: 'humidity' })}
                                onTemperatureClick={() => setAmsHistoryModal({ amsId: ams.id, amsLabel: historyLabel, mode: 'temperature' })}
                              />
                            </div>
                          </HtAmsUnitCard>
                        );
                      })}
                      {/* External spool(s) - grouped in one card like regular AMS */}
                      {status.vt_tray.length > 0 && (
                        <div style={getAmsCardStyle(status.vt_tray.length)} className="min-w-0 p-2 bg-bambu-dark rounded-[10px] space-y-1">
                          <div className="flex w-full min-h-7 items-center gap-1.5 rounded-lg bg-bambu-dark-secondary px-2 py-1">
                            <span className="block min-w-0 flex-1 truncate text-[10px] text-white font-medium">{t('printers.external')}</span>
                          </div>
                          <div className={`grid w-full ${status.vt_tray.length > 1 ? 'grid-cols-[repeat(2,minmax(3.5rem,1fr))]' : 'grid-cols-[minmax(3.5rem,1fr)]'} gap-1`}>
                            {[...status.vt_tray].sort((a, b) => (a.id ?? 254) - (b.id ?? 254)).map((extTray) => {
                              const extTrayId = extTray.id ?? 254;
                              // On dual-nozzle (H2C/H2D), tray_now=254 means "external spool"
                              // generically — use active_extruder to determine L vs R:
                              // extruder 1=left → Ext-L (id=254), extruder 0=right → Ext-R (id=255)
                              const isExtActive = isDualNozzle && effectiveTrayNow === 254
                                ? (extTrayId === 254 && status.active_extruder === 1) ||
                                  (extTrayId === 255 && status.active_extruder === 0)
                                : effectiveTrayNow === extTrayId;
                              const slotTrayId = extTrayId - 254; // 0 or 1
                              const extLabel = isDualNozzle
                                ? (extTrayId === 254 ? t('printers.extL') : t('printers.extR'))
                                : '';
                              const extCloudInfo = extTray.tray_info_idx ? filamentInfo?.[extTray.tray_info_idx] : null;
                              const extSlotPreset = slotPresets?.[getSlotPresetKey(255, slotTrayId)];

                              const extInventoryAssignment = onGetAssignment?.(printer.id, 255, slotTrayId);
                              const extSlotModel = resolveAmsSlotModel({
                                tray: extTray,
                                printerId: printer.id,
                                printerSerial: printer.serial_number,
                                amsId: 255,
                                trayId: slotTrayId,
                                slotPreset: extSlotPreset,
                                cloudInfo: extCloudInfo,
                                spoolmanEnabled,
                                spoolmanLoading,
                                linkedSpools,
                                spoolmanSpools,
                                spoolmanSlotAssignments,
                                inventoryAssignment: extInventoryAssignment,
                              });
                              const { fillLevel: extEffectiveFill } = extSlotModel;

                              const isEmpty = !extTray.tray_type;
                              const emptyKind = getEmptySlotKind(extTray);
                              const extSlotContent = (
                                <div className={`w-full bg-bambu-dark-secondary rounded-lg p-1 text-center ${isEmpty ? 'opacity-50' : ''} ${isExtActive ? 'ring-2 ring-bambu-green ring-offset-1 ring-offset-bambu-dark' : ''}`}>
                                  {/* Color circle: L/R inside on dual-nozzle external (replaces
                                      the separate Ext-L/Ext-R caption that made the row taller than
                                      regular AMS slots), 1-based slot number on single-nozzle. */}
                                  <FilamentSlotCircle
                                    trayColor={extTray.tray_color}
                                    trayType={extTray.tray_type}
                                    isEmpty={isEmpty}
                                    emptyKind={emptyKind}
                                    slotNumber={isDualNozzle ? (extTrayId === 254 ? 'L' : 'R') : slotTrayId + 1}
                                  />
                                  <div className={`text-[9px] font-bold truncate ${isEmpty ? 'text-white/40' : 'text-white'}`}>
                                    {extTray.tray_type || t('ams.slotEmpty')}
                                  </div>
                                  <div className="mt-1 h-1.5 bg-black/30 rounded-full overflow-hidden">
                                    {extEffectiveFill !== null && extEffectiveFill >= 0 && !isEmpty && (
                                      <div
                                        className="h-full rounded-full transition-all"
                                        style={{
                                          width: `${extEffectiveFill}%`,
                                          backgroundColor: getFillBarColor(extEffectiveFill),
                                        }}
                                      />
                                    )}
                                  </div>
                                </div>
                              );

                              return (
                                <div key={extTrayId} className={`relative group w-full ${filamentSlotClass}`}>
                                  <AmsSlot
                                    controller={amsSlotController}
                                    slot={{
                                      amsId: 255,
                                      trayId: slotTrayId,
                                      trayCount: 1,
                                      tray: extTray,
                                      slotPreset: extSlotPreset,
                                      location: extLabel || t('printers.external'),
                                      emptyLocation: `External Slot ${slotTrayId + 1}`,
                                      model: extSlotModel,
                                    }}
                                    emptyKind={emptyKind}
                                    actions={renderAmsSlotActions({
                                      amsId: 255,
                                      slotId: slotTrayId,
                                      loadTrayId: extTrayId,
                                      includeRfid: false,
                                    })}
                                  >
                                    {extSlotContent}
                                  </AmsSlot>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                  </div>
                </div>
              );
            })()}
          </>
        )}

        {/* Bottom block (power row + action bar). Wrapped together so the
            power row hugs the action bar at the card bottom instead of
            floating up when there's less filament content above. */}
        <div className="mt-auto">
        <PrinterPowerControls key={printer.id} printer={printer} isPrintingOrPaused={isPrintingOrPaused} className="pt-3" />

        {/* Connection Info & Actions */}
        <div className="pt-4">
            <div className="mb-3 h-[2px] bg-bambu-dark-tertiary" />
            <div className="flex items-center justify-between gap-2">
              {printerActionsMenu}
              <div className="flex items-center justify-end gap-2 flex-wrap">
                {/* Camera Button */}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    if (cameraViewMode === 'embedded' && onOpenEmbeddedCamera) {
                      onOpenEmbeddedCamera(printer.id, printer.name);
                    } else {
                      // Use saved window state or defaults
                      const saved = localStorage.getItem('cameraWindowState');
                      const state = saved ? JSON.parse(saved) : { width: 640, height: 400 };
                      const features = [
                        `width=${state.width}`,
                        `height=${state.height}`,
                        state.left !== undefined ? `left=${state.left}` : '',
                        state.top !== undefined ? `top=${state.top}` : '',
                        // No `noopener`: same-origin popup needs opener so the browser
                        // copies sessionStorage (auth token) into the new window.
                        'menubar=no,toolbar=no,location=no,status=no',
                      ].filter(Boolean).join(',');
                      window.open(`/camera/${printer.id}`, `camera-${printer.id}`, features);
                    }
                  }}
                  disabled={!status?.connected || !hasPermission('camera:view')}
                  title={!hasPermission('camera:view') ? t('printers.permission.noCamera') : (cameraViewMode === 'embedded' ? t('printers.openCameraOverlay') : t('printers.openCameraWindow'))}
                  className={footerIconButtonClass}
                >
                  <Video className="w-4 h-4" />
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowFileManager(true)}
                  disabled={!isConnected || !hasPermission('printers:files')}
                  title={!hasPermission('printers:files') ? t('printers.permission.noFiles') : t('printers.browseFiles')}
                  className={footerIconButtonClass}
                >
                  <HardDrive className="w-4 h-4" />
                </Button>
                <Button
                  size="sm"
                  onClick={() => setShowUploadForPrint(true)}
                  disabled={!hasPermission('library:upload') || !hasPermission('queue:create')}
                  title={
                    !hasPermission('library:upload')
                      ? t('fileManager.noPermissionUpload')
                      : !hasPermission('queue:create')
                        ? t('fileManager.noPermissionAddToQueue')
                        : t('common.print')
                  }
                  className={`${footerActionButtonClass} !bg-bambu-green hover:!bg-bambu-green/80 !text-white`}
                >
                  <PrinterIcon className="w-4 h-4" />
                  {t('common.print')}
                </Button>
              </div>
            </div>
        </div>
        </div>
      </CardContent>

      {/* File Manager Modal */}
      {showFileManager && (
        <FileManagerModal
          printerId={printer.id}
          printerName={printer.name}
          onClose={() => setShowFileManager(false)}
        />
      )}

      {/* Upload for Print Modal */}
      {showUploadForPrint && (
        <FileUploadModal
          folderId={null}
          onClose={() => setShowUploadForPrint(false)}
          onUploadComplete={() => {}}
          autoUpload
          accept=".gcode,.3mf"
          validateFile={(file) => {
            const lower = file.name.toLowerCase();
            if (!lower.endsWith('.gcode') && !lower.includes('.gcode.')) {
              return t('printers.dropNotPrintable', 'Only .gcode and .gcode.3mf files can be printed');
            }
          }}
          onFileUploaded={(uploadedFile) => {
            // Check printer compatibility if sliced_for_model is available in metadata
            const slicedFor = (uploadedFile.metadata as Record<string, unknown>)?.sliced_for_model as string | undefined;
            const printerModel = mapModelCode(printer.model);
            if (slicedFor && printerModel && slicedFor.toLowerCase() !== printerModel.toLowerCase()) {
              api.deleteLibraryFile(uploadedFile.id).catch(() => {});
              return t('printers.incompatibleFile', 'This file was sliced for {{slicedFor}}, but this printer is a {{printerModel}}', { slicedFor, printerModel });
            }
            setPrintAfterUpload({ id: uploadedFile.id, filename: uploadedFile.filename });
          }}
        />
      )}

      {/* Print Modal (after upload) */}
      {printAfterUpload && (
        <PrintModal
          mode="create"
          libraryFileId={printAfterUpload.id}
          archiveName={printAfterUpload.filename}
          initialSelectedPrinterIds={[printer.id]}
          onClose={() => setPrintAfterUpload(null)}
          onSuccess={() => setPrintAfterUpload(null)}
          cleanupLibraryAfterDispatch
        />
      )}

      {/* MQTT Debug Modal */}
      {showMQTTDebug && (
        <MQTTDebugModal
          printerId={printer.id}
          printerName={printer.name}
          onClose={() => setShowMQTTDebug(false)}
        />
      )}

      {showDiagnostic && (
        <ConnectionDiagnosticModal
          printerId={printer.id}
          printerName={printer.name}
          onClose={() => setShowDiagnostic(false)}
        />
      )}

      {showPrinterInfo && (
        <PrinterInfoModal
          printer={printer}
          status={status}
          totalPrintHours={maintenanceInfo?.total_print_hours}
          onClose={closePrinterInfo}
        />
      )}

      {/* Maintenance Mode mid-print confirmation (#1476) — entering maintenance
          disconnects MQTT, which stops progress tracking + completion
          notifications for the in-flight job. Idle / FINISH / FAILED states
          skip this dialog and toggle directly. */}
      {confirmMaintenanceEnter && (
        <ConfirmModal
          title={t('printers.maintenance.confirmMidPrintTitle')}
          message={t('printers.maintenance.confirmMidPrintMessage', { name: printer.name })}
          confirmText={t('printers.maintenance.menuEnter')}
          variant="danger"
          onConfirm={() => {
            maintenanceMutation.mutate(false);
            setConfirmMaintenanceEnter(false);
          }}
          onCancel={() => setConfirmMaintenanceEnter(false)}
        />
      )}

      <PrinterStopPrintConfirmation
        printerName={printer.name}
        isOpen={showStopConfirm}
        onStop={() => stopPrintMutation.mutate()}
        onClose={() => setShowStopConfirm(false)}
      />

      {/* Pause Print Confirmation */}
      {showPauseConfirm && (
        <ConfirmModal
          title={t('printers.confirm.pauseTitle')}
          message={t('printers.confirm.pauseMessage', { name: printer.name })}
          confirmText={t('printers.confirm.pauseButton')}
          variant="default"
          onConfirm={() => {
            pausePrintMutation.mutate();
            setShowPauseConfirm(false);
          }}
          onCancel={() => setShowPauseConfirm(false)}
        />
      )}

      {/* Resume Print Confirmation */}
      {showResumeConfirm && (
        <ConfirmModal
          title={t('printers.confirm.resumeTitle')}
          message={t('printers.confirm.resumeMessage', { name: printer.name })}
          confirmText={t('printers.confirm.resumeButton')}
          variant="default"
          onConfirm={() => {
            resumePrintMutation.mutate();
            setShowResumeConfirm(false);
          }}
          onCancel={() => setShowResumeConfirm(false)}
        />
      )}

      {/* Bed Jog — not-homed warning (Studio-style) */}
      {showNotHomedModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-xl w-full max-w-sm p-5">
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-semibold text-white mb-1">
                  {t('printers.bedJog.notHomedTitle')}
                </h3>
                <p className="text-xs text-bambu-gray leading-relaxed">
                  {t('printers.bedJog.notHomedMessage')}
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => {
                  homeAxesMutation.mutate('all');
                  setShowNotHomedModal(null);
                }}
                className="w-full px-3 py-2 rounded-lg text-xs font-medium bg-bambu-green/20 text-bambu-green hover:bg-bambu-green/30 transition-colors"
              >
                {t('printers.bedJog.homeZ')}
              </button>
              <button
                onClick={() => {
                  const d = showNotHomedModal.distance;
                  try { sessionStorage.setItem(`bambuddy.bedJog.warned.${printer.id}`, '1'); } catch { /* ignore */ }
                  bedJogMutation.mutate({ distance: d, force: true });
                  setShowNotHomedModal(null);
                }}
                className="w-full px-3 py-2 rounded-lg text-xs font-medium bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 transition-colors"
              >
                {t('printers.bedJog.moveAnyway')}
              </button>
              <button
                onClick={() => setShowNotHomedModal(null)}
                className="w-full px-3 py-2 rounded-lg text-xs font-medium bg-bambu-dark text-bambu-gray hover:bg-bambu-dark-tertiary transition-colors"
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Skip Objects Modal */}
      <SkipObjectsModal
        printerId={printer.id}
        isOpen={showSkipObjectsModal}
        onClose={() => setShowSkipObjectsModal(false)}
      />

      {/* HMS Error Modal */}
      {showHMSModal && (
        <HMSErrorModal
          printerName={printer.name}
          errors={status?.hms_errors || []}
          onClose={() => setShowHMSModal(false)}
          printerId={printer.id}
          hasPermission={hasPermission}
        />
      )}

      {/* AMS Filament Backup status / control modal (#1762) */}
      {amsBackupModalOpen && status && (
        <AmsBackupModal
          isOpen={amsBackupModalOpen}
          state={status.ams_filament_backup}
          amsUnits={status.ams}
          amsExtruderMap={status.ams_extruder_map}
          isDualNozzle={printer.nozzle_count === 2 || status?.temperatures?.nozzle_2 !== undefined}
          canToggle={hasPermission('printers:control')}
          pending={setAmsBackupMutation.isPending}
          onToggle={(next) => setAmsBackupMutation.mutate(next)}
          onClose={() => setAmsBackupModalOpen(false)}
        />
      )}

      {/* AMS History Modal */}
      {amsHistoryModal && (
        <AMSHistoryModal
          isOpen={!!amsHistoryModal}
          onClose={() => setAmsHistoryModal(null)}
          printerId={printer.id}
          printerName={printer.name}
          amsId={amsHistoryModal.amsId}
          amsLabel={amsHistoryModal.amsLabel}
          initialMode={amsHistoryModal.mode}
          thresholds={amsThresholds}
        />
      )}

      <AmsSlotControllerModals controller={amsSlotController} />

      {/* Edit Printer Modal */}
      {showEditModal && (
        <EditPrinterModal
          printer={printer}
          onClose={() => setShowEditModal(false)}
        />
      )}

      {/* Firmware Update Modal */}
      {showFirmwareModal && firmwareInfo && (
        <FirmwareUpdateModal
          printer={printer}
          firmwareInfo={firmwareInfo}
          onClose={() => setShowFirmwareModal(false)}
        />
      )}

      <AmsDryingPopover controller={dryingControls} />
    </Card>
  );
}

export function AddPrinterModal({
  onClose,
  onAdd,
  existingSerials,
}: {
  onClose: () => void;
  onAdd: (data: PrinterCreate) => void;
  existingSerials: string[];
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<PrinterCreate>({
    name: '',
    serial_number: '',
    ip_address: '',
    access_code: '',
    model: '',
    location: '',
    auto_archive: true,
  });

  // Discovery state
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredPrinter[]>([]);
  const [discoveryError, setDiscoveryError] = useState('');
  const [hasScanned, setHasScanned] = useState(false);
  const [isDocker, setIsDocker] = useState(false);
  const [detectedSubnets, setDetectedSubnets] = useState<string[]>([]);
  const [subnet, setSubnet] = useState('');
  // Custom subnet — `__custom__` sentinel in the dropdown reveals a CIDR
  // text input so users can scan a subnet Grove Control isn't directly on
  // (printer behind a router on a different L3 segment — SSDP multicast
  // won't cross that boundary, only an active unicast scan will). #1564
  const [customSubnet, setCustomSubnet] = useState('');
  const [useCustomSubnet, setUseCustomSubnet] = useState(false);
  const [scanProgress, setScanProgress] = useState({ scanned: 0, total: 0 });
  const [showDiagnostic, setShowDiagnostic] = useState(false);

  // Setup-time pre-flight: run the connection diagnostic on save and warn
  // (not block) when checks fail, so the user doesn't add a printer that
  // immediately shows offline. checkingSave = probe in flight; saveWarning =
  // failed result awaiting an explicit "save anyway".
  const [checkingSave, setCheckingSave] = useState(false);
  const [saveWarning, setSaveWarning] = useState<PrinterDiagnosticResult | null>(null);

  // Fetch discovery info on mount + restore the last custom CIDR the user
  // typed (kept in localStorage so they don't retype `10.1.1.0/24` every
  // time they open this modal).
  useEffect(() => {
    discoveryApi.getInfo().then(info => {
      setIsDocker(info.is_docker);
      if (info.subnets.length > 0) {
        setDetectedSubnets(info.subnets);
        setSubnet(info.subnets[0]);
      }
    }).catch(() => {
      // Ignore errors, assume not Docker
    });
    try {
      const saved = localStorage.getItem('bambuddy.discovery.customSubnet');
      if (saved) setCustomSubnet(saved);
    } catch {
      // localStorage unavailable (private mode, quota); recall is opportunistic
    }
  }, []);

  // Filter out already-added printers
  const newPrinters = discovered.filter(p => !existingSerials.includes(p.serial));

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCheckingSave(true);
    try {
      const result = await api.diagnoseConnection({
        ip_address: form.ip_address.trim(),
        serial_number: form.serial_number.trim() || undefined,
        access_code: form.access_code || undefined,
      });
      if (result.checks.some((c) => c.status === 'fail')) {
        setSaveWarning(result);
        return;
      }
    } catch {
      // Diagnostic infrastructure failed — never block the save on it.
    } finally {
      setCheckingSave(false);
    }
    onAdd(form);
  };

  const startDiscovery = async () => {
    setDiscoveryError('');
    setDiscovered([]);
    setDiscovering(true);
    setHasScanned(false);
    setScanProgress({ scanned: 0, total: 0 });

    // Native installs fall back to subnet scanning when the user picks
    // "Custom" — SSDP can't reach a printer on a different L3 segment
    // (#1564). Docker mode always uses subnet scan (multicast unavailable).
    const scanCidr = useCustomSubnet ? customSubnet.trim() : subnet;
    const wantsSubnetScan = isDocker || useCustomSubnet;

    if (wantsSubnetScan && useCustomSubnet) {
      try {
        localStorage.setItem('bambuddy.discovery.customSubnet', scanCidr);
      } catch {
        // localStorage write best-effort; user just retypes next time
      }
    }

    try {
      if (wantsSubnetScan) {
        await discoveryApi.startSubnetScan(scanCidr);

        // Poll for scan status and results
        const pollInterval = setInterval(async () => {
          try {
            const status = await discoveryApi.getScanStatus();
            setScanProgress({ scanned: status.scanned, total: status.total });

            const printers = await discoveryApi.getDiscoveredPrinters();
            setDiscovered(printers);

            if (!status.running) {
              clearInterval(pollInterval);
              setDiscovering(false);
              setHasScanned(true);
            }
          } catch (e) {
            console.error('Failed to get scan status:', e);
          }
        }, 500);
      } else {
        // Use SSDP discovery for native installs
        await discoveryApi.startDiscovery(10);

        // Poll for discovered printers every second
        const pollInterval = setInterval(async () => {
          try {
            const printers = await discoveryApi.getDiscoveredPrinters();
            setDiscovered(printers);
          } catch (e) {
            console.error('Failed to get discovered printers:', e);
          }
        }, 1000);

        // Stop after 10 seconds
        setTimeout(async () => {
          clearInterval(pollInterval);
          try {
            await discoveryApi.stopDiscovery();
          } catch {
            // Ignore stop errors
          }
          setDiscovering(false);
          setHasScanned(true);
          // Final fetch
          try {
            const printers = await discoveryApi.getDiscoveredPrinters();
            setDiscovered(printers);
          } catch (e) {
            console.error('Failed to get final discovered printers:', e);
          }
        }, 10000);
      }
    } catch (e) {
      console.error('Failed to start discovery:', e);
      setDiscoveryError(e instanceof Error ? e.message : t('printers.discovery.failedToStart'));
      setDiscovering(false);
      setHasScanned(true);
    }
  };

  // Reuse module-level mapModelCode

  const selectPrinter = (printer: DiscoveredPrinter) => {
    // Don't pre-fill serial if it's a placeholder (unknown-*) - user needs to enter actual serial
    const serialNumber = printer.serial.startsWith('unknown-') ? '' : printer.serial;
    setForm({
      ...form,
      name: printer.name || '',
      serial_number: serialNumber,
      ip_address: printer.ip_address,
      model: mapModelCode(printer.model),
    });
    // Clear discovery results after selection
    setDiscovered([]);
  };

  // Cleanup discovery on unmount
  useEffect(() => {
    return () => {
      discoveryApi.stopDiscovery().catch(() => {});
      discoveryApi.stopSubnetScan().catch(() => {});
    };
  }, []);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <>
    <div
      className="fixed inset-0 bg-black/50 flex items-start sm:items-center justify-center z-50 p-4 overflow-y-auto"
      onClick={onClose}
    >
      <Card className="w-full max-w-md my-auto max-h-[calc(100vh-2rem)] overflow-y-auto" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
        <CardContent>
          <h2 className="text-xl font-semibold mb-4">{t('printers.addPrinter')}</h2>

          {/* Discovery Section */}
          <div className="mb-4 pb-4 border-b border-bambu-dark-tertiary">
            {/* Subnet picker — always visible. The dropdown lists detected
                interface subnets and a "Custom..." sentinel that reveals
                a CIDR text input for printers on a different L3 segment
                (router, VLAN, etc.). #1564 */}
            <div className="mb-3">
              <label className="block text-sm text-bambu-gray mb-1">
                {t('printers.discovery.subnetToScan')}
              </label>
              {detectedSubnets.length > 0 ? (
                <ReactSelect
                  className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none text-sm"
                  value={useCustomSubnet ? '__custom__' : subnet}
                  onChange={(e) => {
                    if (e.target.value === '__custom__') {
                      setUseCustomSubnet(true);
                    } else {
                      setUseCustomSubnet(false);
                      setSubnet(e.target.value);
                    }
                  }}
                  disabled={discovering}
                >
                  {detectedSubnets.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                  <option value="__custom__">{t('printers.discovery.customSubnetOption')}</option>
                </ReactSelect>
              ) : (
                <input
                  type="text"
                  className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none text-sm"
                  value={subnet}
                  onChange={(e) => setSubnet(e.target.value)}
                  placeholder="192.168.1.0/24"
                  disabled={discovering}
                />
              )}
              {useCustomSubnet && (
                <input
                  type="text"
                  aria-label={t('printers.discovery.customSubnetLabel')}
                  className="mt-2 w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none text-sm"
                  value={customSubnet}
                  onChange={(e) => setCustomSubnet(e.target.value)}
                  placeholder="10.1.1.0/24"
                  disabled={discovering}
                />
              )}
              <p className="mt-1 text-xs text-bambu-gray">
                {isDocker
                  ? t('printers.discovery.dockerNote')
                  : t('printers.discovery.customSubnetNote')}
              </p>
            </div>


            <Button
              type="button"
              variant="secondary"
              onClick={startDiscovery}
              disabled={discovering}
              className="w-full"
            >
              {discovering ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {(isDocker || useCustomSubnet) && scanProgress.total > 0
                    ? t('printers.discovery.scanProgress', { scanned: scanProgress.scanned, total: scanProgress.total })
                    : t('printers.discovery.scanning')}
                </>
              ) : (
                <>
                  <Search className="w-4 h-4" />
                  {(isDocker || useCustomSubnet) ? t('printers.discovery.scanSubnet') : t('printers.discovery.discoverNetwork')}
                </>
              )}
            </Button>

            {discoveryError && (
              <div className="mt-2 text-sm text-red-400">{discoveryError}</div>
            )}

            {newPrinters.length > 0 && (
              <div className="mt-3 space-y-2 max-h-40 overflow-y-auto">
                {newPrinters.map((printer) => (
                  <div
                    key={printer.serial}
                    className="flex items-center justify-between p-2 bg-bambu-dark rounded-lg hover:bg-bambu-dark-secondary cursor-pointer transition-colors"
                    onClick={() => selectPrinter(printer)}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-white text-sm truncate">
                        {printer.name || printer.serial}
                      </p>
                      <p className="text-xs text-bambu-gray truncate">
                        {mapModelCode(printer.model) || t('printers.discovery.unknown')} • {printer.ip_address}
                        {printer.serial.startsWith('unknown-') && (
                          <span className="text-yellow-500"> • {t('printers.discovery.serialRequired')}</span>
                        )}
                      </p>
                    </div>
                    <ChevronDown className="w-4 h-4 text-bambu-gray -rotate-90 flex-shrink-0 ml-2" />
                  </div>
                ))}
              </div>
            )}

            {discovering && (
              <p className="mt-2 text-sm text-bambu-gray text-center">
                {(isDocker || useCustomSubnet) ? t('printers.discovery.scanningSubnet') : t('printers.discovery.scanningNetwork')}
              </p>
            )}

            {hasScanned && !discovering && discovered.length === 0 && (
              <p className="mt-2 text-sm text-bambu-gray text-center">
                {(isDocker || useCustomSubnet) ? t('printers.discovery.noPrintersFoundSubnet') : t('printers.discovery.noPrintersFoundNetwork')}
              </p>
            )}

            {hasScanned && !discovering && discovered.length > 0 && newPrinters.length === 0 && (
              <p className="mt-2 text-sm text-bambu-gray text-center">
                {t('printers.discovery.allConfigured')}
              </p>
            )}
          </div>
          <form onSubmit={handleAddSubmit} className="space-y-4">
            <div>
              <label className="block text-sm text-bambu-gray mb-1">{t('printers.name')}</label>
              <input
                type="text"
                required
                className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t('printers.modal.myPrinter')}
              />
            </div>
            <div>
              <label className="block text-sm text-bambu-gray mb-1">{t('printers.ipAddress')}</label>
              <input
                type="text"
                required
                pattern="(\d{1,3}(\.\d{1,3}){3}|[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*)"
                className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
                value={form.ip_address}
                onChange={(e) => setForm({ ...form, ip_address: e.target.value })}
                placeholder="192.168.1.100 or printer.local"
              />
            </div>
            <div>
              <label className="block text-sm text-bambu-gray mb-1">{t('printers.serialNumber')}</label>
              <input
                type="text"
                required
                className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
                value={form.serial_number}
                onChange={(e) => setForm({ ...form, serial_number: e.target.value })}
                placeholder="01P00A000000000"
              />
            </div>
            <div>
              <label className="block text-sm text-bambu-gray mb-1">{t('printers.accessCode')}</label>
              <input
                type="password"
                required
                className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
                value={form.access_code}
                onChange={(e) => setForm({ ...form, access_code: e.target.value })}
                placeholder={t('printers.modal.fromPrinterSettings')}
              />
            </div>
            <div>
              <label className="block text-sm text-bambu-gray mb-1">{t('printers.modal.modelOptional')}</label>
              <ReactSelect
                className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
                value={form.model || ''}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
              >
                <option value="">{t('printers.modal.selectModel')}</option>
                <optgroup label="A1 Series">
                  <option value="A1">A1</option>
                  <option value="A1 Mini">A1 Mini</option>
                </optgroup>
                <optgroup label="A2 Series">
                  <option value="A2L">A2L</option>
                </optgroup>
                <optgroup label="H2 Series">
                  <option value="H2C">H2C</option>
                  <option value="H2D">H2D</option>
                  <option value="H2D Pro">H2D Pro</option>
                  <option value="H2S">H2S</option>
                </optgroup>
                <optgroup label="P Series">
                  <option value="P1P">P1P</option>
                  <option value="P1S">P1S</option>
                  <option value="P2S">P2S</option>
                </optgroup>
                <optgroup label="X1 Series">
                  <option value="X1">X1</option>
                  <option value="X1C">X1 Carbon</option>
                  <option value="X1E">X1E</option>
                </optgroup>
                <optgroup label="X2 Series">
                  <option value="X2D">X2D</option>
                </optgroup>
              </ReactSelect>
            </div>
            <div>
              <label className="block text-sm text-bambu-gray mb-1">{t('printers.modal.locationGroup')}</label>
              <input
                type="text"
                className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
                value={form.location || ''}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                placeholder={t('printers.modal.locationPlaceholder')}
              />
              <p className="text-xs text-bambu-gray mt-1">{t('printers.locationHelp')}</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="auto_archive"
                checked={form.auto_archive}
                onChange={(e) => setForm({ ...form, auto_archive: e.target.checked })}
                className="rounded border-bambu-dark-tertiary bg-bambu-dark text-bambu-green focus:ring-bambu-green"
              />
              <label htmlFor="auto_archive" className="text-sm text-bambu-gray">
                {t('printers.modal.autoArchiveLabel')}
              </label>
            </div>
            <button
              type="button"
              onClick={() => setShowDiagnostic(true)}
              disabled={!form.ip_address.trim()}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm text-bambu-gray hover:text-white disabled:opacity-40 disabled:cursor-not-allowed border border-bambu-dark-tertiary rounded-lg transition-colors"
            >
              <Stethoscope className="w-4 h-4" />
              {t('diagnostic.runButton')}
            </button>
            {saveWarning ? (
              <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3 space-y-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-400" />
                  <p className="text-sm text-amber-300">{t('printers.addPreflight.warning')}</p>
                </div>
                <DiagnosticChecklist result={saveWarning} />
                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setSaveWarning(null)}
                    className="flex-1"
                  >
                    {t('printers.addPreflight.back')}
                  </Button>
                  <Button type="button" onClick={() => onAdd(form)} className="flex-1">
                    {t('printers.addPreflight.saveAnyway')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex gap-3 pt-2">
                <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
                  {t('common.cancel')}
                </Button>
                <Button type="submit" disabled={checkingSave} className="flex-1">
                  {checkingSave ? t('printers.addPreflight.checking') : t('printers.addPrinter')}
                </Button>
              </div>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
    {showDiagnostic && (
      <ConnectionDiagnosticModal
        connection={{
          ip_address: form.ip_address.trim(),
          serial_number: form.serial_number.trim() || undefined,
          access_code: form.access_code || undefined,
        }}
        printerName={form.name || null}
        onClose={() => setShowDiagnostic(false)}
      />
    )}
    </>
  );
}


function EditPrinterModal({
  printer,
  onClose,
}: {
  printer: Printer;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [form, setForm] = useState({
    name: printer.name,
    ip_address: printer.ip_address,
    access_code: '',
    model: printer.model || '',
    location: printer.location || '',
    auto_archive: printer.auto_archive,
    is_active: printer.is_active,
  });

  // Setup-time pre-flight — same warn-on-save as the Add-Printer dialog, so an
  // edit that breaks connectivity (e.g. a mistyped IP) is caught before save.
  const [checkingSave, setCheckingSave] = useState(false);
  const [saveWarning, setSaveWarning] = useState<PrinterDiagnosticResult | null>(null);

  const updateMutation = useMutation({
    mutationFn: (data: Partial<PrinterCreate>) => api.updatePrinter(printer.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['printers'] });
      queryClient.invalidateQueries({ queryKey: ['printerStatus', printer.id] });
      onClose();
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToUpdate'), 'error'),
  });

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const doSave = () => {
    const data: Partial<PrinterCreate> = {
      name: form.name,
      ip_address: form.ip_address,
      model: form.model || undefined,
      location: form.location || undefined,
      auto_archive: form.auto_archive,
      is_active: form.is_active,
    };
    // Only include access_code if it was changed
    if (form.access_code) {
      data.access_code = form.access_code;
    }
    updateMutation.mutate(data);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCheckingSave(true);
    try {
      const result = await api.diagnoseConnection({
        ip_address: form.ip_address.trim(),
        serial_number: printer.serial_number,
        access_code: form.access_code || undefined,
      });
      if (result.checks.some((c) => c.status === 'fail')) {
        setSaveWarning(result);
        return;
      }
    } catch {
      // Diagnostic infrastructure failed — never block the save on it.
    } finally {
      setCheckingSave(false);
    }
    doSave();
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-start sm:items-center justify-center z-50 p-4 overflow-y-auto"
      onClick={onClose}
    >
      <Card className="w-full max-w-md my-auto max-h-[calc(100vh-2rem)] overflow-y-auto" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
        <CardContent>
          <h2 className="text-xl font-semibold mb-4">{t('printers.editPrinter')}</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm text-bambu-gray mb-1">{t('printers.name')}</label>
              <input
                type="text"
                required
                className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t('printers.modal.myPrinter')}
              />
            </div>
            <div>
              <label className="block text-sm text-bambu-gray mb-1">{t('printers.ipAddress')}</label>
              <input
                type="text"
                required
                pattern="(\d{1,3}(\.\d{1,3}){3}|[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*)"
                className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
                value={form.ip_address}
                onChange={(e) => setForm({ ...form, ip_address: e.target.value })}
                placeholder="192.168.1.100 or printer.local"
              />
            </div>
            <div>
              <label className="block text-sm text-bambu-gray mb-1">{t('printers.serialNumber')}</label>
              <input
                type="text"
                disabled
                className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-bambu-gray cursor-not-allowed"
                value={printer.serial_number}
              />
              <p className="text-xs text-bambu-gray mt-1">{t('printers.serialCannotBeChanged')}</p>
            </div>
            <div>
              <label className="block text-sm text-bambu-gray mb-1">{t('printers.accessCode')}</label>
              <input
                type="password"
                className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
                value={form.access_code}
                onChange={(e) => setForm({ ...form, access_code: e.target.value })}
                placeholder={t('printers.accessCodePlaceholder')}
              />
            </div>
            <div>
              <label className="block text-sm text-bambu-gray mb-1">{t('printers.model')}</label>
              <ReactSelect
                className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
              >
                <option value="">{t('printers.modal.selectModel')}</option>
                <optgroup label="A1 Series">
                  <option value="A1">A1</option>
                  <option value="A1 Mini">A1 Mini</option>
                </optgroup>
                <optgroup label="A2 Series">
                  <option value="A2L">A2L</option>
                </optgroup>
                <optgroup label="H2 Series">
                  <option value="H2C">H2C</option>
                  <option value="H2D">H2D</option>
                  <option value="H2D Pro">H2D Pro</option>
                  <option value="H2S">H2S</option>
                </optgroup>
                <optgroup label="P Series">
                  <option value="P1P">P1P</option>
                  <option value="P1S">P1S</option>
                  <option value="P2S">P2S</option>
                </optgroup>
                <optgroup label="X1 Series">
                  <option value="X1">X1</option>
                  <option value="X1C">X1 Carbon</option>
                  <option value="X1E">X1E</option>
                </optgroup>
                <optgroup label="X2 Series">
                  <option value="X2D">X2D</option>
                </optgroup>
              </ReactSelect>
            </div>
            <div>
              <label className="block text-sm text-bambu-gray mb-1">Location / Group</label>
              <input
                type="text"
                className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                placeholder={t('printers.modal.locationPlaceholder')}
              />
              <p className="text-xs text-bambu-gray mt-1">{t('printers.locationHelp')}</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="edit_auto_archive"
                checked={form.auto_archive}
                onChange={(e) => setForm({ ...form, auto_archive: e.target.checked })}
                className="rounded border-bambu-dark-tertiary bg-bambu-dark text-bambu-green focus:ring-bambu-green"
              />
              <label htmlFor="edit_auto_archive" className="text-sm text-bambu-gray">
                {t('printers.modal.autoArchiveLabel')}
              </label>
            </div>
            {/* Maintenance Mode toggle (#1476) — checkbox is the inverse of
                is_active because the user-facing concept is "is this printer
                in maintenance" not "is it active". */}
            <div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="edit_maintenance_mode"
                  checked={!form.is_active}
                  onChange={(e) => setForm({ ...form, is_active: !e.target.checked })}
                  className="rounded border-bambu-dark-tertiary bg-bambu-dark text-amber-400 focus:ring-amber-400"
                />
                <label htmlFor="edit_maintenance_mode" className="text-sm text-bambu-gray flex items-center gap-1.5">
                  <Wrench className="w-3.5 h-3.5 text-amber-400" />
                  {t('printers.maintenance.editFieldLabel')}
                </label>
              </div>
              <p className="text-xs text-bambu-gray/70 mt-1 ml-6">
                {t('printers.maintenance.editFieldHelp')}
              </p>
            </div>
            {saveWarning ? (
              <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3 space-y-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-400" />
                  <p className="text-sm text-amber-300">{t('printers.addPreflight.warning')}</p>
                </div>
                <DiagnosticChecklist result={saveWarning} />
                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setSaveWarning(null)}
                    className="flex-1"
                  >
                    {t('printers.addPreflight.back')}
                  </Button>
                  <Button
                    type="button"
                    onClick={doSave}
                    className="flex-1"
                    disabled={updateMutation.isPending}
                  >
                    {t('printers.addPreflight.saveAnyway')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex gap-3 pt-4">
                <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
                  {t('common.cancel')}
                </Button>
                <Button
                  type="submit"
                  className="flex-1"
                  disabled={updateMutation.isPending || checkingSave}
                >
                  {checkingSave
                    ? t('printers.addPreflight.checking')
                    : updateMutation.isPending
                      ? t('common.saving')
                      : t('printers.modal.saveChanges')}
                </Button>
              </div>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

// Component to check if a printer is offline (for power dropdown)
function usePrinterOfflineStatus(printerId: number) {
  const { data: status } = useQuery({
    queryKey: ['printerStatus', printerId],
    queryFn: () => api.getPrinterStatus(printerId),
    refetchInterval: 30000,
  });
  return !status?.connected;
}

// Power dropdown item for an offline printer
function PowerDropdownItem({
  printer,
  plug,
  onPowerOn,
  isPowering,
}: {
  printer: Printer;
  plug: { id: number; name: string };
  onPowerOn: (plugId: number) => void;
  isPowering: boolean;
}) {
  const isOffline = usePrinterOfflineStatus(printer.id);

  // Fetch plug status
  const { data: plugStatus } = useQuery({
    queryKey: ['smartPlugStatus', plug.id],
    queryFn: () => api.getSmartPlugStatus(plug.id),
    refetchInterval: 10000,
  });

  // Only show if printer is offline
  if (!isOffline) {
    return null;
  }

  return (
    <div className="flex items-center justify-between px-3 py-2 hover:bg-gray-100 dark:hover:bg-bambu-dark-tertiary">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm text-gray-900 dark:text-white truncate">{printer.name}</span>
        {plugStatus && (
          <span
            className={`text-xs px-1.5 py-0.5 rounded ${
              plugStatus.state === 'ON'
                ? 'bg-bambu-green/20 text-bambu-green'
                : 'bg-red-500/20 text-red-400'
            }`}
          >
            {plugStatus.state || '?'}
          </span>
        )}
      </div>
      <button
        onClick={() => onPowerOn(plug.id)}
        disabled={isPowering || plugStatus?.state === 'ON'}
        className={`px-2 py-1 text-xs rounded transition-colors flex items-center gap-1 ${
          plugStatus?.state === 'ON'
            ? 'bg-bambu-green/20 text-bambu-green cursor-default'
            : 'bg-bambu-green/20 text-bambu-green hover:bg-bambu-green hover:text-white'
        }`}
      >
        <Power className="w-3 h-3" />
        {isPowering ? '...' : 'On'}
      </button>
    </div>
  );
}

export function PrintersPage() {
  const { t } = useTranslation();
  const { resolvedMode, darkAccent, lightAccent } = useTheme();
  const activeAccent = resolvedMode === 'dark' ? darkAccent : lightAccent;
  const accentButtonClass = {
    green: 'bg-green-500 text-white hover:bg-green-400 border-green-400/60',
    teal: 'bg-teal-500 text-white hover:bg-teal-400 border-teal-400/60',
    blue: 'bg-blue-500 text-white hover:bg-blue-400 border-blue-400/60',
    orange: 'bg-orange-500 text-white hover:bg-orange-400 border-orange-400/60',
    purple: 'bg-purple-500 text-white hover:bg-purple-400 border-purple-400/60',
    red: 'bg-red-500 text-white hover:bg-red-400 border-red-400/60',
  }[activeAccent];
  const [showAddModal, setShowAddModal] = useState(false);
  const [hideDisconnected, setHideDisconnected] = useState(() => {
    return localStorage.getItem('hideDisconnectedPrinters') === 'true';
  });
  const [showPowerDropdown, setShowPowerDropdown] = useState(false);
  const [poweringOn, setPoweringOn] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<SortOption>(() => {
    return (localStorage.getItem('printerSortBy') as SortOption) || 'name';
  });
  const [sortAsc, setSortAsc] = useState<boolean>(() => {
    return localStorage.getItem('printerSortAsc') !== 'false';
  });
  const [printerPageViewMode, setPrinterPageViewModeState] = useState<PrinterPageViewMode>(() => {
    return normalizePrinterPageViewMode(
      localStorage.getItem('printerViewMode'),
      localStorage.getItem('printerCardSize'),
      localStorage.getItem('printerPageView'),
    );
  });
  const [isMobilePrinterView, setIsMobilePrinterView] = useState(() => (
    typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 767px)').matches
  ));
  const [selectedSinglePrinterId, setSelectedSinglePrinterId] = useState<number | null>(() => {
    const saved = localStorage.getItem('singlePrinterViewId');
    const parsed = saved ? Number(saved) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  });
  const [singlePrinterReturnView, setSinglePrinterReturnView] = useState<PrinterPageViewMode | null>(null);
  // Cam-wall settings — per-user, no backend write (a Pi 4 install caps the
  // live count lower than a NUC; default 4 is the documented Pi 4 ceiling).
  const [camWallMaxLive, setCamWallMaxLive] = useState<number>(() => {
    const saved = parseInt(localStorage.getItem('camWallMaxLive') || '', 10);
    return Number.isFinite(saved) && saved > 0 ? saved : 4;
  });
  const [camWallSnapshotSec, setCamWallSnapshotSec] = useState<number>(() => {
    const saved = parseInt(localStorage.getItem('camWallSnapshotSec') || '', 10);
    return Number.isFinite(saved) && saved > 0 ? saved : 8;
  });
  const setPrinterPageViewMode = useCallback((mode: PrinterPageViewMode) => {
    setPrinterPageViewModeState(mode);
    localStorage.setItem('printerViewMode', mode);
    localStorage.removeItem('printerCardSize');
    localStorage.removeItem('printerPageView');
  }, []);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mediaQuery = window.matchMedia('(max-width: 767px)');
    const handleChange = (event: MediaQueryListEvent) => setIsMobilePrinterView(event.matches);
    setIsMobilePrinterView(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);
  useEffect(() => {
    if (!isMobilePrinterView || printerPageViewMode !== 'single') return;
    setSinglePrinterReturnView(null);
    setPrinterPageViewMode('detail');
  }, [isMobilePrinterView, printerPageViewMode, setPrinterPageViewMode]);
  const openSinglePrinter = useCallback((printerId: number) => {
    setSelectedSinglePrinterId(printerId);
    localStorage.setItem('singlePrinterViewId', String(printerId));
    if (isMobilePrinterView) {
      setSinglePrinterReturnView(null);
      setPrinterPageViewMode('detail');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    setSinglePrinterReturnView(printerPageViewMode === 'single' ? null : printerPageViewMode);
    setPrinterPageViewMode('single');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [isMobilePrinterView, printerPageViewMode, setPrinterPageViewMode]);
  const returnFromSinglePrinter = useCallback(() => {
    if (!singlePrinterReturnView) return;
    setSinglePrinterReturnView(null);
    setPrinterPageViewMode('list');
  }, [setPrinterPageViewMode, singlePrinterReturnView]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [locationFilter, setLocationFilter] = useState<string>('all');
  const [statusCacheVersion, setStatusCacheVersion] = useState(0);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem('printerCollapsedSections');
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  });
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  // Embedded camera viewer state - supports multiple simultaneous viewers
  // Persisted to localStorage so cameras reopen after navigation
  const [embeddedCameraPrinters, setEmbeddedCameraPrinters] = useState<Map<number, { id: number; name: string }>>(() => {
    // Initialize from localStorage if camera_view_mode is embedded
    const saved = localStorage.getItem('openEmbeddedCameras');
    if (saved) {
      try {
        const cameras = JSON.parse(saved) as Array<{ id: number; name: string }>;
        return new Map(cameras.map(c => [c.id, c]));
      } catch {
        return new Map();
      }
    }
    return new Map();
  });

  // Persist open cameras to localStorage when they change
  useEffect(() => {
    const cameras = Array.from(embeddedCameraPrinters.values());
    if (cameras.length > 0) {
      localStorage.setItem('openEmbeddedCameras', JSON.stringify(cameras));
    } else {
      localStorage.removeItem('openEmbeddedCameras');
    }
  }, [embeddedCameraPrinters]);

  const { data: printers, isLoading } = useQuery({
    queryKey: ['printers'],
    queryFn: api.getPrinters,
  });

  // Fetch the UI-rendering subset of settings. Uses /ui-preferences (not /settings)
  // so users with printers:read but no settings:read still get the values needed
  // to render the clear-plate button, drying presets, AMS thresholds, etc. (#1293).
  const { data: settings } = useQuery({
    queryKey: ['ui-preferences'],
    queryFn: api.getUiPreferences,
  });
  const { data: appSettings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
    enabled: hasPermission('settings:read'),
    staleTime: 5 * 60 * 1000,
  });

  // Parse user-configured temperature/fan presets once, with defensive fallback
  // to built-in defaults on parse failure (validators on the backend already
  // reject malformed writes, so this is just forward-compat).
  const effectiveNozzleTempPresets = useMemo(
    () => parsePresetTriple(settings?.nozzle_temp_presets, NOZZLE_TEMP_DEFAULTS, 0, 320),
    [settings?.nozzle_temp_presets],
  );
  const effectiveBedTempPresets = useMemo(
    () => parsePresetTriple(settings?.bed_temp_presets, BED_TEMP_DEFAULTS, 0, 140),
    [settings?.bed_temp_presets],
  );
  const effectiveChamberTempPresets = useMemo(
    () => parsePresetTriple(settings?.chamber_temp_presets, CHAMBER_TEMP_DEFAULTS, 0, 60),
    [settings?.chamber_temp_presets],
  );
  const effectiveFanSpeedPresets = useMemo(
    () => parsePresetTriple(settings?.fan_speed_presets, FAN_SPEED_DEFAULTS, 0, 100),
    [settings?.fan_speed_presets],
  );

  // Compute drying presets: user-configured (from settings) merged over built-in defaults
  const effectiveDryingPresets = useMemo(() => {
    if (settings?.drying_presets) {
      try {
        const userPresets = JSON.parse(settings.drying_presets);
        if (typeof userPresets === 'object' && userPresets !== null && Object.keys(userPresets).length > 0) {
          return { ...DRYING_PRESETS, ...userPresets };
        }
      } catch { /* ignore parse errors, use defaults */ }
    }
    return DRYING_PRESETS;
  }, [settings?.drying_presets]);

  // Close embedded cameras if mode changes to 'window'
  useEffect(() => {
    if (settings?.camera_view_mode === 'window' && embeddedCameraPrinters.size > 0) {
      setEmbeddedCameraPrinters(new Map());
    }
  }, [settings?.camera_view_mode, embeddedCameraPrinters.size]);

  // Fetch all smart plugs to know which printers have them
  const { data: smartPlugs } = useQuery({
    queryKey: ['smart-plugs'],
    queryFn: api.getSmartPlugs,
  });

  // Fetch maintenance overview for all printers to show badges
  const { data: maintenanceOverview } = useQuery({
    queryKey: ['maintenanceOverview'],
    queryFn: api.getMaintenanceOverview,
    staleTime: 60 * 1000, // 1 minute
  });

  // Fetch Spoolman status to enable link spool feature
  const { data: spoolmanStatus } = useQuery({
    queryKey: ['spoolman-status'],
    queryFn: api.getSpoolmanStatus,
    staleTime: 60 * 1000, // 1 minute
  });
  const spoolmanEnabled = spoolmanStatus?.enabled && spoolmanStatus?.connected;

  // Fetch Spoolman settings to get sync mode
  const { data: spoolmanSettings } = useQuery({
    queryKey: ['spoolman-settings'],
    queryFn: api.getSpoolmanSettings,
    enabled: !!spoolmanEnabled,
    staleTime: 60 * 1000, // 1 minute
  });
  const spoolmanSyncMode = spoolmanSettings?.spoolman_sync_mode;

  // Fetch unlinked spools to know if link button should be enabled
  const { data: unlinkedSpools } = useQuery({
    queryKey: ['unlinked-spools'],
    queryFn: api.getUnlinkedSpools,
    enabled: !!spoolmanEnabled,
    staleTime: 30 * 1000, // 30 seconds
  });
  const hasUnlinkedSpools = unlinkedSpools && unlinkedSpools.length > 0;

  // Fetch linked spools map (tag -> spool_id) to know which spools are already in Spoolman
  const { data: linkedSpoolsData } = useQuery({
    queryKey: ['linked-spools'],
    queryFn: api.getLinkedSpools,
    enabled: !!spoolmanEnabled,
    staleTime: 30 * 1000, // 30 seconds
  });
  const linkedSpools = linkedSpoolsData?.linked;

  // Fetch spool assignments for inventory feature
  const { data: spoolAssignments } = useQuery({
    queryKey: ['spool-assignments'],
    queryFn: () => api.getAssignments(),
    enabled: hasPermission('inventory:view_assignments'),
    staleTime: 30 * 1000,
  });

  const unassignMutation = useMutation({
    mutationFn: ({ printerId, amsId, trayId }: { printerId: number; amsId: number; trayId: number }) =>
      api.unassignSpool(printerId, amsId, trayId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['spool-assignments'] });
    },
  });

  const { data: spoolmanSpools, isLoading: spoolmanSpoolsLoading } = useQuery({
    queryKey: ['spoolman-inventory-spools'],
    queryFn: () => api.getSpoolmanInventorySpools(false),
    enabled: !!spoolmanEnabled,
    staleTime: 30 * 1000,
  });

  const { data: spoolmanSlotAssignments, isLoading: spoolmanAssignmentsLoading } = useQuery({
    queryKey: ['spoolman-slot-assignments'],
    queryFn: () => api.getSpoolmanSlotAssignments(),
    enabled: !!spoolmanEnabled,
    staleTime: 30 * 1000,
  });

  const unassignSpoolmanMutation = useMutation({
    mutationFn: (spoolmanSpoolId: number) => api.unassignSpoolmanSlot(spoolmanSpoolId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['spoolman-inventory-spools'] });
      queryClient.invalidateQueries({ queryKey: ['spoolman-slot-assignments'] });
    },
  });

  // Helper to find assignment for a specific slot
  const getAssignment = (printerId: number, amsId: number | string, trayId: number | string): SpoolAssignment | undefined => {
    return spoolAssignments?.find(
      (a) => a.printer_id === printerId && a.ams_id === Number(amsId) && a.tray_id === Number(trayId)
    );
  };

  // Create a map of printer_id -> maintenance info for quick lookup
  const maintenanceByPrinter = maintenanceOverview?.reduce(
    (acc, overview) => {
      acc[overview.printer_id] = {
        due_count: overview.due_count,
        warning_count: overview.warning_count,
        total_print_hours: overview.total_print_hours,
      };
      return acc;
    },
    {} as Record<number, PrinterMaintenanceInfo>
  ) || {};

  // Create a map of printer_id -> smart plug
  const smartPlugByPrinter = smartPlugs?.reduce(
    (acc, plug) => {
      if (plug.printer_id) {
        acc[plug.printer_id] = plug;
      }
      return acc;
    },
    {} as Record<number, typeof smartPlugs[0]>
  ) || {};

  const addMutation = useMutation({
    mutationFn: api.createPrinter,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['printers'] });
      queryClient.invalidateQueries({ queryKey: ['maintenanceOverview'] });
      setShowAddModal(false);
    },
    onError: (error: Error) => {
      // Localized message when the backend returns a stable error code;
      // the raw message is an English fallback for non-UI clients.
      if (error instanceof ApiError && error.code === 'printer_connection_failed') {
        showToast(t('printers.toast.connectionFailedNotAdded'), 'error');
        return;
      }
      showToast(error.message || t('printers.toast.failedToAdd'), 'error');
    },
  });

  const powerOnMutation = useMutation({
    mutationFn: (plugId: number) => api.controlSmartPlug(plugId, 'on'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['smart-plugs'] });
      setPoweringOn(null);
    },
    onError: () => {
      setPoweringOn(null);
    },
  });

  // Bulk selection state
  const [selectedPrinterIds, setSelectedPrinterIds] = useState<Set<number>>(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [bulkConfirmAction, setBulkConfirmAction] = useState<'stop' | 'pause' | 'clearPlate' | null>(null);
  const [bulkActionPending, setBulkActionPending] = useState(false);
  const selectionMode = isSelectionMode || selectedPrinterIds.size > 0;

  const toggleSelect = useCallback((id: number) => {
    setSelectedPrinterIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedPrinterIds(new Set());
    setIsSelectionMode(false);
  }, []);

  // Escape key exits selection mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectionMode) {
        clearSelection();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectionMode, clearSelection]);

  const executeBulkAction = useCallback(async (action: 'stop' | 'pause' | 'resume' | 'clearPlate' | 'clearHMS') => {
    setBulkActionPending(true);
    const ids = Array.from(selectedPrinterIds);

    // Filter to only applicable printers based on cached state
    const applicableIds = ids.filter(id => {
      const status = queryClient.getQueryData<{ connected: boolean; state: string | null; hms_errors?: HMSError[] }>(['printerStatus', id]);
      if (!status?.connected) return false;
      switch (action) {
        case 'stop': return status.state === 'RUNNING' || status.state === 'PAUSE';
        case 'pause': return status.state === 'RUNNING';
        case 'resume': return status.state === 'PAUSE';
        case 'clearPlate': return !!(status as { awaiting_plate_clear?: boolean }).awaiting_plate_clear;
        case 'clearHMS': return status.hms_errors && filterKnownHMSErrors(status.hms_errors).length > 0;
        default: return false;
      }
    });

    if (applicableIds.length === 0) {
      showToast(t('printers.bulk.noneApplicable'), 'error');
      setBulkActionPending(false);
      setBulkConfirmAction(null);
      return;
    }

    const apiCall = {
      stop: api.stopPrint,
      pause: api.pausePrint,
      resume: api.resumePrint,
      clearPlate: api.clearPlate,
      clearHMS: api.clearHMSErrors,
    }[action];

    const results = await Promise.allSettled(
      applicableIds.map(id => apiCall(id))
    );

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    if (failed === 0) {
      showToast(t('printers.bulk.success', { action: t(`printers.bulk.actions.${action}`), count: succeeded }));
    } else {
      showToast(t('printers.bulk.partial', { succeeded, failed }), 'error');
    }

    // Invalidate status queries for affected printers
    applicableIds.forEach(id => {
      queryClient.invalidateQueries({ queryKey: ['printerStatus', id] });
    });

    setBulkActionPending(false);
    setBulkConfirmAction(null);
  }, [selectedPrinterIds, queryClient, showToast, t]);

  const handleBulkAction = useCallback((action: 'stop' | 'pause' | 'resume' | 'clearPlate' | 'clearHMS') => {
    // Actions that need confirmation
    if (action === 'stop' || action === 'pause' || action === 'clearPlate') {
      setBulkConfirmAction(action);
    } else {
      executeBulkAction(action);
    }
  }, [executeBulkAction]);

  const toggleHideDisconnected = () => {
    const newValue = !hideDisconnected;
    setHideDisconnected(newValue);
    localStorage.setItem('hideDisconnectedPrinters', String(newValue));
  };

  const handleSortChange = (newSort: SortOption) => {
    setSortBy(newSort);
    localStorage.setItem('printerSortBy', newSort);
  };

  const toggleSortDirection = () => {
    const newAsc = !sortAsc;
    setSortAsc(newAsc);
    localStorage.setItem('printerSortAsc', String(newAsc));
  };

  const getGridClasses = () => {
    return 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3';
  };

  // Increment version counter whenever a printer status cache entry is updated so
  // filteredPrinters re-computes reactively on WebSocket-driven status changes.
  useEffect(() => {
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === 'updated' &&
        Array.isArray(event.query.queryKey) &&
        event.query.queryKey[0] === 'printerStatus'
      ) {
        setStatusCacheVersion(v => v + 1);
      }
    });
    return unsubscribe;
  }, [queryClient]);

  // Filter printers by search term, status, and location
  const filteredPrinters = useMemo(() => {
    if (!printers) return [];
    let result = printers;

    // Text search
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(p =>
        p.name.toLowerCase().includes(q) ||
        (p.model || '').toLowerCase().includes(q) ||
        (p.location || '').toLowerCase().includes(q) ||
        (p.serial_number || '').toLowerCase().includes(q)
      );
    }

    // Location filter
    if (locationFilter !== 'all') {
      result = result.filter(p => (p.location || '') === locationFilter);
    }

    // Status filter
    if (statusFilter !== 'all') {
      result = result.filter(p => {
        const status = queryClient.getQueryData<{ connected: boolean; state: string | null; hms_errors?: HMSError[] }>(['printerStatus', p.id]);
        if (!status?.connected) return statusFilter === 'offline';
        const hmsErrors = status.hms_errors ? filterKnownHMSErrors(status.hms_errors) : [];
        switch (statusFilter) {
          case 'printing': return status.state === 'RUNNING';
          case 'paused':   return status.state === 'PAUSE';
          case 'finished': return status.state === 'FINISH';
          case 'error':    return status.state === 'FAILED' || hmsErrors.length > 0;
          case 'idle':     return status.state !== 'RUNNING' && status.state !== 'PAUSE' && status.state !== 'FINISH' && status.state !== 'FAILED' && hmsErrors.length === 0;
          case 'offline':  return false; // Connected printers are never offline
          default:         return true;
        }
      });
    }

    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- statusCacheVersion is intentional: it forces recompute when WebSocket updates printer status cache
  }, [printers, search, statusFilter, locationFilter, queryClient, statusCacheVersion]);

  // Derive unique locations for the location filter dropdown
  const availableLocations = useMemo(() => {
    if (!printers) return [];
    return [...new Set(printers.map(p => p.location || '').filter(Boolean))].sort();
  }, [printers]);

  // Sort printers based on selected option
  const sortedPrinters = useMemo(() => {
    const sorted = [...filteredPrinters];

    switch (sortBy) {
      case 'name':
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'model':
        sorted.sort((a, b) => (a.model || '').localeCompare(b.model || ''));
        break;
      case 'location':
        // Sort by location, with ungrouped printers last
        sorted.sort((a, b) => {
          const locA = a.location || '';
          const locB = b.location || '';
          if (!locA && locB) return 1;
          if (locA && !locB) return -1;
          return locA.localeCompare(locB) || a.name.localeCompare(b.name);
        });
        break;
      case 'status':
        // Sort by status: HMS errors > printing > idle > offline
        sorted.sort((a, b) => {
          const statusA = queryClient.getQueryData<{ connected: boolean; state: string | null; hms_errors?: HMSError[] }>(['printerStatus', a.id]);
          const statusB = queryClient.getQueryData<{ connected: boolean; state: string | null; hms_errors?: HMSError[] }>(['printerStatus', b.id]);

          const getPriority = (s: typeof statusA) => {
            if (!s?.connected) return 3; // offline
            const hmsErrors = s.hms_errors ? filterKnownHMSErrors(s.hms_errors) : [];
            if (hmsErrors.length > 0) return 0; // HMS errors - top priority
            if (s.state === 'RUNNING') return 1; // printing
            return 2; // idle
          };

          return getPriority(statusA) - getPriority(statusB);
        });
        break;
      case 'eta':
        sorted.sort((a, b) => {
          const statusA = queryClient.getQueryData<{ connected: boolean; state: string | null; remaining_time: number | null }>(['printerStatus', a.id]);
          const statusB = queryClient.getQueryData<{ connected: boolean; state: string | null; remaining_time: number | null }>(['printerStatus', b.id]);

          const tier = (s: typeof statusA) => {
            if (!s?.connected) return 3; // offline last
            if (s.state === 'RUNNING' && s.remaining_time != null && s.remaining_time > 0) return 0; // printing with ETA
            if (s.state === 'RUNNING') return 1; // printing without ETA
            return 2; // idle
          };

          const ta = tier(statusA);
          const tb = tier(statusB);
          if (ta !== tb) return ta - tb;
          if (ta === 0) {
            const diff = (statusA!.remaining_time ?? 0) - (statusB!.remaining_time ?? 0);
            if (diff !== 0) return diff;
          }
          return a.name.localeCompare(b.name);
        });
        break;
    }

    // Apply ascending/descending
    if (!sortAsc) {
      sorted.reverse();
    }

    return sorted;
  }, [filteredPrinters, sortBy, sortAsc, queryClient]);

  const selectedSinglePrinter = useMemo(() => {
    if (sortedPrinters.length === 0) return null;
    return sortedPrinters.find(printer => printer.id === selectedSinglePrinterId) ?? sortedPrinters[0];
  }, [selectedSinglePrinterId, sortedPrinters]);

  useEffect(() => {
    if (!selectedSinglePrinter) return;
    if (selectedSinglePrinter.id === selectedSinglePrinterId) return;
    setSelectedSinglePrinterId(selectedSinglePrinter.id);
    localStorage.setItem('singlePrinterViewId', String(selectedSinglePrinter.id));
  }, [selectedSinglePrinter, selectedSinglePrinterId]);

  const selectAll = useCallback(() => {
    setSelectedPrinterIds(new Set(sortedPrinters.map(p => p.id)));
    setIsSelectionMode(true);
  }, [sortedPrinters]);

  const selectByState = useCallback((state: PrinterState) => {
    setSelectedPrinterIds(prev => {
      const next = new Set(prev);
      sortedPrinters.forEach(p => {
        const status = queryClient.getQueryData<{ connected: boolean; state: string | null; hms_errors?: HMSError[] }>(['printerStatus', p.id]);
        if (classifyPrinterStatus(status) === state) next.add(p.id);
      });
      return next;
    });
    setIsSelectionMode(true);
  }, [sortedPrinters, queryClient]);

  const selectByLocation = useCallback((location: string) => {
    setSelectedPrinterIds(prev => {
      const next = new Set(prev);
      sortedPrinters.filter(p => (p.location || '') === location).forEach(p => next.add(p.id));
      return next;
    });
    setIsSelectionMode(true);
  }, [sortedPrinters]);

  const selectByModel = useCallback((model: string) => {
    setSelectedPrinterIds(prev => {
      const next = new Set(prev);
      sortedPrinters.filter(p => (p.model || 'Unknown') === model).forEach(p => next.add(p.id));
      return next;
    });
    setIsSelectionMode(true);
  }, [sortedPrinters]);

  const toggleSectionCollapse = useCallback((key: string) => {
    setCollapsedSections(prev => {
      const next = { ...prev, [key]: !prev[key] };
      try { localStorage.setItem('printerCollapsedSections', JSON.stringify(next)); } catch { /* quota exceeded / private mode */ }
      return next;
    });
  }, []);

  // Group printers when sorted by location, status, or model
  const groupedPrinters = useMemo(() => {
    if (sortBy === 'name' || sortBy === 'eta') return null;

    const groups: Record<string, typeof sortedPrinters> = {};

    if (sortBy === 'location') {
      sortedPrinters.forEach(printer => {
        const location = printer.location || 'Ungrouped';
        if (!groups[location]) groups[location] = [];
        groups[location].push(printer);
      });
    } else if (sortBy === 'model') {
      sortedPrinters.forEach(printer => {
        const model = printer.model || 'Unknown';
        if (!groups[model]) groups[model] = [];
        groups[model].push(printer);
      });
    } else if (sortBy === 'status') {
      sortedPrinters.forEach(printer => {
        const status = queryClient.getQueryData<{ connected: boolean; state: string | null; hms_errors?: HMSError[] }>(['printerStatus', printer.id]);
        const group = classifyPrinterStatus(status);
        if (!groups[group]) groups[group] = [];
        groups[group].push(printer);
      });
    }

    return groups;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- classifyPrinterStatus & filterKnownHMSErrors are stable module-level functions, not reactive deps; statusCacheVersion forces recompute on WebSocket status updates
  }, [sortBy, sortedPrinters, queryClient, statusCacheVersion]);

  const toolbarRef = useRef<HTMLDivElement>(null);
  const expandedToolbarControlsRef = useRef<HTMLDivElement>(null);
  const expandedToolbarWidthRef = useRef(0);
  const [compactToolbar, setCompactToolbar] = useState(false);

  const measureToolbar = useCallback(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;

    const measuredControlsWidth = expandedToolbarControlsRef.current?.offsetWidth;
    if (measuredControlsWidth) {
      expandedToolbarWidthRef.current = measuredControlsWidth;
    }

    const searchMinimumWidth = 220;
    const gapWidth = 8;
    const shouldCompact = expandedToolbarWidthRef.current > 0 && toolbar.clientWidth < expandedToolbarWidthRef.current + searchMinimumWidth + gapWidth;
    setCompactToolbar(prev => (prev === shouldCompact ? prev : shouldCompact));
  }, []);

  const smartPlugCount = Object.keys(smartPlugByPrinter).length;
  useLayoutEffect(() => {
    measureToolbar();

    const toolbar = toolbarRef.current;
    if (!toolbar) return;

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measureToolbar);
      return () => window.removeEventListener('resize', measureToolbar);
    }

    const resizeObserver = new ResizeObserver(() => measureToolbar());
    resizeObserver.observe(toolbar);
    window.addEventListener('resize', measureToolbar);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', measureToolbar);
    };
  }, [
    measureToolbar,
    printers?.length,
    availableLocations.length,
    hideDisconnected,
    smartPlugCount,
  ]);

  const renderFilterControls = (inMenu = false) => (
    <>
      {/* Status filter */}
      {printers && printers.length > 0 && (
        <ToolbarDropdown
          value={statusFilter}
          onChange={setStatusFilter}
          fullWidth={inMenu}
          options={[
            { value: 'all', label: t('printers.filter.allStatuses') },
            { value: 'printing', label: t('printers.status.printing') },
            { value: 'paused', label: t('printers.status.paused') },
            { value: 'idle', label: t('printers.status.idle') },
            { value: 'finished', label: t('printers.status.finished') },
            { value: 'error', label: t('printers.status.error') },
            { value: 'offline', label: t('printers.status.offline') },
          ]}
        />
      )}

      {/* Location filter — only shown when at least one printer has a location */}
      {printers && printers.length > 0 && availableLocations.length > 0 && (
        <ToolbarDropdown
          value={locationFilter}
          onChange={setLocationFilter}
          fullWidth={inMenu}
          options={[
            { value: 'all', label: t('printers.filter.allLocations') },
            ...availableLocations.map(loc => ({ value: loc, label: loc })),
          ]}
        />
      )}

      <button
        type="button"
        onClick={toggleHideDisconnected}
        aria-pressed={hideDisconnected}
        className={`h-8 px-2 rounded-lg border text-sm font-medium transition-colors ${inMenu ? 'w-full' : ''} ${
          hideDisconnected
            ? 'bg-bambu-green border-bambu-green text-white'
            : 'bg-bambu-dark border-bambu-dark-tertiary text-white hover:bg-bambu-dark-tertiary'
        }`}
      >
        {t('printers.hideOffline')}
      </button>
    </>
  );

  const renderViewControls = (inMenu = false) => (
    <>
      {/* Sort dropdown */}
      <div className={`flex items-center gap-1 ${inMenu ? 'w-full' : ''}`}>
        <ToolbarDropdown<SortOption>
          value={sortBy}
          onChange={handleSortChange}
          fullWidth={inMenu}
          options={[
            { value: 'name', label: t('printers.sort.name') },
            { value: 'status', label: t('printers.sort.status') },
            { value: 'model', label: t('printers.sort.model') },
            { value: 'location', label: t('printers.sort.location') },
            { value: 'eta', label: t('printers.sort.eta') },
          ]}
        />
        <button
          onClick={toggleSortDirection}
          className="h-8 shrink-0 px-2 rounded-lg border bg-bambu-dark border-bambu-dark-tertiary text-white hover:bg-bambu-dark-tertiary transition-colors flex items-center justify-center"
          title={sortAsc ? t('printers.sort.descending') : t('printers.sort.ascending')}
        >
          {sortAsc ? (
            <ArrowUp className="w-4 h-4 text-white" />
          ) : (
            <ArrowDown className="w-4 h-4 text-white" />
          )}
        </button>
      </div>

      {/* View selector */}
      <div className={`flex h-8 items-center bg-bambu-dark rounded-lg border border-bambu-dark-tertiary ${inMenu ? 'w-full' : ''}`}>
        {([
          { mode: 'list' as const, label: t('printers.view.list', 'List'), icon: <List className="h-4 w-4" /> },
          { mode: 'camwall' as const, label: t('printers.pageView.camWall', 'Camera wall'), icon: <MonitorPlay className="h-4 w-4" /> },
          { mode: 'detail' as const, label: t('printers.view.detailCards', 'Detail cards'), icon: <Layers className="h-4 w-4" /> },
          { mode: 'single' as const, label: t('printers.view.singlePrinter', 'Single printer'), icon: <PrinterIcon className="h-4 w-4" /> },
        ]).filter((option) => !isMobilePrinterView || option.mode !== 'single').map((option, index, options) => {
          const isSelected = printerPageViewMode === option.mode;
          return (
            <button
              key={option.mode}
              onClick={() => {
                if (option.mode === 'single' && !selectedSinglePrinter && sortedPrinters[0]) {
                  setSelectedSinglePrinterId(sortedPrinters[0].id);
                  localStorage.setItem('singlePrinterViewId', String(sortedPrinters[0].id));
                }
                setSinglePrinterReturnView(null);
                setPrinterPageViewMode(option.mode);
              }}
              className={`flex h-full items-center justify-center px-2 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${inMenu ? 'flex-1' : ''} ${
                index === 0 ? 'rounded-l-lg' : ''
              } ${
                index === options.length - 1 ? 'rounded-r-lg' : ''
              } ${
                isSelected
                  ? 'bg-bambu-green text-white'
                  : 'text-white hover:bg-bambu-dark-tertiary'
              }`}
              title={option.label}
              aria-label={option.label}
              aria-pressed={isSelected}
              disabled={option.mode === 'camwall' && !hasPermission('camera:view')}
            >
              {option.icon}
            </button>
          );
        })}
      </div>
    </>
  );

  const renderActionControls = (inMenu = false) => (
    <>
      {/* Bulk select toggle */}
      <button
        onClick={() => {
          if (selectionMode) clearSelection();
          else setIsSelectionMode(true);
        }}
        className={`h-8 px-2 rounded-lg border transition-colors ${inMenu ? 'w-full justify-center gap-1.5 text-sm font-medium flex items-center' : ''} ${
          selectionMode
            ? 'bg-bambu-green border-bambu-green text-white'
            : 'bg-bambu-dark border-bambu-dark-tertiary text-white hover:bg-bambu-dark-tertiary'
        }`}
        title={t('printers.bulk.select')}
        disabled={!hasPermission('printers:control')}
      >
        <CheckSquare className="w-4 h-4" />
        {inMenu && <span>{t('printers.bulk.select')}</span>}
      </button>

      {/* Power dropdown for offline printers with smart plugs */}
      {hideDisconnected && Object.keys(smartPlugByPrinter).length > 0 && (
        <div className={`relative ${inMenu ? 'w-full' : ''}`}>
          <button
            onClick={() => setShowPowerDropdown(!showPowerDropdown)}
            className={`h-8 flex items-center gap-1.5 px-2 text-sm rounded-lg border transition-colors ${
              inMenu
                ? 'w-full justify-between bg-bambu-dark border-bambu-dark-tertiary text-white hover:bg-bambu-dark-tertiary hover:text-white'
                : 'bg-bambu-dark border-bambu-dark-tertiary text-white hover:bg-bambu-dark-tertiary'
            }`}
          >
            <span className="flex items-center gap-1.5">
              <Power className="w-4 h-4" />
              {t('printers.powerOn')}
            </span>
            <ChevronDown className={`w-3 h-3 transition-transform ${showPowerDropdown ? 'rotate-180' : ''}`} />
          </button>
          {showPowerDropdown && (
            <>
              {/* Backdrop to close dropdown */}
              <div
                className="fixed inset-0 z-10"
                onClick={() => setShowPowerDropdown(false)}
              />
              <div className="absolute right-0 mt-2 w-56 bg-white dark:bg-bambu-dark-secondary border border-gray-200 dark:border-bambu-dark-tertiary rounded-lg shadow-lg z-20 py-1">
                <div className="px-3 py-2 text-xs text-gray-500 dark:text-bambu-gray border-b border-gray-200 dark:border-bambu-dark-tertiary">
                  {t('printers.offlinePrintersWithPlugs')}
                </div>
                {printers?.filter(p => smartPlugByPrinter[p.id]).map(printer => (
                  <PowerDropdownItem
                    key={printer.id}
                    printer={printer}
                    plug={smartPlugByPrinter[printer.id]}
                    onPowerOn={(plugId) => {
                      setPoweringOn(plugId);
                      powerOnMutation.mutate(plugId);
                    }}
                    isPowering={poweringOn === smartPlugByPrinter[printer.id]?.id}
                  />
                ))}
                {printers?.filter(p => smartPlugByPrinter[p.id]).length === 0 && (
                  <div className="px-3 py-2 text-sm text-bambu-gray">
                    No printers with smart plugs
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
      <Button
        onClick={() => setShowAddModal(true)}
        disabled={!hasPermission('printers:create')}
        title={!hasPermission('printers:create') ? t('printers.permission.noAdd') : undefined}
        className={`!h-8 !min-h-8 px-2 py-0 ${inMenu ? 'w-full' : ''}`}
      >
        <Plus className="w-4 h-4" />
        {t('printers.addPrinter')}
      </Button>
    </>
  );

  return (
    <div
      data-testid="printers-page"
      className={`p-4 md:p-8 ${
        printerPageViewMode === 'single' && !isMobilePrinterView
          ? 'flex h-[calc(100dvh-3.5rem)] flex-col overflow-hidden min-[1144px]:h-dvh'
          : ''
      }`}
    >
      <div className="mb-6 shrink-0 space-y-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            <PrinterIcon className="w-7 h-7 text-bambu-green" />
            {t('printers.title')}
          </h1>
          <StatusSummaryBar printers={printers} />
        </div>
        <div ref={toolbarRef} className="relative flex items-center gap-2">
          {/* Only show search bar when printers exist */}
          {printers && printers.length > 0 && (
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-bambu-gray/50" />
              <input
                type="search"
                name="printer-search"
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('printers.search')}
                aria-label={t('printers.search')}
                className="w-full h-8 pl-9 pr-8 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm placeholder:text-bambu-gray/50 focus:outline-none focus:border-bambu-green"
              />
              {search && (
                <button
                  type="button"
                  aria-label={t('common.clear')}
                  onClick={() => setSearch('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-bambu-gray hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          )}
          <div
            ref={expandedToolbarControlsRef}
            aria-hidden={compactToolbar}
            inert={compactToolbar}
            className={`${compactToolbar ? 'absolute -left-[9999px] top-0 flex w-max pointer-events-none opacity-0' : 'flex'} ml-auto items-center justify-end gap-2 flex-nowrap [&>*]:shrink-0`}
          >
            <div className="h-6 w-px bg-bambu-dark-tertiary" />
            <div className="flex items-center gap-2">{renderFilterControls()}</div>
            <div className="h-6 w-px bg-bambu-dark-tertiary" />
            <div className="flex items-center gap-2">{renderViewControls()}</div>
            <div className="h-6 w-px bg-bambu-dark-tertiary" />
            <div className="flex items-center gap-2">{renderActionControls()}</div>
          </div>

          {compactToolbar && (
            <div className="ml-auto flex items-center justify-end gap-1">
              <ToolbarMenu label={t('printers.toolbar.filters', 'Filters')} icon={<Filter className="w-4 h-4" />}>
                <div className="flex w-48 flex-col gap-2">{renderFilterControls(true)}</div>
              </ToolbarMenu>
              <ToolbarMenu label={t('printers.toolbar.view', 'View')} icon={<SlidersHorizontal className="w-4 h-4" />}>
                <div className="flex w-48 flex-col gap-2">{renderViewControls(true)}</div>
              </ToolbarMenu>
              <ToolbarMenu label={t('printers.toolbar.actions', 'Actions')} icon={<MoreHorizontal className="w-4 h-4" />}>
                <div className="flex w-48 flex-col gap-2">{renderActionControls(true)}</div>
              </ToolbarMenu>
            </div>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-bambu-gray">{t('common.loading')}</div>
      ) : printers?.length === 0 ? (
        <Card>
          <CardContent className="text-center py-12">
            <p className="text-bambu-gray mb-4">{t('printers.noPrintersConfigured')}</p>
            <Button
              onClick={() => setShowAddModal(true)}
              disabled={!hasPermission('printers:create')}
              title={!hasPermission('printers:create') ? t('printers.permission.noAdd') : undefined}
            >
              <Plus className="w-4 h-4" />
              {t('printers.addPrinter')}
            </Button>
          </CardContent>
        </Card>
      ) : sortedPrinters.length === 0 && (search.trim() || statusFilter !== 'all' || locationFilter !== 'all') ? (
        <Card>
          <CardContent className="text-center py-12">
            <p className="text-bambu-gray">{t('printers.noSearchResults')}</p>
          </CardContent>
        </Card>
      ) : printerPageViewMode === 'camwall' ? (
        <CameraWall
          printers={sortedPrinters}
          requirePlateClear={settings?.require_plate_clear === true}
          maxLive={camWallMaxLive}
          snapshotIntervalSec={camWallSnapshotSec}
          timeFormat={settings?.time_format || 'system'}
          onTileClick={(id) => openSinglePrinter(id)}
          onOpenFullscreen={(id, name) => {
            const cameraMode = settings?.camera_view_mode || 'window';
            if (cameraMode === 'embedded') {
              setEmbeddedCameraPrinters(prev => new Map(prev).set(id, { id, name }));
            } else {
              const saved = localStorage.getItem('cameraWindowState');
              const state = saved ? JSON.parse(saved) : { width: 640, height: 400 };
              const features = [
                `width=${state.width}`,
                `height=${state.height}`,
                state.left !== undefined ? `left=${state.left}` : '',
                state.top !== undefined ? `top=${state.top}` : '',
                'menubar=no,toolbar=no,location=no,status=no',
              ].filter(Boolean).join(',');
              window.open(`/camera/${id}`, `camera-${id}`, features);
            }
          }}
          onChangeMaxLive={(next) => {
            setCamWallMaxLive(next);
            localStorage.setItem('camWallMaxLive', String(next));
          }}
          onChangeSnapshotIntervalSec={(next) => {
            setCamWallSnapshotSec(next);
            localStorage.setItem('camWallSnapshotSec', String(next));
          }}
        />

      ) : printerPageViewMode === 'single' && !isMobilePrinterView && selectedSinglePrinter ? (
        <div className="cockpit-layout-container min-h-0 flex-1">
        <div data-testid="cockpit-layout" className="cockpit-layout grid h-full min-h-0 flex-1 gap-4 overflow-hidden">
          <aside className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-3">
            <div className="mb-3 text-center">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold text-white">{t('printers.single.machineList', 'Machines')}</h2>
                <p className="truncate text-[11px] text-bambu-gray">
                  {sortedPrinters.length === 1
                    ? t('printers.single.machineCountOne', '1 printer')
                    : t('printers.single.machineCount', '{{count}} printers', { count: sortedPrinters.length })}
                </p>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
              {sortedPrinters.map(printer => (
                <SinglePrinterSwitcherItem
                  key={printer.id}
                  printer={printer}
                  isSelected={printer.id === selectedSinglePrinter.id}
                  maintenanceInfo={maintenanceByPrinter[printer.id]}
                  requirePlateClear={settings?.require_plate_clear === true}
                  checkPrinterFirmware={settings?.check_printer_firmware !== false}
                  onSelect={(nextId) => {
                    setSelectedSinglePrinterId(nextId);
                    localStorage.setItem('singlePrinterViewId', String(nextId));
                  }}
                />
              ))}
            </div>
          </aside>

          <div className="min-h-0 min-w-0">
            <SinglePrinterCockpit
              printer={selectedSinglePrinter}
              maintenanceInfo={maintenanceByPrinter[selectedSinglePrinter.id]}
              requirePlateClear={settings?.require_plate_clear === true}
              checkPrinterFirmware={settings?.check_printer_firmware !== false}
              currencySymbol={getCurrencySymbol(appSettings?.currency || 'USD')}
              nozzleTempPresets={effectiveNozzleTempPresets}
              bedTempPresets={effectiveBedTempPresets}
              chamberTempPresets={effectiveChamberTempPresets}
              fanSpeedPresets={effectiveFanSpeedPresets}
              dryingPresets={effectiveDryingPresets}
              amsThresholds={settings ? {
                humidityGood: Number(settings.ams_humidity_good) || 40,
                humidityFair: Number(settings.ams_humidity_fair) || 60,
                tempGood: Number(settings.ams_temp_good) || 28,
                tempFair: Number(settings.ams_temp_fair) || 35,
              } : undefined}
              spoolmanEnabled={spoolmanEnabled}
              linkedSpools={linkedSpools}
              spoolmanUrl={spoolmanStatus?.url}
              spoolmanSyncMode={spoolmanSyncMode}
              onGetAssignment={getAssignment}
              onUnassignSpool={(pid, aid, tid) => unassignMutation.mutate({ printerId: pid, amsId: aid, trayId: tid })}
              spoolmanSpools={spoolmanSpools}
              spoolmanSlotAssignments={spoolmanSlotAssignments}
              spoolmanLoading={spoolmanSpoolsLoading || spoolmanAssignmentsLoading}
              onUnassignSpoolmanSpool={(id) => unassignSpoolmanMutation.mutate(id)}
            />
          </div>
        </div>
        </div>
      ) : printerPageViewMode === 'list' ? (
        <div className="overflow-hidden rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary">
          <div className="md:overflow-x-auto">
            <div className="hidden min-w-[820px] grid-cols-[minmax(15rem,1.5fr)_minmax(8rem,0.8fr)_minmax(9rem,0.9fr)_minmax(13rem,1.25fr)_minmax(10rem,0.85fr)] gap-3 border-b border-bambu-dark-tertiary bg-bambu-dark px-3 py-2 text-xs font-medium uppercase tracking-wide text-bambu-gray md:grid">
              <div>{t('common.printer')}</div>
              <div>{t('printers.sort.status')}</div>
              <div>{t('printers.sort.location')}</div>
              <div>{t('printers.currentPrint', 'Current print')}</div>
              <div className="text-right">{t('printers.eta', 'ETA')}</div>
            </div>
            {sortedPrinters.map((printer) => (
              <PrinterListRow
                key={printer.id}
                printer={printer}
                hideIfDisconnected={hideDisconnected}
                maintenanceInfo={maintenanceByPrinter[printer.id]}
                requirePlateClear={settings?.require_plate_clear === true}
                selectionMode={selectionMode}
                isSelected={selectedPrinterIds.has(printer.id)}
                onToggleSelect={toggleSelect}
                onOpenSinglePrinter={openSinglePrinter}
                timeFormat={settings?.time_format || 'system'}
                checkPrinterFirmware={settings?.check_printer_firmware !== false}
              />
            ))}
          </div>
        </div>
      ) : groupedPrinters ? (
        /* Grouped view (location, status, or model) */
        <div className="space-y-6">
          {(() => {
            const keys = sortBy === 'status'
              ? STATUS_GROUP_ORDER.filter(k => groupedPrinters[k]?.length > 0)
              : Object.keys(groupedPrinters);
            // For status grouping, asc/desc flips the fixed priority order
            // (asc = error→offline, desc = offline→error). This matches the
            // sort-toggle behaviour for other groupings.
            return (sortAsc ? keys : [...keys].reverse());
          })().map((groupKey) => {
            const groupPrinters = groupedPrinters[groupKey];
            const collapseKey = `${sortBy}:${groupKey}`;
            const isOpen = !collapsedSections[collapseKey];

            const dot = sortBy === 'status'
              ? STATUS_GROUP_META[groupKey]?.dot || 'bg-bambu-green'
              : 'bg-bambu-green';
            const label = sortBy === 'status'
              ? t(STATUS_GROUP_META[groupKey]?.labelKey || groupKey)
              : groupKey;

            return (
              <Collapsible
                key={groupKey}
                open={isOpen}
                onToggle={() => toggleSectionCollapse(collapseKey)}
                summaryClassName="py-1"
                summary={
                  <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${dot}`} />
                    {label}
                    <span className="text-sm font-normal text-bambu-gray">({groupPrinters.length})</span>
                    {selectionMode && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (sortBy === 'location') selectByLocation(groupKey === 'Ungrouped' ? '' : groupKey);
                          else if (sortBy === 'status') selectByState(groupKey as PrinterState);
                          else if (sortBy === 'model') selectByModel(groupKey);
                        }}
                        className="text-xs text-bambu-green hover:text-bambu-green-light transition-colors ml-1"
                      >
                        {t('printers.bulk.selectAll')}
                      </button>
                    )}
                  </h2>
                }
              >
                <div className={`grid gap-4 ${getGridClasses()}`}>
                  {groupPrinters.map((printer) => (
                    <PrinterCard
                      key={printer.id}
                      printer={printer}
                      hideIfDisconnected={hideDisconnected}
                      maintenanceInfo={maintenanceByPrinter[printer.id]}
                      amsThresholds={settings ? {
                        humidityGood: Number(settings.ams_humidity_good) || 40,
                        humidityFair: Number(settings.ams_humidity_fair) || 60,
                        tempGood: Number(settings.ams_temp_good) || 28,
                        tempFair: Number(settings.ams_temp_fair) || 35,
                      } : undefined}
                      spoolmanEnabled={spoolmanEnabled}
                      hasUnlinkedSpools={hasUnlinkedSpools}
                      linkedSpools={linkedSpools}
                      spoolmanUrl={spoolmanStatus?.url}
                      spoolmanSyncMode={spoolmanSyncMode}
                      onGetAssignment={getAssignment}
                      onUnassignSpool={(pid, aid, tid) => unassignMutation.mutate({ printerId: pid, amsId: aid, trayId: tid })}
                      spoolmanSpools={spoolmanSpools}
                      spoolmanSlotAssignments={spoolmanSlotAssignments}
                      spoolmanLoading={spoolmanSpoolsLoading || spoolmanAssignmentsLoading}
                      onUnassignSpoolmanSpool={(id) => unassignSpoolmanMutation.mutate(id)}
                      timeFormat={settings?.time_format || 'system'}
                      cameraViewMode={settings?.camera_view_mode || 'window'}
                      onOpenEmbeddedCamera={(id, name) => setEmbeddedCameraPrinters(prev => new Map(prev).set(id, { id, name }))}
                      checkPrinterFirmware={settings?.check_printer_firmware !== false}
                      dryingPresets={effectiveDryingPresets}
                      nozzleTempPresets={effectiveNozzleTempPresets}
                      bedTempPresets={effectiveBedTempPresets}
                      chamberTempPresets={effectiveChamberTempPresets}
                      fanSpeedPresets={effectiveFanSpeedPresets}
                      requirePlateClear={settings?.require_plate_clear === true}
                      selectionMode={selectionMode}
                      isSelected={selectedPrinterIds.has(printer.id)}
                      onToggleSelect={toggleSelect}
                      onOpenSinglePrinter={openSinglePrinter}
                    />
                  ))}
                </div>
              </Collapsible>
            );
          })}
        </div>
      ) : (
        /* Regular grid view */
        <div className={`grid gap-4 ${getGridClasses()}`}>
          {sortedPrinters.map((printer) => (
            <PrinterCard
              key={printer.id}
              printer={printer}
              hideIfDisconnected={hideDisconnected}
              maintenanceInfo={maintenanceByPrinter[printer.id]}
              spoolmanEnabled={spoolmanEnabled}
              hasUnlinkedSpools={hasUnlinkedSpools}
              linkedSpools={linkedSpools}
              spoolmanUrl={spoolmanStatus?.url}
              spoolmanSyncMode={spoolmanSyncMode}
              onGetAssignment={getAssignment}
              onUnassignSpool={(pid, aid, tid) => unassignMutation.mutate({ printerId: pid, amsId: aid, trayId: tid })}
              spoolmanSpools={spoolmanSpools}
              spoolmanSlotAssignments={spoolmanSlotAssignments}
              spoolmanLoading={spoolmanSpoolsLoading || spoolmanAssignmentsLoading}
              onUnassignSpoolmanSpool={(id) => unassignSpoolmanMutation.mutate(id)}
              amsThresholds={settings ? {
                humidityGood: Number(settings.ams_humidity_good) || 40,
                humidityFair: Number(settings.ams_humidity_fair) || 60,
                tempGood: Number(settings.ams_temp_good) || 28,
                tempFair: Number(settings.ams_temp_fair) || 35,
              } : undefined}
              timeFormat={settings?.time_format || 'system'}
              cameraViewMode={settings?.camera_view_mode || 'window'}
              onOpenEmbeddedCamera={(id, name) => setEmbeddedCameraPrinters(prev => new Map(prev).set(id, { id, name }))}
              checkPrinterFirmware={settings?.check_printer_firmware !== false}
              dryingPresets={effectiveDryingPresets}
              nozzleTempPresets={effectiveNozzleTempPresets}
              bedTempPresets={effectiveBedTempPresets}
              chamberTempPresets={effectiveChamberTempPresets}
              fanSpeedPresets={effectiveFanSpeedPresets}
              requirePlateClear={settings?.require_plate_clear === true}
              selectionMode={selectionMode}
              isSelected={selectedPrinterIds.has(printer.id)}
              onToggleSelect={toggleSelect}
              onOpenSinglePrinter={openSinglePrinter}
            />
          ))}
        </div>
      )}

      {printerPageViewMode === 'single' && !isMobilePrinterView && singlePrinterReturnView && (
        <button
          type="button"
          onClick={returnFromSinglePrinter}
          className={`fixed bottom-5 left-1/2 z-40 inline-flex -translate-x-1/2 items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium shadow-xl transition-colors ${accentButtonClass}`}
          title={t('common.back', 'Back')}
        >
          <ArrowLeft className="w-4 h-4" />
          {t('common.back', 'Back')}
        </button>
      )}

      {showAddModal && (
        <AddPrinterModal
          onClose={() => setShowAddModal(false)}
          onAdd={(data) => addMutation.mutate(data)}
          existingSerials={printers?.map(p => p.serial_number) || []}
        />
      )}

      {/* Bulk selection toolbar */}
      {selectionMode && printers && (
        <BulkPrinterToolbar
          selectedIds={selectedPrinterIds}
          printers={printers}
          onClose={clearSelection}
          onSelectAll={selectAll}
          onSelectByLocation={selectByLocation}
          onSelectByState={selectByState}
          onAction={handleBulkAction}
          actionPending={bulkActionPending}
        />
      )}

      {/* Bulk action confirmation modals */}
      {bulkConfirmAction === 'stop' && (
        <ConfirmModal
          title={t('printers.bulk.confirm.stopTitle', { count: selectedPrinterIds.size })}
          message={t('printers.bulk.confirm.stopMessage', { count: selectedPrinterIds.size })}
          confirmText={t('printers.bulk.confirm.stopButton')}
          variant="danger"
          isLoading={bulkActionPending}
          onConfirm={() => executeBulkAction('stop')}
          onCancel={() => setBulkConfirmAction(null)}
        />
      )}
      {bulkConfirmAction === 'pause' && (
        <ConfirmModal
          title={t('printers.bulk.confirm.pauseTitle', { count: selectedPrinterIds.size })}
          message={t('printers.bulk.confirm.pauseMessage', { count: selectedPrinterIds.size })}
          confirmText={t('printers.bulk.confirm.pauseButton')}
          isLoading={bulkActionPending}
          onConfirm={() => executeBulkAction('pause')}
          onCancel={() => setBulkConfirmAction(null)}
        />
      )}
      {bulkConfirmAction === 'clearPlate' && (
        <ConfirmModal
          title={t('printers.bulk.confirm.clearPlateTitle', { count: selectedPrinterIds.size })}
          message={t('printers.bulk.confirm.clearPlateMessage', { count: selectedPrinterIds.size })}
          confirmText={t('printers.bulk.confirm.clearPlateButton')}
          isLoading={bulkActionPending}
          onConfirm={() => executeBulkAction('clearPlate')}
          onCancel={() => setBulkConfirmAction(null)}
        />
      )}

      {/* Embedded Camera Viewers - multiple viewers can be open simultaneously */}
      {Array.from(embeddedCameraPrinters.values()).map((camera, index) => (
        <EmbeddedCameraViewer
          key={camera.id}
          printerId={camera.id}
          printerName={camera.name}
          viewerIndex={index}
          onClose={() => setEmbeddedCameraPrinters(prev => {
            const next = new Map(prev);
            next.delete(camera.id);
            return next;
          })}
        />
      ))}
    </div>
  );
}

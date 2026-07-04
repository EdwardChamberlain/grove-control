import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { compareFwVersions } from '../utils/firmwareVersion';
import { formatPrintName } from '../utils/printName';
import { computePopoverPosition } from '../utils/popoverPosition';
import {
  BED_TEMP_DEFAULTS,
  CHAMBER_TEMP_DEFAULTS,
  FAN_SPEED_DEFAULTS,
  NOZZLE_TEMP_DEFAULTS,
  buildPresetOptions,
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
  AlertCircle,
  Terminal,
  Power,
  Zap,
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
  Fan,
  Wind,
  AirVent,
  Download,
  ScanSearch,
  CheckCircle,
  CheckSquare,
  XCircle,
  User,
  Home,
  Printer as PrinterIcon,
  Info,
  Cable,
  Flame,
  Repeat,
  Snowflake,
  Gauge,
  DoorOpen,
  DoorClosed,
  Move,
  LogIn,
  LogOut,
  MoreHorizontal,
  SlidersHorizontal,
  Stethoscope,
  Activity,
  LineChart as LineChartIcon,
  MonitorPlay,
  List,
  BarChart3,
  Package,
} from 'lucide-react';

import { useNavigate } from 'react-router-dom';
import { api, discoveryApi, firmwareApi, getAuthToken, withStreamToken, ApiError } from '../api/client';
import { formatDateOnly, formatETA, formatDuration, parseUTCDate } from '../utils/date';
import { getCurrencySymbol } from '../utils/currency';
import type { Printer, PrinterCreate, PrinterStatus, AMSUnit, DiscoveredPrinter, FirmwareUpdateInfo, FirmwareUploadStatus, LinkedSpoolInfo, SpoolAssignment, HMSError, InventorySpool, PrinterDiagnosticResult, PrintLogEntry } from '../api/client';
import { Card, CardContent } from '../components/Card';
import { Button } from '../components/Button';
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
import { HeaterHistoryModal } from '../components/HeaterHistoryModal';
import type { HeaterSensorKind } from '../api/client';
import { FilamentHoverCard, EmptySlotHoverCard } from '../components/FilamentHoverCard';
import { LinkSpoolModal } from '../components/LinkSpoolModal';
import { AssignSpoolModal } from '../components/AssignSpoolModal';
import { ConfigureAmsSlotModal } from '../components/ConfigureAmsSlotModal';
import { useToast } from '../contexts/ToastContext';
import { ChamberLight } from '../components/icons/ChamberLight';
import { PlateClearedIcon } from '../components/icons/PlateClearedIcon';
import { SkipObjectsModal, SkipObjectsIcon } from '../components/SkipObjectsModal';
import { FileUploadModal } from '../components/FileUploadModal';
import { PrintModal } from '../components/PrintModal';
import { PrinterPowerControls } from '../components/printer/PrinterPowerControls';
import {
  AmsDryingButton,
  AmsDryingPopover,
  AmsDryingStatus,
} from '../components/printer/AmsDryingControls';
import { DRYING_PRESETS, useAmsDryingControls } from '../hooks/useAmsDryingControls';
import type { DryingPresets } from '../hooks/useAmsDryingControls';
import { PrinterInfoModal } from '../components/PrinterInfoModal';
import { getAmsLabel, getGlobalTrayId, getFillBarColor, getSpoolmanFillLevel, getFallbackSpoolTag, isBambuLabSpool } from '../utils/amsHelpers';
import { getPrinterImage, getWifiStrength, filterCompatibleQueueItems } from '../utils/printer';
import { FilamentSlotCircle } from '../components/FilamentSlotCircle';
import { Collapsible } from '../components/Collapsible';
import { ConnectionDiagnosticModal, DiagnosticChecklist } from '../components/ConnectionDiagnostic';
import { getColorName, parseFilamentColor, isLightColor } from '../utils/colors';

export interface SpoolmanSlotAssignmentRow {
  printer_id: number;
  ams_id: number;
  tray_id: number;
  spoolman_spool_id: number;
}

// Color names resolve via getColorName() which reads the backend color_catalog
// (loaded once by ColorCatalogProvider). No hardcoded tables here — see #857.

// Format K value with 3 decimal places, default to 0.020 if null
function formatKValue(k: number | null | undefined): string {
  const value = k ?? 0.020;
  return value.toFixed(3);
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
function nozzleTypeName(type: string, t: (key: string) => string): string {
  if (!type) return '';
  // Full text names (from main nozzle info)
  if (type.includes('hardened')) return t('printers.nozzleHardenedSteel');
  if (type.includes('stainless')) return t('printers.nozzleStainlessSteel');
  if (type.includes('tungsten')) return t('printers.nozzleTungstenCarbide');
  // 4-char codes (e.g. "HS01"): last 2 digits = material
  if (type.length >= 4) {
    const material = type.slice(2, 4);
    if (material === '00') return t('printers.nozzleStainlessSteel');
    if (material === '01') return t('printers.nozzleHardenedSteel');
    if (material === '05') return t('printers.nozzleTungstenCarbide');
  }
  // 2-digit numeric codes
  if (type === '00') return t('printers.nozzleStainlessSteel');
  if (type === '01') return t('printers.nozzleHardenedSteel');
  if (type === '05') return t('printers.nozzleTungstenCarbide');
  // 2-char alpha codes: H prefix = hardened steel
  if (type.startsWith('H')) return t('printers.nozzleHardenedSteel');
  return type;
}

// Parse flow type from nozzle type code
// HH = high flow, HS = standard/normal
function nozzleFlowName(type: string, t: (key: string) => string): string {
  if (!type) return '';
  if (type.startsWith('HH')) return t('printers.nozzleHighFlow');
  if (type.startsWith('HS')) return t('printers.nozzleStandardFlow');
  return '';
}

// Per-slot hover card for nozzle rack
// activeStatus: when true, show "Active" instead of "Mounted"/"Docked" (for hotend nozzles)
function NozzleSlotHoverCard({ slot, index, activeStatus, filamentName, children }: {
  slot: import('../api/client').NozzleRackSlot;
  index: number;
  activeStatus?: boolean;
  filamentName?: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState<'top' | 'bottom'>('top');
  const triggerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isEmpty = !slot.nozzle_diameter && !slot.nozzle_type;
  const isMounted = slot.stat === 1;

  useEffect(() => {
    if (isVisible && triggerRef.current && cardRef.current) {
      const triggerRect = triggerRef.current.getBoundingClientRect();
      const cardHeight = cardRef.current.offsetHeight;
      const headerHeight = 56;
      const spaceAbove = triggerRect.top - headerHeight;
      const spaceBelow = window.innerHeight - triggerRect.bottom;
      if (spaceAbove < cardHeight + 12 && spaceBelow > spaceAbove) {
        setPosition('bottom');
      } else {
        setPosition('top');
      }
    }
  }, [isVisible]);

  const handleMouseEnter = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setIsVisible(true), 80);
  };

  const handleMouseLeave = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setIsVisible(false), 100);
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const filamentCss = parseFilamentColor(slot.filament_color);
  const typeFull = nozzleTypeName(slot.nozzle_type, t);
  const flowFull = nozzleFlowName(slot.nozzle_type, t);

  return (
    <div
      ref={triggerRef}
      className="relative"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}

      {isVisible && (
        <div
          ref={cardRef}
          className={`
            absolute left-1/2 -translate-x-1/2 z-50
            ${position === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'}
            animate-in fade-in-0 zoom-in-95 duration-150
          `}
          style={{ maxWidth: 'calc(100vw - 24px)' }}
        >
          <div className="w-44 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-xl overflow-hidden backdrop-blur-sm">
            {isEmpty ? (
              <div className="px-3 py-2 text-xs text-bambu-gray text-center whitespace-nowrap">
                Slot {index + 1} — Empty
              </div>
            ) : (
              <div className="p-2.5 space-y-1.5">
                {/* Diameter */}
                <div className="flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-wider text-bambu-gray font-medium">{t('printers.nozzleDiameter')}</span>
                  <span className="text-xs text-white font-semibold">{slot.nozzle_diameter} mm</span>
                </div>

                {/* Type */}
                {typeFull && (
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wider text-bambu-gray font-medium">{t('printers.nozzleType')}</span>
                    <span className="text-xs text-white font-semibold truncate max-w-[100px]">{typeFull}</span>
                  </div>
                )}

                {/* Flow (hide if empty) */}
                {flowFull && (
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wider text-bambu-gray font-medium">{t('printers.nozzleFlow')}</span>
                    <span className="text-xs text-white font-semibold">{flowFull}</span>
                  </div>
                )}

                {/* Status badge */}
                <div className="flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-wider text-bambu-gray font-medium">{t('printers.nozzleStatus')}</span>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                    activeStatus || isMounted
                      ? 'bg-green-900/50 text-green-400'
                      : 'bg-bambu-dark-tertiary text-bambu-gray'
                  }`}>
                    {activeStatus ? t('printers.nozzleActive') : isMounted ? t('printers.nozzleMounted') : t('printers.nozzleDocked')}
                  </span>
                </div>

                {/* Wear (hide if null) */}
                {slot.wear != null && (
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wider text-bambu-gray font-medium">{t('printers.nozzleWear')}</span>
                    <span className="text-xs text-white font-semibold">{slot.wear}%</span>
                  </div>
                )}

                {/* Max Temp (hide if 0) */}
                {slot.max_temp > 0 && (
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wider text-bambu-gray font-medium">{t('printers.nozzleMaxTemp')}</span>
                    <span className="text-xs text-white font-semibold">{slot.max_temp}°C</span>
                  </div>
                )}

                {/* Serial (hide if empty) */}
                {slot.serial_number && (
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wider text-bambu-gray font-medium">{t('printers.nozzleSerial')}</span>
                    <span className="text-[10px] text-white font-mono truncate max-w-[80px]">{slot.serial_number}</span>
                  </div>
                )}

                {/* Filament: material type + color swatch (hide if no color) */}
                {(filamentCss || slot.filament_type) && (
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wider text-bambu-gray font-medium">{t('printers.nozzleFilament')}</span>
                    <div className="flex items-center gap-1">
                      {filamentCss && (
                        <div className="w-3 h-3 rounded-sm border border-white/20" style={{ backgroundColor: filamentCss }} />
                      )}
                      <span className="text-[10px] text-white font-semibold truncate max-w-[100px]">{filamentName || slot.filament_type || slot.filament_id || ''}</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Arrow pointer */}
          <div
            className={`
              absolute left-1/2 -translate-x-1/2 w-0 h-0
              border-l-[6px] border-l-transparent
              border-r-[6px] border-r-transparent
              ${position === 'top'
                ? 'top-full border-t-[6px] border-t-bambu-dark-tertiary'
                : 'bottom-full border-b-[6px] border-b-bambu-dark-tertiary'}
            `}
          />
        </div>
      )}
    </div>
  );
}

// Dual-nozzle hover card showing L and R nozzle details side by side
function DualNozzleHoverCard({ leftSlot, rightSlot, activeNozzle, filamentInfo, children }: {
  leftSlot?: import('../api/client').NozzleRackSlot;
  rightSlot?: import('../api/client').NozzleRackSlot;
  activeNozzle: 'L' | 'R';
  filamentInfo?: Record<string, { name: string; k: number | null }>;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState<'top' | 'bottom'>('top');
  const triggerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isVisible && triggerRef.current && cardRef.current) {
      const triggerRect = triggerRef.current.getBoundingClientRect();
      const cardHeight = cardRef.current.offsetHeight;
      const headerHeight = 56;
      const spaceAbove = triggerRect.top - headerHeight;
      const spaceBelow = window.innerHeight - triggerRect.bottom;
      if (spaceAbove < cardHeight + 12 && spaceBelow > spaceAbove) {
        setPosition('bottom');
      } else {
        setPosition('top');
      }
    }
  }, [isVisible]);

  const handleMouseEnter = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setIsVisible(true), 80);
  };

  const handleMouseLeave = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setIsVisible(false), 100);
  };

  useEffect(() => {
    return () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); };
  }, []);

  if (!leftSlot && !rightSlot) return <>{children}</>;

  const renderColumn = (slot: import('../api/client').NozzleRackSlot, side: 'L' | 'R') => {
    const isActive = activeNozzle === side;
    const typeFull = nozzleTypeName(slot.nozzle_type, t);
    const flowFull = nozzleFlowName(slot.nozzle_type, t);
    const filamentCss = parseFilamentColor(slot.filament_color);
    const filamentName = slot.filament_id ? filamentInfo?.[slot.filament_id]?.name : undefined;
    return (
      <div className="flex-1 space-y-1.5">
        <div className={`text-[10px] font-bold pb-1 border-b border-bambu-dark-tertiary/50 ${isActive ? 'text-amber-400' : 'text-bambu-gray'}`}>
          {side === 'L' ? t('common.left') : t('common.right')}
        </div>
        {slot.nozzle_diameter && (
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-bambu-gray">{t('printers.nozzleDiameter')}</span>
            <span className="text-xs text-white font-semibold">{slot.nozzle_diameter} mm</span>
          </div>
        )}
        {typeFull && (
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-bambu-gray">{t('printers.nozzleType')}</span>
            <span className="text-[10px] text-white font-semibold">{typeFull}</span>
          </div>
        )}
        {flowFull && (
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-bambu-gray">{t('printers.nozzleFlow')}</span>
            <span className="text-[10px] text-white font-semibold">{flowFull}</span>
          </div>
        )}
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-bambu-gray">{t('printers.nozzleStatus')}</span>
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
            isActive
              ? 'bg-green-900/50 text-green-400'
              : 'bg-bambu-dark-tertiary text-bambu-gray'
          }`}>
            {isActive ? t('printers.nozzleActive') : t('printers.nozzleIdle')}
          </span>
        </div>
        {slot.wear != null && (
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-bambu-gray">{t('printers.nozzleWear')}</span>
            <span className="text-xs text-white font-semibold">{slot.wear}%</span>
          </div>
        )}
        {/* Serial and max temp only available on the right (removable) nozzle */}
        {side === 'R' && slot.max_temp > 0 && (
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-bambu-gray">{t('printers.nozzleMaxTemp')}</span>
            <span className="text-xs text-white font-semibold">{slot.max_temp}°C</span>
          </div>
        )}
        {side === 'R' && slot.serial_number && (
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-bambu-gray">{t('printers.nozzleSerial')}</span>
            <span className="text-[10px] text-white font-mono">{slot.serial_number}</span>
          </div>
        )}
        {(filamentCss || slot.filament_type || slot.filament_id) && (
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-bambu-gray">{t('printers.nozzleFilament')}</span>
            <div className="flex items-center gap-1">
              {filamentCss && (
                <div className="w-3 h-3 rounded-sm border border-white/20" style={{ backgroundColor: filamentCss }} />
              )}
              <span className="text-[10px] text-white font-semibold truncate max-w-[100px]">
                {filamentName || slot.filament_type || slot.filament_id || ''}
              </span>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      ref={triggerRef}
      className="relative flex-1"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}

      {isVisible && (
        <div
          ref={cardRef}
          className={`
            absolute left-1/2 -translate-x-1/2 z-50
            ${position === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'}
            animate-in fade-in-0 zoom-in-95 duration-150
          `}
          style={{ maxWidth: 'calc(100vw - 24px)' }}
        >
          <div className="w-96 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-xl overflow-hidden backdrop-blur-sm">
            <div className="p-2.5 flex gap-3">
              {leftSlot && renderColumn(leftSlot, 'L')}
              {leftSlot && rightSlot && <div className="w-px bg-bambu-dark-tertiary/50" />}
              {rightSlot && renderColumn(rightSlot, 'R')}
            </div>
          </div>

          {/* Arrow pointer */}
          <div
            className={`
              absolute left-1/2 -translate-x-1/2 w-0 h-0
              border-l-[6px] border-l-transparent
              border-r-[6px] border-r-transparent
              ${position === 'top'
                ? 'top-full border-t-[6px] border-t-bambu-dark-tertiary'
                : 'bottom-full border-b-[6px] border-b-bambu-dark-tertiary'}
            `}
          />
        </div>
      )}
    </div>
  );
}

// H2C Nozzle Rack Card — compact single row showing 6-position tool-changer dock
function NozzleRackCard({ slots, filamentInfo }: { slots: import('../api/client').NozzleRackSlot[]; filamentInfo?: Record<string, { name: string; k: number | null }> }) {
  const { t } = useTranslation();
  // Rack nozzles only (IDs >= 2) — excludes L/R hotend nozzles (IDs 0, 1).
  // H2C rack slot IDs are fixed at 16..21. When a nozzle is picked up into the
  // hotend the firmware omits that rack ID entirely, so we must map by the fixed
  // base — computing it from min(present IDs) shifts everything left when slot 16
  // is the one currently mounted (#943).
  const rackNozzles = slots.filter(s => s.id >= 2);
  const RACK_SIZE = 6;
  const RACK_BASE_ID = 16;
  const rackSlots: (import('../api/client').NozzleRackSlot)[] = Array.from(
    { length: RACK_SIZE },
    (_, i) => rackNozzles.find(s => s.id === RACK_BASE_ID + i) ?? {
      id: -(i + 1), nozzle_type: '', nozzle_diameter: '', wear: null, stat: null,
      max_temp: 0, serial_number: '', filament_color: '', filament_id: '', filament_type: '',
    },
  );

  return (
    <div className="text-center px-2.5 py-1.5 bg-bambu-dark rounded-lg flex-[2_1_190px] flex flex-col justify-center">
      <p className="text-[9px] text-bambu-gray mb-1">{t('printers.nozzleRack')}</p>
      <div className="flex gap-[3px] justify-center">
        {rackSlots.map((slot, i) => {
          const isEmpty = !slot.nozzle_diameter && !slot.nozzle_type;
          const filamentBg = !isEmpty ? parseFilamentColor(slot.filament_color) : null;
          const lightBg = filamentBg ? isLightColor(slot.filament_color) : false;

          return (
            <NozzleSlotHoverCard key={slot.id >= 0 ? slot.id : `empty-${i}`} slot={slot} index={i} filamentName={slot.filament_id ? filamentInfo?.[slot.filament_id]?.name : undefined}>
              <div
                className={`w-7 h-7 rounded flex items-center justify-center cursor-default transition-colors border-b-2 ${
                  isEmpty
                    ? 'bg-bambu-dark-tertiary/20 border-bambu-dark-tertiary/20'
                    : 'bg-bambu-dark-tertiary/40 border-bambu-dark-tertiary/40'
                }`}
                style={filamentBg ? { backgroundColor: filamentBg } : undefined}
              >
                <span className={`text-[10px] font-semibold ${isEmpty ? 'text-bambu-gray/30' : lightBg ? 'text-black/80' : 'text-white'}`}
                      style={filamentBg && !lightBg ? { textShadow: '0 1px 3px rgba(0,0,0,0.9)' } : undefined}
                >
                  {isEmpty ? '—' : (slot.nozzle_diameter || '?')}
                </span>
              </div>
            </NozzleSlotHoverCard>
          );
        })}
      </div>
    </div>
  );
}

// Water drop SVG - empty outline (Bambu Lab style from bambu-humidity)
function WaterDropEmpty({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 36 54" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M17.8131 0.00538C18.4463 -0.15091 20.3648 3.14642 20.8264 3.84781C25.4187 10.816 35.3089 26.9368 35.9383 34.8694C37.4182 53.5822 11.882 61.3357 2.53721 45.3789C-1.73471 38.0791 0.016 32.2049 3.178 25.0232C6.99221 16.3662 12.6411 7.90372 17.8131 0.00538ZM18.3738 7.24807L17.5881 7.48441C14.4452 12.9431 10.917 18.2341 8.19369 23.9368C4.6808 31.29 1.18317 38.5479 7.69403 45.5657C17.3058 55.9228 34.9847 46.8808 31.4604 32.8681C29.2558 24.0969 22.4207 15.2913 18.3776 7.24807H18.3738Z" fill="#C3C2C1"/>
    </svg>
  );
}

// Water drop SVG - half filled with blue water (Bambu Lab style from bambu-humidity)
function WaterDropHalf({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 35 53" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M17.3165 0.0038C17.932 -0.14959 19.7971 3.08645 20.2458 3.77481C24.7103 10.6135 34.3251 26.4346 34.937 34.2198C36.3757 52.5848 11.5505 60.1942 2.46584 44.534C-1.68714 37.3735 0.0148 31.6085 3.08879 24.5603C6.79681 16.0605 12.2884 7.75907 17.3165 0.0038ZM17.8615 7.11561L17.0977 7.34755C14.0423 12.7048 10.6124 17.8974 7.96483 23.4941C4.54975 30.7107 1.14949 37.8337 7.47908 44.721C16.8233 54.8856 34.01 46.0117 30.5838 32.2595C28.4405 23.6512 21.7957 15.0093 17.8652 7.11561H17.8615Z" fill="#C3C2C1"/>
      <path d="M5.03547 30.112C9.64453 30.4936 11.632 35.7985 16.4154 35.791C19.6339 35.7873 20.2161 33.2283 22.3853 31.6197C31.6776 24.7286 33.5835 37.4894 27.9881 44.4254C18.1878 56.5653 -1.16063 44.6013 5.03917 30.1158L5.03547 30.112Z" fill="#1F8FEB"/>
    </svg>
  );
}

// Water drop SVG - fully filled with blue water (Bambu Lab style from bambu-humidity)
function WaterDropFull({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 36 54" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M17.9625 4.48059L4.77216 26.3154L2.08228 40.2175L10.0224 50.8414H23.1594L33.3246 42.1693V30.2455L17.9625 4.48059Z" fill="#1F8FEB"/>
      <path d="M17.7948 0.00538C18.4273 -0.15091 20.3438 3.14642 20.8048 3.84781C25.3921 10.816 35.2715 26.9368 35.9001 34.8694C37.3784 53.5822 11.8702 61.3357 2.53562 45.3789C-1.73163 38.0829 0.0134 32.2087 3.1757 25.027C6.98574 16.3662 12.6284 7.90372 17.7948 0.00538ZM18.3549 7.24807L17.57 7.48441C14.4306 12.9431 10.9063 18.2341 8.1859 23.9368C4.67686 31.29 1.18305 38.5479 7.68679 45.5657C17.2881 55.9228 34.9476 46.8808 31.4271 32.8681C29.2249 24.0969 22.3974 15.2913 18.3587 7.24807H18.3549Z" fill="#C3C2C1"/>
    </svg>
  );
}

// Thermometer SVG - empty outline
function ThermometerEmpty({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 12 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M6 0.5C4.6 0.5 3.5 1.6 3.5 3V12.1C2.6 12.8 2 13.9 2 15C2 17.2 3.8 19 6 19C8.2 19 10 17.2 10 15C10 13.9 9.4 12.8 8.5 12.1V3C8.5 1.6 7.4 0.5 6 0.5Z" stroke="#C3C2C1" strokeWidth="1" fill="none"/>
      <circle cx="6" cy="15" r="2.5" stroke="#C3C2C1" strokeWidth="1" fill="none"/>
    </svg>
  );
}

// Thermometer SVG - half filled (gold - same as humidity fair)
function ThermometerHalf({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 12 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="4.5" y="8" width="3" height="4.5" fill="#d4a017" rx="0.5"/>
      <circle cx="6" cy="15" r="2" fill="#d4a017"/>
      <path d="M6 0.5C4.6 0.5 3.5 1.6 3.5 3V12.1C2.6 12.8 2 13.9 2 15C2 17.2 3.8 19 6 19C8.2 19 10 17.2 10 15C10 13.9 9.4 12.8 8.5 12.1V3C8.5 1.6 7.4 0.5 6 0.5Z" stroke="#C3C2C1" strokeWidth="1" fill="none"/>
    </svg>
  );
}

// Thermometer SVG - fully filled (red - same as humidity bad)
function ThermometerFull({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 12 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="4.5" y="3" width="3" height="9.5" fill="#c62828" rx="0.5"/>
      <circle cx="6" cy="15" r="2" fill="#c62828"/>
      <path d="M6 0.5C4.6 0.5 3.5 1.6 3.5 3V12.1C2.6 12.8 2 13.9 2 15C2 17.2 3.8 19 6 19C8.2 19 10 17.2 10 15C10 13.9 9.4 12.8 8.5 12.1V3C8.5 1.6 7.4 0.5 6 0.5Z" stroke="#C3C2C1" strokeWidth="1" fill="none"/>
    </svg>
  );
}

// Nozzle icon - schematic hot-end view (filament body + heater block + tip).
// Added for visual parity with the thermometer icons on the dual-nozzle card
// that previously had no icon at all (#1115, design by @m4rtini2).
function NozzleIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9.2" y="3.4" width="5.6" height="8.1" />
      <rect x="6" y="11.5" width="12.1" height="3.7" />
      <path d="M 7.3 15.2 L 12.1 19.6 L 16.7 15.2" />
    </svg>
  );
}

// Heater thermometer icon - filled when heating, outline when off
interface HeaterThermometerProps {
  className?: string;
  color: string;  // The color class (e.g., "text-orange-400")
  isHeating: boolean;
}

function HeaterThermometer({ className, color, isHeating }: HeaterThermometerProps) {
  // Extract the actual color from Tailwind class for SVG fill
  const colorMap: Record<string, string> = {
    'text-orange-400': '#fb923c',
    'text-blue-400': '#60a5fa',
    'text-green-400': '#4ade80',
  };
  const fillColor = colorMap[color] || '#888';

  // Glow style when heating
  const glowStyle = isHeating ? {
    filter: `drop-shadow(0 0 4px ${fillColor}) drop-shadow(0 0 8px ${fillColor})`,
  } : {};

  if (isHeating) {
    // Filled thermometer with glow - heater is ON
    return (
      <svg className={className} style={glowStyle} viewBox="0 0 12 20" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="4.5" y="3" width="3" height="9.5" fill={fillColor} rx="0.5"/>
        <circle cx="6" cy="15" r="2" fill={fillColor}/>
        <path d="M6 0.5C4.6 0.5 3.5 1.6 3.5 3V12.1C2.6 12.8 2 13.9 2 15C2 17.2 3.8 19 6 19C8.2 19 10 17.2 10 15C10 13.9 9.4 12.8 8.5 12.1V3C8.5 1.6 7.4 0.5 6 0.5Z" stroke={fillColor} strokeWidth="1" fill="none"/>
      </svg>
    );
  }

  // Empty thermometer - heater is OFF
  return (
    <svg className={className} viewBox="0 0 12 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M6 0.5C4.6 0.5 3.5 1.6 3.5 3V12.1C2.6 12.8 2 13.9 2 15C2 17.2 3.8 19 6 19C8.2 19 10 17.2 10 15C10 13.9 9.4 12.8 8.5 12.1V3C8.5 1.6 7.4 0.5 6 0.5Z" stroke={fillColor} strokeWidth="1" fill="none"/>
      <circle cx="6" cy="15" r="2.5" stroke={fillColor} strokeWidth="1" fill="none"/>
    </svg>
  );
}

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

// Humidity indicator with water drop that fills based on level (Bambu Lab style)
// Reference: https://github.com/theicedmango/bambu-humidity
interface HumidityIndicatorProps {
  humidity: number | string;
  goodThreshold?: number;  // <= this is green
  fairThreshold?: number;  // <= this is orange, > is red
  onClick?: () => void;
  compact?: boolean;  // Smaller version for grid layout
}

function HumidityIndicator({ humidity, goodThreshold = 40, fairThreshold = 60, onClick, compact }: HumidityIndicatorProps) {
  const humidityValue = typeof humidity === 'string' ? parseInt(humidity, 10) : humidity;
  const good = typeof goodThreshold === 'number' ? goodThreshold : 40;
  const fair = typeof fairThreshold === 'number' ? fairThreshold : 60;

  // Status thresholds (configurable via settings)
  // Good: ≤goodThreshold (green #22a352), Fair: ≤fairThreshold (gold #d4a017), Bad: >fairThreshold (red #c62828)
  let textColor: string;
  let statusText: string;

  if (isNaN(humidityValue)) {
    textColor = '#C3C2C1';
    statusText = 'Unknown';
  } else if (humidityValue <= good) {
    textColor = '#22a352'; // Green - Good
    statusText = 'Good';
  } else if (humidityValue <= fair) {
    textColor = '#d4a017'; // Gold - Fair
    statusText = 'Fair';
  } else {
    textColor = '#c62828'; // Red - Bad
    statusText = 'Bad';
  }

  // Fill level based on status: Good=Empty (dry), Fair=Half, Bad=Full (wet)
  let DropComponent: React.FC<{ className?: string }>;
  if (isNaN(humidityValue)) {
    DropComponent = WaterDropEmpty;
  } else if (humidityValue <= good) {
    DropComponent = WaterDropEmpty; // Good - empty drop (dry)
  } else if (humidityValue <= fair) {
    DropComponent = WaterDropHalf; // Fair - half filled
  } else {
    DropComponent = WaterDropFull; // Bad - full (too humid)
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1 ${onClick ? 'cursor-pointer hover:opacity-80 transition-opacity' : ''}`}
      title={`Humidity: ${humidityValue}% - ${statusText}${onClick ? ' (click for history)' : ''}`}
    >
      <DropComponent className={compact ? "w-2.5 h-3" : "w-3 h-4"} />
      <span className={`font-medium tabular-nums ${compact ? 'text-[10px]' : 'text-xs'}`} style={{ color: textColor }}>{humidityValue}%</span>
    </button>
  );
}

// Temperature indicator with dynamic icon and coloring
interface TemperatureIndicatorProps {
  temp: number;
  goodThreshold?: number;  // <= this is blue
  fairThreshold?: number;  // <= this is orange, > is red
  onClick?: () => void;
  compact?: boolean;  // Smaller version for grid layout
}

function TemperatureIndicator({ temp, goodThreshold = 28, fairThreshold = 35, onClick, compact }: TemperatureIndicatorProps) {
  // Ensure thresholds are numbers
  const good = typeof goodThreshold === 'number' ? goodThreshold : 28;
  const fair = typeof fairThreshold === 'number' ? fairThreshold : 35;

  let textColor: string;
  let statusText: string;
  let ThermoComponent: React.FC<{ className?: string }>;

  if (temp <= good) {
    textColor = '#22a352'; // Green - good (same as humidity)
    statusText = 'Good';
    ThermoComponent = ThermometerEmpty;
  } else if (temp <= fair) {
    textColor = '#d4a017'; // Gold - fair (same as humidity)
    statusText = 'Fair';
    ThermoComponent = ThermometerHalf;
  } else {
    textColor = '#c62828'; // Red - bad (same as humidity)
    statusText = 'Bad';
    ThermoComponent = ThermometerFull;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1 ${onClick ? 'cursor-pointer hover:opacity-80 transition-opacity' : ''}`}
      title={`Temperature: ${temp}°C - ${statusText}${onClick ? ' (click for history)' : ''}`}
    >
      <ThermoComponent className={compact ? "w-2.5 h-3" : "w-3 h-4"} />
      <span className={`tabular-nums text-right ${compact ? 'text-[10px] w-8' : 'w-12'}`} style={{ color: textColor }}>{temp}°C</span>
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

type ToolbarDropdownOption<T extends string> = {
  value: T;
  label: string;
};

function ToolbarDropdown<T extends string>({
  value,
  options,
  onChange,
  fullWidth = false,
}: {
  value: T;
  options: ToolbarDropdownOption<T>[];
  onChange: (value: T) => void;
  fullWidth?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const selectedOption = options.find(option => option.value === value) ?? options[0];

  return (
    <div className={`relative ${fullWidth ? 'w-full min-w-0' : ''}`}>
      <button
        type="button"
        onClick={() => setIsOpen(open => !open)}
        className={`h-8 px-2 rounded-lg border bg-bambu-dark border-bambu-dark-tertiary text-white text-sm font-medium transition-colors hover:bg-bambu-dark-tertiary focus:outline-none focus:border-bambu-green flex items-center justify-between gap-2 ${fullWidth ? 'w-full' : 'min-w-28'}`}
      >
        <span className="truncate">{selectedOption?.label}</span>
        <ChevronDown className={`w-4 h-4 text-bambu-gray transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
          <div className="absolute left-0 top-full z-20 mt-1 min-w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary py-1 shadow-xl">
            {options.map(option => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
                className={`w-full px-3 py-2 text-left text-sm transition-colors hover:bg-bambu-dark-tertiary ${
                  option.value === value ? 'text-bambu-green' : 'text-white'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ToolbarMenu({
  label,
  icon,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(open => !open)}
        className="h-8 w-8 rounded-lg border bg-bambu-dark border-bambu-dark-tertiary text-white hover:bg-bambu-dark-tertiary transition-colors flex items-center justify-center"
        aria-label={label}
        title={label}
      >
        {icon}
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 min-w-40 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary p-2 shadow-xl">
            {children}
          </div>
        </>
      )}
    </div>
  );
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

const NOZZLE_TEMPERATURE_OPTIONS = buildPresetOptions(NOZZLE_TEMP_DEFAULTS, 'C');

function NozzleTemperatureControlBox({
  label,
  current,
  target,
  isActive,
  isPending,
  onSubmit,
  options = NOZZLE_TEMPERATURE_OPTIONS,
}: {
  label: string;
  current?: number;
  target?: number;
  isActive: boolean;
  isPending?: boolean;
  onSubmit: (value: number) => void;
  options?: Array<{ label: string; value: number }>;
}) {
  const [customValue, setCustomValue] = useState('');

  const submitCustom = () => {
    const value = Number(customValue);
    if (!Number.isFinite(value)) return;
    onSubmit(Math.min(320, Math.max(0, Math.round(value))));
  };

  return (
    <div className={`rounded-lg border p-2 ${isActive ? 'border-amber-400/60 bg-amber-400/10' : 'border-bambu-dark-tertiary bg-bambu-dark'}`}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className={`text-xs font-medium ${isActive ? 'text-amber-300' : 'text-white'}`}>{label}</span>
        <span className="text-[10px] text-bambu-gray">
          {Math.round(current ?? 0)}°C
          {target !== undefined ? ` / ${Math.round(target)}°` : ''}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1">
        {options.map(option => (
          <button
            key={`${label}-${option.value}`}
            type="button"
            disabled={isPending}
            onClick={() => onSubmit(option.value)}
            className="h-7 rounded-md border border-bambu-dark-tertiary bg-bambu-dark-secondary px-1.5 text-[11px] font-medium text-white transition-colors hover:bg-bambu-dark-tertiary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {option.label}
          </button>
        ))}
      </div>
      <form
        className="mt-1.5 flex gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          submitCustom();
        }}
      >
        <input
          type="number"
          min={0}
          max={320}
          step={1}
          value={customValue}
          onChange={e => setCustomValue(e.target.value)}
          placeholder="Custom"
          className="h-7 min-w-0 flex-1 rounded-md border border-bambu-dark-tertiary bg-bambu-dark-secondary px-1.5 text-[11px] text-white placeholder:text-bambu-gray/60 focus:border-bambu-green focus:outline-none"
        />
        <button
          type="submit"
          disabled={isPending || customValue.trim() === ''}
          className="h-7 rounded-md border border-bambu-dark-tertiary bg-bambu-dark-secondary px-2 text-[11px] font-medium text-white transition-colors hover:bg-bambu-dark-tertiary disabled:cursor-not-allowed disabled:opacity-50"
        >
          Set
        </button>
      </form>
    </div>
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

// Bambu models that ship with an enclosure chamber fan (firmware field
// `big_fan2_speed`). Open-frame models have no chamber fan, so the widget is
// hidden rather than rendered as an inactive control.
const MODELS_WITH_CHAMBER_FAN: ReadonlySet<string> = new Set([
  'X1C',
  'X1',
  'X1E',
  'X2D',
  'P1S',
  'P2S',
  'H2D',
  'H2D Pro',
  'H2C',
  'H2S',
]);

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

function ListHealthStatusMenu({
  status,
  printerHealth,
  knownHmsErrors,
  maintenanceInfo,
  requirePlateClear,
  needsPlateClear,
  firmwareInfo,
  hasDoorSensor,
}: {
  status?: PrinterStatus;
  printerHealth: PrinterHealthMeta;
  knownHmsErrors: HMSError[];
  maintenanceInfo?: PrinterMaintenanceInfo;
  requirePlateClear?: boolean;
  needsPlateClear: boolean;
  firmwareInfo?: FirmwareUpdateInfo;
  hasDoorSensor: boolean;
}) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const rowClass = 'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium';
  const isPrintingOrPaused = status?.state === 'RUNNING' || status?.state === 'PAUSE';
  const maintenanceDueCount = maintenanceInfo?.due_count ?? 0;
  const maintenanceWarningCount = maintenanceInfo?.warning_count ?? 0;
  const plateLabel = isPrintingOrPaused
    ? t('printers.plateStatus.inUse')
    : needsPlateClear
      ? t('printers.plateStatus.notCleared')
      : t('printers.plateStatus.cleared');
  const networkClass = !status?.connected
    ? 'bg-status-error/20 text-status-error'
    : status.wired_network || status.wifi_signal == null || status.wifi_signal >= -60
      ? 'bg-status-ok/20 text-status-ok'
      : status.wifi_signal >= -80
        ? 'bg-status-warning/20 text-status-warning'
        : 'bg-status-error/20 text-status-error';

  useLayoutEffect(() => {
    if (!isOpen) return;
    const measure = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      setCoords(computePopoverPosition({
        triggerRect: rect,
        popoverWidth: 240,
        estimatedHeight: 320,
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
  }, [isOpen]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((open) => !open);
        }}
        className={`pointer-events-auto inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-opacity hover:opacity-80 ${printerHealth.className}`}
        title={t('printers.health.title', 'Machine health: {{status}}', { status: printerHealth.label })}
        aria-label={t('printers.health.title', 'Machine health: {{status}}', { status: printerHealth.label })}
        aria-expanded={isOpen}
      >
        <Activity className="h-4 w-4" />
      </button>
      {isOpen && createPortal(
        <>
          <div
            className="fixed inset-0 z-[1000]"
            onClick={(event) => {
              event.stopPropagation();
              setIsOpen(false);
            }}
          />
          <div
            className="fixed z-[1001] flex w-[240px] flex-col overflow-hidden rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-2xl"
            style={{
              top: coords?.top ?? -9999,
              left: coords?.left ?? -9999,
              visibility: coords ? 'visible' : 'hidden',
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="shrink-0 px-3 py-2.5 text-center text-sm font-medium text-white">
              {t('printers.health.statusDetails', 'Status details')}
            </div>
            <div className="h-px bg-bambu-dark-tertiary" />
            <div className="space-y-1.5 p-2.5">
              <div className={`${rowClass} ${status?.connected ? 'bg-status-ok/20 text-status-ok' : 'bg-status-error/20 text-status-error'}`}>
                {status?.connected ? <Link className="h-3 w-3" /> : <Unlink className="h-3 w-3" />}
                <span>{t('printers.status.connection', 'Connection')}:</span>
                <span>{status?.connected ? t('printers.connection.connected') : t('printers.connection.offline')}</span>
              </div>
              {requirePlateClear && status?.connected && (
                <div className={`${rowClass} ${needsPlateClear ? 'bg-status-warning/20 text-status-warning' : 'bg-status-ok/20 text-status-ok'}`}>
                  <PlateClearedIcon className="h-3 w-3" />
                  <span>{t('printers.plateStatus.title', 'Plate')}:</span>
                  <span>{plateLabel}</span>
                </div>
              )}
              <div className={`${rowClass} ${networkClass}`}>
                {status?.wired_network ? <Cable className="h-3 w-3" /> : <Signal className="h-3 w-3" />}
                <span>{t('printers.status.network', 'Network')}:</span>
                <span>{!status?.connected ? t('printers.connection.offline') : status.wired_network ? t('printers.connection.ethernet', 'Ethernet') : status.wifi_signal != null ? `${status.wifi_signal}dBm` : t('common.unknown', 'Unknown')}</span>
              </div>
              <div className={`${rowClass} ${!status?.connected ? 'bg-status-error/20 text-status-error' : knownHmsErrors.length > 0 ? knownHmsErrors.some((error) => error.severity <= 2) ? 'bg-status-error/20 text-status-error' : 'bg-status-warning/20 text-status-warning' : 'bg-status-ok/20 text-status-ok'}`}>
                <AlertTriangle className="h-3 w-3" />
                <span>{t('printers.status.errors', 'Errors')}:</span>
                <span>{status?.connected ? knownHmsErrors.length > 0 ? t('printers.status.errorCount', '{{count}} active', { count: knownHmsErrors.length }) : t('common.ok', 'OK') : t('common.unknown', 'Unknown')}</span>
              </div>
              <div className={`${rowClass} ${maintenanceDueCount > 0 ? 'bg-status-error/20 text-status-error' : maintenanceWarningCount > 0 ? 'bg-status-warning/20 text-status-warning' : 'bg-status-ok/20 text-status-ok'}`}>
                <Wrench className="h-3 w-3" />
                <span>{t('maintenance.title', 'Maintenance')}:</span>
                <span>{maintenanceDueCount > 0 ? t('maintenance.dueCount', { count: maintenanceDueCount }) : maintenanceWarningCount > 0 ? t('maintenance.warningCount', { count: maintenanceWarningCount }) : t('common.ok', 'OK')}</span>
              </div>
              {(firmwareInfo?.current_version || status?.firmware_version) && (
                <div className={`${rowClass} ${firmwareInfo?.update_available ? 'bg-status-warning/20 text-status-warning' : 'bg-status-ok/20 text-status-ok'}`}>
                  {firmwareInfo?.update_available ? <Download className="h-3 w-3" /> : <CheckCircle className="h-3 w-3" />}
                  <span>{t('printers.status.firmware', 'Firmware')}:</span>
                  <span>{firmwareInfo?.update_available ? t('printers.status.updateAvailable', 'Update available') : firmwareInfo?.current_version || status?.firmware_version}</span>
                </div>
              )}
              {status?.connected && hasDoorSensor && (
                <div className={`${rowClass} ${status.door_open ? 'bg-status-warning/20 text-status-warning' : 'bg-status-ok/20 text-status-ok'}`}>
                  {status.door_open ? <DoorOpen className="h-3 w-3" /> : <DoorClosed className="h-3 w-3" />}
                  <span>{t('printers.status.door', 'Door')}:</span>
                  <span>{status.door_open ? t('printers.door.open') : t('printers.door.closed')}</span>
                </div>
              )}
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
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
  const etaLabel = status?.remaining_time != null && status.remaining_time > 0
    ? `${formatDuration(status.remaining_time * 60)} - ${formatETA(status.remaining_time, timeFormat, t)}`
    : '--:--';
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
          <span className="min-w-12 shrink-0 text-right text-xs font-medium tabular-nums text-white">{etaLabel}</span>
          <ListHealthStatusMenu
            status={status}
            printerHealth={printerHealth}
            knownHmsErrors={knownHmsErrors}
            maintenanceInfo={maintenanceInfo}
            requirePlateClear={requirePlateClear}
            needsPlateClear={needsPlateClear}
            firmwareInfo={firmwareInfo}
            hasDoorSensor={hasDoorSensor}
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
            <ListHealthStatusMenu
              status={status}
              printerHealth={printerHealth}
              knownHmsErrors={knownHmsErrors}
              maintenanceInfo={maintenanceInfo}
              requirePlateClear={requirePlateClear}
              needsPlateClear={needsPlateClear}
              firmwareInfo={firmwareInfo}
              hasDoorSensor={hasDoorSensor}
            />
            <span className={`truncate text-sm font-medium ${status ? 'text-white' : 'text-bambu-gray'}`}>{printerHealth.label}</span>
          </span>
        </div>
        <div className="truncate text-bambu-gray">{location}</div>
        <div className="min-w-0">
          <div className="truncate text-white">{activePrintName || jobStatusLabel}</div>
          <div className="mt-1 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bambu-dark-tertiary">
              <div className="h-full rounded-full bg-bambu-green transition-all" style={{ width: `${isPrintingOrPaused ? progress : 0}%` }} />
            </div>
            <span className="w-9 shrink-0 text-right text-xs tabular-nums text-bambu-gray">{isPrintingOrPaused ? `${Math.round(progress)}%` : '---'}</span>
          </div>
        </div>
        <div className="min-w-0 text-right">
          <div className="truncate text-white">{etaLabel}</div>
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
    <div className={`rounded-xl border border-white/5 bg-bambu-dark/70 shadow-sm ${compact ? 'min-w-0 p-2' : 'p-3'} ${className}`}>
      <div className={`flex items-center font-medium uppercase tracking-wide text-bambu-gray ${compact ? 'gap-1 text-[9px]' : 'gap-2 text-xs'}`}>
        <Icon className={`${compact ? 'h-3 w-3' : 'h-4 w-4'} shrink-0 text-bambu-green`} />
        <span className="truncate">{label}</span>
      </div>
      <div className={`${compact ? 'mt-1 text-base' : 'mt-2 text-2xl'} truncate font-semibold tabular-nums text-white`}>{value}</div>
      {detail && <div className={`mt-1 truncate text-bambu-gray ${compact ? 'text-[9px]' : 'text-xs'}`}>{detail}</div>}
    </div>
  );
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
}) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [statusControlMenu, setStatusControlMenu] = useState<string | null>(null);
  const [jogStep, setJogStep] = useState(10);
  const [showUploadForPrint, setShowUploadForPrint] = useState(false);
  const [printAfterUpload, setPrintAfterUpload] = useState<{ id: number; filename: string } | null>(null);
  const [reprintEntry, setReprintEntry] = useState<PrintLogEntry | null>(null);
  const [isCheckingPlate, setIsCheckingPlate] = useState(false);
  const [showHealthStatusMenu, setShowHealthStatusMenu] = useState(false);
  const [showSkipObjectsModal, setShowSkipObjectsModal] = useState(false);
  const [amsBackupModalOpen, setAmsBackupModalOpen] = useState(false);
  const [showNotHomedModal, setShowNotHomedModal] = useState<null | { distance: number }>(null);
  const [loadedCameraPrinterId, setLoadedCameraPrinterId] = useState<number | null>(null);
  const [failedCameraPrinterId, setFailedCameraPrinterId] = useState<number | null>(null);
  const cameraImageRef = useRef<HTMLImageElement>(null);
  const [configureSlotModal, setConfigureSlotModal] = useState<{
    amsId: number;
    trayId: number;
    trayCount: number;
    trayType?: string;
    trayColor?: string;
    traySubBrands?: string;
    trayInfoIdx?: string;
    caliIdx?: number | null;
  } | null>(null);

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

  const invalidateStatus = () => queryClient.invalidateQueries({ queryKey: ['printerStatus', printer.id] });
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
  const nozzleTemperatureMutation = useMutation({
    mutationFn: ({ target, nozzle }: { target: number; nozzle: number }) => api.setNozzleTemperature(printer.id, target, nozzle),
    onSuccess: (result) => {
      setStatusControlMenu(null);
      showToast(result.message || t('printers.single.nozzleTemperatureSet'));
      invalidateStatus();
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });
  const bedTemperatureMutation = useMutation({
    mutationFn: (target: number) => api.setBedTemperature(printer.id, target),
    onSuccess: (result) => {
      setStatusControlMenu(null);
      showToast(result.message || t('printers.single.bedTemperatureSet'));
      invalidateStatus();
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });
  const chamberTemperatureMutation = useMutation({
    mutationFn: (target: number) => api.setChamberTemperature(printer.id, target),
    onSuccess: (result) => {
      setStatusControlMenu(null);
      showToast(result.message || t('printers.single.chamberTemperatureSet'));
      invalidateStatus();
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });
  const fanSpeedMutation = useMutation({
    mutationFn: ({ fan, speed }: { fan: 'part' | 'aux' | 'chamber'; speed: number }) => api.setFanSpeed(printer.id, fan, speed),
    onSuccess: (result) => {
      setStatusControlMenu(null);
      showToast(result.message || t('printers.single.fanSpeedSet'));
      invalidateStatus();
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
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
  const healthStatusRowClass = 'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium';
  const maintenanceDueCount = maintenanceInfo?.due_count ?? 0;
  const maintenanceWarningCount = maintenanceInfo?.warning_count ?? 0;
  const healthPlateLabel = isPrintingOrPaused
    ? t('printers.plateStatus.inUse')
    : needsPlateClear
      ? t('printers.plateStatus.notCleared')
      : t('printers.plateStatus.cleared');
  const networkHealthClass = !status?.connected
    ? 'bg-status-error/20 text-status-error'
    : status.wired_network || status.wifi_signal == null || status.wifi_signal >= -60
      ? 'bg-status-ok/20 text-status-ok'
      : status.wifi_signal >= -80
        ? 'bg-status-warning/20 text-status-warning'
        : 'bg-status-error/20 text-status-error';

  const activePrintName = status?.current_print && isPrintingOrPaused
    ? formatPrintName(status.subtask_name || status.current_print || null, status.gcode_file, t)
    : null;
  const temp = status?.temperatures;
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
    let energyKwh = 0;

    printEntries.forEach(entry => {
      durationSeconds += entry.duration_seconds ?? 0;
      if (entry.status === 'completed' && entry.duration_seconds != null && entry.duration_seconds > 0) {
        completedDurationSeconds += entry.duration_seconds;
        completedDurationCount += 1;
      }
      filamentGrams += entry.filament_used_grams ?? 0;
      totalCost += entry.cost ?? 0;
      energyKwh += entry.energy_kwh ?? 0;
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
      energyKwh,
      topFilament,
    };
  }, [printEntries]);

  const issueItems = [
    knownHmsErrors.length > 0 ? t('printers.status.errorCount', '{{count}} active', { count: knownHmsErrors.length }) : null,
    needsPlateClear ? t('printers.plateStatus.notCleared') : null,
    (maintenanceInfo?.due_count ?? 0) > 0 ? t('maintenance.dueCount', { count: maintenanceInfo?.due_count ?? 0 }) : null,
    (maintenanceInfo?.warning_count ?? 0) > 0 ? t('maintenance.warningCount', { count: maintenanceInfo?.warning_count ?? 0 }) : null,
    firmwareInfo?.update_available ? t('firmware.updateAvailable', 'Firmware update available') : null,
  ].filter((item): item is string => Boolean(item));

  const recentPrints = printEntries.slice(0, 4);
  const reprintableRecentPrints = recentPrints.filter(entry => entry.archive_id != null).slice(0, 3);
  const controlBusy = stopPrintMutation.isPending || pausePrintMutation.isPending || resumePrintMutation.isPending;
  const canControl = !!status?.connected && hasPermission('printers:control');
  const canUseMachineTools = !!status?.connected && canControl;
  const canJog = canUseMachineTools && !isPrintingOrPaused;
  const isAirductCapable = ['P2S', 'X2D', 'H2D', 'H2D Pro', 'H2C', 'H2S'].includes(printer.model ?? '');
  const nozzleHeating = temp?.nozzle_heating || temp?.nozzle_2_heating || false;
  const bedHeating = temp?.bed_heating || false;
  const chamberHeating = temp?.chamber_heating || false;
  const hasChamberHeater = status?.supports_chamber_heater === true;
  const fanItems = [
    { key: 'part' as const, label: t('printers.fans.partCooling'), value: status?.cooling_fan_speed ?? 0, Icon: Fan, activeClass: 'text-cyan-400' },
    { key: 'aux' as const, label: t('printers.fans.auxiliary'), value: status?.big_fan1_speed ?? 0, Icon: Wind, activeClass: 'text-blue-400' },
    { key: 'chamber' as const, label: t('printers.fans.chamber'), value: status?.big_fan2_speed ?? 0, Icon: AirVent, activeClass: 'text-green-400' },
  ];
  const speedModes = [
    { mode: 1, label: t('printers.speed.silent', 'Silent') },
    { mode: 2, label: t('printers.speed.standard', 'Standard') },
    { mode: 3, label: t('printers.speed.sport', 'Sport') },
    { mode: 4, label: t('printers.speed.ludicrous', 'Ludicrous') },
  ];
  const statusControlClass = `relative min-h-[3.25rem] flex-1 rounded-lg bg-bambu-dark px-2 py-1.5 text-center flex flex-col justify-center items-center transition-colors ${
    canUseMachineTools ? 'cursor-pointer hover:bg-bambu-dark-tertiary' : 'cursor-default opacity-80'
  }`;
  const iconControlClass = 'relative inline-flex h-9 min-w-0 items-center justify-center gap-2 rounded-lg px-3 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';
  const jogButtonClass = 'flex h-7 w-7 shrink-0 items-center justify-center rounded bg-indigo-500/15 text-indigo-300 transition-colors hover:bg-indigo-500/30 disabled:cursor-not-allowed disabled:opacity-50';
  const currentPrintLabel = activePrintName || t('printers.noActiveJob', 'No active job');
  const plateDetectionEnabled = plateDetectionMutation.isPending && plateDetectionMutation.variables != null
    ? plateDetectionMutation.variables
    : printer.plate_detection_enabled;
  const handleOpenPlateCheck = async () => {
    setIsCheckingPlate(true);
    try {
      const result = await api.checkPlateEmpty(printer.id, { includeDebugImage: false });
      showToast(result.is_empty ? t('printers.plateDetection.plateEmpty') : t('printers.plateDetection.objectsDetected'), result.is_empty ? 'success' : 'warning');
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('printers.toast.failedToCheckPlate'), 'error');
    } finally {
      setIsCheckingPlate(false);
    }
  };
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
    <div className="mt-3 min-h-0">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-bambu-gray">{t('printers.single.jog')}</span>
        <div className="h-[2px] flex-1 bg-bambu-dark-tertiary" />
      </div>
      <div className="flex items-start justify-center gap-3 rounded-lg bg-bambu-dark/70 px-3 py-2">
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
    const fillLevel = tray?.tray_type && tray.remain >= 0 ? tray.remain : null;
    return (
      <button
        key={trayId}
        type="button"
        onClick={() => setConfigureSlotModal({
          amsId,
          trayId,
          trayCount,
          trayType: tray?.tray_type || undefined,
          trayColor: tray?.tray_color || undefined,
          traySubBrands: tray?.tray_sub_brands || undefined,
          trayInfoIdx: tray?.tray_info_idx || undefined,
          caliIdx: tray?.cali_idx,
        })}
        disabled={!hasPermission('printers:control')}
        className={`min-w-14 rounded-lg bg-bambu-dark-secondary p-1 text-center transition-colors hover:bg-bambu-dark-tertiary disabled:cursor-not-allowed disabled:opacity-60 ${isEmpty ? 'opacity-60' : ''}`}
        title={!hasPermission('printers:control') ? t('printers.permission.noControl') : t('ams.configureSlot', 'Configure slot')}
      >
        <FilamentSlotCircle trayColor={tray?.tray_color} trayType={tray?.tray_type} isEmpty={isEmpty} emptyKind={emptyKind} slotNumber={trayId + 1} />
        <div className="truncate text-[9px] font-bold text-white">{tray?.tray_type || t(emptyKind === 'reset' ? 'ams.slotUnconfigured' : 'ams.slotEmpty')}</div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-black/30">
          {fillLevel != null && !isEmpty && <div className="h-full rounded-full" style={{ width: `${fillLevel}%`, backgroundColor: getFillBarColor(fillLevel) }} />}
        </div>
      </button>
    );
  };

  const filamentPanel = ((status?.ams?.length ?? 0) > 0 || (status?.vt_tray?.length ?? 0) > 0) ? (
    <section data-testid="cockpit-filament-pane" className="flex min-h-0 flex-col rounded-xl border border-white/10 bg-bambu-dark/80 p-3">
      <div className="mb-2 flex shrink-0 items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-bambu-gray">{t('printers.filaments')}</span>
        <AmsBackupBadge
          state={status?.ams_filament_backup ?? null}
          onClick={() => setAmsBackupModalOpen(true)}
        />
        <div className="h-[2px] flex-1 bg-bambu-dark-tertiary" />
      </div>
      <div data-testid="cockpit-filament-scroll" className="flex min-h-0 min-w-0 gap-2 overflow-auto pb-1">
        {status?.ams?.map((ams) => (
          <div key={ams.id} className="min-w-[15rem] flex-1 rounded-lg bg-bambu-dark p-2">
            <div data-testid={`cockpit-ams-header-${ams.id}`} className="mb-1.5 flex min-h-7 w-full items-center justify-between gap-2 rounded-lg bg-bambu-dark-secondary px-2 py-1">
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="truncate text-[10px] font-medium text-white">{getAmsLabel(ams.id, ams.tray.length)}</span>
              </div>
              <div data-testid={`cockpit-ams-indicators-${ams.id}`} className="flex shrink-0 items-center gap-1.5">
                {ams.humidity != null && <HumidityIndicator humidity={ams.humidity} compact />}
                {ams.temp != null && (
                  <div className="mr-1">
                    <TemperatureIndicator temp={ams.temp} compact />
                  </div>
                )}
                <AmsDryingButton
                  ams={ams}
                  supportsDrying={status?.supports_drying === true}
                  canControl={hasPermission('printers:control')}
                  controller={dryingControls}
                />
              </div>
            </div>
            {ams.dry_time > 0 && <div className="mb-1.5"><AmsDryingStatus ams={ams} controller={dryingControls} /></div>}
            <div className={`grid gap-1 ${ams.tray.length === 1 ? 'grid-cols-1' : 'grid-cols-4'}`}>
              {Array.from({ length: ams.tray.length === 1 ? 1 : 4 }, (_, slotIdx) => renderCockpitFilamentSlot(ams.tray[slotIdx] || ams.tray.find((candidate) => candidate.id === slotIdx), ams.id, slotIdx, ams.tray.length))}
            </div>
          </div>
        ))}
        {(status?.vt_tray?.length ?? 0) > 0 && (
          <div className="min-w-24 rounded-lg bg-bambu-dark p-2">
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

  return (
    <>
    <div className="relative h-full min-h-0 overflow-hidden rounded-xl border border-bambu-dark-tertiary bg-gradient-to-br from-bambu-dark-secondary via-bambu-dark to-bambu-dark-secondary shadow-xl">
      <div className="relative grid h-full min-h-0 gap-3 p-3 xl:grid-cols-[minmax(0,1.45fr)_minmax(21rem,0.8fr)]">
        <div className="grid min-h-0 gap-3 xl:grid-rows-[auto_minmax(0,1fr)]">
          <section className="relative aspect-video w-full min-h-0 overflow-hidden rounded-xl border border-white/10 bg-bambu-dark">
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
            <div className="relative flex h-full min-h-0 flex-col gap-3 p-4">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-3">
                  <h2 className="min-w-0 flex-1 truncate text-3xl font-semibold leading-none text-white">{printer.name}</h2>
                  <div className="relative shrink-0">
                    <button
                      type="button"
                      onClick={() => setShowHealthStatusMenu((open) => !open)}
                      className={`inline-flex h-9 w-9 items-center justify-center rounded-lg transition-opacity hover:opacity-80 ${printerHealth.className}`}
                      title={t('printers.health.title', 'Machine health: {{status}}', { status: printerHealth.label })}
                      aria-label={t('printers.health.title', 'Machine health: {{status}}', { status: printerHealth.label })}
                    >
                      <Activity className="h-4 w-4" />
                    </button>
                    {showHealthStatusMenu && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setShowHealthStatusMenu(false)} />
                        <div className="absolute right-0 top-full z-50 mt-1 flex w-[240px] flex-col overflow-hidden rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-2xl">
                          <div className="shrink-0 px-3 py-2.5 text-center text-sm font-medium text-white">{t('printers.health.statusDetails')}</div>
                          <div className="h-px bg-bambu-dark-tertiary" />
                          <div className="space-y-1.5 p-2.5">
                            <div className={`${healthStatusRowClass} ${status?.connected ? 'bg-status-ok/20 text-status-ok' : 'bg-status-error/20 text-status-error'}`}>
                              {status?.connected ? <Link className="h-3 w-3" /> : <Unlink className="h-3 w-3" />}
                              <span>{t('printers.status.connection', 'Connection')}:</span>
                              <span>{status?.connected ? t('printers.connection.connected') : t('printers.connection.offline')}</span>
                            </div>
                            {requirePlateClear && status?.connected && (
                              <div className={`${healthStatusRowClass} ${needsPlateClear ? 'bg-status-warning/20 text-status-warning' : 'bg-status-ok/20 text-status-ok'}`}>
                                <PlateClearedIcon className="h-3 w-3" />
                                <span>{t('printers.plateStatus.title', 'Plate')}:</span>
                                <span>{healthPlateLabel}</span>
                              </div>
                            )}
                            <div className={`${healthStatusRowClass} ${networkHealthClass}`}>
                              {status?.wired_network ? <Cable className="h-3 w-3" /> : <Signal className="h-3 w-3" />}
                              <span>{t('printers.status.network', 'Network')}:</span>
                              <span>{!status?.connected ? t('printers.connection.offline') : status.wired_network ? t('printers.connection.ethernet', 'Ethernet') : status.wifi_signal != null ? `${status.wifi_signal}dBm` : t('common.unknown', 'Unknown')}</span>
                            </div>
                            <div className={`${healthStatusRowClass} ${!status?.connected ? 'bg-status-error/20 text-status-error' : knownHmsErrors.length > 0 ? knownHmsErrors.some((error) => error.severity <= 2) ? 'bg-status-error/20 text-status-error' : 'bg-status-warning/20 text-status-warning' : 'bg-status-ok/20 text-status-ok'}`}>
                              <AlertTriangle className="h-3 w-3" />
                              <span>{t('printers.status.errors', 'Errors')}:</span>
                              <span>{status?.connected ? knownHmsErrors.length > 0 ? t('printers.status.errorCount', '{{count}} active', { count: knownHmsErrors.length }) : t('common.ok', 'OK') : t('common.unknown', 'Unknown')}</span>
                            </div>
                            <div className={`${healthStatusRowClass} ${maintenanceDueCount > 0 ? 'bg-status-error/20 text-status-error' : maintenanceWarningCount > 0 ? 'bg-status-warning/20 text-status-warning' : 'bg-status-ok/20 text-status-ok'}`}>
                              <Wrench className="h-3 w-3" />
                              <span>{t('maintenance.title', 'Maintenance')}:</span>
                              <span>{maintenanceDueCount > 0 ? t('maintenance.dueCount', { count: maintenanceDueCount }) : maintenanceWarningCount > 0 ? t('maintenance.warningCount', { count: maintenanceWarningCount }) : t('common.ok', 'OK')}</span>
                            </div>
                            {(firmwareInfo?.current_version || status?.firmware_version) && (
                              <div className={`${healthStatusRowClass} ${firmwareInfo?.update_available ? 'bg-status-warning/20 text-status-warning' : 'bg-status-ok/20 text-status-ok'}`}>
                                {firmwareInfo?.update_available ? <Download className="h-3 w-3" /> : <CheckCircle className="h-3 w-3" />}
                                <span>{t('printers.status.firmware', 'Firmware')}:</span>
                                <span>{firmwareInfo?.update_available ? t('printers.status.updateAvailable', 'Update available') : firmwareInfo?.current_version || status?.firmware_version}</span>
                              </div>
                            )}
                            {status?.connected && hasDoorSensor && (
                              <div className={`${healthStatusRowClass} ${status.door_open ? 'bg-status-warning/20 text-status-warning' : 'bg-status-ok/20 text-status-ok'}`}>
                                {status.door_open ? <DoorOpen className="h-3 w-3" /> : <DoorClosed className="h-3 w-3" />}
                                <span>{t('printers.status.door', 'Door')}:</span>
                                <span>{status.door_open ? t('printers.door.open') : t('printers.door.closed')}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>
                <p className="truncate pl-0.5 text-base leading-tight text-bambu-gray">
                  {printer.model || t('common.unknown', 'Unknown')}
                  {printer.location ? ` - ${printer.location}` : ''}
                </p>
              </div>

              <div className="min-h-0 flex-1" />

              <div className="min-w-0">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="min-w-0 flex-1 truncate text-xl font-semibold text-white">{currentPrintLabel}</p>
                  <span className="shrink-0 text-3xl font-semibold tabular-nums text-white">
                    {isPrintingOrPaused ? `${Math.round(progress)}%` : '---'}
                  </span>
                </div>
                <div className="h-3 overflow-hidden rounded-full bg-bambu-dark-tertiary">
                  <div className="h-full rounded-full bg-gradient-to-r from-bambu-green to-emerald-300 transition-all" style={{ width: `${isPrintingOrPaused ? progress : 0}%` }} />
                </div>
              </div>
            </div>
          </section>

          {filamentPanel}
        </div>

        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3">
          <section className="rounded-xl border border-white/10 bg-bambu-dark/80 p-3">
            {showClearPlateButton ? (
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
                  onClick={() => stopPrintMutation.mutate()}
                  disabled={!canControl || controlBusy}
                  className="flex h-10 items-center justify-center gap-2 rounded-lg bg-red-500/20 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/30 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Square className="h-4 w-4" />
                  {t('printers.stop')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowUploadForPrint(true)}
                disabled={!hasPermission('queue:create')}
                className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-bambu-green px-3 text-sm font-medium text-white transition-colors hover:bg-bambu-green-light disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Play className="h-4 w-4" />
                {t('printers.startPrint', 'Start print')}
              </button>
            )}
          </section>

          <section data-testid="cockpit-status-pane" className="relative min-h-0 overflow-y-auto overscroll-contain rounded-xl border border-white/10 bg-bambu-dark/80 p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[10px] font-medium uppercase tracking-wider text-bambu-gray">
                {t('printers.status.title', 'Status')}
              </span>
              <div className="h-[2px] flex-1 bg-bambu-dark-tertiary" />
            </div>

            <div className="flex items-stretch gap-1.5">
              <button
                type="button"
                className={statusControlClass}
                onClick={() => canUseMachineTools && setStatusControlMenu(statusControlMenu === 'nozzle-temp' ? null : 'nozzle-temp')}
                disabled={!canUseMachineTools}
                title={!canUseMachineTools ? t('printers.permission.noControl') : undefined}
              >
                <HeaterThermometer className="mb-0.5 h-4 w-4" color="text-orange-400" isHeating={nozzleHeating} />
                <p className="text-[9px] text-bambu-gray">{t('printers.temperatures.nozzle')}</p>
                <p className="text-xs text-white">{temp?.nozzle != null ? `${Math.round(temp.nozzle)}°C` : '---'}</p>
                {temp?.nozzle_target != null && temp.nozzle_target > 0 && (
                  <p className="text-[9px] text-bambu-gray">/{Math.round(temp.nozzle_target)}°C</p>
                )}
                {statusControlMenu === 'nozzle-temp' && (
                  <IndicatorControlPopover
                    title={t('printers.single.setNozzleTemperature')}
                    unit="°C"
                    customMin={0}
                    customMax={320}
                    isPending={nozzleTemperatureMutation.isPending}
                    options={buildPresetOptions(nozzleTempPresets, 'C')}
                    onClose={() => setStatusControlMenu(null)}
                    onSubmit={(target) => nozzleTemperatureMutation.mutate({ target, nozzle: status?.active_extruder ?? 0 })}
                  />
                )}
              </button>
              <button
                type="button"
                className={statusControlClass}
                onClick={() => canUseMachineTools && setStatusControlMenu(statusControlMenu === 'bed-temp' ? null : 'bed-temp')}
                disabled={!canUseMachineTools}
                title={!canUseMachineTools ? t('printers.permission.noControl') : undefined}
              >
                <HeaterThermometer className="mb-0.5 h-4 w-4" color="text-blue-400" isHeating={bedHeating} />
                <p className="text-[9px] text-bambu-gray">{t('printers.temperatures.bed')}</p>
                <p className="text-xs text-white">{temp?.bed != null ? `${Math.round(temp.bed)}°C` : '---'}</p>
                {temp?.bed_target != null && temp.bed_target > 0 && (
                  <p className="text-[9px] text-bambu-gray">/{Math.round(temp.bed_target)}°C</p>
                )}
                {statusControlMenu === 'bed-temp' && (
                  <IndicatorControlPopover
                    title={t('printers.single.setBedTemperature')}
                    unit="°C"
                    customMin={0}
                    customMax={140}
                    isPending={bedTemperatureMutation.isPending}
                    options={buildPresetOptions(bedTempPresets, 'C')}
                    onClose={() => setStatusControlMenu(null)}
                    onSubmit={(target) => bedTemperatureMutation.mutate(target)}
                  />
                )}
              </button>
              <button
                type="button"
                className={hasChamberHeater ? statusControlClass : 'flex min-h-[3.25rem] flex-1 flex-col items-center justify-center rounded-lg bg-bambu-dark px-2 py-1.5 text-center'}
                onClick={() => hasChamberHeater && canUseMachineTools && setStatusControlMenu(statusControlMenu === 'chamber-temp' ? null : 'chamber-temp')}
                disabled={!hasChamberHeater || !canUseMachineTools}
                title={hasChamberHeater && !canUseMachineTools ? t('printers.permission.noControl') : undefined}
              >
                <HeaterThermometer className="mb-0.5 h-4 w-4" color="text-green-400" isHeating={chamberHeating} />
                <p className="text-[9px] text-bambu-gray">{t('printers.temperatures.chamber')}</p>
                <p className="text-xs text-white">{temp?.chamber != null ? `${Math.round(temp.chamber)}°C` : '---'}</p>
                {temp?.chamber_target != null && temp.chamber_target > 0 && (
                  <p className="text-[9px] text-bambu-gray">/{Math.round(temp.chamber_target)}°C</p>
                )}
                {hasChamberHeater && statusControlMenu === 'chamber-temp' && (
                  <IndicatorControlPopover
                    title={t('printers.single.setChamberTemperature')}
                    unit="°C"
                    customMin={0}
                    customMax={60}
                    isPending={chamberTemperatureMutation.isPending}
                    options={buildPresetOptions(chamberTempPresets, 'C')}
                    onClose={() => setStatusControlMenu(null)}
                    onSubmit={(target) => chamberTemperatureMutation.mutate(target)}
                  />
                )}
              </button>
            </div>

            <div className="mt-2 flex items-center gap-1.5">
              {fanItems.map(({ key, label, value, Icon, activeClass }) => (
                <button
                  key={key}
                  type="button"
                  className={`relative flex min-w-0 flex-1 items-center justify-center gap-1 rounded-lg bg-bambu-dark px-2 py-1.5 transition-colors ${
                    value > 0 ? 'text-white hover:bg-bambu-dark-tertiary' : 'text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white'
                  } disabled:cursor-not-allowed disabled:opacity-50`}
                  onClick={() => canUseMachineTools && setStatusControlMenu(statusControlMenu === `fan-${key}` ? null : `fan-${key}`)}
                  disabled={!canUseMachineTools}
                  title={`${label}: ${value}%`}
                >
                  <Icon className={`h-3.5 w-3.5 shrink-0 ${value > 0 ? activeClass : 'text-bambu-gray/70'}`} />
                  <span className={`text-[10px] leading-none ${value > 0 ? 'text-white' : 'text-bambu-gray'}`}>
                    {value}%
                  </span>
                  {statusControlMenu === `fan-${key}` && (
                    <IndicatorControlPopover
                      title={t('printers.single.setFanSpeed', { fan: label })}
                      unit="%"
                      customMin={0}
                      customMax={100}
                      isPending={fanSpeedMutation.isPending}
                      options={buildPresetOptions(fanSpeedPresets, '%')}
                      onClose={() => setStatusControlMenu(null)}
                      onSubmit={(speed) => fanSpeedMutation.mutate({ fan: key, speed })}
                    />
                  )}
                </button>
              ))}
            </div>

            {issueItems.length > 0 && (
              <div className="mt-2 space-y-1.5 text-xs text-status-warning">
                {issueItems.map(item => <div key={item} className="truncate">{item}</div>)}
              </div>
            )}
            <div className="mt-3 flex items-center gap-2">
              <span className="text-[10px] font-medium uppercase tracking-wider text-bambu-gray">
                {t('printers.controls')}
              </span>
              <div className="h-[2px] flex-1 bg-bambu-dark-tertiary" />
            </div>

            <div className="mt-2 grid min-h-0 gap-2 overflow-hidden">
              <div className="grid grid-cols-2 items-center gap-2">
                <button
                  type="button"
                  className={`${iconControlClass} w-full ${
                    status?.chamber_light
                      ? 'bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20'
                      : 'bg-bambu-dark-tertiary/70 text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white'
                  }`}
                  onClick={() => chamberLightMutation.mutate(!status?.chamber_light)}
                  disabled={!canUseMachineTools || chamberLightMutation.isPending}
                  title={status?.chamber_light ? t('printers.chamberLightOff') : t('printers.chamberLightOn')}
                >
                  <ChamberLight on={!!status?.chamber_light} className="h-5 w-5" />
                  <span className="min-w-0 truncate">{t('printers.chamberLight', 'Chamber Light')}</span>
                </button>
                <div className={`grid min-w-0 grid-cols-2 rounded-lg ${plateDetectionEnabled ? 'ring-1 ring-green-500' : ''}`}>
                  <button
                    type="button"
                    onClick={() => plateDetectionMutation.mutate(!plateDetectionEnabled)}
                    disabled={!status?.connected || plateDetectionMutation.isPending || !hasPermission('printers:update')}
                    className={`${iconControlClass} w-full rounded-r-none ${
                      plateDetectionEnabled
                        ? 'bg-green-500/10 text-green-400 hover:bg-green-500/20'
                        : 'bg-bambu-dark-tertiary/70 text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white'
                    }`}
                    title={!hasPermission('printers:update') ? t('printers.plateDetection.noPermission') : (plateDetectionEnabled ? t('printers.plateDetection.enabledClick') : t('printers.plateDetection.disabledClick'))}
                  >
                    {plateDetectionMutation.isPending ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      <ScanSearch className="h-5 w-5" />
                    )}
                    <span className="min-w-0 truncate">{t('printers.plateStatus.title', 'Plate')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleOpenPlateCheck}
                    disabled={!status?.connected || isCheckingPlate || !hasPermission('printers:update')}
                    className={`${iconControlClass} w-full rounded-l-none border-l border-bambu-dark-tertiary ${
                      plateDetectionEnabled
                        ? 'bg-green-500/10 text-green-400 hover:bg-green-500/20'
                        : 'bg-bambu-dark-tertiary/70 text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white'
                    }`}
                    title={!hasPermission('printers:update') ? t('printers.plateDetection.noPermission') : t('printers.plateDetection.manageCalibration')}
                  >
                    {isCheckingPlate ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      <ChevronDown className="h-5 w-5" />
                    )}
                    <span className="min-w-0 truncate">{t('printers.plateDetection.check', 'Check')}</span>
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => canControl && isPrintingOrPaused && setStatusControlMenu(statusControlMenu === 'speed' ? null : 'speed')}
                  disabled={!isPrintingOrPaused || !canControl || printSpeedMutation.isPending}
                  className={`${iconControlClass} w-full ${
                    isPrintingOrPaused && canControl
                      ? 'bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'
                      : 'bg-bambu-dark-tertiary/70 text-bambu-gray disabled:opacity-60'
                  }`}
                  title={t('printers.speed.title')}
                >
                  <Gauge className="h-5 w-5" />
                  <span className="min-w-0 truncate">{t('printers.speed.title')}</span>
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
                  className={`${iconControlClass} w-full ${
                    isPrintingOrPaused && (status?.printable_objects_count ?? 0) >= 2 && canControl
                      ? 'bg-bambu-dark-tertiary/70 text-white hover:bg-bambu-dark-tertiary'
                      : 'bg-bambu-dark-tertiary/70 text-bambu-gray disabled:opacity-60'
                  }`}
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
                  <SkipObjectsIcon className="h-5 w-5" />
                  <span className="min-w-0 truncate">{t('printers.skipObjects.title')}</span>
                  {objectsData && objectsData.skipped_count > 0 && (
                    <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                      {objectsData.skipped_count}
                    </span>
                  )}
                </button>
                {isAirductCapable && (
                  <button
                    type="button"
                    onClick={() => airductMutation.mutate(status?.airduct_mode === 1 ? 'cooling' : 'heating')}
                    disabled={!canUseMachineTools || airductMutation.isPending}
                    className={`${iconControlClass} w-full ${status?.airduct_mode === 1 ? 'bg-orange-500/10 text-orange-400 hover:bg-orange-500/20' : 'bg-sky-500/10 text-sky-400 hover:bg-sky-500/20'}`}
                    title={t('printers.airduct.title')}
                  >
                    {status?.airduct_mode === 1 ? <Flame className="h-5 w-5" /> : <Snowflake className="h-5 w-5" />}
                    <span className="min-w-0 truncate">
                      {status?.airduct_mode === 1 ? t('printers.airduct.heating') : t('printers.airduct.cooling')}
                    </span>
                  </button>
                )}
              </div>

            </div>
            <PrinterPowerControls key={printer.id} printer={printer} isPrintingOrPaused={isPrintingOrPaused} className="mt-3" />
            {jogPanel}
            <div className="mb-2 mt-3 flex items-center gap-2">
              <span className="text-[10px] font-medium uppercase tracking-wider text-bambu-gray">
                {t('stats.title')}
              </span>
              <div className="h-[2px] flex-1 bg-bambu-dark-tertiary" />
            </div>
            <div className="grid min-h-0 grid-cols-3 gap-1.5">
              <CockpitMetricCard compact icon={BarChart3} label={t('stats.successRate', 'Success rate')} value={`${printerStats.successRate}%`} detail={`${printerStats.completed} / ${printerStats.failed} / ${printerStats.cancelled}`} />
              <CockpitMetricCard compact icon={Package} label={t('stats.totalPrints', 'Total prints')} value={`${printLog?.total ?? printEntries.length}`} detail={t('stats.topFilament', 'Top filament: {{filament}}', { filament: printerStats.topFilament })} />
              <CockpitMetricCard compact icon={Clock} label={t('stats.printTime', 'Print time')} value={`${printerStats.durationHours.toFixed(1)}h`} detail={`${maintenanceInfo?.total_print_hours?.toFixed(1) ?? '0.0'}h ${t('maintenance.title', 'Maintenance')}`} />
              <CockpitMetricCard compact icon={Package} label={t('stats.filamentUsed', 'Filament used')} value={formatCockpitWeight(printerStats.filamentGrams)} detail={`${currencySymbol}${printerStats.totalCost.toFixed(2)} ${t('stats.filamentCost', 'filament cost')}`} />
              <CockpitMetricCard compact icon={Zap} label={t('stats.energyUsed', 'Energy used')} value={`${printerStats.energyKwh.toFixed(2)} kWh`} detail={t('stats.fromPrintHistory', 'From print history')} />
              <CockpitMetricCard compact icon={Timer} label={t('stats.averagePrintTime', 'Average time')} value={printerStats.averageDurationSeconds != null ? formatDuration(Math.round(printerStats.averageDurationSeconds)) : '---'} detail={t('stats.completedPrintAverage', 'Completed prints')} />
            </div>
          </section>
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
    {configureSlotModal && (
      <ConfigureAmsSlotModal
        isOpen
        onClose={() => setConfigureSlotModal(null)}
        printerId={printer.id}
        slotInfo={configureSlotModal}
        printerModel={mapModelCode(printer.model) || undefined}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: ['slotPresets', printer.id] });
          queryClient.invalidateQueries({ queryKey: ['printerStatus', printer.id] });
        }}
      />
    )}
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
    <AmsDryingPopover controller={dryingControls} />
    </>
  );
}

// ─── AMS Name Hover Card ──────────────────────────────────────────────────────
// Wraps the AMS label (e.g. "AMS-A") and shows a popup with:
//  • User-defined friendly name (editable, protected by printers:update)
//  • AMS serial number
//  • AMS firmware version
export function AmsNameHoverCard({
  ams,
  printerId,
  label,
  amsLabels,
  canEdit,
  onSaved,
  children,
}: {
  ams: import('../api/client').AMSUnit;
  printerId: number;
  label: string;           // auto-generated label, e.g. "AMS-A"
  amsLabels?: Record<number, string>;
  canEdit: boolean;
  onSaved: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState<'top' | 'bottom'>('top');
  const [editValue, setEditValue] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isVisible) {
      setEditValue(amsLabels?.[ams.id] ?? '');
      setSaveError(null);
      requestAnimationFrame(() => {
        if (triggerRef.current && cardRef.current) {
          const rect = triggerRef.current.getBoundingClientRect();
          const spaceAbove = rect.top - 56;
          const spaceBelow = window.innerHeight - rect.bottom;
          setPosition(spaceAbove < cardRef.current.offsetHeight + 12 && spaceBelow > spaceAbove ? 'bottom' : 'top');
        }
      });
    }
  }, [isVisible, amsLabels, ams.id]);

  const handleMouseEnter = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setIsVisible(true), 80);
  };
  const handleMouseLeave = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (!isInputFocused) {
      timeoutRef.current = setTimeout(() => setIsVisible(false), 200);
    }
  };
  useEffect(() => () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); }, []);

  const handleSave = async () => {
    if (!canEdit) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      const trimmed = editValue.trim();
      if (trimmed) {
        await api.saveAmsLabel(printerId, ams.id, trimmed, ams.serial_number);
      } else {
        await api.deleteAmsLabel(printerId, ams.id, ams.serial_number);
      }
      onSaved();
      setIsVisible(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  };

  const handleClear = async () => {
    if (!canEdit) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      await api.deleteAmsLabel(printerId, ams.id, ams.serial_number);
      onSaved();
      setIsVisible(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      ref={triggerRef}
      className="relative inline-block"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}

      {isVisible && (
        <div
          ref={cardRef}
          className={`
            absolute left-0 z-50
            ${position === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'}
            animate-in fade-in-0 zoom-in-95 duration-150
          `}
          style={{ maxWidth: 'calc(100vw - 24px)' }}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <div className="w-52 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-xl overflow-hidden backdrop-blur-sm p-2.5 space-y-2">
            {/* AMS auto-label */}
            <div className="text-[10px] uppercase tracking-wider text-bambu-gray font-medium">{label}</div>

            {/* Serial number */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] tracking-wide text-bambu-gray font-medium shrink-0">
                {t('printers.amsPopup.serialNumber')}
              </span>
              <span className="text-[10px] text-white font-mono truncate">{ams.serial_number || '—'}</span>
            </div>

            {/* Firmware version */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] tracking-wide text-bambu-gray font-medium shrink-0">
                {t('printers.amsPopup.firmwareVersion')}
              </span>
              <span className="text-[10px] text-white font-mono truncate">{ams.sw_ver || '—'}</span>
            </div>

            {/* Friendly name editor */}
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-bambu-gray font-medium shrink-0">
                  {t('printers.amsPopup.friendlyName')}
                </span>
                <div className="flex-1 h-[2px] bg-bambu-dark-tertiary/50" />
              </div>
              <input
                type="text"
                value={editValue}
                onChange={(e) => canEdit && setEditValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                onFocus={() => setIsInputFocused(true)}
                onBlur={() => {
                  setIsInputFocused(false);
                  if (timeoutRef.current) clearTimeout(timeoutRef.current);
                    timeoutRef.current = setTimeout(() => setIsVisible(false), 200);
                }}
                placeholder={canEdit ? t('printers.amsPopup.friendlyNamePlaceholder') : (amsLabels?.[ams.id] || '—')}
                disabled={!canEdit}
                title={!canEdit ? t('printers.amsPopup.noEditPermission') : undefined}
                className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-2 py-1 text-xs text-white placeholder-bambu-gray/60 focus:outline-none focus:border-bambu-green disabled:opacity-50 disabled:cursor-not-allowed"
                maxLength={100}
              />
              {canEdit && (
                <div className="space-y-1">
                  {saveError && (
                    <p className="text-[10px] text-red-400 break-words">{saveError}</p>
                  )}
                  <div className="flex gap-1 justify-end">
                    <button
                      onClick={handleSave}
                      disabled={isSaving}
                      className="px-2 py-0.5 text-[10px] bg-bambu-green text-white rounded hover:bg-bambu-green/80 disabled:opacity-50"
                    >
                      {t('printers.amsPopup.save')}
                    </button>
                    {amsLabels?.[ams.id] && (
                      <button
                        onClick={handleClear}
                        disabled={isSaving}
                        className="px-2 py-0.5 text-[10px] bg-bambu-dark-tertiary text-bambu-gray rounded hover:bg-bambu-dark-tertiary/70 disabled:opacity-50"
                      >
                        {t('printers.amsPopup.clear')}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
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
  const [statusControlMenu, setStatusControlMenu] = useState<string | null>(null);
  const [bedJogStep, setBedJogStep] = useState<number>(10);
  const [showNotHomedModal, setShowNotHomedModal] = useState<null | { distance: number }>(null);
  const [showResumeConfirm, setShowResumeConfirm] = useState(false);
  const [showSkipObjectsModal, setShowSkipObjectsModal] = useState(false);
  const [showUploadForPrint, setShowUploadForPrint] = useState(false);
  const [showPrinterInfo, setShowPrinterInfo] = useState(false);
  const [showDiagnostic, setShowDiagnostic] = useState(false);
  const [showHealthStatusMenu, setShowHealthStatusMenu] = useState(false);
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
  const [heaterHistoryModal, setHeaterHistoryModal] = useState<{
    initialKind: HeaterSensorKind;
    availableKinds: HeaterSensorKind[];
  } | null>(null);
  const [linkSpoolModal, setLinkSpoolModal] = useState<{
    tagUid: string;
    trayUuid: string;
    printerId: number;
    amsId: number;
    trayId: number;
  } | null>(null);
  const [assignSpoolModal, setAssignSpoolModal] = useState<{
    printerId: number;
    amsId: number;
    trayId: number;
    trayInfo: { type: string; color: string; location: string; material?: string; profile?: string };
  } | null>(null);
  const [configureSlotModal, setConfigureSlotModal] = useState<{
    amsId: number;
    trayId: number;
    trayCount: number;
    trayType?: string;
    trayColor?: string;
    traySubBrands?: string;
    trayInfoIdx?: string;
    extruderId?: number;
    caliIdx?: number | null;
    savedPresetId?: string;
  } | null>(null);
  const [showFirmwareModal, setShowFirmwareModal] = useState(false);
  const [plateCheckResult, setPlateCheckResult] = useState<{
    is_empty: boolean;
    confidence: number;
    difference_percent: number;
    message: string;
    debug_image_url?: string;
    needs_calibration: boolean;
    light_warning?: boolean;
    reference_count?: number;
    max_references?: number;
    roi?: { x: number; y: number; w: number; h: number };
  } | null>(null);
  const [isCheckingPlate, setIsCheckingPlate] = useState(false);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [editingRoi, setEditingRoi] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [isSavingRoi, setIsSavingRoi] = useState(false);
  const [plateCheckLightWasOff, setPlateCheckLightWasOff] = useState(false);

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

  // Fetch currently printing queue item to show who started it (Issue #206)
  const { data: printingQueueItems } = useQuery({
    queryKey: ['queue', printer.id, 'printing'],
    queryFn: () => api.getQueue(printer.id, 'printing'),
    enabled: status?.state === 'RUNNING',
  });

  // Fetch reprint user info (for prints started via Reprint, not queue - Issue #206)
  const { data: reprintUser } = useQuery({
    queryKey: ['currentPrintUser', printer.id],
    queryFn: () => api.getCurrentPrintUser(printer.id),
    enabled: status?.state === 'RUNNING',
  });

  // Combine both sources: queue item user takes precedence, then reprint user
  const currentPrintUser = printingQueueItems?.[0]?.created_by_username || reprintUser?.username;

  // Fetch last completed print for this printer
  const { data: lastPrints } = useQuery({
    queryKey: ['archives', printer.id, 'last'],
    queryFn: () => api.getArchives(printer.id, 1, 0),
    enabled: status?.connected && status?.state !== 'RUNNING',
  });
  const lastPrint = lastPrints?.[0];
  const isPrintingOrPaused = status?.state === 'RUNNING' || status?.state === 'PAUSE';
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
  const healthMenuPlateStatusPill = plateStatus ? (
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

  const nozzleTemperatureMutation = useMutation({
    mutationFn: ({ target, nozzle }: { target: number; nozzle: number }) =>
      api.setNozzleTemperature(printer.id, target, nozzle),
    onSuccess: (result) => {
      setStatusControlMenu(null);
      showToast(result.message);
      queryClient.invalidateQueries({ queryKey: ['printerStatus', printer.id] });
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });

  const bedTemperatureMutation = useMutation({
    mutationFn: (target: number) => api.setBedTemperature(printer.id, target),
    onSuccess: (result) => {
      setStatusControlMenu(null);
      showToast(result.message);
      queryClient.invalidateQueries({ queryKey: ['printerStatus', printer.id] });
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });

  const chamberTemperatureMutation = useMutation({
    mutationFn: (target: number) => api.setChamberTemperature(printer.id, target),
    onSuccess: (result) => {
      setStatusControlMenu(null);
      showToast(result.message);
      queryClient.invalidateQueries({ queryKey: ['printerStatus', printer.id] });
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });

  const fanSpeedMutation = useMutation({
    mutationFn: ({ fan, speed }: { fan: 'part' | 'aux' | 'chamber'; speed: number }) =>
      api.setFanSpeed(printer.id, fan, speed),
    onMutate: async ({ fan, speed }) => {
      await queryClient.cancelQueries({ queryKey: ['printerStatus', printer.id] });
      const previousStatus = queryClient.getQueryData(['printerStatus', printer.id]);
      const fanField = {
        part: 'cooling_fan_speed',
        aux: 'big_fan1_speed',
        chamber: 'big_fan2_speed',
      }[fan];
      queryClient.setQueryData(['printerStatus', printer.id], (old: PrinterStatus | undefined) =>
        old ? { ...old, [fanField]: speed } : old
      );
      return { previousStatus };
    },
    onSuccess: (result) => {
      setStatusControlMenu(null);
      showToast(result.message);
      queryClient.invalidateQueries({ queryKey: ['printerStatus', printer.id] });
    },
    onError: (error: Error, _variables, context) => {
      if (context?.previousStatus) {
        queryClient.setQueryData(['printerStatus', printer.id], context.previousStatus);
      }
      showToast(error.message || t('printers.toast.failedToSendCommand'), 'error');
    },
  });

  const selectExtruderMutation = useMutation({
    mutationFn: (extruder: number) => api.selectExtruder(printer.id, extruder),
    onMutate: async (extruder) => {
      await queryClient.cancelQueries({ queryKey: ['printerStatus', printer.id] });
      const previousStatus = queryClient.getQueryData(['printerStatus', printer.id]);
      queryClient.setQueryData(['printerStatus', printer.id], (old: PrinterStatus | undefined) =>
        old ? { ...old, active_extruder: extruder } : old
      );
      return { previousStatus };
    },
    onSuccess: (result) => {
      setStatusControlMenu(null);
      showToast(result.message);
      queryClient.invalidateQueries({ queryKey: ['printerStatus', printer.id] });
    },
    onError: (error: Error, _extruder, context) => {
      if (context?.previousStatus) {
        queryClient.setQueryData(['printerStatus', printer.id], context.previousStatus);
      }
      showToast(error.message || t('printers.toast.failedToSendCommand'), 'error');
    },
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

  // Plate references state
  const [plateReferences, setPlateReferences] = useState<{
    references: Array<{ index: number; label: string; timestamp: string; has_image: boolean; thumbnail_url: string }>;
    max_references: number;
  } | null>(null);
  const [editingRefLabel, setEditingRefLabel] = useState<{ index: number; label: string } | null>(null);

  // Fetch plate references
  const fetchPlateReferences = async () => {
    try {
      const data = await api.getPlateReferences(printer.id);
      setPlateReferences(data);
    } catch {
      // Ignore errors - references will show as empty
    }
  };

  // Toggle plate detection enabled/disabled
  const handleTogglePlateDetection = () => {
    plateDetectionMutation.mutate(!printer.plate_detection_enabled);
  };

  // Open plate detection management modal (for calibration/references)
  const handleOpenPlateManagement = async () => {
    setIsCheckingPlate(true);
    setPlateCheckResult(null);

    // Auto-turn on light if it's off
    const lightWasOff = status?.chamber_light === false;
    setPlateCheckLightWasOff(lightWasOff);
    if (lightWasOff) {
      await api.setChamberLight(printer.id, true);
      // Wait for light to physically turn on and camera to adjust exposure
      // (MQTT command is async, light takes ~1s to turn on, camera needs time to adjust)
      await new Promise(resolve => setTimeout(resolve, 2500));
    }

    try {
      const result = await api.checkPlateEmpty(printer.id, { includeDebugImage: true });
      setPlateCheckResult(result);
      fetchPlateReferences();
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('printers.toast.failedToCheckPlate'), 'error');
      // Restore light if check failed
      if (lightWasOff) {
        await api.setChamberLight(printer.id, false);
        setPlateCheckLightWasOff(false);
      }
    } finally {
      setIsCheckingPlate(false);
    }
  };

  // Close plate check modal and restore light state
  const closePlateCheckModal = useCallback(async () => {
    setPlateCheckResult(null);
    // Restore light to original state if we turned it on
    if (plateCheckLightWasOff) {
      await api.setChamberLight(printer.id, false);
      setPlateCheckLightWasOff(false);
    }
  }, [plateCheckLightWasOff, printer.id]);

  // Calibrate plate detection handler
  const handleCalibratePlate = async (label?: string) => {
    setIsCalibrating(true);
    try {
      const result = await api.calibratePlateDetection(printer.id, { label });
      if (result.success) {
        showToast(result.message || t('printers.toast.calibrationSaved'), 'success');
        // Refresh references and re-check
        fetchPlateReferences();
        const checkResult = await api.checkPlateEmpty(printer.id, { includeDebugImage: true });
        setPlateCheckResult(checkResult);
      } else {
        showToast(result.message || t('printers.toast.calibrationFailed'), 'error');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('printers.toast.calibrationFailed'), 'error');
    } finally {
      setIsCalibrating(false);
    }
  };

  // Update reference label
  const handleUpdateRefLabel = async (index: number, label: string) => {
    try {
      await api.updatePlateReferenceLabel(printer.id, index, label);
      setEditingRefLabel(null);
      fetchPlateReferences();
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('printers.toast.failedToUpdateLabel'), 'error');
    }
  };

  // Delete reference
  const handleDeleteRef = async (index: number) => {
    try {
      await api.deletePlateReference(printer.id, index);
      showToast(t('printers.toast.referenceDeleted'), 'success');
      fetchPlateReferences();
      // Re-check to update counts
      const checkResult = await api.checkPlateEmpty(printer.id, { includeDebugImage: true });
      setPlateCheckResult(checkResult);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('printers.toast.failedToDeleteReference'), 'error');
    }
  };

  // Save ROI settings
  const handleSaveRoi = async () => {
    if (!editingRoi) return;
    setIsSavingRoi(true);
    try {
      await api.updatePrinter(printer.id, { plate_detection_roi: editingRoi });
      showToast(t('printers.toast.detectionAreaSaved'), 'success');
      setEditingRoi(null);
      // Re-check to see new ROI in action
      const checkResult = await api.checkPlateEmpty(printer.id, { includeDebugImage: true });
      setPlateCheckResult(checkResult);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('printers.toast.failedToSaveDetectionArea'), 'error');
    } finally {
      setIsSavingRoi(false);
    }
  };

  // Close plate check modal on Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && plateCheckResult) {
        closePlateCheckModal();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [plateCheckResult, closePlateCheckModal]);

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

  const canDrop = isConnected && status?.state !== 'RUNNING' && status?.state !== 'PAUSE' && hasPermission('printers:control');

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

    return (
      <>
        {includeRfid && (
          <button
            className={`w-full px-2 py-1.5 text-left text-xs flex items-center gap-2 rounded transition-colors ${
              hasPermission('printers:ams_rfid')
                ? 'text-white hover:bg-bambu-dark-tertiary'
                : 'text-bambu-gray/50 cursor-not-allowed'
            }`}
            onClick={(e) => {
              e.stopPropagation();
              if (printerBusy || !hasPermission('printers:ams_rfid')) return;
              refreshAmsSlotMutation.mutate({ amsId, slotId });
            }}
            disabled={printerBusy || isRefreshing || !hasPermission('printers:ams_rfid')}
            title={printerBusy ? t('printers.bedJog.disabledWhilePrinting') : !hasPermission('printers:ams_rfid') ? t('printers.permission.noAmsRfid') : undefined}
          >
            <RefreshCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin' : ''}`} />
            {t('printers.rfid.reread')}
          </button>
        )}
        <button
          className={`w-full px-2 py-1.5 text-left text-xs flex items-center gap-2 rounded transition-colors ${
            hasPermission('printers:control')
              ? 'text-white hover:bg-bambu-dark-tertiary'
              : 'text-bambu-gray/50 cursor-not-allowed'
          }`}
          onClick={(e) => {
            e.stopPropagation();
            if (printerBusy || !hasPermission('printers:control')) return;
            loadAmsTrayMutation.mutate({ trayId: loadTrayId });
          }}
          disabled={printerBusy || !hasPermission('printers:control')}
          title={printerBusy ? t('printers.bedJog.disabledWhilePrinting') : !hasPermission('printers:control') ? t('printers.permission.noControl') : undefined}
        >
          <LogIn className="w-3 h-3" />
          {t('printers.ams.load')}
        </button>
        <button
          className={`w-full px-2 py-1.5 text-left text-xs flex items-center gap-2 rounded transition-colors ${
            hasPermission('printers:control')
              ? 'text-white hover:bg-bambu-dark-tertiary'
              : 'text-bambu-gray/50 cursor-not-allowed'
          }`}
          onClick={(e) => {
            e.stopPropagation();
            if (printerBusy || !hasPermission('printers:control')) return;
            unloadAmsMutation.mutate();
          }}
          disabled={printerBusy || !hasPermission('printers:control')}
          title={printerBusy ? t('printers.bedJog.disabledWhilePrinting') : !hasPermission('printers:control') ? t('printers.permission.noControl') : undefined}
        >
          <LogOut className="w-3 h-3" />
          {t('printers.ams.unload')}
        </button>
      </>
    );
  };

  const printerActionsMenu = (
    <div ref={printerActionsMenuRef} className="relative flex-shrink-0">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setShowMenu(!showMenu)}
        title={t('common.more', 'More')}
        className={footerIconButtonClass}
      >
        <MoreVertical className="w-4 h-4" />
      </Button>
      {showMenu && (
        <div className="absolute left-0 bottom-full mb-2 w-48 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-lg z-20">
          <button
            className={`w-full px-4 py-2 text-left text-sm flex items-center gap-2 ${
              hasPermission('printers:update')
                ? 'hover:bg-bambu-dark-tertiary'
                : 'opacity-50 cursor-not-allowed'
            }`}
            onClick={() => {
              if (!hasPermission('printers:update')) return;
              setShowEditModal(true);
              setShowMenu(false);
            }}
            title={!hasPermission('printers:update') ? t('printers.permission.noEdit') : undefined}
          >
            <Pencil className="w-4 h-4" />
            {t('common.edit')}
          </button>
          <button
            className="w-full px-4 py-2 text-left text-sm hover:bg-bambu-dark-tertiary flex items-center gap-2"
            onClick={() => {
              setShowPrinterInfo(true);
              setShowMenu(false);
            }}
          >
            <Info className="w-4 h-4" />
            {t('printers.printerInformation')}
          </button>
          {/* Maintenance Mode toggle (#1476) — leverages backend is_active flag */}
          <button
            className={`w-full px-4 py-2 text-left text-sm flex items-center gap-2 ${
              hasPermission('printers:update')
                ? 'hover:bg-bambu-dark-tertiary'
                : 'opacity-50 cursor-not-allowed'
            }`}
            disabled={maintenanceMutation.isPending || !hasPermission('printers:update')}
            onClick={() => {
              if (!hasPermission('printers:update')) return;
              setShowMenu(false);
              if (printer.is_active !== false) {
                handleEnterMaintenance();
              } else {
                maintenanceMutation.mutate(true);
              }
            }}
            title={!hasPermission('printers:update') ? t('printers.permission.noEdit') : undefined}
          >
            <Wrench className="w-4 h-4" />
            {printer.is_active !== false
              ? t('printers.maintenance.menuEnter')
              : t('printers.maintenance.menuExit')}
          </button>
          <button
            className="w-full px-4 py-2 text-left text-sm hover:bg-bambu-dark-tertiary flex items-center gap-2"
            onClick={() => {
              connectMutation.mutate();
              setShowMenu(false);
            }}
          >
            <RefreshCw className="w-4 h-4" />
            {t('printers.reconnect')}
          </button>
          <button
            className="w-full px-4 py-2 text-left text-sm hover:bg-bambu-dark-tertiary flex items-center gap-2 disabled:opacity-50"
            disabled={forceRefreshMutation.isPending}
            onClick={() => {
              forceRefreshMutation.mutate();
              setShowMenu(false);
            }}
          >
            <RotateCw className={`w-4 h-4 ${forceRefreshMutation.isPending ? 'animate-spin' : ''}`} />
            {t('printers.forceRefresh')}
          </button>
          <button
            className="w-full px-4 py-2 text-left text-sm hover:bg-bambu-dark-tertiary flex items-center gap-2"
            onClick={() => {
              setShowMQTTDebug(true);
              setShowMenu(false);
            }}
          >
            <Terminal className="w-4 h-4" />
            {t('printers.mqttDebug')}
          </button>
          <button
            className="w-full px-4 py-2 text-left text-sm hover:bg-bambu-dark-tertiary flex items-center gap-2"
            onClick={() => {
              setShowDiagnostic(true);
              setShowMenu(false);
            }}
          >
            <Stethoscope className="w-4 h-4" />
            {t('diagnostic.runButton')}
          </button>
          <button
            className={`w-full px-4 py-2 text-left text-sm flex items-center gap-2 ${
              hasPermission('printers:delete')
                ? 'text-red-400 hover:bg-bambu-dark-tertiary'
                : 'text-red-400/50 cursor-not-allowed'
            }`}
            onClick={() => {
              if (!hasPermission('printers:delete')) return;
              setShowDeleteConfirm(true);
              setShowMenu(false);
            }}
            title={!hasPermission('printers:delete') ? t('printers.permission.noDelete') : undefined}
          >
            <Trash2 className="w-4 h-4" />
            {t('common.delete')}
          </button>
        </div>
      )}
    </div>
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
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowHealthStatusMenu(!showHealthStatusMenu);
                }}
                className={`inline-flex h-full min-h-7 w-8 items-center justify-center rounded-lg transition-opacity hover:opacity-80 ${printerHealth.className}`}
                title={t('printers.health.title', 'Machine health: {{status}}', { status: printerHealth.label })}
                aria-label={t('printers.health.title', 'Machine health: {{status}}', { status: printerHealth.label })}
              >
                <Activity className="w-4 h-4" />
              </button>
              {showHealthStatusMenu && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowHealthStatusMenu(false);
                    }}
                  />
                  <div
                    className="absolute right-0 top-full mt-1 z-50 flex w-[240px] flex-col overflow-hidden rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-2xl"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="shrink-0 px-3 py-2.5 text-center text-sm font-medium text-white">
                      {t('printers.health.statusDetails', 'Status details')}
                    </div>
                    <div className="h-px bg-bambu-dark-tertiary" />
                    <div className="space-y-1.5 p-2.5">
                      {connectionStatusPill}
                      {healthMenuPlateStatusPill}
                      {networkStatusPill}
                      {hmsStatusPill}
                      {maintenanceStatusPill}
                      {queueStatusPill}
                      {firmwareStatusPill}
                      {doorStatusPill}
                    </div>
                  </div>
                </>
              )}
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

        {/* Delete Confirmation */}
        {showDeleteConfirm && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <Card className="w-full max-w-md mx-4">
              <CardContent>
                <div className="flex items-start gap-3 mb-4">
                  <div className="p-2 rounded-full bg-red-500/20">
                    <AlertTriangle className="w-5 h-5 text-red-400" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-white">{t('printers.confirm.deleteTitle')}</h3>
                    <p className="text-sm text-bambu-gray mt-1">
                      {t('printers.confirm.deleteMessage', { name: printer.name })}
                    </p>
                  </div>
                </div>

                <div className="bg-bambu-dark rounded-lg p-3 mb-4">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={deleteArchives}
                      onChange={(e) => setDeleteArchives(e.target.checked)}
                      className="mt-0.5 w-4 h-4 rounded border-bambu-gray bg-bambu-dark-secondary text-bambu-green focus:ring-bambu-green focus:ring-offset-0"
                    />
                    <div>
                      <span className="text-sm text-white">{t('printers.deleteArchives')}</span>
                      <p className="text-xs text-bambu-gray mt-0.5">
                        {deleteArchives
                          ? t('printers.confirm.deleteArchivesNote')
                          : t('printers.confirm.keepArchivesNote')}
                      </p>
                    </div>
                  </label>
                </div>

                <div className="flex justify-end gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setShowDeleteConfirm(false);
                      setDeleteArchives(true);
                    }}
                  >
                    {t('common.cancel')}
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => {
                      deleteMutation.mutate({ deleteArchives });
                      setShowDeleteConfirm(false);
                      setDeleteArchives(true);
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
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
                          <div className="flex h-3 items-center gap-2 text-sm">
                            <div className="h-1.5 min-w-0 flex-1 rounded-full bg-bambu-dark-tertiary">
                              <div
                                className={`${isActivePrint ? (status.state === 'PAUSE' ? 'bg-status-warning' : 'bg-bambu-green') : showRetainedPrint ? 'bg-bambu-green' : 'bg-bambu-dark-tertiary'} h-1.5 rounded-full transition-all`}
                                style={{ width: `${progress}%` }}
                              />
                            </div>
                            <span className={`w-9 shrink-0 pr-1 text-right text-[11px] leading-none ${isActivePrint || showRetainedPrint ? 'text-white' : 'text-bambu-gray'}`}>{isActivePrint || showRetainedPrint ? `${Math.round(progress)}%` : '---%'}</span>
                          </div>
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

            {/* Temperatures */}
            {status.temperatures && (() => {
              // Use actual heater states from MQTT stream
              const nozzleHeating = status.temperatures.nozzle_heating || status.temperatures.nozzle_2_heating || false;
              const bedHeating = status.temperatures.bed_heating || false;
              const chamberHeating = status.temperatures.chamber_heating || false;
              const isDualNozzle = printer.nozzle_count === 2 || status.temperatures.nozzle_2 !== undefined;
              const availableHeaterKinds: HeaterSensorKind[] = (() => {
                const kinds: HeaterSensorKind[] = ['nozzle'];
                if (status.temperatures.nozzle_2 !== undefined) kinds.push('nozzle_2');
                kinds.push('bed');
                if (status.temperatures.chamber !== undefined) kinds.push('chamber');
                return kinds;
              })();
              // active_extruder: 0=right, 1=left
              const activeNozzle = status.active_extruder === 1 ? 'L' : 'R';
              // Extended nozzle data from nozzle_rack (H2 series: wear, serial, max_temp, etc.)
              // nozzle_rack id 0 = extruder 0 = RIGHT, id 1 = extruder 1 = LEFT
              const leftNozzleSlot = status.nozzle_rack?.find(s => s.id === 1);
              const rightNozzleSlot = status.nozzle_rack?.find(s => s.id === 0);
              // Single-nozzle models (H2D, H2C): use the primary nozzle (id 0)
              const singleNozzleSlot = rightNozzleSlot || leftNozzleSlot;
              const canUseStatusControls = status.connected && hasPermission('printers:control');
              const statusControlTitle = canUseStatusControls ? undefined : t('printers.permission.noControl');
              const statusControlClass = `relative text-center px-2 py-1.5 bg-bambu-dark rounded-lg flex-1 flex flex-col justify-center items-center transition-colors ${
                canUseStatusControls ? 'cursor-pointer hover:bg-bambu-dark-tertiary' : 'cursor-default opacity-80'
              }`;
              // Chamber fan only exists on enclosed Bambu models. Open-frame
              // printers (A1, A1 Mini, A2L, P1P) have no chamber fan — showing
              // the widget there is at best dead UI and at worst suggests a
              // control that does nothing. Mirrors the enclosure-door badge
              // gate above.
              const hasChamberFan = MODELS_WITH_CHAMBER_FAN.has(printer.model ?? '');
              const fanItems = [
                {
                  key: 'part',
                  label: t('printers.fans.partCooling'),
                  value: status.cooling_fan_speed ?? 0,
                  Icon: Fan,
                  activeClass: 'text-cyan-400',
                },
                {
                  key: 'aux',
                  label: t('printers.fans.auxiliary'),
                  value: status.big_fan1_speed ?? 0,
                  Icon: Wind,
                  activeClass: 'text-blue-400',
                },
                ...(hasChamberFan
                  ? [
                      {
                        key: 'chamber',
                        label: t('printers.fans.chamber'),
                        value: status.big_fan2_speed ?? 0,
                        Icon: AirVent,
                        activeClass: 'text-green-400',
                      },
                    ]
                  : []),
              ];

              return (
                <>
                  <div className="mt-2 flex items-stretch gap-1.5 flex-wrap">
                    {/* Nozzle temp - combined for dual nozzle */}
                    <div
                      className={statusControlClass}
                      title={statusControlTitle}
                      onClick={() => canUseStatusControls && setStatusControlMenu(statusControlMenu === 'nozzle-temp' ? null : 'nozzle-temp')}
                    >
                      <button
                        type="button"
                        className="absolute top-0.5 right-0.5 p-0.5 rounded text-bambu-gray hover:text-white hover:bg-white/10 transition-colors"
                        title={t('printers.heaterHistory.openLabel', 'View heater history')}
                        onClick={(e) => {
                          e.stopPropagation();
                          setHeaterHistoryModal({ initialKind: 'nozzle', availableKinds: availableHeaterKinds });
                        }}
                      >
                        <LineChartIcon className="w-2.5 h-2.5" />
                      </button>
                      <HeaterThermometer className="w-3.5 h-3.5 mb-0.5" color="text-orange-400" isHeating={nozzleHeating} />
                      {status.temperatures.nozzle_2 !== undefined ? (
                        <>
                          <p className="text-[9px] text-bambu-gray">L / R</p>
                          <p className="text-[11px] text-white">
                            {Math.round(status.temperatures.nozzle || 0)}° / {Math.round(status.temperatures.nozzle_2 || 0)}°
                          </p>
                        </>
                      ) : singleNozzleSlot ? (
                        <NozzleSlotHoverCard slot={singleNozzleSlot} index={0} activeStatus filamentName={singleNozzleSlot.filament_id ? filamentInfo?.[singleNozzleSlot.filament_id]?.name : undefined}>
                          <div className="cursor-default">
                            <p className="text-[9px] text-bambu-gray">{t('printers.temperatures.nozzle')}</p>
                            <p className="text-[11px] text-white">
                              {Math.round(status.temperatures.nozzle || 0)}°C
                            </p>
                          </div>
                        </NozzleSlotHoverCard>
                      ) : (
                        <>
                          <p className="text-[9px] text-bambu-gray">{t('printers.temperatures.nozzle')}</p>
                          <p className="text-[11px] text-white">
                            {Math.round(status.temperatures.nozzle || 0)}°C
                          </p>
                        </>
                      )}
                      {statusControlMenu === 'nozzle-temp' && (
                        isDualNozzle ? (
                          <IndicatorControlPopover
                            title="Set Nozzle Temperatures"
                            widthClass="w-[300px]"
                            popoverWidth={300}
                            popoverHeight={260}
                            isPending={nozzleTemperatureMutation.isPending}
                            onClose={() => setStatusControlMenu(null)}
                          >
                            <div className="grid grid-cols-2 gap-2 px-3 py-2.5">
                              <NozzleTemperatureControlBox
                                label="Left Temp"
                                current={status.temperatures.nozzle}
                                target={status.temperatures.nozzle_target}
                                isActive={activeNozzle === 'L'}
                                isPending={nozzleTemperatureMutation.isPending}
                                onSubmit={(target) => nozzleTemperatureMutation.mutate({ target, nozzle: 1 })}
                                options={buildPresetOptions(nozzleTempPresets, 'C')}
                              />
                              <NozzleTemperatureControlBox
                                label="Right Temp"
                                current={status.temperatures.nozzle_2}
                                target={status.temperatures.nozzle_2_target}
                                isActive={activeNozzle === 'R'}
                                isPending={nozzleTemperatureMutation.isPending}
                                onSubmit={(target) => nozzleTemperatureMutation.mutate({ target, nozzle: 0 })}
                                options={buildPresetOptions(nozzleTempPresets, 'C')}
                              />
                            </div>
                          </IndicatorControlPopover>
                        ) : (
                          <IndicatorControlPopover
                            title="Set Nozzle Temperature"
                            unit="°C"
                            customMin={0}
                            customMax={320}
                            isPending={nozzleTemperatureMutation.isPending}
                            options={buildPresetOptions(nozzleTempPresets, 'C')}
                            onClose={() => setStatusControlMenu(null)}
                            onSubmit={(target) => nozzleTemperatureMutation.mutate({ target, nozzle: status.active_extruder ?? 0 })}
                          />
                        )
                      )}
                    </div>
                    <div
                      className={statusControlClass}
                      title={statusControlTitle}
                      onClick={() => canUseStatusControls && setStatusControlMenu(statusControlMenu === 'bed-temp' ? null : 'bed-temp')}
                    >
                      <button
                        type="button"
                        className="absolute top-0.5 right-0.5 p-0.5 rounded text-bambu-gray hover:text-white hover:bg-white/10 transition-colors"
                        title={t('printers.heaterHistory.openLabel', 'View heater history')}
                        onClick={(e) => {
                          e.stopPropagation();
                          setHeaterHistoryModal({ initialKind: 'bed', availableKinds: availableHeaterKinds });
                        }}
                      >
                        <LineChartIcon className="w-2.5 h-2.5" />
                      </button>
                      <HeaterThermometer className="w-3.5 h-3.5 mb-0.5" color="text-blue-400" isHeating={bedHeating} />
                      <p className="text-[9px] text-bambu-gray">{t('printers.temperatures.bed')}</p>
                      <p className="text-[11px] text-white">
                        {Math.round(status.temperatures.bed || 0)}°C
                      </p>
                      {statusControlMenu === 'bed-temp' && (
                        <IndicatorControlPopover
                          title="Set Bed Temperature"
                          unit="°C"
                          customMin={0}
                          customMax={140}
                          isPending={bedTemperatureMutation.isPending}
                          options={buildPresetOptions(bedTempPresets, 'C')}
                          onClose={() => setStatusControlMenu(null)}
                          onSubmit={(target) => bedTemperatureMutation.mutate(target)}
                        />
                      )}
                    </div>
                    {status.temperatures.chamber !== undefined && (() => {
                      // Sensor-only models (X1C, X1E, P2S) show the chamber reading
                      // but can't act on M141, so we keep the card read-only there.
                      const hasChamberHeater = status.supports_chamber_heater === true;
                      return (
                        <div
                          className={hasChamberHeater
                            ? statusControlClass
                            : 'relative text-center px-2 py-1.5 bg-bambu-dark rounded-lg flex-1 flex flex-col justify-center items-center'}
                          title={hasChamberHeater ? statusControlTitle : undefined}
                          onClick={hasChamberHeater
                            ? () => canUseStatusControls && setStatusControlMenu(statusControlMenu === 'chamber-temp' ? null : 'chamber-temp')
                            : undefined}
                        >
                          <button
                            type="button"
                            className="absolute top-0.5 right-0.5 p-0.5 rounded text-bambu-gray hover:text-white hover:bg-white/10 transition-colors"
                            title={t('printers.heaterHistory.openLabel', 'View heater history')}
                            onClick={(e) => {
                              e.stopPropagation();
                              setHeaterHistoryModal({ initialKind: 'chamber', availableKinds: availableHeaterKinds });
                            }}
                          >
                            <LineChartIcon className="w-2.5 h-2.5" />
                          </button>
                          <HeaterThermometer className="w-3.5 h-3.5 mb-0.5" color="text-green-400" isHeating={chamberHeating} />
                          <p className="text-[9px] text-bambu-gray">{t('printers.temperatures.chamber')}</p>
                          <p className="text-[11px] text-white">
                            {Math.round(status.temperatures.chamber || 0)}°C
                          </p>
                          {hasChamberHeater && statusControlMenu === 'chamber-temp' && (
                            <IndicatorControlPopover
                              title="Set Chamber Temperature"
                              unit="°C"
                              customMin={0}
                              customMax={60}
                              isPending={chamberTemperatureMutation.isPending}
                              options={buildPresetOptions(chamberTempPresets, 'C')}
                              onClose={() => setStatusControlMenu(null)}
                              onSubmit={(target) => chamberTemperatureMutation.mutate(target)}
                            />
                          )}
                        </div>
                      );
                    })()}
                    {/* Active nozzle indicator for dual-nozzle printers */}
                    {isDualNozzle && (
                      <DualNozzleHoverCard
                        leftSlot={leftNozzleSlot}
                        rightSlot={rightNozzleSlot}
                        activeNozzle={activeNozzle}
                        filamentInfo={filamentInfo}
                      >
                        <div
                          className={`relative text-center px-3 py-1.5 bg-bambu-dark rounded-lg h-full flex flex-col justify-center items-center transition-colors ${
                            canUseStatusControls ? 'cursor-pointer hover:bg-bambu-dark-tertiary' : 'cursor-default opacity-80'
                          }`}
                          title={canUseStatusControls ? t('printers.activeNozzle', { nozzle: activeNozzle === 'L' ? t('common.left') : t('common.right') }) : statusControlTitle}
                          onClick={() => canUseStatusControls && setStatusControlMenu(statusControlMenu === 'nozzle-select' ? null : 'nozzle-select')}
                        >
                          <NozzleIcon className="w-3.5 h-3.5 mb-0.5 text-amber-400" />
                          <div className="flex items-center gap-2">
                            <span className={`text-[11px] font-bold ${activeNozzle === 'L' ? 'text-amber-400' : 'text-gray-500'}`}>
                              L{leftNozzleSlot?.nozzle_diameter ? ` ${leftNozzleSlot.nozzle_diameter}` : ''}
                            </span>
                            <span className="text-[9px] text-bambu-gray/40">·</span>
                            <span className={`text-[11px] font-bold ${activeNozzle === 'R' ? 'text-amber-400' : 'text-gray-500'}`}>
                              R{rightNozzleSlot?.nozzle_diameter ? ` ${rightNozzleSlot.nozzle_diameter}` : ''}
                            </span>
                          </div>
                          <p className="text-[9px] text-bambu-gray">{t('printers.temperatures.nozzle')}</p>
                          {statusControlMenu === 'nozzle-select' && (
                            <IndicatorControlPopover
                              title="Set Nozzle Selection"
                              widthClass="w-[300px]"
                              popoverWidth={300}
                              popoverHeight={140}
                              isPending={selectExtruderMutation.isPending}
                              options={[
                                { label: 'Left', value: 1 },
                                { label: 'Right', value: 0 },
                              ]}
                              onClose={() => setStatusControlMenu(null)}
                              onSubmit={(extruder) => selectExtruderMutation.mutate(extruder)}
                            />
                          )}
                        </div>
                      </DualNozzleHoverCard>
                    )}
                    {/* H2C nozzle rack (tool-changer dock) — only show when rack nozzles exist (IDs >= 2) */}
                    {status.nozzle_rack && status.nozzle_rack.some(s => s.id >= 2) && (
                      <NozzleRackCard slots={status.nozzle_rack} filamentInfo={filamentInfo} />
                    )}
                  </div>
                  <div className="mt-2 flex items-center gap-1.5">
                    {fanItems.map(({ key, label, value, Icon, activeClass }) => {
                      const active = value > 0;
                      return (
                        <div
                          key={key}
                          className={`relative px-2 py-1.5 bg-bambu-dark rounded-lg flex-1 min-w-0 flex items-center justify-center gap-1 transition-colors ${
                            canUseStatusControls ? 'cursor-pointer hover:bg-bambu-dark-tertiary' : 'cursor-default opacity-80'
                          }`}
                          title={canUseStatusControls ? label : statusControlTitle}
                          onClick={() => canUseStatusControls && setStatusControlMenu(statusControlMenu === `fan-${key}` ? null : `fan-${key}`)}
                        >
                          <Icon className={`w-3 h-3 shrink-0 ${active ? activeClass : 'text-bambu-gray/50'}`} />
                          <span className={`text-[10px] leading-none ${active ? 'text-white' : 'text-bambu-gray/50'}`}>
                            {value}%
                          </span>
                          {statusControlMenu === `fan-${key}` && (
                            <IndicatorControlPopover
                              title={`Set ${label} Speed`}
                              unit="%"
                              customMin={0}
                              customMax={100}
                              isPending={fanSpeedMutation.isPending}
                              options={buildPresetOptions(fanSpeedPresets, '%')}
                              onClose={() => setStatusControlMenu(null)}
                              onSubmit={(speed) => fanSpeedMutation.mutate({ fan: key as 'part' | 'aux' | 'chamber', speed })}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              );
            })()}

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

                      {/* Airduct Mode (P2S / X2D / H2*) */}
                      {(['P2S', 'X2D', 'H2D', 'H2C', 'H2S'].includes(printer.model ?? '')) && (() => {
                        const isHeating = status.airduct_mode === 1;
                        const Icon = isHeating ? Flame : Snowflake;
                        const color = isHeating ? 'text-orange-400' : 'text-sky-400';
                        const bg = isHeating ? 'bg-orange-500/10 text-orange-400 hover:bg-orange-500/20' : 'bg-sky-500/10 text-sky-400 hover:bg-sky-500/20';
                        return (
                          <div className="relative">
                            <button
                              onClick={() => setShowAirductMenu(showAirductMenu === printer.id ? null : printer.id)}
                              disabled={!hasPermission('printers:control')}
                              className={`${iconControlClass} ${bg}`}
                              title={`${t('printers.airduct.title')}: ${isHeating ? t('printers.airduct.heating') : t('printers.airduct.cooling')}`}
                            >
                              <Icon className={`w-4 h-4 ${color}`} />
                            </button>
                            {showAirductMenu === printer.id && (
                              <>
                                <div className="fixed inset-0 z-40" onClick={() => setShowAirductMenu(null)} />
                                <div className="absolute bottom-full left-0 mb-1 z-50 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-lg py-1 min-w-[130px]">
                                  {([
                                    { mode: 'cooling', label: t('printers.airduct.cooling'), modeId: 0 },
                                    { mode: 'heating', label: t('printers.airduct.heating'), modeId: 1 },
                                  ] as const).map(({ mode, label, modeId }) => (
                                    <button
                                      key={mode}
                                      onClick={() => {
                                        airductMutation.mutate(mode);
                                        setShowAirductMenu(null);
                                      }}
                                      className={`w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 ${
                                        status.airduct_mode === modeId
                                          ? 'text-bambu-green bg-bambu-green/10'
                                          : 'text-white hover:bg-bambu-dark-tertiary'
                                      }`}
                                    >
                                      {mode === 'heating' ? <Flame className="w-3 h-3" /> : <Snowflake className="w-3 h-3" />}
                                      {label}
                                    </button>
                                  ))}
                                </div>
                              </>
                            )}
                          </div>
                        );
                      })()}

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

                      <div className={`inline-flex rounded-lg ${printer.plate_detection_enabled ? 'ring-1 ring-green-500' : ''}`}>
                        <button
                          onClick={handleTogglePlateDetection}
                          disabled={!status.connected || plateDetectionMutation.isPending || !hasPermission('printers:update')}
                          className={`${iconControlClass} rounded-r-none ${
                            printer.plate_detection_enabled
                              ? 'bg-green-500/10 text-green-400 hover:bg-green-500/20'
                              : 'bg-bambu-dark text-bambu-gray/50 hover:bg-bambu-dark-tertiary hover:text-white'
                          }`}
                          title={!hasPermission('printers:update') ? t('printers.plateDetection.noPermission') : (printer.plate_detection_enabled ? t('printers.plateDetection.enabledClick') : t('printers.plateDetection.disabledClick'))}
                        >
                          {plateDetectionMutation.isPending ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <ScanSearch className="w-4 h-4" />
                          )}
                        </button>
                        <button
                          onClick={handleOpenPlateManagement}
                          disabled={!status.connected || isCheckingPlate || !hasPermission('printers:update')}
                          className={`flex h-8 w-8 items-center justify-center rounded-r-lg border-l border-bambu-dark-tertiary transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                            printer.plate_detection_enabled
                              ? 'bg-green-500/10 text-green-400 hover:bg-green-500/20'
                              : 'bg-bambu-dark text-bambu-gray/50 hover:bg-bambu-dark-tertiary hover:text-white'
                          }`}
                          title={!hasPermission('printers:update') ? t('printers.plateDetection.noPermission') : t('printers.plateDetection.manageCalibration')}
                        >
                          {isCheckingPlate ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <ChevronDown className="w-4 h-4" />
                          )}
                        </button>
                      </div>

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

                      return (
                        <div key={ams.id} style={getAmsCardStyle(4)} className="min-w-0 p-2 bg-bambu-dark rounded-[10px] space-y-1">
                            {/* Header: Label + Stats (no icon) */}
                            <div className="flex w-full min-h-7 items-center justify-between gap-2 rounded-lg bg-bambu-dark-secondary px-2 py-1">
                              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                                {/* AMS name — hover to see serial, firmware, and edit friendly name */}
                                <AmsNameHoverCard
                                  ams={ams}
                                  printerId={printer.id}
                                  label={getAmsLabel(ams.id, ams.tray.length)}
                                  amsLabels={amsLabels}
                                  canEdit={hasPermission('printers:update')}
                                  onSaved={refetchAmsLabels}
                                >
                                  <span className="block truncate text-[10px] text-white font-medium cursor-default select-none">
                                    {amsLabels?.[ams.id] || getAmsLabel(ams.id, ams.tray.length)}
                                  </span>
                                </AmsNameHoverCard>
                                {isDualNozzle && (isLeftNozzle || isRightNozzle) && (
                                  <NozzleBadge side={isLeftNozzle ? 'L' : 'R'} />
                                )}
                              </div>
                              {(ams.humidity != null || ams.temp != null) && (
                                <div className="flex shrink-0 items-center gap-1.5">
                                  {ams.humidity != null && (
                                    <HumidityIndicator
                                      humidity={ams.humidity}
                                      goodThreshold={amsThresholds?.humidityGood}
                                      fairThreshold={amsThresholds?.humidityFair}
                                      onClick={() => setAmsHistoryModal({
                                        amsId: ams.id,
                                        amsLabel: getAmsLabel(ams.id, ams.tray.length),
                                        mode: 'humidity',
                                      })}
                                      compact
                                    />
                                  )}
                                  {ams.temp != null && (
                                    <div className="mr-1">
                                      <TemperatureIndicator
                                        temp={ams.temp}
                                        goodThreshold={amsThresholds?.tempGood}
                                        fairThreshold={amsThresholds?.tempFair}
                                        onClick={() => setAmsHistoryModal({
                                          amsId: ams.id,
                                          amsLabel: getAmsLabel(ams.id, ams.tray.length),
                                          mode: 'temperature',
                                        })}
                                        compact
                                      />
                                    </div>
                                  )}
                                  <AmsDryingButton ams={ams} supportsDrying={status.supports_drying === true} canControl={hasPermission('printers:control')} controller={dryingControls} />
                                </div>
                              )}
                            </div>
                            <AmsDryingStatus ams={ams} controller={dryingControls} />
                            {/* Slots grid: 4 columns - always render 4 slots */}
                            <div className="grid w-full grid-cols-[repeat(4,minmax(3.5rem,1fr))] gap-1">
                              {[0, 1, 2, 3].map((slotIdx) => {
                                // Find tray data for this slot (may be undefined if data incomplete)
                                // Use array index if available, as tray.id may not always be set
                                const tray = ams.tray[slotIdx] || ams.tray.find(t => t.id === slotIdx);
                                const hasFillLevel = tray?.tray_type && tray.remain >= 0;
                                const isEmpty = !tray?.tray_type;
                                const emptyKind = getEmptySlotKind(tray);
                                // Check if this is the currently loaded tray
                                // Global tray ID = ams.id * 4 + slot index (for standard AMS)
                                const globalTrayId = ams.id * 4 + slotIdx;
                                const isActive = effectiveTrayNow === globalTrayId;
                                // Get cloud preset info if available
                                const cloudInfo = tray?.tray_info_idx ? filamentInfo?.[tray.tray_info_idx] : null;
                                // Get saved slot preset mapping (for user-configured slots)
                                const slotPreset = slotPresets?.[globalTrayId];

                                // Fill level fallback chain: Spoolman → Inventory → AMS remain
                                const trayTag = (tray?.tray_uuid || tray?.tag_uid || getFallbackSpoolTag(printer.serial_number, ams.id, slotIdx))?.toUpperCase();
                                const linkedSpool = trayTag ? linkedSpools?.[trayTag] : undefined;
                                const spoolmanFill = getSpoolmanFillLevel(linkedSpool);
                                // Slot-assigned-only spool fill (no tag link required)
                                const slotAssignmentForFill = spoolmanEnabled && !spoolmanLoading
                                  ? spoolmanSlotAssignments?.find(a => a.printer_id === printer.id && a.ams_id === ams.id && a.tray_id === slotIdx)
                                  : undefined;
                                const slotSpoolForFill = slotAssignmentForFill
                                  ? spoolmanSpools?.find(s => s.id === slotAssignmentForFill.spoolman_spool_id)
                                  : undefined;
                                const slotSpoolFill = (slotSpoolForFill && (slotSpoolForFill.label_weight ?? 0) > 0)
                                  ? Math.round(Math.max(0, (slotSpoolForFill.label_weight ?? 0) - slotSpoolForFill.weight_used) / (slotSpoolForFill.label_weight ?? 1) * 100)
                                  : null;
                                const inventoryAssignment = onGetAssignment?.(printer.id, ams.id, slotIdx);
                                const inventoryFill = (() => {
                                  const sp = inventoryAssignment?.spool;
                                  if (sp && sp.label_weight > 0 && sp.weight_used != null) {
                                    return Math.round(Math.max(0, sp.label_weight - sp.weight_used) / sp.label_weight * 100);
                                  }
                                  return null;
                                })();
                                // If inventory says 0% but AMS reports positive remain, prefer AMS
                                // (inventory weight_used may be stale or over-counted — #676)
                                const resolvedInventoryFill = (inventoryFill === 0 && hasFillLevel && tray.remain > 0)
                                  ? null : inventoryFill;
                                const effectiveFill = spoolmanFill ?? slotSpoolFill ?? resolvedInventoryFill ?? (hasFillLevel ? tray.remain : null);
                                const fillSource = (spoolmanFill !== null || slotSpoolFill !== null) ? 'spoolman' as const
                                  : resolvedInventoryFill !== null ? 'inventory' as const
                                  : hasFillLevel ? 'ams' as const
                                  : undefined;

                                // Build filament data for hover card
                                const filamentData = tray?.tray_type ? {
                                  vendor: (isBambuLabSpool(tray) ? 'Bambu Lab' : 'Generic') as 'Bambu Lab' | 'Generic',
                                  // Spoolman spool name wins over cloud lookup so a slot bound to
                                  // a Spoolman spool shows that spool's preset name (e.g. "Devil
                                  // Design PLA") instead of whatever the printer's filament_id
                                  // resolves to in the cloud catalog (often "Generic PLA" for
                                  // P-prefix local presets). Spoolman's filament.name is just the
                                  // material+subtype ("PLA Basic"); prepend the spool's brand so
                                  // the hover card shows "Devil Design PLA Basic" rather than the
                                  // vendor-less form. Strip the "@<printer>..." suffix that
                                  // BambuStudio appends to user-preset names.
                                  profile: slotPreset?.preset_name || (slotSpoolForFill ? [slotSpoolForFill.brand, slotSpoolForFill.slicer_filament_name?.split('@')[0].trim() || slotSpoolForFill.material].filter(Boolean).join(' ').trim() : null) || inventoryAssignment?.spool?.slicer_filament_name || cloudInfo?.name || tray.tray_sub_brands || tray.tray_type,
                                  colorName: getColorName(tray.tray_color || ''),
                                  colorHex: tray.tray_color || null,
                                  kFactor: formatKValue(tray.k),
                                  fillLevel: effectiveFill,
                                  trayUuid: tray.tray_uuid || null,
                                  tagUid: tray.tag_uid || null,
                                  fillSource,
                                } : null;

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
                                    {/* Hover card wraps only the visual content */}
                                    {filamentData ? (
                                      <FilamentHoverCard
                                        data={filamentData}
                                        actions={renderAmsSlotActions({
                                          amsId: ams.id,
                                          slotId: slotIdx,
                                          loadTrayId: ams.id * 4 + slotIdx,
                                          isRefreshing,
                                        })}
                                        spoolman={{
                                          enabled: spoolmanEnabled,
                                          // #1457: slot assignment is the user's most explicit action — it must
                                          // outrank the tag-link, which can be stale when a non-RFID slot's
                                          // fallback tag is still attached to a previous spool in Spoolman.
                                          linkedSpoolId: slotAssignmentForFill?.spoolman_spool_id
                                            ?? (trayTag ? linkedSpools?.[trayTag]?.id : undefined),
                                          spoolmanUrl,
                                          syncMode: spoolmanSyncMode,
                                          // Suppress Link button when slot is already occupied by ANY assignment
                                          // (Spoolman SlotAssignment OR local SpoolAssignment). Phase 9 only
                                          // suppressed for Spoolman; the maintainer screenshot shows the badge
                                          // still appearing on slots with a local Devil Design PLA assigned.
                                          onLinkSpool: (spoolmanEnabled && !slotAssignmentForFill && !inventoryAssignment) ? () => {
                                            const linkTag = (filamentData.trayUuid || filamentData.tagUid || getFallbackSpoolTag(printer.serial_number, ams.id, slotIdx)).toUpperCase();
                                            setLinkSpoolModal({
                                              tagUid: filamentData.tagUid || linkTag,
                                              trayUuid: filamentData.trayUuid || '',
                                              printerId: printer.id,
                                              amsId: ams.id,
                                              trayId: slotIdx,
                                            });
                                          } : undefined,
                                          onUnlinkSpool: linkedSpool?.id ? () => unlinkSpoolMutation.mutate(linkedSpool.id) : undefined,
                                        }}
                                        inventory={(() => {
                                          if (spoolmanEnabled) {
                                            if (spoolmanLoading) return undefined;
                                            const slotAssignment = slotAssignmentForFill;
                                            const spoolmanSpool = slotSpoolForFill;
                                            return {
                                              assignedSpool: spoolmanSpool ? {
                                                id: spoolmanSpool.id,
                                                material: spoolmanSpool.material,
                                                brand: spoolmanSpool.brand ?? null,
                                                color_name: spoolmanSpool.color_name ?? null,
                                                remainingWeightGrams: spoolmanSpool.label_weight
                                                  ? Math.max(0, Math.round(spoolmanSpool.label_weight - spoolmanSpool.weight_used))
                                                  : undefined,
                                              } : null,
                                              onAssignSpool: () => setAssignSpoolModal({
                                                printerId: printer.id,
                                                amsId: ams.id,
                                                trayId: slotIdx,
                                                trayInfo: {
                                                  type: tray?.tray_type || filamentData.profile,
                                                  material: tray?.tray_type ?? undefined,
                                                  profile: filamentData.profile,
                                                  color: filamentData.colorHex || '',
                                                  location: `${getAmsLabel(ams.id, ams.tray.length)} Slot ${slotIdx + 1}`,
                                                },
                                              }),
                                              onUnassignSpool: (spoolmanSpool && !isBambuLabSpool(tray)) ? () => onUnassignSpoolmanSpool?.(spoolmanSpool.id) : undefined,
                                              isAssigned: !!slotAssignment || isBambuLabSpool(tray),
                                            };
                                          }
                                          const assignment = onGetAssignment?.(printer.id, ams.id, slotIdx);
                                          return {
                                            assignedSpool: assignment?.spool ? {
                                              id: assignment.spool.id,
                                              material: assignment.spool.material,
                                              brand: assignment.spool.brand,
                                              color_name: assignment.spool.color_name,
                                              remainingWeightGrams: Math.max(0, Math.round(assignment.spool.label_weight - assignment.spool.weight_used)),
                                            } : null,
                                            onAssignSpool: () => setAssignSpoolModal({
                                              printerId: printer.id,
                                              amsId: ams.id,
                                              trayId: slotIdx,
                                              trayInfo: {
                                                type: tray?.tray_type || filamentData.profile,
                                                material: tray?.tray_type ?? undefined,
                                                profile: filamentData.profile,
                                                color: filamentData.colorHex || '',
                                                location: `${getAmsLabel(ams.id, ams.tray.length)} Slot ${slotIdx + 1}`,
                                              },
                                            }),
                                            onUnassignSpool: (assignment && !isBambuLabSpool(tray)) ? () => onUnassignSpool?.(printer.id, ams.id, slotIdx) : undefined,
                                            isAssigned: !!assignment || isBambuLabSpool(tray),
                                          };
                                        })()}
                                        configureSlot={{
                                          enabled: hasPermission('printers:control'),
                                          onConfigure: () => setConfigureSlotModal({
                                            amsId: ams.id,
                                            trayId: slotIdx,
                                            trayCount: ams.tray.length,
                                            trayType: tray?.tray_type || undefined,
                                            trayColor: tray?.tray_color || undefined,
                                            traySubBrands: tray?.tray_sub_brands || undefined,
                                            trayInfoIdx: tray?.tray_info_idx || undefined,
                                            extruderId: mappedExtruderId,
                                            caliIdx: tray?.cali_idx,
                                            savedPresetId: slotPreset?.preset_id,
                                          }),
                                        }}
                                      >
                                        {slotVisual}
                                      </FilamentHoverCard>
                                    ) : (
                                      <EmptySlotHoverCard
                                        kind={emptyKind ?? undefined}
                                        actions={renderAmsSlotActions({
                                          amsId: ams.id,
                                          slotId: slotIdx,
                                          loadTrayId: ams.id * 4 + slotIdx,
                                          isRefreshing,
                                        })}
                                        configureSlot={{
                                          enabled: hasPermission('printers:control'),
                                          onConfigure: () => setConfigureSlotModal({
                                            amsId: ams.id,
                                            trayId: slotIdx,
                                            trayCount: ams.tray.length,
                                            extruderId: mappedExtruderId,
                                          }),
                                        }}
                                        onAssignSpool={() => setAssignSpoolModal({
                                          printerId: printer.id,
                                          amsId: ams.id,
                                          trayId: slotIdx,
                                          trayInfo: {
                                            type: '',
                                            material: undefined,
                                            profile: '',
                                            color: '',
                                            location: `${getAmsLabel(ams.id, ams.tray.length)} Slot ${slotIdx + 1}`,
                                          },
                                        })}
                                      >
                                        {slotVisual}
                                      </EmptySlotHoverCard>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                        </div>
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
                      const hasFillLevel = tray?.tray_type && tray.remain >= 0;
                      const isEmpty = !tray?.tray_type;
                      const emptyKind = getEmptySlotKind(tray);
                      // Check if this is the currently loaded tray
                      const globalTrayId = getGlobalTrayId(ams.id, tray?.id ?? 0, false);
                      const isActive = effectiveTrayNow === globalTrayId;
                      // Get cloud preset info if available
                      const cloudInfo = tray?.tray_info_idx ? filamentInfo?.[tray.tray_info_idx] : null;
                      // Get saved slot preset mapping (for user-configured slots)
                      const slotPreset = slotPresets?.[globalTrayId];
                      const htSlotId = tray?.id ?? 0;

                        // Fill level fallback chain: Spoolman → Inventory → AMS remain
                        const htTrayTag = (tray?.tray_uuid || tray?.tag_uid || getFallbackSpoolTag(printer.serial_number, ams.id, htSlotId))?.toUpperCase();
                        const htLinkedSpool = htTrayTag ? linkedSpools?.[htTrayTag] : undefined;
                        const htSpoolmanFill = getSpoolmanFillLevel(htLinkedSpool);
                        const htInventoryAssignment = onGetAssignment?.(printer.id, ams.id, htSlotId);
                        const htInventoryFill = (() => {
                          const sp = htInventoryAssignment?.spool;
                          if (sp && sp.label_weight > 0 && sp.weight_used != null) {
                            return Math.round(Math.max(0, sp.label_weight - sp.weight_used) / sp.label_weight * 100);
                          }
                          return null;
                        })();
                        // If inventory says 0% but AMS reports positive remain, prefer AMS (#676)
                        const htResolvedInventoryFill = (htInventoryFill === 0 && hasFillLevel && tray.remain > 0)
                          ? null : htInventoryFill;
                        // Slot-assigned-only fill (when spool has no NFC tag but is slot-assigned)
                        const htSlotAssignmentForFill = spoolmanEnabled && !spoolmanLoading
                          ? spoolmanSlotAssignments?.find(a => a.printer_id === printer.id && a.ams_id === ams.id && a.tray_id === htSlotId)
                          : undefined;
                        const htSlotSpoolForFill = htSlotAssignmentForFill
                          ? spoolmanSpools?.find(s => s.id === htSlotAssignmentForFill.spoolman_spool_id)
                          : undefined;
                        const htSlotSpoolFill = (htSlotSpoolForFill && (htSlotSpoolForFill.label_weight ?? 0) > 0)
                          ? Math.round(Math.max(0, (htSlotSpoolForFill.label_weight ?? 0) - htSlotSpoolForFill.weight_used) / (htSlotSpoolForFill.label_weight ?? 1) * 100)
                          : null;
                        const htEffectiveFill = htSpoolmanFill ?? htSlotSpoolFill ?? htResolvedInventoryFill ?? (hasFillLevel ? tray.remain : null);
                        const htFillSource = (htSpoolmanFill !== null || htSlotSpoolFill !== null) ? 'spoolman' as const
                          : htResolvedInventoryFill !== null ? 'inventory' as const
                          : hasFillLevel ? 'ams' as const
                          : undefined;

                        // Build filament data for hover card
                        const filamentData = tray?.tray_type ? {
                          vendor: (isBambuLabSpool(tray) ? 'Bambu Lab' : 'Generic') as 'Bambu Lab' | 'Generic',
                          profile: slotPreset?.preset_name || (htSlotSpoolForFill ? [htSlotSpoolForFill.brand, htSlotSpoolForFill.slicer_filament_name?.split('@')[0].trim() || htSlotSpoolForFill.material].filter(Boolean).join(' ').trim() : null) || htInventoryAssignment?.spool?.slicer_filament_name || cloudInfo?.name || tray.tray_sub_brands || tray.tray_type,
                          colorName: getColorName(tray.tray_color || ''),
                          colorHex: tray.tray_color || null,
                          kFactor: formatKValue(tray.k),
                          fillLevel: htEffectiveFill,
                          trayUuid: tray.tray_uuid || null,
                          tagUid: tray.tag_uid || null,
                          fillSource: htFillSource,
                        } : null;

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
                        return (
                          <div key={ams.id} style={htCardStyle} className="min-w-0 p-2 bg-bambu-dark rounded-[10px] space-y-1">
                            {/* Row 1: Label + Nozzle + Drying */}
                            <div className="flex w-full min-h-7 items-center gap-1.5 rounded-lg bg-bambu-dark-secondary px-2 py-1">
                              {/* AMS name — hover to see serial, firmware, and edit friendly name */}
                              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                                <AmsNameHoverCard
                                  ams={ams}
                                  printerId={printer.id}
                                  label={getAmsLabel(ams.id, ams.tray.length)}
                                  amsLabels={amsLabels}
                                  canEdit={hasPermission('printers:update')}
                                  onSaved={refetchAmsLabels}
                                >
                                  <span className="block truncate text-[10px] text-white font-medium cursor-default select-none">
                                    {amsLabels?.[ams.id] || getAmsLabel(ams.id, ams.tray.length)}
                                  </span>
                                </AmsNameHoverCard>
                                {isDualNozzle && (isLeftNozzle || isRightNozzle) && (
                                  <NozzleBadge side={isLeftNozzle ? 'L' : 'R'} />
                                )}
                              </div>
                              <AmsDryingButton ams={ams} supportsDrying={status.supports_drying === true} canControl={hasPermission('printers:control')} controller={dryingControls} />
                            </div>
                            <AmsDryingStatus ams={ams} controller={dryingControls} />
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
                                {/* Hover card wraps only the visual content */}
                                {filamentData ? (
                                  <FilamentHoverCard
                                    data={filamentData}
                                    actions={renderAmsSlotActions({
                                      amsId: ams.id,
                                      slotId: htSlotId,
                                      loadTrayId: ams.id * 4 + htSlotId,
                                      isRefreshing: isHtRefreshing,
                                    })}
                                    spoolman={{
                                      enabled: spoolmanEnabled,
                                      // #1457: slot assignment outranks tag-link (see top-level slot block).
                                      linkedSpoolId: htSlotAssignmentForFill?.spoolman_spool_id
                                        ?? (htTrayTag ? linkedSpools?.[htTrayTag]?.id : undefined),
                                      spoolmanUrl,
                                      syncMode: spoolmanSyncMode,
                                      // Suppress Link button when slot is occupied by ANY assignment (Phase 13 P13-6d)
                                      onLinkSpool: (spoolmanEnabled && !htSlotAssignmentForFill && !htInventoryAssignment) ? () => {
                                        const linkTag = (filamentData.trayUuid || filamentData.tagUid || getFallbackSpoolTag(printer.serial_number, ams.id, htSlotId)).toUpperCase();
                                        setLinkSpoolModal({
                                          tagUid: filamentData.tagUid || linkTag,
                                          trayUuid: filamentData.trayUuid || '',
                                          printerId: printer.id,
                                          amsId: ams.id,
                                          trayId: htSlotId,
                                        });
                                      } : undefined,
                                      onUnlinkSpool: htLinkedSpool?.id ? () => unlinkSpoolMutation.mutate(htLinkedSpool.id) : undefined,
                                    }}
                                    inventory={(() => {
                                      if (spoolmanEnabled) {
                                        if (spoolmanLoading) return undefined;
                                        const slotAssignment = htSlotAssignmentForFill;
                                        const spoolmanSpool = htSlotSpoolForFill;
                                        return {
                                          assignedSpool: spoolmanSpool ? {
                                            id: spoolmanSpool.id,
                                            material: spoolmanSpool.material,
                                            brand: spoolmanSpool.brand ?? null,
                                            color_name: spoolmanSpool.color_name ?? null,
                                            remainingWeightGrams: spoolmanSpool.label_weight
                                              ? Math.max(0, Math.round(spoolmanSpool.label_weight - spoolmanSpool.weight_used))
                                              : undefined,
                                          } : null,
                                          onAssignSpool: () => setAssignSpoolModal({
                                            printerId: printer.id,
                                            amsId: ams.id,
                                            trayId: htSlotId,
                                            trayInfo: {
                                              type: tray?.tray_type || filamentData.profile,
                                              material: tray?.tray_type ?? undefined,
                                              profile: filamentData.profile,
                                              color: filamentData.colorHex || '',
                                              location: getAmsLabel(ams.id, ams.tray.length),
                                            },
                                          }),
                                          onUnassignSpool: (spoolmanSpool && !isBambuLabSpool(tray)) ? () => onUnassignSpoolmanSpool?.(spoolmanSpool.id) : undefined,
                                          isAssigned: !!slotAssignment || isBambuLabSpool(tray),
                                        };
                                      }
                                      const assignment = onGetAssignment?.(printer.id, ams.id, htSlotId);
                                      return {
                                        assignedSpool: assignment?.spool ? {
                                          id: assignment.spool.id,
                                          material: assignment.spool.material,
                                          brand: assignment.spool.brand,
                                          color_name: assignment.spool.color_name,
                                          remainingWeightGrams: Math.max(0, Math.round(assignment.spool.label_weight - assignment.spool.weight_used)),
                                        } : null,
                                        onAssignSpool: () => setAssignSpoolModal({
                                          printerId: printer.id,
                                          amsId: ams.id,
                                          trayId: htSlotId,
                                          trayInfo: {
                                            type: tray?.tray_type || filamentData.profile,
                                            material: tray?.tray_type ?? undefined,
                                            profile: filamentData.profile,
                                            color: filamentData.colorHex || '',
                                            location: getAmsLabel(ams.id, ams.tray.length),
                                          },
                                        }),
                                        onUnassignSpool: (assignment && !isBambuLabSpool(tray)) ? () => onUnassignSpool?.(printer.id, ams.id, htSlotId) : undefined,
                                        isAssigned: !!assignment || isBambuLabSpool(tray),
                                      };
                                    })()}
                                    configureSlot={{
                                      enabled: hasPermission('printers:control'),
                                      onConfigure: () => setConfigureSlotModal({
                                        amsId: ams.id,
                                        trayId: htSlotId,
                                        trayCount: ams.tray.length,
                                        trayType: tray?.tray_type || undefined,
                                        trayColor: tray?.tray_color || undefined,
                                        traySubBrands: tray?.tray_sub_brands || undefined,
                                        trayInfoIdx: tray?.tray_info_idx || undefined,
                                        extruderId: mappedExtruderId,
                                        caliIdx: tray?.cali_idx,
                                        savedPresetId: slotPreset?.preset_id,
                                      }),
                                    }}
                                  >
                                    {slotVisual}
                                  </FilamentHoverCard>
                                ) : (
                                  <EmptySlotHoverCard
                                    kind={emptyKind ?? undefined}
                                    actions={renderAmsSlotActions({
                                      amsId: ams.id,
                                      slotId: htSlotId,
                                      loadTrayId: ams.id * 4 + htSlotId,
                                      isRefreshing: isHtRefreshing,
                                    })}
                                    configureSlot={{
                                      enabled: hasPermission('printers:control'),
                                      onConfigure: () => setConfigureSlotModal({
                                        amsId: ams.id,
                                        trayId: htSlotId,
                                        trayCount: ams.tray.length,
                                        extruderId: mappedExtruderId,
                                      }),
                                    }}
                                    onAssignSpool={() => setAssignSpoolModal({
                                      printerId: printer.id,
                                      amsId: ams.id,
                                      trayId: htSlotId,
                                      trayInfo: {
                                        type: '',
                                        material: undefined,
                                        profile: '',
                                        color: '',
                                        location: getAmsLabel(ams.id, ams.tray.length),
                                      },
                                    })}
                                  >
                                    {slotVisual}
                                  </EmptySlotHoverCard>
                                )}
                              </div>
                              {/* Stats stacked vertically: Temp on top, Humidity below */}
                              {(ams.humidity != null || ams.temp != null) && (
                                <div className="flex flex-col justify-center gap-1 shrink-0 max-[550px]:w-full">
                                  {ams.temp != null && (
                                    <TemperatureIndicator
                                      temp={ams.temp}
                                      goodThreshold={amsThresholds?.tempGood}
                                      fairThreshold={amsThresholds?.tempFair}
                                      onClick={() => setAmsHistoryModal({
                                        amsId: ams.id,
                                        amsLabel: getAmsLabel(ams.id, ams.tray.length),
                                        mode: 'temperature',
                                      })}
                                      compact
                                    />
                                  )}
                                  {ams.humidity != null && (
                                    <HumidityIndicator
                                      humidity={ams.humidity}
                                      goodThreshold={amsThresholds?.humidityGood}
                                      fairThreshold={amsThresholds?.humidityFair}
                                      onClick={() => setAmsHistoryModal({
                                        amsId: ams.id,
                                        amsLabel: getAmsLabel(ams.id, ams.tray.length),
                                        mode: 'humidity',
                                      })}
                                      compact
                                    />
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
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
                              const extSlotPreset = slotPresets?.[255 * 4 + slotTrayId];

                              const extTrayTag = (extTray.tray_uuid || extTray.tag_uid || getFallbackSpoolTag(printer.serial_number, 255, slotTrayId))?.toUpperCase();
                              const extLinkedSpool = extTrayTag ? linkedSpools?.[extTrayTag] : undefined;
                              const extSpoolmanFill = getSpoolmanFillLevel(extLinkedSpool);
                              const extInventoryAssignment = onGetAssignment?.(printer.id, 255, slotTrayId);
                              const extInventoryFill = (() => {
                                const sp = extInventoryAssignment?.spool;
                                if (sp && sp.label_weight > 0 && sp.weight_used != null) {
                                  return Math.round(Math.max(0, sp.label_weight - sp.weight_used) / sp.label_weight * 100);
                                }
                                return null;
                              })();
                              const extHasFillLevel = extTray.tray_type && extTray.remain >= 0;
                              // If inventory says 0% but AMS reports positive remain, prefer AMS (#676)
                              const extResolvedInventoryFill = (extInventoryFill === 0 && extHasFillLevel && extTray.remain > 0)
                                ? null : extInventoryFill;
                              // Slot-assigned-only fill (when spool has no NFC tag but is slot-assigned)
                              const extSlotAssignmentForFill = spoolmanEnabled && !spoolmanLoading
                                ? spoolmanSlotAssignments?.find(a => a.printer_id === printer.id && a.ams_id === 255 && a.tray_id === slotTrayId)
                                : undefined;
                              const extSlotSpoolForFill = extSlotAssignmentForFill
                                ? spoolmanSpools?.find(s => s.id === extSlotAssignmentForFill.spoolman_spool_id)
                                : undefined;
                              const extSlotSpoolFill = (extSlotSpoolForFill && (extSlotSpoolForFill.label_weight ?? 0) > 0)
                                ? Math.round(Math.max(0, (extSlotSpoolForFill.label_weight ?? 0) - extSlotSpoolForFill.weight_used) / (extSlotSpoolForFill.label_weight ?? 1) * 100)
                                : null;
                              const extEffectiveFill = extSpoolmanFill ?? extSlotSpoolFill ?? extResolvedInventoryFill ?? (extHasFillLevel ? extTray.remain : null);
                              const extFillSource = (extSpoolmanFill !== null || extSlotSpoolFill !== null) ? 'spoolman' as const
                                : extResolvedInventoryFill !== null ? 'inventory' as const
                                : extHasFillLevel ? 'ams' as const
                                : undefined;

                              const extFilamentData = {
                                vendor: (isBambuLabSpool(extTray) ? 'Bambu Lab' : 'Generic') as 'Bambu Lab' | 'Generic',
                                profile: extSlotPreset?.preset_name || (extSlotSpoolForFill ? [extSlotSpoolForFill.brand, extSlotSpoolForFill.slicer_filament_name?.split('@')[0].trim() || extSlotSpoolForFill.material].filter(Boolean).join(' ').trim() : null) || extInventoryAssignment?.spool?.slicer_filament_name || extCloudInfo?.name || extTray.tray_sub_brands || extTray.tray_type || 'Unknown',
                                colorName: getColorName(extTray.tray_color || ''),
                                colorHex: extTray.tray_color || null,
                                kFactor: formatKValue(extTray.k),
                                fillLevel: extEffectiveFill,
                                trayUuid: extTray.tray_uuid || null,
                                tagUid: extTray.tag_uid || null,
                                fillSource: extFillSource,
                              };

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
                                  {!isEmpty ? (
                                    <FilamentHoverCard
                                      data={extFilamentData}
                                      actions={renderAmsSlotActions({
                                        amsId: 255,
                                        slotId: slotTrayId,
                                        loadTrayId: extTrayId,
                                        includeRfid: false,
                                      })}
                                      spoolman={{
                                        enabled: spoolmanEnabled,
                                        // #1457: slot assignment outranks tag-link (see top-level slot block).
                                        linkedSpoolId: extSlotAssignmentForFill?.spoolman_spool_id
                                          ?? (extTrayTag ? linkedSpools?.[extTrayTag]?.id : undefined),
                                        spoolmanUrl,
                                        syncMode: spoolmanSyncMode,
                                        // Suppress Link button when slot is occupied by ANY assignment (Phase 13 P13-6d)
                                        onLinkSpool: (spoolmanEnabled && !extSlotAssignmentForFill && !extInventoryAssignment) ? () => {
                                          const linkTag = (extFilamentData.trayUuid || extFilamentData.tagUid || getFallbackSpoolTag(printer.serial_number, 255, slotTrayId)).toUpperCase();
                                          setLinkSpoolModal({
                                            tagUid: extFilamentData.tagUid || linkTag,
                                            trayUuid: extFilamentData.trayUuid || '',
                                            printerId: printer.id,
                                            amsId: 255,
                                            trayId: slotTrayId,
                                          });
                                        } : undefined,
                                        onUnlinkSpool: extLinkedSpool?.id ? () => unlinkSpoolMutation.mutate(extLinkedSpool.id) : undefined,
                                      }}
                                      inventory={(() => {
                                        if (spoolmanEnabled) {
                                          if (spoolmanLoading) return undefined;
                                          const slotAssignment = extSlotAssignmentForFill;
                                          const spoolmanSpool = extSlotSpoolForFill;
                                          return {
                                            assignedSpool: spoolmanSpool ? {
                                              id: spoolmanSpool.id,
                                              material: spoolmanSpool.material,
                                              brand: spoolmanSpool.brand ?? null,
                                              color_name: spoolmanSpool.color_name ?? null,
                                              remainingWeightGrams: spoolmanSpool.label_weight
                                                ? Math.max(0, Math.round(spoolmanSpool.label_weight - spoolmanSpool.weight_used))
                                                : undefined,
                                            } : null,
                                            onAssignSpool: () => setAssignSpoolModal({
                                              printerId: printer.id,
                                              amsId: 255,
                                              trayId: slotTrayId,
                                              trayInfo: {
                                                type: extTray.tray_type || extFilamentData.profile,
                                                material: extTray.tray_type ?? undefined,
                                                profile: extFilamentData.profile,
                                                color: extFilamentData.colorHex || '',
                                                location: extLabel || t('printers.external'),
                                              },
                                            }),
                                            onUnassignSpool: (spoolmanSpool && !isBambuLabSpool(extTray)) ? () => onUnassignSpoolmanSpool?.(spoolmanSpool.id) : undefined,
                                            isAssigned: !!slotAssignment || isBambuLabSpool(extTray),
                                          };
                                        }
                                        const assignment = onGetAssignment?.(printer.id, 255, slotTrayId);
                                        return {
                                          assignedSpool: assignment?.spool ? {
                                            id: assignment.spool.id,
                                            material: assignment.spool.material,
                                            brand: assignment.spool.brand,
                                            color_name: assignment.spool.color_name,
                                            remainingWeightGrams: Math.max(0, Math.round(assignment.spool.label_weight - assignment.spool.weight_used)),
                                          } : null,
                                          onAssignSpool: () => setAssignSpoolModal({
                                            printerId: printer.id,
                                            amsId: 255,
                                            trayId: slotTrayId,
                                            trayInfo: {
                                              type: extTray.tray_type || extFilamentData.profile,
                                              material: extTray.tray_type ?? undefined,
                                              profile: extFilamentData.profile,
                                              color: extFilamentData.colorHex || '',
                                              location: extLabel || t('printers.external'),
                                            },
                                          }),
                                          onUnassignSpool: (assignment && !isBambuLabSpool(extTray)) ? () => onUnassignSpool?.(printer.id, 255, slotTrayId) : undefined,
                                          isAssigned: !!assignment || isBambuLabSpool(extTray),
                                        };
                                      })()}
                                      configureSlot={{
                                        enabled: hasPermission('printers:control'),
                                        onConfigure: () => setConfigureSlotModal({
                                          amsId: 255,
                                          trayId: slotTrayId,
                                          trayCount: 1,
                                          trayType: extTray.tray_type || undefined,
                                          trayColor: extTray.tray_color || undefined,
                                          traySubBrands: extTray.tray_sub_brands || undefined,
                                          trayInfoIdx: extTray.tray_info_idx || undefined,
                                          extruderId: isDualNozzle ? (extTrayId === 254 ? 1 : 0) : undefined,
                                          caliIdx: extTray.cali_idx,
                                          savedPresetId: extSlotPreset?.preset_id,
                                        }),
                                      }}
                                    >
                                      {extSlotContent}
                                    </FilamentHoverCard>
                                  ) : (
                                    <EmptySlotHoverCard
                                      kind={emptyKind ?? undefined}
                                      actions={renderAmsSlotActions({
                                        amsId: 255,
                                        slotId: slotTrayId,
                                        loadTrayId: extTrayId,
                                        includeRfid: false,
                                      })}
                                      configureSlot={{
                                        enabled: hasPermission('printers:control'),
                                        onConfigure: () => setConfigureSlotModal({
                                          amsId: 255,
                                          trayId: slotTrayId,
                                          trayCount: 1,
                                          extruderId: isDualNozzle ? (extTrayId === 254 ? 1 : 0) : undefined,
                                        }),
                                      }}
                                      onAssignSpool={() => setAssignSpoolModal({
                                        printerId: printer.id,
                                        amsId: 255,
                                        trayId: slotTrayId,
                                        trayInfo: {
                                          type: '',
                                          material: undefined,
                                          profile: '',
                                          color: '',
                                          location: `External Slot ${slotTrayId + 1}`,
                                        },
                                      })}
                                    >
                                      {extSlotContent}
                                    </EmptySlotHoverCard>
                                  )}
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
                {isConnected && status?.state !== 'RUNNING' && status?.state !== 'PAUSE' && (
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
                )}
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

      {/* Plate Check Result Modal */}
      {plateCheckResult && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => closePlateCheckModal()}>
          <div className="bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-xl shadow-2xl max-w-lg w-full" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-bambu-dark-tertiary">
              <div className="flex items-center gap-2">
                {plateCheckResult.needs_calibration ? (
                  <ScanSearch className="w-5 h-5 text-blue-500" />
                ) : plateCheckResult.is_empty ? (
                  <CheckCircle className="w-5 h-5 text-green-500" />
                ) : (
                  <XCircle className="w-5 h-5 text-yellow-500" />
                )}
                <h2 className="text-lg font-semibold text-white">
                  Build Plate Check
                </h2>
                {plateCheckResult.reference_count !== undefined && plateCheckResult.max_references && (
                  <span className="text-xs text-bambu-gray bg-bambu-dark-tertiary px-2 py-1 rounded">
                    {plateCheckResult.reference_count}/{plateCheckResult.max_references} refs
                  </span>
                )}
              </div>
              <button
                onClick={() => closePlateCheckModal()}
                className="p-1 text-bambu-gray hover:text-white rounded transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              {plateCheckResult.needs_calibration ? (
                <>
                  <div className="p-3 rounded-lg bg-blue-500/20 border border-blue-500/50">
                    <p className="font-medium text-blue-400">
                      {t('printers.plateDetection.calibrationRequired')}
                    </p>
                    <p className="text-sm text-bambu-gray mt-1" dangerouslySetInnerHTML={{ __html: t('printers.plateDetection.calibrationInstructions') }} />
                  </div>
                  <div className="text-sm text-bambu-gray space-y-2">
                    <p>{t('printers.plateDetection.calibrationDescription')}</p>
                    <p dangerouslySetInnerHTML={{ __html: t('printers.plateDetection.calibrationTip') }} />
                  </div>
                </>
              ) : (
                <>
                  <div className={`p-3 rounded-lg ${plateCheckResult.is_empty ? 'bg-green-500/20 border border-green-500/50' : 'bg-yellow-500/20 border border-yellow-500/50'}`}>
                    <p className={`font-medium ${plateCheckResult.is_empty ? 'text-green-400' : 'text-yellow-400'}`}>
                      {plateCheckResult.is_empty ? t('printers.plateDetection.plateEmpty') : t('printers.plateDetection.objectsDetected')}
                    </p>
                    <p className="text-sm text-bambu-gray mt-1">
                      {t('printers.plateDetection.confidence')}: {Math.round(plateCheckResult.confidence * 100)}% | {t('printers.plateDetection.difference')}: {plateCheckResult.difference_percent.toFixed(1)}%
                    </p>
                  </div>
                  {plateCheckResult.debug_image_url && (
                    <div>
                      <p className="text-sm text-bambu-gray mb-2">{t('printers.plateDetection.analysisPreview')}</p>
                      <img
                        src={plateCheckResult.debug_image_url}
                        alt={t('printers.plateDetection.analysisPreview')}
                        className="w-full rounded-lg border border-bambu-dark-tertiary"
                      />
                      <p className="text-xs text-bambu-gray mt-2">
                        {t('printers.plateDetection.analysisLegend')}
                      </p>
                    </div>
                  )}
                  <p className="text-xs text-bambu-gray">
                    {plateCheckResult.message}
                  </p>
                </>
              )}

              {/* Saved References Grid */}
              {plateReferences && plateReferences.references.length > 0 && (
                <div className="mt-4">
                  <div className="flex items-center gap-2 mb-2">
                    <p className="text-sm font-medium text-white shrink-0">
                      {t('printers.plateDetection.savedReferences', { count: plateReferences.references.length, max: plateReferences.max_references })}
                    </p>
                    <div className="flex-1 h-[2px] bg-bambu-dark-tertiary" />
                  </div>
                  <div className="grid grid-cols-5 gap-2">
                    {plateReferences.references.map((ref) => (
                      <div key={ref.index} className="relative group">
                        <img
                          src={api.getPlateReferenceThumbnailUrl(printer.id, ref.index)}
                          alt={ref.label || `Reference ${ref.index + 1}`}
                          className="w-full aspect-video object-cover rounded border border-bambu-dark-tertiary"
                        />
                        {/* Delete button */}
                        <button
                          onClick={() => handleDeleteRef(ref.index)}
                          className="absolute top-1 right-1 p-0.5 bg-red-500/80 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                          title={t('printers.plateDetection.deleteReference')}
                        >
                          <X className="w-3 h-3 text-white" />
                        </button>
                        {/* Label */}
                        {editingRefLabel?.index === ref.index ? (
                          <input
                            type="text"
                            value={editingRefLabel.label}
                            onChange={(e) => setEditingRefLabel({ ...editingRefLabel, label: e.target.value })}
                            onBlur={() => handleUpdateRefLabel(ref.index, editingRefLabel.label)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleUpdateRefLabel(ref.index, editingRefLabel.label);
                              if (e.key === 'Escape') setEditingRefLabel(null);
                            }}
                            className="w-full mt-1 px-1 py-0.5 text-xs bg-bambu-dark-tertiary border border-bambu-green rounded text-white"
                            autoFocus
                            placeholder={t('printers.plateDetection.labelPlaceholder')}
                          />
                        ) : (
                          <p
                            className="text-xs text-bambu-gray mt-1 truncate cursor-pointer hover:text-white"
                            onClick={() => setEditingRefLabel({ index: ref.index, label: ref.label })}
                            title={ref.label ? t('printers.plateDetection.clickToEdit', { label: ref.label }) : t('printers.plateDetection.clickToAddLabel')}
                          >
                            {ref.label || <span className="italic opacity-50">{t('printers.noLabel')}</span>}
                          </p>
                        )}
                        {/* Timestamp */}
                        <p className="text-[10px] text-bambu-gray/60">
                          {ref.timestamp ? parseUTCDate(ref.timestamp)?.toLocaleDateString() ?? '' : ''}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ROI Editor */}
              {!plateCheckResult.needs_calibration && (
                <div className="mt-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <p className="text-sm font-medium text-white shrink-0">{t('printers.roi.title')}</p>
                      <div className="flex-1 h-[2px] bg-bambu-dark-tertiary" />
                    </div>
                    {!editingRoi ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditingRoi(plateCheckResult.roi || { x: 0.15, y: 0.35, w: 0.70, h: 0.55 })}
                      >
                        <Pencil className="w-3 h-3 mr-1" />
                        {t('common.edit')}
                      </Button>
                    ) : (
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditingRoi(null)}
                          disabled={isSavingRoi}
                        >
                          {t('common.cancel')}
                        </Button>
                        <Button
                          size="sm"
                          onClick={handleSaveRoi}
                          disabled={isSavingRoi}
                        >
                          {isSavingRoi ? <Loader2 className="w-3 h-3 animate-spin" /> : t('common.save')}
                        </Button>
                      </div>
                    )}
                  </div>
                  {editingRoi ? (
                    <div className="space-y-3 bg-bambu-dark-tertiary/50 p-3 rounded-lg">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-xs text-bambu-gray">{t('printers.roi.xStart')}</label>
                          <input
                            type="range"
                            min="0"
                            max="0.9"
                            step="0.01"
                            value={editingRoi.x}
                            onChange={(e) => setEditingRoi({ ...editingRoi, x: parseFloat(e.target.value) })}
                            className="w-full h-1.5 bg-bambu-dark-tertiary rounded-lg cursor-pointer accent-green-500"
                          />
                          <span className="text-xs text-bambu-gray">{Math.round(editingRoi.x * 100)}%</span>
                        </div>
                        <div>
                          <label className="text-xs text-bambu-gray">{t('printers.roi.yStart')}</label>
                          <input
                            type="range"
                            min="0"
                            max="0.9"
                            step="0.01"
                            value={editingRoi.y}
                            onChange={(e) => setEditingRoi({ ...editingRoi, y: parseFloat(e.target.value) })}
                            className="w-full h-1.5 bg-bambu-dark-tertiary rounded-lg cursor-pointer accent-green-500"
                          />
                          <span className="text-xs text-bambu-gray">{Math.round(editingRoi.y * 100)}%</span>
                        </div>
                        <div>
                          <label className="text-xs text-bambu-gray">{t('printers.width')}</label>
                          <input
                            type="range"
                            min="0.1"
                            max="1"
                            step="0.01"
                            value={editingRoi.w}
                            onChange={(e) => setEditingRoi({ ...editingRoi, w: parseFloat(e.target.value) })}
                            className="w-full h-1.5 bg-bambu-dark-tertiary rounded-lg cursor-pointer accent-green-500"
                          />
                          <span className="text-xs text-bambu-gray">{Math.round(editingRoi.w * 100)}%</span>
                        </div>
                        <div>
                          <label className="text-xs text-bambu-gray">{t('printers.height')}</label>
                          <input
                            type="range"
                            min="0.1"
                            max="1"
                            step="0.01"
                            value={editingRoi.h}
                            onChange={(e) => setEditingRoi({ ...editingRoi, h: parseFloat(e.target.value) })}
                            className="w-full h-1.5 bg-bambu-dark-tertiary rounded-lg cursor-pointer accent-green-500"
                          />
                          <span className="text-xs text-bambu-gray">{Math.round(editingRoi.h * 100)}%</span>
                        </div>
                      </div>
                      <p className="text-xs text-bambu-gray">
                        {t('printers.roi.instruction')}
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs text-bambu-gray">
                      Current: X={Math.round((plateCheckResult.roi?.x || 0.15) * 100)}%, Y={Math.round((plateCheckResult.roi?.y || 0.35) * 100)}%,
                      W={Math.round((plateCheckResult.roi?.w || 0.70) * 100)}%, H={Math.round((plateCheckResult.roi?.h || 0.55) * 100)}%
                    </p>
                  )}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 p-4">
              {plateCheckResult.needs_calibration ? (
                <>
                  <Button variant="ghost" onClick={() => closePlateCheckModal()}>
                    {t('common.cancel')}
                  </Button>
                  <Button
                    onClick={() => handleCalibratePlate()}
                    disabled={isCalibrating}
                  >
                    {isCalibrating ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Calibrating...
                      </>
                    ) : (
                      'Calibrate Empty Plate'
                    )}
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="ghost" onClick={() => handleCalibratePlate()} disabled={isCalibrating}>
                    {isCalibrating ? 'Adding...' : `Add Reference (${plateReferences?.references.length || 0}/${plateReferences?.max_references || 5})`}
                  </Button>
                  <Button onClick={() => closePlateCheckModal()}>
                    Close
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
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

      {/* Stop Print Confirmation */}
      {showStopConfirm && (
        <ConfirmModal
          title={t('printers.confirm.stopTitle')}
          message={t('printers.confirm.stopMessage', { name: printer.name })}
          confirmText={t('printers.confirm.stopButton')}
          variant="danger"
          onConfirm={() => {
            stopPrintMutation.mutate();
            setShowStopConfirm(false);
          }}
          onCancel={() => setShowStopConfirm(false)}
        />
      )}

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

      {/* Heater History Modal (nozzle / bed / chamber) */}
      {heaterHistoryModal && (
        <HeaterHistoryModal
          isOpen={!!heaterHistoryModal}
          onClose={() => setHeaterHistoryModal(null)}
          printerId={printer.id}
          printerName={printer.name}
          initialKind={heaterHistoryModal.initialKind}
          availableKinds={heaterHistoryModal.availableKinds}
        />
      )}

      {/* Link Spool Modal */}
      {linkSpoolModal && (
        <LinkSpoolModal
          isOpen={!!linkSpoolModal}
          onClose={() => setLinkSpoolModal(null)}
          tagUid={linkSpoolModal.tagUid}
          trayUuid={linkSpoolModal.trayUuid}
          printerId={linkSpoolModal.printerId}
          amsId={linkSpoolModal.amsId}
          trayId={linkSpoolModal.trayId}
        />
      )}

      {/* Assign Spool Modal */}
      {assignSpoolModal && (
        <AssignSpoolModal
          isOpen={!!assignSpoolModal}
          onClose={() => setAssignSpoolModal(null)}
          printerId={assignSpoolModal.printerId}
          amsId={assignSpoolModal.amsId}
          trayId={assignSpoolModal.trayId}
          trayInfo={assignSpoolModal.trayInfo}
          spoolmanEnabled={!!spoolmanEnabled}
        />
      )}

      {/* Configure AMS Slot Modal */}
      {configureSlotModal && (
        <ConfigureAmsSlotModal
          isOpen={!!configureSlotModal}
          onClose={() => setConfigureSlotModal(null)}
          printerId={printer.id}
          slotInfo={configureSlotModal}
          printerModel={mapModelCode(printer.model) || undefined}
          onSuccess={() => {
            // Refresh slot presets to show updated profile name
            queryClient.invalidateQueries({ queryKey: ['slotPresets', printer.id] });
            // Printer status will update automatically via WebSocket when AMS data changes
            queryClient.invalidateQueries({ queryKey: ['printerStatus', printer.id] });
          }}
        />
      )}

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
                <select
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
                </select>
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
              <select
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
              </select>
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

function FirmwareUpdateModal({
  printer,
  firmwareInfo,
  onClose,
}: {
  printer: Printer;
  firmwareInfo: FirmwareUpdateInfo;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const canUpdate = hasPermission('firmware:update');
  const [uploadStatus, setUploadStatus] = useState<FirmwareUploadStatus | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [pollInterval, setPollInterval] = useState<NodeJS.Timeout | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(
    firmwareInfo.update_available ? firmwareInfo.latest_version : null,
  );

  // Prepare check query — runs when a version is selected and user can update
  const { data: prepareInfo, isLoading: isPreparing } = useQuery({
    queryKey: ['firmwarePrepare', printer.id, selectedVersion],
    queryFn: () => firmwareApi.prepareUpload(printer.id, selectedVersion ?? undefined),
    staleTime: 30000,
    enabled: !!selectedVersion && canUpdate && !isUploading,
  });

  // Start upload mutation
  const uploadMutation = useMutation({
    mutationFn: () => firmwareApi.startUpload(printer.id, selectedVersion ?? undefined),
    onSuccess: () => {
      setIsUploading(true);
      // Start polling for status
      const interval = setInterval(async () => {
        try {
          const status = await firmwareApi.getUploadStatus(printer.id);
          setUploadStatus(status);
          if (status.status === 'complete' || status.status === 'error') {
            clearInterval(interval);
            setPollInterval(null);
            setIsUploading(false);
            if (status.status === 'complete') {
              showToast(t('printers.firmwareModal.uploadedToast'), 'success');
              queryClient.invalidateQueries({ queryKey: ['firmwareUpdate', printer.id] });
            }
          }
        } catch {
          // Ignore errors during polling
        }
      }, 2000);
      setPollInterval(interval);
    },
    onError: (error: Error) => {
      showToast(t('printers.firmwareModal.uploadFailed', { error: error.message }), 'error');
      setIsUploading(false);
    },
  });

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [pollInterval]);

  const handleStartUpload = () => {
    setUploadStatus(null);
    uploadMutation.mutate();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <Card className="w-full max-w-md mx-4">
        <CardContent>
          <div className="flex items-start gap-3 mb-4">
            <div className={`p-2 rounded-full ${firmwareInfo.update_available ? 'bg-orange-500/20' : 'bg-status-ok/20'}`}>
              {firmwareInfo.update_available
                ? <Download className="w-5 h-5 text-orange-400" />
                : <CheckCircle className="w-5 h-5 text-status-ok" />}
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-semibold text-white">
                {firmwareInfo.update_available ? t('printers.firmwareModal.title') : t('printers.firmwareModal.titleUpToDate')}
              </h3>
              <p className="text-sm text-bambu-gray mt-1">
                {printer.name}
              </p>
            </div>
          </div>

          {/* Version Info */}
          {(() => {
            const selectedEntry = selectedVersion
              ? firmwareInfo.available_versions?.find((v) => v.version === selectedVersion)
              : null;
            const displayVersion = selectedVersion ?? firmwareInfo.latest_version;
            const displayNotes = selectedEntry?.release_notes ?? firmwareInfo.release_notes;
            const showSecondLine = !!displayVersion && displayVersion !== firmwareInfo.current_version;
            return (
              <div className="bg-bambu-dark rounded-lg p-3 mb-4">
                <div className="flex justify-between items-center text-sm">
                  <span className="text-bambu-gray">{t('printers.firmwareModal.currentVersion')}</span>
                  <span className={`font-mono ${showSecondLine ? 'text-white' : 'text-status-ok'}`}>
                    {firmwareInfo.current_version || t('common.unknown')}
                  </span>
                </div>
                {showSecondLine && (
                  <div className="flex justify-between items-center text-sm mt-1">
                    <span className="text-bambu-gray">{t('printers.firmwareModal.latestVersion')}</span>
                    <span className="text-orange-400 font-mono">{displayVersion}</span>
                  </div>
                )}
                {displayNotes && (
                  <details className="mt-3 text-sm" open={!showSecondLine} key={displayVersion ?? 'none'}>
                    <summary className={`cursor-pointer hover:underline ${showSecondLine ? 'text-orange-400' : 'text-status-ok'}`}>
                      {t('printers.firmwareModal.releaseNotes')}
                    </summary>
                    <div className="mt-2 text-bambu-gray text-xs max-h-40 overflow-y-auto whitespace-pre-wrap">
                      {displayNotes}
                    </div>
                  </details>
                )}
              </div>
            );
          })()}

          {/* Available versions list */}
          {firmwareInfo.available_versions && firmwareInfo.available_versions.length > 0 && !isUploading && uploadStatus?.status !== 'complete' && (
            <div className="mb-4">
              <div className="text-xs text-bambu-gray mb-2">{t('printers.firmwareModal.availableVersions')}</div>
              <div className="max-h-56 overflow-y-auto border border-bambu-dark-tertiary rounded-lg divide-y divide-bambu-dark-tertiary">
                {firmwareInfo.available_versions.map((v) => {
                  const isCurrent = firmwareInfo.current_version === v.version;
                  const isSelected = selectedVersion === v.version;
                  const cmp = firmwareInfo.current_version
                    ? compareFwVersions(v.version, firmwareInfo.current_version)
                    : 0;
                  const relLabel = isCurrent
                    ? t('printers.firmwareModal.currentBadge')
                    : cmp > 0
                      ? t('printers.firmwareModal.newerBadge')
                      : t('printers.firmwareModal.olderBadge');
                  const relClass = isCurrent
                    ? 'text-bambu-gray'
                    : cmp > 0
                      ? 'text-orange-400'
                      : 'text-blue-400';
                  return (
                    <button
                      key={v.version}
                      type="button"
                      disabled={!v.file_available || !canUpdate || isCurrent}
                      onClick={() => setSelectedVersion(v.version)}
                      className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between gap-2 transition-colors ${
                        isSelected ? 'bg-orange-500/10' : 'hover:bg-bambu-dark'
                      } ${!v.file_available || !canUpdate || isCurrent ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-white">{v.version}</span>
                        <span className={`text-xs ${relClass}`}>{relLabel}</span>
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${
                        isCurrent
                          ? 'bg-blue-500/15 text-blue-400 border border-blue-500/30'
                          : v.file_available
                            ? 'bg-bambu-green/15 text-bambu-green border border-bambu-green/30'
                            : 'bg-bambu-gray/10 text-bambu-gray border border-bambu-gray/30'
                      }`}>
                        {isCurrent
                          ? t('printers.firmwareModal.installed')
                          : v.file_available
                          ? t('printers.firmwareModal.usable')
                          : t('printers.firmwareModal.unavailable')}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Status / Progress (only when a version is selected) */}
          {!selectedVersion ? null : isPreparing ? (
            <div className="flex items-center gap-2 text-bambu-gray text-sm mb-4">
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('printers.firmwareModal.checkingPrereqs')}
            </div>
          ) : prepareInfo && !isUploading && !uploadStatus ? (
            <div className="mb-4">
              {prepareInfo.can_proceed ? (
                <div className="flex items-center gap-2 text-bambu-green text-sm">
                  <Box className="w-4 h-4" />
                  {t('printers.firmwareModal.sdCardReady')}
                </div>
              ) : (
                <div className="space-y-1">
                  {prepareInfo.errors.map((error, i) => (
                    <div key={i} className="flex items-center gap-2 text-red-400 text-sm">
                      <AlertCircle className="w-4 h-4 flex-shrink-0" />
                      {error}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {/* Upload Progress */}
          {(isUploading || uploadStatus) && uploadStatus && (
            <div className="mb-4">
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="text-bambu-gray capitalize">{uploadStatus.status}</span>
                <span className="text-white">{uploadStatus.progress}%</span>
              </div>
              <div className="w-full bg-bambu-dark-tertiary rounded-full h-2">
                <div
                  className={`h-2 rounded-full transition-all ${
                    uploadStatus.status === 'error' ? 'bg-status-error' :
                    uploadStatus.status === 'complete' ? 'bg-status-ok' : 'bg-orange-500'
                  } ${uploadStatus.status === 'uploading' ? 'animate-pulse' : ''}`}
                  style={{ width: `${uploadStatus.progress}%` }}
                />
              </div>
              <p className="text-xs text-bambu-gray mt-1">{uploadStatus.message}</p>
              {uploadStatus.error && (
                <p className="text-xs text-red-400 mt-1">{uploadStatus.error}</p>
              )}
            </div>
          )}

          {/* Success Message */}
          {uploadStatus?.status === 'complete' && (
            <div className="bg-bambu-green/10 border border-bambu-green/30 rounded-lg p-3 mb-4">
              <p className="text-sm text-bambu-green font-medium mb-2">
                {t('printers.firmwareModal.uploadedSuccess')}
              </p>
              <p className="text-xs text-bambu-gray">
                {t('printers.firmwareModal.applyInstructions')}
              </p>
              <ol className="text-xs text-bambu-gray mt-1 list-decimal list-inside space-y-1">
                <li dangerouslySetInnerHTML={{ __html: t('printers.firmwareModal.step1') }} />
                <li dangerouslySetInnerHTML={{ __html: t('printers.firmwareModal.step2') }} />
                <li dangerouslySetInnerHTML={{ __html: t('printers.firmwareModal.step3') }} />
                <li>{t('printers.firmwareModal.step4')}</li>
              </ol>
            </div>
          )}

          {/* Buttons */}
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" onClick={onClose}>
              {uploadStatus?.status === 'complete' ? t('printers.firmwareModal.done') : t('common.cancel')}
            </Button>
            {prepareInfo?.can_proceed && !isUploading && uploadStatus?.status !== 'complete' && canUpdate && (
              <Button
                onClick={handleStartUpload}
                disabled={uploadMutation.isPending}
              >
                {uploadMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    {t('printers.firmwareModal.starting')}
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4 mr-2" />
                    {t('printers.firmwareModal.uploadFirmware')}
                  </>
                )}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
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
              <select
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
              </select>
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
        <div data-testid="cockpit-layout" className="grid min-h-0 flex-1 gap-4 overflow-hidden lg:grid-cols-[17.5rem_minmax(0,1fr)]">
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
            />
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

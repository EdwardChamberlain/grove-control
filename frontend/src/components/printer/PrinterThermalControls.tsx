import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AirVent, Fan, LineChart, Wind } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../api/client';
import type { HeaterSensorKind, NozzleRackSlot, Printer, PrinterStatus } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { computePopoverPosition } from '../../utils/popoverPosition';
import { parseFilamentColor, isLightColor } from '../../utils/colors';
import {
  BED_TEMP_DEFAULTS,
  CHAMBER_TEMP_DEFAULTS,
  FAN_SPEED_DEFAULTS,
  NOZZLE_TEMP_DEFAULTS,
  buildPresetOptions,
} from '../../utils/temperatureFanPresets';
import { HeaterHistoryModal } from '../HeaterHistoryModal';

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
  slot: NozzleRackSlot;
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
  leftSlot?: NozzleRackSlot;
  rightSlot?: NozzleRackSlot;
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

  const renderColumn = (slot: NozzleRackSlot, side: 'L' | 'R') => {
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
function NozzleRackCard({ slots, filamentInfo }: { slots: NozzleRackSlot[]; filamentInfo?: Record<string, { name: string; k: number | null }> }) {
  const { t } = useTranslation();
  // Rack nozzles only (IDs >= 2) — excludes L/R hotend nozzles (IDs 0, 1).
  // H2C rack slot IDs are fixed at 16..21. When a nozzle is picked up into the
  // hotend the firmware omits that rack ID entirely, so we must map by the fixed
  // base — computing it from min(present IDs) shifts everything left when slot 16
  // is the one currently mounted (#943).
  const rackNozzles = slots.filter(s => s.id >= 2);
  const RACK_SIZE = 6;
  const RACK_BASE_ID = 16;
  const rackSlots: NozzleRackSlot[] = Array.from(
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

const MODELS_WITH_CHAMBER_FAN = new Set([
  'X1C', 'X1', 'X1E', 'X2D', 'P1S', 'P2S', 'H2D', 'H2D Pro', 'H2C', 'H2S',
]);

interface PrinterThermalControlsProps {
  printer: Printer;
  status?: PrinterStatus;
  filamentInfo?: Record<string, { name: string; k: number | null }>;
  nozzleTempPresets?: readonly [number, number, number];
  bedTempPresets?: readonly [number, number, number];
  chamberTempPresets?: readonly [number, number, number];
  fanSpeedPresets?: readonly [number, number, number];
  className?: string;
}

export function PrinterThermalControls({
  printer,
  status,
  filamentInfo: suppliedFilamentInfo,
  nozzleTempPresets = NOZZLE_TEMP_DEFAULTS,
  bedTempPresets = BED_TEMP_DEFAULTS,
  chamberTempPresets = CHAMBER_TEMP_DEFAULTS,
  fanSpeedPresets = FAN_SPEED_DEFAULTS,
  className = '',
}: PrinterThermalControlsProps) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [controlMenu, setControlMenu] = useState<string | null>(null);
  const [heaterHistory, setHeaterHistory] = useState<{
    initialKind: HeaterSensorKind;
    availableKinds: HeaterSensorKind[];
  } | null>(null);

  const nozzleFilamentIds = Array.from(new Set(
    (status?.nozzle_rack ?? []).map(slot => slot.filament_id).filter((id): id is string => !!id),
  )).sort();
  const { data: fetchedFilamentInfo } = useQuery({
    queryKey: ['filamentInfo', nozzleFilamentIds],
    queryFn: () => api.getFilamentInfo(nozzleFilamentIds),
    enabled: nozzleFilamentIds.length > 0 && !suppliedFilamentInfo,
    staleTime: 5 * 60 * 1000,
  });
  const filamentInfo = suppliedFilamentInfo ?? fetchedFilamentInfo;
  const invalidateStatus = () => queryClient.invalidateQueries({ queryKey: ['printerStatus', printer.id] });

  const nozzleTemperatureMutation = useMutation({
    mutationFn: ({ target, nozzle }: { target: number; nozzle: number }) => api.setNozzleTemperature(printer.id, target, nozzle),
    onSuccess: result => {
      setControlMenu(null);
      showToast(result.message || t('printers.single.nozzleTemperatureSet'));
      invalidateStatus();
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });
  const bedTemperatureMutation = useMutation({
    mutationFn: (target: number) => api.setBedTemperature(printer.id, target),
    onSuccess: result => {
      setControlMenu(null);
      showToast(result.message || t('printers.single.bedTemperatureSet'));
      invalidateStatus();
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });
  const chamberTemperatureMutation = useMutation({
    mutationFn: (target: number) => api.setChamberTemperature(printer.id, target),
    onSuccess: result => {
      setControlMenu(null);
      showToast(result.message || t('printers.single.chamberTemperatureSet'));
      invalidateStatus();
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });
  const fanSpeedMutation = useMutation({
    mutationFn: ({ fan, speed }: { fan: 'part' | 'aux' | 'chamber'; speed: number }) => api.setFanSpeed(printer.id, fan, speed),
    onMutate: async ({ fan, speed }) => {
      await queryClient.cancelQueries({ queryKey: ['printerStatus', printer.id] });
      const previousStatus = queryClient.getQueryData(['printerStatus', printer.id]);
      const fanField = { part: 'cooling_fan_speed', aux: 'big_fan1_speed', chamber: 'big_fan2_speed' }[fan];
      queryClient.setQueryData(['printerStatus', printer.id], (old: PrinterStatus | undefined) => old ? { ...old, [fanField]: speed } : old);
      return { previousStatus };
    },
    onSuccess: result => {
      setControlMenu(null);
      showToast(result.message || t('printers.single.fanSpeedSet'));
      invalidateStatus();
    },
    onError: (error: Error, _variables, context) => {
      if (context?.previousStatus) queryClient.setQueryData(['printerStatus', printer.id], context.previousStatus);
      showToast(error.message || t('printers.toast.failedToSendCommand'), 'error');
    },
  });
  const selectExtruderMutation = useMutation({
    mutationFn: (extruder: number) => api.selectExtruder(printer.id, extruder),
    onMutate: async extruder => {
      await queryClient.cancelQueries({ queryKey: ['printerStatus', printer.id] });
      const previousStatus = queryClient.getQueryData(['printerStatus', printer.id]);
      queryClient.setQueryData(['printerStatus', printer.id], (old: PrinterStatus | undefined) => old ? { ...old, active_extruder: extruder } : old);
      return { previousStatus };
    },
    onSuccess: result => {
      setControlMenu(null);
      showToast(result.message || t('printers.toast.failedToSendCommand'));
      invalidateStatus();
    },
    onError: (error: Error, _extruder, context) => {
      if (context?.previousStatus) queryClient.setQueryData(['printerStatus', printer.id], context.previousStatus);
      showToast(error.message || t('printers.toast.failedToSendCommand'), 'error');
    },
  });

  const temperatures = status?.temperatures;
  if (!temperatures) return null;

  const canControl = status.connected && hasPermission('printers:control');
  const controlTitle = canControl ? undefined : t('printers.permission.noControl');
  const controlClass = `relative flex min-h-[3.25rem] flex-1 flex-col items-center justify-center rounded-lg bg-bambu-dark px-2 py-1.5 text-center transition-colors ${
    canControl ? 'cursor-pointer hover:bg-bambu-dark-tertiary' : 'cursor-default opacity-80'
  }`;
  const isDualNozzle = printer.nozzle_count === 2 || temperatures.nozzle_2 !== undefined;
  const activeNozzle = status.active_extruder === 1 ? 'L' : 'R';
  const leftNozzleSlot = status.nozzle_rack?.find(slot => slot.id === 1);
  const rightNozzleSlot = status.nozzle_rack?.find(slot => slot.id === 0);
  const singleNozzleSlot = rightNozzleSlot || leftNozzleSlot;
  const availableHeaterKinds: HeaterSensorKind[] = ['nozzle'];
  if (temperatures.nozzle_2 !== undefined) availableHeaterKinds.push('nozzle_2');
  availableHeaterKinds.push('bed');
  if (temperatures.chamber !== undefined) availableHeaterKinds.push('chamber');
  const fanItems = [
    { key: 'part' as const, label: t('printers.fans.partCooling'), value: status.cooling_fan_speed ?? 0, Icon: Fan, activeClass: 'text-cyan-400' },
    { key: 'aux' as const, label: t('printers.fans.auxiliary'), value: status.big_fan1_speed ?? 0, Icon: Wind, activeClass: 'text-blue-400' },
    ...(MODELS_WITH_CHAMBER_FAN.has(printer.model ?? '')
      ? [{ key: 'chamber' as const, label: t('printers.fans.chamber'), value: status.big_fan2_speed ?? 0, Icon: AirVent, activeClass: 'text-green-400' }]
      : []),
  ];

  const historyButton = (kind: HeaterSensorKind) => (
    <button
      type="button"
      className="absolute right-0.5 top-0.5 rounded p-0.5 text-bambu-gray transition-colors hover:bg-white/10 hover:text-white"
      title={t('printers.heaterHistory.openLabel', 'View heater history')}
      onClick={event => {
        event.stopPropagation();
        setHeaterHistory({ initialKind: kind, availableKinds: availableHeaterKinds });
      }}
    >
      <LineChart className="h-2.5 w-2.5" />
    </button>
  );

  return (
    <>
      <div data-testid="printer-thermal-controls" className={className}>
        <div className="flex flex-wrap items-stretch gap-1.5">
          <div data-testid="thermal-nozzle-control" className={controlClass} title={controlTitle} onClick={() => canControl && setControlMenu(controlMenu === 'nozzle-temp' ? null : 'nozzle-temp')}>
            {historyButton('nozzle')}
            <HeaterThermometer className="mb-0.5 h-3.5 w-3.5" color="text-orange-400" isHeating={temperatures.nozzle_heating || temperatures.nozzle_2_heating || false} />
            {temperatures.nozzle_2 !== undefined ? (
              <><p className="text-[9px] text-bambu-gray">L / R</p><p className="text-[11px] text-white">{Math.round(temperatures.nozzle || 0)}° / {Math.round(temperatures.nozzle_2 || 0)}°</p></>
            ) : singleNozzleSlot ? (
              <NozzleSlotHoverCard slot={singleNozzleSlot} index={0} activeStatus filamentName={singleNozzleSlot.filament_id ? filamentInfo?.[singleNozzleSlot.filament_id]?.name : undefined}>
                <div className="cursor-default"><p className="text-[9px] text-bambu-gray">{t('printers.temperatures.nozzle')}</p><p className="text-[11px] text-white">{Math.round(temperatures.nozzle || 0)}°C</p></div>
              </NozzleSlotHoverCard>
            ) : (
              <><p className="text-[9px] text-bambu-gray">{t('printers.temperatures.nozzle')}</p><p className="text-[11px] text-white">{Math.round(temperatures.nozzle || 0)}°C</p></>
            )}
            {controlMenu === 'nozzle-temp' && (isDualNozzle ? (
              <IndicatorControlPopover title={t('printers.single.setNozzleTemperatures', 'Set Nozzle Temperatures')} widthClass="w-[300px]" popoverWidth={300} popoverHeight={260} isPending={nozzleTemperatureMutation.isPending} onClose={() => setControlMenu(null)}>
                <div className="grid grid-cols-2 gap-2 px-3 py-2.5">
                  <NozzleTemperatureControlBox label={t('printers.single.leftTemperature', 'Left Temp')} current={temperatures.nozzle} target={temperatures.nozzle_target} isActive={activeNozzle === 'L'} isPending={nozzleTemperatureMutation.isPending} onSubmit={target => nozzleTemperatureMutation.mutate({ target, nozzle: 1 })} options={buildPresetOptions(nozzleTempPresets, 'C')} />
                  <NozzleTemperatureControlBox label={t('printers.single.rightTemperature', 'Right Temp')} current={temperatures.nozzle_2} target={temperatures.nozzle_2_target} isActive={activeNozzle === 'R'} isPending={nozzleTemperatureMutation.isPending} onSubmit={target => nozzleTemperatureMutation.mutate({ target, nozzle: 0 })} options={buildPresetOptions(nozzleTempPresets, 'C')} />
                </div>
              </IndicatorControlPopover>
            ) : (
              <IndicatorControlPopover title={t('printers.single.setNozzleTemperature')} unit="°C" customMin={0} customMax={320} isPending={nozzleTemperatureMutation.isPending} options={buildPresetOptions(nozzleTempPresets, 'C')} onClose={() => setControlMenu(null)} onSubmit={target => nozzleTemperatureMutation.mutate({ target, nozzle: status.active_extruder ?? 0 })} />
            ))}
          </div>

          <div data-testid="thermal-bed-control" className={controlClass} title={controlTitle} onClick={() => canControl && setControlMenu(controlMenu === 'bed-temp' ? null : 'bed-temp')}>
            {historyButton('bed')}
            <HeaterThermometer className="mb-0.5 h-3.5 w-3.5" color="text-blue-400" isHeating={temperatures.bed_heating || false} />
            <p className="text-[9px] text-bambu-gray">{t('printers.temperatures.bed')}</p>
            <p className="text-[11px] text-white">{Math.round(temperatures.bed || 0)}°C</p>
            {controlMenu === 'bed-temp' && <IndicatorControlPopover title={t('printers.single.setBedTemperature')} unit="°C" customMin={0} customMax={140} isPending={bedTemperatureMutation.isPending} options={buildPresetOptions(bedTempPresets, 'C')} onClose={() => setControlMenu(null)} onSubmit={target => bedTemperatureMutation.mutate(target)} />}
          </div>

          {temperatures.chamber !== undefined && (
            <div data-testid="thermal-chamber-control" className={status.supports_chamber_heater === true ? controlClass : 'relative flex min-h-[3.25rem] flex-1 flex-col items-center justify-center rounded-lg bg-bambu-dark px-2 py-1.5 text-center'} title={status.supports_chamber_heater ? controlTitle : undefined} onClick={status.supports_chamber_heater ? () => canControl && setControlMenu(controlMenu === 'chamber-temp' ? null : 'chamber-temp') : undefined}>
              {historyButton('chamber')}
              <HeaterThermometer className="mb-0.5 h-3.5 w-3.5" color="text-green-400" isHeating={temperatures.chamber_heating || false} />
              <p className="text-[9px] text-bambu-gray">{t('printers.temperatures.chamber')}</p>
              <p className="text-[11px] text-white">{Math.round(temperatures.chamber || 0)}°C</p>
              {status.supports_chamber_heater === true && controlMenu === 'chamber-temp' && <IndicatorControlPopover title={t('printers.single.setChamberTemperature')} unit="°C" customMin={0} customMax={60} isPending={chamberTemperatureMutation.isPending} options={buildPresetOptions(chamberTempPresets, 'C')} onClose={() => setControlMenu(null)} onSubmit={target => chamberTemperatureMutation.mutate(target)} />}
            </div>
          )}

          {isDualNozzle && (
            <DualNozzleHoverCard leftSlot={leftNozzleSlot} rightSlot={rightNozzleSlot} activeNozzle={activeNozzle} filamentInfo={filamentInfo}>
              <div className={`relative flex h-full flex-col items-center justify-center rounded-lg bg-bambu-dark px-3 py-1.5 text-center transition-colors ${canControl ? 'cursor-pointer hover:bg-bambu-dark-tertiary' : 'cursor-default opacity-80'}`} title={canControl ? t('printers.activeNozzle', { nozzle: activeNozzle === 'L' ? t('common.left') : t('common.right') }) : controlTitle} onClick={() => canControl && setControlMenu(controlMenu === 'nozzle-select' ? null : 'nozzle-select')}>
                <NozzleIcon className="mb-0.5 h-3.5 w-3.5 text-amber-400" />
                <div className="flex items-center gap-2"><span className={`text-[11px] font-bold ${activeNozzle === 'L' ? 'text-amber-400' : 'text-gray-500'}`}>L{leftNozzleSlot?.nozzle_diameter ? ` ${leftNozzleSlot.nozzle_diameter}` : ''}</span><span className="text-[9px] text-bambu-gray/40">·</span><span className={`text-[11px] font-bold ${activeNozzle === 'R' ? 'text-amber-400' : 'text-gray-500'}`}>R{rightNozzleSlot?.nozzle_diameter ? ` ${rightNozzleSlot.nozzle_diameter}` : ''}</span></div>
                <p className="text-[9px] text-bambu-gray">{t('printers.temperatures.nozzle')}</p>
                {controlMenu === 'nozzle-select' && <IndicatorControlPopover title={t('printers.single.setNozzleSelection', 'Set Nozzle Selection')} widthClass="w-[300px]" popoverWidth={300} popoverHeight={140} isPending={selectExtruderMutation.isPending} options={[{ label: t('common.left'), value: 1 }, { label: t('common.right'), value: 0 }]} onClose={() => setControlMenu(null)} onSubmit={extruder => selectExtruderMutation.mutate(extruder)} />}
              </div>
            </DualNozzleHoverCard>
          )}
          {status.nozzle_rack?.some(slot => slot.id >= 2) && <NozzleRackCard slots={status.nozzle_rack} filamentInfo={filamentInfo} />}
        </div>

        <div className="mt-2 flex items-center gap-1.5">
          {fanItems.map(({ key, label, value, Icon, activeClass }) => (
            <div key={key} className={`relative flex min-w-0 flex-1 items-center justify-center gap-1 rounded-lg bg-bambu-dark px-2 py-1.5 transition-colors ${canControl ? 'cursor-pointer hover:bg-bambu-dark-tertiary' : 'cursor-default opacity-80'}`} title={canControl ? label : controlTitle} onClick={() => canControl && setControlMenu(controlMenu === `fan-${key}` ? null : `fan-${key}`)}>
              <Icon className={`h-3 w-3 shrink-0 ${value > 0 ? activeClass : 'text-bambu-gray/50'}`} />
              <span className={`text-[10px] leading-none ${value > 0 ? 'text-white' : 'text-bambu-gray/50'}`}>{value}%</span>
              {controlMenu === `fan-${key}` && <IndicatorControlPopover title={t('printers.single.setFanSpeed', { fan: label })} unit="%" customMin={0} customMax={100} isPending={fanSpeedMutation.isPending} options={buildPresetOptions(fanSpeedPresets, '%')} onClose={() => setControlMenu(null)} onSubmit={speed => fanSpeedMutation.mutate({ fan: key, speed })} />}
            </div>
          ))}
        </div>
      </div>

      {heaterHistory && (
        <HeaterHistoryModal isOpen onClose={() => setHeaterHistory(null)} printerId={printer.id} printerName={printer.name} initialKind={heaterHistory.initialKind} availableKinds={heaterHistory.availableKinds} />
      )}
    </>
  );
}

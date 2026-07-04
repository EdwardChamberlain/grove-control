import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { api, type AMSTray, type AMSUnit } from '../../api/client';
import {
  EmptySlotHoverCard,
  FilamentHoverCard,
  type ConfigureSlotConfig,
  type FilamentData,
  type InventoryConfig,
  type SpoolmanConfig,
} from '../FilamentHoverCard';

type AmsCardVariant = 'compact' | 'expanded' | 'ht';

function WaterDropEmpty({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 36 54" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M17.8131 0.00538C18.4463 -0.15091 20.3648 3.14642 20.8264 3.84781C25.4187 10.816 35.3089 26.9368 35.9383 34.8694C37.4182 53.5822 11.882 61.3357 2.53721 45.3789C-1.73471 38.0791 0.016 32.2049 3.178 25.0232C6.99221 16.3662 12.6411 7.90372 17.8131 0.00538ZM18.3738 7.24807L17.5881 7.48441C14.4452 12.9431 10.917 18.2341 8.19369 23.9368C4.6808 31.29 1.18317 38.5479 7.69403 45.5657C17.3058 55.9228 34.9847 46.8808 31.4604 32.8681C29.2558 24.0969 22.4207 15.2913 18.3776 7.24807H18.3738Z" fill="#C3C2C1" /></svg>;
}

function WaterDropHalf({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 35 53" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M17.3165 0.0038C17.932 -0.14959 19.7971 3.08645 20.2458 3.77481C24.7103 10.6135 34.3251 26.4346 34.937 34.2198C36.3757 52.5848 11.5505 60.1942 2.46584 44.534C-1.68714 37.3735 0.0148 31.6085 3.08879 24.5603C6.79681 16.0605 12.2884 7.75907 17.3165 0.0038ZM17.8615 7.11561L17.0977 7.34755C14.0423 12.7048 10.6124 17.8974 7.96483 23.4941C4.54975 30.7107 1.14949 37.8337 7.47908 44.721C16.8233 54.8856 34.01 46.0117 30.5838 32.2595C28.4405 23.6512 21.7957 15.0093 17.8652 7.11561H17.8615Z" fill="#C3C2C1" /><path d="M5.03547 30.112C9.64453 30.4936 11.632 35.7985 16.4154 35.791C19.6339 35.7873 20.2161 33.2283 22.3853 31.6197C31.6776 24.7286 33.5835 37.4894 27.9881 44.4254C18.1878 56.5653 -1.16063 44.6013 5.03917 30.1158L5.03547 30.112Z" fill="#1F8FEB" /></svg>;
}

function WaterDropFull({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 36 54" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M17.9625 4.48059L4.77216 26.3154L2.08228 40.2175L10.0224 50.8414H23.1594L33.3246 42.1693V30.2455L17.9625 4.48059Z" fill="#1F8FEB" /><path d="M17.7948 0.00538C18.4273 -0.15091 20.3438 3.14642 20.8048 3.84781C25.3921 10.816 35.2715 26.9368 35.9001 34.8694C37.3784 53.5822 11.8702 61.3357 2.53562 45.3789C-1.73163 38.0829 0.0134 32.2087 3.1757 25.027C6.98574 16.3662 12.6284 7.90372 17.7948 0.00538ZM18.3549 7.24807L17.57 7.48441C14.4306 12.9431 10.9063 18.2341 8.1859 23.9368C4.67686 31.29 1.18305 38.5479 7.68679 45.5657C17.2881 55.9228 34.9476 46.8808 31.4271 32.8681C29.2249 24.0969 22.3974 15.2913 18.3587 7.24807H18.3549Z" fill="#C3C2C1" /></svg>;
}

function ThermometerEmpty({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 12 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 0.5C4.6 0.5 3.5 1.6 3.5 3V12.1C2.6 12.8 2 13.9 2 15C2 17.2 3.8 19 6 19C8.2 19 10 17.2 10 15C10 13.9 9.4 12.8 8.5 12.1V3C8.5 1.6 7.4 0.5 6 0.5Z" stroke="#C3C2C1" strokeWidth="1" fill="none" /><circle cx="6" cy="15" r="2.5" stroke="#C3C2C1" strokeWidth="1" fill="none" /></svg>;
}

function ThermometerHalf({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 12 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4.5" y="8" width="3" height="4.5" fill="#d4a017" rx="0.5" /><circle cx="6" cy="15" r="2" fill="#d4a017" /><path d="M6 0.5C4.6 0.5 3.5 1.6 3.5 3V12.1C2.6 12.8 2 13.9 2 15C2 17.2 3.8 19 6 19C8.2 19 10 17.2 10 15C10 13.9 9.4 12.8 8.5 12.1V3C8.5 1.6 7.4 0.5 6 0.5Z" stroke="#C3C2C1" strokeWidth="1" fill="none" /></svg>;
}

function ThermometerFull({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 12 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4.5" y="3" width="3" height="9.5" fill="#c62828" rx="0.5" /><circle cx="6" cy="15" r="2" fill="#c62828" /><path d="M6 0.5C4.6 0.5 3.5 1.6 3.5 3V12.1C2.6 12.8 2 13.9 2 15C2 17.2 3.8 19 6 19C8.2 19 10 17.2 10 15C10 13.9 9.4 12.8 8.5 12.1V3C8.5 1.6 7.4 0.5 6 0.5Z" stroke="#C3C2C1" strokeWidth="1" fill="none" /></svg>;
}

function HumidityIndicator({ humidity, goodThreshold = 40, fairThreshold = 60, onClick }: { humidity: number | string; goodThreshold?: number; fairThreshold?: number; onClick?: () => void }) {
  const value = typeof humidity === 'string' ? parseInt(humidity, 10) : humidity;
  const isUnknown = Number.isNaN(value);
  const color = isUnknown ? '#C3C2C1' : value <= goodThreshold ? '#22a352' : value <= fairThreshold ? '#d4a017' : '#c62828';
  const status = isUnknown ? 'Unknown' : value <= goodThreshold ? 'Good' : value <= fairThreshold ? 'Fair' : 'Bad';
  const Drop = isUnknown || value <= goodThreshold ? WaterDropEmpty : value <= fairThreshold ? WaterDropHalf : WaterDropFull;
  return (
    <button type="button" onClick={onClick} className={`flex items-center gap-1 ${onClick ? 'cursor-pointer transition-opacity hover:opacity-80' : ''}`} title={`Humidity: ${value}% - ${status}${onClick ? ' (click for history)' : ''}`}>
      <Drop className="h-3 w-2.5" />
      <span className="text-[10px] font-medium tabular-nums" style={{ color }}>{value}%</span>
    </button>
  );
}

function TemperatureIndicator({ temp, goodThreshold = 28, fairThreshold = 35, onClick }: { temp: number; goodThreshold?: number; fairThreshold?: number; onClick?: () => void }) {
  const color = temp <= goodThreshold ? '#22a352' : temp <= fairThreshold ? '#d4a017' : '#c62828';
  const status = temp <= goodThreshold ? 'Good' : temp <= fairThreshold ? 'Fair' : 'Bad';
  const Thermometer = temp <= goodThreshold ? ThermometerEmpty : temp <= fairThreshold ? ThermometerHalf : ThermometerFull;
  return (
    <button type="button" onClick={onClick} className={`flex items-center gap-1 ${onClick ? 'cursor-pointer transition-opacity hover:opacity-80' : ''}`} title={`Temperature: ${temp}°C - ${status}${onClick ? ' (click for history)' : ''}`}>
      <Thermometer className="h-3 w-2.5" />
      <span className="w-8 text-right text-[10px] tabular-nums" style={{ color }}>{temp}°C</span>
    </button>
  );
}

export interface AmsEnvironmentThresholds {
  humidityGood?: number;
  humidityFair?: number;
  tempGood?: number;
  tempFair?: number;
}

export function AmsEnvironmentIndicators({ ams, thresholds, layout = 'inline', onHumidityClick, onTemperatureClick, testId }: { ams: AMSUnit; thresholds?: AmsEnvironmentThresholds; layout?: 'inline' | 'stacked'; onHumidityClick?: () => void; onTemperatureClick?: () => void; testId?: string }) {
  if (ams.humidity == null && ams.temp == null) return null;
  const humidity = ams.humidity != null ? <HumidityIndicator humidity={ams.humidity} goodThreshold={thresholds?.humidityGood} fairThreshold={thresholds?.humidityFair} onClick={onHumidityClick} /> : null;
  const temperature = ams.temp != null ? <TemperatureIndicator temp={ams.temp} goodThreshold={thresholds?.tempGood} fairThreshold={thresholds?.tempFair} onClick={onTemperatureClick} /> : null;
  return (
    <div data-testid={testId} className={layout === 'stacked' ? 'flex shrink-0 flex-col justify-center gap-1 max-[550px]:w-full' : 'flex shrink-0 items-center gap-1.5'}>
      {layout === 'stacked' ? <>{temperature}{humidity}</> : <>{humidity}{temperature && <div className="mr-1">{temperature}</div>}</>}
    </div>
  );
}

export function AmsUnitHeader({ label, badge, environment, dryingControl, testId, controlsTestId }: { label: ReactNode; badge?: ReactNode; environment?: ReactNode; dryingControl?: ReactNode; testId?: string; controlsTestId?: string }) {
  return (
    <div data-testid={testId} className="flex min-h-7 w-full items-center justify-between gap-2 rounded-lg bg-bambu-dark-secondary px-2 py-1">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{label}{badge}</div>
      {(environment || dryingControl) && <div data-testid={controlsTestId} className="flex shrink-0 items-center gap-1.5">{environment}{dryingControl}</div>}
    </div>
  );
}

export function AmsSlotGrid({ ams, variant, renderSlot }: { ams: AMSUnit; variant: Exclude<AmsCardVariant, 'ht'>; renderSlot: (tray: AMSTray | undefined, slotIndex: number) => ReactNode }) {
  const slotCount = ams.tray.length === 1 ? 1 : 4;
  const className = variant === 'expanded'
    ? 'grid w-full grid-cols-[repeat(4,minmax(3.5rem,1fr))] gap-1'
    : `grid gap-1 ${slotCount === 1 ? 'grid-cols-1' : 'grid-cols-4'}`;
  return <div className={className}>{Array.from({ length: slotCount }, (_, index) => renderSlot(ams.tray[index] || ams.tray.find(tray => tray.id === index), index))}</div>;
}

export function AmsSlotControl({
  children,
  filament,
  emptyKind,
  actions,
  spoolman,
  inventory,
  configureSlot,
  onAssignSpool,
}: {
  children: ReactNode;
  filament?: FilamentData | null;
  emptyKind?: 'physical' | 'reset' | null;
  actions?: ReactNode;
  spoolman?: SpoolmanConfig;
  inventory?: InventoryConfig;
  configureSlot?: ConfigureSlotConfig;
  onAssignSpool?: () => void;
}) {
  return (
    <div data-testid="ams-slot-control">
      {filament ? (
        <FilamentHoverCard data={filament} actions={actions} spoolman={spoolman} inventory={inventory} configureSlot={configureSlot}>
          {children}
        </FilamentHoverCard>
      ) : (
        <EmptySlotHoverCard kind={emptyKind ?? undefined} actions={actions} configureSlot={configureSlot} onAssignSpool={onAssignSpool}>
          {children}
        </EmptySlotHoverCard>
      )}
    </div>
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
  ams: AMSUnit;
  printerId: number;
  label: string;           // auto-generated label, e.g. "AMS-A"
  amsLabels?: Record<number, string>;
  canEdit: boolean;
  onSaved: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [isVisible, setIsVisible] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
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
    }
  }, [isVisible, amsLabels, ams.id]);
  useLayoutEffect(() => {
    if (!isVisible) {
      setCoords(null);
      return;
    }
    const compute = () => {
      if (!triggerRef.current || !cardRef.current) return;
      const triggerRect = triggerRef.current.getBoundingClientRect();
      const cardRect = cardRef.current.getBoundingClientRect();
      const spaceAbove = triggerRect.top - 56;
      const showBelow = spaceAbove < cardRect.height + 12 && window.innerHeight - triggerRect.bottom > spaceAbove;
      setCoords({
        top: showBelow ? triggerRect.bottom + 8 : triggerRect.top - cardRect.height - 8,
        left: Math.max(8, Math.min(triggerRect.left, window.innerWidth - cardRect.width - 8)),
      });
    };
    compute();
    const frame = requestAnimationFrame(compute);
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [isVisible]);

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

      {isVisible && createPortal(
        <div
          ref={cardRef}
          className="fixed z-[60] animate-in fade-in-0 zoom-in-95 duration-150"
          style={{ top: coords?.top ?? -9999, left: coords?.left ?? -9999, maxWidth: 'calc(100vw - 24px)', visibility: coords ? 'visible' : 'hidden' }}
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
        </div>,
        document.body,
      )}
    </div>
  );
}

function AmsCardLayout({ amsId, variant, style, children }: { amsId: number; variant: AmsCardVariant; style?: CSSProperties; children: ReactNode }) {
  const variantClass = variant === 'compact' ? 'min-w-[15rem] flex-1 rounded-lg' : 'min-w-0 rounded-[10px] space-y-1';
  return <div data-testid={`ams-unit-card-${variant}-${amsId}`} style={style} className={`${variantClass} bg-bambu-dark p-2`}>{children}</div>;
}

export function CompactAmsUnitCard(props: Omit<Parameters<typeof AmsCardLayout>[0], 'variant'>) {
  return <AmsCardLayout {...props} variant="compact" />;
}

export function ExpandedAmsUnitCard(props: Omit<Parameters<typeof AmsCardLayout>[0], 'variant'>) {
  return <AmsCardLayout {...props} variant="expanded" />;
}

export function HtAmsUnitCard(props: Omit<Parameters<typeof AmsCardLayout>[0], 'variant'>) {
  return <AmsCardLayout {...props} variant="ht" />;
}

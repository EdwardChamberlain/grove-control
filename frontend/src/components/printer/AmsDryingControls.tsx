import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Flame, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { AMSUnit } from '../../api/client';
import { getAmsLabel } from '../../utils/amsHelpers';
import type { AmsDryingController } from '../../hooks/useAmsDryingControls';

export function AmsDryingControl({
  ams,
  supportsDrying,
  canControl,
  controller,
}: {
  ams: AMSUnit;
  supportsDrying: boolean;
  canControl: boolean;
  controller: AmsDryingController;
}) {
  const { t } = useTranslation();
  if (!supportsDrying || !['n3f', 'n3s'].includes(ams.module_type) || !canControl) return null;

  return (
    <button
      type="button"
      disabled={!!(ams.dry_sf_reason?.length && ams.dry_time === 0) || controller.isStopping}
      onClick={(event) => {
        event.stopPropagation();
        controller.toggle(ams, event.currentTarget);
      }}
      className={`ml-1 flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] transition-colors disabled:cursor-not-allowed ${
        ams.dry_time > 0
          ? 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30'
          : ams.dry_sf_reason?.length
            ? 'bg-bambu-dark text-bambu-gray/50'
            : 'bg-bambu-dark text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white'
      }`}
      title={ams.dry_time > 0 ? t('printers.drying.stop') : ams.dry_sf_reason?.length ? t('printers.drying.powerRequired') : t('printers.drying.start')}
      aria-label={`${getAmsLabel(ams.id, ams.tray.length)}: ${ams.dry_time > 0 ? t('printers.drying.stop') : t('printers.drying.start')}`}
    >
      <Flame className="h-3 w-3" />
    </button>
  );
}

// Compatibility alias for callers outside the composed AMS card implementation.
export const AmsDryingButton = AmsDryingControl;

export function AmsDryingStatus({ ams, controller, canControl }: { ams: AMSUnit; controller: AmsDryingController; canControl: boolean }) {
  const { t } = useTranslation();
  if (ams.dry_time <= 0) return null;

  const remaining = ams.dry_time >= 60
    ? `${Math.floor(ams.dry_time / 60)}h ${ams.dry_time % 60}m`
    : `${ams.dry_time}m`;

  return (
    <div className="flex items-center gap-2 rounded-lg bg-amber-500/10 px-2 py-1 text-[9px]">
      <Flame className="h-3 w-3 shrink-0 text-amber-400" />
      <span className="font-medium text-amber-400">{t('printers.drying.active')}</span>
      {ams.dry_filament && ams.dry_target_temp != null && (
        <span className="truncate text-amber-300/70">
          {t('printers.drying.targetSummary', { filament: ams.dry_filament, temp: ams.dry_target_temp })}
        </span>
      )}
      <span className="shrink-0 text-amber-300/70">
        {t('printers.drying.timeRemaining', { time: remaining })}
      </span>
      {canControl && (
        <button
          type="button"
          onClick={() => controller.stop(ams.id)}
          disabled={controller.isStopping}
          className="ml-auto text-amber-400 transition-colors hover:text-amber-300 disabled:opacity-50"
          title={t('printers.drying.stop')}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function DryingFilamentDropdown({ controller }: { controller: AmsDryingController }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div className="relative w-full min-w-0">
      <button
        type="button"
        onClick={() => setIsOpen(open => !open)}
        className="flex h-8 w-full items-center justify-between gap-2 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-2 text-sm font-medium text-white transition-colors hover:bg-bambu-dark-tertiary focus:border-bambu-green focus:outline-none"
      >
        <span className="truncate">{controller.filament}</span>
        <ChevronDown className={`h-4 w-4 text-bambu-gray transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {isOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
          <div className="absolute left-0 top-full z-20 mt-1 min-w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary py-1 shadow-xl">
            {Object.keys(controller.presets).map(option => (
              <button
                key={option}
                type="button"
                onClick={() => {
                  controller.setFilament(option);
                  setIsOpen(false);
                }}
                className={`w-full px-3 py-2 text-left text-sm transition-colors hover:bg-bambu-dark-tertiary ${option === controller.filament ? 'text-bambu-green' : 'text-white'}`}
              >
                {option}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function AmsDryingPopover({ controller }: { controller: AmsDryingController }) {
  const { t } = useTranslation();
  if (controller.activeAmsId == null || !controller.position) return null;
  const maxTemp = controller.moduleType === 'n3s' ? 85 : 65;
  const popover = (
    <>
      <div className="fixed inset-0 z-[100]" onClick={controller.close} />
      <div
        role="dialog"
        aria-label={t('printers.drying.start')}
        className="fixed z-[101] flex w-[240px] flex-col overflow-hidden rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-2xl"
        style={{
          top: controller.position.top,
          left: controller.position.left,
          maxHeight: `calc(100dvh - ${controller.position.top}px - 8px)`,
        }}
        onClick={event => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-center gap-2 px-3 py-2.5">
          <Flame className="h-3.5 w-3.5 text-bambu-green" />
          <span className="text-sm font-medium text-white">{t('printers.drying.start')}</span>
        </div>
        <div className="h-px shrink-0 bg-bambu-dark-tertiary" />
        <div className="min-h-0 space-y-2.5 overflow-y-auto px-3 py-2.5">
          <div>
            <label className="mb-1 block text-[10px] font-medium text-white/70">{t('printers.filaments')}</label>
            <DryingFilamentDropdown controller={controller} />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label htmlFor="ams-drying-temperature" className="text-[10px] font-medium text-white/70">{t('printers.drying.temperature')}</label>
              <div className="flex items-center gap-1">
                <input
                  id="ams-drying-temperature"
                  type="number"
                  min={45}
                  max={maxTemp}
                  value={controller.temperature}
                  onChange={event => controller.setTemperature(Math.min(maxTemp, Math.max(45, Number(event.target.value) || 45)))}
                  className="w-12 rounded border border-bambu-dark-tertiary bg-bambu-dark px-1 py-0.5 text-center text-[11px] text-white focus:border-bambu-green focus:outline-none"
                />
                <span className="text-[10px] text-bambu-gray">°C</span>
              </div>
            </div>
            <input type="range" min={45} max={maxTemp} value={controller.temperature} onChange={event => controller.setTemperature(Number(event.target.value))} className="h-1 w-full cursor-pointer accent-bambu-green" />
            <div className="mt-0.5 flex justify-between text-[9px] text-bambu-gray/50"><span>45°C</span><span>{maxTemp}°C</span></div>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label htmlFor="ams-drying-duration" className="text-[10px] font-medium text-white/70">{t('printers.drying.duration')}</label>
              <div className="flex items-center gap-1">
                <input
                  id="ams-drying-duration"
                  type="number"
                  min={1}
                  max={24}
                  value={controller.duration}
                  onChange={event => controller.setDuration(Math.min(24, Math.max(1, Number(event.target.value) || 1)))}
                  className="w-10 rounded border border-bambu-dark-tertiary bg-bambu-dark px-1 py-0.5 text-center text-[11px] text-white focus:border-bambu-green focus:outline-none"
                />
                <span className="text-[10px] text-bambu-gray">{t('printers.drying.hours')}</span>
              </div>
            </div>
            <input type="range" min={1} max={24} value={controller.duration} onChange={event => controller.setDuration(Number(event.target.value))} className="h-1 w-full cursor-pointer accent-bambu-green" />
            <div className="mt-0.5 flex justify-between text-[9px] text-bambu-gray/50"><span>1h</span><span>24h</span></div>
          </div>
          <button
            type="button"
            onClick={controller.toggleRotateTray}
            aria-pressed={controller.rotateTray && !controller.trayLoaded}
            disabled={controller.trayLoaded}
            title={controller.trayLoaded ? t('printers.drying.rotateUnavailableReason') : undefined}
            className={`h-8 w-full rounded-lg border px-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              controller.rotateTray && !controller.trayLoaded
                ? 'border-bambu-green bg-bambu-green text-white'
                : 'border-bambu-dark-tertiary bg-bambu-dark text-white hover:bg-bambu-dark-tertiary'
            }`}
          >
            {t('printers.drying.rotateTray')}
          </button>
        </div>
        <div className="h-px shrink-0 bg-bambu-dark-tertiary" />
        <div className="shrink-0 px-3 pb-3 pt-2.5">
          <button
            type="button"
            onClick={controller.start}
            disabled={controller.isStarting}
            className="w-full rounded-lg bg-bambu-green py-1.5 text-xs font-medium text-white transition-colors hover:bg-bambu-green/80 disabled:opacity-50"
          >
            {controller.isStarting ? t('printers.drying.startingDrying') : t('printers.drying.start')}
          </button>
        </div>
      </div>
    </>
  );
  return createPortal(popover, document.body);
}

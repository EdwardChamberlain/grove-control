import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { api } from '../api/client';
import type { AMSUnit } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { computePopoverPosition } from '../utils/popoverPosition';

const DRYING_POPOVER_WIDTH = 240;
const DRYING_POPOVER_ESTIMATED_HEIGHT = 320;

export type DryingPreset = {
  n3f: number;
  n3s: number;
  n3f_hours: number;
  n3s_hours: number;
};

export type DryingPresets = Record<string, DryingPreset>;

export const DRYING_PRESETS: DryingPresets = {
  PLA:  { n3f: 45, n3s: 45, n3f_hours: 12, n3s_hours: 12 },
  PETG: { n3f: 65, n3s: 65, n3f_hours: 12, n3s_hours: 12 },
  TPU:  { n3f: 65, n3s: 75, n3f_hours: 12, n3s_hours: 18 },
  ABS:  { n3f: 65, n3s: 80, n3f_hours: 12, n3s_hours: 8 },
  ASA:  { n3f: 65, n3s: 80, n3f_hours: 12, n3s_hours: 8 },
  PA:   { n3f: 65, n3s: 85, n3f_hours: 12, n3s_hours: 12 },
  PC:   { n3f: 65, n3s: 80, n3f_hours: 12, n3s_hours: 8 },
  PVA:  { n3f: 65, n3s: 85, n3f_hours: 12, n3s_hours: 18 },
};

export interface AmsDryingController {
  activeAmsId: number | null;
  moduleType: 'n3f' | 'n3s';
  filament: string;
  temperature: number;
  duration: number;
  rotateTray: boolean;
  position: { top: number; left: number } | null;
  targetAms?: AMSUnit;
  trayLoaded: boolean;
  isStarting: boolean;
  isStopping: boolean;
  presets: DryingPresets;
  toggle: (ams: AMSUnit, trigger: HTMLElement) => void;
  stop: (amsId: number) => void;
  close: () => void;
  setFilament: (filament: string) => void;
  setTemperature: (temperature: number) => void;
  setDuration: (duration: number) => void;
  toggleRotateTray: () => void;
  start: () => void;
}

export function useAmsDryingControls({
  printerId,
  amsUnits,
  presets = DRYING_PRESETS,
}: {
  printerId: number;
  amsUnits: AMSUnit[];
  presets?: DryingPresets;
}): AmsDryingController {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [activeAmsId, setActiveAmsId] = useState<number | null>(null);
  const [moduleType, setModuleType] = useState<'n3f' | 'n3s'>('n3f');
  const [filament, setFilamentState] = useState('PLA');
  const [temperature, setTemperature] = useState(45);
  const [duration, setDuration] = useState(12);
  const [rotateTray, setRotateTray] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    setActiveAmsId(null);
    setPosition(null);
  }, [printerId]);

  const invalidateStatus = () => queryClient.invalidateQueries({ queryKey: ['printerStatus', printerId] });
  const startMutation = useMutation({
    mutationFn: ({ amsId, temp, hours, material, rotate }: { amsId: number; temp: number; hours: number; material: string; rotate: boolean }) =>
      api.startDrying(printerId, amsId, temp, hours, material, rotate),
    onSuccess: () => {
      setActiveAmsId(null);
      invalidateStatus();
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });
  const stopMutation = useMutation({
    mutationFn: (amsId: number) => api.stopDrying(printerId, amsId),
    onSuccess: invalidateStatus,
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });

  const targetAms = activeAmsId == null ? undefined : amsUnits.find(ams => ams.id === activeAmsId);
  const trayLoaded = (targetAms?.tray ?? []).some(tray => tray.state === 11);

  const setFilament = (nextFilament: string) => {
    setFilamentState(nextFilament);
    const preset = presets[nextFilament];
    if (preset) {
      setTemperature(preset[moduleType]);
      setDuration(moduleType === 'n3s' ? preset.n3s_hours : preset.n3f_hours);
    }
  };

  return {
    activeAmsId,
    moduleType,
    filament,
    temperature,
    duration,
    rotateTray,
    position,
    targetAms,
    trayLoaded,
    isStarting: startMutation.isPending,
    isStopping: stopMutation.isPending,
    presets,
    toggle: (ams, trigger) => {
      if (ams.dry_time > 0) {
        stopMutation.mutate(ams.id);
        return;
      }
      if (activeAmsId === ams.id) {
        setActiveAmsId(null);
        return;
      }
      const firstTray = ams.tray.find(tray => tray.tray_type);
      const nextFilament = (firstTray?.tray_type || 'PLA').split(' ')[0].toUpperCase();
      const nextModuleType = ams.module_type === 'n3s' ? 'n3s' : 'n3f';
      const preset = presets[nextFilament] || presets.PLA;
      setFilamentState(nextFilament);
      setTemperature(preset[nextModuleType]);
      setDuration(nextModuleType === 'n3s' ? preset.n3s_hours : preset.n3f_hours);
      setRotateTray(false);
      setModuleType(nextModuleType);
      setActiveAmsId(ams.id);
      setPosition(computePopoverPosition({
        triggerRect: trigger.getBoundingClientRect(),
        popoverWidth: DRYING_POPOVER_WIDTH,
        estimatedHeight: DRYING_POPOVER_ESTIMATED_HEIGHT,
        horizontalAlign: 'center',
      }));
    },
    stop: (amsId) => stopMutation.mutate(amsId),
    close: () => setActiveAmsId(null),
    setFilament,
    setTemperature,
    setDuration,
    toggleRotateTray: () => setRotateTray(enabled => !enabled),
    start: () => {
      if (activeAmsId == null) return;
      startMutation.mutate({
        amsId: activeAmsId,
        temp: temperature,
        hours: duration,
        material: filament,
        rotate: rotateTray && !trayLoaded,
      });
    },
  };
}

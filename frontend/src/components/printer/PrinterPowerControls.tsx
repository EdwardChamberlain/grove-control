import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Home, Play, Power, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../api/client';
import type { Printer, SmartPlug } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { ConfirmModal } from '../ConfirmModal';

interface PrinterPowerControlsProps {
  printer: Pick<Printer, 'id' | 'name'>;
  isPrintingOrPaused: boolean;
  className?: string;
}

export function PrinterPowerControls({
  printer,
  isPrintingOrPaused,
  className = '',
}: PrinterPowerControlsProps) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [showPowerOnConfirm, setShowPowerOnConfirm] = useState(false);
  const [showPowerOffConfirm, setShowPowerOffConfirm] = useState(false);
  const [haToggleConfirm, setHaToggleConfirm] = useState<SmartPlug | null>(null);

  const { data: smartPlug } = useQuery({
    queryKey: ['smartPlugByPrinter', printer.id],
    queryFn: () => api.getSmartPlugByPrinter(printer.id),
    // Older servers returned [] rather than null when no socket was assigned.
    select: (plug) => Array.isArray(plug) ? null : plug,
  });
  const { data: scriptPlugs } = useQuery({
    queryKey: ['scriptPlugsByPrinter', printer.id],
    queryFn: () => api.getScriptPlugsByPrinter(printer.id),
  });
  const { data: plugStatus } = useQuery({
    queryKey: ['smartPlugStatus', smartPlug?.id],
    queryFn: () => smartPlug ? api.getSmartPlugStatus(smartPlug.id) : null,
    enabled: !!smartPlug,
    refetchInterval: 10000,
  });

  const powerControlMutation = useMutation({
    mutationFn: (action: 'on' | 'off') => smartPlug
      ? api.controlSmartPlug(smartPlug.id, action)
      : Promise.reject(new Error('No power socket is assigned')),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['smartPlugStatus', smartPlug?.id] }),
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });
  const toggleAutoOffMutation = useMutation({
    mutationFn: (enabled: boolean) => smartPlug
      ? api.updateSmartPlug(smartPlug.id, { auto_off: enabled })
      : Promise.reject(new Error('No power socket is assigned')),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['smartPlugByPrinter', printer.id] });
      queryClient.invalidateQueries({ queryKey: ['smart-plugs'] });
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToSendCommand'), 'error'),
  });
  const runScriptMutation = useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'on' | 'toggle' }) => api.controlSmartPlug(id, action),
    onSuccess: () => showToast(t('printers.toast.scriptTriggered')),
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToRunScript'), 'error'),
  });

  if (!smartPlug) return null;

  return (
    <>
      <section className={className}>
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-bambu-gray">
            {t('printers.power', 'Power')}
          </span>
          <div className="h-[2px] flex-1 bg-bambu-dark-tertiary" />
        </div>
        <div data-testid="printer-power-controls" className="flex items-center gap-2 rounded-[10px] bg-bambu-dark p-2">
          <Zap className="h-4 w-4 shrink-0 text-bambu-gray" />
          <span className="min-w-0 truncate text-sm text-white">{smartPlug.name}</span>
          <span
            className="shrink-0 rounded-full bg-bambu-dark-tertiary px-1.5 py-0.5 text-[10px] font-medium text-bambu-gray"
            title={t('smartPlugs.power')}
          >
            {plugStatus?.energy?.power != null ? `${Math.round(plugStatus.energy.power)}W` : '--'}
          </span>
          <div className="flex-1" />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => toggleAutoOffMutation.mutate(!smartPlug.auto_off)}
              disabled={toggleAutoOffMutation.isPending || smartPlug.auto_off_executed || !hasPermission('smart_plugs:control')}
              title={!hasPermission('smart_plugs:control') ? t('printers.permission.noSmartPlugControl') : (smartPlug.auto_off_executed ? t('printers.autoOffExecuted') : t('printers.autoOffAfterPrint'))}
              aria-label={t('printers.autoOffAfterPrint')}
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                smartPlug.auto_off || smartPlug.auto_off_executed
                  ? 'bg-bambu-green/20 text-bambu-green hover:bg-bambu-green/30'
                  : 'bg-bambu-dark-tertiary text-bambu-gray hover:bg-bambu-dark-tertiary/80 hover:text-white'
              }`}
            >
              <Clock className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => plugStatus?.state === 'ON' ? setShowPowerOffConfirm(true) : setShowPowerOnConfirm(true)}
              disabled={powerControlMutation.isPending || !hasPermission('smart_plugs:control')}
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                plugStatus?.state === 'ON'
                  ? 'bg-bambu-green/20 text-bambu-green hover:bg-bambu-green/30'
                  : 'bg-bambu-dark-tertiary text-bambu-gray hover:bg-bambu-dark-tertiary/80 hover:text-white'
              }`}
              title={!hasPermission('smart_plugs:control') ? t('printers.permission.noSmartPlugControl') : (plugStatus?.state === 'ON' ? t('common.turnOff', 'Turn off') : t('common.turnOn', 'Turn on'))}
              aria-label={`${smartPlug.name}: ${plugStatus?.state === 'ON' ? t('common.turnOff', 'Turn off') : t('common.turnOn', 'Turn on')}`}
            >
              <Power className="h-4 w-4" />
            </button>
          </div>
        </div>

        {scriptPlugs && scriptPlugs.length > 0 && (
          <div className="mt-2 flex items-center gap-2">
            <Home className="h-3.5 w-3.5 shrink-0 text-blue-400" />
            <span className="text-xs text-bambu-gray">HA:</span>
            <div className="h-[2px] w-5 bg-bambu-dark-tertiary/50" />
            <div className="flex flex-wrap gap-1">
              {scriptPlugs.map(script => {
                const isScript = script.ha_entity_id?.startsWith('script.');
                return (
                  <button
                    key={script.id}
                    type="button"
                    onClick={() => isScript
                      ? runScriptMutation.mutate({ id: script.id, action: 'on' })
                      : setHaToggleConfirm(script)}
                    disabled={runScriptMutation.isPending || !hasPermission('smart_plugs:control')}
                    title={`${isScript ? 'Run' : 'Toggle'} ${script.ha_entity_id}`}
                    className="flex items-center gap-1 rounded bg-blue-500/20 px-2 py-0.5 text-xs text-blue-400 transition-colors hover:bg-blue-500/30 disabled:opacity-50"
                  >
                    <Play className="h-2.5 w-2.5" />
                    {script.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </section>

      {showPowerOnConfirm && (
        <ConfirmModal
          title={t('printers.confirm.powerOnTitle')}
          message={t('printers.confirm.powerOnMessage', { name: printer.name })}
          confirmText={t('printers.confirm.powerOnButton')}
          variant="default"
          onConfirm={() => {
            powerControlMutation.mutate('on');
            setShowPowerOnConfirm(false);
          }}
          onCancel={() => setShowPowerOnConfirm(false)}
        />
      )}
      {showPowerOffConfirm && (
        <ConfirmModal
          title={t('printers.confirm.powerOffTitle')}
          message={isPrintingOrPaused
            ? t('printers.confirm.powerOffWarning', { name: printer.name })
            : t('printers.confirm.powerOffMessage', { name: printer.name })}
          confirmText={t('printers.confirm.powerOffButton')}
          variant="danger"
          onConfirm={() => {
            powerControlMutation.mutate('off');
            setShowPowerOffConfirm(false);
          }}
          onCancel={() => setShowPowerOffConfirm(false)}
        />
      )}
      {haToggleConfirm && (
        <ConfirmModal
          title={t('printers.confirm.haToggleTitle', { name: haToggleConfirm.name })}
          message={isPrintingOrPaused
            ? t('printers.confirm.haToggleWarning', { name: printer.name, entity: haToggleConfirm.ha_entity_id || haToggleConfirm.name })
            : t('printers.confirm.haToggleMessage', { entity: haToggleConfirm.ha_entity_id || haToggleConfirm.name })}
          confirmText={t('printers.confirm.haToggleButton')}
          variant={isPrintingOrPaused ? 'danger' : 'default'}
          onConfirm={() => {
            runScriptMutation.mutate({ id: haToggleConfirm.id, action: 'toggle' });
            setHaToggleConfirm(null);
          }}
          onCancel={() => setHaToggleConfirm(null)}
        />
      )}
    </>
  );
}

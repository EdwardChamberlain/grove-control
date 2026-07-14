import { useTranslation } from 'react-i18next';
import { Hand, Power, Code, ListOrdered } from 'lucide-react';
import type { ScheduleOptionsProps } from './types';

/**
 * Queue options component for queue items.
 */
export function ScheduleOptionsPanel({
  options,
  onChange,
  canControlPrinter = true,
  hasGcodeSnippets = false,
}: ScheduleOptionsProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <label className="flex items-start gap-3 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-3 cursor-pointer select-none">
        <input
          type="checkbox"
          id="insertAtTop"
          checked={options.insertAtTop}
          onChange={(e) => onChange({ ...options, insertAtTop: e.target.checked })}
          className="accent-bambu-green w-4 h-4 mt-0.5"
        />
        <ListOrdered className="w-4 h-4 mt-0.5 text-bambu-gray flex-shrink-0" />
        <span className="text-sm text-white">{t('printModal.insertAtTop', 'Insert at top of queue')}</span>
      </label>

      {/* Manual start */}
      <label className="flex items-start gap-3 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-3 cursor-pointer select-none">
        <input
          type="checkbox"
          id="requireManualStart"
          checked={options.requireManualStart}
          onChange={(e) => onChange({ ...options, requireManualStart: e.target.checked })}
          className="accent-bambu-green w-4 h-4 mt-0.5"
        />
        <Hand className="w-4 h-4 mt-0.5 text-bambu-gray flex-shrink-0" />
        <span className="text-sm text-white">{t('printModal.requireManualStart')}</span>
      </label>

      {/* Require previous success */}
      <label className="flex items-start gap-3 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-3 cursor-pointer select-none">
        <input
          type="checkbox"
          id="requirePrevious"
          checked={options.requirePreviousSuccess}
          onChange={(e) => onChange({ ...options, requirePreviousSuccess: e.target.checked })}
          className="accent-bambu-green w-4 h-4 mt-0.5"
        />
        <ListOrdered className="w-4 h-4 mt-0.5 text-bambu-gray flex-shrink-0" />
        <span className="text-sm text-white">{t('printModal.requirePreviousSuccess')}</span>
      </label>

      {/* Auto power off */}
      <label className={`flex items-start gap-3 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-3 select-none ${canControlPrinter ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
        <input
          type="checkbox"
          id="autoOffAfter"
          checked={options.autoOffAfter}
          onChange={(e) => onChange({ ...options, autoOffAfter: e.target.checked })}
          disabled={!canControlPrinter}
          className="accent-bambu-green w-4 h-4 mt-0.5"
        />
        <Power className="w-4 h-4 mt-0.5 text-bambu-gray flex-shrink-0" />
        <span className="text-sm text-white">{t('printModal.autoOffAfter')}</span>
      </label>

      {/* G-code injection */}
      {hasGcodeSnippets && (
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="gcodeInjection"
            checked={options.gcodeInjection}
            onChange={(e) => onChange({ ...options, gcodeInjection: e.target.checked })}
            className="rounded border-bambu-dark-tertiary bg-bambu-dark text-bambu-green focus:ring-bambu-green"
          />
          <label htmlFor="gcodeInjection" className="text-sm flex items-center gap-1 text-bambu-gray">
            <Code className="w-3.5 h-3.5" />
            {t('printModal.gcodeInjection', 'Inject auto-print G-code')}
          </label>
        </div>
      )}


      {/* Help text */}
      <p className="text-xs text-bambu-gray">
        {t('printModal.helpQueue')}
      </p>
    </div>
  );
}

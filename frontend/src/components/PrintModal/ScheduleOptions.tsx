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
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="insertAtTop"
          checked={options.insertAtTop}
          onChange={(e) => onChange({ ...options, insertAtTop: e.target.checked })}
          className="rounded border-bambu-dark-tertiary bg-bambu-dark text-bambu-green focus:ring-bambu-green"
        />
        <label htmlFor="insertAtTop" className="text-sm flex items-center gap-1 text-bambu-gray">
          <ListOrdered className="w-3.5 h-3.5" />
          {t('printModal.insertAtTop', 'Insert at top of queue')}
        </label>
      </div>

      {/* Manual start */}
      <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="requireManualStart"
            checked={options.requireManualStart}
            onChange={(e) => onChange({ ...options, requireManualStart: e.target.checked })}
            className="rounded border-bambu-dark-tertiary bg-bambu-dark text-bambu-green focus:ring-bambu-green"
          />
          <label htmlFor="requireManualStart" className="text-sm flex items-center gap-1 text-bambu-gray">
            <Hand className="w-3.5 h-3.5" />
            {t('printModal.requireManualStart')}
          </label>
      </div>

      {/* Require previous success */}
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="requirePrevious"
          checked={options.requirePreviousSuccess}
          onChange={(e) => onChange({ ...options, requirePreviousSuccess: e.target.checked })}
          className="rounded border-bambu-dark-tertiary bg-bambu-dark text-bambu-green focus:ring-bambu-green"
        />
        <label htmlFor="requirePrevious" className="text-sm text-bambu-gray">
          {t('printModal.requirePreviousSuccess')}
        </label>
      </div>

      {/* Auto power off */}
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="autoOffAfter"
          checked={options.autoOffAfter}
          onChange={(e) => onChange({ ...options, autoOffAfter: e.target.checked })}
          disabled={!canControlPrinter}
          className="rounded border-bambu-dark-tertiary bg-bambu-dark text-bambu-green focus:ring-bambu-green disabled:opacity-50"
        />
        <label htmlFor="autoOffAfter" className={`text-sm flex items-center gap-1 ${canControlPrinter ? 'text-bambu-gray' : 'text-bambu-gray/50'}`}>
          <Power className="w-3.5 h-3.5" />
          {t('printModal.autoOffAfter')}
        </label>
      </div>

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

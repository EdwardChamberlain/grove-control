import { useState } from 'react';
import { ChevronDown, ChevronUp, ListOrdered } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ScheduleOptionsProps, ScheduleOptions } from './types';

type QueueOptionConfig = {
  key: keyof ScheduleOptions;
  label: string;
  disabled?: boolean;
};

/** Collapsible queue behavior controls for a print job. */
export function ScheduleOptionsPanel({
  options,
  onChange,
  canControlPrinter = true,
  hasGcodeSnippets = false,
}: ScheduleOptionsProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);
  const controls: QueueOptionConfig[] = [
    { key: 'insertAtTop', label: t('printModal.insertAtTop', 'Insert at top of queue') },
    { key: 'requireManualStart', label: t('printModal.requireManualStart') },
    { key: 'requirePreviousSuccess', label: t('printModal.requirePreviousSuccess') },
    { key: 'autoOffAfter', label: t('printModal.autoOffAfter'), disabled: !canControlPrinter },
    ...(hasGcodeSnippets ? [{ key: 'gcodeInjection' as const, label: t('printModal.gcodeInjection', 'Inject auto-print G-code') }] : []),
  ];

  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 text-sm text-bambu-gray hover:text-white transition-colors w-full"
      >
        <ListOrdered className="w-4 h-4" />
        <span>{t('printModal.queueOptions', 'Queue options')}</span>
        {isExpanded ? <ChevronUp className="w-4 h-4 ml-auto" /> : <ChevronDown className="w-4 h-4 ml-auto" />}
      </button>
      {isExpanded && (
        <div className="mt-2 bg-bambu-dark rounded-lg p-3 space-y-2">
          {controls.map(({ key, label, disabled }) => (
            <label key={key} className={`flex items-center justify-between ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer group'}`}>
              <span className="text-sm text-white">{label}</span>
              <input
                type="checkbox"
                checked={options[key]}
                onChange={() => !disabled && onChange({ ...options, [key]: !options[key] })}
                disabled={disabled}
                className="peer sr-only"
              />
              <div className={`relative w-10 h-5 rounded-full transition-colors ${options[key] ? 'bg-bambu-green' : 'bg-bambu-dark-tertiary'}`}>
                <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${options[key] ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </div>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

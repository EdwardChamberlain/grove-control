import { useEffect, useRef, useState } from 'react';
import { Calendar, ChevronDown, ChevronUp, ListOrdered } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ScheduleOptions, ScheduleOptionsProps } from './types';
import {
  formatDateInput,
  formatTimeInput,
  getDatePlaceholder,
  getTimePlaceholder,
  parseDateInput,
  parseTimeInput,
  toDateTimeLocalValue,
  type DateFormat,
  type TimeFormat,
} from '../../utils/date';

type ToggleKey = Exclude<keyof ScheduleOptions, 'scheduledTime'>;

/** Collapsible queue controls, including an optional do-not-start-before time. */
export function ScheduleOptionsPanel({
  options,
  onChange,
  dateFormat = 'system',
  timeFormat = 'system',
  canControlPrinter = true,
  canInsertAtTop = false,
  showAutoOff = false,
  hasGcodeSnippets = false,
}: ScheduleOptionsProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);
  const [dateValue, setDateValue] = useState('');
  const [timeValue, setTimeValue] = useState('');
  const [isDateValid, setIsDateValid] = useState(true);
  const [isTimeValid, setIsTimeValid] = useState(true);
  const hiddenInputRef = useRef<HTMLInputElement>(null);
  const isInitializedRef = useRef(false);

  const controls: Array<{ key: ToggleKey; label: string; disabled?: boolean }> = [
    ...(canInsertAtTop ? [{ key: 'insertAtTop' as const, label: t('printModal.insertAtTop', 'Insert at top of queue') }] : []),
    { key: 'postponePrint', label: t('printModal.postponePrint', 'Postpone print') },
    { key: 'requireManualStart', label: t('printModal.requireManualStart') },
    { key: 'requirePreviousSuccess', label: t('printModal.requirePreviousSuccess') },
    ...(showAutoOff ? [{ key: 'autoOffAfter' as const, label: t('printModal.autoOffAfter'), disabled: !canControlPrinter }] : []),
    ...(hasGcodeSnippets ? [{ key: 'gcodeInjection' as const, label: t('printModal.gcodeInjection', 'Inject auto-print G-code') }] : []),
  ];

  useEffect(() => {
    if (!options.postponePrint) {
      isInitializedRef.current = false;
      return;
    }
    if (isInitializedRef.current) return;
    isInitializedRef.current = true;

    let date = options.scheduledTime ? new Date(options.scheduledTime) : new Date();
    if (Number.isNaN(date.getTime()) || !options.scheduledTime) {
      date = new Date();
      date.setHours(date.getHours() + 1, 0, 0, 0);
      onChange({ ...options, scheduledTime: toDateTimeLocalValue(date) });
    }
    setDateValue(formatDateInput(date, dateFormat as DateFormat));
    setTimeValue(formatTimeInput(date, timeFormat as TimeFormat));
    setIsDateValid(true);
    setIsTimeValid(true);
  }, [dateFormat, onChange, options, options.postponePrint, options.scheduledTime, timeFormat]);

  const updateScheduledTime = (nextDate: string, nextTime: string) => {
    const parsedDate = parseDateInput(nextDate, dateFormat as DateFormat);
    const parsedTime = parseTimeInput(nextTime);
    setIsDateValid(!!parsedDate);
    setIsTimeValid(!!parsedTime);
    if (!parsedDate || !parsedTime) return;
    parsedDate.setHours(parsedTime.hours, parsedTime.minutes, 0, 0);
    if (parsedDate > new Date()) onChange({ ...options, scheduledTime: toDateTimeLocalValue(parsedDate) });
  };

  return (
    <div className="mb-4">
      <button type="button" onClick={() => setIsExpanded(!isExpanded)} className="flex w-full items-center gap-2 text-sm text-bambu-gray transition-colors hover:text-white">
        <ListOrdered className="w-4 h-4" />
        <span>{t('printModal.queueOptions', 'Queue options')}</span>
        {isExpanded ? <ChevronUp className="ml-auto w-4 h-4" /> : <ChevronDown className="ml-auto w-4 h-4" />}
      </button>
      {isExpanded && (
        <div className="mt-2 space-y-3 rounded-lg bg-bambu-dark p-3">
          {controls.map(({ key, label, disabled }) => (
            <label key={key} className={`flex items-center justify-between ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer group'}`}>
              <span className="text-sm text-white">{label}</span>
              <input type="checkbox" checked={options[key]} onChange={() => !disabled && onChange({ ...options, [key]: !options[key] })} disabled={disabled} className="peer sr-only" />
              <div className={`relative h-5 w-10 rounded-full transition-colors ${options[key] ? 'bg-bambu-green' : 'bg-bambu-dark-tertiary'}`}>
                <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${options[key] ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </div>
            </label>
          ))}

          {options.postponePrint && (
            <div>
              <label className="mb-1 block text-sm text-bambu-gray">{t('printModal.doNotStartBefore', 'Do not start before')}</label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input type="text" value={dateValue} onChange={(event) => { setDateValue(event.target.value); updateScheduledTime(event.target.value, timeValue); }} placeholder={getDatePlaceholder(dateFormat as DateFormat)} className={`w-full rounded-lg border bg-bambu-dark px-3 py-2 pr-10 text-white focus:outline-none ${isDateValid ? 'border-bambu-dark-tertiary focus:border-bambu-green' : 'border-red-500'}`} />
                  <button type="button" onClick={() => hiddenInputRef.current?.showPicker()} className="absolute right-2 top-1/2 -translate-y-1/2 text-bambu-gray hover:text-white" title={t('printModal.openCalendar')}><Calendar className="w-4 h-4" /></button>
                  <input ref={hiddenInputRef} type="datetime-local" className="pointer-events-none absolute left-0 top-0 h-0 w-0 opacity-0" value={options.scheduledTime} onChange={(event) => { const date = new Date(event.target.value); if (!Number.isNaN(date.getTime())) { setDateValue(formatDateInput(date, dateFormat as DateFormat)); setTimeValue(formatTimeInput(date, timeFormat as TimeFormat)); setIsDateValid(true); setIsTimeValid(true); onChange({ ...options, scheduledTime: event.target.value }); } }} tabIndex={-1} />
                </div>
                <input type="text" value={timeValue} onChange={(event) => { setTimeValue(event.target.value); updateScheduledTime(dateValue, event.target.value); }} placeholder={getTimePlaceholder(timeFormat as TimeFormat)} className={`w-32 rounded-lg border bg-bambu-dark px-3 py-2 text-white focus:outline-none ${isTimeValid ? 'border-bambu-dark-tertiary focus:border-bambu-green' : 'border-red-500'}`} />
              </div>
              {(!isDateValid || !isTimeValid) && <p className="mt-1 text-xs text-red-400">{t('printModal.invalidDateTime')}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

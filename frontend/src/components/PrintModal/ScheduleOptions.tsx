import { useEffect, useRef, useState } from 'react';
import { Calendar, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ListOrdered } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ScheduleOptions, ScheduleOptionsProps } from './types';
import {
  formatDateInput,
  getDatePlaceholder,
  parseDateInput,
  parseTimeInput,
  toDateTimeLocalValue,
  type DateFormat,
} from '../../utils/date';

type ToggleKey = Exclude<keyof ScheduleOptions, 'scheduledTime'>;

/** Collapsible queue controls, including an optional do-not-start-before time. */
export function ScheduleOptionsPanel({
  options,
  onChange,
  dateFormat = 'system',
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
  const [isPast, setIsPast] = useState(false);
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(new Date());
  const [selectedCalendarDate, setSelectedCalendarDate] = useState<Date | null>(null);
  const calendarRef = useRef<HTMLDivElement>(null);
  const isInitializedRef = useRef(false);

  const controls: Array<{ key: ToggleKey; label: string; disabled?: boolean }> = [
    ...(canInsertAtTop ? [{ key: 'insertAtTop' as const, label: t('printModal.insertAtTop', 'Insert at top of queue') }] : []),
    { key: 'requireManualStart', label: t('printModal.requireManualStart') },
    { key: 'requirePreviousSuccess', label: t('printModal.requirePreviousSuccess') },
    ...(showAutoOff ? [{ key: 'autoOffAfter' as const, label: t('printModal.autoOffAfter'), disabled: !canControlPrinter }] : []),
    ...(hasGcodeSnippets ? [{ key: 'gcodeInjection' as const, label: t('printModal.gcodeInjection', 'Inject auto-print G-code') }] : []),
    { key: 'postponePrint', label: t('printModal.postponePrint', 'Postpone print') },
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
      date.setSeconds(0, 0);
      date.setMinutes(date.getMinutes() + 15 - (date.getMinutes() % 15));
      onChange({ ...options, scheduledTime: toDateTimeLocalValue(date) });
    }
    setDateValue(formatDateInput(date, dateFormat as DateFormat));
    setTimeValue(`${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`);
    setIsDateValid(true);
    setIsTimeValid(true);
    setIsPast(date <= new Date());
  }, [dateFormat, onChange, options, options.postponePrint, options.scheduledTime]);

  const updateScheduledTime = (nextDate: string, nextTime: string) => {
    const parsedDate = parseDateInput(nextDate, dateFormat as DateFormat);
    const parsedTime = parseTimeInput(nextTime);
    setIsDateValid(!!parsedDate);
    setIsTimeValid(!!parsedTime);
    if (!parsedDate || !parsedTime) return;
    parsedDate.setHours(parsedTime.hours, parsedTime.minutes, 0, 0);
    setIsPast(parsedDate <= new Date());
    onChange({ ...options, scheduledTime: toDateTimeLocalValue(parsedDate) });
  };

  const openCalendar = () => {
    const selected = options.scheduledTime ? new Date(options.scheduledTime) : new Date();
    const validSelected = Number.isNaN(selected.getTime()) ? new Date() : selected;
    setSelectedCalendarDate(validSelected);
    setCalendarMonth(new Date(validSelected.getFullYear(), validSelected.getMonth(), 1));
    setIsCalendarOpen(true);
  };

  useEffect(() => {
    if (!isCalendarOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!calendarRef.current?.contains(event.target as Node)) setIsCalendarOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsCalendarOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isCalendarOpen]);

  const calendarDays = (() => {
    const firstDay = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
    const daysInMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();
    return Array.from({ length: firstDay.getDay() + daysInMonth }, (_, index) => {
      const day = index - firstDay.getDay() + 1;
      return day > 0 ? new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), day) : null;
    });
  })();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

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
                  <button type="button" onClick={openCalendar} className="absolute right-2 top-1/2 -translate-y-1/2 text-bambu-gray hover:text-white" title={t('printModal.openCalendar')}><Calendar className="w-4 h-4" /></button>
                  {isCalendarOpen && (
                    <div ref={calendarRef} role="dialog" aria-label={t('printModal.chooseDate', 'Choose date')} className="absolute bottom-full left-0 z-50 mb-2 w-72 rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-3 shadow-xl">
                      <div className="mb-3 flex items-center justify-between">
                        <button type="button" aria-label={t('printModal.previousMonth', 'Previous month')} onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))} className="rounded p-1 text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white"><ChevronLeft className="h-4 w-4" /></button>
                        <span className="text-sm font-medium text-white">{calendarMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
                        <button type="button" aria-label={t('printModal.nextMonth', 'Next month')} onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))} className="rounded p-1 text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white"><ChevronRight className="h-4 w-4" /></button>
                      </div>
                      <div className="mb-1 grid grid-cols-7 text-center text-[10px] font-medium text-bambu-gray">{['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}</div>
                      <div className="grid grid-cols-7 gap-1">
                        {calendarDays.map((date, index) => {
                          if (!date) return <span key={`empty-${index}`} />;
                          const disabled = date < today;
                          const selected = selectedCalendarDate?.toDateString() === date.toDateString();
                          return <button key={date.toISOString()} type="button" disabled={disabled} onClick={() => setSelectedCalendarDate(date)} className={`h-8 rounded text-xs transition-colors ${selected ? 'bg-bambu-green text-white' : 'text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white'} disabled:cursor-not-allowed disabled:opacity-30`}>{date.getDate()}</button>;
                        })}
                      </div>
                      <div className="mt-3 flex justify-end gap-2 border-t border-bambu-dark-tertiary pt-3">
                        <button type="button" onClick={() => setIsCalendarOpen(false)} className="rounded px-2.5 py-1.5 text-xs text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white">{t('common.cancel')}</button>
                        <button type="button" onClick={() => { if (!selectedCalendarDate) return; const parsedTime = parseTimeInput(timeValue); if (!parsedTime) return; const next = new Date(selectedCalendarDate); next.setHours(parsedTime.hours, parsedTime.minutes, 0, 0); if (next <= new Date()) { setIsPast(true); return; } setDateValue(formatDateInput(next, dateFormat as DateFormat)); setIsDateValid(true); setIsPast(false); onChange({ ...options, scheduledTime: toDateTimeLocalValue(next) }); setIsCalendarOpen(false); }} className="rounded bg-bambu-green px-2.5 py-1.5 text-xs font-medium text-white hover:bg-bambu-green-light">{t('common.save')}</button>
                      </div>
                    </div>
                  )}
                </div>
                <input type="time" aria-label={t('printModal.postponeTime', 'Postpone time')} step="60" value={timeValue} onChange={(event) => { setTimeValue(event.target.value); updateScheduledTime(dateValue, event.target.value); }} className={`w-32 rounded-lg border bg-bambu-dark px-3 py-2 text-white focus:outline-none ${isTimeValid && !isPast ? 'border-bambu-dark-tertiary focus:border-bambu-green' : 'border-red-500'}`} />
              </div>
              {isPast ? <p className="mt-1 text-xs text-red-400">{t('printModal.futureDateTime', 'Choose a future date and time')}</p> : (!isDateValid || !isTimeValid) && <p className="mt-1 text-xs text-red-400">{t('printModal.invalidDateTime')}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

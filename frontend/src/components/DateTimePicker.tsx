import { useEffect, useRef, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  formatDateInput,
  getDatePlaceholder,
  parseDateInput,
  parseTimeInput,
  toDateTimeLocalValue,
  type DateFormat,
} from '../utils/date';

export interface DateTimePickerProps {
  /** A local datetime value in the same format as an HTML datetime-local input. */
  value: string;
  onChange: (value: string) => void;
  dateFormat?: DateFormat;
  dateInputId?: string;
  timeAriaLabel?: string;
  required?: boolean;
  className?: string;
}

function parseLocalDateTime(value: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * A date/time control with the same calendar treatment as the Print Modal.
 * The value remains a local datetime string so callers can submit it as UTC
 * without relying on browser-specific datetime-local styling.
 */
export function DateTimePicker({
  value,
  onChange,
  dateFormat = 'system',
  dateInputId,
  timeAriaLabel,
  required = false,
  className,
}: DateTimePickerProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language || undefined;
  const initialDate = parseLocalDateTime(value);
  const [dateValue, setDateValue] = useState(initialDate ? formatDateInput(initialDate, dateFormat) : '');
  const [timeValue, setTimeValue] = useState(initialDate ? `${String(initialDate.getHours()).padStart(2, '0')}:${String(initialDate.getMinutes()).padStart(2, '0')}` : '');
  const [isDateValid, setIsDateValid] = useState(!value || !!initialDate);
  const [isTimeValid, setIsTimeValid] = useState(!value || !!initialDate);
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(initialDate ? new Date(initialDate.getFullYear(), initialDate.getMonth(), 1) : new Date());
  const [selectedCalendarDate, setSelectedCalendarDate] = useState<Date | null>(initialDate);
  const calendarRef = useRef<HTMLDivElement>(null);
  const calendarTriggerRef = useRef<HTMLButtonElement>(null);
  const calendarWasOpenRef = useRef(false);
  const lastValueRef = useRef(value);
  const lastDateFormatRef = useRef(dateFormat);

  // Synchronize only external value changes. During an incomplete edit the
  // parent value is intentionally empty, but the visible text should remain
  // available for the user to finish typing.
  useEffect(() => {
    if (value === lastValueRef.current && dateFormat === lastDateFormatRef.current) return;
    lastValueRef.current = value;
    lastDateFormatRef.current = dateFormat;
    const nextDate = parseLocalDateTime(value);
    if (!nextDate) {
      setDateValue('');
      setTimeValue('');
      setIsDateValid(!value);
      setIsTimeValid(!value);
      setSelectedCalendarDate(null);
      return;
    }
    setDateValue(formatDateInput(nextDate, dateFormat));
    setTimeValue(`${String(nextDate.getHours()).padStart(2, '0')}:${String(nextDate.getMinutes()).padStart(2, '0')}`);
    setIsDateValid(true);
    setIsTimeValid(true);
    setSelectedCalendarDate(nextDate);
    setCalendarMonth(new Date(nextDate.getFullYear(), nextDate.getMonth(), 1));
  }, [dateFormat, value]);

  const emitValue = (nextValue: string) => {
    lastValueRef.current = nextValue;
    onChange(nextValue);
  };

  const updateDateTime = (nextDateValue: string, nextTimeValue: string) => {
    const parsedDate = parseDateInput(nextDateValue, dateFormat);
    const parsedTime = parseTimeInput(nextTimeValue);
    setIsDateValid(!!parsedDate);
    setIsTimeValid(!!parsedTime);
    if (!parsedDate || !parsedTime) {
      emitValue('');
      return;
    }
    parsedDate.setHours(parsedTime.hours, parsedTime.minutes, 0, 0);
    emitValue(toDateTimeLocalValue(parsedDate));
  };

  const openCalendar = () => {
    const current = parseLocalDateTime(value) || parseDateInput(dateValue, dateFormat) || new Date();
    setSelectedCalendarDate(current);
    setCalendarMonth(new Date(current.getFullYear(), current.getMonth(), 1));
    setIsCalendarOpen(true);
  };

  useEffect(() => {
    if (!isCalendarOpen) {
      if (calendarWasOpenRef.current) {
        calendarTriggerRef.current?.focus();
        calendarWasOpenRef.current = false;
      }
      return;
    }

    calendarWasOpenRef.current = true;
    const getFocusableElements = () => Array.from(
      calendarRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    getFocusableElements()[0]?.focus();

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!calendarRef.current?.contains(event.target as Node)) setIsCalendarOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setIsCalendarOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = getFocusableElements();
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isCalendarOpen]);

  const firstDayOfWeek = (() => {
    try {
      const localeInfo = new Intl.Locale(locale || 'en') as Intl.Locale & {
        getWeekInfo?: () => { firstDay: number };
        weekInfo?: { firstDay: number };
      };
      const weekInfo = localeInfo.getWeekInfo?.() ?? localeInfo.weekInfo;
      if (weekInfo) return weekInfo.firstDay % 7;
    } catch {
      // Fall through to Sunday-first when the locale is unknown.
    }
    return 0;
  })();
  const weekdayLabels = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(2024, 0, 7 + ((firstDayOfWeek + index) % 7));
    return new Intl.DateTimeFormat(locale, { weekday: 'narrow' }).format(date);
  });
  const calendarDays = (() => {
    const firstDay = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
    const daysInMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();
    const leadingDays = (firstDay.getDay() - firstDayOfWeek + 7) % 7;
    return Array.from({ length: leadingDays + daysInMonth }, (_, index) => {
      const day = index - leadingDays + 1;
      return day > 0 ? new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), day) : null;
    });
  })();
  const calendarWeeks = Array.from({ length: Math.ceil(calendarDays.length / 7) }, (_, index) => calendarDays.slice(index * 7, index * 7 + 7));

  const applyCalendarDate = () => {
    if (!selectedCalendarDate) return;
    const parsedTime = parseTimeInput(timeValue);
    if (!parsedTime) {
      setIsTimeValid(false);
      return;
    }
    const next = new Date(selectedCalendarDate);
    next.setHours(parsedTime.hours, parsedTime.minutes, 0, 0);
    const nextDateValue = formatDateInput(next, dateFormat);
    setDateValue(nextDateValue);
    setIsDateValid(true);
    setIsTimeValid(true);
    emitValue(toDateTimeLocalValue(next));
    setIsCalendarOpen(false);
  };

  const dateInputClass = isDateValid
    ? 'border-bambu-dark-tertiary focus:border-bambu-green'
    : 'border-red-500';
  const timeInputClass = isTimeValid
    ? 'border-bambu-dark-tertiary focus:border-bambu-green'
    : 'border-red-500';

  return (
    <div className={className || ''}>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
        <input
          id={dateInputId}
          type="text"
          required={required}
          value={dateValue}
          onChange={(event) => {
            setDateValue(event.target.value);
            updateDateTime(event.target.value, timeValue);
          }}
          placeholder={getDatePlaceholder(dateFormat)}
          className={`w-full rounded-lg border bg-bambu-dark px-3 py-2 pr-10 text-white focus:outline-none ${dateInputClass}`}
        />
        <button
          ref={calendarTriggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={isCalendarOpen}
          onClick={openCalendar}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-bambu-gray hover:text-white"
          title={t('printModal.openCalendar')}
        >
          <Calendar className="h-4 w-4" />
        </button>
        {isCalendarOpen && (
          <div
            ref={calendarRef}
            role="dialog"
            aria-modal="true"
            aria-label={t('printModal.chooseDate')}
            className="absolute bottom-full left-0 z-50 mb-2 w-72 rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-3 shadow-xl"
          >
            <div className="mb-3 flex items-center justify-between">
              <button
                type="button"
                aria-label={t('printModal.previousMonth')}
                onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}
                className="rounded p-1 text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-sm font-medium text-white">
                {calendarMonth.toLocaleDateString(locale, { month: 'long', year: 'numeric' })}
              </span>
              <button
                type="button"
                aria-label={t('printModal.nextMonth')}
                onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}
                className="rounded p-1 text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <div role="grid" aria-label={t('printModal.chooseDate')}>
              <div role="row" className="mb-1 grid grid-cols-7 text-center text-[10px] font-medium text-bambu-gray">
                {weekdayLabels.map((day, index) => <span role="columnheader" key={`${day}-${index}`}>{day}</span>)}
              </div>
              {calendarWeeks.map((week, weekIndex) => (
                <div role="row" key={weekIndex} className="grid grid-cols-7 gap-1">
                  {week.map((date, dayIndex) => {
                    if (!date) return <span role="gridcell" key={`empty-${weekIndex}-${dayIndex}`} />;
                    const selected = selectedCalendarDate?.toDateString() === date.toDateString();
                    return (
                      <div role="gridcell" key={date.toISOString()}>
                        <button
                          type="button"
                          aria-label={date.toLocaleDateString(locale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                          aria-pressed={selected}
                          onClick={() => setSelectedCalendarDate(date)}
                          className={`h-8 w-full rounded text-xs transition-colors ${selected ? 'bg-bambu-green text-white' : 'text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white'}`}
                        >
                          {date.getDate()}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="mt-3 flex justify-end gap-2 border-t border-bambu-dark-tertiary pt-3">
              <button
                type="button"
                onClick={() => setIsCalendarOpen(false)}
                className="rounded px-2.5 py-1.5 text-xs text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={applyCalendarDate}
                className="rounded bg-bambu-green px-2.5 py-1.5 text-xs font-medium text-white hover:bg-bambu-green-light"
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        )}
        </div>
        <input
          type="time"
          required={required}
          aria-label={timeAriaLabel || t('printModal.postponeTime', 'Time')}
          step="60"
          value={timeValue}
          onChange={(event) => {
            setTimeValue(event.target.value);
            updateDateTime(dateValue, event.target.value);
          }}
          className={`w-32 rounded-lg border bg-bambu-dark px-3 py-2 text-white focus:outline-none ${timeInputClass}`}
        />
      </div>
      {(!isDateValid || !isTimeValid) && (
        <p className="mt-1 text-xs text-red-400">{t('printModal.invalidDateTime')}</p>
      )}
    </div>
  );
}

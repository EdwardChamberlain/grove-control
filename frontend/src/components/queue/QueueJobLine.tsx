import { useEffect, useState, type CSSProperties, type MouseEventHandler, type ReactNode, type Ref } from 'react';
import type { LucideIcon } from 'lucide-react';
import { AlertCircle, Check, Clock, Code, Hand, Layers, Power, Printer, Timer, User, Weight } from 'lucide-react';
import { api } from '../../api/client';
import type { PrintQueueItem } from '../../api/client';
import { getBedTypeInfo } from '../../utils/bedType';
import { type TimeFormat, formatDate, formatDuration, formatETA, formatRelativeTime, parseUTCDate } from '../../utils/date';
import { formatWeight } from './format';
import { QUEUE_TONES, resolveQueueTone, type QueueJobProgress, type QueueTone } from './queueTones';

function formatHeatSoakCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** The queue fields a job line reads, so synthetic kiosk lines can be built without a full queue row. */
export type QueueJobLineItem = Pick<
  PrintQueueItem,
  | 'status'
  | 'printer_id'
  | 'printer_name'
  | 'target_model'
  | 'target_location'
  | 'required_filament_types'
  | 'variants'
  | 'archive_id'
  | 'library_file_id'
  | 'archive_thumbnail'
  | 'library_file_thumbnail'
  | 'plate_id'
  | 'bed_type'
  | 'created_by_username'
  | 'scheduled_time'
  | 'manual_start'
  | 'waiting_reason'
  | 'print_time_seconds'
  | 'filament_used_grams'
  | 'require_previous_success'
  | 'auto_off_after'
  | 'gcode_injection'
  | 'filament_short'
  | 'error_message'
  | 'preheat_started_at'
  | 'heat_soak_minutes'
> &
  // Optional so a synthetic line needs no flag: a missing one keeps a wait highlighted.
  Partial<Pick<PrintQueueItem, 'waiting_needs_action'>>;

export interface QueueJobLineStatus {
  tone: QueueTone;
  Icon: LucideIcon;
  label: string;
}

export interface QueueJobLineProps {
  item: QueueJobLineItem;
  /** Title text; callers add plate names and the like. */
  displayName: string;
  /** `queue` is the interactive Queue page card, `kiosk` the larger read-only one. */
  size?: 'queue' | 'kiosk';
  /** Live printer state ('PAUSE', 'RUNNING', ...) for the printer running this job. */
  printerState?: string | null;
  timeFormat?: TimeFormat;
  t: (key: string, options?: Record<string, unknown>) => string;
  progress?: QueueJobProgress | null;
  pauseReasonKey?: string;
  /** Replaces the tone, icon and label derived from the item. */
  status?: QueueJobLineStatus;
  /** Pulse the line to ask for attention (plate clear). */
  alert?: boolean;
  /** Extra footer strip, laid out in the line's tone. */
  extraFooter?: ReactNode;
  /** Draws the selection ring and thumbnail ring. */
  selected?: boolean;

  // Slots used by the interactive Queue page; the read-only kiosk leaves them out.
  rootRef?: Ref<HTMLDivElement>;
  rootStyle?: CSSProperties;
  rootClassName?: string;
  onRootClick?: MouseEventHandler<HTMLDivElement>;
  /** Replaces the default status icon and label inside the gutter. */
  gutter?: ReactNode;
  /** Sits over the thumbnail, for example a selection checkbox. */
  thumbnailAdornment?: ReactNode;
  /** Replaces the plain title text, for example with an edit button. */
  title?: ReactNode;
  /** Shown after the title: links and option icons. */
  titleAdornments?: ReactNode;
  /** Right-hand action buttons. */
  actions?: ReactNode;
  /** Start button for a staged job. */
  startAction?: ReactNode;
  /** Skip button while heat soaking. */
  skipHeatSoakAction?: ReactNode;
}

/** Icons for the print options set on a queue item. */
export function QueueOptionIcons({ item, t }: { item: QueueJobLineItem; t: QueueJobLineProps['t'] }) {
  return (
    <>
      {item.require_previous_success && (
        <span
          role="img"
          aria-label={t('queue.badges.requiresPrevious')}
          title={t('queue.badges.requiresPrevious')}
          className="inline-flex shrink-0 text-bambu-gray-light"
        >
          <Check className="w-3.5 h-3.5" />
        </span>
      )}
      {item.auto_off_after && (
        <span
          role="img"
          aria-label={t('queue.badges.autoPowerOff')}
          title={t('queue.badges.autoPowerOff')}
          className="inline-flex shrink-0 text-bambu-gray-light"
        >
          <Power className="w-3.5 h-3.5" />
        </span>
      )}
      {item.gcode_injection && (
        <span
          role="img"
          aria-label={t('queue.badges.gcodeInjection')}
          title={t('queue.badges.gcodeInjection')}
          className="inline-flex shrink-0 text-bambu-gray-light"
        >
          <Code className="w-3.5 h-3.5" />
        </span>
      )}
    </>
  );
}

function thumbnailUrl(item: QueueJobLineItem): string | null {
  if (item.archive_thumbnail && item.archive_id) {
    return item.plate_id != null
      ? api.getArchivePlateThumbnail(item.archive_id, item.plate_id)
      : api.getArchiveThumbnail(item.archive_id);
  }
  if (item.library_file_thumbnail && item.library_file_id) {
    return item.plate_id != null
      ? api.getLibraryFilePlateThumbnail(item.library_file_id, item.plate_id)
      : api.getLibraryFileThumbnailUrl(item.library_file_id);
  }
  return null;
}

/**
 * One job in a print queue: a full-height status gutter, the job's details and
 * a stack of footers (progress, waiting reason, pause reason, heat soak, errors).
 *
 * The Queue page and the kiosk both render this, so status tones, footers and
 * their wording cannot drift apart. The Queue page fills the interaction slots
 * (drag handle, checkbox, buttons); the kiosk renders it read-only at `size="kiosk"`.
 */
export function QueueJobLine({
  item,
  displayName,
  size = 'queue',
  printerState,
  timeFormat = 'system',
  t,
  progress,
  pauseReasonKey,
  status,
  alert = false,
  extraFooter,
  selected = false,
  rootRef,
  rootStyle,
  rootClassName = '',
  onRootClick,
  gutter,
  thumbnailAdornment,
  title,
  titleAdornments,
  actions,
  startAction,
  skipHeatSoakAction,
}: QueueJobLineProps) {
  const k = size === 'kiosk';
  const isPrinting = item.status === 'printing' || item.status === 'preheating';
  const isPending = item.status === 'pending';
  const { tone, Icon: StatusIcon, label: statusLabel } = status ?? resolveQueueTone(item, printerState, t);

  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  useEffect(() => {
    if (item.status !== 'preheating') return;

    const interval = window.setInterval(() => setCountdownNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [item.status]);

  const preheatStartedAt = item.preheat_started_at ? parseUTCDate(item.preheat_started_at) : null;
  const heatSoakRemainingSeconds = item.status === 'preheating' && preheatStartedAt && item.heat_soak_minutes
    ? Math.max(0, item.heat_soak_minutes * 60 - Math.floor((countdownNow - preheatStartedAt.getTime()) / 1000))
    : null;
  const heatSoakText = item.status === 'preheating'
    ? (heatSoakRemainingSeconds !== null
        ? t('heatSoak.remaining', { time: formatHeatSoakCountdown(heatSoakRemainingSeconds) })
        : t('heatSoak.waitingForConfirmation'))
    : null;

  const bed = getBedTypeInfo(item.bed_type);
  const showStartButton = isPending && item.manual_start;
  const showWaitingReason = isPending && !!item.waiting_reason;
  const showStagedFooter = (showStartButton && !!startAction) || showWaitingReason;
  // Filament-short flag from the dispatch pre-flight (#1496). It shares the staged
  // footer with the Start button when there is one, so a staged job that is also
  // short on filament gets a single strip rather than two stacked ones.
  const showFilamentShort = !!item.filament_short && isPending;

  const printerLabel =
    (item.variants?.length ?? 0) > 1 && !item.printer_id
      ? // A cross-model item (#671) is waiting on several models at once.
        // Showing only target_model would name whichever candidate is
        // first and read as a lie the moment the other one runs.
        `${t('queue.filter.any')} ${item.variants!.map(v => v.target_model).join(' / ')}${item.target_location ? ` @ ${item.target_location}` : ''}`
      : item.target_model && !item.printer_id
        ? `${t('queue.filter.any')} ${item.target_model}${item.target_location ? ` @ ${item.target_location}` : ''}${item.required_filament_types?.length ? ` (${item.required_filament_types.join(', ')})` : ''}`
        : item.printer_id === null
          ? t('queue.filter.unassigned')
          : (item.printer_name || `${t('common.printer')} #${item.printer_id}`);
  const isFutureSchedule = !!item.scheduled_time && (parseUTCDate(item.scheduled_time)?.getTime() ?? 0) > Date.now();
  const scheduleText = isPending && !item.manual_start
    ? (item.scheduled_time
        ? ((parseUTCDate(item.scheduled_time)?.getTime() ?? 0) - Date.now() < -60000
            ? t('queue.time.overdue')
            : isFutureSchedule
              ? formatDate(item.scheduled_time)
              : formatRelativeTime(item.scheduled_time, timeFormat, t))
        : t('queue.time.asap'))
    : null;

  const thumbnail = thumbnailUrl(item);
  const footerPad = k ? 'px-[18px] py-1.5 text-base' : 'px-4 py-1.5 text-xs';
  const progressPad = k ? 'px-[18px] py-2 text-base' : 'px-4 py-2 text-xs';
  const footerIcon = k ? 'h-4 w-4' : 'h-3.5 w-3.5';
  // Height of one footer text line (text-base / text-xs, set by footerPad above). The alert icon sits in a box this
  // tall so it stays on the first line when the text wraps.
  const footerLineHeight = k ? 'h-6' : 'h-4';
  // One alert line in a footer strip: an icon beside text. Two whole-pixel offsets line the pair up by eye, tuned
  // against rendered screenshots: the icon is lifted 1px at the compact size, where the glyphs sit a little above
  // the middle of their line box (the kiosk's taller line box needs no lift), and the whole line is dropped 1px so
  // the pair is centred in the strip. Whole pixels keep the icon crisp on 1x displays.
  const renderAlertLine = (text: ReactNode, title?: string) => (
    <span className="flex translate-y-px items-start gap-2" title={title}>
      <span className={`flex flex-shrink-0 items-center ${footerLineHeight} ${k ? '' : '-translate-y-px'}`}>
        <AlertCircle className={footerIcon} />
      </span>
      <span>{text}</span>
    </span>
  );

  return (
    <div
      ref={rootRef}
      style={rootStyle}
      onClick={onRootClick}
      className={`
        group relative flex overflow-hidden rounded-xl border bg-bambu-dark-secondary transition-all duration-200
        ${tone.border}
        ${selected ? tone.ring : ''}
        ${alert ? 'kiosk-plate-clear-alert' : ''}
        ${rootClassName}
      `}
    >
      {tone.wash && <div aria-hidden="true" className={`pointer-events-none absolute inset-0 ${tone.wash}`} />}

      {/* Status gutter: status icon + label. The Queue page swaps in a drag handle. */}
      <div
        className={`relative z-10 flex flex-none flex-col items-center justify-center border-r ${k ? 'w-[104px]' : 'w-12 sm:w-[80px]'} ${tone.gutter} ${tone.text}`}
        data-no-card-click
      >
        {gutter ?? (
          k ? (
            <div className="flex flex-col items-center justify-center gap-1.5 px-1">
              <StatusIcon className="h-7 w-7" />
              <span className="break-words text-center text-xs font-bold uppercase tracking-[0.04em]">{statusLabel}</span>
            </div>
          ) : (
            <>
              <div className="hidden sm:flex flex-col items-center justify-center gap-1.5 px-1">
                <StatusIcon className="h-6 w-6" />
                <span className="break-words text-center text-[10px] font-bold uppercase tracking-[0.04em]">{statusLabel}</span>
              </div>
              <div className="sm:hidden flex flex-col items-center gap-1">
                <StatusIcon className="h-5 w-5" aria-hidden="true" />
              </div>
            </>
          )
        )}
      </div>

      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <div className={k ? 'flex items-center gap-4 px-[18px] py-2' : 'flex items-center gap-3 sm:gap-3.5 px-3 py-2.5 sm:pl-[18px] sm:pr-3'}>
          {/* Thumbnail with optional adornment (selection checkbox) */}
          <div className={`relative flex-none ${k ? 'h-[52px] w-[52px]' : 'h-11 w-11'}`}>
            <div className={`overflow-hidden bg-bambu-dark ${k ? 'h-[52px] w-[52px] rounded-lg' : 'h-11 w-11 rounded-lg'} ${selected ? 'ring-2 ring-bambu-green' : ''}`}>
              {thumbnail ? (
                <img src={thumbnail} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-bambu-gray">
                  <Layers className={k ? 'h-6 w-6' : 'h-5 w-5'} />
                </div>
              )}
            </div>
            {thumbnailAdornment}
          </div>

          {/* Info */}
          <div className={`flex min-w-0 flex-1 flex-col ${k ? 'gap-1' : 'gap-1.5'}`}>
            <div className="flex min-w-0 items-center gap-2">
              {title ?? (
                <p
                  className={`min-w-0 truncate font-semibold text-white ${k ? 'text-xl' : 'text-sm sm:text-[15px]'}`}
                  title={k ? displayName : undefined}
                >
                  {displayName}
                </p>
              )}
              {titleAdornments}
            </div>

            <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-bambu-gray-light ${k ? 'text-base' : 'text-xs sm:text-[13px]'}`}>
              {!k && (
                <span className={`text-[10px] font-bold uppercase tracking-[0.04em] sm:hidden ${tone.text}`}>{statusLabel}</span>
              )}
              <span className="flex items-center gap-1.5">
                <Printer className={k ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
                <span className={k ? 'truncate' : 'max-w-[160px] truncate sm:max-w-none'}>{printerLabel}</span>
              </span>
              {bed && (
                <span className="flex items-center gap-1.5" title={bed.label}>
                  <img src={bed.icon} alt="" className="h-4 w-4 object-contain" />
                  <span className="max-w-[140px] truncate">{bed.label}</span>
                </span>
              )}
              {item.created_by_username && (
                <span className={`items-center gap-1.5 ${k ? 'flex' : 'hidden sm:flex'}`} title={t('queue.addedBy', { name: item.created_by_username })}>
                  <User className={k ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
                  {item.created_by_username}
                </span>
              )}
              {scheduleText && (
                <span className="flex items-center gap-1.5">
                  <Clock className={k ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
                  {scheduleText}
                </span>
              )}
              {/* Time and weight sit in the right-hand column on wider screens */}
              {!k && (
                <span className="flex items-center gap-3 sm:hidden">
                  {item.print_time_seconds ? (
                    <span className="flex items-center gap-1">
                      <Timer className="h-3 w-3" />
                      {formatDuration(item.print_time_seconds)}
                    </span>
                  ) : null}
                  {item.filament_used_grams ? (
                    <span className="flex items-center gap-1">
                      <Weight className="h-3 w-3" />
                      {formatWeight(item.filament_used_grams)}
                    </span>
                  ) : null}
                </span>
              )}
            </div>
          </div>

          {/* Time + weight */}
          <div className={`min-w-[72px] flex-none flex-col items-end gap-0.5 ${k ? 'flex' : 'hidden sm:flex'}`}>
            {item.print_time_seconds ? (
              <span className={`font-semibold text-white ${k ? 'text-xl' : 'text-[15px]'}`}>{formatDuration(item.print_time_seconds)}</span>
            ) : null}
            {item.filament_used_grams ? (
              <span className={`text-bambu-gray-light ${k ? 'text-base' : 'text-xs'}`}>{formatWeight(item.filament_used_grams)}</span>
            ) : null}
          </div>

          {/* Single action slot */}
          {actions && (
            <div className="flex flex-none items-center gap-2" data-no-card-click>
              {actions}
            </div>
          )}
        </div>

        {/* Footer strips: only rendered when there is something to say */}
        {extraFooter && (
          <div className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t ${footerPad} ${tone.footer}`}>
            {extraFooter}
          </div>
        )}

        {showStagedFooter && (
          <div
            className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t ${footerPad} ${tone.footer}`}
            // Covers the whole strip, as the stand-alone filament-short strip did; the Start button keeps its own title.
            // With a waiting reason in the strip it moves to the filament line, so it does not describe the wrong text.
            title={showFilamentShort && !showWaitingReason ? t('queue.filamentShort.rowTooltip') : undefined}
          >
            {showWaitingReason || showFilamentShort ? (
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                {showWaitingReason && renderAlertLine(item.waiting_reason)}
                {showFilamentShort &&
                  renderAlertLine(
                    t('queue.filamentShort.rowBadge'),
                    showWaitingReason ? t('queue.filamentShort.rowTooltip') : undefined,
                  )}
              </span>
            ) : (
              <span className="flex-1" />
            )}
            {/* The gutter already says Staged unless a waiting reason or filament flag took its place. */}
            {item.manual_start && (showWaitingReason || showFilamentShort) && (
              <span className="flex items-center gap-1.5">
                <Hand className="h-3 w-3" />
                {t('queue.badges.staged')}
              </span>
            )}
            {showStartButton && startAction}
          </div>
        )}

        {/* Filament-short flag on its own strip when no staged footer can carry it. */}
        {showFilamentShort && !showStagedFooter && (
          <div
            className={`border-t ${QUEUE_TONES.waiting.footer} ${footerPad}`}
            title={t('queue.filamentShort.rowTooltip')}
          >
            {renderAlertLine(t('queue.filamentShort.rowBadge'))}
          </div>
        )}

        {/* Progress for printing items */}
        {isPrinting && progress && (
          <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 border-t ${progressPad} ${tone.footer}`}>
            <div className={`min-w-[120px] flex-1 rounded-full bg-bambu-dark-tertiary ${k ? 'h-2.5' : 'h-1.5'}`}>
              <div
                className={`rounded-full transition-all ${tone.bar} ${k ? 'h-2.5' : 'h-1.5'}`}
                style={{ width: `${progress.progress}%` }}
              />
            </div>
            <span className={`font-bold text-white ${k ? 'text-xl tabular-nums' : 'text-[13px]'}`}>{Math.round(progress.progress)}%</span>
            {progress.remaining != null && progress.remaining > 0 && (
              <>
                <span>{formatDuration(progress.remaining * 60)}</span>
                <span className={`font-medium ${tone.text}`} title={t('printers.estimatedCompletion')}>
                  ETA {formatETA(progress.remaining, timeFormat, t)}
                </span>
              </>
            )}
            {progress.layerNum != null && progress.totalLayers != null && progress.totalLayers > 0 && (
              <span className="flex items-center gap-1">
                <Layers className={k ? 'h-4 w-4' : 'h-3 w-3'} />
                {progress.layerNum}/{progress.totalLayers}
              </span>
            )}
            {pauseReasonKey && (
              <span className="flex items-center gap-1 font-semibold">
                <AlertCircle className={k ? 'h-4 w-4' : 'h-3 w-3'} />
                {t(pauseReasonKey)}
              </span>
            )}
          </div>
        )}

        {item.status === 'preheating' && (
          <div className={`flex items-center gap-2 border-t ${footerPad} ${tone.footer}`}>
            <Timer className={`flex-shrink-0 ${footerIcon}`} />
            <span className="flex-1">{heatSoakText}</span>
            {skipHeatSoakAction}
          </div>
        )}

        {/* Error message */}
        {item.error_message && (
          <div className={`flex items-center gap-2 border-t border-red-400/25 bg-red-400/10 text-red-600 dark:text-red-400 ${footerPad}`}>
            <AlertCircle className={`flex-shrink-0 ${footerIcon}`} />
            {item.error_message}
          </div>
        )}
      </div>
    </div>
  );
}

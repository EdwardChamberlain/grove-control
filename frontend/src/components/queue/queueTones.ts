import { Ban, Calendar, CheckCircle, Clock, Hand, List, Pause, Printer, SkipForward, Timer, XCircle, type LucideIcon } from 'lucide-react';
import type { PrintQueueItem, PrinterStatus } from '../../api/client';
import { parseUTCDate } from '../../utils/date';

export type QueueTone = {
  /** Gutter label/icon colour. */
  text: string;
  /** Gutter background + divider. */
  gutter: string;
  /** Card border colour. */
  border: string;
  /** Faint wash laid over the card, or '' for none. */
  wash: string;
  /** Footer strip background, border and text colour. */
  footer: string;
  /** Ring drawn around a selected card. */
  ring: string;
  /** Progress bar fill. */
  bar: string;
};

// Colour means a person needs to act, with one exception: green means printing.
//   green  - printing, no issues (heat soak included)
//   orange - paused
//   yellow - plate clear required
//   purple - waiting on something (material, manual start)
//   neutral - everything else, scheduled and dispatching jobs included
// Coloured text uses a dark shade in the light theme and a light shade in the
// dark theme; neutral text uses theme tokens so it follows the active theme.
export const QUEUE_TONES = {
  waiting: {
    text: 'text-purple-700 dark:text-purple-300',
    gutter: 'bg-purple-400/20 border-purple-400/40',
    border: 'border-purple-400/45',
    wash: 'bg-purple-400/[0.07]',
    footer: 'bg-purple-400/10 border-purple-400/25 text-purple-700 dark:text-purple-300',
    ring: 'ring-1 ring-purple-400',
    bar: 'bg-purple-400',
  },
  active: {
    text: 'text-green-700 dark:text-green-400',
    gutter: 'bg-bambu-green/20 border-bambu-green/45',
    border: 'border-bambu-green/50',
    wash: 'bg-bambu-green/[0.07]',
    footer: 'bg-bambu-green/10 border-bambu-green/30 text-bambu-gray-light',
    ring: 'ring-1 ring-bambu-green',
    bar: 'bg-bambu-green-light',
  },
  neutral: {
    text: 'text-bambu-gray-light',
    gutter: 'bg-bambu-gray-light/10 border-bambu-dark-tertiary',
    border: 'border-bambu-dark-tertiary',
    wash: '',
    footer: 'bg-bambu-dark/40 border-bambu-dark-tertiary text-bambu-gray-light',
    ring: 'ring-1 ring-bambu-gray-light',
    bar: 'bg-bambu-gray-light',
  },
  plateClear: {
    text: 'text-yellow-700 dark:text-yellow-300',
    gutter: 'bg-yellow-400/15 border-yellow-400/40',
    border: 'border-yellow-400/40',
    wash: 'bg-yellow-400/[0.06]',
    footer: 'bg-yellow-400/10 border-yellow-400/25 text-yellow-700 dark:text-yellow-300',
    ring: 'ring-1 ring-yellow-400',
    bar: 'bg-yellow-400',
  },
  paused: {
    text: 'text-orange-700 dark:text-orange-300',
    gutter: 'bg-orange-500/20 border-orange-500/50',
    border: 'border-orange-500/55',
    wash: 'bg-orange-500/[0.08]',
    footer: 'bg-orange-500/10 border-orange-500/30 text-orange-700 dark:text-orange-300',
    ring: 'ring-1 ring-orange-500',
    bar: 'bg-orange-500',
  },
} satisfies Record<string, QueueTone>;

// History tab: finished jobs follow the rule above loosely, since the point is to
// spot problems at a glance. Failed is red and skipped reuses the paused orange so
// both stand out; completed gets a green gutter only (its card stays neutral, so
// green still reads as "printing" on the live queue); cancelled is neutral. A
// failure or skip reason is drawn by QueueJobLine's error footer, which is always
// red, so a skipped card has an orange gutter and a red reason strip.
const HISTORY_TONES = {
  completed: {
    ...QUEUE_TONES.neutral,
    text: 'text-green-700 dark:text-green-400',
    gutter: 'bg-bambu-green/10 border-bambu-dark-tertiary',
  },
  failed: {
    text: 'text-red-600 dark:text-red-400',
    gutter: 'bg-red-400/15 border-red-400/40',
    border: 'border-red-400/40',
    wash: 'bg-red-400/[0.06]',
    footer: 'bg-red-400/10 border-red-400/25 text-red-600 dark:text-red-400',
    ring: 'ring-1 ring-red-400',
    bar: 'bg-red-400',
  },
  skipped: {
    ...QUEUE_TONES.paused,
  },
  cancelled: QUEUE_TONES.neutral,
} satisfies Record<string, QueueTone>;

/** Status colour, icon and label for a finished job in the Queue page's History tab. */
export function resolveHistoryTone(
  status: string,
  t: (key: string) => string,
): { tone: QueueTone; Icon: LucideIcon; label: string } {
  switch (status) {
    case 'completed': return { tone: HISTORY_TONES.completed, Icon: CheckCircle, label: t('queue.status.completed') };
    case 'failed': return { tone: HISTORY_TONES.failed, Icon: XCircle, label: t('queue.status.failed') };
    case 'skipped': return { tone: HISTORY_TONES.skipped, Icon: SkipForward, label: t('queue.status.skipped') };
    default: return { tone: HISTORY_TONES.cancelled, Icon: Ban, label: t('queue.status.cancelled') };
  }
}

/**
 * Printer stage numbers (`stg_cur`) that mean the print is paused, mapped to
 * the i18n key for why. Other stages are not pause reasons.
 */
export const PAUSE_REASON_KEYS: Record<number, string> = {
  6: 'queue.pauseReason.filamentRanOut',
  16: 'queue.pauseReason.byUser',
  17: 'queue.pauseReason.frontCover',
  20: 'queue.pauseReason.nozzleTemperature',
  21: 'queue.pauseReason.bedTemperature',
};

/**
 * Status colour, icon and label for a queue card's gutter. Only statuses that
 * render as a queue job line are handled; finished jobs use resolveHistoryTone.
 */
export function resolveQueueTone(
  item: Pick<PrintQueueItem, 'status' | 'scheduled_time' | 'waiting_reason'> &
    Partial<Pick<PrintQueueItem, 'manual_start' | 'filament_short' | 'waiting_needs_action'>>,
  printerState: string | null | undefined,
  t: (key: string) => string,
): { tone: QueueTone; Icon: LucideIcon; label: string } {
  const { status } = item;
  if (status === 'pending') {
    // Blocked on something a person can fix: material, or a manual start. A wait
    // that clears by itself (printer busy, upload slot, AMS drying) is not, and
    // the backend says so with waiting_needs_action. A missing flag, such as
    // stale cached data, keeps the highlight rather than hiding a stuck job.
    const waitNeedsAction = !!item.waiting_reason && item.waiting_needs_action !== false;
    if (waitNeedsAction || item.filament_short) {
      return { tone: QUEUE_TONES.waiting, Icon: Clock, label: t('queue.status.waiting') };
    }
    if (item.manual_start) {
      return { tone: QUEUE_TONES.waiting, Icon: Hand, label: t('queue.badges.staged') };
    }
    // Still labelled Waiting, but neutral: the job starts on its own.
    if (item.waiting_reason) {
      return { tone: QUEUE_TONES.neutral, Icon: Clock, label: t('queue.status.waiting') };
    }
    // A future pending job needs nothing from anyone, so it stays neutral.
    if (item.scheduled_time && (parseUTCDate(item.scheduled_time)?.getTime() ?? 0) > Date.now()) {
      return { tone: QUEUE_TONES.neutral, Icon: Calendar, label: t('queue.status.scheduled') };
    }
  }
  if (status === 'printing' && printerState === 'PAUSE') {
    return { tone: QUEUE_TONES.paused, Icon: Pause, label: t('queue.status.paused') };
  }
  switch (status) {
    case 'preheating': return { tone: QUEUE_TONES.active, Icon: Timer, label: t('heatSoak.status') };
    case 'dispatching': return { tone: QUEUE_TONES.neutral, Icon: Timer, label: t('queue.status.dispatching') };
    case 'printing': return { tone: QUEUE_TONES.active, Icon: Printer, label: t('queue.status.printing') };
    default: return { tone: QUEUE_TONES.neutral, Icon: List, label: t('queue.status.pending') };
  }
}

/** i18n key for why a paused print stopped, when the printer reports a known stage. */
export function pauseReasonKeyFor(status: Pick<PrinterStatus, 'stg_cur'> | null | undefined): string | undefined {
  return status ? PAUSE_REASON_KEYS[status.stg_cur] : undefined;
}

/** Live progress of a job, taken from its printer's status. */
export interface QueueJobProgress {
  progress: number;
  remaining: number | null;
  layerNum: number | null;
  totalLayers: number | null;
}

/**
 * Progress/remaining/layer for the printer actually running a print. Between
 * dispatch and the RUNNING transition (H2D/P1 MQTT lag) status.progress is
 * stale from the previous print, showing 100% then snapping back to 0%, so
 * these fields are only trusted while the printer state is active.
 */
export function jobProgressFromStatus(
  status: Pick<PrinterStatus, 'state' | 'progress' | 'remaining_time' | 'layer_num' | 'total_layers'>,
): QueueJobProgress {
  const isActive = status.state === 'RUNNING' || status.state === 'PAUSE';
  return {
    progress: isActive ? (status.progress || 0) : 0,
    remaining: isActive ? status.remaining_time : null,
    layerNum: isActive ? status.layer_num : null,
    totalLayers: isActive ? status.total_layers : null,
  };
}

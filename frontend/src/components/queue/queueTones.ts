import { Calendar, Clock, List, Pause, Printer, Timer, type LucideIcon } from 'lucide-react';
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
};

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
  },
  active: {
    text: 'text-green-700 dark:text-green-400',
    gutter: 'bg-bambu-green/20 border-bambu-green/45',
    border: 'border-bambu-green/50',
    wash: 'bg-bambu-green/[0.07]',
    footer: 'bg-bambu-green/10 border-bambu-green/30 text-bambu-gray-light',
    ring: 'ring-1 ring-bambu-green',
  },
  neutral: {
    text: 'text-white',
    gutter: 'bg-bambu-gray-light/15 border-bambu-gray-dark',
    border: 'border-bambu-gray-dark',
    wash: '',
    footer: 'bg-bambu-dark/40 border-bambu-dark-tertiary',
    ring: 'ring-1 ring-bambu-gray-light',
  },
  scheduled: {
    text: 'text-yellow-700 dark:text-yellow-300',
    gutter: 'bg-yellow-400/15 border-yellow-400/40',
    border: 'border-yellow-400/40',
    wash: 'bg-yellow-400/[0.06]',
    footer: 'bg-yellow-400/10 border-yellow-400/25 text-yellow-700 dark:text-yellow-300',
    ring: 'ring-1 ring-yellow-400',
  },
  paused: {
    text: 'text-orange-700 dark:text-orange-300',
    gutter: 'bg-orange-500/20 border-orange-500/50',
    border: 'border-orange-500/55',
    wash: 'bg-orange-500/[0.08]',
    footer: 'bg-orange-500/10 border-orange-500/30 text-orange-700 dark:text-orange-300',
    ring: 'ring-1 ring-orange-500',
  },
  preheating: {
    text: 'text-amber-700 dark:text-amber-300',
    gutter: 'bg-amber-400/15 border-amber-400/40',
    border: 'border-amber-400/40',
    wash: 'bg-amber-400/[0.06]',
    footer: 'bg-amber-400/10 border-amber-400/25 text-amber-700 dark:text-amber-300',
    ring: 'ring-1 ring-amber-400',
  },
} satisfies Record<string, QueueTone>;

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
 * render as a queue job line are handled; finished jobs use CompactHistoryRow.
 */
export function resolveQueueTone(
  item: Pick<PrintQueueItem, 'status' | 'scheduled_time' | 'waiting_reason'>,
  printerState: string | null | undefined,
  t: (key: string) => string,
): { tone: QueueTone; Icon: LucideIcon; label: string } {
  const { status } = item;
  // A future pending job has its own explicit status.
  if (status === 'pending' && item.scheduled_time && (parseUTCDate(item.scheduled_time)?.getTime() ?? 0) > Date.now()) {
    return { tone: QUEUE_TONES.scheduled, Icon: Calendar, label: t('queue.status.scheduled') };
  }
  // Pending with a waiting_reason is blocked on something (filament, printer).
  if (status === 'pending' && item.waiting_reason) {
    return { tone: QUEUE_TONES.waiting, Icon: Clock, label: t('queue.status.waiting') };
  }
  if (status === 'printing' && printerState === 'PAUSE') {
    return { tone: QUEUE_TONES.paused, Icon: Pause, label: t('queue.status.paused') };
  }
  switch (status) {
    case 'preheating': return { tone: QUEUE_TONES.preheating, Icon: Timer, label: t('heatSoak.status') };
    case 'dispatching': return { tone: QUEUE_TONES.waiting, Icon: Timer, label: t('queue.status.dispatching') };
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

import { RefreshCw, Trash2 } from 'lucide-react';
import { type TimeFormat, formatRelativeTime } from '../utils/date';
import type { PrintQueueItem, Permission } from '../api/client';
import { QueueJobLine } from './queue/QueueJobLine';
import { resolveHistoryTone } from './queue/queueTones';
import { queueItemDisplayName } from '../utils/queueItemName';

const BUTTON_BASE =
  'flex h-11 w-11 items-center justify-center rounded-[10px] border transition-colors disabled:cursor-not-allowed disabled:opacity-40';

/**
 * A finished job in the History tab. It renders the same card as the active
 * queue (QueueJobLine) so the two tabs look alike, with the outcome in the
 * gutter and the failure or skip reason in the card's error footer.
 */
export function CompactHistoryRow({
  item,
  onRequeue,
  onRemove,
  timeFormat = 'system',
  hasPermission,
  canModify,
  t,
}: {
  item: PrintQueueItem;
  onRequeue: () => void;
  onRemove: () => void;
  timeFormat?: TimeFormat;
  hasPermission: (permission: Permission) => boolean;
  canModify: (resource: 'queue' | 'archives' | 'library', action: 'update' | 'delete' | 'reprint', createdById: number | null | undefined) => boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const status = resolveHistoryTone(item.status, t);
  const completedTime = item.completed_at || item.created_at;
  const canRequeue = hasPermission('queue:create');
  const canRemove = canModify('queue', 'delete', item.created_by_id);
  // Only failed and skipped jobs explain themselves; the line would otherwise
  // show any stray message in its red error footer.
  const shownItem = item.status === 'failed' || item.status === 'skipped'
    ? item
    : { ...item, error_message: null };

  return (
    <QueueJobLine
      item={shownItem}
      displayName={queueItemDisplayName(item)}
      timeFormat={timeFormat}
      t={t}
      status={status}
      titleAdornments={(
        <span
          className="flex-shrink-0 text-xs text-bambu-gray"
          title={completedTime ?? undefined}
        >
          {formatRelativeTime(completedTime, timeFormat, t)}
        </span>
      )}
      actions={(
        <>
          <button
            type="button"
            onClick={onRequeue}
            disabled={!canRequeue}
            title={!canRequeue ? t('queue.permissions.noRequeue') : t('queue.actions.requeue')}
            aria-label={t('queue.actions.requeue')}
            className={`${BUTTON_BASE} border-bambu-green/30 bg-bambu-green/10 text-green-700 hover:border-bambu-green/60 hover:bg-bambu-green/20 dark:text-green-400`}
          >
            <RefreshCw className="h-[18px] w-[18px]" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            disabled={!canRemove}
            title={!canRemove ? t('queue.permissions.noRemove') : t('common.remove')}
            aria-label={t('common.remove')}
            className={`${BUTTON_BASE} border-bambu-dark-tertiary bg-bambu-gray-light/10 text-bambu-gray-light hover:bg-bambu-gray-light/20`}
          >
            <Trash2 className="h-[18px] w-[18px]" />
          </button>
        </>
      )}
    />
  );
}

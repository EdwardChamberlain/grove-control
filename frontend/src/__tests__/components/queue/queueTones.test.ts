import { describe, expect, it } from 'vitest';
import { QUEUE_TONES, resolveQueueTone } from '../../../components/queue/queueTones';

const t = (key: string) => key;
const future = new Date(Date.now() + 3_600_000).toISOString();
const base = { scheduled_time: null, waiting_reason: null, manual_start: false, filament_short: false };

describe('resolveQueueTone', () => {
  it('uses green for printing and heat soaking', () => {
    expect(resolveQueueTone({ ...base, status: 'printing' }, 'RUNNING', t).tone).toBe(QUEUE_TONES.active);
    expect(resolveQueueTone({ ...base, status: 'preheating' }, 'RUNNING', t).tone).toBe(QUEUE_TONES.active);
  });

  it('uses orange for a paused print', () => {
    expect(resolveQueueTone({ ...base, status: 'printing' }, 'PAUSE', t).tone).toBe(QUEUE_TONES.paused);
  });

  it('uses purple when a pending job is waiting, staged or short of filament', () => {
    expect(resolveQueueTone({ ...base, status: 'pending', waiting_reason: 'Waiting for PETG' }, null, t).tone).toBe(QUEUE_TONES.waiting);
    expect(resolveQueueTone({ ...base, status: 'pending', filament_short: true }, null, t).tone).toBe(QUEUE_TONES.waiting);
    const staged = resolveQueueTone({ ...base, status: 'pending', manual_start: true }, null, t);
    expect(staged.tone).toBe(QUEUE_TONES.waiting);
    expect(staged.label).toBe('queue.badges.staged');
  });

  it('keeps scheduled, pending and dispatching jobs neutral because they need no user action', () => {
    const scheduled = resolveQueueTone({ ...base, status: 'pending', scheduled_time: future }, null, t);
    expect(scheduled.tone).toBe(QUEUE_TONES.neutral);
    expect(scheduled.label).toBe('queue.status.scheduled');
    expect(resolveQueueTone({ ...base, status: 'pending' }, null, t).tone).toBe(QUEUE_TONES.neutral);
    expect(resolveQueueTone({ ...base, status: 'dispatching' }, null, t).tone).toBe(QUEUE_TONES.neutral);
  });

  it('lets a waiting reason win over a future schedule', () => {
    const item = { ...base, status: 'pending' as const, scheduled_time: future, waiting_reason: 'Waiting for PETG' };
    expect(resolveQueueTone(item, null, t).tone).toBe(QUEUE_TONES.waiting);
  });
});

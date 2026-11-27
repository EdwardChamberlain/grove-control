import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { QueueTimelineView } from '../../components/QueueTimelineView';
import type { PrintQueueItem, Printer } from '../../api/client';

const HOUR_S = 3600;

const printer = (id: number, extra: Partial<Printer> = {}) =>
  ({ id, name: `P1S ${id}`, model: 'P1S', location: null, is_active: true, ...extra }) as Printer;

const modelJob = (id: number, extra: Partial<PrintQueueItem> = {}) =>
  ({
    id,
    printer_id: null,
    target_model: 'P1S',
    target_location: null,
    status: 'pending',
    position: id,
    manual_start: false,
    waiting_reason: null,
    scheduled_time: null,
    print_time_seconds: HOUR_S,
    archive_name: `Job ${id}`,
    ...extra,
  }) as unknown as PrintQueueItem;

const printingJob = (id: number, printerId: number) =>
  modelJob(id, {
    printer_id: printerId,
    target_model: null,
    status: 'printing',
    started_at: new Date().toISOString(),
  });

function renderTimeline(
  items: PrintQueueItem[],
  printers: Printer[],
  extra: {
    printersLoaded?: boolean;
    printersError?: boolean;
    printerStatuses?: Record<number, { progress?: number; remaining_time?: number; state?: string }>;
  } = {},
) {
  const t = (key: string) => key;
  return render(
    <QueueTimelineView
      queueItems={items}
      printers={printers}
      printerStatuses={{}}
      onItemClick={vi.fn()}
      t={t}
      {...extra}
    />,
  );
}

const startOf = (id: number) =>
  parseFloat(screen.getByTestId(`queue-timeline-item-${id}`).style.left.match(/([\d.]+)%/)![1]);
const topOf = (id: number) => screen.getByTestId(`queue-timeline-item-${id}`).style.top;
// Label of the lane a bar is drawn in.
const laneOf = (id: number) =>
  screen.getByTestId(`queue-timeline-item-${id}`).closest('div.flex.border-b')!.querySelector('span.truncate')!
    .textContent;

describe('QueueTimelineView job placement', () => {
  // P1S 1 is busy for the first hour; P1S 2 is idle.
  const printers = [printer(1), printer(2)];

  it('places each job on the printer it would be dispatched to', () => {
    renderTimeline([printingJob(10, 1), modelJob(1), modelJob(2), modelJob(3)], printers);

    // Job 1 takes the idle P1S 2 now; jobs 2 and 3 then start together, one per printer.
    expect(laneOf(1)).toBe('P1S 2');
    expect(startOf(1)).toBeLessThan(startOf(2));
    expect(startOf(2)).toBe(startOf(3));
    expect(laneOf(2)).not.toBe(laneOf(3));
    expect(screen.queryByText('queue.timeline.lane.noEligible')).not.toBeInTheDocument();
  });

  it('queues behind the only eligible printer', () => {
    renderTimeline(
      [printingJob(10, 1), modelJob(1), modelJob(2)],
      [printer(1), printer(2, { model: 'X1C' })],
    );
    expect(laneOf(1)).toBe('P1S 1');
    expect(laneOf(2)).toBe('P1S 1');
    expect(startOf(2)).toBeGreaterThan(startOf(1));
  });

  it('respects target location when picking printers', () => {
    renderTimeline(
      [
        printingJob(10, 1),
        modelJob(1, { target_location: 'Shed' }),
        modelJob(2, { target_location: 'Shed' }),
      ],
      [printer(1, { location: 'Shed' }), printer(2, { location: 'House' })],
    );
    expect(laneOf(1)).toBe('P1S 1');
    expect(laneOf(2)).toBe('P1S 1');
  });

  it('never starts a job before its scheduled time', () => {
    const later = new Date(Date.now() + 5 * 3600_000).toISOString();
    renderTimeline([modelJob(1, { scheduled_time: later })], printers);
    expect(startOf(1)).toBeGreaterThan(20);
  });

  it('puts a blocked job on the printer it could go onto, coloured as blocked', () => {
    renderTimeline(
      [printingJob(10, 1), modelJob(1), modelJob(2, { waiting_reason: 'Waiting on PETG' })],
      printers,
    );
    expect(laneOf(1)).toBe('P1S 2');
    // P1S 1 and P1S 2 are both free at 1h; the blocked job takes the first.
    expect(laneOf(2)).toBe('P1S 1');
    const bar = screen.getByTestId('queue-timeline-item-2');
    expect(bar).toHaveAttribute('data-status', 'waiting');
    expect(bar).toHaveTextContent('Waiting on PETG');
    // Purple, like a blocked job on the Queue tab.
    expect(bar.className).toContain('purple');
    expect(screen.queryByText('queue.timeline.lane.noEligible')).not.toBeInTheDocument();
  });

  it('starts a blocked job where the next machine frees up without taking its capacity', () => {
    renderTimeline(
      [
        printingJob(10, 1),
        modelJob(1),
        modelJob(2, { waiting_reason: 'Waiting on PETG' }),
        modelJob(3),
      ],
      printers,
    );
    expect(startOf(2)).toBeGreaterThan(startOf(1));
    // Same start as the placed job that takes that slot.
    expect(startOf(2)).toBe(startOf(3));
  });

  it('keeps a blocked job on the model lane when no printer is eligible', () => {
    renderTimeline(
      [modelJob(1, { waiting_reason: 'Waiting on PETG' })],
      [printer(1, { model: 'X1C' })],
    );
    expect(laneOf(1)).toBe('queue.timeline.lane.noEligible');
  });

  it('treats a wait that clears by itself like a normal queued job', () => {
    renderTimeline(
      [
        printingJob(10, 1),
        modelJob(1, { waiting_reason: 'Printer busy', waiting_needs_action: false }),
      ],
      printers,
    );
    const bar = screen.getByTestId('queue-timeline-item-1');
    expect(bar).toHaveAttribute('data-status', 'queued');
    expect(bar.className).not.toContain('purple');
    expect(laneOf(1)).toBe('P1S 2');
  });

  it('colours queued jobs neutral and printing jobs green, as on the Queue tab', () => {
    renderTimeline([printingJob(10, 1), modelJob(1)], printers);
    expect(screen.getByTestId('queue-timeline-item-10').className).toContain('bg-bambu-green');
    const queued = screen.getByTestId('queue-timeline-item-1').className;
    expect(queued).not.toContain('green');
    expect(queued).not.toContain('purple');
  });
});

describe('QueueTimelineView scheduled jobs', () => {
  const printers = [printer(1), printer(2)];
  const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
  // Expected left position (%) of a time h hours from now in the default 12h window; it starts
  // on the previous whole hour, so allow up to one hour of slack.
  const expectedPct = (h: number) => (h / 12) * 100;

  it('draws a printer-specific scheduled job at its time on that printer', () => {
    renderTimeline(
      [modelJob(1, { printer_id: 2, target_model: null, scheduled_time: inHours(6) })],
      printers,
    );
    expect(laneOf(1)).toBe('P1S 2');
    expect(startOf(1)).toBeGreaterThan(expectedPct(6));
    expect(startOf(1)).toBeLessThanOrEqual(expectedPct(6) + expectedPct(1));
  });

  it('draws a model job scheduled in the future on a printer at its time', () => {
    renderTimeline([modelJob(1, { scheduled_time: inHours(8) })], printers);
    expect(laneOf(1)).toBe('P1S 1');
    expect(startOf(1)).toBeGreaterThan(expectedPct(8));
    expect(startOf(1)).toBeLessThanOrEqual(expectedPct(8) + expectedPct(1));
  });

  it('runs two jobs scheduled for the same time side by side on separate printers', () => {
    const at = inHours(4);
    renderTimeline(
      [modelJob(1, { scheduled_time: at }), modelJob(2, { scheduled_time: at })],
      printers,
    );
    expect(laneOf(1)).not.toBe(laneOf(2));
    expect(startOf(1)).toBe(startOf(2));
  });

  it('keeps a job scheduled later behind an earlier ASAP job on a single printer', () => {
    renderTimeline(
      [
        // 0.9h, so the 1h ASAP job can never squeeze into the gap before it.
        modelJob(1, { scheduled_time: inHours(0.9) }),
        modelJob(2),
        modelJob(3, { scheduled_time: inHours(10) }),
      ],
      [printer(1)],
    );
    expect(startOf(1)).toBeLessThan(startOf(2));
    expect(startOf(2)).toBeLessThan(startOf(3));
    expect(startOf(3)).toBeGreaterThan(expectedPct(10));
  });

  it('fits a model job into the idle time before a job scheduled on that printer', () => {
    // P1S 1 has a job scheduled in 6h. A 1h ASAP "Any P1S" job fits before it.
    renderTimeline(
      [
        modelJob(9, { printer_id: 1, target_model: null, scheduled_time: inHours(6) }),
        modelJob(1, { scheduled_time: inHours(2) }),
        modelJob(2),
      ],
      [printer(1)],
    );
    expect(laneOf(1)).toBe('P1S 1');
    expect(startOf(2)).toBeLessThan(startOf(1));
    expect(startOf(1)).toBeLessThan(startOf(9));
  });

  it('moves a model job that does not fit before a scheduled job to after it', () => {
    // A 3h job cannot finish in the 1h before the scheduled job on the only printer.
    renderTimeline(
      [
        modelJob(9, { printer_id: 1, target_model: null, scheduled_time: inHours(1) }),
        modelJob(1, { print_time_seconds: 3 * HOUR_S, scheduled_time: inHours(0.1) }),
      ],
      [printer(1)],
    );
    expect(startOf(1)).toBeGreaterThan(startOf(9));
  });
});

describe('QueueTimelineView toolbar and bars', () => {
  const printers = [printer(1), printer(2)];
  // Width is `max(32px, calc(N% - 4px))`; return N.
  const widthOf = (id: number) =>
    parseFloat(screen.getByTestId(`queue-timeline-item-${id}`).style.width.match(/calc\(([\d.]+)%/)![1]);

  it('titles a bar with the job name, not the printer', () => {
    renderTimeline([printingJob(10, 1)], printers);
    const bar = screen.getByTestId('queue-timeline-item-10');
    expect(bar).toHaveTextContent('Job 10');
    expect(bar).not.toHaveTextContent('P1S');
  });

  it('offers 6h, 12h, 24h and 48h zoom, defaulting to 12h', async () => {
    const user = userEvent.setup();
    renderTimeline([printingJob(10, 1), modelJob(1)], printers);
    expect(screen.getByTestId('queue-timeline-zoom-12')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('queue-timeline-zoom-6')).toBeInTheDocument();
    expect(screen.getByTestId('queue-timeline-zoom-24')).toBeInTheDocument();
    expect(screen.getByTestId('queue-timeline-zoom-48')).toBeInTheDocument();

    const at12 = widthOf(1);
    await user.click(screen.getByTestId('queue-timeline-zoom-6'));
    expect(screen.getByTestId('queue-timeline-zoom-6')).toHaveAttribute('aria-pressed', 'true');
    // The same one-hour job takes twice the width of the track in a 6h window.
    expect(widthOf(1)).toBeCloseTo(at12 * 2, 1);
    await user.click(screen.getByTestId('queue-timeline-zoom-24'));
    expect(widthOf(1)).toBeCloseTo(at12 / 2, 1);
  });

  it('describes each printer lane: printing until, next job, or nothing queued', () => {
    renderTimeline(
      [printingJob(10, 1), modelJob(1)],
      [printer(1), printer(2), printer(3, { model: 'X1C' })],
    );
    expect(screen.getByText(/queue\.timeline\.lane\.printingFree/)).toBeInTheDocument();
    expect(screen.getByText(/queue\.timeline\.lane\.idleNext/)).toBeInTheDocument();
    expect(screen.getByText(/queue\.timeline\.lane\.idleEmpty/)).toBeInTheDocument();
  });

  it('shows the Now marker with the time and a legend', () => {
    renderTimeline([printingJob(10, 1)], printers);
    expect(screen.getByText(/queue\.timeline\.nowLabel/)).toBeInTheDocument();
    expect(screen.getByText('queue.timeline.legend.blocked')).toBeInTheDocument();
  });

  it('keeps a job no printer can take on its model lane instead of dropping it', () => {
    const at = new Date(Date.now() + 2 * 3600_000).toISOString();
    // Every P1S is deactivated, so no printer is eligible.
    renderTimeline(
      [modelJob(1, { scheduled_time: at })],
      [printer(1, { is_active: false }), printer(2, { is_active: false })],
    );
    expect(laneOf(1)).toBe('queue.timeline.lane.noEligible');
  });

  it('keeps a job whose target location has no printers on its model lane', () => {
    const at = new Date(Date.now() + 2 * 3600_000).toISOString();
    renderTimeline(
      [modelJob(1, { target_location: 'Garage', scheduled_time: at })],
      [printer(1, { location: 'Shed' })],
    );
    expect(laneOf(1)).toBe('queue.timeline.lane.noEligible');
  });

  it('commits a model lane when any job in it is scheduled, not just the first', () => {
    const at = new Date(Date.now() + 3 * 3600_000).toISOString();
    renderTimeline([modelJob(1), modelJob(2, { scheduled_time: at })], [printer(1)]);
    expect(screen.getByTestId('queue-timeline-item-1')).toBeInTheDocument();
    expect(screen.getByTestId('queue-timeline-item-2')).toBeInTheDocument();
  });

  it('does not treat a busy printer outside the target location as an anchor', () => {
    renderTimeline(
      [printingJob(10, 1), modelJob(1, { target_location: 'Shed' })],
      [printer(1, { location: 'House' }), printer(2, { location: 'Shed' })],
    );
    // The only active print is on a printer the job cannot use, so an ASAP
    // job has nothing to chain off and stays off the timeline.
    expect(screen.queryByTestId('queue-timeline-item-1')).not.toBeInTheDocument();
  });

  it('still shows a printer-specific job that is only short of filament, in purple', () => {
    renderTimeline(
      [printingJob(10, 1), modelJob(1, { printer_id: 1, target_model: null, filament_short: true })],
      printers,
    );
    const bar = screen.getByTestId('queue-timeline-item-1');
    expect(bar).toHaveAttribute('data-status', 'queued');
    expect(bar.className).toContain('purple');
  });

  it('explains a model job blocked only by filament shortage', () => {
    renderTimeline([printingJob(10, 1), modelJob(1, { filament_short: true })], printers);
    const bar = screen.getByTestId('queue-timeline-item-1');
    expect(bar).toHaveAttribute('data-status', 'waiting');
    expect(bar).toHaveTextContent('queue.filamentShort.rowBadge');
  });

  it('places a cross-model job on a variant model printer that is free sooner', () => {
    renderTimeline(
      [
        printingJob(10, 1),
        modelJob(1, {
          variants: [{ library_file_id: 1, filename: 'a.3mf', target_model: 'X1C', position: 0 }],
        }),
      ],
      [printer(1), printer(2, { name: 'X1C 2', model: 'X1C' })],
    );
    expect(laneOf(1)).toBe('X1C 2');
  });

  it('stacks blocked jobs that share a slot in their own rows, after the real jobs', () => {
    renderTimeline(
      [
        printingJob(10, 1),
        modelJob(1, { waiting_reason: 'Waiting on PETG', waiting_needs_action: true }),
        modelJob(2, { waiting_reason: 'Waiting on ABS', waiting_needs_action: true }),
        modelJob(3),
      ],
      [printer(1)],
    );
    // The real job claims the printer first; blocked jobs slot in after it.
    expect(startOf(3)).toBeLessThan(startOf(1));
    // Blocked jobs claim no time, so they share a start and stack.
    expect(laneOf(1)).toBe(laneOf(2));
    expect(startOf(1)).toBe(startOf(2));
    expect(topOf(1)).not.toBe(topOf(2));
  });

  it('shows an ASAP job with no eligible machine even when nothing anchors it', () => {
    // No scheduled job and nothing printing: an eligible ASAP job would stay
    // off the timeline, but a stuck one is worth surfacing.
    renderTimeline([modelJob(1, { target_model: 'H2D' })], [printer(1)]);
    expect(laneOf(1)).toBe('queue.timeline.lane.noEligible');
    expect(screen.getByTestId('queue-timeline-item-1')).toHaveAttribute('data-status', 'waiting');
  });

  it('stacks jobs with no eligible machine on one lane and omits the lane otherwise', () => {
    const { unmount } = renderTimeline(
      [modelJob(1, { target_model: 'H2D' }), modelJob(2, { target_model: 'A1' })],
      [printer(1)],
    );
    expect(laneOf(1)).toBe('queue.timeline.lane.noEligible');
    expect(laneOf(2)).toBe('queue.timeline.lane.noEligible');
    expect(topOf(1)).not.toBe(topOf(2));
    unmount();

    renderTimeline([printingJob(10, 1), modelJob(3)], [printer(1)]);
    expect(screen.queryByText('queue.timeline.lane.noEligible')).not.toBeInTheDocument();
  });

  it('holds model jobs back until the printer list has loaded', () => {
    // With no printers yet, every model job would look like it has no machine.
    renderTimeline([modelJob(1, { target_model: 'H2D' })], [], { printersLoaded: false });
    expect(screen.queryByTestId('queue-timeline-item-1')).not.toBeInTheDocument();
    expect(screen.queryByText('queue.timeline.lane.noEligible')).not.toBeInTheDocument();
    expect(screen.getByText('common.loading')).toBeInTheDocument();
  });

  it('says so when the printer list failed to load, rather than showing an empty board', () => {
    renderTimeline([modelJob(1)], [], { printersLoaded: false, printersError: true });
    expect(screen.getByRole('alert')).toHaveTextContent('common.errorLoading');
    expect(screen.queryByText('queue.timeline.lane.noEligible')).not.toBeInTheDocument();
    expect(screen.queryByTestId('queue-timeline-item-1')).not.toBeInTheDocument();
  });

  it('draws the progress track with a themed colour, not a fixed white', () => {
    renderTimeline([printingJob(10, 1)], [printer(1)], {
      printerStatuses: { 1: { progress: 40, state: 'RUNNING' } },
    });
    const track = screen.getByTestId('queue-timeline-item-10').querySelector('[aria-hidden]')!;
    expect(track.className).toContain('bg-bambu-gray-light');
    expect(track.className).not.toContain('bg-white');
  });

  it('draws a blocked printer-specific job on its printer after what is queued there', () => {
    renderTimeline(
      [
        printingJob(10, 1),
        modelJob(1, {
          printer_id: 1,
          target_model: null,
          waiting_reason: 'Waiting on PETG',
          waiting_needs_action: true,
        }),
      ],
      printers,
    );
    const bar = screen.getByTestId('queue-timeline-item-1');
    expect(bar).toHaveAttribute('data-status', 'waiting');
    expect(bar.className).toContain('purple');
    expect(laneOf(1)).toBe('P1S 1');
    // Starts when the running print ends, not at "now".
    expect(startOf(1)).toBeGreaterThan(startOf(10));
  });
});

describe('QueueTimelineView short jobs and window controls', () => {
  const printers = [printer(1)];
  const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
  const shortJobs = () => [
    modelJob(1, { printer_id: 1, target_model: null, scheduled_time: inHours(2), print_time_seconds: 1200 }),
    modelJob(2, { printer_id: 1, target_model: null, print_time_seconds: 1200 }),
  ];

  it('stacks short back-to-back jobs when their minimum bar width would overlap', async () => {
    const user = userEvent.setup();
    renderTimeline(shortJobs(), printers);
    await user.click(screen.getByTestId('queue-timeline-zoom-48'));
    // 20 minutes is a few px at 48h but bars are drawn at least 32px wide.
    expect(topOf(1)).not.toBe(topOf(2));
    // At 6h the same 10 minutes is wide enough to sit side by side.
    await user.click(screen.getByTestId('queue-timeline-zoom-6'));
    expect(topOf(1)).toBe(topOf(2));
  });

  it('moves the window by half its width and offers a way back to now', async () => {
    const user = userEvent.setup();
    renderTimeline([printingJob(10, 1)], printers);
    const range = () => screen.getByText(/→/).textContent;
    const before = range();
    expect(screen.queryByText('queue.timeline.window.now')).not.toBeInTheDocument();
    await user.click(screen.getByTitle('queue.timeline.window.later'));
    expect(range()).not.toBe(before);
    await user.click(screen.getByText('queue.timeline.window.now'));
    expect(range()).toBe(before);
    await user.click(screen.getByTitle('queue.timeline.window.earlier'));
    expect(range()).not.toBe(before);
  });

  it('shows an axis label every 2h at 12h zoom and every 6h at 48h', async () => {
    const user = userEvent.setup();
    renderTimeline([printingJob(10, 1)], printers);
    // Move the window so the Now pill is out of view and hides no labels.
    await user.click(screen.getByTitle('queue.timeline.window.later'));
    const labels = () => screen.queryAllByTestId('queue-timeline-tick').length;
    expect(labels()).toBe(6);
    await user.click(screen.getByTestId('queue-timeline-zoom-48'));
    expect(labels()).toBe(8);
    await user.click(screen.getByTestId('queue-timeline-zoom-24'));
    expect(labels()).toBe(6);
  });
});

describe('QueueTimelineView Now pill', () => {
  const originalRect = Element.prototype.getBoundingClientRect;
  const originalObserver = globalThis.ResizeObserver;

  afterEach(() => {
    vi.useRealTimers();
    Element.prototype.getBoundingClientRect = originalRect;
    globalThis.ResizeObserver = originalObserver;
  });

  it('hides exactly the axis labels the pill would cover, by pixel width', () => {
    // 22:10 local, so the 12h window starts at 22:00 and Now sits 10 minutes in
    // (1.39% of the track). Ticks are every 2h: 0%, 16.7%, 33.3% ... 83.3%.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 26, 22, 10, 0));

    let notify: () => void = () => {};
    let width = 1000;
    Element.prototype.getBoundingClientRect = function () {
      return { width, height: 40, top: 0, left: 0, right: width, bottom: 40, x: 0, y: 0, toJSON: () => ({}) };
    };
    globalThis.ResizeObserver = class {
      constructor(cb: () => void) {
        notify = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    renderTimeline([printingJob(10, 1)], [printer(1)]);
    const shownTicks = () =>
      screen.queryAllByTestId('queue-timeline-tick').map((el) =>
        Math.round(parseFloat(el.style.left)),
      );

    // 1000px: only the 0% label is within 72px before / 140px after Now.
    expect(shownTicks()).toEqual([17, 33, 50, 67, 83]);

    // 300px: the same pixel zone spans more of the axis, hiding 0%, 17% and 33%.
    width = 300;
    act(() => notify());
    expect(shownTicks()).toEqual([50, 67, 83]);
  });

  it('labels a deactivated printer instead of showing it as idle capacity', () => {
    renderTimeline(
      [printingJob(10, 1)],
      [printer(1), printer(2, { is_active: false }), printer(3)],
    );
    expect(screen.getAllByText('queue.timeline.lane.deactivated')).toHaveLength(1);
    // The other idle printer is still described as idle.
    expect(screen.getAllByText('queue.timeline.lane.idleEmpty')).toHaveLength(1);
    expect(screen.getByText('P1S 2')).toHaveClass('text-bambu-gray');
  });
});

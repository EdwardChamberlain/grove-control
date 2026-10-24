/**
 * QueuePage: selection, bulk edit/cancel, reordering, group-by-printer and
 * the resume-after-failure banner.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { QueuePage } from '../../pages/QueuePage';
import { server } from '../mocks/server';
import { setAuthToken } from '../../api/client';

function queueItem(overrides: Record<string, unknown>) {
  return {
    id: 1,
    printer_id: 1,
    archive_id: 1,
    position: 1,
    status: 'pending',
    scheduled_time: null,
    require_previous_success: false,
    auto_off_after: false,
    manual_start: false,
    ams_mapping: null,
    plate_id: null,
    bed_levelling: 'auto',
    flow_cali: 'auto',
    vibration_cali: true,
    layer_inspect: false,
    timelapse: false,
    use_ams: true,
    started_at: null,
    completed_at: null,
    error_message: null,
    created_at: '2026-01-01T00:00:00Z',
    archive_name: 'Benchy',
    archive_thumbnail: null,
    printer_name: 'Workshop X1C',
    print_time_seconds: 3600,
    filament_used_grams: 20,
    ...overrides,
  };
}

const printers = [
  { id: 1, name: 'Workshop X1C', model: 'X1C', location: 'Workshop', nozzle_count: 1 },
  { id: 2, name: 'Office H2D', model: 'H2D', location: 'Office', nozzle_count: 2 },
];

const pending = [
  queueItem({ id: 1, position: 1, archive_name: 'Benchy' }),
  queueItem({ id: 2, position: 2, archive_name: 'Bracket' }),
  queueItem({ id: 3, position: 3, archive_name: 'Clip' }),
];

interface Captured {
  bulk: unknown[];
  cancelled: number[];
  reorder: unknown[];
  resumed: number[];
  deleted: number[];
  settings: unknown[];
}

function useQueue(items: unknown[]): Captured {
  const captured: Captured = { bulk: [], cancelled: [], reorder: [], resumed: [], deleted: [], settings: [] };
  server.use(
    http.get('/api/v1/queue/', () => HttpResponse.json(items)),
    http.get('/api/v1/printers/', () => HttpResponse.json(printers)),
    http.patch('/api/v1/queue/bulk', async ({ request }) => {
      captured.bulk.push(await request.json());
      return HttpResponse.json({ updated_count: 2, skipped_count: 0, message: 'Updated 2 items' });
    }),
    http.post('/api/v1/queue/:id/cancel', ({ params }) => {
      captured.cancelled.push(Number(params.id));
      return HttpResponse.json({ success: true });
    }),
    http.post('/api/v1/queue/reorder', async ({ request }) => {
      captured.reorder.push(await request.json());
      return HttpResponse.json({ message: 'ok' });
    }),
    http.post('/api/v1/queue/printer/:id/resume', ({ params }) => {
      captured.resumed.push(Number(params.id));
      return HttpResponse.json({ acknowledged: 1, restored: 2 });
    }),
    http.delete('/api/v1/queue/:id', ({ params }) => {
      captured.deleted.push(Number(params.id));
      return HttpResponse.json({ success: true });
    }),
    http.put('/api/v1/settings/', async ({ request }) => {
      captured.settings.push(await request.json());
      return HttpResponse.json({});
    }),
  );
  return captured;
}

/** The labelled row inside the bulk-edit modal (TriState / CalibrationMode toggles). */
function toggleRow(label: string) {
  return screen.getByText(label).parentElement as HTMLElement;
}

beforeEach(() => {
  vi.mocked(localStorage.getItem).mockImplementation((key: string) => {
    if (key === 'queue.historyCollapsed') return 'false';
    if (key === 'queue.viewMode') return 'list';
    return null;
  });
});

describe('QueuePage selection and bulk actions', () => {
  it('selects and deselects every pending item', async () => {
    useQueue(pending);
    const user = userEvent.setup();
    render(<QueuePage />);

    await user.click(await screen.findByRole('button', { name: 'Select All' }));
    expect(screen.getByText('3 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Deselect All' }));
    expect(screen.queryByText('3 selected')).not.toBeInTheDocument();
  });

  it('bulk edit sends only the settings that were changed', async () => {
    const captured = useQueue(pending);
    const user = userEvent.setup();
    render(<QueuePage />);

    await user.click(await screen.findByRole('button', { name: 'Select All' }));
    await user.click(screen.getByRole('button', { name: /Edit Selected/ }));

    const apply = screen.getByRole('button', { name: 'Apply Changes' });
    expect(apply).toBeDisabled();

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'Office H2D' }));
    await user.click(within(toggleRow('Staged (manual start)')).getByRole('button', { name: 'On' }));
    await user.click(within(toggleRow('Timelapse')).getByRole('button', { name: 'Off' }));
    await user.click(within(toggleRow('Bed levelling')).getByRole('button', { name: 'Off' }));
    // Office H2D is dual-nozzle, so its calibration toggle is offered.
    await user.click(within(toggleRow('Nozzle offset calibration')).getByRole('button', { name: 'On' }));
    // Choosing "no change" again drops a setting from the request.
    await user.click(within(toggleRow('Use AMS')).getByRole('button', { name: 'Off' }));
    await user.click(within(toggleRow('Use AMS')).getByRole('button', { name: '—' }));

    await user.click(apply);

    await waitFor(() => expect(captured.bulk).toHaveLength(1));
    expect(captured.bulk[0]).toEqual({
      item_ids: [1, 2, 3],
      printer_id: 2,
      manual_start: true,
      timelapse: false,
      bed_levelling: 'off',
      nozzle_offset_cali: 'on',
    });
    expect(await screen.findByText('Updated 2 items')).toBeInTheDocument();
    expect(screen.queryByText('3 selected')).not.toBeInTheDocument();
  });

  it('bulk edit can unassign the printer', async () => {
    const captured = useQueue(pending);
    const user = userEvent.setup();
    render(<QueuePage />);

    await user.click(await screen.findByRole('button', { name: 'Select All' }));
    await user.click(screen.getByRole('button', { name: /Edit Selected/ }));
    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'Unassigned' }));
    await user.click(screen.getByRole('button', { name: 'Apply Changes' }));

    await waitFor(() => expect(captured.bulk).toEqual([{ item_ids: [1, 2, 3], printer_id: null }]));
  });

  it('bulk cancel cancels each selected item', async () => {
    const captured = useQueue(pending);
    const user = userEvent.setup();
    render(<QueuePage />);

    await user.click(await screen.findByRole('button', { name: 'Select All' }));
    await user.click(screen.getByRole('button', { name: /Cancel Selected/ }));

    await waitFor(() => expect(captured.cancelled).toEqual([1, 2, 3]));
    expect(await screen.findByText('Cancelled 3 item(s)')).toBeInTheDocument();
  });
});

describe('QueuePage reordering', () => {
  it('moves an item down with the move button', async () => {
    const captured = useQueue(pending);
    const user = userEvent.setup();
    render(<QueuePage />);

    const downButtons = await screen.findAllByRole('button', { name: /move down/i });
    await user.click(downButtons[0]);

    await waitFor(() => expect(captured.reorder).toHaveLength(1));
    expect(captured.reorder[0]).toEqual({
      items: [
        { id: 2, position: 1 },
        { id: 1, position: 2 },
        { id: 3, position: 3 },
      ],
    });
  });

  it('moves an item up with the move button', async () => {
    const captured = useQueue(pending);
    const user = userEvent.setup();
    render(<QueuePage />);

    const upButtons = await screen.findAllByRole('button', { name: /move up/i });
    expect(upButtons[0]).toBeDisabled();
    await user.click(upButtons[2]);

    await waitFor(() => expect(captured.reorder).toHaveLength(1));
    expect(captured.reorder[0]).toEqual({
      items: [
        { id: 1, position: 1 },
        { id: 3, position: 2 },
        { id: 2, position: 3 },
      ],
    });
  });
});

describe('QueuePage layouts and filters', () => {
  it('groups pending jobs by printer and model', async () => {
    useQueue([
      queueItem({ id: 1, archive_name: 'On printer' }),
      queueItem({ id: 2, printer_id: null, printer_name: null, target_model: 'P1S', archive_name: 'Any P1S job' }),
      queueItem({ id: 3, printer_id: null, printer_name: null, archive_name: 'Floating job' }),
    ]);
    const user = userEvent.setup();
    render(<QueuePage />);

    await user.click(await screen.findByRole('button', { name: /By Printer/ }));

    const headers = await screen.findAllByText(/^(Workshop X1C|Any P1S|Unassigned)$/, { selector: 'span.font-semibold' });
    // Printers and models sort by name; unassigned jobs come last.
    expect(headers.map((el) => el.textContent)).toEqual(['Any P1S', 'Workshop X1C', 'Unassigned']);
  });

  it('toggles shortest-job-first scheduling', async () => {
    const captured = useQueue(pending);
    const user = userEvent.setup();
    render(<QueuePage />);

    await user.click(await screen.findByRole('button', { name: /SJF/ }));

    await waitFor(() => expect(captured.settings).toEqual([{ queue_shortest_first: true }]));
  });

  it('sorts the pending list by name', async () => {
    useQueue([
      queueItem({ id: 1, position: 1, archive_name: 'Zebra' }),
      queueItem({ id: 2, position: 2, archive_name: 'Apple' }),
    ]);
    const user = userEvent.setup();
    render(<QueuePage />);

    await screen.findByText('Zebra');
    await user.click(screen.getByRole('button', { name: /Sort by Position|Manual order|Position/ }));
    await user.click(screen.getByRole('button', { name: /Sort by Name|Name/ }));

    const names = screen.getAllByText(/^(Zebra|Apple)$/).map((el) => el.textContent);
    expect(names).toEqual(['Apple', 'Zebra']);
  });
});

describe('QueuePage resume after failure (#1818)', () => {
  it('offers to resume a printer blocked by a failed print', async () => {
    const captured = useQueue([
      queueItem({ id: 7, status: 'skipped', error_message: 'Previous print failed or was aborted' }),
      queueItem({ id: 8, status: 'skipped', error_message: 'Previous print failed or was aborted' }),
      queueItem({ id: 9, status: 'skipped', error_message: 'Filament short' }),
    ]);
    const user = userEvent.setup();
    render(<QueuePage />);

    expect(
      await screen.findByText('Workshop X1C is blocked by a previous-print failure — 2 job(s) skipped'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Resume after failure' }));
    const dialog = await screen.findByText('Resume queue after failure?');
    expect(dialog).toBeInTheDocument();
    const confirmButtons = screen.getAllByRole('button', { name: 'Resume after failure' });
    await user.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => expect(captured.resumed).toEqual([1]));
  });
});

describe('QueuePage history', () => {
  it('clears every history item after confirmation', async () => {
    const captured = useQueue([
      queueItem({ id: 1 }),
      queueItem({ id: 4, status: 'completed', completed_at: '2026-01-02T00:00:00Z' }),
      queueItem({ id: 5, status: 'failed', completed_at: '2026-01-03T00:00:00Z' }),
    ]);
    const user = userEvent.setup();
    render(<QueuePage />);

    await user.click(await screen.findByRole('button', { name: /^History/ }));
    await user.click(await screen.findByRole('button', { name: /Clear History/i }));
    const buttons = await screen.findAllByRole('button', { name: /Clear History/i });
    await user.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(captured.deleted.sort()).toEqual([4, 5]));
  });
});

describe('QueuePage confirmations', () => {
  it('cancels a pending job after confirmation', async () => {
    const captured = useQueue(pending);
    const user = userEvent.setup();
    render(<QueuePage />);

    await user.click((await screen.findAllByTitle('Cancel'))[0]);
    expect(await screen.findByText('Cancel Scheduled Print')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel Print' }));

    await waitFor(() => expect(captured.cancelled).toEqual([1]));
    expect(await screen.findByText('Queue item cancelled')).toBeInTheDocument();
  });

  it('reports a failed cancel', async () => {
    useQueue(pending);
    server.use(http.post('/api/v1/queue/:id/cancel', () => HttpResponse.json({ detail: 'nope' }, { status: 500 })));
    const user = userEvent.setup();
    render(<QueuePage />);

    await user.click((await screen.findAllByTitle('Cancel'))[0]);
    await user.click(await screen.findByRole('button', { name: 'Cancel Print' }));

    expect(await screen.findByText('Failed to cancel item')).toBeInTheDocument();
  });

  it('stops a printing job after confirmation', async () => {
    const stopped: number[] = [];
    useQueue([queueItem({ id: 5, status: 'printing', started_at: '2026-01-01T10:00:00Z', archive_name: 'Running' })]);
    server.use(
      http.post('/api/v1/queue/:id/stop', ({ params }) => {
        stopped.push(Number(params.id));
        return HttpResponse.json({ success: true });
      }),
    );
    const user = userEvent.setup();
    render(<QueuePage />);

    await user.click((await screen.findAllByTitle('Stop Print'))[0]);
    const stopButtons = await screen.findAllByRole('button', { name: 'Stop Print' });
    await user.click(stopButtons[stopButtons.length - 1]);

    await waitFor(() => expect(stopped).toEqual([5]));
    expect(await screen.findByText('Print stopped')).toBeInTheDocument();
  });
});

describe('QueuePage ordering', () => {
  it('shows shortest-job-first order when the scheduler uses it', async () => {
    useQueue([
      queueItem({ id: 1, position: 1, archive_name: 'Long', print_time_seconds: 7200 }),
      queueItem({ id: 2, position: 2, archive_name: 'Short', print_time_seconds: 600 }),
      queueItem({ id: 3, position: 3, archive_name: 'Jumped', print_time_seconds: 9000, been_jumped: true }),
      queueItem({ id: 4, position: 4, archive_name: 'Unknown', print_time_seconds: null }),
    ]);
    server.use(http.get('/api/v1/settings/', () => HttpResponse.json({ queue_shortest_first: true })));
    render(<QueuePage />);

    await screen.findByText('Long');
    await waitFor(() => {
      const names = screen.getAllByText(/^(Long|Short|Jumped|Unknown)$/).map((el) => el.textContent);
      // Jumped jobs first (starvation guard), then shortest, unknown time last.
      expect(names).toEqual(['Jumped', 'Short', 'Long', 'Unknown']);
    });
    // Manual reordering is off while the scheduler picks the order.
    expect(screen.queryByRole('button', { name: /move up/i })).not.toBeInTheDocument();
  });

  it('sorts by printer, descending', async () => {
    useQueue([
      queueItem({ id: 1, position: 1, archive_name: 'On A', printer_name: 'Alpha' }),
      queueItem({ id: 2, position: 2, archive_name: 'On B', printer_name: 'Bravo' }),
    ]);
    const user = userEvent.setup();
    render(<QueuePage />);

    await screen.findByText('On A');
    await user.click(screen.getByRole('button', { name: 'Sort by Position' }));
    await user.click(screen.getByRole('button', { name: 'Sort by Printer' }));
    await user.click(screen.getByTitle('Ascending'));

    const names = screen.getAllByText(/^On [AB]$/).map((el) => el.textContent);
    expect(names).toEqual(['On B', 'On A']);
  });
});

describe('QueuePage reordering own jobs', () => {
  it('only swaps positions among the jobs the user may move', async () => {
    setAuthToken('owner-token');
    const captured = useQueue([
      queueItem({ id: 1, position: 1, archive_name: 'Mine 1', created_by_id: 7 }),
      queueItem({ id: 2, position: 2, archive_name: 'Mine 2', created_by_id: 7 }),
      queueItem({ id: 3, position: 3, archive_name: 'Theirs', created_by_id: 9 }),
    ]);
    server.use(
      http.get('*/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: true, requires_setup: false })),
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json({ id: 7, username: 'owner', is_admin: false, permissions: ['queue:reorder', 'queue:update_own', 'queue:read'] }),
      ),
    );
    const user = userEvent.setup();
    render(<QueuePage />);

    await screen.findByText('Mine 1');
    const downButtons = await screen.findAllByRole('button', { name: /move down/i });
    await user.click(downButtons[0]);

    await waitFor(() => expect(captured.reorder).toHaveLength(1));
    expect(captured.reorder[0]).toEqual({
      items: [
        { id: 2, position: 1 },
        { id: 1, position: 2 },
      ],
    });
    setAuthToken(null);
  });
});

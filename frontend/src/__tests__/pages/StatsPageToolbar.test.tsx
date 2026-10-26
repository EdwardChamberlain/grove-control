/**
 * StatsPage toolbar: every timeframe preset (short ranges switch the print
 * calendar to an hourly heatmap), a custom range, CSV / Excel export, cost
 * recalculation and resetting the layout.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { StatsPage } from '../../pages/StatsPage';

const hoursAgo = (n: number) => new Date(Date.now() - n * 3600000).toISOString();

const archive = (id: number, created: string, status = 'completed') => ({
  id, created_at: created, started_at: created, completed_at: created, print_name: `Print ${id}`, status,
  printer_id: 1, filament_type: 'PLA', filament_color: '#00FF00', filament_used_grams: 20,
  actual_time_seconds: 3600, print_time_seconds: 3600, cost: 1, quantity: 1,
});

let slimRequests: URLSearchParams[];
let calls: string[];

beforeEach(() => {
  slimRequests = [];
  calls = [];
  vi.mocked(localStorage.getItem).mockReturnValue(null);
  server.use(
    http.get('/api/v1/archives/stats', () =>
      HttpResponse.json({ total_prints: 4, successful_prints: 3, failed_prints: 1, cancelled_prints: 0, total_print_time_hours: 4,
        total_filament_grams: 80, total_cost: 4, prints_by_filament_type: { PLA: 4 }, prints_by_printer: { '1': 4 },
        average_time_accuracy: 99, time_accuracy_by_printer: { '1': 99 }, total_energy_kwh: 1, total_energy_cost: 0.2 }),
    ),
    http.get('/api/v1/printers/', () => HttpResponse.json([{ id: 1, name: 'X1 Carbon', model: 'X1C', enabled: true }])),
    http.get('/api/v1/archives/slim', ({ request }) => {
      slimRequests.push(new URL(request.url).searchParams);
      return HttpResponse.json([archive(1, hoursAgo(1)), archive(2, hoursAgo(2)), archive(3, hoursAgo(2), 'failed'), archive(4, hoursAgo(30))]);
    }),
    http.get('/api/v1/settings/', () => HttpResponse.json({ currency: 'USD' })),
    http.get('/api/v1/archives/analysis/failures', () =>
      HttpResponse.json({ period_days: 30, total_prints: 4, failed_prints: 1, failure_rate: 25, failures_by_reason: {}, failures_by_filament: {}, failures_by_printer: {}, failures_by_hour: {}, recent_failures: [], trend: [] }),
    ),
    http.get('/api/v1/archives/stats/export', ({ request }) => {
      calls.push(`export ${new URL(request.url).searchParams.get('format')}`);
      return new HttpResponse('data', { headers: { 'content-disposition': 'attachment; filename="stats.csv"' } });
    }),
    http.post('/api/v1/archives/recalculate-costs', () => {
      calls.push('recalculate');
      return HttpResponse.json({ message: 'ok', updated: 12 });
    }),
    http.put('/api/v1/settings/', () => HttpResponse.json({})),
  );
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});

async function ready() {
  render(<StatsPage />);
  await screen.findByText('Recalculate Costs');
}

async function pickTimeframe(user: ReturnType<typeof userEvent.setup>, label: string) {
  const current = screen.getAllByRole('button').find((b) => /Today|This Week|This Month|Last \d+ Days|This Year|All Time|Custom Range|\d{4}-\d{2}-\d{2}/.test(b.textContent ?? '')) as HTMLElement;
  await user.click(current);
  await user.click(await screen.findByRole('button', { name: label }));
}

describe('timeframes', () => {
  it.each(['Today', 'This Week', 'This Month', 'Last 7 Days', 'Last 90 Days', 'This Year'])(
    'requests archives from a start date for %s',
    async (label) => {
      const user = userEvent.setup();
      await ready();
      const before = slimRequests.length;

      await pickTimeframe(user, label);

      await waitFor(() => expect(slimRequests.length).toBeGreaterThan(before));
      expect(slimRequests[slimRequests.length - 1].get('date_from')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    },
  );

  it('shows an hourly heatmap for ranges of a week or less', async () => {
    const user = userEvent.setup();
    await ready();
    expect(screen.queryByText('12am')).not.toBeInTheDocument();

    await pickTimeframe(user, 'Last 7 Days');

    expect(await screen.findByText('12am')).toBeInTheDocument();
  });

  it('goes back to all time without a date filter', async () => {
    const user = userEvent.setup();
    await ready();
    await pickTimeframe(user, 'Today');
    await waitFor(() => expect(slimRequests.at(-1)?.get('date_from')).not.toBeNull());

    await pickTimeframe(user, 'All Time');

    await waitFor(() => expect(slimRequests.at(-1)?.get('date_from')).toBeNull());
  });

  it('sets a custom range', async () => {
    const user = userEvent.setup();
    await ready();

    await pickTimeframe(user, 'Custom Range');
    const dateInputs = () => Array.from(document.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
    fireEvent.change(dateInputs()[0], { target: { value: '2026-01-01' } });
    // Each change refetches and re-renders the picker, so look the inputs up again.
    await waitFor(() => expect(dateInputs()).toHaveLength(2));
    fireEvent.change(dateInputs()[1], { target: { value: '2026-01-05' } });
    // New dates refetch, so the page briefly shows its loading state.
    await user.click(await screen.findByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(slimRequests.at(-1)?.get('date_from')).toBe('2026-01-01'));
    expect(slimRequests.at(-1)?.get('date_to')).toBe('2026-01-05');
  });
});

describe('toolbar actions', () => {
  it('exports as CSV and Excel', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const user = userEvent.setup();
    await ready();

    await user.click(screen.getByRole('button', { name: /Export Stats/ }));
    await user.click(screen.getByRole('button', { name: 'Export as CSV' }));
    expect(await screen.findByText('Export downloaded')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Export Stats/ }));
    await user.click(screen.getByRole('button', { name: 'Export as Excel' }));
    await waitFor(() => expect(calls).toEqual(['export csv', 'export xlsx']));
    click.mockRestore();
  });

  it('reports a failed export', async () => {
    server.use(http.get('/api/v1/archives/stats/export', () => HttpResponse.json({}, { status: 500 })));
    const user = userEvent.setup();
    await ready();

    await user.click(screen.getByRole('button', { name: /Export Stats/ }));
    await user.click(screen.getByRole('button', { name: 'Export as CSV' }));

    expect(await screen.findByText('Export failed')).toBeInTheDocument();
  });

  it('recalculates costs', async () => {
    const user = userEvent.setup();
    await ready();

    await user.click(screen.getByRole('button', { name: /Recalculate Costs/ }));

    await waitFor(() => expect(calls).toContain('recalculate'));
    expect(await screen.findByText('Recalculated costs for 12 archives')).toBeInTheDocument();
  });

  it('reports a failed recalculation', async () => {
    server.use(http.post('/api/v1/archives/recalculate-costs', () => HttpResponse.json({}, { status: 500 })));
    const user = userEvent.setup();
    await ready();

    await user.click(screen.getByRole('button', { name: /Recalculate Costs/ }));

    expect(await screen.findByText('Failed to recalculate costs')).toBeInTheDocument();
  });

  it('resets the layout', async () => {
    const user = userEvent.setup();
    await ready();

    await user.click(screen.getByRole('button', { name: /Reset Layout/ }));

    expect(await screen.findByText('Layout reset')).toBeInTheDocument();
  });
});

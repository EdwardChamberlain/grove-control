/**
 * MaintenancePage: filament-change based intervals (#337). A task can be due after a
 * number of filament changes (the initial load of each job plus every change defined
 * in its sliced file); the count since the last service is shown, and completed tasks
 * keep the change count in the maintenance log.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, type JsonBodyType } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { MaintenancePage } from '../../pages/MaintenancePage';

const item = (overrides: Record<string, unknown>) => ({
  printer_id: 1,
  printer_name: 'X1 Carbon',
  printer_model: 'X1C',
  maintenance_type_icon: 'Wrench',
  maintenance_type_wiki_url: null,
  enabled: true,
  interval_hours: 20,
  interval_type: 'changes',
  current_hours: 500,
  hours_since_maintenance: 0,
  hours_until_due: 0,
  days_since_maintenance: null,
  days_until_due: null,
  current_jobs: 120,
  jobs_since_maintenance: null,
  jobs_until_due: null,
  current_changes: 300,
  changes_since_maintenance: 7,
  changes_until_due: 13,
  is_due: false,
  is_warning: false,
  last_performed_at: null,
  ...overrides,
});

const overview = [
  {
    printer_id: 1,
    printer_name: 'X1 Carbon',
    printer_model: 'X1C',
    is_active: true,
    total_print_hours: 512.4,
    total_print_jobs: 120,
    total_filament_changes: 300,
    due_count: 1,
    warning_count: 2,
    maintenance_items: [
      item({ id: 31, maintenance_type_id: 31, maintenance_type_name: 'Replace Cutter Blade', changes_since_maintenance: 23, changes_until_due: -3, is_due: true }),
      item({ id: 32, maintenance_type_id: 32, maintenance_type_name: 'Clean AMS Path', changes_since_maintenance: 18, changes_until_due: 2, is_warning: true }),
      item({ id: 33, maintenance_type_id: 33, maintenance_type_name: 'Check PTFE Tubes', changes_since_maintenance: 19, changes_until_due: 1, is_warning: true }),
      item({ id: 34, maintenance_type_id: 34, maintenance_type_name: 'Oil Cutter Pivot' }),
    ],
  },
  { printer_id: 2, printer_name: 'P1S', printer_model: 'P1S', is_active: true, total_print_hours: 10, total_print_jobs: 0, total_filament_changes: 0, due_count: 0, warning_count: 0, maintenance_items: [] },
];

const types = [
  { id: 31, name: 'Replace Cutter Blade', description: null, default_interval_hours: 20, interval_type: 'changes', icon: 'Wrench', wiki_url: null, is_system: false, created_at: '' },
  { id: 35, name: 'Swap Nozzle Wiper', description: null, default_interval_hours: 1, interval_type: 'changes', icon: 'Wrench', wiki_url: null, is_system: false, created_at: '' },
];

const logEntry = {
  id: 1,
  printer_id: 1,
  printer_name: 'X1 Carbon',
  entry_type: 'scheduled' as const,
  title: 'Replace Cutter Blade',
  notes: null,
  occurred_at: '2024-01-02T10:00:00Z',
  hours_at_maintenance: 100,
  jobs_at_maintenance: null,
  changes_at_maintenance: 24,
  created_by_id: null,
  created_by_username: null,
  updated_by_id: null,
  updated_by_username: null,
  created_at: '2024-01-02T10:00:00Z',
  updated_at: '2024-01-02T10:00:00Z',
};

let calls: { method: string; path: string; body: unknown }[];

beforeEach(() => {
  calls = [];
  const record = (status = 200, response: JsonBodyType = {}) =>
    async ({ request }: { request: Request }) => {
      const text = await request.text();
      const url = new URL(request.url);
      calls.push({ method: request.method, path: url.pathname + url.search, body: text ? JSON.parse(text) : null });
      return HttpResponse.json(response, { status });
    };
  server.use(
    http.get('/api/v1/maintenance/overview', () => HttpResponse.json(overview)),
    http.get('/api/v1/maintenance/types', () => HttpResponse.json(types)),
    http.get('/api/v1/maintenance/logs', () => HttpResponse.json({ items: [logEntry], next_cursor: null })),
    http.post('/api/v1/maintenance/printers/:pid/assign/:tid', record()),
    http.post('/api/v1/maintenance/types', record(200, { id: 40 })),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

const paths = () => calls.map((c) => `${c.method} ${c.path}`);

describe('change-based task rows', () => {
  async function openStatus() {
    render(<MaintenancePage />);
    await screen.findByRole('heading', { name: 'All machines' });
  }
  const row = (name: string) => screen.getByRole('group', { name: new RegExp(`^${name}`) });

  it('counts down the changes left, due soon or overdue', async () => {
    await openStatus();

    expect(within(row('Replace Cutter Blade')).getByText('3 changes')).toBeInTheDocument();
    expect(within(row('Replace Cutter Blade')).getByText('overdue')).toBeInTheDocument();
    expect(within(row('Replace Cutter Blade')).getByText('23 changes / 20 changes')).toBeInTheDocument();
    expect(within(row('Clean AMS Path')).getByText('2 changes')).toBeInTheDocument();
    // A single change reads naturally rather than "1 changes".
    expect(within(row('Check PTFE Tubes')).getByText('1 change')).toBeInTheDocument();
    expect(within(row('Oil Cutter Pivot')).getByText('13 changes')).toBeInTheDocument();
    expect(within(row('Oil Cutter Pivot')).getByText('left')).toBeInTheDocument();
  });

  it('does not overflow the progress bar for an overdue task', async () => {
    await openStatus();

    const bar = within(row('Replace Cutter Blade')).getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '100');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('100%');
  });
});

describe('change-based settings', () => {
  async function openSettings(user: ReturnType<typeof userEvent.setup>) {
    render(<MaintenancePage />);
    await screen.findByRole('heading', { name: 'All machines' });
    await user.click(screen.getByRole('button', { name: /^Settings$/ }));
    await screen.findByText('Maintenance Types');
  }

  it('lists a change-based type with its interval in changes', async () => {
    const user = userEvent.setup();
    await openSettings(user);

    expect(screen.getAllByText('20 changes').length).toBeGreaterThanOrEqual(1);
    // A single change reads naturally rather than "1 changes".
    expect(screen.getAllByText('1 change').length).toBeGreaterThanOrEqual(1);
  });

  it('adds a custom type that counts filament changes', async () => {
    const user = userEvent.setup();
    await openSettings(user);

    await user.click(screen.getByRole('button', { name: /Add Custom Type/ }));
    await user.type(screen.getByPlaceholderText('e.g., Replace HEPA Filter'), 'Grease Cutter');
    await user.click(screen.getByRole('combobox', { name: /Print Hours/ }));
    await user.click(await screen.findByRole('option', { name: 'Filament Changes' }));

    // Switching the type swaps the unit label and a sensible default count.
    expect(screen.getByText('Interval (filament changes)')).toBeInTheDocument();
    expect(screen.getByDisplayValue('20')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'P1S' }));
    await user.click(screen.getByRole('button', { name: 'Add Type' }));

    await waitFor(() => expect(paths()).toContain('POST /api/v1/maintenance/printers/2/assign/40'));
    expect(calls.find((c) => c.path === '/api/v1/maintenance/types')!.body).toMatchObject({
      name: 'Grease Cutter', default_interval_hours: 20, interval_type: 'changes',
    });
  });
});

describe('maintenance log', () => {
  it('shows the change count recorded when a task was completed', async () => {
    const user = userEvent.setup();
    render(<MaintenancePage />);

    await user.click(await screen.findByText('Log'));

    expect(await screen.findByText('Replace Cutter Blade')).toBeInTheDocument();
    expect(screen.getByText('100.0h · 24 changes')).toBeInTheDocument();
  });

  it('shows both counts when an entry recorded both', async () => {
    server.use(
      http.get('/api/v1/maintenance/logs', () =>
        HttpResponse.json({ items: [{ ...logEntry, jobs_at_maintenance: 12 }], next_cursor: null })
      )
    );
    const user = userEvent.setup();
    render(<MaintenancePage />);

    await user.click(await screen.findByText('Log'));

    expect(await screen.findByText('100.0h · 12 jobs · 24 changes')).toBeInTheDocument();
  });

  it('omits the change count for entries that predate change tracking', async () => {
    server.use(
      http.get('/api/v1/maintenance/logs', () =>
        HttpResponse.json({ items: [{ ...logEntry, changes_at_maintenance: null }], next_cursor: null })
      )
    );
    const user = userEvent.setup();
    render(<MaintenancePage />);

    await user.click(await screen.findByText('Log'));

    expect(await screen.findByText('100.0h')).toBeInTheDocument();
    expect(screen.queryByText(/ changes?$/)).not.toBeInTheDocument();
  });
});

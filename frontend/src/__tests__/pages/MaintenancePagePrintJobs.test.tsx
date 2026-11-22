/**
 * MaintenancePage: print-job based intervals (#337). A task can be due after a
 * number of finished print jobs instead of print hours or calendar days; the
 * count since the last service is shown, and completed tasks keep the job
 * count in the maintenance log.
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
  interval_hours: 50,
  interval_type: 'jobs',
  current_hours: 500,
  hours_since_maintenance: 0,
  hours_until_due: 0,
  days_since_maintenance: null,
  days_until_due: null,
  current_jobs: 120,
  jobs_since_maintenance: 20,
  jobs_until_due: 30,
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
    due_count: 1,
    warning_count: 2,
    maintenance_items: [
      item({ id: 21, maintenance_type_id: 21, maintenance_type_name: 'Replace Nozzle', jobs_since_maintenance: 53, jobs_until_due: -3, is_due: true }),
      item({ id: 22, maintenance_type_id: 22, maintenance_type_name: 'Clean Plate', jobs_since_maintenance: 46, jobs_until_due: 4, is_warning: true }),
      item({ id: 23, maintenance_type_id: 23, maintenance_type_name: 'Oil Bearings', jobs_since_maintenance: 49, jobs_until_due: 1, is_warning: true }),
      item({ id: 24, maintenance_type_id: 24, maintenance_type_name: 'Check Cutter' }),
    ],
  },
  { printer_id: 2, printer_name: 'P1S', printer_model: 'P1S', is_active: true, total_print_hours: 10, total_print_jobs: 0, due_count: 0, warning_count: 0, maintenance_items: [] },
];

const types = [
  { id: 21, name: 'Replace Nozzle', description: null, default_interval_hours: 50, interval_type: 'jobs', icon: 'Wrench', wiki_url: null, is_system: false, created_at: '' },
  { id: 30, name: 'Swap Build Plate', description: null, default_interval_hours: 1, interval_type: 'jobs', icon: 'Wrench', wiki_url: null, is_system: false, created_at: '' },
];

const scheduledEntry = {
  id: 1,
  printer_id: 1,
  printer_name: 'X1 Carbon',
  entry_type: 'scheduled' as const,
  title: 'Replace Nozzle',
  notes: null,
  occurred_at: '2024-01-02T10:00:00Z',
  hours_at_maintenance: 100,
  jobs_at_maintenance: 12,
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
    http.get('/api/v1/maintenance/logs', () => HttpResponse.json({ items: [scheduledEntry], next_cursor: null })),
    http.post('/api/v1/maintenance/printers/:pid/assign/:tid', record()),
    http.post('/api/v1/maintenance/types', record(200, { id: 40 })),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

const paths = () => calls.map((c) => `${c.method} ${c.path}`);

describe('job-based task rows', () => {
  async function openStatus() {
    render(<MaintenancePage />);
    await screen.findByRole('heading', { name: 'All machines' });
  }
  const row = (name: string) => screen.getByRole('group', { name: new RegExp(`^${name}`) });

  it('counts down the jobs left, due soon or overdue', async () => {
    await openStatus();

    expect(within(row('Replace Nozzle')).getByText('3 jobs')).toBeInTheDocument();
    expect(within(row('Replace Nozzle')).getByText('overdue')).toBeInTheDocument();
    expect(within(row('Replace Nozzle')).getByText('53 jobs / 50 jobs')).toBeInTheDocument();
    expect(within(row('Clean Plate')).getByText('4 jobs')).toBeInTheDocument();
    expect(within(row('Clean Plate')).getByText('left')).toBeInTheDocument();
    // A single job reads naturally rather than "1 jobs".
    expect(within(row('Oil Bearings')).getByText('1 job')).toBeInTheDocument();
    expect(within(row('Check Cutter')).getByText('30 jobs')).toBeInTheDocument();
  });

  it('does not overflow the progress bar for an overdue task', async () => {
    await openStatus();

    const bar = within(row('Replace Nozzle')).getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '100');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('100%');
  });
});

describe('job-based settings', () => {
  async function openSettings(user: ReturnType<typeof userEvent.setup>) {
    render(<MaintenancePage />);
    await screen.findByRole('heading', { name: 'All machines' });
    await user.click(screen.getByRole('button', { name: /^Settings$/ }));
    await screen.findByText('Maintenance Types');
  }

  it('lists a job-based type with its interval in jobs', async () => {
    const user = userEvent.setup();
    await openSettings(user);

    expect(screen.getAllByText('50 jobs').length).toBeGreaterThanOrEqual(1);
    // A single job reads naturally rather than "1 jobs".
    expect(screen.getAllByText('1 job').length).toBeGreaterThanOrEqual(1);
  });

  it('adds a custom type that counts print jobs', async () => {
    const user = userEvent.setup();
    await openSettings(user);

    await user.click(screen.getByRole('button', { name: /Add Custom Type/ }));
    await user.type(screen.getByPlaceholderText('e.g., Replace HEPA Filter'), 'Grease Screws');
    await user.click(screen.getByRole('combobox', { name: /Print Hours/ }));
    await user.click(await screen.findByRole('option', { name: 'Print Jobs' }));

    // Switching the type swaps the unit label and a sensible default count.
    expect(screen.getByText('Interval (print jobs)')).toBeInTheDocument();
    expect(screen.getByDisplayValue('50')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'P1S' }));
    await user.click(screen.getByRole('button', { name: 'Add Type' }));

    await waitFor(() => expect(paths()).toContain('POST /api/v1/maintenance/printers/2/assign/40'));
    expect(calls.find((c) => c.path === '/api/v1/maintenance/types')!.body).toMatchObject({
      name: 'Grease Screws', default_interval_hours: 50, interval_type: 'jobs',
    });
  });
});

describe('maintenance log', () => {
  it('shows the job count recorded when a task was completed', async () => {
    const user = userEvent.setup();
    render(<MaintenancePage />);

    await user.click(await screen.findByText('Log'));

    expect(await screen.findByText('Replace Nozzle')).toBeInTheDocument();
    expect(screen.getByText('100.0h · 12 jobs')).toBeInTheDocument();
  });

  it('omits the job count for entries that predate job tracking', async () => {
    server.use(
      http.get('/api/v1/maintenance/logs', () =>
        HttpResponse.json({ items: [{ ...scheduledEntry, jobs_at_maintenance: null }], next_cursor: null })
      )
    );
    const user = userEvent.setup();
    render(<MaintenancePage />);

    await user.click(await screen.findByText('Log'));

    expect(await screen.findByText('100.0h')).toBeInTheDocument();
    expect(screen.queryByText(/ jobs?$/)).not.toBeInTheDocument();
  });
});

/**
 * MaintenancePage: status cards (overdue / due soon / OK / days-based /
 * disabled), resetting and toggling tasks, editing print hours, and the
 * settings tab — adding, editing and deleting types, assigning printers,
 * interval overrides and restoring defaults.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
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
  interval_hours: 100,
  interval_type: 'hours',
  current_hours: 500,
  hours_since_maintenance: 50,
  hours_until_due: 50,
  days_since_maintenance: null,
  days_until_due: null,
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
    total_print_hours: 512.4,
    due_count: 1,
    warning_count: 1,
    maintenance_items: [
      item({ id: 11, maintenance_type_id: 1, maintenance_type_name: 'Lubricate Rods', hours_until_due: -12, is_due: true }),
      item({ id: 12, maintenance_type_id: 2, maintenance_type_name: 'Clean Nozzle', hours_until_due: 4, is_warning: true }),
      item({ id: 13, maintenance_type_id: 3, maintenance_type_name: 'Check Belts', hours_until_due: 80 }),
      item({
        id: 14, maintenance_type_id: 4, maintenance_type_name: 'Replace HEPA', interval_type: 'days', interval_hours: 90,
        days_since_maintenance: 30, days_until_due: 60, maintenance_type_wiki_url: 'https://wiki.example/hepa',
      }),
      item({ id: 15, maintenance_type_id: 5, maintenance_type_name: 'Dry Box', enabled: false }),
      item({ id: 16, maintenance_type_id: 9, maintenance_type_name: 'Polish Bed', hours_until_due: 200 }),
    ],
  },
  { printer_id: 2, printer_name: 'P1S', printer_model: 'P1S', total_print_hours: 10, due_count: 0, warning_count: 0, maintenance_items: [] },
];

const types = [
  { id: 1, name: 'Lubricate Rods', description: null, default_interval_hours: 100, interval_type: 'hours', icon: 'Droplet', wiki_url: null, is_system: true, created_at: '' },
  { id: 4, name: 'Replace HEPA', description: null, default_interval_hours: 90, interval_type: 'days', icon: 'Wind', wiki_url: null, is_system: true, created_at: '' },
  { id: 9, name: 'Polish Bed', description: null, default_interval_hours: 300, interval_type: 'hours', icon: 'Sparkles', wiki_url: null, is_system: false, created_at: '' },
];

let calls: { method: string; path: string; body: unknown }[];

beforeEach(() => {
  calls = [];
  const record = (status = 200, response: unknown = {}) =>
    async ({ request }: { request: Request }) => {
      const text = await request.text();
      const url = new URL(request.url);
      calls.push({ method: request.method, path: url.pathname + url.search, body: text ? JSON.parse(text) : null });
      return HttpResponse.json(response, { status });
    };
  server.use(
    http.get('/api/v1/maintenance/overview', () => HttpResponse.json(overview)),
    http.get('/api/v1/maintenance/types', () => HttpResponse.json(types)),
    http.post('/api/v1/maintenance/items/:id/perform', record()),
    http.patch('/api/v1/maintenance/items/:id', record()),
    http.delete('/api/v1/maintenance/items/:id', record()),
    http.patch('/api/v1/maintenance/printers/:id/hours', record()),
    http.post('/api/v1/maintenance/printers/:pid/assign/:tid', record()),
    http.post('/api/v1/maintenance/types', record(200, { id: 20 })),
    http.patch('/api/v1/maintenance/types/:id', record()),
    http.delete('/api/v1/maintenance/types/:id', record()),
    http.post('/api/v1/maintenance/types/restore-defaults', record(200, { restored: 3 })),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

const paths = () => calls.map((c) => `${c.method} ${c.path}`);

async function openPrinter(user: ReturnType<typeof userEvent.setup>) {
  render(<MaintenancePage />);
  await screen.findByText('1 overdue');
  await user.click(screen.getAllByRole('button', { name: /Expand/ })[0]);
  return screen.getByText('Lubricate Rods', { selector: 'h3' }).closest('.rounded-xl') as HTMLElement;
}

describe('status', () => {
  it('summarises each printer and describes every task', async () => {
    const user = userEvent.setup();
    await openPrinter(user);

    expect(screen.getByText('1 due soon')).toBeInTheDocument();
    expect(screen.getByText('All good')).toBeInTheDocument();
    expect(screen.getByText(/Overdue by/)).toBeInTheDocument();
    expect(screen.getByText(/Due in/)).toBeInTheDocument();
    expect(screen.getAllByText(/ left$/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Disabled')).toBeInTheDocument();
    expect(screen.getByTitle('View documentation') ?? screen.getAllByRole('link')[0]).toHaveAttribute('href', 'https://wiki.example/hepa');

    await user.click(screen.getAllByRole('button', { name: /Collapse/ })[0]);
    expect(screen.queryByText('Check Belts')).not.toBeInTheDocument();
  });

  it('resets and disables tasks', async () => {
    const user = userEvent.setup();
    const card = await openPrinter(user);

    await user.click(within(card).getByRole('button', { name: /Reset/ }));
    await waitFor(() => expect(paths()).toContain('POST /api/v1/maintenance/items/11/perform'));
    expect(await screen.findByText('Maintenance marked as complete')).toBeInTheDocument();

    await user.click(within(card).getByRole('switch'));
    await waitFor(() => expect(calls.at(-1)).toEqual({ method: 'PATCH', path: '/api/v1/maintenance/items/11', body: { enabled: false } }));
  });

  it('edits the printer total print hours', async () => {
    const user = userEvent.setup();
    render(<MaintenancePage />);

    await user.click((await screen.findAllByText(/512 hours/))[0]);
    const input = screen.getByDisplayValue('512');
    await user.clear(input);
    await user.type(input, '600');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(paths()).toContain('PATCH /api/v1/maintenance/printers/1/hours?total_hours=600'));
    expect(await screen.findByText('Print hours updated')).toBeInTheDocument();

    await user.click((await screen.findAllByText(/512 hours/))[0]);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByDisplayValue('512')).not.toBeInTheDocument();
  });

  it('reports a failed reset', async () => {
    server.use(http.post('/api/v1/maintenance/items/:id/perform', () => HttpResponse.json({ detail: 'Locked' }, { status: 423 })));
    const user = userEvent.setup();
    const card = await openPrinter(user);

    await user.click(within(card).getByRole('button', { name: /Reset/ }));

    expect(await screen.findByText('Locked')).toBeInTheDocument();
  });
});

describe('settings', () => {
  async function openSettings(user: ReturnType<typeof userEvent.setup>) {
    render(<MaintenancePage />);
    await screen.findByText('1 overdue');
    await user.click(screen.getByRole('button', { name: /^Settings$/ }));
    await screen.findByText('Maintenance Types');
  }

  it('adds a custom type and assigns it to the chosen printers', async () => {
    const user = userEvent.setup();
    await openSettings(user);

    await user.click(screen.getByRole('button', { name: /Add Custom Type/ }));
    await user.type(screen.getByPlaceholderText('e.g., Replace HEPA Filter'), 'Grease Screws');
    const addButton = screen.getByRole('button', { name: 'Add Type' });
    expect(addButton).toBeDisabled();
    expect(screen.getByText('Select at least one printer')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'P1S' }));
    await user.click(screen.getByRole('button', { name: 'X1 Carbon' }));
    await user.click(screen.getByRole('button', { name: 'X1 Carbon' }));
    await user.type(screen.getByPlaceholderText('https://wiki.bambulab.com/...'), 'https://docs.example/grease');
    await user.click(addButton);

    await waitFor(() => expect(paths()).toContain('POST /api/v1/maintenance/printers/2/assign/20'));
    expect(calls.find((c) => c.path === '/api/v1/maintenance/types')!.body).toMatchObject({
      name: 'Grease Screws', default_interval_hours: 100, interval_type: 'hours', wiki_url: 'https://docs.example/grease',
    });
    expect(paths()).not.toContain('POST /api/v1/maintenance/printers/1/assign/20');
  });

  it('edits a custom type', async () => {
    const user = userEvent.setup();
    await openSettings(user);

    const row = screen.getAllByText('Polish Bed')[0].closest('div[class*="rounded"]') as HTMLElement;
    const buttons = within(row).getAllByRole('button');
    await user.click(buttons[buttons.length - 2]); // edit
    const name = screen.getByDisplayValue('Polish Bed');
    await user.clear(name);
    await user.type(name, 'Polish PEI');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(paths()).toContain('PATCH /api/v1/maintenance/types/9'));
    expect(calls.at(-1)!.body).toMatchObject({ name: 'Polish PEI', default_interval_hours: 300 });
    expect(await screen.findByText('Maintenance type updated')).toBeInTheDocument();
  });

  it('deletes custom types after a browser confirm and system types after a dialog', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const user = userEvent.setup();
    await openSettings(user);

    const custom = screen.getAllByText('Polish Bed')[0].closest('div[class*="rounded"]') as HTMLElement;
    const del = within(custom).getAllByRole('button').pop()!;
    await user.click(del);
    expect(paths()).not.toContain('DELETE /api/v1/maintenance/types/9');
    await user.click(del);
    await waitFor(() => expect(paths()).toContain('DELETE /api/v1/maintenance/types/9'));
    expect(confirm).toHaveBeenCalledWith('Delete "Polish Bed"?');

    const system = screen.getAllByText('Lubricate Rods').find((el) => el.closest('div[class*="rounded"]')?.querySelector('button'))!
      .closest('div[class*="rounded"]') as HTMLElement;
    await user.click(within(system).getAllByRole('button').pop()!);
    expect(await screen.findByText('Delete default maintenance task?')).toBeInTheDocument();
    const dialog = screen.getByText('Delete default maintenance task?').closest('.fixed') as HTMLElement;
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(paths()).toContain('DELETE /api/v1/maintenance/types/1'));
  });

  it('assigns and removes printers from a type', async () => {
    const user = userEvent.setup();
    await openSettings(user);

    await user.click(screen.getAllByTitle(/printer\(s\) assigned/)[0]);
    expect(screen.getByText('Assigned to printers:')).toBeInTheDocument();
    await user.click(screen.getByTitle('Remove from this printer'));
    await waitFor(() => expect(paths()).toContain('DELETE /api/v1/maintenance/items/16'));
    expect(await screen.findByText('Printer removed')).toBeInTheDocument();

    const add = screen.getByText('Add:').parentElement as HTMLElement;
    await user.click(within(add).getByRole('button', { name: /P1S/ }));
    await waitFor(() => expect(paths()).toContain('POST /api/v1/maintenance/printers/2/assign/9'));
    expect(await screen.findByText('Printer assigned')).toBeInTheDocument();
  });

  it('overrides an interval per printer', async () => {
    const user = userEvent.setup();
    await openSettings(user);

    const overrides = screen.getByText('Interval Overrides').closest('div')!.parentElement as HTMLElement;
    const row = within(overrides).getByText('Check Belts').parentElement as HTMLElement;
    await user.click(within(row).getByRole('button'));
    const input = within(row).getByRole('spinbutton');
    await user.clear(input);
    await user.type(input, '150{Enter}');

    await waitFor(() => expect(paths()).toContain('PATCH /api/v1/maintenance/items/13'));
    expect(calls.at(-1)!.body).toMatchObject({ custom_interval_hours: 150 });
  });

  it('restores default tasks', async () => {
    const user = userEvent.setup();
    await openSettings(user);

    await user.click(screen.getByRole('button', { name: /Restore Default Tasks/ }));

    expect(await screen.findByText('Restored 3 default task(s)')).toBeInTheDocument();
  });
});

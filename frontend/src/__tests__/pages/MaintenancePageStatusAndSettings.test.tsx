/**
 * MaintenancePage: the Status tab (the All machines to-do list and the
 * single-printer view with its machine rail), resetting and toggling tasks,
 * editing print hours, and the settings tab — adding, editing and deleting
 * types, assigning printers, interval overrides and restoring defaults.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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
    is_active: true,
    total_print_hours: 512.4,
    total_print_jobs: 42,
    total_filament_changes: 7,
    due_count: 1,
    warning_count: 1,
    maintenance_items: [
      item({ id: 11, maintenance_type_id: 1, maintenance_type_name: 'Lubricate Rods', hours_until_due: -12, is_due: true }),
      item({ id: 12, maintenance_type_id: 2, maintenance_type_name: 'Clean Nozzle', hours_until_due: 4, is_warning: true }),
      item({ id: 13, maintenance_type_id: 3, maintenance_type_name: 'Check Belts', hours_until_due: 80 }),
      item({
        id: 14, maintenance_type_id: 4, maintenance_type_name: 'Replace HEPA', interval_type: 'days', interval_hours: 90,
        days_since_maintenance: 30, days_until_due: 60, maintenance_type_wiki_url: 'https://wiki.example/hepa',
        last_performed_at: '2024-03-05T12:00:00Z',
      }),
      item({ id: 15, maintenance_type_id: 5, maintenance_type_name: 'Dry Box', enabled: false }),
      item({ id: 16, maintenance_type_id: 9, maintenance_type_name: 'Polish Bed', hours_until_due: 200 }),
    ],
  },
  { printer_id: 2, printer_name: 'P1S', printer_model: 'P1S', is_active: true, total_print_hours: 10, due_count: 0, warning_count: 0, maintenance_items: [] },
];

const types = [
  { id: 1, name: 'Lubricate Rods', description: null, default_interval_hours: 100, interval_type: 'hours', icon: 'Droplet', wiki_url: null, is_system: true, created_at: '' },
  { id: 4, name: 'Replace HEPA', description: null, default_interval_hours: 90, interval_type: 'days', icon: 'Wind', wiki_url: null, is_system: true, created_at: '' },
  { id: 9, name: 'Polish Bed', description: null, default_interval_hours: 300, interval_type: 'hours', icon: 'Sparkles', wiki_url: null, is_system: false, created_at: '' },
];

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

const row = (name: string) => screen.getByRole('group', { name: new RegExp(`^${name}`) });
const region = (name: string) => screen.getByRole('region', { name });
const rowNames = (container: HTMLElement) =>
  within(container).getAllByRole('group').map((group) => group.getAttribute('aria-label'));

async function openStatus() {
  render(<MaintenancePage />);
  await screen.findByRole('heading', { name: 'All machines' });
}

async function openPrinter(user: ReturnType<typeof userEvent.setup>, name = 'X1 Carbon') {
  await openStatus();
  await user.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }));
  await screen.findByRole('heading', { level: 2, name });
}

const onTrackItems = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    item({ id: 100 + index, maintenance_type_id: 100 + index, maintenance_type_name: `Task ${index + 1}`, hours_until_due: 90 - index }),
  );

const overviewWith = (items: unknown[]) => [{ ...overview[0], is_active: true, due_count: 0, warning_count: 0, maintenance_items: items }];

describe('all machines', () => {
  it('lists every enabled task across printers, most urgent first, in bands', async () => {
    await openStatus();

    expect(rowNames(region('Overdue'))).toEqual(['Lubricate Rods (X1 Carbon)']);
    expect(rowNames(region('Due soon'))).toEqual(['Clean Nozzle (X1 Carbon)']);
    // Ordered by how much of the interval is used, whatever the unit.
    expect(rowNames(region('On track'))).toEqual([
      'Replace HEPA (X1 Carbon)',
      'Check Belts (X1 Carbon)',
      'Polish Bed (X1 Carbon)',
    ]);
    expect(screen.queryByRole('group', { name: /Dry Box/ })).not.toBeInTheDocument();
  });

  it('counts down each task in its own unit', async () => {
    await openStatus();

    expect(within(row('Lubricate Rods')).getByText('12h')).toBeInTheDocument();
    expect(within(row('Lubricate Rods')).getByText('overdue')).toBeInTheDocument();
    expect(within(row('Lubricate Rods')).getByText('112h / 100h')).toBeInTheDocument();
    expect(within(row('Clean Nozzle')).getByText('4h')).toBeInTheDocument();
    expect(within(row('Clean Nozzle')).getByText('left')).toBeInTheDocument();
    expect(within(row('Replace HEPA')).getByText('60 days')).toBeInTheDocument();
    expect(within(row('Replace HEPA')).getByText('30 days / 90 days')).toBeInTheDocument();
    expect(within(row('Replace HEPA')).getByText('Every 3 months')).toBeInTheDocument();
    expect(within(row('Replace HEPA')).getByTitle('View documentation')).toHaveAttribute('href', 'https://wiki.example/hepa');
  });

  it('reads a task due today, or overdue by less than a day, naturally', async () => {
    server.use(
      http.get('/api/v1/maintenance/overview', () =>
        HttpResponse.json(overviewWith([
          item({ id: 71, maintenance_type_id: 71, maintenance_type_name: 'Wipe Lens', interval_type: 'days', interval_hours: 30, days_since_maintenance: 30, days_until_due: 0.4 }),
          item({ id: 72, maintenance_type_id: 72, maintenance_type_name: 'Wipe Door', interval_type: 'days', interval_hours: 30, days_since_maintenance: 30, days_until_due: 0, is_due: true }),
          item({ id: 73, maintenance_type_id: 73, maintenance_type_name: 'Wipe Plate', interval_type: 'days', interval_hours: 1, days_since_maintenance: 1, days_until_due: 0, is_due: true }),
        ])),
      ),
    );
    await openStatus();

    expect(within(row('Wipe Lens')).getByText('Today')).toBeInTheDocument();
    expect(within(row('Wipe Lens')).queryByText('left')).not.toBeInTheDocument();
    expect(within(row('Wipe Door')).getByText('1 day')).toBeInTheDocument();
    expect(within(row('Wipe Door')).getByText('overdue')).toBeInTheDocument();
    expect(within(row('Wipe Plate')).getByText('Every 1 day')).toBeInTheDocument();
  });

  it('counts an hours interval in minutes when under an hour is left', async () => {
    server.use(
      http.get('/api/v1/maintenance/overview', () =>
        HttpResponse.json(overviewWith([
          item({ id: 81, maintenance_type_id: 81, maintenance_type_name: 'Wipe Fan', hours_until_due: 0.5, is_warning: true }),
        ])),
      ),
    );
    await openStatus();

    expect(within(row('Wipe Fan')).getByText('30m')).toBeInTheDocument();
  });

  it('summarises the overdue and due soon counts under the page title', async () => {
    await openStatus();

    expect(screen.getAllByText('1 overdue', { selector: 'span' })).toHaveLength(1);
    expect(screen.getAllByText('1 due soon', { selector: 'span' })).toHaveLength(1);
  });

  it('shows the fleet and each printer in the rail', async () => {
    await openStatus();

    const rail = screen.getByRole('navigation', { name: 'Machines' });
    const all = within(rail).getByRole('button', { name: /^All machines/ });
    expect(all).toHaveAttribute('aria-current', 'true');
    expect(all).toHaveTextContent('1 overdue · 1 due soon · 3 on track');
    expect(within(rail).getByRole('button', { name: /^X1 Carbon/ })).toHaveTextContent('1 overdue · 1 due soon · 3 on track');
    expect(within(rail).getByRole('button', { name: /^P1S/ })).toHaveTextContent('No tasks');
  });

  it('filters to the tasks that need attention', async () => {
    const user = userEvent.setup();
    await openStatus();

    await user.click(screen.getByRole('button', { name: 'Needs attention · 2' }));
    expect(screen.getByRole('button', { name: 'Needs attention · 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('region', { name: 'On track' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Overdue' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'All tasks · 5' }));
    expect(region('On track')).toBeInTheDocument();
  });

  it('says so when nothing needs attention', async () => {
    server.use(http.get('/api/v1/maintenance/overview', () => HttpResponse.json(overviewWith(onTrackItems(2)))));
    const user = userEvent.setup();
    await openStatus();

    await user.click(screen.getByRole('button', { name: 'Needs attention · 0' }));

    expect(screen.getByText('Nothing needs attention')).toBeInTheDocument();
    expect(screen.getByText('Every task is within its interval.')).toBeInTheDocument();
  });

  it('collapses a long on-track list and expands it on request', async () => {
    server.use(http.get('/api/v1/maintenance/overview', () => HttpResponse.json(overviewWith(onTrackItems(10)))));
    const user = userEvent.setup();
    await openStatus();

    expect(rowNames(region('On track'))).toHaveLength(8);
    await user.click(screen.getByRole('button', { name: 'Show 2 more on-track tasks' }));
    expect(rowNames(region('On track'))).toHaveLength(10);
    await user.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(rowNames(region('On track'))).toHaveLength(8);
  });

  it('marks a task done from the list', async () => {
    const user = userEvent.setup();
    await openStatus();

    await user.click(within(row('Lubricate Rods')).getByRole('button', { name: /Mark as Done/ }));

    await waitFor(() => expect(paths()).toContain('POST /api/v1/maintenance/items/11/perform'));
    expect(await screen.findByText('Maintenance marked as complete')).toBeInTheDocument();
  });

  it('explains an empty fleet or a fleet with no tasks', async () => {
    server.use(http.get('/api/v1/maintenance/overview', () => HttpResponse.json([])));
    const { unmount } = render(<MaintenancePage />);
    expect(await screen.findByText('No printers configured')).toBeInTheDocument();
    unmount();

    server.use(http.get('/api/v1/maintenance/overview', () => HttpResponse.json(overviewWith([]))));
    render(<MaintenancePage />);
    expect((await screen.findAllByText('No tasks')).length).toBeGreaterThanOrEqual(1);
  });
});

describe('printer view', () => {
  it('groups a printer\'s tasks by status and shows its counters', async () => {
    const user = userEvent.setup();
    await openPrinter(user);

    expect(screen.getByRole('button', { name: /^X1 Carbon/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getAllByText('1 overdue', { selector: 'span' })).toHaveLength(2);
    expect(screen.getAllByText('1 due soon', { selector: 'span' })).toHaveLength(2);
    expect(screen.getByText('512 hours')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();

    expect(rowNames(region('Overdue'))).toEqual(['Lubricate Rods']);
    expect(rowNames(region('Due soon'))).toEqual(['Clean Nozzle']);
    expect(rowNames(region('On track'))).toEqual(['Replace HEPA', 'Check Belts', 'Polish Bed']);
    expect(rowNames(region('Disabled'))).toEqual(['Dry Box']);

    // Unlike the fleet list, the printer view shows when a task was last done and lets it be switched off.
    expect(within(row('Replace HEPA')).getByText(/last done/)).toBeInTheDocument();
    expect(within(row('Check Belts')).getByText(/not done yet/)).toBeInTheDocument();
    expect(within(row('Dry Box')).getByRole('switch')).not.toBeChecked();
    expect(within(row('Dry Box')).getByText('—')).toBeInTheDocument();
    expect(within(row('Dry Box')).getByRole('button', { name: /Mark as Done/ })).toBeDisabled();
  });

  it('resets and disables tasks', async () => {
    const user = userEvent.setup();
    await openPrinter(user);

    await user.click(within(row('Lubricate Rods')).getByRole('button', { name: /Mark as Done/ }));
    await waitFor(() => expect(paths()).toContain('POST /api/v1/maintenance/items/11/perform'));
    expect(await screen.findByText('Maintenance marked as complete')).toBeInTheDocument();

    await user.click(within(row('Lubricate Rods')).getByRole('switch'));
    await waitFor(() => expect(calls.at(-1)).toEqual({ method: 'PATCH', path: '/api/v1/maintenance/items/11', body: { enabled: false } }));
  });

  it('labels a printer in Maintenance Mode and still lets its maintenance be completed', async () => {
    // Printers in Maintenance Mode are listed so their maintenance can be recorded (#332).
    server.use(
      http.get('/api/v1/maintenance/overview', () =>
        HttpResponse.json(overview.map((p) => (p.printer_id === 1 ? { ...p, is_active: false } : p)))
      )
    );
    const user = userEvent.setup();
    await openPrinter(user);

    const rail = screen.getByRole('navigation', { name: 'Machines' });
    expect(within(within(rail).getByRole('button', { name: /^X1 Carbon/ })).getByText('Maintenance Mode')).toBeInTheDocument();
    expect(within(within(rail).getByRole('button', { name: /^P1S/ })).queryByText('Maintenance Mode')).not.toBeInTheDocument();
    expect(screen.getAllByText('Maintenance Mode')).toHaveLength(2);

    await user.click(within(row('Lubricate Rods')).getByRole('button', { name: /Mark as Done/ }));
    await waitFor(() => expect(paths()).toContain('POST /api/v1/maintenance/items/11/perform'));
    expect(await screen.findByText('Maintenance marked as complete')).toBeInTheDocument();
  });

  it('edits the printer total print hours', async () => {
    const user = userEvent.setup();
    await openPrinter(user);

    await user.click(screen.getByText('512 hours'));
    const input = screen.getByDisplayValue('512');
    await user.clear(input);
    await user.type(input, '600');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(paths()).toContain('PATCH /api/v1/maintenance/printers/1/hours?total_hours=600'));
    expect(await screen.findByText('Print hours updated')).toBeInTheDocument();

    await user.click(await screen.findByText('512 hours'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByDisplayValue('512')).not.toBeInTheDocument();
  });

  it('reports a failed reset', async () => {
    server.use(http.post('/api/v1/maintenance/items/:id/perform', () => HttpResponse.json({ detail: 'Locked' }, { status: 423 })));
    const user = userEvent.setup();
    await openPrinter(user);

    await user.click(within(row('Lubricate Rods')).getByRole('button', { name: /Mark as Done/ }));

    expect(await screen.findByText('Locked')).toBeInTheDocument();
  });

  it('opens the log form for that printer from Log a repair', async () => {
    const user = userEvent.setup();
    await openPrinter(user, 'P1S');
    expect(screen.getByText('No maintenance tasks are assigned to this printer.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Log a repair' }));

    expect(await screen.findByLabelText('Title')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Printer' })).toHaveTextContent('P1S');
  });

  it('returns to the fleet list from All machines', async () => {
    const user = userEvent.setup();
    await openPrinter(user);

    await user.click(screen.getByRole('button', { name: /^All machines/ }));

    expect(await screen.findByRole('heading', { name: 'All machines' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^All machines/ })).toHaveAttribute('aria-current', 'true');
  });

  it('cancels editing the print hours on Escape without saving', async () => {
    const user = userEvent.setup();
    await openPrinter(user);

    await user.click(screen.getByText('512 hours'));
    fireEvent.keyDown(screen.getByDisplayValue('512'), { key: 'Escape' });

    expect(screen.queryByDisplayValue('512')).not.toBeInTheDocument();
    expect(paths()).not.toContain('PATCH /api/v1/maintenance/printers/1/hours?total_hours=512');
  });
});

describe('settings', () => {
  async function openSettings(user: ReturnType<typeof userEvent.setup>) {
    render(<MaintenancePage />);
    await screen.findByRole('heading', { name: 'All machines' });
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

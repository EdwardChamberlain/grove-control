/**
 * PrintersPage printer actions menu: edit (with the connection pre-check),
 * maintenance mode, reconnect, force refresh and delete.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { PrintersPage } from '../../pages/PrintersPage';
import { server } from '../mocks/server';

const printer = {
  id: 1,
  name: 'X1 Carbon',
  ip_address: '192.168.1.100',
  serial_number: '00M09A350100001',
  model: 'X1C',
  location: 'Workshop',
  is_active: true,
  auto_archive: true,
  nozzle_count: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const passing = {
  printer_id: null,
  ip_address: '192.168.1.100',
  overall: 'ok',
  checks: [{ id: 'port_mqtt', status: 'pass', params: {} }],
};

interface Requests {
  patches: unknown[];
  diagnose: unknown[];
  deletes: string[];
  connects: number;
  refreshes: number;
  statusReads: number;
}

function setup({ printerOverrides = {}, state = 'IDLE', diagnostic = passing as unknown, diagnosticStatus = 200 } = {}) {
  const requests: Requests = { patches: [], diagnose: [], deletes: [], connects: 0, refreshes: 0, statusReads: 0 };
  server.use(
    http.get('/api/v1/printers/', () => HttpResponse.json([{ ...printer, ...printerOverrides }])),
    http.get('/api/v1/printers/:id/status', () => {
      requests.statusReads += 1;
      return HttpResponse.json({ connected: true, state, temperatures: { nozzle: 25, bed: 25 }, vt_tray: [], progress: 0 });
    }),
    http.get('/api/v1/queue/', () => HttpResponse.json([])),
    http.patch('/api/v1/printers/:id', async ({ request }) => {
      requests.patches.push(await request.json());
      return HttpResponse.json(printer);
    }),
    http.post('/api/v1/printers/diagnostic', async ({ request }) => {
      requests.diagnose.push(await request.json());
      return HttpResponse.json(diagnostic, { status: diagnosticStatus });
    }),
    http.delete('/api/v1/printers/:id', ({ request }) => {
      requests.deletes.push(new URL(request.url).search);
      return HttpResponse.json({ status: 'deleted', archives_deleted: false });
    }),
    http.post('/api/v1/printers/:id/connect', () => {
      requests.connects += 1;
      return HttpResponse.json({ connected: true });
    }),
    http.post('/api/v1/printers/:id/refresh-status', () => {
      requests.refreshes += 1;
      return HttpResponse.json({ status: 'ok' });
    }),
  );
  return requests;
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  render(<PrintersPage />);
  await screen.findAllByText('X1 Carbon');
  await user.click(screen.getByTitle(/more/i));
}

beforeEach(() => {
  localStorage.removeItem('printerViewMode');
  localStorage.removeItem('singlePrinterViewId');
});

describe('Edit printer', () => {
  it('runs the connection check and saves the changes', async () => {
    const requests = setup();
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Edit' }));

    const nameInput = screen.getAllByDisplayValue('X1 Carbon').find((el) => el.tagName === 'INPUT') as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, 'Big X1');
    await user.type(screen.getByPlaceholderText('Leave empty to keep current'), '87654321');
    await user.clear(screen.getByDisplayValue('Workshop'));
    await user.click(screen.getByLabelText(/Maintenance mode/));
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(requests.patches).toHaveLength(1));
    expect(requests.diagnose).toEqual([
      { ip_address: '192.168.1.100', serial_number: '00M09A350100001', access_code: '87654321' },
    ]);
    expect(requests.patches[0]).toEqual({
      name: 'Big X1',
      ip_address: '192.168.1.100',
      model: 'X1C',
      auto_archive: true,
      is_active: false,
      access_code: '87654321',
    });
    await waitFor(() => expect(screen.queryByText('Edit Printer')).not.toBeInTheDocument());
  });

  it('warns when the connection check fails, and can save anyway', async () => {
    const requests = setup({
      diagnostic: { ...passing, overall: 'problems', checks: [{ id: 'port_mqtt', status: 'fail', params: {} }] },
    });
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(await screen.findByText(/Some connection checks failed/)).toBeInTheDocument();
    expect(requests.patches).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByText(/Some connection checks failed/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await user.click(await screen.findByRole('button', { name: 'Save anyway' }));

    await waitFor(() => expect(requests.patches).toHaveLength(1));
  });

  it('never blocks the save when the check itself errors', async () => {
    const requests = setup({ diagnosticStatus: 500, diagnostic: { detail: 'boom' } });
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(requests.patches).toHaveLength(1));
    // The access code is only sent when it was changed.
    expect(requests.patches[0]).not.toHaveProperty('access_code');
  });

  it('shows the server error when saving fails', async () => {
    setup();
    server.use(http.patch('/api/v1/printers/:id', () => HttpResponse.json({ detail: 'IP already used' }, { status: 400 })));
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(await screen.findByText('IP already used')).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    setup();
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByText('Edit Printer')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByText('Edit Printer')).not.toBeInTheDocument();
  });
});

describe('Maintenance mode', () => {
  it('enters maintenance directly when idle', async () => {
    const requests = setup();
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Enter maintenance mode' }));

    await waitFor(() => expect(requests.patches).toEqual([{ is_active: false }]));
    expect(await screen.findByText('X1 Carbon is now in maintenance mode')).toBeInTheDocument();
  });

  it('asks first when the printer is printing', async () => {
    const requests = setup({ state: 'RUNNING' });
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Enter maintenance mode' }));

    expect(await screen.findByText('Enter maintenance mode mid-print?')).toBeInTheDocument();
    expect(requests.patches).toHaveLength(0);
    const confirm = screen.getAllByRole('button', { name: 'Enter maintenance mode' });
    await user.click(confirm[confirm.length - 1]);

    await waitFor(() => expect(requests.patches).toEqual([{ is_active: false }]));
  });

  it('exits maintenance from the printer card', async () => {
    const requests = setup({ printerOverrides: { is_active: false } });
    localStorage.setItem('printerViewMode', 'detail');
    const user = userEvent.setup();
    render(<PrintersPage />);
    await screen.findAllByText('X1 Carbon');
    await user.click(await screen.findByRole('button', { name: 'Exit maintenance' }));

    await waitFor(() => expect(requests.patches).toEqual([{ is_active: true }]));
    expect(await screen.findByText('X1 Carbon is back online')).toBeInTheDocument();
  });

  it('exits maintenance from the actions menu', async () => {
    const requests = setup({ printerOverrides: { is_active: false } });
    localStorage.setItem('printerViewMode', 'detail');
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Exit maintenance mode' }));

    await waitFor(() => expect(requests.patches).toEqual([{ is_active: true }]));
    expect(await screen.findByText('X1 Carbon is back online')).toBeInTheDocument();
  });
});

describe('Connection actions', () => {
  it('reconnects', async () => {
    const requests = setup();
    const user = userEvent.setup();
    await openMenu(user);
    await waitFor(() => expect(requests.statusReads).toBeGreaterThan(0));
    const statusReadsBefore = requests.statusReads;
    await user.click(screen.getByRole('button', { name: 'Reconnect' }));

    await waitFor(() => {
      expect(requests.connects).toBe(1);
      expect(requests.statusReads).toBeGreaterThan(statusReadsBefore);
    });
  });

  it('force refreshes the status', async () => {
    const requests = setup();
    const user = userEvent.setup();
    await openMenu(user);
    await waitFor(() => expect(requests.statusReads).toBeGreaterThan(0));
    const statusReadsBefore = requests.statusReads;
    await user.click(screen.getByRole('button', { name: 'Force Refresh' }));

    await waitFor(() => {
      expect(requests.refreshes).toBe(1);
      expect(requests.statusReads).toBeGreaterThan(statusReadsBefore);
    });
    expect(await screen.findByText('Refresh requested')).toBeInTheDocument();
  });
});

describe('Delete printer', () => {
  it('deletes print archives by default when deleting a printer', async () => {
    const requests = setup();
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = (await screen.findByText('Delete Printer')).closest('div') as HTMLElement;
    expect(dialog).toBeInTheDocument();
    const checkbox = screen.getByRole('checkbox', { name: /Delete print archives/ });
    expect(checkbox).toBeChecked();

    const buttons = screen.getAllByRole('button', { name: 'Delete' });
    await user.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(requests.deletes).toEqual(['?delete_archives=true']));
  });

  it('keeps print archives when the option is cleared', async () => {
    const requests = setup();
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    const checkbox = screen.getByRole('checkbox', { name: /Delete print archives/ });
    expect(checkbox).toBeChecked();
    await user.click(checkbox);
    expect(checkbox).not.toBeChecked();

    const buttons = screen.getAllByRole('button', { name: 'Delete' });
    await user.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(requests.deletes).toEqual(['?delete_archives=false']));
  });

  it('can be cancelled', async () => {
    const requests = setup();
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByText('Delete Printer');

    const cancel = screen.getAllByRole('button', { name: 'Cancel' });
    await user.click(within(cancel[cancel.length - 1].parentElement as HTMLElement).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('Delete Printer')).not.toBeInTheDocument();
    expect(requests.deletes).toEqual([]);
  });
});

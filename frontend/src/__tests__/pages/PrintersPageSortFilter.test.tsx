/**
 * Printer page sorting, grouping and filtering: sort by name, model and
 * location, the direction toggle, grouping headers, the status filter and
 * hiding offline printers.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { PrintersPage } from '../../pages/PrintersPage';
import { server } from '../mocks/server';

const base = {
  ip_address: '192.168.1.100',
  serial_number: 'S',
  enabled: true,
  is_active: true,
  nozzle_count: 1,
  auto_archive: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const printers = [
  { ...base, id: 1, name: 'Zeta', model: 'X1C', location: 'Workshop' },
  { ...base, id: 2, name: 'Alpha', model: 'A1', location: 'Garage' },
  { ...base, id: 3, name: 'Mid', model: 'P1S', location: 'Workshop' },
  { ...base, id: 4, name: 'Ghost', model: 'P1P', location: 'Garage' },
];

/** Status per printer id: Zeta prints, Ghost is disconnected, the rest are idle. */
const statusById: Record<number, Record<string, unknown>> = {
  1: { connected: true, state: 'RUNNING', progress: 30 },
  2: { connected: true, state: 'IDLE' },
  3: { connected: true, state: 'IDLE' },
  4: { connected: false, state: null },
};

function setup() {
  server.use(
    http.get('/api/v1/printers/', () => HttpResponse.json(printers)),
    http.get('/api/v1/printers/:id/status', ({ params }) => {
      const extra = statusById[Number(params.id)] ?? {};
      return HttpResponse.json({
        connected: true,
        state: 'IDLE',
        has_queued_work: false,
        awaiting_plate_clear: false,
        progress: 0,
        layer_num: 0,
        total_layers: 0,
        temperatures: { nozzle: 25, bed: 25, chamber: 25 },
        remaining_time: 0,
        filename: null,
        wifi_signal: -50,
        vt_tray: [],
        chamber_light: false,
        ...extra,
      });
    }),
    http.get('/api/v1/queue/', () => HttpResponse.json([])),
  );
}

/** The printer names currently on screen, in display order. */
async function visibleOrder(names = ['Zeta', 'Alpha', 'Mid', 'Ghost']) {
  await screen.findAllByText(new RegExp(`^(${names.join('|')})$`));
  return screen
    .queryAllByText(/^(Zeta|Alpha|Mid|Ghost)$/)
    .map((el) => el.textContent);
}

beforeEach(() => {
  localStorage.removeItem('printerViewMode');
  localStorage.removeItem('singlePrinterViewId');
  localStorage.removeItem('printerSortBy');
  localStorage.removeItem('printerSortAsc');
  localStorage.removeItem('hideDisconnectedPrinters');
});

describe('Printer page sorting', () => {
  it('lists printers by name ascending by default', async () => {
    setup();
    render(<PrintersPage />);

    await waitFor(async () => {
      expect(await visibleOrder()).toEqual(['Alpha', 'Ghost', 'Mid', 'Zeta']);
    });
  });

  it('reverses the order with the direction toggle', async () => {
    setup();
    render(<PrintersPage />);
    const user = userEvent.setup();
    await screen.findAllByText('Zeta');

    await user.click(screen.getByRole('button', { name: 'Sort descending' }));

    await waitFor(async () => {
      expect(await visibleOrder()).toEqual(['Zeta', 'Mid', 'Ghost', 'Alpha']);
    });
    expect(localStorage.setItem).toHaveBeenCalledWith('printerSortAsc', 'false');
  });

  it('sorts by model, remembering the choice', async () => {
    setup();
    render(<PrintersPage />);
    const user = userEvent.setup();
    await screen.findAllByText('Zeta');

    await user.click(screen.getByRole('button', { name: 'Name' }));
    await user.click(await screen.findByRole('button', { name: 'Model' }));

    // Model codes: A1, P1P, P1S, X1C.
    await waitFor(async () => {
      expect(await visibleOrder()).toEqual(['Alpha', 'Ghost', 'Mid', 'Zeta']);
    });
    expect(localStorage.setItem).toHaveBeenCalledWith('printerSortBy', 'model');
  });

  it('groups printers under their location headings when sorting by location', async () => {
    setup();
    render(<PrintersPage />);
    const user = userEvent.setup();
    await screen.findAllByText('Zeta');

    await user.click(screen.getByRole('button', { name: 'Name' }));
    await user.click(await screen.findByRole('button', { name: 'Location' }));

    expect(await screen.findByText('Garage')).toBeInTheDocument();
    expect(screen.getByText('Workshop')).toBeInTheDocument();
    expect(screen.getByText('Zeta')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });
});

describe('Printer page filtering', () => {
  it('shows only printers in the chosen status', async () => {
    setup();
    render(<PrintersPage />);
    const user = userEvent.setup();
    await screen.findAllByText('Zeta');

    await user.click(screen.getByRole('button', { name: 'All statuses' }));
    await user.click(await screen.findByRole('button', { name: 'Printing' }));

    await waitFor(async () => {
      expect(await visibleOrder()).toEqual(['Zeta']);
    });
  });

  it('hides disconnected printers and remembers that choice', async () => {
    setup();
    render(<PrintersPage />);
    const user = userEvent.setup();
    await screen.findAllByText('Ghost');

    await user.click(screen.getByRole('button', { name: 'Hide offline' }));

    await waitFor(() => expect(screen.queryByText('Ghost')).not.toBeInTheDocument());
    expect(screen.getByText('Zeta')).toBeInTheDocument();
    expect(localStorage.setItem).toHaveBeenCalledWith('hideDisconnectedPrinters', 'true');
  });
});

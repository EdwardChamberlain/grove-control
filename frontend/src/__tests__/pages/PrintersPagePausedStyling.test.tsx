/**
 * How a paused printer is marked across the Printers page: the orange dot in the
 * header counters, status group headings and bulk toolbar, the list row when it
 * is selected, and the rule that a printer in maintenance mode never shows as
 * paused (it is out of service, so its last reported state is stale).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { PrintersPage } from '../../pages/PrintersPage';
import { server } from '../mocks/server';

const basePrinter = {
  ip_address: '192.168.1.100',
  enabled: true,
  nozzle_count: 1,
  location: 'Workshop',
  auto_archive: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const activePrinters = [
  { ...basePrinter, id: 1, name: 'Paused Pete', serial_number: 'S1', model: 'X1C', is_active: true },
  { ...basePrinter, id: 2, name: 'Running Rita', serial_number: 'S2', model: 'P1S', is_active: true },
];

/** Printer 2 is paused, but switched to maintenance mode. */
const withMaintenancePrinter = [
  { ...basePrinter, id: 1, name: 'Paused Pete', serial_number: 'S1', model: 'X1C', is_active: true },
  { ...basePrinter, id: 2, name: 'Fixing Fred', serial_number: 'S2', model: 'P1S', is_active: false },
];

function setup(printers: typeof activePrinters, states: Record<number, string>) {
  server.use(
    http.get('/api/v1/printers/', () => HttpResponse.json(printers)),
    http.get('/api/v1/printers/:id/status', ({ params }) => HttpResponse.json({
      connected: true,
      state: states[Number(params.id)] ?? 'IDLE',
      current_print: states[Number(params.id)] === 'PAUSE' || states[Number(params.id)] === 'RUNNING' ? 'Widget.3mf' : null,
      has_queued_work: false,
      awaiting_plate_clear: false,
      progress: 42,
      layer_num: 10,
      total_layers: 100,
      temperatures: { nozzle: 25, bed: 25, chamber: 25 },
      remaining_time: 90,
      filename: null,
      wifi_signal: -50,
      vt_tray: [],
      chamber_light: false,
    })),
    http.get('/api/v1/queue/', () => HttpResponse.json([])),
  );
}

beforeEach(() => {
  localStorage.removeItem('printerViewMode');
  localStorage.removeItem('singlePrinterViewId');
  localStorage.removeItem('printerSortBy');
});

/** The coloured dot that sits just before the element's text. */
function dotBefore(label: HTMLElement): HTMLElement {
  return label.previousElementSibling as HTMLElement;
}

describe('Paused printer status markers', () => {
  it('uses an orange dot for the paused count in the header', async () => {
    setup(activePrinters, { 1: 'PAUSE', 2: 'RUNNING' });
    render(<PrintersPage />);

    const label = await screen.findByText(
      (_, el) => el?.tagName === 'SPAN' && el.textContent === '1 paused',
    );
    const dot = dotBefore(label);
    expect(dot).toHaveClass('bg-orange-500');
    expect(dot).not.toHaveClass('bg-status-warning');
  });

  it('uses an orange dot on the Paused heading when grouped by status', async () => {
    setup(activePrinters, { 1: 'PAUSE', 2: 'RUNNING' });
    render(<PrintersPage />);
    const user = userEvent.setup();
    await screen.findAllByText('Paused Pete');

    await user.click(screen.getByRole('button', { name: 'Name' }));
    await user.click(await screen.findByRole('button', { name: 'Status' }));

    const heading = await screen.findByRole('heading', { name: /^Paused/ });
    expect(heading.querySelector('span')).toHaveClass('bg-orange-500');
  });

  it('uses an orange dot for Paused in the bulk "select by state" menu', async () => {
    setup(activePrinters, { 1: 'PAUSE', 2: 'RUNNING' });
    render(<PrintersPage />);
    const user = userEvent.setup();
    await screen.findAllByText('Paused Pete');

    await user.click(screen.getByTestId('select-mode-toggle'));
    await user.click(await screen.findByRole('button', { name: 'Select by State' }));

    // The menu option is the "Paused" button that starts with a coloured dot.
    await screen.findAllByRole('button', { name: /^Paused/ });
    const option = screen
      .getAllByRole('button', { name: /^Paused/ })
      .find((button) => button.firstElementChild?.classList.contains('rounded-full'));
    expect(option).toBeDefined();
    expect(option!.firstElementChild).toHaveClass('bg-orange-500');
  });
});

describe('Paused list row when selected', () => {
  it('shows the green selection tint instead of the orange paused tint', async () => {
    setup(activePrinters, { 1: 'PAUSE', 2: 'RUNNING' });
    render(<PrintersPage />);
    const user = userEvent.setup();
    await screen.findAllByText('Paused Pete');
    fireEvent.click(screen.getByRole('button', { name: 'List' }));

    const row = await screen.findByTestId('printer-list-row-1');
    await waitFor(() => expect(row).toHaveClass('bg-orange-500/10'));

    await user.click(screen.getByTestId('select-mode-toggle'));
    await user.click(await screen.findByRole('button', { name: 'Select All' }));

    await waitFor(() => expect(screen.getByTestId('printer-list-row-1')).toHaveClass('bg-bambu-green/10'));
    expect(screen.getByTestId('printer-list-row-1')).not.toHaveClass('bg-orange-500/10');
    // The progress bar still shows that this print is paused.
    expect(within(screen.getByTestId('printer-list-row-1')).getByTestId('printer-list-progress-1')).toHaveClass('bg-orange-500');
  });
});

describe('Printer in maintenance mode', () => {
  it('is not styled as paused in the list view, and stays visible', async () => {
    setup(withMaintenancePrinter, { 1: 'PAUSE', 2: 'PAUSE' });
    render(<PrintersPage />);
    await screen.findAllByText('Fixing Fred');
    fireEvent.click(screen.getByRole('button', { name: 'List' }));

    const pausedRow = await screen.findByTestId('printer-list-row-1');
    const maintenanceRow = screen.getByTestId('printer-list-row-2');
    await waitFor(() => expect(pausedRow).toHaveClass('bg-orange-500/10'));
    expect(within(pausedRow).getAllByRole('img', { name: 'Paused' }).length).toBeGreaterThan(0);

    expect(maintenanceRow).not.toHaveClass('bg-orange-500/10');
    expect(within(maintenanceRow).queryByRole('img', { name: 'Paused' })).not.toBeInTheDocument();
    expect(within(maintenanceRow).getAllByText('Fixing Fred').length).toBeGreaterThan(0);
  });

  it('gets no orange glow or paused icon on its card', async () => {
    setup(withMaintenancePrinter, { 1: 'PAUSE', 2: 'PAUSE' });
    render(<PrintersPage />);

    const pausedCard = (await screen.findAllByText('Paused Pete'))[0].closest('[id="printer-card-1"]') as HTMLElement;
    const maintenanceCard = (await screen.findAllByText('Fixing Fred'))[0].closest('[id="printer-card-2"]') as HTMLElement;

    expect(pausedCard).toHaveClass('!border-orange-500/60');
    expect(maintenanceCard).not.toHaveClass('!border-orange-500/60');
    expect(within(maintenanceCard).queryByRole('img', { name: 'Paused' })).not.toBeInTheDocument();
  });
});

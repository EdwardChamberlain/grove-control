/**
 * PrinterCard controls in the fleet grid: chamber light, print stop/pause/
 * resume with their confirmations, plate clearing, and the jog popover
 * (not-homed guard, auto-home, XY and extruder moves).
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
  access_code: '12345678',
  model: 'X1C',
  enabled: true,
  is_active: true,
  nozzle_diameter: 0.4,
  nozzle_type: 'hardened_steel',
  location: 'Workshop',
  auto_archive: true,
  nozzle_count: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const idleStatus = {
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
};

/** Serves the printer and a status that tests can override per case. */
function setup(status: Record<string, unknown> = {}) {
  server.use(
    http.get('/api/v1/printers/', () => HttpResponse.json([printer])),
    http.get('/api/v1/printers/:id/status', () => HttpResponse.json({ ...idleStatus, ...status })),
    http.get('/api/v1/queue/', () => HttpResponse.json([])),
  );
}

/**
 * Records every POST to `route` and answers it. `calls` collects the query
 * string of each request, which is where the card encodes its arguments.
 */
function recordPost(route: string, response: { status?: number; body?: unknown } = {}) {
  const calls: string[] = [];
  server.use(
    http.post(route, ({ request }) => {
      calls.push(new URL(request.url).search);
      return HttpResponse.json(response.body ?? { success: true, message: 'ok' }, { status: response.status ?? 200 });
    }),
  );
  return calls;
}

async function openCard() {
  render(<PrintersPage />);
  const card = (await screen.findByText('X1 Carbon')).closest('[id="printer-card-1"]') as HTMLElement;
  expect(card).toBeInTheDocument();
  // Controls render once the live status has loaded.
  await within(card).findByRole('button', { name: /Machine health/ });
  return card;
}

beforeEach(() => {
  localStorage.removeItem('printerViewMode');
  localStorage.removeItem('singlePrinterViewId');
  sessionStorage.clear();
});

describe('Chamber light', () => {
  it('turns the chamber light on from the card', async () => {
    setup({ chamber_light: false });
    const calls = recordPost('*/api/v1/printers/1/chamber-light');
    const card = await openCard();
    const user = userEvent.setup();

    await user.click(within(card).getByRole('button', { name: 'Turn on chamber light' }));

    await waitFor(() => expect(calls).toEqual(['?on=true']));
  });

  it('turns the chamber light off when it is already on', async () => {
    setup({ chamber_light: true });
    const calls = recordPost('*/api/v1/printers/1/chamber-light');
    const card = await openCard();
    const user = userEvent.setup();

    await user.click(within(card).getByRole('button', { name: 'Turn off chamber light' }));

    await waitFor(() => expect(calls).toEqual(['?on=false']));
  });

  it('shows the printer error when the light cannot be switched', async () => {
    setup({ chamber_light: false });
    recordPost('*/api/v1/printers/1/chamber-light', { status: 500, body: { detail: 'Light relay offline' } });
    const card = await openCard();
    const user = userEvent.setup();

    await user.click(within(card).getByRole('button', { name: 'Turn on chamber light' }));

    expect(await screen.findByText('Light relay offline')).toBeInTheDocument();
  });
});

describe('Print controls', () => {
  it('pauses a running print after confirmation', async () => {
    setup({ state: 'RUNNING', progress: 40 });
    const pauses = recordPost('*/api/v1/printers/1/print/pause');
    const card = await openCard();
    const user = userEvent.setup();

    await user.click(within(card).getByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('button', { name: 'Pause Print' })).toBeInTheDocument();
    expect(pauses).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Pause Print' }));

    await waitFor(() => expect(pauses).toHaveLength(1));
    expect(await screen.findByText('Print paused')).toBeInTheDocument();
  });

  it('does not pause when the confirmation is cancelled', async () => {
    setup({ state: 'RUNNING', progress: 40 });
    const pauses = recordPost('*/api/v1/printers/1/print/pause');
    const card = await openCard();
    const user = userEvent.setup();

    await user.click(within(card).getByRole('button', { name: 'Pause' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('button', { name: 'Pause Print' })).not.toBeInTheDocument();
    expect(pauses).toHaveLength(0);
  });

  it('resumes a paused print after confirmation', async () => {
    setup({ state: 'PAUSE', progress: 40 });
    const resumes = recordPost('*/api/v1/printers/1/print/resume');
    const card = await openCard();
    const user = userEvent.setup();

    await user.click(within(card).getByRole('button', { name: 'Resume' }));
    await user.click(await screen.findByRole('button', { name: 'Resume Print' }));

    await waitFor(() => expect(resumes).toHaveLength(1));
    expect(await screen.findByText('Print resumed')).toBeInTheDocument();
  });

  it('does not resume when the confirmation is cancelled', async () => {
    setup({ state: 'PAUSE', progress: 40 });
    const resumes = recordPost('*/api/v1/printers/1/print/resume');
    const card = await openCard();
    const user = userEvent.setup();

    await user.click(within(card).getByRole('button', { name: 'Resume' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('button', { name: 'Resume Print' })).not.toBeInTheDocument();
    expect(resumes).toHaveLength(0);
  });

  it('stops a running print after confirmation', async () => {
    setup({ state: 'RUNNING', progress: 40 });
    const stops = recordPost('*/api/v1/printers/1/print/stop');
    const card = await openCard();
    const user = userEvent.setup();

    await user.click(within(card).getByRole('button', { name: 'Stop' }));
    await user.click(await screen.findByRole('button', { name: 'Stop Print' }));

    await waitFor(() => expect(stops).toHaveLength(1));
    expect(await screen.findByText('Print stopped')).toBeInTheDocument();
  });

  it('shows the printer error when the stop is refused', async () => {
    setup({ state: 'RUNNING', progress: 40 });
    recordPost('*/api/v1/printers/1/print/stop', { status: 409, body: { detail: 'Printer is busy homing' } });
    const card = await openCard();
    const user = userEvent.setup();

    await user.click(within(card).getByRole('button', { name: 'Stop' }));
    await user.click(await screen.findByRole('button', { name: 'Stop Print' }));

    expect(await screen.findByText('Printer is busy homing')).toBeInTheDocument();
  });

  it('disables the print controls for an idle printer', async () => {
    setup({ state: 'IDLE' });
    const card = await openCard();

    expect(within(card).getByRole('button', { name: 'Stop' })).toBeDisabled();
    expect(within(card).getByRole('button', { name: 'Pause' })).toBeDisabled();
  });
});

describe('Plate clearing', () => {
  it('marks the plate as cleared and sends the request', async () => {
    setup({ state: 'FINISH', awaiting_plate_clear: true });
    server.use(http.get('/api/v1/settings/ui-preferences', () => HttpResponse.json({ require_plate_clear: true })));
    const clears = recordPost('*/api/v1/printers/1/clear-plate');
    const card = await openCard();
    const user = userEvent.setup();

    await user.click(await within(card).findByRole('button', { name: 'Mark plate as cleared' }));

    await waitFor(() => expect(clears).toHaveLength(1));
    expect(await screen.findByText('Plate cleared — ready for next print')).toBeInTheDocument();
  });
});

describe('Jog controls', () => {
  it('disables the jog controls while printing', async () => {
    setup({ state: 'RUNNING', progress: 10 });
    const card = await openCard();

    expect(within(card).getByRole('button', { name: 'Disabled while printing' })).toBeDisabled();
  });

  it('asks before moving the plate on a printer that is not homed, then moves anyway', async () => {
    setup();
    const bedJogs = recordPost('*/api/v1/printers/1/bed-jog');
    const card = await openCard();
    const user = userEvent.setup();

    await user.click(within(card).getByRole('button', { name: 'Jog Controls' }));
    await user.click(await screen.findByRole('button', { name: 'Move plate down' }));

    expect(await screen.findByText('Printer is not homed')).toBeInTheDocument();
    expect(bedJogs).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Move anyway' }));

    await waitFor(() => expect(bedJogs).toEqual(['?distance=10&force=true']));
    expect(sessionStorage.getItem('bambuddy.bedJog.warned.1')).toBe('1');
  });

  it('auto-homes from the not-homed prompt', async () => {
    setup();
    const homes = recordPost('*/api/v1/printers/1/home-axes');
    const card = await openCard();
    const user = userEvent.setup();

    await user.click(within(card).getByRole('button', { name: 'Jog Controls' }));
    await user.click(await screen.findByRole('button', { name: 'Move plate up' }));
    const modal = screen.getByText('Printer is not homed').closest('.fixed') as HTMLElement;
    await user.click(within(modal).getByRole('button', { name: 'Auto Home' }));

    await waitFor(() => expect(homes).toEqual(['?axes=all']));
    expect(screen.queryByText('Printer is not homed')).not.toBeInTheDocument();
  });

  it('moves the plate directly once the user has accepted the warning', async () => {
    setup();
    sessionStorage.setItem('bambuddy.bedJog.warned.1', '1');
    const bedJogs = recordPost('*/api/v1/printers/1/bed-jog');
    const card = await openCard();
    const user = userEvent.setup();

    await user.click(within(card).getByRole('button', { name: 'Jog Controls' }));
    await user.click(await screen.findByRole('button', { name: 'Move plate up' }));

    await waitFor(() => expect(bedJogs).toEqual(['?distance=-10&force=true']));
    expect(screen.queryByText('Printer is not homed')).not.toBeInTheDocument();
  });

  it('moves the toolhead in XY from the jog pad', async () => {
    setup();
    const xyJogs = recordPost('*/api/v1/printers/1/xy-jog');
    const card = await openCard();
    const user = userEvent.setup();

    await user.click(within(card).getByRole('button', { name: 'Jog Controls' }));
    await user.click(await screen.findByRole('button', { name: 'Move X right' }));
    await user.click(screen.getByRole('button', { name: 'Move Y back' }));

    await waitFor(() => expect(xyJogs).toHaveLength(2));
    expect(xyJogs).toEqual(['?x=10&y=0', '?x=0&y=-10']);
  });

  it('extrudes and retracts filament from the extruder pad', async () => {
    setup();
    const extruderJogs = recordPost('*/api/v1/printers/1/extruder-jog');
    const card = await openCard();
    const user = userEvent.setup();

    await user.click(within(card).getByRole('button', { name: 'Jog Controls' }));
    await user.click(await screen.findByRole('button', { name: 'Extrude filament' }));
    await user.click(screen.getByRole('button', { name: 'Retract filament' }));

    await waitFor(() => expect(extruderJogs).toHaveLength(2));
    expect(extruderJogs).toEqual(['?distance=10', '?distance=-10']);
  });
});

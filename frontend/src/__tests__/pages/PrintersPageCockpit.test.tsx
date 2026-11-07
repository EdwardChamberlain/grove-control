/**
 * Single-printer cockpit controls: the jog pad (XY, plate, extruder, auto
 * home and the not-homed guard), chamber light, and pause/stop from the
 * cockpit. Each control is checked for the request it sends and for the
 * message the user sees when the printer refuses it.
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

function setup(status: Record<string, unknown> = {}) {
  server.use(
    http.get('/api/v1/printers/', () => HttpResponse.json([printer])),
    http.get('/api/v1/printers/:id/status', () => HttpResponse.json({ ...idleStatus, ...status })),
    http.get('/api/v1/queue/', () => HttpResponse.json([])),
    http.get('/api/v1/printers/:id/ams-labels', () => HttpResponse.json({})),
  );
}

/** Records every POST to `route`; `calls` holds each request's query string. */
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

async function openCockpit() {
  render(<PrintersPage />);
  // Opening the printer from its card name switches the page to the cockpit.
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'X1 Carbon' }));
  return screen.findByTestId('cockpit-jog-content');
}

beforeEach(() => {
  localStorage.removeItem('printerViewMode');
  localStorage.removeItem('singlePrinterViewId');
  sessionStorage.clear();
});

describe('Cockpit jog pad', () => {
  it('moves the toolhead by the selected step', async () => {
    setup();
    const xyJogs = recordPost('*/api/v1/printers/1/xy-jog');
    await openCockpit();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Move X right' }));
    await user.click(screen.getByRole('button', { name: '50' }));
    await user.click(screen.getByRole('button', { name: 'Move Y forward' }));

    await waitFor(() => expect(xyJogs).toHaveLength(2));
    expect(xyJogs).toEqual(['?x=10&y=0', '?x=0&y=50']);
  });

  it('shows the printer message when a toolhead move is refused', async () => {
    setup();
    recordPost('*/api/v1/printers/1/xy-jog', { status: 400, body: { detail: 'Axis limit reached' } });
    await openCockpit();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Move X left' }));

    expect(await screen.findByText('Axis limit reached')).toBeInTheDocument();
  });

  it('asks before moving the plate on a printer that is not homed, then moves anyway', async () => {
    setup();
    const bedJogs = recordPost('*/api/v1/printers/1/bed-jog');
    await openCockpit();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Move plate up' }));
    expect(await screen.findByText('Printer is not homed')).toBeInTheDocument();
    expect(bedJogs).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Move anyway' }));

    await waitFor(() => expect(bedJogs).toEqual(['?distance=-10&force=true']));
    expect(sessionStorage.getItem('bambuddy.bedJog.warned.1')).toBe('1');
  });

  it('moves the plate straight away after the warning has been accepted once', async () => {
    setup();
    sessionStorage.setItem('bambuddy.bedJog.warned.1', '1');
    const bedJogs = recordPost('*/api/v1/printers/1/bed-jog');
    await openCockpit();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Move plate down' }));

    await waitFor(() => expect(bedJogs).toEqual(['?distance=10&force=true']));
    expect(screen.queryByText('Printer is not homed')).not.toBeInTheDocument();
  });

  it('auto-homes from the pad and reports that homing started', async () => {
    setup();
    const homes = recordPost('*/api/v1/printers/1/home-axes');
    await openCockpit();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Auto Home' }));

    await waitFor(() => expect(homes).toEqual(['?axes=all']));
    expect(await screen.findByText('Auto-homing printer…')).toBeInTheDocument();
  });

  it('extrudes and retracts filament by the selected step', async () => {
    setup();
    const extruderJogs = recordPost('*/api/v1/printers/1/extruder-jog');
    await openCockpit();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: '100' }));
    await user.click(screen.getByRole('button', { name: 'Extrude filament' }));
    await user.click(screen.getByRole('button', { name: 'Retract filament' }));

    await waitFor(() => expect(extruderJogs).toHaveLength(2));
    expect(extruderJogs).toEqual(['?distance=100', '?distance=-100']);
  });

  it('disables the pad while a print is running', async () => {
    setup({ state: 'RUNNING', progress: 25 });
    await openCockpit();

    expect(screen.getByRole('button', { name: 'Move X right' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Extrude filament' })).toBeDisabled();
  });
});

describe('Cockpit chamber light', () => {
  it('switches the light on and confirms it', async () => {
    setup({ chamber_light: false });
    const lights = recordPost('*/api/v1/printers/1/chamber-light');
    await openCockpit();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Turn on chamber light' }));

    await waitFor(() => expect(lights).toEqual(['?on=true']));
    expect(await screen.findByText(/chamber light on/i)).toBeInTheDocument();
  });

  it('shows the printer message when the light cannot be switched', async () => {
    setup({ chamber_light: true });
    recordPost('*/api/v1/printers/1/chamber-light', { status: 500, body: { detail: 'Light relay offline' } });
    await openCockpit();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Turn off chamber light' }));

    expect(await screen.findByText('Light relay offline')).toBeInTheDocument();
  });
});

describe('Cockpit print controls', () => {
  it('pauses a running print only after confirmation', async () => {
    setup({ state: 'RUNNING', progress: 25 });
    const pauses = recordPost('*/api/v1/printers/1/print/pause');
    await openCockpit();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(pauses).toHaveLength(0);
    await user.click(await screen.findByRole('button', { name: 'Pause Print' }));

    await waitFor(() => expect(pauses).toHaveLength(1));
    expect(await screen.findByText('Print paused')).toBeInTheDocument();
  });

  it('does not pause when the cockpit confirmation is cancelled', async () => {
    setup({ state: 'RUNNING', progress: 25 });
    const pauses = recordPost('*/api/v1/printers/1/print/pause');
    await openCockpit();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Pause' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('button', { name: 'Pause Print' })).not.toBeInTheDocument();
    expect(pauses).toHaveLength(0);
  });

  it('stops a running print after confirmation', async () => {
    setup({ state: 'RUNNING', progress: 25 });
    const stops = recordPost('*/api/v1/printers/1/print/stop');
    await openCockpit();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await user.click(await screen.findByRole('button', { name: 'Stop Print' }));

    await waitFor(() => expect(stops).toHaveLength(1));
    expect(await screen.findByText('Print stopped')).toBeInTheDocument();
  });

  it('resumes a paused print only after confirmation', async () => {
    setup({ state: 'PAUSE', progress: 25 });
    const resumes = recordPost('*/api/v1/printers/1/print/resume');
    await openCockpit();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(resumes).toHaveLength(0);
    await user.click(await screen.findByRole('button', { name: 'Resume Print' }));

    await waitFor(() => expect(resumes).toHaveLength(1));
    expect(await screen.findByText('Print resumed')).toBeInTheDocument();
  });

  it('does not resume when the cockpit confirmation is cancelled', async () => {
    setup({ state: 'PAUSE', progress: 25 });
    const resumes = recordPost('*/api/v1/printers/1/print/resume');
    await openCockpit();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Resume' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('button', { name: 'Resume Print' })).not.toBeInTheDocument();
    expect(resumes).toHaveLength(0);
  });

  it('keeps the printer on screen after a stop is refused', async () => {
    setup({ state: 'RUNNING', progress: 25 });
    recordPost('*/api/v1/printers/1/print/stop', { status: 409, body: { detail: 'Printer is busy homing' } });
    await openCockpit();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await user.click(await screen.findByRole('button', { name: 'Stop Print' }));

    expect(await screen.findByText('Printer is busy homing')).toBeInTheDocument();
    expect(within(screen.getByTestId('cockpit-jog-content')).getByRole('button', { name: 'Move X right' })).toBeInTheDocument();
  });
});

/**
 * Bulk printer actions from the selection toolbar: which printers each action
 * reaches, the confirmation step for stop/pause, the result toast (including
 * partial failures), and selecting printers by state or location.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { PrintersPage } from '../../pages/PrintersPage';
import { server } from '../mocks/server';

const printers = [
  { id: 1, name: 'X1 Carbon', ip_address: '192.168.1.100', serial_number: 'S1', model: 'X1C', enabled: true, is_active: true, nozzle_count: 1, location: 'Workshop', auto_archive: true, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
  { id: 2, name: 'P1S Backup', ip_address: '192.168.1.101', serial_number: 'S2', model: 'P1S', enabled: true, is_active: true, nozzle_count: 1, location: 'Garage', auto_archive: true, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
  { id: 3, name: 'A1 Mini', ip_address: '192.168.1.102', serial_number: 'S3', model: 'A1M', enabled: true, is_active: true, nozzle_count: 1, location: null, auto_archive: true, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
];

/** Each printer's state, keyed by id. */
const states: Record<number, string> = { 1: 'RUNNING', 2: 'IDLE', 3: 'PAUSE' };

interface Calls {
  stop: number[];
  pause: number[];
  resume: number[];
}

function setup({ failing = [] as number[], stateOverrides = {} as Record<number, string> } = {}) {
  const calls: Calls = { stop: [], pause: [], resume: [] };
  const current = { ...states, ...stateOverrides };
  const statusFor = (id: number) => ({
    connected: true,
    state: current[id] ?? 'IDLE',
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
  });
  const command = (kind: keyof Calls) => ({ params }: { params: Record<string, string> }) => {
    const id = Number(params.id);
    calls[kind].push(id);
    if (failing.includes(id)) return HttpResponse.json({ detail: 'Printer offline' }, { status: 500 });
    return HttpResponse.json({ success: true, message: 'ok' });
  };
  server.use(
    http.get('/api/v1/printers/', () => HttpResponse.json(printers)),
    http.get('/api/v1/printers/:id/status', ({ params }) => HttpResponse.json(statusFor(Number(params.id)))),
    http.get('/api/v1/queue/', () => HttpResponse.json([])),
    http.post('/api/v1/printers/:id/print/stop', command('stop')),
    http.post('/api/v1/printers/:id/print/pause', command('pause')),
    http.post('/api/v1/printers/:id/print/resume', command('resume')),
  );
  return calls;
}

async function selectAllPrinters(user: ReturnType<typeof userEvent.setup>) {
  render(<PrintersPage />);
  await screen.findAllByText('X1 Carbon');
  await user.click(screen.getByTitle('Select'));
  await user.click(await screen.findByRole('button', { name: 'Select All' }));
  return screen.getByText('3 selected').parentElement as HTMLElement;
}

beforeEach(() => {
  localStorage.removeItem('printerViewMode');
  localStorage.removeItem('singlePrinterViewId');
  localStorage.removeItem('printerSortBy');
});

describe('Bulk printer actions', () => {
  it('stops only the printers that are printing or paused, after confirmation', async () => {
    const calls = setup();
    const user = userEvent.setup();
    const toolbar = await selectAllPrinters(user);

    await user.click(within(toolbar).getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Stop 3 Prints')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop All' }));

    await waitFor(() => expect(calls.stop.sort()).toEqual([1, 3]));
    expect(await screen.findByText('Stop completed on 2 printer(s)')).toBeInTheDocument();
  });

  it('pauses only the printers that are running, after confirmation', async () => {
    const calls = setup();
    const user = userEvent.setup();
    const toolbar = await selectAllPrinters(user);

    await user.click(within(toolbar).getByRole('button', { name: 'Pause' }));
    await user.click(await screen.findByRole('button', { name: 'Pause All' }));

    await waitFor(() => expect(calls.pause).toEqual([1]));
    expect(await screen.findByText('Pause completed on 1 printer(s)')).toBeInTheDocument();
  });

  it('does not pause anything when the confirmation is dismissed', async () => {
    const calls = setup();
    const user = userEvent.setup();
    const toolbar = await selectAllPrinters(user);

    await user.click(within(toolbar).getByRole('button', { name: 'Pause' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('button', { name: 'Pause All' })).not.toBeInTheDocument();
    expect(calls.pause).toHaveLength(0);
  });

  it('resumes the paused printers straight away, with no confirmation', async () => {
    const calls = setup();
    const user = userEvent.setup();
    const toolbar = await selectAllPrinters(user);

    await user.click(within(toolbar).getByRole('button', { name: 'Resume' }));

    await waitFor(() => expect(calls.resume).toEqual([3]));
    expect(await screen.findByText('Resume completed on 1 printer(s)')).toBeInTheDocument();
  });

  it('reports a partial result when one printer refuses the command', async () => {
    const calls = setup({ failing: [3] });
    const user = userEvent.setup();
    const toolbar = await selectAllPrinters(user);

    await user.click(within(toolbar).getByRole('button', { name: 'Stop' }));
    await user.click(await screen.findByRole('button', { name: 'Stop All' }));

    await waitFor(() => expect(calls.stop.sort()).toEqual([1, 3]));
    expect(await screen.findByText('1 succeeded, 1 failed')).toBeInTheDocument();
  });

  it('disables an action, and says why, when no selected printer is in the right state', async () => {
    const calls = setup({ stateOverrides: { 3: 'IDLE' } });
    const user = userEvent.setup();
    const toolbar = await selectAllPrinters(user);

    const resume = within(toolbar).getByRole('button', { name: 'Resume' });
    expect(resume).toBeDisabled();
    expect(resume).toHaveAttribute('title', 'No selected printers are in the right state for this action');
    await user.click(resume);
    expect(calls.resume).toHaveLength(0);
  });
});

async function openEmptySelection(user: ReturnType<typeof userEvent.setup>) {
  render(<PrintersPage />);
  await screen.findAllByText('X1 Carbon');
  await user.click(screen.getByTitle('Select'));
  const toolbar = (await screen.findByRole('button', { name: 'Select by State' })).closest('.fixed') as HTMLElement;
  expect(within(toolbar).getByText('0 selected')).toBeInTheDocument();
  return toolbar;
}

describe('Bulk selection shortcuts', () => {
  it('selects the printers in a given state', async () => {
    setup();
    const user = userEvent.setup();
    const toolbar = await openEmptySelection(user);

    await user.click(within(toolbar).getByRole('button', { name: 'Select by State' }));
    await user.click(await screen.findByRole('button', { name: /^Printing\s*1$/ }));

    expect(within(toolbar).getByText('1 selected')).toBeInTheDocument();
  });

  it('selects the printers in a given location', async () => {
    setup();
    const user = userEvent.setup();
    const toolbar = await openEmptySelection(user);

    await user.click(within(toolbar).getByRole('button', { name: 'Select by Location' }));
    await user.click(await screen.findByRole('button', { name: 'Garage' }));

    expect(within(toolbar).getByText('1 selected')).toBeInTheDocument();
  });
});

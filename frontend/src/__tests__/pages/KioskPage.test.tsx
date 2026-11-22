import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { KioskPage } from '../../pages/KioskPage';
import { api } from '../../api/client';

const printers = [
  { id: 1, name: 'Atlas', model: 'X1 Carbon', is_active: true },
  { id: 2, name: 'Beacon', model: 'P1S', is_active: true },
  { id: 3, name: 'Cedar', model: 'H2D', is_active: true },
  { id: 4, name: 'Delta', model: 'A1', is_active: true },
];

const baseSettings = { time_format: '24h', require_plate_clear: true };

const printing = {
  id: 1,
  name: 'Atlas',
  connected: true,
  state: 'RUNNING',
  current_print: 'Widget batch',
  current_queue_owner: 'Morgan',
  subtask_name: null,
  gcode_file: null,
  progress: 42,
  remaining_time: 65,
  layer_num: 120,
  total_layers: 300,
  awaiting_plate_clear: false,
};

const plateClear = {
  id: 2,
  name: 'Beacon',
  connected: true,
  state: 'FINISH',
  current_print: 'Plate-clear job',
  subtask_name: null,
  gcode_file: null,
  progress: 100,
  remaining_time: 0,
  awaiting_plate_clear: true,
  awaiting_plate_clear_print: {
    archive_id: 2,
    print_name: 'Plate-clear job',
    filename: 'plate-clear-job.3mf',
    thumbnail_path: null,
    created_by_username: 'Taylor',
  },
};

const paused = {
  ...printing,
  id: 3,
  name: 'Cedar',
  state: 'PAUSE',
  current_print: 'Cable chain',
  current_queue_owner: 'Sam',
  progress: 38,
  stg_cur: 6,
};

const idle = {
  id: 4,
  name: 'Delta',
  connected: true,
  state: 'IDLE',
  current_print: null,
  progress: 0,
  remaining_time: 0,
  awaiting_plate_clear: false,
};

function statusFor(id: number | string) {
  switch (Number(id)) {
    case 1: return printing;
    case 2: return plateClear;
    case 3: return paused;
    default: return { ...idle, id: Number(id), name: `Printer ${id}` };
  }
}

const queue = [
  { id: 10, printer_id: 1, archive_id: 1, library_file_id: null, archive_name: 'Widget batch', printer_name: 'Atlas', position: 1, status: 'printing', created_by_username: 'Morgan' },
  { id: 13, printer_id: 3, archive_id: 3, library_file_id: null, archive_name: 'Cable chain', printer_name: 'Cedar', position: 2, status: 'printing', created_by_username: 'Sam' },
  { id: 12, printer_id: 4, archive_id: 5, library_file_id: null, archive_name: 'Second in line', printer_name: 'Delta', position: 2, status: 'pending', created_by_username: 'Avery' },
  { id: 11, printer_id: 2, archive_id: 4, library_file_id: null, archive_name: 'Next assembly', printer_name: 'Beacon', position: 1, status: 'pending', created_by_username: 'Avery', print_time_seconds: 3600, waiting_reason: 'Waiting for compatible material' },
];

function jobOrder() {
  return screen.getAllByTestId(/^kiosk-job-(?!list|overflow)/).map((el) => el.getAttribute('data-testid'));
}

describe('KioskPage', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    server.use(
      http.get('/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: false, requires_setup: false })),
      http.get('/api/v1/settings/', () => HttpResponse.json(baseSettings)),
    );
    vi.spyOn(api, 'getPrinters').mockResolvedValue(printers as never);
    vi.spyOn(api, 'getSettings').mockResolvedValue(baseSettings as never);
    vi.spyOn(api, 'getQueue').mockResolvedValue(queue as never);
    vi.spyOn(api, 'getPrinterStatus').mockImplementation(async (printerId) => statusFor(printerId) as never);
    vi.spyOn(api, 'getCurrentPrintUser').mockResolvedValue({ username: null } as never);
  });

  it('shows one read-only job list in the order plate clear, paused, printing, queue', async () => {
    render(<KioskPage />);

    await waitFor(() => {
      expect(jobOrder()).toEqual([
        'kiosk-job-plate-clear-2',
        'kiosk-job-job-13',
        'kiosk-job-job-10',
        'kiosk-job-job-11',
        'kiosk-job-job-12',
      ]);
    });
    // Plate clear, paused and printing share one group; pending jobs are "Up next".
    expect(screen.getByTestId('kiosk-section-printing')).toHaveTextContent(/Printing\s*3/);
    expect(screen.getByTestId('kiosk-section-up-next')).toHaveTextContent(/Up next\s*2/);
    expect(screen.getByTestId('kiosk-job-plate-clear-2').parentElement).toContainElement(screen.getByTestId('kiosk-section-printing'));
    expect(screen.getByTestId('kiosk-job-job-11').parentElement).toContainElement(screen.getByTestId('kiosk-section-up-next'));
    expect(screen.queryByRole('heading', { name: 'Printers' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Active jobs' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('banner').parentElement).toHaveClass('h-screen', 'overflow-hidden');
  });

  it('summarises the fleet in a stats row', async () => {
    render(<KioskPage />);

    await waitFor(() => {
      expect(within(screen.getByTestId('kiosk-stat-clear-plate')).getByText('1')).toBeInTheDocument();
      expect(within(screen.getByTestId('kiosk-stat-printing')).getByText('1')).toBeInTheDocument();
      expect(within(screen.getByTestId('kiosk-stat-paused')).getByText('1')).toBeInTheDocument();
      expect(within(screen.getByTestId('kiosk-stat-queued')).getByText('2')).toBeInTheDocument();
      expect(within(screen.getByTestId('kiosk-stat-idle')).getByText('1')).toBeInTheDocument();
    });
  });

  it('shows a pulsing plate-clear line with the printer, owner and next job', async () => {
    render(<KioskPage />);

    const line = await screen.findByTestId('kiosk-job-plate-clear-2');
    expect(within(line).getByText('Clear plate')).toBeInTheDocument();
    expect(within(line).getByText('Plate-clear job')).toBeInTheDocument();
    expect(within(line).getByText('Beacon')).toBeInTheDocument();
    expect(within(line).getByText('Taylor')).toBeInTheDocument();
    expect(within(line).getByText(/Next: Next assembly/)).toBeInTheDocument();
    expect(line.firstElementChild).toHaveClass('kiosk-plate-clear-alert', 'border-yellow-400/40');
  });

  it('does not ask for a plate clear on a printer in maintenance mode', async () => {
    vi.mocked(api.getPrinters).mockResolvedValue([printers[0], { ...printers[1], is_active: false }] as never);

    render(<KioskPage />);

    await screen.findByTestId('kiosk-job-job-10');
    expect(screen.queryByTestId('kiosk-job-plate-clear-2')).not.toBeInTheDocument();
  });

  it('shows a paused job in orange with progress and its pause reason', async () => {
    render(<KioskPage />);

    const line = await screen.findByTestId('kiosk-job-job-13');
    await waitFor(() => expect(within(line).getByText('38%')).toBeInTheDocument());
    expect(within(line).getByText('Paused')).toBeInTheDocument();
    expect(line.firstElementChild).toHaveClass('border-orange-500/55');
    expect(within(line).getByText('Filament ran out')).toBeInTheDocument();
  });

  it('shows a running job with progress, time left and layers, in green', async () => {
    render(<KioskPage />);

    const line = await screen.findByTestId('kiosk-job-job-10');
    await waitFor(() => expect(within(line).getByText('42%')).toBeInTheDocument());
    expect(within(line).getByText('Printing')).toBeInTheDocument();
    expect(within(line).getByText('120/300')).toBeInTheDocument();
    expect(within(line).getByText(/ETA/)).toBeInTheDocument();
    expect(line.firstElementChild).toHaveClass('border-bambu-green/50');
  });

  it('shows waiting and scheduled jobs in queue order with their reason and time', async () => {
    vi.mocked(api.getQueue).mockResolvedValue([
      { id: 11, printer_id: 2, archive_id: 4, library_file_id: null, archive_name: 'Waiting job', printer_name: 'Beacon', position: 1, status: 'pending', waiting_reason: 'Waiting for compatible material' },
      { id: 12, printer_id: 4, archive_id: 5, library_file_id: null, archive_name: 'Scheduled job', printer_name: 'Delta', position: 2, status: 'pending', scheduled_time: '2099-01-01T09:30:00Z', waiting_reason: null },
    ] as never);

    render(<KioskPage />);

    const waiting = await screen.findByTestId('kiosk-job-job-11');
    expect(within(waiting).getByText('Waiting')).toBeInTheDocument();
    expect(within(waiting).getByText('Waiting for compatible material')).toBeInTheDocument();
    const scheduled = screen.getByTestId('kiosk-job-job-12');
    expect(within(scheduled).getByText('Scheduled')).toBeInTheDocument();
    expect(within(scheduled).getByText('Jan 1, 2099, 09:30 AM')).toBeInTheDocument();
    expect(jobOrder().slice(-2)).toEqual(['kiosk-job-job-11', 'kiosk-job-job-12']);
  });

  it('counts a heat-soaking job as printing', async () => {
    vi.mocked(api.getQueue).mockResolvedValue([
      { id: 12, printer_id: 1, archive_id: 1, library_file_id: null, archive_name: 'Warm chamber assembly', printer_name: 'Atlas', position: 1, status: 'preheating', created_by_username: 'Morgan' },
    ] as never);
    vi.mocked(api.getPrinterStatus).mockImplementation(async (printerId) => (
      printerId === 1
        ? { ...printing, state: 'IDLE', current_print: null, preheating: true, progress: 0 } as never
        : statusFor(printerId) as never
    ));

    render(<KioskPage />);

    const line = await screen.findByTestId('kiosk-job-job-12');
    expect(within(line).getByText('Preheating')).toBeInTheDocument();
    expect(within(line).getByText('Warm chamber assembly')).toBeInTheDocument();
    expect(line.firstElementChild).toHaveClass('border-amber-400/40');
    await waitFor(() => expect(within(screen.getByTestId('kiosk-stat-printing')).getByText('1')).toBeInTheDocument());
  });

  it('lists idle printers in a footer, leaving out busy, offline and maintenance ones', async () => {
    vi.mocked(api.getPrinters).mockResolvedValue([
      ...printers,
      { id: 5, name: 'Echo', model: 'A1', is_active: true },
      { id: 6, name: 'Foxtrot', model: 'A1', is_active: false },
    ] as never);
    vi.mocked(api.getPrinterStatus).mockImplementation(async (printerId) => (
      printerId === 5 ? { ...idle, id: 5, name: 'Echo', connected: false } as never : statusFor(printerId) as never
    ));

    render(<KioskPage />);

    const footer = await screen.findByTestId('kiosk-idle-printers');
    await waitFor(() => expect(within(footer).getByText('Delta')).toBeInTheDocument());
    expect(within(footer).getByText('Ready')).toBeInTheDocument();
    expect(within(footer).queryByText('Atlas')).not.toBeInTheDocument();
    expect(within(footer).queryByText('Echo')).not.toBeInTheDocument();
    expect(within(footer).queryByText('Foxtrot')).not.toBeInTheDocument();
  });

  it('collapses extra idle printers into a +N cell', async () => {
    const many = Array.from({ length: 9 }, (_, index) => ({ id: index + 1, name: `Idle ${index + 1}`, model: 'A1', is_active: true }));
    vi.mocked(api.getPrinters).mockResolvedValue(many as never);
    vi.mocked(api.getQueue).mockResolvedValue([] as never);
    vi.mocked(api.getPrinterStatus).mockImplementation(async (printerId) => ({ ...idle, id: printerId, name: `Idle ${printerId}` }) as never);

    render(<KioskPage />);

    const footer = await screen.findByTestId('kiosk-idle-printers');
    await waitFor(() => expect(within(footer).getByText('Idle 1')).toBeInTheDocument());
    expect(within(footer).getByText('Idle 5')).toBeInTheDocument();
    expect(within(footer).queryByText('Idle 6')).not.toBeInTheDocument();
    expect(screen.getByTestId('kiosk-idle-overflow')).toHaveTextContent('+4 Printers');
  });

  it('renders empty fleet and empty job states', async () => {
    vi.mocked(api.getPrinters).mockResolvedValue([] as never);
    vi.mocked(api.getQueue).mockResolvedValue([] as never);
    const { unmount } = render(<KioskPage />);
    expect(await screen.findByText('No printers configured')).toBeInTheDocument();
    unmount();

    vi.mocked(api.getPrinters).mockResolvedValue([printers[3]] as never);
    render(<KioskPage />);
    expect(await screen.findByText('No jobs to show')).toBeInTheDocument();
  });

  it('keeps a line for a running print that is missing from the queue response', async () => {
    vi.mocked(api.getQueue).mockResolvedValue([] as never);
    vi.mocked(api.getPrinterStatus).mockImplementation(async (printerId) => (
      printerId === 1 ? { ...printing, current_queue_owner: null } as never : statusFor(printerId) as never
    ));
    vi.mocked(api.getCurrentPrintUser).mockResolvedValue({ username: 'Ed' } as never);

    render(<KioskPage />);

    const line = await screen.findByTestId('kiosk-job-printer-1');
    expect(within(line).getByText('Widget batch')).toBeInTheDocument();
    expect(within(line).getByText('Atlas')).toBeInTheDocument();
    await waitFor(() => expect(within(line).getByTitle('Added by Ed')).toBeInTheDocument());
  });

  it('omits the owner when none is known', async () => {
    vi.mocked(api.getQueue).mockResolvedValue([
      { ...queue[0], created_by_username: null },
    ] as never);
    vi.mocked(api.getPrinterStatus).mockImplementation(async (printerId) => (
      printerId === 1 ? { ...printing, current_queue_owner: null } as never : statusFor(printerId) as never
    ));

    render(<KioskPage />);

    const line = await screen.findByTestId('kiosk-job-job-10');
    await waitFor(() => expect(within(line).getByText('42%')).toBeInTheDocument());
    expect(within(line).queryByTitle(/Added by/)).not.toBeInTheDocument();
  });

  it('does not keep a finished print on the list once the printer is no longer active', async () => {
    vi.mocked(api.getQueue).mockResolvedValue([] as never);
    vi.mocked(api.getPrinterStatus).mockImplementation(async (printerId) => (
      printerId === 1
        ? { ...printing, state: 'FINISH', progress: 100, awaiting_plate_clear: false } as never
        : statusFor(printerId) as never
    ));

    render(<KioskPage />);

    await screen.findByTestId('kiosk-job-plate-clear-2');
    expect(screen.queryByTestId('kiosk-job-printer-1')).not.toBeInTheDocument();
  });
});

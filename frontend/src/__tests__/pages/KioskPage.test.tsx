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
];

const baseSettings = { time_format: '24h', require_plate_clear: true };

function statusFor(id: string) {
  if (id === '2') {
    return {
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
    };
  }

  return {
    id: 1,
    name: 'Atlas',
    connected: true,
    state: 'RUNNING',
    current_print: 'Widget batch',
    subtask_name: null,
    gcode_file: null,
    progress: 42,
    remaining_time: 65,
    awaiting_plate_clear: false,
  };
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
      http.get('/api/v1/printers/', () => HttpResponse.json(printers)),
      http.get('/api/v1/printers/:id/status', ({ request }) => {
        const printerId = new URL(request.url).pathname.split('/')[4];
        return HttpResponse.json(statusFor(printerId));
      }),
      http.get('/api/v1/printers/:id/current-print-user', () => HttpResponse.json({ username: 'Morgan' })),
      http.get('/api/v1/queue/', () => HttpResponse.json([
        {
          id: 10,
          printer_id: 1,
          archive_id: 1,
          library_file_id: null,
          archive_name: 'Widget batch',
          printer_name: 'Atlas',
          position: 1,
          status: 'printing',
          created_by_username: null,
        },
        {
          id: 11,
          printer_id: 2,
          archive_id: 2,
          library_file_id: null,
          archive_name: 'Next assembly',
          printer_name: 'Beacon',
          position: 1,
          status: 'pending',
          created_by_username: 'Avery',
          print_time_seconds: 3600,
          waiting_reason: 'Waiting for compatible material',
        },
      ])),
    );
    vi.spyOn(api, 'getPrinters').mockResolvedValue(printers as never);
    vi.spyOn(api, 'getSettings').mockResolvedValue(baseSettings as never);
    vi.spyOn(api, 'getQueue').mockResolvedValue([
      {
        id: 10,
        printer_id: 1,
        archive_id: 1,
        library_file_id: null,
        archive_name: 'Widget batch',
        printer_name: 'Atlas',
        position: 1,
        status: 'printing',
        created_by_username: null,
      },
      {
        id: 11,
        printer_id: 2,
        archive_id: 2,
        library_file_id: null,
        archive_name: 'Next assembly',
        printer_name: 'Beacon',
        position: 1,
        status: 'pending',
        created_by_username: 'Avery',
        print_time_seconds: 3600,
        waiting_reason: 'Waiting for compatible material',
      },
    ] as never);
    vi.spyOn(api, 'getPrinterStatus').mockImplementation(async (printerId) => statusFor(String(printerId)) as never);
    vi.spyOn(api, 'getCurrentPrintUser').mockResolvedValue({ username: 'Morgan' });
  });

  it('shows compact fleet status and a vertically ordered read-only queue', async () => {
    render(<KioskPage />);

    await waitFor(() => {
      expect(screen.getByText('Printers')).toBeInTheDocument();
      expect(within(screen.getByTestId('kiosk-printer-1')).getByText('Atlas')).toBeInTheDocument();
      expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
      expect(screen.getAllByText('Widget batch').length).toBeGreaterThan(0);
      expect(screen.getByText('Morgan')).toBeInTheDocument();
      expect(screen.getAllByText('42%')).toHaveLength(2);
      expect(screen.getAllByText('Plate clear required')).toHaveLength(2);
      expect(screen.getByTestId('kiosk-queue-status-10')).toHaveTextContent('Printing');
      expect(screen.getByTestId('kiosk-queue-status-11')).toHaveTextContent('Waiting · Waiting for compatible material');
      expect(screen.getByRole('banner').parentElement).toHaveClass('h-screen', 'overflow-hidden');
      expect(screen.getByTestId('kiosk-printer-1')).toHaveClass('flex-1');
      expect(screen.queryByTestId('kiosk-fleet-overflow')).not.toBeInTheDocument();
    });

    const printing = screen.getByRole('heading', { name: 'Currently Printing' });
    const queued = screen.getByRole('heading', { name: 'Queued' });
    expect(printing.compareDocumentPosition(queued) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('uses a flashing yellow progress bar when a plate must be cleared', async () => {
    render(<KioskPage />);

    await waitFor(() => {
      expect(screen.getByTestId('kiosk-progress-2')).toHaveClass('bg-yellow-400');
      expect(screen.getByTestId('kiosk-printer-2')).toHaveClass('border-yellow-400/60', 'kiosk-plate-clear-alert');
    });
  });

  it('shows future pending jobs as scheduled with their start time', async () => {
    vi.mocked(api.getQueue).mockResolvedValue([
      {
        id: 12,
        printer_id: 2,
        archive_id: 2,
        library_file_id: null,
        archive_name: 'Scheduled assembly',
        printer_name: 'Beacon',
        position: 1,
        status: 'pending',
        scheduled_time: '2099-01-01T09:30:00Z',
        waiting_reason: null,
      },
    ] as never);

    render(<KioskPage />);

    await waitFor(() => {
      expect(screen.getByTestId('kiosk-queue-status-12')).toHaveTextContent('Scheduled · Jan 1, 2099, 09:30 AM');
    });
  });

  it('shows three prioritised printers and a faded fourth card when the fleet overflows', async () => {
    vi.mocked(api.getPrinters).mockResolvedValue([
      { id: 1, name: 'Printing printer', model: 'X1 Carbon', is_active: true },
      { id: 2, name: 'Plate-clear printer', model: 'P1S', is_active: true },
      { id: 3, name: 'Idle printer', model: 'A1', is_active: true },
      { id: 4, name: 'Idle printer 4', model: 'A1', is_active: true },
      { id: 5, name: 'Idle printer 5', model: 'A1', is_active: true },
      { id: 6, name: 'Idle printer 6', model: 'A1', is_active: true },
      { id: 7, name: 'Idle printer 7', model: 'A1', is_active: true },
      { id: 8, name: 'Idle printer 8', model: 'A1', is_active: true },
      { id: 9, name: 'Idle printer 9', model: 'A1', is_active: true },
    ] as never);
    vi.mocked(api.getPrinterStatus).mockImplementation(async (printerId) => {
      if (printerId === 2) return statusFor('2') as never;
      if (printerId !== 1) return { ...statusFor('1'), id: printerId, name: `Idle printer ${printerId}`, state: 'IDLE', current_print: null, progress: 0 } as never;
      return statusFor('1') as never;
    });

    render(<KioskPage />);

    await waitFor(() => {
      expect(screen.getByText('Plate-clear printer')).toBeInTheDocument();
      expect(screen.getByText('Printing printer')).toBeInTheDocument();
      expect(screen.getByText('Idle printer 4')).toBeInTheDocument();
      expect(screen.queryByText('Idle printer 9')).not.toBeInTheDocument();
      expect(screen.getByText('+6 Printers')).toBeInTheDocument();
      expect(screen.getAllByTestId(/^kiosk-printer-/)).toHaveLength(4);
      expect(screen.getByTestId('kiosk-fleet-grid')).toHaveClass('flex', 'h-[154px]');
      expect(screen.getByTestId('kiosk-printer-4')).toHaveClass('shrink-0');
      expect(screen.getByTestId('kiosk-printer-4')).toHaveStyle({ flexBasis: 'calc((100% - 2.25rem) / 3.25)' });
      expect(screen.getByTestId('kiosk-fleet-overflow')).toHaveClass('inset-y-0', 'right-0', 'w-[10%]');
    });
  });

  it('renders empty fleet and queue states', async () => {
    vi.mocked(api.getPrinters).mockResolvedValue([] as never);
    vi.mocked(api.getQueue).mockResolvedValue([] as never);
    render(<KioskPage />);

    expect(await screen.findByText('No printers configured')).toBeInTheDocument();
    expect(screen.getByText('No jobs are currently printing')).toBeInTheDocument();
    expect(screen.getByText('No jobs are queued')).toBeInTheDocument();
  });
});

/**
 * PrintModal flows not covered elsewhere: the print-options panel (its
 * expand toggle, per-option calibration choices and the dual-nozzle row),
 * the printer/model compatibility guard, and closing with Escape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { PrintModal } from '../../components/PrintModal';
import type { PrintQueueItem } from '../../api/client';
import { server } from '../mocks/server';

const singleNozzlePrinters = [
  { id: 1, name: 'X1 Carbon', model: 'X1C', ip_address: '192.168.1.100', enabled: true, is_active: true, nozzle_count: 1 },
];

const dualNozzlePrinters = [
  { id: 4, name: 'H2D Shop', model: 'H2D', ip_address: '192.168.1.104', enabled: true, is_active: true, nozzle_count: 2 },
];

interface Captured {
  queueBodies: Record<string, unknown>[];
}

function setup({
  printers = singleNozzlePrinters,
  archive = {} as Record<string, unknown>,
}: { printers?: unknown[]; archive?: Record<string, unknown> } = {}) {
  const captured: Captured = { queueBodies: [] };
  server.use(
    http.get('/api/v1/printers/', () => HttpResponse.json(printers)),
    http.get('/api/v1/archives/:id/plates', () => HttpResponse.json({ is_multi_plate: false, plates: [] })),
    http.get('/api/v1/archives/:id/filament-requirements', () => HttpResponse.json({ filaments: [] })),
    http.get('/api/v1/archives/:id', () => HttpResponse.json({ id: 1, filename: 'benchy.3mf', ...archive })),
    http.get('/api/v1/printers/:id/status', () => HttpResponse.json({ connected: true, state: 'IDLE', ams: [], vt_tray: [] })),
    http.post('/api/v1/queue/', async ({ request }) => {
      const text = await request.text();
      captured.queueBodies.push((text ? JSON.parse(text) : {}) as Record<string, unknown>);
      return HttpResponse.json({ id: 1, status: 'pending' });
    }),
  );
  return captured;
}

/** The option row for a label: its title/description block and its choice buttons side by side. */
function optionRow(label: string) {
  const row = screen.getByText(label).parentElement?.parentElement as HTMLElement;
  expect(row).toBeInTheDocument();
  return row;
}

async function openOptions(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Print Options' }));
}

const onClose = vi.fn();
const onSuccess = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PrintModal print options panel', () => {
  it('stays collapsed until the Print Options toggle is opened', async () => {
    setup();
    const user = userEvent.setup();
    render(<PrintModal mode="create" libraryFileId={5} archiveName="Benchy" initialSelectedPrinterIds={[1]} onClose={onClose} onSuccess={onSuccess} />);

    const toggle = await screen.findByRole('button', { name: 'Print Options' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Bed Levelling')).not.toBeInTheDocument();

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Bed Levelling')).toBeInTheDocument();
    expect(screen.getByText('Timelapse')).toBeInTheDocument();
  });

  it('hides the nozzle offset calibration on single-nozzle printers', async () => {
    setup();
    const user = userEvent.setup();
    render(<PrintModal mode="create" libraryFileId={5} archiveName="Benchy" initialSelectedPrinterIds={[1]} onClose={onClose} onSuccess={onSuccess} />);

    await openOptions(user);

    expect(screen.queryByText('Nozzle Offset Calibration')).not.toBeInTheDocument();
  });

  it('shows the nozzle offset calibration for a dual-nozzle printer and sends its choice', async () => {
    const captured = setup({ printers: dualNozzlePrinters });
    const user = userEvent.setup();
    render(<PrintModal mode="create" libraryFileId={5} archiveName="Benchy" initialSelectedPrinterIds={[4]} onClose={onClose} onSuccess={onSuccess} />);

    await openOptions(user);
    await user.click(within(optionRow('Nozzle Offset Calibration')).getByRole('button', { name: 'On' }));
    await user.click(screen.getByRole('button', { name: /^print$/i }));

    await waitFor(() => expect(captured.queueBodies).toHaveLength(1));
    expect(captured.queueBodies[0]).toMatchObject({ nozzle_offset_cali: 'on' });
  });

  it('sends the chosen calibration and toggle values with the queue item', async () => {
    const captured = setup();
    const user = userEvent.setup();
    render(<PrintModal mode="create" libraryFileId={5} archiveName="Benchy" initialSelectedPrinterIds={[1]} onClose={onClose} onSuccess={onSuccess} />);

    await openOptions(user);
    await user.click(within(optionRow('Bed Levelling')).getByRole('button', { name: 'Off' }));
    await user.click(within(optionRow('Flow Calibration')).getByRole('button', { name: 'On' }));
    await user.click(within(optionRow('Vibration Calibration')).getByRole('button', { name: 'Off' }));
    await user.click(within(optionRow('First Layer Inspection')).getByRole('button', { name: 'On' }));
    await user.click(within(optionRow('Timelapse')).getByRole('button', { name: 'On' }));
    await user.click(screen.getByRole('button', { name: /^print$/i }));

    await waitFor(() => expect(captured.queueBodies).toHaveLength(1));
    expect(captured.queueBodies[0]).toMatchObject({
      bed_levelling: 'off',
      flow_cali: 'on',
      vibration_cali: false,
      layer_inspect: true,
      timelapse: true,
    });
  });

  it('sends an option switched back off as off', async () => {
    const captured = setup();
    const user = userEvent.setup();
    render(<PrintModal mode="create" libraryFileId={5} archiveName="Benchy" initialSelectedPrinterIds={[1]} onClose={onClose} onSuccess={onSuccess} />);

    await openOptions(user);
    await user.click(within(optionRow('Timelapse')).getByRole('button', { name: 'On' }));
    await user.click(within(optionRow('Timelapse')).getByRole('button', { name: 'Off' }));
    await user.click(screen.getByRole('button', { name: /^print$/i }));

    await waitFor(() => expect(captured.queueBodies).toHaveLength(1));
    expect(captured.queueBodies[0]).toMatchObject({ timelapse: false });
  });
});

describe('PrintModal printer compatibility guard', () => {
  it('refuses to queue a file sliced for another model and names both models', async () => {
    const captured = setup({ archive: { sliced_for_model: 'A1' } });
    const user = userEvent.setup();
    render(<PrintModal mode="create" archiveId={1} archiveName="Benchy" initialSelectedPrinterIds={[1]} onClose={onClose} onSuccess={onSuccess} />);

    await user.click(await screen.findByRole('button', { name: /^print$/i }));

    expect(
      await screen.findByText('This file was sliced for A1, but this printer is a X1C'),
    ).toBeInTheDocument();
    expect(captured.queueBodies).toHaveLength(0);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe('PrintModal submit failures', () => {
  it('keeps the modal open and reports the server error when queueing fails', async () => {
    setup();
    server.use(http.post('/api/v1/queue/', () => HttpResponse.json({ detail: 'Queue is full' }, { status: 500 })));
    const user = userEvent.setup();
    render(<PrintModal mode="create" libraryFileId={5} archiveName="Benchy" initialSelectedPrinterIds={[1]} onClose={onClose} onSuccess={onSuccess} />);

    await user.click(await screen.findByRole('button', { name: /^print$/i }));

    expect(await screen.findByText(/Queue is full/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('reports how many printers accepted the job when only some do', async () => {
    const twoPrinters = [
      ...singleNozzlePrinters,
      { id: 2, name: 'P1S', model: 'P1S', ip_address: '192.168.1.101', enabled: true, is_active: true, nozzle_count: 1 },
    ];
    const captured = setup({ printers: twoPrinters });
    server.use(
      http.post('/api/v1/queue/', async ({ request }) => {
        const text = await request.text();
        const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
        captured.queueBodies.push(body);
        if (body.printer_id === 2) return HttpResponse.json({ detail: 'Printer offline' }, { status: 500 });
        return HttpResponse.json({ id: 1, status: 'pending' });
      }),
    );
    const user = userEvent.setup();
    render(<PrintModal mode="create" libraryFileId={5} archiveName="Benchy" initialSelectedPrinterIds={[1, 2]} onClose={onClose} onSuccess={onSuccess} />);

    await user.click(await screen.findByRole('button', { name: /^print$/i }));

    expect(await screen.findByText('1 succeeded, 1 failed')).toBeInTheDocument();
    expect(captured.queueBodies.map((body) => body.printer_id).sort()).toEqual([1, 2]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the server error when saving an edited queue item fails', async () => {
    setup();
    server.use(http.patch('/api/v1/queue/:id', () => HttpResponse.json({ detail: 'Item already started' }, { status: 400 })));
    const user = userEvent.setup();
    const queueItem = {
      id: 1,
      printer_id: 1,
      archive_id: 1,
      position: 1,
      scheduled_time: null,
      require_previous_success: false,
      auto_off_after: false,
      manual_start: false,
      force_color_match: true,
      ams_mapping: null,
      plate_id: null,
      bed_levelling: 'on',
      flow_cali: 'off',
      vibration_cali: true,
      layer_inspect: false,
      timelapse: false,
      use_ams: true,
      status: 'pending',
      archive_name: 'Benchy',
      printer_name: 'X1 Carbon',
    } as unknown as PrintQueueItem;
    render(<PrintModal mode="edit-queue-item" archiveId={1} archiveName="Benchy" queueItem={queueItem} onClose={onClose} onSuccess={onSuccess} />);

    await user.click(await screen.findByRole('button', { name: /save/i }));

    expect(await screen.findByText('Failed: Item already started')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('PrintModal compatibility gate on the button', () => {
  it('disables Print while the selected printer cannot take the sliced file', async () => {
    setup({ archive: { sliced_for_model: 'A1' } });
    render(<PrintModal mode="create" archiveId={1} archiveName="Benchy" initialSelectedPrinterIds={[1]} onClose={onClose} onSuccess={onSuccess} />);

    await waitFor(() => expect(screen.getByRole('button', { name: /^print$/i })).toBeDisabled());
  });
});

describe('PrintModal dismissal', () => {
  it('closes when Escape is pressed', async () => {
    setup();
    const user = userEvent.setup();
    render(<PrintModal mode="create" libraryFileId={5} archiveName="Benchy" initialSelectedPrinterIds={[1]} onClose={onClose} onSuccess={onSuccess} />);

    await screen.findByRole('button', { name: /^print$/i });
    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/**
 * The Queue keeps a finished job visible, with a yellow hand "Clear plate" line,
 * until its printer's plate is marked cleared (#366).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { QueuePage } from '../../pages/QueuePage';
import { setAuthToken } from '../../api/client';

const printers = [
  { id: 1, name: 'Workshop P1S', model: 'P1S', is_active: true, location: 'Workshop' },
  { id: 2, name: 'Desk A1', model: 'A1', is_active: true, location: 'Office' },
];

function status(awaiting: boolean, state = 'FINISH') {
  return {
    connected: true,
    state,
    awaiting_plate_clear: awaiting,
    awaiting_plate_clear_print: awaiting
      ? { archive_id: 7, print_name: 'Phone stand v4', filename: 'stand.3mf', thumbnail_path: null, created_by_username: 'ed' }
      : null,
  };
}

describe('QueuePage plate clear', () => {
  let cleared: number[];
  let awaiting: Record<number, boolean>;
  let statusOverrides: Record<number, object>;
  let settings: Record<string, unknown>;

  beforeEach(() => {
    cleared = [];
    awaiting = { 1: true, 2: false };
    statusOverrides = {};
    settings = { require_plate_clear: true };
    vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
      key === 'queue.viewMode' ? 'list' : null,
    );
    server.use(
      http.get('/api/v1/queue/', () => HttpResponse.json([])),
      http.get('/api/v1/printers/', () => HttpResponse.json(printers)),
      http.get('/api/v1/settings/', () => HttpResponse.json(settings)),
      http.get('/api/v1/printers/:id/status', ({ params }) =>
        HttpResponse.json({ ...status(awaiting[Number(params.id)]), ...statusOverrides[Number(params.id)] }),
      ),
      http.post('/api/v1/printers/:id/clear-plate', ({ params }) => {
        const id = Number(params.id);
        cleared.push(id);
        awaiting[id] = false;
        return HttpResponse.json({ success: true, message: 'ok' });
      }),
    );
  });

  it('shows the finished job for a printer awaiting plate clear', async () => {
    render(<QueuePage />);

    const line = await screen.findByTestId('plate-clear-1');
    expect(line).toHaveTextContent('Phone stand v4');
    expect(line).toHaveTextContent('Workshop P1S');
    expect(line).toHaveTextContent('Clear plate');
    expect(screen.queryByTestId('plate-clear-2')).not.toBeInTheDocument();
  });

  it('removes the line once the plate is marked cleared', async () => {
    const user = userEvent.setup();
    render(<QueuePage />);

    const line = await screen.findByTestId('plate-clear-1');
    await user.click(line.querySelector('button')!);

    await waitFor(() => expect(cleared).toEqual([1]));
    await waitFor(() => expect(screen.queryByTestId('plate-clear-1')).not.toBeInTheDocument());
  });

  it('hides the line when plate-clear confirmation is off', async () => {
    settings = { require_plate_clear: false };
    render(<QueuePage />);

    await screen.findByText('Print Queue');
    await waitFor(() => expect(screen.queryByTestId('plate-clear-1')).not.toBeInTheDocument());
  });

  it('names the next queued job for that printer in the hint', async () => {
    server.use(
      http.get('/api/v1/queue/', () => HttpResponse.json([
        { id: 5, printer_id: 1, archive_id: 3, position: 2, status: 'pending', archive_name: 'Later job', printer_name: 'Workshop P1S', created_at: '2026-11-22T10:00:00Z' },
        { id: 4, printer_id: 1, archive_id: 2, position: 1, status: 'pending', archive_name: 'Cable clip x12', printer_name: 'Workshop P1S', created_at: '2026-11-22T10:00:00Z' },
      ])),
    );
    render(<QueuePage />);

    const line = await screen.findByTestId('plate-clear-1');
    expect(line).toHaveTextContent('Next: Cable clip x12');
    expect(line).not.toHaveTextContent('Later job');
  });

  it('falls back to the printer status for the name when the finished print is unknown', async () => {
    statusOverrides = { 1: { awaiting_plate_clear_print: null, subtask_name: 'Gear housing', current_print: 'Gear housing' } };
    render(<QueuePage />);

    expect(await screen.findByTestId('plate-clear-1')).toHaveTextContent('Gear housing');
  });

  it('shows no line for a printer that is printing', async () => {
    statusOverrides = { 1: { state: 'RUNNING' } };
    render(<QueuePage />);

    await screen.findByText('Print Queue');
    await waitFor(() => expect(screen.queryByTestId('plate-clear-1')).not.toBeInTheDocument());
  });

  it('keeps the queue empty state out of the way only on the Queue tab', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key: string) => {
      if (key === 'queue.viewMode') return 'list';
      if (key === 'queue.activeTab') return 'history';
      return null;
    });
    render(<QueuePage />);

    await screen.findByText('Print Queue');
    expect(screen.queryByTestId('plate-clear-1')).not.toBeInTheDocument();
    expect(await screen.findByText('No prints scheduled')).toBeInTheDocument();
  });

  it('hides lines for printers outside the selected location', async () => {
    awaiting = { 1: true, 2: true };
    const user = userEvent.setup();
    render(<QueuePage />);

    await screen.findByTestId('plate-clear-1');
    expect(screen.getByTestId('plate-clear-2')).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: /all locations/i }));
    await user.click(await screen.findByRole('button', { name: 'Workshop' }));

    await waitFor(() => expect(screen.queryByTestId('plate-clear-2')).not.toBeInTheDocument());
    expect(screen.getByTestId('plate-clear-1')).toBeInTheDocument();
  });

  it('disables the button without the clear plate permission', async () => {
    setAuthToken('viewer-token');
    server.use(
      http.get('*/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: true, requires_setup: false })),
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json({ id: 9, username: 'viewer', is_admin: false, permissions: ['queue:read'] }),
      ),
    );
    render(<QueuePage />);

    const line = await screen.findByTestId('plate-clear-1');
    expect(line.querySelector('button')).toBeDisabled();
    setAuthToken(null);
  });

  it('shows the error and keeps the line when clearing the plate fails', async () => {
    server.use(
      http.post('/api/v1/printers/:id/clear-plate', () =>
        HttpResponse.json({ detail: 'Printer offline' }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();
    render(<QueuePage />);

    const line = await screen.findByTestId('plate-clear-1');
    await user.click(line.querySelector('button')!);

    expect(await screen.findByText('Printer offline')).toBeInTheDocument();
    expect(screen.getByTestId('plate-clear-1')).toBeInTheDocument();
  });

  it('shows a spinner and blocks a second click while clearing', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    server.use(
      http.post('/api/v1/printers/:id/clear-plate', async () => {
        await gate;
        return HttpResponse.json({ success: true, message: 'ok' });
      }),
    );
    const user = userEvent.setup();
    render(<QueuePage />);

    const line = await screen.findByTestId('plate-clear-1');
    const button = line.querySelector('button')!;
    await user.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    expect(button.querySelector('.animate-spin')).not.toBeNull();
    release();
  });
});

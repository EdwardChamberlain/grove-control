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

const printers = [
  { id: 1, name: 'Workshop P1S', model: 'P1S', is_active: true },
  { id: 2, name: 'Desk A1', model: 'A1', is_active: true },
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
  let settings: Record<string, unknown>;

  beforeEach(() => {
    cleared = [];
    awaiting = { 1: true, 2: false };
    settings = { require_plate_clear: true };
    vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
      key === 'queue.viewMode' ? 'list' : null,
    );
    server.use(
      http.get('/api/v1/queue/', () => HttpResponse.json([])),
      http.get('/api/v1/printers/', () => HttpResponse.json(printers)),
      http.get('/api/v1/settings/', () => HttpResponse.json(settings)),
      http.get('/api/v1/printers/:id/status', ({ params }) =>
        HttpResponse.json(status(awaiting[Number(params.id)])),
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
});

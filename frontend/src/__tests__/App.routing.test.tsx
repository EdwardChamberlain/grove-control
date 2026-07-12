import { describe, expect, it, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import App from '../App';
import { server } from './mocks/server';

function renderAt(path: string) {
  window.history.pushState({}, '', path);
  return render(<App />);
}

describe('App route smoke coverage', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/v1/auth/status', () =>
        HttpResponse.json({ auth_enabled: false, requires_setup: false })
      ),
      http.get('/api/v1/settings/', () =>
        HttpResponse.json({
          auto_archive: true,
          save_thumbnails: true,
          capture_finish_photo: true,
          default_filament_cost: 25,
          currency: 'USD',
          time_format: 'system',
          date_format: 'system',
          spoolman_enabled: false,
          spoolman_url: '',
        })
      ),
      http.get('/api/v1/queue/', () => HttpResponse.json([])),
      http.get('/api/v1/inventory/spools', () => HttpResponse.json([])),
      http.get('/api/v1/spoolman/settings', () =>
        HttpResponse.json({ spoolman_enabled: 'false', spoolman_url: '' })
      ),
      http.get('/api/v1/spoolman/inventory/spools', () => HttpResponse.json([]))
    );
  });

  it('renders the login route outside the protected layout', async () => {
    renderAt('/login');

    expect(await screen.findByRole('heading', { name: /Grove Control Login/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Username/i)).toBeInTheDocument();
  });

  it('renders the setup route when auth is disabled', async () => {
    renderAt('/setup');

    expect(await screen.findByRole('heading', { name: /Grove Control Setup/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Enable Authentication/i)).toBeInTheDocument();
  });

  it('renders the protected home route when auth is disabled', async () => {
    renderAt('/');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Printers/i })).toBeInTheDocument();
    });
  });

  it('renders inventory, queue, and settings routes through the layout', async () => {
    const inventory = renderAt('/inventory');
    expect(await screen.findByRole('heading', { name: /Inventory/i })).toBeInTheDocument();
    inventory.unmount();

    const queue = renderAt('/queue');
    expect(await screen.findByRole('heading', { name: /Print Queue/i })).toBeInTheDocument();
    queue.unmount();

    renderAt('/settings');
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
  });
});

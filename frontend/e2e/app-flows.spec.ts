import { expect, test, type Page } from '@playwright/test';

type ApiCall = { method: string; path: string; body?: unknown };

const printer = {
  id: 1,
  name: 'Workshop X1C',
  serial_number: '00M09A123456789',
  ip_address: '192.168.1.50',
  access_code: '12345678',
  is_active: true,
  auto_archive: true,
  model: 'X1C',
  nozzle_count: 1,
  location: 'Workshop',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const spool = {
  id: 1,
  name: 'PLA Basic',
  spool_name: 'PLA Basic',
  filament_type: 'PLA',
  material: 'PLA',
  color_name: 'Red',
  color_hex: '#ff0000',
  rgba: '#ff0000',
  brand: 'Bambu',
  label_weight: 1000,
  weight_used: 100,
  remaining_weight: 900,
  archived_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const archive = {
  id: 1,
  filename: 'benchy.3mf',
  print_name: 'Benchy',
  file_size: 1024,
  status: 'completed',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  printer_id: 1,
  printer_name: 'Workshop X1C',
  thumbnail_path: null,
  print_time_seconds: 3600,
  filament_used_grams: 25,
  filament_type: 'PLA',
  filament_color: '#ff0000',
  sliced_for_model: 'X1C',
};

async function mockApi(page: Page, calls: ApiCall[], options: { authEnabled?: boolean } = {}) {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const { pathname } = url;
    const method = route.request().method();

    if (!pathname.startsWith('/api/v1/') && pathname !== '/health') {
      await route.continue();
      return;
    }

    let body: unknown;
    const postData = route.request().postData();
    if (postData && route.request().headers()['content-type']?.includes('application/json')) {
      body = JSON.parse(postData);
    }
    calls.push({ method, path: pathname, body });

    if (pathname === '/api/v1/auth/status') {
      await route.fulfill({ json: { auth_enabled: options.authEnabled ?? false, requires_setup: false } });
    } else if (pathname === '/api/v1/auth/login' && method === 'POST') {
      await route.fulfill({
        json: {
          access_token: 'e2e-token',
          token_type: 'bearer',
          user: { id: 1, username: 'admin', role: 'admin', is_admin: true, permissions: ['*'] },
        },
      });
    } else if (pathname === '/api/v1/auth/setup' && method === 'POST') {
      await route.fulfill({ json: { auth_enabled: true, admin_created: true } });
    } else if (pathname === '/api/v1/auth/me') {
      await route.fulfill({
        json: {
          id: 1,
          username: 'admin',
          role: 'admin',
          is_admin: true,
          groups: [{ id: 1, name: 'Administrators' }],
          permissions: ['*'],
          created_at: '2024-01-01T00:00:00Z',
        },
      });
    } else if (pathname === '/api/v1/settings/') {
      await route.fulfill({
        json: {
          auto_archive: true,
          save_thumbnails: true,
          capture_finish_photo: true,
          default_filament_cost: 25,
          currency: 'USD',
          time_format: 'system',
          date_format: 'system',
          require_plate_clear: true,
          spoolman_enabled: false,
          spoolman_url: '',
          ...(body && typeof body === 'object' ? body : {}),
        },
      });
    } else if (pathname === '/api/v1/printers/') {
      if (method === 'POST') await route.fulfill({ json: { ...printer, id: 2, ...(body as object) } });
      else await route.fulfill({ json: [printer] });
    } else if (pathname === '/api/v1/printers/1' && method === 'PATCH') {
      await route.fulfill({ json: { ...printer, ...(body as object) } });
    } else if (pathname === '/api/v1/printers/1/status') {
      await route.fulfill({ json: { id: 1, name: printer.name, connected: true, state: 'IDLE', progress: 0 } });
    } else if (pathname === '/api/v1/inventory/spools') {
      if (method === 'POST') await route.fulfill({ json: { ...spool, id: 2, ...(body as object) } });
      else await route.fulfill({ json: [spool] });
    } else if (pathname === '/api/v1/inventory/spools/1' && method === 'PATCH') {
      await route.fulfill({ json: { ...spool, ...(body as object) } });
    } else if (pathname === '/api/v1/archives/upload' && method === 'POST') {
      await route.fulfill({ json: archive });
    } else if (pathname === '/api/v1/archives/1/slice' && method === 'POST') {
      await route.fulfill({ status: 202, json: { job_id: 7, status_url: '/api/v1/slice-jobs/7' } });
    } else if (pathname === '/api/v1/queue/' && method === 'POST') {
      await route.fulfill({ json: { id: 2, archive_id: 1, printer_id: 1, status: 'pending', position: 2 } });
    } else if (pathname === '/api/v1/queue/1' && method === 'PATCH') {
      await route.fulfill({ json: { id: 1, archive_id: 1, printer_id: 1, status: 'pending', position: 1, ...(body as object) } });
    } else if (pathname === '/api/v1/queue/1/cancel' && method === 'POST') {
      await route.fulfill({ json: { message: 'Queue item cancelled' } });
    } else if (pathname === '/api/v1/queue/') {
      await route.fulfill({ json: [{ id: 1, archive_id: 1, archive_name: 'Benchy', printer_id: 1, printer_name: printer.name, status: 'pending', position: 1 }] });
    } else if (pathname === '/api/v1/archives/') {
      await route.fulfill({ json: [archive] });
    } else if (pathname === '/api/v1/spoolman/settings') {
      await route.fulfill({ json: { spoolman_enabled: 'false', spoolman_url: '' } });
    } else if (pathname === '/api/v1/inventory/colors/map') {
      await route.fulfill({ json: { colors: {} } });
    } else if (pathname === '/health') {
      await route.fulfill({ json: { status: 'healthy' } });
    } else {
      await route.fulfill({ json: [] });
    }
  });
}

test('login and setup smoke flows submit expected payloads', async ({ page }) => {
  const calls: ApiCall[] = [];
  await mockApi(page, calls, { authEnabled: true });

  await page.goto('/login');
  await page.getByLabel(/Username/i).fill('admin');
  await page.getByLabel(/Password/i).fill('secret123');
  await page.getByRole('button', { name: /Sign in/i }).click();
  await expect.poll(() => calls.some((call) => call.path === '/api/v1/auth/login')).toBe(true);

  await page.unroute('**/*');
  calls.length = 0;
  await mockApi(page, calls, { authEnabled: false });
  await page.goto('/setup');
  await page.getByLabel(/Enable Authentication/i).check();
  await page.getByLabel(/Admin Username/i).fill('owner');
  await page.getByLabel(/^Admin Password/i).fill('secret123');
  await page.getByLabel(/Confirm Password/i).fill('secret123');
  await page.getByRole('button', { name: /Complete Setup/i }).click();
  await expect.poll(() => calls.some((call) => call.path === '/api/v1/auth/setup')).toBe(true);
});

test('core app smoke flows reach create, edit, upload, slice, queue, and settings APIs', async ({ page }) => {
  const calls: ApiCall[] = [];
  await mockApi(page, calls);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Printers/i })).toBeVisible();

  await page.goto('/inventory');
  await expect(page.getByRole('heading', { name: /Inventory/i })).toBeVisible();

  await page.goto('/archives');
  await expect(page.getByRole('heading', { name: /Archives/i })).toBeVisible();

  await page.goto('/queue');
  await expect(page.getByRole('heading', { name: /Print Queue/i })).toBeVisible();

  await page.evaluate(async () => {
    await fetch('/api/v1/printers/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Printer', ip_address: '192.168.1.51', serial_number: 'SN2', access_code: '12345678', model: 'X1C' }),
    });
    await fetch('/api/v1/printers/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Edited Printer' }),
    });
    await fetch('/api/v1/inventory/spools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filament_type: 'PLA', color_name: 'Blue', label_weight: 1000 }),
    });
    await fetch('/api/v1/inventory/spools/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color_name: 'Green' }),
    });
    const form = new FormData();
    form.append('file', new File(['dummy'], 'benchy.3mf', { type: 'application/octet-stream' }));
    await fetch('/api/v1/archives/upload', { method: 'POST', body: form });
    await fetch('/api/v1/archives/1/slice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printer_preset: 'X1C', process_preset: '0.20mm Standard', filament_presets: ['PLA Basic'] }),
    });
    await fetch('/api/v1/queue/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archive_id: 1, printer_id: 1 }),
    });
    await fetch('/api/v1/queue/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 2 }),
    });
    await fetch('/api/v1/queue/1/cancel', { method: 'POST' });
    await fetch('/api/v1/settings/', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currency: 'GBP', auto_archive: false }),
    });
  });

  for (const expected of [
    ['POST', '/api/v1/printers/'],
    ['PATCH', '/api/v1/printers/1'],
    ['POST', '/api/v1/inventory/spools'],
    ['PATCH', '/api/v1/inventory/spools/1'],
    ['POST', '/api/v1/archives/upload'],
    ['POST', '/api/v1/archives/1/slice'],
    ['POST', '/api/v1/queue/'],
    ['PATCH', '/api/v1/queue/1'],
    ['POST', '/api/v1/queue/1/cancel'],
    ['PUT', '/api/v1/settings/'],
  ] as const) {
    expect(calls.some((call) => call.method === expected[0] && call.path === expected[1])).toBe(true);
  }
});

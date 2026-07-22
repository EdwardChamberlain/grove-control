import { expect, test, type Page } from '@playwright/test';
import { stubWebSocket } from './mockWebSocket';

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
  file_path: 'archives/benchy.3mf',
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

async function mockApi(page: Page, calls: ApiCall[], options: { authEnabled?: boolean; printerState?: string } = {}) {
  const queueItems: Array<Record<string, unknown>> = [
    { id: 1, archive_id: 1, archive_name: 'Benchy', printer_id: 1, printer_name: printer.name, status: 'pending', position: 1 },
  ];

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
      await route.fulfill({ json: {
        id: 1,
        name: printer.name,
        connected: true,
        state: options.printerState ?? 'IDLE',
        current_print: options.printerState === 'RUNNING' ? 'active-print.gcode.3mf' : null,
        progress: 0,
        layer_num: 0,
        total_layers: 0,
        remaining_time: 0,
        awaiting_plate_clear: false,
        temperatures: { nozzle: 25, bed: 25, chamber: 25 },
        ams: [{
          id: 0,
          humidity: 35,
          temp: 25,
          tray: [
            { id: 0, tray_type: 'PLA', tray_color: 'FF0000FF', remain: 85 },
            { id: 1, tray_type: 'PETG', tray_color: '00AEEF', remain: 60 },
            { id: 2, tray_type: 'ABS', tray_color: '1F2937', remain: 40 },
            { id: 3, tray_type: 'PLA', tray_color: 'F5F5F5', remain: 95 },
          ],
        }],
        vt_tray: [],
      } });
    } else if (pathname === '/api/v1/library/files' && method === 'POST') {
      await route.fulfill({ json: { id: 42, filename: 'queued-print.gcode.3mf', metadata: {} } });
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
      const queueBody = (body ?? {}) as Record<string, unknown>;
      const queuedItem = {
        id: queueItems.length + 1,
        archive_id: 1,
        archive_name: 'Benchy',
        printer_id: queueBody.printer_id ?? 1,
        printer_name: printer.name,
        status: 'pending',
        position: queueItems.length + 1,
        ...queueBody,
      };
      queueItems.push(queuedItem);
      await route.fulfill({ json: queuedItem });
    } else if (pathname === '/api/v1/queue/1' && method === 'PATCH') {
      await route.fulfill({ json: { id: 1, archive_id: 1, printer_id: 1, status: 'pending', position: 1, ...(body as object) } });
    } else if (pathname === '/api/v1/queue/1/cancel' && method === 'POST') {
      await route.fulfill({ json: { message: 'Queue item cancelled' } });
    } else if (pathname === '/api/v1/queue/') {
      await route.fulfill({ json: queueItems });
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

test.beforeEach(async ({ page }) => {
  await stubWebSocket(page);
});

test('login smoke flow submits expected payload', async ({ page }) => {
  const calls: ApiCall[] = [];
  await mockApi(page, calls, { authEnabled: true });

  await page.goto('/login');
  await page.getByLabel(/Username/i).fill('admin');
  await page.getByLabel(/Password/i).fill('secret123');
  await page.getByRole('button', { name: /Sign in/i }).click();
  await expect.poll(() => calls.some((call) => call.path === '/api/v1/auth/login')).toBe(true);
});

test('setup smoke flow submits expected payload', async ({ page }) => {
  const calls: ApiCall[] = [];
  await mockApi(page, calls, { authEnabled: false });

  await page.goto('/setup');
  await page.getByLabel(/Enable Authentication/i).check();
  await page.getByLabel(/Admin Username/i).fill('owner');
  await page.getByLabel(/^Admin Password/i).fill('secret123');
  await page.getByLabel(/Confirm Password/i).fill('secret123');
  await page.getByRole('button', { name: /Complete Setup/i }).click();
  await expect.poll(() => calls.some((call) => call.path === '/api/v1/auth/setup')).toBe(true);
});

test('print modal exposes queue-first controls', async ({ page }) => {
  const calls: ApiCall[] = [];
  await mockApi(page, calls);

  await page.goto('/archives');
  await expect(page.getByRole('heading', { name: /Archives/i })).toBeVisible();
  await page.getByRole('button', { name: /^Print$/i }).first().click();

  await expect(page.getByRole('heading', { name: /^Print$/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /Queue options/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /^(ASAP|Queue|Schedule)$/i })).toHaveCount(0);

  await page.getByRole('button', { name: /Queue options/i }).click();
  await expect(page.getByRole('checkbox', { name: /Require manual start/i })).toBeVisible();
  await expect(page.getByText(/Power off printer when done/i)).toHaveCount(0);

  await page.locator('label', { hasText: 'Require manual start' }).click();
  await expect(page.getByRole('checkbox', { name: /Require manual start/i })).toBeChecked();
  await page.getByRole('button', { name: /^Print$/i }).last().click();

  await expect.poll(() => calls.some((call) => call.method === 'POST' && call.path === '/api/v1/queue/')).toBe(true);
  const queueCall = calls.find((call) => call.method === 'POST' && call.path === '/api/v1/queue/');
  expect(queueCall?.body).toMatchObject({ manual_start: true });
  expect(queueCall?.body).not.toHaveProperty('scheduled_time');
});

test('postponed print submits its UTC start time and is shown as scheduled in the queue', async ({ page }) => {
  const calls: ApiCall[] = [];
  await mockApi(page, calls);

  await page.goto('/archives');
  await page.getByRole('button', { name: /^Print$/i }).first().click();
  await page.getByRole('button', { name: /Queue options/i }).click();
  await page.locator('label', { hasText: 'Postpone print' }).click();
  await expect(page.getByRole('checkbox', { name: /Postpone print/i })).toBeChecked();
  await page.getByLabel(/Do not start before/i).fill('12/31/2099');
  await page.getByLabel(/Postpone time/i).fill('09:30');
  await page.getByRole('button', { name: /^Print$/i }).last().click();

  await expect.poll(() => calls.some((call) => call.method === 'POST' && call.path === '/api/v1/queue/')).toBe(true);
  const queueCall = calls.find((call) => call.method === 'POST' && call.path === '/api/v1/queue/');
  expect(queueCall?.body).toMatchObject({ scheduled_time: '2099-12-31T09:30:00.000Z' });

  await page.goto('/queue');
  await expect(page.getByText(/Scheduled · Dec 31, 2099, 09:30 AM/)).toBeVisible();
});

test('invalid postponed dates cannot create a queue item', async ({ page }) => {
  const calls: ApiCall[] = [];
  await mockApi(page, calls);

  await page.goto('/archives');
  await page.getByRole('button', { name: /^Print$/i }).first().click();
  await page.getByRole('button', { name: /Queue options/i }).click();
  await page.locator('label', { hasText: 'Postpone print' }).click();
  await page.getByLabel(/Do not start before/i).fill('02/31/2099');

  await expect(page.getByText(/Please enter a valid date and time/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Print$/i }).last()).toBeDisabled();
  expect(calls.some((call) => call.method === 'POST' && call.path === '/api/v1/queue/')).toBe(false);
});

test('a running printer accepts a dropped print file for queueing', async ({ page }) => {
  const calls: ApiCall[] = [];
  await mockApi(page, calls, { printerState: 'RUNNING' });

  await page.goto('/');
  const printerCard = page.locator('#printer-card-1');
  await expect(printerCard).toBeVisible();

  await printerCard.evaluate((card) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['gcode'], 'queued-print.gcode.3mf', { type: 'application/octet-stream' }));
    card.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer }));
  });

  await expect.poll(() => calls.some((call) => call.method === 'POST' && call.path === '/api/v1/library/files')).toBe(true);
});

test('core app API smoke reaches create, edit, upload, slice, queue, and settings paths', async ({ page }) => {
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

async function expectCockpitToFitViewport(page: Page) {
  const [layout, detailGrid, camera, controls, controlsContent, actions, status, currentPrint] = await Promise.all([
    page.getByTestId('cockpit-layout').boundingBox(),
    page.getByTestId('cockpit-detail-grid').boundingBox(),
    page.getByTestId('cockpit-camera-panel').boundingBox(),
    page.getByTestId('cockpit-machine-controls-panel').boundingBox(),
    page.getByTestId('cockpit-machine-controls-content').boundingBox(),
    page.getByTestId('cockpit-actions-panel').boundingBox(),
    page.getByTestId('cockpit-status-pane').boundingBox(),
    page.getByTestId('cockpit-current-print').boundingBox(),
  ]);

  expect(layout).not.toBeNull();
  expect(detailGrid).not.toBeNull();
  expect(camera).not.toBeNull();
  expect(controls).not.toBeNull();
  expect(controlsContent).not.toBeNull();
  expect(actions).not.toBeNull();
  expect(status).not.toBeNull();
  expect(currentPrint).not.toBeNull();

  expect(camera!.width / camera!.height).toBeCloseTo(16 / 9, 2);
  expect(camera!.width).toBeCloseTo(controls!.width, 1);
  expect(Math.abs(controls!.height - controlsContent!.height)).toBeLessThanOrEqual(1);
  const controlsMinimumHeight = await page.getByTestId('cockpit-detail-grid').evaluate((grid) => {
    const styles = getComputedStyle(grid);
    return (grid.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom)) * 0.3;
  });
  expect(controls!.height).toBeGreaterThanOrEqual(controlsMinimumHeight - 1);
  const amsHeader = await page.getByTestId('cockpit-ams-header-0').boundingBox();
  expect(amsHeader).not.toBeNull();
  // The compact AMS card has a 15rem intrinsic width for its header controls
  // and four tray slots; it must never be clipped by the status column.
  expect(amsHeader!.width).toBeGreaterThanOrEqual(15 * 16 - 24);
  const cameraControlsGap = await page.getByTestId('cockpit-camera-panel').evaluate((cameraPanel) => (
    parseFloat(getComputedStyle(cameraPanel.parentElement!).rowGap)
  ));
  expect(Math.abs((controls!.y - (camera!.y + camera!.height)) - cameraControlsGap)).toBeLessThanOrEqual(1);
  expect(currentPrint!.y + currentPrint!.height).toBeLessThanOrEqual(camera!.y + camera!.height - 16);
  expect(controls!.y + controls!.height).toBeLessThanOrEqual(layout!.y + layout!.height + 1);
  expect(actions!.x).toBeGreaterThanOrEqual(controls!.x + controls!.width - 1);
  expect(actions!.y + actions!.height).toBeLessThanOrEqual(status!.y + 1);
  expect(status!.y + status!.height).toBeLessThanOrEqual(layout!.y + layout!.height + 1);
  await expect(page.getByTestId('cockpit-status-pane')).toHaveCSS('overflow-y', 'auto');

  const fixedPanelHeights = await page.locator('[data-testid="cockpit-machine-controls-panel"], [data-testid="cockpit-actions-panel"]').evaluateAll((panels) => panels.map((panel) => ({
    clientHeight: panel.clientHeight,
    scrollHeight: panel.scrollHeight,
  })));
  for (const panel of fixedPanelHeights) {
    expect(panel.scrollHeight).toBeLessThanOrEqual(panel.clientHeight + 1);
  }

  const documentSize = await page.evaluate(() => ({
    clientHeight: document.scrollingElement?.clientHeight ?? 0,
    scrollHeight: document.scrollingElement?.scrollHeight ?? 0,
  }));
  expect(documentSize.scrollHeight).toBeLessThanOrEqual(documentSize.clientHeight + 1);
}

for (const viewport of [
  { width: 1024, height: 768 },
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
]) {
  test(`cockpit keeps fixed controls inside the viewport at ${viewport.width}x${viewport.height} through sidebar collapse`, async ({ page }, testInfo) => {
    const calls: ApiCall[] = [];
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      localStorage.setItem('printerViewMode', 'single');
      localStorage.setItem('singlePrinterViewId', '1');
    });
    await mockApi(page, calls, { printerState: 'RUNNING' });
    await page.goto('/');

    await expect(page.getByTestId('cockpit-layout')).toBeVisible();
    await expect(page.getByTestId('cockpit-ams-header-0')).toBeVisible();
    await expectCockpitToFitViewport(page);
    await page.getByTestId('cockpit-layout').screenshot({
      path: testInfo.outputPath(`cockpit-${viewport.width}x${viewport.height}-expanded.png`),
    });

    const collapseSidebar = page.getByTitle('Collapse sidebar');
    if (await collapseSidebar.count()) {
      await collapseSidebar.click();
      await page.waitForTimeout(150);
      await expect(page.getByTitle('Expand sidebar')).toBeVisible();
      await expectCockpitToFitViewport(page);
      await page.getByTestId('cockpit-layout').screenshot({
        path: testInfo.outputPath(`cockpit-${viewport.width}x${viewport.height}-collapsed.png`),
      });
    }
  });
}

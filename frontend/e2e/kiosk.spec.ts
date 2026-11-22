import { expect, test, type Page } from '@playwright/test';
import { stubWebSocket } from './mockWebSocket';

const printers = Array.from({ length: 9 }, (_, index) => ({
  id: index + 1,
  name: `Printer ${index + 1}`,
  model: index % 2 === 0 ? 'X1 Carbon' : 'P1S',
  is_active: true,
}));

const queue = [
  ...Array.from({ length: 8 }, (_, index) => ({
    id: index + 1,
    printer_id: index + 1,
    archive_id: index + 1,
    archive_name: `Printing job ${index + 1}`,
    printer_name: `Printer ${index + 1}`,
    position: index + 1,
    status: 'printing',
    created_by_username: `Operator ${index + 1}`,
    print_time_seconds: 3_600,
  })),
  ...Array.from({ length: 14 }, (_, index) => ({
    id: index + 101,
    printer_id: null,
    archive_id: index + 101,
    archive_name: `Queued job ${index + 1}`,
    printer_name: null,
    position: index + 1,
    status: 'pending',
    created_by_username: `Operator ${index + 1}`,
    print_time_seconds: 3_600,
    scheduled_time: index === 0 ? '2099-01-01T09:30:00Z' : null,
    waiting_reason: index === 1 ? 'Waiting for compatible material' : null,
  })),
];

async function mockKioskApi(page: Page) {
  await page.route('**/*', async (route) => {
    const { pathname } = new URL(route.request().url());
    const statusMatch = pathname.match(/^\/api\/v1\/printers\/(\d+)\/status$/);

    if (!pathname.startsWith('/api/v1/')) {
      await route.continue();
      return;
    }

    if (pathname === '/api/v1/auth/status') {
      await route.fulfill({ json: { auth_enabled: false, requires_setup: false } });
    } else if (pathname === '/api/v1/settings/') {
      await route.fulfill({ json: { time_format: '24h', require_plate_clear: true } });
    } else if (pathname === '/api/v1/inventory/colors/map') {
      await route.fulfill({ json: { colors: {} } });
    } else if (pathname === '/api/v1/printers/') {
      await route.fulfill({ json: printers });
    } else if (pathname === '/api/v1/queue/') {
      await route.fulfill({ json: queue });
    } else if (statusMatch) {
      const printerId = Number(statusMatch[1]);
      await route.fulfill({
        json: {
          id: printerId,
          name: `Printer ${printerId}`,
          connected: true,
          state: printerId <= 8 ? 'RUNNING' : 'IDLE',
          current_print: printerId <= 8 ? `Printing job ${printerId}` : null,
          progress: printerId <= 8 ? 50 : 0,
          remaining_time: printerId <= 8 ? 60 : 0,
          awaiting_plate_clear: false,
        },
      });
    } else if (pathname.endsWith('/current-print-user')) {
      await route.fulfill({ json: {} });
    } else {
      await route.fulfill({ json: {} });
    }
  });
}

test('keeps the job list within the kiosk viewport at 1080p', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await stubWebSocket(page);
  await mockKioskApi(page);
  await page.goto('/kiosk');

  // One list of shared job lines: no Printers strip and no separate Active jobs section.
  await expect(page.getByTestId('kiosk-stats')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Printers' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Active jobs' })).toHaveCount(0);
  await expect(page.getByTestId('kiosk-job-job-1')).toContainText('Printing job 1');
  await expect(page.getByTestId('kiosk-job-job-101')).toContainText('Scheduled');
  await expect(page.getByTestId('kiosk-job-job-102')).toContainText('Waiting for compatible material');
  await expect(page.getByTestId('kiosk-idle-printer-9')).toBeVisible();
  await expect(page.getByTestId('kiosk-job-overflow')).toContainText(/^\+\d+ Jobs$/);

  const pageBounds = await page.getByTestId('kiosk-page').boundingBox();
  const jobsBounds = await page.getByTestId('kiosk-jobs').boundingBox();
  const footerBounds = await page.getByTestId('kiosk-idle-printers').boundingBox();

  expect(pageBounds).not.toBeNull();
  expect(jobsBounds).not.toBeNull();
  expect(footerBounds).not.toBeNull();
  expect(jobsBounds!.y + jobsBounds!.height).toBeLessThanOrEqual(footerBounds!.y);
  expect(footerBounds!.y + footerBounds!.height).toBeLessThanOrEqual(pageBounds!.y + pageBounds!.height);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(1080);

  const hiddenItemCount = await page.getByTestId('kiosk-job-list').evaluate((element) => {
    const bottom = element.getBoundingClientRect().bottom;
    return Array.from(element.children).filter((item) => item.getBoundingClientRect().bottom > bottom + 1).length;
  });

  expect(hiddenItemCount).toBeGreaterThan(0);
  await expect(page.getByTestId('kiosk-job-overflow')).toHaveText(`+${hiddenItemCount} Jobs`);
});

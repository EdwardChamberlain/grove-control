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

test('keeps queue truncation within the kiosk viewport at 1080p', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await stubWebSocket(page);
  await mockKioskApi(page);
  await page.goto('/kiosk');

  await expect(page.getByRole('heading', { name: 'Printers' })).toBeVisible();
  await expect(page.getByText(/Scheduled · Jan 1, 2099/)).toBeVisible();
  await expect(page.getByText('Waiting · Waiting for compatible material')).toBeVisible();
  await expect(page.getByTestId('kiosk-pending-section-overflow')).toContainText(/^\+\d+ Jobs$/);

  const pageBounds = await page.getByTestId('kiosk-page').boundingBox();
  const fleetBounds = await page.getByTestId('kiosk-fleet-grid').boundingBox();
  const fourthPrinterBounds = await page.getByTestId('kiosk-printer-4').boundingBox();
  const fleetFadeBounds = await page.getByTestId('kiosk-fleet-overflow').boundingBox();
  const queueBounds = await page.getByTestId('kiosk-queue-area').boundingBox();
  const printingBounds = await page.getByTestId('kiosk-printing-section').boundingBox();
  const pendingBounds = await page.getByTestId('kiosk-pending-section').boundingBox();

  expect(pageBounds).not.toBeNull();
  expect(fleetBounds).not.toBeNull();
  expect(fourthPrinterBounds).not.toBeNull();
  expect(fleetFadeBounds).not.toBeNull();
  expect(queueBounds).not.toBeNull();
  expect(printingBounds).not.toBeNull();
  expect(pendingBounds).not.toBeNull();

  const visibleFourthPrinterWidth = fleetBounds!.x + fleetBounds!.width - fourthPrinterBounds!.x;
  expect(visibleFourthPrinterWidth / fourthPrinterBounds!.width).toBeGreaterThan(0.2);
  expect(visibleFourthPrinterWidth / fourthPrinterBounds!.width).toBeLessThan(0.3);
  expect(fleetFadeBounds!.x + fleetFadeBounds!.width).toBeCloseTo(fleetBounds!.x + fleetBounds!.width, 1);

  expect(queueBounds!.y + queueBounds!.height).toBeLessThanOrEqual(pageBounds!.y + pageBounds!.height);
  expect(printingBounds!.y + printingBounds!.height).toBeLessThanOrEqual(queueBounds!.y + queueBounds!.height);
  expect(pendingBounds!.y + pendingBounds!.height).toBeLessThanOrEqual(queueBounds!.y + queueBounds!.height);

  const pendingList = page.getByTestId('kiosk-pending-section-list');
  const hiddenItemCount = await pendingList.evaluate((element) => {
    const bottom = element.getBoundingClientRect().bottom;
    return Array.from(element.children).filter((item) => item.getBoundingClientRect().bottom > bottom + 1).length;
  });

  expect(hiddenItemCount).toBeGreaterThan(0);
  await expect(page.getByTestId('kiosk-pending-section-overflow')).toHaveText(`+${hiddenItemCount} Jobs`);
});

import { expect, test, type Page } from '@playwright/test';
import { stubWebSocket } from './mockWebSocket';

async function mockApi(page: Page, options: { updateBanner: boolean }) {
  await page.route('**/api/v1/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    let json: unknown = [];
    if (pathname.endsWith('/auth/status')) json = { auth_enabled: false, requires_setup: false };
    else if (pathname.endsWith('/settings/')) json = { currency: 'USD', time_format: 'system', date_format: 'system' };
    else if (pathname.endsWith('/updates/check')) {
      json = options.updateBanner
        ? { update_available: true, current_version: '1.0.0', latest_version: '9.9.9' }
        : { update_available: false };
    }
    await route.fulfill({ json });
  });
}

// The page must end at the bottom of the viewport: no dead space below it and no
// page-level scroll, with or without a banner above it. The sidebar becomes a left
// rail (no top bar) at 1144px; below that a 3.5rem top bar takes its place.
const viewports = [
  { name: 'desktop with side rail', width: 1440, height: 900 },
  { name: 'just above the compact breakpoint', width: 1144, height: 800 },
  { name: 'compact top bar, lg two-pane', width: 1100, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
];

for (const updateBanner of [false, true]) {
  for (const { name, width, height } of viewports) {
    test(`Files page fills the viewport height - ${name}${updateBanner ? ' with update banner' : ''}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await stubWebSocket(page);
      await mockApi(page, { updateBanner });
      await page.goto('/files');
      await expect(page.getByRole('heading', { name: 'File Manager' })).toBeVisible();
      if (updateBanner) await expect(page.getByText(/9\.9\.9 is available/)).toBeVisible();

      const { bottom, scrollHeight } = await page.evaluate(() => {
        const pageRoot = document.querySelector('main > div:last-child') as HTMLElement;
        return {
          bottom: Math.round(pageRoot.getBoundingClientRect().bottom),
          scrollHeight: document.documentElement.scrollHeight,
        };
      });
      expect(bottom).toBe(height);
      expect(scrollHeight).toBe(height);
    });
  }
}

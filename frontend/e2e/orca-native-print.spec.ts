import { expect, test } from '@playwright/test';
import { stubWebSocket } from './mockWebSocket';

declare global {
  interface Window {
    orcaDeliver: (message: Record<string, unknown>) => void;
    orcaMessages: Array<Record<string, unknown>>;
  }
}

test('native Orca Print opens with IIS framing headers and cancels without a queue POST', async ({ page }) => {
  const writes: string[] = [];
  await stubWebSocket(page);
  await page.route('**/integrations/orca?**', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        'X-Frame-Options': 'SAMEORIGIN',
        'Content-Security-Policy': "frame-ancestors 'none'",
      },
    });
  });
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') writes.push(path);
    let json: unknown = [];
    if (path === '/api/v1/auth/status') {
      json = { auth_enabled: true, requires_setup: false };
    } else if (path === '/api/v1/auth/me') {
      json = { id: 7, username: 'operator', is_active: true, is_admin: true, permissions: ['*'], groups: [] };
    } else if (path === '/api/v1/library/files/42') {
      json = { id: 42, filename: 'orca-part.gcode.3mf', created_by_id: 7, metadata: {} };
    } else if (path === '/api/v1/library/files/42/plates') {
      json = { file_id: 42, is_multi_plate: false, plates: [{ index: 1, name: 'Plate 1' }] };
    } else if (path.endsWith('/filament-requirements')) {
      json = { filaments: [] };
    } else if (path === '/api/v1/settings/') {
      json = {};
    } else if (path.includes('/colors/')) {
      json = { colors: {} };
    }
    await route.fulfill({ json });
  });
  await page.addInitScript(() => {
    sessionStorage.setItem('auth_token', 'header.payload.signature');
    const handlers: Array<(payload: unknown) => void> = [];
    const messages: Array<Record<string, unknown>> = [];
    const deliver = (fields: Record<string, unknown>) => {
      const payload = { protocol_version: 1, request_id: 'browser-print', ...fields };
      handlers.forEach((handler) => handler(payload));
    };
    Object.assign(window, { orcaMessages: messages, orcaDeliver: deliver });
    window.orca = {
      onMessage: (handler) => { handlers.push(handler); },
      postMessage: (message) => {
        messages.push(message);
        if (message.type !== 'ready') return;
        queueMicrotask(() => deliver(message.mode === 'connect'
          ? { type: 'initialize', mode: 'connect' }
          : { type: 'initialize', mode: 'print', expected_user_id: 7, library_file_id: 42, filename: 'orca-part.gcode.3mf' }));
      },
    };
  });

  const response = await page.goto('/integrations/orca?mode=print&transport=native&protocol_version=1&request_id=browser-print');
  expect(response?.headers()['x-frame-options']).toBe('SAMEORIGIN');
  expect(response?.headers()['content-security-policy']).toBe("frame-ancestors 'none'");
  await expect(page.getByRole('heading', { name: 'Print', exact: true })).toBeVisible();
  await expect(page.getByText('orca-part.gcode.3mf', { exact: true })).toBeVisible();
  expect(page.frames()).toHaveLength(1);
  await page.evaluate(() => {
    window.orcaDeliver({ type: 'cancel_requested' });
  });
  await expect(page.getByText('Print request cancelled. The uploaded file remains in File Manager.')).toBeVisible();
  const terminal = await page.evaluate(() => {
    return window.orcaMessages.filter((message) => message.type === 'cancelled');
  });
  expect(terminal).toEqual([{
    type: 'cancelled', protocol_version: 1, request_id: 'browser-print',
    user_id: 7, library_file_id: 42, queue_item_ids: [], access_token: 'header.payload.signature',
  }]);
  expect(writes).toEqual([]);
});

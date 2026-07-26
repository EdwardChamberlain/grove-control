import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './screenshot-generation',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4174',
    browserName: 'chromium',
    colorScheme: 'dark',
    deviceScaleFactor: 2,
    locale: 'en-GB',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    timezoneId: 'UTC',
    viewport: { width: 1512, height: 857 },
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4174',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

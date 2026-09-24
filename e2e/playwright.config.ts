import { defineConfig } from '@playwright/test';
import { BASE_URL, WORKERS } from './lib/config';

/**
 * SmartProctoring end-to-end suite: real server (from source) + built SPA on one origin, a fresh Postgres
 * database, real vision models, and Chromium with a fake camera fed from Y4M files (see README.md).
 */
export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.ts$/,
  globalSetup: './global-setup.ts',
  // Camera scenarios take minutes of real time (detections need sustained conditions).
  timeout: 6 * 60_000,
  expect: { timeout: 20_000 },
  workers: WORKERS,
  fullyParallel: true,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
});

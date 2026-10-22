import { defineConfig, type Project } from '@playwright/test';
import { CROSS_BROWSER_TAG, FIREFOX_PREFS, selectedBrowsers, type BrowserName } from './lib/browsers';
import { BASE_URL, CHROMIUM_EXECUTABLE, WORKERS } from './lib/config';

/**
 * Projects = browsers (E2E_BROWSERS, default `chromium` only, so a plain run is the Chromium suite). Firefox and
 * WebKit run the scenarios tagged @cross-browser with the camera shim (lib/camera.ts; README "Browsers").
 */
const PROJECTS: Record<BrowserName, Project> = {
  chromium: { name: 'chromium', use: { browserName: 'chromium', launchOptions: { executablePath: CHROMIUM_EXECUTABLE } } },
  firefox: { name: 'firefox', grep: new RegExp(CROSS_BROWSER_TAG), use: { browserName: 'firefox', launchOptions: { firefoxUserPrefs: FIREFOX_PREFS } } },
  webkit: { name: 'webkit', grep: new RegExp(CROSS_BROWSER_TAG), use: { browserName: 'webkit' } },
};

/**
 * SmartProctoring end-to-end suite: real server (from source) + built SPA on one origin, a fresh Postgres
 * database, real vision models, and browsers with a fake camera fed from Y4M files (see README.md).
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
  projects: selectedBrowsers().map((b) => PROJECTS[b]),
});

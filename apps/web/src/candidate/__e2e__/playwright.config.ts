import { defineConfig } from '@playwright/test';

/**
 * Candidate end-to-end tests (real Chromium + fake camera + real server + real vision models).
 *
 * Prerequisites:
 *   - server:  DATABASE_URL=… PORT=8091 PUBLIC_URL=http://localhost:5174 BOOTSTRAP_ADMIN_EMAIL=owner@example.com
 *              BOOTSTRAP_ADMIN_PASSWORD=owner-password-123 pnpm --filter @sp/server dev
 *   - web:     API_URL=http://127.0.0.1:8091 pnpm --filter @sp/web exec vite --port 5174
 *              (or a production build: vite build && vite preview --port … ; set SP_BASE_URL accordingly)
 *   - fake camera videos (Y4M, 640×480, 5 fps) built with e2e/scripts/make-y4m.ts from face images:
 *       SP_Y4M_OBAMA  person A, frontal, ~20 s (loops)
 *       SP_Y4M_SWAP   person A 90 s → empty room 6 s → a different, frontal person B 120 s
 *       SP_Y4M_ENV    person A 45 s → the same person A shifted/smaller 90 s (moved seat)
 *   - SP_ADMIN_EMAIL / SP_ADMIN_PASSWORD: staff login used to create exams/sessions and verify timelines.
 *     (flow/liveness/offline/swap can instead use pre-created links: SP_LINK_<KEY>, SP_SESSION_<KEY>.)
 * Run:  PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers pnpm --filter @sp/web exec playwright test -c src/candidate/__e2e__/playwright.config.ts
 * The Vite HMR socket is stubbed in the test browser (SP_KEEP_HMR=1 to disable) so concurrent edits do not reload pages.
 */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.pw\.ts$/,
  timeout: 8 * 60_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: env.SP_E2E_OUTPUT ?? 'test-results',
  use: {
    baseURL: env.SP_BASE_URL ?? 'http://localhost:5174',
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 30_000,
  },
});

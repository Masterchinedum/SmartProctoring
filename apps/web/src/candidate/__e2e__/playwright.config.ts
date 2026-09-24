import { defineConfig } from '@playwright/test';

/**
 * Candidate end-to-end tests (real Chromium + fake camera + real server + real vision models).
 *
 * Prerequisites (see run-candidate-e2e.md next to this file):
 *   - server:  DATABASE_URL=… PORT=8091 PUBLIC_URL=http://localhost:5174 BOOTSTRAP_ADMIN_EMAIL=… BOOTSTRAP_ADMIN_PASSWORD=… pnpm --filter @sp/server dev
 *   - web:     API_URL=http://127.0.0.1:8091 pnpm --filter @sp/web exec vite --port 5174
 *   - fake camera videos (Y4M) built with e2e/scripts/make-y4m.ts; paths via SP_Y4M_* env vars.
 * Run:  pnpm --filter @sp/web exec playwright test -c src/candidate/__e2e__/playwright.config.ts
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

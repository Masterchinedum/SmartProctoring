import { test as base, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPEN_CANDIDATE_PAGES } from './candidate';
import { ARTIFACTS_DIR, BASE_URL, EXTERNAL_SERVER } from './config';
import { StaffApi } from './staff-api';

/** The main server's log (global setup); per-run copies are kept by global setup (server-<run>.log). */
export const SERVER_LOG = join(ARTIFACTS_DIR, 'server.log');

function fileSize(f: string): number {
  try {
    return statSync(f).size;
  } catch {
    return 0;
  }
}

function readSlice(f: string, from: number, to: number): string {
  if (!existsSync(f) || to <= from) return '';
  const fd = openSync(f, 'r');
  try {
    const len = Math.min(to - from, 32 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, to - len);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Test fixtures:
 *  - `staff`: owner API client, logged in once per worker (the login endpoint allows 10 attempts/min/IP);
 *  - `staffPage(browser?)`: opens the staff app in a new context that reuses that cookie (no UI login);
 *  - `diagnostics` (automatic): when a test fails (or with E2E_KEEP_LOGS=1), attaches the main server's log lines
 *    written during the test (other workers' tests interleave — filter by session id) and every candidate page's
 *    identity API log (check frames / completes / identity samples) and console errors, so failures that depend on
 *    load or timing can be diagnosed after the run.
 */
export const test = base.extend<{ staffPage: (b?: Browser) => Promise<Page>; diagnostics: void }, { staff: StaffApi }>({
  staff: [
    async ({}, use) => {
      const s = await StaffApi.login();
      await use(s);
      await s.dispose();
    },
    { scope: 'worker' },
  ],
  staffPage: async ({ browser, staff }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (b?: Browser) => {
      const ctx = await (b ?? browser).newContext({ baseURL: BASE_URL, viewport: { width: 1400, height: 1000 }, storageState: await staff.storageState() });
      contexts.push(ctx);
      return ctx.newPage();
    });
    for (const c of contexts) await c.close().catch(() => undefined);
  },
  diagnostics: [
    async ({}, use, testInfo) => {
      OPEN_CANDIDATE_PAGES.clear();
      const from = EXTERNAL_SERVER ? 0 : fileSize(SERVER_LOG);
      const startedAt = new Date().toISOString();
      await use();
      const failed = testInfo.status !== testInfo.expectedStatus;
      if (!failed && process.env.E2E_KEEP_LOGS !== '1') return;
      mkdirSync(testInfo.outputDir, { recursive: true });
      if (!EXTERNAL_SERVER) {
        const text = readSlice(SERVER_LOG, from, fileSize(SERVER_LOG));
        const header = `# server log lines written during "${testInfo.title}" (worker ${testInfo.workerIndex}, started ${startedAt}); other workers' tests may interleave\n`;
        const file = testInfo.outputPath('server.log');
        writeFileSync(file, header + text);
        await testInfo.attach('server.log', { path: file, contentType: 'text/plain' });
      }
      let i = 0;
      for (const c of OPEN_CANDIDATE_PAGES) {
        i++;
        const body = [`# candidate page ${i}: identity API answers`, ...c.apiLog, '', '# identity check screen (on change)', ...c.verifyTrace, '', '# console errors / warnings', ...c.logs, '', '# HTTP errors', ...c.httpErrors].join('\n');
        const file = testInfo.outputPath(`candidate-${i}.log`);
        writeFileSync(file, body);
        await testInfo.attach(`candidate-${i}.log`, { path: file, contentType: 'text/plain' });
      }
    },
    { auto: true },
  ],
});

export { expect };

import { test as base, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { BASE_URL } from './config';
import { StaffApi } from './staff-api';

/**
 * Test fixtures:
 *  - `staff`: owner API client, logged in once per worker (the login endpoint allows 10 attempts/min/IP);
 *  - `staffPage(browser?)`: opens the staff app in a new context that reuses that cookie (no UI login).
 */
export const test = base.extend<{ staffPage: (b?: Browser) => Promise<Page> }, { staff: StaffApi }>({
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
});

export { expect };

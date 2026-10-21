import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { base32Decode, totp, totpStep } from '../../apps/server/src/lib/totp';
import { ADMIN_EMAIL, ADMIN_PASSWORD, DATABASE_URL, EXTERNAL_SERVER, PORT } from '../lib/config';
import { SmtpSink } from '../lib/integrations';
import { artifactLog, resetDatabase, siblingDatabaseUrl, startServer, type ServerHandle } from '../lib/server';
import { StaffApi } from '../lib/staff-api';
import { expect, test } from '../lib/test';

/**
 * Scenario 11b — staff two-step sign-in, on a dedicated server instance (the organisation-wide requirement must not
 * affect the other scenarios' organisation), with an SMTP sink for the security emails.
 *  a) An administrator sets it up on the Account page (QR / key, a code from the app, recovery codes shown once),
 *     then signs in with a recovery code ("I don't have my phone") and with a code from the app.
 *  b) The owner requires it for everyone: a reviewer without it is sent to set-up first and can use the staff app only
 *     after; the owner resets the reviewer's two-step sign-in on the Users page, which signs them out and sends them
 *     back to set-up.
 */
test.describe('two-step sign-in', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(EXTERNAL_SERVER, 'starts its own server instance from this repository (not with E2E_BASE_URL)');

  const port = PORT + 3;
  const databaseUrl = siblingDatabaseUrl(DATABASE_URL, 'mfa');
  let storageDir = '';
  let server: ServerHandle;
  let smtp: SmtpSink;
  let staff: StaffApi;

  test.beforeAll(async () => {
    test.setTimeout(3 * 60_000);
    smtp = await SmtpSink.start();
    await resetDatabase(databaseUrl);
    storageDir = mkdtempSync(join(tmpdir(), 'sp-e2e-mfa-storage-'));
    server = await startServer({
      port,
      publicHost: '127.0.0.1',
      databaseUrl,
      storageDir,
      logFile: artifactLog('server-mfa.log'),
      env: { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'false', SMTP_FROM: 'SmartProctoring <security@e2e.example>', VISION_THREADS: '1' },
    });
    staff = await StaffApi.login(ADMIN_EMAIL, ADMIN_PASSWORD, server.url);
  });

  test.afterAll(async () => {
    await staff?.dispose().catch(() => undefined);
    await server?.stop();
    await smtp?.close();
    if (storageDir) rmSync(storageDir, { recursive: true, force: true });
  });

  const openStaff = async (browser: Browser) => (await browser.newContext({ baseURL: server.url, viewport: { width: 1400, height: 1000 } })).newPage();

  async function passwordStep(page: Page, email: string, password: string) {
    await page.goto('/admin/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }

  /** A code for a time step after `usedStep` (each step's code works once): waits for the next step if needed. */
  async function freshCode(secret: Buffer, usedStep: number): Promise<{ code: string; step: number }> {
    while (totpStep(Date.now()) <= usedStep) await new Promise((r) => setTimeout(r, 500));
    return { code: totp(secret, Date.now()), step: totpStep(Date.now()) };
  }

  /** The set-up wizard (Account page or the enrolment gate): key → code → recovery codes. */
  async function completeSetup(page: Page): Promise<{ secret: Buffer; step: number; codes: string[] }> {
    await page.getByTestId('mfa-setup-begin').click();
    await expect(page.getByRole('img', { name: /QR code for SmartProctoring/ })).toBeVisible();
    const secret = base32Decode((await page.getByTestId('mfa-secret').innerText()).replace(/\s/g, ''));
    const step = totpStep(Date.now());
    await page.getByTestId('mfa-code').fill(totp(secret, Date.now()));
    await page.getByTestId('mfa-confirm').click();
    await expect(page.getByTestId('recovery-codes')).toBeVisible();
    const codes = (await page.locator('.recovery-codes li').allInnerTexts()).map((c) => c.trim());
    expect(codes).toHaveLength(10);
    await expect(page.getByTestId('codes-done')).toBeDisabled();
    await page.getByTestId('codes-saved').check();
    await page.getByTestId('codes-done').click();
    return { secret, step, codes };
  }

  test('an administrator sets it up and signs in with a recovery code and with the app', async ({ browser }) => {
    const admin = await staff.createUser('admin');
    const page = await openStaff(browser);
    await passwordStep(page, admin.email, admin.password);
    await expect(page.getByRole('heading', { name: 'Live', exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Account & security' }).click();
    const section = page.getByTestId('two-step');
    await expect(section).toContainText('Off');
    await page.getByTestId('two-step-enable').click();
    const { secret, step, codes } = await completeSetup(page);
    await expect(section).toContainText('On');
    await expect(section).toContainText('10 unused recovery codes left');
    await expect.poll(() => smtp.messages.some((m) => m.to.includes(admin.email) && /Two-step sign-in was turned on/.test(m.subject)), { timeout: 15_000 }).toBe(true);

    /* ---------------- sign in with a recovery code */
    await page.getByRole('button', { name: 'Sign out' }).click();
    await passwordStep(page, admin.email, admin.password);
    await expect(page.getByTestId('login-mfa')).toBeVisible();
    await page.getByRole('button', { name: /use a recovery code/ }).click();
    await page.getByLabel('Recovery code').fill(codes[0]);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Live', exact: true })).toBeVisible();
    await page.goto('/admin/account');
    await expect(page.getByTestId('two-step')).toContainText('9 unused recovery codes left');

    /* ---------------- sign in with the app (a wrong code first) */
    await page.getByRole('button', { name: 'Sign out' }).click();
    await passwordStep(page, admin.email, admin.password);
    await page.getByTestId('login-code').fill('000000');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('That code is not right');
    const { code } = await freshCode(secret, step);
    await page.getByTestId('login-code').fill(code);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Live', exact: true })).toBeVisible();
    await page.context().close();
  });

  test('when required, staff without it set it up first; the owner can reset it', async ({ browser }) => {
    test.setTimeout(3 * 60_000);
    // The owner turns it on for themselves (API), then requires it for everyone.
    const setup = await staff.json<{ secret: string }>('post', '/api/auth/mfa/totp/setup', {});
    const ownerSecret = base32Decode(setup.secret);
    await staff.json('post', '/api/auth/mfa/totp/confirm', { code: totp(ownerSecret, Date.now()) });
    const reviewer = await staff.createUser('reviewer');
    expect((await staff.json<{ requireMfa: string }>('put', '/api/admin/settings', { requireMfa: 'everyone' })).requireMfa).toBe('everyone');

    const page = await openStaff(browser);
    await passwordStep(page, reviewer.email, reviewer.password);
    const gate = page.getByTestId('mfa-gate');
    await expect(gate).toContainText('requires two-step sign-in for your account');
    // Nothing else is available meanwhile.
    expect((await page.request.get('/api/admin/sessions')).status()).toBe(403);
    await completeSetup(page);
    await expect(page.getByRole('heading', { name: 'Live', exact: true })).toBeVisible();

    /* ---------------- the owner resets it on the Users page */
    const ownerPage = await (await browser.newContext({ baseURL: server.url, viewport: { width: 1400, height: 1000 }, storageState: await staff.storageState() })).newPage();
    await ownerPage.goto('/admin/users');
    const row = ownerPage.getByRole('row', { name: new RegExp(reviewer.email.replace(/[.+]/g, '\\$&')) });
    await expect(row).toContainText('On');
    await row.getByRole('button', { name: 'Reset two-step sign-in' }).click();
    await ownerPage.getByRole('dialog').getByRole('button', { name: 'Reset two-step sign-in' }).click();
    await expect(row).toContainText('Off');
    await expect.poll(() => smtp.messages.some((m) => m.to.includes(reviewer.email) && /Two-step sign-in was reset/.test(m.subject) && m.text.includes(`${staff.user.name} reset it`)), { timeout: 15_000 }).toBe(true);

    // The reviewer was signed out; at the next sign-in they set it up again.
    await page.goto('/admin/sessions');
    await expect(page.getByLabel('Email')).toBeVisible({ timeout: 15_000 });
    await passwordStep(page, reviewer.email, reviewer.password);
    await expect(page.getByTestId('mfa-gate')).toBeVisible();

    await staff.json('put', '/api/admin/settings', { requireMfa: 'off' });
    await page.context().close();
    await ownerPage.context().close();
  });
});

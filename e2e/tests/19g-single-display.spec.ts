import type { Browser } from '@playwright/test';
import { expectNoA11yIssues } from '../lib/a11y';
import { cameraPermissions } from '../lib/camera';
import { CandidatePage, launchCamera, skipUnlessFixtures } from '../lib/candidate';
import { BASE_URL } from '../lib/config';
import { expect, test } from '../lib/test';

/**
 * Scenario 19g — the per-exam "Require a single display" rule (policy.browser.requireSingleDisplay). Chromium only:
 * the browser reports displays through the Window Management API (`screen.isExtended` and a `change` event on
 * `window.screen`); an init script fakes them so the test can connect and disconnect a display.
 *
 *  a) rule on: the welcome screen lists the rule and its system check warns about the second display; the ready screen
 *     keeps "Start exam" disabled until the display is disconnected (no reload); a display connected mid-exam puts the
 *     exam on hold with a plain message, and the hold screen shows when it is disconnected; staff see the reason on the
 *     session page and release the hold without a new check; the exam continues;
 *  b) a browser that cannot tell (`isExtended` undefined, as in Firefox and Safari): the system check says the display
 *     check is not available and recommends Chrome or Edge;
 *  c) rule off: today's behaviour — a warning on the welcome check, a neutral event mid-exam, no hold.
 */

/** Init script: `screen.isExtended` (null = the browser cannot tell) and `__spSetDisplays(v)` to change it like a cable. */
const fakeDisplays = (initial: boolean | null) => `(() => {
  let extended = ${JSON.stringify(initial)};
  Object.defineProperty(Screen.prototype, 'isExtended', { configurable: true, get: () => (extended === null ? undefined : extended) });
  if (!('onchange' in Screen.prototype)) Object.defineProperty(Screen.prototype, 'onchange', { configurable: true, writable: true, value: null });
  window.__spSetDisplays = (v) => {
    extended = v;
    window.screen.dispatchEvent(new Event('change'));
  };
})();`;

async function openWithDisplays(browser: Browser, link: string, initial: boolean | null): Promise<CandidatePage> {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1280, height: 900 }, ...cameraPermissions() });
  await context.addInitScript(fakeDisplays(initial));
  return CandidatePage.open(null, link, { context });
}

const setDisplays = (c: CandidatePage, extended: boolean) => c.page.evaluate((v) => (window as unknown as { __spSetDisplays: (x: boolean) => void }).__spSetDisplays(v), extended);
const displayItem = (c: CandidatePage) => c.page.locator('[data-testid="requirements"] [data-item="single_display"]');

test('single display required: start blocked until the display is disconnected, a display connected mid-exam holds the exam, staff release it', async ({ staff, staffPage }) => {
  skipUnlessFixtures('a');
  const s = await staff.createSession({ policy: { browser: { requireSingleDisplay: true } } });
  const browser = await launchCamera('a');
  try {
    const c = await openWithDisplays(browser, s.link, true);

    /* ---------------- welcome: the rule, and a warning (consent and the check-in are not blocked) */
    await expect(c.tid('rule-single-display')).toHaveText('One display only');
    await expect(displayItem(c)).toHaveClass(/warn/);
    await expect(displayItem(c)).toContainText('This exam allows only one display: disconnect any additional displays before you start the exam.');
    await c.consent();
    expect(await c.runCheck(), 'initial check outcome').toBe('ready');

    /* ---------------- ready: "Start exam" stays disabled while two displays are connected */
    await expect(c.tid('ready-screen')).toContainText('Only one display may be connected.');
    await expect(c.tid('single-display-blocked')).toContainText('More than one display is connected.');
    await expect(c.tid('start-exam')).toBeDisabled();
    await expectNoA11yIssues(c.page, 'candidate: ready screen, start blocked by a second display');
    await c.tid('single-display-recheck').click(); // still connected: still blocked
    await expect(c.tid('start-exam')).toBeDisabled();
    await setDisplays(c, false); // unplugged: the page notices without a reload
    await expect(c.tid('single-display-blocked')).toHaveCount(0);
    await c.startExam();
    const started = await staff.waitForEventType(s.sessionId, 'session_started');
    expect(started.details).toMatchObject({ displays: 'single' });

    /* ---------------- a display connected mid-exam: on hold, with a plain message */
    await setDisplays(c, true);
    const hold = c.tid('hold-screen');
    await expect(hold).toBeVisible({ timeout: 30_000 });
    await expect(hold).toHaveAttribute('data-reason', 'additional_display');
    await expect(hold).toContainText('An additional display was connected to your computer, and this exam allows only one display');
    await expect(hold).toContainText('The exam administrator will review this and release the hold.');
    await expect(hold).not.toContainText(/cheat|violation|suspicious|fraud/i);
    await expect(c.tid('hold-displays')).toContainText('More than one display is still connected.');
    await expect.poll(() => c.liveCameraTracks(), { timeout: 10_000, message: 'camera released while on hold' }).toBe(0);
    await setDisplays(c, false);
    await expect(c.tid('hold-displays')).toContainText('Only one display is connected now.');

    const held = await staff.waitForSession(s.sessionId, (d) => d.summary.status === 'on_hold');
    expect(held.summary.hold?.reason).toBe('additional_display');
    const display = await staff.waitForEventType(s.sessionId, 'additional_display_detected');
    expect(display).toMatchObject({ category: 'neutral', severity: 'info' });
    const heldEvent = (await staff.events(s.sessionId)).find((e) => e.type === 'session_held');
    expect(heldEvent?.details).toMatchObject({ reason: 'additional_display', eventId: display.id });

    /* ---------------- staff: the reason on the session page; release without a new check */
    const sp = await staffPage();
    await sp.goto(`/admin/sessions/${s.sessionId}`);
    await expect(sp.getByText('Additional display connected (the exam allows only one)').first()).toBeVisible();
    await sp.getByRole('button', { name: 'Release hold…' }).click();
    const rel = sp.getByRole('dialog', { name: 'Release hold' });
    await expect(rel.getByTestId('release-display-note')).toContainText('if more than one display is still connected, the exam is put on hold again');
    await rel.getByLabel('Require a fresh identity check before the candidate continues (recommended)').uncheck();
    await rel.getByRole('button', { name: 'Release hold' }).click();
    await expect(rel).toHaveCount(0);

    /* ---------------- the exam continues (one display: no new hold) */
    await expect(c.tid('exam-screen')).toBeVisible({ timeout: 30_000 });
    await c.expectMonitoringActive();
    await c.page.waitForTimeout(5_000);
    const after = await staff.session(s.sessionId);
    expect(after.summary.status).toBe('active');
    const types = (await staff.events(s.sessionId)).map((e) => e.type);
    expect(types.filter((t) => t === 'session_held')).toHaveLength(1);
    expect(types.filter((t) => t === 'additional_display_detected')).toHaveLength(1);
    expect(types).toContain('hold_released');
    await sp.getByRole('tab', { name: /Devices/ }).click();
    await expect(sp.getByRole('cell', { name: 'More than one' }).first()).toBeVisible(); // what the check-in reported
  } finally {
    await browser.close();
  }
});

test('single display required, browser cannot tell: the system check says so and recommends Chrome or Edge', async ({ staff, browser }) => {
  const s = await staff.createSession({ policy: { browser: { requireSingleDisplay: true } } });
  const c = await openWithDisplays(browser, s.link, null); // the welcome screen only: no camera needed
  try {
    await expect(c.tid('rule-single-display')).toHaveText('One display only');
    await expect(displayItem(c)).toHaveClass(/warn/);
    await expect(displayItem(c)).toContainText('The display check is not available in this browser.');
    await expect(displayItem(c)).toContainText('use Chrome or Edge');
    await expect(c.tid('consent-checkbox')).toBeEnabled(); // not blocked
  } finally {
    await c.close();
  }
});

test('rule off: an additional display is a warning on the welcome check and a neutral event, never a hold', async ({ staff }) => {
  skipUnlessFixtures('a');
  const s = await staff.createSession();
  const browser = await launchCamera('a');
  try {
    const c = await openWithDisplays(browser, s.link, true);
    await expect(c.tid('rule-single-display')).toHaveCount(0);
    await expect(displayItem(c)).toHaveClass(/warn/);
    await expect(displayItem(c)).toContainText('This is recorded for the exam administrator; consider disconnecting additional displays.');
    await setDisplays(c, false);
    await expect(displayItem(c)).toHaveCount(0); // updated without a reload (as before: no item with one display)
    await c.consent();
    expect(await c.runCheck(), 'initial check outcome').toBe('ready');
    await expect(c.tid('single-display-blocked')).toHaveCount(0);
    await c.startExam();
    await setDisplays(c, true);
    await staff.waitForEventType(s.sessionId, 'additional_display_detected');
    await c.page.waitForTimeout(5_000);
    await expect(c.tid('exam-screen')).toBeVisible();
    const d = await staff.session(s.sessionId);
    expect(d.summary.status).toBe('active');
    expect((await staff.events(s.sessionId)).some((e) => e.type === 'session_held')).toBe(false);
  } finally {
    await browser.close();
  }
});

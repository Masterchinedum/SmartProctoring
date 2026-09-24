import type { Page } from '@playwright/test';
import { CandidatePage, launchCamera, skipUnlessFixtures } from '../lib/candidate';
import { expect, test } from '../lib/test';

/**
 * Scenario 8 — exam-page browser events: switching away from the exam tab and leaving required
 * fullscreen. Each episode must become exactly one event with a start and an end.
 *
 * Headless (and even headed) Playwright Chromium keeps every page "visible" and focused when another
 * tab or window is brought to the front, so the tab switch is simulated in the page the way the
 * browser reports it: `blur`, then `visibilitychange` with document.visibilityState = 'hidden', and
 * the reverse on return. Fullscreen is real (Element.requestFullscreen / document.exitFullscreen).
 */
async function switchAway(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    if (h) window.dispatchEvent(new Event('blur'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
    if (!h) window.dispatchEvent(new Event('focus'));
  }, hidden);
}

test('tab hidden and fullscreen exit: one event per episode', async ({ staff }) => {
  skipUnlessFixtures('a');
  const s = await staff.createSession({ policy: { browser: { requireFullscreen: true, flagTabHidden: true, flagWindowBlur: true, windowBlurMinSec: 2 } } });
  const browser = await launchCamera('a');
  try {
    const c = await CandidatePage.open(browser, s.link);
    await c.checkInAndStart();
    const page = c.page;
    expect(await page.evaluate(() => !!document.fullscreenElement), 'exam runs in fullscreen').toBe(true);
    await expect(c.tid('fullscreen-overlay')).toHaveCount(0);

    /* ---------------- two separate tab switches (further apart than the 10 s merge gap) */
    const h1 = Date.now();
    await switchAway(page, true);
    await page.waitForTimeout(4_000);
    await switchAway(page, false);
    const b1 = Date.now();
    await page.waitForTimeout(13_000);
    const h2 = Date.now();
    await switchAway(page, true);
    await page.waitForTimeout(3_000);
    await switchAway(page, false);
    const b2 = Date.now();

    /* ---------------- leave fullscreen, then return via the overlay */
    await page.waitForTimeout(1_000);
    const f1 = Date.now();
    await page.evaluate(() => document.exitFullscreen());
    await expect(c.tid('fullscreen-overlay')).toBeVisible();
    await expect(c.tid('fullscreen-overlay')).toContainText('Leaving fullscreen is recorded');
    await page.waitForTimeout(3_000);
    await c.tid('fullscreen-return').click();
    await expect(c.tid('fullscreen-overlay')).toHaveCount(0);
    const f2 = Date.now();
    expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true);

    /* ---------------- staff: exactly one event per episode, with start/end */
    await expect
      .poll(async () => (await staff.events(s.sessionId)).filter((e) => e.type === 'tab_hidden' && e.status === 'closed').length, { timeout: 30_000 })
      .toBe(2);
    const hiddenEvents = (await staff.events(s.sessionId)).filter((e) => e.type === 'tab_hidden').sort((a, b) => a.startedAt - b.startedAt);
    expect(hiddenEvents).toHaveLength(2);
    const tol = 2_500; // client/server clock offset + event-loop latency
    expect(Math.abs(hiddenEvents[0].startedAt - h1)).toBeLessThan(tol);
    expect(Math.abs(hiddenEvents[0].endedAt! - b1)).toBeLessThan(tol);
    expect(hiddenEvents[0].durationMs!).toBeGreaterThan(3_000);
    expect(hiddenEvents[0].durationMs!).toBeLessThan(6_000);
    expect(Math.abs(hiddenEvents[1].startedAt - h2)).toBeLessThan(tol);
    expect(Math.abs(hiddenEvents[1].endedAt! - b2)).toBeLessThan(tol);
    expect(hiddenEvents[0].category).toBe('integrity');
    expect(hiddenEvents[0].observation).toMatch(/hidden/);
    // The blur that preceded each switch is part of the hidden episode, not a separate event.
    const events = await staff.events(s.sessionId);
    expect(events.filter((e) => e.type === 'window_unfocused')).toHaveLength(0);

    const fs = await staff.waitForEvent(s.sessionId, (e) => e.type === 'fullscreen_exited' && e.status === 'closed', { timeout: 30_000 });
    expect((await staff.events(s.sessionId)).filter((e) => e.type === 'fullscreen_exited')).toHaveLength(1);
    expect(Math.abs(fs.startedAt - f1)).toBeLessThan(tol);
    expect(Math.abs(fs.endedAt! - f2)).toBeLessThan(tol);
    expect(fs.durationMs!).toBeGreaterThan(2_500);
  } finally {
    await browser.close();
  }
});

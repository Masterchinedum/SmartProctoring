import type { Page } from '@playwright/test';
import { CandidatePage, launchCamera, skipUnlessFixtures } from '../lib/candidate';
import { candidateState } from '../lib/staff-api';
import { expect, test } from '../lib/test';

/**
 * Scenario 9 — the connection drops for ~40 s during the exam.
 *  - candidate: "Live reporting is interrupted" banner; the exam keeps working (answers saved locally);
 *  - staff: the dashboard shows the session disconnected with "Reporting interrupted since …" (live);
 *  - back online: what happened during the outage (a tab switch, answers) arrives with its ORIGINAL
 *    timestamps, flagged "delivered late" (> 30 s after it happened), exactly once.
 */
async function switchAway(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test('offline: interruption visible to both sides; buffered events delivered late, once, with original timestamps', async ({ staff, staffPage }) => {
  skipUnlessFixtures('a');
  const s = await staff.createSession({ policy: { connection: { heartbeatTimeoutSec: 10, disconnectTimerBehavior: 'continue' } } });
  const sp = await staffPage();
  await sp.goto('/admin');
  const card = sp.locator(`a.session-card[href="/admin/sessions/${s.sessionId}"]`);

  const browser = await launchCamera('a');
  try {
    const c = await CandidatePage.open(browser, s.link);
    await c.checkInAndStart();
    await c.gotoQuestion(0);
    await c.page.getByRole('radio', { name: 'Mean' }).check();
    await c.page.waitForTimeout(2_000); // answer delivered, a heartbeat or two
    await expect(card).toContainText('Online', { timeout: 20_000 });
    await expect(card.locator('.sc-monitor')).toContainText('1 face');
    const before = await staff.events(s.sessionId);

    /* ---------------- offline */
    await c.context.setOffline(true);
    const offAt = Date.now();
    await expect(c.tid('reporting-banner')).toBeVisible({ timeout: 15_000 });
    await expect(c.tid('reporting-banner')).toContainText('Live reporting is interrupted');
    await expect(c.tid('reporting-banner')).toContainText('saved on this device');

    // Things happen while offline: a tab switch (an event) and more answers.
    const hideAt = Date.now();
    await switchAway(c.page, true);
    await c.page.waitForTimeout(3_000);
    await switchAway(c.page, false);
    const showAt = Date.now();
    await c.tid('next-question').click();
    await c.page.getByRole('checkbox', { name: 'Variance' }).check();
    await c.tid('next-question').click();
    await c.tid('answer-input').fill('gaussian');
    await expect(c.tid('qnav-1')).toHaveClass(/answered/);
    await expect(c.tid('exam-screen')).toBeVisible();

    // Staff side: the server noticed the missing heartbeats; shown live on the dashboard.
    await expect(card).toContainText('Reporting interrupted since', { timeout: 30_000 });
    await expect(card).toContainText('Disconnected');
    const during = await staff.session(s.sessionId);
    expect(during.summary.connection).toBe('offline');
    expect(during.summary.reportingInterruptedSince).not.toBeNull();
    expect(during.summary.status).toBe('active');
    await staff.waitForEventType(s.sessionId, 'reporting_interrupted');
    // Nothing from the outage has reached the server yet.
    expect((await staff.events(s.sessionId)).some((e) => e.type === 'tab_hidden')).toBe(false);

    const wait = 40_000 - (Date.now() - offAt);
    if (wait > 0) await c.page.waitForTimeout(wait);

    /* ---------------- back online */
    await c.context.setOffline(false);
    const onAt = Date.now();
    await expect(c.tid('reporting-banner')).toHaveCount(0, { timeout: 30_000 });
    await expect(card).not.toContainText('Reporting interrupted', { timeout: 30_000 });
    await expect(card).toContainText('Online', { timeout: 30_000 });
    await expect(card.locator('.sc-monitor')).toContainText('1 face');

    const hidden = await staff.waitForEvent(s.sessionId, (e) => e.type === 'tab_hidden' && e.status === 'closed', { timeout: 30_000 });
    expect(Math.abs(hidden.startedAt - hideAt), 'original start time').toBeLessThan(2_500);
    expect(Math.abs(hidden.endedAt! - showAt), 'original end time').toBeLessThan(2_500);
    expect(hidden.receivedAt).toBeGreaterThanOrEqual(onAt - 1_000);
    expect(hidden.deliveredLate).toBe(true);

    const ri = await staff.waitForEvent(s.sessionId, (e) => e.type === 'reporting_interrupted' && e.status === 'closed', { timeout: 30_000 });
    expect(ri.category).toBe('technical');
    expect(ri.startedAt).toBeLessThanOrEqual(offAt + 6_000);
    expect(ri.endedAt!).toBeGreaterThanOrEqual(onAt - 6_000);

    /* ---------------- no duplicates after the outbox retried */
    await c.page.waitForTimeout(8_000);
    const after = await staff.events(s.sessionId);
    const ids = after.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(after.filter((e) => e.type === 'tab_hidden')).toHaveLength(1);
    expect(after.filter((e) => e.type === 'reporting_interrupted')).toHaveLength(1);
    for (const e of before) expect(ids).toContain(e.id);

    /* ---------------- answers typed offline reached the server */
    await c.submit();
    const end = await candidateState(s.token);
    const qs = [...(end.questions ?? [])].sort((a, b) => a.index - b.index);
    const byQ = new Map((end.answers ?? []).map((a) => [a.questionId, a.value] as const));
    expect(byQ.get(qs[0].id)).toBe('b');
    expect(byQ.get(qs[1].id)).toEqual(['a']);
    expect(byQ.get(qs[2].id)).toBe('gaussian');
  } finally {
    await browser.close();
  }
});

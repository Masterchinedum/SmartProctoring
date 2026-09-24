import { CandidatePage, launchCamera, since, skipUnlessFixtures } from '../lib/candidate';
import { candidateState } from '../lib/staff-api';
import { expect, test } from '../lib/test';

/**
 * Scenario 12 — a 1-minute exam: staff add 1 minute in the admin UI (accommodation); the candidate's
 * clock updates without a reload; when the clock reaches zero the server submits automatically and the
 * candidate sees why. Saved answers are graded.
 */
test('time extension updates the candidate clock; expiry auto-submits', async ({ staff, staffPage }) => {
  skipUnlessFixtures('a');
  test.setTimeout(4 * 60_000);
  const s = await staff.createSession({ durationSec: 60 });
  const browser = await launchCamera('a');
  try {
    const c = await CandidatePage.open(browser, s.link);
    await c.checkInAndStart();
    await c.gotoQuestion(0);
    await c.page.getByRole('radio', { name: 'Mean' }).check();
    await c.gotoQuestion(2);
    await c.tid('answer-input').fill('Gaussian');
    const before = await c.countdownMs();
    expect(before).toBeLessThanOrEqual(60_000);
    expect(before).toBeGreaterThan(30_000);

    /* ---------------- staff extend by 1 minute in the admin UI */
    const sp = await staffPage();
    await sp.goto(`/admin/sessions/${s.sessionId}`);
    await sp.getByRole('button', { name: 'Extend time…' }).click();
    const dlg = sp.getByRole('dialog', { name: 'Extend exam time' });
    await dlg.getByLabel('Minutes to add').fill('1');
    await dlg.getByLabel(/Reason/).fill('Accommodation (E2E)');
    await dlg.getByRole('button', { name: 'Add 1 min' }).click();
    await expect(dlg).toHaveCount(0);
    const extendedAt = Date.now();

    // The candidate's countdown jumps up by ~60 s (next heartbeat, <= 5 s) without a reload.
    await expect.poll(() => c.countdownMs(), { timeout: 15_000 }).toBeGreaterThan(before + 40_000);
    const afterExtend = await c.countdownMs();
    expect(afterExtend).toBeLessThanOrEqual(120_000);
    const ext = await staff.waitForEventType(s.sessionId, 'time_extended');
    expect(JSON.stringify(ext.details)).toMatch(/60000|"minutes":1/);

    /* ---------------- expiry: automatic submission */
    await expect(c.tid('ended-screen')).toBeVisible({ timeout: afterExtend + 30_000 });
    console.log(`ended ${since(extendedAt)} after the extension (countdown then ${afterExtend} ms)`);
    // Not before the extended time ran out.
    expect(Date.now() - extendedAt).toBeGreaterThan(afterExtend - 5_000);
    await expect(c.tid('ended-screen')).toContainText('The exam time ran out, and your saved answers were submitted automatically.');

    const d = await staff.waitForSession(s.sessionId, (x) => x.summary.status === 'submitted');
    expect(d.summary.endReason).toBe('time_expired');
    expect(d.score?.points).toBe(2); // Mean (1) + Gaussian (1)
    const types = (await staff.events(s.sessionId)).map((e) => e.type);
    for (const t of ['time_extended', 'session_expired', 'session_submitted']) expect(types).toContain(t);
    const end = await candidateState(s.token);
    expect(end.session.status).toBe('submitted');
    expect(end.session.endReason).toBe('time_expired');
    const report = await staff.report(s.sessionId);
    expect(report.totals.examTimeUsedMs).toBeGreaterThanOrEqual(119_000);
    expect(report.totals.examTimeUsedMs).toBeLessThanOrEqual(121_000);
  } finally {
    await browser.close();
  }
});

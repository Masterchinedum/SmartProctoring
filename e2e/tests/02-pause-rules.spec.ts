import { CandidatePage, launchCamera, skipUnlessFixtures } from '../lib/candidate';
import { expect, test } from '../lib/test';

/**
 * Scenario 2 — the exam's pause rules.
 *  a) requireReason: the candidate cannot pause without a reason; the reason reaches staff.
 *  b) requireApproval + timerBehavior 'continue': the request is pending (monitoring continues) until a
 *     staff member decides in the admin UI — a denial is shown to the candidate, an approval pauses the
 *     exam — and the exam clock keeps running during the pause.
 */
test('pause requires a reason', async ({ staff }) => {
  skipUnlessFixtures('a');
  const s = await staff.createSession({ policy: { pause: { allowed: true, requireReason: true, timerBehavior: 'stop' } } });
  const browser = await launchCamera('a');
  try {
    const c = await CandidatePage.open(browser, s.link);
    await c.checkInAndStart();
    await c.tid('pause-button').click();
    await expect(c.tid('pause-dialog')).toContainText('The exam clock stops during the pause.');
    await expect(c.tid('pause-dialog')).toContainText('Reason (required)');
    await c.tid('pause-confirm').click();
    await expect(c.tid('pause-dialog')).toContainText('Please give a reason for the pause.');
    await c.page.waitForTimeout(1500);
    await expect(c.tid('exam-screen')).toBeVisible();
    expect((await staff.session(s.sessionId)).summary.status).toBe('active');

    await c.tid('pause-reason').fill('Doorbell — parcel delivery');
    await c.tid('pause-confirm').click();
    await expect(c.tid('paused-screen')).toBeVisible({ timeout: 30_000 });
    await expect(c.tid('paused-screen')).toContainText('Doorbell — parcel delivery');
    await expect(c.tid('paused-screen')).toContainText('Stopped during the pause');

    const d = await staff.waitForSession(s.sessionId, (x) => x.summary.status === 'paused');
    const paused = d.periods.find((p) => p.kind === 'paused' && p.endedAt == null);
    expect(paused?.observed).toBe(false);
    expect(paused?.reason).toBe('Doorbell — parcel delivery');
    const ev = (await staff.events(s.sessionId)).find((e) => e.type === 'session_paused');
    expect(ev?.details.reason).toBe('Doorbell — parcel delivery');
    expect(d.summary.timerRunning).toBe(false);
  } finally {
    await browser.close();
  }
});

test('pause needs approval (decided in the admin UI) and the clock keeps running', async ({ staff, staffPage }) => {
  skipUnlessFixtures('a');
  const s = await staff.createSession({ policy: { pause: { allowed: true, requireApproval: true, requireReason: false, timerBehavior: 'continue' } } });
  const browser = await launchCamera('a');
  try {
    const sp = await staffPage();
    await sp.goto('/admin');
    await expect(sp.getByRole('heading', { name: 'Live', exact: true })).toBeVisible();

    const c = await CandidatePage.open(browser, s.link);
    await c.checkInAndStart();

    /* ---------------- request → pending (monitoring continues) → denied in the admin UI */
    await c.tid('pause-button').click();
    await expect(c.tid('pause-dialog')).toContainText('The exam administrator must approve the pause first.');
    await expect(c.tid('pause-dialog')).toContainText('The exam clock keeps running during the pause.');
    await c.tid('pause-reason').fill('Need to take medication');
    await c.tid('pause-confirm').click();
    await expect(c.tid('pause-pending')).toBeVisible({ timeout: 20_000 });
    await c.page.getByRole('button', { name: 'Keep working' }).click();
    await expect(c.tid('pause-button')).toContainText('Pause requested');
    await expect(c.tid('exam-screen')).toBeVisible();
    expect((await staff.session(s.sessionId)).summary.status).toBe('active');

    // The request appears on the live dashboard without a reload.
    let item = sp.locator('.attention-item.pause', { hasText: s.candidateName });
    await expect(item).toBeVisible({ timeout: 20_000 });
    await expect(item).toContainText('Need to take medication');
    await item.getByPlaceholder('Note to candidate (optional)').fill('Please finish this section first');
    await item.getByRole('button', { name: 'Deny' }).click();
    await expect(item).toHaveCount(0, { timeout: 20_000 });
    await expect(c.page.getByText('Your pause request was not approved: Please finish this section first')).toBeVisible({ timeout: 20_000 });
    await expect(c.tid('exam-screen')).toBeVisible();
    await expect(c.tid('pause-button')).toHaveText('Pause');

    /* ---------------- request again → approved in the admin UI → paused, clock running */
    await c.tid('pause-button').click();
    await c.tid('pause-confirm').click();
    await expect(c.tid('pause-pending')).toBeVisible({ timeout: 20_000 });
    item = sp.locator('.attention-item.pause', { hasText: s.candidateName });
    await expect(item).toBeVisible({ timeout: 20_000 });
    const beforeApproval = await c.countdownMs();
    await item.getByRole('button', { name: 'Approve' }).click();
    await expect(c.tid('paused-screen')).toBeVisible({ timeout: 20_000 });
    await expect(c.tid('paused-screen')).toContainText('Keeps running during the pause');
    const d = await staff.waitForSession(s.sessionId, (x) => x.summary.status === 'paused');
    expect(d.summary.timerRunning).toBe(true);
    expect(d.pauseRequests.map((r) => r.status)).toEqual(['denied', 'approved']);

    // The countdown keeps going down while paused.
    const p1 = await c.countdownMs();
    await c.page.waitForTimeout(8_000);
    const p2 = await c.countdownMs();
    expect(p1 - p2).toBeGreaterThanOrEqual(6_000);

    /* ---------------- resume: remaining time reflects the pause */
    await c.tid('resume-button').click();
    expect(await c.runCheck({ purpose: 'resume' })).toBe('passed');
    await c.continueAfterCheck();
    const afterResume = await c.countdownMs();
    expect(beforeApproval - afterResume).toBeGreaterThanOrEqual(8_000);
    const events = (await staff.events(s.sessionId)).map((e) => e.type);
    for (const t of ['pause_requested', 'pause_denied', 'session_paused', 'session_resumed']) expect(events).toContain(t);
  } finally {
    await browser.close();
  }
});

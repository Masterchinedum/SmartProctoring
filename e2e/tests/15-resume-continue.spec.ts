import { CandidatePage, launchCamera, skipUnlessFixtures } from '../lib/candidate';
import { candidateState } from '../lib/staff-api';
import { expect, test } from '../lib/test';

/**
 * Scenario 15 — the moments around a pause that used to produce false records or lose an answer.
 *  a) requireFullscreen: pause → close the browser → reopen → resume check passes → the candidate stays on
 *     "Check complete" for longer than the heartbeat timeout (and a paused-state poll) → clicks Resume.
 *     While that screen waits, the browser keeps sending heartbeats (the session stays online, no
 *     reporting outage) but monitoring does not run yet — so there is no "left fullscreen" before the
 *     click could enter fullscreen. After the click: fullscreen, monitoring active, still no such events.
 *  b) pause with approval: an answer typed in the seconds after staff approved (before this page learnt it
 *     from its next heartbeat) is refused by the server; it is kept and saved after the resume.
 */
test('resume with required fullscreen: "Check complete" keeps the heartbeat, monitoring starts with the click', async ({ staff }) => {
  skipUnlessFixtures('a');
  const s = await staff.createSession({
    policy: { browser: { requireFullscreen: true }, pause: { allowed: true, requireReason: false, requireApproval: false, timerBehavior: 'stop' } },
  });
  const browser = await launchCamera('a');
  try {
    let c = await CandidatePage.open(browser, s.link);
    await c.checkInAndStart();
    expect(await c.page.evaluate(() => !!document.fullscreenElement), 'the exam runs in fullscreen').toBe(true);
    await c.gotoQuestion(2);
    await c.tid('answer-input').fill('normal');
    await c.pause();

    /* ---------------- close the browser window, reopen the link, resume check */
    await c.close();
    await staff.waitForSession(s.sessionId, (d) => d.summary.status === 'paused');
    await new Promise((r) => setTimeout(r, 3_000));
    c = await CandidatePage.open(browser, s.link);
    await expect(c.tid('paused-screen')).toBeVisible();
    await c.tid('resume-button').click();
    expect(await c.runCheck({ purpose: 'resume' })).toBe('passed');
    const passedAt = Date.now();

    /* ---------------- wait on "Check complete" longer than the heartbeat timeout (20 s) */
    await c.page.waitForTimeout(25_000);
    await expect(c.tid('check-passed')).toBeVisible(); // a background refresh did not skip it
    expect(await c.page.evaluate(() => !!document.fullscreenElement)).toBe(false);
    const waiting = await staff.session(s.sessionId);
    expect(waiting.summary.status).toBe('active');
    expect(waiting.summary.connection, 'heartbeats continue while "Check complete" waits').toBe('online');
    expect(waiting.summary.reportingInterruptedSince).toBeNull();
    expect(waiting.summary.monitoring?.label).toBe('Check passed — waiting for the candidate to continue');
    expect(Date.now() - (waiting.summary.monitoring?.at ?? 0), 'a recent heartbeat').toBeLessThan(12_000);
    let events = await staff.events(s.sessionId);
    expect(events.filter((e) => e.type === 'fullscreen_exited').map((e) => e.startedAt)).toEqual([]);
    expect(events.filter((e) => e.type === 'reporting_interrupted').map((e) => e.startedAt)).toEqual([]);

    /* ---------------- click "Resume exam": fullscreen, then monitoring */
    await c.continueAfterCheck();
    expect(await c.page.evaluate(() => !!document.fullscreenElement), 'fullscreen entered by the click').toBe(true);
    await expect(c.tid('fullscreen-overlay')).toHaveCount(0);
    await c.expectMonitoringActive();
    await expect(c.tid('answer-input')).toHaveValue('normal');
    await c.page.waitForTimeout(6_000); // let the monitoring runtime's first events reach the server

    events = await staff.events(s.sessionId);
    expect(events.filter((e) => e.type === 'fullscreen_exited').map((e) => e.startedAt), 'no "left fullscreen" around the resume').toEqual([]);
    expect(events.filter((e) => e.type === 'reporting_interrupted').map((e) => e.startedAt), 'no reporting outage around the resume').toEqual([]);
    const after = await staff.session(s.sessionId);
    expect(after.summary.connection).toBe('online');
    expect(after.summary.monitoring?.state).not.toBe('off');
    expect(after.identityChecks.some((ch) => ch.trigger === 'resume' && ch.decision === 'match')).toBe(true);
    console.log(`resume check passed ${((Date.now() - passedAt) / 1000).toFixed(1)} s ago; event types: ${[...new Set(events.map((e) => e.type))].join(', ')}`);

    await c.submit();
    expect(c.pageErrors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('an answer typed just after the pause was approved is kept and saved after the resume', async ({ staff }) => {
  skipUnlessFixtures('a');
  const s = await staff.createSession({ policy: { pause: { allowed: true, requireApproval: true, requireReason: false, timerBehavior: 'stop' } } });
  const browser = await launchCamera('a');
  try {
    const c = await CandidatePage.open(browser, s.link);
    await c.checkInAndStart();
    await c.gotoQuestion(2);
    await c.tid('answer-input').fill('normal');
    await c.page.waitForTimeout(2_000); // saved

    /* ---------------- request a pause; keep working while it is pending */
    await c.tid('pause-button').click();
    await c.tid('pause-confirm').click();
    await expect(c.tid('pause-pending')).toBeVisible({ timeout: 20_000 });
    await c.page.getByRole('button', { name: 'Keep working' }).click();
    const pending = await staff.waitForSession(s.sessionId, (d) => d.pauseRequests.some((r) => r.status === 'pending'));
    const request = pending.pauseRequests.find((r) => r.status === 'pending')!;

    /* ---------------- staff approve; this page learns it only with its next heartbeat (held back here) */
    let holdHeartbeats = true;
    await c.page.route('**/api/candidate/heartbeat', async (route) => {
      while (holdHeartbeats) await new Promise((r) => setTimeout(r, 100));
      // The route may already be removed (unroute below) when the held request is released.
      await route.continue().catch(() => undefined);
    });
    await staff.decidePause(s.sessionId, request.id, true);
    await c.page.waitForTimeout(1_000);
    await expect(c.tid('exam-screen')).toBeVisible();
    await c.tid('answer-input').fill('gaussian'); // typed after the approval
    await expect.poll(() => c.httpErrors.some((e) => e.startsWith('409 PUT /api/candidate/answers/')), { timeout: 10_000, message: 'the server refused the answer (paused)' }).toBe(true);
    holdHeartbeats = false;
    await c.page.unroute('**/api/candidate/heartbeat');
    await expect(c.tid('paused-screen')).toBeVisible({ timeout: 20_000 });
    // Waiting for the resume is not a reporting outage.
    await c.page.waitForTimeout(12_000);
    await expect(c.tid('reporting-banner')).toHaveCount(0);

    /* ---------------- resume in the same page: the answer is still there and reaches the server */
    await c.tid('resume-button').click();
    expect(await c.runCheck({ purpose: 'resume' })).toBe('passed');
    await c.continueAfterCheck();
    await c.gotoQuestion(2);
    await expect(c.tid('answer-input')).toHaveValue('gaussian');
    await c.page.waitForTimeout(2_000);
    await c.submit();
    await expect(c.tid('answers-not-saved')).toHaveCount(0);

    const end = await candidateState(s.token);
    const qs = [...(end.questions ?? [])].sort((a, b) => a.index - b.index);
    const saved = (end.answers ?? []).find((a) => a.questionId === qs[2].id);
    expect(saved?.value, 'the answer typed after the approval was saved').toBe('gaussian');
    expect(c.pageErrors).toEqual([]);
  } finally {
    await browser.close();
  }
});

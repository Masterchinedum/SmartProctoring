import { CandidatePage, launchCamera, since, skipUnlessFixtures } from '../lib/candidate';
import { candidateState } from '../lib/staff-api';
import { expect, test } from '../lib/test';

/**
 * Scenario 1 — happy path + persistence across a pause with the browser closed:
 * consent (privacy notice) → readiness all green → identity reference → start → answer every question
 * type → pause (clock stops) → close the page → reopen the link in a new context → resume check →
 * answers, current question and remaining time preserved → submit → staff report.
 */
test('happy path: check-in, answers, pause with browser closed, resume, submit, report', async ({ staff, staffPage }) => {
  skipUnlessFixtures('a');
  const s = await staff.createSession({ policy: { pause: { allowed: true, requireReason: false, requireApproval: false, timerBehavior: 'stop' } } });
  const browser = await launchCamera('a');
  try {
    let c = await CandidatePage.open(browser, s.link);
    const { page } = c;

    /* ---------------- consent: privacy notice with what is monitored / stored / not stored */
    await expect(page.getByRole('heading', { name: 'What is monitored' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'What is not stored' })).toBeVisible();
    await expect(page.getByText(/Screenshots and identity data are deleted \d+ days after your exam ends/)).toBeVisible();
    await c.consent();

    /* ---------------- readiness (all required items green) → identity reference → ready */
    expect(await c.runCheck()).toBe('ready');
    const ready = await staff.session(s.sessionId);
    expect(ready.summary.status).toBe('ready');
    expect(ready.consent.acceptedAt).not.toBeNull();
    expect(ready.references).toHaveLength(1);
    expect(ready.references[0].active).toBe(true);
    expect(ready.references[0].images.length).toBeGreaterThan(0);

    await c.startExam();

    /* ---------------- answer several question types */
    await c.answerStandardQuestions(); // single choice, multiple choice, short text (now on question 3)
    await c.tid('next-question').click();
    await c.tid('answer-input').fill('5'); // numeric
    await c.tid('next-question').click();
    await c.tid('answer-input').fill('Correlation does not imply causation.'); // long text
    await c.gotoQuestion(2); // leave the candidate on question 3
    await expect(c.tid('answer-input')).toHaveValue('normal');

    /* ---------------- pause (policy: the clock stops) */
    const beforePause = await c.countdownMs();
    await c.pause();
    await expect(c.tid('paused-screen')).toContainText('Stopped during the pause');
    await expect(c.tid('paused-screen')).toContainText('You can close this window.');
    const pausedAtWall = Date.now();
    const onPause = await c.countdownMs();
    expect(beforePause - onPause).toBeLessThan(8_000);
    await staff.waitForSession(s.sessionId, (d) => d.summary.status === 'paused' && !d.summary.timerRunning);

    /* ---------------- close the browser window, wait, reopen the link in a new context */
    await c.close();
    await new Promise((r) => setTimeout(r, 12_000));
    c = await CandidatePage.open(browser, s.link);
    await expect(c.tid('paused-screen')).toBeVisible();
    const afterReopen = await c.countdownMs();
    expect(Math.abs(onPause - afterReopen), 'clock did not run while paused and closed').toBeLessThan(2_500);

    await c.tid('resume-button').click();
    expect(await c.runCheck({ purpose: 'resume' })).toBe('passed');
    await c.continueAfterCheck();
    const pausedWallMs = Date.now() - pausedAtWall;

    /* ---------------- same question, answers restored, time preserved */
    await expect(c.tid('question')).toContainText('bell-shaped');
    await expect(c.tid('answer-input')).toHaveValue('normal');
    for (const i of [0, 1, 2, 3, 4]) await expect(c.tid(`qnav-${i}`)).toHaveClass(/answered/);
    await c.gotoQuestion(0);
    await expect(c.page.getByRole('radio', { name: 'Mean' })).toBeChecked();
    await c.gotoQuestion(1);
    await expect(c.page.getByRole('checkbox', { name: 'Variance' })).toBeChecked();
    await expect(c.page.getByRole('checkbox', { name: 'Range' })).toBeChecked();
    await expect(c.page.getByRole('checkbox', { name: 'Mean' })).not.toBeChecked();
    const afterResume = await c.countdownMs();
    console.log(`paused (wall) ${since(pausedAtWall)}; countdown before pause ${beforePause} ms, after resume ${afterResume} ms`);
    expect(pausedWallMs).toBeGreaterThan(15_000);
    // Only the seconds since the resume check passed were used — not the time spent paused/closed/checking.
    expect(beforePause - afterResume).toBeLessThan(6_000);
    expect(beforePause - afterResume).toBeGreaterThanOrEqual(0);

    /* ---------------- submit */
    await c.tid('submit-button').click();
    await expect(c.tid('submit-dialog')).toContainText('You have answered 5 of 5 questions.');
    await c.tid('submit-confirm').click();
    await expect(c.tid('ended-screen')).toBeVisible({ timeout: 30_000 });
    await expect(c.tid('ended-screen')).toContainText('You submitted your exam');

    const end = await candidateState(s.token);
    expect(end.session.status).toBe('submitted');
    const qs = [...(end.questions ?? [])].sort((a, b) => a.index - b.index);
    const byQ = new Map((end.answers ?? []).map((a) => [a.questionId, a.value] as const));
    expect(byQ.get(qs[0].id)).toBe('b');
    expect(byQ.get(qs[1].id)).toEqual(['a', 'b']);
    expect(byQ.get(qs[2].id)).toBe('normal');
    expect(byQ.get(qs[3].id)).toBe(5);
    expect(byQ.get(qs[4].id)).toBe('Correlation does not imply causation.');

    /* ---------------- staff report: active / paused (unobserved) / active, identity checks, score */
    const report = await staff.report(s.sessionId);
    const kinds = [...report.periods].sort((a, b) => a.startedAt - b.startedAt).map((p) => p.kind);
    const firstActive = kinds.indexOf('active');
    const pausedIdx = kinds.indexOf('paused');
    const lastActive = kinds.lastIndexOf('active');
    expect(firstActive).toBeGreaterThanOrEqual(0);
    expect(pausedIdx).toBeGreaterThan(firstActive);
    expect(lastActive).toBeGreaterThan(pausedIdx);
    const paused = report.periods.find((p) => p.kind === 'paused')!;
    expect(paused.observed).toBe(false);
    expect(paused.endedAt).not.toBeNull();
    expect(report.totals.pauseCount).toBe(1);
    expect(report.totals.pausedMs).toBeGreaterThan(12_000);
    expect(report.totals.unobservedMs).toBeGreaterThanOrEqual(report.totals.pausedMs);
    // The exam clock only counted active time.
    expect(report.totals.examTimeUsedMs).toBeLessThan(report.totals.wallClockMs - 12_000);
    expect(report.identity.referenceCreatedAt).not.toBeNull();
    expect(report.identity.matches).toBeGreaterThanOrEqual(2);
    expect(report.identity.mismatches).toBe(0);
    const detail = await staff.session(s.sessionId);
    expect(detail.identityChecks.some((ch) => ch.trigger === 'check_in' && ch.decision === 'match')).toBe(true);
    expect(detail.identityChecks.some((ch) => ch.trigger === 'resume' && ch.decision === 'match')).toBe(true);
    expect(report.score).toEqual({ points: 5, maxPoints: 8, autoGraded: false });
    // No behavioural observations are claimed inside the pause.
    const events = await staff.events(s.sessionId);
    const inPause = events.filter((e) => e.category !== 'neutral' && e.startedAt > paused.startedAt + 1000 && e.startedAt < paused.endedAt! - 1000);
    expect(inPause.map((e) => e.type)).toEqual([]);
    for (const t of ['session_started', 'session_paused', 'unobserved_period', 'session_resumed', 'session_submitted']) expect(events.map((e) => e.type)).toContain(t);

    /* ---------------- the report page renders these facts */
    const sp = await staffPage();
    await sp.goto(`/admin/sessions/${s.sessionId}/report`);
    const periodsTable = sp.locator('section.report-section', { has: sp.getByRole('heading', { name: /^Periods/ }) });
    await expect(periodsTable.locator('tbody tr')).toHaveCount(report.periods.length);
    await expect(periodsTable.locator('tr.row-unobserved', { hasText: 'Paused' })).toContainText('Unobserved');
    await expect(periodsTable.locator('tbody tr', { hasText: 'Active' }).first()).toContainText('Observed');
    await expect(sp.locator('.report-totals')).toContainText('5 / 8');
    await expect(sp.locator('.report-totals')).toContainText('1 pause');
    await expect(sp.locator('.report-identity')).toContainText('Same person');

    expect(c.pageErrors).toEqual([]);
  } finally {
    await browser.close();
  }
});

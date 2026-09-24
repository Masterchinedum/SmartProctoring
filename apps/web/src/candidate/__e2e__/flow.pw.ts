import { expect, test } from '@playwright/test';
import { acceptConsent, answerFirstQuestions, candidateState, countdownMs, createSession, launchWithCamera, openCandidate, runCheck, y4m } from './helpers';

/**
 * Scenario 1 — full candidate journey with liveness 'off':
 * consent → readiness → identity reference → start → answer → pause → close the browser → reopen →
 * resume check → continue at the same question with answers and remaining time preserved → submit.
 */
test('full flow: consent, check, exam, pause, close, resume, submit', async () => {
  const video = y4m('obama', '/tmp/claude-0/candidate-agent/obama-cam.y4m');
  const { path, admin, sessionId } = await createSession('flow', {
    identity: { liveness: 'off', idPhotoComparison: 'off' },
    pause: { allowed: true, requireReason: true, timerBehavior: 'stop' },
    browser: { requireFullscreen: false, blockClipboard: true },
  });
  const browser = await launchWithCamera(video);
  try {
    /* ---------------- first visit */
    let c = await openCandidate(browser, path);
    let page = c.page;
    await expect(page.getByRole('heading', { name: /Introduction|E2E/ }).first()).toBeVisible();
    // Privacy notice is shown with what is (not) stored and the retention period.
    await expect(page.getByText('What is not stored')).toBeVisible();
    await expect(page.getByText(/No continuous video/)).toBeVisible();
    await acceptConsent(page);

    expect(await runCheck(page)).toBe('ready');
    await page.getByTestId('start-exam').click();
    await expect(page.getByTestId('exam-screen')).toBeVisible();
    await expect(page.getByTestId('monitoring-status')).toContainText('Monitoring', { timeout: 30_000 });

    await answerFirstQuestions(page);
    // A paste attempt is blocked by policy and recorded as an exam-page event.
    await page.getByTestId('answer-input').dispatchEvent('paste');
    await page.getByTestId('qnav-2').click();
    await expect(page.getByTestId('answer-input')).toHaveValue('normal');
    await expect(page.getByTestId('qnav-0')).toHaveClass(/answered/);
    await expect(page.getByTestId('qnav-1')).toHaveClass(/answered/);
    await page.waitForTimeout(1500); // > autosave debounce

    // Server has the answers.
    const s1 = await candidateState(page, path);
    expect(s1.session.status).toBe('active');

    /* ---------------- pause (reason required) */
    const beforePauseMs = await countdownMs(page);
    await page.getByTestId('pause-button').click();
    await expect(page.getByTestId('pause-dialog')).toBeVisible();
    await page.getByTestId('pause-confirm').click();
    await expect(page.getByText('Please give a reason for the pause.')).toBeVisible();
    await page.getByTestId('pause-reason').fill('Doorbell — parcel delivery');
    await page.getByTestId('pause-confirm').click();
    await expect(page.getByTestId('paused-screen')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('paused-screen')).toContainText('Stopped during the pause');
    await expect(page.getByTestId('paused-screen')).toContainText('You can close this window.');
    await expect(page.getByTestId('paused-screen')).toContainText('Doorbell');

    /* ---------------- close the browser window, wait, reopen */
    await c.context.close();
    await new Promise((r) => setTimeout(r, 5000));
    c = await openCandidate(browser, path);
    page = c.page;
    await expect(page.getByTestId('paused-screen')).toBeVisible();
    const pausedMs = await countdownMs(page);
    expect(Math.abs(pausedMs - beforePauseMs)).toBeLessThan(15_000);

    await page.getByTestId('resume-button').click();
    expect(await runCheck(page, { introPurpose: 'resume' })).toBe('passed');
    await page.getByTestId('check-continue').click();
    await expect(page.getByTestId('exam-screen')).toBeVisible();

    // Same question, answers restored, remaining time preserved (clock was stopped while paused).
    await expect(page.getByTestId('question')).toContainText('bell-shaped');
    await expect(page.getByTestId('answer-input')).toHaveValue('normal');
    await expect(page.getByTestId('qnav-0')).toHaveClass(/answered/);
    await expect(page.getByTestId('qnav-1')).toHaveClass(/answered/);
    const afterResumeMs = await countdownMs(page);
    expect(beforePauseMs - afterResumeMs).toBeLessThan(20_000);

    /* ---------------- continue and submit */
    await page.getByTestId('next-question').click();
    await page.getByTestId('answer-input').fill('5');
    await page.waitForTimeout(1000);
    await page.getByTestId('submit-button').click();
    await expect(page.getByTestId('submit-dialog')).toContainText('4');
    await expect(page.getByTestId('submit-dialog')).toContainText('1 question is unanswered');
    await page.getByTestId('submit-confirm').click();
    await expect(page.getByTestId('ended-screen')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('ended-screen')).toContainText('You submitted your exam');

    const end = await candidateState(page, path);
    expect(end.session.status).toBe('submitted');
    const byQ = new Map((end.answers ?? []).map((a) => [a.questionId, a.value] as const));
    const qs = end.questions ?? [];
    expect(byQ.get(qs[0].id)).toBe('b');
    expect(byQ.get(qs[1].id)).toEqual(['a', 'b']);
    expect(byQ.get(qs[2].id)).toBe('normal');
    expect(byQ.get(qs[3].id)).toBe(5);

    /* ---------------- server-side timeline (when the staff API is available) */
    if (admin && sessionId) {
      const detail = await admin.sessionDetail(sessionId);
      const kinds = detail.periods.map((p) => p.kind);
      expect(kinds).toContain('paused');
      expect(kinds.filter((k) => k === 'active').length).toBeGreaterThanOrEqual(2);
      expect(detail.identityChecks.some((ch) => ch.trigger === 'resume' && ch.decision === 'match')).toBe(true);
      const events = await admin.events(sessionId);
      const types = events.map((e) => e.type);
      for (const t of ['session_started', 'session_paused', 'session_resumed', 'session_submitted', 'clipboard_attempt']) expect(types).toContain(t);
      await admin.dispose();
    }
    expect(c.logs.filter((l) => l.startsWith('[pageerror]'))).toEqual([]);
  } finally {
    await browser.close();
  }
});

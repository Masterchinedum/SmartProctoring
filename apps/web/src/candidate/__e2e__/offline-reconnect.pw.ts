import { expect, request as pwRequest, test } from '@playwright/test';
import type { CandidateSessionState } from '@sp/shared';
import { acceptConsent, BASE_URL, createSession, launchWithCamera, openCandidate, runCheck, tokenFromPath, y4m } from './helpers';

/**
 * Offline safety + reconnect:
 *  - the connection drops during the exam: the candidate keeps answering, sees the "live reporting is
 *    interrupted" banner, answers are kept on the device;
 *  - the connection returns: queued answers/events are delivered automatically, banner disappears;
 *  - the page is reloaded (a new browser instance): the reconnect check is required before the exam
 *    continues at the same question with all answers.
 */
test('offline answers are delivered later; reload requires a reconnect check', async () => {
  const video = y4m('obama', '/tmp/claude-0/candidate-agent/obama-cam.y4m');
  const { path } = await createSession('offline', { identity: { liveness: 'off', idPhotoComparison: 'off' }, browser: { requireFullscreen: false } });
  const token = tokenFromPath(path);
  // Independent observer (not affected by the page's offline emulation).
  const observer = await pwRequest.newContext({ baseURL: BASE_URL });
  const serverState = async () =>
    (await (await observer.get('/api/candidate/session', { headers: { Authorization: `Bearer ${token}`, 'X-Client-Instance': 'e2e-observer-0002' } })).json()) as CandidateSessionState;

  const browser = await launchWithCamera(video);
  try {
    const c = await openCandidate(browser, path);
    const page = c.page;
    await acceptConsent(page);
    expect(await runCheck(page)).toBe('ready');
    await page.getByTestId('start-exam').click();
    await expect(page.getByTestId('exam-screen')).toBeVisible();
    await page.getByRole('radio', { name: 'Mean' }).check();
    await page.waitForTimeout(1500);

    /* ---------------- connection lost */
    await c.context.setOffline(true);
    const offlineAt = Date.now();
    await page.getByTestId('next-question').click();
    await page.getByRole('checkbox', { name: 'Variance' }).check();
    await page.getByTestId('next-question').click();
    await page.getByTestId('answer-input').fill('gaussian');
    await expect(page.getByTestId('reporting-banner')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('reporting-banner')).toContainText('saved on this device');
    // Stay offline long enough for the server to notice (heartbeat timeout) — the exam UI keeps working.
    await page.waitForTimeout(25_000);
    await expect(page.getByTestId('qnav-1')).toHaveClass(/answered/);
    const during = await serverState();
    expect(during.session.status).toBe('active');

    /* ---------------- connection back */
    await c.context.setOffline(false);
    await expect(page.getByTestId('reporting-banner')).toBeHidden({ timeout: 30_000 });
    const onlineAt = Date.now();
    console.log(`offline for ${Math.round((onlineAt - offlineAt) / 1000)} s`);

    /* ---------------- reload = new browser instance => reconnect check */
    await page.reload();
    await expect(page.getByTestId('check-intro')).toHaveAttribute('data-purpose', 'reconnect');
    expect(await runCheck(page, { introPurpose: 'reconnect' })).toBe('passed');
    await page.getByTestId('check-continue').click();
    await expect(page.getByTestId('exam-screen')).toBeVisible();
    await expect(page.getByTestId('question')).toContainText('bell-shaped');
    await expect(page.getByTestId('answer-input')).toHaveValue('gaussian');
    await expect(page.getByTestId('qnav-0')).toHaveClass(/answered/);
    await expect(page.getByTestId('qnav-1')).toHaveClass(/answered/);

    expect((await serverState()).session.status).toBe('active');

    // Submit from the reconnected window; the server has every answer.
    await page.getByTestId('submit-button').click();
    await page.getByTestId('submit-confirm').click();
    await expect(page.getByTestId('ended-screen')).toBeVisible({ timeout: 30_000 });
    const end = await serverState();
    const qs = end.questions ?? [];
    const byQ = new Map((end.answers ?? []).map((a) => [a.questionId, a] as const));
    expect(byQ.get(qs[0].id)?.value).toBe('b');
    expect(byQ.get(qs[1].id)?.value).toEqual(['a']);
    expect(byQ.get(qs[2].id)?.value).toBe('gaussian');
    // Answers typed later carry higher client sequence numbers.
    expect(byQ.get(qs[2].id)!.clientSeq).toBeGreaterThan(byQ.get(qs[0].id)!.clientSeq);
  } finally {
    await observer.dispose();
    await browser.close();
  }
});

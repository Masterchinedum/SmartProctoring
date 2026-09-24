import { expect, test } from '@playwright/test';
import { acceptConsent, AdminApi, countdownMs, launchWithCamera, openCandidate, runCheck, y4m } from './helpers';

/**
 * Staff-driven changes reach the candidate through heartbeat commands / state polling:
 *  - required fullscreen: leaving it shows the "Return to fullscreen" overlay (and is recorded);
 *  - pause needing approval: request → denied (candidate is told calmly) → request → approved → paused
 *    with the clock running (timerBehavior 'continue') → resume with the identity check;
 *  - staff hold → hold screen → release requiring a new check → "Verify again" → exam continues;
 *  - staff termination → ended screen.
 * Requires the staff API (no SP_LINK_* fallback).
 */
test('pause approval, hold and release, termination, fullscreen enforcement', async () => {
  const video = y4m('obama', '/tmp/claude-0/candidate-agent/obama-cam.y4m');
  const admin = await AdminApi.login();
  const { path, sessionId } = await admin.createSession({
    policy: {
      identity: { liveness: 'off', idPhotoComparison: 'off' },
      pause: { allowed: true, requireApproval: true, requireReason: false, timerBehavior: 'continue' },
      browser: { requireFullscreen: true },
    },
  });
  const browser = await launchWithCamera(video);
  try {
    const { page } = await openCandidate(browser, path);
    await acceptConsent(page);
    expect(await runCheck(page)).toBe('ready');
    await page.getByTestId('start-exam').click();
    await expect(page.getByTestId('exam-screen')).toBeVisible();
    expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true);

    /* ---------------- fullscreen enforcement */
    await page.evaluate(() => document.exitFullscreen());
    await expect(page.getByTestId('fullscreen-overlay')).toBeVisible();
    await page.getByTestId('fullscreen-return').click();
    await expect(page.getByTestId('fullscreen-overlay')).toBeHidden();

    /* ---------------- pause with approval: denied */
    await page.getByTestId('pause-button').click();
    await expect(page.getByTestId('pause-dialog')).toContainText('The exam administrator must approve the pause first.');
    await page.getByTestId('pause-confirm').click();
    await expect(page.getByTestId('pause-pending')).toBeVisible();
    await page.getByRole('button', { name: 'Keep working' }).click();
    await expect(page.getByTestId('pause-button')).toContainText('Pause requested');
    let reqId = await admin.pendingPauseRequestId(sessionId);
    expect(reqId).toBeTruthy();
    await admin.decidePause(sessionId, reqId!, false, 'Please finish the current section first');
    await expect(page.getByText(/not approved: Please finish the current section first/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('exam-screen')).toBeVisible();

    /* ---------------- pause with approval: approved (clock keeps running) */
    await page.getByTestId('pause-button').click();
    await page.getByTestId('pause-confirm').click();
    await expect(page.getByTestId('pause-pending')).toBeVisible();
    reqId = await admin.pendingPauseRequestId(sessionId);
    await admin.decidePause(sessionId, reqId!, true);
    await expect(page.getByTestId('paused-screen')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('paused-screen')).toContainText('Keeps running during the pause');
    const a = await countdownMs(page);
    await page.waitForTimeout(3000);
    expect(await countdownMs(page)).toBeLessThan(a);

    /* ---------------- resume */
    await page.getByTestId('resume-button').click();
    expect(await runCheck(page, { introPurpose: 'resume' })).toBe('passed');
    await page.getByTestId('check-continue').click();
    await expect(page.getByTestId('exam-screen')).toBeVisible();
    await expect(page.getByTestId('fullscreen-overlay')).toBeHidden();

    /* ---------------- staff hold → release with a new check */
    await admin.hold(sessionId, 'Checking the room');
    await expect(page.getByTestId('hold-screen')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('hold-screen')).toContainText('An administrator has put your exam on hold');
    await expect(page.getByTestId('reverify-button')).toHaveCount(0);
    await admin.release(sessionId, { requireCheck: true, note: 'All good' });
    await expect(page.getByTestId('reverify-button')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('reverify-button').click();
    expect(await runCheck(page, { introPurpose: 'reverify' })).toBe('passed');
    await page.getByTestId('check-continue').click();
    await expect(page.getByTestId('exam-screen')).toBeVisible();

    /* ---------------- termination */
    await admin.terminate(sessionId, 'E2E test termination');
    await expect(page.getByTestId('ended-screen')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('ended-screen')).toHaveAttribute('data-status', 'terminated');
    await expect(page.getByTestId('ended-screen')).toContainText('ended by the exam administrator');

    /* ---------------- timeline */
    const types = (await admin.events(sessionId)).map((e) => e.type);
    for (const t of ['fullscreen_exited', 'pause_requested', 'pause_denied', 'session_paused', 'session_resumed', 'session_held', 'hold_released', 'session_terminated']) {
      expect(types, `timeline should contain ${t}`).toContain(t);
    }
  } finally {
    await browser.close();
    await admin.dispose();
  }
});

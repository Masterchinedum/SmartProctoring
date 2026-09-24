import { expect, test } from '@playwright/test';
import { acceptConsent, AdminApi, launchWithCamera, openCandidate, runCheck, y4m } from './helpers';

/**
 * A dim room: the browser's checklist passes, but the server's quality gate rejects the frontal frames
 * (too little contrast for a dependable comparison). The client must hand the attempt to the server
 * after a few rejections so it is recorded as "unable to verify" (never as a different person), show
 * the server's guidance and let the candidate try again — which succeeds once the light is on.
 * Fake camera (SP_Y4M_DIM): the candidate in a dim room for 35 s, then the same room with the light on.
 */
test('dim room: unable to verify with guidance, then passes with better light', async () => {
  const video = y4m('dim', '/tmp/claude-0/candidate-agent/dim.y4m');
  const admin = await AdminApi.login();
  const { path, sessionId } = await admin.createSession({
    policy: { identity: { liveness: 'off', idPhotoComparison: 'off', maxVerificationAttempts: 3 }, browser: { requireFullscreen: false } },
  });
  const browser = await launchWithCamera(video);
  const t0 = Date.now();
  try {
    const { page } = await openCandidate(browser, path);
    await acceptConsent(page);
    const outcome = await runCheck(page);
    expect(outcome).toBe('retry');
    expect((Date.now() - t0) / 1000).toBeLessThan(35); // decided long before the challenge would expire
    await expect(page.getByTestId('check-retry')).toContainText('Attempts remaining: 2');
    await expect(page.getByTestId('check-retry-guidance')).toContainText(/light|washed out|lit/i);
    expect((await admin.sessionDetail(sessionId)).summary.status).toBe('invited');

    // The light comes on (video), the candidate tries again.
    await page.waitForTimeout(Math.max(0, 38_000 - (Date.now() - t0)));
    await page.getByTestId('check-try-again').click();
    await expect(page.getByTestId('ready-screen')).toBeVisible({ timeout: 90_000 });

    const detail = await admin.sessionDetail(sessionId);
    const decisions = detail.identityChecks.map((c) => c.decision);
    expect(decisions).toContain('unable_to_verify');
    expect(decisions).not.toContain('mismatch');
  } finally {
    await browser.close();
    await admin.dispose();
  }
});

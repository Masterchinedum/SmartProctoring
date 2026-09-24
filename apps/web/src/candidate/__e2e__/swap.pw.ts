import { expect, test } from '@playwright/test';
import { acceptConsent, answerFirstQuestions, candidateState, createSession, launchWithCamera, openCandidate, runCheck, y4m } from './helpers';

/**
 * Scenario 3 — possible person swap during the active exam.
 * Fake camera: candidate A (reference) for 90 s, empty room for 6 s, then a different person B.
 * Expected: the face returning after the absence triggers an identity sample; the server finds a
 * non-match, asks for a follow-up sample, confirms, flags `identity_mismatch` and (policy
 * hold_for_review) holds the exam. The candidate sees a calm hold screen.
 */
test('person swap during the exam is flagged and the exam is held', async () => {
  const video = y4m('swap', '/tmp/claude-0/candidate-agent/swap.y4m');
  const { path, admin, sessionId } = await createSession('swap', {
    identity: { liveness: 'off', idPhotoComparison: 'off', periodicCheckIntervalSec: 10, onMismatch: 'hold_for_review' },
    browser: { requireFullscreen: false },
  });
  const browser = await launchWithCamera(video);
  const t0 = Date.now();
  try {
    const c = await openCandidate(browser, path);
    const page = c.page;
    await acceptConsent(page);
    expect(await runCheck(page)).toBe('ready');
    await page.getByTestId('start-exam').click();
    await expect(page.getByTestId('exam-screen')).toBeVisible();
    const startedAfterSec = (Date.now() - t0) / 1000;
    console.log(`exam started after ${startedAfterSec.toFixed(0)} s (person B appears at ~96 s of video)`);
    expect(startedAfterSec).toBeLessThan(85);
    await answerFirstQuestions(page);

    // While candidate A is in view, routine samples match and the exam continues.
    await page.waitForTimeout(Math.max(0, 80_000 - (Date.now() - t0)));
    expect((await candidateState(page, path)).session.status).toBe('active');

    // After the swap: hold screen within ~90 s.
    await expect(page.getByTestId('hold-screen')).toBeVisible({ timeout: 150_000 });
    console.log(`hold after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    const st = await candidateState(page, path);
    expect(st.session.status).toBe('on_hold');
    expect(st.session.hold?.reason).toBe('identity_mismatch');
    await expect(page.getByTestId('hold-screen')).toContainText(/on hold/i);
    // Candidate-facing wording is non-accusatory.
    await expect(page.getByTestId('hold-screen')).not.toContainText(/cheat|fraud|impostor/i);

    if (admin && sessionId) {
      const detail = await admin.sessionDetail(sessionId);
      const mismatches = detail.identityChecks.filter((ch) => ch.decision === 'mismatch');
      expect(mismatches.length).toBeGreaterThanOrEqual(2);
      expect(detail.identityChecks.some((ch) => ch.decision === 'match' && ch.trigger !== 'check_in')).toBe(true);
      const events = await admin.events(sessionId);
      const mm = events.find((e) => e.type === 'identity_mismatch');
      expect(mm).toBeTruthy();
      expect(mm!.evidence.length).toBeGreaterThan(0);
      await admin.dispose();
    }
  } finally {
    await browser.close();
  }
});

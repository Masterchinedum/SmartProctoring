import { CandidatePage, launchCamera, since, skipUnlessFixtures } from '../lib/candidate';
import { expect, test } from '../lib/test';

/**
 * Scenario 3 — active liveness with a still photo in front of the camera (the fake camera is a still
 * image with sensor noise and a few pixels of jitter: it cannot turn its head).
 * Expected: the guided check cannot progress past the head-turn step; the attempt is handed to the
 * server, which records a failed live-person check and returns retry guidance; the session never becomes
 * ready; after the configured attempts the exam is held for human review as "could not verify" (never
 * as a different person). Staff see every failed attempt.
 */
test('active liveness: a still photo cannot pass; attempts recorded; held for review', async ({ staff, staffPage }) => {
  skipUnlessFixtures('a');
  test.setTimeout(5 * 60_000);
  const s = await staff.createSession({ policy: { identity: { liveness: 'active', livenessSteps: 2, maxVerificationAttempts: 2 } } });
  const browser = await launchCamera('a');
  try {
    const c = await CandidatePage.open(browser, s.link);
    await c.consent();
    await c.passReadiness();
    const t0 = Date.now();

    /* ---------------- attempt 1: stuck at the head-turn instruction */
    await expect(c.tid('verify-step')).toHaveAttribute('data-phase', 'liveness', { timeout: 60_000 });
    await expect(c.tid('verify-instruction')).toContainText(/turn your head/i, { timeout: 20_000 });
    await c.page.waitForTimeout(10_000);
    await expect(c.tid('verify-instruction')).toContainText(/turn your head/i);
    await expect(c.tid('ready-screen')).toHaveCount(0);
    expect((await staff.session(s.sessionId)).summary.status).toBe('invited');

    // No progress → the attempt goes to the server → retry guidance.
    await expect(c.tid('check-retry')).toBeVisible({ timeout: 60_000 });
    console.log(`attempt 1 ended after ${since(t0)}`);
    await expect(c.tid('check-retry')).toContainText('We could not confirm the live head movements');
    await expect(c.tid('check-retry')).toContainText(/Attempts remaining:\s*1/);
    await expect(c.tid('check-try-again')).toBeVisible();

    let d = await staff.waitForSession(s.sessionId, (x) => x.identityChecks.filter((ch) => ch.trigger === 'check_in').length >= 1);
    expect(d.summary.status).toBe('invited');
    expect(d.references).toHaveLength(0);
    const first = d.identityChecks.find((ch) => ch.trigger === 'check_in')!;
    expect(first.decision).toBe('unable_to_verify');

    /* ---------------- attempt 2: same result → held for review (not "different person") */
    await c.tid('check-try-again').click();
    await expect(c.tid('verify-step')).toHaveAttribute('data-phase', 'liveness', { timeout: 60_000 });
    const outcome = await c.waitForCheckOutcome(90_000);
    expect(outcome).toBe('hold');
    await expect(c.tid('hold-screen')).toContainText('Your exam is on hold');

    d = await staff.waitForSession(s.sessionId, (x) => x.summary.status === 'on_hold');
    expect(d.summary.hold?.reason).toBe('identity_unverifiable');
    expect(d.references).toHaveLength(0);
    const attempts = d.identityChecks.filter((ch) => ch.trigger === 'check_in');
    expect(attempts).toHaveLength(2);
    expect(attempts.every((ch) => ch.decision === 'unable_to_verify')).toBe(true);
    const events = await staff.events(s.sessionId);
    const unverifiable = events.find((e) => e.type === 'identity_unverifiable');
    expect(unverifiable?.category).toBe('uncertain');
    expect(unverifiable?.details).toMatchObject({ attempts: 2, lastReason: 'liveness_failed', livenessPassed: false });
    expect(events.some((e) => e.type === 'identity_mismatch')).toBe(false);
    expect(events.some((e) => e.type === 'reference_created' || e.type === 'checkin_completed')).toBe(false);

    /* ---------------- staff see the failed attempts (Identity tab) */
    const sp = await staffPage();
    await sp.goto(`/admin/sessions/${s.sessionId}?tab=identity`);
    const checks = sp.locator('section', { has: sp.getByRole('heading', { name: 'Identity checks' }) });
    await expect(checks.getByText('Could not verify (image quality)').first()).toBeVisible();
    await expect(sp.getByText('Identity could not be verified after repeated attempts').first()).toBeVisible();
  } finally {
    await browser.close();
  }
});

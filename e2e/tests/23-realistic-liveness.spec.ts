import { CandidatePage } from '../lib/candidate';
import { RW_FIXTURES, type RwFixtureName } from '../lib/realistic';
import { checkWithRetries, createRwSession, launchRw, recordMetric, reps, rwPolicy, secs, skipUnlessRw } from '../lib/realistic-run';
import { expect, test } from '../lib/test';

/**
 * Scenario 23 — active liveness (default policy: 2 random head-turn steps) under realistic webcam conditions.
 *  - A turning head (synthetic nose-vs-eyes parallax applied to the source photo BEFORE the webcam simulation, so
 *    the turn goes through the same exposure / noise / blur / JPEG): typical light, dim light, another room with a
 *    VGA camera. Measured: pass, attempts, time from the readiness "Continue" to the ready screen, re-prompts.
 *  - A still photo (the same realistic frames without head turns): must still fail — retry guidance, then held
 *    as "could not verify", never as a different person.
 */

const TURNING: { id: string; fixture: RwFixtureName }[] = [
  { id: 'typical', fixture: 'rwTurnA_typical' },
  { id: 'dim', fixture: 'rwTurnA_dim' },
  { id: 'other-room-camera-480p', fixture: 'rwTurnA2_other' },
];
const STILL: { id: string; fixture: RwFixtureName }[] = [
  { id: 'still-typical', fixture: 'rwA_typical' },
  { id: 'still-dim', fixture: 'rwA_dim' },
];

for (const cs of TURNING) {
  for (const rep of reps()) {
    test(`realistic liveness: turning head passes, ${cs.id} #${rep}`, async ({ staff }, testInfo) => {
      skipUnlessRw(cs.fixture);
      test.setTimeout(6 * 60_000);
      const s = await createRwSession(staff, rwPolicy({ liveness: 'active' }), `RW liveness ${cs.id}`);
      const browser = await launchRw(cs.fixture);
      try {
        const c = await CandidatePage.open(browser, s.link);
        await c.consent();
        const r = await checkWithRetries(c, { maxAttempts: 3 });
        const cam = await c.lastCameraOpen();
        const d = await staff.session(s.sessionId);
        const completes = c.apiLog.filter((l) => / complete /.test(l));
        const stepFrames = c.apiLog.filter((l) => / frame step=\d/.test(l));
        recordMetric(testInfo, {
          scenario: 'liveness',
          case: cs.id,
          rep,
          pass: r.final === 'ready',
          firstAttempt: r.final === 'ready' && r.attempts === 1,
          fixture: cs.fixture,
          camera: cam ? `${cam.width}x${cam.height}` : null,
          final: r.final,
          attempts: r.attempts,
          timeToOutcomeS: secs(r.totalMs),
          attemptS: r.attemptMs.map(secs),
          reprompts: r.reprompts,
          retryGuidance: r.guidance,
          livenessPassed: d.references[0]?.liveness?.passed ?? null,
          completes,
          stepFramesSent: stepFrames.length,
          stepFramesSatisfied: stepFrames.filter((l) => / sat=true /.test(l)).length,
          about: RW_FIXTURES[cs.fixture].about,
        });
        expect(r.final, `outcome after ${r.attempts} attempt(s): ${JSON.stringify(completes)}`).toBe('ready');
        expect(d.references[0]?.liveness?.passed).toBe(true);
      } finally {
        await browser.close();
      }
    });
  }
}

for (const cs of STILL) {
  for (const rep of reps()) {
    test(`realistic liveness: a still photo still fails, ${cs.id} #${rep}`, async ({ staff }, testInfo) => {
      skipUnlessRw(cs.fixture);
      test.setTimeout(6 * 60_000);
      const s = await createRwSession(staff, rwPolicy({ liveness: 'active', identity: { maxVerificationAttempts: 2 } }), `RW still ${cs.id}`);
      const browser = await launchRw(cs.fixture);
      try {
        const c = await CandidatePage.open(browser, s.link);
        await c.consent();
        const r = await checkWithRetries(c, { maxAttempts: 2 });
        const d = await staff.waitForSession(s.sessionId, (x) => x.summary.status === 'on_hold' || x.summary.status === 'ready', { timeout: 30_000 }).catch(() => null);
        const events = await staff.events(s.sessionId);
        recordMetric(testInfo, {
          scenario: 'liveness-still',
          case: cs.id,
          rep,
          pass: r.final !== 'ready' && !events.some((e) => e.type === 'identity_mismatch'),
          fixture: cs.fixture,
          final: r.final,
          attempts: r.attempts,
          timeToOutcomeS: secs(r.totalMs),
          status: d?.summary.status ?? null,
          holdReason: d?.summary.hold?.reason ?? null,
          completes: c.apiLog.filter((l) => / complete /.test(l)),
        });
        expect(r.final, 'a still photo never passes active liveness').not.toBe('ready');
        expect(events.some((e) => e.type === 'identity_mismatch'), 'never called a different person').toBe(false);
        expect(d?.summary.status).toBe('on_hold');
        expect(d?.summary.hold?.reason).toBe('identity_unverifiable');
      } finally {
        await browser.close();
      }
    });
  }
}

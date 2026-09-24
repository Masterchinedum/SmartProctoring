import type { Browser } from '@playwright/test';
import { CandidatePage } from '../lib/candidate';
import { RW_FIXTURES, type RwFixtureName } from '../lib/realistic';
import { checkWithRetries, createRwSession, launchRw, recordMetric, reps, rwPolicy, secs, skipUnlessRw } from '../lib/realistic-run';
import { expect, test } from '../lib/test';

/**
 * Scenario 20 — a returning student resumes under REALISTIC webcam conditions (the product owner's first
 * complaint: "a returning student needed several attempts to resume").
 *
 * Candidate A checks in at home (laptop webcam 1280×720, typical indoor light), starts, pauses and closes the
 * browser. The exam is resumed from a new browser profile under another condition: the same room (typical),
 * the evening (dim), with the window behind (backlit), with a side lamp, the laptop camera in VGA mode (dim), or
 * on ANOTHER DAY in another room with another camera (a different photo of A: other hairstyle and make-up).
 * Liveness off and on (head-turn fixtures). Impostors resume too: person B (a plausible look-alike) and a family
 * member (the father resumes the son's… here: the son resumes the father's exam).
 *
 * Measured per run: attempts until the outcome, time from clicking Resume to the outcome, in-place liveness
 * re-prompts, the server's resume-check decisions / similarities. Asserted: a genuine candidate is never held or
 * called a different person and passes within 5 attempts; first-attempt pass in typical and dim light (the target);
 * an impostor never passes.
 */

interface ResumeCase {
  id: string;
  enrol: RwFixtureName;
  resume: RwFixtureName;
  liveness: 'off' | 'active';
  /** The target: passes on the first attempt. */
  firstAttempt: boolean;
}

const GENUINE: ResumeCase[] = [
  // Same day (the check-in photo of A, other frames): the light changes.
  { id: 'typical', enrol: 'rwA_typical', resume: 'rwA_typical_later', liveness: 'off', firstAttempt: true },
  { id: 'dim', enrol: 'rwA_typical', resume: 'rwA_dim', liveness: 'off', firstAttempt: true },
  { id: 'backlit', enrol: 'rwA_typical', resume: 'rwA_backlit', liveness: 'off', firstAttempt: false },
  { id: 'sidelit', enrol: 'rwA_typical', resume: 'rwA_sidelit', liveness: 'off', firstAttempt: false },
  { id: 'dim-480p', enrol: 'rwA_typical', resume: 'rwA_dim480', liveness: 'off', firstAttempt: true },
  // Another day (another photo of A: hair down, smiling, other make-up).
  { id: 'other-day-typical', enrol: 'rwA_typical', resume: 'rwA2_typical', liveness: 'off', firstAttempt: true },
  { id: 'other-day-dim', enrol: 'rwA_typical', resume: 'rwA2_dim', liveness: 'off', firstAttempt: true },
  { id: 'other-day-backlit', enrol: 'rwA_typical', resume: 'rwA2_backlit', liveness: 'off', firstAttempt: false },
  { id: 'other-day-room-camera', enrol: 'rwA_typical', resume: 'rwA2_other_typical', liveness: 'off', firstAttempt: false },
  { id: 'other-day-room-camera-dim', enrol: 'rwA_typical', resume: 'rwA2_other_dim', liveness: 'off', firstAttempt: false },
  // Active liveness (head turns) at check-in and at resume.
  { id: 'typical', enrol: 'rwTurnA_typical', resume: 'rwTurnA_typical_later', liveness: 'active', firstAttempt: true },
  { id: 'dim', enrol: 'rwTurnA_typical', resume: 'rwTurnA_dim', liveness: 'active', firstAttempt: true },
  { id: 'other-day-room-camera', enrol: 'rwTurnA_typical', resume: 'rwTurnA2_other', liveness: 'active', firstAttempt: false },
];

const IMPOSTOR: ResumeCase[] = [
  { id: 'B-typical', enrol: 'rwA_typical', resume: 'rwB_typical', liveness: 'off', firstAttempt: false },
  { id: 'B-dim', enrol: 'rwA_typical', resume: 'rwB_dim', liveness: 'off', firstAttempt: false },
  { id: 'B-backlit', enrol: 'rwA_typical', resume: 'rwB_backlit', liveness: 'off', firstAttempt: false },
  { id: 'family-son-for-father', enrol: 'rwDAD_typical', resume: 'rwSON_typical', liveness: 'off', firstAttempt: false },
];

async function checkInPauseClose(link: string, enrol: RwFixtureName, browser: Browser) {
  const a = await CandidatePage.open(browser, link);
  await a.consent();
  const ci = await checkWithRetries(a, { maxAttempts: 3 });
  expect(ci.final, `check-in with ${enrol}: ${JSON.stringify(ci)}`).toBe('ready');
  const cam = await a.lastCameraOpen();
  await a.startExam();
  await a.gotoQuestion(0);
  await a.page.getByRole('radio', { name: 'Mean' }).check();
  await a.page.waitForTimeout(6_000); // a little monitoring (the exam_start sample) before the break
  await a.pause('Short break');
  await a.close();
  return { checkin: ci, camera: cam };
}

for (const cs of [...GENUINE, ...IMPOSTOR]) {
  const impostor = IMPOSTOR.includes(cs);
  for (const rep of reps()) {
    test(`realistic resume: ${impostor ? 'impostor' : 'genuine'} ${cs.id}, liveness ${cs.liveness} #${rep}`, async ({ staff }, testInfo) => {
      skipUnlessRw(cs.enrol, cs.resume);
      test.setTimeout(7 * 60_000);
      const s = await createRwSession(staff, rwPolicy({ liveness: cs.liveness }), `RW resume ${cs.id}`);
      const b1 = await launchRw(cs.enrol);
      const b2 = cs.resume === cs.enrol ? b1 : await launchRw(cs.resume);
      try {
        const first = await checkInPauseClose(s.link, cs.enrol, b1);

        /* ---------------- resume from a new browser profile under the case's condition */
        const c = await CandidatePage.open(b2, s.link);
        await expect(c.tid('paused-screen')).toBeVisible({ timeout: 30_000 });
        const t0 = Date.now();
        await c.tid('resume-button').click();
        const r = await checkWithRetries(c, { purpose: 'resume', maxAttempts: 5, t0 });
        const cam = await c.lastCameraOpen();
        const d = await staff.session(s.sessionId);
        const resumeChecks = d.identityChecks.filter((ch) => ch.trigger === 'resume');
        const events = await staff.events(s.sessionId);
        const types = events.map((e) => e.type);
        const verdictLines = c.apiLog.filter((l) => / complete /.test(l));
        const pass = impostor ? r.final !== 'passed' : r.final === 'passed' && (!cs.firstAttempt || r.attempts === 1);
        recordMetric(testInfo, {
          scenario: impostor ? 'resume-impostor' : 'resume',
          case: cs.id,
          liveness: cs.liveness,
          rep,
          pass,
          fixture: cs.resume,
          camera: cam ? `${cam.width}x${cam.height}` : null,
          final: r.final,
          attempts: r.attempts,
          outcomes: r.outcomes,
          timeToOutcomeS: secs(r.totalMs),
          attemptS: r.attemptMs.map(secs),
          reprompts: r.reprompts,
          retryGuidance: r.guidance,
          resumeDecisions: resumeChecks.map((ch) => `${ch.decision}${ch.similarity == null ? '' : `@${ch.similarity.toFixed(3)}`}`),
          completes: verdictLines,
          checkinAttempts: first.checkin.attempts,
          checkinS: secs(first.checkin.totalMs),
          status: d.summary.status,
          holdReason: d.summary.hold?.reason ?? null,
          mismatchEvents: types.filter((t) => t === 'identity_mismatch').length,
          unverifiableEvents: types.filter((t) => t === 'identity_unverifiable').length,
          about: RW_FIXTURES[cs.resume].about,
        });

        if (impostor) {
          // Never lets the other person continue; the expected result is a hold for review (identity_mismatch).
          expect(r.final, `impostor outcome (attempts ${r.attempts})`).not.toBe('passed');
          expect(d.summary.status).not.toBe('active');
          return;
        }
        // Genuine: never held, never "a different person"; passes (target: at the first attempt in typical / dim).
        expect(types, 'no identity_mismatch for the genuine candidate').not.toContain('identity_mismatch');
        expect(r.final, `genuine resume outcome after ${r.attempts} attempt(s): ${JSON.stringify(r.outcomes)} ${JSON.stringify(r.guidance)}`).toBe('passed');
        if (cs.firstAttempt) expect.soft(r.attempts, 'target: first-attempt pass').toBe(1);
        await c.continueAfterCheck();
        await expect(c.tid('qnav-0')).toHaveClass(/answered/);
      } finally {
        await b1.close();
        if (b2 !== b1) await b2.close();
      }
    });
  }
}

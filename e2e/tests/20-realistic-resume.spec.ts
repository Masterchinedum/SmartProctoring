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
 * re-prompts, the server's resume-check decisions / similarities. Asserted — what the product SHOULD do, so these are
 * regression scenarios, not a snapshot of today's behaviour:
 *  - a genuine candidate is never called a different person (no identity_mismatch) in any condition;
 *  - `first`: passes at the first attempt (same room in typical or dim light, another day in typical light);
 *  - `within2`: passes within two attempts (backlit, side lamp, VGA camera, active liveness in dim / another room);
 *  - `honest`: may end "unable to verify" with guidance (another day AND poor light — the image may really be too
 *    poor), but never a mismatch;
 *  - an impostor never passes.
 */

interface ResumeCase {
  id: string;
  enrol: RwFixtureName;
  resume: RwFixtureName;
  liveness: 'off' | 'active';
  /** What the product should achieve for a genuine candidate (see above); impostors: 'never'. */
  expect: 'first' | 'within2' | 'honest' | 'never';
}

const GENUINE: ResumeCase[] = [
  // Same day (the check-in photo of A, other frames): the light changes.
  { id: 'typical', enrol: 'rwA_typical', resume: 'rwA_typical_later', liveness: 'off', expect: 'first' },
  { id: 'dim', enrol: 'rwA_typical', resume: 'rwA_dim', liveness: 'off', expect: 'first' },
  { id: 'backlit', enrol: 'rwA_typical', resume: 'rwA_backlit', liveness: 'off', expect: 'within2' },
  { id: 'sidelit', enrol: 'rwA_typical', resume: 'rwA_sidelit', liveness: 'off', expect: 'within2' },
  { id: 'dim-480p', enrol: 'rwA_typical', resume: 'rwA_dim480', liveness: 'off', expect: 'within2' },
  // Another day (another photo of A: hair down, smiling, other make-up).
  { id: 'other-day-typical', enrol: 'rwA_typical', resume: 'rwA2_typical', liveness: 'off', expect: 'first' },
  { id: 'other-day-dim', enrol: 'rwA_typical', resume: 'rwA2_dim', liveness: 'off', expect: 'honest' },
  { id: 'other-day-backlit', enrol: 'rwA_typical', resume: 'rwA2_backlit', liveness: 'off', expect: 'honest' },
  { id: 'other-day-room-camera', enrol: 'rwA_typical', resume: 'rwA2_other_typical', liveness: 'off', expect: 'within2' },
  { id: 'other-day-room-camera-dim', enrol: 'rwA_typical', resume: 'rwA2_other_dim', liveness: 'off', expect: 'honest' },
  // Active liveness (head turns) at check-in and at resume.
  { id: 'typical', enrol: 'rwTurnA_typical', resume: 'rwTurnA_typical_later', liveness: 'active', expect: 'first' },
  { id: 'dim', enrol: 'rwTurnA_typical', resume: 'rwTurnA_dim', liveness: 'active', expect: 'within2' },
  { id: 'other-day-room-camera', enrol: 'rwTurnA_typical', resume: 'rwTurnA2_other', liveness: 'active', expect: 'within2' },
];

const IMPOSTOR: ResumeCase[] = [
  { id: 'B-typical', enrol: 'rwA_typical', resume: 'rwB_typical', liveness: 'off', expect: 'never' },
  { id: 'B-dim', enrol: 'rwA_typical', resume: 'rwB_dim', liveness: 'off', expect: 'never' },
  { id: 'B-backlit', enrol: 'rwA_typical', resume: 'rwB_backlit', liveness: 'off', expect: 'never' },
  { id: 'family-son-for-father', enrol: 'rwDAD_typical', resume: 'rwSON_typical', liveness: 'off', expect: 'never' },
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
        const within = cs.expect === 'first' ? 1 : cs.expect === 'within2' ? 2 : 5;
        const pass = impostor ? r.final !== 'passed' : cs.expect === 'honest' ? !types.includes('identity_mismatch') : r.final === 'passed' && r.attempts <= within;
        recordMetric(testInfo, {
          scenario: impostor ? 'resume-impostor' : 'resume',
          case: cs.id,
          liveness: cs.liveness,
          rep,
          pass,
          target: cs.expect,
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
        // Genuine: never "a different person" in any light.
        expect(types, 'no identity_mismatch for the genuine candidate').not.toContain('identity_mismatch');
        expect(d.summary.hold?.reason ?? null).not.toBe('identity_mismatch');
        if (cs.expect === 'honest') {
          // Another day in poor light: "unable to verify" with guidance is an honest answer; a pass is welcome.
          if (r.final !== 'passed') {
            expect(r.guidance.flat().length, 'guidance to improve the view').toBeGreaterThan(0);
            return;
          }
        } else {
          expect(r.final, `genuine resume outcome after ${r.attempts} attempt(s): ${JSON.stringify(r.outcomes)} ${JSON.stringify(r.guidance)}`).toBe('passed');
          expect(r.attempts, `target: pass within ${within} attempt(s) (${cs.expect})`).toBeLessThanOrEqual(within);
        }
        await c.continueAfterCheck();
        await expect(c.tid('qnav-0')).toHaveClass(/answered/);
      } finally {
        await b1.close();
        if (b2 !== b1) await b2.close();
      }
    });
  }
}

import { CandidatePage } from '../lib/candidate';
import { RW_FIXTURES, SWAP_AT_SEC, SWAP_B_SEC, SWAP_DONE_SEC, type RwFixtureName } from '../lib/realistic';
import { checkWithRetries, createRwSession, launchRw, recordMetric, reps, rwPolicy, secs, skipUnlessRw, waitForCameraTime } from '../lib/realistic-run';
import { expect, test } from '../lib/test';

/**
 * Scenario 21 — a QUICK person swap right after the exam starts (the product owner's second complaint: "a person
 * swap right after exam start was NOT detected"), and a family member taking over (scenario 3, mid-exam).
 *
 * Realistic fake camera (lib/realistic.ts): candidate A in view from the camera start; the test starts the exam
 * `START_BEFORE_SWAP_SEC` before the fixture's swap (camera time 35 s), so the exam_start sample sees A and the
 * swap follows a few seconds later. Variants: A stands up and B sits down within ~2.6 s (gap), a 0.5 s
 * cross-dissolve (no gap: the face never disappears), A sliding out while B slides in (no gap, both half in
 * view), dim light, 1280×720 and 640×480, and the candidate's father replacing him (family look-alike).
 *
 * Measured: detection = the exam is held with reason identity_mismatch (default policy hold_for_review); delay from
 * the moment the new person is fully in view (and from the start of the transition) to the candidate's hold
 * screen; identity samples after the swap. Target: detected every run, median ≲ 20 s. Asserted: no identity
 * finding before the swap; held before the video loops back to A (~45 s); family look-alike and dim light: held, or
 * at least a staff-visible identity signal (non-matching check / identity event) within 30 s.
 */

const START_BEFORE_SWAP_SEC = 5;

interface SwapCase {
  id: string;
  fixture: RwFixtureName;
  kind: keyof typeof SWAP_DONE_SEC;
  family?: boolean;
  /**
   * What the product must at least do: 'hold' = held as identity_mismatch before the video loops back;
   * 'signal' = held, or a staff-visible identity signal (a non-matching identity check or an identity event) within
   * SIGNAL_WITHIN_SEC of the new person being in view (poor light never confirms a swap on its own, by design).
   */
  minimum: 'hold' | 'signal';
}

const SIGNAL_WITHIN_SEC = 30;

const CASES: SwapCase[] = [
  { id: 'gap-720p', fixture: 'rwSwapGap', kind: 'gap', minimum: 'hold' },
  { id: 'no-gap-crossfade-720p', fixture: 'rwSwapBlend', kind: 'blend', minimum: 'hold' },
  { id: 'gap-480p', fixture: 'rwSwapGap480', kind: 'gap', minimum: 'hold' },
  { id: 'no-gap-slide-480p', fixture: 'rwSwapSlide480', kind: 'slide', minimum: 'hold' },
  { id: 'dim-no-gap-crossfade-480p', fixture: 'rwSwapDimBlend480', kind: 'blend', minimum: 'signal' },
  { id: 'family-gap-720p', fixture: 'rwFamilySwap', kind: 'gap', family: true, minimum: 'signal' },
  { id: 'family-no-gap-crossfade-480p', fixture: 'rwFamilySwapBlend480', kind: 'blend', family: true, minimum: 'signal' },
];

for (const cs of CASES) {
  for (const rep of reps()) {
    test(`realistic swap right after exam start: ${cs.id} #${rep}`, async ({ staff }, testInfo) => {
      skipUnlessRw(cs.fixture);
      test.setTimeout(5 * 60_000);
      const s = await createRwSession(staff, rwPolicy({ liveness: 'off' }), `RW swap ${cs.id}`);
      const browser = await launchRw(cs.fixture);
      try {
        const c = await CandidatePage.open(browser, s.link);
        await c.consent();
        const ci = await checkWithRetries(c, { maxAttempts: 2 });
        expect(ci.final, `check-in: ${JSON.stringify(ci)}`).toBe('ready');
        const cam = (await c.lastCameraOpen())!;
        const readyAtSec = (Date.now() - cam.at) / 1000;
        // The check-in must end before the swap (it normally takes 10-25 s of the 35 s).
        expect(readyAtSec, 'check-in finished before the swap in the video').toBeLessThan(SWAP_AT_SEC - 2);

        /* ---------------- start the exam a few seconds before the swap */
        await waitForCameraTime(c, cam.at, SWAP_AT_SEC - START_BEFORE_SWAP_SEC);
        await c.tid('start-exam').click();
        await expect(c.tid('exam-screen')).toBeVisible({ timeout: 30_000 });
        const startedAt = Date.now();
        const swapStart = cam.at + SWAP_AT_SEC * 1000;
        const swapDone = cam.at + SWAP_DONE_SEC[cs.kind] * 1000;
        const deadline = swapDone + (SWAP_B_SEC - 1) * 1000; // then the video loops back to A

        /* ---------------- wait for the hold (or the end of B's time in view) */
        let heldAt: number | null = null;
        const until = Math.max(5_000, deadline - Date.now());
        await c.tid('hold-screen').waitFor({ state: 'visible', timeout: until }).then(
          () => (heldAt = Date.now()),
          () => undefined,
        );
        const d = await staff.session(s.sessionId);
        const events = await staff.events(s.sessionId);
        const mismatch = events.find((e) => e.type === 'identity_mismatch') ?? null;
        const before = d.identityChecks.filter((ch) => ch.at < swapStart && ch.trigger !== 'check_in');
        const after = d.identityChecks.filter((ch) => ch.at >= swapStart);
        const samplesAfter = c.apiLog.filter((l) => / sample /.test(l) && / complete=true /.test(l));
        // The candidate never sees the evidence state; the server's cadence hint ("send the next sample sooner") is the
        // closest candidate-side trace of a suspicion.
        const fasterRequested = c.apiLog.some((l) => / sample /.test(l) && / faster=yes /.test(l));
        const detected = d.summary.status === 'on_hold' && d.summary.hold?.reason === 'identity_mismatch';
        const staffVisible = after.some((ch) => ch.decision === 'mismatch' || ch.decision === 'inconclusive');
        // The first moment staff could see something: a non-matching identity check or an identity event after the swap.
        const signalTimes = [
          ...after.filter((ch) => ch.decision !== 'match').map((ch) => ch.at),
          ...events.filter((e) => e.type.startsWith('identity_') && e.startedAt >= swapStart).map((e) => e.startedAt),
        ];
        const signalAt = signalTimes.length ? Math.min(...signalTimes) : null;
        const falseAlarm = before.some((ch) => ch.decision === 'mismatch') || (mismatch != null && mismatch.startedAt < swapStart);
        recordMetric(testInfo, {
          scenario: cs.family ? 'family-swap' : 'swap',
          case: cs.id,
          rep,
          pass: !falseAlarm && (detected || (cs.minimum === 'signal' && signalAt != null && signalAt - swapDone <= SIGNAL_WITHIN_SEC * 1000)),
          fixture: cs.fixture,
          camera: `${cam.width}x${cam.height}`,
          checkinS: secs(ci.totalMs),
          checkinAttempts: ci.attempts,
          startBeforeSwapS: secs(swapStart - startedAt),
          detected,
          holdReason: d.summary.hold?.reason ?? null,
          delayFromNewPersonS: heldAt != null ? secs(heldAt - swapDone) : null,
          delayFromTransitionS: heldAt != null ? secs(heldAt - swapStart) : null,
          mismatchEventDelayS: mismatch ? secs(mismatch.startedAt - swapDone) : null,
          mismatchConfidence: mismatch?.confidence ?? null,
          falseAlarmBeforeSwap: falseAlarm,
          checksBeforeSwap: before.map((ch) => `${ch.trigger}:${ch.decision}${ch.similarity == null ? '' : `@${ch.similarity.toFixed(2)}`}`),
          checksAfterSwap: after.map((ch) => `+${secs(ch.at - swapDone)}s ${ch.trigger}:${ch.decision}${ch.similarity == null ? '' : `@${ch.similarity.toFixed(2)}`}`),
          fasterRequested,
          suspectSeen: fasterRequested,
          staffVisible,
          minimum: cs.minimum,
          staffSignalDelayS: signalAt != null ? secs(signalAt - swapDone) : null,
          identityEvents: events.filter((e) => e.type.startsWith('identity_')).map((e) => `${e.type}/${e.category}`),
          sampleAnswers: samplesAfter.slice(-12),
          about: RW_FIXTURES[cs.fixture].about,
        });

        expect(falseAlarm, `no identity finding before the swap: ${JSON.stringify(before)}`).toBe(false);
        if (cs.minimum === 'signal' && !detected) {
          // Minimum for a close relative / poor light: a staff-visible identity signal soon after the swap.
          expect(signalAt, `a staff-visible identity signal after the swap (checks after: ${JSON.stringify(after.map((x) => [x.trigger, x.decision, x.similarity]))})`).not.toBeNull();
          expect((signalAt! - swapDone) / 1000, 'signal delay (s)').toBeLessThanOrEqual(SIGNAL_WITHIN_SEC);
          return;
        }
        expect(detected, `held as identity_mismatch within ${SWAP_B_SEC} s of the swap (checks after: ${JSON.stringify(after.map((x) => [x.trigger, x.decision, x.similarity]))})`).toBe(true);
        expect(mismatch?.category).toBe('integrity');
        await expect(c.tid('hold-screen')).not.toContainText(/cheat|fraud|impostor/i);
      } finally {
        await browser.close();
      }
    });
  }
}

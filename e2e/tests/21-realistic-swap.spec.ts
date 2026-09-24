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
 * finding before the swap; detected before the video loops back to A (~45 s); family: detected or at least
 * 'suspect' and staff-visible (non-matching identity checks on the session).
 */

const START_BEFORE_SWAP_SEC = 5;

interface SwapCase {
  id: string;
  fixture: RwFixtureName;
  kind: keyof typeof SWAP_DONE_SEC;
  family?: boolean;
}

const CASES: SwapCase[] = [
  { id: 'gap-720p', fixture: 'rwSwapGap', kind: 'gap' },
  { id: 'no-gap-crossfade-720p', fixture: 'rwSwapBlend', kind: 'blend' },
  { id: 'gap-480p', fixture: 'rwSwapGap480', kind: 'gap' },
  { id: 'no-gap-slide-480p', fixture: 'rwSwapSlide480', kind: 'slide' },
  { id: 'dim-no-gap-crossfade-480p', fixture: 'rwSwapDimBlend480', kind: 'blend' },
  { id: 'family-gap-720p', fixture: 'rwFamilySwap', kind: 'gap', family: true },
  { id: 'family-no-gap-crossfade-480p', fixture: 'rwFamilySwapBlend480', kind: 'blend', family: true },
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
        const evidenceStates = [...new Set(c.apiLog.map((l) => / evidence=([a-z_]+):/.exec(l)?.[1]).filter(Boolean))];
        const detected = d.summary.status === 'on_hold' && d.summary.hold?.reason === 'identity_mismatch';
        const staffVisible = after.some((ch) => ch.decision === 'mismatch' || ch.decision === 'inconclusive');
        const falseAlarm = before.some((ch) => ch.decision === 'mismatch') || (mismatch != null && mismatch.startedAt < swapStart);
        recordMetric(testInfo, {
          scenario: cs.family ? 'family-swap' : 'swap',
          case: cs.id,
          rep,
          pass: detected && !falseAlarm,
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
          evidenceStates,
          suspectSeen: evidenceStates.includes('suspect') || evidenceStates.includes('confirmed_mismatch'),
          staffVisible,
          sampleAnswers: samplesAfter.slice(-12),
          about: RW_FIXTURES[cs.fixture].about,
        });

        expect(falseAlarm, `no identity finding before the swap: ${JSON.stringify(before)}`).toBe(false);
        if (cs.family && !detected) {
          // Minimum for a close relative: the evidence became 'suspect' and staff see non-matching checks.
          expect(evidenceStates, 'family look-alike: at least suspect').toEqual(expect.arrayContaining(['suspect']));
          expect(staffVisible, 'family look-alike: non-matching identity checks visible to staff').toBe(true);
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

import { CandidatePage } from '../lib/candidate';
import { RW_FIXTURES, type RwFixtureName } from '../lib/realistic';
import { checkWithRetries, createRwSession, launchRw, recordMetric, reps, rwPolicy, secs, skipUnlessRw } from '../lib/realistic-run';
import { expect, test } from '../lib/test';

/**
 * Scenario 22 — the genuine candidate for several minutes under realistic webcam conditions: the light changes
 * (lamp off → dim, side lamp, window light), the head sways and glances around the screen (short ~5–8° turns),
 * the video loops every 60–90 s (a small jump, like shifting in the chair). Product default identity policy
 * (6 s start-up samples for 3 minutes, then every 15 s, bursts of 3).
 *
 * Asserted: ZERO identity_mismatch and no hold. Recorded: samples and their decisions, lowest similarity,
 * identity_unverifiable (allowed: an honest "cannot tell" in poor light), lighting observations.
 */

const MINUTES = Number(process.env.E2E_RW_LONG_MIN || 5);

const CASES: { id: string; fixture: RwFixtureName }[] = [
  { id: 'typical-with-light-changes', fixture: 'rwGenuineLong' },
  { id: 'mostly-dim', fixture: 'rwGenuineDim' },
];

for (const cs of CASES) {
  for (const rep of reps()) {
    test(`realistic genuine candidate ${MINUTES} min: ${cs.id} #${rep}`, async ({ staff }, testInfo) => {
      skipUnlessRw(cs.fixture);
      test.setTimeout((MINUTES + 4) * 60_000);
      const s = await createRwSession(staff, rwPolicy({ liveness: 'off' }), `RW genuine ${cs.id}`);
      const browser = await launchRw(cs.fixture);
      try {
        const c = await CandidatePage.open(browser, s.link);
        await c.consent();
        const ci = await checkWithRetries(c, { maxAttempts: 3 });
        expect(ci.final, `check-in: ${JSON.stringify(ci)}`).toBe('ready');
        const cam = (await c.lastCameraOpen())!;
        await c.startExam();
        const t0 = Date.now();
        await c.answerStandardQuestions();

        /* ---------------- the exam runs: watch for holds */
        let heldAt: number | null = null;
        while (Date.now() - t0 < MINUTES * 60_000) {
          await c.page.waitForTimeout(15_000);
          if (await c.tid('hold-screen').isVisible().catch(() => false)) {
            heldAt = Date.now();
            break;
          }
        }
        const d = await staff.session(s.sessionId);
        const events = await staff.events(s.sessionId);
        const samples = d.identityChecks.filter((ch) => ch.at >= t0 - 2_000 && ch.trigger !== 'check_in');
        const hist: Record<string, number> = {};
        for (const ch of samples) hist[ch.decision] = (hist[ch.decision] ?? 0) + 1;
        const trig: Record<string, number> = {};
        for (const ch of samples) trig[ch.trigger] = (trig[ch.trigger] ?? 0) + 1;
        const sims = samples.map((ch) => ch.similarity).filter((x): x is number => x != null);
        const count = (t: string) => events.filter((e) => e.type === t).length;
        const mismatches = count('identity_mismatch');
        recordMetric(testInfo, {
          scenario: 'genuine-long',
          case: cs.id,
          rep,
          pass: mismatches === 0 && heldAt == null,
          fixture: cs.fixture,
          camera: `${cam.width}x${cam.height}`,
          minutes: secs(Date.now() - t0)! / 60,
          checkinAttempts: ci.attempts,
          checkinS: secs(ci.totalMs),
          samples: samples.length,
          decisions: hist,
          triggers: trig,
          minSimilarity: sims.length ? Math.min(...sims) : null,
          medianSimilarity: sims.length ? [...sims].sort((a, b) => a - b)[Math.floor(sims.length / 2)] : null,
          identityMismatch: mismatches,
          identityUnverifiable: count('identity_unverifiable'),
          lightingUnusable: count('lighting_unusable'),
          heldAfterS: heldAt ? secs(heldAt - t0) : null,
          holdReason: d.summary.hold?.reason ?? null,
          eventTypes: [...new Set(events.map((e) => e.type))],
          evidenceStates: [...new Set(c.apiLog.map((l) => / evidence=([a-z_]+):/.exec(l)?.[1]).filter(Boolean))],
          about: RW_FIXTURES[cs.fixture].about,
        });
        expect(mismatches, `identity_mismatch for the genuine candidate (decisions ${JSON.stringify(hist)})`).toBe(0);
        expect(heldAt, `held after ${heldAt ? secs(heldAt - t0) : '-'} s (${d.summary.hold?.reason})`).toBeNull();
        expect(d.summary.status).toBe('active');
      } finally {
        await browser.close();
      }
    });
  }
}

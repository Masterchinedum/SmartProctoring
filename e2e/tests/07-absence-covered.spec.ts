import { CandidatePage, launchCamera, since, skipUnlessFixtures } from '../lib/candidate';
import { expect, test } from '../lib/test';

/**
 * Scenario 7 — the candidate leaves and returns; the lens is covered.
 * Fake camera (seconds since camera start): A 0–50, empty room 50–66, A 66–91, black 91–105, A after.
 * Expected: ONE candidate_absent event with start ≈ 50 s and end ≈ 66 s, followed by a face_return
 * identity check against the reference; ONE camera_covered event for the covered lens.
 */
test('absence (with face-return identity check) and covered lens', async ({ staff }) => {
  skipUnlessFixtures('absence');
  test.setTimeout(4 * 60_000);
  const s = await staff.createSession({ policy: { detection: { absenceSec: 4, coveredSec: 3 } } });
  const browser = await launchCamera('absence');
  try {
    const c = await CandidatePage.open(browser, s.link);
    await c.consent();
    const t0 = Date.now();
    await c.runCheck();
    await c.startExam();
    await c.answerStandardQuestions();
    expect(Date.now() - t0).toBeLessThan(45_000);

    /* ---------------- absence: one event with start and end */
    const absent = await staff.waitForEvent(s.sessionId, (e) => e.type === 'candidate_absent' && e.status === 'closed', { timeout: 100_000, message: 'closed candidate_absent' });
    const rel = (t: number) => Math.round((t - t0) / 1000);
    console.log(`candidate_absent +${rel(absent.startedAt)}..+${rel(absent.endedAt!)} s`);
    expect(absent.category).toBe('integrity');
    expect(absent.startedAt - t0).toBeGreaterThan(46_000);
    expect(absent.startedAt - t0).toBeLessThan(58_000);
    expect(absent.endedAt! - t0).toBeGreaterThan(62_000);
    expect(absent.endedAt! - t0).toBeLessThan(76_000);
    expect(absent.durationMs).toBe(absent.endedAt! - absent.startedAt);
    expect(absent.evidence.some((e) => e.kind === 'event_screenshot')).toBe(true);

    // The returning face is compared with the protected reference.
    const d = await staff.waitForSession(s.sessionId, (x) => x.identityChecks.some((ch) => ch.trigger === 'face_return' && ch.at >= absent.startedAt), { timeout: 30_000 });
    const ret = d.identityChecks.find((ch) => ch.trigger === 'face_return')!;
    console.log(`face_return check +${rel(ret.at)} s: ${ret.decision} ${ret.similarity}`);
    expect(ret.decision).toBe('match');
    expect(ret.context.precededBy.join(' ')).toMatch(/absen|face/i);

    /* ---------------- covered lens */
    const covered = await staff.waitForEvent(s.sessionId, (e) => e.type === 'camera_covered' && e.status === 'closed', { timeout: 90_000, message: 'closed camera_covered' });
    console.log(`camera_covered +${rel(covered.startedAt)}..+${rel(covered.endedAt!)} s`);
    expect(covered.startedAt - t0).toBeGreaterThan(87_000);
    expect(covered.startedAt - t0).toBeLessThan(100_000);
    expect(covered.endedAt! - t0).toBeLessThan(115_000);

    /* ---------------- one event per episode; the exam carried on */
    await c.page.waitForTimeout(5_000);
    const events = await staff.events(s.sessionId);
    const absences = events.filter((e) => e.type === 'candidate_absent' && e.startedAt < t0 + 80_000);
    expect(absences, 'one absence event for the empty-room episode').toHaveLength(1);
    expect(events.filter((e) => e.type === 'camera_covered')).toHaveLength(1);
    expect(events.some((e) => e.type === 'identity_mismatch')).toBe(false);
    expect((await staff.session(s.sessionId)).summary.status).toBe('active');
    await expect(c.tid('exam-screen')).toBeVisible();
    console.log(`done ${since(t0)}; event types: ${[...new Set(events.map((e) => e.type))].join(', ')}`);
  } finally {
    await browser.close();
  }
});

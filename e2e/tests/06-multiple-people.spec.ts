import { request } from '@playwright/test';
import { CandidatePage, launchCamera, since, skipUnlessFixtures } from '../lib/candidate';
import { BASE_URL } from '../lib/config';
import { expect, test } from '../lib/test';

/**
 * Scenario 6 — more than one person in view. Fake camera: A for 50 s, A and a second person for 20 s,
 * then A alone. Expected: ONE multiple_people event (integrity, high) spanning the second person's
 * presence, with a webcam screenshot from that moment; the screenshot is served to staff as a JPEG and
 * refused without staff authentication.
 */
test('multiple people: one event with a screenshot; evidence is staff-only', async ({ staff }) => {
  skipUnlessFixtures('two');
  const s = await staff.createSession({ policy: { detection: { multiplePeopleSec: 1 } } });
  const browser = await launchCamera('two');
  try {
    const c = await CandidatePage.open(browser, s.link);
    await c.consent();
    const t0 = Date.now();
    await c.runCheck();
    await c.startExam();
    await c.answerStandardQuestions();
    expect(Date.now() - t0).toBeLessThan(45_000);

    const ev = await staff.waitForEvent(s.sessionId, (e) => e.type === 'multiple_people' && e.status === 'closed', { timeout: 110_000, message: 'closed multiple_people event' });
    console.log(`multiple_people ${new Date(ev.startedAt).toISOString()} +${Math.round((ev.startedAt - t0) / 1000)} s, ${Math.round(ev.durationMs! / 1000)} s`);
    expect(ev.category).toBe('integrity');
    expect(ev.severity).toBe('high');
    // Started when the second person appeared (~50 s after camera start) and lasted ~20 s.
    expect(ev.startedAt - t0).toBeGreaterThan(45_000);
    expect(ev.startedAt - t0).toBeLessThan(62_000);
    expect(ev.durationMs!).toBeGreaterThan(12_000);
    expect(ev.durationMs!).toBeLessThan(32_000);
    expect(ev.confidence!).toBeGreaterThan(0.5);
    expect(ev.status).toBe('closed');
    // One ongoing issue = one event (no duplicates).
    const all = (await staff.events(s.sessionId)).filter((e) => e.type === 'multiple_people');
    expect(all).toHaveLength(1);

    /* ---------------- screenshot from the relevant moment */
    const shot = ev.evidence.find((e) => e.kind === 'event_screenshot');
    expect(shot, 'event screenshot').toBeTruthy();
    expect(shot!.capturedAt).toBeGreaterThanOrEqual(ev.startedAt - 1000);
    expect(shot!.capturedAt).toBeLessThanOrEqual(ev.endedAt! + 1000);
    const res = await staff.raw(shot!.url);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('image/jpeg');
    expect(res.headers()['cache-control']).toMatch(/no-store/);
    const body = await res.body();
    expect(body.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    expect(body.length).toBeGreaterThan(5_000);

    // Without staff authentication: 401 (candidate token does not help either).
    const anon = await request.newContext({ baseURL: BASE_URL });
    expect((await anon.get(shot!.url)).status()).toBe(401);
    expect((await anon.get(shot!.url, { headers: { Authorization: `Bearer ${s.token}` } })).status()).toBe(401);
    await anon.dispose();

    // The evidence view was audit-logged.
    const audit = await staff.json<{ items: { action: string; targetId: string | null }[] }>('get', '/api/admin/audit-log?action=evidence.view&limit=50');
    expect(audit.items.some((a) => a.targetId === shot!.id)).toBe(true);

    // After the second person left, the candidate's identity was re-checked against the reference.
    const d = await staff.waitForSession(s.sessionId, (x) => x.identityChecks.some((ch) => ch.trigger === 'after_multiple_people'), { timeout: 30_000 });
    const after = d.identityChecks.find((ch) => ch.trigger === 'after_multiple_people')!;
    expect(['match', 'unable_to_verify', 'inconclusive']).toContain(after.decision);
    expect(d.identityChecks.some((ch) => ch.decision === 'mismatch')).toBe(false);
    expect(d.summary.status).toBe('active');
    console.log(`done ${since(t0)}`);
  } finally {
    await browser.close();
  }
});

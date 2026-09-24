import { CandidatePage, launchCamera, since, skipUnlessFixtures } from '../lib/candidate';
import { expect, test } from '../lib/test';

/**
 * Scenario 5 — identity continuity across a pause.
 *  a) Candidate A checks in and pauses; the exam is resumed from another browser whose camera shows B
 *     ⇒ the resume check compares B with A's protected reference ⇒ held for review, with before/after
 *     evidence (reference image vs. resume image) and the pause as context.
 *  b) A resumes in a dim room: the image is not good enough for a dependable comparison ⇒ "unable to
 *     verify": guidance to improve the view and a retry — never labelled a different person.
 */
test('resume by a different person is held with before/after evidence', async ({ staff, staffPage }) => {
  skipUnlessFixtures('a', 'b');
  const s = await staff.createSession({ policy: { identity: { onMismatch: 'hold_for_review' } } });
  const browserA = await launchCamera('a');
  const browserB = await launchCamera('b');
  try {
    const a = await CandidatePage.open(browserA, s.link);
    await a.checkInAndStart();
    await a.answerStandardQuestions();
    await a.pause('Short break');
    await a.close();

    /* ---------------- someone else resumes (another device, another camera) */
    const b = await CandidatePage.open(browserB, s.link);
    await expect(b.tid('paused-screen')).toBeVisible();
    await b.tid('resume-button').click();
    expect(await b.runCheck({ purpose: 'resume' })).toBe('hold');
    await expect(b.tid('hold-screen')).toContainText('Your exam is on hold');
    await expect(b.tid('hold-screen')).not.toContainText(/cheat|fraud|impostor|different person/i);
    await expect(b.tid('reverify-button')).toHaveCount(0);
    // Nothing of the exam is served to the held browser.
    await expect(b.tid('exam-screen')).toHaveCount(0);

    /* ---------------- staff: held for review, with before/after evidence */
    const d = await staff.waitForSession(s.sessionId, (x) => x.summary.status === 'on_hold');
    expect(d.summary.hold?.reason).toBe('identity_mismatch');
    const resumeCheck = d.identityChecks.find((ch) => ch.trigger === 'resume');
    expect(resumeCheck?.decision).toBe('mismatch');
    expect(resumeCheck?.probeEvidence).not.toBeNull();
    expect(d.identityChecks.filter((ch) => ch.decision === 'unable_to_verify')).toHaveLength(0);
    const ev = await staff.waitForEventType(s.sessionId, 'identity_mismatch');
    expect(ev.category).toBe('integrity');
    expect(ev.severity).toBe('high');
    expect(ev.observation).toMatch(/may/); // observational wording, not a verdict
    expect(JSON.stringify(ev.context)).toMatch(/pause/i);

    const cmp = await staff.compare(ev.id);
    expect(cmp.reference.images.length).toBeGreaterThan(0);
    expect(cmp.probes.some((p) => p.image?.available)).toBe(true);
    expect(cmp.similarity.max!).toBeLessThan(cmp.similarity.thresholds.mismatch);
    expect(cmp.surrounding.some((it) => it.kind === 'period' && it.period.kind === 'paused')).toBe(true);
    for (const img of [cmp.reference.images[0], cmp.probes.find((p) => p.image)!.image!]) {
      const res = await staff.raw(img.url);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toBe('image/jpeg');
    }

    /* ---------------- staff UI: comparison view shows both sides and the pause */
    const sp = await staffPage();
    await sp.goto(`/admin/sessions/${s.sessionId}/compare/${ev.id}`);
    await expect(sp.locator('img[src*="/api/admin/evidence/"]').first()).toBeVisible();
    expect(await sp.locator('img[src*="/api/admin/evidence/"]').count()).toBeGreaterThanOrEqual(2);
    await expect(sp.getByText(/paused/i).first()).toBeVisible();
  } finally {
    await browserA.close();
    await browserB.close();
  }
});

test('resume in a dim room: unable to verify, guidance and retry — never a different person', async ({ staff }) => {
  skipUnlessFixtures('a', 'dimThenLight');
  const s = await staff.createSession();
  const browserA = await launchCamera('a');
  const browserDim = await launchCamera('dimThenLight');
  try {
    const a = await CandidatePage.open(browserA, s.link);
    await a.checkInAndStart();
    await a.answerStandardQuestions();
    await a.pause();
    await a.close();

    /* ---------------- resume in a dim room (camera: dim for 30 s, then the light goes on) */
    const c = await CandidatePage.open(browserDim, s.link);
    await c.tid('resume-button').click();
    await expect(c.tid('check-intro')).toHaveAttribute('data-purpose', 'resume');
    await c.tid('check-intro-continue').click();
    const t0 = Date.now(); // camera start
    await c.passReadiness(); // dim, but good enough for the browser's own checklist
    // The server cannot use the images: guidance while it keeps trying, then a retry screen.
    await expect(c.tid('verify-guidance')).toContainText(/light/i, { timeout: 30_000 });
    await expect(c.tid('check-retry')).toBeVisible({ timeout: 30_000 });
    console.log(`retry screen after ${since(t0)}`);
    expect(Date.now() - t0).toBeLessThan(29_000); // still dim: this is the dim-room result
    await expect(c.tid('check-retry')).toContainText('We could not verify your identity from these images');
    await expect(c.tid('check-retry-guidance')).toContainText(/light/i);
    await expect(c.tid('check-retry')).toContainText(/Attempts remaining:\s*4/);
    await expect(c.tid('check-retry')).not.toContainText(/different person|not match/i);

    let d = await staff.waitForSession(s.sessionId, (x) => x.identityChecks.some((ch) => ch.trigger === 'resume'));
    expect(d.summary.status).toBe('paused');
    const first = d.identityChecks.find((ch) => ch.trigger === 'resume')!;
    expect(first.decision).toBe('unable_to_verify');
    expect(first.quality?.issues.length).toBeGreaterThan(0);

    /* ---------------- the candidate improves the light and tries again */
    const wait = 33_000 - (Date.now() - t0);
    if (wait > 0) await c.page.waitForTimeout(wait);
    await c.tid('check-try-again').click();
    expect(await c.waitForCheckOutcome(60_000)).toBe('passed');
    await c.continueAfterCheck();
    await expect(c.tid('question')).toContainText('bell-shaped');
    await expect(c.tid('qnav-0')).toHaveClass(/answered/);

    d = await staff.waitForSession(s.sessionId, (x) => x.summary.status === 'active');
    const resumes = d.identityChecks.filter((ch) => ch.trigger === 'resume').map((ch) => ch.decision);
    expect(resumes).toEqual(['unable_to_verify', 'match']);
    expect(d.identityChecks.some((ch) => ch.decision === 'mismatch')).toBe(false);
    const events = await staff.events(s.sessionId);
    expect(events.some((e) => e.type === 'identity_mismatch')).toBe(false);
    expect(events.some((e) => e.type === 'session_held')).toBe(false);
  } finally {
    await browserA.close();
    await browserDim.close();
  }
});

/**
 * 5c — the room goes dark DURING the exam (camera: A, dark from 50 s to 90 s, then light again).
 * The image is too dark for dependable monitoring or comparison: the candidate is guided to add light,
 * an UNCERTAIN lighting observation spans the dark period, monitoring is shown as limited, and no identity
 * verdict is drawn from unusable images — never a mismatch, never a hold. When the light is back, routine
 * identity samples match again.
 */
test('room goes dark mid-exam: uncertain lighting observation with guidance — never a different person', async ({ staff }) => {
  skipUnlessFixtures('darkPeriod');
  test.setTimeout(4 * 60_000);
  const s = await staff.createSession({ policy: { identity: { periodicCheckIntervalSec: 10 } } });
  const browser = await launchCamera('darkPeriod');
  try {
    const c = await CandidatePage.open(browser, s.link);
    await c.consent();
    const t0 = Date.now();
    await c.runCheck();
    await c.startExam();
    await c.answerStandardQuestions();

    /* ---------------- dark: guidance, limited monitoring, uncertain observation */
    await expect(c.tid('candidate-prompt').filter({ hasText: 'Your face is too dark' })).toBeVisible({ timeout: 80_000 });
    expect(Date.now() - t0).toBeGreaterThan(50_000);
    await expect(c.tid('monitoring-status')).toContainText('Monitoring limited', { timeout: 20_000 });
    const lighting = await staff.waitForEventType(s.sessionId, 'lighting_unusable', { timeout: 30_000 });
    expect(lighting.category).toBe('uncertain');
    expect(Math.abs(lighting.startedAt - (t0 + 50_000))).toBeLessThan(8_000);

    /* ---------------- light again: the observation closes, identity matches again */
    const closed = await staff.waitForEvent(s.sessionId, (e) => e.type === 'lighting_unusable' && e.status === 'closed', { timeout: 60_000 });
    console.log(`lighting_unusable +${Math.round((closed.startedAt - t0) / 1000)}..+${Math.round((closed.endedAt! - t0) / 1000)} s`);
    expect(Math.abs(closed.endedAt! - (t0 + 90_000))).toBeLessThan(8_000);
    await expect(c.tid('candidate-prompt').filter({ hasText: 'Your face is too dark' })).toHaveCount(0, { timeout: 20_000 });
    await expect(c.tid('monitoring-status')).toContainText('Monitoring active', { timeout: 20_000 });
    const d = await staff.waitForSession(s.sessionId, (x) => x.identityChecks.some((ch) => ch.at > closed.endedAt! && ch.decision === 'match'), { timeout: 40_000 });
    expect(d.identityChecks.some((ch) => ch.decision === 'mismatch')).toBe(false);
    expect(d.summary.status).toBe('active');
    const events = await staff.events(s.sessionId);
    expect(events.some((e) => e.type === 'identity_mismatch' || e.type === 'session_held')).toBe(false);
    expect(events.filter((e) => e.type === 'lighting_unusable')).toHaveLength(1);
  } finally {
    await browser.close();
  }
});

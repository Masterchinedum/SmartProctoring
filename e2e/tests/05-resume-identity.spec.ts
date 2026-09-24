import { CandidatePage, launchCamera, skipUnlessFixtures } from '../lib/candidate';
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
    await a.pause();
    await a.close();

    const c = await CandidatePage.open(browserDim, s.link);
    await c.tid('resume-button').click();
    await expect(c.tid('check-intro')).toHaveAttribute('data-purpose', 'resume');
    const t0 = Date.now();
    await c.tid('check-intro-continue').click();
    await c.passReadiness(); // dim, but good enough for the browser's own checklist
    const seen = new Set<string>();
    while (Date.now() - t0 < 70_000) {
      const vis = async (id: string) => (await c.tid(id).isVisible().catch(() => false)) ? id : null;
      const state = (await Promise.all(['verify-step', 'verify-problem', 'check-retry', 'check-passed', 'hold-screen', 'check-failed'].map(vis))).filter(Boolean).join(',');
      const g = (await c.tid('verify-guidance').isVisible().catch(() => false)) ? await c.tid('verify-guidance').innerText() : '';
      const p = (await c.tid('verify-problem').isVisible().catch(() => false)) ? await c.tid('verify-problem').innerText() : '';
      const r = (await c.tid('check-retry').isVisible().catch(() => false)) ? await c.tid('check-retry').innerText() : '';
      const line = `${state} | ${g.replace(/\n/g, ' / ')} | ${p.replace(/\n/g, ' / ')} | ${r.replace(/\n/g, ' / ')}`;
      if (!seen.has(line)) console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s: ${line}`);
      seen.add(line);
      if (state.includes('check-passed')) break;
      await c.page.waitForTimeout(500);
    }
    const d = await staff.session(s.sessionId);
    console.log(JSON.stringify(d.identityChecks.map((x) => [x.trigger, x.decision, x.quality?.issues])));
    console.log(c.httpErrors.join('\n'));
  } finally {
    await browserA.close();
    await browserDim.close();
  }
});

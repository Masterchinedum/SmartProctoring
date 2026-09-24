import { CandidatePage, launchCamera, since, skipUnlessFixtures } from '../lib/candidate';
import { expect, test } from '../lib/test';

const DEBUG = process.env.E2E_DEBUG === '1';

/**
 * Scenario 3 — active liveness with a still photo in front of the camera (the fake camera is a still
 * image with sensor noise and a few pixels of jitter: it cannot turn its head).
 * Expected: the guided check cannot progress past the head-turn step; the attempt is handed to the
 * server, which records a failed live-person check and returns retry guidance; the session never becomes
 * ready; after the configured attempts the exam is held for human review as "could not verify" (never
 * as a different person). Staff see every failed attempt.
 */
test('active liveness: a still photo cannot pass; attempts recorded; held for review', async ({ staff, staffPage }) => {
  skipUnlessFixtures('a');
  test.setTimeout(5 * 60_000);
  const s = await staff.createSession({ policy: { identity: { liveness: 'active', livenessSteps: 2, maxVerificationAttempts: 2 } } });
  const browser = await launchCamera('a');
  try {
    const c = await CandidatePage.open(browser, s.link);
    await c.consent();
    await c.passReadiness();
    const t0 = Date.now();

    /* ---------------- attempt 1: stuck at the head-turn instruction */
    await expect(c.tid('verify-step')).toHaveAttribute('data-phase', 'liveness', { timeout: 60_000 });
    await expect(c.tid('verify-instruction')).toContainText(/turn your head/i, { timeout: 20_000 });
    await c.page.waitForTimeout(10_000);
    await expect(c.tid('verify-instruction')).toContainText(/turn your head/i);
    await expect(c.tid('ready-screen')).toHaveCount(0);
    expect((await staff.session(s.sessionId)).summary.status).toBe('invited');

    // No progress → the attempt goes to the server → retry guidance.
    await expect(c.tid('check-retry')).toBeVisible({ timeout: 60_000 });
    console.log(`attempt 1 ended after ${since(t0)}`);
    await expect(c.tid('check-retry')).toContainText('We could not confirm the live head movements');
    await expect(c.tid('check-retry')).toContainText(/Attempts remaining:\s*1/);
    await expect(c.tid('check-try-again')).toBeVisible();

    let d = await staff.waitForSession(s.sessionId, (x) => x.identityChecks.filter((ch) => ch.trigger === 'check_in').length >= 1);
    expect(d.summary.status).toBe('invited');
    expect(d.references).toHaveLength(0);
    const first = d.identityChecks.find((ch) => ch.trigger === 'check_in')!;
    expect(first.decision).toBe('unable_to_verify');

    /* ---------------- attempt 2: same result → held for review (not "different person") */
    await c.tid('check-try-again').click();
    await expect(c.tid('verify-step')).toHaveAttribute('data-phase', 'liveness', { timeout: 60_000 });
    const outcome = await c.waitForCheckOutcome(90_000);
    expect(outcome).toBe('hold');
    await expect(c.tid('hold-screen')).toContainText('Your exam is on hold');

    d = await staff.waitForSession(s.sessionId, (x) => x.summary.status === 'on_hold');
    expect(d.summary.hold?.reason).toBe('identity_unverifiable');
    expect(d.references).toHaveLength(0);
    const attempts = d.identityChecks.filter((ch) => ch.trigger === 'check_in');
    expect(attempts).toHaveLength(2);
    expect(attempts.every((ch) => ch.decision === 'unable_to_verify')).toBe(true);
    const events = await staff.events(s.sessionId);
    const unverifiable = events.find((e) => e.type === 'identity_unverifiable');
    expect(unverifiable?.category).toBe('uncertain');
    expect(unverifiable?.details).toMatchObject({ attempts: 2, lastReason: 'liveness_failed', livenessPassed: false });
    expect(events.some((e) => e.type === 'identity_mismatch')).toBe(false);
    expect(events.some((e) => e.type === 'reference_created' || e.type === 'checkin_completed')).toBe(false);

    /* ---------------- staff see the failed attempts (Identity tab) */
    const sp = await staffPage();
    await sp.goto(`/admin/sessions/${s.sessionId}?tab=identity`);
    const checks = sp.locator('section', { has: sp.getByRole('heading', { name: 'Identity checks' }) });
    await expect(checks.getByText('Could not verify (image quality)').first()).toBeVisible();
    await expect(sp.getByText('Identity could not be verified after repeated attempts').first()).toBeVisible();
  } finally {
    await browser.close();
  }
});

/**
 * Scenario 3b — the passing path: a live (turning) person. Fake camera: candidate A frontal for 10 s,
 * then cycles of turning left and right (synthetic parallax between nose and eyes, identity preserved —
 * see scripts/synth-headturn.ts). Both the initial check and a resume check with active liveness pass.
 */
test('active liveness: a turning head passes at check-in and at resume', async ({ staff }) => {
  skipUnlessFixtures('headturn');
  test.setTimeout(5 * 60_000);
  const s = await staff.createSession({ policy: { identity: { liveness: 'active', livenessSteps: 2 } } });
  const browser = await launchCamera('headturn');
  const trace = async (c: CandidatePage, label: string, until: () => Promise<boolean>, timeoutMs: number) => {
    const t0 = Date.now();
    let last = '';
    while (Date.now() - t0 < timeoutMs) {
      if (await until()) return;
      const phase = await c.tid('verify-step').getAttribute('data-phase', { timeout: 1000 }).catch(() => null);
      const instr = (await c.tid('verify-instruction').innerText({ timeout: 1000 }).catch(() => '')).replace(/\s+/g, ' ');
      const line = `${phase} | ${instr}`;
      if (line !== last && DEBUG) console.log(`[${label}] +${((Date.now() - t0) / 1000).toFixed(1)} s ${line}`);
      last = line;
      await c.page.waitForTimeout(500);
    }
  };
  try {
    let c = await CandidatePage.open(browser, s.link);
    const logVerdicts = (page: typeof c.page) =>
      page.on('response', async (r) => {
        if (/\/checks\/[^/]+\/(complete|frames)/.test(r.url())) {
          const b = await r.json().catch(() => null);
          if (r.url().includes('/complete')) console.log(`complete: ${b?.outcome} liveness=${JSON.stringify(b?.liveness)} guidance=${JSON.stringify(b?.guidance)}`);
          else if (DEBUG) console.log(`frame ${new URL(r.url()).searchParams.get('step')}: accepted=${b?.accepted} satisfied=${b?.stepSatisfied} measured=${JSON.stringify(b?.measured)} client=${new URL(r.url()).searchParams.get('clientYaw')}`);
        }
      });
    logVerdicts(c.page);
    await c.consent();
    await c.passReadiness();
    const anyOutcome = () => c.page.locator('[data-testid="ready-screen"], [data-testid="check-retry"], [data-testid="hold-screen"], [data-testid="check-passed"]').first().isVisible();
    await trace(c, 'initial', anyOutcome, 120_000);
    expect(await c.waitForCheckOutcome(1_000)).toBe('ready');

    const d = await staff.session(s.sessionId);
    expect(d.summary.status).toBe('ready');
    expect(d.references).toHaveLength(1);
    expect(d.references[0].liveness?.passed).toBe(true);
    const types = (await staff.events(s.sessionId)).map((e) => e.type);
    expect(types).toContain('reference_created');
    expect(types).toContain('checkin_completed');
    const checkin = (await staff.events(s.sessionId)).find((e) => e.type === 'checkin_completed')!;
    expect(checkin.details.liveness).toBe('passed');

    await c.startExam();
    await c.gotoQuestion(0);
    await c.page.getByRole('radio', { name: 'Mean' }).check();
    await c.pause();
    await c.close();

    /* ---------------- resume with active liveness (the camera restarts: frontal, then turning) */
    c = await CandidatePage.open(browser, s.link);
    await c.tid('resume-button').click();
    await c.tid('check-intro-continue').click();
    await c.passReadiness();
    await trace(c, 'resume', anyOutcome, 120_000);
    expect(await c.waitForCheckOutcome(1_000)).toBe('passed');
    await c.continueAfterCheck();
    await expect(c.tid('qnav-0')).toHaveClass(/answered/);
    const after = await staff.waitForSession(s.sessionId, (x) => x.summary.status === 'active');
    expect(after.identityChecks.find((ch) => ch.trigger === 'resume')?.decision).toBe('match');
  } finally {
    await browser.close();
  }
});

/**
 * Scenario 3c — a tampered client (script in the page's origin, same camera) submits the still photo for
 * EVERY liveness step and claims the requested head pose. The server measures the pose itself (no
 * nose-vs-eyes parallax in a flat photo) and must reject the attempt: never ready.
 */
test('active liveness: a tampered client sending the photo for every step is rejected by the server', async ({ staff }) => {
  skipUnlessFixtures('a');
  const s = await staff.createSession({ policy: { identity: { liveness: 'active', livenessSteps: 2, maxVerificationAttempts: 3 } } });
  const browser = await launchCamera('a');
  try {
    const c = await CandidatePage.open(browser, s.link);
    await c.consent(); // consent is recorded; the tampered script then drives the check API directly
    const page = await c.context.newPage();
    await page.goto('/mediapipe/vision_wasm_internal.js'); // any same-origin document (secure context)
    const result = await page.evaluate(async (tok: string) => {
      const inst = `tamper-${crypto.randomUUID()}`;
      const H: Record<string, string> = { Authorization: `Bearer ${tok}`, 'X-Client-Instance': inst };
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
      const v = document.createElement('video');
      v.muted = true;
      v.srcObject = stream;
      await v.play();
      await new Promise((r) => setTimeout(r, 1000));
      const cv = document.createElement('canvas');
      cv.width = 640;
      cv.height = 480;
      const g = cv.getContext('2d')!;
      const snap = () => {
        g.drawImage(v, 0, 0, 640, 480);
        return new Promise<Blob>((r) => cv.toBlob((b) => r(b!), 'image/jpeg', 0.85));
      };
      const start = await (
        await fetch('/api/candidate/checks', {
          method: 'POST',
          headers: { ...H, 'Content-Type': 'application/json' },
          body: JSON.stringify({ purpose: 'initial', clientInstanceId: inst, device: { cameraLabel: 'Integrated Camera', cameraIdHash: '', userAgent: navigator.userAgent, screen: {} } }),
        })
      ).json();
      const lie: Record<string, [number, number]> = { center: [0, 0], turn_left: [28, 0], turn_right: [-28, 0], look_up: [0, 18], look_down: [0, -18] };
      const frames: { step: string; status: number; accepted?: boolean; stepSatisfied?: boolean }[] = [];
      const send = async (step: number | 'frontal', action: string) => {
        const [yaw, pitch] = lie[action] ?? [0, 0];
        const q = new URLSearchParams({ step: String(step), capturedAt: String(Date.now()), nonce: start.liveness?.nonce ?? '', clientYaw: String(yaw), clientPitch: String(pitch) });
        const res = await fetch(`/api/candidate/checks/${start.checkId}/frames?${q}`, { method: 'POST', headers: { ...H, 'Content-Type': 'image/jpeg' }, body: await snap() });
        const b = await res.json();
        frames.push({ step: String(step), status: res.status, accepted: b.accepted, stepSatisfied: b.stepSatisfied });
        await new Promise((r) => setTimeout(r, 450));
      };
      for (let i = 0; i < start.frontalFramesRequired; i++) await send('frontal', 'center');
      for (const st of start.liveness?.steps ?? []) {
        await send(st.index, st.action);
        await send(st.index, st.action);
      }
      const done = await (await fetch(`/api/candidate/checks/${start.checkId}/complete`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}' })).json();
      stream.getTracks().forEach((t) => t.stop());
      return { steps: start.liveness?.steps?.map((x: { action: string }) => x.action), frames, outcome: done.outcome, liveness: done.liveness, status: done.state?.session?.status };
    }, s.token);
    console.log(`tampered attempt: ${result.outcome}; liveness reasons: ${JSON.stringify(result.liveness?.reasons)}`);
    expect(result.frames.filter((f) => f.step === 'frontal').every((f) => f.status === 200)).toBe(true);
    // The turn steps were not satisfied: the server's own pose measurement shows no head turn.
    expect(result.frames.filter((f) => f.step !== 'frontal' && f.step !== '0').some((f) => f.stepSatisfied)).toBe(false);
    expect(result.outcome).toBe('retry');
    expect(result.liveness?.passed).toBe(false);
    expect(result.status).toBe('invited');

    const d = await staff.session(s.sessionId);
    expect(d.summary.status).toBe('invited');
    expect(d.references).toHaveLength(0);
    expect(d.identityChecks.filter((ch) => ch.trigger === 'check_in').map((ch) => ch.decision)).toEqual(['unable_to_verify']);
    // The honest window was superseded by the tampered instance's check (it started a new one).
    await c.page.reload();
    await expect(c.tid('readiness-checklist')).toBeVisible({ timeout: 30_000 });
  } finally {
    await browser.close();
  }
});

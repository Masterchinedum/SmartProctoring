import { expect, test, type Page } from '@playwright/test';
import type { CompleteCheckResponse, StartCheckResponse } from '@sp/shared';
import { acceptConsent, candidateState, createSession, launchWithCamera, openCandidate, tokenFromPath, y4m } from './helpers';

/**
 * Scenario 2 — active liveness with a STILL photo in front of the camera must NOT pass.
 *
 *  a) Honest client: the photo cannot perform the head-turn step, so the guided check never
 *     captures step frames and never reaches the ready screen.
 *  b) Tampered client: a script in another window sends the photo's frames for every step anyway
 *     (and lies about the client-side pose). The server's liveness verification must reject it;
 *     after the configured number of attempts the exam is put on hold for review.
 */

interface TamperResult {
  start: StartCheckResponse;
  frames: { step: string; status: number; accepted?: boolean; stepSatisfied?: boolean; measured?: unknown }[];
  outcome: CompleteCheckResponse['outcome'];
  message: string;
  liveness: CompleteCheckResponse['liveness'];
  status: string | undefined;
}

async function tamperedCheck(page: Page, token: string): Promise<TamperResult> {
  return page.evaluate(async (tok: string) => {
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
    const snap = async () => {
      g.drawImage(v, 0, 0, 640, 480);
      return new Promise<Blob>((r) => cv.toBlob((b) => r(b!), 'image/jpeg', 0.85));
    };
    const start = (await (
      await fetch('/api/candidate/checks', {
        method: 'POST',
        headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose: 'initial', clientInstanceId: inst, device: { cameraLabel: 'tampered', cameraIdHash: '', userAgent: navigator.userAgent, screen: {} } }),
      })
    ).json()) as StartCheckResponse;
    const frames: TamperResult['frames'] = [];
    // Lie about the pose: claim the requested direction was reached.
    const fakePose: Record<string, [number, number]> = { center: [0, 0], turn_left: [28, 0], turn_right: [-28, 0], look_up: [0, 18], look_down: [0, -18] };
    const send = async (step: number | 'frontal', action: string) => {
      const [yaw, pitch] = fakePose[action] ?? [0, 0];
      const q = new URLSearchParams({ step: String(step), capturedAt: String(Date.now()), nonce: start.liveness?.nonce ?? '', clientYaw: String(yaw), clientPitch: String(pitch) });
      const res = await fetch(`/api/candidate/checks/${start.checkId}/frames?${q}`, { method: 'POST', headers: { ...H, 'Content-Type': 'image/jpeg' }, body: await snap() });
      const body = (await res.json()) as { accepted?: boolean; stepSatisfied?: boolean; measured?: unknown };
      frames.push({ step: String(step), status: res.status, accepted: body.accepted, stepSatisfied: body.stepSatisfied, measured: body.measured });
      await new Promise((r) => setTimeout(r, 450));
    };
    for (let i = 0; i < start.frontalFramesRequired; i++) await send('frontal', 'center');
    for (const st of start.liveness?.steps ?? []) {
      await send(st.index, st.action);
      await send(st.index, st.action);
    }
    const done = (await (
      await fetch(`/api/candidate/checks/${start.checkId}/complete`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}' })
    ).json()) as CompleteCheckResponse;
    stream.getTracks().forEach((t) => t.stop());
    return { start, frames, outcome: done.outcome, message: done.message, liveness: done.liveness, status: done.state?.session?.status };
  }, token);
}

test('active liveness: a still photo does not pass', async () => {
  const video = y4m('obama', '/tmp/claude-0/candidate-agent/obama-cam.y4m');
  const { path } = await createSession('liveness', {
    identity: { liveness: 'active', livenessSteps: 2, idPhotoComparison: 'off', maxVerificationAttempts: 2 },
    browser: { requireFullscreen: false },
  });
  const token = tokenFromPath(path);
  const browser = await launchWithCamera(video);
  try {
    /* ---------------- a) guided (honest) client */
    const c = await openCandidate(browser, path);
    const page = c.page;
    await acceptConsent(page);
    await expect(page.getByTestId('readiness-continue')).toBeEnabled({ timeout: 60_000 });
    await page.getByTestId('readiness-continue').click();
    await expect(page.getByTestId('verify-step')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('verify-step')).toHaveAttribute('data-phase', 'liveness', { timeout: 90_000 });
    // The photo cannot turn its head: the instruction to turn stays, nothing progresses.
    await expect(page.getByTestId('verify-instruction')).toContainText(/turn your head/i, { timeout: 30_000 });
    await page.waitForTimeout(20_000);
    await expect(page.getByTestId('verify-instruction')).toContainText(/turn your head/i);
    await expect(page.getByTestId('ready-screen')).toHaveCount(0);
    expect((await candidateState(page, path)).session.status).toBe('invited');

    /* ---------------- b) tampered client sends the photo frames anyway */
    const tamperPage = await c.context.newPage();
    await tamperPage.goto('/mediapipe/vision_wasm_internal.js'); // any same-origin document (secure context)
    const first = await tamperedCheck(tamperPage, token);
    console.log(
      'tampered attempt 1:',
      JSON.stringify({
        outcome: first.outcome,
        reasons: first.liveness?.reasons,
        steps: first.liveness?.steps.map((st) => `${st.action}:${st.passed ? 'ok' : 'fail'}(${st.measured ?? '-'})`),
        stepFrames: first.frames.filter((f) => f.step !== 'frontal').map((f) => `${f.step}:${f.stepSatisfied ? 'ok' : 'no'}`),
      }),
    );
    expect(first.frames.filter((f) => f.step === 'frontal').every((f) => f.status === 200)).toBe(true);
    expect(first.outcome).not.toBe('passed');
    expect(first.liveness?.passed).toBe(false);
    expect(first.status).not.toBe('ready');

    const second = await tamperedCheck(tamperPage, token);
    console.log('tampered attempt 2:', JSON.stringify({ outcome: second.outcome, message: second.message, status: second.status }));
    expect(second.outcome).not.toBe('passed');
    expect(second.liveness?.passed ?? false).toBe(false);

    // After the configured attempts the exam is held for human review — never 'ready'.
    const st = await candidateState(page, path);
    expect(['invited', 'on_hold']).toContain(st.session.status);
    expect(st.session.status).toBe('on_hold');

    // The original window learns that it was superseded / held when it reloads.
    await page.reload();
    await expect(page.getByTestId('hold-screen')).toBeVisible({ timeout: 30_000 });
  } finally {
    await browser.close();
  }
});

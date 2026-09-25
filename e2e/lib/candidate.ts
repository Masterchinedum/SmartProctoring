import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { BASE_URL, HEADED } from './config';
import { fixtureAvailable, fixturePath, type FixtureName } from './fixtures';

/**
 * Candidate side: a Chromium per fake camera (the Y4M file is a launch argument) and a page object for
 * the candidate app (/take/:token).
 *
 * Timing notes (from the candidate app's own drafts):
 *  - the camera (and the Y4M video, from frame 0) starts at the camera check and stays on through the exam;
 *    closing the page or pausing stops it, so the next camera start replays the file from the beginning;
 *    the app asks for 1280×720 (ideal); the file-backed fake camera delivers the Y4M's own 640×480;
 *  - the readiness checklist is smoothed over ~8 analysed frames, calibration takes >= 2.5 s; only camera
 *    frames and exactly one face block the checklist (size / lighting / sharpness are warnings);
 *  - the identity check is adaptive: frontal frames while the server wants more (CheckFrameResponse.progress),
 *    liveness frames at the peak of each head turn with in-place re-prompts, /complete when the server can
 *    decide — `verify-step` carries data-phase (frontal / liveness / completing) and data-stage (liveness:
 *    move / hold / verify / retry);
 *  - identity samples are bursts (policy.identity.burstSize frames, one request each, shared burstId) — the
 *    server decides each burst as ONE identity check;
 *  - a reload is a NEW client instance by design (reconnect check), so tests never reload by accident.
 *
 * Test ids added with identity v2 (all earlier ids are unchanged):
 *   readiness-warning        advisory readiness hint shown while Continue is already enabled
 *   verify-step              + data-stage (liveness: move | hold | verify | retry)
 *   verify-frontal-progress  "Pictures of your face: n of m" (server's running frontal need)
 *   verify-step-progress     head-movement progress bar of the current liveness step
 *   verify-hold              "Hold still" bar while the head is at the peak of a turn
 *   verify-reprompt          in-place re-prompt when the server did not accept a step ("a little further")
 *   debug-overlay            only with ?debug=1 on the take URL; inside: debug-camera-resolution,
 *                            debug-check-frame, debug-check-progress, debug-identity, debug-next-sample,
 *                            debug-triggers
 *   staff /admin/tools/camera-test: camera-test-enrol, camera-test-probe, camera-test-reset,
 *                            camera-test-message, camera-test-camera, camera-test-result,
 *                            camera-test-similarity, camera-test-evidence (+ data-state), camera-test-guidance,
 *                            camera-test-history
 */

export function skipUnlessFixtures(...names: FixtureName[]): void {
  const missing = names.filter((n) => !fixtureAvailable(n));
  test.skip(missing.length > 0, `face images for fixture(s) ${missing.join(', ')} not found (set E2E_FACES_DIR)`);
}

export async function launchCamera(fixture: FixtureName): Promise<Browser> {
  return launchCameraFile(fixturePath(fixture));
}

/** A Chromium whose fake camera plays the given Y4M file (e.g. a realistic fixture, lib/realistic.ts). */
export async function launchCameraFile(y4m: string): Promise<Browser> {
  return chromium.launch({
    headless: !HEADED,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${y4m}`,
      '--autoplay-policy=no-user-gesture-required',
      // Keep timers and the camera loop running in background tabs / occluded windows.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
}

/**
 * A persistent browser profile with a given camera: two launches with the same `userDataDir` and different
 * fixtures model the same computer/browser whose camera view changed (e.g. the candidate moved seats).
 */
export async function launchPersistentCamera(fixture: FixtureName, userDataDir: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, {
    headless: !HEADED,
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 900 },
    permissions: ['camera'],
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${fixturePath(fixture)}`,
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
  });
}

/**
 * Init script: remember every camera track the page obtains (to verify that the camera is released) and when
 * each camera open resolved (`__spCamOpens`: wall-clock ms + delivered size). Chrome's file camera starts its
 * video from frame 0 at every open, so the last open before a moment gives the fixture's timeline position.
 */
export const TRACK_CAMERA_STREAMS = `(() => {
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia || window.__spTracks) return;
  window.__spTracks = [];
  window.__spCamOpens = [];
  const orig = md.getUserMedia.bind(md);
  md.getUserMedia = async (c) => {
    const s = await orig(c);
    const tracks = s.getVideoTracks();
    window.__spTracks.push(...tracks);
    if (tracks.length) {
      const st = tracks[0].getSettings ? tracks[0].getSettings() : {};
      window.__spCamOpens.push({ at: Date.now(), width: st.width || 0, height: st.height || 0 });
    }
    return s;
  };
})();`;

/** Every CandidatePage of the running test (lib/test.ts attaches their API logs when a test fails). */
export const OPEN_CANDIDATE_PAGES = new Set<CandidatePage>();

const hhmmss = (t: number) => new Date(t).toISOString().slice(11, 23);

/** One compact line per identity-relevant API answer (check frames / completes, identity samples). */
async function summarizeApiResponse(url: string, status: number, body: unknown): Promise<string | null> {
  const path = url.replace(/^.*\/api/, '/api');
  const b = (body ?? {}) as Record<string, any>;
  const q = new URL(url).searchParams;
  if (/\/api\/candidate\/checks\/[^/]+\/frames/.test(path)) {
    const qa = b.quality ?? {};
    const pr = b.progress ?? {};
    return `frame step=${q.get('step')} ${status} accepted=${b.accepted} usable=${qa.usable} issues=${(qa.issues ?? []).join('+') || '-'} bright=${qa.brightness?.toFixed?.(0)} contrast=${qa.contrast?.toFixed?.(1)} ie=${qa.interEyePx?.toFixed?.(0)} yaw=${qa.yawDeg?.toFixed?.(0)} sat=${b.stepSatisfied ?? '-'} measured=${b.measured ? `${b.measured.yawDeg?.toFixed(0)}/${b.measured.pitchDeg?.toFixed(0)}` : '-'} client=${q.get('clientYaw') ?? '-'} progress=${pr.frontalAccepted ?? '-'}+${pr.frontalNeeded ?? '-'} steps=${(pr.steps ?? []).map((x: any) => (x.satisfied ? 1 : 0)).join('')} canComplete=${pr.canComplete ?? '-'}`;
  }
  if (/\/api\/candidate\/checks\/[^/]+\/complete/.test(path)) {
    return `complete ${status} outcome=${b.outcome} liveness=${b.liveness ? `${b.liveness.passed}:${(b.liveness.reasons ?? []).join('+')}` : '-'} remaining=${b.attemptsRemaining} guidance=${JSON.stringify(b.guidance ?? [])}`;
  }
  if (/\/api\/candidate\/checks$/.test(path.split('?')[0]!)) {
    return `check start ${status} purpose=${b.purpose ?? '-'} liveness=${(b.liveness?.steps ?? []).map((x: any) => x.action).join(',') || '-'} frontal=${b.frontalFramesRequired ?? '-'}/${b.maxFrontalFrames ?? '-'}`;
  }
  if (/\/api\/candidate\/identity\/sample/.test(path)) {
    const r = b.result ?? {};
    // The candidate is told only whether the image was usable (and guidance) — never a decision, score or evidence
    // state; `faster=yes` is the server's cadence hint (followUpInMs: it wants the next sample sooner).
    return `sample trigger=${q.get('trigger')} burst=${q.get('burstIndex') ?? '-'}/${q.get('burstSize') ?? '-'} ${status} usable=${r.usable ?? '-'} guidance=${JSON.stringify(r.guidance ?? [])} complete=${b.burst?.complete ?? '-'} faster=${b.followUpInMs != null ? 'yes' : 'no'} next=${b.nextSampleInMs ?? '-'} status=${b.status}`;
  }
  return null;
}

export type CheckOutcome = 'ready' | 'passed' | 'retry' | 'hold' | 'problem' | 'failed';

export class CandidatePage {
  readonly logs: string[] = [];
  readonly httpErrors: string[] = [];
  /** Identity-relevant API answers (check frames, check completes, identity samples), one line each. */
  readonly apiLog: string[] = [];
  /** What the identity check screen showed over time (phase / stage / instruction / progress), on change. */
  readonly verifyTrace: string[] = [];
  private lastVerify = '';

  /** Sample the identity check screen once; appends a line to `verifyTrace` when it changed. */
  async traceVerify(): Promise<void> {
    const v = await this.page
      .evaluate(() => {
        const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
        const step = q('verify-step');
        if (!step) return null;
        const prog = q('verify-step-progress')?.getAttribute('aria-valuenow') ?? '-';
        const hold = q('verify-hold') ? (q('verify-hold')!.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') ?? '?') : '-';
        const g = (q('verify-guidance')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 120);
        const live = (step.querySelector('.cand-live-slot') as HTMLElement | null)?.innerText.replace(/\s+/g, ' ').slice(0, 120) ?? '';
        return `${step.dataset.phase ?? '-'} ${step.dataset.stage ?? '-'} prog=${prog} hold=${hold} "${(q('verify-instruction')?.innerText ?? '').replace(/\s+/g, ' ')}"${q('verify-reprompt') ? ' REPROMPT' : ''}${live || g ? ` | ${live || g}` : ''}`;
      })
      .catch(() => null);
    if (v && v !== this.lastVerify) {
      this.lastVerify = v;
      this.verifyTrace.push(`${hhmmss(Date.now())} ${v}`);
      if (this.verifyTrace.length > 3000) this.verifyTrace.splice(0, 1000);
    }
  }

  private constructor(
    readonly context: BrowserContext,
    readonly page: Page,
  ) {}

  /**
   * New browser context (fresh storage = a new device/browser profile) on `browser`, opened at `link`;
   * or a new page in `opts.context` (e.g. a persistent profile).
   */
  static async open(browser: Browser | null, link: string, opts: { context?: BrowserContext } = {}): Promise<CandidatePage> {
    const context = opts.context ?? (await browser!.newContext({ baseURL: BASE_URL, viewport: { width: 1280, height: 900 }, permissions: ['camera'] }));
    await context.addInitScript(TRACK_CAMERA_STREAMS);
    // A/B measurement of the check's pose smoothing (apps/web/src/candidate/check/poseFilter.ts): raw poses.
    if (process.env.E2E_RAW_POSE === '1') await context.addInitScript('window.__spRawPose = true;');
    const page = await context.newPage();
    const c = new CandidatePage(context, page);
    OPEN_CANDIDATE_PAGES.add(c);
    c.attach(page);
    await page.goto(new URL(link, BASE_URL).pathname + new URL(link, BASE_URL).search);
    return c;
  }

  private attach(page: Page): void {
    page.on('dialog', (d) => void d.accept().catch(() => undefined)); // beforeunload on reload/close
    page.on('console', (m) => {
      const t = m.text();
      if ((m.type() === 'error' || m.type() === 'warning') && !/GL Driver|OpenGL|XNNPACK|gl_context|face_landmarker_graph|swiftshader|GroupMarkerNotSet|WebGL|TensorFlow Lite/i.test(t)) {
        this.logs.push(`[${m.type()}] ${t.slice(0, 400)}`);
      }
    });
    page.on('pageerror', (e) => this.logs.push(`[pageerror] ${e.message}`));
    page.on('response', (r) => {
      if (r.url().includes('/api/') && r.status() >= 400) this.httpErrors.push(`${r.status()} ${r.request().method()} ${r.url().replace(/^.*\/api/, '/api')}`);
      if (/\/api\/candidate\/(checks|identity\/sample)/.test(r.url()) && r.request().method() === 'POST') {
        const at = Date.now();
        void r
          .json()
          .catch(() => null)
          .then((b) => summarizeApiResponse(r.url(), r.status(), b))
          .then((line) => {
            if (line) this.apiLog.push(`${hhmmss(at)} ${line}`);
            if (this.apiLog.length > 2000) this.apiLog.splice(0, 500);
          })
          .catch(() => undefined);
      }
    });
  }

  /** Wall-clock times (ms) at which this page's camera opens resolved, with the delivered size. */
  cameraOpens(): Promise<{ at: number; width: number; height: number }[]> {
    return this.page.evaluate(() => (window as unknown as { __spCamOpens?: { at: number; width: number; height: number }[] }).__spCamOpens ?? []);
  }

  /** When the camera was last opened (the file camera's frame 0), or null. */
  async lastCameraOpen(): Promise<{ at: number; width: number; height: number } | null> {
    const o = await this.cameraOpens();
    return o.length ? o[o.length - 1]! : null;
  }

  /**
   * Camera tracks obtained by this page that are still live. The candidate app must release the camera
   * whenever monitoring stops (pause, hold, end) — a leaked track keeps the camera (and its light) on.
   */
  liveCameraTracks(): Promise<number> {
    return this.page.evaluate(() => ((window as unknown as { __spTracks?: MediaStreamTrack[] }).__spTracks ?? []).filter((t) => t.readyState === 'live').length);
  }

  get pageErrors(): string[] {
    return this.logs.filter((l) => l.startsWith('[pageerror]'));
  }

  tid(id: string) {
    return this.page.getByTestId(id);
  }

  /* ---------------------------------------------------------------- consent & checks */

  /** Welcome screen: privacy notice visible, system requirements pass, consent. */
  async consent(): Promise<void> {
    await expect(this.page.getByRole('heading', { name: 'Privacy notice: camera monitoring' })).toBeVisible();
    await expect(this.tid('requirements')).toBeVisible();
    await expect(this.tid('consent-continue')).toBeDisabled();
    await this.tid('consent-checkbox').check();
    await expect(this.tid('consent-continue')).toBeEnabled();
    await this.tid('consent-continue').click();
  }

  /**
   * Readiness: the blocking items (camera frames, exactly one face) must be green before continuing. Size /
   * position, lighting and sharpness are advice only (the server judges usability during the check): with
   * `strict` they must be green too, otherwise they are only logged when they show a warning.
   */
  async passReadiness(timeout = 90_000, opts: { strict?: boolean } = {}): Promise<void> {
    await expect(this.tid('readiness-checklist')).toBeVisible();
    await expect(this.tid('readiness-continue')).toBeEnabled({ timeout });
    const item = (id: string) => this.page.locator(`[data-testid="readiness-checklist"] [data-item="${id}"]`);
    for (const id of ['frames', 'one_face']) await expect(item(id)).toHaveAttribute('data-ok', '1');
    for (const id of ['size_position', 'lighting', 'sharpness']) {
      if (opts.strict) await expect(item(id)).toHaveAttribute('data-ok', '1');
      else if ((await item(id).getAttribute('data-ok')) !== '1') console.log(`[readiness] advisory item "${id}" shows a warning (continuing)`);
    }
    await this.tid('readiness-continue').click();
  }

  /**
   * The adaptive identity check (VerifyStep) as the candidate sees it: phase (starting / frontal / liveness /
   * completing), liveness stage (move / hold / verify / retry) and the instruction text. For diagnostics.
   */
  async verifyState(): Promise<{ phase: string | null; stage: string | null; instruction: string }> {
    const step = this.tid('verify-step');
    const phase = await step.getAttribute('data-phase', { timeout: 1000 }).catch(() => null);
    const stage = await step.getAttribute('data-stage', { timeout: 1000 }).catch(() => null);
    const instruction = (await this.tid('verify-instruction').innerText({ timeout: 1000 }).catch(() => '')).replace(/\s+/g, ' ');
    return { phase, stage, instruction };
  }

  /** Readiness → calibration → identity frames → outcome screen. */
  async runCheck(opts: { purpose?: 'resume' | 'reconnect' | 'reverify'; timeout?: number } = {}): Promise<CheckOutcome> {
    if (opts.purpose) {
      await expect(this.tid('check-intro')).toHaveAttribute('data-purpose', opts.purpose, { timeout: 30_000 });
      await this.tid('check-intro-continue').click();
    }
    await this.passReadiness();
    await expect(this.tid('verify-step').or(this.tid('verify-problem'))).toBeVisible({ timeout: 40_000 });
    return this.waitForCheckOutcome(opts.timeout ?? 120_000);
  }

  async waitForCheckOutcome(timeoutMs = 120_000): Promise<CheckOutcome> {
    const outcomes: Record<CheckOutcome, string> = {
      ready: 'ready-screen',
      passed: 'check-passed',
      retry: 'check-retry',
      hold: 'hold-screen',
      problem: 'verify-problem',
      failed: 'check-failed',
    };
    const any = Object.values(outcomes).map((t) => `[data-testid="${t}"]`).join(', ');
    await this.page.locator(any).first().waitFor({ state: 'visible', timeout: timeoutMs });
    for (const [k, t] of Object.entries(outcomes)) if (await this.tid(t).isVisible()) return k as CheckOutcome;
    throw new Error('check outcome disappeared');
  }

  /** Consent + initial check + start. Returns when the exam screen shows and monitoring runs. */
  async checkInAndStart(): Promise<void> {
    await this.consent();
    expect(await this.runCheck(), 'initial check outcome').toBe('ready');
    await this.startExam();
  }

  async startExam(): Promise<void> {
    await expect(this.tid('ready-screen')).toBeVisible();
    await this.tid('start-exam').click();
    await expect(this.tid('exam-screen')).toBeVisible({ timeout: 30_000 });
    await this.expectMonitoringActive();
  }

  async expectMonitoringActive(timeout = 45_000): Promise<void> {
    await expect(this.tid('monitoring-status')).toContainText('Monitoring active', { timeout });
  }

  /** After a passed resume/reconnect/reverify check: continue into the exam. */
  async continueAfterCheck(): Promise<void> {
    await expect(this.tid('check-passed')).toBeVisible();
    await this.tid('check-continue').click();
    await expect(this.tid('exam-screen')).toBeVisible({ timeout: 30_000 });
  }

  /* ---------------------------------------------------------------- exam */

  async gotoQuestion(i: number): Promise<void> {
    await this.tid(`qnav-${i}`).click();
    await expect(this.tid('question')).toContainText(`Question ${i + 1}`);
  }

  async answerStandardQuestions(): Promise<void> {
    await this.gotoQuestion(0);
    await this.page.getByRole('radio', { name: 'Mean' }).check();
    await this.tid('next-question').click();
    await this.page.getByRole('checkbox', { name: 'Variance' }).check();
    await this.page.getByRole('checkbox', { name: 'Range' }).check();
    await this.tid('next-question').click();
    await this.tid('answer-input').fill('normal');
    await expect(this.tid('qnav-0')).toHaveClass(/answered/);
    await expect(this.tid('qnav-1')).toHaveClass(/answered/);
    await expect(this.tid('qnav-2')).toHaveClass(/answered/);
  }

  /** Countdown in ms parsed from the header ("mm:ss" or "h:mm:ss"). */
  async countdownMs(): Promise<number> {
    const text = (await this.tid('countdown').first().locator('[role="timer"]').innerText()).trim();
    const parts = text.split(':').map((x) => Number.parseInt(x, 10));
    const [h, m, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
    return ((h * 60 + m) * 60 + s) * 1000;
  }

  /** Pause without approval: returns once the paused screen shows. */
  async pause(reason?: string): Promise<void> {
    await this.tid('pause-button').click();
    await expect(this.tid('pause-dialog')).toBeVisible();
    if (reason) await this.tid('pause-reason').fill(reason);
    await this.tid('pause-confirm').click();
    await expect(this.tid('paused-screen')).toBeVisible({ timeout: 30_000 });
  }

  async submit(): Promise<void> {
    await this.tid('submit-button').click();
    await expect(this.tid('submit-dialog')).toBeVisible();
    await this.tid('submit-confirm').click();
    await expect(this.tid('ended-screen')).toBeVisible({ timeout: 30_000 });
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
  }
}

/** Seconds elapsed since `t0` (for logging timing-dependent steps). */
export function since(t0: number): string {
  return `${((Date.now() - t0) / 1000).toFixed(1)} s`;
}

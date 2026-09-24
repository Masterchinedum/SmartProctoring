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
 *  - the readiness checklist is smoothed over ~8 analysed frames, calibration takes >= 2.5 s;
 *  - a reload is a NEW client instance by design (reconnect check), so tests never reload by accident.
 */

export function skipUnlessFixtures(...names: FixtureName[]): void {
  const missing = names.filter((n) => !fixtureAvailable(n));
  test.skip(missing.length > 0, `face images for fixture(s) ${missing.join(', ')} not found (set E2E_FACES_DIR)`);
}

export async function launchCamera(fixture: FixtureName): Promise<Browser> {
  return chromium.launch({
    headless: !HEADED,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${fixturePath(fixture)}`,
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

/** Init script: remember every camera track the page obtains (to verify that the camera is released). */
const TRACK_CAMERA_STREAMS = `(() => {
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia || window.__spTracks) return;
  window.__spTracks = [];
  const orig = md.getUserMedia.bind(md);
  md.getUserMedia = async (c) => {
    const s = await orig(c);
    window.__spTracks.push(...s.getVideoTracks());
    return s;
  };
})();`;

export type CheckOutcome = 'ready' | 'passed' | 'retry' | 'hold' | 'problem' | 'failed';

export class CandidatePage {
  readonly logs: string[] = [];
  readonly httpErrors: string[] = [];

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
    const page = await context.newPage();
    const c = new CandidatePage(context, page);
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
    });
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

  /** Every required readiness item must be green before continuing. */
  async passReadiness(timeout = 90_000): Promise<void> {
    await expect(this.tid('readiness-checklist')).toBeVisible();
    await expect(this.tid('readiness-continue')).toBeEnabled({ timeout });
    for (const id of ['frames', 'one_face', 'size_position', 'lighting', 'sharpness']) {
      await expect(this.page.locator(`[data-testid="readiness-checklist"] [data-item="${id}"]`)).toHaveAttribute('data-ok', '1');
    }
    await this.tid('readiness-continue').click();
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

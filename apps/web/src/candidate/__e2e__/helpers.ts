import { chromium, expect, request as pwRequest, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { AssignmentDTO, CandidateDTO, CandidateSessionState, EventDTO, ExamDTO, ExamInput, ProctoringPolicyInput, SessionDetailDTO } from '@sp/shared';

/** Environment (read without Node typings so this file also typechecks inside @sp/web). */
export const env: Record<string, string | undefined> = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

export const BASE_URL = env.SP_BASE_URL ?? 'http://localhost:5174';
export const ADMIN_EMAIL = env.SP_ADMIN_EMAIL ?? 'owner@example.com';
export const ADMIN_PASSWORD = env.SP_ADMIN_PASSWORD ?? 'owner-password-123';

export function y4m(name: string, fallback: string): string {
  return env[`SP_Y4M_${name.toUpperCase()}`] ?? fallback;
}

/* ------------------------------------------------------------------ browser with a fake camera */

export async function launchWithCamera(videoFile: string): Promise<Browser> {
  return chromium.launch({
    headless: env.SP_HEADED !== '1',
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${videoFile}`, '--autoplay-policy=no-user-gesture-required'],
  });
}

export interface CandidatePage {
  context: BrowserContext;
  page: Page;
  logs: string[];
  httpErrors: string[];
}

export async function openCandidate(browser: Browser, link: string): Promise<CandidatePage> {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1280, height: 900 }, permissions: ['camera'] });
  // Against a Vite dev server, silence the HMR socket so edits elsewhere in the repo cannot reload
  // the page in the middle of a test (a reload is a new client instance by design).
  if (env.SP_KEEP_HMR !== '1') await context.routeWebSocket((url) => url.searchParams.has('token') && !url.pathname.startsWith('/api'), () => undefined);
  const page = await context.newPage();
  const logs: string[] = [];
  const httpErrors: string[] = [];
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || m.type() === 'warning') {
      if (!/GL Driver|OpenGL|XNNPACK|gl_context|face_landmarker_graph|swiftshader|GroupMarkerNotSet/i.test(t)) logs.push(`[${m.type()}] ${t.slice(0, 400)}`);
    }
  });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 400) httpErrors.push(`${r.status()} ${r.request().method()} ${r.url().replace(/^.*\/api/, '/api')}`);
  });
  await page.goto(link);
  return { context, page, logs, httpErrors };
}

/* ------------------------------------------------------------------ admin API (session setup + verification) */

export const EXAM_QUESTIONS: ExamInput['questions'] = [
  { type: 'single_choice', prompt: 'Which measure of central tendency is most affected by outliers?', options: [{ id: 'a', text: 'Median' }, { id: 'b', text: 'Mean' }, { id: 'c', text: 'Mode' }], correct: ['b'], points: 1 },
  { type: 'multiple_choice', prompt: 'Which of these are measures of spread?', options: [{ id: 'a', text: 'Variance' }, { id: 'b', text: 'Range' }, { id: 'c', text: 'Mean' }], correct: ['a', 'b'], points: 2 },
  { type: 'short_text', prompt: 'Name the distribution with a bell-shaped curve.', options: [], correct: ['normal', 'gaussian'], points: 1 },
  { type: 'numeric', prompt: 'What is the mean of 2, 4 and 9?', options: [], correct: ['5'], points: 1 },
  { type: 'long_text', prompt: 'Explain the difference between correlation and causation.', options: [], correct: [], points: 3 },
];

export class AdminApi {
  private constructor(readonly api: APIRequestContext) {}

  static async login(): Promise<AdminApi> {
    const api = await pwRequest.newContext({ baseURL: BASE_URL });
    const res = await api.post('/api/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    if (!res.ok()) throw new Error(`admin login failed: ${res.status()} ${await res.text()}`);
    return new AdminApi(api);
  }

  private async json<T>(method: 'get' | 'post' | 'put', path: string, data?: unknown): Promise<T> {
    const res = await this.api[method](path, data === undefined ? undefined : { data });
    if (!res.ok()) throw new Error(`${method.toUpperCase()} ${path} -> ${res.status()} ${await res.text()}`);
    return (await res.json()) as T;
  }

  /** Creates a published exam with `policy`, a candidate and an assignment. Returns the candidate link path. */
  async createSession(opts: { policy: ProctoringPolicyInput; title?: string; durationSec?: number; candidateName?: string }): Promise<{ path: string; sessionId: string; examId: string }> {
    const exam = await this.json<ExamDTO>('post', '/api/admin/exams', {
      title: opts.title ?? `E2E ${new Date().toISOString()}`,
      description: 'End-to-end test exam.',
      instructions: 'Answer all questions. Your answers are saved automatically.',
      durationSec: opts.durationSec ?? 1800,
      policy: opts.policy,
      questions: EXAM_QUESTIONS,
    });
    await this.json<ExamDTO>('post', `/api/admin/exams/${exam.id}/publish`, {});
    const cand = await this.json<CandidateDTO>('post', '/api/admin/candidates', { name: opts.candidateName ?? 'Alex Candidate', email: `e2e-${Date.now()}@example.com` });
    const { items } = await this.json<{ items: AssignmentDTO[] }>('post', `/api/admin/exams/${exam.id}/assignments`, { candidateIds: [cand.id] });
    const link = new URL(items[0].accessLink);
    return { path: link.pathname, sessionId: items[0].sessionId, examId: exam.id };
  }

  sessionDetail(sessionId: string): Promise<SessionDetailDTO> {
    return this.json<SessionDetailDTO>('get', `/api/admin/sessions/${sessionId}`);
  }

  async events(sessionId: string): Promise<EventDTO[]> {
    return (await this.json<{ items: EventDTO[] }>('get', `/api/admin/sessions/${sessionId}/events`)).items;
  }

  dispose(): Promise<void> {
    return this.api.dispose();
  }
}

/**
 * Creates a test session through the staff API. When the staff API is not available, falls back to a
 * pre-created link in SP_LINK_<KEY> (path or full URL).
 */
export async function createSession(key: string, policy: ProctoringPolicyInput, durationSec = 1800): Promise<{ path: string; sessionId: string | null; admin: AdminApi | null }> {
  const preset = env[`SP_LINK_${key.toUpperCase()}`];
  if (preset) {
    const u = new URL(preset, BASE_URL);
    return { path: u.pathname, sessionId: env[`SP_SESSION_${key.toUpperCase()}`] ?? null, admin: null };
  }
  const admin = await AdminApi.login();
  const s = await admin.createSession({ policy, durationSec });
  return { path: s.path, sessionId: s.sessionId, admin };
}

/* ------------------------------------------------------------------ candidate steps */

export function tokenFromPath(path: string): string {
  return path.split('/take/')[1]?.split(/[/?#]/)[0] ?? '';
}

/** Read the session state as the server reports it (read-only; uses a throwaway client instance id). */
export async function candidateState(page: Page, path: string): Promise<CandidateSessionState> {
  const token = tokenFromPath(path);
  const res = await page.request.get('/api/candidate/session', { headers: { Authorization: `Bearer ${token}`, 'X-Client-Instance': 'e2e-observer-0001' } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as CandidateSessionState;
}

export async function acceptConsent(page: Page): Promise<void> {
  await expect(page.getByTestId('requirements')).toBeVisible();
  await expect(page.getByTestId('consent-continue')).toBeDisabled();
  await page.getByTestId('consent-checkbox').check();
  await page.getByTestId('consent-continue').click();
}

/** Readiness checklist → calibration → verification. Returns the outcome screen that appeared. */
export async function runCheck(page: Page, opts: { introPurpose?: string; timeoutMs?: number } = {}): Promise<'ready' | 'passed' | 'retry' | 'hold' | 'problem' | 'failed'> {
  if (opts.introPurpose) {
    await expect(page.getByTestId('check-intro')).toHaveAttribute('data-purpose', opts.introPurpose);
    await page.getByTestId('check-intro-continue').click();
  }
  await expect(page.getByTestId('readiness-checklist')).toBeVisible();
  await expect(page.getByTestId('readiness-continue')).toBeEnabled({ timeout: 60_000 });
  // Every required item must be ticked before continuing.
  for (const id of ['frames', 'one_face', 'size_position', 'lighting', 'sharpness']) {
    await expect(page.locator(`[data-item="${id}"]`)).toHaveAttribute('data-ok', '1');
  }
  await page.getByTestId('readiness-continue').click();
  await expect(page.getByTestId('verify-step')).toBeVisible({ timeout: 30_000 });
  return waitForCheckOutcome(page, opts.timeoutMs ?? 120_000);
}

export async function waitForCheckOutcome(page: Page, timeoutMs = 120_000): Promise<'ready' | 'passed' | 'retry' | 'hold' | 'problem' | 'failed'> {
  const outcomes = {
    ready: page.getByTestId('ready-screen'),
    passed: page.getByTestId('check-passed'),
    retry: page.getByTestId('check-retry'),
    hold: page.getByTestId('hold-screen'),
    problem: page.getByTestId('verify-problem'),
    failed: page.getByTestId('check-failed'),
  } as const;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const [k, loc] of Object.entries(outcomes)) {
      if (await loc.isVisible().catch(() => false)) return k as keyof typeof outcomes;
    }
    await page.waitForTimeout(500);
  }
  throw new Error('No check outcome within timeout');
}

/** Countdown in ms parsed from the header ("mm:ss" or "h:mm:ss"). */
export async function countdownMs(page: Page): Promise<number> {
  const text = (await page.getByTestId('countdown').locator('[role="timer"]').innerText()).trim();
  const parts = text.split(':').map((x) => Number.parseInt(x, 10));
  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  return ((h * 60 + m) * 60 + s) * 1000;
}

export async function answerFirstQuestions(page: Page): Promise<void> {
  await page.getByTestId('qnav-0').click();
  await page.getByRole('radio', { name: 'Mean' }).check();
  await page.getByTestId('next-question').click();
  await page.getByRole('checkbox', { name: 'Variance' }).check();
  await page.getByRole('checkbox', { name: 'Range' }).check();
  await page.getByTestId('next-question').click();
  await page.getByTestId('answer-input').fill('normal');
}

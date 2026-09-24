import { expect, request, type APIRequestContext, type APIResponse } from '@playwright/test';
import type {
  AssignmentDTO,
  CandidateDTO,
  CandidateSessionState,
  DashboardDTO,
  EventDTO,
  ExamDTO,
  ExamInput,
  IdentityComparisonDTO,
  IdPhotoUploadResponse,
  NoteDTO,
  SessionDetailDTO,
  SessionReportDTO,
  SessionSummaryDTO,
  StaffUserDTO,
  TimelineItemDTO,
} from '../../packages/shared/src/api';
import type { EventType } from '../../packages/shared/src/events';
import type { ProctoringPolicyInput } from '../../packages/shared/src/policy';
import { ADMIN_EMAIL, ADMIN_PASSWORD, BASE_URL } from './config';

export type { CandidateSessionState, EventDTO, SessionDetailDTO, SessionReportDTO, TimelineItemDTO, IdentityComparisonDTO };

/** A mix of every question type (auto-graded except the essay). */
export const QUESTIONS: ExamInput['questions'] = [
  { type: 'single_choice', prompt: 'Which measure of central tendency is most affected by outliers?', options: [{ id: 'a', text: 'Median' }, { id: 'b', text: 'Mean' }, { id: 'c', text: 'Mode' }], correct: ['b'], points: 1 },
  { type: 'multiple_choice', prompt: 'Which of these are measures of spread?', options: [{ id: 'a', text: 'Variance' }, { id: 'b', text: 'Range' }, { id: 'c', text: 'Mean' }], correct: ['a', 'b'], points: 2 },
  { type: 'short_text', prompt: 'Name the distribution with a bell-shaped curve.', options: [], correct: ['normal', 'gaussian'], points: 1 },
  { type: 'numeric', prompt: 'What is the mean of 2, 4 and 9?', options: [], correct: ['5'], points: 1 },
  { type: 'long_text', prompt: 'Explain the difference between correlation and causation.', options: [], correct: [], points: 3 },
];

/**
 * Policy defaults for camera tests: liveness off (a still photo cannot turn its head), no ID photo,
 * no fullscreen requirement (headless Chromium), fast periodic identity samples.
 */
export const BASE_POLICY: ProctoringPolicyInput = {
  identity: { liveness: 'off', idPhotoComparison: 'off', periodicCheckIntervalSec: 30 },
  browser: { requireFullscreen: false },
};

export function mergePolicy(base: ProctoringPolicyInput, over: ProctoringPolicyInput = {}): ProctoringPolicyInput {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b && typeof b === 'object' && v && typeof v === 'object' ? { ...(b as object), ...(v as object) } : v;
  }
  return out as ProctoringPolicyInput;
}

export interface SessionHandle {
  sessionId: string;
  examId: string;
  candidateId: string;
  candidateName: string;
  examTitle: string;
  /** Full access link (PUBLIC_URL/take/<token>). */
  link: string;
  /** Path part of the link (/take/<token>). */
  path: string;
  token: string;
}

let seq = 0;
export function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}${(++seq).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export class StaffApi {
  private constructor(
    readonly api: APIRequestContext,
    readonly user: StaffUserDTO,
  ) {}

  /** `baseURL`: another server instance (dedicated servers of the integrations / key-rotation specs). */
  static async login(email = ADMIN_EMAIL, password = ADMIN_PASSWORD, baseURL = BASE_URL): Promise<StaffApi> {
    const api = await request.newContext({ baseURL });
    const res = await api.post('/api/auth/login', { data: { email, password } });
    if (!res.ok()) throw new Error(`staff login failed for ${email}: ${res.status()} ${await res.text()}`);
    const body = (await res.json()) as { user: StaffUserDTO };
    return new StaffApi(api, body.user);
  }

  /** Cookie state for a browser context of the staff app (avoids UI logins, which are rate limited). */
  storageState() {
    return this.api.storageState();
  }

  async json<T>(method: 'get' | 'post' | 'put' | 'delete', path: string, data?: unknown): Promise<T> {
    const res = await this.api[method](path, data === undefined ? undefined : { data });
    if (!res.ok()) throw new Error(`${method.toUpperCase()} ${path} -> ${res.status()} ${await res.text()}`);
    return (await res.json()) as T;
  }

  raw(path: string): Promise<APIResponse> {
    return this.api.get(path);
  }

  /* ---------------------------------------------------------------- setup */

  async createExam(opts: { policy?: ProctoringPolicyInput; durationSec?: number; title?: string; questions?: ExamInput['questions'] } = {}): Promise<ExamDTO> {
    const exam = await this.json<ExamDTO>('post', '/api/admin/exams', {
      title: opts.title ?? uniqueName('E2E exam'),
      description: 'End-to-end test exam.',
      instructions: 'Answer all questions. Your answers are saved automatically.',
      durationSec: opts.durationSec ?? 1800,
      policy: opts.policy ?? BASE_POLICY,
      questions: opts.questions ?? QUESTIONS,
    });
    return this.json<ExamDTO>('post', `/api/admin/exams/${exam.id}/publish`, {});
  }

  createCandidate(name = uniqueName('Candidate')): Promise<CandidateDTO> {
    return this.json<CandidateDTO>('post', '/api/admin/candidates', { name, email: `e2e-${Date.now()}-${++seq}@example.com` });
  }

  async assign(exam: ExamDTO, candidate: CandidateDTO): Promise<SessionHandle> {
    const { items } = await this.json<{ items: AssignmentDTO[] }>('post', `/api/admin/exams/${exam.id}/assignments`, { candidateIds: [candidate.id] });
    const a = items[0];
    const url = new URL(a.accessLink);
    return {
      sessionId: a.sessionId,
      examId: exam.id,
      candidateId: candidate.id,
      candidateName: candidate.name,
      examTitle: exam.title,
      link: a.accessLink,
      path: url.pathname,
      token: url.pathname.split('/take/')[1] ?? '',
    };
  }

  /** Published exam (policy = BASE_POLICY merged with `policy`) + candidate + assignment. */
  async createSession(opts: { policy?: ProctoringPolicyInput; durationSec?: number; candidateName?: string; title?: string; questions?: ExamInput['questions'] } = {}): Promise<SessionHandle> {
    const exam = await this.createExam({ ...opts, policy: mergePolicy(BASE_POLICY, opts.policy) });
    const cand = await this.createCandidate(opts.candidateName);
    return this.assign(exam, cand);
  }

  async createUser(role: 'owner' | 'admin' | 'reviewer'): Promise<{ email: string; password: string; user: StaffUserDTO }> {
    const email = `${role}-${Date.now()}-${++seq}@example.com`;
    const password = `pw-${role}-${Math.random().toString(36).slice(2)}-e2e`;
    const user = await this.json<StaffUserDTO>('post', '/api/admin/users', { email, name: `E2E ${role}`, role, password });
    return { email, password, user };
  }

  /* ---------------------------------------------------------------- reads */

  dashboard(): Promise<DashboardDTO> {
    return this.json('get', '/api/admin/dashboard');
  }
  session(id: string): Promise<SessionDetailDTO> {
    return this.json('get', `/api/admin/sessions/${id}`);
  }
  async events(id: string, filter: Record<string, string> = {}): Promise<EventDTO[]> {
    const q = new URLSearchParams(filter).toString();
    return (await this.json<{ items: EventDTO[] }>('get', `/api/admin/sessions/${id}/events${q ? `?${q}` : ''}`)).items;
  }
  async timeline(id: string): Promise<TimelineItemDTO[]> {
    return (await this.json<{ items: TimelineItemDTO[] }>('get', `/api/admin/sessions/${id}/timeline`)).items;
  }
  report(id: string): Promise<SessionReportDTO> {
    return this.json('get', `/api/admin/sessions/${id}/report`);
  }
  compare(eventId: string): Promise<IdentityComparisonDTO> {
    return this.json('get', `/api/admin/identity/compare/${eventId}`);
  }

  /* ---------------------------------------------------------------- actions */

  decidePause(sessionId: string, requestId: string, approve: boolean, note?: string): Promise<SessionSummaryDTO> {
    return this.json('post', `/api/admin/sessions/${sessionId}/pause-requests/${requestId}/decision`, { approve, note });
  }
  extend(sessionId: string, minutes: number, note?: string): Promise<SessionSummaryDTO> {
    return this.json('post', `/api/admin/sessions/${sessionId}/extend`, { minutes, note });
  }
  release(sessionId: string, opts: { requireCheck?: boolean; reEnroll?: boolean; note?: string } = {}): Promise<SessionSummaryDTO> {
    return this.json('post', `/api/admin/sessions/${sessionId}/release`, { requireCheck: true, reEnroll: false, ...opts });
  }
  terminate(sessionId: string, reason: string): Promise<SessionSummaryDTO> {
    return this.json('post', `/api/admin/sessions/${sessionId}/terminate`, { reason });
  }
  addNote(sessionId: string, text: string): Promise<NoteDTO> {
    return this.json('post', `/api/admin/sessions/${sessionId}/notes`, { text });
  }
  hold(sessionId: string, note?: string): Promise<SessionSummaryDTO> {
    return this.json('post', `/api/admin/sessions/${sessionId}/hold`, { note });
  }
  legalHold(sessionId: string, enabled: boolean): Promise<SessionSummaryDTO> {
    return this.json('post', `/api/admin/sessions/${sessionId}/legal-hold`, { enabled });
  }
  /** Approved ID photo (the staff API behind the candidate page's upload; the UI converts to JPEG first). */
  async uploadIdPhoto(candidateId: string, jpeg: Buffer): Promise<IdPhotoUploadResponse> {
    const res = await this.api.put(`/api/admin/candidates/${candidateId}/id-photo`, { data: jpeg, headers: { 'Content-Type': 'image/jpeg' } });
    if (!res.ok()) throw new Error(`PUT id-photo -> ${res.status()} ${await res.text()}`);
    return (await res.json()) as IdPhotoUploadResponse;
  }

  /* ---------------------------------------------------------------- waiting */

  /** Poll the session until `pred` holds (returns the matching detail). */
  async waitForSession(id: string, pred: (d: SessionDetailDTO) => boolean, opts: { timeout?: number; message?: string } = {}): Promise<SessionDetailDTO> {
    let last: SessionDetailDTO | null = null;
    await expect
      .poll(
        async () => {
          last = await this.session(id);
          return pred(last);
        },
        { timeout: opts.timeout ?? 60_000, intervals: [500, 1000, 2000], message: opts.message },
      )
      .toBe(true);
    return last!;
  }

  /** Poll the event list until an event matching `pred` exists (returns it). */
  async waitForEvent(id: string, pred: (e: EventDTO) => boolean, opts: { timeout?: number; message?: string } = {}): Promise<EventDTO> {
    let found: EventDTO | undefined;
    await expect
      .poll(
        async () => {
          found = (await this.events(id)).find(pred);
          return !!found;
        },
        { timeout: opts.timeout ?? 60_000, intervals: [1000, 2000], message: opts.message },
      )
      .toBe(true);
    return found!;
  }

  waitForEventType(id: string, type: EventType, opts: { timeout?: number; closed?: boolean } = {}): Promise<EventDTO> {
    return this.waitForEvent(id, (e) => e.type === type && (!opts.closed || e.status === 'closed'), { timeout: opts.timeout, message: `waiting for ${opts.closed ? 'closed ' : ''}${type}` });
  }

  dispose(): Promise<void> {
    return this.api.dispose();
  }
}

/** Candidate-side read of the session (read-only observer instance, not affected by page offline emulation). */
export async function candidateState(token: string, baseURL = BASE_URL): Promise<CandidateSessionState> {
  const api = await request.newContext({ baseURL });
  try {
    const res = await api.get('/api/candidate/session', { headers: { Authorization: `Bearer ${token}`, 'X-Client-Instance': 'e2e-observer-0001' } });
    if (!res.ok()) throw new Error(`candidate state ${res.status()} ${await res.text()}`);
    return (await res.json()) as CandidateSessionState;
  } finally {
    await api.dispose();
  }
}

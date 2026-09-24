import type {
  ApiError as ApiErrorBody,
  AssignmentDTO,
  AuditLogEntryDTO,
  CandidateDTO,
  DashboardDTO,
  DetectionQualityDTO,
  EventDTO,
  ExamDTO,
  ExamInput,
  IdentityComparisonDTO,
  IdPhotoUploadResponse,
  LiveEventDTO,
  NoteDTO,
  OrgSettingsDTO,
  Paged,
  ReviewStatus,
  SessionDetailDTO,
  SessionReportDTO,
  SessionSummaryDTO,
  StaffRole,
  StaffUserDTO,
  TimelineItemDTO,
} from '@sp/shared';

/** Error thrown for any non-2xx response. `code` is the machine code from the ApiError body. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let unauthorizedHandler: (() => void) | null = null;
/** Called when any staff request (except auth probes) returns 401. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export type QueryValue = string | number | boolean | null | undefined;

export function buildQuery(query?: Record<string, QueryValue>): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

interface RequestOptions {
  body?: unknown;
  /** Raw binary body (e.g. image/jpeg). */
  blob?: Blob;
  query?: Record<string, QueryValue>;
  /** Do not redirect to login on 401 (used by the auth probe and login itself). */
  noAuthRedirect?: boolean;
  signal?: AbortSignal;
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: BodyInit | undefined;
  if (opts.blob) {
    headers['Content-Type'] = opts.blob.type || 'application/octet-stream';
    body = opts.blob;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  } else if (method !== 'GET' && method !== 'DELETE') {
    // Fastify rejects an empty body with a JSON content-type; always send a JSON object.
    headers['Content-Type'] = 'application/json';
    body = '{}';
  }
  let res: Response;
  try {
    res = await fetch(path + buildQuery(opts.query), { method, headers, body, credentials: 'include', signal: opts.signal });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'Could not reach the server. Check your connection and try again.');
  }
  if (res.status === 401 && !opts.noAuthRedirect) unauthorizedHandler?.();
  const contentType = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    let parsed: Partial<ApiErrorBody> | null = null;
    if (contentType.includes('json')) parsed = (await res.json().catch(() => null)) as Partial<ApiErrorBody> | null;
    throw new ApiError(
      res.status,
      parsed?.error ?? httpCode(res.status),
      parsed?.message ?? `${res.status} ${res.statusText || 'Request failed'}`,
      parsed?.details,
    );
  }
  if (res.status === 204) return undefined as T;
  if (contentType.includes('json')) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

function httpCode(status: number): string {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'server_error';
  return 'request_failed';
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'You do not have permission to do this.';
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}

/** React Query retry policy: never retry client errors (4xx), retry network/server errors once. */
export function shouldRetry(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

const A = '/api/admin';
const enc = encodeURIComponent;

export interface MeResponse {
  user: StaffUserDTO;
  org: { id: string; name: string };
}

export interface SessionListParams {
  status?: string;
  examId?: string;
  q?: string;
  connection?: string;
  limit?: number;
  offset?: number;
}

export const api = {
  // ---- auth
  me: () => request<MeResponse>('GET', '/api/auth/me', { noAuthRedirect: true }),
  login: (email: string, password: string) => request<MeResponse>('POST', '/api/auth/login', { body: { email, password }, noAuthRedirect: true }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout', { noAuthRedirect: true }),

  // ---- dashboard / sessions
  dashboard: () => request<DashboardDTO>('GET', `${A}/dashboard`),
  sessions: (p: SessionListParams) => request<Paged<SessionSummaryDTO>>('GET', `${A}/sessions`, { query: { ...p } }),
  session: (id: string) => request<SessionDetailDTO>('GET', `${A}/sessions/${enc(id)}`),
  sessionEvents: (id: string) => request<{ items: EventDTO[] }>('GET', `${A}/sessions/${enc(id)}/events`),
  sessionTimeline: (id: string) => request<{ items: TimelineItemDTO[] }>('GET', `${A}/sessions/${enc(id)}/timeline`),
  sessionReport: (id: string) => request<SessionReportDTO>('GET', `${A}/sessions/${enc(id)}/report`),
  sessionCsvUrl: (id: string) => `${A}/sessions/${enc(id)}/events.csv`,
  addSessionNote: (id: string, text: string) => request<NoteDTO>('POST', `${A}/sessions/${enc(id)}/notes`, { body: { text } }),
  decidePause: (id: string, requestId: string, approve: boolean, note?: string) =>
    request<SessionSummaryDTO>('POST', `${A}/sessions/${enc(id)}/pause-requests/${enc(requestId)}/decision`, { body: { approve, note: note || undefined } }),
  hold: (id: string, note?: string) => request<SessionSummaryDTO>('POST', `${A}/sessions/${enc(id)}/hold`, { body: { note: note || undefined } }),
  release: (id: string, body: { note?: string; requireCheck: boolean; reEnroll: boolean }) =>
    request<SessionSummaryDTO>('POST', `${A}/sessions/${enc(id)}/release`, { body: { ...body, note: body.note || undefined } }),
  terminate: (id: string, reason: string) => request<SessionSummaryDTO>('POST', `${A}/sessions/${enc(id)}/terminate`, { body: { reason } }),
  staffSubmit: (id: string, note?: string) => request<SessionSummaryDTO>('POST', `${A}/sessions/${enc(id)}/submit`, { body: { note: note || undefined } }),
  legalHold: (id: string, enabled: boolean) => request<SessionSummaryDTO>('POST', `${A}/sessions/${enc(id)}/legal-hold`, { body: { enabled } }),
  regenerateLink: (id: string) => request<{ accessLink: string }>('POST', `${A}/sessions/${enc(id)}/regenerate-link`),
  extendTime: (id: string, minutes: number, note?: string) =>
    request<SessionSummaryDTO>('POST', `${A}/sessions/${enc(id)}/extend`, { body: { minutes, note: note || undefined } }),

  // ---- events
  events: (p: { category?: string; severity?: string; review?: string; since?: number; limit?: number }) =>
    request<{ items: LiveEventDTO[] }>('GET', `${A}/events`, { query: { ...p } }),
  event: (id: string) => request<EventDTO>('GET', `${A}/events/${enc(id)}`),
  reviewEvent: (id: string, status: ReviewStatus, note?: string) =>
    request<EventDTO>('POST', `${A}/events/${enc(id)}/review`, { body: { status, note: note || undefined } }),
  eventNotes: (id: string) => request<{ items: NoteDTO[] }>('GET', `${A}/events/${enc(id)}/notes`),
  addEventNote: (id: string, text: string) => request<NoteDTO>('POST', `${A}/events/${enc(id)}/notes`, { body: { text } }),
  compare: (eventId: string) => request<IdentityComparisonDTO>('GET', `${A}/identity/compare/${enc(eventId)}`),
  evidenceUrl: (evidenceId: string) => `${A}/evidence/${enc(evidenceId)}`,

  // ---- exams
  exams: () => request<{ items: ExamDTO[] }>('GET', `${A}/exams`),
  exam: (id: string) => request<ExamDTO>('GET', `${A}/exams/${enc(id)}`),
  createExam: (input: ExamInput) => request<ExamDTO>('POST', `${A}/exams`, { body: input }),
  updateExam: (id: string, input: ExamInput) => request<ExamDTO>('PUT', `${A}/exams/${enc(id)}`, { body: input }),
  publishExam: (id: string) => request<ExamDTO>('POST', `${A}/exams/${enc(id)}/publish`),
  archiveExam: (id: string) => request<ExamDTO>('POST', `${A}/exams/${enc(id)}/archive`),
  examSessions: (id: string) => request<{ items: SessionSummaryDTO[] }>('GET', `${A}/exams/${enc(id)}/sessions`),
  assign: (id: string, candidateIds: string[]) => request<{ items: AssignmentDTO[] }>('POST', `${A}/exams/${enc(id)}/assignments`, { body: { candidateIds } }),

  // ---- candidates
  candidates: (q?: string) => request<{ items: CandidateDTO[] }>('GET', `${A}/candidates`, { query: { q } }),
  candidate: (id: string) => request<CandidateDTO>('GET', `${A}/candidates/${enc(id)}`),
  createCandidate: (input: { name: string; email: string | null; externalId: string | null }) =>
    request<CandidateDTO>('POST', `${A}/candidates`, { body: input }),
  updateCandidate: (id: string, input: { name: string; email: string | null; externalId: string | null }) =>
    request<CandidateDTO>('PUT', `${A}/candidates/${enc(id)}`, { body: input }),
  deleteCandidate: (id: string) => request<{ ok: boolean }>('DELETE', `${A}/candidates/${enc(id)}`),
  uploadIdPhoto: (id: string, jpeg: Blob) => request<IdPhotoUploadResponse>('PUT', `${A}/candidates/${enc(id)}/id-photo`, { blob: jpeg }),
  removeIdPhoto: (id: string) => request<CandidateDTO>('DELETE', `${A}/candidates/${enc(id)}/id-photo`),

  // ---- org
  settings: () => request<OrgSettingsDTO>('GET', `${A}/settings`),
  updateSettings: (patch: Partial<Omit<OrgSettingsDTO, 'identityThresholds'>> & { identityThresholds?: Partial<OrgSettingsDTO['identityThresholds']> }) =>
    request<OrgSettingsDTO>('PUT', `${A}/settings`, { body: patch }),
  users: () => request<{ items: StaffUserDTO[] }>('GET', `${A}/users`),
  createUser: (input: { email: string; name: string; role: StaffRole; password: string }) => request<StaffUserDTO>('POST', `${A}/users`, { body: input }),
  updateUser: (id: string, patch: { name?: string; role?: StaffRole; disabled?: boolean; password?: string }) =>
    request<StaffUserDTO>('PUT', `${A}/users/${enc(id)}`, { body: patch }),
  auditLog: (p: { limit: number; offset: number; action?: string }) => request<Paged<AuditLogEntryDTO>>('GET', `${A}/audit-log`, { query: { ...p } }),
  detectionQuality: (p: { from?: number; to?: number }) => request<DetectionQualityDTO>('GET', `${A}/metrics/detection-quality`, { query: { ...p } }),
};

/** Resolve a relative evidence/API URL against the current origin (for new-tab links). */
export function absoluteUrl(url: string): string {
  try {
    return new URL(url, window.location.origin).toString();
  } catch {
    return url;
  }
}

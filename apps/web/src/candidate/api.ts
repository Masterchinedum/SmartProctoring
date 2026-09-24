import type {
  CandidateSessionState,
  CheckFrameResponse,
  CompleteCheckResponse,
  ConsentRequest,
  EventBatchResponse,
  EventUpsert,
  EvidenceUploadResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  IdentityCheckTrigger,
  IdentitySampleResponse,
  PauseResponse,
  SaveAnswerRequest,
  SaveAnswerResponse,
  StartCheckRequest,
  StartCheckResponse,
} from '@sp/shared';

/**
 * Candidate HTTP client (contract: packages/shared/src/api.ts).
 *
 * Every request carries the invite token as Bearer credential and the per-page-load client instance
 * id (`X-Client-Instance`). A reload therefore is a new instance and the server requires a
 * 'reconnect' check before it serves questions or accepts data from it.
 */

export const CLIENT_INSTANCE_HEADER = 'X-Client-Instance';

/** Error raised for any failed request. `status` 0 means the request never got an HTTP response. */
export class CandidateApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'CandidateApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isNetwork(): boolean {
    return this.status === 0;
  }
}

export type ApiErrorKind =
  | 'network' // no response (offline, DNS, timeout, CORS)
  | 'invalid_link' // token unknown / revoked / expired
  | 'superseded' // another browser instance took over this session
  | 'not_verified' // this instance has not passed the required check (yet)
  | 'invalid_state' // action not allowed in the current session state
  | 'rate_limited'
  | 'server' // 5xx
  | 'client'; // other 4xx (validation etc.) — permanent for this payload

const INVALID_LINK_CODES = new Set(['invalid_token', 'unauthorized', 'invalid_link', 'link_invalid', 'link_expired', 'link_revoked', 'token_invalid', 'token_expired', 'session_not_found']);
const NOT_VERIFIED_CODES = new Set(['not_verified', 'instance_not_verified', 'check_required', 'unverified_instance']);

export function classifyApiError(err: unknown): ApiErrorKind {
  if (!(err instanceof CandidateApiError)) return 'network';
  const { status, code } = err;
  if (status === 0) return 'network';
  if (code === 'superseded') return 'superseded';
  if (NOT_VERIFIED_CODES.has(code)) return 'not_verified';
  if (status === 401 || INVALID_LINK_CODES.has(code)) return 'invalid_link';
  if (code === 'invalid_state' || status === 423) return 'invalid_state';
  if (status === 409) return 'invalid_state';
  if (status === 429) return 'rate_limited';
  if (status === 408 || status >= 500) return 'server';
  return 'client';
}

/**
 * The server is busy (vision queue full: 503 vision_busy, or rate limited: 429). Retrying later will
 * work; this says nothing about the connection (not a delivery failure).
 */
export function isServerBusy(err: unknown): boolean {
  return err instanceof CandidateApiError && (err.status === 503 || err.status === 429 || err.code === 'vision_busy');
}

/** True when retrying the same request later may succeed. */
export function isRetryable(err: unknown): boolean {
  const kind = classifyApiError(err);
  return kind === 'network' || kind === 'server' || kind === 'rate_limited' || kind === 'not_verified' || kind === 'invalid_state';
}

export interface RequestTiming {
  /** Local Date.now() just before the request was sent. */
  sentAt: number;
  /** Local Date.now() when the response arrived. */
  receivedAt: number;
}

export interface Timed<T> {
  data: T;
  timing: RequestTiming;
}

export interface FrameUploadQuery {
  step: number | 'frontal';
  capturedAt: number;
  nonce?: string | null;
  clientYaw?: number | null;
  clientPitch?: number | null;
}

export interface EvidenceUploadQuery {
  eventId: string;
  capturedAt: number;
  reason: 'onset' | 'peak' | 'periodic' | 'end';
}

export interface IdentitySampleQuery {
  trigger: IdentityCheckTrigger;
  capturedAt: number;
}

export type JpegBody = Blob | ArrayBuffer | Uint8Array;

export interface CandidateApi {
  readonly instanceId: string;
  getState(): Promise<Timed<CandidateSessionState>>;
  consent(req: ConsentRequest): Promise<CandidateSessionState>;
  startCheck(req: StartCheckRequest): Promise<StartCheckResponse>;
  uploadCheckFrame(checkId: string, jpeg: JpegBody, q: FrameUploadQuery): Promise<CheckFrameResponse>;
  completeCheck(checkId: string): Promise<CompleteCheckResponse>;
  start(): Promise<Timed<CandidateSessionState>>;
  saveAnswer(questionId: string, req: SaveAnswerRequest): Promise<SaveAnswerResponse>;
  heartbeat(req: HeartbeatRequest): Promise<Timed<HeartbeatResponse>>;
  sendEvents(events: EventUpsert[]): Promise<EventBatchResponse>;
  uploadEvidence(evidenceId: string, jpeg: JpegBody, q: EvidenceUploadQuery): Promise<EvidenceUploadResponse>;
  identitySample(sampleId: string, jpeg: JpegBody, q: IdentitySampleQuery): Promise<IdentitySampleResponse>;
  pause(reason?: string): Promise<PauseResponse>;
  cancelPause(): Promise<Timed<CandidateSessionState>>;
  submit(): Promise<Timed<CandidateSessionState>>;
}

export interface CandidateApiOptions {
  token: string;
  instanceId: string;
  /** Origin prefix, default '' (same origin; Vite proxies /api in dev). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  uploadTimeoutMs?: number;
  /**
   * Called for errors that end the candidate's ability to use this page (invalid link, superseded).
   * Invoked in addition to the promise rejecting.
   */
  onFatal?: (kind: 'invalid_link' | 'superseded', err: CandidateApiError) => void;
}

function qs(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) continue;
    sp.set(k, typeof v === 'number' ? String(Math.round(v * 100) / 100) : v);
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

async function readError(res: Response): Promise<CandidateApiError> {
  let code = `http_${res.status}`;
  let message = res.statusText || `Request failed (${res.status})`;
  let details: unknown;
  try {
    const text = await res.text();
    if (text) {
      const body = JSON.parse(text) as Partial<{ error: string; message: string; details: unknown; code: string }>;
      if (typeof body.error === 'string') code = body.error;
      else if (typeof body.code === 'string') code = body.code;
      if (typeof body.message === 'string') message = body.message;
      details = body.details;
    }
  } catch {
    /* non-JSON error body */
  }
  return new CandidateApiError(res.status, code, message, details);
}

export function createCandidateApi(opts: CandidateApiOptions): CandidateApi {
  const base = (opts.baseUrl ?? '').replace(/\/$/, '');
  const doFetch = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const uploadTimeoutMs = opts.uploadTimeoutMs ?? 45_000;

  async function request<T>(method: string, path: string, body?: unknown, kind: 'json' | 'jpeg' = 'json', firstPartyPath = path): Promise<Timed<T>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.token}`,
      [CLIENT_INSTANCE_HEADER]: opts.instanceId,
      Accept: 'application/json',
    };
    let payload: BodyInit | undefined;
    if (body !== undefined) {
      if (kind === 'jpeg') {
        headers['Content-Type'] = 'image/jpeg';
        payload = body instanceof Blob ? body : new Blob([body as ArrayBuffer | Uint8Array<ArrayBuffer>], { type: 'image/jpeg' });
      } else {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
    } else if (method !== 'GET') {
      // Fastify rejects empty bodies declared as JSON; send an empty object for bodiless POSTs.
      headers['Content-Type'] = 'application/json';
      payload = '{}';
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), kind === 'jpeg' ? uploadTimeoutMs : timeoutMs);
    const sentAt = Date.now();
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, { method, headers, body: payload, signal: ctrl.signal, cache: 'no-store', credentials: 'omit' });
    } catch (e) {
      clearTimeout(timer);
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      throw new CandidateApiError(0, aborted ? 'timeout' : 'network_error', aborted ? 'The request timed out.' : 'Could not reach the server.');
    }
    try {
      if (!res.ok) {
        const err = await readError(res);
        const k = classifyApiError(err);
        // 403/404 on the session endpoint itself means the link is not valid.
        const fatalLink = k === 'invalid_link' || ((res.status === 403 || res.status === 404) && firstPartyPath === '/api/candidate/session');
        if (fatalLink) opts.onFatal?.('invalid_link', err);
        else if (k === 'superseded') opts.onFatal?.('superseded', err);
        throw err;
      }
      const receivedAt = Date.now();
      const text = await res.text();
      const data = (text ? JSON.parse(text) : null) as T;
      return { data, timing: { sentAt, receivedAt } };
    } catch (e) {
      if (e instanceof CandidateApiError) throw e;
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      throw new CandidateApiError(0, aborted ? 'timeout' : 'bad_response', aborted ? 'The request timed out.' : 'Unexpected response from the server.');
    } finally {
      clearTimeout(timer);
    }
  }

  const json = async <T>(method: string, path: string, body?: unknown) => (await request<T>(method, path, body)).data;

  return {
    instanceId: opts.instanceId,
    getState: () => request<CandidateSessionState>('GET', '/api/candidate/session'),
    consent: (req) => json<CandidateSessionState>('POST', '/api/candidate/consent', req),
    startCheck: (req) => json<StartCheckResponse>('POST', '/api/candidate/checks', req),
    uploadCheckFrame: async (checkId, jpeg, q) =>
      (
        await request<CheckFrameResponse>(
          'POST',
          `/api/candidate/checks/${encodeURIComponent(checkId)}/frames${qs({
            step: String(q.step),
            capturedAt: Math.round(q.capturedAt),
            nonce: q.nonce ?? undefined,
            clientYaw: q.clientYaw ?? undefined,
            clientPitch: q.clientPitch ?? undefined,
          })}`,
          jpeg,
          'jpeg',
        )
      ).data,
    completeCheck: (checkId) => json<CompleteCheckResponse>('POST', `/api/candidate/checks/${encodeURIComponent(checkId)}/complete`),
    start: () => request<CandidateSessionState>('POST', '/api/candidate/start'),
    saveAnswer: (questionId, req) => json<SaveAnswerResponse>('PUT', `/api/candidate/answers/${encodeURIComponent(questionId)}`, req),
    heartbeat: (req) => request<HeartbeatResponse>('POST', '/api/candidate/heartbeat', req),
    sendEvents: (events) => json<EventBatchResponse>('POST', '/api/candidate/events/batch', { events }),
    uploadEvidence: async (evidenceId, jpeg, q) =>
      (
        await request<EvidenceUploadResponse>(
          'PUT',
          `/api/candidate/evidence/${encodeURIComponent(evidenceId)}${qs({ eventId: q.eventId, capturedAt: Math.round(q.capturedAt), reason: q.reason })}`,
          jpeg,
          'jpeg',
        )
      ).data,
    identitySample: async (sampleId, jpeg, q) =>
      (
        await request<IdentitySampleResponse>(
          'POST',
          `/api/candidate/identity/sample${qs({ sampleId, trigger: q.trigger, capturedAt: Math.round(q.capturedAt) })}`,
          jpeg,
          'jpeg',
        )
      ).data,
    pause: (reason) => json<PauseResponse>('POST', '/api/candidate/pause', reason ? { reason } : {}),
    cancelPause: () => request<CandidateSessionState>('POST', '/api/candidate/pause/cancel'),
    submit: () => request<CandidateSessionState>('POST', '/api/candidate/submit'),
  };
}

/** RFC 4122 v4 UUID; uses crypto.randomUUID when available (secure contexts). */
export function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** One id per page load: a reload is a new client instance by design. */
let pageInstanceId: string | null = null;
export function getPageInstanceId(): string {
  if (!pageInstanceId) pageInstanceId = uuid();
  return pageInstanceId;
}

/** SHA-256 hex of a string (used for camera deviceId — the raw id never leaves the browser). */
export async function sha256Hex(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || !input) return '';
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('');
}

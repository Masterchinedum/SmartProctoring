import { describe, expect, it, vi } from 'vitest';
import { CandidateApiError, classifyApiError, createCandidateApi, isRetryable, isServerBusy, sha256Hex, uuid } from './api';

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('candidate api client', () => {
  it('sends the bearer token and the client instance header', async () => {
    const { fn, calls } = mockFetch(() => json(200, { serverTime: 1 }));
    const api = createCandidateApi({ token: 'tok123', instanceId: 'inst-abcdef', fetchImpl: fn });
    const res = await api.getState();
    expect(res.data).toEqual({ serverTime: 1 });
    expect(res.timing.receivedAt).toBeGreaterThanOrEqual(res.timing.sentAt);
    const h = calls[0].init.headers as Record<string, string>;
    expect(calls[0].url).toBe('/api/candidate/session');
    expect(h.Authorization).toBe('Bearer tok123');
    expect(h['X-Client-Instance']).toBe('inst-abcdef');
  });

  it('uploads raw JPEG with metadata in the query string', async () => {
    const { fn, calls } = mockFetch(() => json(200, { accepted: true, quality: {}, guidance: [] }));
    const api = createCandidateApi({ token: 't', instanceId: 'inst-abcdef', fetchImpl: fn });
    await api.uploadCheckFrame('chk/1', new Uint8Array([1, 2, 3]), { step: 'frontal', capturedAt: 1234.6, nonce: 'n1', clientYaw: -12.346, clientPitch: null });
    const { url, init } = calls[0];
    expect(url.startsWith('/api/candidate/checks/chk%2F1/frames?')).toBe(true);
    const q = new URLSearchParams(url.split('?')[1]);
    expect(q.get('step')).toBe('frontal');
    expect(q.get('capturedAt')).toBe('1235');
    expect(q.get('nonce')).toBe('n1');
    expect(q.get('clientYaw')).toBe('-12.35');
    expect(q.has('clientPitch')).toBe(false);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('image/jpeg');
    expect(init.body).toBeInstanceOf(Blob);
  });

  it('sends evidence and identity sample metadata', async () => {
    const { fn, calls } = mockFetch(() => json(200, {}));
    const api = createCandidateApi({ token: 't', instanceId: 'inst-abcdef', fetchImpl: fn });
    await api.uploadEvidence('ev-1', new Uint8Array([1]), { eventId: 'e1', capturedAt: 5, reason: 'onset' });
    await api.identitySample('s-1', new Uint8Array([1]), { trigger: 'face_return', capturedAt: 7 });
    expect(calls[0].init.method).toBe('PUT');
    expect(calls[0].url).toBe('/api/candidate/evidence/ev-1?eventId=e1&capturedAt=5&reason=onset');
    expect(calls[1].init.method).toBe('POST');
    expect(calls[1].url).toBe('/api/candidate/identity/sample?sampleId=s-1&trigger=face_return&capturedAt=7');
  });

  it('sends JSON bodies and an empty object for bodiless POSTs', async () => {
    const { fn, calls } = mockFetch(() => json(200, {}));
    const api = createCandidateApi({ token: 't', instanceId: 'inst-abcdef', fetchImpl: fn });
    await api.saveAnswer('q1', { value: ['a'], clientSeq: 3, answeredAt: 10 });
    await api.submit();
    expect(calls[0].init.method).toBe('PUT');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ value: ['a'], clientSeq: 3, answeredAt: 10 });
    expect(calls[1].init.body).toBe('{}');
  });

  it('maps error responses to CandidateApiError with the server code', async () => {
    const { fn } = mockFetch(() => json(409, { error: 'invalid_state', message: 'Not now' }));
    const api = createCandidateApi({ token: 't', instanceId: 'inst-abcdef', fetchImpl: fn });
    const err = await api.start().catch((e) => e);
    expect(err).toBeInstanceOf(CandidateApiError);
    expect(err).toMatchObject({ status: 409, code: 'invalid_state', message: 'Not now' });
    expect(classifyApiError(err)).toBe('invalid_state');
  });

  it('reports superseded and invalid links as fatal', async () => {
    const onFatal = vi.fn();
    let status = 409;
    let body: unknown = { error: 'superseded', message: 'Another browser' };
    const { fn } = mockFetch(() => json(status, body));
    const api = createCandidateApi({ token: 't', instanceId: 'inst-abcdef', fetchImpl: fn, onFatal });
    await expect(api.heartbeat({} as never)).rejects.toBeInstanceOf(CandidateApiError);
    expect(onFatal).toHaveBeenLastCalledWith('superseded', expect.any(CandidateApiError));
    status = 401;
    body = { error: 'unauthorized', message: 'bad token' };
    await expect(api.getState()).rejects.toBeInstanceOf(CandidateApiError);
    expect(onFatal).toHaveBeenLastCalledWith('invalid_link', expect.any(CandidateApiError));
    status = 404;
    body = { error: 'not_found', message: 'no' };
    await expect(api.getState()).rejects.toBeInstanceOf(CandidateApiError);
    expect(onFatal).toHaveBeenCalledTimes(3);
    // a 404 on another endpoint (e.g. an unknown check) is NOT an invalid link
    await expect(api.completeCheck('x')).rejects.toBeInstanceOf(CandidateApiError);
    expect(onFatal).toHaveBeenCalledTimes(3);
  });

  it('turns network failures into status-0 errors', async () => {
    const fn = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const api = createCandidateApi({ token: 't', instanceId: 'inst-abcdef', fetchImpl: fn });
    const err = await api.getState().catch((e) => e);
    expect(err).toMatchObject({ status: 0, code: 'network_error' });
    expect(err.isNetwork).toBe(true);
    expect(isRetryable(err)).toBe(true);
  });

  it('handles non-JSON error bodies', async () => {
    const { fn } = mockFetch(() => new Response('Bad gateway', { status: 502 }));
    const api = createCandidateApi({ token: 't', instanceId: 'inst-abcdef', fetchImpl: fn });
    const err = await api.getState().catch((e) => e);
    expect(err).toMatchObject({ status: 502, code: 'http_502' });
    expect(classifyApiError(err)).toBe('server');
    expect(isRetryable(err)).toBe(true);
  });

  it('classifies errors', () => {
    expect(classifyApiError(new CandidateApiError(400, 'validation_failed', ''))).toBe('client');
    expect(classifyApiError(new CandidateApiError(423, 'locked', ''))).toBe('invalid_state');
    expect(classifyApiError(new CandidateApiError(429, 'rate_limited', ''))).toBe('rate_limited');
    expect(classifyApiError(new CandidateApiError(403, 'not_verified', ''))).toBe('not_verified');
    expect(isRetryable(new CandidateApiError(400, 'validation_failed', ''))).toBe(false);
  });

  it('tells a busy server apart from a failing connection', () => {
    expect(isServerBusy(new CandidateApiError(503, 'vision_busy', 'busy'))).toBe(true);
    expect(isServerBusy(new CandidateApiError(429, 'rate_limited', ''))).toBe(true);
    expect(isServerBusy(new CandidateApiError(502, 'http_502', 'Bad Gateway'))).toBe(false);
    expect(isServerBusy(new CandidateApiError(500, 'internal', ''))).toBe(false);
    expect(isServerBusy(new CandidateApiError(0, 'network_error', ''))).toBe(false);
    expect(isServerBusy(new Error('x'))).toBe(false);
  });
});

describe('helpers', () => {
  it('generates v4 uuids', () => {
    const id = uuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuid()).not.toBe(id);
  });
  it('hashes device ids with SHA-256', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Hex('')).toBe('');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimelineItemDTO } from '@sp/shared';
import { makeCheck, makeEvent, makePeriod } from '../test/fixtures';
import { offsetLabel, precedingFacts, scalePosition } from './compare';
import { fitWithin } from './image';
import { api, ApiError, buildQuery, request, setUnauthorizedHandler, shouldRetry } from '../api/client';
import { backoffMs, liveUrl } from '../api/live';
import { roleAtLeast } from '../auth';
import { validateSettingsDraft } from '../pages/SettingsPage';
import { assignableRoles } from '../pages/UsersPage';
import { contextLabel, decisionCategory } from './labels';

describe('fitWithin', () => {
  it('scales the longest side down to the limit without upscaling', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1280, height: 960 });
    expect(fitWithin(1080, 1920)).toEqual({ width: 720, height: 1280 });
    expect(fitWithin(640, 480)).toEqual({ width: 640, height: 480 });
    expect(fitWithin(0, 10)).toEqual({ width: 0, height: 0 });
  });
});

describe('comparison helpers', () => {
  const T = 1_000_000;
  const paused = makePeriod('paused', T - 600_000, T - 120_000);
  const items: TimelineItemDTO[] = [
    { kind: 'period', at: paused.startedAt, period: paused },
    { kind: 'event', at: T - 60_000, event: makeEvent('candidate_absent', T - 60_000) },
    { kind: 'event', at: T + 30_000, event: makeEvent('camera_disconnected', T + 30_000) }, // after: ignored
    { kind: 'identity_check', at: T - 200_000, check: makeCheck('match', T - 200_000, { trigger: 'reconnect' }) },
  ];
  it('answers what happened just before the event', () => {
    const facts = Object.fromEntries(precedingFacts(items, T).map((f) => [f.key, f.item]));
    expect(facts.paused?.at).toBe(paused.startedAt);
    expect(facts.face_left?.kind).toBe('event');
    expect(facts.camera).toBeNull();
    expect(facts.disconnected?.kind).toBe('identity_check');
    expect(facts.multiple_people).toBeNull();
  });
  it('positions values on the similarity scale and labels offsets', () => {
    expect(scalePosition(0.4)).toBeCloseTo(40);
    expect(scalePosition(-0.2)).toBe(0);
    expect(scalePosition(1.3)).toBe(100);
    expect(offsetLabel(T - 185_000, T)).toBe('−3m 05s');
    expect(offsetLabel(T + 12_000, T)).toBe('+12s');
    expect(offsetLabel(T, T)).toBe('0s');
  });
});

describe('labels', () => {
  it('never maps unable_to_verify to integrity', () => {
    expect(decisionCategory('unable_to_verify')).toBe('uncertain');
    expect(decisionCategory('inconclusive')).toBe('uncertain');
    expect(decisionCategory('mismatch')).toBe('integrity');
    expect(decisionCategory('match')).toBe('neutral');
  });
  it('labels context keys', () => {
    expect(contextLabel('session_resumed')).toBe('Exam was resumed');
    expect(contextLabel('face_absence')).toBe('Face left the camera view');
    expect(contextLabel('phone_detected')).toBe('Preceded by: Phone visible');
    expect(contextLabel('someThing')).toBe('Some thing');
  });
});

describe('api client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setUnauthorizedHandler(null);
  });

  it('builds query strings skipping empty values', () => {
    expect(buildQuery({ a: 1, b: '', c: undefined, d: null, e: 'x y', f: false })).toBe('?a=1&e=x+y&f=false');
    expect(buildQuery({})).toBe('');
  });

  it('sends JSON with credentials and parses ApiError bodies', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_state', message: 'Session is not on hold' }), { status: 409, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const err = (await api.release('s1', { requireCheck: true, reEnroll: false }).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('invalid_state');
    expect(err.status).toBe(409);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/admin/sessions/s1/release');
    expect(init.credentials).toBe('include');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ requireCheck: true, reEnroll: false });
  });

  it('sends an empty JSON object for body-less POSTs and calls the 401 handler', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    await expect(api.publishExam('e1')).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.body).toBe('{}');
    // the auth probe must not trigger a redirect loop
    await expect(api.me()).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('uploads raw JPEG bodies', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const blob = new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' });
    await api.uploadIdPhoto('c1', blob);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('image/jpeg');
    expect(init.body).toBe(blob);
  });

  it('maps network failures and retries only server/network errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const err = (await request('GET', '/api/admin/dashboard').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('network_error');
    expect(shouldRetry(0, err)).toBe(true);
    expect(shouldRetry(1, err)).toBe(false);
    expect(shouldRetry(0, new ApiError(404, 'not_found', 'x'))).toBe(false);
  });
});

describe('realtime helpers', () => {
  it('derives the WebSocket URL from the page origin', () => {
    expect(liveUrl({ protocol: 'https:', host: 'proctor.example.com' })).toBe('wss://proctor.example.com/api/admin/live');
    expect(liveUrl({ protocol: 'http:', host: 'localhost:5175' })).toBe('ws://localhost:5175/api/admin/live');
  });
  it('backs off exponentially with jitter, capped at 30 s', () => {
    expect(backoffMs(0, () => 0.5)).toBe(1000);
    expect(backoffMs(3, () => 0.5)).toBe(8000);
    expect(backoffMs(10, () => 0.5)).toBe(30000);
    expect(backoffMs(2, () => 0)).toBe(3200);
    expect(backoffMs(2, () => 1)).toBe(4800);
  });
});

describe('roles', () => {
  it('ranks roles and limits what admins can assign', () => {
    expect(roleAtLeast('owner', 'admin')).toBe(true);
    expect(roleAtLeast('reviewer', 'admin')).toBe(false);
    expect(roleAtLeast(undefined, 'reviewer')).toBe(false);
    expect(assignableRoles('owner')).toEqual(['owner', 'admin', 'reviewer']);
    expect(assignableRoles('admin')).toEqual(['reviewer']);
  });
});

describe('settings validation', () => {
  const ok = {
    name: 'Org',
    evidenceRetentionDays: '30',
    eventRetentionDays: '365',
    privacyContact: 'privacy@example.com',
    match: '0.4',
    mismatch: '0.28',
    idPhotoMatch: '0.36',
    idPhotoMismatch: '0.24',
    mismatchConfirmations: '2',
  };
  it('accepts valid settings and rejects inconsistent thresholds', () => {
    expect(validateSettingsDraft(ok)).toEqual({});
    expect(validateSettingsDraft({ ...ok, mismatch: '0.5' }).mismatch).toMatch(/lower than/);
    expect(validateSettingsDraft({ ...ok, match: '1.5' }).match).toBeDefined();
    expect(validateSettingsDraft({ ...ok, eventRetentionDays: '10' }).eventRetentionDays).toBeDefined();
    expect(validateSettingsDraft({ ...ok, evidenceRetentionDays: '2.5' }).evidenceRetentionDays).toBeDefined();
    expect(validateSettingsDraft({ ...ok, mismatchConfirmations: '0' }).mismatchConfirmations).toBeDefined();
    expect(validateSettingsDraft({ ...ok, name: ' ' }).name).toBe('Required');
  });
});

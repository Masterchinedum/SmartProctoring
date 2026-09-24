/**
 * Staff API access control: authentication, role enforcement and organisation isolation.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startedSession } from '../flow.js';
import { createTestEnv, type TestEnv } from '../helpers.js';
import { clientEvent, json, MIN, otherOrg, screenshot, staffApi, type Api } from './fixtures.js';

let env: TestEnv;
let reviewer: Api;
let admin: Api;
let other: Awaited<ReturnType<typeof otherOrg>>;
let eventId: string;
let evidenceId: string;

beforeAll(async () => {
  env = await createTestEnv();
  reviewer = await staffApi(env, 'reviewer');
  admin = await staffApi(env, 'admin');
  other = await otherOrg(env);
  const c = await startedSession(env);
  env.clock.advance(MIN);
  eventId = await clientEvent(c, { type: 'multiple_people', startedAt: env.clock.t - 20_000, endedAt: env.clock.t - 8_000, confidence: 0.91 });
  evidenceId = await screenshot(c, eventId, env.clock.t - 15_000, { person: 'alice', faces: 2 });
});
afterAll(async () => env?.close());

type Ids = { session: string; candidate: string; exam: string; user: string };
const ADMIN_ONLY: [method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: (ids: Ids) => string, body?: unknown | ((ids: Ids) => unknown)][] = [
  ['POST', (i) => `/sessions/${i.session}/terminate`, { reason: 'x' }],
  ['POST', (i) => `/sessions/${i.session}/submit`, {}],
  ['POST', (i) => `/sessions/${i.session}/legal-hold`, { enabled: true }],
  ['POST', (i) => `/sessions/${i.session}/regenerate-link`, {}],
  ['POST', (i) => `/sessions/${i.session}/extend`, { minutes: 5 }],
  ['POST', () => `/exams`, { title: 'X', durationSec: 600 }],
  ['PUT', (i) => `/exams/${i.exam}`, { title: 'X', durationSec: 600 }],
  ['POST', (i) => `/exams/${i.exam}/publish`, {}],
  ['POST', (i) => `/exams/${i.exam}/archive`, {}],
  ['POST', (i) => `/exams/${i.exam}/assignments`, (i: Ids) => ({ candidateIds: [i.candidate] })],
  ['POST', () => `/candidates`, { name: 'X' }],
  ['PUT', (i) => `/candidates/${i.candidate}`, { name: 'X' }],
  ['DELETE', (i) => `/candidates/${i.candidate}`],
  ['DELETE', (i) => `/candidates/${i.candidate}/id-photo`],
  ['GET', () => `/settings`],
  ['PUT', () => `/settings`, { name: 'X' }],
  ['GET', () => `/users`],
  ['POST', () => `/users`, { email: 'x@y.example', name: 'X', role: 'reviewer', password: 'long-enough-password' }],
  ['PUT', (i) => `/users/${i.user}`, { name: 'X' }],
  ['GET', () => `/audit-log`],
  ['POST', () => `/metrics/offline-evaluation`, { tool: 'identity-eval' }],
];

describe('authentication', () => {
  it('rejects unauthenticated requests with 401 on every staff endpoint family', async () => {
    for (const url of ['/api/admin/dashboard', '/api/admin/sessions', `/api/admin/sessions/${env.session.id}`, '/api/admin/events', `/api/admin/evidence/${evidenceId}`, '/api/admin/exams', '/api/admin/candidates', '/api/admin/metrics/detection-quality']) {
      const res = await env.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().error).toBe('unauthorized');
    }
  });

  it('works with a cookie from the real login endpoint', async () => {
    const cookie = await env.login('reviewer');
    const res = await env.app.inject({ method: 'GET', url: '/api/admin/dashboard', headers: { cookie } });
    expect(res.statusCode).toBe(200);
  });

  it('refuses cross-origin state-changing requests', async () => {
    const res = await reviewer.inject({ method: 'POST', url: `/api/admin/sessions/${env.session.id}/notes`, headers: { origin: 'https://evil.example' }, payload: { text: 'hi' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('bad_origin');
  });
});

describe('roles', () => {
  it('a reviewer gets 403 on every admin-only endpoint', async () => {
    const ids = { session: env.session.id, candidate: env.candidate.id, exam: env.exam.id, user: env.users.reviewer.id };
    for (const [method, path, body] of ADMIN_ONLY) {
      const url = `/api/admin${path(ids)}`;
      const payload = typeof body === 'function' ? (body as (i: Ids) => unknown)(ids) : body;
      const res = await reviewer.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(403);
      expect(res.json().error).toBe('forbidden');
    }
  });

  it('a reviewer can use the review endpoints', async () => {
    json(await reviewer.get('/dashboard'));
    json(await reviewer.get('/sessions'));
    json(await reviewer.get(`/sessions/${env.session.id}`));
    json(await reviewer.get(`/sessions/${env.session.id}/timeline`));
    json(await reviewer.get(`/sessions/${env.session.id}/report`));
    json(await reviewer.get(`/events/${eventId}`));
    json(await reviewer.post(`/events/${eventId}/notes`, { text: 'Looked at this' }));
    json(await reviewer.get('/exams'));
    json(await reviewer.get('/candidates'));
    json(await reviewer.get('/metrics/detection-quality'));
    const img = await reviewer.get(`/evidence/${evidenceId}`);
    expect(img.statusCode).toBe(200);
  });

  it('an admin can use admin endpoints', async () => {
    json(await admin.get('/settings'));
    json(await admin.get('/users'));
    json(await admin.get('/audit-log'));
  });
});

describe('organisation isolation', () => {
  it('staff of another organisation cannot see or act on this organisation’s data (404, never 403)', async () => {
    const o = other.api;
    const sid = env.session.id;
    const checks: [string, Promise<{ statusCode: number }>][] = [
      ['session', o.get(`/sessions/${sid}`)],
      ['session events', o.get(`/sessions/${sid}/events`)],
      ['session csv', o.get(`/sessions/${sid}/events.csv`)],
      ['timeline', o.get(`/sessions/${sid}/timeline`)],
      ['report', o.get(`/sessions/${sid}/report`)],
      ['note', o.post(`/sessions/${sid}/notes`, { text: 'x' })],
      ['hold', o.post(`/sessions/${sid}/hold`, {})],
      ['terminate', o.post(`/sessions/${sid}/terminate`, { reason: 'x' })],
      ['legal hold', o.post(`/sessions/${sid}/legal-hold`, { enabled: true })],
      ['extend', o.post(`/sessions/${sid}/extend`, { minutes: 5 })],
      ['event', o.get(`/events/${eventId}`)],
      ['review', o.post(`/events/${eventId}/review`, { status: 'dismissed' })],
      ['event notes', o.get(`/events/${eventId}/notes`)],
      ['compare', o.get(`/identity/compare/${eventId}`)],
      ['evidence', o.get(`/evidence/${evidenceId}`)],
      ['exam', o.get(`/exams/${env.exam.id}`)],
      ['exam update', o.put(`/exams/${env.exam.id}`, { title: 'Hijack', durationSec: 600 })],
      ['exam sessions', o.get(`/exams/${env.exam.id}/sessions`)],
      ['candidate', o.get(`/candidates/${env.candidate.id}`)],
      ['candidate delete', o.del(`/candidates/${env.candidate.id}`)],
      ['user update', o.put(`/users/${env.users.reviewer.id}`, { name: 'Hijack' })],
    ];
    for (const [what, p] of checks) expect((await p).statusCode, what).toBe(404);

    // Lists never include the other organisation's rows.
    const sessions = json(await o.get('/sessions'));
    expect(sessions.items.map((s: { id: string }) => s.id)).toEqual([other.session.id]);
    expect(sessions.total).toBe(1);
    const dash = json(await o.get('/dashboard'));
    expect(dash.sessions.map((s: { id: string }) => s.id)).not.toContain(sid);
    expect(dash.recentEvents).toHaveLength(0);
    expect(json(await o.get('/events')).items).toHaveLength(0);
    expect(json(await o.get('/candidates')).items.map((c: { id: string }) => c.id)).toEqual([other.candidate.id]);
    expect(json(await o.get('/exams')).items.map((e: { id: string }) => e.id)).toEqual([other.exam.id]);
    expect(json(await o.get('/users')).items.map((u: { id: string }) => u.id)).toEqual([other.admin.id]);
    const audit = json(await o.get('/audit-log'));
    expect(audit.items.every((a: { targetId: string }) => a.targetId !== sid)).toBe(true);

    // Assigning another organisation's candidate is refused.
    const assign = await admin.post(`/exams/${env.exam.id}/assignments`, { candidateIds: [other.candidate.id] });
    expect(assign.statusCode).toBe(400);

    // Nothing was changed by the attempts above.
    const ev = json(await reviewer.get(`/events/${eventId}`));
    expect(ev.review.status).toBe('unreviewed');
    const s = json(await reviewer.get(`/sessions/${sid}`));
    expect(s.summary.status).toBe('active');
  });

  it('non-UUID ids are 404, not server errors', async () => {
    for (const url of ['/sessions/not-a-uuid', '/events/123', '/evidence/%27%3B--', '/identity/compare/x', '/exams/abc', '/candidates/abc']) {
      const res = await reviewer.get(url);
      expect(res.statusCode, url).toBe(404);
    }
    expect((await reviewer.get(`/sessions/${randomUUID()}`)).statusCode).toBe(404);
  });
});

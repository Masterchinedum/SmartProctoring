/**
 * Organisation API keys (staff endpoints) and the integration API /api/v1/*.
 */
import type { CreatedApiKeyDTO, IntegrationSessionDTO } from '@sp/shared';
import { and, eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiKeys, auditLog, candidates, examSessions } from '../../src/db/schema.js';
import { sweepOnce } from '../../src/jobs/sweeper.js';
import { clientEvent, json, MIN, otherOrg, screenshot, staffApi, type Api } from '../admin/fixtures.js';
import { startedSession } from '../flow.js';
import { createTestEnv, type TestEnv } from '../helpers.js';

let env: TestEnv;
let admin: Api;
let reviewer: Api;
let other: Awaited<ReturnType<typeof otherOrg>>;
let key: string;
let keyId: string;

const v1 = (k: string | null, method: InjectOptions['method'], url: string, body?: unknown) =>
  env.app.inject({ method, url: `/api/v1${url}`, headers: k ? { authorization: `Bearer ${k}` } : {}, ...(body !== undefined ? { payload: body as InjectOptions['payload'] } : {}) });

beforeAll(async () => {
  env = await createTestEnv({ env: { API_RATE_LIMIT_PER_MINUTE: '40' } });
  admin = await staffApi(env, 'admin');
  reviewer = await staffApi(env, 'reviewer');
  other = await otherOrg(env);
  const created = json<CreatedApiKeyDTO>(await admin.post('/api-keys', { name: 'LMS production' }));
  key = created.secret;
  keyId = created.apiKey.id;
});
afterAll(async () => env?.close());

describe('API keys (staff)', () => {
  it('creates a key shown once (sp_live_ + 43 chars), lists it by prefix and audits create/revoke', async () => {
    expect(key).toMatch(/^sp_live_[A-Za-z0-9_-]{43}$/);
    const list = json<{ items: { id: string; prefix: string; name: string; createdBy: { name: string } | null; revokedAt: number | null }[] }>(await admin.get('/api-keys'));
    const row = list.items.find((k) => k.id === keyId)!;
    expect(row).toMatchObject({ name: 'LMS production', prefix: key.slice(0, 16), revokedAt: null, createdBy: { name: 'Test admin' } });
    expect(JSON.stringify(list)).not.toContain(key);
    // Only the hash is stored.
    const [stored] = await env.ctx.db.select().from(apiKeys).where(eq(apiKeys.id, keyId));
    expect(stored.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(key.slice(16));

    const tmp = json<CreatedApiKeyDTO>(await admin.post('/api-keys', { name: 'temporary' }));
    expect(json(await v1(tmp.secret, 'GET', '/exams')).items.length).toBeGreaterThan(0);
    const revoked = json(await admin.post(`/api-keys/${tmp.apiKey.id}/revoke`));
    expect(revoked.revokedAt).toBe(env.clock.t);
    const denied = await v1(tmp.secret, 'GET', '/exams');
    expect(denied.statusCode).toBe(401);
    expect(denied.json().error).toBe('invalid_api_key');
    expect(denied.headers['www-authenticate']).toMatch(/Bearer/);
    const audits = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.targetType, 'api_key'), eq(auditLog.targetId, tmp.apiKey.id)));
    expect(audits.map((a) => a.action).sort()).toEqual(['api_key.created', 'api_key.revoked']);
    expect(JSON.stringify(audits)).not.toContain(tmp.secret);
  });

  it('is admin-only and organisation-scoped', async () => {
    expect((await reviewer.get('/api-keys')).statusCode).toBe(403);
    expect((await reviewer.post('/api-keys', { name: 'x' })).statusCode).toBe(403);
    expect((await other.api.post(`/api-keys/${keyId}/revoke`)).statusCode).toBe(404);
    expect(json(await other.api.get('/api-keys')).items).toHaveLength(0);
    expect((await admin.post('/api-keys', { name: '' })).statusCode).toBe(400);
  });
});

describe('integration API authentication', () => {
  it('rejects missing, malformed, unknown and staff credentials', async () => {
    for (const h of [undefined, 'Bearer nope', `Bearer sp_live_${'A'.repeat(43)}`, `Basic ${key}`, key]) {
      const res = await env.app.inject({ method: 'GET', url: '/api/v1/exams', headers: h ? { authorization: h } : {} });
      expect(res.statusCode, String(h)).toBe(401);
      expect(res.json().error).toBe('invalid_api_key');
    }
    // A staff cookie is not an API key.
    const res = await env.app.inject({ method: 'GET', url: '/api/v1/exams', headers: { cookie: admin.cookie } });
    expect(res.statusCode).toBe(401);
    // And an API key cannot use the staff API.
    expect((await env.app.inject({ method: 'GET', url: '/api/admin/sessions', headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(401);
  });

  it('records lastUsedAt (at most once a minute)', async () => {
    env.clock.advance(2 * MIN);
    json(await v1(key, 'GET', '/exams'));
    const [row] = await env.ctx.db.select().from(apiKeys).where(eq(apiKeys.id, keyId));
    expect(row.lastUsedAt?.getTime()).toBe(env.clock.t);
  });

  it('never sees another organisation (404, not 403)', async () => {
    expect((await v1(key, 'GET', `/sessions/${other.session.id}`)).statusCode).toBe(404);
    expect((await v1(key, 'GET', `/sessions/${other.session.id}/report`)).statusCode).toBe(404);
    expect((await v1(key, 'GET', `/sessions/${other.session.id}/events`)).statusCode).toBe(404);
    expect((await v1(key, 'POST', `/exams/${other.exam.id}/assignments`, { candidateIds: [env.candidate.id] })).statusCode).toBe(404);
    const r = await v1(key, 'POST', `/exams/${env.exam.id}/assignments`, { candidateIds: [other.candidate.id] });
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(json(await v1(key, 'GET', '/sessions?limit=500')).items)).not.toContain(other.session.id);
    expect(json(await v1(key, 'GET', '/exams')).items.map((e: { id: string }) => e.id)).not.toContain(other.exam.id);
  });
});

describe('integration API endpoints', () => {
  it('GET /exams lists id, title, status, durationSec with a status filter', async () => {
    await env.newExam({ title: 'Draft exam' }).then(async ({ exam }) => admin.post(`/exams/${exam.id}/archive`));
    const all = json(await v1(key, 'GET', '/exams')).items as { id: string; title: string; status: string; durationSec: number }[];
    expect(all.find((e) => e.id === env.exam.id)).toEqual({ id: env.exam.id, title: 'Sample Exam', status: 'published', durationSec: 3600 });
    const published = json(await v1(key, 'GET', '/exams?status=published')).items as { status: string }[];
    expect(published.every((e) => e.status === 'published')).toBe(true);
    expect(published.length).toBeLessThan(all.length);
    expect((await v1(key, 'GET', '/exams?status=bogus')).statusCode).toBe(400);
  });

  it('POST /candidates upserts by externalId; GET /candidates?externalId= finds it', async () => {
    const c1 = await v1(key, 'POST', '/candidates', { name: 'Ada Lovelace', email: 'ada@example.edu', externalId: 'S-100' });
    expect(c1.statusCode).toBe(201);
    const a = c1.json();
    expect(a).toMatchObject({ created: true, candidate: { name: 'Ada Lovelace', email: 'ada@example.edu', externalId: 'S-100' } });
    const c2 = await v1(key, 'POST', '/candidates', { name: 'Ada King', externalId: 'S-100' });
    expect(c2.statusCode).toBe(200);
    expect(c2.json()).toMatchObject({ created: false, candidate: { id: a.candidate.id, name: 'Ada King', email: 'ada@example.edu' } });
    // Unchanged repeat is a no-op (no audit entry).
    expect((await v1(key, 'POST', '/candidates', { name: 'Ada King', externalId: 'S-100' })).statusCode).toBe(200);
    // Concurrent upserts of a new external id create exactly one candidate.
    const burst = await Promise.all([1, 2, 3, 4].map(() => v1(key, 'POST', '/candidates', { name: 'Grace Hopper', externalId: 'S-200' })));
    expect(burst.filter((r) => r.statusCode === 201)).toHaveLength(1);
    const rows = await env.ctx.db.select().from(candidates).where(and(eq(candidates.orgId, env.org.id), eq(candidates.externalId, 'S-200')));
    expect(rows).toHaveLength(1);
    // Without externalId: always a new candidate.
    expect((await v1(key, 'POST', '/candidates', { name: 'No Id' })).statusCode).toBe(201);
    expect((await v1(key, 'POST', '/candidates', { name: '', externalId: 'x' })).statusCode).toBe(400);
    expect((await v1(key, 'POST', '/candidates', { name: 'Bad', email: 'not-an-email' })).statusCode).toBe(400);

    const found = json(await v1(key, 'GET', '/candidates?externalId=S-100'));
    expect(found).toMatchObject({ total: 1, items: [{ id: a.candidate.id, externalId: 'S-100' }] });
    expect(json(await v1(key, 'GET', '/candidates?externalId=nope')).items).toEqual([]);
    const audits = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.actorType, 'api_key'), eq(auditLog.targetId, a.candidate.id)));
    expect(audits.map((x) => x.action)).toEqual(expect.arrayContaining(['api.candidate.created', 'api.candidate.updated']));
    expect(audits.every((x) => x.actorId === keyId)).toBe(true);
    // The staff audit log shows the key name as the actor.
    const staffView = json(await admin.get('/audit-log', { action: 'api.candidate' })).items as { actorType: string; actorName: string }[];
    expect(staffView[0]).toMatchObject({ actorType: 'api_key', actorName: 'API key “LMS production”' });
  });

  it('POST /exams/:id/assignments accepts candidateIds and externalIds, returns links and dedupes like the staff endpoint', async () => {
    const { exam } = await env.newExam({ title: 'Assigned via API' });
    const s1 = json(await v1(key, 'POST', '/candidates', { name: 'Stu One', externalId: 'A-1' }), 201).candidate;
    const s2 = json(await v1(key, 'POST', '/candidates', { name: 'Stu Two', externalId: 'A-2' }), 201).candidate;
    const first = json(await v1(key, 'POST', `/exams/${exam.id}/assignments`, { candidateIds: [s1.id], externalIds: ['A-2', 'A-1'] })).items;
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({ candidateId: s1.id, candidateName: 'Stu One', externalId: 'A-1', existing: false });
    expect(first[1]).toMatchObject({ candidateId: s2.id, externalId: 'A-2', existing: false });
    expect(first[0].accessLink).toMatch(/^http:\/\/exam\.test\/take\//);
    const again = json(await v1(key, 'POST', `/exams/${exam.id}/assignments`, { externalIds: ['A-1', 'A-2'] })).items;
    expect(again.map((a: { sessionId: string }) => a.sessionId)).toEqual(first.map((a: { sessionId: string }) => a.sessionId));
    expect(again.every((a: { existing: boolean }) => a.existing)).toBe(true);
    expect(again[0].accessLink).toBe(first[0].accessLink);
    const n = await env.ctx.db.select().from(examSessions).where(eq(examSessions.examId, exam.id));
    expect(n).toHaveLength(2);

    const unknown = await v1(key, 'POST', `/exams/${exam.id}/assignments`, { externalIds: ['A-1', 'missing'] });
    expect(unknown.statusCode).toBe(400);
    expect(JSON.stringify(unknown.json().details)).toContain('missing');
    expect((await v1(key, 'POST', `/exams/${exam.id}/assignments`, {})).statusCode).toBe(400);
    const archived = await env.newExam({ title: 'Archived' });
    await admin.post(`/exams/${archived.exam.id}/archive`);
    const na = await v1(key, 'POST', `/exams/${archived.exam.id}/assignments`, { externalIds: ['A-1'] });
    expect(na.statusCode).toBe(409);
    expect(na.json().error).toBe('exam_not_published');
    expect((await v1(key, 'POST', `/exams/not-a-uuid/assignments`, { externalIds: ['A-1'] })).statusCode).toBe(404);
  });

  it('GET /sessions/:id summarises status, times, score, counts and hold; GET /sessions filters by exam, externalId and status', async () => {
    const s = await env.newSession();
    const c = await startedSession(env, env.candidateClient(s.token));
    env.clock.advance(MIN);
    const evId = await clientEvent(c, { type: 'multiple_people', startedAt: env.clock.t - 20_000, endedAt: env.clock.t - 5_000, confidence: 0.9 });
    await screenshot(c, evId, env.clock.t - 15_000, { person: 'alice', faces: 2 });
    await clientEvent(c, { type: 'looking_away', startedAt: env.clock.t - 4_000, endedAt: env.clock.t - 1_000 });
    json(await admin.post(`/sessions/${s.id}/hold`, { note: 'checking' }));
    let dto = json<IntegrationSessionDTO>(await v1(key, 'GET', `/sessions/${s.id}`));
    expect(dto).toMatchObject({ id: s.id, status: 'on_hold', endReason: null, exam: { id: env.exam.id }, candidate: { id: env.candidate.id, externalId: env.candidate.externalId }, score: null });
    expect(dto.hold).toMatchObject({ reason: 'staff' });
    expect(dto.counts).toMatchObject({ integrity: 2, highSeverity: 1 });
    expect(dto.startedAt).not.toBeNull();
    expect(dto.staffUrl).toBe(`http://exam.test/admin/sessions/${s.id}`);
    expect(dto.accessLink).toBe(s.link); // single-session read only
    expect(json(await v1(key, 'GET', `/sessions?examId=${env.exam.id}`)).items.every((x: IntegrationSessionDTO) => x.accessLink === null)).toBe(true);
    json(await admin.post(`/sessions/${s.id}/submit`, {}));
    dto = json<IntegrationSessionDTO>(await v1(key, 'GET', `/sessions/${s.id}`));
    expect(dto).toMatchObject({ status: 'submitted', endReason: 'staff_submitted', hold: null });
    expect(dto.score).toMatchObject({ maxPoints: 10, autoGraded: false });

    const byExt = json(await v1(key, 'GET', `/sessions?externalId=${env.candidate.externalId}&status=submitted`));
    expect(byExt.items.map((x: { id: string }) => x.id)).toContain(s.id);
    expect(byExt.items.every((x: { status: string }) => x.status === 'submitted')).toBe(true);
    expect(byExt.total).toBe(byExt.items.length);
    const byExam = json(await v1(key, 'GET', `/sessions?examId=${env.exam.id}&limit=1`));
    expect(byExam.items).toHaveLength(1);
    expect(byExam.total).toBeGreaterThan(1);
    expect((await v1(key, 'GET', '/sessions?status=bogus')).statusCode).toBe(400);
    expect((await v1(key, 'GET', '/sessions?examId=nope')).statusCode).toBe(400);

    // Report: the staff report without evidence URLs.
    const report = json(await v1(key, 'GET', `/sessions/${s.id}/report?tz=Europe/Berlin`));
    expect(report.session.id).toBe(s.id);
    expect(report.staffUrl).toBe(`http://exam.test/admin/sessions/${s.id}`);
    const mp = report.notableEvents.find((e: { id: string }) => e.id === evId);
    expect(mp).toMatchObject({ type: 'multiple_people', evidenceCount: 1, staffUrl: `http://exam.test/admin/sessions/${s.id}?event=${evId}` });
    expect(mp.evidence).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain('/api/admin/evidence');
    // Events: EventDTO without evidence URLs, filterable.
    const evs = json(await v1(key, 'GET', `/sessions/${s.id}/events`)).items as { id: string; type: string; evidenceCount: number }[];
    expect(evs.map((e) => e.type)).toEqual(expect.arrayContaining(['session_started', 'multiple_people', 'looking_away', 'session_held', 'session_submitted']));
    expect(JSON.stringify(evs)).not.toContain('/api/admin/evidence');
    expect(evs.find((e) => e.id === evId)!.evidenceCount).toBe(1);
    const integrity = json(await v1(key, 'GET', `/sessions/${s.id}/events?category=integrity&severity=high`)).items;
    expect(integrity.map((e: { id: string }) => e.id)).toEqual([evId]);
    const reads = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.actorType, 'api_key'), eq(auditLog.targetId, s.id)));
    expect(reads.map((r) => r.action).sort()).toEqual(['api.session.events_read', 'api.session.events_read', 'api.session.report_read']);
  });

  it('reports time-expired submissions from the sweeper', async () => {
    const s = await env.newSession();
    await startedSession(env, env.candidateClient(s.token));
    env.clock.advance(3601_000);
    await sweepOnce(env.ctx);
    expect(json(await v1(key, 'GET', `/sessions/${s.id}`))).toMatchObject({ status: 'submitted', endReason: 'time_expired', remainingMs: 0 });
  });

  it('rate-limits per API key (429 rate_limited)', async () => {
    admin = await staffApi(env, 'admin'); // earlier tests moved the clock past the staff idle timeout
    const extra = json<CreatedApiKeyDTO>(await admin.post('/api-keys', { name: 'burst' })).secret;
    const results = [];
    for (let i = 0; i < 45; i++) results.push((await v1(extra, 'GET', '/exams')).statusCode);
    expect(results.filter((c) => c === 429).length).toBeGreaterThan(0);
    const limited = await v1(extra, 'GET', '/exams');
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe('rate_limited');
    // Another key is unaffected.
    expect((await v1(key, 'GET', '/exams')).statusCode).toBe(200);
  });
});

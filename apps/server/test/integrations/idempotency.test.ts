/**
 * Idempotency-Key on the integration API's POST endpoints (services/idempotency.ts): replay of the stored response,
 * 422 for the same key with another request, 409 while the first request runs, release of the key after a failed
 * request, takeover of abandoned and expired records, organisation scope, encryption at rest and the purge job.
 */
import { IDEMPOTENT_REPLAYED_HEADER, type CreatedApiKeyDTO } from '@sp/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiIdempotencyKeys, auditLog, candidates, examSessions } from '../../src/db/schema.js';
import { canonicalJson, IDEMPOTENCY_TTL_MS, idempotencyRequestHash, idempotencyResponseAad, purgeIdempotencyKeys } from '../../src/services/idempotency.js';
import { json, otherOrg, staffApi, type Api } from '../admin/fixtures.js';
import { createTestEnv, type TestEnv } from '../helpers.js';

let env: TestEnv;
let admin: Api;
let key: string;
let keyId: string;

const post = (k: string, url: string, body: unknown, idem?: string | string[]) =>
  env.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: { authorization: `Bearer ${k}`, ...(idem !== undefined ? { 'idempotency-key': idem } : {}) }, payload: body as InjectOptions['payload'] });
const uid = () => crypto.randomUUID();
const records = (k: string) => env.ctx.db.select().from(apiIdempotencyKeys).where(and(eq(apiIdempotencyKeys.orgId, env.org.id), eq(apiIdempotencyKeys.key, k)));
const candidatesNamed = (name: string) => env.ctx.db.select().from(candidates).where(and(eq(candidates.orgId, env.org.id), eq(candidates.name, name)));

beforeAll(async () => {
  env = await createTestEnv();
  admin = await staffApi(env, 'admin');
  const created = json<CreatedApiKeyDTO>(await admin.post('/api-keys', { name: 'LMS' }));
  key = created.secret;
  keyId = created.apiKey.id;
});
afterAll(async () => env?.close());

describe('request hash', () => {
  it('ignores object key order but not values, method, path or query', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}');
    const h = idempotencyRequestHash('POST', '/api/v1/candidates', '', { name: 'A', externalId: 'x' });
    expect(idempotencyRequestHash('post', '/api/v1/candidates', '', { externalId: 'x', name: 'A' })).toBe(h);
    expect(idempotencyRequestHash('POST', '/api/v1/candidates', '', { name: 'B', externalId: 'x' })).not.toBe(h);
    expect(idempotencyRequestHash('POST', '/api/v1/other', '', { name: 'A', externalId: 'x' })).not.toBe(h);
    expect(idempotencyRequestHash('POST', '/api/v1/candidates', 'a=1', { name: 'A', externalId: 'x' })).not.toBe(h);
  });
});

describe('Idempotency-Key', () => {
  it('replays the stored response of a create (status, body, Idempotent-Replayed) without creating twice', async () => {
    const k = uid();
    const first = await post(key, '/candidates', { name: 'Idem Once', email: 'once@example.edu' }, k);
    expect(first.statusCode).toBe(201);
    expect(first.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
    // Same request with the keys in another order: the same request.
    const again = await post(key, '/candidates', { email: 'once@example.edu', name: 'Idem Once' }, k);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(again.json()).toEqual(first.json());
    expect(await candidatesNamed('Idem Once')).toHaveLength(1);
    const audits = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'api.candidate.created'), eq(auditLog.targetId, first.json().candidate.id)));
    expect(audits).toHaveLength(1);
    const [rec] = await records(k);
    expect(rec).toMatchObject({ statusCode: 201, method: 'POST', path: '/api/v1/candidates', apiKeyId: keyId });
    expect(rec.completedAt).not.toBeNull();
  });

  it('without the header nothing is stored and each request runs', async () => {
    expect((await post(key, '/candidates', { name: 'Idem None' })).statusCode).toBe(201);
    expect((await post(key, '/candidates', { name: 'Idem None' })).statusCode).toBe(201);
    expect(await candidatesNamed('Idem None')).toHaveLength(2);
  });

  it('refuses the same key for a different body or path (422 idempotency_key_reused)', async () => {
    const k = uid();
    json(await post(key, '/candidates', { name: 'Idem Reuse' }, k), 201);
    const other = await post(key, '/candidates', { name: 'Idem Reuse 2' }, k);
    expect(other.statusCode).toBe(422);
    expect(other.json()).toMatchObject({ error: 'idempotency_key_reused' });
    expect(other.json().message).toContain('POST /api/v1/candidates');
    const otherPath = await post(key, `/exams/${env.exam.id}/assignments`, { candidateIds: [env.candidate.id] }, k);
    expect(otherPath.statusCode).toBe(422);
    expect(await candidatesNamed('Idem Reuse 2')).toHaveLength(0);
  });

  it('validates the header: 1–255 characters from the documented set, one value', async () => {
    for (const bad of ['', 'a'.repeat(256), 'has space', 'ünïcode', 'semi;colon']) {
      const res = await post(key, '/candidates', { name: 'Idem Bad' }, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json().error).toBe('invalid_idempotency_key');
    }
    const twice = await post(key, '/candidates', { name: 'Idem Bad' }, ['a', 'b']);
    expect(twice.statusCode).toBe(400);
    for (const ok of ['a', 'A-z_0.9:~+/=', 'x'.repeat(255), uid()]) expect((await post(key, '/candidates', { name: `Idem ok ${ok.length}` }, ok)).statusCode, ok).toBe(201);
    expect(await candidatesNamed('Idem Bad')).toHaveLength(0);
  });

  it('a failed request stores nothing: the same key can be retried with a corrected body', async () => {
    const k = uid();
    const bad = await post(key, '/candidates', { name: 'Idem Fix', email: 'not-an-email' }, k);
    expect(bad.statusCode).toBe(400);
    expect(await records(k)).toHaveLength(0);
    const fixed = await post(key, '/candidates', { name: 'Idem Fix', email: 'fix@example.edu' }, k);
    expect(fixed.statusCode).toBe(201);
    // State conflicts (409) release the key as well.
    const { exam } = await env.newExam({ title: 'Idem archived' });
    json(await admin.post(`/exams/${exam.id}/archive`));
    const k2 = uid();
    expect((await post(key, `/exams/${exam.id}/assignments`, { candidateIds: [env.candidate.id] }, k2)).statusCode).toBe(409);
    expect(await records(k2)).toHaveLength(0);
  });

  it('replays assignments with the same links; the stored response is encrypted at rest', async () => {
    const { exam } = await env.newExam({ title: 'Idem assignments' });
    const c = json(await post(key, '/candidates', { name: 'Idem Assignee', externalId: 'IDEM-1' }), 201).candidate;
    const k = uid();
    const first = json(await post(key, `/exams/${exam.id}/assignments`, { externalIds: ['IDEM-1'] }, k));
    expect(first.items[0]).toMatchObject({ candidateId: c.id, existing: false });
    const replay = await post(key, `/exams/${exam.id}/assignments`, { externalIds: ['IDEM-1'] }, k);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    // Replayed verbatim: `existing` stays false (a request without the key would say existing: true).
    expect(replay.json()).toEqual(first);
    expect(await env.ctx.db.select().from(examSessions).where(eq(examSessions.examId, exam.id))).toHaveLength(1);
    const [rec] = await records(k);
    const token = first.items[0].accessLink.split('/take/')[1];
    expect(rec.responseEnc!.toString('latin1')).not.toContain(token);
    expect(env.ctx.keyring.decryptString(rec.responseEnc!, idempotencyResponseAad(rec.id))).toContain(token);
  });

  it('concurrent duplicates run the request once: the others get the stored response or 409 idempotency_key_in_use', async () => {
    const k = uid();
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map(() => post(key, '/candidates', { name: 'Idem Burst' }, k)));
    const codes = results.map((r) => r.statusCode);
    expect(codes.every((c) => c === 201 || c === 409), codes.join(',')).toBe(true);
    const executed = results.filter((r) => r.statusCode === 201 && r.headers['idempotent-replayed'] === undefined);
    expect(executed).toHaveLength(1);
    for (const r of results.filter((x) => x.statusCode === 409)) {
      expect(r.json().error).toBe('idempotency_key_in_use');
      expect(r.headers['retry-after']).toBe('1');
    }
    expect(await candidatesNamed('Idem Burst')).toHaveLength(1);
    // Afterwards every repeat is a replay.
    const later = await post(key, '/candidates', { name: 'Idem Burst' }, k);
    expect(later.headers['idempotent-replayed']).toBe('true');
    expect(later.json().candidate.id).toBe(executed[0].json().candidate.id);
  });

  it('a request still marked in progress blocks its key for 60 s, then the key is free (the server stopped mid-request)', async () => {
    const k = uid();
    const hash = idempotencyRequestHash('POST', '/api/v1/candidates', '', { name: 'Idem Abandoned' });
    await env.ctx.db.insert(apiIdempotencyKeys).values({ orgId: env.org.id, key: k, apiKeyId: keyId, method: 'POST', path: '/api/v1/candidates', requestHash: hash, createdAt: new Date(env.clock.t - 30_000) });
    const busy = await post(key, '/candidates', { name: 'Idem Abandoned' }, k);
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toBe('idempotency_key_in_use');
    expect(busy.headers['retry-after']).toBe('1');
    env.clock.advance(31_000);
    expect((await post(key, '/candidates', { name: 'Idem Abandoned' }, k)).statusCode).toBe(201);
    expect(await candidatesNamed('Idem Abandoned')).toHaveLength(1);
  });

  it('is scoped to the organisation: shared by its keys, separate for another organisation', async () => {
    const k = uid();
    const first = json(await post(key, '/candidates', { name: 'Idem Shared' }, k), 201);
    const second = json<CreatedApiKeyDTO>(await admin.post('/api-keys', { name: 'LMS (rotated)' })).secret;
    const viaOtherKey = await post(second, '/candidates', { name: 'Idem Shared' }, k);
    expect(viaOtherKey.headers['idempotent-replayed']).toBe('true');
    expect(viaOtherKey.json()).toEqual(first);
    // A key without the scope is refused before any replay.
    const ro = json<CreatedApiKeyDTO>(await admin.post('/api-keys', { name: 'RO', scopes: ['exams:read'] })).secret;
    expect((await post(ro, '/candidates', { name: 'Idem Shared' }, k)).statusCode).toBe(403);
    const other = await otherOrg(env);
    const otherKey = json<CreatedApiKeyDTO>(await other.api.post('/api-keys', { name: 'Other LMS' })).secret;
    const elsewhere = await post(otherKey, '/candidates', { name: 'Idem Shared' }, k);
    expect(elsewhere.statusCode).toBe(201);
    expect(elsewhere.headers['idempotent-replayed']).toBeUndefined();
    expect(elsewhere.json().candidate.id).not.toBe(first.candidate.id);
  });

  it('records expire after 24 hours: the key runs again, and the hourly job deletes old records', async () => {
    const k = uid();
    json(await post(key, '/candidates', { name: 'Idem Old' }, k), 201);
    env.clock.advance(IDEMPOTENCY_TTL_MS - 60_000);
    admin = await staffApi(env, 'admin');
    expect((await post(key, '/candidates', { name: 'Idem Old' }, k)).headers['idempotent-replayed']).toBe('true');
    env.clock.advance(60_000);
    const fresh = await post(key, '/candidates', { name: 'Idem Old' }, k);
    expect(fresh.statusCode).toBe(201);
    expect(fresh.headers['idempotent-replayed']).toBeUndefined();
    expect(await candidatesNamed('Idem Old')).toHaveLength(2);

    const [{ n: before }] = await env.ctx.db.select({ n: sql<number>`count(*)::int` }).from(apiIdempotencyKeys);
    env.clock.advance(IDEMPOTENCY_TTL_MS);
    const deleted = await purgeIdempotencyKeys(env.ctx);
    expect(deleted).toBe(before);
    expect(await env.ctx.db.select().from(apiIdempotencyKeys)).toHaveLength(0);
    expect(env.ctx.jobs.list()).toContain('api-idempotency');
  });
});

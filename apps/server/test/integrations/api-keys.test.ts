/**
 * API key scopes and expiry (integration API maturity): created by staff with scopes and an optional expiry, every
 * /api/v1 endpoint enforces the scope the catalogue declares (403 insufficient_scope), expired keys are refused
 * (401 api_key_expired), and expiring keys show up in the operational checks and the Prometheus gauge.
 */
import { API_KEY_MAX_LIFETIME_DAYS, API_KEY_READ_ONLY_SCOPES, API_KEY_SCOPES, INTEGRATION_ENDPOINTS, type ApiKeyDTO, type ApiKeyScope, type CreatedApiKeyDTO, type OpsChecksDTO } from '@sp/shared';
import { and, eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiKeys, auditLog } from '../../src/db/schema.js';
import { json, MIN, otherOrg, staffApi, type Api } from '../admin/fixtures.js';
import { createTestEnv, type TestEnv } from '../helpers.js';

const DAY = 86_400_000;
let env: TestEnv;
let admin: Api;

const v1 = (k: string, method: InjectOptions['method'], url: string, body?: unknown) =>
  env.app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${k}` }, ...(body !== undefined ? { payload: body as InjectOptions['payload'] } : {}) });

async function newKey(body: { name?: string; scopes?: ApiKeyScope[]; expiresAt?: number | null } = {}): Promise<CreatedApiKeyDTO> {
  return json<CreatedApiKeyDTO>(await admin.post('/api-keys', { name: 'key', ...body }));
}

/** A request each endpoint accepts far enough to get past authentication and the scope check. */
function sampleRequest(path: string, method: string): { url: string; body?: unknown } {
  const url = path.replace(':examId', env.exam.id).replace(':id', env.session.id);
  if (method === 'POST' && path === '/candidates') return { url, body: { name: 'Scope Probe' } };
  if (method === 'POST') return { url, body: { candidateIds: [env.candidate.id] } };
  if (method === 'PUT') return { url, body: { window: { startsAt: null, endsAt: null } } };
  return { url };
}

beforeAll(async () => {
  env = await createTestEnv();
  admin = await staffApi(env, 'admin');
});
afterAll(async () => env?.close());

describe('creating keys with scopes and an expiry', () => {
  it('stores the scopes (canonical order) and the expiry, lists them and audits them', async () => {
    const expiresAt = env.clock.t + 90 * DAY;
    const created = await newKey({ name: 'Reporting', scopes: ['sessions:read', 'exams:read', 'sessions:read'], expiresAt });
    expect(created.apiKey).toMatchObject({ name: 'Reporting', scopes: ['exams:read', 'sessions:read'], expiresAt, scope: 'integration', revokedAt: null });
    const listed = json<{ items: ApiKeyDTO[] }>(await admin.get('/api-keys')).items.find((k) => k.id === created.apiKey.id);
    expect(listed).toMatchObject({ scopes: ['exams:read', 'sessions:read'], expiresAt });
    const [a] = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'api_key.created'), eq(auditLog.targetId, created.apiKey.id)));
    expect(a.meta).toMatchObject({ name: 'Reporting', scopes: ['exams:read', 'sessions:read'], expiresAt });
    expect(JSON.stringify(a)).not.toContain(created.secret);
  });

  it('defaults to every scope and no expiry (the behaviour before scopes existed)', async () => {
    const created = await newKey({ name: 'Default' });
    expect(created.apiKey).toMatchObject({ scopes: [...API_KEY_SCOPES], expiresAt: null });
  });

  it('refuses no scopes, unknown scopes, an expiry less than an hour ahead or beyond the maximum lifetime', async () => {
    for (const body of [
      { name: 'x', scopes: [] },
      { name: 'x', scopes: ['exams:write'] },
      { name: 'x', expiresAt: env.clock.t - 1 },
      { name: 'x', expiresAt: env.clock.t + 30 * MIN },
      { name: 'x', expiresAt: env.clock.t + (API_KEY_MAX_LIFETIME_DAYS + 1) * DAY },
      { name: 'x', expiresAt: 'tomorrow' },
    ]) {
      const res = await admin.post('/api-keys', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error).toBe('validation_failed');
    }
    const past = (await admin.post('/api-keys', { name: 'x', expiresAt: env.clock.t - 1 })).json();
    expect(past.details).toEqual([{ path: 'expiresAt', message: 'Choose an expiry at least an hour from now' }]);
    expect((await admin.post('/api-keys', { name: 'max', expiresAt: env.clock.t + API_KEY_MAX_LIFETIME_DAYS * DAY })).statusCode).toBe(200);
  });
});

describe('scopes', () => {
  it('every endpoint requires exactly the scope the catalogue declares', async () => {
    const scoped = INTEGRATION_ENDPOINTS.filter((e) => e.scope);
    expect(scoped.length).toBe(INTEGRATION_ENDPOINTS.length - 1); // all but the OpenAPI document
    for (const e of scoped) {
      const without = await newKey({ name: `without ${e.scope}`, scopes: API_KEY_SCOPES.filter((s) => s !== e.scope) });
      const only = await newKey({ name: `only ${e.scope}`, scopes: [e.scope!] });
      const { url, body } = sampleRequest(e.path, e.method);
      const denied = await v1(without.secret, e.method, url, body);
      expect(denied.statusCode, `${e.operationId} without ${e.scope}`).toBe(403);
      expect(denied.json()).toMatchObject({ error: 'insufficient_scope', details: { requiredScope: e.scope } });
      expect(denied.headers['www-authenticate']).toBe(`Bearer realm="SmartProctoring integration API", error="insufficient_scope", scope="${e.scope}"`);
      const allowed = await v1(only.secret, e.method, url, body);
      expect(allowed.statusCode, `${e.operationId} with only ${e.scope}: ${allowed.body}`).toBeLessThan(300);
      for (const k of [without, only]) json(await admin.post(`/api-keys/${k.apiKey.id}/revoke`));
    }
  });

  it('a read-only key reads everything and writes nothing; candidates’ exam links need assignments:write', async () => {
    const ro = await newKey({ name: 'Read only', scopes: [...API_KEY_READ_ONLY_SCOPES] });
    const full = await newKey({ name: 'Full' });
    for (const url of ['/exams', '/candidates', '/sessions', `/sessions/${env.session.id}`, `/sessions/${env.session.id}/report`, `/sessions/${env.session.id}/events`]) {
      expect((await v1(ro.secret, 'GET', url)).statusCode, url).toBe(200);
    }
    expect((await v1(ro.secret, 'POST', '/candidates', { name: 'Nope' })).statusCode).toBe(403);
    expect((await v1(ro.secret, 'POST', `/exams/${env.exam.id}/assignments`, { candidateIds: [env.candidate.id] })).statusCode).toBe(403);
    expect(json(await v1(ro.secret, 'GET', `/sessions/${env.session.id}`)).accessLink).toBeNull();
    expect(json(await v1(full.secret, 'GET', `/sessions/${env.session.id}`)).accessLink).toBe(env.session.link);
    // Reports never carry the link, whatever the key.
    expect(json(await v1(full.secret, 'GET', `/sessions/${env.session.id}/report`)).session.accessLink).toBeNull();
  });

  it('is checked after authentication: an invalid key is 401 whatever the endpoint', async () => {
    const res = await v1(`sp_live_${'B'.repeat(43)}`, 'POST', '/candidates', { name: 'x' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_api_key');
  });
});

describe('expiry', () => {
  it('refuses an expired key with api_key_expired (and does not record it as used)', async () => {
    const k = await newKey({ name: 'Short-lived', expiresAt: env.clock.t + 2 * 3600_000 });
    expect((await v1(k.secret, 'GET', '/exams')).statusCode).toBe(200);
    const [before] = await env.ctx.db.select().from(apiKeys).where(eq(apiKeys.id, k.apiKey.id));
    env.clock.advance(2 * 3600_000);
    const res = await v1(k.secret, 'GET', '/exams');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'api_key_expired' });
    expect(res.json().message).toContain(new Date(k.apiKey.expiresAt!).toISOString());
    expect(res.headers['www-authenticate']).toMatch(/error="invalid_token"/);
    const [after] = await env.ctx.db.select().from(apiKeys).where(eq(apiKeys.id, k.apiKey.id));
    expect(after.lastUsedAt).toEqual(before.lastUsedAt);
    // A revoked key stays invalid_api_key (revocation wins over expiry).
    admin = await staffApi(env, 'admin');
    json(await admin.post(`/api-keys/${k.apiKey.id}/revoke`));
    expect((await v1(k.secret, 'GET', '/exams')).json().error).toBe('invalid_api_key');
  });

  it('expired keys do not count against the limit of active keys', async () => {
    const other = await otherOrg(env);
    for (let i = 0; i < 25; i++) json(await other.api.post('/api-keys', { name: `k${i}`, expiresAt: env.clock.t + 2 * 3600_000 }));
    expect((await other.api.post('/api-keys', { name: 'one too many' })).json().error).toBe('too_many_api_keys');
    env.clock.advance(2 * 3600_000);
    const fresh = await staffApi(env, other.admin);
    expect((await fresh.post('/api-keys', { name: 'after expiry' })).statusCode).toBe(200);
  });
});

describe('operational check and metric', () => {
  it('warns about keys expiring within 14 days, fails for a key that expired while in use, and counts them for Prometheus', async () => {
    const org = await otherOrg(env);
    const a = await staffApi(env, org.admin);
    const check = async () => json<OpsChecksDTO>(await a.get('/ops/checks')).checks.find((c) => c.id === 'api_keys')!;
    expect(await check()).toMatchObject({ status: 'ok', detail: 'No active API keys.' });
    json(await a.post('/api-keys', { name: 'Long-lived', expiresAt: env.clock.t + 200 * DAY }));
    expect(await check()).toMatchObject({ status: 'ok', detail: '1 active API key(s); none expire within 14 days.' });

    const metric = async () => {
      const text = await env.ctx.metrics.registry.metrics();
      const line = text.split('\n').find((l) => l.startsWith('sp_cluster_api_keys_expiring_soon '));
      return line ? Number(line.split(' ')[1]) : null;
    };
    const before = (await metric())!;
    const soon = json<CreatedApiKeyDTO>(await a.post('/api-keys', { name: 'Moodle', expiresAt: env.clock.t + 10 * DAY }));
    expect(await check()).toMatchObject({ status: 'warning' });
    expect((await check()).detail).toMatch(/^1 API key\(s\) expire within 14 days \(“Moodle” on \d{4}-\d{2}-\d{2}\)/);
    await new Promise((r) => setTimeout(r, 1100)); // the cluster snapshot is cached for 1 s
    expect(await metric()).toBe(before + 1);

    // Used shortly before it expired → the connected system is probably failing now.
    env.clock.advance(9 * DAY);
    json(await v1(soon.secret, 'GET', '/exams'));
    env.clock.advance(2 * DAY);
    const a2 = await staffApi(env, org.admin);
    const failing = json<OpsChecksDTO>(await a2.get('/ops/checks')).checks.find((c) => c.id === 'api_keys')!;
    expect(failing).toMatchObject({ status: 'failing' });
    expect(failing.detail).toContain('expired while still in use (“Moodle”');
    // Revoking it (after replacing it) clears the check.
    json(await a2.post(`/api-keys/${soon.apiKey.id}/revoke`));
    expect(json<OpsChecksDTO>(await a2.get('/ops/checks')).checks.find((c) => c.id === 'api_keys')).toMatchObject({ status: 'ok' });
  });
});

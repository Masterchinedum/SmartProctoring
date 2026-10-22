/**
 * Contract tests of the integration API against its published contract (packages/shared/src/integrations.ts →
 * the OpenAPI document):
 *  - no undocumented routes: every route below /api/v1 is in the endpoint catalogue (and the document), and back;
 *  - the served document and the committed docs/openapi.json are the generated one; every `$ref` resolves;
 *  - every endpoint is exercised with realistic data (an attempt with accommodations, events, evidence, notes,
 *    reviewer decisions, a hold, a submission and a resolved review), and every response is checked: 2xx bodies
 *    against the endpoint's schema in strict mode (a field the server sends but the contract does not describe
 *    fails), error bodies against the Error schema, and each status / error code must be documented for that
 *    operation in the OpenAPI document.
 */
import { readFileSync } from 'node:fs';
import {
  buildIntegrationOpenApi,
  INTEGRATION_ENDPOINTS,
  integrationErrorSchema,
  integrationOpenApiJson,
  openApiPath,
  type CreatedApiKeyDTO,
  type IntegrationEndpoint,
  type IntegrationOperationId,
} from '@sp/shared';
import Fastify, { type InjectOptions, type LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodFirstPartyTypeKind as K, type ZodTypeAny } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { apiIdempotencyKeys, candidates, organizations } from '../../src/db/schema.js';
import { idempotencyRequestHash } from '../../src/services/idempotency.js';
import { integrationApiRoutes } from '../../src/routes/v1/index.js';
import { clientEvent, json, MIN, screenshot, staffApi, type Api } from '../admin/fixtures.js';
import { startedSession } from '../flow.js';
import { createTestEnv, type TestEnv } from '../helpers.js';

const RATE_LIMIT = 100;
let env: TestEnv;
let admin: Api;
let key: string;
let keyId: string;
const doc = buildIntegrationOpenApi({ serverUrl: 'http://exam.test/api/v1' }) as { paths: Record<string, Record<string, Operation>>; components: Record<string, Record<string, unknown>> };

interface Operation {
  operationId: string;
  security: Record<string, string[]>[];
  responses: Record<string, { $ref?: string; description?: string }>;
}

/** Every response the contract test saw, checked in the last test (each operation must have been exercised). */
const seen: { operationId: IntegrationOperationId; status: number; code: string | null }[] = [];

/* ------------------------------------------------------------------ strict validation */

/** The schema with every object strict (unknown keys fail) at every depth. */
function strict(schema: ZodTypeAny): ZodTypeAny {
  // zod v3 internals: rebuild each node from its definition with strict children.
  const def = schema._def as Record<string, any>;
  const Ctor = schema.constructor as new (def: unknown) => ZodTypeAny;
  switch (def.typeName as K) {
    case K.ZodObject: {
      const shape = Object.fromEntries(Object.entries((schema as unknown as { shape: Record<string, ZodTypeAny> }).shape).map(([k, v]) => [k, strict(v)]));
      return new Ctor({ ...def, shape: () => shape, unknownKeys: 'strict' });
    }
    case K.ZodArray:
      return new Ctor({ ...def, type: strict(def.type) });
    case K.ZodOptional:
    case K.ZodNullable:
    case K.ZodDefault:
      return new Ctor({ ...def, innerType: strict(def.innerType) });
    case K.ZodUnion:
      return new Ctor({ ...def, options: (def.options as ZodTypeAny[]).map(strict) });
    case K.ZodRecord:
      return new Ctor({ ...def, valueType: strict(def.valueType) });
    case K.ZodEffects:
      return new Ctor({ ...def, schema: strict(def.schema) });
    case K.ZodIntersection:
      return new Ctor({ ...def, left: strict(def.left), right: strict(def.right) });
    default:
      return schema;
  }
}

function documentedCodes(op: Operation, status: number): string {
  const r = op.responses[String(status)];
  if (!r) return '';
  const resolved = r.$ref ? (doc.components.responses[r.$ref.split('/').pop()!] as { description: string }) : r;
  return resolved.description ?? '';
}

/** Check one response against the contract and record it. */
function check(e: IntegrationEndpoint, res: LightMyRequestResponse): LightMyRequestResponse {
  const op = doc.paths[openApiPath(e.path)][e.method.toLowerCase()];
  expect(op.responses[String(res.statusCode)], `${e.operationId}: status ${res.statusCode} is not documented (${res.body.slice(0, 200)})`).toBeDefined();
  if (res.statusCode < 300) {
    const schema = e.responses.find((r) => r.status === res.statusCode)?.schema;
    if (schema) {
      const parsed = strict(schema).safeParse(res.json());
      expect(parsed.success, `${e.operationId} ${res.statusCode}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 5))}`).toBe(true);
    }
    seen.push({ operationId: e.operationId, status: res.statusCode, code: null });
  } else {
    const body = res.json();
    const parsed = strict(integrationErrorSchema).safeParse(body);
    expect(parsed.success, `${e.operationId} ${res.statusCode} error body: ${res.body}`).toBe(true);
    expect(documentedCodes(op, res.statusCode), `${e.operationId}: error code ${body.error} (${res.statusCode}) is not documented`).toContain(`\`${body.error}\``);
    seen.push({ operationId: e.operationId, status: res.statusCode, code: body.error });
  }
  return res;
}

const endpoint = (id: IntegrationOperationId) => INTEGRATION_ENDPOINTS.find((e) => e.operationId === id)!;

/** Call an operation (path parameters filled in order) and check the response. */
async function call(
  id: IntegrationOperationId,
  opts: { params?: string[]; query?: string; body?: unknown; key?: string | null; headers?: Record<string, string> } = {},
): Promise<LightMyRequestResponse> {
  const e = endpoint(id);
  let i = 0;
  const path = e.path.replace(/:[A-Za-z]+/g, () => opts.params![i++]);
  const k = opts.key === undefined ? key : opts.key;
  const res = await env.app.inject({
    method: e.method,
    url: `/api/v1${path}${opts.query ? `?${opts.query}` : ''}`,
    headers: { ...(k ? { authorization: `Bearer ${k}` } : {}), ...(opts.headers ?? {}) },
    ...(opts.body !== undefined ? { payload: opts.body as InjectOptions['payload'] } : {}),
  });
  return check(e, res);
}

/* ------------------------------------------------------------------ data */

let rich: { sessionId: string; examId: string; candidateId: string; eventId: string };
let held: string;

beforeAll(async () => {
  env = await createTestEnv({ env: { API_RATE_LIMIT_PER_MINUTE: String(RATE_LIMIT) } });
  admin = await staffApi(env, 'admin');
  const created = json<CreatedApiKeyDTO>(await admin.post('/api-keys', { name: 'Contract LMS' }));
  key = created.secret;
  keyId = created.apiKey.id;

  // An attempt with everything a report can contain: an accommodation, events with evidence, notes, decisions,
  // a hold and release, a staff submission (score) and a resolved review.
  const cand = await env.newCandidate('Contract Candidate');
  json(await admin.post(`/candidates/${cand.id}/accommodations`, { kind: 'extra_time', params: { percent: 25 }, basis: 'accessibility' }));
  const s = await env.newSession({ candidateId: cand.id });
  const c = await startedSession(env, env.candidateClient(s.token));
  env.clock.advance(MIN);
  const evId = await clientEvent(c, { type: 'multiple_people', startedAt: env.clock.t - 20_000, endedAt: env.clock.t - 5_000, confidence: 0.9 });
  await screenshot(c, evId, env.clock.t - 15_000, { person: 'alice', faces: 2 });
  const lookId = await clientEvent(c, { type: 'looking_away', startedAt: env.clock.t - 4_000, endedAt: env.clock.t - 1_000 });
  json(await admin.post(`/sessions/${s.id}/notes`, { text: 'Second person seen briefly.' }));
  json(await admin.post(`/events/${evId}/notes`, { text: 'Checked the image.' }));
  json(await admin.post(`/events/${evId}/review`, { resolution: 'concern', note: 'Someone else was in the room.' }));
  json(await admin.post(`/events/${lookId}/review`, { resolution: 'no_concern' }));
  json(await admin.post(`/sessions/${s.id}/hold`, { note: 'checking' }));
  json(await admin.post(`/sessions/${s.id}/release`, { requireCheck: false, note: 'continue' }));
  json(await admin.post(`/sessions/${s.id}/submit`, {}));
  json(await admin.post(`/sessions/${s.id}/review/resolve`, { outcome: 'concerns', note: 'Refer to the integrity process.' }));
  rich = { sessionId: s.id, examId: env.exam.id, candidateId: cand.id, eventId: evId };

  // An attempt on hold right now.
  const h = await env.newSession({ candidateId: (await env.newCandidate('Held Candidate')).id });
  await startedSession(env, env.candidateClient(h.token));
  json(await admin.post(`/sessions/${h.id}/hold`, { note: 'waiting' }));
  held = h.id;
});
afterAll(async () => env?.close());

/* ------------------------------------------------------------------ tests */

describe('the contract covers the implementation', () => {
  it('the strict check rejects fields the contract does not describe, at any depth', () => {
    const schema = endpoint('getSession').responses[0].schema!;
    const valid = {
      id: crypto.randomUUID(),
      status: 'invited',
      endReason: null,
      exam: { id: crypto.randomUUID(), title: 'T' },
      examVersion: null,
      accommodations: [],
      candidate: { id: crypto.randomUUID(), name: 'N', email: null, externalId: null },
      createdAt: 1,
      startedAt: null,
      endedAt: null,
      remainingMs: 0,
      timerRunning: false,
      pauseCount: 0,
      score: null,
      counts: { integrity: 0, uncertain: 0, technical: 0, unreviewed: 0, open: 0, highSeverity: 0 },
      hold: null,
      accessLink: null,
      window: null,
      review: { state: 'none', outcome: null },
      staffUrl: 'http://exam.test/admin/sessions/x',
    };
    expect(strict(schema).safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, extra: 1 }).success).toBe(true); // the plain schema ignores unknown fields (clients should too)
    expect(strict(schema).safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(strict(schema).safeParse({ ...valid, exam: { ...valid.exam, secret: 'x' } }).success).toBe(false);
    expect(strict(schema).safeParse({ ...valid, status: 'unknown' }).success).toBe(false);
  });

  it('every route below /api/v1 is in the endpoint catalogue, and every catalogue endpoint is a route', async () => {
    const probe = Fastify();
    const routes: string[] = [];
    probe.addHook('onRoute', (r) => {
      for (const m of [r.method].flat()) if (m !== 'HEAD') routes.push(`${m} ${r.url}`);
    });
    probe.decorate('ctx', env.ctx);
    await probe.register(integrationApiRoutes, { prefix: '/api/v1' });
    await probe.ready();
    await probe.close();
    const documented = INTEGRATION_ENDPOINTS.map((e) => `${e.method} /api/v1${e.path}`);
    expect(routes.sort()).toEqual([...documented].sort());
    for (const e of INTEGRATION_ENDPOINTS) expect(env.app.hasRoute({ method: e.method, url: `/api/v1${e.path}` }), e.operationId).toBe(true);
  });

  it('the OpenAPI document lists exactly the catalogue, with each operation’s scope; every $ref resolves', () => {
    const ops = Object.entries(doc.paths).flatMap(([p, methods]) => Object.entries(methods).map(([m, op]) => ({ key: `${m.toUpperCase()} ${p}`, op })));
    expect(ops.map((o) => o.key).sort()).toEqual(INTEGRATION_ENDPOINTS.map((e) => `${e.method} ${openApiPath(e.path)}`).sort());
    for (const e of INTEGRATION_ENDPOINTS) {
      const op = doc.paths[openApiPath(e.path)][e.method.toLowerCase()];
      expect(op.operationId).toBe(e.operationId);
      expect(op.security).toEqual(e.scope ? [{ apiKey: [e.scope] }] : []);
      if (e.scope) for (const s of ['401', '403', '429']) expect(op.responses[s], `${e.operationId} ${s}`).toBeDefined();
    }
    const refs: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) k === '$ref' ? refs.push(x as string) : walk(x);
    };
    walk(doc);
    expect(refs.length).toBeGreaterThan(20);
    for (const r of new Set(refs)) {
      const [, kind, name] = /^#\/components\/([^/]+)\/([^/]+)$/.exec(r) ?? [];
      expect(doc.components[kind]?.[name], r).toBeDefined();
    }
  });

  it('serves the document without an API key, and docs/openapi.json is up to date', async () => {
    const res = await call('getOpenApiDocument', { key: null });
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.json()).toEqual(doc);
    expect(res.json()).toMatchObject({ openapi: '3.1.0', servers: [{ url: 'http://exam.test/api/v1' }] });
    const committed = readFileSync(new URL('../../../../docs/openapi.json', import.meta.url), 'utf8');
    expect(committed, 'docs/openapi.json is out of date: run pnpm --filter @sp/server openapi -- --out ../../docs/openapi.json').toBe(integrationOpenApiJson());
  });
});

describe('every endpoint answers as documented', () => {
  it('listExams', async () => {
    expect(json(await call('listExams')).items.length).toBeGreaterThan(0);
    expect(json(await call('listExams', { query: 'status=published' })).items.every((e: { status: string }) => e.status === 'published')).toBe(true);
    expect((await call('listExams', { query: 'status=bogus' })).json().error).toBe('validation_failed');
  });

  it('upsertCandidate (with Idempotency-Key replays and errors)', async () => {
    expect((await call('upsertCandidate', { body: { name: 'Contract Upsert', email: 'cu@example.edu', externalId: 'C-1' } })).statusCode).toBe(201);
    expect((await call('upsertCandidate', { body: { name: 'Contract Upserted', externalId: 'C-1' } })).statusCode).toBe(200);
    expect((await call('upsertCandidate', { body: { name: 'Bad', email: 'nope' } })).statusCode).toBe(400);
    const idem = crypto.randomUUID();
    expect((await call('upsertCandidate', { body: { name: 'Contract Idem' }, headers: { 'idempotency-key': idem } })).statusCode).toBe(201);
    const replay = await call('upsertCandidate', { body: { name: 'Contract Idem' }, headers: { 'idempotency-key': idem } });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect((await call('upsertCandidate', { body: { name: 'Contract Idem 2' }, headers: { 'idempotency-key': idem } })).json().error).toBe('idempotency_key_reused');
    expect((await call('upsertCandidate', { body: { name: 'x' }, headers: { 'idempotency-key': 'bad key' } })).json().error).toBe('invalid_idempotency_key');
    const busy = crypto.randomUUID();
    await env.ctx.db.insert(apiIdempotencyKeys).values({
      orgId: env.org.id,
      key: busy,
      apiKeyId: keyId,
      method: 'POST',
      path: '/api/v1/candidates',
      requestHash: idempotencyRequestHash('POST', '/api/v1/candidates', '', { name: 'Busy' }),
      createdAt: new Date(env.clock.t),
    });
    expect((await call('upsertCandidate', { body: { name: 'Busy' }, headers: { 'idempotency-key': busy } })).json().error).toBe('idempotency_key_in_use');
  });

  it('listCandidates', async () => {
    expect(json(await call('listCandidates', { query: 'externalId=C-1' })).total).toBe(1);
    expect(json(await call('listCandidates', { query: 'limit=2&offset=1' })).items.length).toBeLessThanOrEqual(2);
    expect((await call('listCandidates', { query: 'limit=0' })).statusCode).toBe(400);
  });

  it('assignCandidates', async () => {
    const { exam } = await env.newExam({ title: 'Contract assignments' });
    expect(json(await call('assignCandidates', { params: [exam.id], body: { externalIds: ['C-1'] } })).items[0].existing).toBe(false);
    expect(json(await call('assignCandidates', { params: [exam.id], body: { externalIds: ['C-1'] }, headers: { 'idempotency-key': crypto.randomUUID() } })).items[0].existing).toBe(true);
    expect((await call('assignCandidates', { params: [exam.id], body: { externalIds: ['missing'] } })).statusCode).toBe(400);
    expect((await call('assignCandidates', { params: [crypto.randomUUID()], body: { externalIds: ['C-1'] } })).json().error).toBe('exam_not_found');
    const archived = await env.newExam({ title: 'Contract archived' });
    json(await admin.post(`/exams/${archived.exam.id}/archive`));
    expect((await call('assignCandidates', { params: [archived.exam.id], body: { externalIds: ['C-1'] } })).json().error).toBe('exam_not_published');
  });

  it('quota_exceeded on upsertCandidate and assignCandidates (the organisation’s limits, services/quotas.ts)', async () => {
    const [{ n }] = await env.ctx.db.select({ n: sql<number>`count(*)::int` }).from(candidates).where(eq(candidates.orgId, env.org.id));
    await env.ctx.db.update(organizations).set({ quotas: { candidates: n, sessionsPerMonth: 0 } }).where(eq(organizations.id, env.org.id));
    try {
      expect((await call('upsertCandidate', { body: { name: 'Over the limit' } })).json().error).toBe('quota_exceeded');
      const { exam } = await env.newExam({ title: 'Contract quota' });
      expect((await call('assignCandidates', { params: [exam.id], body: { externalIds: ['C-1'] } })).json().error).toBe('quota_exceeded');
    } finally {
      await env.ctx.db.update(organizations).set({ quotas: {} }).where(eq(organizations.id, env.org.id));
    }
  });

  it('listSessions', async () => {
    const all = json(await call('listSessions', { query: 'limit=500' }));
    expect(all.items.map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining([rich.sessionId, held]));
    expect(json(await call('listSessions', { query: 'status=on_hold' })).items.map((s: { id: string }) => s.id)).toContain(held);
    expect((await call('listSessions', { query: 'status=bogus' })).statusCode).toBe(400);
    expect((await call('listSessions', { query: 'examId=nope' })).statusCode).toBe(400);
  });

  it('getSession', async () => {
    const s = json(await call('getSession', { params: [rich.sessionId] }));
    expect(s).toMatchObject({ status: 'submitted', accommodations: ['extra_time'], review: { state: 'resolved', outcome: 'concerns' } });
    expect(s.score).not.toBeNull();
    expect(json(await call('getSession', { params: [held] })).hold).toMatchObject({ reason: 'staff' });
    expect((await call('getSession', { params: [crypto.randomUUID()] })).json().error).toBe('session_not_found');
  });

  it('rescheduleSession', async () => {
    const s = await env.newSession({ candidateId: (await env.newCandidate('Window Candidate')).id });
    const startsAt = env.clock.t + 86_400_000;
    const window = { startsAt, endsAt: startsAt + 3600_000 };
    const res = json(await call('rescheduleSession', { params: [s.id], body: { window, note: 'Moved to tomorrow' } }));
    expect(res).toMatchObject({ id: s.id, status: 'invited', window, accessLink: null });
    // ISO 8601 with a time zone works too; the same request with an Idempotency-Key is replayed.
    const iso = { window: { startsAt: new Date(startsAt).toISOString(), endsAt: null } };
    const idem = crypto.randomUUID();
    expect(json(await call('rescheduleSession', { params: [s.id], body: iso, headers: { 'idempotency-key': idem } })).window).toEqual({ startsAt, endsAt: null });
    expect((await call('rescheduleSession', { params: [s.id], body: iso, headers: { 'idempotency-key': idem } })).headers['idempotent-replayed']).toBe('true');
    expect(json(await call('listSessions', { query: 'status=invited&limit=500' })).items.find((x: { id: string }) => x.id === s.id).window).toEqual({ startsAt, endsAt: null });
    expect((await call('rescheduleSession', { params: [s.id], body: { window: { startsAt: null, endsAt: env.clock.t - 1 } } })).json().error).toBe('validation_failed');
    expect((await call('rescheduleSession', { params: [s.id], body: {} })).statusCode).toBe(400);
    expect((await call('rescheduleSession', { params: [crypto.randomUUID()], body: iso })).json().error).toBe('session_not_found');
    expect((await call('rescheduleSession', { params: [held], body: iso })).json().error).toBe('already_started');
    expect((await call('rescheduleSession', { params: [rich.sessionId], body: iso })).json().error).toBe('invalid_state');
    // Assignments take a window for the new attempts and return each attempt's window.
    const { exam } = await env.newExam({ title: 'Contract windowed assignment' });
    const assigned = json(await call('assignCandidates', { params: [exam.id], body: { externalIds: ['C-1'], window } })).items[0];
    expect(assigned).toMatchObject({ existing: false, window });
    expect((await call('assignCandidates', { params: [exam.id], body: { externalIds: ['C-1'], window: { startsAt: null, endsAt: 1 } } })).statusCode).toBe(400);
  });

  it('getSessionReport', async () => {
    const r = json(await call('getSessionReport', { params: [rich.sessionId], query: 'tz=Europe/Berlin' }));
    expect(r.accommodations.exceptions.length).toBeGreaterThan(0);
    expect(r.reviewerNotes.length).toBeGreaterThan(0);
    expect(r.incidents.length).toBeGreaterThan(0);
    expect(r.review).toMatchObject({ state: 'resolved', outcome: 'concerns' });
    expect(r.notableEvents.find((e: { id: string }) => e.id === rich.eventId)).toMatchObject({ evidenceCount: 1, review: { resolution: 'concern' } });
    json(await call('getSessionReport', { params: [held] }));
    expect((await call('getSessionReport', { params: [crypto.randomUUID()] })).statusCode).toBe(404);
  });

  it('listSessionEvents', async () => {
    const evs = json(await call('listSessionEvents', { params: [rich.sessionId] })).items;
    expect(evs.length).toBeGreaterThan(3);
    expect(json(await call('listSessionEvents', { params: [rich.sessionId], query: 'category=integrity&severity=high' })).items.map((e: { id: string }) => e.id)).toEqual([rich.eventId]);
    expect(json(await call('listSessionEvents', { params: [rich.sessionId], query: `since=${env.clock.t + 1}` })).items).toEqual([]);
    expect((await call('listSessionEvents', { params: [rich.sessionId], query: 'category=bogus' })).statusCode).toBe(400);
    expect((await call('listSessionEvents', { params: [crypto.randomUUID()] })).statusCode).toBe(404);
  });

  it('authentication, scope and rate-limit errors are documented for every endpoint', async () => {
    const readOnly = json<CreatedApiKeyDTO>(await admin.post('/api-keys', { name: 'Contract RO', scopes: ['exams:read'] })).secret;
    const expiring = json<CreatedApiKeyDTO>(await admin.post('/api-keys', { name: 'Contract expiring', expiresAt: env.clock.t + 3600_000 + 1 })).secret;
    for (const e of INTEGRATION_ENDPOINTS.filter((x) => x.scope)) {
      const params = e.path.includes(':') ? [rich.sessionId] : [];
      expect((await call(e.operationId, { params, key: null, body: e.method !== 'GET' ? {} : undefined })).json().error).toBe('invalid_api_key');
      if (e.scope !== 'exams:read') expect((await call(e.operationId, { params, key: readOnly, body: e.method !== 'GET' ? {} : undefined })).json().error).toBe('insufficient_scope');
    }
    env.clock.advance(3600_000 + 1);
    expect((await call('listExams', { key: expiring })).json().error).toBe('api_key_expired');
    admin = await staffApi(env, 'admin');
    const burst = json<CreatedApiKeyDTO>(await admin.post('/api-keys', { name: 'Contract burst' })).secret;
    let limited: LightMyRequestResponse | null = null;
    for (let i = 0; i <= RATE_LIMIT && !limited; i++) {
      const res = await env.app.inject({ method: 'GET', url: '/api/v1/exams', headers: { authorization: `Bearer ${burst}` } });
      if (res.statusCode === 429) limited = res;
    }
    expect(limited, 'rate limited').not.toBeNull();
    check(endpoint('listExams'), limited!);
    expect(limited!.json().error).toBe('rate_limited');
  });

  it('every operation was exercised, with a success and an error response where it has errors', () => {
    for (const e of INTEGRATION_ENDPOINTS) {
      const mine = seen.filter((s) => s.operationId === e.operationId);
      expect(mine.some((s) => s.status < 300), `${e.operationId}: no success response checked`).toBe(true);
      for (const r of e.responses) expect(mine.some((s) => s.status === r.status), `${e.operationId}: ${r.status} not exercised`).toBe(true);
      for (const err of e.errors) for (const code of err.codes) expect(mine.some((s) => s.code === code), `${e.operationId}: ${code} not exercised`).toBe(true);
    }
  });
});

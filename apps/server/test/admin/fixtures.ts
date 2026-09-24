/**
 * Helpers for the staff API integration tests (test/admin/*.test.ts).
 *
 *   const admin = await staffApi(env, 'admin');         // /api/admin client with a fresh staff session cookie
 *   const res = await admin.get('/sessions', { status: 'active' });
 *
 * Cookies are minted directly (a staff_sessions row + signed cookie) so tests are not limited by the
 * login rate limit and can mint a fresh one after moving the test clock far ahead. The real login flow
 * is covered in test/auth.test.ts (and once in access.test.ts).
 */
import { randomUUID } from 'node:crypto';
import type { EventType, EventUpsert, StaffRole } from '@sp/shared';
import { eq } from 'drizzle-orm';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import { candidates, staffSessions, staffUsers, type StaffUser } from '../../src/db/schema.js';
import { hashPassword, randomToken, sha256Hex } from '../../src/lib/crypto.js';
import { createExam } from '../../src/services/exams.js';
import { createOrganization } from '../../src/services/org.js';
import { createExamSession } from '../../src/services/session-actions.js';
import { FakeVisionService, type FakeImageSpec } from '../../src/vision/fake.js';
import { SAMPLE_EXAM, TEST_PASSWORD, type CandidateClient, type TestEnv } from '../helpers.js';

export type Res = LightMyRequestResponse;

export interface Api {
  cookie: string;
  user: StaffUser;
  get(url: string, query?: Record<string, string | number | boolean>): Promise<Res>;
  post(url: string, body?: unknown): Promise<Res>;
  put(url: string, body?: unknown): Promise<Res>;
  del(url: string): Promise<Res>;
  jpeg(url: string, data: Buffer | FakeImageSpec, method?: 'PUT' | 'POST'): Promise<Res>;
  inject(opts: InjectOptions): Promise<Res>;
}

/** A signed staff-session cookie for `user` (valid for the next 8 h of test-clock time). */
export async function mintCookie(env: TestEnv, user: StaffUser): Promise<string> {
  const token = randomToken(32);
  const now = env.clock.t;
  await env.ctx.db.insert(staffSessions).values({
    tokenHash: sha256Hex(token),
    staffUserId: user.id,
    createdAt: new Date(now),
    lastSeenAt: new Date(now),
    expiresAt: new Date(now + env.config.staffSessionIdleMs),
    ip: '127.0.0.1',
    userAgent: 'vitest',
  });
  return `sp_session=${env.app.signCookie(token)}`;
}

export function apiWithCookie(env: TestEnv, cookie: string, user: StaffUser): Api {
  const base = '/api/admin';
  const q = (query?: Record<string, string | number | boolean>) => (query ? Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])) : undefined);
  const inject = (opts: InjectOptions) => env.app.inject({ ...opts, headers: { cookie, ...(opts.headers ?? {}) } });
  return {
    cookie,
    user,
    get: (url, query) => inject({ method: 'GET', url: base + url, query: q(query) }),
    post: (url, body) => inject({ method: 'POST', url: base + url, payload: (body ?? {}) as InjectOptions['payload'] }),
    put: (url, body) => inject({ method: 'PUT', url: base + url, payload: (body ?? {}) as InjectOptions['payload'] }),
    del: (url) => inject({ method: 'DELETE', url: base + url }),
    jpeg: (url, data, method = 'PUT') =>
      inject({ method, url: base + url, headers: { 'content-type': 'image/jpeg' }, payload: Buffer.isBuffer(data) ? data : FakeVisionService.encode(data) }),
    inject,
  };
}

/** Staff API client for one of the seeded users (or any user row). */
export async function staffApi(env: TestEnv, who: StaffRole | StaffUser): Promise<Api> {
  const user = typeof who === 'string' ? env.users[who] : who;
  return apiWithCookie(env, await mintCookie(env, user), user);
}

export function json<T = any>(res: Res, status = 200): T {
  expect(res.statusCode, `${res.statusCode} ${res.body}`).toBe(status);
  return res.json() as T;
}

/** A second organisation with its own admin, exam, candidate and session (for isolation tests). */
export async function otherOrg(env: TestEnv) {
  const db = env.ctx.db;
  const org = await createOrganization(db, 'Other College', {}, env.clock.t);
  const [admin] = await db
    .insert(staffUsers)
    .values({ orgId: org.id, email: `admin-${randomUUID().slice(0, 8)}@other.example`, name: 'Other Admin', role: 'admin', passwordHash: await hashPassword(TEST_PASSWORD), createdAt: new Date(env.clock.t), updatedAt: new Date(env.clock.t) })
    .returning();
  const { exam } = await createExam(db, org.id, SAMPLE_EXAM, { status: 'published', now: env.clock.t });
  const [candidate] = await db.insert(candidates).values({ orgId: org.id, name: 'Other Candidate', createdAt: new Date(env.clock.t), updatedAt: new Date(env.clock.t) }).returning();
  const s = await createExamSession(env.ctx, db, { orgId: org.id, examId: exam.id, candidateId: candidate.id });
  return { org, admin, exam, candidate, session: { id: s.session.id, token: s.accessToken }, api: await staffApi(env, admin) };
}

export async function userRow(env: TestEnv, id: string): Promise<StaffUser> {
  const [u] = await env.ctx.db.select().from(staffUsers).where(eq(staffUsers.id, id));
  return u;
}

/* ------------------------------------------------------------------ candidate-side helpers */

export interface ClientEventInput {
  type: EventType;
  startedAt: number;
  endedAt?: number | null;
  confidence?: number;
  observation?: string;
  details?: Record<string, unknown>;
  id?: string;
}

/** Report one closed (or open, endedAt null) episode through the candidate API. Returns the event id. */
export async function clientEvent(c: CandidateClient, e: ClientEventInput): Promise<string> {
  const id = e.id ?? randomUUID();
  const ev: EventUpsert = {
    id,
    type: e.type,
    phase: e.endedAt === null ? 'open' : 'close',
    startedAt: e.startedAt,
    endedAt: e.endedAt === undefined ? e.startedAt : e.endedAt,
    confidence: e.confidence ?? 0.9,
    observation: e.observation,
    details: e.details ?? {},
    version: 1,
  };
  const r = await c.req('POST', '/api/candidate/events/batch', { events: [ev] });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().results[0], JSON.stringify(r.json())).toMatchObject({ result: 'created' });
  return id;
}

/** Upload a screenshot for an event through the candidate API. Returns the evidence id. */
export async function screenshot(c: CandidateClient, eventId: string, capturedAt: number, spec: FakeImageSpec = { person: 'alice' }): Promise<string> {
  const id = randomUUID();
  const r = await c.jpeg(`/api/candidate/evidence/${id}`, spec, { eventId, capturedAt, reason: 'onset' }, 'PUT');
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json()).toMatchObject({ stored: true });
  return id;
}

export const MIN = 60_000;

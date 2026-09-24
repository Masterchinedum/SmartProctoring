/**
 * Integration-test helpers: an app on a fresh, migrated Postgres database (cloned from the run's
 * template), a controllable clock, FakeVisionService, a temp-dir evidence store, and seeded data
 * (org, owner/admin/reviewer, a published exam with questions, a candidate and an invited session).
 *
 *   const env = await createTestEnv({ policy: { pause: { requireApproval: true } } });
 *   const cookie = await env.login('reviewer');
 *   const res = await env.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
 *   const c = env.candidateClient(env.session.token);       // candidate API with Bearer + X-Client-Instance
 *   await env.close();
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExamInput, ProctoringPolicyInput, StaffRole } from '@sp/shared';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { inject } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import type { Ctx } from '../src/context.js';
import { createDatabase } from '../src/db/index.js';
import { candidates, staffUsers, type Candidate, type Exam, type Organization, type Question, type StaffUser } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/crypto.js';
import type { Mailer } from '../src/lib/mailer.js';
import { FsStorage } from '../src/lib/storage.js';
import { LocalBus } from '../src/realtime/bus.js';
import { createExam } from '../src/services/exams.js';
import { createOrganization } from '../src/services/org.js';
import { createExamSession } from '../src/services/session-actions.js';
import { FakeVisionService, type FakeImageSpec } from '../src/vision/fake.js';
import { dbUrl, TEST_ADMIN_URL } from './global-setup.js';

export const TEST_PASSWORD = 'Test-Password-123!';
export const T0 = Date.parse('2026-09-24T09:00:00.000Z');

export class TestClock {
  constructor(public t = T0) {}
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
    return this.t;
  }
  set(t: number) {
    this.t = t;
  }
}

export const SAMPLE_EXAM: ExamInput = {
  title: 'Sample Exam',
  description: 'Integration test exam',
  instructions: 'Answer all questions.',
  durationSec: 3600,
  policy: {},
  questions: [
    { type: 'single_choice', prompt: '2 + 2 = ?', options: [{ id: 'a', text: '3' }, { id: 'b', text: '4' }], correct: ['b'], points: 1 },
    { type: 'multiple_choice', prompt: 'Primes?', options: [{ id: 'a', text: '2' }, { id: 'b', text: '4' }, { id: 'c', text: '5' }], correct: ['a', 'c'], points: 2 },
    { type: 'short_text', prompt: 'Capital of France?', options: [], correct: ['Paris'], points: 1 },
    { type: 'numeric', prompt: 'pi to 2 decimals', options: [], correct: ['3.14'], points: 1 },
    { type: 'long_text', prompt: 'Explain.', options: [], correct: [], points: 5 },
  ],
};

export interface TestSession {
  id: string;
  token: string;
  link: string;
}

export interface CandidateClient {
  token: string;
  instanceId: string;
  req(method: InjectOptions['method'], url: string, body?: unknown, extra?: { query?: Record<string, string | number>; headers?: Record<string, string> }): Promise<LightMyRequestResponse>;
  jpeg(url: string, spec: FakeImageSpec | Buffer, query?: Record<string, string | number>, method?: 'POST' | 'PUT'): Promise<LightMyRequestResponse>;
  withInstance(instanceId: string): CandidateClient;
}

export interface TestEnv {
  app: FastifyInstance;
  ctx: Ctx;
  config: Config;
  clock: TestClock;
  vision: FakeVisionService;
  storage: FsStorage;
  dbName: string;
  org: Organization;
  users: Record<StaffRole, StaffUser>;
  exam: Exam;
  questions: Question[];
  candidate: Candidate;
  session: TestSession;
  login(role?: StaffRole): Promise<string>;
  newCandidate(name?: string): Promise<Candidate>;
  newSession(opts?: { examId?: string; candidateId?: string }): Promise<TestSession>;
  newExam(input?: Partial<ExamInput>): Promise<{ exam: Exam; questions: Question[] }>;
  candidateClient(token?: string, instanceId?: string): CandidateClient;
  close(): Promise<void>;
}

export interface TestEnvOptions {
  policy?: ProctoringPolicyInput;
  durationSec?: number;
  env?: Record<string, string>;
  /** Default fake-camera spec. */
  defaultSpec?: FakeImageSpec;
  /** Outgoing email (e.g. a MemoryMailer); default none (email alerts unavailable). */
  mailer?: Mailer | null;
}

export async function createTestEnv(opts: TestEnvOptions = {}): Promise<TestEnv> {
  const runId = inject('testRunId');
  const template = inject('testTemplateDb');
  const dbName = `proctor_t_${runId}_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: TEST_ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${dbName}" TEMPLATE "${template}"`);
  } finally {
    await admin.end();
  }
  const storageDir = mkdtempSync(join(tmpdir(), 'sp-evidence-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: dbUrl(dbName),
    STORAGE_DRIVER: 'fs',
    STORAGE_DIR: storageDir,
    PUBLIC_URL: 'http://exam.test',
    EVIDENCE_KEY: Buffer.alloc(32, 7).toString('base64'),
    SESSION_SECRET: 'test-session-secret-0123456789-abcdefghij',
    WEB_DIST_DIR: join(storageDir, 'no-web'),
    SWEEPER_ENABLED: 'false',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    ...(opts.env ?? {}),
  });
  const database = createDatabase(config.databaseUrl, { max: 10 });
  const clock = new TestClock();
  const vision = new FakeVisionService({ defaultSpec: opts.defaultSpec ?? { person: 'alice' } });
  const storage = new FsStorage(storageDir);
  const app = await buildApp({ config, database, vision, storage, bus: new LocalBus(), now: clock.now, migrate: false, jobs: false, bootstrap: false, serveWeb: false, mailer: opts.mailer ?? null });
  await app.ready();
  const ctx = app.ctx;
  const db = ctx.db;

  const org = await createOrganization(db, 'Test University', { privacyContact: 'privacy@test.example' }, clock.t);
  const passwordHash = await hashPassword(TEST_PASSWORD);
  const users = {} as Record<StaffRole, StaffUser>;
  for (const role of ['owner', 'admin', 'reviewer'] as StaffRole[]) {
    const [u] = await db
      .insert(staffUsers)
      .values({ orgId: org.id, email: `${role}@test.example`, name: `Test ${role}`, role, passwordHash, createdAt: new Date(clock.t), updatedAt: new Date(clock.t) })
      .returning();
    users[role] = u;
  }

  const newExam = async (input: Partial<ExamInput> = {}) =>
    createExam(db, org.id, { ...SAMPLE_EXAM, durationSec: opts.durationSec ?? SAMPLE_EXAM.durationSec, policy: (opts.policy ?? {}) as Record<string, unknown>, ...input }, { status: 'published', now: clock.t, createdBy: users.admin.id });
  const { exam, questions } = await newExam();

  const newCandidate = async (name = 'Alice Candidate') => {
    const [c] = await db
      .insert(candidates)
      .values({ orgId: org.id, name, email: `${name.split(' ')[0].toLowerCase()}@candidate.example`, externalId: `ext-${randomBytes(3).toString('hex')}`, createdAt: new Date(clock.t), updatedAt: new Date(clock.t) })
      .returning();
    return c;
  };
  const candidate = await newCandidate();

  const newSession = async (o: { examId?: string; candidateId?: string } = {}): Promise<TestSession> => {
    const s = await createExamSession(ctx, db, { orgId: org.id, examId: o.examId ?? exam.id, candidateId: o.candidateId ?? candidate.id });
    return { id: s.session.id, token: s.accessToken, link: s.accessLink };
  };
  const session = await newSession();

  const login = async (role: StaffRole = 'owner') => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${role}@test.example`, password: TEST_PASSWORD } });
    if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
    const c = res.cookies.find((x) => x.name === 'sp_session');
    if (!c) throw new Error('no session cookie');
    return `sp_session=${c.value}`;
  };

  const candidateClient = (token = session.token, instanceId = `inst-${randomBytes(6).toString('hex')}`): CandidateClient => ({
    token,
    instanceId,
    req: (method, url, body, extra = {}) =>
      app.inject({
        method,
        url,
        query: extra.query ? Object.fromEntries(Object.entries(extra.query).map(([k, v]) => [k, String(v)])) : undefined,
        headers: { authorization: `Bearer ${token}`, 'x-client-instance': instanceId, ...(extra.headers ?? {}) },
        ...(body !== undefined ? { payload: body as InjectOptions['payload'] } : {}),
      }),
    jpeg: (url, spec, query = {}, method = 'POST') =>
      app.inject({
        method,
        url,
        query: Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
        headers: { authorization: `Bearer ${token}`, 'x-client-instance': instanceId, 'content-type': 'image/jpeg' },
        payload: Buffer.isBuffer(spec) ? spec : FakeVisionService.encode(spec),
      }),
    withInstance: (id) => candidateClient(token, id),
  });

  return {
    app,
    ctx,
    config,
    clock,
    vision,
    storage,
    dbName,
    org,
    users,
    exam,
    questions,
    candidate,
    session,
    login,
    newCandidate,
    newSession,
    newExam,
    candidateClient,
    async close() {
      await app.close();
      await database.close();
      await storage.destroy();
      const a = new pg.Client({ connectionString: TEST_ADMIN_URL });
      await a.connect();
      try {
        await a.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      } finally {
        await a.end();
      }
    },
  };
}

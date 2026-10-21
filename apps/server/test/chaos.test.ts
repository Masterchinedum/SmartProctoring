/**
 * Resilience (chaos) tests on real Postgres: database connections killed in the middle of a candidate request or while
 * a transaction waits, a database outage, a server restart in the middle of an identity check, of an identity burst
 * and of an exam (the outage in the timeline), a face-analysis worker crashing mid-request, and Redis going away. Every fault stays inside this test's own
 * database or process (test/chaos.ts): the shared Postgres / Redis services are never stopped.
 *
 * What must hold: a failed request answers 5xx and leaves no partial state (its transaction rolled back); the client's
 * retry with the same ids takes effect exactly once (events by id + version, answers by clientSeq, samples by
 * sampleId); the pool and the app recover by themselves; no evidence row points to a missing blob and no blob is left
 * without its row; nothing is stuck (open checks, pending bursts).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { CheckFrameResponse, StartCheckResponse } from '@sp/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDatabase, type Database } from '../src/db/index.js';
import { answers, checks, events, evidence, examSessions, identityChecks, identitySampleFrames } from '../src/db/schema.js';
import { sweepOnce } from '../src/jobs/sweeper.js';
import { appLoggerOptions } from '../src/lib/log-redact.js';
import { FsStorage } from '../src/lib/storage.js';
import { LocalBus } from '../src/realtime/bus.js';
import { BURST_TIMEOUT_MS } from '../src/services/identity-samples.js';
import { FakeVisionService, type FakeImageSpec } from '../src/vision/fake.js';
import { resolveWorkerScript, VisionWorkerPool } from '../src/vision/pool.js';
import type { VisionService } from '../src/vision/types.js';
import { backendPids, databaseOutage, DbChaos, idleInTransaction, TcpProxy, terminateBackends } from './chaos.js';
import { burst, consent, DEVICE, hb, runCheck, sample, startedSession } from './flow.js';
import { createTestEnv, type CandidateClient, type TestEnv } from './helpers.js';

let env: TestEnv;
let chaos: DbChaos;

beforeAll(async () => {
  env = await createTestEnv();
  chaos = new DbChaos(env.ctx.database.pool);
});
afterEach(() => chaos.disarm());
afterAll(async () => {
  await env?.close();
});

const ev = (over: Record<string, unknown> = {}) => ({ id: randomUUID(), type: 'looking_away', phase: 'open', startedAt: env.clock.t, endedAt: null, confidence: 0.8, details: {}, version: 1, ...over });
/** The session's events with these ids (the session also has the server's own events: check-in, start...). */
const eventsOf = (sessionId: string, ids: { id: string }[]) => env.ctx.db.select().from(events).where(and(eq(events.sessionId, sessionId), inArray(events.id, ids.map((e) => e.id))));
const sessionRow = async (id: string) => (await env.ctx.db.select().from(examSessions).where(eq(examSessions.id, id)))[0];

/** A candidate API client on any app instance (helpers.candidateClient is bound to env.app). */
function clientFor(app: FastifyInstance, token: string, instanceId = `inst-${randomBytes(6).toString('hex')}`): CandidateClient {
  const headers = { authorization: `Bearer ${token}`, 'x-client-instance': instanceId };
  const query = (q: Record<string, string | number> = {}) => Object.fromEntries(Object.entries(q).map(([k, v]) => [k, String(v)]));
  return {
    token,
    instanceId,
    req: (method, url, body, extra = {}) =>
      app.inject({ method, url, query: extra.query ? query(extra.query) : undefined, headers: { ...headers, ...(extra.headers ?? {}) }, ...(body !== undefined ? { payload: body as InjectOptions['payload'] } : {}) }),
    jpeg: (url, spec, q = {}, method = 'POST') =>
      app.inject({ method, url, query: query(q), headers: { ...headers, 'content-type': 'image/jpeg' }, payload: Buffer.isBuffer(spec) ? spec : FakeVisionService.encode(spec) }),
    withInstance: (id) => clientFor(app, token, id),
  };
}

/** Evidence rows whose blob is gone (not purged), and blobs in the store that no row points to. */
async function evidenceIntegrity(): Promise<{ missingBlobs: string[]; orphanBlobs: string[] }> {
  const rows = await env.ctx.db.select({ id: evidence.id, storageKey: evidence.storageKey, purgedAt: evidence.purgedAt }).from(evidence);
  const missingBlobs = rows.filter((r) => !r.purgedAt && !existsSync(env.storage.resolveKey(r.storageKey))).map((r) => r.id);
  const root = (env.storage as unknown as { root: string }).root;
  const keys = new Set(rows.map((r) => r.storageKey));
  let files: string[] = [];
  try {
    files = readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.bin'))
      .map((d) => relative(root, join(d.parentPath, d.name)).split(sep).join('/'));
  } catch {
    // nothing stored yet
  }
  return { missingBlobs, orphanBlobs: files.filter((f) => !keys.has(f)) };
}

/** After-commit purges (a passed check's frames, a decided burst's extra frames) may still be running: wait for them. */
const expectEvidenceIntact = () => vi.waitFor(async () => expect(await evidenceIntegrity()).toEqual({ missingBlobs: [], orphanBlobs: [] }), { timeout: 15_000, interval: 100 });

/**
 * A passed check-in's frame images are purged after its commit (checks.ts purgePassedCheckImages): the blob is deleted,
 * then its row tombstoned. Wait for that to finish before crashing an instance — a crash in between leaves a row
 * without its blob (documented; retention cleans it up), which every later evidenceIntegrity() would then report.
 */
const checkInPurged = (sessionId: string) =>
  vi.waitFor(
    async () => expect((await env.ctx.db.select().from(evidence).where(eq(evidence.sessionId, sessionId))).filter((e) => e.kind === 'liveness_frame' && !e.purgedAt)).toHaveLength(0),
    { timeout: 15_000, interval: 50 },
  );

describe('a database connection killed in the middle of a request', () => {
  it('event batch: killed before COMMIT => 500, nothing kept; the retry stores each event exactly once', async () => {
    const s = await env.newSession();
    const c = await startedSession(env, env.candidateClient(s.token));
    env.clock.advance(5_000);
    const batch = [ev(), ev({ type: 'tab_hidden', phase: 'close', startedAt: env.clock.t - 3_000, endedAt: env.clock.t - 1_000 }), ev({ type: 'multiple_people', details: { faces: 2 } })];
    const before = await sessionRow(s.id);

    const killed = chaos.arm({ after: /^insert into "events"/i, at: /^commit/i, when: 'before' });
    const failed = await c.req('POST', '/api/candidate/events/batch', { events: batch });
    expect(chaos.armed).toBe(false);
    await killed;
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({ error: 'internal_error' });
    // The three inserts and the session update were rolled back together.
    expect(await eventsOf(s.id, batch)).toHaveLength(0);
    expect((await sessionRow(s.id)).updatedAt).toEqual(before.updatedAt);

    // The outbox resends the same batch: delivered once, then recognised as already applied.
    const retry = await c.req('POST', '/api/candidate/events/batch', { events: batch });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().results.map((r: { result: string }) => r.result)).toEqual(['created', 'created', 'created']);
    const again = await c.req('POST', '/api/candidate/events/batch', { events: batch });
    expect(again.json().results.map((r: { result: string }) => r.result)).toEqual(['stale', 'stale', 'stale']);
    expect((await eventsOf(s.id, batch)).map((e) => e.id).sort()).toEqual(batch.map((e) => e.id).sort());
  });

  it('event batch: the connection dies right after COMMIT => 500 although stored; the retry changes nothing', async () => {
    const s = await env.newSession();
    const c = await startedSession(env, env.candidateClient(s.token));
    env.clock.advance(5_000);
    const batch = [ev(), ev({ type: 'tab_hidden', phase: 'close', startedAt: env.clock.t - 2_000, endedAt: env.clock.t - 500 })];

    const killed = chaos.arm({ after: /^insert into "events"/i, at: /^commit/i, when: 'after' });
    const failed = await c.req('POST', '/api/candidate/events/batch', { events: batch });
    expect(chaos.armed).toBe(false);
    await killed;
    expect(failed.statusCode).toBe(500); // the client cannot know it was stored...
    expect(await eventsOf(s.id, batch)).toHaveLength(2); // ...but it was

    const retry = await c.req('POST', '/api/candidate/events/batch', { events: batch });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().results.map((r: { result: string }) => r.result)).toEqual(['stale', 'stale']);
    const rows = await eventsOf(s.id, batch);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.version === 1)).toBe(true);
    // A newer version of the open episode still applies after the outage.
    const closed = await c.req('POST', '/api/candidate/events/batch', { events: [{ ...batch[0], version: 2, phase: 'close', endedAt: env.clock.t }] });
    expect(closed.json().results[0].result).toBe('updated');
  });

  it('answer save: killed before or after COMMIT, the client’s retry by clientSeq keeps exactly the newest answer', async () => {
    const s = await env.newSession();
    const c = await startedSession(env, env.candidateClient(s.token));
    const q = env.questions[0];
    const url = `/api/candidate/answers/${q.id}`;
    const answerRow = async () => (await env.ctx.db.select().from(answers).where(eq(answers.sessionId, s.id)))[0];

    let killed = chaos.arm({ after: /^insert into "answers"/i, at: /^commit/i, when: 'before' });
    const lost = await c.req('PUT', url, { value: 'a', clientSeq: 1, answeredAt: env.clock.t });
    expect(chaos.armed).toBe(false);
    await killed;
    expect(lost.statusCode).toBe(500);
    expect(await answerRow()).toBeUndefined();
    expect((await c.req('PUT', url, { value: 'a', clientSeq: 1, answeredAt: env.clock.t })).json()).toMatchObject({ saved: true, applied: true, serverSeq: 1 });

    env.clock.advance(1_000);
    killed = chaos.arm({ after: /^insert into "answers"/i, at: /^commit/i, when: 'after' });
    const unknown = await c.req('PUT', url, { value: 'b', clientSeq: 2, answeredAt: env.clock.t });
    expect(chaos.armed).toBe(false);
    await killed;
    expect(unknown.statusCode).toBe(500);
    expect(await answerRow()).toMatchObject({ value: 'b', clientSeq: 2 });
    // The retry of the same change is recognised; a late resend of the older value cannot overwrite it.
    expect((await c.req('PUT', url, { value: 'b', clientSeq: 2, answeredAt: env.clock.t })).json()).toMatchObject({ saved: true, applied: false, serverSeq: 2 });
    expect((await c.req('PUT', url, { value: 'a', clientSeq: 1, answeredAt: env.clock.t - 1_000 })).json()).toMatchObject({ applied: false, serverSeq: 2 });
    expect(await answerRow()).toMatchObject({ value: 'b', clientSeq: 2 });
  });

  it('heartbeat: a failed update changes nothing, the next heartbeat works and the pool has recovered', async () => {
    const s = await env.newSession();
    const c = await startedSession(env, env.candidateClient(s.token));
    expect((await hb(c)).statusCode).toBe(200);
    const before = await sessionRow(s.id);
    env.clock.advance(10_000);

    const killed = chaos.arm({ at: /^update "exam_sessions" set .*"last_heartbeat_at"/is, when: 'before' });
    const failed = await hb(c);
    expect(chaos.armed).toBe(false);
    await killed;
    expect(failed.statusCode).toBe(500);
    expect((await sessionRow(s.id)).lastHeartbeatAt).toEqual(before.lastHeartbeatAt);

    const ok = await hb(c);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await sessionRow(s.id)).lastHeartbeatAt!.getTime()).toBe(env.clock.t);
    expect(chaos.poolStats.waiting).toBe(0);
  });

  it('a connection lost while its transaction waits (blob upload of a check frame) fails that request only — the process keeps running, no blob is left behind', async () => {
    const s = await env.newSession();
    const c = env.candidateClient(s.token);
    await consent(c);
    const start = (await c.req('POST', '/api/candidate/checks', { purpose: 'initial', clientInstanceId: c.instanceId, device: DEVICE })).json() as StartCheckResponse;
    const url = `/api/candidate/checks/${start.checkId}/frames`;
    const frame = { step: 'frontal', capturedAt: env.clock.t, nonce: start.liveness?.nonce ?? '' };
    // Postgres goes away while the transaction holding the check row is idle, waiting for the evidence store — the
    // client then gets an 'error' event with no statement running (before the fix this was an unhandled error that
    // ended the process).
    const put = env.storage.put.bind(env.storage);
    let killedWhileIdle = 0;
    env.storage.put = async (key, data) => {
      if (!killedWhileIdle) {
        const pids = await backendPids(env.dbName);
        const idle = await idleInTransaction(pids);
        killedWhileIdle = idle.length;
        await terminateBackends(idle);
      }
      return put(key, data);
    };
    try {
      const failed = await c.jpeg(url, { person: 'alice' }, frame);
      expect(killedWhileIdle).toBe(1);
      expect(failed.statusCode).toBe(500);
    } finally {
      env.storage.put = put;
    }
    expect(await env.ctx.db.select().from(evidence).where(eq(evidence.sessionId, s.id))).toHaveLength(0);
    await expectEvidenceIntact();
    // The candidate app resends the frame; the check completes.
    const retried = await c.jpeg(url, { person: 'alice' }, frame);
    expect(retried.statusCode, retried.body).toBe(200);
    expect((retried.json() as CheckFrameResponse).accepted).toBe(true);
  });

  it('a request that fails after storing evidence in its transaction deletes the blob again (rollback)', async () => {
    // Matching samples' images are kept too, so this sample stores images before its decision row.
    const { exam } = await env.newExam({ policy: { evidence: { keepMatchingIdentitySamples: true } } });
    const s = await env.newSession({ examId: exam.id });
    const c = await startedSession(env, env.candidateClient(s.token));
    env.clock.advance(20_000);
    // The identity-sample transaction stores the frame images, then dies at the insert of the sample frame row.
    const killed = chaos.arm({ after: /^insert into "evidence"/i, at: /^insert into "identity_checks"|^insert into "identity_sample_frames"/i, when: 'before' });
    const sampleId = randomUUID();
    const failed = await sample(env, c, { person: 'alice' }, 'periodic', sampleId);
    expect(chaos.armed).toBe(false);
    await killed;
    expect(failed.statusCode).toBe(500);
    await expectEvidenceIntact();
    // The outbox resends it with the same sampleId: decided once.
    const retried = await sample(env, c, { person: 'alice' }, 'periodic', sampleId);
    expect(retried.statusCode, retried.body).toBe(200);
    expect((await sample(env, c, { person: 'alice' }, 'periodic', sampleId)).json().result.id).toBe(retried.json().result.id);
    const decided = await env.ctx.db.select().from(identityChecks).where(eq(identityChecks.sampleId, sampleId));
    expect(decided).toHaveLength(1);
    await expectEvidenceIntact();
  });
});

describe('a database outage', () => {
  it('is reported by /api/health/ready while it lasts; requests fail with 500 and work again once it is back', async () => {
    const s = await env.newSession();
    const c = await startedSession(env, env.candidateClient(s.token));
    // The passed check's frame images are purged after the response; let that finish first (an outage between the
    // blob delete and the tombstone would leave the row unmarked until retention purges the session).
    await expectEvidenceIntact();
    const metric = async (series: string) => {
      const line = (await env.ctx.metrics.registry.metrics()).split('\n').find((l) => l.startsWith(`${series} `));
      return line ? Number(line.slice(series.length + 1)) : 0;
    };
    const lostBefore = await metric('sp_db_connection_errors_total{kind="lost"}');
    const connectBefore = await metric('sp_db_connection_errors_total{kind="connect"}');
    expect((await env.app.inject({ method: 'GET', url: '/api/health/ready' })).statusCode).toBe(200);
    expect(env.ctx.database.pool.idleCount).toBeGreaterThan(0);

    const outage = await databaseOutage(env.dbName);
    try {
      // The pool's idle connections were closed by the server: reported once each, and dropped from the pool.
      await vi.waitFor(async () => expect(await metric('sp_db_connection_errors_total{kind="lost"}')).toBeGreaterThan(lostBefore), { timeout: 5_000 });
      const ready = await env.app.inject({ method: 'GET', url: '/api/health/ready' });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toMatchObject({ ok: false, db: 'error', vision: 'ok' });
      expect((await env.app.inject({ method: 'GET', url: '/api/health/live' })).statusCode).toBe(200);
      const beat = await hb(c);
      expect(beat.statusCode).toBe(500);
      expect(await metric('sp_db_connection_errors_total{kind="connect"}')).toBeGreaterThan(connectBefore);
    } finally {
      await outage.restore();
    }

    expect((await env.app.inject({ method: 'GET', url: '/api/health/ready' })).statusCode).toBe(200);
    const beat = await hb(c);
    expect(beat.statusCode, beat.body).toBe(200);
    expect((await c.req('PUT', `/api/candidate/answers/${env.questions[0].id}`, { value: 'b', clientSeq: 1, answeredAt: env.clock.t })).statusCode).toBe(200);
    expect(chaos.poolStats.waiting).toBe(0);
  });
});

describe('a server restart in the middle of an identity check', () => {
  const instances: { app: FastifyInstance; database: Database }[] = [];
  const instance = async (name: string) => {
    const database = createDatabase(env.config.databaseUrl, { max: 4, applicationName: `sp-chaos-${name}` });
    const app = await buildApp({
      config: env.config,
      database,
      vision: new FakeVisionService({ defaultSpec: { person: 'alice' } }),
      // The same evidence directory, as a new process would open it.
      storage: new FsStorage((env.storage as unknown as { root: string }).root),
      bus: new LocalBus(),
      now: env.clock.now,
      migrate: false,
      jobs: false,
      bootstrap: false,
      serveWeb: false,
    });
    const inst = { app, database };
    instances.push(inst);
    return inst;
  };
  /** The instance goes away: graceful (SIGTERM: in-flight requests finish) or a crash (its connections just die). */
  const stop = async (inst: { app: FastifyInstance; database: Database }, how: 'graceful' | 'crash') => {
    if (how === 'crash') await terminateBackends(await backendPids(env.dbName, inst.database.pool.options.application_name as string));
    await inst.app.close();
    await inst.database.close();
  };
  afterAll(async () => {
    for (const i of instances) {
      await i.app.close().catch(() => {});
      await i.database.close().catch(() => {});
    }
  });

  /** Frames of a check: the frontal ones, then one per liveness step. */
  const frames = (start: StartCheckResponse): { step: string | number; spec: FakeImageSpec }[] => [
    ...Array.from({ length: start.frontalFramesRequired }, () => ({ step: 'frontal' as const, spec: { person: 'alice', yawDeg: 0, pitchDeg: 0 } })),
    ...(start.liveness?.steps ?? []).map((st) => ({
      step: st.index,
      spec: { person: 'alice', ...({ center: { yawDeg: 0, pitchDeg: 0 }, turn_left: { yawDeg: 22, pitchDeg: 0 }, turn_right: { yawDeg: -22, pitchDeg: 0 }, look_up: { yawDeg: 0, pitchDeg: 14 }, look_down: { yawDeg: 0, pitchDeg: -14 } } as Record<string, object>)[st.action] },
    })),
  ];
  const send = (c: CandidateClient, start: StartCheckResponse, f: { step: string | number; spec: FakeImageSpec & { yawDeg?: number; pitchDeg?: number } }) =>
    c.jpeg(`/api/candidate/checks/${start.checkId}/frames`, f.spec, { step: f.step, capturedAt: env.clock.advance(250), nonce: start.liveness?.nonce ?? '', clientYaw: f.spec.yawDeg ?? 0, clientPitch: f.spec.pitchDeg ?? 0 });

  it('graceful restart: the new instance continues the same check on the frames already received', async () => {
    const s = await env.newSession();
    const a = await instance('a1');
    const instanceId = `inst-${randomBytes(6).toString('hex')}`;
    const ca = clientFor(a.app, s.token, instanceId);
    await consent(ca);
    const start = (await ca.req('POST', '/api/candidate/checks', { purpose: 'initial', clientInstanceId: instanceId, device: DEVICE })).json() as StartCheckResponse;
    const all = frames(start);
    const half = Math.ceil(all.length / 2);
    for (const f of all.slice(0, half)) expect((await send(ca, start, f)).statusCode).toBe(200);

    await stop(a, 'graceful');
    const b = await instance('b1');
    const cb = clientFor(b.app, s.token, instanceId); // the same browser page, now talking to the new process
    for (const f of all.slice(half)) expect((await send(cb, start, f)).statusCode).toBe(200);
    const done = await cb.req('POST', `/api/candidate/checks/${start.checkId}/complete`);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().outcome).toBe('passed');
    const started = await cb.req('POST', '/api/candidate/start');
    expect(started.json().session.status).toBe('active');
    expect(await env.ctx.db.select().from(checks).where(eq(checks.sessionId, s.id))).toMatchObject([{ status: 'passed' }]);
    await expectEvidenceIntact();
  });

  it('crash mid-frame and a long outage: the expired check is settled, a new check passes, no evidence is lost or orphaned', async () => {
    const s = await env.newSession();
    const a = await instance('a2');
    const aChaos = new DbChaos(a.database.pool);
    const instanceId = `inst-${randomBytes(6).toString('hex')}`;
    const ca = clientFor(a.app, s.token, instanceId);
    await consent(ca);
    const start = (await ca.req('POST', '/api/candidate/checks', { purpose: 'initial', clientInstanceId: instanceId, device: DEVICE })).json() as StartCheckResponse;
    const all = frames(start);
    expect((await send(ca, start, all[0])).statusCode).toBe(200);
    // The process dies while storing the second frame: its images are already in the store, its rows are not.
    const killed = aChaos.arm({ after: /^insert into "evidence"/i, at: /^insert into "check_frames"/i, when: 'before' });
    expect((await send(ca, start, all[1])).statusCode).toBe(500);
    expect(aChaos.armed).toBe(false);
    await killed;
    await stop(a, 'crash');

    // Back after more than the check's lifetime: the candidate app retries the frame on the new instance.
    env.clock.advance(5 * 60_000);
    const b = await instance('b2');
    const cb = clientFor(b.app, s.token, instanceId);
    const late = await send(cb, start, all[1]);
    expect(late.statusCode).toBe(410);
    expect(late.json().error).toBe('check_expired');
    expect((await env.ctx.db.select().from(checks).where(eq(checks.id, start.checkId)))[0].status).toBe('expired');
    // A new check (the candidate app starts one on check_expired) passes on this instance.
    const { complete } = await runCheck(env, cb, 'initial');
    expect(complete!.outcome).toBe('passed');
    expect((await sessionRow(s.id)).status).toBe('ready');
    expect(await env.ctx.db.select().from(checks).where(and(eq(checks.sessionId, s.id), eq(checks.status, 'open')))).toHaveLength(0);
    await expectEvidenceIntact();
  });

  it('the outage of a restart is in the timeline whether the new instance’s sweeper or the candidate’s heartbeat comes first (and a "stop" clock did not run)', async () => {
    const { exam } = await env.newExam({ policy: { connection: { heartbeatTimeoutSec: 10, disconnectTimerBehavior: 'stop' } } });
    const restartDuringExam = async (first: 'sweeper' | 'heartbeat') => {
      const s = await env.newSession({ examId: exam.id });
      const a = await instance(`gap-a-${first}`);
      const instanceId = `inst-${randomBytes(6).toString('hex')}`;
      const ca = await startedSession(env, clientFor(a.app, s.token, instanceId));
      const before = await hb(ca);
      const last = env.clock.t;
      await checkInPurged(s.id);
      await stop(a, 'crash');
      env.clock.advance(60_000); // every instance down for a minute: no sweeper notices the silence
      const b = await instance(`gap-b-${first}`);
      if (first === 'sweeper') expect((await sweepOnce(b.app.ctx)).timedOut).toBeGreaterThanOrEqual(1);
      const back = await hb(clientFor(b.app, s.token, instanceId));
      expect(back.statusCode, back.body).toBe(200);
      expect(back.json().remainingMs).toBe(before.json().remainingMs); // the clock stopped at the last heartbeat
      const outages = await env.ctx.db.select().from(events).where(and(eq(events.sessionId, s.id), eq(events.type, 'reporting_interrupted')));
      expect(outages).toHaveLength(1);
      expect(outages[0]).toMatchObject({ status: 'closed', startedAt: new Date(last), endedAt: new Date(env.clock.t), category: 'technical' });
      expect(outages[0].details).toMatchObject({ closedBy: 'heartbeat_resumed', lastHeartbeatAt: last });
      expect(await sessionRow(s.id)).toMatchObject({ connection: 'online', reportingEventId: null, reportingInterruptedSince: null });
      return outages[0];
    };
    const viaSweeper = await restartDuringExam('sweeper');
    const viaHeartbeat = await restartDuringExam('heartbeat');
    expect(viaHeartbeat.details).toMatchObject({ detectedBy: 'late_heartbeat' });
    expect(viaSweeper.details).not.toHaveProperty('detectedBy');
  });

  it('a restart longer than the resume policy’s maxOfflineMinutes: the same outcome whichever comes first — one outage episode and the limit applied (hold or end)', async () => {
    const restartPastLimit = async (onLimit: 'hold' | 'end', first: 'sweeper' | 'heartbeat') => {
      const { exam } = await env.newExam({ policy: { connection: { heartbeatTimeoutSec: 10, disconnectTimerBehavior: 'stop' }, resume: { maxOfflineMinutes: 1, onLimit } } });
      const s = await env.newSession({ examId: exam.id });
      const a = await instance(`limit-a-${onLimit}-${first}`);
      const instanceId = `inst-${randomBytes(6).toString('hex')}`;
      const ca = await startedSession(env, clientFor(a.app, s.token, instanceId));
      expect((await hb(ca)).statusCode).toBe(200);
      const last = env.clock.t;
      await checkInPurged(s.id);
      await stop(a, 'crash');
      env.clock.advance(2 * 60_000); // down for longer than the exam allows a browser to be offline
      const b = await instance(`limit-b-${onLimit}-${first}`);
      if (first === 'sweeper') await sweepOnce(b.app.ctx);
      const back = await hb(clientFor(b.app, s.token, instanceId));
      expect(back.statusCode, back.body).toBe(200);
      const row = await sessionRow(s.id);
      if (onLimit === 'hold') {
        expect(back.json().status).toBe('on_hold');
        expect(row).toMatchObject({ status: 'on_hold', holdReason: 'resume_limit', runningSince: null, connection: 'online' });
      } else {
        expect(back.json().status).toBe('submitted');
        expect(row).toMatchObject({ status: 'submitted', endReason: 'resume_limit' });
      }
      const outages = await env.ctx.db.select().from(events).where(and(eq(events.sessionId, s.id), eq(events.type, 'reporting_interrupted')));
      expect(outages).toHaveLength(1);
      expect(outages[0]).toMatchObject({ status: 'closed', startedAt: new Date(last) });
      expect(outages[0].details).toMatchObject({ closedBy: onLimit === 'hold' ? 'heartbeat_resumed' : 'session_end' });
      const limitEvents = await env.ctx.db.select().from(events).where(and(eq(events.sessionId, s.id), inArray(events.type, ['session_held', 'session_submitted'])));
      expect(limitEvents.filter((e) => (e.details as { limit?: string }).limit === 'offline')).toHaveLength(1);
    };
    for (const onLimit of ['hold', 'end'] as const) {
      await restartPastLimit(onLimit, 'sweeper');
      await restartPastLimit(onLimit, 'heartbeat');
    }
  });

  it('an identity burst pending at shutdown is decided by the next instance (sweeper); the session is not left waiting', async () => {
    const s = await env.newSession();
    const a = await instance('a3');
    const instanceId = `inst-${randomBytes(6).toString('hex')}`;
    const ca = clientFor(a.app, s.token, instanceId);
    await startedSession(env, ca);
    env.clock.advance(15_000);
    const pending = await burst(env, ca, [{ person: 'alice' }, { person: 'alice' }, { person: 'alice' }], { omit: [2] });
    expect(pending.last.burst).toMatchObject({ received: 2, complete: false });
    expect((await sessionRow(s.id)).identityState.pendingBursts).toHaveLength(1);
    await checkInPurged(s.id);
    await expectEvidenceIntact();

    await stop(a, 'crash');
    const b = await instance('b3');
    env.clock.advance(BURST_TIMEOUT_MS + 1_000);
    expect((await sweepOnce(b.app.ctx)).burstsDecided).toBe(1);
    const row = await sessionRow(s.id);
    expect(row.identityState.pendingBursts).toEqual([]);
    expect(row.status).toBe('active');
    const decided = await env.ctx.db.select().from(identityChecks).where(eq(identityChecks.sampleId, `burst:${pending.burstId}`));
    expect(decided).toMatchObject([{ decision: 'match' }]);
    expect((await env.ctx.db.select().from(identitySampleFrames).where(eq(identitySampleFrames.burstId, pending.burstId))).every((f) => f.identityCheckId === decided[0].id)).toBe(true);
    // The candidate continues on the new instance.
    const cb = clientFor(b.app, s.token, instanceId);
    expect((await hb(cb)).statusCode).toBe(200);
    expect((await sample(env, cb, { person: 'alice' })).statusCode).toBe(200);
    await expectEvidenceIntact();
  });
});

/** The fixture worker crashes on a frame of this person (test/fixtures/vision-worker/worker.ts). */
const CRASH_PERSON = 'crash-the-worker';

describe('a face-analysis worker crashing mid-request', () => {
  let app: FastifyInstance;
  let pool: VisionWorkerPool;
  let exits = 0;
  beforeAll(async () => {
    pool = await VisionWorkerPool.start({
      size: 1,
      maxQueue: 16,
      script: resolveWorkerScript(join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'vision-worker')),
      workerData: { engine: { modelsDir: 'unused', threads: 1 }, nice: 0 },
      onWorkerExit: () => exits++,
      observer: env.ctx.metrics.visionObserver,
    });
    const vision: VisionService = { analyze: (jpeg, opts) => pool.analyze(jpeg, opts ?? {}), close: () => pool.close(), get load() { return pool.load; } };
    app = await buildApp({ config: env.config, database: env.ctx.database, vision, storage: env.storage, bus: new LocalBus(), now: env.clock.now, migrate: false, jobs: false, bootstrap: false, serveWeb: false });
  });
  afterAll(async () => {
    await app?.close();
    await pool?.close();
  });

  it('fails that frame with a retryable 500; the pool replaces the worker and the retried frame and the check succeed', async () => {
    const s = await env.newSession();
    const c = clientFor(app, s.token);
    await consent(c);
    const start = (await c.req('POST', '/api/candidate/checks', { purpose: 'initial', clientInstanceId: c.instanceId, device: DEVICE })).json() as StartCheckResponse;
    const url = `/api/candidate/checks/${start.checkId}/frames`;
    const crashed = await c.jpeg(url, { person: CRASH_PERSON }, { step: 'frontal', capturedAt: env.clock.t, nonce: start.liveness?.nonce ?? '' });
    expect(crashed.statusCode).toBe(500);
    expect(crashed.json()).toMatchObject({ error: 'internal_error' }); // the candidate app retries 5xx (classifyApiError 'server')
    expect(exits).toBe(1);
    // Nothing of the failed frame was stored (it failed before the transaction).
    expect(await env.ctx.db.select().from(evidence).where(eq(evidence.sessionId, s.id))).toHaveLength(0);
    // The retried frame waits for the replacement worker, then the check completes normally.
    const { complete } = await runCheck(env, c, 'initial');
    expect(complete!.outcome).toBe('passed');
    expect(pool.load.workers).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/api/health/ready' })).json()).toMatchObject({ ok: true, vision: 'ok' });
    expect(await env.ctx.metrics.registry.metrics()).toMatch(/sp_vision_analyses_total\{priority="interactive",result="failed"\} [1-9]/);
  });
});

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
async function redisAvailable(): Promise<boolean> {
  const r = new Redis(REDIS_URL, { lazyConnect: true, connectTimeout: 1000, maxRetriesPerRequest: 0, retryStrategy: () => null });
  r.on('error', () => {});
  try {
    await r.connect();
    return (await r.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}
const redisUp = await redisAvailable();

describe.skipIf(!redisUp)('Redis unavailable (realtime bus and shared rate limits)', () => {
  it('candidate and staff requests keep working (rate limits fail open, live messages are dropped), the failure is logged, and both recover', async () => {
    const target = new URL(REDIS_URL);
    const proxy = await TcpProxy.start({ host: target.hostname, port: Number(target.port || 6379) });
    const lines: string[] = [];
    const namespace = `sp:rl:chaos:${randomBytes(6).toString('hex')}:`;
    const app = await buildApp({
      config: { ...env.config, redisUrl: `redis://127.0.0.1:${proxy.port}` },
      database: env.ctx.database,
      vision: env.vision,
      storage: env.storage,
      now: env.clock.now,
      migrate: false,
      jobs: false,
      bootstrap: false,
      serveWeb: false,
      rateLimitNamespace: namespace,
      logger: { ...appLoggerOptions('info'), stream: new Writable({ write: (chunk, _enc, cb) => (lines.push(String(chunk)), cb()) }) },
    });
    const admin = new Redis(REDIS_URL);
    try {
      const s = await env.newSession();
      const c = clientFor(app, s.token);
      await startedSession(env, c);
      expect((await hb(c)).statusCode).toBe(200);
      const cookie = await env.login('admin');
      const note = () => app.inject({ method: 'POST', url: `/api/admin/sessions/${s.id}/notes`, headers: { cookie }, payload: { text: 'Checked the room.' } });
      expect((await note()).statusCode).toBe(200);
      expect((await admin.keys(`${namespace}*`)).length).toBeGreaterThan(0);

      proxy.cut();
      env.clock.advance(5_000);
      const t0 = Date.now();
      expect((await hb(c)).statusCode).toBe(200); // the heartbeat route is rate limited: the store error lets it through
      expect((await c.req('PUT', `/api/candidate/answers/${env.questions[0].id}`, { value: 'b', clientSeq: 1, answeredAt: env.clock.t })).statusCode).toBe(200);
      expect((await note()).statusCode).toBe(200); // publishes to the (unreachable) bus
      expect(Date.now() - t0).toBeLessThan(10_000); // no request waits for Redis to come back
      await vi.waitFor(() => expect(lines.some((l) => /redis (rate-limit store|bus) error/.test(l))).toBe(true), { timeout: 5_000 });

      proxy.restore();
      // ioredis reconnects by itself; the counters are shared through Redis again.
      await vi.waitFor(
        async () => {
          await admin.del(...(await admin.keys(`${namespace}*`)), `${namespace}none`);
          expect((await hb(c)).statusCode).toBe(200);
          expect((await admin.keys(`${namespace}*`)).length).toBeGreaterThan(0);
        },
        { timeout: 15_000, interval: 250 },
      );
    } finally {
      await app.close();
      admin.disconnect();
      await proxy.close();
    }
  });
});

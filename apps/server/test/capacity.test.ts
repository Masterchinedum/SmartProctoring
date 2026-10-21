/**
 * Behaviour at the face-analysis capacity limit (docs/PERFORMANCE.md §6–§7): what refused clients are told, the
 * health / readiness / capacity signals, admission at exam start and the load-aware sampling cadence.
 */
import { SAMPLING_PROFILES } from '@sp/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { events, examSessions } from '../src/db/schema.js';
import { assessCapacity, samplingPressure } from '../src/services/capacity.js';
import { CADENCE, loadAwareDelayMs, nextSampleDelayMs, sampleWatchdog } from '../src/services/identity-evidence.js';
import { identityState } from '../src/services/session-state.js';
import type { LoadSnapshot } from '../src/lib/load-monitor.js';
import type { VisionLoad } from '../src/vision/index.js';
import { burst, consent, hb, runCheck, sample, startedSession } from './flow.js';
import { createTestEnv, type CandidateClient, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env?.close());
afterEach(() => {
  env.vision.setLoad({});
});

const get = (url: string) => env.app.inject({ method: 'GET', url });
const idle = { interactive: 0, background: 0 };
const VISION: VisionLoad = { workers: 3, inFlight: 3, queued: idle, oldestWaitMs: idle, serviceMs: 85, estimatedWaitMs: idle, maxQueue: 256 };
const MONITOR: LoadSnapshot = { eventLoopP99Ms: 20, eventLoopMaxMs: 40, eventLoopUtilization: 0.3, dbTotal: 20, dbIdle: 15, dbWaiting: 0, visionInFlight: 3, visionQueued: 0, visionWorkers: 3 };
const LIMITS = { maxVisionWaitMs: 2000, maxEventLoopP99Ms: 200, maxDbWaiting: 5 };

describe('health probes', () => {
  it('live: the process answers, with no database or vision dependency', async () => {
    env.vision.setLoad({ workers: 0 });
    const res = await get('/api/health/live');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it('ready (and /api/health): the database answers and face analysis has a worker', async () => {
    for (const url of ['/api/health', '/api/health/ready']) {
      const res = await get(url);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, db: 'ok', vision: 'ok' });
    }
    env.vision.setLoad({ workers: 0 }); // e.g. every worker crashed and none could restart
    const down = await get('/api/health');
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ ok: false, db: 'ok', vision: 'unavailable' });
  });

  it('ready: a database that does not answer in time is reported down instead of hanging the probe', async () => {
    const db = env.ctx.db as unknown as { execute: (...a: unknown[]) => Promise<unknown> };
    const execute = db.execute;
    db.execute = () => new Promise(() => {});
    try {
      const t0 = Date.now();
      const res = await get('/api/health/ready');
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ ok: false, db: 'timeout' });
      expect(Date.now() - t0).toBeLessThan(4000);
    } finally {
      db.execute = execute;
    }
  });

  it('capacity: a long face-analysis queue stops new exam starts but never fails readiness (always 200)', async () => {
    expect((await get('/api/health/capacity')).json()).toEqual({ accepting: true, reasons: [] });
    env.vision.setLoad({ queued: { interactive: 10, background: 90 }, estimatedWaitMs: { interactive: 300, background: 3100 } });
    const busy = await get('/api/health/capacity');
    expect(busy.statusCode).toBe(200);
    expect(busy.json()).toEqual({ accepting: false, reasons: ['vision_queue_long'] });
    expect((await get('/api/health/ready')).statusCode).toBe(200);
  });
});

describe('assessCapacity', () => {
  it('accepts while every signal is under its limit', () => {
    expect(assessCapacity(LIMITS, VISION, MONITOR)).toEqual({ accepting: true, reasons: [], visionWaitMs: 0 });
    expect(assessCapacity(LIMITS, undefined, null)).toEqual({ accepting: true, reasons: [], visionWaitMs: null });
  });

  it('uses the longer of the background estimate and what the oldest waiting sample has already waited', () => {
    const waited = assessCapacity(LIMITS, { ...VISION, oldestWaitMs: { interactive: 0, background: 2500 } }, MONITOR);
    expect(waited).toMatchObject({ accepting: false, reasons: ['vision_queue_long'], visionWaitMs: 2500 });
  });

  it('names every reason: no vision worker, event loop lagging, database pool exhausted', () => {
    const s = assessCapacity(LIMITS, { ...VISION, workers: 0 }, { ...MONITOR, eventLoopP99Ms: 450, dbWaiting: 9 });
    expect(s).toMatchObject({ accepting: false, reasons: ['vision_unavailable', 'event_loop_lagging', 'database_pool_exhausted'] });
  });
});

describe('a full face-analysis queue', () => {
  it('answers 503 vision_busy with the pool’s estimate as Retry-After; the same sample is taken once there is room', async () => {
    const s = await env.newSession();
    const c = env.candidateClient(s.token);
    await startedSession(env, c);
    env.vision.busyNext(1, 7);
    const sampleId = crypto.randomUUID();
    const refused = await sample(env, c, { person: 'alice' }, 'periodic', sampleId);
    expect(refused.statusCode).toBe(503);
    expect(refused.headers['retry-after']).toBe('7');
    expect(refused.json()).toMatchObject({ error: 'vision_busy', retryAfterSec: 7 });
    const retried = await sample(env, c, { person: 'alice' }, 'periodic', sampleId);
    expect(retried.statusCode).toBe(200);
  });
});

/** A queue that makes a new identity sample wait `ms` (background work). */
const busyFor = (ms: number) => env.vision.setLoad({ queued: { interactive: 0, background: Math.round(ms / 30) }, estimatedWaitMs: { interactive: 0, background: ms } });
const sessionRow = async (id: string) => (await env.ctx.db.select().from(examSessions).where(eq(examSessions.id, id)))[0];

/** Invite -> consent -> passed check-in: ready to start. */
async function readySession(): Promise<{ id: string; c: CandidateClient }> {
  const s = await env.newSession();
  const c = env.candidateClient(s.token);
  await consent(c);
  expect((await runCheck(env, c, 'initial', { spec: { person: 'alice' } })).complete!.outcome).toBe('passed');
  return { id: s.id, c };
}
const start = (c: CandidateClient) => c.req('POST', '/api/candidate/start');

describe('admission at exam start', () => {
  it('defers a start while the server is at capacity (503 start_deferred + Retry-After), without starting the clock', async () => {
    const { id, c } = await readySession();
    busyFor(9_000);
    const res = await start(c);
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('9');
    expect(res.json()).toMatchObject({ error: 'start_deferred', retryAfterSec: 9 });
    const row = await sessionRow(id);
    expect(row).toMatchObject({ status: 'ready', runningSince: null, usedMs: 0 });
    expect(row.startDeferredSince?.getTime()).toBe(env.clock.t);

    // Room again: the start goes ahead, and staff see how long it was held back.
    env.clock.advance(40_000);
    env.vision.setLoad({});
    const ok = await start(c);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().session.status).toBe('active');
    expect((await sessionRow(id)).startDeferredSince).toBeNull();
    const [started] = await env.ctx.db.select().from(events).where(and(eq(events.sessionId, id), eq(events.type, 'session_started')));
    expect(started.details).toMatchObject({ startDeferredMs: 40_000 });
    expect(started.observation).toMatch(/held back 40 s while the server was busy/);
  });

  it('keeps Retry-After between 5 and 30 s', async () => {
    const a = await readySession();
    busyFor(2_500);
    expect((await start(a.c)).headers['retry-after']).toBe('5');
    busyFor(120_000);
    expect((await start(a.c)).headers['retry-after']).toBe('30');
  });

  it('never keeps a candidate waiting longer than EXAM_START_MAX_DEFER_SEC in total (counted from the first deferral)', async () => {
    const { id, c } = await readySession();
    busyFor(9_000);
    expect((await start(c)).statusCode).toBe(503);
    env.clock.advance(env.config.examStartAdmission.maxDeferMs - 1_000);
    expect((await start(c)).statusCode).toBe(503); // still within the limit: the first deferral counts, not the latest
    env.clock.advance(1_000);
    const res = await start(c); // the server is still busy, but this candidate has waited long enough
    expect(res.statusCode).toBe(200);
    expect((await sessionRow(id)).status).toBe('active');
  });

  it('does not defer a session that is not ready (the usual state error), and can be switched off', async () => {
    busyFor(9_000);
    const s = await env.newSession();
    const c = env.candidateClient(s.token);
    await consent(c);
    expect((await start(c)).statusCode).toBe(409);

    const off = await createTestEnv({ env: { EXAM_START_ADMISSION: 'false' } });
    try {
      off.vision.setLoad({ estimatedWaitMs: { interactive: 0, background: 9_000 } });
      await startedSession(off, off.candidateClient()); // asserts a 200 start
    } finally {
      await off.close();
    }
  });
});

describe('load-aware sampling cadence', () => {
  const policy = SAMPLING_PROFILES.maximum;
  const consistent = { state: 'consistent' as const, unusableStreak: 0 };
  const t0 = 1_000_000;

  it('spaces routine samples out with the queue pressure, at most to the Balanced intensity', () => {
    const inStartup = { activeSince: t0, acc: consistent };
    const later = { activeSince: t0 - 10 * 60_000, acc: consistent };
    expect(loadAwareDelayMs(policy, inStartup, t0 + 30_000, 0)).toBe(6_000);
    expect(loadAwareDelayMs(policy, inStartup, t0 + 30_000, 0.5)).toBe(9_000);
    expect(loadAwareDelayMs(policy, inStartup, t0 + 30_000, 1)).toBe(SAMPLING_PROFILES.balanced.startupIntervalSec * 1000);
    expect(loadAwareDelayMs(policy, later, t0, 1)).toBe(SAMPLING_PROFILES.balanced.periodicCheckIntervalSec * 1000);
    expect(loadAwareDelayMs(policy, later, t0, 7)).toBe(30_000); // pressure is capped at 1
  });

  it('never slows the faster cadence while evidence builds up, nor exams already at the Balanced intensity', () => {
    const at = { activeSince: t0, acc: consistent };
    expect(loadAwareDelayMs(policy, { ...at, acc: { state: 'suspect', unusableStreak: 0 } }, t0, 1)).toBe(CADENCE.suspectMs);
    expect(loadAwareDelayMs(policy, { ...at, acc: { state: 'monitoring', unusableStreak: 0 } }, t0, 1)).toBe(CADENCE.monitoringMs);
    expect(loadAwareDelayMs(policy, { ...at, acc: { state: 'consistent', unusableStreak: 1 } }, t0, 1)).toBe(nextSampleDelayMs(policy, { ...at, acc: { state: 'consistent', unusableStreak: 1 } }, t0));
    expect(loadAwareDelayMs(SAMPLING_PROFILES.balanced, at, t0, 1)).toBe(12_000);
  });

  it('pressure: 0 below half the vision limit, 1 at the limit', () => {
    const limits = env.config.capacity;
    expect(samplingPressure(limits, null)).toBe(0);
    expect(samplingPressure(limits, limits.maxVisionWaitMs / 2)).toBe(0);
    expect(samplingPressure(limits, limits.maxVisionWaitMs * 0.75)).toBe(0.5);
    expect(samplingPressure(limits, limits.maxVisionWaitMs * 3)).toBe(1);
  });

  it('the watchdog waits for the interval the client was told, so a spaced-out cadence is not "overdue"', () => {
    const st = { activeSince: t0 - 10 * 60_000, evidence: { state: 'consistent' as const, unusableStreak: 0 }, lastSampleReceivedAt: t0 };
    expect(sampleWatchdog(policy, st, t0 + 50_000)).toBe('request'); // 3 x 15 s
    expect(sampleWatchdog(policy, { ...st, cadenceMs: 30_000 }, t0 + 50_000)).toBe('ok');
    expect(sampleWatchdog(policy, { ...st, cadenceMs: 30_000 }, t0 + 95_000)).toBe('request'); // 3 x 30 s
  });

  it('on a real session: the answer to a sample carries the spaced-out interval, and a resume starts afresh', async () => {
    const s = await env.newSession();
    const c = env.candidateClient(s.token);
    await startedSession(env, c);
    const quiet = await burst(env, c, [{ person: 'alice' }, { person: 'alice' }, { person: 'alice' }], { trigger: 'exam_start' });
    expect(quiet.last.nextSampleInMs).toBe(6_000);
    env.clock.advance(6_000);
    busyFor(env.config.capacity.maxVisionWaitMs);
    const busy = await burst(env, c, [{ person: 'alice' }, { person: 'alice' }, { person: 'alice' }]);
    expect(busy.last.nextSampleInMs).toBe(12_000);
    expect(identityState(await sessionRow(s.id)).cadenceMs).toBe(12_000);
    expect((await hb(c)).json().identitySample ?? null).toBeNull(); // not overdue
  });
});

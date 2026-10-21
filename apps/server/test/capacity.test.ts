/**
 * Behaviour at the face-analysis capacity limit (docs/PERFORMANCE.md §6–§7): what refused clients are told, the
 * health / readiness / capacity signals, admission at exam start and the load-aware sampling cadence.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assessCapacity } from '../src/services/capacity.js';
import type { LoadSnapshot } from '../src/lib/load-monitor.js';
import type { VisionLoad } from '../src/vision/index.js';
import { sample, startedSession } from './flow.js';
import { createTestEnv, type TestEnv } from './helpers.js';

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

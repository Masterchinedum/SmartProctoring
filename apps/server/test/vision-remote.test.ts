/**
 * Dedicated vision worker (src/vision-worker) + the server's remote driver (vision/remote.ts, VISION_DRIVER=remote):
 * the identity flows through a worker started in-process on an ephemeral port (FakeVisionService behind it for speed;
 * one block with the real models), the token, busy answers and Retry-After, dead workers (circuit breaker,
 * readiness), load balancing over several workers, DNS expansion, and the health / capacity / metrics endpoints.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DEFAULT_IDENTITY_THRESHOLDS, type IdentityTestResponse } from '@sp/shared';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { runSelfTest } from '../src/services/identity-selftest.js';
import { buildVisionWorker } from '../src/vision-worker/server.js';
import { FakeVisionService } from '../src/vision/fake.js';
import { createVisionService, resolveModelsDir, VisionBusyError, VisionInputError, type OnnxVisionService } from '../src/vision/index.js';
import { createRemoteVisionService, NO_WORKER_RETRY_AFTER_SEC, type RemoteVisionOptions, type RemoteVisionService } from '../src/vision/remote.js';
import { staffApi } from './admin/fixtures.js';
import { consent, runCheck, sample, startCheck, startedSession } from './flow.js';
import { createTestEnv, type TestEnv } from './helpers.js';

const TOKEN = 'vision-worker-test-token-0123456789';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(20);
  }
}

interface Worker {
  fake: FakeVisionService;
  port: number;
  url: string;
  app(): FastifyInstance;
  stop(): Promise<void>;
  restart(): Promise<void>;
}
const workers: Worker[] = [];
const drivers: RemoteVisionService[] = [];

/** A vision worker on an ephemeral port of this process, with a FakeVisionService (or the given back-end) behind it. */
async function startWorker(o: { fake?: FakeVisionService; host?: string } = {}): Promise<Worker> {
  const fake = o.fake ?? new FakeVisionService({ defaultSpec: { person: 'alice' } });
  const host = o.host ?? '127.0.0.1';
  let app = await buildVisionWorker({ vision: fake, token: TOKEN });
  await app.listen({ port: 0, host });
  const port = (app.server.address() as AddressInfo).port;
  let running = true;
  const w: Worker = {
    fake,
    port,
    url: `http://127.0.0.1:${port}`,
    app: () => app,
    stop: async () => {
      if (!running) return;
      running = false;
      await app.close();
    },
    restart: async () => {
      app = await buildVisionWorker({ vision: fake, token: TOKEN });
      await app.listen({ port, host });
      running = true;
    },
  };
  workers.push(w);
  return w;
}

/** The remote driver with fast polling (production polls every second). */
async function remote(urls: string[], o: Partial<RemoteVisionOptions> = {}): Promise<RemoteVisionService> {
  const d = await createRemoteVisionService({ urls, token: TOKEN, pollMs: 50, pollTimeoutMs: 500, connectTimeoutMs: 500, timeoutMs: 5_000, ...o });
  drivers.push(d);
  return d;
}

afterAll(async () => {
  await Promise.all(drivers.map((d) => d.close()));
  await Promise.all(workers.map((w) => w.stop()));
});

const img = (spec: Parameters<typeof FakeVisionService.encode>[0] = { person: 'alice' }) => FakeVisionService.encode(spec);

describe('identity flows through a vision worker', () => {
  let w: Worker;
  let env: TestEnv;
  beforeAll(async () => {
    w = await startWorker();
    env = await createTestEnv({ fake: w.fake, service: await remote([w.url]) });
  });
  afterAll(async () => env?.close());

  it('check-in, exam start, identity samples and a confirmed swap are all analysed on the worker', async () => {
    const before = w.fake.calls.length;
    const s = await env.newSession();
    const c = env.candidateClient(s.token);
    await startedSession(env, c);
    expect(w.fake.calls.length).toBeGreaterThanOrEqual(before + 5); // the check-in's frames
    env.clock.advance(30_000);
    const m1 = await sample(env, c, { person: 'mallory' }, 'face_return');
    expect(m1.statusCode, m1.body).toBe(200);
    expect(m1.json().followUpInMs).toBeGreaterThan(0);
    env.clock.advance(4_000);
    const m2 = (await sample(env, c, { person: 'mallory' }, 'follow_up')).json();
    expect(m2.status).toBe('on_hold');
    expect(m2.hold.reason).toBe('identity_mismatch');
  });

  it('a different person at a resume check is held for review', async () => {
    const s = await env.newSession();
    const c = env.candidateClient(s.token);
    await startedSession(env, c);
    env.clock.advance(60_000);
    await c.req('POST', '/api/candidate/pause', { reason: 'break' });
    env.clock.advance(5 * 60_000);
    const { complete, identity } = await runCheck(env, c, 'resume', { spec: { person: 'mallory' } });
    expect(complete!.outcome).toBe('held');
    expect(identity!.decision).toBe('mismatch');
  });

  it('forwards the analysis options and priority, and returns exactly what the worker computed', async () => {
    const d = await remote([w.url]);
    const image = img({ person: 'alice', dhash: 'feedc0de00000000', yawDeg: 3.5, similarity: 0.71 });
    const viaWorker = await d.analyze(image, { embed: true, faceCrop: true, priority: 'background' });
    expect(w.fake.calls.at(-1)!.opts).toEqual({ embed: true, faceCrop: true, priority: 'background' });
    expect(viaWorker).toEqual(await new FakeVisionService().analyze(image, { embed: true, faceCrop: true }));
    await expect(d.analyze(img({ person: 'alice', corrupt: true }))).rejects.toBeInstanceOf(VisionInputError);
  });

  it('a corrupt image answers 400 invalid_image, as in-process', async () => {
    const s = await env.newSession();
    const c = env.candidateClient(s.token);
    await startedSession(env, c);
    const res = await sample(env, c, { person: 'alice', corrupt: true });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_image' });
  });

  it('an ID photo is processed on the worker (relaxed gate, no low-light pass)', async () => {
    const admin = await staffApi(env, 'admin');
    const cand = (await admin.post('/candidates', { name: 'Paula Photo' })).json();
    const n = w.fake.calls.length;
    const res = await admin.jpeg(`/candidates/${cand.id}/id-photo`, { person: 'paula' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ accepted: true, quality: { usable: true, faceCount: 1 } });
    const first = w.fake.calls[n];
    expect(first.spec.person).toBe('paula');
    expect(first.opts).toMatchObject({ embed: true, faceCrop: true, enhanceLowLight: false, gate: expect.objectContaining({ minInterEyePx: expect.any(Number) }) });
  });
});

describe('a busy or failing worker', () => {
  let w: Worker;
  let env: TestEnv;
  beforeAll(async () => {
    w = await startWorker();
    env = await createTestEnv({ fake: w.fake, service: await remote([w.url]) });
  });
  afterAll(async () => env?.close());
  afterEach(() => {
    w.fake.setLoad({});
  });

  it('a full worker queue: an identity sample answers 503 with the worker’s Retry-After, and is taken once there is room', async () => {
    const s = await env.newSession();
    const c = env.candidateClient(s.token);
    await startedSession(env, c);
    w.fake.busyNext(1, 7);
    const sampleId = crypto.randomUUID();
    const refused = await sample(env, c, { person: 'alice' }, 'periodic', sampleId);
    expect(refused.statusCode).toBe(503);
    expect(refused.headers['retry-after']).toBe('7');
    expect(refused.json()).toMatchObject({ error: 'vision_busy', retryAfterSec: 7 });
    expect((await sample(env, c, { person: 'alice' }, 'periodic', sampleId)).statusCode).toBe(200);
  });

  it('a check frame is told the server is busy (503 vision_busy), and the same frame goes through afterwards', async () => {
    const s = await env.newSession();
    const c = env.candidateClient(s.token);
    await consent(c);
    const start = (await startCheck(c, 'initial')).json();
    const frame = () => c.jpeg(`/api/candidate/checks/${start.checkId}/frames`, { person: 'alice' }, { step: 'frontal', capturedAt: env.clock.t, nonce: start.liveness?.nonce ?? '' });
    w.fake.busyNext(1, 4);
    const busy = await frame();
    expect(busy.statusCode).toBe(503);
    expect(busy.headers['retry-after']).toBe('4');
    expect(busy.json()).toMatchObject({ error: 'vision_busy', message: expect.stringMatching(/busy/) });
    expect((await frame()).statusCode).toBe(200);
  });

  it('a wrong token: the worker is not used, the server is not ready (vision unavailable) and frames are refused with Retry-After', async () => {
    const bad = await remote([w.url], { token: 'not-the-worker-token-0123456789' });
    expect(bad.load.workers).toBe(0);
    expect(bad.workerStates()).toMatchObject({ up: 0, down: 1 });
    expect(bad.workerInfo()[0].lastError).toMatch(/TOKEN/);
    await expect(bad.analyze(img())).rejects.toMatchObject({ name: 'VisionBusyError', retryAfterSec: NO_WORKER_RETRY_AFTER_SEC });

    const env2 = await createTestEnv({ fake: w.fake, service: bad });
    try {
      const ready = await env2.app.inject({ method: 'GET', url: '/api/health/ready' });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toMatchObject({ ok: false, db: 'ok', vision: 'unavailable', visionWorkers: { ready: 0, configured: 1 } });
      expect((await env2.app.inject({ method: 'GET', url: '/api/health/capacity' })).json()).toMatchObject({ accepting: false, reasons: ['vision_unavailable'] });
      const c = env2.candidateClient();
      await consent(c);
      const start = (await startCheck(c, 'initial')).json();
      const res = await c.jpeg(`/api/candidate/checks/${start.checkId}/frames`, { person: 'alice' }, { step: 'frontal', capturedAt: env2.clock.t, nonce: start.liveness?.nonce ?? '' });
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe(String(NO_WORKER_RETRY_AFTER_SEC));
    } finally {
      await env2.close();
    }
  });

  it('accepts the new and the old token while the secret is rotated', async () => {
    const fake = new FakeVisionService();
    const app = await buildVisionWorker({ vision: fake, token: ['new-worker-token-0123456789abcdef', TOKEN] });
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      for (const token of ['new-worker-token-0123456789abcdef', TOKEN]) expect((await remote([url], { token })).load.workers).toBe(3);
      expect((await remote([url], { token: 'retired-worker-token-0123456789' })).load.workers).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('worker endpoints: health probes without a token, the API only with it; no ready thread = 503 vision_unavailable', async () => {
    const get = (path: string, token?: string) => fetch(`${w.url}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect((await get('/health/live')).status).toBe(200);
    expect(await (await get('/health/ready')).json()).toMatchObject({ ok: true, workers: 3 });
    expect((await get('/v1/load')).status).toBe(401);
    expect((await get('/v1/load', 'wrong-token-0123456789abcdef')).status).toBe(401);
    expect(await (await get('/v1/load', TOKEN)).json()).toMatchObject({ instanceId: expect.any(String), load: { workers: 3, maxQueue: 256 } });
    const post = (headers: Record<string, string>, body?: Buffer) => fetch(`${w.url}/v1/analyze`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, ...headers }, body });
    expect((await post({ 'content-type': 'image/jpeg', 'x-vision-options': '{"priority":"urgent"}' }, img())).status).toBe(400);
    expect((await post({})).status).toBe(415);
    const unauth = await fetch(`${w.url}/v1/analyze`, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: img() });
    expect(unauth.status).toBe(401);

    const d = await remote([w.url]);
    w.fake.setLoad({ workers: 0 }); // e.g. every analysis thread crashed and is restarting
    expect((await get('/health/ready')).status).toBe(503);
    const r = await post({ 'content-type': 'image/jpeg' }, img());
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: 'vision_unavailable' });
    await until(() => d.load.workers === 0);
    await expect(d.analyze(img())).rejects.toBeInstanceOf(VisionBusyError);
    w.fake.setLoad({});
    await until(() => d.load.workers === 3);
    expect((await d.analyze(img())).primary).not.toBeNull();
  });
});

describe('several workers', () => {
  it('spreads analyses over idle workers, prefers the shortest expected wait, and adds the workers up in `load`', async () => {
    const a = await startWorker();
    const b = await startWorker();
    const d = await remote([a.url, b.url]);
    for (let i = 0; i < 12; i++) await d.analyze(img());
    expect(a.fake.calls.length).toBeGreaterThan(0);
    expect(b.fake.calls.length).toBeGreaterThan(0);
    expect(d.load).toMatchObject({ workers: 6, maxQueue: 512 });

    b.fake.setLoad({ inFlight: 3, queued: { interactive: 40, background: 5 }, oldestWaitMs: { interactive: 900, background: 400 }, estimatedWaitMs: { interactive: 3_000, background: 3_200 } });
    await until(() => d.load.queued.interactive === 40);
    const [na, nb] = [a.fake.calls.length, b.fake.calls.length];
    for (let i = 0; i < 8; i++) await d.analyze(img(), { priority: i % 2 ? 'background' : 'interactive' });
    expect(a.fake.calls.length).toBe(na + 8);
    expect(b.fake.calls.length).toBe(nb);
    const load = d.load;
    expect(load).toMatchObject({ workers: 6, inFlight: 3, queued: { interactive: 40, background: 5 }, estimatedWaitMs: { interactive: 0, background: 0 } });
    expect(load.oldestWaitMs.interactive).toBeGreaterThanOrEqual(900);

    // The preferred worker's queue is full: the frame was not taken there, so the other one analyses it (once).
    a.fake.busyNext(1, 9);
    const nb2 = b.fake.calls.length;
    expect((await d.analyze(img())).primary).not.toBeNull();
    expect(b.fake.calls.length).toBe(nb2 + 1);
    // Both full: the shortest Retry-After.
    a.fake.busyNext(1, 9);
    b.fake.busyNext(1, 6);
    await expect(d.analyze(img())).rejects.toMatchObject({ name: 'VisionBusyError', retryAfterSec: 6 });
  });

  it('a dead worker is skipped (circuit open) and used again once it answers; with none left the server is not ready', async () => {
    const a = await startWorker();
    const b = await startWorker();
    const d = await remote([a.url, b.url]);
    await b.stop();
    for (let i = 0; i < 6; i++) expect((await d.analyze(img())).primary).not.toBeNull(); // a connection refused is retried on `a`
    expect(d.workerStates()).toMatchObject({ up: 1, down: 1 });
    expect(d.load.workers).toBe(3);
    const nb = b.fake.calls.length;
    await b.restart();
    await until(() => d.workerStates().up === 2);
    for (let i = 0; i < 6; i++) await d.analyze(img());
    expect(b.fake.calls.length).toBeGreaterThan(nb);

    await a.stop();
    await b.stop();
    await until(() => d.load.workers === 0);
    expect(d.workerStates()).toMatchObject({ up: 0, down: 2 });
    await expect(d.analyze(img())).rejects.toMatchObject({ name: 'VisionBusyError', retryAfterSec: NO_WORKER_RETRY_AFTER_SEC });
  });

  it('a DNS name stands for every address it resolves to; two addresses of the same worker count once', async () => {
    const w = await startWorker({ host: '0.0.0.0' });
    let addresses = ['127.0.0.1', '127.0.0.2'];
    const d = await remote([`http://vision.internal:${w.port}`], { lookup: async () => addresses, resolveMs: 50 });
    const info = d.workerInfo();
    expect(info.map((i) => i.key).sort()).toEqual([`127.0.0.1:${w.port}`, `127.0.0.2:${w.port}`]);
    expect(info.filter((i) => i.duplicate)).toHaveLength(1);
    expect(d.workerStates()).toMatchObject({ up: 1 });
    expect(d.load.workers).toBe(3);
    expect((await d.analyze(img())).primary).not.toBeNull();
    addresses = ['127.0.0.2'];
    await until(() => d.workerInfo().length === 1);
    expect(d.workerInfo()[0]).toMatchObject({ key: `127.0.0.2:${w.port}`, state: 'up', duplicate: false });
  });
});

describe('readiness, capacity, admission and metrics with the remote driver', () => {
  const METRICS = 'metrics-token-0123456789abcdef';
  let w: Worker;
  let driver: RemoteVisionService;
  let env: TestEnv;
  beforeAll(async () => {
    w = await startWorker();
    driver = await remote([w.url]);
    env = await createTestEnv({ fake: w.fake, service: driver, env: { METRICS_TOKEN: METRICS } });
  });
  afterAll(async () => env?.close());
  afterEach(() => {
    w.fake.setLoad({});
  });
  const get = (url: string) => env.app.inject({ method: 'GET', url });

  it('ready while a worker is; capacity and admission at exam start follow the worker’s queue', async () => {
    const ready = await get('/api/health/ready');
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ ok: true, vision: 'ok', visionWorkers: { ready: 1, configured: 1 } });

    const s = await env.newSession();
    const c = env.candidateClient(s.token);
    await consent(c);
    expect((await runCheck(env, c, 'initial', { spec: { person: 'alice' } })).complete!.outcome).toBe('passed');

    w.fake.setLoad({ queued: { interactive: 10, background: 90 }, estimatedWaitMs: { interactive: 300, background: 9_000 } });
    await until(() => driver.load.estimatedWaitMs.background >= 9_000);
    expect((await get('/api/health/capacity')).json()).toEqual({ accepting: false, reasons: ['vision_queue_long'] });
    expect((await get('/api/health/ready')).statusCode).toBe(200); // a busy fleet still serves its candidates
    const deferred = await c.req('POST', '/api/candidate/start');
    expect(deferred.statusCode).toBe(503);
    expect(deferred.json()).toMatchObject({ error: 'start_deferred', retryAfterSec: 9 });

    w.fake.setLoad({});
    await until(() => driver.load.estimatedWaitMs.background === 0);
    expect((await get('/api/health/capacity')).json()).toEqual({ accepting: true, reasons: [] });
    expect((await c.req('POST', '/api/candidate/start')).statusCode).toBe(200);
  });

  it('buildApp with VISION_DRIVER=remote: /metrics shows the fleet, the worker-reported analysis times and the cost of the HTTP hop', async () => {
    // The production wiring (app.ts creates the driver from the config, with the metrics observer).
    const fromEnv = loadConfig({ NODE_ENV: 'test', VISION_DRIVER: 'remote', VISION_WORKER_URLS: w.url, VISION_WORKER_TOKEN: TOKEN });
    expect(fromEnv).toMatchObject({ visionDriver: 'remote', visionRemote: { urls: [w.url], token: TOKEN, timeoutMs: 30_000 } });
    const config = { ...env.config, metricsToken: METRICS, visionDriver: fromEnv.visionDriver, visionRemote: fromEnv.visionRemote };
    const app = await buildApp({ config, database: env.ctx.database, storage: env.storage, now: env.clock.now, migrate: false, jobs: false, bootstrap: false, serveWeb: false, mailer: null });
    try {
      expect((await app.inject({ method: 'GET', url: '/api/health/ready' })).json()).toMatchObject({ ok: true, vision: 'ok', visionWorkers: { ready: 1, configured: 1 } });
      expect((await app.ctx.vision.analyze(img(), { embed: true, priority: 'background' })).embedding).not.toBeNull();
      const text = (await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${METRICS}` } })).body;
      const value = (series: string) => Number(text.split('\n').find((l) => l.startsWith(`${series} `))?.split(' ')[1] ?? Number.NaN);
      expect(value('sp_vision_remote_workers{state="up"}')).toBe(1);
      expect(value('sp_vision_remote_workers{state="down"}')).toBe(0);
      expect(value('sp_vision_workers')).toBe(3);
      expect(value('sp_vision_remote_overhead_seconds_count')).toBe(1);
      expect(value('sp_vision_analyses_total{priority="background",result="ok"}')).toBe(1);
      expect(value('sp_vision_queue_wait_seconds_count{priority="background"}')).toBe(1);
    } finally {
      await app.close(); // closes the driver it created
    }
  });
});

/* ---------------------------------------------------------------- the real models behind a worker */

const FACES = process.env.SP_TEST_FACES_DIR ?? '/tmp/claude-0/faces';
const haveModels = (() => {
  try {
    resolveModelsDir();
    return true;
  } catch {
    return false;
  }
})();
const havePhotos = ['obama.jpg', 'obama_small.jpg', 'biden.jpg'].every((f) => existsSync(join(FACES, f)));

/** Webcam-like variants of one photo (as test/identity-real-model.test.ts). */
async function frames(file: string, n: number): Promise<Buffer[]> {
  const src = readFileSync(file);
  const meta = await sharp(src).metadata();
  const out: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const s = 1 - 0.03 * i;
    const wd = Math.round(meta.width! * s);
    const ht = Math.round(meta.height! * s);
    out.push(
      await sharp(src)
        .extract({ left: Math.round((meta.width! - wd) / 2), top: Math.round((meta.height! - ht) / 2), width: wd, height: ht })
        .resize({ width: 640, height: 480, fit: 'inside' })
        .modulate({ brightness: 1 - 0.05 * (i % 3) })
        .jpeg({ quality: 85 - i * 3 })
        .toBuffer(),
    );
  }
  return out;
}

describe.skipIf(!haveModels || !havePhotos)('the real models behind a vision worker', () => {
  let local: OnnxVisionService;
  let app: FastifyInstance;
  let d: RemoteVisionService;
  beforeAll(async () => {
    local = await createVisionService({ workers: 1 });
    app = await buildVisionWorker({ vision: local, token: TOKEN });
    await app.listen({ port: 0, host: '127.0.0.1' });
    d = await remote([`http://127.0.0.1:${(app.server.address() as AddressInfo).port}`]);
  }, 60_000);
  afterAll(async () => {
    await d?.close();
    await app?.close();
    await local?.close();
  });

  it('answers exactly the in-process analysis (embedding bit for bit, face crop, pose, quality) and ID-photo result', async () => {
    const photo = readFileSync(join(FACES, 'obama.jpg'));
    const viaWorker = await d.analyze(photo, { embed: true, faceCrop: true });
    expect(viaWorker.embedding).not.toBeNull();
    expect(viaWorker).toEqual(await local.analyze(photo, { embed: true, faceCrop: true }));
    const id = readFileSync(join(FACES, 'obama_small.jpg'));
    const viaWorkerId = await d.processIdPhoto(id);
    expect(viaWorkerId.accepted).toBe(true);
    expect(viaWorkerId).toEqual(await local.processIdPhoto(id));
  }, 60_000);

  it('frames the server stopped waiting for are dropped from the worker’s queue, and a slow (overloaded) worker stays in use', async () => {
    const photo = readFileSync(join(FACES, 'obama.jpg'));
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const impatient = await remote([url], { timeoutMs: 150 }); // shorter than a few analyses on the only thread
    const before = local.stats.analyzed;
    const settled = await Promise.allSettled(Array.from({ length: 10 }, () => impatient.analyze(photo, { embed: true })));
    const refused = settled.filter((s) => s.status === 'rejected');
    expect(refused.length).toBeGreaterThanOrEqual(6);
    for (const r of refused) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(VisionBusyError);
    await until(() => local.stats.inFlight === 0 && local.stats.queued === 0);
    await sleep(300);
    // Only what had started (or finished) before the timeout ran; the rest was dropped when the connections closed.
    expect(local.stats.analyzed - before).toBeLessThanOrEqual(10 - refused.length + 2);
    expect(impatient.workerStates()).toMatchObject({ up: 1, down: 0 }); // timeouts are not a dead worker
  }, 60_000);

  it('identity decisions through the worker: the same person stays consistent, a different person is flagged', async () => {
    let t = 1_000_000;
    const ctx = { now: () => t, vision: d };
    const run = async (mode: 'enroll' | 'probe', b: Buffer): Promise<IdentityTestResponse> => (await runSelfTest(ctx, { staffId: 'staff', testId: 'remote', mode, thresholds: DEFAULT_IDENTITY_THRESHOLDS }, b)).response;
    let enrolled: IdentityTestResponse | null = null;
    for (const b of await frames(join(FACES, 'obama.jpg'), 6)) enrolled = await run('enroll', b);
    expect(enrolled!.enrolledFrames).toBeGreaterThanOrEqual(3);
    t += 15_000;
    const same = await run('probe', (await frames(join(FACES, 'obama_small.jpg'), 2))[1]);
    expect(same.decision).toBe('match');
    expect(same.evidence!.state).toBe('consistent');
    t += 15_000;
    const other = await run('probe', (await frames(join(FACES, 'biden.jpg'), 2))[1]);
    expect(other.decision).toBe('mismatch');
  }, 120_000);
});

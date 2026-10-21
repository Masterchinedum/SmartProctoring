/**
 * Prometheus metrics (/metrics, lib/metrics.ts) and log correlation (request ids, session / staff ids on log lines).
 */
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { appLoggerOptions } from '../src/lib/log-redact.js';
import { AppMetrics } from '../src/lib/metrics.js';
import { MemoryStorage } from '../src/lib/storage.js';
import { sample, startedSession } from './flow.js';
import { createTestEnv, type TestEnv } from './helpers.js';

const TOKEN = 'metrics-token-0123456789abcdef';
let env: TestEnv;
let app: FastifyInstance;
const lines: string[] = [];

beforeAll(async () => {
  env = await createTestEnv();
  app = await buildApp({
    config: { ...env.config, metricsToken: TOKEN },
    database: env.ctx.database,
    vision: env.vision,
    storage: env.storage,
    now: env.clock.now,
    migrate: false,
    jobs: false,
    bootstrap: false,
    serveWeb: false,
    logger: {
      ...appLoggerOptions('info'),
      stream: new Writable({
        write(chunk, _enc, cb) {
          lines.push(String(chunk));
          cb();
        },
      }),
    },
  });
});
afterAll(async () => {
  await app?.close();
  await env?.close();
});

const scrape = (headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) => app.inject({ method: 'GET', url: '/metrics', headers });
/** The value of one series in the exposition text (null when absent). */
function value(text: string, series: string): number | null {
  const line = text.split('\n').find((l) => l.startsWith(`${series} `));
  return line ? Number(line.slice(series.length + 1)) : null;
}

describe('/metrics', () => {
  it('is not served without METRICS_TOKEN', async () => {
    expect((await env.app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
  });

  it('requires the bearer token', async () => {
    expect((await scrape({})).statusCode).toBe(401);
    expect((await scrape({ authorization: 'Bearer nope' })).statusCode).toBe(401);
    const ok = await scrape();
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toMatch(/^text\/plain; version=0\.0\.4/);
  });

  it('exposes the vision queue, capacity, the database pool, cluster backlogs, the identity model and process metrics', async () => {
    await app.inject({ method: 'GET', url: '/api/health' });
    env.vision.setLoad({ queued: { interactive: 2, background: 40 }, estimatedWaitMs: { interactive: 200, background: 2500 } });
    try {
      const text = (await scrape()).body;
      expect(value(text, 'sp_vision_workers')).toBe(3);
      expect(value(text, 'sp_vision_queued{priority="background"}')).toBe(40);
      expect(value(text, 'sp_vision_estimated_wait_seconds{priority="background"}')).toBe(2.5);
      expect(value(text, 'sp_capacity_accepting')).toBe(0);
      expect(value(text, 'sp_capacity_limited{reason="vision_queue_long"}')).toBe(1);
      expect(value(text, 'sp_capacity_limited{reason="event_loop_lagging"}')).toBe(0);
      expect(value(text, 'sp_db_pool_connections{state="waiting"}')).toBe(0);
      expect(value(text, 'sp_cluster_metrics_up')).toBe(1);
      expect(value(text, 'sp_cluster_sessions{status="active"}')).not.toBeNull();
      expect(value(text, 'sp_cluster_webhook_deliveries_pending')).toBe(0);
      expect(value(text, 'sp_cluster_webhook_oldest_pending_seconds')).toBe(0);
      expect(text).toMatch(/sp_identity_model_info\{calibration="webcam-v2\.1",embedding_model="\d+"\} 1/);
      expect(value(text, 'sp_http_requests_total{method="GET",route="/api/health",status="200"}')).toBeGreaterThanOrEqual(1);
      expect(text).toContain('process_cpu_user_seconds_total');
      expect(text).toContain('nodejs_eventloop_lag_p99_seconds');
    } finally {
      env.vision.setLoad({});
    }
  });

  it('counts identity decisions once committed: checks and in-exam samples, by trigger and decision', async () => {
    const s = await env.newSession();
    const c = env.candidateClient(s.token);
    await startedSession(env, c);
    expect((await sample(env, c, { person: 'alice' })).statusCode).toBe(200);
    const text = await env.ctx.metrics.registry.metrics();
    expect(value(text, 'sp_identity_decisions_total{kind="check",trigger="check_in",decision="match"}')).toBeGreaterThanOrEqual(1);
    expect(text).toMatch(/sp_identity_decisions_total\{kind="sample",trigger="periodic",decision="match"\} [1-9]/);
  });

  it('records background job runs: outcome, duration and last success', async () => {
    expect(await env.ctx.jobs.runNow('retention')).toBe(true);
    const text = await env.ctx.metrics.registry.metrics();
    expect(value(text, 'sp_job_runs_total{job="retention",result="ok"}')).toBe(1);
    expect(value(text, 'sp_job_last_success_timestamp_seconds{job="retention"}')).toBe(Math.round(env.clock.t / 1000));
  });

  it('counts failed evidence-store operations without changing what the caller sees', async () => {
    const m = new AppMetrics();
    const broken = new MemoryStorage();
    broken.put = async () => {
      throw new Error('disk full');
    };
    const s = m.instrumentStorage(broken);
    await expect(s.put('a/b', Buffer.from('x'))).rejects.toThrow('disk full');
    expect(await s.get('a/b')).toBeNull();
    expect(value(await m.registry.metrics(), 'sp_evidence_storage_errors_total{op="put"}')).toBe(1);
  });

  it('records face-analysis queue waits, analysis times and refusals from the worker pool', async () => {
    const m = new AppMetrics();
    m.visionObserver.analysisEnded({ priority: 'background', waitMs: 1500, runMs: 80, ok: true });
    m.visionObserver.analysisEnded({ priority: 'interactive', waitMs: 10, runMs: 5, ok: false });
    m.visionObserver.analysisRefused('background');
    const text = await m.registry.metrics();
    expect(value(text, 'sp_vision_analyses_total{priority="background",result="ok"}')).toBe(1);
    expect(value(text, 'sp_vision_analyses_total{priority="interactive",result="failed"}')).toBe(1);
    expect(value(text, 'sp_vision_refused_total{priority="background"}')).toBe(1);
    expect(value(text, 'sp_vision_queue_wait_seconds_bucket{le="1",priority="background"}')).toBe(0);
    expect(value(text, 'sp_vision_queue_wait_seconds_bucket{le="2",priority="background"}')).toBe(1);
    expect(value(text, 'sp_vision_analysis_seconds_count{priority="background"}')).toBe(1);
    expect(value(text, 'sp_vision_analysis_seconds_count{priority="interactive"}')).toBeNull(); // failures carry no analysis time
  });
});

describe('log correlation', () => {
  it('answers every request with its id: the proxy’s X-Request-Id when it is a plain token, else a new one', async () => {
    const kept = await app.inject({ method: 'GET', url: '/api/health/live', headers: { 'x-request-id': 'proxy-req-0001' } });
    expect(kept.headers['x-request-id']).toBe('proxy-req-0001');
    const replaced = await app.inject({ method: 'GET', url: '/api/health/live', headers: { 'x-request-id': 'bad id\nwith newline' } });
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const fresh = await app.inject({ method: 'GET', url: '/api/health/live' });
    expect(fresh.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('tags a candidate request’s log lines with its request id and exam session', async () => {
    lines.length = 0;
    const res = await app.inject({ method: 'GET', url: '/api/candidate/session', headers: { authorization: `Bearer ${env.session.token}`, 'x-client-instance': 'inst-log-0001', 'x-request-id': 'corr-candidate-01' } });
    expect(res.statusCode).toBe(200);
    const done = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'request completed' && l.reqId === 'corr-candidate-01');
    expect(done).toMatchObject({ sessionId: env.session.id, orgId: env.org.id });
  });

  it('tags a staff request’s log lines with the staff user', async () => {
    lines.length = 0;
    const cookie = await env.login('admin');
    await app.inject({ method: 'GET', url: '/api/admin/sessions', headers: { cookie, 'x-request-id': 'corr-staff-0001' } });
    const done = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'request completed' && l.reqId === 'corr-staff-0001');
    expect(done).toMatchObject({ staffId: env.users.admin.id, orgId: env.org.id });
  });
});

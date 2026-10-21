/**
 * Prometheus metrics (GET /metrics with `Authorization: Bearer $METRICS_TOKEN`, routes/metrics.ts;
 * docs/OPERATIONS.md §5 lists every metric and suggested alerts).
 *
 * Instance metrics describe this process: HTTP requests, the face-analysis queue (depth, waits, analysis time,
 * refusals), capacity, the Postgres pool, staff WebSockets, background jobs, evidence-storage errors and the identity
 * decisions made here. Cluster metrics (`sp_cluster_*`) are read from Postgres at scrape time and are the same on
 * every instance: aggregate them with max(), not sum().
 */
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import { and, count, gte, inArray, isNotNull, min, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { emailAlerts, examSessions, webhookDeliveries, webhooks } from '../db/schema.js';
import { CAPACITY_REASONS, currentCapacity, samplingPressure } from '../services/capacity.js';
import { CALIBRATION } from '../vision/calibration.js';
import { EMBEDDING_MODEL_CURRENT } from '../vision/embeddings.js';
import type { VisionObserver, VisionPriority } from '../vision/types.js';
import type { BlobStorage } from './storage.js';

const PRIORITIES: VisionPriority[] = ['interactive', 'background'];
/** Session states that are still in progress (cluster gauge). */
const LIVE_STATUSES = ['ready', 'active', 'paused', 'on_hold'] as const;
/** The cluster query must not hold up a scrape (or a connection) for long. */
const CLUSTER_QUERY_TIMEOUT_MS = 3_000;
/** Gauges of one scrape share one cluster query. */
const CLUSTER_SNAPSHOT_TTL_MS = 1_000;

interface ClusterSnapshot {
  sessions: Record<string, number>;
  reportingInterrupted: number;
  webhooksPending: number;
  webhooksOldestPendingAt: Date | null;
  webhooksFailed24h: number;
  webhooksDisabled: number;
  emailPending: number;
  emailOldestPendingAt: Date | null;
}

export class AppMetrics {
  readonly registry = new Registry();
  private ctx: Ctx | null = null;
  private cluster: { at: number; snapshot: Promise<ClusterSnapshot | null> } | null = null;
  private defaultsOn = false;

  readonly httpRequests = new Counter({ name: 'sp_http_requests_total', help: 'HTTP requests by route pattern and status.', labelNames: ['method', 'route', 'status'] as const, registers: [this.registry] });
  readonly httpDuration = new Histogram({
    name: 'sp_http_request_duration_seconds',
    help: 'HTTP request duration by route pattern.',
    labelNames: ['method', 'route'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [this.registry],
  });
  readonly visionAnalyses = new Counter({ name: 'sp_vision_analyses_total', help: 'Face analyses that finished, by queue priority and result (ok / failed).', labelNames: ['priority', 'result'] as const, registers: [this.registry] });
  readonly visionRefused = new Counter({ name: 'sp_vision_refused_total', help: 'Face analyses refused because the queue was full (HTTP 503 vision_busy).', labelNames: ['priority'] as const, registers: [this.registry] });
  readonly visionQueueWait = new Histogram({
    name: 'sp_vision_queue_wait_seconds',
    help: 'Time a face analysis waited in the queue for a worker.',
    labelNames: ['priority'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60],
    registers: [this.registry],
  });
  readonly visionAnalysisTime = new Histogram({
    name: 'sp_vision_analysis_seconds',
    help: 'Worker time of one face analysis (inference included).',
    labelNames: ['priority'] as const,
    buckets: [0.02, 0.04, 0.06, 0.08, 0.1, 0.15, 0.2, 0.3, 0.5, 1, 2],
    registers: [this.registry],
  });
  readonly identityDecisions = new Counter({
    name: 'sp_identity_decisions_total',
    help: 'Identity decisions recorded on this instance: kind check (check-in / resume / reconnect / reverify) or sample (during the exam), by trigger and decision (match / inconclusive / mismatch / unable_to_verify).',
    labelNames: ['kind', 'trigger', 'decision'] as const,
    registers: [this.registry],
  });
  readonly jobRuns = new Counter({ name: 'sp_job_runs_total', help: 'Background job runs on this instance: ok, failed, or skipped (another instance held the job).', labelNames: ['job', 'result'] as const, registers: [this.registry] });
  readonly jobDuration = new Histogram({ name: 'sp_job_duration_seconds', help: 'Background job run time.', labelNames: ['job'] as const, buckets: [0.01, 0.1, 0.5, 1, 5, 10, 60, 300, 1800], registers: [this.registry] });
  readonly jobLastSuccess = new Gauge({ name: 'sp_job_last_success_timestamp_seconds', help: 'When the job last completed without error on this instance (unix seconds).', labelNames: ['job'] as const, registers: [this.registry] });
  readonly retentionFailures = new Counter({ name: 'sp_retention_failures_total', help: 'Sessions whose evidence or event metadata the retention job could not purge (it retries next run).', registers: [this.registry] });
  readonly storageErrors = new Counter({ name: 'sp_evidence_storage_errors_total', help: 'Evidence store operations that failed (put / get / delete).', labelNames: ['op'] as const, registers: [this.registry] });
  readonly identitySamplesSpacedOut = new Counter({
    name: 'sp_identity_samples_spaced_out_total',
    help: 'Identity samples answered with a longer routine interval because the face-analysis queue was busy (load-aware sampling).',
    registers: [this.registry],
  });
  readonly examStartsDeferred = new Counter({
    name: 'sp_exam_starts_deferred_total',
    help: 'Exam starts deferred because this instance was at capacity (the candidate app retries; the exam clock has not started).',
    registers: [this.registry],
  });
  readonly staffSockets = new Gauge({ name: 'sp_staff_websockets', help: 'Open staff dashboard WebSockets on this instance.', registers: [this.registry] });

  constructor() {
    const reg = [this.registry];
    const self = this;
    new Gauge({
      name: 'sp_identity_model_info',
      help: 'Identity decision configuration this instance runs (1): calibration version and face-template model id. A change between deploys changes decisions.',
      labelNames: ['calibration', 'embedding_model'] as const,
      registers: reg,
    }).set({ calibration: CALIBRATION.version, embedding_model: String(EMBEDDING_MODEL_CURRENT) }, 1);

    const visionGauge = (name: string, help: string, read: (g: Gauge<'priority'>) => void) =>
      new Gauge({
        name,
        help,
        labelNames: ['priority'] as const,
        registers: reg,
        collect() {
          read(this);
        },
      });
    const load = () => this.ctx?.vision.load;
    new Gauge({
      name: 'sp_vision_workers',
      help: 'Face-analysis workers ready on this instance.',
      registers: reg,
      collect() {
        const l = load();
        if (l) this.set(l.workers);
      },
    });
    new Gauge({
      name: 'sp_vision_in_flight',
      help: 'Face analyses running now.',
      registers: reg,
      collect() {
        const l = load();
        if (l) this.set(l.inFlight);
      },
    });
    visionGauge('sp_vision_queued', 'Face analyses waiting for a worker.', (g) => {
      const l = load();
      if (l) for (const p of PRIORITIES) g.set({ priority: p }, l.queued[p]);
    });
    visionGauge('sp_vision_oldest_wait_seconds', 'How long the oldest waiting face analysis has waited.', (g) => {
      const l = load();
      if (l) for (const p of PRIORITIES) g.set({ priority: p }, l.oldestWaitMs[p] / 1000);
    });
    visionGauge('sp_vision_estimated_wait_seconds', 'Expected queue wait of a face analysis submitted now (also the basis of Retry-After).', (g) => {
      const l = load();
      if (l) for (const p of PRIORITIES) g.set({ priority: p }, l.estimatedWaitMs[p] / 1000);
    });
    new Gauge({
      name: 'sp_capacity_accepting',
      help: 'Whether this instance should take more exam starts (1) or not (0): GET /api/health/capacity.',
      registers: reg,
      collect() {
        if (self.ctx) this.set(currentCapacity(self.ctx).accepting ? 1 : 0);
      },
    });
    new Gauge({
      name: 'sp_capacity_limited',
      help: 'Why this instance should not take more exam starts (1 = this reason applies).',
      labelNames: ['reason'] as const,
      registers: reg,
      collect() {
        if (!self.ctx) return;
        const reasons = currentCapacity(self.ctx).reasons;
        for (const r of CAPACITY_REASONS) this.set({ reason: r }, reasons.includes(r) ? 1 : 0);
      },
    });
    new Gauge({
      name: 'sp_identity_sampling_pressure',
      help: 'How far routine identity samples are being spaced out because of the face-analysis queue (0 = not, 1 = to the Balanced intensity).',
      registers: reg,
      collect() {
        const c = self.ctx;
        if (c) this.set(c.config.loadAwareSampling ? samplingPressure(c.config.capacity, currentCapacity(c).visionWaitMs) : 0);
      },
    });
    new Gauge({
      name: 'sp_db_pool_connections',
      help: 'Postgres pool of this instance: total, idle, and requests waiting for a connection.',
      labelNames: ['state'] as const,
      registers: reg,
      collect() {
        const pool = self.ctx?.database.pool;
        if (!pool) return;
        this.set({ state: 'total' }, pool.totalCount);
        this.set({ state: 'idle' }, pool.idleCount);
        this.set({ state: 'waiting' }, pool.waitingCount);
      },
    });

    // Cluster-wide, from Postgres (one query per scrape).
    const clusterGauge = (name: string, help: string, labelNames: readonly string[], read: (g: Gauge<string>, s: ClusterSnapshot, now: number) => void) =>
      new Gauge({
        name,
        help,
        labelNames,
        registers: reg,
        async collect() {
          const s = await self.clusterSnapshot();
          this.reset();
          if (s) read(this, s, self.ctx!.now());
        },
      });
    new Gauge({
      name: 'sp_cluster_metrics_up',
      help: 'Whether the sp_cluster_* metrics could be read from Postgres in this scrape (1) or not (0).',
      registers: reg,
      async collect() {
        this.set((await self.clusterSnapshot()) ? 1 : 0);
      },
    });
    clusterGauge('sp_cluster_sessions', 'Exam sessions in progress, by status (all instances).', ['status'], (g, s) => {
      for (const st of LIVE_STATUSES) g.set({ status: st }, s.sessions[st] ?? 0);
    });
    clusterGauge('sp_cluster_sessions_reporting_interrupted', 'Sessions in progress whose browser has stopped reporting (reporting interrupted).', [], (g, s) => g.set(s.reportingInterrupted));
    clusterGauge('sp_cluster_webhook_deliveries_pending', 'Webhook deliveries waiting to be sent or retried.', [], (g, s) => g.set(s.webhooksPending));
    clusterGauge('sp_cluster_webhook_oldest_pending_seconds', 'Age of the oldest webhook delivery still pending (0 when none).', [], (g, s, now) => g.set(ageSec(s.webhooksOldestPendingAt, now)));
    clusterGauge('sp_cluster_webhook_deliveries_failed_24h', 'Webhook deliveries that gave up after every retry in the last 24 h (dead letters).', [], (g, s) => g.set(s.webhooksFailed24h));
    clusterGauge('sp_cluster_webhooks_disabled', 'Webhook endpoints disabled (after repeated failures or by staff).', [], (g, s) => g.set(s.webhooksDisabled));
    clusterGauge('sp_cluster_email_alerts_pending', 'Alert emails waiting to be sent or retried.', [], (g, s) => g.set(s.emailPending));
    clusterGauge('sp_cluster_email_alert_oldest_pending_seconds', 'Age of the oldest alert email still pending (0 when none).', [], (g, s, now) => g.set(ageSec(s.emailOldestPendingAt, now)));
  }

  /** Read gauges from this app's context at scrape time. */
  bind(ctx: Ctx): void {
    this.ctx = ctx;
  }

  /** Process metrics (CPU, memory, heap, GC, event-loop lag, Node version); only when /metrics is served. */
  enableProcessMetrics(): void {
    if (this.defaultsOn) return;
    this.defaultsOn = true;
    collectDefaultMetrics({ register: this.registry });
  }

  readonly visionObserver: VisionObserver = {
    analysisEnded: ({ priority, waitMs, runMs, ok }) => {
      this.visionAnalyses.inc({ priority, result: ok ? 'ok' : 'failed' });
      this.visionQueueWait.observe({ priority }, waitMs / 1000);
      if (ok) this.visionAnalysisTime.observe({ priority }, runMs / 1000);
    },
    analysisRefused: (priority) => {
      this.visionRefused.inc({ priority });
    },
  };

  httpRequest(method: string, route: string, status: number, ms: number): void {
    this.httpRequests.inc({ method, route, status: String(status) });
    this.httpDuration.observe({ method, route }, ms / 1000);
  }

  identityDecision(kind: 'check' | 'sample', trigger: string, decision: string): void {
    this.identityDecisions.inc({ kind, trigger, decision });
  }

  jobRun(job: string, result: 'ok' | 'failed' | 'skipped', ms: number, at: number): void {
    this.jobRuns.inc({ job, result });
    if (result === 'skipped') return;
    this.jobDuration.observe({ job }, ms / 1000);
    if (result === 'ok') this.jobLastSuccess.set({ job }, Math.round(at / 1000));
  }

  /** The same store, with failed operations counted. */
  instrumentStorage(storage: BlobStorage): BlobStorage {
    const counted = <T>(op: 'put' | 'get' | 'delete', p: Promise<T>): Promise<T> =>
      p.catch((err: unknown) => {
        this.storageErrors.inc({ op });
        throw err;
      });
    return {
      get driver() {
        return storage.driver;
      },
      put: (key, data) => counted('put', storage.put(key, data)),
      get: (key) => counted('get', storage.get(key)),
      delete: (key) => counted('delete', storage.delete(key)),
      ...(storage.close ? { close: () => storage.close!() } : {}),
    };
  }

  private clusterSnapshot(): Promise<ClusterSnapshot | null> {
    const now = Date.now();
    if (this.cluster && now - this.cluster.at < CLUSTER_SNAPSHOT_TTL_MS) return this.cluster.snapshot;
    const snapshot = this.readCluster();
    this.cluster = { at: now, snapshot };
    return snapshot;
  }

  private async readCluster(): Promise<ClusterSnapshot | null> {
    const ctx = this.ctx;
    if (!ctx) return null;
    const db = ctx.db;
    const since = new Date(ctx.now() - 24 * 3_600_000);
    const read = Promise.all([
      db.select({ status: examSessions.status, n: count() }).from(examSessions).where(inArray(examSessions.status, [...LIVE_STATUSES])).groupBy(examSessions.status),
      db
        .select({ n: count() })
        .from(examSessions)
        .where(and(inArray(examSessions.status, ['active', 'paused', 'on_hold']), isNotNull(examSessions.reportingInterruptedSince))),
      db.select({ n: count(), oldest: min(webhookDeliveries.createdAt) }).from(webhookDeliveries).where(sql`${webhookDeliveries.status} = 'pending'`),
      db
        .select({ n: count() })
        .from(webhookDeliveries)
        .where(and(sql`${webhookDeliveries.status} = 'failed'`, gte(webhookDeliveries.createdAt, since))),
      db.select({ n: count() }).from(webhooks).where(isNotNull(webhooks.disabledAt)),
      db.select({ n: count(), oldest: min(emailAlerts.createdAt) }).from(emailAlerts).where(sql`${emailAlerts.status} = 'pending'`),
    ]).then(([sessions, interrupted, wh, whFailed, whDisabled, email]) => ({
      sessions: Object.fromEntries(sessions.map((r) => [r.status, r.n])),
      reportingInterrupted: interrupted[0]?.n ?? 0,
      webhooksPending: wh[0]?.n ?? 0,
      webhooksOldestPendingAt: wh[0]?.oldest ?? null,
      webhooksFailed24h: whFailed[0]?.n ?? 0,
      webhooksDisabled: whDisabled[0]?.n ?? 0,
      emailPending: email[0]?.n ?? 0,
      emailOldestPendingAt: email[0]?.oldest ?? null,
    }));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), CLUSTER_QUERY_TIMEOUT_MS);
    });
    try {
      return await Promise.race([read, timeout]);
    } catch (err) {
      ctx.log.warn({ err }, 'metrics: cluster query failed');
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

function ageSec(at: Date | null, now: number): number {
  return at ? Math.max(0, (now - at.getTime()) / 1000) : 0;
}

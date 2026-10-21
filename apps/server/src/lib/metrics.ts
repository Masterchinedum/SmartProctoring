/**
 * Prometheus metrics (GET /metrics with `Authorization: Bearer $METRICS_TOKEN`, routes/metrics.ts;
 * docs/OPERATIONS.md §5 lists every metric and suggested alerts).
 *
 * Instance metrics describe this process: HTTP requests, the face-analysis queue (depth, waits, analysis time,
 * refusals), capacity, the Postgres pool (connections, acquisition wait, connection errors), staff WebSockets,
 * background jobs, the evidence store (latency, errors), check outcomes and the identity decisions made here. Cluster
 * metrics (`sp_cluster_*`) are read from Postgres at scrape time and are the same on every instance: aggregate them
 * with max(), not sum(). Slow-moving ones (background job status, privacy requests, retention backlog) are read at most
 * every SLOW_CLUSTER_TTL_MS.
 */
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import { API_KEY_EXPIRY_WARNING_DAYS, DEFAULT_REVIEW_SLA, PRIVACY_REQUEST_KINDS } from '@sp/shared';
import { and, count, eq, gt, gte, inArray, isNotNull, isNull, lte, min, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import type { DatabaseObserver } from '../db/index.js';
import { apiKeys, emailAlerts, events, examSessions, exams, jobStatus, organizations, privacyRequests, sessionReviews, webhookDeliveries, webhooks } from '../db/schema.js';
import { CAPACITY_REASONS, currentCapacity, samplingPressure } from '../services/capacity.js';
import { evidenceDueSql } from '../services/privacy-ops.js';
import { OPEN_PRIVACY_STATUSES } from '../services/privacy-requests.js';
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
/** Job status, privacy requests and the retention backlog change slowly: read at most this often (one query each). */
export const SLOW_CLUSTER_TTL_MS = 30_000;

/** Outcome of a readiness / identity check (sp_checks_completed_total): /complete's answer, or abandoned (expired / superseded). */
export type CheckOutcomeLabel = 'passed' | 'retry' | 'held' | 'failed' | 'abandoned';

interface SlowClusterSnapshot {
  /** job_status rows: background jobs that record their runs cluster-wide (retention). */
  jobs: { name: string; lastSuccessAt: Date | null; lastFinishedAt: Date | null; failed: boolean }[];
  privacyOpen: Record<string, number>;
  privacyOverdue: number;
  /** Sessions whose images are past their deletion date and not deleted (no legal hold), and the oldest due date. */
  retentionOverdue: number;
  retentionOldestDueAt: Date | null;
}

interface ClusterSnapshot {
  sessions: Record<string, number>;
  reportingInterrupted: number;
  webhooksPending: number;
  webhooksOldestPendingAt: Date | null;
  webhooksFailed24h: number;
  webhooksDisabled: number;
  emailPending: number;
  emailOldestPendingAt: Date | null;
  /** Held exams past their organisation's review target (reviewSla.holdMinutes). */
  holdsOverdue: number;
  flagsUndecided: number;
  oldestUndecidedFlagAt: Date | null;
  reviewsEscalated: number;
  /** Unrevoked API keys expiring within API_KEY_EXPIRY_WARNING_DAYS (not yet expired). */
  apiKeysExpiringSoon: number;
}

export class AppMetrics {
  readonly registry = new Registry();
  private ctx: Ctx | null = null;
  private cluster: { at: number; snapshot: Promise<ClusterSnapshot | null> } | null = null;
  private slowCluster: { at: number; snapshot: Promise<SlowClusterSnapshot | null> } | null = null;
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
  readonly visionRemoteOverhead = new Histogram({
    name: 'sp_vision_remote_overhead_seconds',
    help: 'Remote vision driver: time an analysis request to a vision worker took beyond the worker’s own queue wait and analysis (the HTTP hop).',
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [this.registry],
  });
  readonly visionRemoteFailures = new Counter({
    name: 'sp_vision_remote_failures_total',
    help: 'Remote vision driver: failed requests and load polls to vision workers, by reason (connect, timeout, reset, unauthorized, bad_response, server_error).',
    labelNames: ['reason'] as const,
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
  readonly storageErrors = new Counter({
    name: 'sp_evidence_storage_errors_total',
    help: 'Evidence store operations that failed (put / get / delete), per storage location (default or a STORAGE_LOCATIONS name).',
    labelNames: ['op', 'location'] as const,
    registers: [this.registry],
  });
  readonly storageDuration = new Histogram({
    name: 'sp_evidence_storage_seconds',
    help: 'Evidence store operation time (put / get / delete; disk or S3), failed operations included, per storage location.',
    labelNames: ['op', 'location'] as const,
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  readonly dbAcquire = new Histogram({
    name: 'sp_db_pool_acquire_seconds',
    help: 'Time a request waited for a Postgres connection from this instance’s pool (a new connection included).',
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [this.registry],
  });
  readonly dbConnectionErrors = new Counter({
    name: 'sp_db_connection_errors_total',
    help: 'Postgres connections that could not be opened (connect) or broke while open (lost: Postgres restarted, failed over or killed the connection).',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });
  readonly checksCompleted = new Counter({
    name: 'sp_checks_completed_total',
    help: 'Readiness / identity checks finished on this instance, by purpose (initial / resume / reconnect / reverify) and outcome (passed / retry / held / failed, or abandoned: expired or superseded without /complete).',
    labelNames: ['purpose', 'outcome'] as const,
    registers: [this.registry],
  });
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
      name: 'sp_vision_remote_workers',
      help: 'Remote vision driver: vision worker processes by state (up = in use, unready = no analysis thread ready, down = not answering / token rejected, unknown = not reached yet).',
      labelNames: ['state'] as const,
      registers: reg,
      collect() {
        const v = self.ctx?.vision as { workerStates?: () => Record<string, number> } | undefined;
        const states = v?.workerStates?.();
        if (states) for (const [state, n] of Object.entries(states)) this.set({ state }, n);
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
        const [fast, slow] = await Promise.all([self.clusterSnapshot(), self.slowClusterSnapshot()]);
        this.set(fast && slow ? 1 : 0);
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
    clusterGauge('sp_cluster_review_holds_overdue', 'Exams on hold longer than their organisation’s review target (Settings → review targets).', [], (g, s) => g.set(s.holdsOverdue));
    clusterGauge('sp_cluster_review_flags_undecided', 'Flags (integrity / uncertain / technical events) no reviewer has decided yet.', [], (g, s) => g.set(s.flagsUndecided));
    clusterGauge('sp_cluster_review_oldest_undecided_flag_seconds', 'Age of the oldest undecided flag (0 when none).', [], (g, s, now) => g.set(ageSec(s.oldestUndecidedFlagAt, now)));
    clusterGauge('sp_cluster_reviews_escalated', 'Session reviews escalated and not yet resolved.', [], (g, s) => g.set(s.reviewsEscalated));
    clusterGauge(
      'sp_cluster_api_keys_expiring_soon',
      `Integration API keys (not revoked) that expire within the next ${API_KEY_EXPIRY_WARNING_DAYS} days, all organisations: replace them before they stop working.`,
      [],
      (g, s) => g.set(s.apiKeysExpiringSoon),
    );

    // Cluster-wide and slow-moving (cached for SLOW_CLUSTER_TTL_MS).
    const slowGauge = (name: string, help: string, labelNames: readonly string[], read: (g: Gauge<string>, s: SlowClusterSnapshot, now: number) => void) =>
      new Gauge({
        name,
        help,
        labelNames,
        registers: reg,
        async collect() {
          const s = await self.slowClusterSnapshot();
          this.reset();
          if (s) read(this, s, self.ctx!.now());
        },
      });
    slowGauge(
      'sp_cluster_job_last_success_timestamp_seconds',
      'When a background job that records its runs in the database (retention) last completed without error, on any instance (unix seconds; absent until its first success).',
      ['job'],
      (g, s) => {
        for (const j of s.jobs) if (j.lastSuccessAt) g.set({ job: j.name }, Math.round(j.lastSuccessAt.getTime() / 1000));
      },
    );
    slowGauge('sp_cluster_job_last_run_failed', 'Whether the last finished run of a background job that records its runs (retention) failed as a whole (1) or not (0).', ['job'], (g, s) => {
      for (const j of s.jobs) if (j.lastFinishedAt) g.set({ job: j.name }, j.failed ? 1 : 0);
    });
    slowGauge('sp_cluster_privacy_requests_open', 'Data-subject requests in the privacy register that are open or in progress, by kind (all organisations).', ['kind'], (g, s) => {
      for (const k of PRIVACY_REQUEST_KINDS) g.set({ kind: k }, s.privacyOpen[k] ?? 0);
    });
    slowGauge('sp_cluster_privacy_requests_overdue', 'Open data-subject requests past their response deadline (due date, extensions included).', [], (g, s) => g.set(s.privacyOverdue));
    slowGauge('sp_cluster_retention_overdue_sessions', 'Ended sessions whose images are past their deletion date and not deleted yet (legal holds excluded).', [], (g, s) => g.set(s.retentionOverdue));
    slowGauge('sp_cluster_retention_overdue_oldest_seconds', 'How long the oldest overdue session’s images have been past their deletion date (0 when none).', [], (g, s, now) =>
      g.set(ageSec(s.retentionOldestDueAt, now)),
    );
  }

  /** Forget the cached sp_cluster_* values (the next scrape reads Postgres). */
  clearClusterCache(): void {
    this.cluster = null;
    this.slowCluster = null;
  }

  /** Pool observer (createDatabase): connection wait and connection errors. */
  readonly databaseObserver: DatabaseObserver = {
    acquired: (waitMs) => this.dbAcquire.observe(waitMs / 1000),
    connectionError: (kind) => this.dbConnectionErrors.inc({ kind }),
  };

  checkCompleted(purpose: string, outcome: CheckOutcomeLabel): void {
    this.checksCompleted.inc({ purpose, outcome });
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
    remoteRequestEnded: ({ overheadMs }) => {
      this.visionRemoteOverhead.observe(overheadMs / 1000);
    },
    remoteFailure: (reason) => {
      this.visionRemoteFailures.inc({ reason });
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

  /** The same store, with operation times measured and failed operations counted (per storage location). */
  instrumentStorage(storage: BlobStorage, location = 'default'): BlobStorage {
    const counted = async <T>(op: 'put' | 'get' | 'delete', run: () => Promise<T>): Promise<T> => {
      const t0 = performance.now();
      try {
        return await run();
      } catch (err) {
        this.storageErrors.inc({ op, location });
        throw err;
      } finally {
        this.storageDuration.observe({ op, location }, (performance.now() - t0) / 1000);
      }
    };
    return {
      get driver() {
        return storage.driver;
      },
      put: (key, data) => counted('put', () => storage.put(key, data)),
      get: (key) => counted('get', () => storage.get(key)),
      delete: (key) => counted('delete', () => storage.delete(key)),
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
      db
        .select({ n: count() })
        .from(examSessions)
        .innerJoin(organizations, eq(organizations.id, examSessions.orgId))
        .where(
          and(
            eq(examSessions.status, 'on_hold'),
            sql`${examSessions.holdSince} < ${new Date(ctx.now())}::timestamptz - make_interval(mins => coalesce((${organizations.settings} -> 'reviewSla' ->> 'holdMinutes')::int, ${DEFAULT_REVIEW_SLA.holdMinutes}))`,
          ),
        ),
      // Served by the partial index events_undecided_flags_idx.
      db
        .select({ n: count(), oldest: min(events.firstReceivedAt) })
        .from(events)
        .where(and(eq(events.reviewStatus, 'unreviewed'), inArray(events.category, ['integrity', 'uncertain', 'technical']))),
      db.select({ n: count() }).from(sessionReviews).where(eq(sessionReviews.state, 'escalated')),
      db
        .select({ n: count() })
        .from(apiKeys)
        .where(and(isNull(apiKeys.revokedAt), gt(apiKeys.expiresAt, new Date(ctx.now())), lte(apiKeys.expiresAt, new Date(ctx.now() + API_KEY_EXPIRY_WARNING_DAYS * 86_400_000)))),
    ]).then(([sessions, interrupted, wh, whFailed, whDisabled, email, holdsOverdue, flags, escalated, keysExpiring]) => ({
      sessions: Object.fromEntries(sessions.map((r) => [r.status, r.n])),
      reportingInterrupted: interrupted[0]?.n ?? 0,
      webhooksPending: wh[0]?.n ?? 0,
      webhooksOldestPendingAt: wh[0]?.oldest ?? null,
      webhooksFailed24h: whFailed[0]?.n ?? 0,
      webhooksDisabled: whDisabled[0]?.n ?? 0,
      emailPending: email[0]?.n ?? 0,
      emailOldestPendingAt: email[0]?.oldest ?? null,
      holdsOverdue: holdsOverdue[0]?.n ?? 0,
      flagsUndecided: flags[0]?.n ?? 0,
      oldestUndecidedFlagAt: flags[0]?.oldest ?? null,
      reviewsEscalated: escalated[0]?.n ?? 0,
      apiKeysExpiringSoon: keysExpiring[0]?.n ?? 0,
    }));
    return withTimeout(ctx, read);
  }

  /** Cached for SLOW_CLUSTER_TTL_MS; a failed read is not cached (the next scrape tries again). */
  private slowClusterSnapshot(): Promise<SlowClusterSnapshot | null> {
    const now = Date.now();
    if (this.slowCluster && now - this.slowCluster.at < SLOW_CLUSTER_TTL_MS) return this.slowCluster.snapshot;
    const snapshot = this.readSlowCluster();
    const entry = { at: now, snapshot };
    this.slowCluster = entry;
    void snapshot.then((s) => {
      if (!s && this.slowCluster === entry) this.slowCluster = null;
    });
    return snapshot;
  }

  private async readSlowCluster(): Promise<SlowClusterSnapshot | null> {
    const ctx = this.ctx;
    if (!ctx) return null;
    const db = ctx.db;
    const nowDate = new Date(ctx.now());
    const read = Promise.all([
      db.select({ name: jobStatus.name, lastSuccessAt: jobStatus.lastSuccessAt, lastFinishedAt: jobStatus.lastFinishedAt, lastError: jobStatus.lastError }).from(jobStatus),
      db
        .select({ kind: privacyRequests.kind, n: count(), overdue: sql<number>`count(*) filter (where ${privacyRequests.dueAt} < ${nowDate})::int` })
        .from(privacyRequests)
        .where(inArray(privacyRequests.status, OPEN_PRIVACY_STATUSES))
        .groupBy(privacyRequests.kind),
      // The retention preview's "past its date" (services/privacy-ops.ts), over all organisations.
      db
        .select({ n: count(), oldest: sql<Date | null>`min(${evidenceDueSql})` })
        .from(examSessions)
        .innerJoin(exams, eq(exams.id, examSessions.examId))
        .innerJoin(organizations, eq(organizations.id, examSessions.orgId))
        .where(and(isNotNull(examSessions.endedAt), isNull(examSessions.evidencePurgedAt), eq(examSessions.legalHold, false), lte(evidenceDueSql, nowDate))),
    ]).then(([jobs, privacy, [overdue]]) => ({
      jobs: jobs.map((j) => ({ name: j.name, lastSuccessAt: j.lastSuccessAt, lastFinishedAt: j.lastFinishedAt, failed: j.lastError != null })),
      privacyOpen: Object.fromEntries(privacy.map((r) => [r.kind, r.n])),
      privacyOverdue: privacy.reduce((a, r) => a + r.overdue, 0),
      retentionOverdue: overdue?.n ?? 0,
      retentionOldestDueAt: overdue?.oldest ? new Date(overdue.oldest) : null,
    }));
    return withTimeout(ctx, read);
  }
}

/** A cluster query must not hold up a scrape: null after CLUSTER_QUERY_TIMEOUT_MS or on error (logged). */
async function withTimeout<T>(ctx: Ctx, read: Promise<T>): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CLUSTER_QUERY_TIMEOUT_MS);
  });
  // A query that fails after the timeout won must not become an unhandled rejection (that would end the process).
  let raced = false;
  read.catch((err: unknown) => {
    if (raced) ctx.log.warn({ err }, 'metrics: cluster query failed after its timeout');
  });
  try {
    return await Promise.race([read, timeout]);
  } catch (err) {
    ctx.log.warn({ err }, 'metrics: cluster query failed');
    return null;
  } finally {
    raced = true;
    clearTimeout(timer);
  }
}

function ageSec(at: Date | null, now: number): number {
  return at ? Math.max(0, (now - at.getTime()) / 1000) : 0;
}

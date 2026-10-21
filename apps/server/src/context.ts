import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { Database, Db } from './db/index.js';
import type { JobRunner } from './jobs/runner.js';
import type { Keyring } from './lib/crypto.js';
import type { LoadMonitor } from './lib/load-monitor.js';
import type { AppMetrics } from './lib/metrics.js';
import type { Mailer } from './lib/mailer.js';
import type { BlobStorage, StorageLocations } from './lib/storage.js';
import type { RealtimeBus } from './realtime/bus.js';
import type { LiveNotifier } from './realtime/notifier.js';
import type { VerifierRegistry } from './verifiers/registry.js';
import type { VisionService } from './vision/types.js';

/**
 * Everything a route or service needs. Created once in buildApp() and available as `app.ctx`
 * (or `request.server.ctx`) inside routes. Services take it as their first argument.
 */
export interface Ctx {
  config: Config;
  database: Database;
  db: Db;
  vision: VisionService;
  /** The default evidence store (storage location `default`). Evidence rows are read where they were written: storageAt(). */
  storage: BlobStorage;
  /** Every configured evidence storage location, `default` (= storage) included (data residency, lib/storage.ts). */
  storageLocations: StorageLocations;
  keyring: Keyring;
  bus: RealtimeBus;
  /** Clock (epoch ms). Always use this instead of Date.now() so tests can control time. */
  now: () => number;
  log: FastifyBaseLogger;
  /** Throttled realtime publishing for staff dashboards. */
  live: LiveNotifier;
  /** Periodic background jobs (advisory-lock guarded). Register with ctx.jobs.register({...}). */
  jobs: JobRunner;
  /** Outgoing email (SMTP from config.smtp, or a fake in tests). null = email alerts unavailable. */
  mailer: Mailer | null;
  /** Optional external second-opinion face verifiers (src/verifiers; per-org settings, off by default). */
  verifiers: VerifierRegistry;
  /** Event-loop / database-pool / vision-queue sampling of this instance (snapshot null until it has run). */
  loadMonitor: LoadMonitor;
  /** Prometheus metrics of this instance (lib/metrics.ts; served at /metrics when METRICS_TOKEN is set). */
  metrics: AppMetrics;
}

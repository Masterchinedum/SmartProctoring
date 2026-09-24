import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { Database, Db } from './db/index.js';
import type { Keyring } from './lib/crypto.js';
import type { BlobStorage } from './lib/storage.js';
import type { RealtimeBus } from './realtime/bus.js';
import type { LiveNotifier } from './realtime/notifier.js';
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
  storage: BlobStorage;
  keyring: Keyring;
  bus: RealtimeBus;
  /** Clock (epoch ms). Always use this instead of Date.now() so tests can control time. */
  now: () => number;
  log: FastifyBaseLogger;
  /** Throttled realtime publishing for staff dashboards. */
  live: LiveNotifier;
}

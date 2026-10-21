import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.js';

export { schema };
export type Db = NodePgDatabase<typeof schema>;
/** A drizzle transaction handle (same query API as Db). */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything you can run queries on: the db or an open transaction. */
export type DbOrTx = Db | Tx;

// Return BIGINT (int8) as JS number (counts; values we store fit in 2^53).
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

/** Told about the pool's connections (buildApp: metrics and log lines). Must not throw. */
export interface DatabaseObserver {
  /** A pooled connection was handed out — pool.connect(), also behind every query outside a transaction — after `waitMs`. */
  acquired(waitMs: number): void;
  /** A connection could not be opened ('connect'), or an open one broke ('lost': idle in the pool or in use). */
  connectionError(kind: 'connect' | 'lost', err: Error): void;
}

export interface Database {
  pool: pg.Pool;
  db: Db;
  close(): Promise<void>;
  /** Watch the pool's connections; returns the function that stops it. */
  observe(observer: Partial<DatabaseObserver>): () => void;
}

export interface DatabaseOptions {
  /** Pool size (PG_POOL_MAX; default 20). Sum over all instances must stay below Postgres max_connections. */
  max?: number;
  applicationName?: string;
  /** Server-side statement_timeout for pooled connections (ms; 0/undefined = none). Migrations lift it. */
  statementTimeoutMs?: number;
}

type ConnectCallback = (err: Error | undefined, client: pg.PoolClient | undefined, release: (err?: unknown) => void) => void;

export function createDatabase(url: string, opts: DatabaseOptions = {}): Database {
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 20,
    application_name: opts.applicationName ?? 'smartproctoring',
    idleTimeoutMillis: 30_000,
    ...(opts.statementTimeoutMs ? { statement_timeout: opts.statementTimeoutMs } : {}),
  });
  const observers = new Set<Partial<DatabaseObserver>>();
  const connectionError = (kind: 'connect' | 'lost', err: Error) => {
    if (!observers.size) console.error(`[db] ${kind === 'connect' ? 'connection failed' : 'connection lost'}:`, err.message);
    for (const o of observers) o.connectionError?.(kind, err);
  };
  // The pool re-emits errors of idle clients (Postgres restarted, the connection was killed): a listener is required,
  // or the process crashes. They are reported by the client listener below.
  pool.on('error', () => {});
  // A connection that breaks while it is checked out — between or during the statements of a transaction: Postgres
  // restarted or failed over, pg_terminate_backend, idle_in_transaction_session_timeout, a network cut — emits 'error'
  // on the client, where pg-pool listens only while the client is idle. Without this listener that error is unhandled
  // and takes the whole process down with every request in flight. With it, the transaction's statements fail (its
  // request answers 500 and the client retries), Postgres has rolled it back, and the pool discards the client when
  // it is released (pg-pool drops clients that are no longer queryable). Reported once per connection.
  const broken = new WeakSet<pg.PoolClient>();
  pool.on('connect', (client) => {
    client.on('error', (err) => {
      if (broken.has(client)) return;
      broken.add(client);
      connectionError('lost', err);
    });
  });
  // How long a request waits for a connection, and connections that cannot be opened (pool.query() goes through
  // pool.connect() too).
  const rawConnect = pool.connect.bind(pool) as (cb?: ConnectCallback) => Promise<pg.PoolClient> | void;
  const observedConnect = (cb?: ConnectCallback): Promise<pg.PoolClient> | void => {
    const t0 = performance.now();
    const settled = (err: Error | undefined) => {
      if (err) connectionError('connect', err);
      else if (observers.size) for (const o of observers) o.acquired?.(performance.now() - t0);
    };
    if (cb) {
      return rawConnect((err, client, release) => {
        settled(err);
        cb(err, client, release);
      });
    }
    return (rawConnect() as Promise<pg.PoolClient>).then(
      (client) => {
        settled(undefined);
        return client;
      },
      (err: Error) => {
        settled(err);
        throw err;
      },
    );
  };
  pool.connect = observedConnect as pg.Pool['connect'];
  const db = drizzle(pool, { schema });
  return {
    pool,
    db,
    async close() {
      await pool.end();
    },
    observe(observer) {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
  };
}

/**
 * Locate the SQL migrations folder. Works from src/ (tsx), dist/ (bundled) and tests.
 * Override with MIGRATIONS_DIR.
 */
export function findMigrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return resolve(process.env.MIGRATIONS_DIR);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    for (const candidate of [resolve(dir, 'drizzle'), resolve(dir, 'migrations')]) {
      if (existsSync(resolve(candidate, 'meta', '_journal.json'))) return candidate;
    }
    dir = dirname(dir);
  }
  throw new Error('Could not locate the drizzle migrations folder (set MIGRATIONS_DIR).');
}

/**
 * Apply pending migrations. Safe to call concurrently from several instances (advisory lock). `migrationsFolder` is for
 * upgrade tests that stop at an earlier migration (test/migrations.test.ts).
 */
export async function migrate(database: Database, opts: { migrationsFolder?: string } = {}): Promise<void> {
  const client = await database.pool.connect();
  try {
    // Index builds on large tables may take longer than the request-oriented statement_timeout.
    await client.query('SET statement_timeout = 0');
    await client.query('SELECT pg_advisory_lock(727274001)');
    try {
      await drizzleMigrate(drizzle(client, { schema }), { migrationsFolder: opts.migrationsFolder ?? findMigrationsDir() });
    } finally {
      await client.query('SELECT pg_advisory_unlock(727274001)');
      await client.query('RESET statement_timeout');
    }
  } finally {
    client.release();
  }
}

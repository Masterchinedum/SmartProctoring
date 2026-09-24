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

export interface Database {
  pool: pg.Pool;
  db: Db;
  close(): Promise<void>;
}

export function createDatabase(url: string, opts: { max?: number; applicationName?: string } = {}): Database {
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 20,
    application_name: opts.applicationName ?? 'smartproctoring',
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', (err) => {
    // Idle client errors (e.g. server restart) must not crash the process.
    console.error('[db] idle client error', err.message);
  });
  const db = drizzle(pool, { schema });
  return {
    pool,
    db,
    async close() {
      await pool.end();
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

/** Apply pending migrations. Safe to call concurrently from several instances (advisory lock). */
export async function migrate(database: Database): Promise<void> {
  const client = await database.pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274001)');
    try {
      await drizzleMigrate(drizzle(client, { schema }), { migrationsFolder: findMigrationsDir() });
    } finally {
      await client.query('SELECT pg_advisory_unlock(727274001)');
    }
  } finally {
    client.release();
  }
}

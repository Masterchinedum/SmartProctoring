/**
 * Creates (once per `vitest run`) a migrated template database; each test file clones it
 * (CREATE DATABASE ... TEMPLATE) so files run in parallel on isolated databases.
 * Names are unique per run so concurrent test runs (several developers/agents) never collide.
 */
import pg from 'pg';
import type { GlobalSetupContext } from 'vitest/node';
import { createDatabase, migrate } from '../src/db/index.js';

export const TEST_ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres';

export function dbUrl(name: string): string {
  const u = new URL(TEST_ADMIN_URL);
  u.pathname = `/${name}`;
  return u.toString();
}

declare module 'vitest' {
  export interface ProvidedContext {
    testTemplateDb: string;
    testRunId: string;
  }
}

export default async function setup({ provide }: GlobalSetupContext) {
  const runId = `${process.pid}_${Date.now().toString(36)}`;
  const template = `proctor_tpl_${runId}`;
  const admin = new pg.Client({ connectionString: TEST_ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${template}`);
  } finally {
    await admin.end();
  }
  const database = createDatabase(dbUrl(template), { max: 1 });
  try {
    await migrate(database);
  } finally {
    await database.close();
  }
  provide('testTemplateDb', template);
  provide('testRunId', runId);
  return async () => {
    const a = new pg.Client({ connectionString: TEST_ADMIN_URL });
    await a.connect();
    try {
      const { rows } = await a.query(`SELECT datname FROM pg_database WHERE datname LIKE $1`, [`proctor_t_${runId}_%`]);
      for (const r of rows) await a.query(`DROP DATABASE IF EXISTS "${r.datname}" WITH (FORCE)`);
      await a.query(`DROP DATABASE IF EXISTS ${template} WITH (FORCE)`);
    } finally {
      await a.end();
    }
  };
}

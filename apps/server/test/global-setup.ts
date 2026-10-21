/**
 * Creates (once per `vitest run`) a migrated template database; each test file clones it
 * (CREATE DATABASE ... TEMPLATE) so files run in parallel on isolated databases.
 * Names are unique per run so concurrent test runs (several developers/agents) never collide.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * The public photos the real-model tests need (src/vision/service.test.ts, src/eval/identity-eval.test.ts,
 * test/identity-real-model.test.ts; fetched by `pnpm --filter @sp/e2e fetch-faces` and
 * `pnpm --filter @sp/server eval:fetch-faces`). Without them those tests skip — unless SP_REQUIRE_TEST_IMAGES=1 (CI),
 * which makes a missing image a failure, so a green run means they ran.
 */
function requireTestImages(): void {
  if (process.env.SP_REQUIRE_TEST_IMAGES !== '1') return;
  const faces = process.env.SP_TEST_FACES_DIR ?? '/tmp/claude-0/faces';
  const facesets = process.env.SP_TEST_FACESETS_DIR ?? '/tmp/claude-0/facesets';
  const needed = [
    ...['obama.jpg', 'obama2.jpg', 'obama_small.jpg', 'biden.jpg', 'two_people.jpg'].map((f) => join(faces, f)),
    ...['Family1-Dad1', 'Family1-Dad2', 'Family1-Dad3', 'Family1-Son1', 'Family1-Son2'].map((n) => join(facesets, 'azure', `Face__images__${n}.jpg`)),
  ];
  const missing = needed.filter((f) => !existsSync(f));
  if (missing.length) throw new Error(`SP_REQUIRE_TEST_IMAGES=1 but test images are missing: ${missing.join(', ')}`);
}

export default async function setup({ provide }: GlobalSetupContext) {
  requireTestImages();
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

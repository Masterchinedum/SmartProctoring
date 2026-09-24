import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FullConfig } from '@playwright/test';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  ARTIFACTS_DIR,
  BASE_URL,
  DATABASE_URL,
  EVIDENCE_KEY,
  EXTERNAL_SERVER,
  FACES_DIR,
  PORT,
  REPO_DIR,
  SESSION_SECRET,
} from './lib/config';
import { ensureFixtures } from './lib/fixtures';

const log = (m: string) => console.log(`[e2e setup] ${m}`);

/** Drop and re-create the throwaway database (uses the server's own `pg` dependency; no extra deps). */
async function resetDatabase(): Promise<void> {
  const url = new URL(DATABASE_URL);
  const dbName = url.pathname.replace(/^\//, '');
  if (!/^[a-z0-9_]+$/i.test(dbName) || !/e2e/i.test(dbName)) throw new Error(`Refusing to reset database "${dbName}": the name must contain "e2e".`);
  const require = createRequire(join(REPO_DIR, 'apps/server/package.json'));
  const pg = require('pg') as { Client: new (o: { connectionString: string }) => { connect(): Promise<void>; query(q: string): Promise<unknown>; end(): Promise<void> } };
  const admin = new URL(DATABASE_URL);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await client.end();
  }
  log(`database ${dbName} re-created`);
}

function buildWeb(): void {
  const dist = join(REPO_DIR, 'apps/web/dist/index.html');
  if (process.env.E2E_SKIP_BUILD === '1' && existsSync(dist)) {
    log('E2E_SKIP_BUILD=1: reusing apps/web/dist');
    return;
  }
  log('building the web app (vite build) …');
  const t0 = Date.now();
  // `vite build` only: type errors are the typecheck job's business, not a reason to skip behaviour tests.
  const r = spawnSync('pnpm', ['--filter', '@sp/web', 'exec', 'vite', 'build', '--logLevel', 'warn'], { cwd: REPO_DIR, stdio: 'inherit', env: process.env });
  if (r.status !== 0) throw new Error('web build failed');
  log(`web app built in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

async function waitForHealth(proc: ChildProcess | null, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    if (proc && proc.exitCode != null) throw new Error(`server exited with code ${proc.exitCode} (see e2e/.artifacts/server.log)`);
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not become healthy at ${BASE_URL} within ${timeoutMs / 1000} s (${last})`);
}

export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const t0 = Date.now();
  const fx = await ensureFixtures(log);
  if (fx.built.length) log(`fixtures built: ${fx.built.join(', ')}`);
  if (fx.skipped.length) log(`face images missing in ${FACES_DIR}: camera fixtures ${fx.skipped.join(', ')} unavailable (their tests are skipped)`);

  if (EXTERNAL_SERVER) {
    log(`using the running server at ${BASE_URL}`);
    await waitForHealth(null, 30_000);
    return async () => undefined;
  }

  await resetDatabase();
  buildWeb();

  const storageDir = mkdtempSync(join(tmpdir(), 'sp-e2e-storage-'));
  const logFile = join(ARTIFACTS_DIR, 'server.log');
  const out = createWriteStream(logFile);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production', // production code paths; the secrets below are test-only
    COOKIE_SECURE: 'false', // plain http://localhost
    PORT: String(PORT),
    HOST: '127.0.0.1',
    PUBLIC_URL: BASE_URL,
    DATABASE_URL,
    EVIDENCE_KEY,
    SESSION_SECRET,
    STORAGE_DRIVER: 'fs',
    STORAGE_DIR: storageDir,
    WEB_DIST_DIR: join(REPO_DIR, 'apps/web/dist'),
    BOOTSTRAP_ADMIN_EMAIL: ADMIN_EMAIL,
    BOOTSTRAP_ADMIN_PASSWORD: ADMIN_PASSWORD,
    BOOTSTRAP_ORG_NAME: 'E2E University',
    SWEEPER_ENABLED: 'true',
    SWEEPER_INTERVAL_MS: '2000',
    LOG_LEVEL: process.env.E2E_SERVER_LOG_LEVEL || 'info',
    REDIS_URL: '',
    SMTP_HOST: '',
  };
  log(`starting the server on ${BASE_URL} (log: e2e/.artifacts/server.log)`);
  // From source (tsx), like `pnpm --filter @sp/server exec tsx src/main.ts`, in its own process group.
  const proc = spawn(join(REPO_DIR, 'apps/server/node_modules/.bin/tsx'), ['src/main.ts'], {
    cwd: join(REPO_DIR, 'apps/server'),
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout!.pipe(out);
  proc.stderr!.pipe(out);
  await waitForHealth(proc, 120_000);
  log(`ready after ${((Date.now() - t0) / 1000).toFixed(0)} s`);

  return async () => {
    if (proc.exitCode == null && proc.pid) {
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      const deadline = Date.now() + 10_000;
      while (proc.exitCode == null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
      if (proc.exitCode == null) {
        try {
          process.kill(-proc.pid, 'SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }
    out.end();
    rmSync(storageDir, { recursive: true, force: true });
  };
}

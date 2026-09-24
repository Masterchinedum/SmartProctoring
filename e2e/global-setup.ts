import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FullConfig } from '@playwright/test';
import { ARTIFACTS_DIR, BASE_URL, DATABASE_URL, EXTERNAL_SERVER, FACES_DIR, PORT, REPO_DIR } from './lib/config';
import { ensureFixtures } from './lib/fixtures';
import { ensureRealisticFixtures, FACESETS_DIR, type RwFixtureName } from './lib/realistic';
import { resetDatabase, startServer, waitForHealth } from './lib/server';

const log = (m: string) => console.log(`[e2e setup] ${m}`);

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

/**
 * Keep the previous runs' server logs (server-<run id>.log, the newest 8): a failure seen only in an earlier run
 * must stay diagnosable after the next run has started.
 */
function rotateServerLog(runId: string): void {
  const cur = join(ARTIFACTS_DIR, 'server.log');
  if (existsSync(cur)) {
    const prevId = new Date(statSync(cur).mtimeMs).toISOString().replace(/[:.]/g, '-');
    renameSync(cur, join(ARTIFACTS_DIR, `server-${prevId}.log`));
  }
  const old = readdirSync(ARTIFACTS_DIR)
    .filter((f) => /^server-\d{4}-.*\.log$/.test(f))
    .sort()
    .reverse();
  for (const f of old.slice(8)) rmSync(join(ARTIFACTS_DIR, f), { force: true });
  log(`run ${runId}: previous server logs kept as e2e/.artifacts/server-<time>.log`);
}

export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const t0 = Date.now();
  // Workers inherit this: realistic scenarios tag their metrics with the run (lib/metrics.ts).
  process.env.E2E_RUN_ID ||= new Date().toISOString().replace(/[:.]/g, '-');
  const fx = await ensureFixtures(log);
  if (fx.built.length) log(`fixtures built: ${fx.built.join(', ')}`);
  if (fx.skipped.length) log(`face images missing in ${FACES_DIR}: camera fixtures ${fx.skipped.join(', ')} unavailable (their tests are skipped)`);
  if (process.env.E2E_SKIP_REALISTIC !== '1') {
    const only = (process.env.E2E_RW_ONLY ?? '').split(',').filter(Boolean) as RwFixtureName[];
    const rw = ensureRealisticFixtures(log, only);
    if (rw.built.length) log(`realistic fixtures built: ${rw.built.join(', ')}`);
    if (rw.skipped.length) log(`identity sets missing in ${FACESETS_DIR}: realistic fixtures ${rw.skipped.join(', ')} unavailable (their tests are skipped)`);
  }

  if (EXTERNAL_SERVER) {
    log(`using the running server at ${BASE_URL}`);
    await waitForHealth(BASE_URL, null, 30_000);
    return async () => undefined;
  }

  await resetDatabase(DATABASE_URL);
  log(`database ${new URL(DATABASE_URL).pathname.slice(1)} re-created`);
  buildWeb();

  rotateServerLog(process.env.E2E_RUN_ID!);
  const storageDir = mkdtempSync(join(tmpdir(), 'sp-e2e-storage-'));
  // Workers inherit this: specs that run the server's CLIs against the main server (retention) need its storage.
  process.env.E2E_STORAGE_DIR = storageDir;
  log(`starting the server on ${BASE_URL} (log: e2e/.artifacts/server.log)`);
  const server = await startServer({ port: PORT, databaseUrl: DATABASE_URL, storageDir, logFile: join(ARTIFACTS_DIR, 'server.log') });
  log(`ready after ${((Date.now() - t0) / 1000).toFixed(0)} s`);

  return async () => {
    await server.stop();
    rmSync(storageDir, { recursive: true, force: true });
  };
}

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FullConfig } from '@playwright/test';
import { ARTIFACTS_DIR, BASE_URL, DATABASE_URL, EXTERNAL_SERVER, FACES_DIR, PORT, REPO_DIR } from './lib/config';
import { ensureFixtures } from './lib/fixtures';
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

export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const t0 = Date.now();
  const fx = await ensureFixtures(log);
  if (fx.built.length) log(`fixtures built: ${fx.built.join(', ')}`);
  if (fx.skipped.length) log(`face images missing in ${FACES_DIR}: camera fixtures ${fx.skipped.join(', ')} unavailable (their tests are skipped)`);

  if (EXTERNAL_SERVER) {
    log(`using the running server at ${BASE_URL}`);
    await waitForHealth(BASE_URL, null, 30_000);
    return async () => undefined;
  }

  await resetDatabase(DATABASE_URL);
  log(`database ${new URL(DATABASE_URL).pathname.slice(1)} re-created`);
  buildWeb();

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

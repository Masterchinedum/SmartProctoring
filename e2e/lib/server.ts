import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { ADMIN_EMAIL, ADMIN_PASSWORD, ARTIFACTS_DIR, EVIDENCE_KEY, REPO_DIR, SESSION_SECRET } from './config';

/**
 * Server processes for the suite: the main server (global setup) and dedicated instances that specs start
 * themselves when they need a different environment (integrations: SMTP + webhook receiver; key rotation:
 * restarts with other EVIDENCE_KEYs). Each dedicated instance has its own port, database and storage
 * directory, so the main server (and every other spec) is unaffected.
 */

type PgClient = { connect(): Promise<void>; query<R = Record<string, unknown>>(q: string, params?: unknown[]): Promise<{ rows: R[] }>; end(): Promise<void> };
type PgModule = { Client: new (o: { connectionString: string }) => PgClient };

/** The server's own `pg` dependency (no extra dependency for the suite). */
function pg(): PgModule {
  const require = createRequire(join(REPO_DIR, 'apps/server/package.json'));
  return require('pg') as PgModule;
}

/** Run one SQL statement against a (test) database. */
export async function sql<R = Record<string, unknown>>(databaseUrl: string, text: string, params: unknown[] = []): Promise<R[]> {
  const client = new (pg().Client)({ connectionString: databaseUrl });
  await client.connect();
  try {
    return (await client.query<R>(text, params)).rows;
  } finally {
    await client.end();
  }
}

/** Drop and re-create a throwaway database (refuses names without "e2e"). */
export async function resetDatabase(databaseUrl: string): Promise<void> {
  const url = new URL(databaseUrl);
  const dbName = url.pathname.replace(/^\//, '');
  if (!/^[a-z0-9_]+$/i.test(dbName) || !/e2e/i.test(dbName)) throw new Error(`Refusing to reset database "${dbName}": the name must contain "e2e".`);
  const admin = new URL(databaseUrl);
  admin.pathname = '/postgres';
  const client = new (pg().Client)({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await client.end();
  }
}

/** Same server, another database on the same Postgres (e.g. proctor_e2e -> proctor_e2e_rekey). */
export function siblingDatabaseUrl(databaseUrl: string, suffix: string): string {
  const u = new URL(databaseUrl);
  u.pathname = `${u.pathname.replace(/\/+$/, '')}_${suffix}`;
  return u.toString();
}

export interface ServerOptions {
  port: number;
  /** Host name in PUBLIC_URL (default localhost). Dedicated instances use 127.0.0.1 so their cookies never mix with the main server's. */
  publicHost?: string;
  databaseUrl: string;
  storageDir: string;
  evidenceKey?: string;
  /** Extra / overriding environment (e.g. EVIDENCE_KEYS_OLD, SMTP_*). */
  env?: NodeJS.ProcessEnv;
}

/** The server environment (production code paths, test-only secrets). Also the environment for the server's CLIs. */
export function serverEnv(o: ServerOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'production', // production code paths; the secrets below are test-only
    COOKIE_SECURE: 'false', // plain http://localhost
    PORT: String(o.port),
    HOST: '127.0.0.1',
    PUBLIC_URL: `http://${o.publicHost ?? 'localhost'}:${o.port}`,
    DATABASE_URL: o.databaseUrl,
    EVIDENCE_KEY: o.evidenceKey ?? EVIDENCE_KEY,
    SESSION_SECRET,
    STORAGE_DRIVER: 'fs',
    STORAGE_DIR: o.storageDir,
    WEB_DIST_DIR: join(REPO_DIR, 'apps/web/dist'),
    BOOTSTRAP_ADMIN_EMAIL: ADMIN_EMAIL,
    BOOTSTRAP_ADMIN_PASSWORD: ADMIN_PASSWORD,
    BOOTSTRAP_ORG_NAME: 'E2E University',
    SWEEPER_ENABLED: 'true',
    SWEEPER_INTERVAL_MS: '2000',
    LOG_LEVEL: process.env.E2E_SERVER_LOG_LEVEL || 'info',
    REDIS_URL: '',
    SMTP_HOST: '',
    ...o.env,
  };
}

export async function waitForHealth(url: string, proc: ChildProcess | null, timeoutMs: number, logHint = 'the server log'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    if (proc && proc.exitCode != null) throw new Error(`server exited with code ${proc.exitCode} (see ${logHint})`);
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not become healthy at ${url} within ${timeoutMs / 1000} s (${last})`);
}

export interface ServerHandle {
  url: string;
  env: NodeJS.ProcessEnv;
  proc: ChildProcess;
  logFile: string;
  stop(): Promise<void>;
}

/** Start the server from source (tsx src/main.ts, like `pnpm --filter @sp/server exec tsx src/main.ts`) in its own process group. */
export async function startServer(o: ServerOptions & { logFile: string; appendLog?: boolean; healthTimeoutMs?: number }): Promise<ServerHandle> {
  mkdirSync(dirname(o.logFile), { recursive: true });
  const env = serverEnv(o);
  const out = createWriteStream(o.logFile, { flags: o.appendLog ? 'a' : 'w' });
  const proc = spawn(join(REPO_DIR, 'apps/server/node_modules/.bin/tsx'), ['src/main.ts'], {
    cwd: join(REPO_DIR, 'apps/server'),
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout!.pipe(out, { end: false });
  proc.stderr!.pipe(out, { end: false });
  const url = env.PUBLIC_URL!;
  const stop = async () => {
    if (proc.exitCode == null && proc.signalCode == null && proc.pid) {
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      const deadline = Date.now() + 15_000;
      while (proc.exitCode == null && proc.signalCode == null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
      if (proc.exitCode == null && proc.signalCode == null) {
        try {
          process.kill(-proc.pid, 'SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }
    out.end();
  };
  try {
    await waitForHealth(url, proc, o.healthTimeoutMs ?? 120_000, o.logFile.replace(`${REPO_DIR}/`, ''));
  } catch (err) {
    await stop();
    throw err;
  }
  return { url, env, proc, logFile: o.logFile, stop };
}

export function artifactLog(name: string): string {
  return join(ARTIFACTS_DIR, name);
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run one of the server's operator CLIs exactly as documented (`pnpm --filter @sp/server <script> [args]`,
 * docs/OPERATIONS.md) with the given server environment.
 */
export function runServerCli(script: 'retention:run' | 'rekey', args: string[], env: NodeJS.ProcessEnv, timeoutMs = 120_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const p = spawn('pnpm', ['--filter', '@sp/server', script, ...args], { cwd: REPO_DIR, env: { ...env, LOG_LEVEL: 'warn' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error(`${script} ${args.join(' ')} timed out\n${stdout}\n${stderr}`));
    }, timeoutMs);
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** The JSON document a CLI printed with --json (pnpm prints its own lines before, and after a non-zero exit). */
export function cliJson<T>(r: CliResult): T {
  const lines = r.stdout.split('\n');
  const start = lines.findIndex((l) => l === '{');
  const end = start >= 0 ? lines.findIndex((l, i) => i > start && l === '}') : -1;
  if (start < 0 || end < 0) throw new Error(`no JSON in CLI output (exit ${r.code}):\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(lines.slice(start, end + 1).join('\n')) as T;
}

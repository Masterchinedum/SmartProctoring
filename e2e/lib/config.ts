import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Suite configuration (environment variables, all optional):
 *
 *   E2E_FACES_DIR        folder with the source face images (default /tmp/claude-0/faces). Camera tests are
 *                        skipped when it (or a needed image) is missing. Images are NEVER copied into the repo;
 *                        derived crops and Y4M videos go to e2e/.fixtures (gitignored).
 *   E2E_PORT             port for the server started by global setup (default 8098)
 *   E2E_BASE_URL         use an already running server instead of starting one (no DB reset, no build)
 *   E2E_DATABASE_URL     Postgres URL of the throwaway database (default postgres://postgres@127.0.0.1:5432/proctor_e2e);
 *                        it is DROPPED and re-created at the start of every run
 *   E2E_SKIP_BUILD=1     reuse apps/web/dist if it exists
 *   E2E_WORKERS          parallel workers (default 2; every camera test runs its own Chromium)
 *   E2E_HEADED=1         show the candidate browsers
 *   E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD   owner created via BOOTSTRAP_ADMIN_* (and used by the tests)
 */

const here = dirname(fileURLToPath(import.meta.url));
export const E2E_DIR = resolve(here, '..');
export const REPO_DIR = resolve(E2E_DIR, '..');
export const FIXTURES_DIR = join(E2E_DIR, '.fixtures');
export const ARTIFACTS_DIR = join(E2E_DIR, '.artifacts');

const env = process.env;

export const FACES_DIR = env.E2E_FACES_DIR || '/tmp/claude-0/faces';
export const PORT = Number(env.E2E_PORT || 8098);
export const EXTERNAL_SERVER = !!env.E2E_BASE_URL;
export const BASE_URL = (env.E2E_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
export const DATABASE_URL = env.E2E_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/proctor_e2e';
export const ADMIN_EMAIL = env.E2E_ADMIN_EMAIL || 'owner@example.com';
export const ADMIN_PASSWORD = env.E2E_ADMIN_PASSWORD || 'e2e-owner-password-1';
/** Fixed test secrets (never used outside this throwaway environment). */
export const EVIDENCE_KEY = Buffer.alloc(32, 7).toString('base64');
export const SESSION_SECRET = 'e2e-session-secret-0123456789abcdefghijklmnopqrstuvwxyz';
export const HEADED = env.E2E_HEADED === '1';
export const WORKERS = Number(env.E2E_WORKERS || 2);

export function faceImage(name: string): string {
  return join(FACES_DIR, name);
}

export function facesAvailable(...names: string[]): boolean {
  return existsSync(FACES_DIR) && names.every((n) => existsSync(faceImage(n)));
}

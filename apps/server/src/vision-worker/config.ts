import { availableParallelism } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { MIN_VISION_WORKER_TOKEN_LENGTH, serverRoot } from '../config.js';

/**
 * Configuration of the dedicated vision worker (src/vision-worker/main.ts) from its environment. It needs no
 * database, evidence key or session secret: only the shared token, where to listen and the models.
 *
 *   VISION_WORKER_TOKEN        shared secret the server sends (≥ 24 characters; the same value as on the server). While
 *                              rotating it, `new,old`: both are accepted until every server sends the new one.
 *   VISION_WORKER_PORT         port (default 8090)
 *   VISION_WORKER_HOST         interface (default 0.0.0.0: in a container; never publish it, docs/SECURITY.md)
 *   VISION_THREADS             CPU threads for face analysis (default: the CPU count, max 8 — a worker host has no
 *                              event loop or database to leave a core for); VISION_THREADS_PER_WORKER, VISION_WORKERS,
 *                              VISION_NICE as on the server (docs/PERFORMANCE.md §6)
 *   MODELS_DIR, LOG_LEVEL      as on the server
 */
export interface VisionWorkerConfig {
  /** Accepted tokens (one, or two while rotating). */
  tokens: string[];
  port: number;
  host: string;
  modelsDir: string;
  /** Total CPU threads for analysis (null = the vision service's own default from VISION_THREADS / VISION_WORKERS). */
  threads: number | null;
  logLevel: string;
}

export const DEFAULT_VISION_WORKER_PORT = 8090;

export function loadVisionWorkerConfig(env: NodeJS.ProcessEnv = process.env, cpus = availableParallelism()): VisionWorkerConfig {
  const tokens = (env.VISION_WORKER_TOKEN ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length || tokens.some((t) => t.length < MIN_VISION_WORKER_TOKEN_LENGTH)) {
    throw new Error(`VISION_WORKER_TOKEN must be set to at least ${MIN_VISION_WORKER_TOKEN_LENGTH} characters (e.g. openssl rand -hex 32), the same value as on the server (while rotating: new,old).`);
  }
  const port = env.VISION_WORKER_PORT ? Number.parseInt(env.VISION_WORKER_PORT, 10) : DEFAULT_VISION_WORKER_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid VISION_WORKER_PORT: ${env.VISION_WORKER_PORT}`);
  const models = env.MODELS_DIR || 'models';
  const explicitThreads = env.VISION_THREADS || env.VISION_WORKERS;
  return {
    tokens,
    port,
    host: env.VISION_WORKER_HOST || '0.0.0.0',
    modelsDir: isAbsolute(models) ? models : resolve(serverRoot(), models),
    threads: explicitThreads ? null : Math.min(8, Math.max(1, cpus)),
    logLevel: env.LOG_LEVEL || 'info',
  };
}

import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { resolveCandidateSession } from '../auth/candidate.js';
import type { Ctx } from '../context.js';
import { currentCapacity } from '../services/capacity.js';
import { noticeFor } from '../services/privacy.js';

const startedAt = Date.now();

/** A database that does not answer within this is reported down (a stuck pool must not hang the probe). */
export const HEALTH_DB_TIMEOUT_MS = 2_000;

async function dbStatus(ctx: Ctx): Promise<'ok' | 'error' | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), HEALTH_DB_TIMEOUT_MS);
  });
  try {
    return await Promise.race([ctx.db.execute(sql`select 1`).then(() => 'ok' as const), timeout]);
  } catch {
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * /api/health* and /api/public/* (no staff auth).
 *
 *   GET /health/live      the process answers (no I/O)                                   -> liveness probe
 *   GET /health/ready     the database answers and face analysis has a worker (200/503)  -> load balancer / readiness
 *                         (remote vision driver: at least one vision worker process ready; `visionWorkers`)
 *   GET /health           same as /health/ready (kept for existing probes, e.g. the Dockerfile HEALTHCHECK)
 *   GET /health/capacity  whether this instance should take more exam starts (always 200; `accepting`)
 *                         — for operators, autoscalers and admission, never for load-balancer routing
 *                         (services/capacity.ts)
 */
export const publicRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const uptimeSec = () => Math.round((Date.now() - startedAt) / 1000);

  app.get('/health/live', async () => ({ ok: true, uptimeSec: uptimeSec() }));

  const ready = async (_req: unknown, reply: FastifyReply) => {
    const db = await dbStatus(ctx);
    const load = ctx.vision.load;
    const vision = !load || load.workers > 0 ? 'ok' : 'unavailable';
    const ok = db === 'ok' && vision === 'ok';
    // Remote vision driver: how many vision worker processes are in use (ready = at least one).
    const states = (ctx.vision as { workerStates?: () => Record<string, number> }).workerStates?.();
    const visionWorkers = states ? { ready: states.up, configured: Object.values(states).reduce((a, b) => a + b, 0) } : undefined;
    return reply.status(ok ? 200 : 503).send({ ok, db, vision, ...(visionWorkers ? { visionWorkers } : {}), uptimeSec: uptimeSec(), serverTime: ctx.now() });
  };
  app.get('/health', ready);
  app.get('/health/ready', ready);

  app.get('/health/capacity', async () => {
    const { accepting, reasons } = currentCapacity(ctx);
    return { accepting, reasons };
  });

  /** Privacy notice for a candidate link: ?token=<accessToken> or Authorization: Bearer <accessToken>. */
  app.get('/public/privacy-notice', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const token = (req.query as { token?: string }).token;
    const loaded = await resolveCandidateSession(ctx, req, token);
    return noticeFor(loaded.org, loaded.policy, loaded.candidate);
  });
};

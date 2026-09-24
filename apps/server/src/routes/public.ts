import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { resolveCandidateSession } from '../auth/candidate.js';
import { noticeFor } from '../services/privacy.js';

const startedAt = Date.now();

/** /api/health and /api/public/* (no staff auth). */
export const publicRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;

  app.get('/health', async (_req, reply) => {
    let db = 'ok';
    try {
      await ctx.db.execute(sql`select 1`);
    } catch {
      db = 'error';
    }
    const ok = db === 'ok';
    return reply.status(ok ? 200 : 503).send({ ok, db, vision: 'ok', uptimeSec: Math.round((Date.now() - startedAt) / 1000), serverTime: ctx.now() });
  });

  /** Privacy notice for a candidate link: ?token=<accessToken> or Authorization: Bearer <accessToken>. */
  app.get('/public/privacy-notice', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const token = (req.query as { token?: string }).token;
    const loaded = await resolveCandidateSession(ctx, req, token);
    return noticeFor(loaded.org, loaded.policy, loaded.candidate);
  });
};

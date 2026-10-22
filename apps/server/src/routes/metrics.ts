import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { sha256Hex } from '../lib/crypto.js';

/**
 * GET /metrics — Prometheus exposition (lib/metrics.ts), for a scraper holding METRICS_TOKEN
 * (`Authorization: Bearer <token>`). Not served at all (404) while METRICS_TOKEN is unset.
 */
export const metricsRoute: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const token = ctx.config.metricsToken;
  if (!token) return;
  const expected = sha256Hex(token);
  ctx.metrics.enableProcessMetrics();
  app.get('/metrics', async (req, reply) => {
    const h = req.headers.authorization;
    const given = h?.startsWith('Bearer ') ? h.slice(7) : '';
    if (!timingSafeEqual(Buffer.from(sha256Hex(given), 'hex'), Buffer.from(expected, 'hex'))) {
      return reply.status(401).header('WWW-Authenticate', 'Bearer').send({ error: 'unauthorized', message: 'A valid metrics token is required.' });
    }
    return reply.header('Content-Type', ctx.metrics.registry.contentType).header('Cache-Control', 'no-store').send(await ctx.metrics.registry.metrics());
  });
};

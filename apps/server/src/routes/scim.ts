/**
 * SCIM 2.0 staff provisioning, prefix /scim/v2 (services/scim.ts; docs/OPERATIONS.md has the set-up runbooks).
 *
 * Auth: `Authorization: Bearer sp_scim_…` (the organisation's SCIM token, auth/scim-token.ts); no cookies. Rate limit:
 * SCIM_RATE_LIMIT_PER_MINUTE per token (default 600). Bodies: application/scim+json or application/json. Errors use
 * the SCIM error schema.
 *
 *   GET    /ServiceProviderConfig | /ResourceTypes | /ResourceTypes/User | /Schemas | /Schemas/<User schema>
 *   GET    /Users?filter=userName eq "…"&startIndex=&count=   -> ListResponse
 *   POST   /Users                                             -> 201 User   (409 uniqueness)
 *   GET    /Users/:id                                         -> User
 *   PUT    /Users/:id                                         -> User       (replace)
 *   PATCH  /Users/:id  PatchOp                                -> User       (active=false disables and signs out)
 *   DELETE /Users/:id                                         -> 204        (disable + hide from SCIM)
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { authenticateScimToken, bearerScimToken, type ScimPrincipal } from '../auth/scim-token.js';
import { sha256Hex } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';
import { bindRequestLog } from '../lib/request-log.js';
import {
  createScimUser,
  deleteScimUser,
  getScimUser,
  listScimUsers,
  parseScimPatch,
  parseScimUser,
  resourceTypes,
  SCIM_LIST_SCHEMA,
  SCIM_MAX_RESULTS,
  SCIM_USER_SCHEMA,
  ScimError,
  serviceProviderConfig,
  toScimUser,
  updateScimUser,
  userSchema,
} from '../services/scim.js';

const SCIM_CONTENT_TYPE = 'application/scim+json; charset=utf-8';

export const scimRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const baseUrl = `${ctx.config.publicUrl}/scim/v2`;
  app.decorateRequest('scim', null);

  app.addContentTypeParser(['application/scim+json'], { parseAs: 'string' }, app.getDefaultJsonParser('error', 'ignore'));

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    if (String(reply.getHeader('content-type') ?? '').startsWith('application/json')) reply.header('Content-Type', SCIM_CONTENT_TYPE);
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ScimError) return reply.status(err.status).send(err.toBody());
    if (err instanceof HttpError) return reply.status(err.statusCode).send(new ScimError(err.statusCode, err.message).toBody());
    if (err instanceof ZodError) return reply.status(400).send(new ScimError(400, 'Request validation failed', 'invalidValue').toBody());
    const e = err as { statusCode?: number; message: string; code?: string };
    if (e.statusCode === 429) return reply.status(429).send(new ScimError(429, 'Too many requests', 'tooMany').toBody());
    if (e.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || e.statusCode === 415) return reply.status(415).send(new ScimError(415, 'Send application/scim+json').toBody());
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) return reply.status(e.statusCode).send(new ScimError(e.statusCode, e.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ? 'A request body is required' : 'Invalid request', 'invalidSyntax').toBody());
    req.log.error({ err }, 'unhandled SCIM error');
    return reply.status(500).send(new ScimError(500, 'An unexpected error occurred').toBody());
  });

  const rateLimit = {
    max: ctx.config.scim.rateLimitPerMinute,
    timeWindow: '1 minute',
    keyGenerator: (req: FastifyRequest) => {
      const t = bearerScimToken(req);
      return t ? `scim:${sha256Hex(t).slice(0, 32)}` : `scim-ip:${req.ip}`;
    },
  };

  const requireScim = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearerScimToken(req);
    const principal = token ? await authenticateScimToken(ctx, token, req.ip) : null;
    if (!principal) {
      reply.header('WWW-Authenticate', 'Bearer realm="SmartProctoring SCIM"');
      throw new ScimError(401, 'Missing, invalid or revoked SCIM token');
    }
    req.scim = principal;
    bindRequestLog(req, reply, { orgId: principal.orgId });
  };
  const auth = { preHandler: requireScim, config: { rateLimit } };
  const principal = (req: FastifyRequest): ScimPrincipal => {
    if (!req.scim) throw new ScimError(401, 'Missing, invalid or revoked SCIM token');
    return req.scim;
  };
  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;

  /* ---------------------------------------------------------------- discovery */

  app.get('/ServiceProviderConfig', auth, async () => serviceProviderConfig(baseUrl, `${ctx.config.publicUrl}/admin/settings`));
  app.get('/ResourceTypes', auth, async () => ({ schemas: [SCIM_LIST_SCHEMA], totalResults: 1, startIndex: 1, itemsPerPage: 1, Resources: resourceTypes(baseUrl) }));
  app.get('/ResourceTypes/User', auth, async () => resourceTypes(baseUrl)[0]);
  app.get('/Schemas', auth, async () => ({ schemas: [SCIM_LIST_SCHEMA], totalResults: 1, startIndex: 1, itemsPerPage: 1, Resources: [userSchema(baseUrl)] }));
  app.get(`/Schemas/${SCIM_USER_SCHEMA}`, auth, async () => userSchema(baseUrl));

  /* ---------------------------------------------------------------- users */

  app.get('/Users', auth, async (req) => {
    const p = principal(req);
    const q = req.query as Record<string, string | undefined>;
    const startIndex = Math.max(1, Number.parseInt(q.startIndex ?? '1', 10) || 1);
    const count = Math.min(SCIM_MAX_RESULTS, Math.max(0, Number.parseInt(q.count ?? '100', 10) || (q.count === '0' ? 0 : 100)));
    const { total, users } = await listScimUsers(ctx.db, p.orgId, { filter: q.filter, startIndex, count });
    return { schemas: [SCIM_LIST_SCHEMA], totalResults: total, startIndex, itemsPerPage: users.length, Resources: users.map((u) => toScimUser(baseUrl, u)) };
  });

  app.post('/Users', auth, async (req, reply) => {
    const user = await createScimUser(ctx, principal(req), req.body);
    reply.status(201).header('Location', `${baseUrl}/Users/${user.id}`);
    return toScimUser(baseUrl, user);
  });

  app.get('/Users/:id', auth, async (req) => toScimUser(baseUrl, await getScimUser(ctx.db, principal(req).orgId, idOf(req))));

  app.put('/Users/:id', auth, async (req) => toScimUser(baseUrl, await updateScimUser(ctx, principal(req), idOf(req), parseScimUser(req.body))));

  app.patch('/Users/:id', auth, async (req) => toScimUser(baseUrl, await updateScimUser(ctx, principal(req), idOf(req), parseScimPatch(req.body))));

  app.delete('/Users/:id', auth, async (req, reply) => {
    await deleteScimUser(ctx, principal(req), idOf(req));
    return reply.status(204).send();
  });

  app.setNotFoundHandler((_req, reply) => reply.status(404).send(new ScimError(404, 'Unknown SCIM endpoint (Groups are not supported)').toBody()));
};

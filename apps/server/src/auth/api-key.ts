/**
 * Organisation API keys for the integration API (/api/v1/*).
 *
 *   Authorization: Bearer sp_live_<43 chars base64url>
 *
 * Keys are random (256 bit), shown once at creation, and stored only as sha256 (plus an 16-character display
 * prefix). A key belongs to one organisation, works only on the integration API (`scope` 'integration'), and carries
 * `scopes` (API_KEY_SCOPES): every /api/v1 endpoint requires one (INTEGRATION_ENDPOINTS), else 403 insufficient_scope.
 * Revoked keys stop working immediately (401 invalid_api_key); keys past their `expiresAt` are refused with
 * 401 api_key_expired. `lastUsedAt` is written at most once a minute per key.
 *
 * Usage in a route plugin (routes/v1 registers every route through the endpoint catalogue instead):
 *   app.get('/x', { preHandler: [requireApiKey, requireScope('exams:read')] }, async (req) => { const key = getApiKey(req); ... key.orgId ... })
 */
import { API_KEY_PATTERN, API_KEY_PREFIX, normaliseApiKeyScopes, type ApiKeyDTO, type ApiKeyScope } from '@sp/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import { apiKeys, type ApiKey } from '../db/schema.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';
import { bindRequestLog } from '../lib/request-log.js';

export const API_KEY_DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 8;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const REALM = 'SmartProctoring integration API';

export interface ApiKeyPrincipal {
  id: string;
  orgId: string;
  name: string;
  scopes: ApiKeyScope[];
  expiresAt: number | null;
  ip: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKey: ApiKeyPrincipal | null;
  }
}

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const key = `${API_KEY_PREFIX}${randomToken(32)}`;
  return { key, prefix: key.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH), hash: sha256Hex(key) };
}

export function toApiKeyDTO(row: ApiKey, creatorName: string | null): ApiKeyDTO {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scope: row.scope,
    scopes: normaliseApiKeyScopes(row.scopes),
    createdAt: row.createdAt.getTime(),
    createdBy: row.createdBy ? { id: row.createdBy, name: creatorName ?? 'Unknown' } : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.getTime() : null,
    expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
    revokedAt: row.revokedAt ? row.revokedAt.getTime() : null,
  };
}

/** The bearer token of a request if it looks like an API key (no database access). */
export function bearerApiKey(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  if (!m || !API_KEY_PATTERN.test(m[1])) return null;
  return m[1];
}

export type ApiKeyAuthResult = { ok: true; principal: ApiKeyPrincipal } | { ok: false; reason: 'invalid' } | { ok: false; reason: 'expired'; expiresAt: number };

/** Resolve an API key: unknown or revoked → invalid; past its expiry → expired (lastUsedAt is not touched then). */
export async function authenticateApiKey(ctx: Pick<Ctx, 'db' | 'now'>, key: string, ip: string): Promise<ApiKeyAuthResult> {
  const [row] = await ctx.db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, sha256Hex(key)), isNull(apiKeys.revokedAt)));
  if (!row) return { ok: false, reason: 'invalid' };
  const now = ctx.now();
  if (row.expiresAt && row.expiresAt.getTime() <= now) return { ok: false, reason: 'expired', expiresAt: row.expiresAt.getTime() };
  if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS) {
    await ctx.db.update(apiKeys).set({ lastUsedAt: new Date(now) }).where(eq(apiKeys.id, row.id));
  }
  return { ok: true, principal: { id: row.id, orgId: row.orgId, name: row.name, scopes: normaliseApiKeyScopes(row.scopes), expiresAt: row.expiresAt?.getTime() ?? null, ip } };
}

function invalidKey(reply: FastifyReply): HttpError {
  reply.header('WWW-Authenticate', `Bearer realm="${REALM}"`);
  return new HttpError(401, 'invalid_api_key', 'Missing, invalid or revoked API key. Send "Authorization: Bearer sp_live_...".');
}

function expiredKey(reply: FastifyReply, expiresAt: number): HttpError {
  reply.header('WWW-Authenticate', `Bearer realm="${REALM}", error="invalid_token", error_description="The API key has expired"`);
  return new HttpError(401, 'api_key_expired', `This API key expired on ${new Date(expiresAt).toISOString()}. Ask an administrator for a new key (Integrations → API keys).`);
}

/** preHandler: require a valid, unexpired organisation API key. */
export async function requireApiKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const key = bearerApiKey(req);
  if (!key) throw invalidKey(reply);
  const r = await authenticateApiKey(req.server.ctx, key, req.ip);
  if (!r.ok) throw r.reason === 'expired' ? expiredKey(reply, r.expiresAt) : invalidKey(reply);
  req.apiKey = r.principal;
  bindRequestLog(req, reply, { apiKeyId: r.principal.id, orgId: r.principal.orgId });
}

/** preHandler (after requireApiKey): the key must carry `scope` (403 insufficient_scope otherwise). */
export function requireScope(scope: ApiKeyScope) {
  return async function requireApiKeyScope(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const key = getApiKey(req);
    if (key.scopes.includes(scope)) return;
    reply.header('WWW-Authenticate', `Bearer realm="${REALM}", error="insufficient_scope", scope="${scope}"`);
    throw new HttpError(403, 'insufficient_scope', `This API key does not have the "${scope}" scope. An administrator can create a key with it (Integrations → API keys).`, {
      requiredScope: scope,
      scopes: key.scopes,
    });
  };
}

/** The API key principal inside a handler guarded by requireApiKey. */
export function getApiKey(req: FastifyRequest): ApiKeyPrincipal {
  if (!req.apiKey) throw new HttpError(401, 'invalid_api_key', 'Missing, invalid or revoked API key.');
  return req.apiKey;
}

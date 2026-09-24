/**
 * Organisation API keys for the integration API (/api/v1/*).
 *
 *   Authorization: Bearer sp_live_<43 chars base64url>
 *
 * Keys are random (256 bit), shown once at creation, and stored only as sha256 (plus an 16-character display
 * prefix). A key belongs to one organisation and has the fixed scope 'integration'. Revoked keys stop
 * working immediately. `lastUsedAt` is written at most once a minute per key.
 *
 * Usage in a route plugin:
 *   app.get('/x', { preHandler: requireApiKey }, async (req) => { const key = getApiKey(req); ... key.orgId ... })
 */
import { API_KEY_PATTERN, API_KEY_PREFIX, type ApiKeyDTO } from '@sp/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import { apiKeys, type ApiKey } from '../db/schema.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';

export const API_KEY_DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 8;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

export interface ApiKeyPrincipal {
  id: string;
  orgId: string;
  name: string;
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
    createdAt: row.createdAt.getTime(),
    createdBy: row.createdBy ? { id: row.createdBy, name: creatorName ?? 'Unknown' } : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.getTime() : null,
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

/** Resolve an API key (null if unknown or revoked). */
export async function authenticateApiKey(ctx: Pick<Ctx, 'db' | 'now'>, key: string, ip: string): Promise<ApiKeyPrincipal | null> {
  const [row] = await ctx.db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, sha256Hex(key)), isNull(apiKeys.revokedAt)));
  if (!row) return null;
  const now = ctx.now();
  if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS) {
    await ctx.db.update(apiKeys).set({ lastUsedAt: new Date(now) }).where(eq(apiKeys.id, row.id));
  }
  return { id: row.id, orgId: row.orgId, name: row.name, ip };
}

function invalidKey(reply: FastifyReply): HttpError {
  reply.header('WWW-Authenticate', 'Bearer realm="SmartProctoring integration API"');
  return new HttpError(401, 'invalid_api_key', 'Missing, invalid or revoked API key. Send "Authorization: Bearer sp_live_...".');
}

/** preHandler: require a valid organisation API key. */
export async function requireApiKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const key = bearerApiKey(req);
  if (!key) throw invalidKey(reply);
  const principal = await authenticateApiKey(req.server.ctx, key, req.ip);
  if (!principal) throw invalidKey(reply);
  req.apiKey = principal;
}

/** The API key principal inside a handler guarded by requireApiKey. */
export function getApiKey(req: FastifyRequest): ApiKeyPrincipal {
  if (!req.apiKey) throw new HttpError(401, 'invalid_api_key', 'Missing, invalid or revoked API key.');
  return req.apiKey;
}

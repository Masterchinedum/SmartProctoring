/**
 * SCIM bearer tokens (routes/scim.ts): `Authorization: Bearer sp_scim_<43 chars base64url>`.
 *
 * One active token per organisation, created / rotated / revoked by an owner (routes/admin/sso.ts), shown once and
 * stored as sha256 only (looked up by its hash, then compared in constant time). A revoked token stops working on the
 * next request. `lastUsedAt` is written at most once a minute.
 */
import { SCIM_TOKEN_PATTERN, SCIM_TOKEN_PREFIX } from '@sp/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import { scimTokens } from '../db/schema.js';
import { randomToken, safeEqual, sha256Hex } from '../lib/crypto.js';

const LAST_USED_WRITE_INTERVAL_MS = 60_000;
export const SCIM_TOKEN_DISPLAY_PREFIX_LENGTH = SCIM_TOKEN_PREFIX.length + 6;

export interface ScimPrincipal {
  tokenId: string;
  orgId: string;
  ip: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    scim: ScimPrincipal | null;
  }
}

export function generateScimToken(): { token: string; prefix: string; hash: string } {
  const token = `${SCIM_TOKEN_PREFIX}${randomToken(32)}`;
  return { token, prefix: token.slice(0, SCIM_TOKEN_DISPLAY_PREFIX_LENGTH), hash: sha256Hex(token) };
}

/** The bearer token of a request if it looks like a SCIM token (no database access). */
export function bearerScimToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  if (!m || !SCIM_TOKEN_PATTERN.test(m[1])) return null;
  return m[1];
}

export async function authenticateScimToken(ctx: Pick<Ctx, 'db' | 'now'>, token: string, ip: string): Promise<ScimPrincipal | null> {
  const hash = sha256Hex(token);
  const [row] = await ctx.db
    .select()
    .from(scimTokens)
    .where(and(eq(scimTokens.tokenHash, hash), isNull(scimTokens.revokedAt)));
  if (!row || !safeEqual(row.tokenHash, hash)) return null;
  const now = ctx.now();
  if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS) {
    await ctx.db.update(scimTokens).set({ lastUsedAt: new Date(now) }).where(eq(scimTokens.id, row.id));
  }
  return { tokenId: row.id, orgId: row.orgId, ip };
}

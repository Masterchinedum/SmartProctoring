/**
 * Staff authentication: opaque random session token in a signed httpOnly cookie (`sp_session`);
 * only sha256(token) is stored. Sliding idle expiry plus an absolute lifetime.
 *
 * Usage in a route plugin:
 *   app.get('/x', { preHandler: requireStaff('reviewer') }, async (req) => { const staff = getStaff(req); ... })
 * Role order: reviewer < admin < owner (requireStaff('admin') admits admin and owner).
 */
import type { StaffRole } from '@sp/shared';
import { and, eq, gt } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Ctx } from '../context.js';
import { organizations, staffSessions, staffUsers, type StaffUser } from '../db/schema.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export const STAFF_COOKIE = 'sp_session';

export const ROLE_RANK: Record<StaffRole, number> = { reviewer: 1, admin: 2, owner: 3 };

export function roleAtLeast(role: StaffRole, min: StaffRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export interface StaffPrincipal {
  user: StaffUser;
  /** Convenience copies. */
  id: string;
  orgId: string;
  role: StaffRole;
  name: string;
  staffSessionId: string;
  ip: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    staff: StaffPrincipal | null;
  }
}

/** Resolve a staff principal from a raw (signed) cookie value. Used by HTTP routes and the WebSocket. */
export async function authenticateStaffToken(ctx: Ctx, rawCookie: string | undefined, unsign: (v: string) => { valid: boolean; value: string | null }, ip: string): Promise<StaffPrincipal | null> {
  if (!rawCookie) return null;
  const un = unsign(rawCookie);
  if (!un.valid || !un.value) return null;
  const tokenHash = sha256Hex(un.value);
  const now = ctx.now();
  const rows = await ctx.db
    .select({ sess: staffSessions, user: staffUsers })
    .from(staffSessions)
    .innerJoin(staffUsers, eq(staffUsers.id, staffSessions.staffUserId))
    .where(and(eq(staffSessions.tokenHash, tokenHash), gt(staffSessions.expiresAt, new Date(now))));
  const row = rows[0];
  if (!row || row.user.disabled) return null;
  // Sliding expiry, written at most once a minute.
  if (now - row.sess.lastSeenAt.getTime() > 60_000) {
    const expiresAt = Math.min(now + ctx.config.staffSessionIdleMs, row.sess.createdAt.getTime() + ctx.config.staffSessionMaxMs);
    await ctx.db.update(staffSessions).set({ lastSeenAt: new Date(now), expiresAt: new Date(expiresAt) }).where(eq(staffSessions.id, row.sess.id));
  }
  return { user: row.user, id: row.user.id, orgId: row.user.orgId, role: row.user.role, name: row.user.name, staffSessionId: row.sess.id, ip };
}

function allowedOrigins(ctx: Ctx, req: FastifyRequest): string[] {
  const out = [new URL(ctx.config.publicUrl).origin];
  const host = req.headers.host;
  if (host) out.push(`${req.protocol}://${host}`);
  return out;
}

/**
 * Does this cookie-authenticated request come from our own origin, as far as the browser tells? `Origin`
 * decides when present; without it (older browsers, privacy tools that strip it) Fetch Metadata
 * (`Sec-Fetch-Site`) and then `Referer` are consulted. A request carrying none of them comes from a
 * non-browser client, which a third-party site cannot drive with the staff member's cookie.
 */
export function isSameOriginRequest(ctx: Ctx, req: FastifyRequest): boolean {
  const allowed = allowedOrigins(ctx, req);
  const origin = req.headers.origin;
  if (origin) return allowed.includes(origin);
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== '' && site !== 'same-origin' && site !== 'none') return false;
  const referer = req.headers.referer;
  if (referer) {
    try {
      return allowed.includes(new URL(referer).origin);
    } catch {
      return false;
    }
  }
  return true;
}

/** preHandler for cookie routes without a role check (e.g. logout): refuse cross-site requests. */
export async function requireSameOrigin(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!isSameOriginRequest(req.server.ctx, req)) throw forbidden('Cross-origin request refused', 'bad_origin');
}

/** preHandler factory: require a logged-in staff user with at least `min` role. */
export function requireStaff(min: StaffRole = 'reviewer'): preHandlerAsyncHookHandler {
  return async function (this: unknown, req: FastifyRequest, _reply: FastifyReply) {
    const ctx = req.server.ctx;
    // CSRF / cross-site WebSocket defence in depth (cookie is SameSite=Lax): state-changing requests and
    // WebSocket upgrades must come from our own origin when the browser says where they come from.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.headers.upgrade?.toLowerCase() === 'websocket') {
      if (!isSameOriginRequest(ctx, req)) throw forbidden('Cross-origin request refused', 'bad_origin');
    }
    const principal = req.staff ?? (await authenticateStaffToken(ctx, req.cookies?.[STAFF_COOKIE], (v) => req.unsignCookie(v), req.ip));
    if (!principal) throw unauthorized();
    if (!roleAtLeast(principal.role, min)) throw forbidden(`This action requires the ${min} role`);
    req.staff = principal;
  };
}

/** Get the authenticated staff principal inside a handler guarded by requireStaff(). */
export function getStaff(req: FastifyRequest): StaffPrincipal {
  if (!req.staff) throw unauthorized();
  return req.staff;
}

/** Create a staff session and set the cookie. */
export async function startStaffSession(ctx: Ctx, reply: FastifyReply, user: StaffUser, req: FastifyRequest): Promise<void> {
  const token = randomToken(32);
  const now = ctx.now();
  await ctx.db.insert(staffSessions).values({
    tokenHash: sha256Hex(token),
    staffUserId: user.id,
    createdAt: new Date(now),
    lastSeenAt: new Date(now),
    expiresAt: new Date(now + ctx.config.staffSessionIdleMs),
    ip: req.ip,
    userAgent: (req.headers['user-agent'] ?? '').slice(0, 500),
  });
  reply.setCookie(STAFF_COOKIE, token, {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.cookieSecure,
    path: '/',
    maxAge: Math.floor(ctx.config.staffSessionMaxMs / 1000),
  });
}

export async function endStaffSession(ctx: Ctx, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = req.cookies?.[STAFF_COOKIE];
  if (raw) {
    const un = req.unsignCookie(raw);
    if (un.valid && un.value) await ctx.db.delete(staffSessions).where(eq(staffSessions.tokenHash, sha256Hex(un.value)));
  }
  reply.clearCookie(STAFF_COOKIE, { path: '/' });
}

/** Revoke all sessions of a user (password change, disable). */
export async function revokeStaffSessions(ctx: Pick<Ctx, 'db'>, userId: string, exceptSessionId?: string): Promise<void> {
  const rows = await ctx.db.select({ id: staffSessions.id }).from(staffSessions).where(eq(staffSessions.staffUserId, userId));
  for (const r of rows) if (r.id !== exceptSessionId) await ctx.db.delete(staffSessions).where(eq(staffSessions.id, r.id));
}

export async function loadOrgName(ctx: Pick<Ctx, 'db'>, orgId: string): Promise<string> {
  const [o] = await ctx.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
  return o?.name ?? '';
}

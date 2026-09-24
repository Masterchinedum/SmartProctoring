import { loginRequestSchema } from '@sp/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { endStaffSession, getStaff, loadOrgName, requireSameOrigin, requireStaff, revokeStaffSessions, startStaffSession } from '../auth/staff.js';
import { staffUsers } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { dummyPasswordHash, hashPassword, passwordNeedsRehash, verifyPassword } from '../lib/crypto.js';
import { badRequest, HttpError, unauthorized } from '../lib/errors.js';
import { toStaffUserDTO } from '../services/dto.js';
import { admitLoginAttempt, clearLoginFailures, purgeStaleLoginThrottles } from '../services/login-throttle.js';

/** "45 seconds" / "2 minutes" for the per-account backoff message. */
export function waitText(sec: number): string {
  if (sec < 90) return `${sec} second${sec === 1 ? '' : 's'}`;
  const min = Math.ceil(sec / 60);
  return `${min} minute${min === 1 ? '' : 's'}`;
}

const passwordChangeSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(10).max(200) });

/** /api/auth/* — staff login, logout, current user, password change. */
export const authRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const loginLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  // Per-account backoff table housekeeping (the per-IP limit above is separate).
  ctx.jobs.register({ name: 'login-throttle-cleanup', intervalMs: 3_600_000, runAtStart: false, run: (c) => purgeStaleLoginThrottles(c.db, c.now()) });

  app.post('/login', { config: loginLimit }, async (req, reply) => {
    const body = loginRequestSchema.parse(req.body);
    const email = body.email.trim().toLowerCase();
    const findUser = async () => (await ctx.db.select().from(staffUsers).where(eq(sql`lower(${staffUsers.email})`, email)))[0];
    // Per-account backoff (independent of the client IP), keyed on the address TRIED, so registered and unknown
    // addresses behave the same. Charged before the password check; cleared by a successful login.
    const admission = await admitLoginAttempt(ctx.db, email, ctx.now());
    if (!admission.admitted) {
      const sec = Math.ceil(admission.retryAfterMs / 1000);
      const user = await findUser();
      await audit(ctx.db, {
        orgId: user?.orgId ?? null,
        actorType: 'staff',
        actorId: user?.id ?? null,
        action: 'auth.login_failed',
        targetType: 'staff_user',
        targetId: user?.id ?? null,
        meta: { email, reason: 'throttled', retryAfterSec: sec },
        ip: req.ip,
        at: ctx.now(),
      });
      reply.header('Retry-After', String(sec));
      throw new HttpError(429, 'too_many_attempts', `Too many failed sign-in attempts for this account. Try again in ${waitText(sec)}.`, { retryAfterSec: sec });
    }
    const user = await findUser();
    const ok = user ? await verifyPassword(body.password, user.passwordHash) : (await verifyPassword(body.password, await dummyPasswordHash()), false);
    if (!user || !ok || user.disabled) {
      // Never the password itself; the attempted address, the reason and the backoff state.
      await audit(ctx.db, {
        orgId: user?.orgId ?? null,
        actorType: 'staff',
        actorId: user?.id ?? null,
        action: 'auth.login_failed',
        targetType: 'staff_user',
        targetId: user?.id ?? null,
        meta: { email, reason: !user ? 'unknown_user' : user.disabled ? 'disabled' : 'bad_password', failures: admission.failures, ...(admission.lockedUntil ? { lockedUntil: admission.lockedUntil } : {}) },
        ip: req.ip,
        at: ctx.now(),
      });
      throw unauthorized('Invalid email or password');
    }
    await clearLoginFailures(ctx.db, email);
    // Hashes made with older (weaker) scrypt parameters are upgraded transparently while we have the password.
    if (passwordNeedsRehash(user.passwordHash)) {
      const upgraded = await hashPassword(body.password);
      await ctx.db
        .update(staffUsers)
        .set({ passwordHash: upgraded })
        .where(and(eq(staffUsers.id, user.id), eq(staffUsers.passwordHash, user.passwordHash)));
    }
    await startStaffSession(ctx, reply, user, req);
    await ctx.db.update(staffUsers).set({ lastLoginAt: new Date(ctx.now()) }).where(eq(staffUsers.id, user.id));
    await audit(ctx.db, { orgId: user.orgId, actorType: 'staff', actorId: user.id, action: 'auth.login', targetType: 'staff_user', targetId: user.id, ip: req.ip, at: ctx.now() });
    return { user: toStaffUserDTO(user), org: { id: user.orgId, name: await loadOrgName(ctx, user.orgId) } };
  });

  // Same-origin only: a third-party page must not be able to sign staff out (CSRF).
  app.post('/logout', { preHandler: requireSameOrigin }, async (req, reply) => {
    await endStaffSession(ctx, req, reply);
    return { ok: true };
  });

  app.get('/me', { preHandler: requireStaff('reviewer') }, async (req) => {
    const staff = getStaff(req);
    return { user: toStaffUserDTO(staff.user), org: { id: staff.orgId, name: await loadOrgName(ctx, staff.orgId) } };
  });

  app.post('/password', { preHandler: requireStaff('reviewer'), config: loginLimit }, async (req) => {
    const staff = getStaff(req);
    const body = passwordChangeSchema.parse(req.body);
    if (!(await verifyPassword(body.currentPassword, staff.user.passwordHash))) throw badRequest('Current password is incorrect', undefined, 'bad_password');
    const now = ctx.now();
    await ctx.db
      .update(staffUsers)
      .set({ passwordHash: await hashPassword(body.newPassword), passwordChangedAt: new Date(now), updatedAt: new Date(now) })
      .where(eq(staffUsers.id, staff.id));
    await revokeStaffSessions(ctx, staff.id, staff.staffSessionId);
    await clearLoginFailures(ctx.db, staff.user.email);
    await audit(ctx.db, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'auth.password_changed', targetType: 'staff_user', targetId: staff.id, ip: req.ip, at: now });
    return { ok: true };
  });
};

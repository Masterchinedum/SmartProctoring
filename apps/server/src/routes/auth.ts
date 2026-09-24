import { loginRequestSchema } from '@sp/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { endStaffSession, getStaff, loadOrgName, requireStaff, revokeStaffSessions, startStaffSession } from '../auth/staff.js';
import { staffUsers } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { dummyPasswordHash, hashPassword, verifyPassword } from '../lib/crypto.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { toStaffUserDTO } from '../services/dto.js';

const passwordChangeSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(10).max(200) });

/** /api/auth/* — staff login, logout, current user, password change. */
export const authRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const loginLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  app.post('/login', { config: loginLimit }, async (req, reply) => {
    const body = loginRequestSchema.parse(req.body);
    const email = body.email.trim().toLowerCase();
    const [user] = await ctx.db
      .select()
      .from(staffUsers)
      .where(eq(sql`lower(${staffUsers.email})`, email));
    const ok = user ? await verifyPassword(body.password, user.passwordHash) : (await verifyPassword(body.password, await dummyPasswordHash()), false);
    if (!user || !ok || user.disabled) {
      await audit(ctx.db, {
        orgId: user?.orgId ?? null,
        actorType: 'staff',
        actorId: user?.id ?? null,
        action: 'auth.login_failed',
        targetType: 'staff_user',
        targetId: user?.id ?? null,
        meta: { email, reason: !user ? 'unknown_user' : user.disabled ? 'disabled' : 'bad_password' },
        ip: req.ip,
        at: ctx.now(),
      });
      throw unauthorized('Invalid email or password');
    }
    await startStaffSession(ctx, reply, user, req);
    await ctx.db.update(staffUsers).set({ lastLoginAt: new Date(ctx.now()) }).where(eq(staffUsers.id, user.id));
    await audit(ctx.db, { orgId: user.orgId, actorType: 'staff', actorId: user.id, action: 'auth.login', targetType: 'staff_user', targetId: user.id, ip: req.ip, at: ctx.now() });
    return { user: toStaffUserDTO(user), org: { id: user.orgId, name: await loadOrgName(ctx, user.orgId) } };
  });

  app.post('/logout', async (req, reply) => {
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
    await audit(ctx.db, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'auth.password_changed', targetType: 'staff_user', targetId: staff.id, ip: req.ip, at: now });
    return { ok: true };
  });
};

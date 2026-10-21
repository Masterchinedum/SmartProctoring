import { loginRequestSchema, mfaDisableSchema, mfaLoginSchema, recoveryCodesRegenerateSchema, totpConfirmSchema, type MfaChallengeResponse, type RecoveryCodesDTO, type TotpSetupDTO } from '@sp/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { endStaffSession, getStaff, isSameOriginRequest, loadOrgName, requireSameOrigin, requireStaff, revokeStaffSessions, startStaffSession } from '../auth/staff.js';
import { organizations, staffUsers } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { dummyPasswordHash, hashPassword, isUsablePasswordHash, passwordNeedsRehash, verifyPassword } from '../lib/crypto.js';
import { badRequest, forbidden, HttpError, unauthorized } from '../lib/errors.js';
import { toStaffUserDTO } from '../services/dto.js';
import { admitLoginAttempt, clearLoginFailures, purgeStaleLoginThrottles, type ThrottleScope } from '../services/login-throttle.js';
import {
  assertMayDisable,
  beginTotpSetup,
  confirmTotpSetup,
  createLoginChallenge,
  deleteChallenge,
  disableMfa,
  MFA_CHALLENGE_TTL_MS,
  MFA_COOKIE,
  purgeExpiredChallenges,
  replaceRecoveryCodes,
  securityDTO,
  takeChallengeAttempt,
  verifySecondFactor,
  verifyTotpCode,
} from '../services/mfa.js';
import { orgSettings } from '../services/org.js';
import { notifySecurityChange } from '../services/security-notices.js';

/** "45 seconds" / "2 minutes" for the per-account backoff message. */
export function waitText(sec: number): string {
  if (sec < 90) return `${sec} second${sec === 1 ? '' : 's'}`;
  const min = Math.ceil(sec / 60);
  return `${min} minute${min === 1 ? '' : 's'}`;
}

const passwordChangeSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(10).max(200) });

/** /api/auth/* — staff login (with two-step sign-in), logout, current user, password change, two-step sign-in set-up. */
export const authRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const loginLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };
  /** Sign-in state, set-up and sign-out stay available to a user who must set up two-step sign-in first. */
  const signedIn = { preHandler: requireStaff('reviewer', { allowMfaEnrollment: true }) };

  // Per-account backoff table housekeeping (the per-IP limit above is separate), and stale sign-in challenges.
  ctx.jobs.register({
    name: 'login-throttle-cleanup',
    intervalMs: 3_600_000,
    runAtStart: false,
    run: async (c) => {
      await purgeStaleLoginThrottles(c.db, c.now());
      await purgeExpiredChallenges(c.db, c.now());
    },
  });

  const signedInResponse = async (user: typeof staffUsers.$inferSelect, signInMethod: 'password' | 'sso' = 'password') => ({
    user: toStaffUserDTO(user),
    org: { id: user.orgId, name: await loadOrgName(ctx, user.orgId) },
    security: await securityDTO(ctx.db, user, signInMethod),
  });
  const auditAuth = (user: { id: string; orgId: string } | null, action: string, meta: Record<string, unknown>, ip: string) =>
    audit(ctx.db, { orgId: user?.orgId ?? null, actorType: 'staff', actorId: user?.id ?? null, action, targetType: 'staff_user', targetId: user?.id ?? null, meta, ip, at: ctx.now() });

  const assertPasswordSignInAllowed = async (user: typeof staffUsers.$inferSelect, ip: string) => {
    if (user.role === 'owner') return;
    const [o] = await ctx.db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, user.orgId));
    if (!orgSettings(o ?? null).requireSso) return;
    await auditAuth(user, 'auth.login_failed', { email: user.email, reason: 'sso_required' }, ip);
    throw forbidden('Your organisation signs in with single sign-on. Choose “Sign in with your organisation”.', 'sso_required');
  };

  /**
   * Re-authentication on a signed-in account (the current password, a code) is charged to a per-account backoff like
   * a sign-in, before it is checked, so a session left open or stolen cannot be used to guess faster than the sign-in
   * allows (services/login-throttle.ts scopes). A success clears the scope's failures.
   */
  const admitReauth = async (user: typeof staffUsers.$inferSelect, scope: Exclude<ThrottleScope, 'login'>, req: FastifyRequest, reply: FastifyReply) => {
    const admission = await admitLoginAttempt(ctx.db, user.email, ctx.now(), scope);
    if (admission.admitted) return;
    const sec = Math.ceil(admission.retryAfterMs / 1000);
    await auditAuth(user, 'auth.login_failed', { reason: 'throttled', step: scope, retryAfterSec: sec }, req.ip);
    reply.header('Retry-After', String(sec));
    throw new HttpError(429, 'too_many_attempts', `Too many wrong attempts. Try again in ${waitText(sec)}.`, { retryAfterSec: sec });
  };

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
    // Accounts without a password (created by SCIM or single sign-on) cost the same derivation as any other.
    const ok = user && isUsablePasswordHash(user.passwordHash) ? await verifyPassword(body.password, user.passwordHash) : (await verifyPassword(body.password, await dummyPasswordHash()), false);
    if (!user || !ok || user.disabled) {
      // Never the password itself; the attempted address, the reason and the backoff state.
      await audit(ctx.db, {
        orgId: user?.orgId ?? null,
        actorType: 'staff',
        actorId: user?.id ?? null,
        action: 'auth.login_failed',
        targetType: 'staff_user',
        targetId: user?.id ?? null,
        meta: {
          email,
          reason: !user ? 'unknown_user' : user.disabled ? 'disabled' : isUsablePasswordHash(user.passwordHash) ? 'bad_password' : 'no_password',
          failures: admission.failures,
          ...(admission.lockedUntil ? { lockedUntil: admission.lockedUntil } : {}),
        },
        ip: req.ip,
        at: ctx.now(),
      });
      throw unauthorized('Invalid email or password');
    }
    // The organisation signs in with single sign-on: only owners keep password sign-in (break-glass). Said only after
    // the right password, so it does not reveal which addresses have accounts.
    await assertPasswordSignInAllowed(user, req.ip);
    // Hashes made with older (weaker) scrypt parameters are upgraded transparently while we have the password.
    if (passwordNeedsRehash(user.passwordHash)) {
      const upgraded = await hashPassword(body.password);
      await ctx.db
        .update(staffUsers)
        .set({ passwordHash: upgraded })
        .where(and(eq(staffUsers.id, user.id), eq(staffUsers.passwordHash, user.passwordHash)));
    }
    if (user.mfaEnabledAt) {
      // Second step: no session yet. The account's failed-attempt backoff is cleared only by the complete sign-in, so
      // guessing codes costs a password attempt per challenge plus MAX_CHALLENGE_ATTEMPTS codes each.
      const token = await createLoginChallenge(ctx.db, user.id, ctx.now(), req.ip);
      reply.setCookie(MFA_COOKIE, token, { signed: true, httpOnly: true, sameSite: 'strict', secure: ctx.config.cookieSecure, path: '/api/auth', maxAge: Math.floor(MFA_CHALLENGE_TTL_MS / 1000) });
      const res: MfaChallengeResponse = { mfaRequired: true, methods: ['totp', 'recovery_code'] };
      return res;
    }
    await clearLoginFailures(ctx.db, email);
    await startStaffSession(ctx, reply, user, req);
    await ctx.db.update(staffUsers).set({ lastLoginAt: new Date(ctx.now()) }).where(eq(staffUsers.id, user.id));
    await audit(ctx.db, { orgId: user.orgId, actorType: 'staff', actorId: user.id, action: 'auth.login', targetType: 'staff_user', targetId: user.id, ip: req.ip, at: ctx.now() });
    return signedInResponse(user);
  });

  /** Second step of a sign-in with two-step sign-in: an authenticator code or a recovery code. */
  app.post('/login/mfa', { config: loginLimit }, async (req, reply) => {
    if (!isSameOriginRequest(ctx, req)) throw forbidden('Cross-origin request refused', 'bad_origin');
    const body = mfaLoginSchema.parse(req.body ?? {});
    const raw = req.cookies?.[MFA_COOKIE];
    const un = raw ? req.unsignCookie(raw) : null;
    const expired = () => {
      reply.clearCookie(MFA_COOKIE, { path: '/api/auth' });
      return new HttpError(401, 'mfa_challenge_expired', 'This sign-in has expired. Enter your email and password again.');
    };
    if (!un?.valid || !un.value) throw expired();
    const now = ctx.now();
    const taken = await takeChallengeAttempt(ctx.db, un.value, now);
    if (!taken.ok) {
      if (taken.reason === 'too_many_attempts') await auditAuth(null, 'auth.login_failed', { reason: 'mfa_too_many_attempts' }, req.ip);
      throw expired();
    }
    const [user] = await ctx.db.select().from(staffUsers).where(eq(staffUsers.id, taken.userId));
    if (!user || user.disabled || !user.mfaEnabledAt) {
      await deleteChallenge(ctx.db, taken.challengeId);
      throw expired();
    }
    await assertPasswordSignInAllowed(user, req.ip);
    // Every code attempt also counts toward the account's backoff (as a password attempt would).
    const admission = await admitLoginAttempt(ctx.db, user.email.toLowerCase(), now);
    if (!admission.admitted) {
      const sec = Math.ceil(admission.retryAfterMs / 1000);
      await auditAuth(user, 'auth.login_failed', { reason: 'throttled', step: 'mfa', retryAfterSec: sec }, req.ip);
      reply.header('Retry-After', String(sec));
      throw new HttpError(429, 'too_many_attempts', `Too many failed sign-in attempts for this account. Try again in ${waitText(sec)}.`, { retryAfterSec: sec });
    }
    const method = await verifySecondFactor(ctx, user, (body.code ?? body.recoveryCode)!);
    if (!method) {
      await auditAuth(user, 'auth.login_failed', { reason: 'bad_mfa_code', kind: body.code ? 'totp' : 'recovery_code', failures: admission.failures }, req.ip);
      throw new HttpError(401, 'invalid_mfa_code', body.code ? 'That code is not right. Enter the current 6-digit code from your authenticator app (check that the time on your phone is set automatically).' : 'That recovery code is not right, or it was already used.');
    }
    await deleteChallenge(ctx.db, taken.challengeId);
    reply.clearCookie(MFA_COOKIE, { path: '/api/auth' });
    await clearLoginFailures(ctx.db, user.email.toLowerCase());
    await startStaffSession(ctx, reply, user, req);
    await ctx.db.update(staffUsers).set({ lastLoginAt: new Date(now) }).where(eq(staffUsers.id, user.id));
    await auditAuth(user, 'auth.login', { mfa: method }, req.ip);
    const res = await signedInResponse(user);
    if (method === 'recovery_code') {
      await auditAuth(user, 'auth.recovery_code_used', { left: res.security.recoveryCodesLeft }, req.ip);
      await notifySecurityChange(ctx, user, 'recovery_code_used', { left: res.security.recoveryCodesLeft ?? 0 });
    }
    return res;
  });

  // Same-origin only: a third-party page must not be able to sign staff out (CSRF).
  app.post('/logout', { preHandler: requireSameOrigin }, async (req, reply) => {
    await endStaffSession(ctx, req, reply);
    return { ok: true };
  });

  app.get('/me', signedIn, async (req) => {
    const staff = getStaff(req);
    return signedInResponse(staff.user, staff.authMethod);
  });

  /* ---------------------------------------------------------------- two-step sign-in */

  app.post('/mfa/totp/setup', { ...signedIn, config: loginLimit }, async (req): Promise<TotpSetupDTO> => {
    const staff = getStaff(req);
    return beginTotpSetup(ctx, staff.user, await loadOrgName(ctx, staff.orgId));
  });

  app.post('/mfa/totp/confirm', { ...signedIn, config: loginLimit }, async (req, reply): Promise<RecoveryCodesDTO> => {
    const staff = getStaff(req);
    const body = totpConfirmSchema.parse(req.body ?? {});
    const [user] = await ctx.db.select().from(staffUsers).where(eq(staffUsers.id, staff.id));
    // Replacing an authenticator proves the current factor: that check is backoff-limited.
    const replacing = !!user.mfaEnabledAt;
    if (replacing) await admitReauth(user, 'reauth', req, reply);
    const r = await confirmTotpSetup(ctx, user, body.code, body.currentCode);
    if (!r.ok) {
      const messages: Record<typeof r.reason, string> = {
        no_setup: 'Start the set-up again.',
        setup_expired: 'The set-up took too long. Start it again to get a new code.',
        bad_code: 'That code is not right. Enter the current 6-digit code shown by the authenticator app you just set up.',
        current_code_required: 'Two-step sign-in is already on: also enter a code from your current authenticator app (or a recovery code).',
        bad_current_code: 'The code from your current authenticator app (or the recovery code) is not right.',
      };
      throw new HttpError(r.reason === 'no_setup' || r.reason === 'setup_expired' ? 409 : 400, `mfa_${r.reason}`, messages[r.reason]);
    }
    if (replacing) await clearLoginFailures(ctx.db, user.email, ['reauth']);
    // Other signed-in browsers must sign in again with the second step.
    await revokeStaffSessions(ctx, staff.id, staff.staffSessionId);
    await auditAuth(staff.user, r.replaced ? 'auth.mfa_replaced' : 'auth.mfa_enabled', {}, req.ip);
    await notifySecurityChange(ctx, staff.user, r.replaced ? 'mfa_replaced' : 'mfa_enabled');
    return { codes: r.codes };
  });

  app.post('/mfa/recovery-codes', { ...signedIn, config: loginLimit }, async (req, reply): Promise<RecoveryCodesDTO> => {
    const staff = getStaff(req);
    const body = recoveryCodesRegenerateSchema.parse(req.body ?? {});
    const [user] = await ctx.db.select().from(staffUsers).where(eq(staffUsers.id, staff.id));
    if (!user.mfaEnabledAt) throw new HttpError(409, 'mfa_not_enabled', 'Two-step sign-in is not on.');
    await admitReauth(user, 'reauth', req, reply);
    if (!(await verifyTotpCode(ctx, user, body.code))) throw badRequest('That code is not right. Enter the current 6-digit code from your authenticator app.', undefined, 'invalid_mfa_code');
    await clearLoginFailures(ctx.db, user.email, ['reauth']);
    const codes = await replaceRecoveryCodes(ctx.db, user.id, ctx.now());
    await auditAuth(user, 'auth.mfa_recovery_codes_regenerated', {}, req.ip);
    await notifySecurityChange(ctx, user, 'recovery_codes_regenerated');
    return { codes };
  });

  app.post('/mfa/disable', { ...signedIn, config: loginLimit }, async (req, reply) => {
    const staff = getStaff(req);
    const body = mfaDisableSchema.parse(req.body ?? {});
    const [user] = await ctx.db.select().from(staffUsers).where(eq(staffUsers.id, staff.id));
    if (!user.mfaEnabledAt) throw new HttpError(409, 'mfa_not_enabled', 'Two-step sign-in is not on.');
    await assertMayDisable(ctx.db, user);
    await admitReauth(user, 'reauth', req, reply);
    if (!(await verifyPassword(body.password, user.passwordHash))) throw badRequest('Your password is not right.', undefined, 'bad_password');
    if (!(await verifySecondFactor(ctx, user, body.code))) throw badRequest('That code is not right.', undefined, 'invalid_mfa_code');
    await clearLoginFailures(ctx.db, user.email, ['reauth']);
    await disableMfa(ctx.db, user.id, ctx.now());
    await auditAuth(user, 'auth.mfa_disabled', {}, req.ip);
    await notifySecurityChange(ctx, user, 'mfa_disabled');
    return { ok: true };
  });

  app.post('/password', { ...signedIn, config: loginLimit }, async (req, reply) => {
    const staff = getStaff(req);
    const body = passwordChangeSchema.parse(req.body);
    await admitReauth(staff.user, 'password', req, reply);
    if (!(await verifyPassword(body.currentPassword, staff.user.passwordHash))) throw badRequest('Current password is incorrect', undefined, 'bad_password');
    const now = ctx.now();
    await ctx.db
      .update(staffUsers)
      .set({ passwordHash: await hashPassword(body.newPassword), passwordChangedAt: new Date(now), updatedAt: new Date(now) })
      .where(eq(staffUsers.id, staff.id));
    await revokeStaffSessions(ctx, staff.id, staff.staffSessionId);
    await clearLoginFailures(ctx.db, staff.user.email, ['login', 'password']);
    await audit(ctx.db, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'auth.password_changed', targetType: 'staff_user', targetId: staff.id, ip: req.ip, at: now });
    return { ok: true };
  });
};

/**
 * Break-glass account recovery by a server operator (the `staff-access` CLI), for when nobody in the organisation
 * can do it in the staff app: the only owner lost their phone and their recovery codes, or forgot their password.
 * Everything else is done in the app (an administrator resets a colleague's password or two-step sign-in).
 *
 * Each change is audited in the person's organisation as actor `system` with the operator's reason, ends every
 * signed-in session of the account, lifts the account's sign-in backoff and pending second steps, and the person is
 * emailed (when SMTP is configured) — an operator cannot quietly take over an account. A temporary password is
 * returned to the operator once (never stored or logged in clear, never emailed).
 */
import { eq, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { staffLoginChallenges, staffUsers, type StaffUser } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { hashPassword } from '../lib/crypto.js';
import { generateRecoveryCode } from '../lib/totp.js';
import { revokeStaffSessions } from '../auth/staff.js';
import { clearLoginFailures, THROTTLE_SCOPES } from './login-throttle.js';
import { disableMfa } from './mfa.js';
import { notifySecurityChange } from './security-notices.js';

export interface StaffRecoveryRequest {
  email: string;
  resetMfa: boolean;
  resetPassword: boolean;
  /** Why (ticket number, who asked and how their identity was checked): recorded in the audit log. */
  reason: string;
}

export interface StaffRecoveryResult {
  user: Pick<StaffUser, 'id' | 'orgId' | 'email' | 'name' | 'role' | 'disabled'>;
  /** `not_enabled`: two-step sign-in was not on (nothing to reset). */
  mfa: 'reset' | 'not_enabled' | 'unchanged';
  /** Shown to the operator once, to hand over through a trusted channel. */
  temporaryPassword: string | null;
}

/** ≈ 98 bits, unambiguous characters, easy to read out: `XXXXX-XXXXX-XXXXX-XXXXX`. */
export function temporaryPassword(): string {
  return `${generateRecoveryCode()}-${generateRecoveryCode()}`;
}

/** `null` when no staff account has that address. */
export async function recoverStaffAccess(ctx: Pick<Ctx, 'db' | 'mailer' | 'config' | 'log' | 'now'>, req: StaffRecoveryRequest): Promise<StaffRecoveryResult | null> {
  const email = req.email.trim().toLowerCase();
  const reason = req.reason.trim();
  const now = ctx.now();
  const password = req.resetPassword ? temporaryPassword() : null;
  const passwordHash = password ? await hashPassword(password) : undefined;

  const result = await ctx.db.transaction(async (tx) => {
    const [user] = await tx.select().from(staffUsers).where(sql`lower(${staffUsers.email}) = ${email}`).for('update');
    if (!user) return null;
    const meta = { email: user.email, via: 'operator_cli', reason };
    let mfa: StaffRecoveryResult['mfa'] = 'unchanged';
    if (req.resetMfa) {
      if (user.mfaEnabledAt) {
        await disableMfa(tx, user.id, now);
        await audit(tx, { orgId: user.orgId, actorType: 'system', action: 'user.mfa_reset', targetType: 'staff_user', targetId: user.id, meta, at: now });
        mfa = 'reset';
      } else {
        mfa = 'not_enabled';
      }
    }
    if (passwordHash) {
      await tx.update(staffUsers).set({ passwordHash, passwordChangedAt: new Date(now), updatedAt: new Date(now) }).where(eq(staffUsers.id, user.id));
      await audit(tx, { orgId: user.orgId, actorType: 'system', action: 'user.updated', targetType: 'staff_user', targetId: user.id, meta: { ...meta, fields: ['password'] }, at: now });
    }
    await tx.delete(staffLoginChallenges).where(eq(staffLoginChallenges.staffUserId, user.id));
    return { user, mfa };
  });
  if (!result) return null;

  const { user, mfa } = result;
  if (mfa === 'reset' || password) {
    await revokeStaffSessions(ctx, user.id);
    await clearLoginFailures(ctx.db, user.email, THROTTLE_SCOPES);
  }
  if (mfa === 'reset') await notifySecurityChange(ctx, user, 'mfa_reset_by_admin', { by: 'A SmartProctoring server operator' });
  if (password) await notifySecurityChange(ctx, user, 'password_reset_by_operator', { by: 'A SmartProctoring server operator' });
  return {
    user: { id: user.id, orgId: user.orgId, email: user.email, name: user.name, role: user.role, disabled: user.disabled },
    mfa,
    temporaryPassword: password,
  };
}

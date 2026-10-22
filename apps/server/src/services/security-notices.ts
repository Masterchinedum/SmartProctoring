/**
 * Emails a staff member about security changes on their own account (two-step sign-in turned on / off / reset, a new
 * authenticator, new recovery codes, a recovery code used), so an unexpected change is noticed by the person whose
 * account it is. Only when the server has SMTP configured (ctx.mailer); best effort — a failed email never fails
 * the change itself (it is audit-logged either way).
 */
import type { Ctx } from '../context.js';
import type { StaffUser } from '../db/schema.js';
import { headerSafe } from '../lib/mailer.js';

export type SecurityChange =
  | 'mfa_enabled'
  | 'mfa_replaced'
  | 'mfa_disabled'
  | 'mfa_reset_by_admin'
  | 'recovery_codes_regenerated'
  | 'recovery_code_used'
  | 'password_reset_by_operator';

const SUBJECT: Record<SecurityChange, string> = {
  mfa_enabled: 'Two-step sign-in was turned on for your account',
  mfa_replaced: 'A new authenticator app was set up for your account',
  mfa_disabled: 'Two-step sign-in was turned off for your account',
  mfa_reset_by_admin: 'Two-step sign-in was reset for your account',
  recovery_codes_regenerated: 'New recovery codes were created for your account',
  recovery_code_used: 'A recovery code was used to sign in to your account',
  password_reset_by_operator: 'The password for your account was reset',
};

export function securityNoticeText(change: SecurityChange, data: { name: string; left?: number; by?: string; signInUrl: string }): string {
  const lines = [`Hello ${data.name},`, '', `${SUBJECT[change]} (SmartProctoring).`];
  if (change === 'mfa_reset_by_admin') lines.push('', `${data.by ?? 'An administrator'} reset it. At your next sign-in you will be asked to set it up again if your organisation requires it.`);
  if (change === 'password_reset_by_operator') lines.push('', `${data.by ?? 'An administrator'} reset it to a temporary password, which you receive separately. Change it on your account page after signing in.`);
  if (change === 'recovery_code_used') lines.push('', `You have ${data.left ?? 0} unused recovery code${data.left === 1 ? '' : 's'} left. Create new ones on your account page if you are running low.`);
  lines.push('', 'If this was not you, contact your administrator immediately and change your password.', '', `Sign in: ${data.signInUrl}`);
  return lines.join('\n');
}

export async function notifySecurityChange(ctx: Pick<Ctx, 'mailer' | 'config' | 'log'>, user: Pick<StaffUser, 'email' | 'name' | 'id'>, change: SecurityChange, data: { left?: number; by?: string } = {}): Promise<void> {
  if (!ctx.mailer) return;
  try {
    await ctx.mailer.send({
      to: [user.email],
      subject: headerSafe(`SmartProctoring: ${SUBJECT[change]}`),
      text: securityNoticeText(change, { name: user.name, signInUrl: `${ctx.config.publicUrl}/admin/login`, ...data }),
    });
  } catch (err) {
    ctx.log.warn({ err, staffUserId: user.id, change }, 'security notice email could not be sent');
  }
}

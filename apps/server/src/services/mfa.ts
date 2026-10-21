/**
 * Two-step sign-in for staff (routes/auth.ts): TOTP authenticator apps (lib/totp.ts) and single-use recovery codes.
 *
 *  - Secrets are encrypted at rest (AAD totp:<userId>; a secret being set up: totp-pending:<userId>; both rekey
 *    targets). A code is accepted once: the last accepted time step is stored and moved forward atomically.
 *  - Recovery codes (10, shown once) are stored as sha256 of the normalised code (≈50 bits each) and consumed
 *    atomically (UPDATE … WHERE used_at IS NULL).
 *  - Sign-in with two-step sign-in is a challenge (staff_login_challenges): created after the right password,
 *    carried by a signed httpOnly cookie, valid 5 minutes and MAX_CHALLENGE_ATTEMPTS codes.
 *  - An organisation can require it (settings.requireMfa); requireStaff then admits a user who must but has not set it
 *    up only to the set-up endpoints (auth/staff.ts).
 */
import { mfaRequiredFor, type StaffRole, type StaffSecurityDTO, type TotpSetupDTO } from '@sp/shared';
import { and, count, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import type { DbOrTx } from '../db/index.js';
import { organizations, staffLoginChallenges, staffRecoveryCodes, staffUsers, type StaffUser } from '../db/schema.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { conflict } from '../lib/errors.js';
import { base32Encode, generateRecoveryCode, generateTotpSecret, normaliseRecoveryCode, otpauthUri, RECOVERY_CODE_COUNT, verifyTotp } from '../lib/totp.js';
import { orgSettings } from './org.js';

export const totpAad = (userId: string) => `totp:${userId}`;
export const totpPendingAad = (userId: string) => `totp-pending:${userId}`;

export const MFA_CHALLENGE_TTL_MS = 5 * 60_000;
export const MAX_CHALLENGE_ATTEMPTS = 5;
/** A secret being set up must be confirmed within this time. */
export const TOTP_SETUP_TTL_MS = 15 * 60_000;
export const MFA_COOKIE = 'sp_mfa';

const hashRecovery = (code: string) => sha256Hex(`recovery:${normaliseRecoveryCode(code)}`);

export async function requireMfaFor(db: DbOrTx, orgId: string): Promise<ReturnType<typeof orgSettings>['requireMfa']> {
  const [o] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
  return orgSettings(o ?? null).requireMfa;
}

export async function securityDTO(db: DbOrTx, user: Pick<StaffUser, 'id' | 'orgId' | 'role' | 'mfaEnabledAt'>): Promise<StaffSecurityDTO> {
  const required = mfaRequiredFor(await requireMfaFor(db, user.orgId), user.role as StaffRole);
  const enabled = user.mfaEnabledAt != null;
  let left: number | null = null;
  if (enabled) {
    const [r] = await db
      .select({ n: count() })
      .from(staffRecoveryCodes)
      .where(and(eq(staffRecoveryCodes.staffUserId, user.id), isNull(staffRecoveryCodes.usedAt)));
    left = r?.n ?? 0;
  }
  return { mfaEnabled: enabled, mfaEnabledAt: user.mfaEnabledAt?.getTime() ?? null, recoveryCodesLeft: left, mfaRequired: required, enrollmentRequired: required && !enabled };
}

/* ------------------------------------------------------------------ set-up */

export async function beginTotpSetup(ctx: Pick<Ctx, 'db' | 'keyring' | 'now'>, user: StaffUser, orgName: string): Promise<TotpSetupDTO> {
  const secret = generateTotpSecret();
  const now = ctx.now();
  await ctx.db
    .update(staffUsers)
    .set({ totpPendingEnc: ctx.keyring.encrypt(secret, totpPendingAad(user.id)), totpPendingAt: new Date(now) })
    .where(eq(staffUsers.id, user.id));
  const issuer = orgName ? `SmartProctoring (${orgName})` : 'SmartProctoring';
  return { secret: base32Encode(secret), otpauthUri: otpauthUri({ secret, account: user.email, issuer }), issuer, account: user.email, expiresAt: now + TOTP_SETUP_TTL_MS };
}

/** Fresh recovery codes for a user (replacing any earlier ones). Returns them in clear, once. */
export async function replaceRecoveryCodes(db: DbOrTx, userId: string, now: number): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  await db.delete(staffRecoveryCodes).where(eq(staffRecoveryCodes.staffUserId, userId));
  await db.insert(staffRecoveryCodes).values(codes.map((c) => ({ staffUserId: userId, codeHash: hashRecovery(c), createdAt: new Date(now) })));
  return codes;
}

/**
 * Confirm the secret being set up with a code from the app. When two-step sign-in is already on (a new phone), the
 * current factor must be proven too (`currentCode`: a code from the old app or a recovery code). Returns new recovery
 * codes, or null when a code is wrong.
 */
export async function confirmTotpSetup(
  ctx: Pick<Ctx, 'db' | 'keyring' | 'now'>,
  user: StaffUser,
  code: string,
  currentCode: string | undefined,
): Promise<{ ok: true; codes: string[]; replaced: boolean } | { ok: false; reason: 'no_setup' | 'setup_expired' | 'bad_code' | 'current_code_required' | 'bad_current_code' }> {
  const now = ctx.now();
  if (!user.totpPendingEnc || !user.totpPendingAt) return { ok: false, reason: 'no_setup' };
  if (now - user.totpPendingAt.getTime() > TOTP_SETUP_TTL_MS) return { ok: false, reason: 'setup_expired' };
  const pending = ctx.keyring.decrypt(user.totpPendingEnc, totpPendingAad(user.id));
  const step = verifyTotp(pending, code, now);
  if (step == null) return { ok: false, reason: 'bad_code' };
  const replaced = user.mfaEnabledAt != null;
  if (replaced) {
    if (!currentCode) return { ok: false, reason: 'current_code_required' };
    if (!(await verifySecondFactor(ctx, user, currentCode))) return { ok: false, reason: 'bad_current_code' };
  }
  return ctx.db.transaction(async (tx) => {
    await tx
      .update(staffUsers)
      .set({ totpSecretEnc: ctx.keyring.encrypt(pending, totpAad(user.id)), totpLastStep: step, mfaEnabledAt: new Date(now), totpPendingEnc: null, totpPendingAt: null, updatedAt: new Date(now) })
      .where(eq(staffUsers.id, user.id));
    const codes = await replaceRecoveryCodes(tx, user.id, now);
    return { ok: true as const, codes, replaced };
  });
}

/* ------------------------------------------------------------------ verification */

/** A 6-digit authenticator code (moves the last accepted step forward atomically; a replay fails). */
export async function verifyTotpCode(ctx: Pick<Ctx, 'db' | 'keyring' | 'now'>, user: Pick<StaffUser, 'id' | 'totpSecretEnc' | 'totpLastStep'>, code: string): Promise<boolean> {
  if (!user.totpSecretEnc) return false;
  const secret = ctx.keyring.decrypt(user.totpSecretEnc, totpAad(user.id));
  const step = verifyTotp(secret, code, ctx.now(), user.totpLastStep ?? null);
  if (step == null) return false;
  // Compare-and-set: two concurrent requests with the same code cannot both win.
  const rows = await ctx.db
    .update(staffUsers)
    .set({ totpLastStep: step })
    .where(and(eq(staffUsers.id, user.id), or(isNull(staffUsers.totpLastStep), lt(staffUsers.totpLastStep, step))))
    .returning({ id: staffUsers.id });
  return rows.length === 1;
}

/** A recovery code, consumed atomically. */
export async function consumeRecoveryCode(db: DbOrTx, userId: string, code: string, now: number): Promise<boolean> {
  if (normaliseRecoveryCode(code).length !== 10) return false;
  const rows = await db
    .update(staffRecoveryCodes)
    .set({ usedAt: new Date(now) })
    .where(and(eq(staffRecoveryCodes.staffUserId, userId), eq(staffRecoveryCodes.codeHash, hashRecovery(code)), isNull(staffRecoveryCodes.usedAt)))
    .returning({ id: staffRecoveryCodes.id });
  return rows.length === 1;
}

/** Either factor: 6 digits are an authenticator code, anything else a recovery code. */
export async function verifySecondFactor(ctx: Pick<Ctx, 'db' | 'keyring' | 'now'>, user: Pick<StaffUser, 'id' | 'totpSecretEnc' | 'totpLastStep'>, input: string): Promise<'totp' | 'recovery_code' | null> {
  if (/^\d{6}$/.test(input.replace(/[\s-]/g, ''))) return (await verifyTotpCode(ctx, user, input)) ? 'totp' : null;
  return (await consumeRecoveryCode(ctx.db, user.id, input, ctx.now())) ? 'recovery_code' : null;
}

export async function disableMfa(db: DbOrTx, userId: string, now: number): Promise<void> {
  await db
    .update(staffUsers)
    .set({ totpSecretEnc: null, totpLastStep: null, mfaEnabledAt: null, totpPendingEnc: null, totpPendingAt: null, updatedAt: new Date(now) })
    .where(eq(staffUsers.id, userId));
  await db.delete(staffRecoveryCodes).where(eq(staffRecoveryCodes.staffUserId, userId));
}

/** Refused when the organisation requires two-step sign-in for the user's role. */
export async function assertMayDisable(db: DbOrTx, user: Pick<StaffUser, 'orgId' | 'role'>): Promise<void> {
  if (mfaRequiredFor(await requireMfaFor(db, user.orgId), user.role as StaffRole)) {
    throw conflict('mfa_required_by_organisation', 'Your organisation requires two-step sign-in for your role, so it cannot be turned off. To move it to a new phone, set up the new authenticator instead.');
  }
}

/* ------------------------------------------------------------------ sign-in challenge */

export async function createLoginChallenge(db: DbOrTx, userId: string, now: number, ip: string): Promise<string> {
  const token = randomToken(32);
  // One challenge per user at a time, and none left over from earlier sign-ins.
  await db.delete(staffLoginChallenges).where(or(eq(staffLoginChallenges.staffUserId, userId), lt(staffLoginChallenges.expiresAt, new Date(now))));
  await db.insert(staffLoginChallenges).values({ tokenHash: sha256Hex(token), staffUserId: userId, createdAt: new Date(now), expiresAt: new Date(now + MFA_CHALLENGE_TTL_MS), ip });
  return token;
}

/** The open challenge for a token (attempt counted), or why there is none. */
export async function takeChallengeAttempt(db: DbOrTx, token: string, now: number): Promise<{ ok: true; userId: string; challengeId: string } | { ok: false; reason: 'missing' | 'expired' | 'too_many_attempts' }> {
  const [c] = await db.select().from(staffLoginChallenges).where(eq(staffLoginChallenges.tokenHash, sha256Hex(token)));
  if (!c) return { ok: false, reason: 'missing' };
  if (c.expiresAt.getTime() <= now) {
    await db.delete(staffLoginChallenges).where(eq(staffLoginChallenges.id, c.id));
    return { ok: false, reason: 'expired' };
  }
  const [u] = await db
    .update(staffLoginChallenges)
    .set({ attempts: sql`${staffLoginChallenges.attempts} + 1` })
    .where(eq(staffLoginChallenges.id, c.id))
    .returning({ attempts: staffLoginChallenges.attempts });
  if (!u || u.attempts > MAX_CHALLENGE_ATTEMPTS) {
    await db.delete(staffLoginChallenges).where(eq(staffLoginChallenges.id, c.id));
    return { ok: false, reason: 'too_many_attempts' };
  }
  return { ok: true, userId: c.staffUserId, challengeId: c.id };
}

export async function deleteChallenge(db: DbOrTx, challengeId: string): Promise<void> {
  await db.delete(staffLoginChallenges).where(eq(staffLoginChallenges.id, challengeId));
}

export async function purgeExpiredChallenges(db: DbOrTx, now: number): Promise<number> {
  const rows = await db.delete(staffLoginChallenges).where(lt(staffLoginChallenges.expiresAt, new Date(now))).returning({ id: staffLoginChallenges.id });
  return rows.length;
}

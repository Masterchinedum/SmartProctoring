/**
 * Two-step sign-in for staff (services/mfa.ts, routes/auth.ts): set-up with an authenticator app, sign-in with a code
 * or a recovery code (challenge cookie, attempt limits, replay protection, account backoff), recovery code
 * regeneration, turning it off, the organisation requirement (owner only; enforced on every staff endpoint except
 * set-up), an administrator's reset, an operator's break-glass recovery (staff-access CLI), a new authenticator, and
 * security notice emails.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RecoveryCodesDTO, StaffSecurityDTO, TotpSetupDTO } from '@sp/shared';
import type { LightMyRequestResponse } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, loginThrottle, staffLoginChallenges, staffRecoveryCodes, staffUsers, type StaffUser } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/crypto.js';
import { MemoryMailer } from '../src/lib/mailer.js';
import { base32Decode, totp } from '../src/lib/totp.js';
import { recoverStaffAccess } from '../src/services/staff-recovery.js';
import { json, mintCookie } from './admin/fixtures.js';
import { createTestEnv, TEST_PASSWORD, type TestEnv } from './helpers.js';

let env: TestEnv;
const mailer = new MemoryMailer();

beforeAll(async () => {
  env = await createTestEnv({ mailer });
});
afterAll(async () => env?.close());

let seq = 0;
async function newUser(role: StaffUser['role'] = 'reviewer'): Promise<StaffUser> {
  const [u] = await env.ctx.db
    .insert(staffUsers)
    .values({ orgId: env.org.id, email: `mfa-${++seq}-${role}@test.example`, name: `MFA ${role} ${seq}`, role, passwordHash: await hashPassword(TEST_PASSWORD), createdAt: new Date(env.clock.t), updatedAt: new Date(env.clock.t) })
    .returning();
  return u;
}

// A different client address per request: the per-IP sign-in rate limit (10/min, test/security.test.ts) is not what
// these tests are about; the per-account backoff is.
let ip = 0;
const inject = (method: 'GET' | 'POST' | 'PUT', url: string, cookie?: string, payload?: unknown) =>
  env.app.inject({ method, url, remoteAddress: `10.9.${Math.floor(++ip / 250)}.${ip % 250}`, headers: cookie ? { cookie } : {}, ...(payload !== undefined ? { payload: payload as object } : {}) });
const cookieOf = (res: LightMyRequestResponse, name: string) => {
  const c = res.cookies.find((x) => x.name === name);
  return c ? `${name}=${c.value}` : null;
};
const login = (email: string, password = TEST_PASSWORD) => inject('POST', '/api/auth/login', undefined, { email, password });

/** Sets up two-step sign-in for a signed-in user; returns the secret and the recovery codes. */
async function enrol(cookie: string): Promise<{ secret: Buffer; codes: string[] }> {
  const setup = json<TotpSetupDTO>(await inject('POST', '/api/auth/mfa/totp/setup', cookie));
  const secret = base32Decode(setup.secret);
  const { codes } = json<RecoveryCodesDTO>(await inject('POST', '/api/auth/mfa/totp/confirm', cookie, { code: totp(secret, env.clock.t) }));
  return { secret, codes };
}

/** A fresh code: moves the clock to the next 30-second step first (each step's code works once). */
function nextCode(secret: Buffer): string {
  env.clock.advance(30_000);
  return totp(secret, env.clock.t);
}

async function signInWithMfa(email: string, factor: { code?: string; recoveryCode?: string }) {
  const first = await login(email);
  expect(first.statusCode, first.body).toBe(200);
  const challenge = cookieOf(first, 'sp_mfa');
  return { first, res: await inject('POST', '/api/auth/login/mfa', challenge ?? undefined, factor) };
}

describe('set-up and sign-in', () => {
  let user: StaffUser;
  let secret: Buffer;
  let codes: string[];

  it('sets up an authenticator: a pending secret, confirmed with a code; recovery codes shown once; other sessions end', async () => {
    user = await newUser('admin');
    const cookie = await mintCookie(env, user);
    const other = await mintCookie(env, user);
    const setup = json<TotpSetupDTO>(await inject('POST', '/api/auth/mfa/totp/setup', cookie));
    expect(setup).toMatchObject({ issuer: 'SmartProctoring (Test University)', account: user.email, expiresAt: env.clock.t + 15 * 60_000 });
    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.otpauthUri).toContain(`secret=${setup.secret}`);
    const [row] = await env.ctx.db.select().from(staffUsers).where(eq(staffUsers.id, user.id));
    expect(row.totpPendingEnc!.toString('latin1')).not.toContain(setup.secret); // encrypted
    expect(row.mfaEnabledAt).toBeNull();

    secret = base32Decode(setup.secret);
    expect((await inject('POST', '/api/auth/mfa/totp/confirm', cookie, { code: '000000' })).json().error).toBe('mfa_bad_code');
    const confirmed = json<RecoveryCodesDTO>(await inject('POST', '/api/auth/mfa/totp/confirm', cookie, { code: totp(secret, env.clock.t) }));
    codes = confirmed.codes;
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);

    const me = json<{ security: StaffSecurityDTO }>(await inject('GET', '/api/auth/me', cookie));
    expect(me.security).toEqual({ mfaEnabled: true, mfaEnabledAt: env.clock.t, recoveryCodesLeft: 10, mfaRequired: false, enrollmentRequired: false, signInMethod: 'password', ssoRequired: false });
    expect((await inject('GET', '/api/auth/me', other)).statusCode).toBe(401); // other browser signed out
    const stored = await env.ctx.db.select().from(staffRecoveryCodes).where(eq(staffRecoveryCodes.staffUserId, user.id));
    expect(stored.map((s) => s.codeHash).join()).not.toContain(codes[0].replace('-', ''));
    expect(mailer.sent.at(-1)).toMatchObject({ to: [user.email], subject: 'SmartProctoring: Two-step sign-in was turned on for your account' });
    const [a] = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.actorId, user.id), eq(auditLog.action, 'auth.mfa_enabled')));
    expect(a).toBeDefined();
  });

  it('signs in in two steps: no session after the password, then a code from the app', async () => {
    const first = await login(user.email);
    expect(first.json()).toEqual({ mfaRequired: true, methods: ['totp', 'recovery_code'] });
    expect(cookieOf(first, 'sp_session')).toBeNull();
    const challengeCookie = first.cookies.find((c) => c.name === 'sp_mfa')!;
    expect(challengeCookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api/auth' });
    const challenge = `sp_mfa=${challengeCookie.value}`;

    const wrong = await inject('POST', '/api/auth/login/mfa', challenge, { code: '123456' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).toBe('invalid_mfa_code');
    const code = nextCode(secret);
    const ok = await inject('POST', '/api/auth/login/mfa', challenge, { code });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ user: { id: user.id }, security: { mfaEnabled: true } });
    const session = cookieOf(ok, 'sp_session')!;
    expect(json(await inject('GET', '/api/auth/me', session)).user.id).toBe(user.id);
    // The challenge is used up.
    expect((await inject('POST', '/api/auth/login/mfa', challenge, { code })).json().error).toBe('mfa_challenge_expired');
    const [a] = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.actorId, user.id), eq(auditLog.action, 'auth.login')));
    expect(a.meta).toEqual({ mfa: 'totp' });

    // The same code again (another sign-in within its 30 seconds): refused — a code works once.
    const replay = await signInWithMfa(user.email, { code });
    expect(replay.res.json().error).toBe('invalid_mfa_code');
    expect((await signInWithMfa(user.email, { code: nextCode(secret) })).res.statusCode).toBe(200);
  });

  it('accepts each recovery code once and tells the user how many are left', async () => {
    const r = await signInWithMfa(user.email, { recoveryCode: codes[0].toLowerCase() });
    expect(r.res.statusCode, r.res.body).toBe(200);
    expect(r.res.json().security.recoveryCodesLeft).toBe(9);
    expect((await signInWithMfa(user.email, { recoveryCode: codes[0] })).res.json().error).toBe('invalid_mfa_code');
    expect(mailer.sent.at(-1)).toMatchObject({ subject: 'SmartProctoring: A recovery code was used to sign in to your account' });
    expect(mailer.sent.at(-1)!.text).toContain('You have 9 unused recovery codes left.');
    const [a] = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.actorId, user.id), eq(auditLog.action, 'auth.recovery_code_used')));
    expect(a.meta).toEqual({ left: 9 });
    expect((await inject('POST', '/api/auth/login/mfa', undefined, { code: '123456', recoveryCode: 'X' })).statusCode).toBe(400);
  });

  it('limits a challenge to 5 codes and 5 minutes; a missing or forged cookie is refused', async () => {
    const clearBackoff = () => env.ctx.db.delete(loginThrottle); // the account backoff is tested separately below
    await clearBackoff();
    const first = await login(user.email);
    const challenge = cookieOf(first, 'sp_mfa')!;
    for (let i = 0; i < 5; i++) {
      await clearBackoff();
      expect((await inject('POST', '/api/auth/login/mfa', challenge, { code: '000000' })).json().error).toBe('invalid_mfa_code');
    }
    await clearBackoff();
    expect((await inject('POST', '/api/auth/login/mfa', challenge, { code: nextCode(secret) })).json().error).toBe('mfa_challenge_expired');
    expect(await env.ctx.db.select().from(staffLoginChallenges).where(eq(staffLoginChallenges.staffUserId, user.id))).toHaveLength(0);

    const fresh = await login(user.email);
    env.clock.advance(5 * 60_000 + 1);
    expect((await inject('POST', '/api/auth/login/mfa', cookieOf(fresh, 'sp_mfa')!, { code: totp(secret, env.clock.t) })).json().error).toBe('mfa_challenge_expired');
    expect((await inject('POST', '/api/auth/login/mfa', undefined, { code: '123456' })).json().error).toBe('mfa_challenge_expired');
    expect((await inject('POST', '/api/auth/login/mfa', 'sp_mfa=forged.value', { code: '123456' })).json().error).toBe('mfa_challenge_expired');
    await clearBackoff();
  });

  it('counts every code attempt toward the account backoff, like a password attempt', async () => {
    const good = nextCode(secret); // (moves the clock first: the lock below starts after it)
    const first = await login(user.email); // failure count 1 (cleared only by a complete sign-in)
    const challenge = cookieOf(first, 'sp_mfa')!;
    for (let i = 0; i < 4; i++) expect((await inject('POST', '/api/auth/login/mfa', challenge, { code: '000000' })).json().error).toBe('invalid_mfa_code');
    // The 5th failure locks the account for 30 s: even the right code is refused meanwhile.
    const locked = await inject('POST', '/api/auth/login/mfa', challenge, { code: good });
    expect(locked.statusCode).toBe(429);
    expect(locked.headers['retry-after']).toBeDefined();
    expect((await login(user.email)).statusCode).toBe(429);
    env.clock.advance(16 * 60_000); // a quiet window resets the count
    expect((await signInWithMfa(user.email, { code: nextCode(secret) })).res.statusCode).toBe(200);
  });

  it('regenerates recovery codes with a current code (the old ones stop working)', async () => {
    const cookie = await mintCookie(env, user);
    expect((await inject('POST', '/api/auth/mfa/recovery-codes', cookie, { code: '000000' })).json().error).toBe('invalid_mfa_code');
    const { codes: fresh } = json<RecoveryCodesDTO>(await inject('POST', '/api/auth/mfa/recovery-codes', cookie, { code: nextCode(secret) }));
    expect(fresh).toHaveLength(10);
    expect((await signInWithMfa(user.email, { recoveryCode: codes[1] })).res.json().error).toBe('invalid_mfa_code');
    expect((await signInWithMfa(user.email, { recoveryCode: fresh[0] })).res.statusCode).toBe(200);
    codes = fresh.slice(1);
  });

  it('moves to a new authenticator only with the current factor', async () => {
    const cookie = await mintCookie(env, user);
    const setup = json<TotpSetupDTO>(await inject('POST', '/api/auth/mfa/totp/setup', cookie));
    const newSecret = base32Decode(setup.secret);
    expect((await inject('POST', '/api/auth/mfa/totp/confirm', cookie, { code: totp(newSecret, env.clock.t) })).json().error).toBe('mfa_current_code_required');
    expect((await inject('POST', '/api/auth/mfa/totp/confirm', cookie, { code: totp(newSecret, env.clock.t), currentCode: '000000' })).json().error).toBe('mfa_bad_current_code');
    json(await inject('POST', '/api/auth/mfa/totp/confirm', cookie, { code: totp(newSecret, env.clock.t), currentCode: codes[0] }));
    expect(mailer.sent.at(-1)!.subject).toBe('SmartProctoring: A new authenticator app was set up for your account');
    // The old app no longer works; the new one does.
    expect((await signInWithMfa(user.email, { code: nextCode(secret) })).res.json().error).toBe('invalid_mfa_code');
    expect((await signInWithMfa(user.email, { code: totp(newSecret, env.clock.t) })).res.statusCode).toBe(200);
    secret = newSecret;
  });

  it('turns off with password and code (and back to a one-step sign-in)', async () => {
    const cookie = await mintCookie(env, user);
    expect((await inject('POST', '/api/auth/mfa/disable', cookie, { password: 'wrong-password', code: nextCode(secret) })).json().error).toBe('bad_password');
    expect((await inject('POST', '/api/auth/mfa/disable', cookie, { password: TEST_PASSWORD, code: '000000' })).json().error).toBe('invalid_mfa_code');
    json(await inject('POST', '/api/auth/mfa/disable', cookie, { password: TEST_PASSWORD, code: nextCode(secret) }));
    const [row] = await env.ctx.db.select().from(staffUsers).where(eq(staffUsers.id, user.id));
    expect(row).toMatchObject({ totpSecretEnc: null, mfaEnabledAt: null, totpLastStep: null });
    expect(await env.ctx.db.select().from(staffRecoveryCodes).where(eq(staffRecoveryCodes.staffUserId, user.id))).toHaveLength(0);
    const plain = await login(user.email);
    expect(cookieOf(plain, 'sp_session')).not.toBeNull();
    expect(plain.json().security.mfaEnabled).toBe(false);
  });
});

describe('re-authentication on a signed-in account', () => {
  it('limits wrong codes and passwords per account (separately from sign-in); a password change does not reset code guessing', async () => {
    const user = await newUser('reviewer');
    const cookie = await mintCookie(env, user);
    const { secret } = await enrol(cookie);
    const regenerate = (code: string) => inject('POST', '/api/auth/mfa/recovery-codes', cookie, { code });
    const changePassword = (currentPassword: string, newPassword = 'Another-Password-456!') => inject('POST', '/api/auth/password', cookie, { currentPassword, newPassword });

    // 4 free failures, the 5th locks the code checks for 30 s.
    for (let i = 0; i < 5; i++) expect((await regenerate('000000')).json().error).toBe('invalid_mfa_code');
    const locked = await regenerate(totp(secret, env.clock.t));
    expect(locked.statusCode).toBe(429);
    expect(locked.headers['retry-after']).toBe('30');
    expect((await inject('POST', '/api/auth/mfa/disable', cookie, { password: TEST_PASSWORD, code: '000000' })).statusCode).toBe(429);
    const [throttled] = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'auth.login_failed'), eq(auditLog.targetId, user.id)));
    expect(throttled.meta).toMatchObject({ reason: 'throttled', step: 'reauth', retryAfterSec: 30 });

    // Knowing the password neither lifts that lock nor is limited by it; signing in is unaffected.
    expect((await changePassword(TEST_PASSWORD)).statusCode).toBe(200);
    expect((await regenerate(totp(secret, env.clock.t))).statusCode).toBe(429);
    const signIn = await login(user.email, 'Another-Password-456!');
    expect(signIn.statusCode, signIn.body).toBe(200);
    expect(signIn.json()).toMatchObject({ mfaRequired: true });
    env.clock.advance(30_000);
    expect((await regenerate(totp(secret, env.clock.t))).statusCode).toBe(200);
    // …and a success clears the failures: 4 more wrong codes are free again.
    for (let i = 0; i < 4; i++) expect((await regenerate('000000')).statusCode).toBe(400);
    expect((await regenerate(nextCode(secret))).statusCode).toBe(200);

    // Guessing the current password is limited the same way.
    for (let i = 0; i < 5; i++) expect((await changePassword('wrong-password-1')).json().error).toBe('bad_password');
    expect((await changePassword('Another-Password-456!', 'Third-Password-789!')).statusCode).toBe(429);
    env.clock.advance(30_000);
    expect((await changePassword('Another-Password-456!', 'Third-Password-789!')).statusCode).toBe(200);
  });
});

describe('organisation requirement', () => {
  it('only an owner sets it; staff who must use it can only set it up until they do', async () => {
    const admin = await newUser('admin');
    const reviewer = await newUser('reviewer');
    const adminCookie = await mintCookie(env, admin);
    const reviewerCookie = await mintCookie(env, reviewer);
    expect((await inject('PUT', '/api/admin/settings', adminCookie, { requireMfa: 'admins' })).json().error).toBe('owner_required');
    const ownerCookie = await mintCookie(env, env.users.owner);
    const set = json(await inject('PUT', '/api/admin/settings', ownerCookie, { requireMfa: 'admins' }));
    expect(set.requireMfa).toBe('admins');
    // The owner (without two-step sign-in) is now held to it as well.
    expect((await inject('GET', '/api/admin/sessions', ownerCookie)).json().error).toBe('mfa_enrollment_required');

    const blocked = await inject('GET', '/api/admin/sessions', adminCookie);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe('mfa_enrollment_required');
    expect(json(await inject('GET', '/api/auth/me', adminCookie)).security).toMatchObject({ mfaRequired: true, enrollmentRequired: true });
    expect((await inject('GET', '/api/admin/sessions', reviewerCookie)).statusCode).toBe(200); // reviewers not required under 'admins'

    const { secret } = await enrol(adminCookie);
    // Enrolment ended other sessions of that user, including this one? No: the current one stays.
    expect((await inject('GET', '/api/admin/sessions', adminCookie)).statusCode).toBe(200);
    // Cannot be turned off while required.
    expect((await inject('POST', '/api/auth/mfa/disable', adminCookie, { password: TEST_PASSWORD, code: nextCode(secret) })).json().error).toBe('mfa_required_by_organisation');

    // A required user signing in without it set up gets a session that can only set it up.
    const fresh = await newUser('admin');
    const res = await login(fresh.email);
    expect(res.json().security).toMatchObject({ enrollmentRequired: true });
    expect((await inject('GET', '/api/admin/exams', cookieOf(res, 'sp_session')!)).json().error).toBe('mfa_enrollment_required');

    const owner = await enrol(ownerCookie);
    json(await inject('PUT', '/api/admin/settings', ownerCookie, { requireMfa: 'everyone' }));
    expect((await inject('GET', '/api/admin/sessions', reviewerCookie)).json().error).toBe('mfa_enrollment_required');
    json(await inject('PUT', '/api/admin/settings', ownerCookie, { requireMfa: 'off' }));
    expect((await inject('GET', '/api/admin/sessions', reviewerCookie)).statusCode).toBe(200);
    const audits = await env.ctx.db.select().from(auditLog).where(eq(auditLog.action, 'settings.updated'));
    expect(audits.map((x) => (x.meta as { requireMfa?: unknown }).requireMfa).filter(Boolean)).toEqual([
      { from: 'off', to: 'admins' },
      { from: 'admins', to: 'everyone' },
      { from: 'everyone', to: 'off' },
    ]);
    void owner;
  });
});

describe('administrator reset', () => {
  it('resets another user’s two-step sign-in, ends their sessions and tells them; never an owner’s unless by an owner, never one’s own', async () => {
    const target = await newUser('reviewer');
    const targetCookie = await mintCookie(env, target);
    await enrol(targetCookie);
    const admin = await newUser('admin');
    const adminCookie = await mintCookie(env, admin);
    const reset = json(await inject('POST', `/api/admin/users/${target.id}/mfa/reset`, adminCookie));
    expect(reset).toMatchObject({ id: target.id, mfaEnabledAt: null });
    expect((await inject('GET', '/api/auth/me', targetCookie)).statusCode).toBe(401);
    expect(mailer.sent.at(-1)).toMatchObject({ to: [target.email], subject: 'SmartProctoring: Two-step sign-in was reset for your account' });
    expect(mailer.sent.at(-1)!.text).toContain(`${admin.name} reset it.`);
    const [a] = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'user.mfa_reset'), eq(auditLog.targetId, target.id)));
    expect(a.actorId).toBe(admin.id);
    expect((await inject('POST', `/api/admin/users/${target.id}/mfa/reset`, adminCookie)).json().error).toBe('mfa_not_enabled');
    expect((await inject('POST', `/api/admin/users/${admin.id}/mfa/reset`, adminCookie)).json().error).toBe('use_account_page');

    const owner2 = await newUser('owner');
    await enrol(await mintCookie(env, owner2));
    expect((await inject('POST', `/api/admin/users/${owner2.id}/mfa/reset`, adminCookie)).statusCode).toBe(403);
    expect((await inject('POST', `/api/admin/users/${owner2.id}/mfa/reset`, await mintCookie(env, env.users.owner))).statusCode).toBe(200);
    expect((await inject('POST', `/api/admin/users/${target.id}/mfa/reset`, await mintCookie(env, target))).statusCode).toBe(403);
  });
});

describe('operator recovery (staff-access CLI)', () => {
  const recover = (email: string, opts: { resetMfa?: boolean; resetPassword?: boolean } = {}) =>
    recoverStaffAccess(env.ctx, { email, resetMfa: !!opts.resetMfa, resetPassword: !!opts.resetPassword, reason: 'Ticket 42: owner called, identity checked by video' });

  it('resets the only owner’s second factor and password: sessions end, backoff and pending sign-ins cleared, audited, emailed', async () => {
    const owner = await newUser('owner');
    const cookie = await mintCookie(env, owner);
    await enrol(cookie);
    // Locked out: a pending second step and failed attempts on the account.
    expect(cookieOf(await login(owner.email), 'sp_mfa')).not.toBeNull();
    for (let i = 0; i < 5; i++) await login(owner.email, 'wrong-password-123');
    expect((await login(owner.email)).statusCode).toBe(429);
    const sentBefore = mailer.sent.length;

    const r = await recover(owner.email.toUpperCase(), { resetMfa: true, resetPassword: true });
    expect(r).toMatchObject({ user: { id: owner.id, role: 'owner' }, mfa: 'reset' });
    expect(r!.temporaryPassword).toMatch(/^[A-HJKMNP-Z2-9]{5}(-[A-HJKMNP-Z2-9]{5}){3}$/);
    expect((await inject('GET', '/api/auth/me', cookie)).statusCode).toBe(401);
    expect(await env.ctx.db.select().from(staffLoginChallenges).where(eq(staffLoginChallenges.staffUserId, owner.id))).toEqual([]);
    expect(await env.ctx.db.select().from(staffRecoveryCodes).where(eq(staffRecoveryCodes.staffUserId, owner.id))).toEqual([]);

    // The old password no longer works; the temporary one signs in directly (no second step any more).
    expect((await login(owner.email)).statusCode).toBe(401);
    const signedIn = await login(owner.email, r!.temporaryPassword!);
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    expect(signedIn.json()).toMatchObject({ user: { id: owner.id }, security: { mfaEnabled: false } });

    const audits = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.targetId, owner.id), eq(auditLog.actorType, 'system')));
    expect(audits.map((a) => a.action).sort()).toEqual(['user.mfa_reset', 'user.updated']);
    for (const a of audits) expect(a.meta).toMatchObject({ via: 'operator_cli', reason: 'Ticket 42: owner called, identity checked by video', email: owner.email });
    expect(JSON.stringify(audits)).not.toContain(r!.temporaryPassword!);
    const sent = mailer.sent.slice(sentBefore);
    expect(sent.map((m) => m.subject)).toEqual(['SmartProctoring: Two-step sign-in was reset for your account', 'SmartProctoring: The password for your account was reset']);
    for (const m of sent) {
      expect(m.to).toEqual([owner.email]);
      expect(m.text).toContain('A SmartProctoring server operator reset it');
      expect(m.text).not.toContain(r!.temporaryPassword!);
    }
  });

  it('unknown addresses and a factor that is not on change nothing', async () => {
    expect(await recover('nobody@test.example', { resetMfa: true })).toBeNull();
    const user = await newUser('admin');
    const cookie = await mintCookie(env, user);
    const r = await recover(user.email, { resetMfa: true });
    expect(r).toMatchObject({ mfa: 'not_enabled', temporaryPassword: null });
    expect((await inject('GET', '/api/auth/me', cookie)).statusCode).toBe(200);
    expect(await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.targetId, user.id), eq(auditLog.actorType, 'system')))).toEqual([]);
  });

  it('the CLI checks its arguments, requires a reason and reports unknown addresses', async () => {
    const run = promisify(execFile);
    const cli = async (...args: string[]) => {
      try {
        const r = await run(process.execPath, ['--import', 'tsx', 'src/scripts/staff-access-cli.ts', ...args], {
          cwd: new URL('..', import.meta.url).pathname,
          env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: env.config.databaseUrl, EVIDENCE_KEY: env.config.evidenceKey.toString('base64'), LOG_LEVEL: 'silent', SMTP_HOST: '' },
        });
        return { code: 0, out: r.stdout, err: r.stderr };
      } catch (err) {
        const x = err as { code: number; stdout: string; stderr: string };
        return { code: x.code, out: x.stdout, err: x.stderr };
      }
    };
    expect((await cli('--email', 'a@b.example', '--reason', 'Ticket 42: checked by video')).code).toBe(2); // nothing to do
    expect((await cli('--email', 'a@b.example', '--reset-mfa')).code).toBe(2); // no reason
    expect((await cli('--email', 'a@b.example', '--reset-mfa', '--reason', 'short')).code).toBe(2);
    expect((await cli('--reset-mfa', '--reason', 'Ticket 42: checked by video')).code).toBe(2); // no address
    expect((await cli('--bogus')).code).toBe(2);
    expect((await cli('--email', 'nobody@test.example', '--reset-mfa', '--reason', 'Ticket 42: checked by video')).code).toBe(4);

    const user = await newUser('owner');
    const r = await cli('--email', user.email, '--reset-password', '--reason', 'Ticket 43: checked by video', '--json');
    expect(r.code, r.err).toBe(0);
    const out = JSON.parse(r.out) as { mfa: string; temporaryPassword: string; user: { id: string } };
    expect(out).toMatchObject({ mfa: 'unchanged', user: { id: user.id } });
    expect((await login(user.email, out.temporaryPassword)).statusCode).toBe(200);
  });
});

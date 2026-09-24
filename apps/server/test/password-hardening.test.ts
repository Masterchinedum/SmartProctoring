/**
 * Security review #9: scrypt N=2^17 with transparent rehash of older hashes at login, and per-account
 * failed-login backoff (independent of the client IP, identical for unknown addresses), audited without the password.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, loginThrottle, staffUsers } from '../src/db/schema.js';
import { hashPassword, passwordNeedsRehash, SCRYPT_PARAMS, verifyPassword } from '../src/lib/crypto.js';
import { lockDelayMs, loginThrottleKey } from '../src/services/login-throttle.js';
import { staffApi } from './admin/fixtures.js';
import { createTestEnv, TEST_PASSWORD, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env?.close();
});

let ipCounter = 0;
/** Each call comes from a different client address: the backoff must not depend on the IP. */
function login(email: string, password: string) {
  ipCounter++;
  return env.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: `10.9.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`, payload: { email, password } });
}

describe('scrypt parameters', () => {
  it('hashes new passwords with N=2^17, r=8, p=1 and still verifies older N=2^15 hashes', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h.startsWith(`scrypt$${1 << 17}$8$1$`)).toBe(true);
    expect(SCRYPT_PARAMS).toEqual({ N: 1 << 17, r: 8, p: 1 });
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(passwordNeedsRehash(h)).toBe(false);

    const old = await hashPassword('legacy pass', { N: 1 << 15, r: 8, p: 1 });
    expect(old.startsWith(`scrypt$${1 << 15}$8$1$`)).toBe(true);
    expect(await verifyPassword('legacy pass', old)).toBe(true);
    expect(passwordNeedsRehash(old)).toBe(true);
  });

  it('runs many derivations through the two-slot limiter without stalling', async () => {
    const hashes = await Promise.all(Array.from({ length: 7 }, (_, i) => hashPassword(`pw-${i}`, { N: 1 << 10, r: 8, p: 1 })));
    expect(new Set(hashes).size).toBe(7);
    expect(await Promise.all(hashes.map((h, i) => verifyPassword(`pw-${i}`, h)))).toEqual(Array(7).fill(true));
  });

  it('refuses malformed or memory-exhausting stored parameters without deriving', async () => {
    const [, , , , salt, hash] = (await hashPassword('x')).split('$');
    for (const bad of [`scrypt$${1 << 21}$8$1$${salt}$${hash}`, `scrypt$${1 << 20}$8$1$${salt}$${hash}`, `scrypt$100000$8$1$${salt}$${hash}`, `scrypt$16384$64$1$${salt}$${hash}`, `scrypt$16384$8$0$${salt}$${hash}`, 'garbage', `bcrypt$1$2$3$${salt}$${hash}`]) {
      expect(await verifyPassword('x', bad), bad).toBe(false);
      expect(passwordNeedsRehash(bad)).toBe(true);
    }
  });

  it('upgrades an outdated hash at the next successful login (the password keeps working)', async () => {
    const old = await hashPassword(TEST_PASSWORD, { N: 1 << 15, r: 8, p: 1 });
    await env.ctx.db.update(staffUsers).set({ passwordHash: old }).where(eq(staffUsers.id, env.users.reviewer.id));
    const before = (await env.ctx.db.select().from(staffUsers).where(eq(staffUsers.id, env.users.reviewer.id)))[0];

    const r = await login('reviewer@test.example', TEST_PASSWORD);
    expect(r.statusCode, r.body).toBe(200);
    const after = (await env.ctx.db.select().from(staffUsers).where(eq(staffUsers.id, env.users.reviewer.id)))[0];
    expect(after.passwordHash).not.toBe(old);
    expect(after.passwordHash.startsWith(`scrypt$${1 << 17}$8$1$`)).toBe(true);
    expect(after.passwordChangedAt?.getTime() ?? null).toBe(before.passwordChangedAt?.getTime() ?? null);
    expect((await login('reviewer@test.example', TEST_PASSWORD)).statusCode).toBe(200);

    // A failed login never rehashes.
    await env.ctx.db.update(staffUsers).set({ passwordHash: old }).where(eq(staffUsers.id, env.users.reviewer.id));
    expect((await login('reviewer@test.example', 'not-the-password')).statusCode).toBe(401);
    expect((await env.ctx.db.select().from(staffUsers).where(eq(staffUsers.id, env.users.reviewer.id)))[0].passwordHash).toBe(old);
    await env.ctx.db.delete(loginThrottle);
  });
});

describe('per-account failed-login backoff', () => {
  it('delays 30 s → 15 min exponentially from the 5th failure', () => {
    expect([1, 2, 3, 4].map(lockDelayMs)).toEqual([0, 0, 0, 0]);
    expect(lockDelayMs(5)).toBe(30_000);
    expect(lockDelayMs(6)).toBe(60_000);
    expect(lockDelayMs(9)).toBe(480_000);
    expect(lockDelayMs(10)).toBe(900_000);
    expect(lockDelayMs(50)).toBe(900_000);
  });

  it('locks the account (not the IP) after 5 failures in a row, even for the right password, and escalates', async () => {
    const email = 'admin@test.example';
    for (let i = 1; i <= 5; i++) {
      const r = await login(email, `wrong-${i}`);
      expect(r.statusCode, `attempt ${i}`).toBe(401);
      expect(r.json().error).toBe('unauthorized');
    }
    // Locked for 30 s: even the correct password from a fresh IP is refused without being checked.
    const locked = await login(email, TEST_PASSWORD);
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toMatchObject({ error: 'too_many_attempts', details: { retryAfterSec: 30 } });
    expect(locked.json().message).toMatch(/Try again in 30 seconds/);
    expect(locked.headers['retry-after']).toBe('30');
    // Attempts while locked do not extend the lock.
    env.clock.advance(20_000);
    expect((await login(email, 'wrong-again')).statusCode).toBe(429);
    env.clock.advance(11_000);
    // 6th counted failure => 60 s.
    expect((await login(email, 'wrong-6')).statusCode).toBe(401);
    const l2 = await login(email, TEST_PASSWORD);
    expect(l2.statusCode).toBe(429);
    expect(l2.json().details.retryAfterSec).toBe(60);
    env.clock.advance(61_000);
    // The right password after the lock: signed in, and the counter is gone.
    const ok = await login(email, TEST_PASSWORD);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await env.ctx.db.select().from(loginThrottle).where(eq(loginThrottle.key, loginThrottleKey(email)))).toHaveLength(0);
    for (let i = 1; i <= 4; i++) expect((await login(email, 'wrong')).statusCode).toBe(401);
    expect((await login(email, TEST_PASSWORD)).statusCode).toBe(200);
  });

  it('treats unknown addresses exactly like registered ones (no enumeration)', async () => {
    const known = 'owner@test.example';
    const unknown = 'nobody-here@test.example';
    const bodies: Record<string, string[]> = { known: [], unknown: [] };
    for (let i = 0; i < 6; i++) {
      const a = await login(known, 'wrong-pass');
      const b = await login(unknown, 'wrong-pass');
      expect(a.statusCode).toBe(b.statusCode);
      bodies.known.push(a.body);
      bodies.unknown.push(b.body);
    }
    expect(bodies.known).toEqual(bodies.unknown);
    expect(JSON.parse(bodies.unknown[5]).error).toBe('too_many_attempts');
    env.clock.advance(16 * 60_000);
    await env.ctx.db.delete(loginThrottle);
  });

  it('forgets failures after 15 quiet minutes', async () => {
    const email = 'owner@test.example';
    for (let i = 0; i < 4; i++) expect((await login(email, 'wrong')).statusCode).toBe(401);
    env.clock.advance(15 * 60_000 + 1000);
    for (let i = 0; i < 4; i++) expect((await login(email, 'wrong')).statusCode).toBe(401);
    expect((await login(email, TEST_PASSWORD)).statusCode).toBe(200);
  });

  it('cannot be bypassed with a burst of parallel attempts', async () => {
    const email = 'reviewer@test.example';
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => login(email, `burst-${i}`)));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401).length).toBe(5);
    expect(codes.filter((c) => c === 429).length).toBe(7);
    env.clock.advance(16 * 60_000);
    await env.ctx.db.delete(loginThrottle);
  });

  it('audits failed and throttled logins without the password; an admin password reset lifts the backoff', async () => {
    const email = 'reviewer@test.example';
    const secret = 'Sup3r-Secret-Guess!';
    for (let i = 0; i < 6; i++) await login(email, secret);
    const rows = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'auth.login_failed'), eq(auditLog.targetId, env.users.reviewer.id)));
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows.map((r) => (r.meta as { reason: string }).reason)).toContain('throttled');
    expect(rows.find((r) => (r.meta as { failures?: number }).failures === 5)?.meta).toMatchObject({ reason: 'bad_password', lockedUntil: expect.any(Number) });
    for (const r of rows) expect(JSON.stringify(r)).not.toContain(secret);
    expect((await login(email, TEST_PASSWORD)).statusCode).toBe(429);

    const owner = await staffApi(env, 'owner');
    const reset = await owner.inject({ method: 'PUT', url: `/api/admin/users/${env.users.reviewer.id}`, payload: { password: 'A-brand-new-pass-1' } });
    expect(reset.statusCode, reset.body).toBe(200);
    expect((await login(email, 'A-brand-new-pass-1')).statusCode).toBe(200);
  });
});

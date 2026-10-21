/**
 * Per-account failed-login backoff (security review #9), independent of the client IP (the per-IP rate limit is
 * separate) and shared by every server instance (Postgres).
 *
 * The key is the normalised email address that was TRIED, whether or not an account exists, so throttling
 * behaves identically for registered and unknown addresses (no account enumeration).
 *
 *  - Every attempt is charged BEFORE the password is checked (atomic upsert under the row lock), so a burst of
 *    parallel requests cannot slip past the limit; a successful login clears the row.
 *  - Up to LOGIN_FREE_FAILURES consecutive failures are free. From the 5th on, the address is locked for
 *    30 s · 2^(failures − 5), capped at 15 min. While locked, attempts are refused with 429 without checking the
 *    password and are NOT counted (they cannot extend the lock).
 *  - The counter resets after LOGIN_FAILURE_WINDOW_MS (15 min) without a failed attempt.
 *
 * Scopes: `login` is the sign-in (password and second step). Re-authentication on a signed-in account has its own
 * counters, so a session left open (or stolen) cannot be used to guess faster: `password` (changing the password)
 * and `reauth` (a code or recovery code to manage two-step sign-in). They are separate so that knowing one secret
 * never resets the counter of another (a successful password change does not reset code guessing).
 */
import { and, eq, inArray, lt, lte, or, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/index.js';
import { loginThrottle } from '../db/schema.js';
import { sha256Hex } from '../lib/crypto.js';

export const LOGIN_FAILURE_WINDOW_MS = 15 * 60_000;
export const LOGIN_FREE_FAILURES = 4;
export const LOGIN_LOCK_AFTER_FAILURES = LOGIN_FREE_FAILURES + 1;
export const LOGIN_BASE_DELAY_MS = 30_000;
export const LOGIN_MAX_DELAY_MS = 15 * 60_000;
/** Rows untouched for this long are deleted by the cleanup job. */
export const LOGIN_THROTTLE_RETENTION_MS = 24 * 3600_000;

export type ThrottleScope = 'login' | 'password' | 'reauth';
export const THROTTLE_SCOPES: readonly ThrottleScope[] = ['login', 'password', 'reauth'];

export function loginThrottleKey(email: string, scope: ThrottleScope = 'login'): string {
  return sha256Hex(`${scope}:${email.trim().toLowerCase()}`);
}

/** Lock duration after the n-th consecutive failure (0 = no lock). */
export function lockDelayMs(failures: number): number {
  if (failures < LOGIN_LOCK_AFTER_FAILURES) return 0;
  const exp = Math.min(30, failures - LOGIN_LOCK_AFTER_FAILURES);
  return Math.min(LOGIN_MAX_DELAY_MS, LOGIN_BASE_DELAY_MS * 2 ** exp);
}

export type LoginAdmission = { admitted: true; failures: number; lockedUntil: number | null } | { admitted: false; retryAfterMs: number };

/**
 * Charge one attempt for `email` (counted as a failure until clearLoginFailures() is called after a successful
 * login). Refused while the address is locked.
 */
export async function admitLoginAttempt(db: DbOrTx, email: string, now: number, scope: ThrottleScope = 'login'): Promise<LoginAdmission> {
  const key = loginThrottleKey(email, scope);
  const nowD = new Date(now);
  const windowStart = new Date(now - LOGIN_FAILURE_WINDOW_MS);
  // failures' = 1 after a quiet window, else failures + 1; lock computed from failures' in the same statement.
  const next = sql<number>`CASE WHEN ${loginThrottle.lastFailureAt} < ${windowStart} THEN 1 ELSE ${loginThrottle.failures} + 1 END`;
  const exp = sql`LEAST(30, GREATEST(0, (${next}) - ${LOGIN_LOCK_AFTER_FAILURES}))`;
  const lockedUntil = sql`CASE WHEN (${next}) >= ${LOGIN_LOCK_AFTER_FAILURES}
    THEN ${nowD}::timestamptz + make_interval(secs => LEAST(${LOGIN_MAX_DELAY_MS / 1000}::double precision, ${LOGIN_BASE_DELAY_MS / 1000}::double precision * power(2, ${exp})))
    ELSE NULL END`;
  const rows = await db
    .insert(loginThrottle)
    .values({ key, failures: 1, lastFailureAt: nowD, lockedUntil: lockDelayMs(1) ? new Date(now + lockDelayMs(1)) : null })
    .onConflictDoUpdate({
      target: loginThrottle.key,
      set: { failures: next, lastFailureAt: nowD, lockedUntil },
      setWhere: or(isNull(loginThrottle.lockedUntil), lte(loginThrottle.lockedUntil, nowD)),
    })
    .returning({ failures: loginThrottle.failures, lockedUntil: loginThrottle.lockedUntil });
  if (rows[0]) return { admitted: true, failures: rows[0].failures, lockedUntil: rows[0].lockedUntil?.getTime() ?? null };
  const [row] = await db.select({ lockedUntil: loginThrottle.lockedUntil }).from(loginThrottle).where(eq(loginThrottle.key, key));
  const until = row?.lockedUntil?.getTime() ?? now + 1000;
  return { admitted: false, retryAfterMs: Math.max(1000, until - now) };
}

/** After a successful login (or a password reset): forget the address's failures (in `scopes`). */
export async function clearLoginFailures(db: DbOrTx, email: string, scopes: readonly ThrottleScope[] = ['login']): Promise<void> {
  await db.delete(loginThrottle).where(inArray(loginThrottle.key, scopes.map((s) => loginThrottleKey(email, s))));
}

/** Delete rows without activity for a day whose lock has expired (the table only needs recent attempts). */
export async function purgeStaleLoginThrottles(db: DbOrTx, now: number): Promise<number> {
  const cutoff = new Date(now - LOGIN_THROTTLE_RETENTION_MS);
  const rows = await db
    .delete(loginThrottle)
    .where(and(lt(loginThrottle.lastFailureAt, cutoff), or(isNull(loginThrottle.lockedUntil), lt(loginThrottle.lockedUntil, new Date(now)))))
    .returning({ key: loginThrottle.key });
  return rows.length;
}

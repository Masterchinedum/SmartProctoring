/**
 * Single sign-on attempts and account resolution (routes/sso.ts).
 *
 * Attempts: a row per sign-in sent to a provider (10 minutes, used once), bound to the browser that started it by the
 * signed, httpOnly `sp_sso` cookie (SameSite=Lax, path /api/auth/sso; only sha256 of its value is stored). The OIDC
 * callback (a top-level GET) and the SAML completion step check it, so a response cannot be replayed into another
 * browser (login CSRF) and a sign-in cannot be finished elsewhere.
 *
 * Accounts (resolveSsoUser), fail closed:
 *  1. the asserted email must belong to one of the provider's claimed domains (and, for OIDC providers that require it,
 *     carry email_verified = true);
 *  2. an identity already linked to an account (provider + subject) signs in that account;
 *  3. otherwise the account with that email (case-insensitive) in the provider's organisation is linked — unless it is
 *     already linked to another subject at this provider (a re-used address) — or, with just-in-time accounts on, a
 *     new account is created with the mapped / default role (never owner) and no password;
 *  4. disabled accounts never sign in. Accounts of other organisations are never touched.
 */
import { emailDomain, type SsoErrorCode } from '@sp/shared';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../../context.js';
import { ssoDomains, ssoLoginAttempts, ssoSamlAssertions, staffSsoIdentities, staffUsers, type IdentityProvider, type SsoAttemptIdentity, type SsoLoginAttempt, type StaffUser } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { NO_PASSWORD_HASH, randomToken, safeEqual, sha256Hex } from '../../lib/crypto.js';
import { jitRole } from './providers.js';

export const SSO_COOKIE = 'sp_sso';
export const SSO_COOKIE_PATH = '/api/auth/sso';
export const SSO_ATTEMPT_TTL_MS = 10 * 60_000;

/** A sign-in that cannot complete: `code` is shown to the person (SSO_ERROR_MESSAGES), `reason` goes to the audit log. */
export class SsoFailure extends Error {
  constructor(
    readonly code: SsoErrorCode,
    readonly reason: string,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(`${code}: ${reason}`);
    this.name = 'SsoFailure';
  }
}

/** Only in-app staff paths (no open redirect), as the sign-in page does. */
export function safeReturnPath(next: unknown): string {
  if (typeof next === 'string' && next.startsWith('/admin') && !next.startsWith('//') && !next.startsWith('/admin/login') && !/[\\\r\n]/.test(next) && next.length <= 500) return next;
  return '/admin';
}

export async function createAttempt(
  ctx: Pick<Ctx, 'db' | 'config' | 'now'>,
  reply: FastifyReply,
  provider: IdentityProvider,
  fields: { state?: string; nonce?: string; codeVerifier?: string; samlRequestId?: string; returnTo: string; ip: string },
): Promise<SsoLoginAttempt> {
  const binding = randomToken(32);
  const now = ctx.now();
  const [row] = await ctx.db
    .insert(ssoLoginAttempts)
    .values({
      providerId: provider.id,
      orgId: provider.orgId,
      browserHash: sha256Hex(binding),
      stateHash: fields.state ? sha256Hex(fields.state) : null,
      nonce: fields.nonce ?? null,
      codeVerifier: fields.codeVerifier ?? null,
      samlRequestId: fields.samlRequestId ?? null,
      returnTo: fields.returnTo,
      ip: fields.ip,
      createdAt: new Date(now),
      expiresAt: new Date(now + SSO_ATTEMPT_TTL_MS),
    })
    .returning();
  reply.setCookie(SSO_COOKIE, binding, { signed: true, httpOnly: true, sameSite: 'lax', secure: ctx.config.cookieSecure, path: SSO_COOKIE_PATH, maxAge: Math.floor(SSO_ATTEMPT_TTL_MS / 1000) });
  return row;
}

/** The browser presenting this request is the one that started the attempt. */
export function browserMatches(req: FastifyRequest, attempt: Pick<SsoLoginAttempt, 'browserHash'>): boolean {
  const raw = req.cookies?.[SSO_COOKIE];
  const un = raw ? req.unsignCookie(raw) : null;
  if (!un?.valid || !un.value) return false;
  return safeEqual(sha256Hex(un.value), attempt.browserHash);
}

export function clearSsoCookie(reply: FastifyReply): void {
  reply.clearCookie(SSO_COOKIE, { path: SSO_COOKIE_PATH });
}

export async function attemptByState(ctx: Pick<Ctx, 'db'>, providerId: string, state: string): Promise<SsoLoginAttempt | null> {
  const [row] = await ctx.db
    .select()
    .from(ssoLoginAttempts)
    .where(and(eq(ssoLoginAttempts.stateHash, sha256Hex(state)), eq(ssoLoginAttempts.providerId, providerId)));
  return row ?? null;
}

export async function attemptBySamlRequest(ctx: Pick<Ctx, 'db'>, providerId: string, requestId: string): Promise<SsoLoginAttempt | null> {
  const [row] = await ctx.db
    .select()
    .from(ssoLoginAttempts)
    .where(and(eq(ssoLoginAttempts.samlRequestId, requestId), eq(ssoLoginAttempts.providerId, providerId)));
  return row ?? null;
}

/** Move an attempt from one status to the next exactly once (compare-and-set), while it has not expired. */
export async function transitionAttempt(
  ctx: Pick<Ctx, 'db' | 'now'>,
  id: string,
  from: SsoLoginAttempt['status'],
  to: SsoLoginAttempt['status'],
  patch: Partial<Pick<SsoLoginAttempt, 'identity'>> = {},
): Promise<SsoLoginAttempt | null> {
  const [row] = await ctx.db
    .update(ssoLoginAttempts)
    .set({ status: to, ...patch })
    .where(and(eq(ssoLoginAttempts.id, id), eq(ssoLoginAttempts.status, from), sql`${ssoLoginAttempts.expiresAt} > ${new Date(ctx.now())}`))
    .returning();
  return row ?? null;
}

/** Remember a SAML assertion ID; false when it was used before (replay). */
export async function recordAssertion(ctx: Pick<Ctx, 'db'>, providerId: string, assertionId: string, expiresAt: number): Promise<boolean> {
  const rows = await ctx.db
    .insert(ssoSamlAssertions)
    .values({ providerId, assertionId, expiresAt: new Date(expiresAt) })
    .onConflictDoNothing()
    .returning({ id: ssoSamlAssertions.assertionId });
  return rows.length === 1;
}

/** Housekeeping: attempts and remembered assertion IDs past their time. */
export async function purgeExpiredSsoState(ctx: Pick<Ctx, 'db'>, now: number): Promise<void> {
  await ctx.db.delete(ssoLoginAttempts).where(lt(ssoLoginAttempts.expiresAt, new Date(now - 60_000)));
  await ctx.db.delete(ssoSamlAssertions).where(lt(ssoSamlAssertions.expiresAt, new Date(now)));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ResolvedSsoUser {
  user: StaffUser;
  created: boolean;
  linked: boolean;
}

/** Find (or link, or create) the staff account for a validated identity. Throws SsoFailure. */
export async function resolveSsoUser(ctx: Pick<Ctx, 'db' | 'now'>, provider: IdentityProvider, identity: SsoAttemptIdentity, ip: string): Promise<ResolvedSsoUser> {
  const email = identity.email?.trim().toLowerCase() ?? '';
  if (!identity.subject) throw new SsoFailure('sso_failed', 'no_subject');
  if (!EMAIL_RE.test(email) || email.length > 254) throw new SsoFailure('sso_failed', 'no_email', { subject: identity.subject });
  const domain = emailDomain(email);
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    // Same lock as user management (last-owner checks, SCIM): one change to the organisation's accounts at a time.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'staff-users:' + provider.orgId}))`);
    const [claimed] = domain
      ? await tx
          .select()
          .from(ssoDomains)
          .where(and(eq(ssoDomains.providerId, provider.id), eq(ssoDomains.domain, domain)))
      : [];
    if (!claimed) throw new SsoFailure('sso_domain_not_allowed', 'domain_not_allowed', { email });
    if (provider.kind === 'oidc' && provider.oidcRequireVerifiedEmail && identity.emailVerified !== true) throw new SsoFailure('sso_email_unverified', 'email_not_verified', { email });

    const [link] = await tx
      .select()
      .from(staffSsoIdentities)
      .where(and(eq(staffSsoIdentities.providerId, provider.id), eq(staffSsoIdentities.subject, identity.subject)));
    let user: StaffUser | undefined;
    let created = false;
    let linked = false;
    if (link) {
      [user] = await tx
        .select()
        .from(staffUsers)
        .where(and(eq(staffUsers.id, link.staffUserId), eq(staffUsers.orgId, provider.orgId)));
      if (!user) throw new SsoFailure('sso_no_account', 'link_without_account', { email });
      if (user.disabled) throw new SsoFailure('sso_account_disabled', 'disabled', { email, userId: user.id });
    } else {
      [user] = await tx
        .select()
        .from(staffUsers)
        .where(eq(sql`lower(${staffUsers.email})`, email));
      if (user && user.orgId !== provider.orgId) throw new SsoFailure('sso_no_account', 'other_organisation', { email });
      if (user) {
        if (user.disabled) throw new SsoFailure('sso_account_disabled', 'disabled', { email, userId: user.id });
        const [other] = await tx
          .select({ id: staffSsoIdentities.id })
          .from(staffSsoIdentities)
          .where(and(eq(staffSsoIdentities.staffUserId, user.id), eq(staffSsoIdentities.providerId, provider.id)));
        if (other) throw new SsoFailure('sso_identity_mismatch', 'subject_mismatch', { email, userId: user.id });
      } else {
        if (!provider.jitEnabled) throw new SsoFailure('sso_no_account', 'no_account', { email });
        const role = jitRole(provider, identity.groups);
        const name = (identity.name ?? '').trim().slice(0, 200) || email.split('@')[0];
        [user] = await tx
          .insert(staffUsers)
          .values({ orgId: provider.orgId, email, name, role, passwordHash: NO_PASSWORD_HASH, provisionedVia: 'sso', createdAt: new Date(now), updatedAt: new Date(now) })
          .onConflictDoNothing()
          .returning();
        if (!user) throw new SsoFailure('sso_no_account', 'email_taken', { email });
        created = true;
        await audit(tx, { orgId: provider.orgId, actorType: 'system', action: 'user.created', targetType: 'staff_user', targetId: user.id, meta: { email, role, via: 'sso', provider: provider.id }, ip, at: now });
      }
      await tx.insert(staffSsoIdentities).values({ staffUserId: user.id, providerId: provider.id, subject: identity.subject, email, createdAt: new Date(now) });
      linked = true;
      await audit(tx, { orgId: provider.orgId, actorType: 'system', action: 'user.sso_linked', targetType: 'staff_user', targetId: user.id, meta: { email, provider: provider.id, kind: provider.kind }, ip, at: now });
    }
    await tx
      .update(staffSsoIdentities)
      .set({ lastLoginAt: new Date(now), email })
      .where(and(eq(staffSsoIdentities.providerId, provider.id), eq(staffSsoIdentities.subject, identity.subject)));
    await tx.update(staffUsers).set({ lastLoginAt: new Date(now) }).where(eq(staffUsers.id, user.id));
    return { user, created, linked };
  });
}

/**
 * Staff single sign-on, prefix /api/auth/sso (no staff session needed). Services: src/services/sso/*.
 *
 *   POST /discover {email, next?}             -> SsoDiscoverResponse | 404 sso_not_configured   (provider from the email domain)
 *   GET  /:providerId/start?next=&login_hint= -> 302 to the identity provider (sets the sp_sso browser-binding cookie)
 *   GET  /oidc/:providerId/callback           -> OIDC redirect URI: 303 to `next` signed in, or to /admin/login?sso_error=<code>
 *   POST /saml/:providerId/acs                -> SAML assertion consumer service (HTTP-POST, form encoded): 303 to /complete
 *   GET  /complete?attempt=<id>               -> finishes a validated SAML sign-in in the browser that started it
 *   GET  /saml/:providerId/metadata           -> SP metadata (XML)
 *
 * CSRF: the ACS is a cross-site POST by design (the identity provider's page posts the response). It is the only route
 * of the server with a form-encoded body parser (registered in its own plugin scope below; every other route still
 * answers 415 to form posts), it carries no cookie authority (SameSite=Lax cookies are not sent with it) and only
 * stores the validated identity on its attempt; the sign-in is completed by a same-site GET that must present the
 * browser-binding cookie of the browser that started it. Every failure redirects to the sign-in page with a general
 * code (SSO_ERROR_MESSAGES) and is audited (`auth.sso_failed`, with the precise reason).
 */
import { emailDomain, ssoDiscoverSchema, type SsoDiscoverResponse, type SsoErrorCode } from '@sp/shared';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { startStaffSession } from '../auth/staff.js';
import { identityProviders, ssoLoginAttempts, type IdentityProvider, type SsoLoginAttempt, type SsoAttemptIdentity } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/errors.js';
import { errorText, oidcAuthorizationUrl, oidcCallback } from '../services/sso/oidc.js';
import { providerForDomain } from '../services/sso/providers.js';
import { newSamlRequestId, samlAuthorizationUrl, samlServiceProviderMetadata, SamlValidationError, validateSamlResponse } from '../services/sso/saml.js';
import {
  attemptBySamlRequest,
  attemptByState,
  browserMatches,
  clearSsoCookie,
  createAttempt,
  purgeExpiredSsoState,
  recordAssertion,
  resolveSsoUser,
  safeReturnPath,
  SsoFailure,
  transitionAttempt,
} from '../services/sso/login.js';
import { isUuid } from './admin/common.js';

/** Largest SAMLResponse form body accepted (responses with several certificates and attributes stay well below). */
export const SAML_ACS_BODY_LIMIT = 512 * 1024;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const ssoRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const perMinute = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute' } });

  ctx.jobs.register({ name: 'sso-cleanup', intervalMs: 3_600_000, runAtStart: false, run: async (c) => purgeExpiredSsoState(c, c.now()) });

  const loadById = async (id: unknown): Promise<IdentityProvider | null> => {
    if (!isUuid(id)) return null;
    const [p] = await ctx.db.select().from(identityProviders).where(eq(identityProviders.id, id.toLowerCase()));
    return p ?? null;
  };

  /** Audit, forget the browser binding, back to the sign-in page with a general message. */
  const fail = async (req: FastifyRequest, reply: FastifyReply, provider: IdentityProvider | null, code: SsoErrorCode, reason: string, meta: Record<string, unknown> = {}) => {
    const { userId, ...rest } = meta as { userId?: string } & Record<string, unknown>;
    await audit(ctx.db, {
      orgId: provider?.orgId ?? null,
      actorType: 'staff',
      actorId: userId ?? null,
      action: 'auth.sso_failed',
      targetType: 'identity_provider',
      targetId: provider?.id ?? null,
      meta: { reason, code, ...(provider ? { kind: provider.kind } : {}), ...rest },
      ip: req.ip,
      at: ctx.now(),
    });
    clearSsoCookie(reply);
    return reply.redirect(`/admin/login?sso_error=${code}`, 303);
  };

  /** Account resolution, the staff session (no local second step: the provider handles it) and the audit entry. */
  const finish = async (req: FastifyRequest, reply: FastifyReply, provider: IdentityProvider, identity: SsoAttemptIdentity, attempt: SsoLoginAttempt) => {
    let resolved;
    try {
      resolved = await resolveSsoUser(ctx, provider, identity, req.ip);
    } catch (err) {
      if (err instanceof SsoFailure) return fail(req, reply, provider, err.code, err.reason, err.meta);
      throw err;
    }
    clearSsoCookie(reply);
    await startStaffSession(ctx, reply, resolved.user, req, { method: 'sso', ssoProviderId: provider.id });
    await audit(ctx.db, {
      orgId: provider.orgId,
      actorType: 'staff',
      actorId: resolved.user.id,
      action: 'auth.login',
      targetType: 'staff_user',
      targetId: resolved.user.id,
      meta: { method: 'sso', provider: provider.id, kind: provider.kind, ...(resolved.created ? { accountCreated: true } : {}) },
      ip: req.ip,
      at: ctx.now(),
    });
    return reply.redirect(attempt.returnTo, 303);
  };

  app.post('/discover', { config: perMinute(10) }, async (req): Promise<SsoDiscoverResponse> => {
    const body = ssoDiscoverSchema.parse(req.body ?? {});
    const email = body.email.toLowerCase();
    const domain = emailDomain(email);
    const provider = domain ? await providerForDomain(ctx.db, domain) : null;
    if (!provider) throw new HttpError(404, 'sso_not_configured', 'Single sign-on is not set up for this email address. Sign in with your password, or ask your administrator.');
    const q = new URLSearchParams({ login_hint: email, next: safeReturnPath(body.next) });
    return { providerName: provider.name, startUrl: `/api/auth/sso/${provider.id}/start?${q}` };
  });

  app.get('/:providerId/start', { config: perMinute(20) }, async (req, reply) => {
    const params = req.params as { providerId: string };
    const query = req.query as Record<string, unknown>;
    const provider = await loadById(params.providerId);
    if (!provider) return fail(req, reply, null, 'sso_unavailable', 'unknown_provider');
    if (!provider.enabled) return fail(req, reply, provider, 'sso_unavailable', 'provider_disabled');
    const returnTo = safeReturnPath(query.next);
    const hint = typeof query.login_hint === 'string' && EMAIL_RE.test(query.login_hint) && query.login_hint.length <= 254 ? query.login_hint : undefined;
    if (provider.kind === 'oidc') {
      let start;
      try {
        start = await oidcAuthorizationUrl(ctx, provider, hint);
      } catch (err) {
        return fail(req, reply, provider, 'sso_provider_error', 'discovery_failed', { detail: errorText(err) });
      }
      await createAttempt(ctx, reply, provider, { state: start.state, nonce: start.nonce, codeVerifier: start.codeVerifier, returnTo, ip: req.ip });
      return reply.redirect(start.url, 302);
    }
    const requestId = newSamlRequestId();
    let url: string;
    try {
      url = await samlAuthorizationUrl(ctx, provider, requestId);
    } catch (err) {
      return fail(req, reply, provider, 'sso_unavailable', 'saml_request_failed', { detail: errorText(err) });
    }
    await createAttempt(ctx, reply, provider, { samlRequestId: requestId, returnTo, ip: req.ip });
    return reply.redirect(url, 302);
  });

  app.get('/oidc/:providerId/callback', { config: perMinute(20) }, async (req, reply) => {
    const params = req.params as { providerId: string };
    const query = Object.fromEntries(Object.entries((req.query ?? {}) as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
    const provider = await loadById(params.providerId);
    if (!provider || provider.kind !== 'oidc') return fail(req, reply, null, 'sso_failed', 'unknown_provider');
    if (!provider.enabled) return fail(req, reply, provider, 'sso_unavailable', 'provider_disabled');
    const state = query.state;
    const attempt = state && state.length <= 200 ? await attemptByState(ctx, provider.id, state) : null;
    if (!attempt || attempt.status !== 'pending' || attempt.expiresAt.getTime() <= ctx.now()) return fail(req, reply, provider, 'sso_expired', attempt ? 'attempt_used_or_expired' : 'unknown_state');
    if (!browserMatches(req, attempt)) return fail(req, reply, provider, 'sso_expired', 'other_browser');
    // One use only, whatever happens next.
    if (!(await transitionAttempt(ctx, attempt.id, 'pending', 'done'))) return fail(req, reply, provider, 'sso_expired', 'attempt_used_or_expired');
    if (query.error) return fail(req, reply, provider, 'sso_cancelled', 'provider_error', { error: query.error.slice(0, 100), ...(query.error_description ? { description: query.error_description.slice(0, 200) } : {}) });
    let identity: SsoAttemptIdentity;
    try {
      identity = await oidcCallback(ctx, provider, query, { state: state!, nonce: attempt.nonce!, codeVerifier: attempt.codeVerifier! });
    } catch (err) {
      return fail(req, reply, provider, 'sso_failed', 'token_rejected', { detail: errorText(err) });
    }
    return finish(req, reply, provider, identity, attempt);
  });

  // The assertion consumer service: the only form-encoded route (its own scope; see the CSRF note above).
  await app.register(async (acs) => {
    acs.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: SAML_ACS_BODY_LIMIT }, (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error, undefined);
      }
    });
    acs.post('/saml/:providerId/acs', { config: perMinute(30), bodyLimit: SAML_ACS_BODY_LIMIT }, async (req, reply) => {
      const params = req.params as { providerId: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      const provider = await loadById(params.providerId);
      if (!provider || provider.kind !== 'saml') return fail(req, reply, null, 'sso_failed', 'unknown_provider');
      if (!provider.enabled) return fail(req, reply, provider, 'sso_unavailable', 'provider_disabled');
      if (typeof body.SAMLResponse !== 'string' || body.SAMLResponse.length === 0) return fail(req, reply, provider, 'sso_failed', 'no_saml_response');
      let validated;
      try {
        validated = await validateSamlResponse(ctx, provider, body.SAMLResponse);
      } catch (err) {
        if (err instanceof SamlValidationError) return fail(req, reply, provider, 'sso_failed', err.reason, { detail: err.message });
        return fail(req, reply, provider, 'sso_failed', 'invalid_response', { detail: errorText(err) });
      }
      const attempt = await attemptBySamlRequest(ctx, provider.id, validated.inResponseTo);
      if (!attempt) return fail(req, reply, provider, 'sso_expired', 'unknown_request');
      if (!(await recordAssertion(ctx, provider.id, validated.assertionId, validated.expiresAt))) return fail(req, reply, provider, 'sso_failed', 'replayed', { assertionId: validated.assertionId.slice(0, 100) });
      const updated = await transitionAttempt(ctx, attempt.id, 'pending', 'validated', { identity: validated.identity });
      if (!updated) return fail(req, reply, provider, 'sso_expired', 'attempt_used_or_expired');
      return reply.redirect(`/api/auth/sso/complete?attempt=${attempt.id}`, 303);
    });
  });

  app.get('/complete', { config: perMinute(20) }, async (req, reply) => {
    const id = (req.query as Record<string, unknown>).attempt;
    const [attempt] = isUuid(id) ? await ctx.db.select().from(ssoLoginAttempts).where(eq(ssoLoginAttempts.id, id)) : [];
    const provider = attempt ? await loadById(attempt.providerId) : null;
    if (!attempt || !provider || attempt.status !== 'validated' || !attempt.identity || attempt.expiresAt.getTime() <= ctx.now()) return fail(req, reply, provider, 'sso_expired', 'attempt_not_validated');
    if (!browserMatches(req, attempt)) return fail(req, reply, provider, 'sso_expired', 'other_browser');
    if (!provider.enabled) return fail(req, reply, provider, 'sso_unavailable', 'provider_disabled');
    if (!(await transitionAttempt(ctx, attempt.id, 'validated', 'done'))) return fail(req, reply, provider, 'sso_expired', 'attempt_used_or_expired');
    return finish(req, reply, provider, attempt.identity, attempt);
  });

  app.get('/saml/:providerId/metadata', { config: perMinute(60) }, async (req, reply) => {
    const provider = await loadById((req.params as { providerId: string }).providerId);
    if (!provider || provider.kind !== 'saml') throw new HttpError(404, 'not_found', 'No SAML identity provider here');
    return reply.header('Content-Type', 'application/samlmetadata+xml; charset=utf-8').send(samlServiceProviderMetadata(ctx, provider));
  });
};

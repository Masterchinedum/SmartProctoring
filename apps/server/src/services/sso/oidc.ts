/**
 * OpenID Connect sign-in (authorization code flow with PKCE, state and nonce) through `openid-client` (MIT).
 *
 *  - Discovery (`<issuer>/.well-known/openid-configuration`) and the provider's JWKS are cached per provider for an
 *    hour (the JWKS is re-fetched by the library when a token names an unknown key); a changed provider (updatedAt)
 *    starts afresh. Every request goes through lib/net-guard.ts guardedFetch (SSRF policy, https in production, no
 *    redirects, timeout, size limit).
 *  - The ID token is validated by the library: signature against the provider's JWKS (enableNonRepudiationChecks;
 *    asymmetric algorithms only, never `alg: none`), `iss` =
 *    the discovered issuer (which must equal the configured one), `aud` contains our client id (and `azp`), `exp` /
 *    `iat` with 60 s tolerance, and the `nonce` of this attempt; the authorization response's `state` (and `iss`
 *    when the provider supports RFC 9207). The PKCE verifier is sent to the token endpoint.
 *  - Times are measured on ctx.now() (tests move the clock).
 */
import * as oidc from 'openid-client';
import type { Ctx } from '../../context.js';
import type { IdentityProvider, SsoAttemptIdentity } from '../../db/schema.js';
import { guardedFetch } from '../../lib/net-guard.js';
import { SSO_DEFAULT_CLAIMS } from '@sp/shared';
import { ssoClientSecretAad, ssoUrls } from './providers.js';

export const OIDC_METADATA_TTL_MS = 60 * 60_000;
/** Seconds of clock difference tolerated on exp / iat / nbf. */
export const OIDC_CLOCK_TOLERANCE_SEC = 60;

type OidcCtx = Pick<Ctx, 'config' | 'keyring' | 'now'>;

interface CacheEntry {
  key: string;
  at: number;
  metadata: oidc.ServerMetadata;
  jwks?: ReturnType<typeof oidc.getJwksCache>;
}

/** Per server configuration object (one per app instance; tests build many apps in one process). */
const caches = new WeakMap<object, Map<string, CacheEntry>>();

function cacheFor(ctx: OidcCtx): Map<string, CacheEntry> {
  let c = caches.get(ctx.config);
  if (!c) caches.set(ctx.config, (c = new Map()));
  return c;
}

/** Forget cached discovery / keys for a provider (after it was changed or deleted). */
export function forgetOidcProvider(ctx: OidcCtx, providerId: string): void {
  cacheFor(ctx).delete(providerId);
}

function fetchFor(ctx: OidcCtx) {
  return guardedFetch({ allowPrivateNetworks: ctx.config.sso.allowPrivateNetworks, requireHttps: ctx.config.sso.requireHttps, timeoutMs: ctx.config.sso.timeoutMs });
}

const cacheKey = (p: IdentityProvider) => `${p.id}:${p.updatedAt.getTime()}:${p.oidcIssuer}`;

/** The provider's discovery document (cached). Throws when it cannot be fetched or its issuer differs. */
export async function oidcMetadata(ctx: OidcCtx, provider: IdentityProvider, opts: { fresh?: boolean } = {}): Promise<oidc.ServerMetadata> {
  const cache = cacheFor(ctx);
  const hit = cache.get(provider.id);
  if (!opts.fresh && hit && hit.key === cacheKey(provider) && Date.now() - hit.at < OIDC_METADATA_TTL_MS) return hit.metadata;
  const insecure = !ctx.config.sso.requireHttps;
  // The library checks that the document's issuer equals the URL it was discovered from.
  const discovered = await oidc.discovery(new URL(provider.oidcIssuer!), provider.oidcClientId!, undefined, oidc.None(), {
    [oidc.customFetch]: fetchFor(ctx),
    execute: insecure ? [oidc.allowInsecureRequests] : [],
    timeout: Math.ceil(ctx.config.sso.timeoutMs / 1000),
  });
  const metadata = discovered.serverMetadata();
  cache.set(provider.id, { key: cacheKey(provider), at: Date.now(), metadata });
  return metadata;
}

/** A client configuration for one sign-in step (fresh per use: the clock offset follows ctx.now()). */
async function configurationFor(ctx: OidcCtx, provider: IdentityProvider): Promise<{ config: oidc.Configuration; entry: CacheEntry | undefined }> {
  const metadata = await oidcMetadata(ctx, provider);
  const secret = provider.oidcClientSecretEnc ? ctx.keyring.decryptString(provider.oidcClientSecretEnc, ssoClientSecretAad(provider.id)) : null;
  // client_secret_basic is the default of the specification; client_secret_post when the provider supports only that.
  const methods = metadata.token_endpoint_auth_methods_supported;
  const auth = !secret ? oidc.None() : methods && !methods.includes('client_secret_basic') && methods.includes('client_secret_post') ? oidc.ClientSecretPost(secret) : oidc.ClientSecretBasic(secret);
  const config = new oidc.Configuration(
    metadata,
    provider.oidcClientId!,
    {
      ...(secret ? { client_secret: secret } : {}),
      [oidc.clockSkew]: Math.round((ctx.now() - Date.now()) / 1000),
      [oidc.clockTolerance]: OIDC_CLOCK_TOLERANCE_SEC,
    },
    auth,
  );
  config[oidc.customFetch] = fetchFor(ctx);
  config.timeout = Math.ceil(ctx.config.sso.timeoutMs / 1000);
  if (!ctx.config.sso.requireHttps) oidc.allowInsecureRequests(config);
  // Verify the ID token's signature against the provider's JWKS although it comes straight from the token endpoint
  // (the specification lets TLS stand in for it): defence in depth, and a tampering proxy or a mis-issued certificate
  // cannot forge a sign-in. Only asymmetric algorithms (RS / PS / ES / EdDSA) are accepted.
  oidc.enableNonRepudiationChecks(config);
  const entry = cacheFor(ctx).get(provider.id);
  if (entry?.jwks) oidc.setJwksCache(config, entry.jwks);
  return { config, entry };
}

export interface OidcStart {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

/** The authorization request (PKCE S256, state, nonce). */
export async function oidcAuthorizationUrl(ctx: OidcCtx, provider: IdentityProvider, loginHint?: string): Promise<OidcStart> {
  const { config } = await configurationFor(ctx, provider);
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: ssoUrls(ctx.config.publicUrl, provider.id).redirectUri,
    scope: provider.oidcScopes,
    response_type: 'code',
    code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    state,
    nonce,
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
  return { url: url.href, state, nonce, codeVerifier };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** Claims → identity, through the provider's claim mapping (defaults: email, name, groups). */
export function identityFromClaims(provider: Pick<IdentityProvider, 'claimMapping'>, claims: Record<string, unknown>): SsoAttemptIdentity {
  const map = { ...SSO_DEFAULT_CLAIMS.oidc, ...Object.fromEntries(Object.entries(provider.claimMapping ?? {}).filter(([, v]) => v)) };
  const groupsRaw = claims[map.groups];
  const groups = Array.isArray(groupsRaw) ? groupsRaw.filter((g): g is string => typeof g === 'string') : typeof groupsRaw === 'string' ? [groupsRaw] : [];
  const given = [str(claims.given_name), str(claims.family_name)].filter(Boolean).join(' ');
  return {
    subject: String(claims.sub),
    email: str(claims[map.email]),
    emailVerified: claims.email_verified === true || claims.email_verified === 'true' ? true : claims.email_verified === undefined ? null : false,
    name: str(claims[map.name]) ?? (given || null),
    groups: groups.slice(0, 200),
  };
}

/**
 * The authorization response at our redirect URI → validated identity. `query` is the callback's query string. Throws
 * (library errors: wrong state / nonce / audience / issuer / signature, expired token, error responses).
 */
export async function oidcCallback(
  ctx: OidcCtx,
  provider: IdentityProvider,
  query: Record<string, string>,
  checks: { state: string; nonce: string; codeVerifier: string },
): Promise<SsoAttemptIdentity> {
  const { config } = await configurationFor(ctx, provider);
  // Built from our configured redirect URI (never the Host header): the library derives redirect_uri from it.
  const current = new URL(ssoUrls(ctx.config.publicUrl, provider.id).redirectUri);
  for (const [k, v] of Object.entries(query)) current.searchParams.set(k, v);
  const tokens = await oidc.authorizationCodeGrant(config, current, { pkceCodeVerifier: checks.codeVerifier, expectedState: checks.state, expectedNonce: checks.nonce, idTokenExpected: true });
  const entry = cacheFor(ctx).get(provider.id);
  const jwks = oidc.getJwksCache(config);
  if (entry && jwks) entry.jwks = jwks;
  const claims = tokens.claims();
  if (!claims) throw new Error('The token response contained no ID token');
  return identityFromClaims(provider, claims as Record<string, unknown>);
}

/** Test connection: discovery (fresh), the JWKS and what the sign-in needs. */
export async function testOidcProvider(ctx: OidcCtx, provider: IdentityProvider): Promise<{ name: string; ok: boolean; detail: string }[]> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  let metadata: oidc.ServerMetadata;
  try {
    metadata = await oidcMetadata(ctx, provider, { fresh: true });
    checks.push({ name: 'Discovery document', ok: true, detail: `Issuer ${metadata.issuer}` });
  } catch (err) {
    checks.push({ name: 'Discovery document', ok: false, detail: errorText(err) });
    return checks;
  }
  checks.push({ name: 'Authorization endpoint', ok: !!metadata.authorization_endpoint, detail: metadata.authorization_endpoint ?? 'Missing from the discovery document' });
  checks.push({ name: 'Token endpoint', ok: !!metadata.token_endpoint, detail: metadata.token_endpoint ?? 'Missing from the discovery document' });
  const pkce = metadata.code_challenge_methods_supported;
  checks.push({ name: 'PKCE (S256)', ok: !pkce || pkce.includes('S256'), detail: pkce ? `Supported methods: ${pkce.join(', ')}` : 'Not advertised; it will be sent anyway' });
  if (!metadata.jwks_uri) {
    checks.push({ name: 'Signing keys (JWKS)', ok: false, detail: 'jwks_uri missing from the discovery document' });
  } else {
    try {
      const res = await fetchFor(ctx)(metadata.jwks_uri, { headers: { accept: 'application/json' } });
      const body = (await res.json().catch(() => null)) as { keys?: unknown[] } | null;
      const n = Array.isArray(body?.keys) ? body!.keys!.length : 0;
      checks.push({ name: 'Signing keys (JWKS)', ok: res.ok && n > 0, detail: res.ok ? `${n} key${n === 1 ? '' : 's'}` : `HTTP ${res.status}` });
    } catch (err) {
      checks.push({ name: 'Signing keys (JWKS)', ok: false, detail: errorText(err) });
    }
  }
  return checks;
}

/** A short, secret-free description of an OIDC / transport error (for the audit log and the test result). */
export function errorText(err: unknown): string {
  const e = err as { code?: string; message?: string; error?: string; error_description?: string; cause?: { message?: string } };
  const parts = [e?.code, e?.error, e?.error_description ?? e?.message, e?.cause?.message].filter((x): x is string => typeof x === 'string' && x !== '');
  return [...new Set(parts)].join(': ').slice(0, 300) || 'Unknown error';
}

/**
 * Single sign-on test flows: create providers through the staff API and drive a browser's sign-in with app.inject
 * (our server) and fetch (the fake identity provider), carrying the sp_sso cookie like a browser.
 */
import { randomBytes } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import type { TestEnv } from '../helpers.js';
import { json, staffApi } from '../admin/fixtures.js';
import type { FakeOidcProvider } from './fake-oidc.js';
import { TestSamlIdp } from './saml-idp.js';

/** A different client address per request: the sign-in routes are rate-limited per IP. */
export const someIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0] % 250)}`;

export function cookieValue(res: LightMyRequestResponse, name: string): string | null {
  const c = res.cookies.find((x) => x.name === name);
  return c && c.value ? c.value : null;
}

export async function createOidcProvider(env: TestEnv, idp: FakeOidcProvider, overrides: Record<string, unknown> = {}, oidc: Record<string, unknown> = {}) {
  const owner = await staffApi(env, 'owner');
  return json(
    await owner.post('/sso/providers', {
      kind: 'oidc',
      name: 'Test University login',
      enabled: true,
      domains: ['test.example'],
      oidc: { issuer: idp.issuer, clientId: 'sp-client', clientSecret: 'sp-client-secret-123', ...oidc },
      ...overrides,
    }),
  );
}

export async function createSamlProvider(env: TestEnv, idp: TestSamlIdp, overrides: Record<string, unknown> = {}) {
  const owner = await staffApi(env, 'owner');
  return json(
    await owner.post('/sso/providers', {
      kind: 'saml',
      name: 'Test University SAML',
      enabled: true,
      domains: ['test.example'],
      saml: { entityId: idp.entityId, ssoUrl: idp.ssoUrl, certificates: [idp.cert.certPem] },
      ...overrides,
    }),
  );
}

export interface SsoResult {
  /** Our final answer (303). */
  res: LightMyRequestResponse;
  location: string;
  /** `sp_session=…` when signed in. */
  sessionCookie: string | null;
  error: string | null;
}

function result(res: LightMyRequestResponse): SsoResult {
  const location = String(res.headers.location ?? '');
  const session = cookieValue(res, 'sp_session');
  return { res, location, sessionCookie: session ? `sp_session=${session}` : null, error: new URL(location, 'http://x').searchParams.get('sso_error') };
}

/** Start single sign-on: the IdP URL and the browser-binding cookie. */
export async function startSso(env: TestEnv, providerId: string, query = '') {
  // Audit entries are ordered by time: every step moves the test clock a little.
  env.clock.advance(1000);
  const start = await env.app.inject({ method: 'GET', url: `/api/auth/sso/${providerId}/start${query}`, remoteAddress: someIp() });
  return { start, idpUrl: String(start.headers.location ?? ''), binding: cookieValue(start, 'sp_sso') };
}

/** The callback request for an OIDC authorization response URL (from the fake IdP's redirect). */
export async function oidcCallback(env: TestEnv, callbackUrl: string, binding: string | null): Promise<SsoResult> {
  const u = new URL(callbackUrl);
  env.clock.advance(1000);
  const res = await env.app.inject({ method: 'GET', url: u.pathname + u.search, remoteAddress: someIp(), headers: binding ? { cookie: `sp_sso=${binding}` } : {} });
  return result(res);
}

/** A whole OIDC sign-in like a browser: start → IdP (signs in idp.nextUser) → callback. */
export async function oidcLogin(env: TestEnv, providerId: string, opts: { query?: string; dropBinding?: boolean } = {}) {
  const { start, idpUrl, binding } = await startSso(env, providerId, opts.query ?? '');
  expect(start.statusCode, start.body).toBe(302);
  const atIdp = await fetch(idpUrl, { redirect: 'manual' });
  expect(atIdp.status).toBe(302);
  const callbackUrl = atIdp.headers.get('location')!;
  const r = await oidcCallback(env, callbackUrl, opts.dropBinding ? null : binding);
  return { ...r, callbackUrl, binding, idpUrl };
}

/** POST a SAMLResponse to the ACS as the identity provider's page would (cross-site, no cookies). */
export async function postAcs(env: TestEnv, providerId: string, samlResponse: string, extra: Record<string, string> = {}) {
  env.clock.advance(1000);
  return env.app.inject({
    method: 'POST',
    url: `/api/auth/sso/saml/${providerId}/acs`,
    remoteAddress: someIp(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://idp.example', 'sec-fetch-site': 'cross-site', ...extra },
    payload: new URLSearchParams({ SAMLResponse: samlResponse, RelayState: '' }).toString(),
  });
}

/** Finish a validated SAML sign-in in the browser (the ACS redirect target) with the binding cookie. */
export async function completeSaml(env: TestEnv, acsRes: LightMyRequestResponse, binding: string | null): Promise<SsoResult> {
  const location = String(acsRes.headers.location ?? '');
  if (!location.startsWith('/api/auth/sso/complete')) return result(acsRes);
  env.clock.advance(1000);
  const res = await env.app.inject({ method: 'GET', url: location, remoteAddress: someIp(), headers: binding ? { cookie: `sp_sso=${binding}` } : {} });
  return result(res);
}

/** A whole SAML sign-in: start → (test IdP builds the response) → ACS → complete. */
export async function samlLogin(env: TestEnv, providerId: string, idp: TestSamlIdp, build: Omit<Parameters<TestSamlIdp['response']>[0], 'request'>) {
  const { start, idpUrl, binding } = await startSso(env, providerId);
  expect(start.statusCode, start.body).toBe(302);
  const request = TestSamlIdp.parseRedirect(idpUrl);
  const samlResponse = idp.response({ ...build, request });
  const acs = await postAcs(env, providerId, samlResponse);
  expect(acs.statusCode, acs.body).toBe(303);
  return { ...(await completeSaml(env, acs, binding)), acs, request, samlResponse, binding };
}

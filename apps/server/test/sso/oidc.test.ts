/**
 * OpenID Connect single sign-on against an in-process provider (test/sso/fake-oidc.ts): configuration (owner only,
 * secret encrypted and never returned), discovery by email domain, the authorization code flow with PKCE / state /
 * nonce, ID-token validation failures, account linking, just-in-time accounts, domain and verified-email rules,
 * disabled accounts, "require single sign-on" with owner break-glass, provider changes ending sessions, and the SSRF
 * guard on identity-provider requests.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, identityProviders, organizations, staffSessions, staffSsoIdentities, staffUsers } from '../../src/db/schema.js';
import { createOrganization } from '../../src/services/org.js';
import { json, staffApi } from '../admin/fixtures.js';
import { createTestEnv, TEST_PASSWORD, type TestEnv } from '../helpers.js';
import { FakeOidcProvider } from './fake-oidc.js';
import { createOidcProvider, oidcCallback, oidcLogin, someIp, startSso } from './flow.js';

let env: TestEnv;
let idp: FakeOidcProvider;
let providerId: string;

const lastAudit = async (action: string) => (await env.ctx.db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(desc(auditLog.at), desc(auditLog.id)).limit(1))[0];
const me = (cookie: string) => env.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
const passwordLogin = (email: string, password = TEST_PASSWORD) => {
  env.clock.advance(1000);
  return env.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: someIp(), payload: { email, password } });
};
const setOrgSettings = (patch: Record<string, unknown>) =>
  env.ctx.db
    .update(organizations)
    .set({ settings: sql`${organizations.settings} || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(organizations.id, env.org.id));

beforeAll(async () => {
  env = await createTestEnv();
  idp = await FakeOidcProvider.start({ clientId: 'sp-client', clientSecret: 'sp-client-secret-123', now: env.clock.now });
});
afterAll(async () => {
  await idp?.close();
  await env?.close();
});
beforeEach(() => {
  idp.nextUser = null;
  idp.tokenOverrides = null;
});

describe('identity provider configuration', () => {
  it('only an owner adds a provider; the client secret is encrypted, never returned, and not audited', async () => {
    const admin = await staffApi(env, 'admin');
    const reviewer = await staffApi(env, 'reviewer');
    const body = { kind: 'oidc', name: 'Uni', enabled: true, domains: ['test.example'], oidc: { issuer: idp.issuer, clientId: 'sp-client', clientSecret: 'sp-client-secret-123' } };
    expect(json(await admin.post('/sso/providers', body), 403).error).toBe('owner_required');
    expect((await reviewer.get('/sso')).statusCode).toBe(403);

    const created = await createOidcProvider(env, idp);
    providerId = created.id;
    expect(created.oidc).toMatchObject({ issuer: idp.issuer, clientId: 'sp-client', clientSecretSet: true, redirectUri: `http://exam.test/api/auth/sso/oidc/${providerId}/callback` });
    expect(created.signInUrl).toBe(`http://exam.test/api/auth/sso/${providerId}/start`);
    expect(JSON.stringify(created)).not.toContain('sp-client-secret-123');
    const [row] = await env.ctx.db.select().from(identityProviders).where(eq(identityProviders.id, providerId));
    expect(row.oidcClientSecretEnc!.includes(Buffer.from('sp-client-secret-123'))).toBe(false);
    expect(env.ctx.keyring.decryptString(row.oidcClientSecretEnc!, `sso-client-secret:${providerId}`)).toBe('sp-client-secret-123');
    const a = await lastAudit('sso.provider_created');
    expect(a.meta).toMatchObject({ kind: 'oidc', domains: ['test.example'], clientSecret: 'set' });
    expect(JSON.stringify(a.meta)).not.toContain('sp-client-secret-123');

    // Administrators can see it (and test it), not change it.
    const overview = json(await admin.get('/sso'));
    expect(overview.providers).toHaveLength(1);
    expect(overview.requireSso).toBe(false);
    expect(json(await admin.put(`/sso/providers/${providerId}`, body), 403).error).toBe('owner_required');
    const test = json(await admin.post(`/sso/providers/${providerId}/test`));
    expect(test.ok).toBe(true);
    expect(test.checks.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(['Discovery document', 'Signing keys (JWKS)']));
  });

  it('refuses public mailbox domains, a domain another provider claims, and bad input', async () => {
    const owner = await staffApi(env, 'owner');
    const base = { kind: 'oidc', name: 'X', domains: ['gmail.com'], oidc: { issuer: idp.issuer, clientId: 'c' } };
    expect(json(await owner.post('/sso/providers', base), 400).error).toBe('validation_failed');
    expect(json(await owner.post('/sso/providers', { ...base, domains: ['test.example'] }), 409).error).toBe('sso_domain_taken');
    expect(json(await owner.post('/sso/providers', { ...base, domains: ['other.example'], oidc: { issuer: `${idp.issuer}/.well-known/openid-configuration`, clientId: 'c' } }), 400).error).toBe('validation_failed');
    expect(json(await owner.post('/sso/providers', { ...base, domains: ['other.example'], oidc: { issuer: idp.issuer, clientId: 'c', scopes: 'email' } }), 400).error).toBe('validation_failed');
    // Another organisation cannot claim it either (domains are unique on the whole server).
    const org2 = await createOrganization(env.ctx.db, 'Other Org', {}, env.clock.t);
    const [u2] = await env.ctx.db.insert(staffUsers).values({ orgId: org2.id, email: 'owner2@other.example', name: 'O2', role: 'owner', passwordHash: 'x' }).returning();
    const owner2 = await staffApi(env, u2);
    expect(json(await owner2.post('/sso/providers', { ...base, domains: ['TEST.example'] }), 409).error).toBe('sso_domain_taken');
    // …and cannot see or change this organisation's provider.
    expect((await owner2.put(`/sso/providers/${providerId}`, { ...base, domains: ['x.example'] })).statusCode).toBe(404);
    expect(json(await owner2.get('/sso')).providers).toEqual([]);
  });

  it('finds the provider from the email domain', async () => {
    const r = json(await env.app.inject({ method: 'POST', url: '/api/auth/sso/discover', remoteAddress: someIp(), payload: { email: 'Someone@TEST.example', next: '/admin/sessions' } }));
    expect(r.providerName).toBe('Test University login');
    expect(r.startUrl).toBe(`/api/auth/sso/${providerId}/start?login_hint=someone%40test.example&next=%2Fadmin%2Fsessions`);
    const none = await env.app.inject({ method: 'POST', url: '/api/auth/sso/discover', remoteAddress: someIp(), payload: { email: 'a@nowhere.example' } });
    expect(json(none, 404).error).toBe('sso_not_configured');
  });
});

describe('OIDC sign-in', () => {
  it('signs in an existing account with code + PKCE + state + nonce, links it, and skips the local second step', async () => {
    await env.ctx.db.update(staffUsers).set({ disabled: false }).where(eq(staffUsers.id, env.users.reviewer.id));
    // The organisation requires two-step sign-in for everyone: after single sign-on the provider is responsible.
    await setOrgSettings({ requireMfa: 'everyone' });
    idp.nextUser = { sub: 'sub-reviewer', email: 'Reviewer@test.example', email_verified: true, name: 'Test reviewer' };
    const r = await oidcLogin(env, providerId, { query: '?next=/admin/sessions&login_hint=reviewer@test.example' });
    expect(r.error).toBeNull();
    expect(r.res.statusCode).toBe(303);
    expect(r.location).toBe('/admin/sessions');
    expect(r.sessionCookie).not.toBeNull();
    // The browser-binding cookie is cleared.
    expect(r.res.cookies.find((c) => c.name === 'sp_sso')?.value).toBe('');

    const authz = idp.authorizeRequests.at(-1)!;
    expect(authz.get('response_type')).toBe('code');
    expect(authz.get('code_challenge_method')).toBe('S256');
    expect(authz.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(authz.get('state')).toBeTruthy();
    expect(authz.get('nonce')).toBeTruthy();
    expect(authz.get('scope')).toBe('openid email profile');
    expect(authz.get('login_hint')).toBe('reviewer@test.example');
    expect(authz.get('redirect_uri')).toBe(`http://exam.test/api/auth/sso/oidc/${providerId}/callback`);
    const token = idp.tokenRequests.at(-1)!;
    expect(token.auth).toMatch(/^Basic /);
    expect(token.body.get('code_verifier')).toMatch(/^[\w-]{43,}$/);

    const meRes = json(await me(r.sessionCookie!));
    expect(meRes.user.id).toBe(env.users.reviewer.id);
    expect(meRes.security).toMatchObject({ signInMethod: 'sso', enrollmentRequired: false, mfaRequired: true });
    expect((await env.app.inject({ method: 'GET', url: '/api/admin/dashboard', headers: { cookie: r.sessionCookie! } })).statusCode).toBe(200);
    const login = await lastAudit('auth.login');
    expect(login).toMatchObject({ actorId: env.users.reviewer.id, meta: { method: 'sso', provider: providerId, kind: 'oidc' } });
    expect((await lastAudit('user.sso_linked')).targetId).toBe(env.users.reviewer.id);
    const [link] = await env.ctx.db.select().from(staffSsoIdentities).where(eq(staffSsoIdentities.staffUserId, env.users.reviewer.id));
    expect(link).toMatchObject({ providerId, subject: 'sub-reviewer', email: 'reviewer@test.example' });
    const [sess] = await env.ctx.db.select().from(staffSessions).where(and(eq(staffSessions.staffUserId, env.users.reviewer.id), eq(staffSessions.authMethod, 'sso')));
    expect(sess.ssoProviderId).toBe(providerId);
    await setOrgSettings({ requireMfa: 'off' });

    // The Users page shows the link.
    const users = json(await (await staffApi(env, 'admin')).get('/users')).items as { id: string; ssoLinked: boolean }[];
    expect(users.find((u) => u.id === env.users.reviewer.id)?.ssoLinked).toBe(true);
    expect(users.find((u) => u.id === env.users.admin.id)?.ssoLinked).toBe(false);
  });

  it('only accepts the callback once, in the browser that started it, with the right state', async () => {
    idp.nextUser = { sub: 'sub-reviewer', email: 'reviewer@test.example', email_verified: true };
    // Another browser (no binding cookie).
    const other = await oidcLogin(env, providerId, { dropBinding: true });
    expect(other.error).toBe('sso_expired');
    expect((await lastAudit('auth.sso_failed')).meta).toMatchObject({ reason: 'other_browser' });

    // A forged state.
    const { binding, idpUrl } = await startSso(env, providerId);
    const back = (await fetch(idpUrl, { redirect: 'manual' })).headers.get('location')!;
    const forged = new URL(back);
    forged.searchParams.set('state', 'not-the-state');
    expect((await oidcCallback(env, forged.href, binding)).error).toBe('sso_expired');
    expect((await lastAudit('auth.sso_failed')).meta).toMatchObject({ reason: 'unknown_state' });
    // The genuine callback still works once…
    const ok = await oidcCallback(env, back, binding);
    expect(ok.error).toBeNull();
    // …and never again (replay).
    expect((await oidcCallback(env, back, binding)).error).toBe('sso_expired');

    // An expired attempt (10 minutes).
    const late = await startSso(env, providerId);
    const lateBack = (await fetch(late.idpUrl, { redirect: 'manual' })).headers.get('location')!;
    env.clock.advance(11 * 60_000);
    expect((await oidcCallback(env, lateBack, late.binding)).error).toBe('sso_expired');
  });

  it('refuses ID tokens with a wrong nonce, audience, issuer or signature, and expired ones', async () => {
    const cases: [string, () => void, RegExp][] = [
      ['wrong nonce', () => (idp.tokenOverrides = { nonce: 'another-nonce' }), /nonce/i],
      ['wrong audience', () => (idp.tokenOverrides = { aud: 'someone-else' }), /aud/i],
      ['wrong issuer', () => (idp.tokenOverrides = { iss: 'http://evil.example/oidc' }), /iss/i],
      ['expired', () => (idp.tokenOverrides = { exp: Math.floor(env.clock.t / 1000) - 300, iat: Math.floor(env.clock.t / 1000) - 900 }), /exp|timestamp/i],
      ['foreign key', () => (idp.signWithForeignKey = true), /signature|key/i],
    ];
    for (const [name, arrange, detail] of cases) {
      idp.nextUser = { sub: 'sub-reviewer', email: 'reviewer@test.example', email_verified: true };
      arrange();
      const r = await oidcLogin(env, providerId);
      expect(r.error, name).toBe('sso_failed');
      expect(r.sessionCookie, name).toBeNull();
      const a = await lastAudit('auth.sso_failed');
      expect(a.meta, name).toMatchObject({ reason: 'token_rejected', code: 'sso_failed', kind: 'oidc' });
      expect(String((a.meta as { detail: string }).detail), name).toMatch(detail);
    }
    idp.nextError = 'access_denied';
    expect((await oidcLogin(env, providerId)).error).toBe('sso_cancelled');
  });

  it('applies the account rules: disabled, other organisation, domain, verified email, re-used address', async () => {
    // Disabled accounts never sign in.
    await env.ctx.db.update(staffUsers).set({ disabled: true }).where(eq(staffUsers.id, env.users.reviewer.id));
    idp.nextUser = { sub: 'sub-reviewer', email: 'reviewer@test.example', email_verified: true };
    expect((await oidcLogin(env, providerId)).error).toBe('sso_account_disabled');
    await env.ctx.db.update(staffUsers).set({ disabled: false }).where(eq(staffUsers.id, env.users.reviewer.id));

    // An address of a domain the provider does not claim.
    idp.nextUser = { sub: 'x1', email: 'admin@elsewhere.example', email_verified: true };
    expect((await oidcLogin(env, providerId)).error).toBe('sso_domain_not_allowed');

    // An account of another organisation with an address of this domain is never touched.
    const org2 = await createOrganization(env.ctx.db, 'Org Three', {}, env.clock.t);
    await env.ctx.db.insert(staffUsers).values({ orgId: org2.id, email: 'outsider@test.example', name: 'Outsider', role: 'owner', passwordHash: 'x' });
    idp.nextUser = { sub: 'x2', email: 'outsider@test.example', email_verified: true };
    expect((await oidcLogin(env, providerId)).error).toBe('sso_no_account');
    expect((await lastAudit('auth.sso_failed')).meta).toMatchObject({ reason: 'other_organisation' });

    // Unverified email (the default requires email_verified = true).
    idp.nextUser = { sub: 'sub-admin', email: 'admin@test.example', email_verified: false };
    expect((await oidcLogin(env, providerId)).error).toBe('sso_email_unverified');
    idp.nextUser = { sub: 'sub-admin', email: 'admin@test.example' };
    expect((await oidcLogin(env, providerId)).error).toBe('sso_email_unverified');

    // The reviewer's address now asserted for another subject (re-used address): refused until unlinked.
    idp.nextUser = { sub: 'sub-someone-new', email: 'reviewer@test.example', email_verified: true };
    expect((await oidcLogin(env, providerId)).error).toBe('sso_identity_mismatch');
    const admin = await staffApi(env, 'admin');
    json(await admin.post(`/users/${env.users.reviewer.id}/sso/unlink`));
    expect((await lastAudit('user.sso_unlinked')).targetId).toBe(env.users.reviewer.id);
    idp.nextUser = { sub: 'sub-someone-new', email: 'reviewer@test.example', email_verified: true };
    expect((await oidcLogin(env, providerId)).error).toBeNull();
  });

  it('creates just-in-time accounts only when switched on, with the mapped role (never owner) and no password', async () => {
    idp.nextUser = { sub: 'sub-new', email: 'newcomer@test.example', email_verified: true, name: 'New Comer', groups: ['proctoring-admins'] };
    expect((await oidcLogin(env, providerId)).error).toBe('sso_no_account');
    expect(await env.ctx.db.select().from(staffUsers).where(eq(staffUsers.email, 'newcomer@test.example'))).toHaveLength(0);

    const owner = await staffApi(env, 'owner');
    const current = json(await owner.get('/sso')).providers[0];
    const update = {
      kind: 'oidc',
      name: current.name,
      enabled: true,
      domains: current.domains,
      jit: { enabled: true, defaultRole: 'reviewer' },
      roleMappings: [{ group: 'Proctoring-Admins', role: 'admin' }],
      oidc: { issuer: current.oidc.issuer, clientId: current.oidc.clientId },
    };
    const updated = json(await owner.put(`/sso/providers/${providerId}`, update));
    expect(updated.oidc.clientSecretSet).toBe(true); // omitted secret = kept
    expect(json(await owner.put(`/sso/providers/${providerId}`, { ...update, jit: { enabled: true, defaultRole: 'owner' } }), 400).error).toBe('validation_failed');

    idp.nextUser = { sub: 'sub-new', email: 'newcomer@test.example', email_verified: true, name: 'New Comer', groups: ['proctoring-admins'] };
    const r = await oidcLogin(env, providerId);
    expect(r.error).toBeNull();
    const [u] = await env.ctx.db.select().from(staffUsers).where(eq(staffUsers.email, 'newcomer@test.example'));
    expect(u).toMatchObject({ orgId: env.org.id, role: 'admin', name: 'New Comer', provisionedVia: 'sso', disabled: false });
    expect((await lastAudit('user.created')).meta).toMatchObject({ via: 'sso', role: 'admin', provider: providerId });
    expect((await lastAudit('auth.login')).meta).toMatchObject({ accountCreated: true });
    // No password: password sign-in fails like a wrong password.
    expect((await passwordLogin('newcomer@test.example', 'anything-at-all')).statusCode).toBe(401);
    expect((await lastAudit('auth.login_failed')).meta).toMatchObject({ reason: 'no_password' });

    // Without a mapped group: the default role.
    idp.nextUser = { sub: 'sub-new2', email: 'second@test.example', email_verified: true };
    expect((await oidcLogin(env, providerId)).error).toBeNull();
    const [u2] = await env.ctx.db.select().from(staffUsers).where(eq(staffUsers.email, 'second@test.example'));
    expect(u2.role).toBe('reviewer');
    expect(u2.name).toBe('second');
  });

  it('lets owners require single sign-on for everyone else, with password sign-in as the owners’ break-glass', async () => {
    const owner = await staffApi(env, 'owner');
    const admin = await staffApi(env, 'admin');
    expect(json(await admin.put('/settings', { requireSso: true }), 403).error).toBe('owner_required');
    const adminPasswordSession = admin.cookie;

    json(await owner.put('/settings', { requireSso: true }));
    expect((await lastAudit('settings.updated')).meta).toMatchObject({ requireSso: { from: false, to: true } });
    // Password sessions of non-owners end; the owner's continues.
    expect((await me(adminPasswordSession)).statusCode).toBe(401);
    expect((await me(owner.cookie)).statusCode).toBe(200);
    // Password sign-in: refused for non-owners (after the right password only), still possible for owners.
    const refused = await passwordLogin('admin@test.example');
    expect(json(refused, 403).error).toBe('sso_required');
    expect((await passwordLogin('admin@test.example', 'wrong-password-123')).statusCode).toBe(401);
    expect((await passwordLogin('owner@test.example')).statusCode).toBe(200);
    // Single sign-on works, and the session reports the requirement.
    idp.nextUser = { sub: 'sub-admin', email: 'admin@test.example', email_verified: true };
    await env.ctx.db.update(identityProviders).set({ oidcRequireVerifiedEmail: true }).where(eq(identityProviders.id, providerId));
    const r = await oidcLogin(env, providerId);
    expect(r.error).toBeNull();
    expect(json(await me(r.sessionCookie!)).security).toMatchObject({ signInMethod: 'sso', ssoRequired: true });

    // The last enabled provider cannot be disabled or deleted while single sign-on is required.
    const current = json(await owner.get('/sso')).providers[0];
    const disable = { kind: 'oidc', name: current.name, enabled: false, domains: current.domains, oidc: { issuer: current.oidc.issuer, clientId: current.oidc.clientId } };
    expect(json(await owner.put(`/sso/providers/${providerId}`, disable), 409).error).toBe('sso_required_needs_provider');
    expect(json(await owner.del(`/sso/providers/${providerId}`), 409).error).toBe('sso_required_needs_provider');

    // Turned off again: disabling the provider now ends its sessions.
    json(await owner.put('/settings', { requireSso: false }));
    json(await owner.put(`/sso/providers/${providerId}`, disable));
    expect((await me(r.sessionCookie!)).statusCode).toBe(401);
    expect((await lastAudit('sso.provider_updated')).meta).toMatchObject({ enabled: { from: true, to: false } });
    const start = await startSso(env, providerId);
    expect(String(start.start.headers.location)).toBe('/admin/login?sso_error=sso_unavailable');
    // Requiring single sign-on needs an enabled provider.
    expect(json(await owner.put('/settings', { requireSso: true }), 409).error).toBe('sso_not_configured');
    json(await owner.put(`/sso/providers/${providerId}`, { ...disable, enabled: true }));
  });

  it('never redirects outside the staff app after sign-in', async () => {
    idp.nextUser = { sub: 'sub-admin', email: 'admin@test.example', email_verified: true };
    const r = await oidcLogin(env, providerId, { query: `?next=${encodeURIComponent('https://evil.example/admin')}` });
    expect(r.location).toBe('/admin');
    idp.nextUser = { sub: 'sub-admin', email: 'admin@test.example', email_verified: true };
    expect((await oidcLogin(env, providerId, { query: '?next=//evil.example' })).location).toBe('/admin');
  });

  it('pointing the provider at another issuer drops its account links and ends its sessions; deleting it does too', async () => {
    idp.nextUser = { sub: 'sub-admin', email: 'admin@test.example', email_verified: true };
    const r = await oidcLogin(env, providerId);
    expect(r.error).toBeNull();
    const owner = await staffApi(env, 'owner');
    const current = json(await owner.get('/sso')).providers[0];
    const other = await FakeOidcProvider.start({ clientId: 'sp-client', now: env.clock.now });
    try {
      const moved = json(await owner.put(`/sso/providers/${providerId}`, { kind: 'oidc', name: current.name, enabled: true, domains: current.domains, oidc: { issuer: other.issuer, clientId: 'sp-client', clientSecret: null } }));
      expect(moved.oidc.clientSecretSet).toBe(false);
      expect(moved.linkedUsers).toBe(0);
      expect((await me(r.sessionCookie!)).statusCode).toBe(401);
      expect((await lastAudit('sso.provider_updated')).meta).toMatchObject({ clientSecret: 'removed', linksRemoved: expect.any(Number) });
      // A public client (PKCE only) at the new issuer.
      other.nextUser = { sub: 'other-sub', email: 'admin@test.example', email_verified: true };
      const r2 = await oidcLogin(env, providerId);
      expect(r2.error).toBeNull();
      expect(other.tokenRequests.at(-1)!.auth).toBeNull();
      expect(other.tokenRequests.at(-1)!.body.get('client_id')).toBe('sp-client');
      json(await owner.del(`/sso/providers/${providerId}`));
      expect((await me(r2.sessionCookie!)).statusCode).toBe(401);
      expect(await env.ctx.db.select().from(staffSsoIdentities)).toHaveLength(0);
      expect((await lastAudit('sso.provider_deleted')).meta).toMatchObject({ kind: 'oidc', domains: ['test.example'] });
    } finally {
      await other.close();
    }
  });
});

describe('identity provider requests go through the SSRF guard', () => {
  it('refuses a provider on a private address unless private networks are allowed', async () => {
    const e = await createTestEnv({ env: { SSO_ALLOW_PRIVATE_NETWORKS: 'false' } });
    const local = await FakeOidcProvider.start({ clientId: 'c', now: e.clock.now });
    try {
      const p = await createOidcProvider(e, local, {}, { clientSecret: null });
      const { start } = await startSso(e, p.id);
      expect(String(start.headers.location)).toBe('/admin/login?sso_error=sso_provider_error');
      const [a] = await e.ctx.db.select().from(auditLog).where(eq(auditLog.action, 'auth.sso_failed'));
      expect(a.meta).toMatchObject({ reason: 'discovery_failed' });
      expect(String((a.meta as { detail: string }).detail)).toMatch(/not a public address/);
      const test = json(await (await staffApi(e, 'admin')).post(`/sso/providers/${p.id}/test`));
      expect(test.ok).toBe(false);
      expect(local.authorizeRequests).toHaveLength(0);
    } finally {
      await local.close();
      await e.close();
    }
  });
});

/**
 * SAML 2.0 single sign-on with a test identity provider whose certificate signs the assertions (test/sso/saml-idp.ts,
 * xml-crypto): SP metadata, the HTTP-Redirect AuthnRequest, the HTTP-POST ACS (a cross-site form post, the only one the
 * server accepts) with signed assertion / signed response, and the refusals — tampered, unsigned, another key,
 * expired, wrong audience / recipient / issuer, unsolicited, replayed, finished in another browser.
 * node-saml measures time with the system clock, so the test clock is set to it.
 */
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, ssoSamlAssertions, staffUsers } from '../../src/db/schema.js';
import { json, staffApi } from '../admin/fixtures.js';
import { createTestEnv, type TestEnv } from '../helpers.js';
import { completeSaml, createSamlProvider, postAcs, samlLogin, someIp, startSso } from './flow.js';
import { TestSamlIdp } from './saml-idp.js';
import { selfSignedCertificate } from './x509.js';

let env: TestEnv;
let idp: TestSamlIdp;
let providerId: string;

const lastAudit = async (action: string) => (await env.ctx.db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(desc(auditLog.at), desc(auditLog.id)).limit(1))[0];

beforeAll(async () => {
  env = await createTestEnv();
  env.clock.set(Date.now());
  idp = new TestSamlIdp('https://idp.test.example/saml', 'https://idp.test.example/saml/sso');
});
afterAll(async () => {
  await env?.close();
});

describe('SAML provider configuration', () => {
  it('stores the certificates (PEM or base64), shows the SP URLs and serves SP metadata', async () => {
    const owner = await staffApi(env, 'owner');
    expect(json(await owner.post('/sso/providers', { kind: 'saml', name: 'X', domains: ['x.example'], saml: { entityId: 'e', ssoUrl: 'https://idp/sso', certificates: ['not a certificate'] } }), 400).error).toBe(
      'validation_failed',
    );
    const created = await createSamlProvider(env, idp, { saml: { entityId: idp.entityId, ssoUrl: idp.ssoUrl, certificates: [idp.cert.certBase64] } });
    providerId = created.id;
    expect(created.saml).toMatchObject({
      entityId: idp.entityId,
      ssoUrl: idp.ssoUrl,
      spEntityId: `http://exam.test/api/auth/sso/saml/${providerId}/metadata`,
      acsUrl: `http://exam.test/api/auth/sso/saml/${providerId}/acs`,
    });
    expect(created.saml.certificates).toHaveLength(1);
    expect(created.saml.certificates[0].pem).toContain('-----BEGIN CERTIFICATE-----');
    expect(created.saml.certificates[0].subject).toContain('Test SAML IdP');

    const meta = await env.app.inject({ method: 'GET', url: `/api/auth/sso/saml/${providerId}/metadata` });
    expect(meta.statusCode).toBe(200);
    expect(meta.headers['content-type']).toContain('application/samlmetadata+xml');
    expect(meta.body).toContain(`entityID="http://exam.test/api/auth/sso/saml/${providerId}/metadata"`);
    expect(meta.body).toContain(`Location="http://exam.test/api/auth/sso/saml/${providerId}/acs"`);
    expect(meta.body).toContain('urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST');
    expect(meta.body).toContain('WantAssertionsSigned="true"');

    const test = json(await (await staffApi(env, 'admin')).post(`/sso/providers/${providerId}/test`));
    expect(test.ok).toBe(true);
  });
});

describe('SAML sign-in', () => {
  it('sends an AuthnRequest by redirect and signs in with a signed assertion', async () => {
    const { start, idpUrl } = await startSso(env, providerId);
    expect(start.statusCode).toBe(302);
    expect(idpUrl.startsWith(`${idp.ssoUrl}?SAMLRequest=`)).toBe(true);
    const req = TestSamlIdp.parseRedirect(idpUrl);
    expect(req.id).toMatch(/^_[0-9a-f]{40}$/);
    expect(req.acsUrl).toBe(`http://exam.test/api/auth/sso/saml/${providerId}/acs`);
    expect(req.issuer).toBe(`http://exam.test/api/auth/sso/saml/${providerId}/metadata`);
    expect(req.xml).not.toContain('RequestedAuthnContext');

    const r = await samlLogin(env, providerId, idp, { nameId: 'saml-reviewer-1', attributes: { email: 'REVIEWER@test.example', displayName: 'Test reviewer' } });
    expect(r.acs.headers.location).toMatch(/^\/api\/auth\/sso\/complete\?attempt=/);
    // The ACS answers the cross-site POST without signing anyone in (no cookie authority there).
    expect(r.acs.cookies.find((c) => c.name === 'sp_session')).toBeUndefined();
    expect(r.error).toBeNull();
    expect(r.location).toBe('/admin');
    const me = json(await env.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: r.sessionCookie! } }));
    expect(me.user.id).toBe(env.users.reviewer.id);
    expect(me.security.signInMethod).toBe('sso');
    expect((await lastAudit('auth.login')).meta).toMatchObject({ method: 'sso', kind: 'saml', provider: providerId });
    expect(await env.ctx.db.select().from(ssoSamlAssertions)).toHaveLength(1);
  });

  it('accepts a signed response (covering the assertion) and the email from an email-shaped NameID', async () => {
    const r = await samlLogin(env, providerId, idp, { nameId: 'admin@test.example', nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress', sign: 'response' });
    expect(r.error).toBeNull();
    expect(json(await env.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: r.sessionCookie! } })).user.id).toBe(env.users.admin.id);
  });

  it('refuses tampered, unsigned, foreign-signed, expired, mis-addressed and unsolicited responses', async () => {
    const other = selfSignedCertificate('Someone else');
    const cases: [string, Omit<Parameters<TestSamlIdp['response']>[0], 'request'>, string, RegExp][] = [
      ['tampered', { nameId: 'n1', attributes: { email: 'reviewer@test.example' }, tamper: (x) => x.replace('reviewer@test.example', 'admin@test.example') }, 'invalid_response', /signature/i],
      ['unsigned', { nameId: 'n1', attributes: { email: 'reviewer@test.example' }, sign: 'none' }, 'invalid_response', /signature/i],
      ['other key', { nameId: 'n1', attributes: { email: 'reviewer@test.example' }, signingCert: other }, 'invalid_response', /signature/i],
      ['expired', { nameId: 'n1', attributes: { email: 'reviewer@test.example' }, issueInstantSec: -1200, notBeforeSec: -1200, notOnOrAfterSec: -600 }, 'invalid_response', /expired/i],
      ['wrong audience', { nameId: 'n1', attributes: { email: 'reviewer@test.example' }, audience: 'https://someone-else.example/sp' }, 'invalid_response', /audience/i],
      ['wrong recipient', { nameId: 'n1', attributes: { email: 'reviewer@test.example' }, recipient: 'https://evil.example/acs' }, 'wrong_recipient', /subject confirmation/i],
      ['wrong issuer', { nameId: 'n1', attributes: { email: 'reviewer@test.example' }, issuer: 'https://evil.example/idp' }, 'wrong_issuer', /issuer/i],
      ['unsolicited', { nameId: 'n1', attributes: { email: 'reviewer@test.example' }, inResponseTo: null }, 'unsolicited', /subject confirmation/i],
    ];
    for (const [name, build, reason, detail] of cases) {
      const r = await samlLogin(env, providerId, idp, build);
      expect(r.error, name).toBe('sso_failed');
      expect(r.sessionCookie, name).toBeNull();
      const a = await lastAudit('auth.sso_failed');
      expect(a.meta, name).toMatchObject({ reason, code: 'sso_failed', kind: 'saml' });
      expect(String((a.meta as { detail?: string }).detail), name).toMatch(detail);
    }
    // A response to a request this server never sent.
    const { binding } = await startSso(env, providerId);
    const forged = idp.response({ nameId: 'n1', attributes: { email: 'reviewer@test.example' }, request: { id: '_never-sent', acsUrl: `http://exam.test/api/auth/sso/saml/${providerId}/acs`, issuer: `http://exam.test/api/auth/sso/saml/${providerId}/metadata` } });
    const acs = await postAcs(env, providerId, forged);
    expect((await completeSaml(env, acs, binding)).error).toBe('sso_expired');
    expect((await lastAudit('auth.sso_failed')).meta).toMatchObject({ reason: 'unknown_request' });
  });

  it('uses each assertion once and completes only in the browser that started the sign-in', async () => {
    const r = await samlLogin(env, providerId, idp, { nameId: 'saml-reviewer-1', attributes: { email: 'reviewer@test.example' } });
    expect(r.error).toBeNull();
    // Replayed to the ACS.
    const again = await postAcs(env, providerId, r.samlResponse);
    expect(String(again.headers.location)).toBe('/admin/login?sso_error=sso_failed');
    expect((await lastAudit('auth.sso_failed')).meta).toMatchObject({ reason: 'replayed' });

    // Validated at the ACS, but finished without (or with another) binding cookie: login CSRF is refused.
    const { binding } = await startSso(env, providerId);
    void binding;
    const second = await startSso(env, providerId);
    const request = TestSamlIdp.parseRedirect(second.idpUrl);
    const acs = await postAcs(env, providerId, idp.response({ nameId: 'saml-reviewer-1', attributes: { email: 'reviewer@test.example' }, request }));
    expect((await completeSaml(env, acs, null)).error).toBe('sso_expired');
    expect((await lastAudit('auth.sso_failed')).meta).toMatchObject({ reason: 'other_browser' });
    // The right browser can still finish it.
    expect((await completeSaml(env, acs, second.binding)).error).toBeNull();
    expect((await completeSaml(env, acs, second.binding)).error).toBe('sso_expired');
  });

  it('links by the email when the NameID is transient (a new value at every sign-in)', async () => {
    const transient = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';
    for (const nameId of ['_t1', '_t2']) {
      const r = await samlLogin(env, providerId, idp, { nameId, nameIdFormat: transient, attributes: { mail: 'owner@test.example' } });
      expect(r.error, nameId).toBeNull();
    }
  });

  it('applies the same account rules as OIDC (domain, disabled, no account)', async () => {
    expect((await samlLogin(env, providerId, idp, { nameId: 'z1', attributes: { email: 'someone@elsewhere.example' } })).error).toBe('sso_domain_not_allowed');
    expect((await samlLogin(env, providerId, idp, { nameId: 'z2', attributes: { email: 'nobody@test.example' } })).error).toBe('sso_no_account');
    await env.ctx.db.update(staffUsers).set({ disabled: true }).where(eq(staffUsers.id, env.users.admin.id));
    expect((await samlLogin(env, providerId, idp, { nameId: 'admin@test.example', nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' })).error).toBe('sso_account_disabled');
    await env.ctx.db.update(staffUsers).set({ disabled: false }).where(eq(staffUsers.id, env.users.admin.id));
  });
});

describe('form posts', () => {
  it('are accepted by the ACS only; every other route still refuses them', async () => {
    const login = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: someIp(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=owner%40test.example&password=x',
    });
    expect(login.statusCode).toBe(415);
    const admin = await staffApi(env, 'admin');
    const settings = await admin.inject({ method: 'PUT', url: '/api/admin/settings', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'name=x' });
    expect(settings.statusCode).toBe(415);
    // An oversized body at the ACS.
    const big = await postAcs(env, providerId, 'A'.repeat(600 * 1024));
    expect(big.statusCode).toBe(413);
  });
});

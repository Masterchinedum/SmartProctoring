import { describe, expect, it } from 'vitest';
import { identityProviderInputSchema, ssoErrorMessage, SSO_ERROR_MESSAGES, type IdentityProviderDTO } from '@sp/shared';
import { ApiError } from '../api/client';
import { loginErrorMessage } from './auth-errors';
import { certificateDaysLeft, draftFromProvider, draftToInput, emptyDraft, parseDomains, splitCertificates, ssoDiscoverErrorMessage, validateDraft } from './sso';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----';

const provider = (over: Partial<IdentityProviderDTO> = {}): IdentityProviderDTO => ({
  id: 'p1',
  kind: 'oidc',
  name: 'Uni login',
  enabled: true,
  domains: ['example.edu', 'staff.example.edu'],
  jit: { enabled: true, defaultRole: 'reviewer' },
  roleMappings: [{ group: 'proctor-admins', role: 'admin' }],
  claimMapping: { email: '', name: '', groups: 'roles' },
  oidc: { issuer: 'https://login.example.edu', clientId: 'abc', clientSecretSet: true, scopes: 'openid email profile', requireVerifiedEmail: false, redirectUri: 'https://sp/cb' },
  saml: null,
  signInUrl: 'https://sp/start',
  linkedUsers: 3,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('identity provider form', () => {
  it('reads domains leniently and flags what it cannot use', () => {
    expect(parseDomains('Example.EDU, @staff.example.edu\nexample.edu')).toEqual({ domains: ['example.edu', 'staff.example.edu'], invalid: [], publicMail: [] });
    expect(parseDomains('not a domain!, gmail.com')).toEqual({ domains: [], invalid: ['not', 'a', 'domain!'], publicMail: ['gmail.com'] });
  });

  it('splits pasted certificates', () => {
    expect(splitCertificates(`${PEM}\n\n${PEM}`)).toEqual([PEM, PEM]);
    expect(splitCertificates(' MIIB szCC \n AVmg ')).toEqual(['MIIBszCCAVmg']);
    expect(splitCertificates('  ')).toEqual([]);
  });

  it('validates OIDC and SAML drafts in plain language', () => {
    const e = validateDraft(emptyDraft('oidc'));
    expect(Object.keys(e).sort()).toEqual(['clientId', 'domains', 'issuer', 'name']);
    expect(validateDraft({ ...emptyDraft('oidc'), name: 'x', domains: 'gmail.com', issuer: 'https://idp/.well-known/openid-configuration', clientId: 'c', scopes: 'email' })).toMatchObject({
      domains: expect.stringMatching(/public email provider/),
      issuer: expect.stringMatching(/without \/\.well-known/),
      scopes: expect.stringMatching(/openid/),
    });
    const saml = validateDraft({ ...emptyDraft('saml'), name: 'x', domains: 'example.edu' });
    expect(Object.keys(saml).sort()).toEqual(['certificates', 'entityId', 'ssoUrl']);
    expect(validateDraft({ ...emptyDraft('saml'), name: 'x', domains: 'example.edu', entityId: 'e', ssoUrl: 'https://idp/sso', certificates: PEM, roleMappings: [{ group: ' ', role: 'admin' }] })).toEqual({
      'roleMappings.0': 'Enter the group name or ID',
    });
  });

  it('round-trips a provider into an input the server accepts; an empty secret keeps the stored one', () => {
    const d = draftFromProvider(provider());
    expect(d).toMatchObject({ domains: 'example.edu, staff.example.edu', clientSecret: '', requireVerifiedEmail: false, claimGroups: 'roles' });
    const input = draftToInput(d, true);
    expect(input.oidc).toEqual({ issuer: 'https://login.example.edu', clientId: 'abc', scopes: 'openid email profile', requireVerifiedEmail: false });
    expect(identityProviderInputSchema.safeParse(input).success).toBe(true);
    expect(draftToInput({ ...d, clientSecret: ' new ' }, true).oidc?.clientSecret).toBe('new');
    expect(draftToInput({ ...d, removeSecret: true, clientSecret: 'x' }, true).oidc?.clientSecret).toBeNull();
    // A new provider without a secret is a public client.
    expect(draftToInput({ ...emptyDraft('oidc'), name: 'n', domains: 'a.example', issuer: 'https://i', clientId: 'c' }, false).oidc?.clientSecret).toBeNull();
    const samlInput = draftToInput({ ...emptyDraft('saml'), name: 'S', domains: 'a.example', entityId: 'e', ssoUrl: 'https://idp/sso', certificates: `${PEM}\n${PEM}` }, false);
    expect(samlInput.saml?.certificates).toHaveLength(2);
    expect(identityProviderInputSchema.safeParse(samlInput).success).toBe(true);
  });

  it('warns about certificates that expire soon', () => {
    const now = Date.parse('2026-10-01T00:00:00Z');
    const cert = (notAfter: number) => ({ pem: PEM, subject: 'CN=x', notBefore: 0, fingerprint256: 'AA', notAfter });
    const saml = { entityId: 'e', ssoUrl: 'u', certificates: [cert(now + 10 * 86_400_000), cert(now + 40 * 86_400_000)], spEntityId: 's', acsUrl: 'a', metadataUrl: 'm' };
    expect(certificateDaysLeft(provider({ kind: 'saml', oidc: null, saml }), now)).toBe(40);
    expect(certificateDaysLeft(provider(), now)).toBeNull();
  });
});

describe('sign-in messages for single sign-on', () => {
  it('maps the codes the server sends back, generically for unknown ones', () => {
    expect(ssoErrorMessage('sso_no_account')).toBe(SSO_ERROR_MESSAGES.sso_no_account);
    expect(ssoErrorMessage('something_else')).toBe(SSO_ERROR_MESSAGES.sso_failed);
    expect(ssoErrorMessage(null)).toBeNull();
  });

  it('explains discovery failures and the single sign-on requirement', () => {
    expect(ssoDiscoverErrorMessage(new ApiError(404, 'sso_not_configured', 'Single sign-on is not set up for this email address.'))).toMatch(/not set up/);
    expect(ssoDiscoverErrorMessage(new ApiError(400, 'validation_failed', 'x'))).toBe('Enter your work email address.');
    expect(ssoDiscoverErrorMessage(new ApiError(429, 'rate_limited', 'x'))).toMatch(/Wait a minute/);
    expect(loginErrorMessage(new ApiError(403, 'sso_required', 'Your organisation signs in with single sign-on.'))).toBe('Your organisation signs in with single sign-on.');
  });
});

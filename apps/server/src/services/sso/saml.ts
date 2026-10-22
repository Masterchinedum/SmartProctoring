/**
 * SAML 2.0 sign-in (SP-initiated; AuthnRequest over HTTP-Redirect, Response over HTTP-POST) with `@node-saml/node-saml`
 * (MIT; XML signatures verified by xml-crypto — never by code of ours).
 *
 * What is accepted (validateSamlResponse):
 *  - a valid XML signature by one of the provider's configured certificates over the Response (covering its single
 *    assertion) or over the Assertion itself; anything else, multiple assertions or encrypted assertions are refused;
 *    only the signed content is read;
 *  - Conditions NotBefore / NotOnOrAfter with SAML_CLOCK_SKEW_MS, an assertion at most SAML_MAX_ASSERTION_AGE_MS old,
 *    AudienceRestriction = our SP entity ID (library);
 *  - the assertion's Issuer = the provider's entity ID; a bearer SubjectConfirmation whose Recipient is our ACS URL,
 *    whose InResponseTo is the ID of an AuthnRequest we sent for this provider (unsolicited / IdP-initiated responses
 *    are refused) and whose NotOnOrAfter has not passed (checked here, on the signed assertion);
 *  - each assertion ID once (sso_saml_assertions, kept until it would have expired).
 * node-saml measures time with the system clock; the checks here use ctx.now() (equal in production).
 */
import { randomBytes } from 'node:crypto';
import { SAML, ValidateInResponseTo, type Profile } from '@node-saml/node-saml';
import { SSO_DEFAULT_CLAIMS } from '@sp/shared';
import type { Ctx } from '../../context.js';
import type { IdentityProvider, SsoAttemptIdentity } from '../../db/schema.js';
import { ssoUrls } from './providers.js';

export const SAML_CLOCK_SKEW_MS = 60_000;
export const SAML_MAX_ASSERTION_AGE_MS = 10 * 60_000;
const BEARER = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';

type SamlCtx = Pick<Ctx, 'config' | 'now'>;

/** AuthnRequest IDs: an XML ID (starts with a letter or underscore), 160 random bits. */
export function newSamlRequestId(): string {
  return `_${randomBytes(20).toString('hex')}`;
}

function samlFor(ctx: SamlCtx, provider: IdentityProvider, requestId?: string, metadataOnly = false): SAML {
  const urls = ssoUrls(ctx.config.publicUrl, provider.id);
  return new SAML({
    callbackUrl: urls.acsUrl,
    entryPoint: provider.samlSsoUrl ?? undefined,
    issuer: urls.spEntityId,
    audience: urls.spEntityId,
    idpCert: provider.samlCertificates,
    idpIssuer: provider.samlEntityId ?? undefined,
    // Either the Response or the Assertion must carry a valid signature (node-saml requires one of them).
    wantAuthnResponseSigned: false,
    // The metadata asks providers to sign the assertion (what most do by default); validation also accepts a signed
    // Response that covers it.
    wantAssertionsSigned: metadataOnly,
    acceptedClockSkewMs: SAML_CLOCK_SKEW_MS,
    maxAssertionAgeMs: SAML_MAX_ASSERTION_AGE_MS,
    // InResponseTo is checked below against the signed assertion's SubjectConfirmationData and our stored request.
    validateInResponseTo: ValidateInResponseTo.never,
    identifierFormat: null,
    // Requesting a password authentication context would stop providers from using MFA / passwordless methods.
    disableRequestedAuthnContext: true,
    signatureAlgorithm: 'sha256',
    generateUniqueId: () => requestId ?? newSamlRequestId(),
  });
}

/** The identity provider URL with the deflated, base64 AuthnRequest (HTTP-Redirect binding). */
export async function samlAuthorizationUrl(ctx: SamlCtx, provider: IdentityProvider, requestId: string): Promise<string> {
  return samlFor(ctx, provider, requestId).getAuthorizeUrlAsync('', undefined, {});
}

/** Service provider metadata (entity ID, ACS with HTTP-POST, signed assertions wanted). */
export function samlServiceProviderMetadata(ctx: SamlCtx, provider: IdentityProvider): string {
  return samlFor(ctx, provider, undefined, true).generateServiceProviderMetadata(null, null);
}

export class SamlValidationError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'SamlValidationError';
  }
}

type XmlNode = { $?: Record<string, string>; _?: string } & Record<string, unknown>;
const first = (v: unknown): XmlNode | undefined => (Array.isArray(v) ? (v[0] as XmlNode) : undefined);
const parseTime = (v: string | undefined) => (v ? Date.parse(v) : NaN);

export interface ValidatedSamlResponse {
  identity: SsoAttemptIdentity;
  /** The AuthnRequest ID this response answers (our sso_login_attempts.saml_request_id). */
  inResponseTo: string;
  assertionId: string;
  /** Until when the assertion ID must be remembered (replay protection). */
  expiresAt: number;
}

/**
 * Verify a POSTed SAMLResponse (base64). Throws SamlValidationError (reason for the audit log) or a library error.
 * The caller then matches `inResponseTo` with a pending attempt of this provider and records the assertion ID.
 */
export async function validateSamlResponse(ctx: SamlCtx, provider: IdentityProvider, samlResponse: string): Promise<ValidatedSamlResponse> {
  const urls = ssoUrls(ctx.config.publicUrl, provider.id);
  let profile: Profile | null;
  try {
    ({ profile } = await samlFor(ctx, provider).validatePostResponseAsync({ SAMLResponse: samlResponse }));
  } catch (err) {
    throw new SamlValidationError('invalid_response', (err as Error)?.message?.slice(0, 300) || 'Invalid SAML response');
  }
  if (!profile?.getAssertion) throw new SamlValidationError('no_assertion', 'The response contains no assertion');
  const assertion = (profile.getAssertion() as { Assertion?: XmlNode }).Assertion;
  if (!assertion) throw new SamlValidationError('no_assertion', 'The response contains no assertion');
  const now = ctx.now();

  const issuer = profile.issuer;
  if (!issuer || issuer !== provider.samlEntityId) throw new SamlValidationError('wrong_issuer', `Assertion issuer ${issuer ?? '(none)'} is not the configured entity ID`);
  const assertionId = assertion.$?.ID;
  if (!assertionId) throw new SamlValidationError('no_assertion_id', 'The assertion has no ID');

  // A bearer confirmation for us, answering a request of ours, still valid.
  const confirmations = ((first(assertion.Subject)?.SubjectConfirmation as XmlNode[] | undefined) ?? []).filter((c) => c.$?.Method === BEARER);
  let reason = 'no_bearer_confirmation';
  let match: { inResponseTo: string; notOnOrAfter: number } | null = null;
  for (const c of confirmations) {
    const data = first(c.SubjectConfirmationData)?.$;
    if (!data) continue;
    if (data.Recipient !== urls.acsUrl) {
      reason = 'wrong_recipient';
      continue;
    }
    if (!data.InResponseTo) {
      reason = 'unsolicited';
      continue;
    }
    const notOnOrAfter = parseTime(data.NotOnOrAfter);
    const notBefore = parseTime(data.NotBefore);
    if (!Number.isFinite(notOnOrAfter) || now - SAML_CLOCK_SKEW_MS >= notOnOrAfter || (Number.isFinite(notBefore) && now + SAML_CLOCK_SKEW_MS < notBefore)) {
      reason = 'confirmation_expired';
      continue;
    }
    match = { inResponseTo: data.InResponseTo, notOnOrAfter };
    break;
  }
  if (!match) throw new SamlValidationError(reason, 'No valid bearer subject confirmation for this service provider');

  const conditionsEnd = parseTime(first(assertion.Conditions)?.$?.NotOnOrAfter);
  const expiresAt = Math.max(match.notOnOrAfter, Number.isFinite(conditionsEnd) ? conditionsEnd : 0, now + SAML_MAX_ASSERTION_AGE_MS) + SAML_CLOCK_SKEW_MS;
  if (!profile.nameID) throw new SamlValidationError('no_name_id', 'The assertion has no NameID');
  return { identity: identityFromProfile(provider, profile), inResponseTo: match.inResponseTo, assertionId, expiresAt };
}

const EMAIL_ATTRIBUTES = ['email', 'mail', 'emailAddress', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', 'urn:oid:0.9.2342.19200300.100.1.3'];
const NAME_ATTRIBUTES = ['displayName', 'http://schemas.microsoft.com/identity/claims/displayname', 'name', 'urn:oid:2.16.840.1.113730.3.1.241'];
const GROUP_ATTRIBUTES = ['groups', 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups', 'memberOf'];

/** The SAML profile → identity, through the provider's attribute mapping (else the usual attribute names). */
export function identityFromProfile(provider: Pick<IdentityProvider, 'claimMapping'>, profile: Profile): SsoAttemptIdentity {
  const attrs = ((profile as { attributes?: Record<string, unknown> }).attributes ?? {}) as Record<string, unknown>;
  const values = (name: string): string[] => {
    const v = attrs[name];
    const list = Array.isArray(v) ? v : v === undefined ? [] : [v];
    return list.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
  };
  const firstOf = (names: string[]) => names.map((n) => values(n)[0]).find((x) => x != null) ?? null;
  const mapping = provider.claimMapping ?? {};
  const isEmail = (s: string) => /^[^\s@]+@[^\s@]+$/.test(s);
  const emailFromAttrs = firstOf(mapping.email ? [mapping.email] : [...new Set([SSO_DEFAULT_CLAIMS.saml.email, ...EMAIL_ATTRIBUTES])]);
  const email = emailFromAttrs ?? (isEmail(profile.nameID) ? profile.nameID : null);
  const given = firstOf(['givenName', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname', 'urn:oid:2.5.4.42']);
  const sur = firstOf(['sn', 'surname', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname', 'urn:oid:2.5.4.4']);
  const name = firstOf(mapping.name ? [mapping.name] : [...new Set([SSO_DEFAULT_CLAIMS.saml.name, ...NAME_ATTRIBUTES])]) ?? ([given, sur].filter(Boolean).join(' ') || null);
  const groups = (mapping.groups ? [mapping.groups] : [...new Set([SSO_DEFAULT_CLAIMS.saml.groups, ...GROUP_ATTRIBUTES])]).flatMap(values);
  // A transient NameID changes at every sign-in: the account is then linked by the asserted email instead.
  const transient = profile.nameIDFormat === 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';
  const subject = transient && email ? `email:${email.toLowerCase()}` : profile.nameID;
  return { subject, email, emailVerified: null, name, groups: [...new Set(groups)].slice(0, 200) };
}

/** Test connection (no network: the SSO URL is a browser endpoint): the certificates and URLs. */
export function testSamlProvider(ctx: SamlCtx, provider: IdentityProvider, certs: { subject: string; notBefore: number; notAfter: number }[]): { name: string; ok: boolean; detail: string }[] {
  const now = ctx.now();
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  checks.push({ name: 'Single sign-on URL', ok: !!provider.samlSsoUrl, detail: provider.samlSsoUrl ?? 'Missing' });
  checks.push({ name: 'Entity ID', ok: !!provider.samlEntityId, detail: provider.samlEntityId ?? 'Missing' });
  if (certs.length === 0) checks.push({ name: 'Signing certificate', ok: false, detail: 'No valid certificate' });
  for (const c of certs) {
    const days = Math.floor((c.notAfter - now) / 86_400_000);
    const valid = now >= c.notBefore && now < c.notAfter;
    checks.push({
      name: 'Signing certificate',
      ok: valid,
      detail: `${c.subject} — ${valid ? (days < 30 ? `expires in ${days} day${days === 1 ? '' : 's'}: add the new certificate now` : `valid until ${new Date(c.notAfter).toISOString().slice(0, 10)}`) : now < c.notBefore ? 'not valid yet' : 'expired'}`,
    });
  }
  return checks;
}

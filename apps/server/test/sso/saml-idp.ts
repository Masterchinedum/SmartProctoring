/**
 * A test SAML identity provider: builds SAML 2.0 Responses for an AuthnRequest and signs the Assertion or the Response
 * with xml-crypto (the same library the service provider verifies with). Options produce the bad cases (tampered,
 * expired, wrong audience / recipient / issuer, unsolicited, unsigned).
 */
import { inflateRawSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { SignedXml } from 'xml-crypto';
import { selfSignedCertificate, type TestCertificate } from './x509.js';

export interface SamlAssertionOptions {
  /** Defaults from the AuthnRequest / the IdP. */
  inResponseTo?: string | null;
  recipient?: string;
  audience?: string;
  issuer?: string;
  nameId: string;
  nameIdFormat?: string;
  attributes?: Record<string, string | string[]>;
  /** Seconds relative to now. */
  notBeforeSec?: number;
  notOnOrAfterSec?: number;
  issueInstantSec?: number;
  sign?: 'assertion' | 'response' | 'none';
  assertionId?: string;
  /** Edit the XML after signing (tampering). */
  tamper?: (xml: string) => string;
  /** Sign with another key than the one the service provider trusts. */
  signingCert?: TestCertificate;
  now?: number;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export class TestSamlIdp {
  readonly cert: TestCertificate;
  constructor(
    readonly entityId: string,
    readonly ssoUrl: string,
  ) {
    this.cert = selfSignedCertificate('Test SAML IdP');
  }

  /** The AuthnRequest carried by an HTTP-Redirect URL (deflated, base64) — ID, ACS URL and issuer. */
  static parseRedirect(url: string): { id: string; acsUrl: string; issuer: string; xml: string; relayState: string | null } {
    const u = new URL(url);
    const xml = inflateRawSync(Buffer.from(u.searchParams.get('SAMLRequest') ?? '', 'base64')).toString('utf8');
    const id = /\sID="([^"]+)"/.exec(xml)?.[1] ?? '';
    const acsUrl = /AssertionConsumerServiceURL="([^"]+)"/.exec(xml)?.[1] ?? '';
    const issuer = /<saml:Issuer[^>]*>([^<]+)<\/saml:Issuer>/.exec(xml)?.[1] ?? '';
    return { id, acsUrl, issuer, xml, relayState: u.searchParams.get('RelayState') };
  }

  /** A base64 SAMLResponse. */
  response(o: SamlAssertionOptions & { request?: { id: string; acsUrl: string; issuer: string } }): string {
    const now = o.now ?? Date.now();
    const acs = o.recipient ?? o.request?.acsUrl ?? '';
    const audience = o.audience ?? o.request?.issuer ?? '';
    const inResponseTo = o.inResponseTo === undefined ? (o.request?.id ?? null) : o.inResponseTo;
    const issuer = o.issuer ?? this.entityId;
    const assertionId = o.assertionId ?? `_a${randomBytes(16).toString('hex')}`;
    const responseId = `_r${randomBytes(16).toString('hex')}`;
    const issued = iso(now + (o.issueInstantSec ?? 0) * 1000);
    const notBefore = iso(now + (o.notBeforeSec ?? -30) * 1000);
    const notOnOrAfter = iso(now + (o.notOnOrAfterSec ?? 300) * 1000);
    const irt = inResponseTo ? ` InResponseTo="${esc(inResponseTo)}"` : '';
    const attrs = Object.entries(o.attributes ?? {})
      .map(([name, v]) => `<saml:Attribute Name="${esc(name)}">${(Array.isArray(v) ? v : [v]).map((x) => `<saml:AttributeValue>${esc(x)}</saml:AttributeValue>`).join('')}</saml:Attribute>`)
      .join('');
    const assertion =
      `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${issued}">` +
      `<saml:Issuer>${esc(issuer)}</saml:Issuer>` +
      `<saml:Subject><saml:NameID Format="${esc(o.nameIdFormat ?? 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent')}">${esc(o.nameId)}</saml:NameID>` +
      `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}" Recipient="${esc(acs)}"${irt}/></saml:SubjectConfirmation></saml:Subject>` +
      `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${esc(audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
      `<saml:AuthnStatement AuthnInstant="${issued}" SessionIndex="_s${randomBytes(6).toString('hex')}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
      (attrs ? `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` : '') +
      `</saml:Assertion>`;
    let xml =
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${responseId}" Version="2.0" IssueInstant="${issued}" Destination="${esc(acs)}"${irt}>` +
      `<saml:Issuer>${esc(issuer)}</saml:Issuer>` +
      `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
      assertion +
      `</samlp:Response>`;
    const sign = o.sign ?? 'assertion';
    if (sign !== 'none') xml = this.sign(xml, sign, o.signingCert ?? this.cert);
    if (o.tamper) xml = o.tamper(xml);
    return Buffer.from(xml, 'utf8').toString('base64');
  }

  private sign(xml: string, what: 'assertion' | 'response', cert: TestCertificate): string {
    const el = what === 'assertion' ? 'Assertion' : 'Response';
    const sig = new SignedXml({
      privateKey: cert.privateKeyPem,
      publicCert: cert.certPem,
      canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    });
    sig.addReference({
      xpath: `//*[local-name(.)='${el}']`,
      transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    });
    sig.computeSignature(xml, { location: { reference: `//*[local-name(.)='${el}']/*[local-name(.)='Issuer']`, action: 'after' } });
    return sig.getSignedXml();
  }
}

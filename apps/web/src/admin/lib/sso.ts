import {
  normaliseDomain,
  OIDC_DEFAULT_SCOPES,
  PUBLIC_EMAIL_DOMAINS,
  type IdentityProviderDTO,
  type IdentityProviderInput,
  type SsoAssignableRole,
  type SsoProviderKind,
  type SsoRoleMapping,
} from '@sp/shared';
import { ApiError, errorMessage } from '../api/client';

/** The identity-provider form (Settings → Single sign-on). Text fields as typed; converted by draftToInput. */
export interface ProviderDraft {
  kind: SsoProviderKind;
  name: string;
  enabled: boolean;
  /** Comma, space or line separated. */
  domains: string;
  jitEnabled: boolean;
  jitDefaultRole: SsoAssignableRole;
  roleMappings: { group: string; role: SsoAssignableRole }[];
  claimEmail: string;
  claimName: string;
  claimGroups: string;
  issuer: string;
  clientId: string;
  /** A new secret ('' = keep the stored one when editing). */
  clientSecret: string;
  removeSecret: boolean;
  scopes: string;
  requireVerifiedEmail: boolean;
  entityId: string;
  ssoUrl: string;
  /** One or more PEM blocks (or a base64 value from the provider's metadata). */
  certificates: string;
}

export function emptyDraft(kind: SsoProviderKind = 'oidc'): ProviderDraft {
  return {
    kind,
    name: '',
    enabled: false,
    domains: '',
    jitEnabled: false,
    jitDefaultRole: 'reviewer',
    roleMappings: [],
    claimEmail: '',
    claimName: '',
    claimGroups: '',
    issuer: '',
    clientId: '',
    clientSecret: '',
    removeSecret: false,
    scopes: OIDC_DEFAULT_SCOPES,
    requireVerifiedEmail: true,
    entityId: '',
    ssoUrl: '',
    certificates: '',
  };
}

export function draftFromProvider(p: IdentityProviderDTO): ProviderDraft {
  return {
    ...emptyDraft(p.kind),
    name: p.name,
    enabled: p.enabled,
    domains: p.domains.join(', '),
    jitEnabled: p.jit.enabled,
    jitDefaultRole: p.jit.defaultRole,
    roleMappings: p.roleMappings.map((m) => ({ ...m })),
    claimEmail: p.claimMapping.email,
    claimName: p.claimMapping.name,
    claimGroups: p.claimMapping.groups,
    issuer: p.oidc?.issuer ?? '',
    clientId: p.oidc?.clientId ?? '',
    scopes: p.oidc?.scopes ?? OIDC_DEFAULT_SCOPES,
    requireVerifiedEmail: p.oidc?.requireVerifiedEmail ?? true,
    entityId: p.saml?.entityId ?? '',
    ssoUrl: p.saml?.ssoUrl ?? '',
    certificates: (p.saml?.certificates ?? []).map((c) => c.pem.trim()).join('\n'),
  };
}

/** "example.edu, @Staff.Example.edu" → valid lower-case domains, and what could not be read. */
export function parseDomains(text: string): { domains: string[]; invalid: string[]; publicMail: string[] } {
  const parts = text
    .split(/[\s,;]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const domains: string[] = [];
  const invalid: string[] = [];
  const publicMail: string[] = [];
  for (const p of parts) {
    const d = normaliseDomain(p);
    if (!d) invalid.push(p);
    else if ((PUBLIC_EMAIL_DOMAINS as readonly string[]).includes(d)) publicMail.push(d);
    else if (!domains.includes(d)) domains.push(d);
  }
  return { domains, invalid, publicMail };
}

/** Split pasted certificates: PEM blocks, or one base64 value. */
export function splitCertificates(text: string): string[] {
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (blocks) return blocks.map((b) => b.trim());
  const bare = text.replace(/\s+/g, '');
  return bare ? [bare] : [];
}

const isHttpUrl = (s: string) => {
  try {
    const u = new URL(s.trim());
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
};

/** Field messages for the form (keys: draft field names). */
export function validateDraft(d: ProviderDraft): Record<string, string> {
  const e: Record<string, string> = {};
  if (!d.name.trim()) e.name = 'Give the provider a name staff will recognise';
  const { domains, invalid, publicMail } = parseDomains(d.domains);
  if (invalid.length) e.domains = `Not a domain name: ${invalid.join(', ')}`;
  else if (publicMail.length) e.domains = `${publicMail.join(', ')} is a public email provider; enter your organisation’s own domain`;
  else if (domains.length === 0) e.domains = 'Add at least one email domain, for example example.edu';
  if (d.kind === 'oidc') {
    if (!isHttpUrl(d.issuer)) e.issuer = 'Enter the issuer URL, for example https://login.microsoftonline.com/<tenant>/v2.0';
    else if (d.issuer.includes('/.well-known/')) e.issuer = 'Enter the issuer itself, without /.well-known/openid-configuration';
    if (!d.clientId.trim()) e.clientId = 'Enter the client (application) ID';
    if (!d.scopes.split(/\s+/).includes('openid')) e.scopes = 'The scopes must include openid';
  } else {
    if (!d.entityId.trim()) e.entityId = 'Enter the identity provider’s entity ID (issuer)';
    if (!isHttpUrl(d.ssoUrl)) e.ssoUrl = 'Enter the single sign-on URL';
    const certs = splitCertificates(d.certificates);
    if (certs.length === 0) e.certificates = 'Paste the signing certificate';
    else if (certs.length > 3) e.certificates = 'At most three certificates';
  }
  d.roleMappings.forEach((m, i) => {
    if (!m.group.trim()) e[`roleMappings.${i}`] = 'Enter the group name or ID';
  });
  return e;
}

export function draftToInput(d: ProviderDraft, editing: boolean): IdentityProviderInput {
  const roleMappings: SsoRoleMapping[] = d.roleMappings.filter((m) => m.group.trim()).map((m) => ({ group: m.group.trim(), role: m.role }));
  const base = {
    kind: d.kind,
    name: d.name.trim(),
    enabled: d.enabled,
    domains: parseDomains(d.domains).domains,
    jit: { enabled: d.jitEnabled, defaultRole: d.jitDefaultRole },
    roleMappings,
    claimMapping: { email: d.claimEmail.trim(), name: d.claimName.trim(), groups: d.claimGroups.trim() },
  };
  if (d.kind === 'oidc') {
    // Editing: an empty secret keeps the stored one; "remove" turns the client into a public client (PKCE only).
    const clientSecret = d.removeSecret ? null : d.clientSecret.trim() ? d.clientSecret.trim() : editing ? undefined : null;
    return {
      ...base,
      oidc: { issuer: d.issuer.trim(), clientId: d.clientId.trim(), ...(clientSecret !== undefined ? { clientSecret } : {}), scopes: d.scopes.trim(), requireVerifiedEmail: d.requireVerifiedEmail },
    };
  }
  return { ...base, saml: { entityId: d.entityId.trim(), ssoUrl: d.ssoUrl.trim(), certificates: splitCertificates(d.certificates) } };
}

/** Days until the soonest certificate expiry (negative: expired), or null. */
export function certificateDaysLeft(p: IdentityProviderDTO, now = Date.now()): number | null {
  const ends = (p.saml?.certificates ?? []).map((c) => c.notAfter);
  if (!ends.length) return null;
  return Math.floor((Math.max(...ends) - now) / 86_400_000);
}

/** Message for a failed "Sign in with your organisation" lookup. */
export function ssoDiscoverErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'sso_not_configured') return err.message;
    if (err.status === 400) return 'Enter your work email address.';
    if (err.status === 429) return 'Too many attempts. Wait a minute and try again.';
  }
  return errorMessage(err);
}

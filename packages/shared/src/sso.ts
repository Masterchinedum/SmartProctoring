import { z } from 'zod';

/**
 * Single sign-on (OIDC / SAML 2.0) and SCIM 2.0 provisioning for staff.
 *
 *  - An organisation configures one or more identity providers (owner only; administrators can view them and test a
 *    connection). Each provider claims email domains; a domain belongs to at most one provider on the server, so the
 *    sign-in page can send `someone@example.edu` to the right provider (`POST /api/auth/sso/discover`). Every provider
 *    also has its own sign-in link (`signInUrl`).
 *  - A single sign-on creates the normal staff session. The identity provider is responsible for the second factor:
 *    SmartProctoring's own two-step sign-in is not asked after it. Owners keep their password (and two-step sign-in)
 *    as break-glass access even when the organisation requires single sign-on for everyone else.
 *  - SCIM: one bearer token per organisation (shown once) for /scim/v2/Users; roles through the `roles` attribute.
 */

export const SSO_PROVIDER_KINDS = ['oidc', 'saml'] as const;
export type SsoProviderKind = (typeof SSO_PROVIDER_KINDS)[number];

export const SSO_PROVIDER_KIND_LABEL: Record<SsoProviderKind, string> = { oidc: 'OpenID Connect', saml: 'SAML 2.0' };

/** Roles a provider (just-in-time accounts, group mapping) or SCIM may give: never owner. */
export const SSO_ASSIGNABLE_ROLES = ['reviewer', 'admin'] as const;
export type SsoAssignableRole = (typeof SSO_ASSIGNABLE_ROLES)[number];

/** Defaults for the claim (OIDC) / attribute (SAML) names; empty in a provider's mapping = use these. */
export const SSO_DEFAULT_CLAIMS: Record<SsoProviderKind, { email: string; name: string; groups: string }> = {
  oidc: { email: 'email', name: 'name', groups: 'groups' },
  // SAML: the email comes from the attribute below, the common email attributes, or an email-shaped NameID.
  saml: { email: 'email', name: 'displayName', groups: 'groups' },
};

export const OIDC_DEFAULT_SCOPES = 'openid email profile';

/** Personal mailbox providers cannot be claimed as an organisation's single sign-on domain. */
export const PUBLIC_EMAIL_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.de',
  'web.de',
  'mail.com',
  'yandex.com',
  'zoho.com',
] as const;

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** `Example.EDU ` → `example.edu`; null when it is not a host name. */
export function normaliseDomain(input: string): string | null {
  const d = input.trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
  return DOMAIN_RE.test(d) ? d : null;
}

/** The domain part of an email address (lower case), or null. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return null;
  return normaliseDomain(email.slice(at + 1));
}

const domainSchema = z
  .string()
  .max(253)
  .transform((v, ctx) => {
    const d = normaliseDomain(v);
    if (!d) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `“${v.trim()}” is not a domain name (for example example.edu)` });
      return z.NEVER;
    }
    if ((PUBLIC_EMAIL_DOMAINS as readonly string[]).includes(d)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${d} is a public email provider; claim your organisation’s own domain` });
      return z.NEVER;
    }
    return d;
  });

const claimName = z.string().trim().max(200);

export const ssoClaimMappingSchema = z.object({ email: claimName.optional(), name: claimName.optional(), groups: claimName.optional() });
export type SsoClaimMapping = z.infer<typeof ssoClaimMappingSchema>;

export const ssoRoleMappingSchema = z.object({ group: z.string().trim().min(1).max(200), role: z.enum(SSO_ASSIGNABLE_ROLES) });
export type SsoRoleMapping = z.infer<typeof ssoRoleMappingSchema>;

const httpUrl = z
  .string()
  .trim()
  .max(1000)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'Enter an https:// address');

export const oidcProviderInputSchema = z.object({
  /** The issuer (discovery at `<issuer>/.well-known/openid-configuration`). */
  issuer: httpUrl,
  clientId: z.string().trim().min(1).max(300),
  /** Write-only. Omitted: keep the stored secret; null or '': remove it (public client with PKCE only). */
  clientSecret: z.string().max(2000).nullable().optional(),
  scopes: z.string().trim().max(300).optional(),
  /** Refuse sign-ins whose `email_verified` claim is not true (default on; Microsoft Entra ID does not send it). */
  requireVerifiedEmail: z.boolean().optional(),
});

export const samlProviderInputSchema = z.object({
  /** The identity provider's entity ID (the Issuer of its assertions). */
  entityId: z.string().trim().min(1).max(500),
  /** Its single sign-on service URL (HTTP-Redirect binding). */
  ssoUrl: httpUrl,
  /** Signing certificates (PEM or base64 DER), 1–3 (a second one during a certificate rollover). */
  certificates: z.array(z.string().trim().min(1).max(20_000)).min(1).max(3),
});

export const identityProviderInputSchema = z
  .object({
    kind: z.enum(SSO_PROVIDER_KINDS),
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean().default(false),
    domains: z.array(domainSchema).min(1, 'Add at least one email domain').max(20),
    jit: z.object({ enabled: z.boolean(), defaultRole: z.enum(SSO_ASSIGNABLE_ROLES) }).default({ enabled: false, defaultRole: 'reviewer' }),
    roleMappings: z.array(ssoRoleMappingSchema).max(50).default([]),
    claimMapping: ssoClaimMappingSchema.default({}),
    oidc: oidcProviderInputSchema.optional(),
    saml: samlProviderInputSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'oidc' && !v.oidc) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['oidc'], message: 'OpenID Connect settings are required' });
    if (v.kind === 'saml' && !v.saml) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['saml'], message: 'SAML settings are required' });
    if (new Set(v.domains).size !== v.domains.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['domains'], message: 'A domain is listed twice' });
  });
export type IdentityProviderInput = z.input<typeof identityProviderInputSchema>;

export interface SamlCertificateInfoDTO {
  /** As stored (PEM). */
  pem: string;
  subject: string;
  notBefore: number;
  notAfter: number;
  /** SHA-256 fingerprint (AA:BB:…). */
  fingerprint256: string;
}

export interface IdentityProviderDTO {
  id: string;
  kind: SsoProviderKind;
  name: string;
  enabled: boolean;
  domains: string[];
  jit: { enabled: boolean; defaultRole: SsoAssignableRole };
  roleMappings: SsoRoleMapping[];
  /** As configured ('' = the default for the kind, SSO_DEFAULT_CLAIMS). */
  claimMapping: { email: string; name: string; groups: string };
  oidc: {
    issuer: string;
    clientId: string;
    clientSecretSet: boolean;
    scopes: string;
    requireVerifiedEmail: boolean;
    /** Register this redirect URI with the identity provider. */
    redirectUri: string;
  } | null;
  saml: {
    entityId: string;
    ssoUrl: string;
    certificates: SamlCertificateInfoDTO[];
    /** This service provider's entity ID (= the metadata URL). */
    spEntityId: string;
    /** Assertion consumer service (HTTP-POST). */
    acsUrl: string;
    metadataUrl: string;
  } | null;
  /** Organisation-specific sign-in link (starts single sign-on with this provider). */
  signInUrl: string;
  /** Staff accounts linked to this provider. */
  linkedUsers: number;
  createdAt: number;
  updatedAt: number;
}

/** GET /api/admin/scim/token (and the SCIM part of GET /api/admin/sso). */
export interface ScimStatusDTO {
  /** SCIM base URL to enter in the identity provider (…/scim/v2). */
  baseUrl: string;
  token: { id: string; prefix: string; createdAt: number; createdBy: { id: string; name: string } | null; lastUsedAt: number | null } | null;
}

/** POST /api/admin/scim/token: the new token, shown once. */
export interface CreatedScimTokenDTO extends ScimStatusDTO {
  secret: string;
}

export const SCIM_TOKEN_PREFIX = 'sp_scim_';
export const SCIM_TOKEN_PATTERN = /^sp_scim_[A-Za-z0-9_-]{43}$/;

/** GET /api/admin/sso */
export interface SsoOverviewDTO {
  providers: IdentityProviderDTO[];
  /** OrgSettingsDTO.requireSso (changed through PUT /settings, owner only). */
  requireSso: boolean;
  scim: ScimStatusDTO;
}

/** POST /api/admin/sso/providers/:id/test */
export interface SsoTestResultDTO {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

/** POST /api/auth/sso/discover — which provider signs this address in. */
export const ssoDiscoverSchema = z.object({ email: z.string().trim().email().max(254), next: z.string().max(500).optional() });

export interface SsoDiscoverResponse {
  providerName: string;
  /** Navigate the browser here (GET): it redirects to the identity provider. */
  startUrl: string;
}

/**
 * Why a single sign-on did not complete: the sign-in page reads `?sso_error=<code>` after the redirect back. The
 * messages are deliberately general (the audit log has the precise reason, e.g. a wrong audience or nonce).
 */
export const SSO_ERROR_MESSAGES = {
  sso_failed: 'Single sign-on did not complete. Try again, or contact your administrator if it keeps happening.',
  sso_expired: 'That sign-in took too long or was started in another browser. Start single sign-on again.',
  sso_cancelled: 'Your organisation’s sign-in was cancelled or refused.',
  sso_unavailable: 'Single sign-on is not available for this organisation right now. Contact your administrator.',
  sso_provider_error: 'Your organisation’s identity provider could not be reached. Try again in a moment.',
  sso_no_account: 'There is no SmartProctoring staff account for you yet. Ask your administrator to add you.',
  sso_account_disabled: 'This account is disabled. Contact your administrator.',
  sso_domain_not_allowed: 'Your email address is not one this organisation signs in with single sign-on.',
  sso_email_unverified: 'Your identity provider did not confirm your email address, so you cannot be signed in with it.',
  sso_identity_mismatch: 'This account is linked to a different identity at your organisation. Ask your administrator to unlink it.',
} as const;
export type SsoErrorCode = keyof typeof SSO_ERROR_MESSAGES;
export const SSO_ERROR_CODES = Object.keys(SSO_ERROR_MESSAGES) as SsoErrorCode[];

export function ssoErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return (SSO_ERROR_MESSAGES as Record<string, string>)[code] ?? SSO_ERROR_MESSAGES.sso_failed;
}

/** How the current staff session was signed in (GET /api/auth/me → security.signInMethod). */
export type StaffSignInMethod = 'password' | 'sso';

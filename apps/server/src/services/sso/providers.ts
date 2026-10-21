/**
 * Identity providers of an organisation (OpenID Connect / SAML 2.0) — configuration, validation, staff-facing DTOs.
 *
 *  - Owners create, change and delete providers; administrators can view them (routes/admin/sso.ts).
 *  - Each provider claims email domains (table sso_domains, one provider per domain on the whole server): the sign-in
 *    page finds the provider from the address typed, and only addresses of those domains are accepted from it.
 *  - The OIDC client secret is encrypted (AAD `sso-client-secret:<id>`, a rekey target) and never returned.
 *  - Disabling a provider, pointing it at another issuer / entity, or deleting it ends the sessions signed in through
 *    it; a new issuer also drops the account links (subjects are only meaningful at one issuer).
 */
import { randomUUID, X509Certificate } from 'node:crypto';
import { OIDC_DEFAULT_SCOPES, type IdentityProviderDTO, type IdentityProviderInput, type SamlCertificateInfoDTO, type SsoAssignableRole, type SsoRoleMapping } from '@sp/shared';
import { identityProviderInputSchema } from '@sp/shared';
import { and, count, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Ctx } from '../../context.js';
import type { DbOrTx } from '../../db/index.js';
import { identityProviders, organizations, ssoDomains, staffSsoIdentities, type IdentityProvider } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { orgSettings } from '../org.js';

export const ssoClientSecretAad = (providerId: string) => `sso-client-secret:${providerId}`;

/** Serialises domain claims across organisations (a domain belongs to one provider). */
const DOMAIN_LOCK = 'sso-domains';

export interface SsoUrls {
  signInUrl: string;
  redirectUri: string;
  spEntityId: string;
  metadataUrl: string;
  acsUrl: string;
}

/** Per-provider URLs (a provider id in every URL: no mix-up between providers). */
export function ssoUrls(publicUrl: string, providerId: string): SsoUrls {
  const base = `${publicUrl}/api/auth/sso`;
  const metadataUrl = `${base}/saml/${providerId}/metadata`;
  return {
    signInUrl: `${base}/${providerId}/start`,
    redirectUri: `${base}/oidc/${providerId}/callback`,
    spEntityId: metadataUrl,
    metadataUrl,
    acsUrl: `${base}/saml/${providerId}/acs`,
  };
}

/* ------------------------------------------------------------------ certificates */

/** A PEM certificate or base64 DER (whitespace ignored) → the parsed certificate, or null. */
export function parseCertificate(input: string): X509Certificate | null {
  const text = input.trim();
  try {
    if (text.includes('-----BEGIN CERTIFICATE-----')) return new X509Certificate(text);
    const der = Buffer.from(text.replace(/\s+/g, ''), 'base64');
    if (der.length < 100) return null;
    return new X509Certificate(der);
  } catch {
    return null;
  }
}

export function certificateInfo(pem: string): SamlCertificateInfoDTO | null {
  const cert = parseCertificate(pem);
  if (!cert) return null;
  return { pem: cert.toString(), subject: cert.subject.replace(/\n/g, ', '), notBefore: Date.parse(cert.validFrom), notAfter: Date.parse(cert.validTo), fingerprint256: cert.fingerprint256 };
}

/* ------------------------------------------------------------------ DTOs */

export interface ProviderWithDomains {
  row: IdentityProvider;
  domains: string[];
  linkedUsers: number;
}

export function toIdentityProviderDTO(publicUrl: string, p: ProviderWithDomains): IdentityProviderDTO {
  const { row } = p;
  const urls = ssoUrls(publicUrl, row.id);
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    enabled: row.enabled,
    domains: [...p.domains].sort(),
    jit: { enabled: row.jitEnabled, defaultRole: row.jitDefaultRole },
    roleMappings: row.roleMappings ?? [],
    claimMapping: { email: row.claimMapping?.email ?? '', name: row.claimMapping?.name ?? '', groups: row.claimMapping?.groups ?? '' },
    oidc:
      row.kind === 'oidc'
        ? {
            issuer: row.oidcIssuer ?? '',
            clientId: row.oidcClientId ?? '',
            clientSecretSet: row.oidcClientSecretEnc != null,
            scopes: row.oidcScopes,
            requireVerifiedEmail: row.oidcRequireVerifiedEmail,
            redirectUri: urls.redirectUri,
          }
        : null,
    saml:
      row.kind === 'saml'
        ? {
            entityId: row.samlEntityId ?? '',
            ssoUrl: row.samlSsoUrl ?? '',
            certificates: (row.samlCertificates ?? []).map(certificateInfo).filter((c): c is SamlCertificateInfoDTO => c != null),
            spEntityId: urls.spEntityId,
            acsUrl: urls.acsUrl,
            metadataUrl: urls.metadataUrl,
          }
        : null,
    signInUrl: urls.signInUrl,
    linkedUsers: p.linkedUsers,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/* ------------------------------------------------------------------ queries */

async function withDomains(db: DbOrTx, rows: IdentityProvider[]): Promise<ProviderWithDomains[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [domains, links] = await Promise.all([
    db.select().from(ssoDomains).where(inArray(ssoDomains.providerId, ids)),
    db
      .select({ providerId: staffSsoIdentities.providerId, n: count() })
      .from(staffSsoIdentities)
      .where(inArray(staffSsoIdentities.providerId, ids))
      .groupBy(staffSsoIdentities.providerId),
  ]);
  return rows.map((row) => ({
    row,
    domains: domains.filter((d) => d.providerId === row.id).map((d) => d.domain),
    linkedUsers: links.find((l) => l.providerId === row.id)?.n ?? 0,
  }));
}

export async function listProviders(db: DbOrTx, orgId: string): Promise<ProviderWithDomains[]> {
  const rows = await db.select().from(identityProviders).where(eq(identityProviders.orgId, orgId)).orderBy(identityProviders.createdAt, identityProviders.id);
  return withDomains(db, rows);
}

/** A provider of the organisation (404 otherwise: other organisations' ids are not revealed). */
export async function loadProvider(db: DbOrTx, orgId: string, id: string, lock = false): Promise<IdentityProvider> {
  const q = db
    .select()
    .from(identityProviders)
    .where(and(eq(identityProviders.id, id), eq(identityProviders.orgId, orgId)));
  const [row] = lock ? await q.for('update') : await q;
  if (!row) throw notFound('Identity provider not found', 'sso_provider_not_found');
  return row;
}

export async function loadProviderWithDomains(db: DbOrTx, orgId: string, id: string): Promise<ProviderWithDomains> {
  return (await withDomains(db, [await loadProvider(db, orgId, id)]))[0];
}

/** The enabled provider that signs in addresses of `domain`, if any. */
export async function providerForDomain(db: DbOrTx, domain: string): Promise<IdentityProvider | null> {
  const [row] = await db
    .select({ p: identityProviders })
    .from(ssoDomains)
    .innerJoin(identityProviders, eq(identityProviders.id, ssoDomains.providerId))
    .where(and(eq(ssoDomains.domain, domain), eq(identityProviders.enabled, true)));
  return row?.p ?? null;
}

export async function providerDomains(db: DbOrTx, providerId: string): Promise<string[]> {
  return (await db.select({ d: ssoDomains.domain }).from(ssoDomains).where(eq(ssoDomains.providerId, providerId))).map((r) => r.d);
}

export async function enabledProviderCount(db: DbOrTx, orgId: string, exceptId?: string): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(identityProviders)
    .where(and(eq(identityProviders.orgId, orgId), eq(identityProviders.enabled, true), exceptId ? ne(identityProviders.id, exceptId) : undefined));
  return r?.n ?? 0;
}

/* ------------------------------------------------------------------ create / update / delete */

type ParsedInput = ReturnType<typeof identityProviderInputSchema.parse>;

interface WriteCtx {
  ctx: Pick<Ctx, 'db' | 'keyring' | 'config' | 'now'>;
  orgId: string;
  actorId: string;
  ip: string;
}

/** Field checks that need the server configuration (https in production, certificates). */
function validateProviderInput(input: ParsedInput, requireHttps: boolean): void {
  const issues: { path: string; message: string }[] = [];
  const https = (path: string, url: string | undefined) => {
    if (url && requireHttps && !url.toLowerCase().startsWith('https://')) issues.push({ path, message: 'Use an https:// address' });
  };
  if (input.kind === 'oidc' && input.oidc) {
    https('oidc.issuer', input.oidc.issuer);
    if (/\/\.well-known\//.test(input.oidc.issuer)) issues.push({ path: 'oidc.issuer', message: 'Enter the issuer itself (without /.well-known/openid-configuration)' });
    const scopes = (input.oidc.scopes ?? OIDC_DEFAULT_SCOPES).split(/\s+/).filter(Boolean);
    if (!scopes.includes('openid')) issues.push({ path: 'oidc.scopes', message: 'The scopes must include openid' });
  }
  if (input.kind === 'saml' && input.saml) {
    https('saml.ssoUrl', input.saml.ssoUrl);
    input.saml.certificates.forEach((c, i) => {
      if (!parseCertificate(c)) issues.push({ path: `saml.certificates.${i}`, message: 'Not an X.509 certificate (paste the PEM text or the base64 value from the provider’s metadata)' });
    });
  }
  if (issues.length) throw validationFailed('Invalid identity provider settings', issues);
}

/** Claim the domains for `providerId` (409 sso_domain_taken when another provider has one). Caller holds DOMAIN_LOCK. */
async function claimDomains(tx: DbOrTx, orgId: string, providerId: string, domains: string[]): Promise<{ added: string[]; removed: string[] }> {
  const taken = domains.length
    ? await tx
        .select({ domain: ssoDomains.domain })
        .from(ssoDomains)
        .where(and(inArray(ssoDomains.domain, domains), ne(ssoDomains.providerId, providerId)))
    : [];
  if (taken.length) {
    throw conflict('sso_domain_taken', `${taken.map((t) => t.domain).join(', ')} already signs in through another identity provider. Each domain can belong to one provider only.`, { domains: taken.map((t) => t.domain) });
  }
  const current = await providerDomains(tx, providerId);
  const added = domains.filter((d) => !current.includes(d));
  const removed = current.filter((d) => !domains.includes(d));
  if (removed.length) await tx.delete(ssoDomains).where(and(eq(ssoDomains.providerId, providerId), inArray(ssoDomains.domain, removed)));
  if (added.length) await tx.insert(ssoDomains).values(added.map((domain) => ({ domain, providerId, orgId })));
  return { added, removed };
}

function columnsFrom(input: ParsedInput) {
  const mapping = Object.fromEntries(Object.entries(input.claimMapping ?? {}).filter(([, v]) => typeof v === 'string' && v.trim() !== '')) as Record<string, string>;
  return {
    name: input.name,
    enabled: input.enabled,
    jitEnabled: input.jit.enabled,
    jitDefaultRole: input.jit.defaultRole,
    roleMappings: input.roleMappings as SsoRoleMapping[],
    claimMapping: mapping,
    oidcIssuer: input.kind === 'oidc' ? input.oidc!.issuer.replace(/\/+$/, '') : null,
    oidcClientId: input.kind === 'oidc' ? input.oidc!.clientId : null,
    oidcScopes: input.kind === 'oidc' ? (input.oidc!.scopes?.trim() || OIDC_DEFAULT_SCOPES) : OIDC_DEFAULT_SCOPES,
    oidcRequireVerifiedEmail: input.kind === 'oidc' ? input.oidc!.requireVerifiedEmail ?? true : true,
    samlEntityId: input.kind === 'saml' ? input.saml!.entityId : null,
    samlSsoUrl: input.kind === 'saml' ? input.saml!.ssoUrl : null,
    samlCertificates: input.kind === 'saml' ? input.saml!.certificates.map((c) => parseCertificate(c)!.toString()) : [],
  };
}

export async function createProvider(w: WriteCtx, body: unknown): Promise<ProviderWithDomains> {
  const input = identityProviderInputSchema.parse(body);
  validateProviderInput(input, w.ctx.config.sso.requireHttps);
  const id = randomUUID();
  const now = new Date(w.ctx.now());
  const secret = input.kind === 'oidc' ? input.oidc!.clientSecret?.trim() || null : null;
  return w.ctx.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${DOMAIN_LOCK}))`);
    const cols = columnsFrom(input);
    const [row] = await tx
      .insert(identityProviders)
      .values({ id, orgId: w.orgId, kind: input.kind, ...cols, oidcClientSecretEnc: secret ? w.ctx.keyring.encryptString(secret, ssoClientSecretAad(id)) : null, createdBy: w.actorId, createdAt: now, updatedAt: now })
      .returning();
    await claimDomains(tx, w.orgId, id, input.domains);
    await audit(tx, {
      orgId: w.orgId,
      actorType: 'staff',
      actorId: w.actorId,
      action: 'sso.provider_created',
      targetType: 'identity_provider',
      targetId: id,
      meta: { kind: input.kind, name: input.name, enabled: input.enabled, domains: input.domains, jit: input.jit, clientSecret: secret ? 'set' : 'none' },
      ip: w.ip,
      at: now.getTime(),
    });
    return (await withDomains(tx, [row]))[0];
  });
}

export interface ProviderUpdateResult {
  provider: ProviderWithDomains;
  /** Sessions signed in through it must end (disabled, or another issuer / entity). */
  endSessions: boolean;
}

export async function updateProvider(w: WriteCtx, id: string, body: unknown): Promise<ProviderUpdateResult> {
  const input = identityProviderInputSchema.parse(body);
  validateProviderInput(input, w.ctx.config.sso.requireHttps);
  const now = new Date(w.ctx.now());
  return w.ctx.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${DOMAIN_LOCK}))`);
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, w.orgId)).for('update');
    const cur = await loadProvider(tx, w.orgId, id, true);
    if (cur.kind !== input.kind) throw conflict('sso_kind_immutable', 'The kind of an identity provider cannot be changed. Add a new provider instead.');
    if (cur.enabled && !input.enabled && orgSettings(org).requireSso && (await enabledProviderCount(tx, w.orgId, id)) === 0) {
      throw conflict('sso_required_needs_provider', 'Single sign-on is required for your organisation. Turn that requirement off before disabling the last identity provider.');
    }
    const cols = columnsFrom(input);
    let secretChange: 'set' | 'removed' | null = null;
    let secretEnc = cur.oidcClientSecretEnc;
    if (input.kind === 'oidc' && input.oidc!.clientSecret !== undefined) {
      const s = input.oidc!.clientSecret?.trim() || null;
      secretEnc = s ? w.ctx.keyring.encryptString(s, ssoClientSecretAad(id)) : null;
      secretChange = s ? 'set' : cur.oidcClientSecretEnc ? 'removed' : null;
    }
    const repointed = (cur.kind === 'oidc' && cols.oidcIssuer !== cur.oidcIssuer) || (cur.kind === 'saml' && cols.samlEntityId !== cur.samlEntityId);
    const [row] = await tx
      .update(identityProviders)
      .set({ ...cols, oidcClientSecretEnc: secretEnc, updatedAt: now })
      .where(eq(identityProviders.id, id))
      .returning();
    const domains = await claimDomains(tx, w.orgId, id, input.domains);
    let linksRemoved = 0;
    if (repointed) linksRemoved = (await tx.delete(staffSsoIdentities).where(eq(staffSsoIdentities.providerId, id)).returning({ id: staffSsoIdentities.id })).length;
    const fields = (Object.keys(cols) as (keyof typeof cols)[]).filter((k) => JSON.stringify(cols[k]) !== JSON.stringify(cur[k]));
    await audit(tx, {
      orgId: w.orgId,
      actorType: 'staff',
      actorId: w.actorId,
      action: 'sso.provider_updated',
      targetType: 'identity_provider',
      targetId: id,
      meta: {
        fields: [...fields, ...(domains.added.length || domains.removed.length ? ['domains'] : []), ...(secretChange ? ['clientSecret'] : [])],
        ...(cur.enabled !== input.enabled ? { enabled: { from: cur.enabled, to: input.enabled } } : {}),
        ...(domains.added.length ? { domainsAdded: domains.added } : {}),
        ...(domains.removed.length ? { domainsRemoved: domains.removed } : {}),
        ...(secretChange ? { clientSecret: secretChange } : {}),
        ...(repointed ? { linksRemoved } : {}),
      },
      ip: w.ip,
      at: now.getTime(),
    });
    return { provider: (await withDomains(tx, [row]))[0], endSessions: (cur.enabled && !input.enabled) || repointed };
  });
}

export async function deleteProvider(w: WriteCtx, id: string): Promise<void> {
  const now = w.ctx.now();
  await w.ctx.db.transaction(async (tx) => {
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, w.orgId)).for('update');
    const cur = await loadProvider(tx, w.orgId, id, true);
    if (cur.enabled && orgSettings(org).requireSso && (await enabledProviderCount(tx, w.orgId, id)) === 0) {
      throw conflict('sso_required_needs_provider', 'Single sign-on is required for your organisation. Turn that requirement off before deleting the last identity provider.');
    }
    const domains = await providerDomains(tx, id);
    const [{ n: links }] = await tx.select({ n: count() }).from(staffSsoIdentities).where(eq(staffSsoIdentities.providerId, id));
    await tx.delete(identityProviders).where(eq(identityProviders.id, id));
    await audit(tx, {
      orgId: w.orgId,
      actorType: 'staff',
      actorId: w.actorId,
      action: 'sso.provider_deleted',
      targetType: 'identity_provider',
      targetId: id,
      meta: { kind: cur.kind, name: cur.name, domains, linksRemoved: links },
      ip: w.ip,
      at: now,
    });
  });
}

/** Role of a just-in-time account: the highest role among the mapped groups the person is in, else the default. */
export function jitRole(provider: Pick<IdentityProvider, 'jitDefaultRole' | 'roleMappings'>, groups: string[]): SsoAssignableRole {
  const set = new Set(groups.map((g) => g.trim().toLowerCase()));
  const matched = (provider.roleMappings ?? []).filter((m) => set.has(m.group.trim().toLowerCase())).map((m) => m.role);
  if (matched.includes('admin')) return 'admin';
  if (matched.includes('reviewer')) return 'reviewer';
  return provider.jitDefaultRole;
}

export type { IdentityProviderInput };

/**
 * Staff API — single sign-on providers and the SCIM token (services/sso/*, services/scim.ts).
 *
 *   GET    /sso                                -> SsoOverviewDTO                  [admin]
 *   POST   /sso/providers  IdentityProviderInput -> IdentityProviderDTO          [owner]
 *   PUT    /sso/providers/:id  IdentityProviderInput -> IdentityProviderDTO      [owner; kind fixed; clientSecret omitted = kept]
 *   DELETE /sso/providers/:id                  -> { ok: true }                    [owner]
 *   POST   /sso/providers/:id/test             -> SsoTestResultDTO                [admin; 10/min]
 *   GET    /scim/token                         -> ScimStatusDTO                   [admin]
 *   POST   /scim/token                         -> CreatedScimTokenDTO (shown once; replaces the active token) [owner]
 *   DELETE /scim/token                         -> ScimStatusDTO                   [owner]
 *   POST   /users/:id/sso/unlink               -> StaffUserDTO                    [admin; same rules as other user changes]
 *   (OrgSettingsDTO.requireSso is changed through PUT /settings, owner only.)
 *
 * Owners decide how staff sign in (a provider or SCIM token could otherwise be used to take over accounts or create
 * administrators); administrators can see the configuration and test it. Every change is audited; the client secret and
 * the SCIM token never appear in responses (after creation), logs or audit entries.
 */
import { type CreatedScimTokenDTO, type ScimStatusDTO, type SsoOverviewDTO, type SsoTestResultDTO } from '@sp/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { generateScimToken } from '../../auth/scim-token.js';
import { getStaff, requireStaff, revokeProviderSessions, revokeStaffSessions, type StaffPrincipal } from '../../auth/staff.js';
import type { DbOrTx } from '../../db/index.js';
import { scimTokens, staffSsoIdentities, staffUsers } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { toStaffUserDTO } from '../../services/dto.js';
import { orgSettings } from '../../services/org.js';
import { forgetOidcProvider, testOidcProvider } from '../../services/sso/oidc.js';
import { certificateInfo, createProvider, deleteProvider, listProviders, loadProvider, toIdentityProviderDTO, updateProvider } from '../../services/sso/providers.js';
import { testSamlProvider } from '../../services/sso/saml.js';
import { idParam, loadOrgRow, noStore } from './common.js';

function requireOwner(staff: StaffPrincipal, what: string): void {
  if (staff.role !== 'owner') throw forbidden(`Only an owner can ${what}.`, 'owner_required');
}

async function scimStatus(db: DbOrTx, orgId: string, baseUrl: string): Promise<ScimStatusDTO> {
  const [row] = await db
    .select({ t: scimTokens, creatorName: staffUsers.name })
    .from(scimTokens)
    .leftJoin(staffUsers, eq(staffUsers.id, scimTokens.createdBy))
    .where(and(eq(scimTokens.orgId, orgId), isNull(scimTokens.revokedAt)));
  return {
    baseUrl,
    token: row
      ? {
          id: row.t.id,
          prefix: row.t.prefix,
          createdAt: row.t.createdAt.getTime(),
          createdBy: row.t.createdBy ? { id: row.t.createdBy, name: row.creatorName ?? 'Unknown' } : null,
          lastUsedAt: row.t.lastUsedAt?.getTime() ?? null,
        }
      : null,
  };
}

export const ssoAdminRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const admin = { preHandler: requireStaff('admin') };
  const scimBase = `${ctx.config.publicUrl}/scim/v2`;
  const writeCtx = (req: FastifyRequest) => {
    const staff = getStaff(req);
    return { ctx, orgId: staff.orgId, actorId: staff.id, ip: req.ip };
  };

  app.get('/sso', admin, async (req): Promise<SsoOverviewDTO> => {
    const staff = getStaff(req);
    const [providers, org, scim] = await Promise.all([listProviders(ctx.db, staff.orgId), loadOrgRow(ctx, staff.orgId), scimStatus(ctx.db, staff.orgId, scimBase)]);
    return { providers: providers.map((p) => toIdentityProviderDTO(ctx.config.publicUrl, p)), requireSso: orgSettings(org).requireSso, scim };
  });

  app.post('/sso/providers', admin, async (req) => {
    requireOwner(getStaff(req), 'add identity providers');
    const p = await createProvider(writeCtx(req), req.body ?? {});
    return toIdentityProviderDTO(ctx.config.publicUrl, p);
  });

  app.put('/sso/providers/:id', admin, async (req) => {
    requireOwner(getStaff(req), 'change identity providers');
    const id = idParam(req, 'id', 'Identity provider', 'sso_provider_not_found');
    const r = await updateProvider(writeCtx(req), id, req.body ?? {});
    forgetOidcProvider(ctx, id);
    if (r.endSessions) await revokeProviderSessions(ctx, id);
    return toIdentityProviderDTO(ctx.config.publicUrl, r.provider);
  });

  app.delete('/sso/providers/:id', admin, async (req) => {
    requireOwner(getStaff(req), 'delete identity providers');
    const id = idParam(req, 'id', 'Identity provider', 'sso_provider_not_found');
    await deleteProvider(writeCtx(req), id);
    forgetOidcProvider(ctx, id);
    await revokeProviderSessions(ctx, id);
    return { ok: true };
  });

  app.post('/sso/providers/:id/test', { ...admin, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req): Promise<SsoTestResultDTO> => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Identity provider', 'sso_provider_not_found');
    const provider = await loadProvider(ctx.db, staff.orgId, id);
    const checks =
      provider.kind === 'oidc'
        ? await testOidcProvider(ctx, provider)
        : testSamlProvider(
            ctx,
            provider,
            provider.samlCertificates.map(certificateInfo).filter((c) => c != null),
          );
    const ok = checks.every((c) => c.ok);
    await audit(ctx.db, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'sso.provider_tested', targetType: 'identity_provider', targetId: id, meta: { ok, failed: checks.filter((c) => !c.ok).map((c) => c.name) }, ip: req.ip, at: ctx.now() });
    return { ok, checks };
  });

  /* ---------------------------------------------------------------- SCIM token */

  app.get('/scim/token', admin, async (req) => scimStatus(ctx.db, getStaff(req).orgId, scimBase));

  app.post('/scim/token', admin, async (req, reply): Promise<CreatedScimTokenDTO> => {
    const staff = getStaff(req);
    requireOwner(staff, 'create SCIM tokens');
    const now = ctx.now();
    const { token, prefix, hash } = generateScimToken();
    await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`scim-token:${staff.orgId}`}))`);
      const revoked = await tx
        .update(scimTokens)
        .set({ revokedAt: new Date(now), revokedBy: staff.id })
        .where(and(eq(scimTokens.orgId, staff.orgId), isNull(scimTokens.revokedAt)))
        .returning({ id: scimTokens.id, prefix: scimTokens.prefix });
      const [row] = await tx.insert(scimTokens).values({ orgId: staff.orgId, prefix, tokenHash: hash, createdBy: staff.id, createdAt: new Date(now) }).returning();
      await audit(tx, {
        orgId: staff.orgId,
        actorType: 'staff',
        actorId: staff.id,
        action: revoked.length ? 'scim.token_rotated' : 'scim.token_created',
        targetType: 'scim_token',
        targetId: row.id,
        meta: { prefix, ...(revoked.length ? { replaced: revoked[0].prefix } : {}) },
        ip: req.ip,
        at: now,
      });
    });
    noStore(reply);
    return { ...(await scimStatus(ctx.db, staff.orgId, scimBase)), secret: token };
  });

  app.delete('/scim/token', admin, async (req) => {
    const staff = getStaff(req);
    requireOwner(staff, 'revoke the SCIM token');
    const now = ctx.now();
    const revoked = await ctx.db
      .update(scimTokens)
      .set({ revokedAt: new Date(now), revokedBy: staff.id })
      .where(and(eq(scimTokens.orgId, staff.orgId), isNull(scimTokens.revokedAt)))
      .returning();
    if (!revoked.length) throw notFound('There is no active SCIM token', 'scim_token_not_found');
    await audit(ctx.db, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'scim.token_revoked', targetType: 'scim_token', targetId: revoked[0].id, meta: { prefix: revoked[0].prefix }, ip: req.ip, at: now });
    return scimStatus(ctx.db, staff.orgId, scimBase);
  });

  /* ---------------------------------------------------------------- account links */

  /** Unlink an account from its identity provider identities (a re-used address, a new identity at the provider). */
  app.post('/users/:id/sso/unlink', admin, async (req) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'User', 'user_not_found');
    if (id === staff.id) throw badRequest('Ask another administrator to unlink your own account.', undefined, 'use_other_admin');
    const now = ctx.now();
    const user = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'staff-users:' + staff.orgId}))`);
      const [u] = await tx
        .select()
        .from(staffUsers)
        .where(and(eq(staffUsers.id, id), eq(staffUsers.orgId, staff.orgId)));
      if (!u) throw notFound('User not found', 'user_not_found');
      if ((u.role === 'owner' || u.role === 'admin') && staff.role !== 'owner') throw forbidden('Only an owner can change owner or admin accounts', 'owner_required');
      const removed = await tx.delete(staffSsoIdentities).where(eq(staffSsoIdentities.staffUserId, id)).returning({ providerId: staffSsoIdentities.providerId });
      if (!removed.length) throw conflict('sso_not_linked', 'This account is not linked to an identity provider.');
      await audit(tx, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'user.sso_unlinked', targetType: 'staff_user', targetId: id, meta: { email: u.email, providers: removed.map((r) => r.providerId) }, ip: req.ip, at: now });
      return u;
    });
    // Sessions opened through the old identity end with it.
    await revokeStaffSessions(ctx, id);
    return toStaffUserDTO(user, { ssoLinked: false });
  });
};

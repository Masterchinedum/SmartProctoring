/**
 * Staff API — organisation settings, staff users, audit log.
 *
 *   GET  /settings                                  -> OrgSettingsDTO               [admin]
 *   PUT  /settings  Partial<OrgSettingsDTO>         -> OrgSettingsDTO               [admin]
 *   GET  /users                                     -> { items: StaffUserDTO[] }    [admin]
 *   POST /users {email,name,role,password}          -> StaffUserDTO                 [admin; only an owner may create owners/admins]
 *   PUT  /users/:id {name?,role?,disabled?,password?} -> StaffUserDTO               [admin]
 *   GET  /audit-log?limit=&offset=&action=&targetType=&targetId= -> Paged<AuditLogEntryDTO>  [admin]
 *
 * User-management rules:
 *   - only an owner may create, promote to, or modify owners and admins; admins manage reviewers;
 *   - nobody can disable themselves; the last enabled owner cannot be disabled or demoted;
 *   - your own password is changed via POST /api/auth/password (which asks for the current one);
 *   - disabling a user or resetting a password signs that user out everywhere.
 */
import {
  settingsUpdateSchema,
  userCreateSchema,
  userUpdateSchema,
  type AuditLogEntryDTO,
  type OrgSettingsDTO,
  type Paged,
  type StaffRole,
} from '@sp/shared';
import { and, desc, eq, like, ne, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getStaff, requireStaff, revokeStaffSessions } from '../../auth/staff.js';
import type { DbOrTx } from '../../db/index.js';
import { apiKeys, auditLog, organizations, staffUsers, type Organization, type OrgSettings } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { hashPassword } from '../../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound, validationFailed } from '../../lib/errors.js';
import { toStaffUserDTO } from '../../services/dto.js';
import { mergePolicy, orgSettings } from '../../services/org.js';
import { clearLoginFailures } from '../../services/login-throttle.js';
import { blankToUndefined, escapeLike, idParam, loadOrgRow, pagingSchema, sanitizePolicyInput } from './common.js';

const auditQuerySchema = pagingSchema.extend({
  action: z.string().max(100).optional(),
  targetType: z.string().max(50).optional(),
  targetId: z.string().max(100).optional(),
});

export function toOrgSettingsDTO(org: Organization): OrgSettingsDTO {
  const s = orgSettings(org);
  return {
    name: org.name,
    evidenceRetentionDays: s.evidenceRetentionDays,
    eventRetentionDays: s.eventRetentionDays,
    defaultPolicy: mergePolicy(undefined, s.defaultPolicy as Record<string, unknown>),
    privacyContact: s.privacyContact,
    identityThresholds: { ...s.identityThresholds },
    abandonAfterDays: s.abandonAfterDays,
    alertRecipients: [...s.alertRecipients],
    emailAlerts: { ...s.emailAlerts },
  };
}

async function loadScopedUser(db: DbOrTx, orgId: string, id: string, lock = false) {
  const q = db
    .select()
    .from(staffUsers)
    .where(and(eq(staffUsers.id, id), eq(staffUsers.orgId, orgId)));
  const [u] = lock ? await q.for('update') : await q;
  if (!u) throw notFound('User not found', 'user_not_found');
  return u;
}

const PRIVILEGED: StaffRole[] = ['owner', 'admin'];

export const orgRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const admin = { preHandler: requireStaff('admin') };

  /* ------------------------------------------------------------------ settings */

  app.get('/settings', admin, async (req) => {
    const staff = getStaff(req);
    return toOrgSettingsDTO(await loadOrgRow(ctx, staff.orgId));
  });

  app.put('/settings', admin, async (req) => {
    const staff = getStaff(req);
    const body = settingsUpdateSchema.parse(req.body ?? {});
    const now = ctx.now();
    const updated = await ctx.db.transaction(async (tx) => {
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, staff.orgId)).for('update');
      if (!org) throw notFound('Organisation not found');
      const cur = orgSettings(org);
      // Only explicit overrides are stored (defaults are filled in by orgSettings()), so improved defaults
      // keep reaching organisations that never customised a value.
      const stored: Partial<OrgSettings> = { ...(org.settings ?? {}) };
      if (body.evidenceRetentionDays !== undefined) stored.evidenceRetentionDays = body.evidenceRetentionDays;
      if (body.eventRetentionDays !== undefined) stored.eventRetentionDays = body.eventRetentionDays;
      if (body.privacyContact !== undefined) stored.privacyContact = body.privacyContact.trim();
      if (body.identityThresholds) {
        const provided = Object.fromEntries(Object.entries(body.identityThresholds).filter(([, v]) => v !== undefined));
        stored.identityThresholds = { ...(stored.identityThresholds ?? {}), ...provided } as OrgSettings['identityThresholds'];
      }
      if (body.abandonAfterDays !== undefined) stored.abandonAfterDays = body.abandonAfterDays;
      if (body.alertRecipients !== undefined) stored.alertRecipients = [...new Set(body.alertRecipients.map((e) => e.trim().toLowerCase()))];
      if (body.emailAlerts !== undefined) {
        const provided = Object.fromEntries(Object.entries(body.emailAlerts).filter(([, v]) => v !== undefined));
        stored.emailAlerts = { ...cur.emailAlerts, ...(stored.emailAlerts ?? {}), ...provided };
      }
      if (body.defaultPolicy !== undefined) {
        const policy = sanitizePolicyInput(body.defaultPolicy);
        mergePolicy(undefined, policy); // throws ZodError (400) with field paths when invalid
        stored.defaultPolicy = policy;
      }
      const next = orgSettings({ settings: stored });
      const issues: { path: string; message: string }[] = [];
      if (next.eventRetentionDays < next.evidenceRetentionDays) {
        issues.push({ path: 'eventRetentionDays', message: 'Event records must be kept at least as long as the evidence images' });
      }
      const t = next.identityThresholds;
      if (!(t.mismatch < t.match)) issues.push({ path: 'identityThresholds.mismatch', message: 'The mismatch threshold must be lower than the match threshold' });
      if (!(t.idPhotoMismatch < t.idPhotoMatch)) issues.push({ path: 'identityThresholds.idPhotoMismatch', message: 'The ID-photo mismatch threshold must be lower than the ID-photo match threshold' });
      if (issues.length) throw validationFailed('Invalid settings', issues);

      const name = body.name !== undefined ? body.name.trim() : org.name;
      if (!name) throw validationFailed('Invalid settings', [{ path: 'name', message: 'The organisation name cannot be empty' }]);
      const changed = [
        ...(name !== org.name ? ['name'] : []),
        ...(Object.keys(next) as (keyof OrgSettings)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(cur[k])),
      ];
      const [row] = await tx
        .update(organizations)
        .set({ name, settings: stored, updatedAt: new Date(now) })
        .where(eq(organizations.id, staff.orgId))
        .returning();
      await audit(tx, {
        orgId: staff.orgId,
        actorType: 'staff',
        actorId: staff.id,
        action: 'settings.updated',
        targetType: 'organization',
        targetId: staff.orgId,
        meta: {
          fields: changed,
          ...(changed.includes('identityThresholds') ? { identityThresholds: { from: cur.identityThresholds, to: next.identityThresholds } } : {}),
          ...(changed.includes('evidenceRetentionDays') ? { evidenceRetentionDays: { from: cur.evidenceRetentionDays, to: next.evidenceRetentionDays } } : {}),
          ...(changed.includes('eventRetentionDays') ? { eventRetentionDays: { from: cur.eventRetentionDays, to: next.eventRetentionDays } } : {}),
          ...(changed.includes('abandonAfterDays') ? { abandonAfterDays: { from: cur.abandonAfterDays, to: next.abandonAfterDays } } : {}),
          ...(changed.includes('alertRecipients') ? { alertRecipients: { count: next.alertRecipients.length } } : {}),
          ...(changed.includes('emailAlerts') ? { emailAlerts: next.emailAlerts } : {}),
        },
        ip: req.ip,
        at: now,
      });
      return row;
    });
    return toOrgSettingsDTO(updated);
  });

  /* ------------------------------------------------------------------ users */

  app.get('/users', admin, async (req) => {
    const staff = getStaff(req);
    const rows = await ctx.db.select().from(staffUsers).where(eq(staffUsers.orgId, staff.orgId)).orderBy(staffUsers.createdAt, staffUsers.id);
    return { items: rows.map(toStaffUserDTO) };
  });

  app.post('/users', admin, async (req) => {
    const staff = getStaff(req);
    const body = userCreateSchema.parse(req.body ?? {});
    if (PRIVILEGED.includes(body.role) && staff.role !== 'owner') throw forbidden('Only an owner can create owner or admin accounts');
    const email = body.email.trim().toLowerCase();
    const now = ctx.now();
    const passwordHash = await hashPassword(body.password);
    const user = await ctx.db.transaction(async (tx) => {
      const [dup] = await tx
        .select({ id: staffUsers.id })
        .from(staffUsers)
        .where(eq(sql`lower(${staffUsers.email})`, email));
      if (dup) throw conflict('email_taken', 'An account with this email address already exists.');
      const [u] = await tx
        .insert(staffUsers)
        .values({ orgId: staff.orgId, email, name: body.name.trim(), role: body.role, passwordHash, createdAt: new Date(now), updatedAt: new Date(now), passwordChangedAt: new Date(now) })
        .onConflictDoNothing()
        .returning();
      if (!u) throw conflict('email_taken', 'An account with this email address already exists.');
      await audit(tx, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'user.created', targetType: 'staff_user', targetId: u.id, meta: { email, role: body.role }, ip: req.ip, at: now });
      return u;
    });
    return toStaffUserDTO(user);
  });

  app.put('/users/:id', admin, async (req) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'User', 'user_not_found');
    const body = userUpdateSchema.parse(req.body ?? {});
    const now = ctx.now();
    const self = id === staff.id;
    if (self && body.password !== undefined) throw badRequest('Change your own password from your account menu (it asks for your current password).', undefined, 'use_password_change');
    if (self && body.disabled === true) throw conflict('cannot_disable_self', 'You cannot disable your own account.');
    const passwordHash = body.password !== undefined ? await hashPassword(body.password) : undefined;

    const { user, revoke } = await ctx.db.transaction(async (tx) => {
      // Serialise user-management changes per organisation (last-owner checks).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'staff-users:' + staff.orgId}))`);
      const target = await loadScopedUser(tx, staff.orgId, id, true);
      if (staff.role !== 'owner') {
        if (PRIVILEGED.includes(target.role) && !self) throw forbidden('Only an owner can change owner or admin accounts');
        if (body.role !== undefined && body.role !== target.role && (PRIVILEGED.includes(body.role) || self)) throw forbidden('Only an owner can grant or change the owner and admin roles');
      }
      const demotesOwner = target.role === 'owner' && body.role !== undefined && body.role !== 'owner';
      const disablesOwner = target.role === 'owner' && body.disabled === true && !target.disabled;
      if (demotesOwner || disablesOwner) {
        const [{ n }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(staffUsers)
          .where(and(eq(staffUsers.orgId, staff.orgId), eq(staffUsers.role, 'owner'), eq(staffUsers.disabled, false), ne(staffUsers.id, id)));
        if (n === 0) throw conflict('last_owner', 'The organisation must keep at least one active owner. Make someone else an owner first.');
      }
      const patch: Partial<typeof staffUsers.$inferInsert> = { updatedAt: new Date(now) };
      const changed: string[] = [];
      if (body.name !== undefined && body.name.trim() !== target.name) {
        patch.name = body.name.trim();
        changed.push('name');
      }
      if (body.role !== undefined && body.role !== target.role) {
        patch.role = body.role;
        changed.push('role');
      }
      if (body.disabled !== undefined && body.disabled !== target.disabled) {
        patch.disabled = body.disabled;
        changed.push('disabled');
      }
      if (passwordHash !== undefined) {
        patch.passwordHash = passwordHash;
        patch.passwordChangedAt = new Date(now);
        changed.push('password');
      }
      const [u] = await tx.update(staffUsers).set(patch).where(eq(staffUsers.id, id)).returning();
      if (changed.length) {
        await audit(tx, {
          orgId: staff.orgId,
          actorType: 'staff',
          actorId: staff.id,
          action: 'user.updated',
          targetType: 'staff_user',
          targetId: id,
          meta: { fields: changed, ...(patch.role ? { role: { from: target.role, to: patch.role } } : {}), ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}) },
          ip: req.ip,
          at: now,
        });
      }
      return { user: u, revoke: patch.disabled === true || passwordHash !== undefined };
    });
    if (revoke) await revokeStaffSessions(ctx, id);
    // An administrator's password reset also lifts the per-account sign-in backoff.
    if (passwordHash !== undefined) await clearLoginFailures(ctx.db, user.email);
    return toStaffUserDTO(user);
  });

  /* ------------------------------------------------------------------ audit log */

  app.get('/audit-log', admin, async (req): Promise<Paged<AuditLogEntryDTO>> => {
    const staff = getStaff(req);
    const q = auditQuerySchema.parse(blankToUndefined(req.query));
    const conds = [
      eq(auditLog.orgId, staff.orgId),
      q.action ? like(auditLog.action, `${escapeLike(q.action.trim())}%`) : undefined,
      q.targetType ? eq(auditLog.targetType, q.targetType) : undefined,
      q.targetId ? eq(auditLog.targetId, q.targetId) : undefined,
    ];
    const where = and(...conds);
    const [[{ total }], rows] = await Promise.all([
      ctx.db.select({ total: sql<number>`count(*)::int` }).from(auditLog).where(where),
      ctx.db
        .select({ entry: auditLog, actorName: staffUsers.name, apiKeyName: apiKeys.name })
        .from(auditLog)
        .leftJoin(staffUsers, and(eq(auditLog.actorType, 'staff'), eq(staffUsers.id, auditLog.actorId)))
        .leftJoin(apiKeys, and(eq(auditLog.actorType, 'api_key'), eq(apiKeys.id, auditLog.actorId)))
        .where(where)
        .orderBy(desc(auditLog.at), desc(auditLog.id))
        .limit(q.limit)
        .offset(q.offset),
    ]);
    return {
      total,
      items: rows.map(({ entry, actorName, apiKeyName }) => ({
        id: entry.id,
        at: entry.at.getTime(),
        actorType: entry.actorType,
        actorId: entry.actorId ?? null,
        actorName: entry.actorType === 'system' ? 'System' : entry.actorType === 'api_key' ? (apiKeyName ? `API key “${apiKeyName}”` : 'API key') : (actorName ?? null),
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId ?? null,
        meta: entry.meta ?? {},
      })),
    };
  });
};

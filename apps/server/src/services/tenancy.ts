/**
 * Operator management of organisations (roadmap #15): create an organisation with its first owner, change its kind
 * (`production` / `sandbox`), its quotas and a sandbox's clean-up period. Only through the operator CLI
 * (`org:create`, `org:set`, `org:list`; src/scripts/org-cli.ts) — staff can neither see nor change these settings
 * beyond what Settings → Usage shows. Every change is audited in the organisation's audit log as actor `system`
 * (`organization.created`, `user.created`, `organization.updated`, with the operator's reason when given).
 *
 * The first owner gets a temporary password, returned to the operator once (never stored in clear, logged or
 * emailed); they change it on their account page, as after `staff-access --reset-password`.
 *
 * Turning a production organisation into a sandbox is destructive — the hourly clean-up (services/sandbox-purge.ts)
 * then deletes its data older than the clean-up period — so it needs an explicit confirmation (`confirmPurge`).
 */
import { DEFAULT_SANDBOX_PURGE_DAYS, MAX_QUOTA, MAX_SANDBOX_PURGE_DAYS, QUOTA_KINDS, type OrgKind, type OrgQuotas, type OrgUsageDTO, type QuotaKind, type StaffOrgDTO } from '@sp/shared';
import { asc, eq, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import type { DbOrTx } from '../db/index.js';
import { organizations, staffUsers, type Organization, type StaffUser } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { hashPassword } from '../lib/crypto.js';
import { createOrganization } from './org.js';
import { effectiveQuotas, orgKind, orgUsageDTO, sandboxPurgeDays } from './quotas.js';
import { temporaryPassword } from './staff-recovery.js';

export type TenancyErrorCode = 'invalid' | 'email_taken' | 'org_not_found' | 'confirm_required';

/** A refused operator request (the CLI turns `code` into its exit code). */
export class TenancyError extends Error {
  constructor(
    readonly code: TenancyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TenancyError';
  }
}

/** A quota value from the operator: a number, `null` (no limit) or `'default'` (the kind's default: remove the override). */
export type QuotaSetting = number | null | 'default';

export function validQuotaSetting(v: QuotaSetting): boolean {
  return v === null || v === 'default' || (Number.isInteger(v) && v >= 0 && v <= MAX_QUOTA);
}

/** The organisation as the staff app sees it (GET /api/auth/me). */
export function staffOrgDTO(org: Pick<Organization, 'id' | 'name' | 'kind' | 'sandboxPurgeDays'>): StaffOrgDTO {
  const kind = orgKind(org);
  return { id: org.id, name: org.name, kind, sandbox: kind === 'sandbox' ? { purgeAfterDays: sandboxPurgeDays(org) } : null };
}

export interface OrganizationDescription {
  id: string;
  name: string;
  kind: OrgKind;
  createdAt: number;
  /** What applies (the kind's defaults with the operator's overrides). */
  quotas: OrgQuotas;
  /** The operator's overrides only. */
  overrides: Partial<OrgQuotas>;
  /** Sandbox: days after last use before data is deleted (also shown for production: applies once it is a sandbox). */
  sandboxPurgeDays: number;
  owners: string[];
  usage: OrgUsageDTO;
}

export async function describeOrganization(db: DbOrTx, org: Organization, now: number): Promise<OrganizationDescription> {
  const owners = await db
    .select({ email: staffUsers.email })
    .from(staffUsers)
    .where(sql`${staffUsers.orgId} = ${org.id} and ${staffUsers.role} = 'owner' and not ${staffUsers.disabled}`)
    .orderBy(asc(staffUsers.createdAt));
  return {
    id: org.id,
    name: org.name,
    kind: orgKind(org),
    createdAt: org.createdAt.getTime(),
    quotas: effectiveQuotas(org),
    overrides: { ...(org.quotas ?? {}) },
    sandboxPurgeDays: sandboxPurgeDays(org),
    owners: owners.map((o) => o.email),
    usage: await orgUsageDTO(db, org, now),
  };
}

export async function listOrganizations(db: DbOrTx, now: number): Promise<OrganizationDescription[]> {
  const rows = await db.select().from(organizations).orderBy(asc(organizations.createdAt), asc(organizations.id));
  const out: OrganizationDescription[] = [];
  for (const o of rows) out.push(await describeOrganization(db, o, now));
  return out;
}

/** Stored overrides after applying the operator's settings (`default` removes one). */
function applyQuotaSettings(stored: Partial<OrgQuotas>, settings: Partial<Record<QuotaKind, QuotaSetting>>): Partial<OrgQuotas> {
  const next: Partial<OrgQuotas> = { ...stored };
  for (const k of QUOTA_KINDS) {
    const v = settings[k];
    if (v === undefined) continue;
    if (v === 'default') delete next[k];
    else next[k] = v;
  }
  return next;
}

function checkPurgeDays(days: number | null | undefined): void {
  if (days != null && (!Number.isInteger(days) || days < 1 || days > MAX_SANDBOX_PURGE_DAYS)) {
    throw new TenancyError('invalid', `The clean-up period must be a whole number of days from 1 to ${MAX_SANDBOX_PURGE_DAYS}.`);
  }
}

function checkQuotaSettings(settings: Partial<Record<QuotaKind, QuotaSetting>>): void {
  for (const k of QUOTA_KINDS) {
    const v = settings[k];
    if (v !== undefined && !validQuotaSetting(v)) throw new TenancyError('invalid', `The ${k} limit must be a whole number from 0 to ${MAX_QUOTA}, "unlimited" or "default".`);
  }
}

/* ------------------------------------------------------------------ create */

export interface CreateOrganizationRequest {
  name: string;
  kind: OrgKind;
  ownerEmail: string;
  ownerName?: string;
  quotas?: Partial<Record<QuotaKind, QuotaSetting>>;
  /** null / undefined = DEFAULT_SANDBOX_PURGE_DAYS. */
  sandboxPurgeDays?: number | null;
  /** Ticket / why: recorded in the audit log. */
  reason?: string;
}

export interface CreateOrganizationResult {
  org: Organization;
  owner: Pick<StaffUser, 'id' | 'email' | 'name' | 'role'>;
  /** Shown to the operator once, to hand over through a trusted channel. */
  temporaryPassword: string;
}

export async function createOrganizationWithOwner(ctx: Pick<Ctx, 'db' | 'now'>, req: CreateOrganizationRequest): Promise<CreateOrganizationResult> {
  const name = req.name.trim();
  const email = req.ownerEmail.trim().toLowerCase();
  const ownerName = (req.ownerName ?? '').trim() || 'Owner';
  if (!name || name.length > 200) throw new TenancyError('invalid', 'The organisation name is required (at most 200 characters).');
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) throw new TenancyError('invalid', 'A valid owner email address is required.');
  if (ownerName.length > 200) throw new TenancyError('invalid', 'The owner name must be at most 200 characters.');
  checkQuotaSettings(req.quotas ?? {});
  checkPurgeDays(req.sandboxPurgeDays);
  const now = ctx.now();
  const password = temporaryPassword();
  const passwordHash = await hashPassword(password);
  const quotas = applyQuotaSettings({}, req.quotas ?? {});
  const reason = req.reason?.trim() || null;

  return ctx.db.transaction(async (tx) => {
    const [dup] = await tx
      .select({ id: staffUsers.id })
      .from(staffUsers)
      .where(eq(sql`lower(${staffUsers.email})`, email));
    if (dup) throw new TenancyError('email_taken', `A staff account with the address ${email} already exists (each address can belong to one organisation only).`);
    const org = await createOrganization(tx, name, {}, now, { kind: req.kind, quotas, sandboxPurgeDays: req.sandboxPurgeDays ?? null });
    const [owner] = await tx
      .insert(staffUsers)
      .values({ orgId: org.id, email, name: ownerName, role: 'owner', passwordHash, passwordChangedAt: new Date(now), createdAt: new Date(now), updatedAt: new Date(now) })
      .onConflictDoNothing()
      .returning();
    if (!owner) throw new TenancyError('email_taken', `A staff account with the address ${email} already exists.`);
    await audit(tx, {
      orgId: org.id,
      actorType: 'system',
      action: 'organization.created',
      targetType: 'organization',
      targetId: org.id,
      meta: { name, kind: req.kind, quotas, sandboxPurgeDays: req.sandboxPurgeDays ?? null, via: 'operator_cli', ...(reason ? { reason } : {}) },
      at: now,
    });
    await audit(tx, { orgId: org.id, actorType: 'system', action: 'user.created', targetType: 'staff_user', targetId: owner.id, meta: { email, role: 'owner', via: 'operator_cli' }, at: now });
    return { org, owner: { id: owner.id, email: owner.email, name: owner.name, role: owner.role }, temporaryPassword: password };
  });
}

/* ------------------------------------------------------------------ update */

export interface UpdateOrganizationRequest {
  orgId: string;
  kind?: OrgKind;
  quotas?: Partial<Record<QuotaKind, QuotaSetting>>;
  /** Remove every quota override first (back to the kind's defaults); `quotas` then applies on top. */
  resetQuotas?: boolean;
  /** null = back to DEFAULT_SANDBOX_PURGE_DAYS. */
  sandboxPurgeDays?: number | null;
  /** Required to turn a production organisation into a sandbox (its old data will be deleted). */
  confirmPurge?: boolean;
  reason?: string;
}

export interface UpdateOrganizationResult {
  org: Organization;
  /** Fields that changed (kind, quotas, sandboxPurgeDays); empty = nothing to do (nothing audited). */
  changed: string[];
}

export async function updateOrganizationTenancy(ctx: Pick<Ctx, 'db' | 'now'>, req: UpdateOrganizationRequest): Promise<UpdateOrganizationResult> {
  checkQuotaSettings(req.quotas ?? {});
  checkPurgeDays(req.sandboxPurgeDays);
  const now = ctx.now();
  const reason = req.reason?.trim() || null;
  return ctx.db.transaction(async (tx) => {
    const [cur] = await tx.select().from(organizations).where(eq(organizations.id, req.orgId)).for('update');
    if (!cur) throw new TenancyError('org_not_found', `No organisation has the id ${req.orgId}.`);
    const kind = req.kind ?? orgKind(cur);
    if (kind === 'sandbox' && orgKind(cur) !== 'sandbox' && !req.confirmPurge) {
      const days = req.sandboxPurgeDays ?? cur.sandboxPurgeDays ?? DEFAULT_SANDBOX_PURGE_DAYS;
      throw new TenancyError(
        'confirm_required',
        `"${cur.name}" is a production organisation. As a sandbox, its exam sessions, images and candidates are deleted ${days} days after their last use — including what it already has. Confirm with --confirm-purge.`,
      );
    }
    const quotas = applyQuotaSettings(req.resetQuotas ? {} : { ...(cur.quotas ?? {}) }, req.quotas ?? {});
    const purgeDays = req.sandboxPurgeDays !== undefined ? req.sandboxPurgeDays : cur.sandboxPurgeDays;
    const before = { kind: orgKind(cur), quotas: effectiveQuotas(cur), overrides: { ...(cur.quotas ?? {}) }, sandboxPurgeDays: sandboxPurgeDays(cur) };
    const after = { kind, quotas: effectiveQuotas({ kind, quotas }), overrides: quotas, sandboxPurgeDays: sandboxPurgeDays({ sandboxPurgeDays: purgeDays }) };
    const changed = [
      ...(before.kind !== after.kind ? ['kind'] : []),
      ...(JSON.stringify(before.overrides) !== JSON.stringify(after.overrides) || JSON.stringify(before.quotas) !== JSON.stringify(after.quotas) ? ['quotas'] : []),
      ...((cur.sandboxPurgeDays ?? null) !== (purgeDays ?? null) ? ['sandboxPurgeDays'] : []),
    ];
    if (!changed.length) return { org: cur, changed };
    const [org] = await tx
      .update(organizations)
      .set({ kind, quotas, sandboxPurgeDays: purgeDays ?? null, updatedAt: new Date(now) })
      .where(eq(organizations.id, cur.id))
      .returning();
    await audit(tx, {
      orgId: cur.id,
      actorType: 'system',
      action: 'organization.updated',
      targetType: 'organization',
      targetId: cur.id,
      meta: {
        fields: changed,
        ...(changed.includes('kind') ? { kind: { from: before.kind, to: after.kind } } : {}),
        ...(changed.includes('quotas') ? { quotas: { from: before.quotas, to: after.quotas } } : {}),
        ...(changed.includes('sandboxPurgeDays') ? { sandboxPurgeDays: { from: before.sandboxPurgeDays, to: after.sandboxPurgeDays } } : {}),
        via: 'operator_cli',
        ...(reason ? { reason } : {}),
      },
      at: now,
    });
    return { org, changed };
  });
}

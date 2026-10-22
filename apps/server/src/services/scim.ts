/**
 * SCIM 2.0 (RFC 7643 / 7644) staff provisioning — the Users resource (routes/scim.ts).
 *
 *  - userName = the staff email (an email address; otherwise the primary `emails` value); `displayName` /
 *    `name.formatted` / `name.givenName` + `name.familyName` = the name; `active` = not disabled; `externalId` kept.
 *  - Role through the core `roles` attribute: `reviewer` or `admin` (primary or first value); absent = unchanged
 *    (new accounts: reviewer). `owner` is refused: owners are managed in SmartProctoring only, and SCIM cannot change,
 *    disable or delete an owner account (403) — owners are the break-glass accounts.
 *  - `active: false` (PUT / PATCH) disables the account and ends its sessions everywhere; DELETE does the same and
 *    hides the account from SCIM (404 afterwards, RFC 7644 §3.6) — records stay for the audit trail; a later POST of
 *    the same userName brings it back. Accounts created by SCIM have no password (single sign-on).
 *  - PATCH: add / replace / remove (any case, Microsoft Entra ID style "Replace" and "False" accepted) on the
 *    attributes above, with or without a path; attributes SmartProctoring does not store are ignored.
 *  - Filters: `userName eq "…"`, `externalId eq "…"`, `id eq "…"`, `emails.value eq "…"`. No Groups resource.
 * Every change is audited with actor type `scim` (the token id), in the token's organisation only.
 */
import { SSO_ASSIGNABLE_ROLES, type SsoAssignableRole } from '@sp/shared';
import { and, asc, count, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import type { DbOrTx } from '../db/index.js';
import { staffLoginChallenges, staffUsers, type StaffUser } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { NO_PASSWORD_HASH } from '../lib/crypto.js';
import { revokeStaffSessions } from '../auth/staff.js';
import type { ScimPrincipal } from '../auth/scim-token.js';

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const SCIM_MAX_RESULTS = 200;

export class ScimError extends Error {
  constructor(
    readonly status: number,
    detail: string,
    readonly scimType?: 'invalidFilter' | 'tooMany' | 'uniqueness' | 'mutability' | 'invalidSyntax' | 'invalidPath' | 'noTarget' | 'invalidValue',
  ) {
    super(detail);
    this.name = 'ScimError';
  }
  toBody() {
    return { schemas: [SCIM_ERROR_SCHEMA], status: String(this.status), ...(this.scimType ? { scimType: this.scimType } : {}), detail: this.message };
  }
}

export interface ScimUserResource {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  name: { formatted: string };
  displayName: string;
  emails: { value: string; type: string; primary: boolean }[];
  active: boolean;
  roles: { value: string; primary: boolean }[];
  meta: { resourceType: 'User'; created: string; lastModified: string; location: string };
}

export function toScimUser(baseUrl: string, u: StaffUser): ScimUserResource {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: u.id,
    ...(u.scimExternalId ? { externalId: u.scimExternalId } : {}),
    userName: u.email,
    name: { formatted: u.name },
    displayName: u.name,
    emails: [{ value: u.email, type: 'work', primary: true }],
    active: !u.disabled,
    roles: [{ value: u.role, primary: true }],
    meta: { resourceType: 'User', created: u.createdAt.toISOString(), lastModified: u.updatedAt.toISOString(), location: `${baseUrl}/Users/${u.id}` },
  };
}

/* ------------------------------------------------------------------ input parsing */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : undefined);

function bool(v: unknown, attr: string): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string' && /^(true|false)$/i.test(v.trim())) return v.trim().toLowerCase() === 'true';
  throw new ScimError(400, `${attr} must be true or false`, 'invalidValue');
}

function role(v: unknown): SsoAssignableRole {
  const list = Array.isArray(v) ? v : [v];
  const entries = list.map((x) => (isObj(x) ? { value: x.value, primary: x.primary === true || x.primary === 'true' } : { value: x, primary: false }));
  const picked = entries.find((e) => e.primary) ?? entries[0];
  const value = typeof picked?.value === 'string' ? picked.value.trim().toLowerCase() : '';
  if (value === 'owner') throw new ScimError(400, 'The owner role cannot be given through SCIM: owners are managed in SmartProctoring.', 'invalidValue');
  if (!(SSO_ASSIGNABLE_ROLES as readonly string[]).includes(value)) throw new ScimError(400, `Unknown role "${String(picked?.value ?? '')}" (use reviewer or admin)`, 'invalidValue');
  return value as SsoAssignableRole;
}

function primaryEmail(v: unknown): string | undefined {
  if (!Array.isArray(v)) return undefined;
  const items = v.filter(isObj);
  const pick = items.find((e) => e.primary === true || e.primary === 'true') ?? items.find((e) => e.type === 'work') ?? items[0];
  return text(pick?.value, 254);
}

/** The attributes SCIM can change, as parsed from a resource or a PATCH. */
export interface ScimUserChanges {
  email?: string;
  name?: string;
  givenName?: string;
  familyName?: string;
  externalId?: string | null;
  active?: boolean;
  role?: SsoAssignableRole;
}

/** Apply one attribute (top-level or dotted path) to the changes. Unknown attributes are ignored. */
function applyAttribute(changes: ScimUserChanges, path: string, value: unknown, remove = false): void {
  const p = path.trim().toLowerCase().replace(new RegExp(`^${SCIM_USER_SCHEMA.toLowerCase()}:`), '');
  switch (p) {
    case 'username': {
      const v = text(value, 254);
      if (v && EMAIL_RE.test(v)) changes.email = v.toLowerCase();
      else if (!remove) throw new ScimError(400, 'userName must be an email address', 'invalidValue');
      return;
    }
    case 'displayname':
    case 'name.formatted':
      if (text(value, 200)) changes.name = text(value, 200);
      return;
    case 'name.givenname':
      changes.givenName = text(value, 100) ?? '';
      return;
    case 'name.familyname':
      changes.familyName = text(value, 100) ?? '';
      return;
    case 'name':
      if (isObj(value)) for (const [k, v] of Object.entries(value)) applyAttribute(changes, `name.${k}`, v, remove);
      return;
    case 'externalid':
      changes.externalId = remove ? null : (text(value, 300) ?? null);
      return;
    case 'active':
      changes.active = remove ? false : bool(value, 'active');
      return;
    case 'roles':
    case 'roles.value':
    case 'roles[primary eq true].value':
    case 'roles[primary eq "true"].value':
      if (remove) changes.role = 'reviewer';
      else if (!(Array.isArray(value) && value.length === 0)) changes.role = role(value);
      return;
    case 'emails':
    case 'emails[type eq "work"].value':
    case 'emails[primary eq true].value': {
      const v = p === 'emails' ? primaryEmail(value) : text(value, 254);
      if (v && EMAIL_RE.test(v)) changes.email ??= v.toLowerCase();
      return;
    }
    default:
      return; // not stored by SmartProctoring (title, phone numbers, enterprise extension, …)
  }
}

/** POST / PUT body → changes (userName required). */
export function parseScimUser(body: unknown): ScimUserChanges & { email: string } {
  if (!isObj(body)) throw new ScimError(400, 'The request body must be a SCIM User', 'invalidSyntax');
  const changes: ScimUserChanges = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'schemas' || k === 'id' || k === 'meta' || k === 'password' || k === 'groups') continue;
    if (k === 'emails') continue;
    applyAttribute(changes, k, v);
  }
  if (!changes.email) {
    const fromEmails = primaryEmail(body.emails);
    if (fromEmails && EMAIL_RE.test(fromEmails)) changes.email = fromEmails.toLowerCase();
  }
  if (!changes.email) throw new ScimError(400, 'userName (an email address) is required', 'invalidValue');
  return changes as ScimUserChanges & { email: string };
}

/** PATCH body → changes. */
export function parseScimPatch(body: unknown): ScimUserChanges {
  if (!isObj(body) || !Array.isArray(body.Operations)) throw new ScimError(400, 'A PATCH needs an Operations array', 'invalidSyntax');
  if (body.Operations.length > 50) throw new ScimError(400, 'Too many operations', 'tooMany');
  const changes: ScimUserChanges = {};
  for (const raw of body.Operations) {
    if (!isObj(raw)) throw new ScimError(400, 'Invalid operation', 'invalidSyntax');
    const op = String(raw.op ?? '').toLowerCase();
    if (op !== 'add' && op !== 'replace' && op !== 'remove') throw new ScimError(400, `Unsupported operation "${String(raw.op)}"`, 'invalidSyntax');
    const path = typeof raw.path === 'string' ? raw.path : '';
    if (path) applyAttribute(changes, path, raw.value, op === 'remove');
    else if (isObj(raw.value)) for (const [k, v] of Object.entries(raw.value)) applyAttribute(changes, k, v, op === 'remove');
    else throw new ScimError(400, 'An operation without a path needs an object value', 'invalidSyntax');
  }
  return changes;
}

/** `attr eq "value"` → SQL condition (on top of the organisation scope). */
export function scimFilter(filter: string | undefined): SQL | undefined {
  if (!filter || !filter.trim()) return undefined;
  const m = /^\s*(userName|externalId|id|emails\.value|emails)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  if (!m) throw new ScimError(400, 'Only filters of the form userName eq "…", externalId eq "…", id eq "…" or emails.value eq "…" are supported', 'invalidFilter');
  const attr = m[1].toLowerCase();
  const value = m[2].replace(/\\(.)/g, '$1');
  if (attr === 'username' || attr === 'emails.value' || attr === 'emails') return eq(sql`lower(${staffUsers.email})`, value.toLowerCase());
  if (attr === 'externalid') return eq(staffUsers.scimExternalId, value);
  return /^[0-9a-f-]{36}$/i.test(value) ? eq(staffUsers.id, value.toLowerCase()) : sql`false`;
}

/* ------------------------------------------------------------------ operations */

type ScimCtx = Pick<Ctx, 'db' | 'now'>;

const visible = (orgId: string) => and(eq(staffUsers.orgId, orgId), isNull(staffUsers.scimDeletedAt));

export async function listScimUsers(db: DbOrTx, orgId: string, q: { filter?: string; startIndex: number; count: number }): Promise<{ total: number; users: StaffUser[] }> {
  const where = and(visible(orgId), scimFilter(q.filter));
  const [[{ n }], users] = await Promise.all([
    db.select({ n: count() }).from(staffUsers).where(where),
    db
      .select()
      .from(staffUsers)
      .where(where)
      .orderBy(asc(staffUsers.createdAt), asc(staffUsers.id))
      .limit(q.count)
      .offset(q.startIndex - 1),
  ]);
  return { total: n, users };
}

async function loadVisible(db: DbOrTx, orgId: string, id: string, lock = false): Promise<StaffUser> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ScimError(404, 'User not found');
  const qb = db.select().from(staffUsers).where(and(visible(orgId), eq(staffUsers.id, id.toLowerCase())));
  const [u] = lock ? await qb.for('update') : await qb;
  if (!u) throw new ScimError(404, 'User not found');
  return u;
}

export async function getScimUser(db: DbOrTx, orgId: string, id: string): Promise<StaffUser> {
  return loadVisible(db, orgId, id);
}

function lockOrg(tx: DbOrTx, orgId: string) {
  return tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'staff-users:' + orgId}))`);
}

function scimAudit(tx: DbOrTx, p: ScimPrincipal, now: number, action: string, userId: string, meta: Record<string, unknown>) {
  return audit(tx, { orgId: p.orgId, actorType: 'scim', actorId: p.tokenId, action, targetType: 'staff_user', targetId: userId, meta: { via: 'scim', ...meta }, ip: p.ip, at: now });
}

function composedName(c: ScimUserChanges): string | undefined {
  if (c.name) return c.name;
  const parts = [c.givenName, c.familyName].filter((x): x is string => !!x);
  return parts.length ? parts.join(' ').slice(0, 200) : undefined;
}

/** Apply changes to an existing (non-owner) account. Returns the row and whether its sessions must end. */
async function applyChanges(tx: DbOrTx, p: ScimPrincipal, now: number, user: StaffUser, c: ScimUserChanges, extra: Record<string, unknown> = {}): Promise<{ user: StaffUser; signOut: boolean }> {
  if (user.role === 'owner') throw new ScimError(403, 'Owner accounts are managed in SmartProctoring only (break-glass access); SCIM cannot change them.', 'mutability');
  const patch: Partial<typeof staffUsers.$inferInsert> = {};
  const fields: string[] = [];
  if (c.email && c.email !== user.email.toLowerCase()) {
    const [dup] = await tx.select({ id: staffUsers.id }).from(staffUsers).where(eq(sql`lower(${staffUsers.email})`, c.email));
    if (dup) throw new ScimError(409, 'Another account already uses this userName', 'uniqueness');
    patch.email = c.email;
    fields.push('email');
  }
  const name = composedName(c);
  if (name && name !== user.name) {
    patch.name = name;
    fields.push('name');
  }
  if (c.externalId !== undefined && c.externalId !== user.scimExternalId) {
    patch.scimExternalId = c.externalId;
    fields.push('externalId');
  }
  if (c.role && c.role !== user.role) {
    patch.role = c.role;
    fields.push('role');
  }
  if (c.active !== undefined && c.active === user.disabled) {
    patch.disabled = !c.active;
    fields.push('disabled');
  }
  if (!fields.length && !Object.keys(extra).length) return { user, signOut: false };
  const [u] = await tx
    .update(staffUsers)
    .set({ ...patch, updatedAt: new Date(now) })
    .where(eq(staffUsers.id, user.id))
    .returning();
  await scimAudit(tx, p, now, 'user.updated', user.id, {
    fields,
    ...(patch.role ? { role: { from: user.role, to: patch.role } } : {}),
    ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}),
    ...(patch.email ? { email: { from: user.email, to: patch.email } } : {}),
    ...extra,
  });
  return { user: u, signOut: patch.disabled === true };
}

async function signOut(ctx: ScimCtx, userId: string): Promise<void> {
  await revokeStaffSessions(ctx, userId);
  await ctx.db.delete(staffLoginChallenges).where(eq(staffLoginChallenges.staffUserId, userId));
}

export async function createScimUser(ctx: ScimCtx, p: ScimPrincipal, body: unknown): Promise<StaffUser> {
  const c = parseScimUser(body);
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    await lockOrg(tx, p.orgId);
    const [existing] = await tx.select().from(staffUsers).where(eq(sql`lower(${staffUsers.email})`, c.email));
    if (existing) {
      // An account deleted through SCIM comes back with the new attributes; anything else is a duplicate.
      if (existing.orgId !== p.orgId || !existing.scimDeletedAt) throw new ScimError(409, 'A user with this userName already exists', 'uniqueness');
      const revived = await applyChanges(tx, p, now, { ...existing }, { ...c, active: c.active ?? true }, { restored: true });
      const [u] = await tx.update(staffUsers).set({ scimDeletedAt: null }).where(eq(staffUsers.id, existing.id)).returning();
      return u ?? revived.user;
    }
    const name = composedName(c) ?? c.email.split('@')[0];
    const [u] = await tx
      .insert(staffUsers)
      .values({
        orgId: p.orgId,
        email: c.email,
        name,
        role: c.role ?? 'reviewer',
        disabled: c.active === false,
        passwordHash: NO_PASSWORD_HASH,
        provisionedVia: 'scim',
        scimExternalId: c.externalId ?? null,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      })
      .onConflictDoNothing()
      .returning();
    if (!u) throw new ScimError(409, 'A user with this userName already exists', 'uniqueness');
    await scimAudit(tx, p, now, 'user.created', u.id, { email: c.email, role: u.role, disabled: u.disabled });
    return u;
  });
}

export async function updateScimUser(ctx: ScimCtx, p: ScimPrincipal, id: string, changes: ScimUserChanges): Promise<StaffUser> {
  const now = ctx.now();
  const r = await ctx.db.transaction(async (tx) => {
    await lockOrg(tx, p.orgId);
    return applyChanges(tx, p, now, await loadVisible(tx, p.orgId, id, true), changes);
  });
  if (r.signOut) await signOut(ctx, r.user.id);
  return r.user;
}

export async function deleteScimUser(ctx: ScimCtx, p: ScimPrincipal, id: string): Promise<void> {
  const now = ctx.now();
  const userId = await ctx.db.transaction(async (tx) => {
    await lockOrg(tx, p.orgId);
    const user = await loadVisible(tx, p.orgId, id, true);
    if (user.role === 'owner') throw new ScimError(403, 'Owner accounts are managed in SmartProctoring only (break-glass access); SCIM cannot delete them.', 'mutability');
    await tx.update(staffUsers).set({ disabled: true, scimDeletedAt: new Date(now), updatedAt: new Date(now) }).where(eq(staffUsers.id, user.id));
    await scimAudit(tx, p, now, 'user.updated', user.id, { fields: user.disabled ? [] : ['disabled'], disabled: true, deleted: true });
    return user.id;
  });
  await signOut(ctx, userId);
}

/* ------------------------------------------------------------------ discovery documents */

export function serviceProviderConfig(baseUrl: string, docsUrl: string) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: docsUrl,
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: SCIM_MAX_RESULTS },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'The SCIM token from SmartProctoring → Settings → Single sign-on', primary: true }],
    meta: { resourceType: 'ServiceProviderConfig', location: `${baseUrl}/ServiceProviderConfig` },
  };
}

export function resourceTypes(baseUrl: string) {
  return [
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: 'User',
      name: 'User',
      endpoint: '/Users',
      description: 'SmartProctoring staff account',
      schema: SCIM_USER_SCHEMA,
      meta: { resourceType: 'ResourceType', location: `${baseUrl}/ResourceTypes/User` },
    },
  ];
}

const attr = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
  name,
  type,
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: 'readWrite',
  returned: 'default',
  uniqueness: 'none',
  ...extra,
});

export function userSchema(baseUrl: string) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
    id: SCIM_USER_SCHEMA,
    name: 'User',
    description: 'SmartProctoring staff account',
    attributes: [
      attr('userName', 'string', { required: true, uniqueness: 'server', description: 'Email address used to sign in' }),
      attr('externalId', 'string', { caseExact: true }),
      attr('displayName', 'string'),
      attr('name', 'complex', { subAttributes: [attr('formatted', 'string'), attr('givenName', 'string'), attr('familyName', 'string')] }),
      attr('emails', 'complex', { multiValued: true, subAttributes: [attr('value', 'string'), attr('type', 'string'), attr('primary', 'boolean')] }),
      attr('active', 'boolean', { description: 'false disables the account and signs it out everywhere' }),
      attr('roles', 'complex', { multiValued: true, description: 'reviewer or admin (owners are managed in SmartProctoring)', subAttributes: [attr('value', 'string'), attr('primary', 'boolean')] }),
    ],
    meta: { resourceType: 'Schema', location: `${baseUrl}/Schemas/${SCIM_USER_SCHEMA}` },
  };
}

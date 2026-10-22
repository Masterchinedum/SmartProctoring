/**
 * Per-organisation quotas (roadmap #15; types, defaults and messages in packages/shared/src/quotas.ts): exams that are
 * not archived, candidate records, and exam sessions created per calendar month (UTC). Set by the server operator
 * (`org:create` / `org:set`, services/tenancy.ts); a production organisation has none unless set, a sandbox has
 * SANDBOX_DEFAULT_QUOTAS.
 *
 * Enforced here, in one place, by every creation path:
 *   exams       POST /api/admin/exams, /exams/import, and publishing an archived exam again   assertExamQuota
 *   candidates  POST /api/admin/candidates, POST /api/v1/candidates (a new candidate only)       assertCandidateQuota
 *   sessions    POST /api/admin/exams/:id/assignments, POST /api/v1/exams/:id/assignments       assertSessionQuota + recordSessionsCreated
 * A refusal is 409 `quota_exceeded` with QuotaExceededDetails and a plain-language message; nothing is created (the
 * whole request is refused, also for a batch of assignments).
 *
 * Concurrency: with a finite limit, the check runs under a per-organisation, per-quota advisory transaction lock and
 * the caller creates the rows in the same transaction, so parallel requests (staff app and integration API alike)
 * can never exceed the limit. Without a limit no lock is taken (production organisations keep their throughput); the
 * monthly session counter is still incremented, as the last write of the transaction (its row lock is then held only
 * until the commit), so usage is shown and a limit set mid-month counts what was already created.
 *
 * Per-session storage and upload caps are a different thing: services/session-limits.ts.
 */
import { PRODUCTION_DEFAULT_QUOTAS, QUOTA_KINDS, quotaExceededMessage, quotaLevel, quotaMonth, SANDBOX_DEFAULT_QUOTAS, DEFAULT_SANDBOX_PURGE_DAYS, type OrgKind, type OrgQuotas, type OrgUsageDTO, type QuotaExceededDetails, type QuotaKind } from '@sp/shared';
import { and, eq, ne, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/index.js';
import { candidates, exams, organizations, orgUsage, type Organization } from '../db/schema.js';
import { conflict, notFound, type HttpError } from '../lib/errors.js';

type OrgLimits = Pick<Organization, 'kind' | 'quotas'>;

const validLimit = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 0);

/** The limits that apply: the operator's overrides over the kind's defaults (null = no limit; bad stored values ignored). */
export function effectiveQuotas(org: OrgLimits): OrgQuotas {
  const base = org.kind === 'sandbox' ? SANDBOX_DEFAULT_QUOTAS : PRODUCTION_DEFAULT_QUOTAS;
  const stored = (org.quotas ?? {}) as Partial<Record<QuotaKind, unknown>>;
  const out = { ...base };
  for (const k of QUOTA_KINDS) {
    const v = stored[k];
    if (k in stored && validLimit(v)) out[k] = v;
  }
  return out;
}

/** Days after its last use before a sandbox's data is deleted. */
export function sandboxPurgeDays(org: Pick<Organization, 'sandboxPurgeDays'>): number {
  const d = org.sandboxPurgeDays;
  return d != null && Number.isInteger(d) && d >= 1 ? d : DEFAULT_SANDBOX_PURGE_DAYS;
}

export function orgKind(org: Pick<Organization, 'kind'> | null | undefined): OrgKind {
  return org?.kind === 'sandbox' ? 'sandbox' : 'production';
}

/** Serialise checks of one quota of one organisation until the transaction ends. */
async function lockQuota(tx: DbOrTx, orgId: string, quota: QuotaKind): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`quota:${quota}:${orgId}`}))`);
}

async function loadLimits(tx: DbOrTx, orgId: string): Promise<OrgLimits> {
  const [org] = await tx.select({ kind: organizations.kind, quotas: organizations.quotas }).from(organizations).where(eq(organizations.id, orgId));
  if (!org) throw notFound('Organisation not found');
  return org;
}

export function quotaExceeded(details: QuotaExceededDetails): HttpError {
  return conflict('quota_exceeded', quotaExceededMessage(details), details);
}

/* ------------------------------------------------------------------ usage */

/** Exams that count against the limit: every exam that is not archived. */
export async function examsInUse(db: DbOrTx, orgId: string): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(exams)
    .where(and(eq(exams.orgId, orgId), ne(exams.status, 'archived')));
  return n;
}

export async function candidatesInUse(db: DbOrTx, orgId: string): Promise<number> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(candidates).where(eq(candidates.orgId, orgId));
  return n;
}

/** Exam sessions created in the calendar month (UTC) containing `now`. */
export async function sessionsCreatedThisMonth(db: DbOrTx, orgId: string, now: number): Promise<number> {
  const [row] = await db
    .select({ n: orgUsage.sessionsCreated })
    .from(orgUsage)
    .where(and(eq(orgUsage.orgId, orgId), eq(orgUsage.month, quotaMonth(now).month)));
  return row?.n ?? 0;
}

/* ------------------------------------------------------------------ enforcement */

async function assertRoom(tx: DbOrTx, orgId: string, quota: QuotaKind, requested: number, now: number, used: (db: DbOrTx) => Promise<number>): Promise<void> {
  if (requested <= 0) return;
  const org = await loadLimits(tx, orgId);
  const limit = effectiveQuotas(org)[quota];
  if (limit == null) return;
  await lockQuota(tx, orgId, quota);
  const n = await used(tx);
  if (n + requested > limit) {
    throw quotaExceeded({ quota, limit, used: n, requested, resetsAt: quota === 'sessionsPerMonth' ? quotaMonth(now).resetsAt : null, kind: orgKind(org) });
  }
}

/** Before creating `requested` exams (or publishing an archived one again) in this transaction. */
export async function assertExamQuota(tx: DbOrTx, orgId: string, requested = 1, now = Date.now()): Promise<void> {
  await assertRoom(tx, orgId, 'exams', requested, now, (db) => examsInUse(db, orgId));
}

/** Before inserting a new candidate in this transaction. */
export async function assertCandidateQuota(tx: DbOrTx, orgId: string, requested = 1, now = Date.now()): Promise<void> {
  await assertRoom(tx, orgId, 'candidates', requested, now, (db) => candidatesInUse(db, orgId));
}

/**
 * Before creating `requested` exam sessions in this transaction; the caller then records what it created with
 * recordSessionsCreated in the same transaction (the lock taken here is held until the commit).
 */
export async function assertSessionQuota(tx: DbOrTx, orgId: string, requested: number, now: number): Promise<void> {
  await assertRoom(tx, orgId, 'sessionsPerMonth', requested, now, (db) => sessionsCreatedThisMonth(db, orgId, now));
}

/** Count `created` new exam sessions for the month (UTC) containing `now`. Call it last in the transaction. */
export async function recordSessionsCreated(tx: DbOrTx, orgId: string, created: number, now: number): Promise<void> {
  if (created <= 0) return;
  const month = quotaMonth(now).month;
  await tx
    .insert(orgUsage)
    .values({ orgId, month, sessionsCreated: created, updatedAt: new Date(now) })
    .onConflictDoUpdate({ target: [orgUsage.orgId, orgUsage.month], set: { sessionsCreated: sql`${orgUsage.sessionsCreated} + ${created}`, updatedAt: new Date(now) } });
}

/** GET /api/admin/usage. */
export async function orgUsageDTO(db: DbOrTx, org: Pick<Organization, 'id' | 'kind' | 'quotas' | 'sandboxPurgeDays'>, now: number): Promise<OrgUsageDTO> {
  const limits = effectiveQuotas(org);
  const [e, c, s] = await Promise.all([examsInUse(db, org.id), candidatesInUse(db, org.id), sessionsCreatedThisMonth(db, org.id, now)]);
  const used: Record<QuotaKind, number> = { exams: e, candidates: c, sessionsPerMonth: s };
  const kind = orgKind(org);
  return {
    kind,
    period: quotaMonth(now),
    quotas: QUOTA_KINDS.map((quota) => ({ quota, limit: limits[quota], used: used[quota], level: quotaLevel(used[quota], limits[quota]) })),
    sandbox: kind === 'sandbox' ? { purgeAfterDays: sandboxPurgeDays(org) } : null,
  };
}

/**
 * Organisations near (warning: from QUOTA_WARNING_RATIO) or at a limit, per quota — the cluster gauge
 * `sp_cluster_organizations_at_quota` (lib/metrics.ts). Only organisations with a limit are read.
 */
export async function quotaPressure(db: DbOrTx, now: number): Promise<Record<QuotaKind, { warning: number; reached: number }>> {
  const month = quotaMonth(now).month;
  const rows = await db
    .select({
      kind: organizations.kind,
      quotas: organizations.quotas,
      // Spelled out: drizzle writes columns in the select list of a one-table query without their table name, which
      // would make these correlated sub-queries compare a table with itself.
      exams: sql<number>`(select count(*) from exams e where e.org_id = organizations.id and e.status <> 'archived')::int`,
      candidates: sql<number>`(select count(*) from candidates c where c.org_id = organizations.id)::int`,
      sessionsPerMonth: sql<number>`coalesce((select u.sessions_created from org_usage u where u.org_id = organizations.id and u.month = ${month}), 0)::int`,
    })
    .from(organizations)
    .where(or(eq(organizations.kind, 'sandbox'), sql`${organizations.quotas} <> '{}'::jsonb`));
  const out = Object.fromEntries(QUOTA_KINDS.map((k) => [k, { warning: 0, reached: 0 }])) as Record<QuotaKind, { warning: number; reached: number }>;
  for (const r of rows) {
    const limits = effectiveQuotas(r);
    for (const k of QUOTA_KINDS) {
      const level = quotaLevel(r[k], limits[k]);
      if (level !== 'ok') out[k][level]++;
    }
  }
  return out;
}

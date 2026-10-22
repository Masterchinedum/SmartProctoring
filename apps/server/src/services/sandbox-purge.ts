/**
 * Sandbox clean-up (roadmap #15; job `sandbox-purge`, hourly; CLI `sandbox:purge`). A sandbox organisation is for
 * trials and integration testing, not for real candidates, so its data does not wait for the retention periods: once
 * it has not been used for the organisation's clean-up period (`sandbox_purge_days`, default 14 days) it is deleted.
 * Production organisations are never touched — the selection reads only `kind = 'sandbox'`, and every deletion
 * re-checks the kind under a share lock on the organisation row (an operator's `org:set --kind production` waits for
 * it, or makes it skip).
 *
 * Per sandbox organisation, older than the cut-off (now − clean-up period):
 *  1. Exam sessions that ended before the cut-off, and unfinished ones whose last activity (the latest of their last
 *     change, last heartbeat, hold start and scheduling window — services/abandonment.ts) is before it: the images
 *     and face templates first, through the evidence helpers (each blob deleted in the storage location its row
 *     records), then the evidence rows and the session row, whose records cascade (events, answers, checks, identity
 *     checks and references, periods, notes, reviews, alert emails…). A session under **legal hold is kept** (counted
 *     and listed in the run's summary and audit entry). A session whose images could not all be deleted stays (what
 *     was deleted is tombstoned) and is retried on the next run.
 *  2. Candidates that no longer have any session and were created and last changed before the cut-off: the approved
 *     ID photo (blob first) and any leftover images, then the candidate row (accommodations cascade). Privacy requests
 *     keep their row (candidate link set to null), as after an erasure.
 * Kept: exams and their versions (configuration, no personal data — the exam quota is what limits them), staff
 * accounts, API keys and webhooks, the privacy register and the audit log (the security record of what was done in the
 * sandbox, including these clean-ups). Webhook delivery records and alert emails age out after 30 days as everywhere.
 *
 * One `sandbox.purge` audit entry per organisation and run in which something was deleted or kept for a legal hold.
 * Every real run (not a dry run) is recorded in job_status (`sandbox-purge`), shown in Privacy → Operational checks of
 * a sandbox organisation. Idempotent: a second run finds nothing more to delete.
 */
import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import type { DbOrTx } from '../db/index.js';
import { candidates, evidence, examSessions, organizations, type SandboxPurgeRunSummary } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { purgeCandidateIdPhoto, purgeEvidenceRows, purgeSessionEvidence } from './evidence.js';
import { recordJobFinish, recordJobStart } from './job-status.js';
import { sandboxPurgeDays } from './quotas.js';
import { DAY_MS } from './retention.js';

export const SANDBOX_PURGE_JOB = 'sandbox-purge';
export const SANDBOX_PURGE_LOCK_KEY = 727274013;
export const SANDBOX_PURGE_INTERVAL_MS = 3_600_000;
export const SANDBOX_PURGE_REASON = 'sandbox_purge';
/** Legal-hold sessions listed by id in a summary / audit entry at most. */
const LIST_MAX = 50;

export type SandboxPurgeCtx = Pick<Ctx, 'db' | 'storage' | 'keyring' | 'now' | 'log'> & Partial<Pick<Ctx, 'storageLocations'>>;

export interface SandboxPurgeOptions {
  /** Evaluate as of this instant (default ctx.now()). */
  now?: number;
  /** Count what would be deleted; delete nothing. */
  dryRun?: boolean;
  /** Only this organisation (it must be a sandbox; a production organisation is never touched). */
  orgId?: string;
  /** Rows examined per database batch (default 100). */
  batchSize?: number;
}

export interface SandboxOrgPurgeResult {
  orgId: string;
  name: string;
  purgeAfterDays: number;
  /** Data last used before this instant is due. */
  cutoff: number;
  sessionsDeleted: number;
  evidenceItemsPurged: number;
  candidatesDeleted: number;
  /** Due sessions kept because of a legal hold. */
  skippedLegalHold: number;
  legalHoldSessionIds: string[];
  failures: { target: 'session' | 'candidate'; id: string; error: string }[];
}

export interface SandboxPurgeSummary {
  now: number;
  dryRun: boolean;
  organisations: SandboxOrgPurgeResult[];
  totals: SandboxPurgeRunSummary;
  durationMs: number;
}

/* ------------------------------------------------------------------ what is due */

/** The session's last use: its end, or for an unfinished session its latest sign of activity (as abandonment.ts). */
const lastUseSql = sql`coalesce(${examSessions.endedAt}, greatest(${examSessions.createdAt}, ${examSessions.updatedAt}, coalesce(${examSessions.lastHeartbeatAt}, ${examSessions.updatedAt}), coalesce(${examSessions.holdSince}, ${examSessions.updatedAt}), ${examSessions.windowStartsAt}, ${examSessions.windowEndsAt}))`;
const sessionDue = (cutoff: Date): SQL => sql`${lastUseSql} <= ${cutoff}`;
const candidateQuiet = (cutoff: Date): SQL => and(sql`${candidates.createdAt} <= ${cutoff}`, sql`${candidates.updatedAt} <= ${cutoff}`)!;

/* ------------------------------------------------------------------ run */

export async function runSandboxPurge(ctx: SandboxPurgeCtx, opts: SandboxPurgeOptions = {}): Promise<SandboxPurgeSummary> {
  if (opts.dryRun) return purgeAll(ctx, opts);
  await recordJobStart(ctx.db, SANDBOX_PURGE_JOB, ctx.now());
  let summary: SandboxPurgeSummary;
  try {
    summary = await purgeAll(ctx, opts);
  } catch (err) {
    await recordJobFinish(ctx.db, SANDBOX_PURGE_JOB, ctx.now(), { error: (err as Error).message || String(err) }).catch((e) => ctx.log.error({ err: e }, 'sandbox purge: could not record the failed run'));
    throw err;
  }
  await recordJobFinish(ctx.db, SANDBOX_PURGE_JOB, ctx.now(), { summary: summary.totals });
  return summary;
}

async function purgeAll(ctx: SandboxPurgeCtx, opts: SandboxPurgeOptions): Promise<SandboxPurgeSummary> {
  const started = Date.now();
  const now = opts.now ?? ctx.now();
  const orgs = await ctx.db
    .select({ id: organizations.id, name: organizations.name, sandboxPurgeDays: organizations.sandboxPurgeDays })
    .from(organizations)
    .where(and(eq(organizations.kind, 'sandbox'), opts.orgId ? eq(organizations.id, opts.orgId) : undefined))
    .orderBy(asc(organizations.id));
  const results: SandboxOrgPurgeResult[] = [];
  for (const org of orgs) {
    const r = await purgeOrg(ctx, org, now, opts);
    results.push(r);
    const did = r.sessionsDeleted + r.candidatesDeleted + r.evidenceItemsPurged + r.skippedLegalHold + r.failures.length;
    if (!opts.dryRun && did > 0) {
      await audit(ctx.db, {
        orgId: org.id,
        actorType: 'system',
        action: 'sandbox.purge',
        targetType: 'organization',
        targetId: org.id,
        meta: {
          purgeAfterDays: r.purgeAfterDays,
          cutoff: r.cutoff,
          sessionsDeleted: r.sessionsDeleted,
          evidenceItemsPurged: r.evidenceItemsPurged,
          candidatesDeleted: r.candidatesDeleted,
          skippedLegalHold: r.skippedLegalHold,
          legalHoldSessionIds: r.legalHoldSessionIds,
          failures: r.failures.length,
        },
        at: now,
      });
    }
  }
  const totals: SandboxPurgeRunSummary = {
    organisations: results.length,
    sessionsDeleted: results.reduce((a, r) => a + r.sessionsDeleted, 0),
    evidenceItemsPurged: results.reduce((a, r) => a + r.evidenceItemsPurged, 0),
    candidatesDeleted: results.reduce((a, r) => a + r.candidatesDeleted, 0),
    skippedLegalHold: results.reduce((a, r) => a + r.skippedLegalHold, 0),
    failures: results.reduce((a, r) => a + r.failures.length, 0),
  };
  return { now, dryRun: opts.dryRun === true, organisations: results, totals, durationMs: Date.now() - started };
}

async function purgeOrg(ctx: SandboxPurgeCtx, org: { id: string; name: string; sandboxPurgeDays: number | null }, now: number, opts: SandboxPurgeOptions): Promise<SandboxOrgPurgeResult> {
  const purgeAfterDays = sandboxPurgeDays(org);
  const cutoff = now - purgeAfterDays * DAY_MS;
  const cutoffDate = new Date(cutoff);
  const batch = Math.max(1, Math.min(opts.batchSize ?? 100, 1000));
  const r: SandboxOrgPurgeResult = { orgId: org.id, name: org.name, purgeAfterDays, cutoff, sessionsDeleted: 0, evidenceItemsPurged: 0, candidatesDeleted: 0, skippedLegalHold: 0, legalHoldSessionIds: [], failures: [] };
  const held = (id: string) => {
    r.skippedLegalHold++;
    if (r.legalHoldSessionIds.length < LIST_MAX) r.legalHoldSessionIds.push(id);
  };

  /* ---------------------------------------------------------------- sessions */
  let lastId: string | null = null;
  for (;;) {
    const due = await ctx.db
      .select({ id: examSessions.id, legalHold: examSessions.legalHold })
      .from(examSessions)
      .where(and(eq(examSessions.orgId, org.id), sessionDue(cutoffDate), lastId ? sql`${examSessions.id} > ${lastId}` : undefined))
      .orderBy(asc(examSessions.id))
      .limit(batch);
    if (due.length === 0) break;
    lastId = due[due.length - 1].id;
    for (const s of due) {
      if (s.legalHold) {
        held(s.id);
        continue;
      }
      if (opts.dryRun) {
        r.sessionsDeleted++;
        r.evidenceItemsPurged += await liveEvidence(ctx.db, eq(evidence.sessionId, s.id));
        continue;
      }
      try {
        const res = await deleteSession(ctx, org.id, s.id, cutoffDate, now);
        if (res === 'legal_hold') held(s.id);
        else if (res === 'not_sandbox') return r; // the operator made it a production organisation: stop here
        else if (res) {
          r.evidenceItemsPurged += res.purged;
          if (res.deleted) r.sessionsDeleted++;
          else r.failures.push({ target: 'session', id: s.id, error: `${res.remaining} image(s) could not be deleted; will retry` });
        }
      } catch (err) {
        r.failures.push({ target: 'session', id: s.id, error: (err as Error).message });
        ctx.log.error({ err, sessionId: s.id, orgId: org.id }, 'sandbox purge: could not delete a session');
      }
    }
    if (due.length < batch) break;
  }

  /* ---------------------------------------------------------------- candidates without sessions */
  // A dry run deleted nothing: count candidates whose every session would go (none under legal hold).
  const noSessionLeft = opts.dryRun
    ? sql`not exists (select 1 from ${examSessions} where ${examSessions.candidateId} = ${candidates.id} and (${examSessions.legalHold} or not (${sessionDue(cutoffDate)})))`
    : sql`not exists (select 1 from ${examSessions} where ${examSessions.candidateId} = ${candidates.id})`;
  lastId = null;
  for (;;) {
    const due = await ctx.db
      .select({ id: candidates.id })
      .from(candidates)
      .where(and(eq(candidates.orgId, org.id), candidateQuiet(cutoffDate), noSessionLeft, lastId ? sql`${candidates.id} > ${lastId}` : undefined))
      .orderBy(asc(candidates.id))
      .limit(batch);
    if (due.length === 0) break;
    lastId = due[due.length - 1].id;
    for (const c of due) {
      if (opts.dryRun) {
        r.candidatesDeleted++;
        r.evidenceItemsPurged += await liveEvidence(ctx.db, and(eq(evidence.candidateId, c.id), isNull(evidence.sessionId))!);
        continue;
      }
      try {
        const res = await deleteCandidate(ctx, org.id, c.id, cutoffDate, now);
        if (res === 'not_sandbox') return r;
        if (res && res !== 'legal_hold') {
          r.evidenceItemsPurged += res.purged;
          if (res.deleted) r.candidatesDeleted++;
          else r.failures.push({ target: 'candidate', id: c.id, error: `${res.remaining} image(s) could not be deleted; will retry` });
        }
      } catch (err) {
        r.failures.push({ target: 'candidate', id: c.id, error: (err as Error).message });
        ctx.log.error({ err, candidateId: c.id, orgId: org.id }, 'sandbox purge: could not delete a candidate');
      }
    }
    if (due.length < batch) break;
  }
  return r;
}

async function liveEvidence(db: DbOrTx, where: SQL): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(evidence)
    .where(and(where, isNull(evidence.purgedAt)));
  return n;
}

/** Still a sandbox? A share lock on the organisation row: `org:set` (FOR UPDATE) waits until this transaction ends. */
async function stillSandbox(tx: DbOrTx, orgId: string): Promise<boolean> {
  const [o] = await tx.select({ kind: organizations.kind }).from(organizations).where(eq(organizations.id, orgId)).for('share');
  return o?.kind === 'sandbox';
}

type DeleteResult = { purged: number; remaining: number; deleted: boolean } | 'legal_hold' | 'not_sandbox' | null;

/** Images first (each in its own storage location), then the rows; re-checked under the row lock. */
async function deleteSession(ctx: SandboxPurgeCtx, orgId: string, sessionId: string, cutoff: Date, now: number): Promise<DeleteResult> {
  return ctx.db.transaction(async (tx) => {
    if (!(await stillSandbox(tx, orgId))) return 'not_sandbox';
    const [s] = await tx
      .select({ id: examSessions.id, legalHold: examSessions.legalHold, due: sql<boolean>`${sessionDue(cutoff)}` })
      .from(examSessions)
      .where(and(eq(examSessions.id, sessionId), eq(examSessions.orgId, orgId)))
      .for('update');
    if (!s) return null; // deleted meanwhile (candidate erased)
    if (s.legalHold) return 'legal_hold';
    if (!s.due) return null; // used again meanwhile (reopened for recovery…)
    const { evidence: purged } = await purgeSessionEvidence({ ...ctx, now: () => now }, tx, sessionId, SANDBOX_PURGE_REASON);
    const remaining = await liveEvidence(tx, eq(evidence.sessionId, sessionId));
    if (remaining > 0) return { purged, remaining, deleted: false };
    await tx.delete(evidence).where(eq(evidence.sessionId, sessionId));
    await tx.delete(examSessions).where(eq(examSessions.id, sessionId)); // cascades to the session's records
    return { purged, remaining: 0, deleted: true };
  });
}

async function deleteCandidate(ctx: SandboxPurgeCtx, orgId: string, candidateId: string, cutoff: Date, now: number): Promise<DeleteResult> {
  const c2 = { ...ctx, now: () => now };
  return ctx.db.transaction(async (tx) => {
    if (!(await stillSandbox(tx, orgId))) return 'not_sandbox';
    const [c] = await tx
      .select({ id: candidates.id })
      .from(candidates)
      .where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId), candidateQuiet(cutoff)))
      .for('update');
    if (!c) return null;
    const [{ sessions }] = await tx.select({ sessions: sql<number>`count(*)::int` }).from(examSessions).where(eq(examSessions.candidateId, candidateId));
    if (sessions > 0) return null; // assigned meanwhile
    const before = await liveEvidence(tx, eq(evidence.candidateId, candidateId));
    await purgeCandidateIdPhoto(c2, tx, candidateId, SANDBOX_PURGE_REASON);
    const leftovers = await tx
      .select()
      .from(evidence)
      .where(and(eq(evidence.candidateId, candidateId), isNull(evidence.purgedAt)));
    await purgeEvidenceRows(c2, tx, leftovers, SANDBOX_PURGE_REASON);
    const remaining = await liveEvidence(tx, eq(evidence.candidateId, candidateId));
    if (remaining > 0) return { purged: before - remaining, remaining, deleted: false };
    await tx.delete(evidence).where(eq(evidence.candidateId, candidateId));
    await tx.delete(candidates).where(eq(candidates.id, candidateId)); // accommodations cascade; privacy requests keep their row
    return { purged: before, remaining: 0, deleted: true };
  });
}

/* ------------------------------------------------------------------ exclusive run */

export type SandboxPurgeLockCtx = SandboxPurgeCtx & Pick<Ctx, 'database'>;

/** Run while holding the cluster-wide lock (shared by the job and the CLI); null when another run holds it. */
export async function runSandboxPurgeExclusive(ctx: SandboxPurgeLockCtx, opts: SandboxPurgeOptions = {}): Promise<SandboxPurgeSummary | null> {
  const client = await ctx.database.pool.connect();
  let locked = false;
  try {
    const res = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [SANDBOX_PURGE_LOCK_KEY]);
    locked = res.rows[0]?.locked === true;
    if (!locked) return null;
    return await runSandboxPurge(ctx, opts);
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [SANDBOX_PURGE_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

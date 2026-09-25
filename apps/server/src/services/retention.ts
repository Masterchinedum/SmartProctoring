/**
 * Retention job (docs/PRIVACY.md §4).
 *
 *  1. Evidence: for every ended session whose evidence retention has elapsed
 *     (exam policy `retention.evidenceDays`, else the organisation's `evidenceRetentionDays`) and that is
 *     not under legal hold, delete the evidence blobs (rows stay as tombstones with purgedAt/purgeReason),
 *     clear the encrypted reference embeddings and check-frame / sample-frame embeddings, strip facial landmarks
 *     from check-frame and sample-frame analyses, and set exam_sessions.evidence_purged_at.
 *  2. Event metadata: for ended sessions older than the organisation's `eventRetentionDays` (and not under
 *     legal hold, and already evidence-purged), delete events, identity checks, check frames, identity-sample
 *     burst frames and the evidence tombstones. The session record, periods, answers, score, notes and the audit log remain.
 *
 * One `retention.purge` audit entry is written per session and run in which something was deleted.
 * The job is idempotent: sessions already purged are skipped, and a failed blob deletion leaves the
 * session unmarked so the next run retries it.
 *
 * Scheduling: startRetentionScheduler(ctx) runs it hourly on every instance; a Postgres advisory lock
 * makes sure only one instance works at a time.
 */
import { and, asc, eq, exists, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import type { DbOrTx } from '../db/index.js';
import { checkFrames, checks, events, evidence, examSessions, exams, identityChecks, identitySampleFrames, organizations } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { purgeSessionEvidence } from './evidence.js';
import { DEFAULT_ORG_SETTINGS, orgSettings } from './org.js';
import { effectivePolicy } from './session-state.js';

export const DAY_MS = 24 * 3600_000;
export const RETENTION_LOCK_KEY = 727274010;
export const RETENTION_PURGE_REASON = 'retention';
export const DEFAULT_RETENTION_INTERVAL_MS = 3600_000;

export type RetentionCtx = Pick<Ctx, 'db' | 'storage' | 'keyring' | 'now' | 'log'>;

export interface RetentionOptions {
  /** Evaluate retention as of this instant (default ctx.now()). */
  now?: number;
  /** Report what would be purged without deleting anything. */
  dryRun?: boolean;
  /** Sessions examined per database batch (default 100). */
  batchSize?: number;
  /** Stop after this many sessions per phase (default unlimited). */
  maxSessions?: number;
}

export interface RetentionSessionResult {
  sessionId: string;
  orgId: string;
  evidencePurged: number | null;
  eventMetadata: { events: number; identityChecks: number; checkFrames: number; sampleFrames: number; evidenceRows: number } | null;
}

export interface RetentionSummary {
  now: number;
  dryRun: boolean;
  /** Sessions whose evidence was purged in this run. */
  sessionsEvidencePurged: number;
  evidenceItemsPurged: number;
  /** Sessions whose event metadata was deleted in this run. */
  sessionsEventMetadataPurged: number;
  eventsDeleted: number;
  identityChecksDeleted: number;
  /** Sessions past their retention date that were kept because of a legal hold. */
  skippedLegalHold: number;
  failures: { sessionId: string; phase: 'evidence' | 'event_metadata'; error: string }[];
  sessions: RetentionSessionResult[];
  durationMs: number;
}

/* ================================================================== deadlines */

/** Days after the session ends before its evidence is deleted. */
export function evidenceDaysFor(session: Parameters<typeof effectivePolicy>[0], exam: Parameters<typeof effectivePolicy>[1], org: Parameters<typeof orgSettings>[0] & Parameters<typeof effectivePolicy>[2]): number {
  let fromPolicy: number | null = null;
  try {
    fromPolicy = effectivePolicy(session, exam, org).retention.evidenceDays;
  } catch {
    fromPolicy = null; // an invalid stored policy never blocks deletion: fall back to the org default
  }
  return fromPolicy ?? orgSettings(org).evidenceRetentionDays;
}

/** SQL: evidence retention days for a session row (same precedence as evidenceDaysFor). Used to pre-filter. */
const jsonDays = (expr: ReturnType<typeof sql>) => sql`(case when jsonb_typeof(${expr}) = 'number' then (${expr})::text::numeric end)`;
const evidenceDaysSql = sql`coalesce(
  ${jsonDays(sql`${examSessions.policy} -> 'retention' -> 'evidenceDays'`)},
  ${jsonDays(sql`${exams.policy} -> 'retention' -> 'evidenceDays'`)},
  ${jsonDays(sql`${organizations.settings} -> 'defaultPolicy' -> 'retention' -> 'evidenceDays'`)},
  ${jsonDays(sql`${organizations.settings} -> 'evidenceRetentionDays'`)},
  ${DEFAULT_ORG_SETTINGS.evidenceRetentionDays}::numeric)`;
const eventDaysSql = sql`coalesce(${jsonDays(sql`${organizations.settings} -> 'eventRetentionDays'`)}, ${DEFAULT_ORG_SETTINGS.eventRetentionDays}::numeric)`;

/* ================================================================== run */

export async function runRetention(ctx: RetentionCtx, opts: RetentionOptions = {}): Promise<RetentionSummary> {
  const started = Date.now();
  const now = opts.now ?? ctx.now();
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? 100, 1000));
  const max = opts.maxSessions ?? Number.POSITIVE_INFINITY;
  const summary: RetentionSummary = {
    now,
    dryRun: opts.dryRun === true,
    sessionsEvidencePurged: 0,
    evidenceItemsPurged: 0,
    sessionsEventMetadataPurged: 0,
    eventsDeleted: 0,
    identityChecksDeleted: 0,
    skippedLegalHold: 0,
    failures: [],
    sessions: [],
    durationMs: 0,
  };
  const results = new Map<string, RetentionSessionResult>();
  const resultFor = (sessionId: string, orgId: string) => {
    let r = results.get(sessionId);
    if (!r) {
      r = { sessionId, orgId, evidencePurged: null, eventMetadata: null };
      results.set(sessionId, r);
    }
    return r;
  };
  const nowDate = new Date(now);

  /* ---------------------------------------------------------------- phase 1: evidence */
  const failedEvidence = new Set<string>();
  let processed = 0;
  let lastId: string | null = null;
  while (processed < max) {
    const due = await ctx.db
      .select({ session: examSessions, exam: { policy: exams.policy }, org: { settings: organizations.settings } })
      .from(examSessions)
      .innerJoin(exams, eq(exams.id, examSessions.examId))
      .innerJoin(organizations, eq(organizations.id, examSessions.orgId))
      .where(
        and(
          isNotNull(examSessions.endedAt),
          isNull(examSessions.evidencePurgedAt),
          eq(examSessions.legalHold, false),
          sql`${examSessions.endedAt} + make_interval(days => (${evidenceDaysSql})::int) <= ${nowDate}`,
          lastId ? sql`${examSessions.id} > ${lastId}` : undefined,
        ),
      )
      .orderBy(asc(examSessions.id))
      .limit(batchSize);
    if (due.length === 0) break;
    lastId = due[due.length - 1].session.id;
    for (const r of due) {
      if (processed >= max) break;
      const s = r.session;
      const days = evidenceDaysFor(s, r.exam, r.org);
      if (!s.endedAt || s.endedAt.getTime() + days * DAY_MS > now) continue; // authoritative check
      processed++;
      if (summary.dryRun) {
        const [{ n }] = await ctx.db
          .select({ n: sql<number>`count(*)::int` })
          .from(evidence)
          .where(and(eq(evidence.sessionId, s.id), isNull(evidence.purgedAt)));
        resultFor(s.id, s.orgId).evidencePurged = n;
        summary.sessionsEvidencePurged++;
        summary.evidenceItemsPurged += n;
        continue;
      }
      try {
        const res = await purgeSessionEvidenceNow(ctx, s.id, now);
        if (res == null) continue; // raced: legal hold set / already purged by another run
        summary.evidenceItemsPurged += res.purged;
        if (res.remaining > 0) {
          // Some blobs could not be deleted (storage error, logged by purgeEvidenceRows). What was deleted is
          // tombstoned; the session stays unmarked so the next run retries the rest.
          failedEvidence.add(s.id);
          summary.failures.push({ sessionId: s.id, phase: 'evidence', error: `${res.remaining} evidence item(s) could not be deleted; will retry (retention ${days} days)` });
          if (res.purged > 0) resultFor(s.id, s.orgId).evidencePurged = res.purged;
          continue;
        }
        resultFor(s.id, s.orgId).evidencePurged = res.purged;
        summary.sessionsEvidencePurged++;
      } catch (err) {
        failedEvidence.add(s.id);
        summary.failures.push({ sessionId: s.id, phase: 'evidence', error: (err as Error).message });
        ctx.log.error({ err, sessionId: s.id }, 'retention: evidence purge failed');
      }
    }
    if (due.length < batchSize) break;
  }

  /* ---------------------------------------------------------------- phase 2: event metadata */
  processed = 0;
  lastId = null;
  while (processed < max) {
    const due = await ctx.db
      .select({ id: examSessions.id, orgId: examSessions.orgId, endedAt: examSessions.endedAt, evidencePurgedAt: examSessions.evidencePurgedAt, eventDays: sql<number>`(${eventDaysSql})::int` })
      .from(examSessions)
      .innerJoin(organizations, eq(organizations.id, examSessions.orgId))
      .where(
        and(
          isNotNull(examSessions.endedAt),
          eq(examSessions.legalHold, false),
          sql`${examSessions.endedAt} + make_interval(days => (${eventDaysSql})::int) <= ${nowDate}`,
          or(
            exists(ctx.db.select({ x: sql`1` }).from(events).where(eq(events.sessionId, examSessions.id))),
            exists(ctx.db.select({ x: sql`1` }).from(identityChecks).where(eq(identityChecks.sessionId, examSessions.id))),
            exists(ctx.db.select({ x: sql`1` }).from(evidence).where(eq(evidence.sessionId, examSessions.id))),
          ),
          lastId ? sql`${examSessions.id} > ${lastId}` : undefined,
        ),
      )
      .orderBy(asc(examSessions.id))
      .limit(batchSize);
    if (due.length === 0) break;
    lastId = due[due.length - 1].id;
    for (const s of due) {
      if (processed >= max) break;
      // Evidence must be gone first (it is normally due much earlier; a longer per-exam evidence period wins).
      const evidenceDone = s.evidencePurgedAt != null || results.get(s.id)?.evidencePurged != null;
      if (!evidenceDone || failedEvidence.has(s.id)) continue;
      processed++;
      if (summary.dryRun) {
        const counts = await countEventMetadata(ctx.db, s.id);
        resultFor(s.id, s.orgId).eventMetadata = counts;
        summary.sessionsEventMetadataPurged++;
        summary.eventsDeleted += counts.events;
        summary.identityChecksDeleted += counts.identityChecks;
        continue;
      }
      try {
        const counts = await purgeEventMetadataNow(ctx, s.id, now, s.eventDays);
        if (!counts) continue;
        resultFor(s.id, s.orgId).eventMetadata = counts;
        summary.sessionsEventMetadataPurged++;
        summary.eventsDeleted += counts.events;
        summary.identityChecksDeleted += counts.identityChecks;
      } catch (err) {
        summary.failures.push({ sessionId: s.id, phase: 'event_metadata', error: (err as Error).message });
        ctx.log.error({ err, sessionId: s.id }, 'retention: event metadata purge failed');
      }
    }
    if (due.length < batchSize) break;
  }

  /* ---------------------------------------------------------------- audit (one entry per session) */
  if (!summary.dryRun) {
    for (const r of results.values()) {
      await audit(ctx.db, {
        orgId: r.orgId,
        actorType: 'system',
        action: 'retention.purge',
        targetType: 'session',
        targetId: r.sessionId,
        meta: {
          evidence: r.evidencePurged != null ? { itemsPurged: r.evidencePurged } : null,
          eventMetadata: r.eventMetadata,
        },
        at: now,
      });
    }
  }

  summary.skippedLegalHold = await countLegalHoldSkips(ctx.db, nowDate);
  summary.sessions = [...results.values()];
  summary.durationMs = Date.now() - started;
  return summary;
}

/**
 * Purge one session's evidence under its row lock. Returns items purged and items that could not be
 * deleted, or null if the session is no longer due (legal hold set / purged by another run meanwhile).
 */
async function purgeSessionEvidenceNow(ctx: RetentionCtx, sessionId: string, now: number): Promise<{ purged: number; remaining: number } | null> {
  return ctx.db.transaction(async (tx) => {
    const [s] = await tx.select().from(examSessions).where(eq(examSessions.id, sessionId)).for('update');
    if (!s || !s.endedAt || s.legalHold || s.evidencePurgedAt) return null;
    const { evidence: purged } = await purgeSessionEvidence({ ...ctx, now: () => now }, tx, sessionId, RETENTION_PURGE_REASON);
    // Facial landmarks / face boxes in check-frame analyses are geometric face data: drop them with the images.
    await tx
      .update(checkFrames)
      .set({ analysis: sql`${checkFrames.analysis} - 'landmarks' - 'box'` })
      .where(eq(checkFrames.sessionId, sessionId));
    await tx
      .update(identitySampleFrames)
      .set({ analysis: sql`${identitySampleFrames.analysis} - 'landmarks' - 'box'` })
      .where(eq(identitySampleFrames.sessionId, sessionId));
    const [{ remaining }] = await tx
      .select({ remaining: sql<number>`count(*)::int` })
      .from(evidence)
      .where(and(eq(evidence.sessionId, sessionId), isNull(evidence.purgedAt)));
    if (remaining === 0) await tx.update(examSessions).set({ evidencePurgedAt: new Date(now) }).where(eq(examSessions.id, sessionId));
    return { purged, remaining };
  });
}

async function countEventMetadata(db: DbOrTx, sessionId: string) {
  const [[e], [i], [f], [sf], [v]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(events).where(eq(events.sessionId, sessionId)),
    db.select({ n: sql<number>`count(*)::int` }).from(identityChecks).where(eq(identityChecks.sessionId, sessionId)),
    db.select({ n: sql<number>`count(*)::int` }).from(checkFrames).where(eq(checkFrames.sessionId, sessionId)),
    db.select({ n: sql<number>`count(*)::int` }).from(identitySampleFrames).where(eq(identitySampleFrames.sessionId, sessionId)),
    db.select({ n: sql<number>`count(*)::int` }).from(evidence).where(eq(evidence.sessionId, sessionId)),
  ]);
  return { events: e.n, identityChecks: i.n, checkFrames: f.n, sampleFrames: sf.n, evidenceRows: v.n };
}

async function purgeEventMetadataNow(ctx: RetentionCtx, sessionId: string, now: number, eventDays: number) {
  return ctx.db.transaction(async (tx) => {
    const [s] = await tx.select().from(examSessions).where(eq(examSessions.id, sessionId)).for('update');
    if (!s || !s.endedAt || s.legalHold || !s.evidencePurgedAt) return null;
    if (s.endedAt.getTime() + eventDays * DAY_MS > now) return null;
    // Only tombstones may be deleted: never drop a row whose blob still exists.
    const [{ live }] = await tx
      .select({ live: sql<number>`count(*)::int` })
      .from(evidence)
      .where(and(eq(evidence.sessionId, sessionId), isNull(evidence.purgedAt)));
    if (live > 0) return null;
    const ev = await tx.delete(events).where(eq(events.sessionId, sessionId)).returning({ id: events.id });
    const ic = await tx.delete(identityChecks).where(eq(identityChecks.sessionId, sessionId)).returning({ id: identityChecks.id });
    const cf = await tx.delete(checkFrames).where(eq(checkFrames.sessionId, sessionId)).returning({ id: checkFrames.id });
    const sf = await tx.delete(identitySampleFrames).where(eq(identitySampleFrames.sessionId, sessionId)).returning({ id: identitySampleFrames.id });
    await tx.update(checks).set({ result: null }).where(eq(checks.sessionId, sessionId));
    const er = await tx
      .delete(evidence)
      .where(and(eq(evidence.sessionId, sessionId), isNotNull(evidence.purgedAt)))
      .returning({ id: evidence.id });
    if (ev.length + ic.length + cf.length + sf.length + er.length === 0) return null;
    return { events: ev.length, identityChecks: ic.length, checkFrames: cf.length, sampleFrames: sf.length, evidenceRows: er.length };
  });
}

async function countLegalHoldSkips(db: DbOrTx, nowDate: Date): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(examSessions)
    .innerJoin(exams, eq(exams.id, examSessions.examId))
    .innerJoin(organizations, eq(organizations.id, examSessions.orgId))
    .where(
      and(
        isNotNull(examSessions.endedAt),
        isNull(examSessions.evidencePurgedAt),
        eq(examSessions.legalHold, true),
        lte(sql`${examSessions.endedAt} + make_interval(days => (${evidenceDaysSql})::int)`, nowDate),
      ),
    );
  return n;
}

/* ================================================================== exclusive run + scheduler */

export type RetentionLockCtx = RetentionCtx & Pick<Ctx, 'database'>;

/**
 * Run retention while holding the cluster-wide advisory lock. Returns null (without running) when
 * another instance holds the lock.
 */
export async function runRetentionExclusive(ctx: RetentionLockCtx, opts: RetentionOptions = {}): Promise<RetentionSummary | null> {
  const client = await ctx.database.pool.connect();
  let locked = false;
  try {
    const res = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [RETENTION_LOCK_KEY]);
    locked = res.rows[0]?.locked === true;
    if (!locked) return null;
    return await runRetention(ctx, opts);
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [RETENTION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

export interface RetentionScheduler {
  /** Run once now (resolves with null when another run/instance holds the lock). */
  runNow(): Promise<RetentionSummary | null>;
  stop(): Promise<void>;
}

/**
 * Start the hourly retention job. Timers are unref'd (they never keep the process alive). Safe to start
 * on every instance: runs are serialised in-process and across instances (advisory lock).
 * Wire it up from app.ts / main.ts: `const retention = startRetentionScheduler(ctx)` and
 * `await retention.stop()` on shutdown.
 */
export function startRetentionScheduler(ctx: RetentionLockCtx, opts: { intervalMs?: number; initialDelayMs?: number } = {}): RetentionScheduler {
  const intervalMs = Math.max(60_000, opts.intervalMs ?? DEFAULT_RETENTION_INTERVAL_MS);
  let running: Promise<RetentionSummary | null> | null = null;
  let stopped = false;

  const runNow = (): Promise<RetentionSummary | null> => {
    if (stopped) return Promise.resolve(null);
    if (running) return running;
    running = runRetentionExclusive(ctx)
      .then((summary) => {
        if (summary && (summary.sessionsEvidencePurged || summary.sessionsEventMetadataPurged || summary.failures.length)) {
          const { sessions: _omit, ...rest } = summary;
          ctx.log.info({ retention: rest }, 'retention run completed');
        }
        return summary;
      })
      .catch((err) => {
        ctx.log.error({ err }, 'retention run failed');
        return null;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };

  const initial = setTimeout(() => void runNow(), Math.max(0, opts.initialDelayMs ?? 60_000));
  initial.unref?.();
  const timer = setInterval(() => void runNow(), intervalMs);
  timer.unref?.();

  return {
    runNow,
    async stop() {
      stopped = true;
      clearTimeout(initial);
      clearInterval(timer);
      if (running) await running;
    },
  };
}

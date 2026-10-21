/**
 * The last run of a cluster-wide background job, persisted in job_status whichever instance ran it (the per-instance
 * Prometheus gauges only know their own runs). The retention job records every real run (services/retention.ts), so
 * staff see that deletion is actually happening (GET /api/admin/retention/preview, /api/admin/ops/checks).
 */
import { RETENTION_STALE_AFTER_MS, type RetentionJobStatusDTO } from '@sp/shared';
import { eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/index.js';
import { jobStatus, type JobStatusRow, type RetentionRunSummary } from '../db/schema.js';

export const RETENTION_JOB = 'retention';

/** A run began (lastStartedAt). */
export async function recordJobStart(db: DbOrTx, name: string, at: number): Promise<void> {
  const when = new Date(at);
  await db
    .insert(jobStatus)
    .values({ name, lastStartedAt: when, updatedAt: when })
    .onConflictDoUpdate({ target: jobStatus.name, set: { lastStartedAt: when, updatedAt: when } });
}

/**
 * A run ended: `error` when it failed as a whole (lastSuccessAt stays at the previous success), otherwise its summary
 * (sessions that could not be purged are counted there; they are retried on the next run).
 */
export async function recordJobFinish(db: DbOrTx, name: string, at: number, result: { error: string } | { summary: RetentionRunSummary }): Promise<void> {
  const when = new Date(at);
  const failed = 'error' in result;
  const set = failed
    ? { lastFinishedAt: when, lastError: result.error.slice(0, 2000), updatedAt: when }
    : { lastFinishedAt: when, lastSuccessAt: when, lastError: null, lastSummary: result.summary, updatedAt: when };
  await db
    .insert(jobStatus)
    .values({ name, ...set })
    .onConflictDoUpdate({ target: jobStatus.name, set: { ...set, lastStartedAt: sql`coalesce(${jobStatus.lastStartedAt}, ${when})` } });
}

export async function loadJobStatus(db: DbOrTx, name: string): Promise<JobStatusRow | null> {
  const [row] = await db.select().from(jobStatus).where(eq(jobStatus.name, name));
  return row ?? null;
}

const ms = (d: Date | null | undefined) => (d ? d.getTime() : null);

/** Stale: no successful run within RETENTION_STALE_AFTER_MS (the job runs hourly), including never. */
export function toRetentionJobStatusDTO(row: JobStatusRow | null, now: number): RetentionJobStatusDTO {
  const lastSuccessAt = ms(row?.lastSuccessAt);
  return {
    lastStartedAt: ms(row?.lastStartedAt),
    lastFinishedAt: ms(row?.lastFinishedAt),
    lastSuccessAt,
    lastError: row?.lastError ?? null,
    lastSummary: row?.lastSummary ?? null,
    stale: lastSuccessAt == null || now - lastSuccessAt > RETENTION_STALE_AFTER_MS,
  };
}

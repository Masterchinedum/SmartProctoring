/**
 * Per-session storage and abuse caps for candidate-driven uploads (config.sessionLimits):
 *  - evidence items / bytes stored for one session (event screenshots, check frames, identity samples);
 *  - checks started per session per rolling hour.
 *
 * Event screenshots may use only EVENT_SCREENSHOT_SHARE of the evidence budget, so a client that floods
 * screenshots can never starve the identity-critical uploads (check frames, identity samples) of space.
 * Mid-exam identity samples are still analysed and decided when the budget is exhausted; only their images
 * are not stored (services/identity-samples.ts) — the identity check itself must never be skippable.
 */
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import type { DbOrTx } from '../db/index.js';
import { checks, evidence } from '../db/schema.js';
import { HttpError } from '../lib/errors.js';

/** Fraction of the per-session evidence budget available to client event screenshots. */
export const EVENT_SCREENSHOT_SHARE = 0.8;

export interface SessionEvidenceUsage {
  items: number;
  bytes: number;
}

export async function sessionEvidenceUsage(db: DbOrTx, sessionId: string): Promise<SessionEvidenceUsage> {
  const [row] = await db
    .select({ items: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(${evidence.byteSize}), 0)::bigint` })
    .from(evidence)
    .where(and(eq(evidence.sessionId, sessionId), isNull(evidence.purgedAt)));
  return { items: Number(row?.items ?? 0), bytes: Number(row?.bytes ?? 0) };
}

/** True when `items` more evidence rows totalling `bytes` fit into the session's budget (times `share`). */
export async function sessionHasEvidenceCapacity(ctx: Pick<Ctx, 'config'>, db: DbOrTx, sessionId: string, add: { items: number; bytes: number }, share = 1): Promise<boolean> {
  const lim = ctx.config.sessionLimits;
  const use = await sessionEvidenceUsage(db, sessionId);
  return use.items + add.items <= Math.floor(lim.maxEvidenceItems * share) && use.bytes + add.bytes <= Math.floor(lim.maxEvidenceBytes * share);
}

/**
 * 413 storage_limit. A 4xx the candidate client treats as permanent (the upload is dropped, not retried).
 */
export function storageLimitError(): HttpError {
  return new HttpError(
    413,
    'storage_limit',
    'The storage limit for this exam session has been reached, so no more images can be stored. Your exam continues; please contact your exam administrator if this keeps happening.',
  );
}

export async function assertSessionEvidenceCapacity(ctx: Pick<Ctx, 'config'>, db: DbOrTx, sessionId: string, add: { items: number; bytes: number }, share = 1): Promise<void> {
  if (!(await sessionHasEvidenceCapacity(ctx, db, sessionId, add, share))) throw storageLimitError();
}

/** 429 too_many_checks once the session started maxChecksPerHour checks within the last hour. */
export async function assertCheckRate(ctx: Pick<Ctx, 'config'>, db: DbOrTx, sessionId: string, now: number): Promise<void> {
  const max = ctx.config.sessionLimits.maxChecksPerHour;
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(checks)
    .where(and(eq(checks.sessionId, sessionId), gte(checks.issuedAt, new Date(now - 3_600_000))));
  if (n >= max) {
    throw new HttpError(429, 'too_many_checks', `Too many camera checks were started for this exam in the last hour (limit ${max}). Please wait a few minutes before trying again, or contact your exam administrator.`);
  }
}

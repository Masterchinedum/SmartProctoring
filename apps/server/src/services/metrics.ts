/**
 * Production detection-quality metrics (GET /api/admin/metrics/detection-quality) and storage of
 * offline evaluation reports produced by the eval CLIs (POST /api/admin/metrics/offline-evaluation).
 *
 * Reviewer decisions are the production precision proxy: for each detector,
 * precision ≈ correct / (correct + false detections) — a reviewer kept the event with a conclusion (every
 * resolution except "inconclusive", or the plain "reviewed" status), or dismissed it as a false detection.
 * Unreviewed and inconclusive events are excluded. Overrides (a reviewer changing another's decision) measure
 * reviewer disagreement.
 */
import {
  EVENT_CATALOG,
  FLAG_CATEGORIES,
  IDENTITY_CHECK_TRIGGERS,
  IDENTITY_DECISIONS,
  type DetectionQualityDTO,
  type EventCategory,
  type EventType,
  type IdentityDecision,
} from '@sp/shared';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { evaluationReports, eventReviews, events, examSessions, identityChecks } from '../db/schema.js';

const zeroDecisions = (): Record<IdentityDecision, number> => Object.fromEntries(IDENTITY_DECISIONS.map((d) => [d, 0])) as Record<IdentityDecision, number>;

export interface OfflineEvaluationEntry {
  id: string;
  kind: string;
  createdAt: number;
  /** true for reports uploaded for all organisations (org_id null, e.g. shipped with a release). */
  global: boolean;
  report: unknown;
}

export async function detectionQuality(ctx: Pick<Ctx, 'db'>, orgId: string, from: number, to: number): Promise<DetectionQualityDTO> {
  const db = ctx.db;
  const range = and(eq(events.orgId, orgId), gte(events.startedAt, new Date(from)), lte(events.startedAt, new Date(to)), inArray(events.category, [...FLAG_CATEGORIES]));
  const [typeRows, resolutionRows, overriddenRows, checkRows, mismatchRows, reviewerRows, offline] = await Promise.all([
    db
      .select({
        type: events.type,
        category: events.category,
        total: sql<number>`count(*)::int`,
        reviewed: sql<number>`count(*) filter (where ${events.reviewStatus} = 'reviewed')::int`,
        dismissed: sql<number>`count(*) filter (where ${events.reviewStatus} = 'dismissed')::int`,
        unreviewed: sql<number>`count(*) filter (where ${events.reviewStatus} = 'unreviewed')::int`,
        inconclusive: sql<number>`count(*) filter (where ${events.reviewStatus} = 'reviewed' and ${events.resolution} = 'inconclusive')::int`,
      })
      .from(events)
      .where(range)
      .groupBy(events.type, events.category),
    db
      .select({ type: events.type, resolution: events.resolution, n: sql<number>`count(*)::int` })
      .from(events)
      .where(and(range, isNotNull(events.resolution)))
      .groupBy(events.type, events.resolution),
    db
      .select({ type: events.type, n: sql<number>`count(distinct ${eventReviews.eventId})::int` })
      .from(eventReviews)
      .innerJoin(events, eq(events.id, eventReviews.eventId))
      .where(and(range, eq(eventReviews.overrides, true)))
      .groupBy(events.type),
    db
      .select({ trigger: identityChecks.trigger, decision: identityChecks.decision, n: sql<number>`count(*)::int` })
      .from(identityChecks)
      .innerJoin(examSessions, eq(examSessions.id, identityChecks.sessionId))
      .where(and(eq(examSessions.orgId, orgId), gte(identityChecks.at, new Date(from)), lte(identityChecks.at, new Date(to))))
      .groupBy(identityChecks.trigger, identityChecks.decision),
    db
      .select({
        dismissed: sql<number>`count(*) filter (where ${events.reviewStatus} = 'dismissed')::int`,
        confirmed: sql<number>`count(*) filter (where ${events.reviewStatus} = 'reviewed' and ${events.resolution} is distinct from 'inconclusive')::int`,
        inconclusive: sql<number>`count(*) filter (where ${events.reviewStatus} = 'reviewed' and ${events.resolution} = 'inconclusive')::int`,
      })
      .from(events)
      .where(and(range, eq(events.type, 'identity_mismatch'))),
    db
      .select({ decisions: sql<number>`count(*)::int`, overrides: sql<number>`count(*) filter (where ${eventReviews.overrides})::int` })
      .from(eventReviews)
      .innerJoin(events, eq(events.id, eventReviews.eventId))
      .where(and(range, sql`${eventReviews.status} <> 'unreviewed'`)),
    latestOfflineEvaluations(ctx, orgId),
  ]);

  // Merge rows of the same type (category is fixed by the catalog, but be tolerant of legacy rows).
  const byTypeMap = new Map<EventType, DetectionQualityDTO['byType'][number]>();
  for (const r of typeRows) {
    const cur = byTypeMap.get(r.type) ?? {
      type: r.type,
      category: (EVENT_CATALOG[r.type]?.category ?? r.category) as EventCategory,
      total: 0,
      reviewed: 0,
      dismissed: 0,
      unreviewed: 0,
      inconclusive: 0,
      byResolution: {},
      overridden: 0,
      precision: null,
    };
    cur.total += r.total;
    cur.reviewed += r.reviewed;
    cur.dismissed += r.dismissed;
    cur.unreviewed += r.unreviewed;
    cur.inconclusive += r.inconclusive;
    byTypeMap.set(r.type, cur);
  }
  for (const r of overriddenRows) {
    const cur = byTypeMap.get(r.type);
    if (cur) cur.overridden += r.n;
  }
  for (const r of resolutionRows) {
    const cur = byTypeMap.get(r.type);
    if (cur && r.resolution) cur.byResolution[r.resolution] = (cur.byResolution[r.resolution] ?? 0) + r.n;
  }
  const catRank: Record<EventCategory, number> = { integrity: 0, uncertain: 1, technical: 2, neutral: 3, exception: 4 };
  const byType = [...byTypeMap.values()]
    .map((t) => ({ ...t, precision: precision(t.reviewed - t.inconclusive, t.dismissed) }))
    .sort((a, b) => catRank[a.category] - catRank[b.category] || b.total - a.total || (a.type < b.type ? -1 : 1));

  const byDecision = zeroDecisions();
  const byTrigger: Record<string, Record<IdentityDecision, number>> = Object.fromEntries(IDENTITY_CHECK_TRIGGERS.map((t) => [t, zeroDecisions()]));
  let checks = 0;
  for (const r of checkRows) {
    checks += r.n;
    if (r.decision in byDecision) byDecision[r.decision] += r.n;
    const t = (byTrigger[r.trigger] ??= zeroDecisions());
    if (r.decision in t) t[r.decision] += r.n;
  }

  return {
    from,
    to,
    byType,
    identity: {
      checks,
      byDecision,
      byTrigger,
      mismatchEventsDismissed: mismatchRows[0]?.dismissed ?? 0,
      mismatchEventsConfirmed: mismatchRows[0]?.confirmed ?? 0,
      mismatchEventsInconclusive: mismatchRows[0]?.inconclusive ?? 0,
    },
    reviewers: {
      decisions: reviewerRows[0]?.decisions ?? 0,
      overrides: reviewerRows[0]?.overrides ?? 0,
      overrideRate: reviewerRows[0]?.decisions ? Math.round((reviewerRows[0].overrides / reviewerRows[0].decisions) * 10_000) / 10_000 : null,
    },
    offlineEvaluation: offline.length ? { reports: offline } : null,
  };
}

/** correct / (correct + false detections), rounded to 4 decimals; null without decisions. */
export function precision(correct: number, falseDetections: number): number | null {
  const n = correct + falseDetections;
  return n === 0 ? null : Math.round((correct / n) * 10_000) / 10_000;
}

/** Latest stored report per kind visible to the organisation (its own uploads and global ones), newest first. */
export async function latestOfflineEvaluations(ctx: Pick<Ctx, 'db'>, orgId: string): Promise<OfflineEvaluationEntry[]> {
  const rows = await ctx.db
    .selectDistinctOn([evaluationReports.kind], { id: evaluationReports.id, kind: evaluationReports.kind, orgId: evaluationReports.orgId, createdAt: evaluationReports.createdAt, report: evaluationReports.report })
    .from(evaluationReports)
    .where(or(eq(evaluationReports.orgId, orgId), isNull(evaluationReports.orgId)))
    .orderBy(evaluationReports.kind, desc(evaluationReports.createdAt), desc(evaluationReports.id));
  return rows
    .map((r) => ({ id: r.id, kind: r.kind, createdAt: r.createdAt.getTime(), global: r.orgId == null, report: r.report }))
    .sort((a, b) => b.createdAt - a.createdAt || (a.kind < b.kind ? -1 : 1));
}

const KIND_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/** Derive a storage kind for an uploaded report: explicit kind, else the report's `tool`/`kind` field. */
export function offlineReportKind(explicit: unknown, report: unknown): string | null {
  const candidates = [explicit, (report as Record<string, unknown> | null)?.kind, (report as Record<string, unknown> | null)?.tool];
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const k = c
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
    if (KIND_RE.test(k)) return k;
  }
  return null;
}

export async function storeOfflineEvaluation(ctx: Pick<Ctx, 'db' | 'now'>, orgId: string, kind: string, report: unknown): Promise<OfflineEvaluationEntry> {
  const [row] = await ctx.db.insert(evaluationReports).values({ orgId, kind, report, createdAt: new Date(ctx.now()) }).returning();
  return { id: row.id, kind: row.kind, createdAt: row.createdAt.getTime(), global: false, report: row.report };
}

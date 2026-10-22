/**
 * Reviewer workflow (shared types and rules: packages/shared/src/review.ts).
 *
 *  - Event decisions: a structured resolution (or a plain status from older clients). Every decision is kept in
 *    event_reviews; changing another reviewer's decision needs a reason and is recorded as an override (reviewer
 *    disagreement). Bulk decisions are limited to technical problems and low-severity observations; an incident's
 *    events (flags close in time, groupIncidents) may be decided together whatever their severity.
 *  - Session review: assignment, escalation and the final outcome (session_reviews), and the service-level target
 *    that applies now — a held exam should be decided within `holdMinutes`, flags within `flagHours`.
 *  - The review queue: sessions on hold, with undecided flags, or with an open / escalated review.
 */
import {
  bulkReviewEligible,
  FLAG_CATEGORIES,
  groupIncidents,
  RESOLUTION_INFO,
  type BulkReviewResultDTO,
  type QueueView,
  type ReviewDecisionDTO,
  type ReviewDueDTO,
  type ReviewResolution,
  type ReviewSlaSettings,
  type ReviewStatus,
  type SessionReviewDTO,
  type SessionReviewSummaryDTO,
} from '@sp/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { StaffPrincipal } from '../auth/staff.js';
import type { DbOrTx } from '../db/index.js';
import { eventReviews, events, sessionReviews, staffUsers, type EventRow, type ExamSession, type SessionReview } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import type { SessionCounts } from './dto.js';

type Staff = Pick<StaffPrincipal, 'id' | 'orgId'> & { ip?: string };

export interface Decision {
  status?: ReviewStatus;
  resolution?: ReviewResolution;
  note?: string | null;
}

export type DecideOutcome =
  | { ok: true; changed: boolean; overrides: boolean }
  | { ok: false; reason: 'resolution_not_applicable' | 'reason_required' | 'unchanged' };

const isFlag = (c: EventRow['category']) => FLAG_CATEGORIES.includes(c);

/**
 * Decide one event (row locked by the caller). Single decisions (`bulk` false) throw for a resolution that does not
 * apply or a missing reason; bulk decisions get the reason back so the caller can report it per event.
 */
export async function decideEvent(tx: DbOrTx, staff: Staff, cur: EventRow, d: Decision, opts: { bulk: boolean; at: number }): Promise<DecideOutcome> {
  const note = d.note?.trim() ? d.note.trim() : null;
  const resolution = d.resolution ?? null;
  if (resolution && !RESOLUTION_INFO[resolution].categories.includes(cur.category)) {
    if (opts.bulk) return { ok: false, reason: 'resolution_not_applicable' };
    throw badRequest(`“${RESOLUTION_INFO[resolution].label}” does not apply to this kind of event`, undefined, 'resolution_not_applicable');
  }
  const status: ReviewStatus = resolution ? RESOLUTION_INFO[resolution].status : d.status!;
  const nextResolution = status === 'unreviewed' ? null : resolution;
  const same = cur.reviewStatus === status && (cur.resolution ?? null) === nextResolution;
  if (same && (cur.reviewNote ?? null) === note) return opts.bulk ? { ok: false, reason: 'unchanged' } : { ok: true, changed: false, overrides: false };
  // Changing a decision another reviewer made is a disagreement: it needs a reason, and bulk decisions never do it.
  const overrides = cur.reviewStatus !== 'unreviewed' && cur.reviewedBy != null && cur.reviewedBy !== staff.id && !same;
  if (overrides && (opts.bulk || !note)) {
    if (opts.bulk) return { ok: false, reason: 'reason_required' };
    throw badRequest('Another reviewer decided this event. Give a reason for changing their decision.', [{ path: 'note', message: 'Required when changing another reviewer’s decision' }], 'reason_required');
  }
  const unreview = status === 'unreviewed';
  await tx
    .update(events)
    .set({ reviewStatus: status, resolution: nextResolution, reviewedBy: unreview ? null : staff.id, reviewedAt: unreview ? null : new Date(opts.at), reviewNote: unreview ? null : note })
    .where(eq(events.id, cur.id));
  await tx.insert(eventReviews).values({
    orgId: cur.orgId,
    eventId: cur.id,
    sessionId: cur.sessionId,
    reviewerId: staff.id,
    status,
    resolution: nextResolution,
    note,
    previousStatus: cur.reviewStatus,
    previousResolution: cur.resolution ?? null,
    previousReviewerId: cur.reviewedBy ?? null,
    overrides,
    bulk: opts.bulk,
    at: new Date(opts.at),
  });
  await audit(tx, {
    orgId: staff.orgId,
    actorType: 'staff',
    actorId: staff.id,
    action: 'event.review',
    targetType: 'event',
    targetId: cur.id,
    meta: {
      sessionId: cur.sessionId,
      type: cur.type,
      from: cur.reviewStatus,
      to: status,
      ...(cur.resolution ? { fromResolution: cur.resolution } : {}),
      ...(nextResolution ? { resolution: nextResolution } : {}),
      note,
      ...(overrides ? { overrides: true, previousReviewerId: cur.reviewedBy } : {}),
      ...(opts.bulk ? { bulk: true } : {}),
    },
    ip: staff.ip,
    at: opts.at,
  });
  return { ok: true, changed: true, overrides };
}

/**
 * One decision for several events of the organisation. Without `incidentId`, events that may not be decided in bulk
 * (bulkReviewEligible) are skipped; with it, only the listed events of that incident are decided (any severity) —
 * the incidents are recomputed here, so a client cannot widen one.
 */
export async function decideEventsBulk(
  tx: DbOrTx,
  staff: Staff,
  req: { eventIds: string[]; resolution: ReviewResolution; note?: string; incidentId?: string },
  now: number,
): Promise<{ result: BulkReviewResultDTO }> {
  const ids = [...new Set(req.eventIds)];
  const rows = await tx
    .select()
    .from(events)
    .where(and(inArray(events.id, ids), eq(events.orgId, staff.orgId)))
    .orderBy(asc(events.id))
    .for('update');
  const byId = new Map(rows.map((r) => [r.id, r]));
  const result: BulkReviewResultDTO = { updated: [], skipped: [] };
  let allowed = new Set<string>(rows.filter((r) => isFlag(r.category) && bulkReviewEligible(r)).map((r) => r.id));
  if (req.incidentId) {
    const [anchor] = await tx
      .select({ sessionId: events.sessionId })
      .from(events)
      .where(and(eq(events.id, req.incidentId), eq(events.orgId, staff.orgId)));
    if (!anchor) throw notFound('Incident not found', 'incident_not_found');
    const all = await tx.select().from(events).where(eq(events.sessionId, anchor.sessionId));
    const inc = groupIncidents(
      all.map((e) => ({ id: e.id, type: e.type, category: e.category, severity: e.severity, startedAt: e.startedAt.getTime(), endedAt: e.endedAt?.getTime() ?? null, review: { status: e.reviewStatus } })),
      { now },
    ).find((i) => i.id === req.incidentId);
    if (!inc) throw notFound('Incident not found', 'incident_not_found');
    allowed = new Set(rows.filter((r) => inc.eventIds.includes(r.id)).map((r) => r.id));
    for (const r of rows) if (!allowed.has(r.id)) result.skipped.push({ id: r.id, reason: 'not_in_incident' });
  }
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) {
      result.skipped.push({ id, reason: 'not_found' });
      continue;
    }
    if (!allowed.has(id)) {
      if (!req.incidentId) result.skipped.push({ id, reason: isFlag(r.category) ? 'not_eligible' : 'resolution_not_applicable' });
      continue;
    }
    const out = await decideEvent(tx, staff, r, { resolution: req.resolution, note: req.note }, { bulk: true, at: now });
    if (out.ok) result.updated.push(id);
    else result.skipped.push({ id, reason: out.reason === 'reason_required' ? 'decided_by_someone_else' : out.reason });
  }
  return { result };
}

export async function loadReviewHistory(db: DbOrTx, eventId: string): Promise<ReviewDecisionDTO[]> {
  const rows = await db
    .select({ r: eventReviews, name: staffUsers.name })
    .from(eventReviews)
    .leftJoin(staffUsers, eq(staffUsers.id, eventReviews.reviewerId))
    .where(eq(eventReviews.eventId, eventId))
    .orderBy(asc(eventReviews.at), asc(eventReviews.seq));
  return rows.map(({ r, name }) => ({
    id: r.id,
    at: r.at.getTime(),
    reviewerId: r.reviewerId,
    reviewerName: r.reviewerId ? (name ?? 'Former staff member') : null,
    status: r.status,
    resolution: r.resolution ?? null,
    note: r.note,
    overrides: r.overrides,
    bulk: r.bulk,
  }));
}

/* ------------------------------------------------------------------ session review */

/** The service-level target that applies now: a held exam's decision first, else the oldest undecided flag. */
export function reviewDue(s: Pick<ExamSession, 'status' | 'holdSince'>, oldestUndecidedAt: number | null, state: SessionReviewSummaryDTO['state'], sla: ReviewSlaSettings, now: number): ReviewDueDTO | null {
  if (s.status === 'on_hold' && s.holdSince) {
    const since = s.holdSince.getTime();
    const dueAt = since + sla.holdMinutes * 60_000;
    return { kind: 'hold', since, dueAt, overdue: now > dueAt };
  }
  if (oldestUndecidedAt != null) {
    const dueAt = oldestUndecidedAt + sla.flagHours * 3_600_000;
    return { kind: 'flags', since: oldestUndecidedAt, dueAt, overdue: now > dueAt };
  }
  void state;
  return null;
}

export function toReviewSummary(
  s: Pick<ExamSession, 'status' | 'holdSince'>,
  counts: Pick<SessionCounts, 'oldestUndecidedAt' | 'undecided' | 'topUndecidedSeverity'> | undefined,
  row: (SessionReview & { assigneeName?: string | null }) | null | undefined,
  sla: ReviewSlaSettings,
  now: number,
): SessionReviewSummaryDTO {
  const state = row?.state ?? 'none';
  return {
    state,
    assignee: row?.assigneeId ? { id: row.assigneeId, name: row.assigneeName ?? 'Former staff member' } : null,
    outcome: row?.outcome ?? null,
    undecided: counts?.undecided ?? { integrity: 0, uncertain: 0, technical: 0 },
    topSeverity: counts?.topUndecidedSeverity ?? null,
    due: reviewDue(s, counts?.oldestUndecidedAt ?? null, state, sla, now),
  };
}

/** Review rows (with the assignee's name) for sessions. */
export async function loadSessionReviewRows(db: DbOrTx, sessionIds: string[]): Promise<Map<string, SessionReview & { assigneeName: string | null }>> {
  if (!sessionIds.length) return new Map();
  const rows = await db
    .select({ r: sessionReviews, assigneeName: staffUsers.name })
    .from(sessionReviews)
    .leftJoin(staffUsers, eq(staffUsers.id, sessionReviews.assigneeId))
    .where(inArray(sessionReviews.sessionId, sessionIds));
  return new Map(rows.map(({ r, assigneeName }) => [r.sessionId, { ...r, assigneeName }]));
}

export async function toSessionReviewDTO(db: DbOrTx, summary: SessionReviewSummaryDTO, row: SessionReview | null | undefined): Promise<SessionReviewDTO> {
  const ids = [row?.escalatedBy, row?.resolvedBy].filter((x): x is string => !!x);
  const people = ids.length ? await db.select({ id: staffUsers.id, name: staffUsers.name }).from(staffUsers).where(inArray(staffUsers.id, ids)) : [];
  const who = (id: string | null | undefined) => (id ? { id, name: people.find((p) => p.id === id)?.name ?? 'Former staff member' } : null);
  return {
    ...summary,
    assignedAt: row?.assignedAt?.getTime() ?? null,
    escalation: row?.escalatedAt ? { at: row.escalatedAt.getTime(), by: who(row.escalatedBy), note: row.escalationNote ?? '' } : null,
    resolution: row?.outcome && row.resolvedAt ? { outcome: row.outcome, note: row.outcomeNote ?? null, at: row.resolvedAt.getTime(), by: who(row.resolvedBy) } : null,
  };
}

/** The session's review row, created (state 'open') when missing; locked for update. */
export async function lockSessionReview(tx: DbOrTx, session: Pick<ExamSession, 'id' | 'orgId'>, now: number): Promise<SessionReview> {
  await tx
    .insert(sessionReviews)
    .values({ sessionId: session.id, orgId: session.orgId, state: 'open', updatedAt: new Date(now) })
    .onConflictDoNothing();
  const [row] = await tx.select().from(sessionReviews).where(eq(sessionReviews.sessionId, session.id)).for('update');
  return row;
}

/** Undecided flags of a session (resolving a review requires none). */
export async function countUndecidedFlags(db: DbOrTx, sessionId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(events)
    .where(and(eq(events.sessionId, sessionId), inArray(events.category, [...FLAG_CATEGORIES]), eq(events.reviewStatus, 'unreviewed')));
  return r?.n ?? 0;
}

/* ------------------------------------------------------------------ queue */

/**
 * Sessions of the organisation that need review work: on hold, with undecided flags, or with an open / escalated
 * review — plus, for the 'resolved' view, the latest resolved reviews. Ordered by the due time (overdue first).
 */
export async function reviewQueueIds(
  db: DbOrTx,
  orgId: string,
  staffId: string,
  q: { view: QueueView; examId?: string; limit: number },
  sla: ReviewSlaSettings,
  now: number,
): Promise<{ ids: string[]; counts: Record<QueueView, number> }> {
  const nowD = new Date(now);
  const holdMs = sla.holdMinutes * 60_000;
  const flagMs = sla.flagHours * 3_600_000;
  const exam = q.examId ? sql`and s.exam_id = ${q.examId}` : sql``;
  const base = sql`
    with flags as (
      select e.session_id, min(e.first_received_at) as oldest, count(*)::int as n
      from events e
      where e.org_id = ${orgId} and e.category in ('integrity', 'uncertain', 'technical') and e.review_status = 'unreviewed'
      group by e.session_id
    ), cand as (
      -- Only sessions that can be in a view, each set found through an index (never a scan of every session).
      select session_id as id from flags
      union select id from exam_sessions where org_id = ${orgId} and status = 'on_hold'
      union select session_id from session_reviews where org_id = ${orgId}
    ), q as (
      select s.id, s.updated_at, r.state, r.assignee_id, r.resolved_at,
        (s.status = 'on_hold' or coalesce(f.n, 0) > 0 or r.state in ('open', 'escalated')) as waiting,
        case
          when s.status = 'on_hold' and s.hold_since is not null then s.hold_since + make_interval(secs => ${holdMs / 1000}::double precision)
          when f.oldest is not null then f.oldest + make_interval(secs => ${flagMs / 1000}::double precision)
        end as due_at
      from cand
      join exam_sessions s on s.id = cand.id
      left join flags f on f.session_id = s.id
      left join session_reviews r on r.session_id = s.id
      where s.org_id = ${orgId} ${exam}
    )`;
  const viewCond = (v: QueueView) => {
    switch (v) {
      case 'mine':
        return sql`waiting and assignee_id = ${staffId}`;
      case 'unassigned':
        return sql`waiting and assignee_id is null`;
      case 'escalated':
        return sql`waiting and state = 'escalated'`;
      case 'overdue':
        return sql`waiting and due_at < ${nowD}`;
      case 'resolved':
        return sql`state = 'resolved' and not waiting`;
      default:
        return sql`waiting`;
    }
  };
  const countRows = await db.execute<Record<QueueView, number>>(sql`${base}
    select
      count(*) filter (where ${viewCond('all')})::int as "all",
      count(*) filter (where ${viewCond('mine')})::int as "mine",
      count(*) filter (where ${viewCond('unassigned')})::int as "unassigned",
      count(*) filter (where ${viewCond('escalated')})::int as "escalated",
      count(*) filter (where ${viewCond('overdue')})::int as "overdue",
      count(*) filter (where ${viewCond('resolved')})::int as "resolved"
    from q`);
  const order = q.view === 'resolved' ? sql`resolved_at desc nulls last, id` : sql`due_at asc nulls last, (state = 'escalated') desc, updated_at desc, id`;
  const idRows = await db.execute<{ id: string }>(sql`${base} select id from q where ${viewCond(q.view)} order by ${order} limit ${q.limit}`);
  const c = countRows.rows[0] ?? ({} as Record<QueueView, number>);
  return {
    ids: idRows.rows.map((r) => r.id),
    counts: { all: c.all ?? 0, mine: c.mine ?? 0, unassigned: c.unassigned ?? 0, escalated: c.escalated ?? 0, overdue: c.overdue ?? 0, resolved: c.resolved ?? 0 },
  };
}

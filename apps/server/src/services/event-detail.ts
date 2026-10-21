/**
 * An event with what a reviewer needs to decide it (EventDetailDTO): the explanation (built from the session's
 * frozen exam rules, its other events and its accommodations — packages/shared/src/explain.ts), the decision
 * history, and the incident it belongs to.
 */
import { explainEvent, groupIncidents, incidentOf, type EventDetailDTO, type ExplainEventInput, type ExplainContext } from '@sp/shared';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import type { DbOrTx } from '../db/index.js';
import { events, examSessions, exams, organizations, type EventRow, type ExamSession } from '../db/schema.js';
import { loadEventDTO } from './dto.js';
import { loadReviewHistory } from './review.js';
import { effectivePolicy } from './session-state.js';

export function toExplainInput(e: Pick<EventRow, 'id' | 'type' | 'category' | 'severity' | 'startedAt' | 'endedAt' | 'confidence' | 'details' | 'context' | 'deliveredLate'>): ExplainEventInput {
  const startedAt = e.startedAt.getTime();
  const endedAt = e.endedAt?.getTime() ?? null;
  return {
    id: e.id,
    type: e.type,
    category: e.category,
    severity: e.severity,
    startedAt,
    endedAt,
    durationMs: endedAt != null ? Math.max(0, endedAt - startedAt) : null,
    confidence: e.confidence ?? null,
    details: e.details ?? {},
    context: e.context ?? {},
    deliveredLate: e.deliveredLate,
  };
}

/** Everything explainEvent needs about a session: its rules, events and accommodations. */
export async function explainContextFor(db: DbOrTx, session: ExamSession, now: number): Promise<{ ctx: ExplainContext; rows: EventRow[] }> {
  const [exam] = await db.select().from(exams).where(eq(exams.id, session.examId));
  const [org] = await db.select().from(organizations).where(eq(organizations.id, session.orgId));
  const rows = await db.select().from(events).where(eq(events.sessionId, session.id));
  const policy = exam ? effectivePolicy(session, exam, org ?? null) : null;
  return {
    rows,
    ctx: {
      policy,
      events: rows.map(toExplainInput),
      accommodations: (session.accommodations?.items ?? []).map((i) => ({ kind: i.kind, params: (i.params ?? {}) as Record<string, unknown> })),
      now,
    },
  };
}

export async function loadEventDetail(ctx: Pick<Ctx, 'db' | 'now'>, eventId: string): Promise<EventDetailDTO | null> {
  const dto = await loadEventDTO(ctx.db, eventId);
  if (!dto) return null;
  const [session] = await ctx.db.select().from(examSessions).where(eq(examSessions.id, dto.sessionId));
  const now = ctx.now();
  const { ctx: explainCtx, rows } = await explainContextFor(ctx.db, session, now);
  const self = rows.find((r) => r.id === eventId);
  const incidents = groupIncidents(
    rows.map((r) => ({ id: r.id, type: r.type, category: r.category, severity: r.severity, startedAt: r.startedAt.getTime(), endedAt: r.endedAt?.getTime() ?? null, review: { status: r.reviewStatus } })),
    { now },
  );
  return {
    ...dto,
    explanation: explainEvent(self ? toExplainInput(self) : { ...dto, deliveredLate: dto.deliveredLate }, explainCtx),
    history: await loadReviewHistory(ctx.db, eventId),
    incident: incidentOf(incidents, eventId),
  };
}

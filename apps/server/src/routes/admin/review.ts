/**
 * Staff API — review queue and the review of a session as a whole (services/review.ts).
 *
 *   GET  /review-queue?view=&examId=&limit=          -> ReviewQueueDTO      [reviewer]
 *   POST /sessions/:id/review/assign {assigneeId}    -> SessionReviewDTO    [reviewer: self / unassign self; admin: anyone]
 *   POST /sessions/:id/review/escalate {note}        -> SessionReviewDTO    [reviewer]
 *   POST /sessions/:id/review/resolve {outcome,note?} -> SessionReviewDTO   [reviewer; an escalated review: admin]
 *   POST /sessions/:id/review/reopen {note}          -> SessionReviewDTO    [reviewer]
 *
 * Resolving needs the exam to have ended and every flag to be decided; it records a neutral "Review completed"
 * timeline entry with the outcome (→ `session.reviewed` webhook, outcome only). Every change is audit-logged.
 */
import {
  assignReviewSchema,
  escalateReviewSchema,
  reopenReviewSchema,
  resolveReviewSchema,
  reviewQueueQuerySchema,
  SESSION_OUTCOME_INFO,
  TERMINAL_STATUSES,
  type ReviewQueueDTO,
  type SessionReviewDTO,
} from '@sp/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { getStaff, requireStaff, roleAtLeast, type StaffPrincipal } from '../../auth/staff.js';
import type { Ctx } from '../../context.js';
import { examSessions, sessionReviews, staffUsers } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { conflict, forbidden, notFound, validationFailed } from '../../lib/errors.js';
import { loadSessionSummaries } from '../../services/dto.js';
import { orgSettings } from '../../services/org.js';
import { countUndecidedFlags, loadSessionReviewRows, lockSessionReview, reviewQueueIds, toSessionReviewDTO } from '../../services/review.js';
import { withSession } from '../../services/session-state.js';
import { blankToUndefined, idParam, loadOrgRow } from './common.js';

async function sessionReviewDTO(ctx: Ctx, orgId: string, sessionId: string): Promise<SessionReviewDTO> {
  const [summary] = await loadSessionSummaries(ctx, ctx.db, { orgId, sessionIds: [sessionId] });
  if (!summary) throw notFound('Session not found', 'session_not_found');
  const rows = await loadSessionReviewRows(ctx.db, [sessionId]);
  return toSessionReviewDTO(ctx.db, summary.review!, rows.get(sessionId));
}

export const reviewRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const reviewer = { preHandler: requireStaff('reviewer') };

  const scopedSession = async (staff: StaffPrincipal, id: string) => {
    const [s] = await ctx.db
      .select()
      .from(examSessions)
      .where(and(eq(examSessions.id, id), eq(examSessions.orgId, staff.orgId)));
    if (!s) throw notFound('Session not found', 'session_not_found');
    return s;
  };
  const auditReview = (tx: Parameters<typeof audit>[0], staff: StaffPrincipal, action: string, sessionId: string, meta: Record<string, unknown>, ip: string, at: number) =>
    audit(tx, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action, targetType: 'session', targetId: sessionId, meta, ip, at });

  app.get('/review-queue', reviewer, async (req): Promise<ReviewQueueDTO> => {
    const staff = getStaff(req);
    const q = reviewQueueQuerySchema.parse(blankToUndefined(req.query));
    const sla = orgSettings(await loadOrgRow(ctx, staff.orgId)).reviewSla;
    const { ids, counts } = await reviewQueueIds(ctx.db, staff.orgId, staff.id, q, sla, ctx.now());
    const summaries = await loadSessionSummaries(ctx, ctx.db, { orgId: staff.orgId, sessionIds: ids });
    const byId = new Map(summaries.map((s) => [s.id, s]));
    return { items: ids.map((id) => byId.get(id)!).filter(Boolean), counts, sla };
  });

  app.post('/sessions/:id/review/assign', reviewer, async (req): Promise<SessionReviewDTO> => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Session', 'session_not_found');
    const body = assignReviewSchema.parse(req.body ?? {});
    const session = await scopedSession(staff, id);
    const isAdmin = roleAtLeast(staff.role, 'admin');
    if (body.assigneeId && body.assigneeId !== staff.id && !isAdmin) throw forbidden('Reviewers can only assign reviews to themselves', 'assign_self_only');
    if (body.assigneeId) {
      const [u] = await ctx.db
        .select({ id: staffUsers.id, disabled: staffUsers.disabled })
        .from(staffUsers)
        .where(and(eq(staffUsers.id, body.assigneeId), eq(staffUsers.orgId, staff.orgId)));
      if (!u) throw notFound('User not found', 'user_not_found');
      if (u.disabled) throw conflict('user_disabled', 'This user is disabled');
    }
    const now = ctx.now();
    await ctx.db.transaction(async (tx) => {
      const row = await lockSessionReview(tx, session, now);
      if (row.state === 'resolved') throw conflict('review_resolved', 'The review is resolved. Reopen it first.');
      if (!body.assigneeId && row.assigneeId && row.assigneeId !== staff.id && !isAdmin) throw forbidden('Only an administrator can unassign someone else', 'assign_self_only');
      if ((row.assigneeId ?? null) === body.assigneeId) return;
      await tx
        .update(sessionReviews)
        .set({ assigneeId: body.assigneeId, assignedAt: body.assigneeId ? new Date(now) : null, assignedBy: body.assigneeId ? staff.id : null, updatedAt: new Date(now) })
        .where(eq(sessionReviews.sessionId, id));
      await auditReview(tx, staff, 'review.assigned', id, { from: row.assigneeId ?? null, to: body.assigneeId }, req.ip, now);
    });
    ctx.live.sessionChanged(id, { orgId: staff.orgId });
    return sessionReviewDTO(ctx, staff.orgId, id);
  });

  app.post('/sessions/:id/review/escalate', reviewer, async (req): Promise<SessionReviewDTO> => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Session', 'session_not_found');
    const body = escalateReviewSchema.parse(req.body ?? {});
    const session = await scopedSession(staff, id);
    const now = ctx.now();
    await ctx.db.transaction(async (tx) => {
      const row = await lockSessionReview(tx, session, now);
      if (row.state === 'resolved') throw conflict('review_resolved', 'The review is resolved. Reopen it first.');
      await tx
        .update(sessionReviews)
        .set({ state: 'escalated', escalatedAt: new Date(now), escalatedBy: staff.id, escalationNote: body.note, updatedAt: new Date(now) })
        .where(eq(sessionReviews.sessionId, id));
      await auditReview(tx, staff, 'review.escalated', id, { note: body.note }, req.ip, now);
    });
    ctx.live.sessionChanged(id, { orgId: staff.orgId });
    return sessionReviewDTO(ctx, staff.orgId, id);
  });

  app.post('/sessions/:id/review/resolve', reviewer, async (req): Promise<SessionReviewDTO> => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Session', 'session_not_found');
    const body = resolveReviewSchema.parse(req.body ?? {});
    const note = body.note?.trim() || null;
    if (body.outcome !== 'no_concerns' && !note) throw validationFailed('Say why', [{ path: 'note', message: `A note is required for “${SESSION_OUTCOME_INFO[body.outcome].label}”` }]);
    await scopedSession(staff, id);
    await withSession(ctx, id, async (m) => {
      if (m.session.orgId !== staff.orgId) throw notFound('Session not found', 'session_not_found');
      if (!TERMINAL_STATUSES.includes(m.session.status)) throw conflict('session_in_progress', 'The exam has not ended yet. Resolve the review once it has ended.');
      const undecided = await countUndecidedFlags(m.tx, id);
      if (undecided > 0) throw conflict('undecided_flags', `${undecided} flag${undecided === 1 ? ' is' : 's are'} not decided yet. Decide every flag first.`, { undecided });
      const row = await lockSessionReview(m.tx, m.session, m.now);
      if (row.state === 'resolved') throw conflict('review_resolved', 'The review is already resolved. Reopen it to change the outcome.');
      if (row.state === 'escalated' && !roleAtLeast(staff.role, 'admin')) throw forbidden('An escalated review is resolved by an administrator', 'escalated_admin_only');
      await m.tx
        .update(sessionReviews)
        .set({ state: 'resolved', outcome: body.outcome, outcomeNote: note, resolvedAt: new Date(m.now), resolvedBy: staff.id, updatedAt: new Date(m.now) })
        .where(eq(sessionReviews.sessionId, id));
      await m.addEvent({
        type: 'review_completed',
        source: 'staff',
        observation: `Staff completed the review of this exam: ${SESSION_OUTCOME_INFO[body.outcome].label.toLowerCase()}.`,
        details: { outcome: body.outcome, note, by: staff.id, escalated: row.state === 'escalated' },
      });
      await auditReview(m.tx, staff, 'review.resolved', id, { outcome: body.outcome, note, escalated: row.state === 'escalated' }, req.ip, m.now);
    });
    return sessionReviewDTO(ctx, staff.orgId, id);
  });

  app.post('/sessions/:id/review/reopen', reviewer, async (req): Promise<SessionReviewDTO> => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Session', 'session_not_found');
    const body = reopenReviewSchema.parse(req.body ?? {});
    await scopedSession(staff, id);
    await withSession(ctx, id, async (m) => {
      if (m.session.orgId !== staff.orgId) throw notFound('Session not found', 'session_not_found');
      const row = await lockSessionReview(m.tx, m.session, m.now);
      if (row.state !== 'resolved') throw conflict('review_not_resolved', 'The review is not resolved.');
      await m.tx
        .update(sessionReviews)
        // Back to an open review (an earlier escalation stays in the audit log).
        .set({ state: 'open', outcome: null, outcomeNote: null, resolvedAt: null, resolvedBy: null, escalatedAt: null, escalatedBy: null, escalationNote: null, updatedAt: new Date(m.now) })
        .where(eq(sessionReviews.sessionId, id));
      await m.addEvent({ type: 'review_reopened', source: 'staff', details: { previousOutcome: row.outcome, note: body.note, by: staff.id } });
      await auditReview(m.tx, staff, 'review.reopened', id, { previousOutcome: row.outcome, note: body.note }, req.ip, m.now);
    });
    return sessionReviewDTO(ctx, staff.orgId, id);
  });
};

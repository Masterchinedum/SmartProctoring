/**
 * Staff API — dashboard and sessions.
 *
 *   GET  /dashboard                                   -> DashboardDTO                               [reviewer]
 *   GET  /sessions?status=&examId=&q=&connection=&limit=&offset= -> Paged<SessionSummaryDTO>      [reviewer]
 *   GET  /sessions/:id                                -> SessionDetailDTO                           [reviewer]
 *   GET  /sessions/:id/events?category=&type=&severity=&review=&since= -> { items: EventDTO[] }   [reviewer]
 *   GET  /sessions/:id/events.csv                     -> text/csv                                   [reviewer]
 *   GET  /sessions/:id/timeline                       -> { items: TimelineItemDTO[] }               [reviewer]
 *   GET  /sessions/:id/report?tz=                     -> SessionReportDTO                           [reviewer]
 *   POST /sessions/:id/notes {text}                   -> NoteDTO                                    [reviewer]
 *   POST /sessions/:id/pause-requests/:requestId/decision {approve,note?} -> SessionSummaryDTO     [reviewer]
 *   POST /sessions/:id/hold {note?}                   -> SessionSummaryDTO                          [reviewer]
 *   POST /sessions/:id/release {note?,requireCheck,reEnroll} -> SessionSummaryDTO                   [reviewer]
 *   POST /sessions/:id/terminate {reason}             -> SessionSummaryDTO                          [admin]
 *   POST /sessions/:id/submit {note?}                 -> SessionSummaryDTO                          [admin]
 *   POST /sessions/:id/legal-hold {enabled}           -> SessionSummaryDTO                          [admin]
 *   POST /sessions/:id/regenerate-link                -> { accessLink }                             [admin]
 *   POST /sessions/:id/extend {minutes,note?}         -> SessionSummaryDTO                          [admin]
 *
 * All lifecycle changes go through services/session-actions.ts (row lock, events, periods, audit,
 * candidate commands, realtime).
 */
import {
  extendTimeSchema,
  holdRequestSchema,
  legalHoldSchema,
  noteRequestSchema,
  pauseDecisionSchema,
  releaseRequestSchema,
  SESSION_STATUSES,
  staffSubmitSchema,
  terminateRequestSchema,
  TERMINAL_STATUSES,
  type ConnectionStatus,
  type DashboardDTO,
  type Paged,
  type SessionDetailDTO,
  type SessionStatus,
  type SessionSummaryDTO,
} from '@sp/shared';
import { and, desc, eq, gte, ilike, inArray, isNotNull, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getStaff, requireStaff, roleAtLeast } from '../../auth/staff.js';
import { candidates, events, examSessions, exams, notes, pauseRequests } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { notFound, validationFailed } from '../../lib/errors.js';
import {
  loadDeviceRecordDTOs,
  loadIdentityCheckDTOs,
  loadIdentityReferenceDTOs,
  loadNoteDTOs,
  loadPauseRequestDTOs,
  loadPeriodDTOs,
  loadSessionSummaries,
  ms,
  toHoldDTO,
  toNoteDTO,
  toPauseRequestDTO,
} from '../../services/dto.js';
import { buildSessionReport } from '../../services/reports.js';
import { eventsToCsv } from '../../services/reports-csv.js';
import { resolveTimeZone } from '../../services/reports-format.js';
import { loadOrderedSessionEvents, loadSessionTimeline } from '../../services/reports-timeline.js';
import {
  decidePauseRequest,
  extendSessionTime,
  holdSession,
  regenerateAccessLink,
  releaseHold,
  setLegalHold,
  staffSubmit,
  terminateSession,
} from '../../services/session-actions.js';
import { effectivePolicy } from '../../services/session-state.js';
import { actorOf, assertSessionInOrg, blankToUndefined, escapeLike, idParam, isUuid, listParam, loadOrgRow, loadScopedSession, noStore, pagingSchema } from './common.js';
import { eventFilterConds, loadLiveEvents } from './events.js';

const DAY_MS = 24 * 3600_000;
/** Safety cap on the dashboard session list (non-terminal + ended in the last 24 h). */
export const DASHBOARD_SESSION_LIMIT = 2000;
export const DASHBOARD_EVENT_LIMIT = 100;

const CONNECTIONS: ConnectionStatus[] = ['online', 'offline', 'never_connected'];

const listQuerySchema = pagingSchema.extend({
  status: z.string().optional(),
  examId: z.string().optional(),
  q: z.string().max(200).optional(),
  connection: z.string().optional(),
});

/** Build the WHERE conditions for the session list (org scoping is added by loadSessionSummaries). */
function sessionListConds(q: z.infer<typeof listQuerySchema>): SQL[] {
  const conds: SQL[] = [];
  const statuses = listParam(q.status);
  if (statuses.length) {
    const bad = statuses.filter((s) => !(SESSION_STATUSES as readonly string[]).includes(s));
    if (bad.length) throw validationFailed('Unknown status filter', [{ path: 'status', message: `Unknown status: ${bad.join(', ')}` }]);
    conds.push(inArray(examSessions.status, statuses as SessionStatus[]));
  }
  if (q.examId) {
    if (!isUuid(q.examId)) throw validationFailed('Invalid exam id', [{ path: 'examId', message: 'Must be an exam id' }]);
    conds.push(eq(examSessions.examId, q.examId));
  }
  const connections = listParam(q.connection);
  if (connections.length) {
    const bad = connections.filter((c) => !(CONNECTIONS as string[]).includes(c));
    if (bad.length) throw validationFailed('Unknown connection filter', [{ path: 'connection', message: `Unknown connection: ${bad.join(', ')}` }]);
    conds.push(inArray(examSessions.connection, connections as ConnectionStatus[]));
  }
  const text = q.q?.trim();
  if (text) {
    const like = `%${escapeLike(text)}%`;
    conds.push(or(ilike(candidates.name, like), ilike(candidates.email, like), ilike(candidates.externalId, like), ilike(exams.title, like))!);
  }
  return conds;
}

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const reviewer = { preHandler: requireStaff('reviewer') };
  const admin = { preHandler: requireStaff('admin') };

  /* ------------------------------------------------------------------ dashboard */

  app.get('/dashboard', reviewer, async (req): Promise<DashboardDTO> => {
    const staff = getStaff(req);
    const now = ctx.now();
    const [sessions, recentEvents, pendingRows, holdRows] = await Promise.all([
      loadSessionSummaries(ctx, ctx.db, {
        orgId: staff.orgId,
        where: or(notInArray(examSessions.status, TERMINAL_STATUSES), gte(examSessions.endedAt, new Date(now - DAY_MS)))!,
        orderBy: [desc(examSessions.updatedAt), desc(examSessions.id)],
        limit: DASHBOARD_SESSION_LIMIT,
      }),
      loadLiveEvents(ctx.db, staff.orgId, [ne(events.category, 'neutral')], DASHBOARD_EVENT_LIMIT),
      ctx.db
        .select({ request: pauseRequests, sessionId: examSessions.id, candidateName: candidates.name, examTitle: exams.title })
        .from(pauseRequests)
        .innerJoin(examSessions, eq(examSessions.id, pauseRequests.sessionId))
        .innerJoin(candidates, eq(candidates.id, examSessions.candidateId))
        .innerJoin(exams, eq(exams.id, examSessions.examId))
        .where(and(eq(examSessions.orgId, staff.orgId), eq(pauseRequests.status, 'pending'), notInArray(examSessions.status, TERMINAL_STATUSES)))
        .orderBy(pauseRequests.requestedAt),
      ctx.db
        .select({ session: examSessions, candidateName: candidates.name, examTitle: exams.title })
        .from(examSessions)
        .innerJoin(candidates, eq(candidates.id, examSessions.candidateId))
        .innerJoin(exams, eq(exams.id, examSessions.examId))
        .where(and(eq(examSessions.orgId, staff.orgId), eq(examSessions.status, 'on_hold'), isNotNull(examSessions.holdReason)))
        .orderBy(examSessions.holdSince),
    ]);
    return {
      serverTime: now,
      sessions,
      recentEvents,
      pending: {
        pauseRequests: pendingRows.map((r) => ({ sessionId: r.sessionId, candidateName: r.candidateName, examTitle: r.examTitle, request: toPauseRequestDTO(r.request) })),
        holds: holdRows.flatMap((r) => {
          const hold = toHoldDTO(r.session);
          return hold ? [{ sessionId: r.session.id, candidateName: r.candidateName, examTitle: r.examTitle, hold }] : [];
        }),
      },
    };
  });

  /* ------------------------------------------------------------------ list & detail */

  app.get('/sessions', reviewer, async (req): Promise<Paged<SessionSummaryDTO>> => {
    const staff = getStaff(req);
    const q = listQuerySchema.parse(blankToUndefined(req.query));
    const conds = sessionListConds(q);
    const where = conds.length ? and(...conds) : undefined;
    const [[{ total }], items] = await Promise.all([
      ctx.db
        .select({ total: sql<number>`count(*)::int` })
        .from(examSessions)
        .innerJoin(exams, eq(exams.id, examSessions.examId))
        .innerJoin(candidates, eq(candidates.id, examSessions.candidateId))
        .where(and(eq(examSessions.orgId, staff.orgId), where)),
      loadSessionSummaries(ctx, ctx.db, { orgId: staff.orgId, where, limit: q.limit, offset: q.offset, orderBy: [desc(examSessions.createdAt), desc(examSessions.id)] }),
    ]);
    return { items, total };
  });

  app.get('/sessions/:id', reviewer, async (req): Promise<SessionDetailDTO> => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Session', 'session_not_found');
    const { session, exam } = await loadScopedSession(ctx.db, staff.orgId, id);
    const org = await loadOrgRow(ctx, staff.orgId);
    const [[summary], periods, identityChecks, references, pauseReqs, noteList, devices] = await Promise.all([
      // The access link (a bearer credential) only for admins, only on this explicit detail response.
      loadSessionSummaries(ctx, ctx.db, { orgId: staff.orgId, sessionIds: [id], includeAccessLink: roleAtLeast(staff.role, 'admin') }),
      loadPeriodDTOs(ctx.db, id),
      loadIdentityCheckDTOs(ctx.db, id),
      loadIdentityReferenceDTOs(ctx.db, id),
      loadPauseRequestDTOs(ctx.db, id),
      loadNoteDTOs(ctx.db, { sessionId: id }),
      loadDeviceRecordDTOs(ctx.db, id),
    ]);
    if (!summary) throw notFound('Session not found', 'session_not_found');
    return {
      summary,
      policy: effectivePolicy(session, exam, org),
      periods,
      identityChecks,
      references,
      pauseRequests: pauseReqs,
      notes: noteList,
      devices,
      consent: { acceptedAt: ms(session.consentAcceptedAt), noticeVersion: session.consentNoticeVersion ?? null },
      score: session.score ? { points: session.score.points, maxPoints: session.score.maxPoints, autoGraded: session.score.autoGraded } : null,
    };
  });

  /* ------------------------------------------------------------------ events, CSV, timeline, report */

  app.get('/sessions/:id/events', reviewer, async (req) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Session', 'session_not_found');
    await assertSessionInOrg(ctx.db, staff.orgId, id);
    const conds = eventFilterConds(req.query);
    if (conds === null) return { items: [] };
    return { items: await loadOrderedSessionEvents(ctx.db, id, ...conds) };
  });

  app.get('/sessions/:id/events.csv', reviewer, async (req, reply) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Session', 'session_not_found');
    await assertSessionInOrg(ctx.db, staff.orgId, id);
    const conds = eventFilterConds(req.query);
    const list = conds === null ? [] : await loadOrderedSessionEvents(ctx.db, id, ...conds);
    await audit(ctx.db, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'session.events_exported', targetType: 'session', targetId: id, meta: { rows: list.length }, ip: req.ip, at: ctx.now() });
    noStore(reply)
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="session-${id}-events.csv"`);
    return reply.send(eventsToCsv(list));
  });

  app.get('/sessions/:id/timeline', reviewer, async (req) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Session', 'session_not_found');
    await assertSessionInOrg(ctx.db, staff.orgId, id);
    const { items } = await loadSessionTimeline(ctx.db, id);
    return { items };
  });

  app.get('/sessions/:id/report', reviewer, async (req) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Session', 'session_not_found');
    const tz = resolveTimeZone((req.query as Record<string, unknown> | undefined)?.tz);
    return buildSessionReport(ctx, id, staff.orgId, { timeZone: tz });
  });

  /* ------------------------------------------------------------------ notes */

  app.post('/sessions/:id/notes', reviewer, async (req) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Session', 'session_not_found');
    const body = noteRequestSchema.parse(req.body ?? {});
    const text = body.text.trim();
    if (!text) throw validationFailed('The note is empty', [{ path: 'text', message: 'Enter some text' }]);
    await assertSessionInOrg(ctx.db, staff.orgId, id);
    const now = ctx.now();
    const note = await ctx.db.transaction(async (tx) => {
      const [n] = await tx.insert(notes).values({ sessionId: id, eventId: null, authorId: staff.id, text, createdAt: new Date(now) }).returning();
      await audit(tx, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'note.created', targetType: 'session', targetId: id, meta: { noteId: n.id }, ip: req.ip, at: now });
      return n;
    });
    const dto = toNoteDTO(note, staff.name);
    // Other staff watching the session see the note without reloading (the session summary refreshes too).
    ctx.live.sessionNote(id, dto);
    return dto;
  });

  /* ------------------------------------------------------------------ lifecycle actions */

  app.post('/sessions/:id/pause-requests/:requestId/decision', reviewer, async (req) => {
    const id = idParam(req, 'id', 'Session', 'session_not_found');
    const requestId = idParam(req, 'requestId', 'Pause request', 'pause_request_not_found');
    const body = pauseDecisionSchema.parse(req.body ?? {});
    return decidePauseRequest(ctx, id, requestId, body.approve, actorOf(req), body.note ?? null);
  });

  app.post('/sessions/:id/hold', reviewer, async (req) => {
    const id = idParam(req, 'id', 'Session', 'session_not_found');
    const body = holdRequestSchema.parse(req.body ?? {});
    return holdSession(ctx, id, actorOf(req), body.note ?? null);
  });

  app.post('/sessions/:id/release', reviewer, async (req) => {
    const id = idParam(req, 'id', 'Session', 'session_not_found');
    const body = releaseRequestSchema.parse(req.body ?? {});
    return releaseHold(ctx, id, actorOf(req), { note: body.note ?? null, requireCheck: body.requireCheck, reEnroll: body.reEnroll });
  });

  app.post('/sessions/:id/terminate', admin, async (req) => {
    const id = idParam(req, 'id', 'Session', 'session_not_found');
    const body = terminateRequestSchema.parse(req.body ?? {});
    return terminateSession(ctx, id, actorOf(req), body.reason.trim());
  });

  app.post('/sessions/:id/submit', admin, async (req) => {
    const id = idParam(req, 'id', 'Session', 'session_not_found');
    const body = staffSubmitSchema.parse(req.body ?? {});
    return staffSubmit(ctx, id, actorOf(req), body.note ?? null);
  });

  app.post('/sessions/:id/legal-hold', admin, async (req) => {
    const id = idParam(req, 'id', 'Session', 'session_not_found');
    const body = legalHoldSchema.parse(req.body ?? {});
    return setLegalHold(ctx, id, body.enabled, actorOf(req));
  });

  app.post('/sessions/:id/regenerate-link', admin, async (req) => {
    const id = idParam(req, 'id', 'Session', 'session_not_found');
    return regenerateAccessLink(ctx, id, actorOf(req));
  });

  app.post('/sessions/:id/extend', admin, async (req) => {
    const id = idParam(req, 'id', 'Session', 'session_not_found');
    const body = extendTimeSchema.parse(req.body ?? {});
    return extendSessionTime(ctx, id, body.minutes, actorOf(req), body.note ?? null);
  });
};

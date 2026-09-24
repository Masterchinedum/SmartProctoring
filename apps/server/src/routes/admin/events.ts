/**
 * Staff API — events: org-wide feed, single event, review decisions and event notes.
 *
 *   GET  /events?category=&severity=&review=&type=&since=&limit=  -> { items: LiveEventDTO[] }   [reviewer]
 *   GET  /events/:id                                               -> EventDTO                    [reviewer]
 *   POST /events/:id/review {status,note?}                         -> EventDTO                    [reviewer]
 *   GET  /events/:id/notes                                         -> { items: NoteDTO[] }        [reviewer]
 *   POST /events/:id/notes {text}                                  -> NoteDTO                     [reviewer]
 */
import { EVENT_TYPES, eventFilterSchema, noteRequestSchema, reviewRequestSchema, type EventType, type LiveEventDTO } from '@sp/shared';
import { and, desc, eq, gte, inArray, ne, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getStaff, requireStaff } from '../../auth/staff.js';
import type { Ctx } from '../../context.js';
import type { DbOrTx } from '../../db/index.js';
import { candidates, events, examSessions, exams, notes, type EventRow } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { notFound, validationFailed } from '../../lib/errors.js';
import { eventRowsToDTOs, loadEventDTO, loadNoteDTOs, toNoteDTO } from '../../services/dto.js';
import { blankToUndefined, idParam, listParam } from './common.js';

const feedQuerySchema = eventFilterSchema.extend({ limit: z.coerce.number().int().min(1).max(500).default(100) });

/** Parse the shared event filters into SQL conditions (null = a filter that can match nothing). */
export function eventFilterConds(query: unknown): SQL[] | null {
  const f = eventFilterSchema.parse(blankToUndefined(query));
  const conds: SQL[] = [];
  if (f.category) conds.push(eq(events.category, f.category));
  if (f.severity) conds.push(eq(events.severity, f.severity));
  if (f.review) conds.push(eq(events.reviewStatus, f.review));
  if (f.since != null && Number.isFinite(f.since)) conds.push(gte(events.receivedAt, new Date(f.since)));
  if (f.type) {
    const types = listParam(f.type).filter((t): t is EventType => (EVENT_TYPES as readonly string[]).includes(t));
    if (types.length === 0) return null;
    conds.push(inArray(events.type, types));
  }
  return conds;
}

/**
 * Events with candidate name and exam title (LiveEventDTO), newest arrivals first (the order the live feed
 * uses: a late-delivered event appears when it arrives, with its original timestamps).
 */
export async function loadLiveEvents(db: DbOrTx, orgId: string, conds: SQL[], limit: number): Promise<LiveEventDTO[]> {
  const rows = await db
    .select({ event: events, candidateName: candidates.name, examTitle: exams.title })
    .from(events)
    .innerJoin(examSessions, eq(examSessions.id, events.sessionId))
    .innerJoin(candidates, eq(candidates.id, examSessions.candidateId))
    .innerJoin(exams, eq(exams.id, examSessions.examId))
    .where(and(eq(events.orgId, orgId), eq(examSessions.orgId, orgId), ...conds))
    .orderBy(desc(events.firstReceivedAt), desc(events.startedAt), desc(events.id))
    .limit(limit);
  const dtos = await eventRowsToDTOs(
    db,
    rows.map((r) => r.event),
  );
  return dtos.map((d, i) => ({ ...d, candidateName: rows[i].candidateName, examTitle: rows[i].examTitle }));
}

/** An event of the staff member's organisation (404 otherwise). */
export async function loadScopedEvent(db: DbOrTx, orgId: string, eventId: string): Promise<EventRow> {
  const [ev] = await db
    .select()
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.orgId, orgId)));
  if (!ev) throw notFound('Event not found', 'event_not_found');
  return ev;
}

async function eventDTO(ctx: Ctx, eventId: string) {
  const dto = await loadEventDTO(ctx.db, eventId);
  if (!dto) throw notFound('Event not found', 'event_not_found');
  return dto;
}

export const eventRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const reviewer = { preHandler: requireStaff('reviewer') };

  app.get('/events', reviewer, async (req) => {
    const staff = getStaff(req);
    const q = feedQuerySchema.parse(blankToUndefined(req.query));
    const conds = eventFilterConds(req.query);
    if (conds === null) return { items: [] };
    // The feed shows flags: neutral session changes only when explicitly requested.
    if (!q.category) conds.push(ne(events.category, 'neutral'));
    return { items: await loadLiveEvents(ctx.db, staff.orgId, conds, q.limit) };
  });

  app.get('/events/:id', reviewer, async (req) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Event', 'event_not_found');
    await loadScopedEvent(ctx.db, staff.orgId, id);
    return eventDTO(ctx, id);
  });

  app.post('/events/:id/review', reviewer, async (req) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Event', 'event_not_found');
    const body = reviewRequestSchema.parse(req.body ?? {});
    const note = body.note?.trim() ? body.note.trim() : null;
    const now = ctx.now();
    const ev = await ctx.db.transaction(async (tx) => {
      const [cur] = await tx
        .select()
        .from(events)
        .where(and(eq(events.id, id), eq(events.orgId, staff.orgId)))
        .for('update');
      if (!cur) throw notFound('Event not found', 'event_not_found');
      const unreview = body.status === 'unreviewed';
      await tx
        .update(events)
        .set({
          reviewStatus: body.status,
          reviewedBy: unreview ? null : staff.id,
          reviewedAt: unreview ? null : new Date(now),
          reviewNote: unreview ? null : note,
        })
        .where(eq(events.id, id));
      await audit(tx, {
        orgId: staff.orgId,
        actorType: 'staff',
        actorId: staff.id,
        action: 'event.review',
        targetType: 'event',
        targetId: id,
        meta: { sessionId: cur.sessionId, type: cur.type, from: cur.reviewStatus, to: body.status, note },
        ip: req.ip,
        at: now,
      });
      return cur;
    });
    ctx.live.eventChanged(id, ev.sessionId);
    return eventDTO(ctx, id);
  });

  app.get('/events/:id/notes', reviewer, async (req) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Event', 'event_not_found');
    const ev = await loadScopedEvent(ctx.db, staff.orgId, id);
    return { items: await loadNoteDTOs(ctx.db, { sessionId: ev.sessionId, eventId: id }) };
  });

  app.post('/events/:id/notes', reviewer, async (req) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Event', 'event_not_found');
    const body = noteRequestSchema.parse(req.body ?? {});
    const text = body.text.trim();
    if (!text) throw validationFailed('The note is empty', [{ path: 'text', message: 'Enter some text' }]);
    const ev = await loadScopedEvent(ctx.db, staff.orgId, id);
    const now = ctx.now();
    const note = await ctx.db.transaction(async (tx) => {
      const [n] = await tx.insert(notes).values({ sessionId: ev.sessionId, eventId: id, authorId: staff.id, text, createdAt: new Date(now) }).returning();
      await audit(tx, {
        orgId: staff.orgId,
        actorType: 'staff',
        actorId: staff.id,
        action: 'note.created',
        targetType: 'event',
        targetId: id,
        meta: { sessionId: ev.sessionId, noteId: n.id },
        ip: req.ip,
        at: now,
      });
      return n;
    });
    ctx.live.eventChanged(id, ev.sessionId);
    return toNoteDTO(note, staff.name);
  });
};

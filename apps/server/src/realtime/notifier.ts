import type { LiveMessage, NoteDTO } from '@sp/shared';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { candidates, events, examSessions, exams, pauseRequests } from '../db/schema.js';
import { loadEventDTO, loadIdentityCheckDTO, loadSessionSummary, toPauseRequestDTO } from '../services/dto.js';

type NotifierCtx = Omit<Ctx, 'live'>;

/**
 * Publishes LiveMessages for staff dashboards. Call AFTER the transaction that made the change has
 * committed (DTOs are re-read from the database). Session summaries are throttled to <= 1/s per session
 * (trailing edge, so the last change is always delivered).
 */
export class LiveNotifier {
  private readonly lastSent = new Map<string, number>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private closed = false;

  constructor(
    private readonly ctx: NotifierCtx,
    private readonly minIntervalMs = 1000,
  ) {}

  private publish(orgId: string, msg: LiveMessage) {
    if (!this.closed) this.ctx.bus.publish(orgId, msg);
  }

  private fail(what: string, err: unknown) {
    this.ctx.log.warn({ err }, `live notifier: ${what} failed`);
  }

  /** Session summary changed (status, connection, monitoring, counts, clock...). Throttled. */
  sessionChanged(sessionId: string): void {
    if (this.closed || this.timers.has(sessionId)) return;
    const last = this.lastSent.get(sessionId) ?? 0;
    const wait = Math.max(0, last + this.minIntervalMs - Date.now());
    const fire = () => {
      this.timers.delete(sessionId);
      this.lastSent.set(sessionId, Date.now());
      void this.sendSession(sessionId);
    };
    if (wait === 0) {
      this.lastSent.set(sessionId, Date.now());
      void this.sendSession(sessionId);
    } else {
      const t = setTimeout(fire, wait);
      t.unref?.();
      this.timers.set(sessionId, t);
    }
    if (this.lastSent.size > 5000) this.pruneLastSent();
  }

  private pruneLastSent() {
    const cutoff = Date.now() - 60_000;
    for (const [k, v] of this.lastSent) if (v < cutoff) this.lastSent.delete(k);
  }

  private async sendSession(sessionId: string) {
    try {
      const dto = await loadSessionSummary(this.ctx, this.ctx.db, sessionId);
      if (!dto) return;
      const [row] = await this.ctx.db.select({ orgId: examSessions.orgId }).from(examSessions).where(eq(examSessions.id, sessionId));
      if (row) this.publish(row.orgId, { type: 'session', session: dto });
    } catch (err) {
      this.fail('session', err);
    }
  }

  /** An event was created or updated. Not throttled. Also refreshes the session summary (counts). */
  eventChanged(eventId: string, sessionId?: string): void {
    if (this.closed) return;
    void (async () => {
      try {
        const [meta] = await this.ctx.db
          .select({ orgId: events.orgId, sessionId: events.sessionId, candidateName: candidates.name, examTitle: exams.title })
          .from(events)
          .innerJoin(examSessions, eq(examSessions.id, events.sessionId))
          .innerJoin(candidates, eq(candidates.id, examSessions.candidateId))
          .innerJoin(exams, eq(exams.id, examSessions.examId))
          .where(eq(events.id, eventId));
        if (!meta) return;
        const dto = await loadEventDTO(this.ctx.db, eventId);
        if (!dto) return;
        this.publish(meta.orgId, { type: 'event', event: dto, candidateName: meta.candidateName, examTitle: meta.examTitle });
        this.sessionChanged(sessionId ?? meta.sessionId);
      } catch (err) {
        this.fail('event', err);
      }
    })();
  }

  identityCheck(sessionId: string, checkId: string): void {
    if (this.closed) return;
    void (async () => {
      try {
        const [row] = await this.ctx.db.select({ orgId: examSessions.orgId }).from(examSessions).where(eq(examSessions.id, sessionId));
        const dto = await loadIdentityCheckDTO(this.ctx.db, checkId);
        if (row && dto) this.publish(row.orgId, { type: 'identity_check', sessionId, check: dto });
        this.sessionChanged(sessionId);
      } catch (err) {
        this.fail('identity_check', err);
      }
    })();
  }

  /** A session note was added: pushed to the org's staff, and the session summary refreshed. */
  sessionNote(sessionId: string, note: NoteDTO): void {
    if (this.closed) return;
    void (async () => {
      try {
        const [row] = await this.ctx.db.select({ orgId: examSessions.orgId }).from(examSessions).where(eq(examSessions.id, sessionId));
        if (row) this.publish(row.orgId, { type: 'note', sessionId, note });
        this.sessionChanged(sessionId);
      } catch (err) {
        this.fail('note', err);
      }
    })();
  }

  pauseRequest(sessionId: string, requestId: string): void {
    if (this.closed) return;
    void (async () => {
      try {
        const [row] = await this.ctx.db
          .select({ orgId: examSessions.orgId, req: pauseRequests })
          .from(pauseRequests)
          .innerJoin(examSessions, eq(examSessions.id, pauseRequests.sessionId))
          .where(eq(pauseRequests.id, requestId));
        if (row) this.publish(row.orgId, { type: 'pause_request', sessionId, request: toPauseRequestDTO(row.req) });
        this.sessionChanged(sessionId);
      } catch (err) {
        this.fail('pause_request', err);
      }
    })();
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

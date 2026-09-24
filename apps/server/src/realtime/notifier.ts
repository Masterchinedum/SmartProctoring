import type { LiveMessage, NoteDTO } from '@sp/shared';
import { eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { candidates, events, examSessions, exams, identityChecks, pauseRequests } from '../db/schema.js';
import { eventRowsToDTOs, identityCheckRowsToDTOs, loadSessionSummaries, toPauseRequestDTO } from '../services/dto.js';

type NotifierCtx = Omit<Ctx, 'live'>;

export interface LiveNotifierOptions {
  /** Min interval between two summaries of the same session (trailing edge: the last change is always sent). */
  sessionIntervalMs?: number;
  /**
   * Changes staff cannot see in a summary (heartbeat timestamps, the clock ticking) are sent at most this often
   * per session, so "last heartbeat" stays roughly current without a summary per heartbeat.
   */
  keepaliveMs?: number;
  /** Changes arriving within this window are loaded and published together (one query set per batch). */
  batchMs?: number;
}

export interface SessionChange {
  /** The session's organisation, when the caller knows it (lets the notifier skip unobserved orgs for free). */
  orgId?: string;
  /** false: only fields staff do not see changed (e.g. a routine heartbeat). Default true. */
  visible?: boolean;
}

export const LIVE_DEFAULTS: Required<LiveNotifierOptions> = { sessionIntervalMs: 2_000, keepaliveMs: 30_000, batchMs: 50 };

const CHUNK = 200;

interface SessionState {
  lastSentAt: number;
  timer: NodeJS.Timeout | null;
  orgId: string | null;
}

/**
 * Publishes LiveMessages for staff dashboards. Call AFTER the transaction that made the change has committed
 * (DTOs are re-read from the database).
 *
 * Cost control (docs/PERFORMANCE.md): nothing is loaded for an organisation without staff subscribers (on this
 * instance or, with Redis, any instance); session summaries are coalesced per session (<= 1 per
 * `sessionIntervalMs`, trailing edge) and changes staff cannot see only refresh a summary every `keepaliveMs`;
 * everything due within `batchMs` is loaded with one query set per organisation.
 */
export class LiveNotifier {
  private readonly opts: Required<LiveNotifierOptions>;
  private readonly sessions = new Map<string, SessionState>();
  private readonly dueSessions = new Map<string, string | null>();
  private readonly dueEvents = new Map<string, string | null>();
  private readonly dueChecks = new Map<string, { sessionId: string; orgId: string | null }>();
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly ctx: NotifierCtx,
    opts: LiveNotifierOptions | number = {},
  ) {
    // (a number is the legacy `minIntervalMs` argument)
    this.opts = { ...LIVE_DEFAULTS, ...(typeof opts === 'number' ? { sessionIntervalMs: opts } : opts) };
  }

  private publish(orgId: string, msg: LiveMessage) {
    if (!this.closed) this.ctx.bus.publish(orgId, msg);
  }

  private fail(what: string, err: unknown) {
    this.ctx.log.warn({ err }, `live notifier: ${what} failed`);
  }

  /** False only when the organisation is known and nobody can receive its messages. */
  private observed(orgId: string | null | undefined): boolean {
    return !orgId || this.ctx.bus.hasSubscribers(orgId);
  }

  /** Session summary changed (status, connection, monitoring, counts, clock...). Coalesced. */
  sessionChanged(sessionId: string, change: SessionChange = {}): void {
    if (this.closed) return;
    const orgId = change.orgId ?? null;
    if (!this.observed(orgId)) return;
    let st = this.sessions.get(sessionId);
    if (!st) {
      if (this.sessions.size >= 5000) this.prune();
      this.sessions.set(sessionId, (st = { lastSentAt: 0, timer: null, orgId }));
    }
    if (orgId) st.orgId = orgId;
    if (st.timer || this.dueSessions.has(sessionId)) return; // already on its way
    const visible = change.visible !== false;
    const wait = st.lastSentAt + (visible ? this.opts.sessionIntervalMs : this.opts.keepaliveMs) - Date.now();
    if (wait <= 0) {
      this.markSessionDue(sessionId, st);
    } else if (visible) {
      const s = st;
      s.timer = setTimeout(() => {
        s.timer = null;
        this.markSessionDue(sessionId, s);
      }, wait);
      s.timer.unref?.();
    }
    // invisible change inside the keepalive window: nothing to tell staff
  }

  private markSessionDue(sessionId: string, st: SessionState) {
    if (this.closed) return;
    st.lastSentAt = Date.now();
    this.dueSessions.set(sessionId, st.orgId);
    this.scheduleFlush();
  }

  private prune() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, v] of this.sessions) if (!v.timer && v.lastSentAt < cutoff) this.sessions.delete(k);
  }

  /** An event was created or updated. Batched (not throttled). Also refreshes the session summary (counts). */
  eventChanged(eventId: string, _sessionId?: string, orgId?: string): void {
    if (this.closed || !this.observed(orgId)) return;
    this.dueEvents.set(eventId, orgId ?? null);
    this.scheduleFlush();
  }

  /** An identity check was recorded. Batched. Also refreshes the session summary. */
  identityCheck(sessionId: string, checkId: string, orgId?: string): void {
    if (this.closed || !this.observed(orgId)) return;
    this.dueChecks.set(checkId, { sessionId, orgId: orgId ?? null });
    this.scheduleFlush();
  }

  /** A session note was added: pushed to the org's staff, and the session summary refreshed. */
  sessionNote(sessionId: string, note: NoteDTO): void {
    if (this.closed) return;
    void (async () => {
      try {
        const [row] = await this.ctx.db.select({ orgId: examSessions.orgId }).from(examSessions).where(eq(examSessions.id, sessionId));
        if (!row || !this.observed(row.orgId)) return;
        this.publish(row.orgId, { type: 'note', sessionId, note });
        this.sessionChanged(sessionId, { orgId: row.orgId });
      } catch (err) {
        this.fail('note', err);
      }
    })();
  }

  pauseRequest(sessionId: string, requestId: string, orgId?: string): void {
    if (this.closed || !this.observed(orgId)) return;
    void (async () => {
      try {
        const [row] = await this.ctx.db
          .select({ orgId: examSessions.orgId, req: pauseRequests })
          .from(pauseRequests)
          .innerJoin(examSessions, eq(examSessions.id, pauseRequests.sessionId))
          .where(eq(pauseRequests.id, requestId));
        if (row) this.publish(row.orgId, { type: 'pause_request', sessionId, request: toPauseRequestDTO(row.req) });
        this.sessionChanged(sessionId, { orgId: row?.orgId });
      } catch (err) {
        this.fail('pause_request', err);
      }
    })();
  }

  private scheduleFlush() {
    if (this.flushTimer || this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      // One batch at a time; whatever arrives meanwhile goes into the next one.
      const run = async () => {
        if (this.flushing) await this.flushing.catch(() => {});
        await this.flush();
      };
      const p = run().finally(() => {
        if (this.flushing === p) this.flushing = null;
      });
      this.flushing = p;
    }, this.opts.batchMs);
    this.flushTimer.unref?.();
  }

  private async flush(): Promise<void> {
    if (this.closed) return;
    const evs = [...this.dueEvents.keys()];
    this.dueEvents.clear();
    const checks = [...this.dueChecks];
    this.dueChecks.clear();
    if (evs.length) await this.sendEvents(evs).catch((err) => this.fail('event', err));
    if (checks.length) await this.sendIdentityChecks(checks).catch((err) => this.fail('identity_check', err));
    // Events and checks above may have queued their sessions: send summaries in the same batch.
    const sessions = [...this.dueSessions];
    this.dueSessions.clear();
    if (sessions.length) await this.sendSessions(sessions).catch((err) => this.fail('session', err));
  }

  private async sendEvents(ids: string[]) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const metas = await this.ctx.db
        .select({ id: events.id, orgId: events.orgId, sessionId: events.sessionId, candidateName: candidates.name, examTitle: exams.title })
        .from(events)
        .innerJoin(examSessions, eq(examSessions.id, events.sessionId))
        .innerJoin(candidates, eq(candidates.id, examSessions.candidateId))
        .innerJoin(exams, eq(exams.id, examSessions.examId))
        .where(inArray(events.id, chunk));
      const wanted = metas.filter((m) => this.ctx.bus.hasSubscribers(m.orgId));
      if (!wanted.length) continue;
      const rows = await this.ctx.db.select().from(events).where(inArray(events.id, wanted.map((m) => m.id)));
      const dtos = new Map((await eventRowsToDTOs(this.ctx.db, rows)).map((d) => [d.id, d]));
      for (const m of wanted) {
        const event = dtos.get(m.id);
        if (!event) continue;
        this.publish(m.orgId, { type: 'event', event, candidateName: m.candidateName, examTitle: m.examTitle });
        this.sessionChanged(m.sessionId, { orgId: m.orgId });
      }
    }
  }

  private async sendIdentityChecks(list: [string, { sessionId: string; orgId: string | null }][]) {
    const unknown = [...new Set(list.filter(([, v]) => !v.orgId).map(([, v]) => v.sessionId))];
    const orgOf = new Map<string, string>();
    if (unknown.length) {
      const rows = await this.ctx.db.select({ id: examSessions.id, orgId: examSessions.orgId }).from(examSessions).where(inArray(examSessions.id, unknown));
      for (const r of rows) orgOf.set(r.id, r.orgId);
    }
    const wanted = list
      .map(([id, v]) => ({ id, sessionId: v.sessionId, orgId: v.orgId ?? orgOf.get(v.sessionId) ?? null }))
      .filter((c): c is { id: string; sessionId: string; orgId: string } => !!c.orgId && this.ctx.bus.hasSubscribers(c.orgId));
    for (let i = 0; i < wanted.length; i += CHUNK) {
      const chunk = wanted.slice(i, i + CHUNK);
      const rows = await this.ctx.db.select().from(identityChecks).where(inArray(identityChecks.id, chunk.map((c) => c.id)));
      const dtos = new Map((await identityCheckRowsToDTOs(this.ctx.db, rows)).map((d) => [d.id, d]));
      for (const c of chunk) {
        const check = dtos.get(c.id);
        if (check) this.publish(c.orgId, { type: 'identity_check', sessionId: c.sessionId, check });
        this.sessionChanged(c.sessionId, { orgId: c.orgId });
      }
    }
  }

  private async sendSessions(list: [string, string | null][]) {
    const unknown = list.filter(([, org]) => !org).map(([id]) => id);
    const byOrg = new Map<string, string[]>();
    const add = (orgId: string, id: string) => {
      const l = byOrg.get(orgId);
      if (l) l.push(id);
      else byOrg.set(orgId, [id]);
    };
    for (const [id, org] of list) if (org) add(org, id);
    for (let i = 0; i < unknown.length; i += CHUNK) {
      const rows = await this.ctx.db
        .select({ id: examSessions.id, orgId: examSessions.orgId })
        .from(examSessions)
        .where(inArray(examSessions.id, unknown.slice(i, i + CHUNK)));
      for (const r of rows) {
        add(r.orgId, r.id);
        const st = this.sessions.get(r.id);
        if (st) st.orgId = r.orgId;
      }
    }
    for (const [orgId, ids] of byOrg) {
      if (!this.ctx.bus.hasSubscribers(orgId)) continue;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const dtos = await loadSessionSummaries(this.ctx, this.ctx.db, { orgId, sessionIds: ids.slice(i, i + CHUNK) });
        for (const session of dtos) this.publish(orgId, { type: 'session', session });
      }
    }
  }

  close(): void {
    this.closed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const st of this.sessions.values()) if (st.timer) clearTimeout(st.timer);
    this.sessions.clear();
    this.dueSessions.clear();
    this.dueEvents.clear();
    this.dueChecks.clear();
  }
}

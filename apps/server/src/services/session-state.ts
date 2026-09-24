/**
 * Session state machine primitives.
 *
 * Every change to a session runs inside `withSession(ctx, sessionId, fn)`: a transaction holding a row
 * lock on exam_sessions (SELECT ... FOR NO KEY UPDATE — does not block FK inserts elsewhere), so heartbeats, sweeper, candidate and staff actions
 * are serialised per session and safe across several server instances. Realtime notifications are
 * queued on the mutation and published after COMMIT.
 */
import { randomUUID } from 'node:crypto';
import {
  clockStart as clockStartFn,
  clockStop as clockStopFn,
  EVENT_CATALOG,
  OBSERVED_PERIOD_KINDS,
  type CandidateCommand,
  type CheckPurpose,
  type SessionEndReason,
  type EventSource,
  type EventType,
  type HoldReason,
  type PeriodKind,
  type ProctoringPolicy,
  type SessionStatus,
} from '@sp/shared';
import { and, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import type { Tx } from '../db/index.js';
import {
  candidates,
  events,
  examSessions,
  exams,
  organizations,
  pauseRequests,
  sessionCommands,
  sessionPeriods,
  type Candidate,
  type EventRow,
  type Exam,
  type ExamSession,
  type IdentityEngineState,
  type Organization,
  type SessionPeriod,
} from '../db/schema.js';
import { HttpError, notFound } from '../lib/errors.js';
import { sessionClock } from './dto.js';
import { gradeSession } from './grading.js';
import { enqueueIntegrationNotifications } from './integration-events.js';
import { mergePolicy, orgThresholds } from './org.js';

export const TERMINAL: SessionStatus[] = ['submitted', 'terminated'];
export const UNOBSERVED_KINDS: PeriodKind[] = ['paused', 'disconnected', 'on_hold'];
/** Behavioural events with timestamps inside these periods are dropped. */
export const BLOCKING_PERIOD_KINDS: PeriodKind[] = ['paused', 'on_hold'];

export const EMPTY_IDENTITY_STATE: IdentityEngineState = {
  consecutiveMatch: 0,
  consecutiveMismatch: 0,
  consecutiveUnable: 0,
  openMismatchEventId: null,
  openUnverifiableEventId: null,
  openFeedSuspectEventId: null,
  lastSampleDhash: null,
  identicalDhashStreak: 0,
  lastMatchAt: null,
  followUpRequestedAt: null,
  pendingMismatchCheckIds: [],
};

export function identityState(s: Pick<ExamSession, 'identityState'>): IdentityEngineState {
  return { ...EMPTY_IDENTITY_STATE, ...(s.identityState ?? {}) };
}

/** Effective policy: snapshot taken at exam start, else org default merged with the exam policy. */
export function effectivePolicy(session: Pick<ExamSession, 'policy'>, exam: Pick<Exam, 'policy'>, org: Pick<Organization, 'settings'> | null): ProctoringPolicy {
  if (session.policy) return mergePolicy(undefined, session.policy as Record<string, unknown>);
  return mergePolicy(org?.settings?.defaultPolicy as Record<string, unknown> | undefined, exam.policy as Record<string, unknown>);
}

/** Which check (if any) THIS browser instance must pass before continuing. */
export function requiredCheckFor(s: ExamSession, instanceId: string | null | undefined): CheckPurpose | null {
  const inControl = !!instanceId && instanceId === s.verifiedInstanceId && instanceId === s.activeInstanceId;
  switch (s.status) {
    case 'invited':
      return s.consentAcceptedAt ? 'initial' : null;
    case 'ready':
    case 'active':
      return inControl ? null : 'reconnect';
    case 'paused':
      return 'resume';
    case 'on_hold':
      return s.holdCanReverify ? 'reverify' : null;
    default:
      return null;
  }
}

export interface ServerEventInput {
  type: EventType;
  startedAt?: number;
  endedAt?: number | null;
  /** Span events: keep open (endedAt null). Ignored for markers. */
  open?: boolean;
  confidence?: number | null;
  observation?: string;
  details?: Record<string, unknown>;
  context?: Record<string, unknown>;
  source?: EventSource;
  id?: string;
}

/** A locked session inside a transaction. Mutate via set()/helpers; changes are written on commit. */
export class SessionMutation {
  readonly now: number;
  private patch: Partial<typeof examSessions.$inferInsert> = {};
  private readonly touchedEvents = new Set<string>();
  private readonly identityChecksToPublish: string[] = [];
  private readonly pauseRequestsToPublish: string[] = [];
  private readonly afterCommit: (() => void | Promise<void>)[] = [];
  private cache: { exam?: Exam; org?: Organization | null; candidate?: Candidate; periods?: SessionPeriod[] } = {};

  constructor(
    readonly ctx: Ctx,
    readonly tx: Tx,
    public session: ExamSession,
  ) {
    this.now = ctx.now();
  }

  /** Update session fields (applied to the in-memory copy immediately and written on commit). */
  set(fields: Partial<typeof examSessions.$inferInsert>): void {
    Object.assign(this.patch, fields);
    Object.assign(this.session, fields);
  }

  get dirty(): boolean {
    return Object.keys(this.patch).length > 0;
  }

  async exam(): Promise<Exam> {
    if (!this.cache.exam) {
      const [e] = await this.tx.select().from(exams).where(eq(exams.id, this.session.examId));
      this.cache.exam = e;
    }
    return this.cache.exam!;
  }

  async org(): Promise<Organization | null> {
    if (this.cache.org === undefined) {
      const [o] = await this.tx.select().from(organizations).where(eq(organizations.id, this.session.orgId));
      this.cache.org = o ?? null;
    }
    return this.cache.org;
  }

  async candidate(): Promise<Candidate> {
    if (!this.cache.candidate) {
      const [c] = await this.tx.select().from(candidates).where(eq(candidates.id, this.session.candidateId));
      this.cache.candidate = c;
    }
    return this.cache.candidate!;
  }

  async policy(): Promise<ProctoringPolicy> {
    return effectivePolicy(this.session, await this.exam(), await this.org());
  }

  async thresholds() {
    return orgThresholds(await this.org());
  }

  /* ---------------------------------------------------------------- notifications */

  onCommit(fn: () => void | Promise<void>): void {
    this.afterCommit.push(fn);
  }
  /** Events created or changed by this mutation (integration outbox, realtime). */
  get touchedEventIds(): string[] {
    return [...this.touchedEvents];
  }
  touchEvent(id: string): void {
    this.touchedEvents.add(id);
  }
  publishIdentityCheck(id: string): void {
    this.identityChecksToPublish.push(id);
  }
  publishPauseRequest(id: string): void {
    this.pauseRequestsToPublish.push(id);
  }

  /** @internal */
  async flush(): Promise<void> {
    if (this.dirty) {
      this.patch.updatedAt = new Date(this.now);
      await this.tx.update(examSessions).set(this.patch).where(eq(examSessions.id, this.session.id));
      this.patch = {};
    }
  }

  /** @internal */
  runAfterCommit(): void {
    const live = this.ctx.live;
    const sid = this.session.id;
    for (const id of this.touchedEvents) live.eventChanged(id, sid);
    for (const id of this.identityChecksToPublish) live.identityCheck(sid, id);
    for (const id of this.pauseRequestsToPublish) live.pauseRequest(sid, id);
    live.sessionChanged(sid);
    for (const fn of this.afterCommit) {
      try {
        const r = fn();
        if (r instanceof Promise) r.catch((err) => this.ctx.log.error({ err }, 'afterCommit hook failed'));
      } catch (err) {
        this.ctx.log.error({ err }, 'afterCommit hook failed');
      }
    }
  }

  /* ---------------------------------------------------------------- clock */

  clockStart(at = this.now): void {
    if (this.session.runningSince) return;
    const c = clockStartFn(sessionClock(this.session), at);
    this.set({ runningSince: c.runningSince != null ? new Date(c.runningSince) : null });
  }

  clockStop(at = this.now): void {
    if (!this.session.runningSince) return;
    const c = clockStopFn(sessionClock(this.session), at);
    this.set({ usedMs: Math.round(c.usedMs), runningSince: null });
  }

  /* ---------------------------------------------------------------- periods */

  async periods(): Promise<SessionPeriod[]> {
    if (!this.cache.periods) {
      this.cache.periods = await this.tx.select().from(sessionPeriods).where(eq(sessionPeriods.sessionId, this.session.id)).orderBy(sessionPeriods.startedAt);
    }
    return this.cache.periods;
  }

  async openPeriodRow(): Promise<SessionPeriod | null> {
    const ps = await this.periods();
    for (let i = ps.length - 1; i >= 0; i--) if (!ps[i].endedAt) return ps[i];
    return null;
  }

  /** Close the currently open period (if any) at `at`. Emits unobserved_period for unobserved kinds. */
  async closeOpenPeriod(at = this.now, meta?: Record<string, unknown>): Promise<SessionPeriod | null> {
    const p = await this.openPeriodRow();
    if (!p) return null;
    const end = Math.max(p.startedAt.getTime(), at);
    const newMeta = meta ? { ...p.meta, ...meta } : p.meta;
    await this.tx.update(sessionPeriods).set({ endedAt: new Date(end), meta: newMeta }).where(eq(sessionPeriods.id, p.id));
    p.endedAt = new Date(end);
    p.meta = newMeta;
    if (UNOBSERVED_KINDS.includes(p.kind)) {
      await this.addEvent({
        type: 'unobserved_period',
        startedAt: p.startedAt.getTime(),
        endedAt: end,
        details: { periodId: p.id, periodKind: p.kind, reason: p.reason, durationMs: end - p.startedAt.getTime() },
      });
    }
    return p;
  }

  /** Insert a period. If `endedAt` is omitted the period is open (close any open one first!). */
  async insertPeriod(kind: PeriodKind, startedAt: number, opts: { endedAt?: number | null; reason?: string | null; meta?: Record<string, unknown> } = {}): Promise<SessionPeriod> {
    const [row] = await this.tx
      .insert(sessionPeriods)
      .values({
        sessionId: this.session.id,
        kind,
        observed: OBSERVED_PERIOD_KINDS.includes(kind),
        startedAt: new Date(startedAt),
        endedAt: opts.endedAt != null ? new Date(Math.max(startedAt, opts.endedAt)) : null,
        reason: opts.reason ?? null,
        meta: opts.meta ?? {},
      })
      .returning();
    const ps = await this.periods();
    ps.push(row);
    ps.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    if (UNOBSERVED_KINDS.includes(kind) && row.endedAt) {
      await this.addEvent({
        type: 'unobserved_period',
        startedAt,
        endedAt: row.endedAt.getTime(),
        details: { periodId: row.id, periodKind: kind, reason: row.reason, durationMs: row.endedAt.getTime() - startedAt },
      });
    }
    return row;
  }

  /** Close the open period and open a new one. */
  async switchPeriod(kind: PeriodKind, at = this.now, opts: { reason?: string | null; meta?: Record<string, unknown> } = {}): Promise<SessionPeriod> {
    await this.closeOpenPeriod(at);
    return this.insertPeriod(kind, at, opts);
  }

  /* ---------------------------------------------------------------- events */

  async addEvent(input: ServerEventInput): Promise<EventRow> {
    const cat = EVENT_CATALOG[input.type];
    const startedAt = input.startedAt ?? this.now;
    const isOpen = cat.span && input.open === true && input.endedAt == null;
    const endedAt = isOpen ? null : (input.endedAt ?? startedAt);
    const [row] = await this.tx
      .insert(events)
      .values({
        id: input.id ?? randomUUID(),
        orgId: this.session.orgId,
        sessionId: this.session.id,
        type: input.type,
        category: cat.category,
        severity: cat.severity,
        source: input.source ?? cat.sources[0],
        status: isOpen ? 'open' : 'closed',
        title: cat.title,
        observation: input.observation ?? cat.observation,
        startedAt: new Date(startedAt),
        endedAt: endedAt != null ? new Date(Math.max(startedAt, endedAt)) : null,
        confidence: input.confidence ?? null,
        details: input.details ?? {},
        context: input.context ?? {},
        version: 1,
        firstReceivedAt: new Date(this.now),
        receivedAt: new Date(this.now),
        deliveredLate: false,
      })
      .returning();
    this.touchEvent(row.id);
    return row;
  }

  /** Server-side update. Does not change `version` (that sequence belongs to the reporting client). */
  async updateEvent(id: string, fields: Partial<typeof events.$inferInsert>): Promise<EventRow | null> {
    const [row] = await this.tx
      .update(events)
      .set({ ...fields, receivedAt: new Date(this.now) })
      .where(and(eq(events.id, id), eq(events.sessionId, this.session.id)))
      .returning();
    if (row) this.touchEvent(row.id);
    return row ?? null;
  }

  async closeEvent(id: string | null | undefined, at = this.now, detailsPatch?: Record<string, unknown>): Promise<EventRow | null> {
    if (!id) return null;
    const [cur] = await this.tx.select().from(events).where(and(eq(events.id, id), eq(events.sessionId, this.session.id)));
    if (!cur || cur.status === 'closed') return cur ?? null;
    return this.updateEvent(id, {
      status: 'closed',
      endedAt: new Date(Math.max(cur.startedAt.getTime(), at)),
      details: detailsPatch ? { ...cur.details, ...detailsPatch } : cur.details,
    });
  }

  /**
   * Close all open span events at `at` (monitoring stopped: pause, hold, end).
   * `keep` lists event types to leave open.
   */
  async closeOpenEvents(at: number, reason: string, keep: EventType[] = []): Promise<void> {
    const open = await this.tx
      .select({ id: events.id, type: events.type, startedAt: events.startedAt, details: events.details })
      .from(events)
      .where(and(eq(events.sessionId, this.session.id), eq(events.status, 'open')));
    for (const e of open) {
      if (keep.includes(e.type)) continue;
      await this.updateEvent(e.id, {
        status: 'closed',
        endedAt: new Date(Math.max(e.startedAt.getTime(), at)),
        details: { ...e.details, closedBy: reason },
      });
    }
    const st = identityState(this.session);
    const ids = new Set(open.filter((e) => !keep.includes(e.type)).map((e) => e.id));
    if (ids.size) {
      this.setIdentityState({
        ...st,
        openMismatchEventId: st.openMismatchEventId && ids.has(st.openMismatchEventId) ? null : st.openMismatchEventId,
        openUnverifiableEventId: st.openUnverifiableEventId && ids.has(st.openUnverifiableEventId) ? null : st.openUnverifiableEventId,
        openFeedSuspectEventId: st.openFeedSuspectEventId && ids.has(st.openFeedSuspectEventId) ? null : st.openFeedSuspectEventId,
      });
      if (this.session.reportingEventId && ids.has(this.session.reportingEventId)) this.set({ reportingEventId: null });
    }
  }

  setIdentityState(state: IdentityEngineState): void {
    this.set({ identityState: state });
  }

  /** Reset per-period identity aggregation counters (new observed period). */
  resetIdentityCounters(): void {
    const st = identityState(this.session);
    this.setIdentityState({ ...st, consecutiveMatch: 0, consecutiveMismatch: 0, consecutiveUnable: 0, followUpRequestedAt: null, pendingMismatchCheckIds: [], identicalDhashStreak: 0, lastSampleDhash: null });
  }

  /* ---------------------------------------------------------------- commands */

  async enqueueCommand(command: CandidateCommand, targetInstanceId: string | null = null): Promise<void> {
    await this.tx.insert(sessionCommands).values({ sessionId: this.session.id, targetInstanceId, command, createdAt: new Date(this.now) });
  }
}

/**
 * Run `fn` with the session row locked. Throws 404 if the session does not exist.
 * Notifications queued on the mutation are published after commit.
 */
export async function withSession<T>(ctx: Ctx, sessionId: string, fn: (m: SessionMutation) => Promise<T>): Promise<T> {
  let mutation: SessionMutation | null = null;
  const result = await ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(examSessions).where(eq(examSessions.id, sessionId)).for('no key update');
    if (!row) throw notFound('Session not found', 'session_not_found');
    const m = new SessionMutation(ctx, tx, row);
    mutation = m;
    const out = await fn(m);
    await m.flush();
    await enqueueIntegrationNotifications(m); // webhook / email outbox rows in the same transaction
    return out;
  });
  (mutation as SessionMutation | null)?.runAfterCommit();
  return result;
}

/* =================================================================== transitions */

export function assertStatus(m: SessionMutation, allowed: SessionStatus[], message?: string): void {
  if (!allowed.includes(m.session.status)) {
    throw new HttpError(409, 'invalid_state', message ?? `This action is not possible while the exam is ${m.session.status.replace('_', ' ')}`, { status: m.session.status });
  }
}

/** ready -> active: clock starts, active period opens, policy snapshot taken. */
export async function startExam(m: SessionMutation): Promise<void> {
  assertStatus(m, ['ready'], 'The exam can only be started after the readiness check');
  const policy = await m.policy();
  m.set({ status: 'active', startedAt: m.session.startedAt ?? new Date(m.now), policy, currentQuestionIndex: m.session.currentQuestionIndex ?? 0 });
  m.clockStart();
  await m.switchPeriod('active', m.now);
  m.resetIdentityCounters();
  await m.addEvent({ type: 'session_started', details: { durationMs: m.session.durationMs } });
}

/** active -> paused (formal pause). Monitoring stops; paused period (unobserved) opens. */
export async function pauseNow(m: SessionMutation, opts: { reason: string | null; requestId?: string | null; approvedBy?: string | null }): Promise<void> {
  assertStatus(m, ['active']);
  const policy = await m.policy();
  const at = m.now;
  if (policy.pause.timerBehavior === 'stop') m.clockStop(at);
  else m.clockStart(at); // e.g. was stopped during a disconnect; pause with 'continue' keeps time running
  await m.closeOpenEvents(at, 'pause', ['reporting_interrupted']);
  await m.switchPeriod('paused', at, { reason: opts.reason, meta: { requestId: opts.requestId ?? null, timerBehavior: policy.pause.timerBehavior } });
  m.set({ status: 'paused', pauseCount: m.session.pauseCount + 1, checkAttemptsResetAt: new Date(at) });
  m.resetIdentityCounters();
  await m.addEvent({
    type: 'session_paused',
    startedAt: at,
    details: { reason: opts.reason, requestId: opts.requestId ?? null, approvedBy: opts.approvedBy ?? null, timerBehavior: policy.pause.timerBehavior, pauseNumber: m.session.pauseCount },
  });
}

export const HOLD_MESSAGES: Record<HoldReason, string> = {
  identity_mismatch: 'Your exam is on hold while an administrator reviews the identity check. Please wait; you will be able to continue if the review allows it.',
  identity_unverifiable: 'We could not verify your identity after several attempts. Your exam is on hold until an administrator reviews it. Your answers and remaining time are saved.',
  id_photo_mismatch: 'We could not match you with the identity photo on file. An administrator will review this before you can start.',
  pause_limit: 'Your pause was longer than the exam rules allow. An administrator needs to approve before you can continue. Your answers and remaining time are saved.',
  staff: 'An administrator has put your exam on hold. Please wait for further instructions.',
  id_photo_unverifiable:
    'We could not compare you clearly with the identity photo on file (for example because of lighting or image quality). This is not a finding that you are a different person. An administrator will review this before you can start.',
};

/** Put the session on hold (clock stopped, on_hold period opens, candidate gets a 'hold' command). */
export async function holdNow(m: SessionMutation, opts: { reason: HoldReason; message?: string; canReverify?: boolean; source?: EventSource; details?: Record<string, unknown>; by?: string | null }): Promise<void> {
  assertStatus(m, ['invited', 'ready', 'active', 'paused', 'on_hold']);
  const at = m.now;
  const prev = m.session.status;
  const message = opts.message ?? HOLD_MESSAGES[opts.reason];
  m.clockStop(at);
  if (prev !== 'on_hold') await m.closeOpenEvents(at, 'hold', ['reporting_interrupted']);
  const open = await m.openPeriodRow();
  const continuing = open?.kind === 'on_hold';
  if (continuing) {
    await m.tx.update(sessionPeriods).set({ reason: opts.reason }).where(eq(sessionPeriods.id, open.id));
    open.reason = opts.reason;
  } else {
    await m.switchPeriod('on_hold', at, { reason: opts.reason, meta: { previousStatus: prev } });
  }
  m.set({
    status: 'on_hold',
    holdReason: opts.reason,
    holdSince: continuing && m.session.holdSince ? m.session.holdSince : new Date(at),
    holdMessage: message,
    holdCanReverify: opts.canReverify ?? false,
    holdPrevStatus: prev === 'on_hold' ? m.session.holdPrevStatus : prev === 'paused' ? 'active' : prev,
    // A new hold invalidates any earlier staff authorisation to re-enrol the reference (staff decide again on release).
    reEnrollAuthorized: false,
    reEnrollAuthorizedBy: null,
  });
  m.resetIdentityCounters();
  await m.addEvent({ type: 'session_held', source: opts.source ?? 'server_system', details: { reason: opts.reason, previousStatus: prev, by: opts.by ?? null, ...(opts.details ?? {}) } });
  await m.enqueueCommand({ kind: 'hold', hold: { reason: opts.reason, since: m.session.holdSince?.getTime() ?? at, message, canReverify: opts.canReverify ?? false } });
}

/**
 * End the session (submitted / terminated). Clock stops, all open periods/events close, answers are graded.
 */
export async function finalizeSession(
  m: SessionMutation,
  endReason: SessionEndReason,
  opts: { by?: string | null; note?: string | null; /** 'abandoned' only */ observation?: string; details?: Record<string, unknown>; candidateMessage?: string } = {},
): Promise<void> {
  if (TERMINAL.includes(m.session.status)) return;
  // Time expiry is recorded at the moment the clock ran out (the sweeper may run a few seconds later).
  const rs = m.session.runningSince?.getTime();
  const at = endReason === 'time_expired' && rs != null ? Math.max(rs, Math.min(m.now, rs + m.session.durationMs - m.session.usedMs)) : m.now;
  m.clockStop(at);
  // 'abandoned' (housekeeping after inactivity) ends as terminated so no score is implied; answers are kept.
  const status: SessionStatus = endReason === 'staff_terminated' || endReason === 'abandoned' ? 'terminated' : 'submitted';
  await m.closeOpenEvents(at, 'session_end');
  await m.closeOpenPeriod(at);
  await m.tx
    .update(pauseRequests)
    .set({ status: 'cancelled', decidedAt: new Date(at) })
    .where(and(eq(pauseRequests.sessionId, m.session.id), eq(pauseRequests.status, 'pending')));
  const wasStarted = m.session.startedAt != null;
  m.set({
    status,
    endReason,
    endedAt: new Date(at),
    reportingInterruptedSince: null,
    reportingEventId: null,
    holdCanReverify: false,
  });
  if (endReason === 'time_expired') await m.addEvent({ type: 'session_expired', startedAt: at });
  if (endReason === 'abandoned') {
    // Neutral housekeeping marker (services/abandonment.ts); no score, answers kept.
    await m.addEvent({ type: 'session_terminated', source: 'server_system', startedAt: at, observation: opts.observation, details: { reason: 'abandoned_after_inactivity', ...(opts.details ?? {}) } });
    await m.enqueueCommand({ kind: 'terminated', message: opts.candidateMessage ?? 'This exam session was closed because it was not used for a long time.' });
  } else if (endReason === 'staff_terminated') {
    await m.addEvent({ type: 'session_terminated', source: 'staff', startedAt: at, details: { reason: opts.note ?? null, by: opts.by ?? null } });
    await m.enqueueCommand({ kind: 'terminated', message: 'Your exam was ended by an administrator.' });
  } else {
    await m.addEvent({ type: 'session_submitted', startedAt: at, source: 'server_system', details: { endReason, by: opts.by ?? null, note: opts.note ?? null } });
    if (endReason !== 'candidate_submitted') await m.enqueueCommand({ kind: 'submitted', reason: endReason });
  }
  if (wasStarted && endReason !== 'abandoned') {
    const score = await gradeSession(m.tx, m.session.id, m.session.examId, at);
    m.set({ score });
  }
}

/** Latest active-period start (for "answeredAt <= period start" late-delivery rules). */
export async function currentUnobservedPeriodStart(m: SessionMutation): Promise<number | null> {
  const p = await m.openPeriodRow();
  return p && !p.observed ? p.startedAt.getTime() : null;
}

/* =================================================================== queries */

export async function findPeriodAt(tx: Tx | Ctx['db'], sessionId: string, at: number): Promise<SessionPeriod | null> {
  const rows = await tx
    .select()
    .from(sessionPeriods)
    .where(and(eq(sessionPeriods.sessionId, sessionId), lte(sessionPeriods.startedAt, new Date(at)), or(isNull(sessionPeriods.endedAt), sql`${sessionPeriods.endedAt} > ${new Date(at)}`)))
    .orderBy(desc(sessionPeriods.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function loadSessionByToken(ctx: Ctx, tokenHash: string): Promise<ExamSession | null> {
  const [s] = await ctx.db.select().from(examSessions).where(eq(examSessions.accessTokenHash, tokenHash));
  return s ?? null;
}

export async function pendingPauseRequest(tx: Tx | Ctx['db'], sessionId: string) {
  const [p] = await tx
    .select()
    .from(pauseRequests)
    .where(and(eq(pauseRequests.sessionId, sessionId), eq(pauseRequests.status, 'pending')))
    .orderBy(desc(pauseRequests.requestedAt))
    .limit(1);
  return p ?? null;
}


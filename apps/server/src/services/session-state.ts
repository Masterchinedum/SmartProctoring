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
  ACCOMMODATION_CATALOG,
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
import { and, desc, eq, getTableColumns, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import type { Tx } from '../db/index.js';
import {
  candidates,
  events,
  examSessions,
  exams,
  identitySampleFrames,
  organizations,
  pauseRequests,
  sessionCommands,
  sessionPeriods,
  type Candidate,
  type EventRow,
  type Exam,
  type ExamSession,
  type IdentityCheck,
  type IdentityEngineState,
  type Organization,
  type SessionPeriod,
} from '../db/schema.js';
import { HttpError, notFound } from '../lib/errors.js';
import { sessionClock, staffVisibleKey } from './dto.js';
import { refreshSessionAccommodations, withAccommodations } from './accommodations.js';
import { transactionWithEvidence } from './evidence.js';
import { loadVersion, versionForStart } from './exam-versions.js';
import { gradeSession } from './grading.js';
import { enqueueIntegrationNotifications } from './integration-events.js';
import { decisionStamp, mergePolicy, orgThresholds, type DecisionStamp } from './org.js';
import { capturesWithin, GAP_NOT_RETURNED, loadLateCaptures } from './reporting-gaps.js';
import { EMPTY_ACCUMULATOR } from './identity-evidence.js';

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
  evidence: { ...EMPTY_ACCUMULATOR, window: [] },
  activeSince: null,
  sampleRequest: null,
  pendingBursts: [],
  secondOpinionPending: null,
  secondOpinionVeto: null,
  normalisation: 'continuous',
  periodBaseline: null,
  openNoSamplesEventId: null,
};

export function identityState(s: Pick<ExamSession, 'identityState'>): IdentityEngineState {
  const st = { ...EMPTY_IDENTITY_STATE, ...(s.identityState ?? {}) };
  return { ...st, evidence: { ...EMPTY_ACCUMULATOR, ...(st.evidence ?? {}), window: [...(st.evidence?.window ?? [])] }, pendingBursts: [...(st.pendingBursts ?? [])] };
}

/** Effective policy: snapshot taken at exam start, else org default merged with the exam policy. */
/**
 * The rules a session runs under: the snapshot taken at start (accommodations included); before that the exam's rules
 * merged with the organisation default, with the session's approved accommodations applied (services/accommodations.ts).
 */
export function effectivePolicy(session: Pick<ExamSession, 'policy'> & Partial<Pick<ExamSession, 'accommodations'>>, exam: Pick<Exam, 'policy'>, org: Pick<Organization, 'settings'> | null): ProctoringPolicy {
  if (session.policy) return mergePolicy(undefined, session.policy as Record<string, unknown>);
  const examPolicy = mergePolicy(org?.settings?.defaultPolicy as Record<string, unknown> | undefined, exam.policy as Record<string, unknown>);
  return withAccommodations(examPolicy, session.accommodations).policy;
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
  private readonly identityChecksToPublish: Pick<IdentityCheck, 'id' | 'checkId' | 'trigger' | 'decision'>[] = [];
  private readonly pauseRequestsToPublish: string[] = [];
  private readonly afterCommit: (() => void | Promise<void>)[] = [];
  /** Bursts dropped undecided (resetIdentityCounters / dropPendingBursts): their frame embeddings are erased at flush. */
  private readonly droppedBurstIds = new Set<string>();
  private eraseAllUndecidedFrames = false;
  private cache: { exam?: Exam; org?: Organization | null; candidate?: Candidate; periods?: SessionPeriod[] } = {};
  /** What staff saw of the session before this mutation (dto.ts staffVisibleKey). */
  private readonly visibleBefore: string;
  /** Whether the organisation had active webhooks when the session was locked (null = unknown). */
  hasActiveWebhooks: boolean | null = null;

  constructor(
    readonly ctx: Ctx,
    readonly tx: Tx,
    public session: ExamSession,
    preloaded: SessionPreload = {},
  ) {
    this.now = ctx.now();
    this.visibleBefore = staffVisibleKey(session);
    // Rows the request already loaded (candidate auth) for this very session: exam / org / candidate.
    if (preloaded.exam?.id === session.examId) this.cache.exam = preloaded.exam;
    if (preloaded.org !== undefined && (preloaded.org?.id ?? session.orgId) === session.orgId) this.cache.org = preloaded.org;
    if (preloaded.candidate?.id === session.candidateId) this.cache.candidate = preloaded.candidate;
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

  /** The versions an identity decision made now records (same organisation row as thresholds()). */
  async decisionStamp(): Promise<DecisionStamp> {
    return decisionStamp(await this.org());
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
  /** A recorded identity decision: staff dashboards are told, and it is counted (metrics), once committed. */
  publishIdentityCheck(row: Pick<IdentityCheck, 'id' | 'checkId' | 'trigger' | 'decision'>): void {
    this.identityChecksToPublish.push(row);
  }
  publishPauseRequest(id: string): void {
    this.pauseRequestsToPublish.push(id);
  }

  /** @internal */
  async flush(): Promise<void> {
    if (this.droppedBurstIds.size || this.eraseAllUndecidedFrames) {
      // Frame embeddings of bursts that will never be decided are erased with the change that dropped them
      // (PRIVACY.md: burst-frame templates are kept only until the burst is decided).
      await this.tx
        .update(identitySampleFrames)
        .set({ embeddingEnc: null })
        .where(
          and(
            eq(identitySampleFrames.sessionId, this.session.id),
            isNull(identitySampleFrames.identityCheckId),
            isNotNull(identitySampleFrames.embeddingEnc),
            this.eraseAllUndecidedFrames ? sql`true` : inArray(identitySampleFrames.burstId, [...this.droppedBurstIds]),
          ),
        );
      this.droppedBurstIds.clear();
      this.eraseAllUndecidedFrames = false;
    }
    if (this.dirty) {
      this.patch.updatedAt = new Date(this.now);
      await this.tx.update(examSessions).set(this.patch).where(eq(examSessions.id, this.session.id));
      this.patch = {};
    }
  }

  /** Did this mutation change anything staff see in the session summary? */
  get staffVisibleChange(): boolean {
    return staffVisibleKey(this.session) !== this.visibleBefore;
  }

  /** @internal */
  runAfterCommit(): void {
    const live = this.ctx.live;
    const sid = this.session.id;
    const orgId = this.session.orgId;
    // Events / identity checks / pause requests refresh the summary themselves (counts, last decision...).
    for (const id of this.touchedEvents) live.eventChanged(id, sid, orgId);
    for (const c of this.identityChecksToPublish) {
      live.identityCheck(sid, c.id, orgId);
      this.ctx.metrics.identityDecision(c.checkId ? 'check' : 'sample', c.trigger, c.decision);
    }
    for (const id of this.pauseRequestsToPublish) live.pauseRequest(sid, id, orgId);
    // A routine heartbeat (only timestamps changed) only keeps the summary fresh at the keepalive rate.
    live.sessionChanged(sid, { orgId, visible: this.staffVisibleChange });
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
        openNoSamplesEventId: st.openNoSamplesEventId && ids.has(st.openNoSamplesEventId) ? null : (st.openNoSamplesEventId ?? null),
      });
      if (this.session.reportingEventId && ids.has(this.session.reportingEventId)) this.set({ reportingEventId: null });
    }
  }

  setIdentityState(state: IdentityEngineState): void {
    this.set({ identityState: state });
  }

  /**
   * Reset per-period identity aggregation (a new period begins: exam start, pause, hold, resume, release). When the
   * session is (again) active, the start-up sampling cadence begins and an exam_start sample is requested
   * (CandidateSessionState / HeartbeatResponse.identitySample): a swap is most likely right after a (re)start.
   * Bursts still being collected belong to the previous period; they are dropped (identity-samples.ts decides
   * frames that still arrive as late frames, without effect) and their frame embeddings erased.
   */
  resetIdentityCounters(): void {
    const st = identityState(this.session);
    const active = this.session.status === 'active';
    for (const b of st.pendingBursts) this.droppedBurstIds.add(b.id);
    this.setIdentityState({
      ...st,
      consecutiveMatch: 0,
      consecutiveMismatch: 0,
      consecutiveUnable: 0,
      followUpRequestedAt: null,
      pendingMismatchCheckIds: [],
      identicalDhashStreak: 0,
      lastSampleDhash: null,
      evidence: { ...EMPTY_ACCUMULATOR, window: [] },
      pendingBursts: [],
      secondOpinionPending: null,
      secondOpinionVeto: null,
      activeSince: active ? this.now : null,
      sampleRequest: active ? { trigger: 'exam_start', since: this.now } : null,
      cadenceMs: null,
    });
  }

  /**
   * The session ends: bursts still being collected are never decided — dropped, and every undecided frame's embedding
   * of the session erased (at flush).
   */
  dropPendingBursts(): void {
    const st = identityState(this.session);
    if (st.pendingBursts.length) this.setIdentityState({ ...st, pendingBursts: [] });
    this.eraseAllUndecidedFrames = true;
  }

  /* ---------------------------------------------------------------- commands */

  async enqueueCommand(command: CandidateCommand, targetInstanceId: string | null = null): Promise<void> {
    await this.tx.insert(sessionCommands).values({ sessionId: this.session.id, targetInstanceId, command, createdAt: new Date(this.now) });
  }
}

/** Rows a request already loaded for the session (e.g. candidate auth), reused instead of re-read in the mutation. */
export interface SessionPreload {
  exam?: Exam;
  org?: Organization | null;
  candidate?: Candidate;
}

/**
 * Run `fn` with the session row locked. Throws 404 if the session does not exist.
 * Notifications queued on the mutation are published after commit.
 */
export async function withSession<T>(ctx: Ctx, sessionId: string, fn: (m: SessionMutation) => Promise<T>, preload?: SessionPreload): Promise<T> {
  let mutation: SessionMutation | null = null;
  // Evidence stored in a transaction that rolls back is deleted again (services/evidence.ts).
  const result = await transactionWithEvidence(ctx, async (tx) => {
    // The lock query also tells whether the organisation has active webhooks (the integration outbox hook can
    // then skip its savepoint and lookups for the common "no webhooks" case).
    const [locked] = await tx
      .select({ ...getTableColumns(examSessions), hasActiveWebhooks: sql<boolean>`exists (select 1 from webhooks w where w.org_id = ${examSessions.orgId} and w.active)` })
      .from(examSessions)
      .where(eq(examSessions.id, sessionId))
      .for('no key update');
    if (!locked) throw notFound('Session not found', 'session_not_found');
    const { hasActiveWebhooks, ...row } = locked;
    const m = new SessionMutation(ctx, tx, row, preload);
    m.hasActiveWebhooks = hasActiveWebhooks;
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

/**
 * The browser stopped reporting at `last` (its last heartbeat) and the heartbeat timeout has passed: the connection is
 * offline; during an active exam a `reporting_interrupted` event opens at `last` and, under disconnect policy 'stop',
 * the clock stops there. Recorded by the sweeper, or by the browser's next heartbeat when no sweeper saw the silence
 * (every instance was down or restarting) — the outcome must not depend on which comes first.
 */
export async function recordReportingTimeout(m: SessionMutation, policy: ProctoringPolicy, last: number, detectedBy: 'sweeper' | 'late_heartbeat'): Promise<void> {
  const s = m.session;
  m.set({ connection: 'offline' });
  if (s.status !== 'active') return;
  const ev = await m.addEvent({
    type: 'reporting_interrupted',
    open: true,
    startedAt: last,
    details: { lastHeartbeatAt: last, instanceId: s.lastHeartbeatInstanceId, timerBehavior: policy.connection.disconnectTimerBehavior, ...(detectedBy === 'sweeper' ? {} : { detectedBy }) },
  });
  m.set({ reportingEventId: ev.id, reportingInterruptedSince: new Date(Math.min(last, s.reportingInterruptedSince?.getTime() ?? Infinity)) });
  if (policy.connection.disconnectTimerBehavior === 'stop') m.clockStop(Math.max(last, s.runningSince?.getTime() ?? last));
}

export function assertStatus(m: SessionMutation, allowed: SessionStatus[], message?: string): void {
  if (!allowed.includes(m.session.status)) {
    throw new HttpError(409, 'invalid_state', message ?? `This action is not possible while the exam is ${m.session.status.replace('_', ' ')}`, { status: m.session.status });
  }
}

/** ready -> active: clock starts, active period opens, policy snapshot taken. */
export async function startExam(m: SessionMutation): Promise<void> {
  assertStatus(m, ['ready'], 'The exam can only be started after the readiness check');
  // The attempt is pinned to the exam's current version (questions, answer keys, the exam's own rules) for good:
  // later edits of the exam never reach it (services/exam-versions.ts).
  const pinned = m.session.examVersionId ? await loadVersion(m.tx, m.session.examVersionId) : null;
  const version = pinned ?? (await versionForStart(m.tx, m.session.examId, m.now));
  const org = await m.org();
  // Approved accommodations as of now (a grant or revocation up to the very start counts), then frozen with the policy.
  await refreshSessionAccommodations(m);
  const examPolicy = mergePolicy(org?.settings?.defaultPolicy as Record<string, unknown> | undefined, version.policy as Record<string, unknown>);
  const acc = m.session.accommodations;
  const { policy, exceptions } = withAccommodations(examPolicy, acc, m.session.durationMs);
  // Admission at exam start (candidate-actions.ts startSession) may have held the start back while the server was busy.
  const deferredMs = m.session.startDeferredSince ? Math.max(0, m.now - m.session.startDeferredSince.getTime()) : null;
  m.set({
    status: 'active',
    startedAt: m.session.startedAt ?? new Date(m.now),
    examVersionId: version.id,
    policy,
    accommodations: acc?.items.length ? { ...acc, exceptions } : null,
    currentQuestionIndex: m.session.currentQuestionIndex ?? 0,
    startDeferredSince: null,
  });
  m.clockStart();
  await m.switchPeriod('active', m.now);
  m.resetIdentityCounters();
  await m.addEvent({
    type: 'session_started',
    details: { durationMs: m.session.durationMs, ...(deferredMs != null ? { startDeferredMs: deferredMs } : {}) },
    ...(deferredMs != null
      ? { observation: `The exam was started. The start was held back ${Math.round(deferredMs / 1000)} s while the server was busy; the exam clock started only now.` }
      : {}),
  });
  if (acc?.items.length) {
    const labels = acc.items.map((i) => ACCOMMODATION_CATALOG[i.kind].label(i.params));
    await m.addEvent({
      type: 'accommodations_applied',
      observation: `Approved accommodations were applied: ${labels.join('; ')}.`,
      details: { items: acc.items.map((i, n) => ({ id: i.id, kind: i.kind, label: labels[n], params: i.params })), extraTimeMs: acc.extraTimeMs, exceptions },
    });
  }
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
  staff_verification: 'A staff member will now verify your identity, as arranged with your organisation. Please keep this page open. The exam clock is stopped.',
  resume_limit:
    'Your exam was interrupted more often or for longer than the exam rules allow, so it is on hold. An administrator needs to approve before you can continue. Your answers and remaining time are saved.',
  recovery: 'An administrator has reopened your exam. Complete the camera and identity check to continue where you stopped. Your answers are saved, and the exam clock starts again only after the check.',
};

/** Put the session on hold (clock stopped, on_hold period opens, candidate gets a 'hold' command). */
export async function holdNow(
  m: SessionMutation,
  opts: { reason: HoldReason; message?: string; canReverify?: boolean; source?: EventSource; details?: Record<string, unknown>; by?: string | null; /** Timeline wording (default: the catalog's). */ observation?: string },
): Promise<void> {
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
  await m.addEvent({ type: 'session_held', source: opts.source ?? 'server_system', observation: opts.observation, details: { reason: opts.reason, previousStatus: prev, by: opts.by ?? null, ...(opts.details ?? {}) } });
  await m.enqueueCommand({ kind: 'hold', hold: { reason: opts.reason, since: m.session.holdSince?.getTime() ?? at, message, canReverify: opts.canReverify ?? false } });
}

/**
 * End the session (submitted / terminated). Clock stops, all open periods/events close, answers are graded.
 */
export async function finalizeSession(
  m: SessionMutation,
  endReason: SessionEndReason,
  opts: { by?: string | null; note?: string | null; /** 'abandoned' / 'candidate_withdrew' / 'resume_limit' only */ observation?: string; details?: Record<string, unknown>; candidateMessage?: string } = {},
): Promise<void> {
  if (TERMINAL.includes(m.session.status)) return;
  // Time expiry is recorded at the moment the clock ran out (the sweeper may run a few seconds later).
  const rs = m.session.runningSince?.getTime();
  const at = endReason === 'time_expired' && rs != null ? Math.max(rs, Math.min(m.now, rs + m.session.durationMs - m.session.usedMs)) : m.now;
  m.clockStop(at);
  // 'abandoned' (housekeeping after inactivity) and 'candidate_withdrew' (consent withdrawn) end as terminated so no
  // score is implied; answers are kept.
  const status: SessionStatus = endReason === 'staff_terminated' || endReason === 'abandoned' || endReason === 'candidate_withdrew' ? 'terminated' : 'submitted';
  await closeReportingGapAtEnd(m, at, endReason);
  await m.closeOpenEvents(at, 'session_end');
  await m.closeOpenPeriod(at);
  await m.tx
    .update(pauseRequests)
    .set({ status: 'cancelled', decidedAt: new Date(at) })
    .where(and(eq(pauseRequests.sessionId, m.session.id), eq(pauseRequests.status, 'pending')));
  const wasStarted = m.session.startedAt != null;
  m.dropPendingBursts();
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
  } else if (endReason === 'candidate_withdrew') {
    // services/privacy-requests.ts withdrawConsent: the candidate's own decision, not an integrity observation.
    await m.addEvent({
      type: 'session_terminated',
      source: 'server_system',
      startedAt: at,
      observation: opts.observation ?? 'The candidate withdrew their consent, so the exam ended. Its face images and templates were deleted.',
      details: { reason: 'consent_withdrawn', ...(opts.details ?? {}) },
    });
    await m.enqueueCommand({ kind: 'terminated', message: opts.candidateMessage ?? 'You withdrew your consent, so your exam has ended.' });
  } else {
    // 'resume_limit' (services/recovery.ts): the resume policy ended the exam; submitted and graded like a time expiry.
    await m.addEvent({ type: 'session_submitted', startedAt: at, source: 'server_system', observation: opts.observation, details: { endReason, by: opts.by ?? null, note: opts.note ?? null, ...(opts.details ?? {}) } });
    if (endReason !== 'candidate_submitted') await m.enqueueCommand({ kind: 'submitted', reason: endReason });
  }
  if (wasStarted && endReason !== 'abandoned' && endReason !== 'candidate_withdrew') {
    const score = await gradeSession(m.tx, m.session, at);
    m.set({ score });
  }
}

const CLIENT_EVENT_SOURCES = ['client_browser', 'client_vision'] as const;

/**
 * The exam ends while the candidate's browser is not reporting (reporting_interrupted still open) and nothing it
 * captured since the last heartbeat has arrived late: from that heartbeat on nothing was observed. As a reconnect
 * check does for the gap it closes (checks.ts closeGapPeriods), the active time from there to the end becomes a
 * 'disconnected' (unobserved) period, reason 'browser_not_returned', and the episodes the gone browser left open
 * end where its observation ended (details.closedBy 'browser_not_returned') instead of spanning the gap.
 * services/reporting-gaps.ts explains the rule; the report derives the same split where it was not materialised.
 */
async function closeReportingGapAtEnd(m: SessionMutation, at: number, endReason: SessionEndReason): Promise<void> {
  const evId = m.session.reportingEventId;
  if (!evId) return;
  const [ev] = await m.tx
    .select({ id: events.id, startedAt: events.startedAt, status: events.status })
    .from(events)
    .where(and(eq(events.id, evId), eq(events.sessionId, m.session.id)));
  if (!ev || ev.status !== 'open') return;
  const gapStart = ev.startedAt.getTime();
  if (at <= gapStart) return;
  const gap = { start: gapStart, end: at };
  // The browser was still capturing (its outbox delivered something from the gap late): observed, nothing to do.
  if (capturesWithin(await loadLateCaptures(m.tx, m.session.id, gap), gap).length) return;
  const active = (await m.periods()).filter((p) => p.kind === 'active' && p.startedAt.getTime() < at && (p.endedAt == null || p.endedAt.getTime() > gapStart));
  if (!active.length) return;
  const open = await m.tx
    .select({ id: events.id, startedAt: events.startedAt, details: events.details })
    .from(events)
    .where(and(eq(events.sessionId, m.session.id), eq(events.status, 'open'), inArray(events.source, [...CLIENT_EVENT_SOURCES])));
  for (const e of open) {
    await m.updateEvent(e.id, { status: 'closed', endedAt: new Date(Math.max(e.startedAt.getTime(), gapStart)), details: { ...e.details, closedBy: GAP_NOT_RETURNED } });
  }
  for (const p of active) {
    const from = Math.max(p.startedAt.getTime(), gapStart);
    const to = Math.min(p.endedAt?.getTime() ?? at, at);
    if (!p.endedAt) {
      await m.closeOpenPeriod(from);
    } else if (p.endedAt.getTime() > from) {
      // A hold / pause began while the browser was already gone: the tail of that active period was not observed.
      await m.tx.update(sessionPeriods).set({ endedAt: new Date(from) }).where(eq(sessionPeriods.id, p.id));
      p.endedAt = new Date(from);
    }
    if (to > from) await m.insertPeriod('disconnected', from, { endedAt: to, reason: GAP_NOT_RETURNED, meta: { reportingEventId: ev.id, endReason } });
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


/**
 * Candidate lifecycle actions: consent, start, answers, heartbeat (+command delivery), pause, submit.
 */
import {
  DEFAULT_POLICY,
  EVENT_TYPES,
  PRIVACY_NOTICE_VERSION,
  type EventType,
  type CandidateCommand,
  type ConsentRequest,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type PauseResponse,
  type ProctoringPolicy,
  type SaveAnswerRequest,
  type SaveAnswerResponse,
} from '@sp/shared';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { answers, examSessions, pauseRequests, questions, sessionCommands, type ExamSession, type Question } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, invalidState, notFound, validationFailed } from '../lib/errors.js';
import { assertInControl, buildCandidateState, instanceInControl, SUPERSEDED_MESSAGE } from './candidate-state.js';
import { recordMultipleInstances } from './checks.js';
import { applyInstanceUsage, evaluateInstanceUsage } from './instance-usage.js';
import { identitySampleRequest, sampleWatchdog } from './identity-evidence.js';
import { remainingMs, sessionClock, staffVisibleKey } from './dto.js';
import { assertStatus, finalizeSession, identityState, pauseNow, pendingPauseRequest, requiredCheckFor, startExam, TERMINAL, withSession, type SessionMutation } from './session-state.js';
import { clockExpired } from '@sp/shared';

export const OUTBOX_DELAY_MS = 30_000;

/* ------------------------------------------------------------------ consent */

export async function acceptConsent(ctx: Ctx, sessionId: string, body: ConsentRequest, meta: { ip: string; userAgent: string }): Promise<void> {
  if (body.noticeVersion !== PRIVACY_NOTICE_VERSION) throw conflict('notice_outdated', 'The privacy notice has been updated. Please read the current version.', { currentVersion: PRIVACY_NOTICE_VERSION });
  await withSession(ctx, sessionId, async (m) => {
    if (TERMINAL.includes(m.session.status)) throw invalidState('The exam has ended');
    if (m.session.consentAcceptedAt) return;
    m.set({ consentAcceptedAt: new Date(m.now), consentNoticeVersion: body.noticeVersion, consentIp: meta.ip, consentUserAgent: meta.userAgent.slice(0, 500) });
    await audit(m.tx, { orgId: m.session.orgId, actorType: 'candidate', action: 'candidate.consent', targetType: 'session', targetId: m.session.id, meta: { noticeVersion: body.noticeVersion }, ip: meta.ip, at: m.now });
  });
}

/* ------------------------------------------------------------------ start / submit */

export async function startSession(ctx: Ctx, sessionId: string, instanceId: string): Promise<void> {
  await withSession(ctx, sessionId, async (m) => {
    assertInControl(m.session, instanceId);
    await startExam(m);
  });
}

export async function candidateSubmit(ctx: Ctx, sessionId: string, instanceId: string): Promise<void> {
  await withSession(ctx, sessionId, async (m) => {
    if (m.session.status === 'submitted') return; // idempotent
    assertInControl(m.session, instanceId);
    assertStatus(m, ['active'], 'The exam can only be submitted while it is in progress');
    await finalizeSession(m, 'candidate_submitted');
  });
}

/* ------------------------------------------------------------------ answers */

function validateAnswer(q: Question, value: SaveAnswerRequest['value']): void {
  if (value === null) return;
  const optionIds = new Set((q.options ?? []).map((o) => o.id));
  switch (q.type) {
    case 'single_choice':
      if (typeof value !== 'string' || !optionIds.has(value)) throw validationFailed('Answer must be one of the question options');
      return;
    case 'multiple_choice':
      if (!Array.isArray(value) || value.some((v) => !optionIds.has(v)) || new Set(value).size !== value.length) throw validationFailed('Answer must be a list of distinct question options');
      return;
    case 'short_text':
      if (typeof value !== 'string' || value.length > 2000) throw validationFailed('Answer must be text (max 2000 characters)');
      return;
    case 'long_text':
      if (typeof value !== 'string') throw validationFailed('Answer must be text');
      return;
    case 'numeric':
      if (typeof value === 'number' && Number.isFinite(value)) return;
      if (typeof value === 'string' && value.length <= 100) return; // allow partially typed input; graded leniently
      throw validationFailed('Answer must be a number');
  }
}

export async function saveAnswer(ctx: Ctx, session: ExamSession, instanceId: string, questionId: string, body: SaveAnswerRequest): Promise<SaveAnswerResponse> {
  const [q] = await ctx.db.select().from(questions).where(and(eq(questions.id, questionId), eq(questions.examId, session.examId)));
  if (!q) throw notFound('Question not found', 'question_not_found');
  validateAnswer(q, body.value);
  return withSession(ctx, session.id, async (m) => {
    const s = m.session;
    assertInControl(s, instanceId);
    const now = m.now;
    const answeredAt = Math.min(Number.isFinite(body.answeredAt) ? body.answeredAt : now, now);
    if (s.status !== 'active') {
      // Late delivery: answers given before the current pause / hold began are still accepted.
      const open = await m.openPeriodRow();
      const allowed = (s.status === 'paused' || s.status === 'on_hold') && open && !open.observed && answeredAt <= open.startedAt.getTime();
      if (!allowed) throw conflict(TERMINAL.includes(s.status) ? 'exam_ended' : 'invalid_state', 'Answers cannot be saved right now', { status: s.status });
    }
    const rows = await m.tx
      .insert(answers)
      .values({ sessionId: s.id, questionId, value: body.value, clientSeq: body.clientSeq, answeredAt: new Date(answeredAt), savedAt: new Date(now) })
      .onConflictDoUpdate({
        target: [answers.sessionId, answers.questionId],
        set: { value: body.value, clientSeq: body.clientSeq, answeredAt: new Date(answeredAt), savedAt: new Date(now) },
        setWhere: sql`${answers.clientSeq} < ${body.clientSeq}`,
      })
      .returning({ clientSeq: answers.clientSeq });
    if (rows.length) return { saved: true, applied: true, serverSeq: rows[0].clientSeq };
    const [cur] = await m.tx.select({ clientSeq: answers.clientSeq }).from(answers).where(and(eq(answers.sessionId, s.id), eq(answers.questionId, questionId)));
    return { saved: true, applied: false, serverSeq: cur?.clientSeq ?? body.clientSeq };
  });
}

/* ------------------------------------------------------------------ pause */

export async function requestPause(ctx: Ctx, sessionId: string, instanceId: string, reason: string | undefined): Promise<Omit<PauseResponse, 'state'>> {
  return withSession(ctx, sessionId, async (m) => {
    assertInControl(m.session, instanceId);
    assertStatus(m, ['active'], 'The exam can only be paused while it is in progress');
    const policy = await m.policy();
    const p = policy.pause;
    const why = reason?.trim() || null;
    if (!p.allowed) return { outcome: 'denied', message: 'Pausing is not allowed for this exam.' };
    if (p.maxPauses != null && m.session.pauseCount >= p.maxPauses) return { outcome: 'denied', message: `You have used all ${p.maxPauses} pause(s) allowed for this exam.` };
    if (p.requireReason && !why) throw badRequest('Please give a reason for the pause.', undefined, 'reason_required');
    const pending = await pendingPauseRequest(m.tx, m.session.id);
    if (pending) return { outcome: 'pending_approval', message: 'Your pause request is waiting for an administrator. Keep working until it is approved.' };
    if (p.requireApproval) {
      const [req] = await m.tx.insert(pauseRequests).values({ sessionId: m.session.id, requestedAt: new Date(m.now), reason: why, status: 'pending' }).returning();
      await m.addEvent({ type: 'pause_requested', details: { requestId: req.id, reason: why } });
      m.publishPauseRequest(req.id);
      return { outcome: 'pending_approval', message: 'Your pause request was sent to an administrator. Keep working until it is approved.' };
    }
    await pauseNow(m, { reason: why });
    return {
      outcome: 'paused',
      message:
        p.timerBehavior === 'stop'
          ? 'Your exam is paused and the timer is stopped. You can close this window; when you return you will repeat the camera and identity check.'
          : 'Your exam is paused. The timer keeps running during the pause. When you return you will repeat the camera and identity check.',
    };
  });
}

export async function cancelPauseRequest(ctx: Ctx, sessionId: string, instanceId: string): Promise<void> {
  await withSession(ctx, sessionId, async (m) => {
    assertInControl(m.session, instanceId);
    const pending = await pendingPauseRequest(m.tx, m.session.id);
    if (!pending) return;
    await m.tx.update(pauseRequests).set({ status: 'cancelled', decidedAt: new Date(m.now) }).where(eq(pauseRequests.id, pending.id));
    m.publishPauseRequest(pending.id);
  });
}

/* ------------------------------------------------------------------ heartbeat */

/** The session row as the request loaded it, with its row version (candidate auth). */
export interface LoadedSession {
  session: ExamSession;
  sessionVersion: string;
  /** Effective policy as loaded with the session (candidate auth); used for identitySample (cadence, burst size). */
  policy?: ProctoringPolicy;
}

type HeartbeatClient = { ip: string; userAgent: string };

function heartbeatMonitoring(body: HeartbeatRequest, now: number): NonNullable<ExamSession['monitoring']> {
  const mon = body.monitoring;
  return {
    state: mon.state,
    faces: mon.faces,
    label: mon.label,
    open: mon.open.filter((t): t is EventType => (EVENT_TYPES as readonly string[]).includes(t)).slice(0, 50),
    at: now,
    fps: mon.fps,
    cameraState: mon.cameraState,
    visibility: body.visibility,
    fullscreen: body.fullscreen,
  };
}

function reportingInterruptedSince(body: HeartbeatRequest, s: ExamSession, now: number): Date | null {
  // Outbox delay (browser online but uploads failing / queued): shown as "reporting interrupted since".
  const delayed = body.outboxOldestAt != null && body.outboxSize > 0 && now - body.outboxOldestAt > OUTBOX_DELAY_MS;
  return delayed ? new Date(Math.min(body.outboxOldestAt!, s.reportingInterruptedSince?.getTime() ?? Infinity)) : null;
}

/**
 * The common heartbeat — nothing to deliver, nothing to open/close, no concurrent-use signal, clock not
 * expired — as ONE conditional UPDATE instead of a locking transaction. The row must still be the version the
 * request loaded (xmin guard); anything else (commands pending, a concurrent change, a state transition) returns
 * null and the caller runs the full locked heartbeat, which produces exactly the same result.
 */
async function fastHeartbeat(ctx: Ctx, loaded: LoadedSession, instanceId: string, body: HeartbeatRequest, client: HeartbeatClient | undefined): Promise<HeartbeatResponse | null> {
  const s = loaded.session;
  const now = ctx.now();
  if (s.activeInstanceId && s.activeInstanceId !== instanceId) return null; // superseded window
  const inControl = instanceInControl(s, instanceId) && !TERMINAL.includes(s.status);
  if (inControl && (s.reportingEventId || (s.status === 'active' && !s.runningSince))) return null;
  // Identity samples overdue long enough for an observation: the locked path records it.
  if (inControl && noSamplesObservationDue(s, (loaded.policy ?? DEFAULT_POLICY).identity, body, now)) return null;
  if ((s.status === 'active' || s.status === 'paused') && clockExpired(sessionClock(s), now)) return null;
  const usage = client ? evaluateInstanceUsage(s, instanceId, { ...client, seq: body.seq, at: now, refresh: true }) : null;
  if (usage?.signal) return null;

  const patch: Partial<typeof examSessions.$inferInsert> = { lastHeartbeatAt: new Date(now), lastHeartbeatInstanceId: instanceId, connection: 'online' };
  if (usage?.changed) patch.instanceUsage = usage.usage;
  if (inControl) {
    patch.lastVerifiedHeartbeatAt = new Date(now);
    patch.monitoring = heartbeatMonitoring(body, now);
    if (body.currentQuestionIndex != null) patch.currentQuestionIndex = body.currentQuestionIndex;
    patch.reportingInterruptedSince = reportingInterruptedSince(body, s, now);
  }
  patch.updatedAt = new Date(now);
  const rows = await ctx.db
    .update(examSessions)
    .set(patch)
    .where(and(eq(examSessions.id, s.id), sql`${examSessions}.xmin::text = ${loaded.sessionVersion}`))
    .returning({
      // (spelled out: drizzle renders columns unqualified in UPDATE ... RETURNING)
      pendingCommands: sql<boolean>`exists (select 1 from session_commands c where c.session_id = exam_sessions.id and c.delivered_at is null and (c.target_instance_id is null or c.target_instance_id = ${instanceId}))`,
    });
  if (!rows.length || rows[0].pendingCommands) return null; // changed meanwhile / commands to deliver: full path
  const after = { ...s, ...patch } as ExamSession;
  ctx.live.sessionChanged(s.id, { orgId: s.orgId, visible: staffVisibleKey(after) !== staffVisibleKey(s) });
  return {
    serverTime: now,
    status: s.status,
    remainingMs: remainingMs(s, now),
    timerRunning: s.runningSince != null,
    requiredCheck: requiredCheckFor(s, instanceId),
    commands: [],
    identitySample: inControl ? identitySampleRequest(s.status, s.identityState, (loaded.policy ?? DEFAULT_POLICY).identity, now) : null,
  };
}

/**
 * The session is active and connected (this heartbeat), yet no identity sample arrived although the server has been
 * asking (identity-evidence.ts sampleWatchdog 'unanswered') and nothing explains it (no reporting outage, the outbox
 * is not holding a backlog), and no such observation is open yet.
 */
function noSamplesObservationDue(s: ExamSession, policy: ProctoringPolicy['identity'], body: HeartbeatRequest, now: number): boolean {
  if (s.status !== 'active' || s.reportingEventId || reportingInterruptedSince(body, s, now)) return false;
  const st = identityState(s);
  return !st.openNoSamplesEventId && sampleWatchdog(policy, st, now) === 'unanswered';
}

/** Open the 'no_samples' observation (uncertain, never evidence of a different person); closed by the next sample. */
async function recordNoSamples(m: SessionMutation, policy: ProctoringPolicy['identity'], body: HeartbeatRequest): Promise<void> {
  const st = identityState(m.session);
  const last = st.evidence.lastSampleAt ?? st.activeSince ?? m.now;
  const ev = await m.addEvent({
    type: 'identity_unverifiable',
    source: 'server_identity',
    open: true,
    startedAt: last,
    confidence: null,
    observation:
      'No identity images arrived from the candidate’s browser for a while although the exam was running and the browser was connected; the server’s requests for one went unanswered. The identity could not be checked in this time. This is not evidence of a different person.',
    details: {
      reason: 'no_samples',
      lastSampleAt: st.evidence.lastSampleAt,
      activeSince: st.activeSince,
      expectedIntervalSec: policy.periodicCheckIntervalSec,
      cameraState: body.monitoring?.cameraState ?? null,
      facesInView: body.monitoring?.faces ?? null,
    },
  });
  m.setIdentityState({ ...identityState(m.session), openNoSamplesEventId: ev.id });
}

export async function heartbeat(ctx: Ctx, sessionId: string, instanceId: string, body: HeartbeatRequest, client?: HeartbeatClient, loaded?: LoadedSession): Promise<HeartbeatResponse> {
  if (body.clientInstanceId && body.clientInstanceId !== instanceId) throw badRequest('clientInstanceId does not match the X-Client-Instance header', undefined, 'instance_mismatch');
  if (loaded && loaded.session.id === sessionId) {
    const fast = await fastHeartbeat(ctx, loaded, instanceId, body, client);
    if (fast) return fast;
  }
  return withSession(ctx, sessionId, async (m) => {
    const s = m.session;
    const now = m.now;
    const commands: CandidateCommand[] = [];

    const deliver = async (onlyTargeted: boolean) => {
      const rows = await m.tx
        .select()
        .from(sessionCommands)
        .where(
          and(
            eq(sessionCommands.sessionId, s.id),
            isNull(sessionCommands.deliveredAt),
            onlyTargeted ? eq(sessionCommands.targetInstanceId, instanceId) : or(isNull(sessionCommands.targetInstanceId), eq(sessionCommands.targetInstanceId, instanceId)),
          ),
        )
        .orderBy(asc(sessionCommands.id))
        .limit(50);
      for (const r of rows) {
        commands.push(r.command);
        await m.tx.update(sessionCommands).set({ deliveredAt: new Date(now) }).where(eq(sessionCommands.id, r.id));
      }
    };

    const superseded = !!s.activeInstanceId && s.activeInstanceId !== instanceId;
    if (superseded) {
      await deliver(true);
      // The old window is demonstrably still open while another one took over.
      if (commands.some((c) => c.kind === 'superseded') && !TERMINAL.includes(s.status)) {
        await recordMultipleInstances(m, instanceId, s.activeInstanceId!, { detectedBy: 'old_instance_still_active' });
      }
      if (!commands.some((c) => c.kind === 'superseded')) commands.push({ kind: 'superseded', message: SUPERSEDED_MESSAGE });
      return { serverTime: now, status: s.status, remainingMs: remainingMs(s, now), timerRunning: s.runningSince != null, requiredCheck: requiredCheckFor(s, instanceId), commands };
    }

    m.set({ lastHeartbeatAt: new Date(now), lastHeartbeatInstanceId: instanceId, connection: 'online' });
    // Same verified instance id used from two places at once (copied id): IP/UA/seq (services/instance-usage.ts).
    // A signal clears verifiedInstanceId, so the block below is skipped and a reconnect check is required.
    if (client) await applyInstanceUsage(m, instanceId, { ...client, seq: body.seq, at: now, refresh: true });
    if (instanceInControl(s, instanceId) && !TERMINAL.includes(s.status)) {
      m.set({
        lastVerifiedHeartbeatAt: new Date(now),
        monitoring: heartbeatMonitoring(body, now),
        ...(body.currentQuestionIndex != null ? { currentQuestionIndex: body.currentQuestionIndex } : {}),
      });
      // Back after an outage: close reporting_interrupted and restart a disconnect-stopped clock.
      if (s.reportingEventId) {
        await m.closeEvent(s.reportingEventId, now, { closedBy: 'heartbeat_resumed' });
        m.set({ reportingEventId: null });
      }
      if (s.status === 'active' && !s.runningSince) m.clockStart(now);
      m.set({ reportingInterruptedSince: reportingInterruptedSince(body, s, now) });
    }
    // Clock expiry is enforced here as well as by the sweeper.
    if ((s.status === 'active' || s.status === 'paused') && clockExpired(sessionClock(s), now)) await finalizeSession(m, 'time_expired');
    await deliver(false);
    const inControl = instanceInControl(m.session, instanceId) && !TERMINAL.includes(m.session.status);
    const policy = await m.policy();
    if (inControl && noSamplesObservationDue(m.session, policy.identity, body, now)) await recordNoSamples(m, policy.identity, body);
    return {
      serverTime: now,
      status: m.session.status,
      remainingMs: remainingMs(m.session, now),
      timerRunning: m.session.runningSince != null,
      requiredCheck: requiredCheckFor(m.session, instanceId),
      commands,
      identitySample: inControl ? identitySampleRequest(m.session.status, m.session.identityState, policy.identity, now) : null,
    };
  });
}

export { buildCandidateState };

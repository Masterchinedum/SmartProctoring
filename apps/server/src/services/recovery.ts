/**
 * Candidate recovery (roadmap #13): the per-exam resume policy and the staff "reopen for recovery" action.
 *
 * Resume policy (packages/shared/src/policy.ts `resume`; defaults: no limits) — interruptions of an exam in progress
 * that are not formal pauses:
 *  - maxReconnects: a reconnect check passed during the exam (the exam reopened in a new browser window) counts once
 *    (`exam_sessions.reconnect_count`, checks.ts). When the count has reached the limit, the NEXT reconnect check is
 *    not started: `enforceReconnectLimits` applies the limit first (checks.ts startCheck → 409 resume_limit_reached,
 *    the candidate app reloads its state and shows the hold / ended screen).
 *  - maxOfflineMinutes: no heartbeat from any browser for longer than this, measured from the last heartbeat or from
 *    when the exam last continued (the open active period's start: a release, a passed check), whichever is later.
 *    Applied by the sweeper (`enforceOfflineLimits`, jobs/sweeper.ts), again when the candidate comes back
 *    (`enforceReconnectLimits`), and by the browser's next heartbeat when no sweeper saw the silence (`applyOfflineLimit`:
 *    every instance was down or restarting). Only active exams: a formal pause has its own limit (pause.maxPauseDurationSec), and a
 *    held exam waits for staff anyway.
 *  - onLimit 'hold' (default): `holdNow` with reason 'resume_limit' (clock stopped; staff release it — the reconnect
 *    allowance then starts again — or terminate). 'end': `finalizeSession(m, 'resume_limit')` — submitted, graded,
 *    the candidate is told why. Staff can reopen it for recovery.
 *
 * Reopen for recovery (`reopenSession`, POST /api/admin/sessions/:id/reopen, admin): an ended exam whose end reason
 * allows it (REOPENABLE_END_REASONS — time ran out, staff ended it, abandoned, the resume policy) and whose evidence
 * still exists (shared reopenEligibility) is put back:
 *  - started exams go on hold (reason 'recovery', `holdCanReverify`): the candidate must pass a fresh camera, live-person
 *    and identity check against the ORIGINAL reference (the 'reverify' check — a reconnect check is tied to replacing a
 *    browser window and counts against maxReconnects; this one does not) before the exam continues with its answers
 *    and remaining time (+ the minutes added). The period from the old end to the check is an unobserved 'on_hold'
 *    period. The score is cleared (recorded in the event) and computed again when the exam ends again;
 *  - exams that never started return to the check-in ('invited').
 * Both reset the reconnect count, add a neutral `session_reopened` timeline event (→ `session.reopened` webhook,
 * without the staff reason) and a `session.reopened` audit entry. Refused (409 with the refusal code) for a
 * candidate's own submission, a withdrawn consent, purged evidence (retention), a completed review (reopen the review
 * first) or a missing identity reference; and when no exam time would be left (`no_time_left`: add minutes).
 */
import { REOPEN_MIN_REMAINING_MS, reopenEligibility, type ProctoringPolicy, type ReopenEligibilityDTO, type ReopenRequest, type SessionEndReason, type SessionSummaryDTO } from '@sp/shared';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import type { DbOrTx } from '../db/index.js';
import { examSessions, identityReferences, sessionReviews, type ExamSession } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import { loadSessionSummary, ms, remainingMs } from './dto.js';
import { clearedHold, type Actor } from './session-actions.js';
import { finalizeSession, HOLD_MESSAGES, holdNow, requiredCheckFor, withSession, type SessionMutation } from './session-state.js';

const BATCH = 200;

/* =================================================================== resume policy */

export type ResumeLimit = { kind: 'reconnects'; reconnects: number; maxReconnects: number } | { kind: 'offline'; offlineSince: number; offlineMs: number; maxOfflineMinutes: number };

/** Message the candidate sees on the hold screen when a limit holds the exam. */
export function resumeLimitHoldMessage(limit: ResumeLimit): string {
  const what =
    limit.kind === 'offline'
      ? `Your exam was disconnected for longer than the exam rules allow (${limit.maxOfflineMinutes} min)`
      : limit.maxReconnects === 0
        ? 'Your exam was opened again in a new browser window, which the exam rules do not allow'
        : `Your exam was opened in a new browser window more often than the exam rules allow (${limit.maxReconnects} ${limit.maxReconnects === 1 ? 'time' : 'times'})`;
  return `${what}, so it is on hold. An administrator needs to approve before you can continue. Your answers and remaining time are saved.`;
}

function limitObservation(limit: ResumeLimit, ended: boolean): string {
  const what =
    limit.kind === 'offline'
      ? `No browser reported for ${Math.round(limit.offlineMs / 60_000)} min during the exam; the exam rules allow ${limit.maxOfflineMinutes} min.`
      : limit.maxReconnects === 0
        ? 'The exam was about to be reopened in a new browser window; the exam rules allow no reconnections.'
        : `The exam was about to be reopened in a new browser window again after ${limit.reconnects} reconnection${limit.reconnects === 1 ? '' : 's'}; the exam rules allow ${limit.maxReconnects}.`;
  return ended ? `${what} Under the exam's resume rules the exam ended and the saved answers were submitted.` : `${what} Under the exam's resume rules the exam was put on hold for staff review.`;
}

/** Hold or end the exam under the resume policy (`policy.resume.onLimit`). */
export async function applyResumeLimit(m: SessionMutation, policy: ProctoringPolicy, limit: ResumeLimit): Promise<void> {
  const details = { limit: limit.kind, onLimit: policy.resume.onLimit, ...limitDetails(limit) };
  if (policy.resume.onLimit === 'end') {
    await finalizeSession(m, 'resume_limit', { observation: limitObservation(limit, true), details });
  } else {
    await holdNow(m, { reason: 'resume_limit', message: resumeLimitHoldMessage(limit), details, observation: limitObservation(limit, false) });
  }
}

function limitDetails(limit: ResumeLimit): Record<string, unknown> {
  return limit.kind === 'reconnects'
    ? { reconnects: limit.reconnects, maxReconnects: limit.maxReconnects }
    : { offlineSince: limit.offlineSince, offlineMs: limit.offlineMs, maxOfflineMinutes: limit.maxOfflineMinutes };
}

/**
 * Since when the exam has had no browser reporting: the last heartbeat, or the moment the exam last continued (the
 * open active period started — a hold released without a check, a passed check), whichever is later.
 */
async function offlineSince(m: SessionMutation): Promise<number> {
  const open = await m.openPeriodRow();
  return Math.max(m.session.lastHeartbeatAt?.getTime() ?? 0, open?.kind === 'active' ? open.startedAt.getTime() : 0, m.session.startedAt?.getTime() ?? 0);
}

async function offlineLimit(m: SessionMutation, policy: ProctoringPolicy): Promise<ResumeLimit | null> {
  const max = policy.resume.maxOfflineMinutes;
  if (max == null || m.session.status !== 'active') return null;
  const since = await offlineSince(m);
  const offlineMs = m.now - since;
  return offlineMs > max * 60_000 ? { kind: 'offline', offlineSince: since, offlineMs, maxOfflineMinutes: max } : null;
}

/**
 * The offline limit for a heartbeat that finds its browser silent past the heartbeat timeout with no sweeper having
 * noticed (every instance was down or restarting; candidate-actions.ts heartbeat, right after it recorded the outage):
 * applied as the sweeper's offline step would have, so the outcome does not depend on which of the two comes first.
 * True when the limit held or ended the exam.
 */
export async function applyOfflineLimit(m: SessionMutation, policy: ProctoringPolicy): Promise<boolean> {
  const limit = await offlineLimit(m, policy);
  if (!limit) return false;
  await applyResumeLimit(m, policy, limit);
  return true;
}

/**
 * A new browser window is about to start a reconnect check during the exam: apply the resume policy first (offline too
 * long, or no reconnections left). Returns the candidate-facing message when a limit was applied (the caller answers
 * 409 resume_limit_reached after this commits), else null.
 */
export async function enforceReconnectLimits(ctx: Ctx, sessionId: string, instanceId: string): Promise<{ message: string } | null> {
  return withSession(ctx, sessionId, async (m) => {
    const s = m.session;
    if (s.status !== 'active' || requiredCheckFor(s, instanceId) !== 'reconnect') return null;
    const policy = await m.policy();
    const max = policy.resume.maxReconnects;
    const limit: ResumeLimit | null = (await offlineLimit(m, policy)) ?? (max != null && s.reconnectCount >= max ? { kind: 'reconnects', reconnects: s.reconnectCount, maxReconnects: max } : null);
    if (!limit) return null;
    await applyResumeLimit(m, policy, limit);
    return {
      message:
        policy.resume.onLimit === 'end'
          ? 'Your exam was interrupted more often or for longer than the exam rules allow, so it has ended and your saved answers were submitted.'
          : resumeLimitHoldMessage(limit),
    };
  });
}

/**
 * Sweeper step: active exams disconnected for longer than their policy's maxOfflineMinutes. The SQL pre-filter reads
 * the policy snapshot taken at start (every active session has one; older snapshots without `resume` have no limit)
 * and the last heartbeat; the locked re-check also counts from when the exam last continued.
 */
export async function enforceOfflineLimits(ctx: Ctx): Promise<number> {
  const now = new Date(ctx.now());
  const maxMinutes = sql`(${examSessions.policy} -> 'resume' ->> 'maxOfflineMinutes')`;
  const due = await ctx.db
    .select({ id: examSessions.id })
    .from(examSessions)
    .where(
      and(
        eq(examSessions.status, 'active'),
        eq(examSessions.connection, 'offline'),
        sql`jsonb_typeof(${examSessions.policy} -> 'resume' -> 'maxOfflineMinutes') = 'number'`,
        sql`coalesce(${examSessions.lastHeartbeatAt}, ${examSessions.startedAt}) < ${now}::timestamptz - make_interval(mins => (${maxMinutes})::int)`,
      ),
    )
    .limit(BATCH);
  let applied = 0;
  for (const { id } of due) {
    try {
      const done = await withSession(ctx, id, async (m) => {
        if (m.session.status !== 'active' || m.session.connection !== 'offline') return false;
        const policy = await m.policy();
        const limit = await offlineLimit(m, policy);
        if (!limit) return false;
        await applyResumeLimit(m, policy, limit);
        return true;
      });
      if (done) applied++;
    } catch (err) {
      ctx.log.error({ err, sessionId: id }, 'sweeper: resume policy (offline limit) failed');
    }
  }
  return applied;
}

/* =================================================================== reopen for recovery */

const END_PHRASE: Partial<Record<SessionEndReason, string>> = {
  time_expired: 'the exam time had run out',
  staff_submitted: 'an administrator had submitted it',
  staff_terminated: 'an administrator had ended it',
  abandoned: 'it had been closed after a long period without activity',
  resume_limit: 'the resume rules had ended it',
};

/** Whether the session may be reopened now (the rules of shared reopenEligibility, with the facts read from the database). */
export async function loadReopenEligibility(db: DbOrTx, s: ExamSession, policy: ProctoringPolicy, now: number): Promise<ReopenEligibilityDTO> {
  const [[ref], [review]] = await Promise.all([
    db
      .select({ id: identityReferences.id })
      .from(identityReferences)
      .where(and(eq(identityReferences.sessionId, s.id), eq(identityReferences.active, true), isNull(identityReferences.purgedAt), isNotNull(identityReferences.embeddingsEnc)))
      .limit(1),
    db.select({ state: sessionReviews.state }).from(sessionReviews).where(eq(sessionReviews.sessionId, s.id)).limit(1),
  ]);
  return reopenEligibility({
    status: s.status,
    endReason: s.endReason ?? null,
    startedAt: ms(s.startedAt),
    evidencePurgedAt: ms(s.evidencePurgedAt),
    hasReference: !!ref,
    staffVerified: policy.identity.verification === 'staff',
    reviewResolved: review?.state === 'resolved',
    remainingMs: remainingMs(s, now),
  });
}

/** What the candidate's hold screen says while a reopened exam waits for their identity check. */
export const RECOVERY_MESSAGE = HOLD_MESSAGES.recovery;

export async function reopenSession(ctx: Ctx, sessionId: string, actor: Actor, req: ReopenRequest): Promise<SessionSummaryDTO> {
  await withSession(ctx, sessionId, async (m) => {
    const s = m.session;
    if (s.orgId !== actor.orgId) throw notFound('Session not found', 'session_not_found');
    const eligibility = await loadReopenEligibility(m.tx, s, await m.policy(), m.now);
    if (!eligibility.allowed) throw conflict(eligibility.code ?? 'invalid_state', eligibility.message, { status: s.status, endReason: s.endReason });
    const addMs = req.addMinutes * 60_000;
    const started = s.startedAt != null;
    const remainingAfter = s.durationMs + addMs - s.usedMs;
    if (started && remainingAfter < REOPEN_MIN_REMAINING_MS) {
      throw conflict('no_time_left', 'No exam time would be left. Add minutes so the candidate can continue.', { remainingMs: Math.max(0, s.durationMs - s.usedMs) });
    }
    const previous = { status: s.status, endReason: s.endReason ?? null, endedAt: ms(s.endedAt), score: s.score ? { points: s.score.points, maxPoints: s.score.maxPoints } : null };
    const reason = req.reason.trim();
    m.set({ endReason: null, endedAt: null, score: null, durationMs: s.durationMs + addMs, reconnectCount: 0, checkAttemptsResetAt: new Date(m.now), startDeferredSince: null });
    if (started) {
      // From the old end until the candidate passes the check the exam is not running and nothing is observed.
      await m.insertPeriod('on_hold', previous.endedAt ?? m.now, { reason: 'recovery', meta: { previousEndReason: previous.endReason, reopenedAt: m.now } });
      m.set({
        status: 'on_hold',
        holdReason: 'recovery',
        holdSince: new Date(m.now),
        holdMessage: RECOVERY_MESSAGE,
        holdCanReverify: true,
        holdPrevStatus: 'active',
        reEnrollAuthorized: false,
        reEnrollAuthorizedBy: null,
      });
      m.resetIdentityCounters();
    } else {
      m.set({ status: 'invited', ...clearedHold(), verifiedInstanceId: null, activeInstanceId: null });
    }
    const why = previous.endReason ? END_PHRASE[previous.endReason] : null;
    await m.addEvent({
      type: 'session_reopened',
      source: 'staff',
      observation: started
        ? `An administrator reopened the exam for recovery after ${why ?? 'it had ended'}. The candidate continues after a fresh identity check; the answers were kept.${req.addMinutes ? ` ${req.addMinutes} min were added.` : ''}`
        : `An administrator reopened the session after ${why ?? 'it had ended'}. The exam had not started: the candidate checks in again.`,
      details: { reason, addMinutes: req.addMinutes, started, previousStatus: previous.status, previousEndReason: previous.endReason, previousEndedAt: previous.endedAt, previousScore: previous.score, remainingMs: remainingAfter, by: actor.id },
    });
    await audit(m.tx, {
      orgId: s.orgId,
      actorType: 'staff',
      actorId: actor.id,
      action: 'session.reopened',
      targetType: 'session',
      targetId: s.id,
      meta: { reason, addMinutes: req.addMinutes, started, previousStatus: previous.status, previousEndReason: previous.endReason },
      ip: actor.ip ?? null,
      at: m.now,
    });
  });
  const dto = await loadSessionSummary(ctx, ctx.db, sessionId);
  if (!dto) throw notFound('Session not found', 'session_not_found');
  return dto;
}

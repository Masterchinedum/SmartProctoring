/**
 * Staff actions on sessions (called by the admin API routes). Every function:
 *  - checks the session belongs to the actor's organisation (404 otherwise),
 *  - runs under the session row lock (withSession),
 *  - writes an audit record, records a timeline event, queues candidate commands,
 *  - returns the fresh SessionSummaryDTO (after commit; realtime is published automatically).
 */
import { randomUUID } from 'node:crypto';
import type { CheckPurpose, SessionSummaryDTO, StaffVerificationMethod } from '@sp/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import type { DbOrTx } from '../db/index.js';
import { events, examSessions, exams, identityReferences, pauseRequests, type ExamSession } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { conflict, invalidState, notFound } from '../lib/errors.js';
import { applicableAccommodations, sessionSnapshot } from './accommodations.js';
import { accessLinkFromToken, loadSessionSummary } from './dto.js';
import { assertStatus, finalizeSession, holdNow, pauseNow, TERMINAL, withSession, type SessionMutation } from './session-state.js';

export interface Actor {
  /** Staff user id. */
  id: string;
  orgId: string;
  ip?: string | null;
}

async function summary(ctx: Ctx, sessionId: string): Promise<SessionSummaryDTO> {
  const dto = await loadSessionSummary(ctx, ctx.db, sessionId);
  if (!dto) throw notFound('Session not found', 'session_not_found');
  return dto;
}

function assertOrg(m: SessionMutation, actor: Actor) {
  if (m.session.orgId !== actor.orgId) throw notFound('Session not found', 'session_not_found');
}

async function auditAction(m: SessionMutation, actor: Actor, action: string, meta: Record<string, unknown> = {}) {
  await audit(m.tx, { orgId: m.session.orgId, actorType: 'staff', actorId: actor.id, action, targetType: 'session', targetId: m.session.id, meta, ip: actor.ip ?? null, at: m.now });
}

/* ------------------------------------------------------------------ session creation / links */

export interface CreatedSession {
  session: ExamSession;
  accessToken: string;
  accessLink: string;
}

/**
 * Create an exam session (assignment) for a candidate. The access token is returned once in clear;
 * only its sha256 (and an encrypted copy for staff re-display) is stored.
 */
export async function createExamSession(ctx: Ctx, db: DbOrTx, input: { orgId: string; examId: string; candidateId: string }): Promise<CreatedSession> {
  const [exam] = await db.select().from(exams).where(and(eq(exams.id, input.examId), eq(exams.orgId, input.orgId)));
  if (!exam) throw notFound('Exam not found', 'exam_not_found');
  const token = randomToken(32);
  const now = ctx.now();
  const id = randomUUID();
  // The candidate's approved accommodations for this exam (kept up to date until the exam starts; accommodations.ts).
  const acc = sessionSnapshot(await applicableAccommodations(db, input.candidateId, input.examId, now), exam.durationSec * 1000, now);
  const [session] = await db
    .insert(examSessions)
    .values({
      id,
      orgId: input.orgId,
      examId: input.examId,
      candidateId: input.candidateId,
      accessTokenHash: sha256Hex(token),
      accessTokenEnc: ctx.keyring.encryptString(token, `access-token:${id}`),
      durationMs: exam.durationSec * 1000 + (acc?.extraTimeMs ?? 0),
      accommodations: acc,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })
    .returning();
  return { session, accessToken: token, accessLink: accessLinkFromToken(ctx, token) };
}

/** Invalidate the old link and issue a new one. */
export async function regenerateAccessLink(ctx: Ctx, sessionId: string, actor: Actor): Promise<{ accessLink: string }> {
  return withSession(ctx, sessionId, async (m) => {
    assertOrg(m, actor);
    if (TERMINAL.includes(m.session.status)) throw invalidState('The exam has ended');
    const token = randomToken(32);
    m.set({ accessTokenHash: sha256Hex(token), accessTokenEnc: ctx.keyring.encryptString(token, `access-token:${m.session.id}`) });
    await auditAction(m, actor, 'session.link_regenerated');
    return { accessLink: accessLinkFromToken(ctx, token) };
  });
}

/* ------------------------------------------------------------------ pause requests */

export async function decidePauseRequest(ctx: Ctx, sessionId: string, requestId: string, approve: boolean, actor: Actor | string, note?: string | null): Promise<SessionSummaryDTO> {
  const a = typeof actor === 'string' ? await actorFromId(ctx, sessionId, actor) : actor;
  await withSession(ctx, sessionId, async (m) => {
    assertOrg(m, a);
    const [req] = await m.tx.select().from(pauseRequests).where(and(eq(pauseRequests.id, requestId), eq(pauseRequests.sessionId, sessionId)));
    if (!req) throw notFound('Pause request not found', 'pause_request_not_found');
    if (req.status !== 'pending') throw conflict('already_decided', `This pause request was already ${req.status}`);
    const decided = { decidedAt: new Date(m.now), decidedBy: a.id, decisionNote: note ?? null };
    if (approve) {
      assertStatus(m, ['active'], 'The exam is no longer active, so it cannot be paused');
      await m.tx.update(pauseRequests).set({ status: 'approved', ...decided }).where(eq(pauseRequests.id, requestId));
      await pauseNow(m, { reason: req.reason, requestId, approvedBy: a.id });
      await m.enqueueCommand({ kind: 'pause_approved' });
    } else {
      await m.tx.update(pauseRequests).set({ status: 'denied', ...decided }).where(eq(pauseRequests.id, requestId));
      await m.addEvent({ type: 'pause_denied', source: 'staff', details: { requestId, note: note ?? null, by: a.id } });
      await m.enqueueCommand({ kind: 'pause_denied', note: note ?? null });
    }
    m.publishPauseRequest(requestId);
    await auditAction(m, a, approve ? 'pause_request.approved' : 'pause_request.denied', { requestId, note: note ?? null });
  });
  return summary(ctx, sessionId);
}

async function actorFromId(ctx: Ctx, sessionId: string, staffUserId: string): Promise<Actor> {
  const [s] = await ctx.db.select({ orgId: examSessions.orgId }).from(examSessions).where(eq(examSessions.id, sessionId));
  if (!s) throw notFound('Session not found', 'session_not_found');
  return { id: staffUserId, orgId: s.orgId };
}

/* ------------------------------------------------------------------ holds */

export async function holdSession(ctx: Ctx, sessionId: string, actor: Actor, note?: string | null): Promise<SessionSummaryDTO> {
  await withSession(ctx, sessionId, async (m) => {
    assertOrg(m, actor);
    assertStatus(m, ['invited', 'ready', 'active', 'paused', 'on_hold']);
    await holdNow(m, { reason: 'staff', source: 'staff', by: actor.id, details: { note: note ?? null } });
    await auditAction(m, actor, 'session.hold', { note: note ?? null });
  });
  return summary(ctx, sessionId);
}

export const RELEASE_REVERIFY_MESSAGE = 'An administrator has reviewed your exam. Complete the camera and identity check to continue.';

/**
 * Release a hold.
 *  - requireCheck (default): the candidate must pass a 'reverify' check (status stays on_hold with canReverify
 *    until they pass; then the exam continues).
 *  - reEnroll: staff confirmed the person and authorise a NEW identity reference at that check (implies requireCheck).
 *  - Holds raised before a reference existed return the session to the initial check.
 *  - A 'staff_verification' hold (identity verified by staff — an accommodation) is released only with `verification`
 *    (how the staff member verified the candidate), recorded as an identity_verified_by_staff event; no check follows,
 *    the verification is the check. Sessions verified by staff have no face reference by design.
 */
export async function releaseHold(
  ctx: Ctx,
  sessionId: string,
  actor: Actor,
  opts: { note?: string | null; requireCheck?: boolean; reEnroll?: boolean; verification?: { method: StaffVerificationMethod; note?: string | null } | null } = {},
): Promise<SessionSummaryDTO> {
  await withSession(ctx, sessionId, async (m) => {
    assertOrg(m, actor);
    assertStatus(m, ['on_hold'], 'The exam is not on hold');
    const staffMode = (await m.policy()).identity.verification === 'staff';
    const verificationHold = m.session.holdReason === 'staff_verification';
    if (verificationHold && !opts.verification) {
      throw conflict('verification_required', 'Confirm that you have verified the candidate’s identity, and how, to release this hold.');
    }
    const reEnroll = !staffMode && opts.reEnroll === true;
    const requireCheck = !verificationHold && (reEnroll || opts.requireCheck !== false);
    const [ref] = await m.tx
      .select({ id: identityReferences.id })
      .from(identityReferences)
      .where(and(eq(identityReferences.sessionId, sessionId), eq(identityReferences.active, true)));
    const prev = m.session.holdPrevStatus ?? 'active';
    const details = { requireCheck, reEnroll, note: opts.note ?? null, by: actor.id, reason: m.session.holdReason };
    if (verificationHold) {
      const [held] = await m.tx
        .select({ details: events.details })
        .from(events)
        .where(and(eq(events.sessionId, sessionId), eq(events.type, 'session_held')))
        .orderBy(desc(events.startedAt))
        .limit(1);
      const purpose = ((held?.details as { purpose?: CheckPurpose } | undefined)?.purpose ?? null) as CheckPurpose | null;
      const verification = { method: opts.verification!.method, note: opts.verification!.note?.trim() || null, by: actor.id, purpose };
      await m.addEvent({ type: 'identity_verified_by_staff', source: 'staff', details: verification });
      await auditAction(m, actor, 'session.identity_verified_by_staff', { method: verification.method, purpose });
    }
    await m.addEvent({ type: 'hold_released', source: 'staff', details });
    // No reference to compare with: back to the initial check — unless identity is verified by staff (no reference by
    // design), where only a hold from before the check-in goes back to it.
    if (staffMode ? prev === 'invited' : !ref) {
      // No protected reference yet (hold during the initial check): back to the initial check.
      await m.closeOpenPeriod(m.now);
      m.set({ status: 'invited', ...clearedHold(), checkAttemptsResetAt: new Date(m.now), reEnrollAuthorized: false, verifiedInstanceId: null });
      await m.enqueueCommand({ kind: 'hold_released', requiresCheck: true });
      await m.enqueueCommand({ kind: 'require_check', purpose: 'initial', message: RELEASE_REVERIFY_MESSAGE });
    } else if (requireCheck) {
      m.set({ holdCanReverify: true, holdMessage: RELEASE_REVERIFY_MESSAGE, reEnrollAuthorized: reEnroll, reEnrollAuthorizedBy: reEnroll ? actor.id : null, checkAttemptsResetAt: new Date(m.now) });
      await m.enqueueCommand({ kind: 'hold_released', requiresCheck: true });
      await m.enqueueCommand({ kind: 'require_check', purpose: 'reverify', message: RELEASE_REVERIFY_MESSAGE });
    } else {
      const next = prev === 'ready' ? 'ready' : prev === 'invited' ? 'invited' : 'active';
      await m.closeOpenPeriod(m.now);
      m.set({ status: next, ...clearedHold(), checkAttemptsResetAt: new Date(m.now) });
      if (next === 'active') {
        await m.insertPeriod('active', m.now, { reason: 'hold_released' });
        m.clockStart();
        m.resetIdentityCounters();
      }
      await m.enqueueCommand({ kind: 'hold_released', requiresCheck: false });
    }
    await auditAction(m, actor, reEnroll ? 'session.release_reenroll_authorized' : 'session.release', details);
  });
  return summary(ctx, sessionId);
}

/**
 * Session fields reset when a hold ends. A re-enrolment authorisation only ever applies to the reverify check
 * of the hold it was given for: releasing without a check (or passing the check) revokes it.
 */
export function clearedHold() {
  return { holdReason: null, holdSince: null, holdMessage: null, holdCanReverify: false, holdPrevStatus: null, reEnrollAuthorized: false, reEnrollAuthorizedBy: null } as const;
}

/* ------------------------------------------------------------------ ending */

export async function terminateSession(ctx: Ctx, sessionId: string, actor: Actor, reason: string): Promise<SessionSummaryDTO> {
  await withSession(ctx, sessionId, async (m) => {
    assertOrg(m, actor);
    if (TERMINAL.includes(m.session.status)) throw invalidState('The exam has already ended');
    await finalizeSession(m, 'staff_terminated', { by: actor.id, note: reason });
    await auditAction(m, actor, 'session.terminate', { reason });
  });
  return summary(ctx, sessionId);
}

export async function staffSubmit(ctx: Ctx, sessionId: string, actor: Actor, note?: string | null): Promise<SessionSummaryDTO> {
  await withSession(ctx, sessionId, async (m) => {
    assertOrg(m, actor);
    assertStatus(m, ['active', 'paused', 'on_hold'], 'Only an exam that has started can be submitted');
    await finalizeSession(m, 'staff_submitted', { by: actor.id, note: note ?? null });
    await auditAction(m, actor, 'session.staff_submit', { note: note ?? null });
  });
  return summary(ctx, sessionId);
}

/* ------------------------------------------------------------------ time extension & legal hold */

export async function extendSessionTime(ctx: Ctx, sessionId: string, minutes: number, actor: Actor | string, note?: string | null): Promise<SessionSummaryDTO> {
  const a = typeof actor === 'string' ? await actorFromId(ctx, sessionId, actor) : actor;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) throw invalidState('minutes must be an integer between 1 and 1440');
  await withSession(ctx, sessionId, async (m) => {
    assertOrg(m, a);
    assertStatus(m, ['ready', 'active', 'paused', 'on_hold'], 'Time can only be extended before the exam ends');
    const addMs = minutes * 60_000;
    m.set({ durationMs: m.session.durationMs + addMs });
    await m.addEvent({ type: 'time_extended', source: 'staff', details: { minutes, note: note ?? null, by: a.id, newDurationMs: m.session.durationMs } });
    await auditAction(m, a, 'session.time_extended', { minutes, note: note ?? null });
  });
  return summary(ctx, sessionId);
}

export async function setLegalHold(ctx: Ctx, sessionId: string, enabled: boolean, actor: Actor): Promise<SessionSummaryDTO> {
  await withSession(ctx, sessionId, async (m) => {
    assertOrg(m, actor);
    m.set({ legalHold: enabled });
    await auditAction(m, actor, enabled ? 'session.legal_hold_on' : 'session.legal_hold_off');
  });
  return summary(ctx, sessionId);
}

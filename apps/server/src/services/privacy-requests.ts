/**
 * The register of data-subject requests (docs/PRIVACY.md §5): access, erasure, rectification, restriction, objection,
 * consent withdrawal. Each request has a legal deadline (DEFAULT_PRIVACY_RESPONSE_DAYS from receipt, extendable by up to
 * MAX_PRIVACY_EXTENSION_DAYS with a reason), an assignee, and a resolution; every change is audited. What was asked is
 * encrypted at rest (AAD privacy-request:<id>). The register is for administrators and owners only.
 *
 * Requests outlive the candidate they concern: erasing the candidate sets candidate_id to null, and `subject` still
 * says who it was about.
 *
 * A candidate who withdraws consent in the exam app (withdrawConsent) ends their exam ('candidate_withdrew', no
 * score), has the session's face images and templates deleted (unless a legal hold requires keeping them), and gets a
 * consent-withdrawal request in the register so staff arrange an alternative assessment.
 */
import {
  DEFAULT_PRIVACY_RESPONSE_DAYS,
  PRIVACY_DUE_SOON_DAYS,
  PRIVACY_REQUEST_INFO,
  type CreatePrivacyRequest,
  type PrivacyRequestDTO,
  type PrivacyRequestListQuery,
  type PrivacyRequestsDTO,
  type PrivacyRequestStatus,
  type UpdatePrivacyRequest,
  type WithdrawConsentRequest,
} from '@sp/shared';
import { and, desc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import type { DbOrTx } from '../db/index.js';
import { candidates, checkFrames, evidence, examSessions, identitySampleFrames, privacyRequests, staffUsers, type PrivacyRequest } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, invalidState, notFound } from '../lib/errors.js';
import { purgeCandidateIdPhoto, purgeEvidenceRows, purgeSessionEvidence } from './evidence.js';
import { DAY_MS } from './retention.js';
import { finalizeSession, TERMINAL, withSession } from './session-state.js';

export const privacyRequestDetailsAad = (id: string) => `privacy-request:${id}`;

/** Requests that are still being worked on. */
export const OPEN_PRIVACY_STATUSES: PrivacyRequestStatus[] = ['open', 'in_progress'];

const CLOSED: PrivacyRequestStatus[] = ['completed', 'rejected'];

export interface PrivacyActor {
  /** Staff user id; null for the candidate (consent withdrawal) or the system. */
  id: string | null;
  orgId: string;
  ip?: string | null;
}

export function dueAtFor(receivedAt: number, extensionDays: number | null | undefined): number {
  return receivedAt + (DEFAULT_PRIVACY_RESPONSE_DAYS + (extensionDays ?? 0)) * DAY_MS;
}

export function isOverdue(r: Pick<PrivacyRequest, 'status' | 'dueAt'>, now: number): boolean {
  return OPEN_PRIVACY_STATUSES.includes(r.status) && r.dueAt.getTime() < now;
}

/* ------------------------------------------------------------------ reading */

const ms = (d: Date | null) => (d ? d.getTime() : null);

async function toDTOs(ctx: Pick<Ctx, 'db' | 'keyring'>, rows: PrivacyRequest[], now: number): Promise<PrivacyRequestDTO[]> {
  if (!rows.length) return [];
  const staffIds = [...new Set(rows.flatMap((r) => [r.assigneeId, r.createdBy, r.closedBy]).filter((x): x is string => !!x))];
  const candidateIds = [...new Set(rows.map((r) => r.candidateId).filter((x): x is string => !!x))];
  const [people, cands] = await Promise.all([
    staffIds.length ? ctx.db.select({ id: staffUsers.id, name: staffUsers.name }).from(staffUsers).where(inArray(staffUsers.id, staffIds)) : Promise.resolve([]),
    candidateIds.length ? ctx.db.select({ id: candidates.id, name: candidates.name }).from(candidates).where(inArray(candidates.id, candidateIds)) : Promise.resolve([]),
  ]);
  const staffById = new Map(people.map((p) => [p.id, p]));
  const candById = new Map(cands.map((c) => [c.id, c]));
  const person = (id: string | null) => (id ? (staffById.get(id) ?? { id, name: 'Former staff member' }) : null);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    subject: r.subject,
    candidate: r.candidateId ? (candById.get(r.candidateId) ?? null) : null,
    channel: r.channel,
    source: r.source,
    receivedAt: r.receivedAt.getTime(),
    dueAt: r.dueAt.getTime(),
    overdue: isOverdue(r, now),
    extension: r.extensionDays ? { days: r.extensionDays, reason: r.extensionReason ?? '' } : null,
    details: r.detailsEnc ? ctx.keyring.decryptString(r.detailsEnc, privacyRequestDetailsAad(r.id)) : null,
    assignee: person(r.assigneeId),
    createdBy: person(r.createdBy),
    createdAt: r.createdAt.getTime(),
    resolutionNote: r.resolutionNote,
    closedAt: ms(r.closedAt),
    closedBy: person(r.closedBy),
    exportedAt: ms(r.exportedAt),
    erasedAt: ms(r.erasedAt),
    sessionId: r.sessionId,
  }));
}

export async function listPrivacyRequests(ctx: Pick<Ctx, 'db' | 'keyring'>, orgId: string, q: PrivacyRequestListQuery, now: number): Promise<PrivacyRequestsDTO> {
  const rows = await ctx.db
    .select()
    .from(privacyRequests)
    .where(
      and(
        eq(privacyRequests.orgId, orgId),
        q.status === 'open' ? inArray(privacyRequests.status, OPEN_PRIVACY_STATUSES) : q.status === 'closed' ? inArray(privacyRequests.status, CLOSED) : undefined,
        q.candidateId ? eq(privacyRequests.candidateId, q.candidateId) : undefined,
      ),
    )
    // Open requests by deadline (most urgent first); closed ones newest first.
    .orderBy(q.status === 'open' ? privacyRequests.dueAt : desc(privacyRequests.receivedAt), desc(privacyRequests.createdAt))
    .limit(500);
  const [counts] = await ctx.db
    .select({
      open: sql<number>`count(*)::int`,
      overdue: sql<number>`count(*) filter (where ${privacyRequests.dueAt} < ${new Date(now)})::int`,
      dueSoon: sql<number>`count(*) filter (where ${privacyRequests.dueAt} >= ${new Date(now)} and ${privacyRequests.dueAt} < ${new Date(now + PRIVACY_DUE_SOON_DAYS * DAY_MS)})::int`,
    })
    .from(privacyRequests)
    .where(and(eq(privacyRequests.orgId, orgId), inArray(privacyRequests.status, OPEN_PRIVACY_STATUSES)));
  return { items: await toDTOs(ctx, rows, now), counts: { open: counts?.open ?? 0, overdue: counts?.overdue ?? 0, dueSoon: counts?.dueSoon ?? 0 } };
}

export async function loadPrivacyRequest(db: DbOrTx, orgId: string, id: string, lock = false): Promise<PrivacyRequest> {
  const q = db
    .select()
    .from(privacyRequests)
    .where(and(eq(privacyRequests.id, id), eq(privacyRequests.orgId, orgId)));
  const [row] = lock ? await q.for('update') : await q;
  if (!row) throw notFound('Request not found', 'privacy_request_not_found');
  return row;
}

export async function privacyRequestDTO(ctx: Pick<Ctx, 'db' | 'keyring'>, orgId: string, id: string, now: number): Promise<PrivacyRequestDTO> {
  return (await toDTOs(ctx, [await loadPrivacyRequest(ctx.db, orgId, id)], now))[0];
}

/* ------------------------------------------------------------------ recording and answering */

/** A request is received now or in the past (a letter opened today may have arrived last week), never later. */
const RECEIVED_FUTURE_TOLERANCE_MS = 5 * 60_000;

async function assertCandidateInOrg(db: DbOrTx, orgId: string, candidateId: string): Promise<void> {
  const [c] = await db
    .select({ id: candidates.id })
    .from(candidates)
    .where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)));
  if (!c) throw notFound('Candidate not found', 'candidate_not_found');
}

/** Only administrators and owners of the organisation work on the register. */
async function assertAssignable(db: DbOrTx, orgId: string, staffId: string): Promise<void> {
  const [u] = await db
    .select({ id: staffUsers.id })
    .from(staffUsers)
    .where(and(eq(staffUsers.id, staffId), eq(staffUsers.orgId, orgId), eq(staffUsers.disabled, false), inArray(staffUsers.role, ['admin', 'owner'])));
  if (!u) throw badRequest('Requests can be assigned to active administrators and owners only.', undefined, 'invalid_assignee');
}

export async function createPrivacyRequest(ctx: Pick<Ctx, 'keyring'>, tx: DbOrTx, actor: PrivacyActor, input: CreatePrivacyRequest, now: number): Promise<PrivacyRequest> {
  const receivedAt = input.receivedAt ?? now;
  if (receivedAt > now + RECEIVED_FUTURE_TOLERANCE_MS) throw badRequest('The request cannot have been received in the future.', undefined, 'received_in_future');
  if (input.candidateId) await assertCandidateInOrg(tx, actor.orgId, input.candidateId);
  const [row] = await tx
    .insert(privacyRequests)
    .values({
      orgId: actor.orgId,
      kind: input.kind,
      status: 'open',
      subject: input.subject.trim(),
      candidateId: input.candidateId ?? null,
      channel: input.channel,
      source: 'staff',
      receivedAt: new Date(receivedAt),
      dueAt: new Date(dueAtFor(receivedAt, 0)),
      createdBy: actor.id,
      assigneeId: actor.id,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })
    .returning();
  const details = input.details?.trim();
  if (details) await tx.update(privacyRequests).set({ detailsEnc: ctx.keyring.encryptString(details, privacyRequestDetailsAad(row.id)) }).where(eq(privacyRequests.id, row.id));
  await audit(tx, {
    orgId: actor.orgId,
    actorType: 'staff',
    actorId: actor.id,
    action: 'privacy_request.created',
    targetType: 'privacy_request',
    targetId: row.id,
    meta: { kind: row.kind, channel: row.channel, candidateId: row.candidateId, receivedAt, dueAt: row.dueAt.getTime() },
    ip: actor.ip ?? null,
    at: now,
  });
  return row;
}

export async function updatePrivacyRequest(tx: DbOrTx, actor: PrivacyActor, id: string, input: UpdatePrivacyRequest, now: number): Promise<PrivacyRequest> {
  const cur = await loadPrivacyRequest(tx, actor.orgId, id, true);
  const patch: Partial<typeof privacyRequests.$inferInsert> = {};
  const changed: string[] = [];
  if (input.assigneeId !== undefined && input.assigneeId !== cur.assigneeId) {
    if (input.assigneeId) await assertAssignable(tx, actor.orgId, input.assigneeId);
    patch.assigneeId = input.assigneeId;
    changed.push('assignee');
  }
  if (input.extension) {
    if (CLOSED.includes(cur.status)) throw invalidState('A closed request has no deadline to extend.');
    if (input.extension.days <= (cur.extensionDays ?? 0)) {
      throw conflict('extension_not_longer', `The deadline is already extended by ${cur.extensionDays} days; an extension can only make it longer.`, { extensionDays: cur.extensionDays });
    }
    patch.extensionDays = input.extension.days;
    patch.extensionReason = input.extension.reason;
    patch.dueAt = new Date(dueAtFor(cur.receivedAt.getTime(), input.extension.days));
    changed.push('extension');
  }
  if (input.resolutionNote !== undefined && (input.resolutionNote || null) !== cur.resolutionNote) {
    patch.resolutionNote = input.resolutionNote || null;
    changed.push('resolutionNote');
  }
  if (input.status && input.status !== cur.status) {
    const closing = CLOSED.includes(input.status);
    patch.status = input.status;
    patch.closedAt = closing ? new Date(now) : null;
    patch.closedBy = closing ? actor.id : null;
    changed.push('status');
  }
  if (!changed.length) return cur;
  const [row] = await tx
    .update(privacyRequests)
    .set({ ...patch, updatedAt: new Date(now) })
    .where(eq(privacyRequests.id, id))
    .returning();
  const reopened = patch.status && CLOSED.includes(cur.status) && !CLOSED.includes(patch.status);
  await audit(tx, {
    orgId: actor.orgId,
    actorType: 'staff',
    actorId: actor.id,
    action: patch.status && CLOSED.includes(patch.status) ? `privacy_request.${patch.status}` : reopened ? 'privacy_request.reopened' : 'privacy_request.updated',
    targetType: 'privacy_request',
    targetId: id,
    meta: {
      fields: changed,
      ...(patch.status ? { from: cur.status, to: patch.status } : {}),
      ...(patch.extensionDays ? { extensionDays: patch.extensionDays, dueAt: patch.dueAt?.getTime() } : {}),
      ...(patch.assigneeId !== undefined ? { assigneeId: patch.assigneeId } : {}),
    },
    ip: actor.ip ?? null,
    at: now,
  });
  return row;
}

/* ------------------------------------------------------------------ consent withdrawal (candidate) */

export interface WithdrawalResult {
  requestId: string;
  /** Face images deleted now (0 while a legal hold keeps them). */
  evidencePurged: number;
  legalHold: boolean;
}

/**
 * The candidate withdrew consent (POST /api/candidate/consent/withdraw). Ends the exam ('candidate_withdrew': status
 * terminated, no score, answers and the event timeline kept), records a consent-withdrawal request (status open: staff
 * arrange an alternative assessment), then deletes the session's face images and templates — unless the session is
 * under legal hold, which the request notes. The candidate's approved ID photo belongs to the candidate record and is
 * not touched (the request says so: staff remove it if the withdrawal covers it).
 */
export async function withdrawConsent(ctx: Ctx, sessionId: string, input: WithdrawConsentRequest, meta: { instanceId: string | null; ip: string }): Promise<WithdrawalResult> {
  const { requestId, legalHold } = await withSession(ctx, sessionId, async (m) => {
    const s = m.session;
    if (TERMINAL.includes(s.status)) throw invalidState('The exam has already ended.');
    if (!s.consentAcceptedAt) throw conflict('consent_not_given', 'Consent was never given for this exam, so there is nothing to withdraw. You can simply close this page.');
    const [cand] = await m.tx.select().from(candidates).where(eq(candidates.id, s.candidateId));
    const wasStarted = s.startedAt != null;
    await finalizeSession(m, 'candidate_withdrew', { details: { status: s.status, started: wasStarted } });
    const receivedAt = m.now;
    const [req] = await m.tx
      .insert(privacyRequests)
      .values({
        orgId: s.orgId,
        kind: 'consent_withdrawal',
        status: 'open',
        subject: [cand?.name, cand?.email || cand?.externalId].filter(Boolean).join(' · ') || 'Candidate',
        candidateId: s.candidateId,
        sessionId: s.id,
        channel: 'candidate_app',
        source: 'candidate',
        receivedAt: new Date(receivedAt),
        dueAt: new Date(dueAtFor(receivedAt, 0)),
        createdAt: new Date(receivedAt),
        updatedAt: new Date(receivedAt),
      })
      .returning();
    const lines = [
      `The candidate withdrew consent in the exam app (${wasStarted ? 'during the exam' : 'before the exam started'}). The exam ended without a score; answers and the event timeline are kept.`,
      s.legalHold
        ? 'The session is under legal hold, so its face images and templates were NOT deleted. Delete them once the hold is lifted, or tell the candidate why they are kept.'
        : 'The session’s face images and templates were deleted.',
      cand?.idPhotoEvidenceId ? 'The candidate’s approved ID photo (candidate record) was kept: remove it on the Candidates page if the withdrawal covers it.' : null,
      input.reason ? `Reason given by the candidate: ${input.reason}` : null,
      PRIVACY_REQUEST_INFO.consent_withdrawal.help,
    ].filter(Boolean);
    await m.tx.update(privacyRequests).set({ detailsEnc: ctx.keyring.encryptString(lines.join('\n\n'), privacyRequestDetailsAad(req.id)) }).where(eq(privacyRequests.id, req.id));
    await audit(m.tx, {
      orgId: s.orgId,
      actorType: 'candidate',
      action: 'candidate.consent_withdrawn',
      targetType: 'session',
      targetId: s.id,
      meta: { privacyRequestId: req.id, previousStatus: s.status, legalHold: s.legalHold, instanceId: meta.instanceId },
      ip: meta.ip,
      at: m.now,
    });
    return { requestId: req.id, legalHold: s.legalHold };
  });
  const evidencePurged = legalHold ? 0 : await purgeWithdrawnSessionEvidence(ctx, sessionId);
  return { requestId, evidencePurged, legalHold };
}

/**
 * Delete the session's images and face templates after a withdrawal (blobs are not transactional, so after the
 * session change committed). As the retention job does, landmarks are stripped from frame analyses and the session is
 * marked purged once nothing is left. Re-checks the legal hold under the row lock.
 */
async function purgeWithdrawnSessionEvidence(ctx: Ctx, sessionId: string): Promise<number> {
  return ctx.db.transaction(async (tx) => {
    const [s] = await tx.select().from(examSessions).where(eq(examSessions.id, sessionId)).for('update');
    if (!s || s.legalHold) return 0;
    const { evidence: purged } = await purgeSessionEvidence(ctx, tx, sessionId, 'consent_withdrawn');
    await tx
      .update(checkFrames)
      .set({ analysis: sql`${checkFrames.analysis} - 'landmarks' - 'box'` })
      .where(eq(checkFrames.sessionId, sessionId));
    await tx
      .update(identitySampleFrames)
      .set({ analysis: sql`${identitySampleFrames.analysis} - 'landmarks' - 'box'` })
      .where(eq(identitySampleFrames.sessionId, sessionId));
    const [{ remaining }] = await tx
      .select({ remaining: sql<number>`count(*)::int` })
      .from(evidence)
      .where(and(eq(evidence.sessionId, sessionId), isNull(evidence.purgedAt)));
    if (remaining === 0 && !s.evidencePurgedAt) await tx.update(examSessions).set({ evidencePurgedAt: new Date(ctx.now()) }).where(eq(examSessions.id, sessionId));
    await audit(tx, { orgId: s.orgId, actorType: 'system', action: 'evidence.purged', targetType: 'session', targetId: sessionId, meta: { reason: 'consent_withdrawn', itemsPurged: purged, remaining }, at: ctx.now() });
    return purged;
  });
}

/* ------------------------------------------------------------------ erasure */

export interface ErasureResult {
  sessionsDeleted: number;
  evidencePurged: number;
}

/**
 * Delete a candidate and everything recorded about them: images and templates first (blobs are not transactional),
 * then the records (the candidate row cascades to sessions, answers, events, …). Refused while a session has not
 * ended (409 candidate_has_open_sessions) or is under legal hold (409 candidate_under_legal_hold). Requests in the
 * privacy register keep their row (candidate_id becomes null). Used by DELETE /api/admin/candidates/:id and by an
 * erasure request (POST /api/admin/privacy-requests/:id/erase, `privacyRequestId`).
 */
export async function eraseCandidate(ctx: Ctx, actor: PrivacyActor & { id: string }, candidateId: string, opts: { privacyRequestId?: string; inTx?: (tx: DbOrTx) => Promise<void> } = {}): Promise<ErasureResult> {
  const now = ctx.now();
  const open = await ctx.db
    .select({ id: examSessions.id })
    .from(examSessions)
    .where(and(eq(examSessions.candidateId, candidateId), notInArray(examSessions.status, TERMINAL)));
  if (open.length) {
    throw conflict('candidate_has_open_sessions', 'This candidate has an exam session that has not ended. Submit or terminate it before deleting the candidate.', { sessionIds: open.map((s) => s.id) });
  }
  const sessions = await ctx.db.select({ id: examSessions.id, legalHold: examSessions.legalHold }).from(examSessions).where(eq(examSessions.candidateId, candidateId));
  const held = sessions.filter((s) => s.legalHold);
  if (held.length) {
    throw conflict('candidate_under_legal_hold', 'A session of this candidate is under legal hold, so its evidence must be kept. Lift the legal hold before deleting the candidate.', { sessionIds: held.map((s) => s.id) });
  }
  let purged = 0;
  for (const s of sessions) purged += (await purgeSessionEvidence(ctx, ctx.db, s.id, 'candidate_deleted')).evidence;
  await purgeCandidateIdPhoto(ctx, ctx.db, candidateId, 'candidate_deleted');
  const leftovers = await ctx.db
    .select()
    .from(evidence)
    .where(and(eq(evidence.candidateId, candidateId), isNull(evidence.purgedAt)));
  purged += await purgeEvidenceRows(ctx, ctx.db, leftovers, 'candidate_deleted');
  await ctx.db.transaction(async (tx) => {
    const sessionIds = sessions.map((s) => s.id);
    await tx.delete(evidence).where(or(eq(evidence.candidateId, candidateId), sessionIds.length ? inArray(evidence.sessionId, sessionIds) : undefined)!);
    await opts.inTx?.(tx);
    await tx.delete(candidates).where(and(eq(candidates.id, candidateId), eq(candidates.orgId, actor.orgId))); // cascades to sessions and their records
    await audit(tx, {
      orgId: actor.orgId,
      actorType: 'staff',
      actorId: actor.id,
      action: 'candidate.deleted',
      targetType: 'candidate',
      targetId: candidateId,
      meta: { sessionsDeleted: sessions.length, evidencePurged: purged, ...(opts.privacyRequestId ? { privacyRequestId: opts.privacyRequestId } : {}) },
      ip: actor.ip ?? null,
      at: now,
    });
  });
  return { sessionsDeleted: sessions.length, evidencePurged: purged };
}

/** Erase the candidate an erasure request concerns; the request records when (erasedAt). */
export async function eraseForRequest(ctx: Ctx, actor: PrivacyActor & { id: string }, requestId: string): Promise<ErasureResult> {
  const req = await loadPrivacyRequest(ctx.db, actor.orgId, requestId);
  if (req.kind !== 'erasure') throw conflict('not_an_erasure_request', 'Only an erasure request can erase a candidate. Record an erasure request, or delete the candidate on the Candidates page.');
  if (CLOSED.includes(req.status)) throw invalidState('This request is closed. Reopen it before acting on it.');
  if (!req.candidateId) throw conflict('no_candidate', req.erasedAt ? 'The candidate was already erased.' : 'This request is not linked to a candidate record.');
  const candidateId = req.candidateId;
  return eraseCandidate(ctx, actor, candidateId, {
    privacyRequestId: requestId,
    inTx: async (tx) => {
      const now = ctx.now();
      await tx.update(privacyRequests).set({ erasedAt: new Date(now), updatedAt: new Date(now) }).where(eq(privacyRequests.id, requestId));
      await audit(tx, { orgId: actor.orgId, actorType: 'staff', actorId: actor.id, action: 'privacy_request.erased', targetType: 'privacy_request', targetId: requestId, meta: { candidateId }, ip: actor.ip ?? null, at: now });
    },
  });
}

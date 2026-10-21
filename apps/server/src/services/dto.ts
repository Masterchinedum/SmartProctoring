/**
 * Row -> DTO mappers and batched loaders shared by candidate routes, staff routes and the realtime notifier.
 * All DTO timestamps are epoch ms.
 */
import {
  ACCESS_LINK_PATH,
  clockRemainingMs,
  type EventDTO,
  type EvidenceRefDTO,
  type ExamClock,
  type HoldDTO,
  type IdentityCheckDTO,
  type IdentityDecision,
  type IdentitySecondOpinionDTO,
  type NoteDTO,
  type PauseRequestDTO,
  type PeriodDTO,
  type CheckPurpose,
  type SessionScoreDTO,
  type SessionSummaryDTO,
  type SessionWindow,
  type StaffUserDTO,
  type StaffVerificationDTO,
  type StaffVerificationMethod,
  type DeviceRecordDTO,
  type IdentityReferenceDTO,
  type Severity,
} from '@sp/shared';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Ctx } from '../context.js';
import type { DbOrTx } from '../db/index.js';
import {
  candidates,
  deviceRecords,
  events,
  evidence,
  examVersions,
  exams,
  identityChecks,
  identityReferences,
  notes,
  organizations,
  pauseRequests,
  sessionPeriods,
  sessionReviews,
  staffUsers,
  examSessions,
  type Candidate,
  type DeviceRecord,
  type EventRow,
  type EvidenceRow,
  type ExamSession,
  type IdentityCheck,
  type IdentityReference,
  type Note,
  type PauseRequest,
  type SessionPeriod,
  type StaffUser,
} from '../db/schema.js';
import { orgSettings } from './org.js';
import { toReviewSummary } from './review.js';

const reviewAssignee = alias(staffUsers, 'review_assignee');

export const ms = (d: Date | null | undefined): number | null => (d ? d.getTime() : null);
export const msReq = (d: Date): number => d.getTime();

/* ------------------------------------------------------------------ clock */

export function sessionClock(s: Pick<ExamSession, 'durationMs' | 'usedMs' | 'runningSince'>): ExamClock {
  return { durationMs: s.durationMs, usedMs: s.usedMs, runningSince: ms(s.runningSince) };
}

export function remainingMs(s: Pick<ExamSession, 'durationMs' | 'usedMs' | 'runningSince'>, now: number): number {
  return clockRemainingMs(sessionClock(s), now);
}

/* ------------------------------------------------------------------ simple mappers */

export function evidenceUrl(id: string): string {
  return `/api/admin/evidence/${id}`;
}

export function toEvidenceRefDTO(row: EvidenceRow): EvidenceRefDTO {
  return {
    id: row.id,
    kind: row.kind,
    capturedAt: msReq(row.capturedAt),
    available: row.purgedAt == null,
    purgedAt: ms(row.purgedAt),
    url: evidenceUrl(row.id),
  };
}

export function toPeriodDTO(row: SessionPeriod): PeriodDTO {
  return {
    id: row.id,
    kind: row.kind,
    observed: row.observed,
    startedAt: msReq(row.startedAt),
    endedAt: ms(row.endedAt),
    reason: row.reason ?? null,
    meta: row.meta ?? {},
  };
}

export function toPauseRequestDTO(row: PauseRequest): PauseRequestDTO {
  return {
    id: row.id,
    requestedAt: msReq(row.requestedAt),
    reason: row.reason ?? null,
    status: row.status,
    decidedAt: ms(row.decidedAt),
    decidedBy: row.decidedBy ?? null,
    decisionNote: row.decisionNote ?? null,
  };
}

/** The session's scheduling window (services/scheduling.ts), or null when it has none. */
export function sessionWindow(s: Pick<ExamSession, 'windowStartsAt' | 'windowEndsAt'>): SessionWindow | null {
  if (!s.windowStartsAt && !s.windowEndsAt) return null;
  return { startsAt: ms(s.windowStartsAt), endsAt: ms(s.windowEndsAt) };
}

export function toHoldDTO(s: Pick<ExamSession, 'status' | 'holdReason' | 'holdSince' | 'holdMessage' | 'holdCanReverify'>): HoldDTO | null {
  if (s.status !== 'on_hold' || !s.holdReason) return null;
  return {
    reason: s.holdReason,
    since: ms(s.holdSince) ?? 0,
    message: s.holdMessage ?? '',
    canReverify: s.holdCanReverify,
  };
}

export function toStaffUserDTO(u: StaffUser): StaffUserDTO {
  return { id: u.id, email: u.email, name: u.name, role: u.role, disabled: u.disabled, createdAt: msReq(u.createdAt), mfaEnabledAt: ms(u.mfaEnabledAt) };
}

export function toNoteDTO(n: Note, authorName: string): NoteDTO {
  return { id: n.id, sessionId: n.sessionId, eventId: n.eventId ?? null, authorId: n.authorId, authorName, text: n.text, createdAt: msReq(n.createdAt) };
}

export function toDeviceRecordDTO(d: DeviceRecord): DeviceRecordDTO {
  return {
    at: msReq(d.at),
    clientInstanceId: d.clientInstanceId,
    cameraLabel: d.cameraLabel,
    cameraIdHash: d.cameraIdHash,
    userAgent: d.userAgent,
    purpose: d.purpose,
  };
}

export function toEventDTO(
  row: EventRow,
  extra: { evidence?: EvidenceRow[]; reviewerName?: string | null; notesCount?: number } = {},
): EventDTO {
  const startedAt = msReq(row.startedAt);
  const endedAt = ms(row.endedAt);
  return {
    id: row.id,
    sessionId: row.sessionId,
    type: row.type,
    category: row.category,
    severity: row.severity,
    source: row.source,
    status: row.status,
    title: row.title,
    observation: row.observation,
    startedAt,
    endedAt,
    durationMs: endedAt != null ? Math.max(0, endedAt - startedAt) : null,
    confidence: row.confidence ?? null,
    details: row.details ?? {},
    context: row.context ?? {},
    evidence: (extra.evidence ?? []).slice().sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime()).map(toEvidenceRefDTO),
    review: {
      status: row.reviewStatus,
      resolution: row.resolution ?? null,
      by: row.reviewedBy ?? null,
      byName: extra.reviewerName ?? null,
      at: ms(row.reviewedAt),
      note: row.reviewNote ?? null,
    },
    notesCount: extra.notesCount ?? 0,
    receivedAt: msReq(row.receivedAt),
    deliveredLate: row.deliveredLate,
  };
}

export function toIdentityCheckDTO(row: IdentityCheck, probe: EvidenceRow | null): IdentityCheckDTO {
  const c = row.context ?? { precededBy: [], periodKind: null, secondsSincePreviousMatch: null };
  return {
    id: row.id,
    trigger: row.trigger,
    decision: row.decision,
    similarity: row.similarity ?? null,
    confidence: row.confidence,
    quality: row.quality ?? null,
    at: msReq(row.at),
    probeEvidence: probe ? toEvidenceRefDTO(probe) : null,
    context: {
      precededBy: Array.isArray(c.precededBy) ? c.precededBy : [],
      periodKind: c.periodKind ?? null,
      secondsSincePreviousMatch: c.secondsSincePreviousMatch ?? null,
    },
    livenessPassed: livenessFromContext(c as unknown as Record<string, unknown>),
    // Only present when an external second opinion was asked (off by default): the DTO is otherwise unchanged.
    ...withSecondOpinion(secondOpinionFromContext(c as unknown as Record<string, unknown>)),
    ...(row.decisionConfigVersion != null || row.calibrationVersion || row.modelVersion
      ? { versions: { decisionConfig: row.decisionConfigVersion ?? null, calibration: row.calibrationVersion ?? null, model: row.modelVersion ?? null } }
      : {}),
  };
}

function withSecondOpinion(so: IdentitySecondOpinionDTO | null): { secondOpinion?: IdentitySecondOpinionDTO } {
  return so ? { secondOpinion: so } : {};
}

/** The external second opinion stored with a check (services/identity-external.ts SecondOpinionRecord), if any. */
function secondOpinionFromContext(c: Record<string, unknown>): IdentitySecondOpinionDTO | null {
  const r = c.secondOpinion as
    | { provider?: string | null; outcome?: string; internalDecision?: IdentityDecision; needsHumanReview?: boolean; explanation?: string; record?: { external?: { similarity?: number | null } | null } }
    | undefined;
  if (!r || typeof r !== 'object' || typeof r.outcome !== 'string') return null;
  return {
    provider: r.provider ?? null,
    outcome: r.outcome,
    internalDecision: r.internalDecision ?? 'inconclusive',
    needsHumanReview: r.needsHumanReview === true,
    externalSimilarity: r.record?.external?.similarity ?? null,
    explanation: r.explanation ?? '',
  };
}

/** Checks record the live-person outcome as `livenessPassed` (resume/reconnect) or `liveness` (check-in). */
function livenessFromContext(c: Record<string, unknown>): boolean | null {
  if (typeof c.livenessPassed === 'boolean') return c.livenessPassed;
  if (typeof c.liveness === 'boolean') return c.liveness;
  return null;
}

export function toIdentityReferenceDTO(row: IdentityReference, images: EvidenceRow[]): IdentityReferenceDTO {
  const byId = new Map(images.map((e) => [e.id, e]));
  return {
    id: row.id,
    createdAt: msReq(row.createdAt),
    active: row.active,
    supersededAt: ms(row.supersededAt),
    supersededReason: row.supersededReason ?? null,
    images: row.imageEvidenceIds.map((id) => byId.get(id)).filter((e): e is EvidenceRow => !!e).map(toEvidenceRefDTO),
    quality: row.quality ?? null,
    liveness: row.liveness ?? null,
    idPhoto: row.idPhoto ?? null,
  };
}

/* ------------------------------------------------------------------ access links */

export function accessLinkFromToken(ctx: Pick<Ctx, 'config'>, token: string): string {
  return `${ctx.config.publicUrl}${ACCESS_LINK_PATH}${token}`;
}

/** Decrypts the stored access token (null if unavailable). */
export function accessLinkFor(ctx: Pick<Ctx, 'config' | 'keyring'>, s: Pick<ExamSession, 'id' | 'accessTokenEnc'>): string | null {
  if (!s.accessTokenEnc) return null;
  try {
    return accessLinkFromToken(ctx, ctx.keyring.decryptString(s.accessTokenEnc, `access-token:${s.id}`));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ batched loaders */

/** Evidence rows grouped by event id. */
export async function loadEvidenceByEvent(db: DbOrTx, eventIds: string[]): Promise<Map<string, EvidenceRow[]>> {
  const out = new Map<string, EvidenceRow[]>();
  if (eventIds.length === 0) return out;
  const rows = await db.select().from(evidence).where(inArray(evidence.eventId, eventIds));
  for (const r of rows) {
    if (!r.eventId) continue;
    const list = out.get(r.eventId) ?? [];
    list.push(r);
    out.set(r.eventId, list);
  }
  return out;
}

/** Build EventDTOs for the given event rows (evidence, reviewer names, notes counts batched). */
export async function eventRowsToDTOs(db: DbOrTx, rows: EventRow[]): Promise<EventDTO[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const reviewerIds = [...new Set(rows.map((r) => r.reviewedBy).filter((x): x is string => !!x))];
  const [evByEvent, reviewers, noteCounts] = await Promise.all([
    loadEvidenceByEvent(db, ids),
    reviewerIds.length ? db.select({ id: staffUsers.id, name: staffUsers.name }).from(staffUsers).where(inArray(staffUsers.id, reviewerIds)) : Promise.resolve([]),
    db
      .select({ eventId: notes.eventId, n: sql<number>`count(*)::int` })
      .from(notes)
      .where(inArray(notes.eventId, ids))
      .groupBy(notes.eventId),
  ]);
  const names = new Map(reviewers.map((r) => [r.id, r.name]));
  const counts = new Map(noteCounts.map((r) => [r.eventId as string, r.n]));
  return rows.map((r) =>
    toEventDTO(r, { evidence: (evByEvent.get(r.id) ?? []).filter((e) => e.sessionId === r.sessionId), reviewerName: r.reviewedBy ? (names.get(r.reviewedBy) ?? null) : null, notesCount: counts.get(r.id) ?? 0 }),
  );
}

export async function loadEventDTO(db: DbOrTx, eventId: string): Promise<EventDTO | null> {
  const rows = await db.select().from(events).where(eq(events.id, eventId));
  if (!rows[0]) return null;
  return (await eventRowsToDTOs(db, rows))[0];
}

/** Events of one session, chronological. Extra filter conditions may be passed (drizzle SQL). */
export async function loadSessionEventDTOs(db: DbOrTx, sessionId: string, ...conds: (SQL | undefined)[]): Promise<EventDTO[]> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.sessionId, sessionId), ...conds))
    .orderBy(events.startedAt, events.firstReceivedAt);
  return eventRowsToDTOs(db, rows);
}

export async function identityCheckRowsToDTOs(db: DbOrTx, rows: IdentityCheck[]): Promise<IdentityCheckDTO[]> {
  const evIds = rows.map((r) => r.probeEvidenceId).filter((x): x is string => !!x);
  const ev = evIds.length ? await db.select().from(evidence).where(inArray(evidence.id, evIds)) : [];
  const byId = new Map(ev.map((e) => [e.id, e]));
  return rows.map((r) => toIdentityCheckDTO(r, r.probeEvidenceId ? (byId.get(r.probeEvidenceId) ?? null) : null));
}

export async function loadIdentityCheckDTOs(db: DbOrTx, sessionId: string): Promise<IdentityCheckDTO[]> {
  const rows = await db.select().from(identityChecks).where(eq(identityChecks.sessionId, sessionId)).orderBy(identityChecks.at);
  return identityCheckRowsToDTOs(db, rows);
}

export async function loadIdentityCheckDTO(db: DbOrTx, id: string): Promise<IdentityCheckDTO | null> {
  const rows = await db.select().from(identityChecks).where(eq(identityChecks.id, id));
  if (!rows[0]) return null;
  return (await identityCheckRowsToDTOs(db, rows))[0];
}

export async function loadIdentityReferenceDTOs(db: DbOrTx, sessionId: string): Promise<IdentityReferenceDTO[]> {
  const refs = await db.select().from(identityReferences).where(eq(identityReferences.sessionId, sessionId)).orderBy(identityReferences.version);
  const ids = refs.flatMap((r) => r.imageEvidenceIds);
  const ev = ids.length ? await db.select().from(evidence).where(inArray(evidence.id, ids)) : [];
  return refs.map((r) => toIdentityReferenceDTO(r, ev));
}

export async function loadPeriodDTOs(db: DbOrTx, sessionId: string): Promise<PeriodDTO[]> {
  const rows = await db.select().from(sessionPeriods).where(eq(sessionPeriods.sessionId, sessionId)).orderBy(sessionPeriods.startedAt);
  return rows.map(toPeriodDTO);
}

export async function loadPauseRequestDTOs(db: DbOrTx, sessionId: string): Promise<PauseRequestDTO[]> {
  const rows = await db.select().from(pauseRequests).where(eq(pauseRequests.sessionId, sessionId)).orderBy(pauseRequests.requestedAt);
  return rows.map(toPauseRequestDTO);
}

export async function loadNoteDTOs(db: DbOrTx, where: { sessionId?: string; eventId?: string }): Promise<NoteDTO[]> {
  const conds = [where.sessionId ? eq(notes.sessionId, where.sessionId) : undefined, where.eventId ? eq(notes.eventId, where.eventId) : undefined];
  const rows = await db
    .select({ note: notes, authorName: staffUsers.name })
    .from(notes)
    .leftJoin(staffUsers, eq(staffUsers.id, notes.authorId))
    .where(and(...conds))
    .orderBy(notes.createdAt, notes.id);
  return rows.map((r) => toNoteDTO(r.note, r.authorName ?? 'Unknown'));
}

export async function loadDeviceRecordDTOs(db: DbOrTx, sessionId: string): Promise<DeviceRecordDTO[]> {
  const rows = await db.select().from(deviceRecords).where(eq(deviceRecords.sessionId, sessionId)).orderBy(deviceRecords.at);
  return rows.map(toDeviceRecordDTO);
}

export interface SessionCounts {
  integrity: number;
  uncertain: number;
  technical: number;
  unreviewed: number;
  open: number;
  highSeverity: number;
  /** Arrival of the oldest undecided flag (review service-level target). */
  oldestUndecidedAt: number | null;
  undecided: { integrity: number; uncertain: number; technical: number };
  topUndecidedSeverity: Severity | null;
}

const ZERO_COUNTS: SessionCounts = {
  integrity: 0,
  uncertain: 0,
  technical: 0,
  unreviewed: 0,
  open: 0,
  highSeverity: 0,
  oldestUndecidedAt: null,
  undecided: { integrity: 0, uncertain: 0, technical: 0 },
  topUndecidedSeverity: null,
};
const publicCounts = (c: SessionCounts): SessionSummaryDTO['counts'] => ({ integrity: c.integrity, uncertain: c.uncertain, technical: c.technical, unreviewed: c.unreviewed, open: c.open, highSeverity: c.highSeverity });
/** Flags: the categories reviewers decide (not session changes or policy exceptions). */
const FLAG_SQL = sql`${events.category} in ('integrity', 'uncertain', 'technical')`;
const SEVERITY_BY_RANK: Record<number, Severity> = { 0: 'info', 1: 'low', 2: 'medium', 3: 'high' };

/** Per-session event counts (dismissed events excluded from category counts). */
export async function loadSessionCounts(db: DbOrTx, sessionIds: string[]): Promise<Map<string, SessionCounts>> {
  const out = new Map<string, SessionCounts>();
  if (sessionIds.length === 0) return out;
  const rows = await db
    .select({
      sessionId: events.sessionId,
      integrity: sql<number>`count(*) filter (where ${events.category} = 'integrity' and ${events.reviewStatus} <> 'dismissed')::int`,
      uncertain: sql<number>`count(*) filter (where ${events.category} = 'uncertain' and ${events.reviewStatus} <> 'dismissed')::int`,
      technical: sql<number>`count(*) filter (where ${events.category} = 'technical' and ${events.reviewStatus} <> 'dismissed')::int`,
      unreviewed: sql<number>`count(*) filter (where ${FLAG_SQL} and ${events.reviewStatus} = 'unreviewed')::int`,
      open: sql<number>`count(*) filter (where ${FLAG_SQL} and ${events.status} = 'open')::int`,
      highSeverity: sql<number>`count(*) filter (where ${events.severity} = 'high' and ${events.reviewStatus} <> 'dismissed')::int`,
      oldestUndecidedAt: sql<Date | null>`min(${events.firstReceivedAt}) filter (where ${FLAG_SQL} and ${events.reviewStatus} = 'unreviewed')`,
      undecidedIntegrity: sql<number>`count(*) filter (where ${events.category} = 'integrity' and ${events.reviewStatus} = 'unreviewed')::int`,
      undecidedUncertain: sql<number>`count(*) filter (where ${events.category} = 'uncertain' and ${events.reviewStatus} = 'unreviewed')::int`,
      undecidedTechnical: sql<number>`count(*) filter (where ${events.category} = 'technical' and ${events.reviewStatus} = 'unreviewed')::int`,
      topUndecidedSeverity: sql<number | null>`max(case ${events.severity} when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end) filter (where ${FLAG_SQL} and ${events.reviewStatus} = 'unreviewed')`,
    })
    .from(events)
    .where(inArray(events.sessionId, sessionIds))
    .groupBy(events.sessionId);
  for (const r of rows) {
    out.set(r.sessionId, {
      integrity: r.integrity,
      uncertain: r.uncertain,
      technical: r.technical,
      unreviewed: r.unreviewed,
      open: r.open,
      highSeverity: r.highSeverity,
      oldestUndecidedAt: r.oldestUndecidedAt ? new Date(r.oldestUndecidedAt).getTime() : null,
      undecided: { integrity: r.undecidedIntegrity, uncertain: r.undecidedUncertain, technical: r.undecidedTechnical },
      topUndecidedSeverity: r.topUndecidedSeverity == null ? null : SEVERITY_BY_RANK[r.topUndecidedSeverity] ?? null,
    });
  }
  return out;
}

export function toScoreDTO(score: ExamSession['score']): SessionScoreDTO | null {
  if (!score) return null;
  return {
    points: score.points,
    maxPoints: score.maxPoints,
    autoGraded: score.autoGraded,
    regrades: (score.regrades ?? []).map((r) => ({ at: r.at, byStaffId: r.by, reason: r.reason, keysFromVersion: r.keysFromVersion, previous: r.previous })),
  };
}

export function toSessionSummaryDTO(
  ctx: Pick<Ctx, 'config' | 'keyring'>,
  input: {
    session: ExamSession;
    exam: { id: string; title: string };
    /** The exam version the attempt is pinned to (null before it starts). */
    examVersion?: { id: string; number: number } | null;
    candidate: Pick<Candidate, 'id' | 'name' | 'email' | 'externalId'>;
    counts?: SessionCounts;
    pendingPauseRequest?: PauseRequest | null;
    /** The access link is a bearer credential: only for admin+ on explicit detail / assignment responses. */
    includeAccessLink?: boolean;
  },
  now: number,
): SessionSummaryDTO {
  const s = input.session;
  const mon = s.monitoring;
  return {
    id: s.id,
    exam: { id: input.exam.id, title: input.exam.title },
    examVersion: input.examVersion ?? null,
    accommodations: (s.accommodations?.items ?? []).map((i) => i.kind),
    candidate: { id: input.candidate.id, name: input.candidate.name, email: input.candidate.email ?? null, externalId: input.candidate.externalId ?? null },
    status: s.status,
    endReason: s.endReason ?? null,
    connection: s.connection,
    lastHeartbeatAt: ms(s.lastHeartbeatAt),
    reportingInterruptedSince: ms(s.reportingInterruptedSince),
    monitoring: mon ? { state: mon.state, faces: mon.faces, label: mon.label, open: mon.open ?? [], lookDirection: mon.lookDirection ?? null, at: mon.at } : null,
    identity: { lastDecision: s.lastIdentityDecision ?? null, lastAt: ms(s.lastIdentityAt), lastSimilarity: s.lastIdentitySimilarity ?? null },
    remainingMs: remainingMs(s, now),
    timerRunning: s.runningSince != null,
    startedAt: ms(s.startedAt),
    endedAt: ms(s.endedAt),
    pauseCount: s.pauseCount,
    counts: publicCounts(input.counts ?? ZERO_COUNTS),
    pendingPauseRequest: input.pendingPauseRequest ? toPauseRequestDTO(input.pendingPauseRequest) : null,
    hold: toHoldDTO(s),
    accessLink: input.includeAccessLink ? accessLinkFor(ctx, s) : null,
    legalHold: s.legalHold,
    window: sessionWindow(s),
    reconnectCount: s.reconnectCount,
  };
}

/**
 * Everything of a session row that staff can see in its SessionSummaryDTO, except values that change on every
 * heartbeat without meaning anything new (lastHeartbeatAt, monitoring.at, the clock ticking down — the UI
 * extrapolates remainingMs). Two rows with the same key render the same summary (up to those fields), so a
 * mutation that leaves the key unchanged does not need a realtime update (services/session-state.ts).
 */
export function staffVisibleKey(s: ExamSession): string {
  const m = s.monitoring;
  return JSON.stringify([
    s.status,
    s.endReason ?? null,
    s.connection,
    ms(s.reportingInterruptedSince),
    m ? [m.state, m.faces, m.label, m.open ?? [], m.lookDirection ?? null] : null,
    s.lastIdentityDecision ?? null,
    ms(s.lastIdentityAt),
    s.lastIdentitySimilarity ?? null,
    s.durationMs,
    s.usedMs,
    ms(s.runningSince),
    ms(s.startedAt),
    ms(s.endedAt),
    s.pauseCount,
    s.holdReason ?? null,
    ms(s.holdSince),
    s.holdMessage ?? null,
    s.holdCanReverify,
    s.legalHold,
    ms(s.windowStartsAt),
    ms(s.windowEndsAt),
    s.reconnectCount,
  ]);
}

export interface SessionSummaryQuery {
  orgId: string;
  sessionIds?: string[];
  where?: SQL;
  limit?: number;
  offset?: number;
  orderBy?: SQL[];
  /**
   * Include the candidate access link (a bearer credential). Default false: summaries are also broadcast over
   * the staff WebSocket and returned to reviewers. Set only for admin+ on explicit detail / assignment responses.
   */
  includeAccessLink?: boolean;
}

/**
 * Load SessionSummaryDTOs (batched: counts, pending pause requests). `where` may reference
 * examSessions / exams / candidates columns (they are joined).
 */
export async function loadSessionSummaries(ctx: Pick<Ctx, 'config' | 'keyring' | 'now'>, db: DbOrTx, q: SessionSummaryQuery): Promise<SessionSummaryDTO[]> {
  const conds: (SQL | undefined)[] = [eq(examSessions.orgId, q.orgId)];
  if (q.sessionIds) {
    if (q.sessionIds.length === 0) return [];
    conds.push(inArray(examSessions.id, q.sessionIds));
  }
  if (q.where) conds.push(q.where);
  let query = db
    .select({
      session: examSessions,
      exam: { id: exams.id, title: exams.title },
      examVersion: { id: examVersions.id, number: examVersions.number },
      candidate: { id: candidates.id, name: candidates.name, email: candidates.email, externalId: candidates.externalId },
      // Review state and the organisation's targets in the same query (one query set for any number of sessions).
      review: sessionReviews,
      assigneeName: reviewAssignee.name,
      orgSettings: organizations.settings,
    })
    .from(examSessions)
    .innerJoin(exams, eq(exams.id, examSessions.examId))
    .innerJoin(candidates, eq(candidates.id, examSessions.candidateId))
    .innerJoin(organizations, eq(organizations.id, examSessions.orgId))
    .leftJoin(examVersions, eq(examVersions.id, examSessions.examVersionId))
    .leftJoin(sessionReviews, eq(sessionReviews.sessionId, examSessions.id))
    .leftJoin(reviewAssignee, eq(reviewAssignee.id, sessionReviews.assigneeId))
    .where(and(...conds))
    .orderBy(...(q.orderBy ?? [desc(examSessions.updatedAt)]))
    .$dynamic();
  if (q.limit != null) query = query.limit(q.limit);
  if (q.offset != null) query = query.offset(q.offset);
  const rows = await query;
  const ids = rows.map((r) => r.session.id);
  const [counts, pending] = await Promise.all([
    loadSessionCounts(db, ids),
    ids.length ? db.select().from(pauseRequests).where(and(inArray(pauseRequests.sessionId, ids), eq(pauseRequests.status, 'pending'))) : Promise.resolve([] as PauseRequest[]),
  ]);
  const pendingBySession = new Map(pending.map((p) => [p.sessionId, p]));
  const sla = orgSettings(rows[0] ? { settings: rows[0].orgSettings } : null).reviewSla;
  const now = ctx.now();
  return rows.map((r) => {
    const dto = toSessionSummaryDTO(
      ctx,
      { session: r.session, exam: r.exam, examVersion: r.examVersion, candidate: r.candidate, counts: counts.get(r.session.id), pendingPauseRequest: pendingBySession.get(r.session.id) ?? null, includeAccessLink: q.includeAccessLink === true },
      now,
    );
    dto.review = toReviewSummary(r.session, counts.get(r.session.id), r.review ? { ...r.review, assigneeName: r.assigneeName } : null, sla, now);
    return dto;
  });
}

/** Identity verifications by staff (identity_verified_by_staff events), oldest first. */
export async function loadStaffVerifications(db: DbOrTx, sessionId: string): Promise<StaffVerificationDTO[]> {
  const rows = await db
    .select({ at: events.startedAt, details: events.details })
    .from(events)
    .where(and(eq(events.sessionId, sessionId), eq(events.type, 'identity_verified_by_staff')))
    .orderBy(events.startedAt);
  const byIds = [...new Set(rows.map((r) => (r.details as { by?: string }).by).filter((x): x is string => !!x))];
  const staff = byIds.length ? await db.select({ id: staffUsers.id, name: staffUsers.name }).from(staffUsers).where(inArray(staffUsers.id, byIds)) : [];
  const names = new Map(staff.map((s) => [s.id, s.name]));
  return rows.map((r) => {
    const d = r.details as { by?: string; method?: StaffVerificationMethod; purpose?: CheckPurpose | null; note?: string | null };
    return { at: r.at.getTime(), by: d.by ? { id: d.by, name: names.get(d.by) ?? 'Former staff member' } : null, method: d.method ?? 'other', purpose: d.purpose ?? null, note: d.note ?? null };
  });
}

/** Summary of a single session regardless of org (caller must authorise). */
export async function loadSessionSummary(ctx: Pick<Ctx, 'config' | 'keyring' | 'now'>, db: DbOrTx, sessionId: string): Promise<SessionSummaryDTO | null> {
  const [s] = await db.select({ orgId: examSessions.orgId }).from(examSessions).where(eq(examSessions.id, sessionId));
  if (!s) return null;
  const [dto] = await loadSessionSummaries(ctx, db, { orgId: s.orgId, sessionIds: [sessionId] });
  return dto ?? null;
}

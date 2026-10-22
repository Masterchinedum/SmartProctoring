/**
 * Exam recording (policy.recording, off by default; packages/shared/src/recording.ts).
 *
 * The candidate's browser records the webcam (with the microphone when the exam records audio) and the shared screen
 * in short, individually playable segments and uploads them in order (POST /api/candidate/recordings/segments). Each
 * segment is stored as an evidence row of kind `recording` — encrypted exactly like an image (services/evidence.ts
 * storeEvidence: AES-256-GCM, AAD bound to the evidence id, the organisation's storage location) — plus a
 * recording_segments row saying which stream it belongs to and when it plays. Retention, legal holds, consent
 * withdrawal, erasure, the personal-data export, `storage:move` and `rekey` therefore cover recordings by construction.
 *
 * Accepting a segment:
 *  - the exam must record that stream (409 recording_not_enabled) and the candidate must have accepted the notice that
 *    covers recording (409 consent_required);
 *  - from the browser in control while the exam has not ended; after the end, segments the last verified browser
 *    recorded (still queued on the device — a page reopened after submitting uploads them) for
 *    config.recording.lateUploadMs, never after a consent withdrawal or once the session's evidence was deleted
 *    (409 recording_closed; an erased session's link no longer authenticates at all);
 *  - only segments that started while the exam was observed: not before the start, not inside a pause or hold, not
 *    after the end (200 with stored=false and the reason: the browser drops them);
 *  - at most config.recording.maxSessionBytes per session (413 recording_limit), separate from the image budget;
 *  - idempotent on (session, stream, recording instance, seq): a re-upload answers duplicate=true.
 */
import {
  consentCoversRecording,
  recordingContainerType,
  recordingPlan,
  RECORDING_STREAMS,
  type ProctoringPolicy,
  type RecordingContainerType,
  type RecordingSegmentDTO,
  type RecordingSegmentQuery,
  type RecordingSegmentUploadResponse,
  type RecordingStream,
  type SessionRecordingDTO,
  type SessionRecordingSummaryDTO,
} from '@sp/shared';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import type { DbOrTx } from '../db/index.js';
import { evidence, examSessions, recordingSegments, sessionPeriods, type EvidenceRow, type ExamSession, type RecordingSegmentRow } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { conflict, HttpError, notFound } from '../lib/errors.js';
import { assertInControl } from './candidate-state.js';
import { purgeEvidenceRows, readEvidence, storeEvidence, transactionWithEvidence, type StaffActor } from './evidence.js';
import { BLOCKING_PERIOD_KINDS, TERMINAL } from './session-state.js';

/** A segment may start this much before the exam's start / after its end (clock offsets, a recorder stopping late). */
const BOUNDARY_TOLERANCE_MS = 5_000;
/** A start time further in the future than this (a wrong client clock) is clamped to now. */
const FUTURE_TOLERANCE_MS = 60_000;
const MAX_MIME_LENGTH = 100;

/** The first bytes of the container the request says it sends: an EBML header (WebM) or an `ftyp` box (MP4). */
export function looksLikeRecording(body: Buffer, container: RecordingContainerType): boolean {
  if (container === 'video/webm') return body.length >= 4 && body.readUInt32BE(0) === 0x1a45dfa3;
  return body.length >= 12 && body.toString('latin1', 4, 8) === 'ftyp';
}

/** The session's recording is gone for good: the candidate withdrew consent, or its evidence was deleted. */
function recordingClosed(s: Pick<ExamSession, 'endReason' | 'evidencePurgedAt'>): boolean {
  return s.endReason === 'candidate_withdrew' || s.evidencePurgedAt != null;
}

const closedError = (why: string) => new HttpError(409, 'recording_closed', `The recording of this exam is no longer accepted (${why}).`);

/** Bytes of recording stored for a session (segments not deleted). */
export async function sessionRecordingBytes(db: DbOrTx, sessionId: string): Promise<number> {
  const [row] = await db
    .select({ bytes: sql<number>`coalesce(sum(${evidence.byteSize}), 0)::bigint` })
    .from(evidence)
    .where(and(eq(evidence.sessionId, sessionId), eq(evidence.kind, 'recording'), isNull(evidence.purgedAt)));
  return Number(row?.bytes ?? 0);
}

async function findSegment(db: DbOrTx, sessionId: string, stream: RecordingStream, instance: string, seq: number): Promise<RecordingSegmentRow | undefined> {
  const [row] = await db
    .select()
    .from(recordingSegments)
    .where(and(eq(recordingSegments.sessionId, sessionId), eq(recordingSegments.stream, stream), eq(recordingSegments.clientInstanceId, instance), eq(recordingSegments.seq, seq)));
  return row;
}

/** Thrown inside the storing transaction when a concurrent upload stored the same segment first (rolls back its blob). */
class DuplicateSegment extends Error {}

/** POST /api/candidate/recordings/segments */
export async function uploadRecordingSegment(
  ctx: Ctx,
  auth: { session: ExamSession; policy: ProctoringPolicy },
  headerInstanceId: string,
  q: RecordingSegmentQuery,
  contentType: string | undefined,
  body: Buffer,
): Promise<RecordingSegmentUploadResponse> {
  const { session, policy } = auth;
  const plan = recordingPlan(policy);
  if (!plan.any || (q.stream === 'camera' && !plan.camera) || (q.stream === 'screen' && !plan.screen)) {
    throw conflict('recording_not_enabled', q.stream === 'screen' ? 'This exam does not record the screen.' : 'This exam does not record the camera.');
  }
  const container = recordingContainerType(contentType);
  if (!container || !Buffer.isBuffer(body) || body.length === 0 || !looksLikeRecording(body, container)) {
    ctx.metrics.recordingRefused.inc({ reason: 'invalid' });
    throw new HttpError(415, 'invalid_recording', 'Expected a recording segment (Content-Type video/webm or video/mp4).');
  }
  const mimeType = (contentType ?? container).replace(/[^\w/.;=,+ -]/g, '').slice(0, MAX_MIME_LENGTH) || container;
  // The browser instance that recorded it: a reloaded page uploads what the previous one queued.
  const recordedBy = q.instance ?? headerInstanceId;

  const existing = await findSegment(ctx.db, session.id, q.stream, recordedBy, q.seq);
  if (existing) return { stored: true, duplicate: true, segmentId: existing.id };

  if (recordingClosed(session)) {
    ctx.metrics.recordingRefused.inc({ reason: 'closed' });
    throw closedError(session.endReason === 'candidate_withdrew' ? 'consent was withdrawn' : 'its evidence was deleted');
  }
  if (!consentCoversRecording(session.consentNoticeVersion, plan)) {
    throw conflict('consent_required', 'The candidate has not accepted the privacy notice that covers recording, so nothing is recorded.');
  }
  const now = ctx.now();
  if (TERMINAL.includes(session.status)) {
    // After the end only what the last verified browser recorded, and only for the grace period.
    if (recordedBy !== session.verifiedInstanceId) throw closedError('the exam has ended');
    if (session.endedAt && now - session.endedAt.getTime() > ctx.config.recording.lateUploadMs) {
      ctx.metrics.recordingRefused.inc({ reason: 'closed' });
      throw closedError('the time for uploading after the exam ended has passed');
    }
  } else {
    assertInControl(session, headerInstanceId);
  }

  const startedAt = Math.min(q.startedAt, now + FUTURE_TOLERANCE_MS);
  if (!session.startedAt || startedAt < session.startedAt.getTime() - BOUNDARY_TOLERANCE_MS) return { stored: false, duplicate: false, segmentId: null, reason: 'before_start' };
  if (session.endedAt && startedAt > session.endedAt.getTime() + BOUNDARY_TOLERANCE_MS) return { stored: false, duplicate: false, segmentId: null, reason: 'after_end' };
  const periods = await ctx.db.select().from(sessionPeriods).where(eq(sessionPeriods.sessionId, session.id));
  const unobserved = periods.some((p) => BLOCKING_PERIOD_KINDS.includes(p.kind) && startedAt >= p.startedAt.getTime() && startedAt < (p.endedAt?.getTime() ?? Infinity));
  if (unobserved) return { stored: false, duplicate: false, segmentId: null, reason: 'during_unobserved_period' };

  // Per-session cap (approximate under concurrent uploads: at most one segment over).
  if ((await sessionRecordingBytes(ctx.db, session.id)) + body.length > ctx.config.recording.maxSessionBytes) {
    ctx.metrics.recordingRefused.inc({ reason: 'limit' });
    throw new HttpError(
      413,
      'recording_limit',
      `The recording limit for this exam session (${Math.round(ctx.config.recording.maxSessionBytes / (1024 * 1024))} MB) has been reached, so no more of the recording can be stored. Your exam continues.`,
    );
  }

  let stored: { segment: RecordingSegmentRow; row: EvidenceRow };
  try {
    stored = await transactionWithEvidence(ctx, async (tx) => {
      const { row } = await storeEvidence(ctx, tx, {
        orgId: session.orgId,
        sessionId: session.id,
        candidateId: session.candidateId,
        kind: 'recording',
        reason: q.stream,
        capturedAt: startedAt,
        data: body,
        contentType: container,
        clientInstanceId: recordedBy,
      });
      const [segment] = await tx
        .insert(recordingSegments)
        .values({
          orgId: session.orgId,
          sessionId: session.id,
          evidenceId: row.id,
          stream: q.stream,
          seq: q.seq,
          startedAt: new Date(startedAt),
          durationMs: Math.round(q.durationMs),
          mimeType,
          byteSize: body.length,
          clientInstanceId: recordedBy,
          createdAt: new Date(now),
        })
        .onConflictDoNothing()
        .returning();
      if (!segment) throw new DuplicateSegment();
      return { segment, row };
    });
  } catch (err) {
    if (!(err instanceof DuplicateSegment)) throw err;
    const again = await findSegment(ctx.db, session.id, q.stream, recordedBy, q.seq);
    return { stored: true, duplicate: true, segmentId: again?.id ?? null };
  }

  // The candidate may have withdrawn consent (or retention run) while this upload was in flight: the purge has then
  // already run, so this segment is deleted here.
  const [after] = await ctx.db.select({ endReason: examSessions.endReason, evidencePurgedAt: examSessions.evidencePurgedAt }).from(examSessions).where(eq(examSessions.id, session.id));
  if (after && recordingClosed(after)) {
    await purgeEvidenceRows(ctx, ctx.db, [stored.row], after.endReason === 'candidate_withdrew' ? 'consent_withdrawn' : 'retention');
    ctx.metrics.recordingRefused.inc({ reason: 'closed' });
    throw closedError(after.endReason === 'candidate_withdrew' ? 'consent was withdrawn' : 'its evidence was deleted');
  }
  ctx.metrics.recordingSegments.inc({ stream: q.stream });
  ctx.metrics.recordingBytes.inc({ stream: q.stream }, body.length);
  return { stored: true, duplicate: false, segmentId: stored.segment.id };
}

/* ------------------------------------------------------------------ staff */

function toSegmentDTO(s: RecordingSegmentRow, e: Pick<EvidenceRow, 'purgedAt' | 'purgeReason'>): RecordingSegmentDTO {
  const startedAt = s.startedAt.getTime();
  return {
    id: s.id,
    stream: s.stream,
    seq: s.seq,
    startedAt,
    durationMs: s.durationMs,
    endedAt: startedAt + s.durationMs,
    mimeType: s.mimeType,
    byteSize: s.byteSize,
    clientInstanceId: s.clientInstanceId,
    available: e.purgedAt == null,
    deletedAt: e.purgedAt ? e.purgedAt.getTime() : null,
    deletedBecause: e.purgedAt ? (e.purgeReason ?? 'deleted') : null,
  };
}

/** A session's segments (with their evidence state), oldest first. */
export async function loadRecordingSegments(db: DbOrTx, sessionId: string): Promise<RecordingSegmentDTO[]> {
  const rows = await db
    .select({ s: recordingSegments, purgedAt: evidence.purgedAt, purgeReason: evidence.purgeReason })
    .from(recordingSegments)
    .innerJoin(evidence, eq(evidence.id, recordingSegments.evidenceId))
    .where(eq(recordingSegments.sessionId, sessionId))
    .orderBy(asc(recordingSegments.startedAt), asc(recordingSegments.stream), asc(recordingSegments.seq));
  return rows.map((r) => toSegmentDTO(r.s, r));
}

/** GET /api/admin/sessions/:id/recordings (segment metadata only; the media is a separate, audited request). */
export async function sessionRecording(db: DbOrTx, orgId: string, sessionId: string): Promise<SessionRecordingDTO> {
  const [s] = await db
    .select({ id: examSessions.id })
    .from(examSessions)
    .where(and(eq(examSessions.id, sessionId), eq(examSessions.orgId, orgId)));
  if (!s) throw notFound('Session not found', 'session_not_found');
  const segments = await loadRecordingSegments(db, sessionId);
  const streams = Object.fromEntries(
    RECORDING_STREAMS.map((stream) => {
      const mine = segments.filter((x) => x.stream === stream);
      return [
        stream,
        {
          segments: mine.length,
          durationMs: mine.reduce((n, x) => n + x.durationMs, 0),
          bytes: mine.reduce((n, x) => n + x.byteSize, 0),
          firstAt: mine.length ? mine[0].startedAt : null,
          lastAt: mine.length ? Math.max(...mine.map((x) => x.endedAt)) : null,
        },
      ];
    }),
  ) as SessionRecordingDTO['streams'];
  return { sessionId, segments, streams };
}

/** What was recorded of a session (session page, report); null when nothing was. */
export async function recordingSummary(db: DbOrTx, sessionId: string): Promise<SessionRecordingSummaryDTO | null> {
  const [r] = await db
    .select({
      segments: sql<number>`count(*)::int`,
      available: sql<number>`(count(*) filter (where ${evidence.purgedAt} is null))::int`,
      cameraMs: sql<number>`coalesce(sum(${recordingSegments.durationMs}) filter (where ${recordingSegments.stream} = 'camera'), 0)::bigint`,
      screenMs: sql<number>`coalesce(sum(${recordingSegments.durationMs}) filter (where ${recordingSegments.stream} = 'screen'), 0)::bigint`,
      bytes: sql<number>`coalesce(sum(${recordingSegments.byteSize}), 0)::bigint`,
      deletedAt: sql<Date | null>`max(${evidence.purgedAt})`,
      deletedBecause: sql<string | null>`max(${evidence.purgeReason})`,
    })
    .from(recordingSegments)
    .innerJoin(evidence, eq(evidence.id, recordingSegments.evidenceId))
    .where(eq(recordingSegments.sessionId, sessionId));
  if (!r || !r.segments) return null;
  const allDeleted = r.available === 0;
  return {
    segments: r.segments,
    available: r.available,
    cameraMs: Number(r.cameraMs),
    screenMs: Number(r.screenMs),
    bytes: Number(r.bytes),
    deletedAt: allDeleted && r.deletedAt ? new Date(r.deletedAt).getTime() : null,
    deletedBecause: allDeleted ? (r.deletedBecause ?? 'deleted') : null,
  };
}

/**
 * Staff access to one segment's media: checks the organisation, decrypts, and (when `auditView`) writes a
 * `recording.view` audit record. Returns null when not found / another organisation; `data: null` when deleted or
 * missing from storage.
 */
export async function readRecordingSegmentForStaff(
  ctx: Ctx,
  segmentId: string,
  actor: StaffActor,
  opts: { auditView: boolean },
): Promise<{ segment: RecordingSegmentRow; row: EvidenceRow; data: Buffer | null } | null> {
  const [hit] = await ctx.db
    .select({ segment: recordingSegments, row: evidence })
    .from(recordingSegments)
    .innerJoin(evidence, eq(evidence.id, recordingSegments.evidenceId))
    .where(eq(recordingSegments.id, segmentId));
  if (!hit || hit.segment.orgId !== actor.orgId || hit.row.orgId !== actor.orgId) return null;
  const data = await readEvidence(ctx, hit.row);
  if (opts.auditView) {
    await audit(ctx.db, {
      orgId: actor.orgId,
      actorType: 'staff',
      actorId: actor.id,
      action: 'recording.view',
      targetType: 'session',
      targetId: hit.segment.sessionId,
      meta: { segmentId: hit.segment.id, evidenceId: hit.row.id, stream: hit.segment.stream, seq: hit.segment.seq, startedAt: hit.segment.startedAt.getTime(), available: data != null },
      ip: actor.ip ?? null,
      at: ctx.now(),
    });
  }
  return { ...hit, data };
}

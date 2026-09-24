/**
 * Helpers shared by check completion and mid-exam identity samples: reference loading, frame
 * reconstruction, evidence copies, context ("what preceded this").
 */
import { randomUUID } from 'node:crypto';
import type { IdentityCheckTrigger, IdentityResultDTO, PeriodKind } from '@sp/shared';
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import type { DbOrTx } from '../db/index.js';
import { events, identityReferences, type CheckFrame, type EvidenceRow, type FrameAnalysisSummary, type IdentityCheck, type IdentityReference } from '../db/schema.js';
import { deserializeEmbeddings } from '../vision/index.js';
import type { DetectedFace, ImageAnalysis } from '../vision/types.js';
import { readEvidence, storeEvidence } from './evidence.js';

export const referenceAad = (id: string) => `reference:${id}`;
export const frameAad = (id: string) => `frame:${id}`;
export const idPhotoAad = (candidateId: string) => `idphoto:${candidateId}`;
export const sampleFrameAad = (id: string) => `sample-frame:${id}`;

export interface ActiveReference {
  ref: IdentityReference;
  embeddings: Float32Array[];
}

export async function loadActiveReference(ctx: Pick<Ctx, 'keyring'>, db: DbOrTx, sessionId: string): Promise<ActiveReference | null> {
  const [ref] = await db
    .select()
    .from(identityReferences)
    .where(and(eq(identityReferences.sessionId, sessionId), eq(identityReferences.active, true)))
    .orderBy(desc(identityReferences.version))
    .limit(1);
  if (!ref || !ref.embeddingsEnc) return null;
  return { ref, embeddings: deserializeEmbeddings(ctx.keyring.decrypt(ref.embeddingsEnc, referenceAad(ref.id))) };
}

/** Rebuild an ImageAnalysis from a stored check frame (embedding decrypted). */
export function frameToAnalysis(ctx: Pick<Ctx, 'keyring'>, f: CheckFrame): ImageAnalysis {
  let embedding: Float32Array | null = null;
  if (f.embeddingEnc) {
    try {
      embedding = deserializeEmbeddings(ctx.keyring.decrypt(f.embeddingEnc, frameAad(f.id)))[0] ?? null;
    } catch {
      embedding = null;
    }
  }
  return analysisFromSummary(f.analysis, embedding);
}

/** Rebuild an ImageAnalysis from a stored analysis summary (summarizeAnalysis) and its (decrypted) embedding. */
export function analysisFromSummary(a: FrameAnalysisSummary, embedding: Float32Array | null): ImageAnalysis {
  const primary: DetectedFace | null =
    a.box && a.landmarks && a.landmarks.length === 5 ? { box: a.box, score: a.score ?? a.quality.detectionScore, landmarks: a.landmarks as DetectedFace['landmarks'] } : null;
  return {
    width: a.width,
    height: a.height,
    faces: primary ? [primary] : [],
    primary,
    pose: a.pose,
    quality: a.quality,
    embedding,
    dhash: a.dhash,
    faceCropJpeg: null,
    imageBrightness: a.imageBrightness,
  };
}

/** Summary stored per frame (everything needed to rebuild the analysis except the embedding). */
export function summarizeAnalysis(a: ImageAnalysis) {
  return {
    faceCount: a.quality.faceCount,
    quality: a.quality,
    pose: a.pose ? { yawDeg: a.pose.yawDeg, pitchDeg: a.pose.pitchDeg, rollDeg: a.pose.rollDeg } : null,
    dhash: a.dhash,
    imageBrightness: a.imageBrightness,
    width: a.width,
    height: a.height,
    box: a.primary ? a.primary.box : null,
    landmarks: a.primary ? a.primary.landmarks.map((p) => ({ x: p.x, y: p.y })) : null,
    score: a.primary ? a.primary.score : null,
  };
}

/**
 * Decrypt and re-store an evidence image under a new id (e.g. reference images linked to a mismatch event).
 * `sessionId` attaches a copy of a candidate-level image (the approved ID photo) to a session: the copy is then
 * that session's evidence — listed with its event, purged by the session's retention, kept under its legal hold.
 */
export async function copyEvidence(
  ctx: Ctx,
  db: DbOrTx,
  src: EvidenceRow,
  patch: { kind?: EvidenceRow['kind']; eventId?: string | null; identityCheckId?: string | null; reason?: string | null; sessionId?: string },
): Promise<EvidenceRow | null> {
  const data = await readEvidence(ctx, src);
  if (!data) return null;
  const { row } = await storeEvidence(ctx, db, {
    id: randomUUID(),
    orgId: src.orgId,
    sessionId: patch.sessionId ?? src.sessionId,
    candidateId: src.candidateId,
    eventId: patch.eventId ?? null,
    identityCheckId: patch.identityCheckId ?? null,
    kind: patch.kind ?? src.kind,
    reason: patch.reason ?? src.reason,
    capturedAt: src.capturedAt.getTime(),
    data,
    contentType: src.contentType,
  });
  return row;
}

export function toIdentityResultDTO(row: IdentityCheck): IdentityResultDTO {
  return {
    id: row.id,
    trigger: row.trigger,
    decision: row.decision,
    similarity: row.similarity ?? null,
    confidence: row.confidence,
    quality: row.quality ?? null,
    guidance: row.guidance ?? [],
    at: row.at.getTime(),
  };
}

const TRIGGER_CONTEXT: Partial<Record<IdentityCheckTrigger, string>> = {
  face_return: 'face_absence',
  camera_reconnect: 'camera_reconnect',
  after_multiple_people: 'multiple_people',
  after_obstruction: 'obstruction',
  follow_up: 'previous_non_match',
  server_request: 'previous_non_match',
  track_break: 'face_track_break',
  appearance_change: 'appearance_change',
  exam_start: 'exam_start',
  resume: 'pause',
  reconnect: 'disconnection',
  reverify: 'hold',
};

const RECENT_EVENT_CONTEXT: Partial<Record<string, string>> = {
  candidate_absent: 'face_absence',
  camera_disconnected: 'camera_disconnect',
  camera_permission_lost: 'camera_disconnect',
  camera_changed: 'camera_change',
  multiple_people: 'multiple_people',
  face_obstructed: 'obstruction',
  camera_covered: 'obstruction',
  session_resumed: 'pause',
  reporting_interrupted: 'disconnection',
  unobserved_period: 'unobserved_period',
};

/** "What preceded this identity observation": trigger + events that ended/started within `windowMs` before `at`. */
export async function precedingContext(
  db: DbOrTx,
  sessionId: string,
  at: number,
  trigger: IdentityCheckTrigger,
  windowMs = 3 * 60_000,
): Promise<{ precededBy: string[]; recentEvents: { type: string; startedAt: number; endedAt: number | null }[] }> {
  const tags = new Set<string>();
  const t = TRIGGER_CONTEXT[trigger];
  if (t) tags.add(t);
  const rows = await db
    .select({ type: events.type, startedAt: events.startedAt, endedAt: events.endedAt })
    .from(events)
    .where(and(eq(events.sessionId, sessionId), inArray(events.type, Object.keys(RECENT_EVENT_CONTEXT) as never[]), lte(events.startedAt, new Date(at)), gte(events.startedAt, new Date(at - 24 * 3600_000))))
    .orderBy(desc(events.startedAt))
    .limit(50);
  const recent: { type: string; startedAt: number; endedAt: number | null }[] = [];
  for (const r of rows) {
    const end = r.endedAt?.getTime() ?? at;
    if (at - end <= windowMs) {
      const tag = RECENT_EVENT_CONTEXT[r.type];
      if (tag) tags.add(tag);
      recent.push({ type: r.type, startedAt: r.startedAt.getTime(), endedAt: r.endedAt?.getTime() ?? null });
    }
  }
  return { precededBy: [...tags], recentEvents: recent.slice(0, 10) };
}

export type { PeriodKind };

/**
 * Evidence for reviewing a possible person swap (GET /api/admin/identity/compare/:eventId).
 *
 * Gathers comparable images of the original candidate (the identity reference that was active when
 * the event began, or the approved ID photo for an ID-photo comparison) and of the person seen later
 * (the identity checks behind the event, plus the last clean match before it), the similarity range
 * against the organisation's thresholds, the surrounding timeline (+/- 10 minutes) and neutral
 * environment notes. Environment differences are phrased as context only — never as evidence.
 */
import type { EventDTO, EvidenceRefDTO, FaceQuality, IdentityCheckDTO, IdentityComparisonDTO, QualityIssue } from '@sp/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { candidates, deviceRecords, events, evidence, examSessions, identityChecks, identityReferences, organizations, type EvidenceRow, type IdentityReference } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { toEvidenceRefDTO } from './dto.js';
import { orgThresholds } from './org.js';
import { formatDuration, listJoin, makeClock, type Clock } from './reports-format.js';
import { loadSessionTimeline, timelineWindow } from './reports-timeline.js';

export const SURROUNDING_WINDOW_MS = 10 * 60_000;

/** Face-brightness difference (0..255 scale) worth mentioning as context. */
const BRIGHTNESS_NOTE_DELTA = 35;
/** Head turn (degrees) worth mentioning as context. */
const POSE_NOTE_DEG = 15;

const ISSUE_TEXT: Record<QualityIssue, string> = {
  no_face: 'no face visible',
  multiple_faces: 'more than one face visible',
  face_too_small: 'face too far from the camera',
  face_cut_off: 'face partly outside the image',
  too_dark: 'too dark',
  too_bright: 'too bright',
  low_contrast: 'low in contrast',
  blurry: 'blurry',
  face_turned: 'face turned away',
  low_detection_confidence: 'face not clearly visible',
  low_detail: 'too low in detail (resolution or compression)',
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Was this identity event a comparison against the approved ID photo (rather than the session reference)? */
export function isIdPhotoComparison(event: Pick<EventDTO, 'type' | 'details'>, linkedChecks: { trigger: string }[]): boolean {
  if (event.type !== 'identity_mismatch' && event.type !== 'identity_unverifiable') return false;
  if (linkedChecks.length > 0 && linkedChecks.every((c) => c.trigger === 'id_photo')) return true;
  const d = event.details ?? {};
  return [d.trigger, d.against, d.comparedWith, d.reference, d.kind, d.source].some((v) => v === 'id_photo');
}

/** The reference that was in force at `at` (falls back to the earliest one). */
export function referenceActiveAt<T extends Pick<IdentityReference, 'createdAt' | 'supersededAt' | 'version'>>(refs: T[], at: number): T | null {
  const sorted = [...refs].sort((a, b) => a.version - b.version);
  const inForce = sorted.filter((r) => r.createdAt.getTime() <= at && (r.supersededAt == null || r.supersededAt.getTime() > at));
  return inForce[inForce.length - 1] ?? sorted.filter((r) => r.createdAt.getTime() <= at).pop() ?? sorted[0] ?? null;
}

export interface CompareOptions {
  timeZone?: string;
}

export async function buildIdentityComparison(ctx: Pick<Ctx, 'db' | 'now'>, orgId: string, eventId: string, opts: CompareOptions = {}): Promise<IdentityComparisonDTO> {
  const db = ctx.db;
  const [ev] = await db
    .select()
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.orgId, orgId)));
  if (!ev) throw notFound('Event not found', 'event_not_found');
  const [row] = await db
    .select({ session: examSessions, org: organizations })
    .from(examSessions)
    .innerJoin(organizations, eq(organizations.id, examSessions.orgId))
    .where(and(eq(examSessions.id, ev.sessionId), eq(examSessions.orgId, orgId)));
  if (!row) throw notFound('Event not found', 'event_not_found');
  const { session, org } = row;
  const now = ctx.now();

  const [timeline, linkedRows, refs, devices] = await Promise.all([
    loadSessionTimeline(db, session.id),
    db.select({ id: identityChecks.id, trigger: identityChecks.trigger }).from(identityChecks).where(eq(identityChecks.eventId, ev.id)),
    db.select().from(identityReferences).where(eq(identityReferences.sessionId, session.id)).orderBy(asc(identityReferences.version)),
    db.select().from(deviceRecords).where(eq(deviceRecords.sessionId, session.id)).orderBy(asc(deviceRecords.at)),
  ]);
  const event = timeline.events.find((e) => e.id === ev.id);
  if (!event) throw notFound('Event not found', 'event_not_found');

  const start = event.startedAt;
  const end = event.endedAt ?? Math.max(start, now);
  const idPhotoMode = isIdPhotoComparison(event, linkedRows);
  const thresholds = orgThresholds(org);
  const clock = makeClock(opts.timeZone ?? 'UTC', timeline.periods[0]?.startedAt ?? start);

  /* ---------------------------------------------------------------- reference side */
  let reference: IdentityComparisonDTO['reference'];
  let refRow: IdentityReference | null = null;
  if (idPhotoMode) {
    const photos = await db
      .select()
      .from(evidence)
      .where(and(eq(evidence.candidateId, session.candidateId), eq(evidence.kind, 'id_photo'), eq(evidence.orgId, orgId)))
      .orderBy(asc(evidence.createdAt));
    const [cand] = await db.select({ current: candidates.idPhotoEvidenceId, approvedAt: candidates.idPhotoApprovedAt }).from(candidates).where(eq(candidates.id, session.candidateId));
    // Prefer the copy linked to the event (the exact photo compared); else the photo on file at the time; else the current one.
    const linked = photos.find((p) => p.eventId === ev.id);
    const onFile = photos.filter((p) => p.eventId == null);
    const before = onFile.filter((p) => p.createdAt.getTime() <= start);
    const photo = linked ?? before[before.length - 1] ?? onFile.find((p) => p.id === cand?.current) ?? onFile[onFile.length - 1] ?? null;
    const replaced = photo != null && !linked && cand?.current != null && cand.current !== photo.id;
    reference = {
      images: photo ? [toEvidenceRefDTO(photo)] : [],
      createdAt: photo ? photo.capturedAt.getTime() : (cand?.approvedAt?.getTime() ?? start),
      purpose: `approved ID photo${replaced ? ' (a different photo is on file now)' : ''}${photo == null ? ' (no longer on file)' : ''}`,
    };
  } else {
    refRow = referenceActiveAt(refs, start);
    const imageRows = refRow && refRow.imageEvidenceIds.length ? await db.select().from(evidence).where(inArray(evidence.id, refRow.imageEvidenceIds)) : [];
    const byId = new Map(imageRows.map((r) => [r.id, r]));
    const images = (refRow?.imageEvidenceIds ?? []).map((id) => byId.get(id)).filter((r): r is EvidenceRow => !!r).map(toEvidenceRefDTO);
    let purpose = 'no identity reference was established';
    if (refRow) {
      purpose = refRow.version <= 1 && !refRow.authorizedBy ? 'check-in reference' : 'reference re-established after a staff-authorised re-enrolment';
      if (refRow.supersededAt) {
        const reason = str(refRow.supersededReason);
        purpose += `; later replaced at ${clock.time(refRow.supersededAt.getTime())}${reason ? ` (${reason.replace(/_/g, ' ')})` : ''}`;
      }
    }
    reference = { images, createdAt: refRow ? refRow.createdAt.getTime() : start, purpose };
  }

  /* ---------------------------------------------------------------- probe side */
  const linkedIds = new Set([...linkedRows.map((r) => r.id), ...strArray(event.details.checkIds), ...strArray(event.details.identityCheckIds), ...strArray(event.details.pendingMismatchCheckIds)]);
  const related = timeline.checks.filter((c) => {
    if (linkedIds.has(c.id)) return true;
    if (c.at < start || c.at > end) return false;
    return idPhotoMode ? c.trigger === 'id_photo' : c.trigger !== 'id_photo';
  });
  const relatedIds = new Set(related.map((c) => c.id));
  const firstRelatedAt = related.length ? Math.min(...related.map((c) => c.at)) : start;
  const lastMatch = idPhotoMode
    ? null
    : ([...timeline.checks].reverse().find((c) => c.at < Math.min(start, firstRelatedAt) && c.decision === 'match' && c.trigger !== 'id_photo' && !relatedIds.has(c.id)) ?? null);
  const probeChecks: IdentityCheckDTO[] = [...(lastMatch ? [lastMatch] : []), ...related].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));

  // Full camera frames behind the checks, used when a check has no separate probe image.
  const frameLinks = probeChecks.length
    ? await db.select({ id: identityChecks.id, frame: identityChecks.frameEvidenceId }).from(identityChecks).where(inArray(identityChecks.id, probeChecks.map((c) => c.id)))
    : [];
  const frameOfCheck = new Map(frameLinks.map((r) => [r.id, r.frame]));
  const frameIds = [...new Set(frameLinks.map((r) => r.frame).filter((x): x is string => !!x))];
  const frameRows = frameIds.length ? await db.select().from(evidence).where(inArray(evidence.id, frameIds)) : [];
  const frameById = new Map(frameRows.map((r) => [r.id, r]));
  const probes = probeChecks.map((check) => {
    const frameId = frameOfCheck.get(check.id);
    const frame = frameId ? frameById.get(frameId) : undefined;
    const image: EvidenceRefDTO | null = check.probeEvidence ?? (frame ? toEvidenceRefDTO(frame) : null);
    return { check, image };
  });

  // The range describes the samples behind the event (linked checks); without any, every check in its span.
  const hasSim = (c: IdentityCheckDTO) => c.similarity != null && Number.isFinite(c.similarity);
  const linkedWithSim = related.filter((c) => linkedIds.has(c.id) && hasSim(c));
  const sims = (linkedWithSim.length ? linkedWithSim : related.filter(hasSim)).map((c) => c.similarity as number);
  const similarity: IdentityComparisonDTO['similarity'] = {
    min: sims.length ? Math.min(...sims) : null,
    max: sims.length ? Math.max(...sims) : null,
    thresholds: idPhotoMode ? { match: thresholds.idPhotoMatch, mismatch: thresholds.idPhotoMismatch } : { match: thresholds.match, mismatch: thresholds.mismatch },
  };

  /* ---------------------------------------------------------------- surrounding timeline */
  const surrounding = timelineWindow(timeline.items, start - SURROUNDING_WINDOW_MS, start + SURROUNDING_WINDOW_MS);

  /* ---------------------------------------------------------------- environment notes (context only) */
  const environmentNotes = environmentNotesFor({
    clock,
    start,
    end,
    idPhotoMode,
    reference: refRow,
    related,
    events: timeline.events,
    devices: devices.map((d) => ({ at: d.at.getTime(), cameraLabel: d.cameraLabel, cameraIdHash: d.cameraIdHash, userAgent: d.userAgent, clientInstanceId: d.clientInstanceId })),
    referenceCreatedAt: reference.createdAt,
  });

  return { eventId: event.id, reference, probes, similarity, surrounding, environmentNotes };
}

interface EnvInput {
  clock: Clock;
  start: number;
  end: number;
  idPhotoMode: boolean;
  reference: IdentityReference | null;
  related: IdentityCheckDTO[];
  events: EventDTO[];
  devices: { at: number; cameraLabel: string; cameraIdHash: string; userAgent: string; clientInstanceId: string }[];
  referenceCreatedAt: number;
}

/** Neutral differences between the reference capture and the later images. Never phrased as evidence. */
export function environmentNotesFor(input: EnvInput): string[] {
  const { clock, start, end, reference } = input;
  const notes: string[] = [];
  const refAt = reference?.createdAt.getTime() ?? null;

  // Time since the reference.
  if (refAt != null && start - refAt >= 60_000) {
    notes.push(`The identity reference was captured ${formatDuration(start - refAt)} before this event began; appearance can change naturally over time.`);
  }

  // Camera / device changes (server-side device records first, then client-reported camera changes).
  const refEnv = reference?.environment ?? null;
  const baseDevice = refAt != null ? ([...input.devices].filter((d) => d.at <= refAt + 5 * 60_000).pop() ?? input.devices[0] ?? null) : (input.devices[0] ?? null);
  const baseHash = refEnv?.cameraIdHash || baseDevice?.cameraIdHash || '';
  const baseLabel = refEnv?.cameraLabel || baseDevice?.cameraLabel || '';
  const later = input.devices.filter((d) => (refAt == null || d.at > refAt) && d.at <= end);
  const changedCam = later.filter((d) => (d.cameraIdHash && baseHash && d.cameraIdHash !== baseHash) || (!d.cameraIdHash && d.cameraLabel && baseLabel && d.cameraLabel !== baseLabel)).pop();
  let cameraNoted = false;
  if (changedCam) {
    const from = baseLabel ? `“${baseLabel}”` : 'the check-in camera';
    const to = changedCam.cameraLabel ? `“${changedCam.cameraLabel}”` : 'another camera';
    notes.push(`A different camera was in use by ${input.clock.time(changedCam.at)} (${to}, compared with ${from} when the reference was captured). A camera change alone is not evidence of a different person.`);
    cameraNoted = true;
  }
  const uaChanged = baseDevice && later.some((d) => d.userAgent && baseDevice.userAgent && d.userAgent !== baseDevice.userAgent);
  if (uaChanged) notes.push('The exam was continued from a different browser or device than the one used at check-in.');

  const windowFrom = refAt ?? start - SURROUNDING_WINDOW_MS;
  for (const e of input.events) {
    if (e.startedAt < windowFrom || e.startedAt > end) continue;
    if (e.type === 'camera_changed' && !cameraNoted) {
      const from = str(e.details.from) ?? str(e.details.previousLabel) ?? str(e.details.previousCameraLabel);
      const to = str(e.details.to) ?? str(e.details.newLabel) ?? str(e.details.cameraLabel) ?? str(e.details.label);
      const what = from && to ? ` (from “${from}” to “${to}”)` : to ? ` (now “${to}”)` : '';
      notes.push(`The camera changed at ${clock.time(e.startedAt)}${what}. This is recorded as context only.`);
    } else if (e.type === 'environment_changed') {
      const aspects = [...strArray(e.details.changes ?? e.details.aspects), ...(str(e.details.aspect) ? [str(e.details.aspect)!] : [])].map((a) => a.replace(/_/g, ' '));
      const what = aspects.length ? `the ${listJoin(aspects)} differed` : 'the lighting, background or camera angle differed';
      notes.push(`At ${clock.time(e.startedAt)} ${what} from the previous exam period. Environment changes are context only, not evidence of a different person.`);
    }
  }

  // Brightness difference between the reference capture and the later images.
  const probeQualities = input.related.map((c) => c.quality).filter((q): q is FaceQuality => q != null && q.faceCount > 0);
  const refBrightness = refEnv?.faceBrightness ?? reference?.quality?.brightness ?? null;
  const laterBrightness = median(probeQualities.map((q) => q.brightness).filter((b) => Number.isFinite(b)));
  if (!input.idPhotoMode && refBrightness != null && laterBrightness != null && Math.abs(laterBrightness - refBrightness) >= BRIGHTNESS_NOTE_DELTA) {
    const dir = laterBrightness < refBrightness ? 'darker' : 'brighter';
    notes.push(
      `The face appeared ${dir} in the later images than in the reference (average face brightness ${Math.round(laterBrightness)} vs ${Math.round(refBrightness)} on a 0–255 scale). Lighting differences can lower similarity scores and are not evidence of a different person.`,
    );
  }

  // Head pose.
  const maxYaw = probeQualities.reduce((m, q) => Math.max(m, Math.abs(q.yawDeg ?? 0), Math.abs(q.pitchDeg ?? 0)), 0);
  if (maxYaw >= POSE_NOTE_DEG) {
    notes.push(`The face was turned up to ${Math.round(maxYaw)}° away from the camera in some later images, which lowers similarity scores.`);
  }

  // Image quality problems in the later images.
  const issues = [...new Set(input.related.flatMap((c) => c.quality?.issues ?? []))].filter((i): i is QualityIssue => i in ISSUE_TEXT);
  if (issues.length) {
    notes.push(`Some later images were not clear enough for a dependable comparison (${listJoin(issues.map((i) => ISSUE_TEXT[i]))}); “unable to verify” results are not evidence of a different person.`);
  }
  return [...new Set(notes)];
}

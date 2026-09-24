/**
 * Readiness / liveness / identity checks (POST /api/candidate/checks, /frames, /complete).
 *
 *  initial   : liveness + build the protected reference (+ optional ID-photo comparison) -> ready
 *  resume    : after a formal pause, compare with the ACTIVE reference -> active
 *  reconnect : new browser instance during ready/active -> compare -> continue
 *  reverify  : after staff released a hold with a required check (optionally re-enrolment) -> continue
 *
 * Outcomes: match -> passed; unable/inconclusive or failed liveness -> retry (+guidance) until
 * maxVerificationAttempts, then on_hold 'identity_unverifiable'; mismatch -> identity_mismatch event with
 * before/after evidence, then hold (policy hold_for_review) or flag and continue.
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  LIVENESS_INSTRUCTIONS,
  QUALITY_GUIDANCE,
  type CheckFrameResponse,
  type CheckPurpose,
  type CompleteCheckResponse,
  type IdentityCheckTrigger,
  type IdentityDecision,
  type IdentityThresholds,
  type LivenessAction,
  type LivenessResultDTO,
  type ProctoringPolicy,
  type StartCheckRequest,
  type StartCheckResponse,
} from '@sp/shared';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import type { DbOrTx } from '../db/index.js';
import {
  candidates,
  checkFrames,
  checks,
  deviceRecords,
  events,
  evidence,
  examSessions,
  exams,
  identityChecks,
  identityReferences,
  organizations,
  type Check,
  type CheckLivenessSpec,
  type EventRow,
  type EvidenceRow,
  type ExamSession,
  type IdentityCheck,
} from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { safeEqual } from '../lib/crypto.js';
import { badRequest, conflict, gone, HttpError, invalidState, notFound } from '../lib/errors.js';
import {
  aggregateFrames,
  buildReference,
  checkStepFrame,
  decideIdentity,
  deserializeEmbeddings,
  maxSimilarity,
  REFERENCE_MIN_FRAMES,
  serializeEmbeddings,
  verifyLiveness,
  type FrameAggregateResult,
  type ImageAnalysis,
  type LivenessFrame,
  type ReferenceBuildResult,
} from '../vision/index.js';
import { buildCandidateState, SUPERSEDED_MESSAGE } from './candidate-state.js';
import { readEvidence, storeEvidence } from './evidence.js';
import { copyEvidence, frameAad, frameToAnalysis, idPhotoAad, loadActiveReference, precedingContext, referenceAad, summarizeAnalysis, toIdentityResultDTO, type ActiveReference } from './identity-common.js';
import { clearedHold } from './session-actions.js';
import { orgThresholds } from './org.js';
import { assertCheckRate, assertSessionEvidenceCapacity } from './session-limits.js';
import { effectivePolicy, holdNow, identityState, requiredCheckFor, withSession, type SessionMutation } from './session-state.js';

export const CHECK_TTL_MS = 3 * 60_000;
export const TARGET_YAW_DEG = 20;
export const TARGET_PITCH_DEG = 12;
export const MAX_FRAMES_PER_CHECK = 40;
/** Upload caps per liveness step / for frontal frames (only the first frames of a step count anyway). */
export const MAX_FRAMES_PER_STEP = 4;
export const MAX_FRONTAL_FRAMES = 10;
const BRIGHTNESS_CHANGE = 45;

const TRIGGER_FOR: Record<CheckPurpose, IdentityCheckTrigger> = { initial: 'check_in', resume: 'resume', reconnect: 'reconnect', reverify: 'reverify' };

/**
 * Frontal frames the client must upload. A check that builds a reference (initial, or a staff-authorised
 * re-enrolment) needs REFERENCE_MIN_FRAMES clear frontal frames even when the liveness challenge (whose
 * 'center' step adds frontal frames) is turned off; a comparison needs 2.
 */
export function frontalFramesRequired(purpose: CheckPurpose, buildsReference = purpose === 'initial'): number {
  return buildsReference ? Math.max(3, REFERENCE_MIN_FRAMES) : 2;
}

/**
 * A staff re-enrolment authorisation applies ONLY to the reverify check of the hold it was given for
 * (release with reEnroll=true keeps the session on hold with holdCanReverify). It is never honoured for
 * resume / reconnect checks, even if a stale flag were left on the row.
 */
export function reEnrollmentApplies(s: Pick<ExamSession, 'status' | 'holdCanReverify' | 'reEnrollAuthorized'>, purpose: CheckPurpose): boolean {
  return purpose === 'reverify' && s.status === 'on_hold' && s.holdCanReverify && s.reEnrollAuthorized;
}

const CLIENT_EVENT_SOURCES = ['client_browser', 'client_vision'] as const;

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Random challenge: 'center', then turn_left & turn_right in random order, plus look_up/look_down when livenessSteps >= 3. */
export function generateLivenessSteps(livenessSteps: number): CheckLivenessSpec['steps'] {
  const actions: LivenessAction[] = shuffle(['turn_left', 'turn_right'] as LivenessAction[]);
  const extra = shuffle(['look_up', 'look_down'] as LivenessAction[]).slice(0, Math.max(0, Math.min(2, livenessSteps - 2)));
  for (const e of extra) actions.splice(randomInt(actions.length + 1), 0, e);
  const all: (LivenessAction | 'center')[] = ['center', ...actions];
  return all.map((action, index) => ({ index, action, instruction: LIVENESS_INSTRUCTIONS[action] }));
}

async function failedAttempts(db: DbOrTx, s: ExamSession, purpose: CheckPurpose, excludeCheckId?: string): Promise<number> {
  const since = s.checkAttemptsResetAt ?? new Date(0);
  const rows = await db
    .select({ id: checks.id })
    .from(checks)
    .where(and(eq(checks.sessionId, s.id), eq(checks.purpose, purpose), eq(checks.status, 'retry'), gte(checks.issuedAt, since)));
  return rows.filter((r) => r.id !== excludeCheckId).length;
}

/* =================================================================== start */

export async function startCheck(ctx: Ctx, sessionId: string, instanceId: string, body: StartCheckRequest): Promise<StartCheckResponse> {
  if (body.clientInstanceId !== instanceId) throw badRequest('clientInstanceId does not match the X-Client-Instance header', undefined, 'instance_mismatch');
  return withSession(ctx, sessionId, async (m) => {
    const s = m.session;
    const required = requiredCheckFor(s, instanceId);
    if (!required) {
      if (s.status === 'invited' && !s.consentAcceptedAt) throw conflict('consent_required', 'Please read and accept the privacy notice first.');
      throw invalidState('No check is needed right now', { status: s.status });
    }
    if (body.purpose !== required) throw conflict('wrong_check_purpose', `A ${required} check is required`, { requiredCheck: required });
    const policy = await m.policy();
    const max = policy.identity.maxVerificationAttempts;
    const failed = await failedAttempts(m.tx, s, required);
    if (failed >= max) throw conflict('attempts_exhausted', 'No verification attempts remain; an administrator will review your exam.');
    await assertCheckRate(ctx, m.tx, s.id, m.now);

    // Expire any other open check of this session.
    await m.tx.update(checks).set({ status: 'expired', completedAt: new Date(m.now) }).where(and(eq(checks.sessionId, s.id), eq(checks.status, 'open')));

    // Another live browser instance? Record it and supersede it.
    const timeoutMs = policy.connection.heartbeatTimeoutSec * 1000;
    const other = s.lastHeartbeatInstanceId && s.lastHeartbeatInstanceId !== instanceId ? s.lastHeartbeatInstanceId : null;
    const otherLive = other && s.lastHeartbeatAt && m.now - s.lastHeartbeatAt.getTime() <= timeoutMs && ['ready', 'active', 'paused', 'on_hold'].includes(s.status);
    if (otherLive) {
      // A different device/browser while the other one is live => recorded now. The same device is most
      // likely a page reload; it is recorded only if the old window proves to be alive (see heartbeat()).
      const [prevDevice] = await m.tx
        .select({ userAgent: deviceRecords.userAgent, cameraIdHash: deviceRecords.cameraIdHash })
        .from(deviceRecords)
        .where(and(eq(deviceRecords.sessionId, s.id), eq(deviceRecords.clientInstanceId, other)))
        .orderBy(desc(deviceRecords.at))
        .limit(1);
      const differentDevice =
        !prevDevice || prevDevice.userAgent !== (body.device.userAgent ?? '') || (!!prevDevice.cameraIdHash && !!body.device.cameraIdHash && prevDevice.cameraIdHash !== body.device.cameraIdHash);
      if (differentDevice) {
        await recordMultipleInstances(m, other, instanceId, {
          purpose: required,
          previousLastHeartbeatAt: s.lastHeartbeatAt!.getTime(),
          cameraLabel: body.device.cameraLabel,
          userAgent: body.device.userAgent,
          detectedBy: 'different_device',
        });
      }
    }
    for (const target of new Set([s.activeInstanceId, other].filter((x): x is string => !!x && x !== instanceId))) {
      await m.enqueueCommand({ kind: 'superseded', message: SUPERSEDED_MESSAGE }, target);
    }
    m.set({ activeInstanceId: instanceId });

    const livenessOn = policy.identity.liveness === 'active';
    const spec: CheckLivenessSpec | null = livenessOn
      ? { challengeId: randomUUID(), steps: generateLivenessSteps(policy.identity.livenessSteps), targetYawDeg: TARGET_YAW_DEG, targetPitchDeg: TARGET_PITCH_DEG }
      : null;
    const nonce = randomBytes(18).toString('base64url');
    const expiresAt = m.now + CHECK_TTL_MS;
    const [check] = await m.tx
      .insert(checks)
      .values({
        sessionId: s.id,
        purpose: required,
        clientInstanceId: instanceId,
        device: body.device,
        status: 'open',
        attempt: failed + 1,
        liveness: spec,
        nonce,
        issuedAt: new Date(m.now),
        expiresAt: new Date(expiresAt),
      })
      .returning();
    await m.tx.insert(deviceRecords).values({
      sessionId: s.id,
      checkId: check.id,
      at: new Date(m.now),
      clientInstanceId: instanceId,
      purpose: required,
      cameraLabel: body.device.cameraLabel ?? '',
      cameraIdHash: body.device.cameraIdHash ?? '',
      userAgent: body.device.userAgent ?? '',
      screen: body.device.screen ?? {},
      videoWidth: body.device.videoWidth ?? null,
      videoHeight: body.device.videoHeight ?? null,
    });
    if (required === 'initial') {
      const open = await m.openPeriodRow();
      if (!open) await m.insertPeriod('check_in', m.now, { reason: 'initial_check' });
    }
    return {
      checkId: check.id,
      purpose: required,
      liveness: spec
        ? { challengeId: spec.challengeId, nonce, steps: spec.steps, expiresAt, targetYawDeg: spec.targetYawDeg, targetPitchDeg: spec.targetPitchDeg }
        : null,
      attemptsRemaining: max - failed,
      frontalFramesRequired: frontalFramesRequired(required, required === 'initial' || reEnrollmentApplies(s, required)),
    };
  });
}

/** Record a multiple_instances observation once per superseded instance. */
export async function recordMultipleInstances(m: SessionMutation, previousInstanceId: string, newInstanceId: string, details: Record<string, unknown>): Promise<void> {
  const [dup] = await m.tx
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.sessionId, m.session.id), eq(events.type, 'multiple_instances'), sql`${events.details}->>'previousInstanceId' = ${previousInstanceId}`))
    .limit(1);
  if (dup) return;
  await m.addEvent({ type: 'multiple_instances', details: { previousInstanceId, newInstanceId, ...details } });
}

/* =================================================================== frames */

export interface FrameQuery {
  step: string;
  capturedAt?: number;
  nonce?: string;
  clientYaw?: number | null;
  clientPitch?: number | null;
}

async function loadCheckFor(ctx: Ctx, sessionId: string, checkId: string, instanceId: string): Promise<{ check: Check; session: ExamSession }> {
  const [row] = await ctx.db.select().from(checks).where(and(eq(checks.id, checkId), eq(checks.sessionId, sessionId)));
  if (!row) throw notFound('Check not found', 'check_not_found');
  if (row.clientInstanceId !== instanceId) throw conflict('superseded', 'This check belongs to another browser window.');
  const [s] = await ctx.db.select().from(examSessions).where(eq(examSessions.id, sessionId));
  if (s.activeInstanceId && s.activeInstanceId !== instanceId) throw conflict('superseded', SUPERSEDED_MESSAGE);
  return { check: row, session: s };
}

export async function submitCheckFrame(ctx: Ctx, sessionId: string, orgId: string, candidateId: string, instanceId: string, checkId: string, q: FrameQuery, jpeg: Buffer): Promise<CheckFrameResponse> {
  const { check } = await loadCheckFor(ctx, sessionId, checkId, instanceId);
  const now = ctx.now();
  if (check.status !== 'open') throw conflict('check_closed', 'This check is no longer open. Start a new check.');
  if (now > check.expiresAt.getTime()) {
    await ctx.db.update(checks).set({ status: 'expired', completedAt: new Date(now) }).where(and(eq(checks.id, check.id), eq(checks.status, 'open')));
    throw gone('check_expired', 'The check expired. Please start it again.');
  }
  const spec = check.liveness;
  if (spec) {
    if (!q.nonce || !safeEqual(q.nonce, check.nonce)) throw badRequest('Invalid or missing challenge nonce', undefined, 'bad_nonce');
  }
  let step: string;
  let action: LivenessAction | 'center';
  if (q.step === 'frontal') {
    step = 'frontal';
    action = 'center';
  } else {
    const idx = Number(q.step);
    const st = spec?.steps.find((x) => x.index === idx);
    if (!Number.isInteger(idx) || !st) throw badRequest(`Unknown step "${q.step}"`, undefined, 'bad_step');
    step = String(idx);
    action = st.action;
  }
  const counts = await ctx.db
    .select({ step: checkFrames.step, n: sql<number>`count(*)::int` })
    .from(checkFrames)
    .where(eq(checkFrames.checkId, check.id))
    .groupBy(checkFrames.step);
  const total = counts.reduce((a, c) => a + c.n, 0);
  const forStep = counts.find((c) => c.step === step)?.n ?? 0;
  if (total >= MAX_FRAMES_PER_CHECK) throw new HttpError(429, 'too_many_frames', 'Too many frames for this check. Start a new check.');
  if (forStep >= (step === 'frontal' ? MAX_FRONTAL_FRAMES : MAX_FRAMES_PER_STEP)) {
    throw new HttpError(429, 'too_many_frames', 'Enough frames were received for this step. Continue with the next step or start a new check.');
  }

  const capturedAt = q.capturedAt != null && Number.isFinite(q.capturedAt) ? q.capturedAt : now;
  const wantCrop = step === 'frontal' || action === 'center';
  await assertSessionEvidenceCapacity(ctx, ctx.db, sessionId, { items: wantCrop ? 2 : 1, bytes: jpeg.length });
  const analysis = await ctx.vision.analyze(jpeg, { embed: true, faceCrop: wantCrop });

  const frameId = randomUUID();
  const { row: ev } = await storeEvidence(ctx, ctx.db, {
    orgId,
    sessionId,
    candidateId,
    kind: 'liveness_frame',
    reason: `check:${check.purpose}:${step}`,
    capturedAt,
    data: jpeg,
    clientInstanceId: instanceId,
  });
  let cropId: string | null = null;
  if (analysis.faceCropJpeg) {
    const { row } = await storeEvidence(ctx, ctx.db, { orgId, sessionId, candidateId, kind: 'liveness_frame', reason: 'face_crop', capturedAt, data: analysis.faceCropJpeg });
    cropId = row.id;
  }
  await ctx.db.insert(checkFrames).values({
    id: frameId,
    checkId: check.id,
    sessionId,
    step,
    action,
    capturedAt: new Date(capturedAt),
    receivedAt: new Date(now),
    analysis: summarizeAnalysis(analysis),
    embeddingEnc: analysis.embedding ? ctx.keyring.encrypt(serializeEmbeddings([analysis.embedding]), frameAad(frameId)) : null,
    evidenceId: ev.id,
    faceCropEvidenceId: cropId,
    clientYaw: q.clientYaw ?? null,
    clientPitch: q.clientPitch ?? null,
  });

  const quality = analysis.quality;
  if (step === 'frontal') {
    const accepted = quality.usable && analysis.embedding != null;
    return { accepted, quality, guidance: accepted ? [] : guidanceFor(quality.issues), measured: analysis.pose ? { yawDeg: r1(analysis.pose.yawDeg), pitchDeg: r1(analysis.pose.pitchDeg) } : undefined };
  }
  // Liveness step frame: feedback relative to the candidate's own frontal pose.
  // The candidate's own frontal pose (YuNet pitch has an offset for frontal faces, so never use absolute pose).
  const prior = await ctx.db
    .select({ analysis: checkFrames.analysis })
    .from(checkFrames)
    .where(and(eq(checkFrames.checkId, check.id), eq(checkFrames.step, 'frontal')));
  const poses = prior.filter((p) => p.analysis.faceCount === 1 && p.analysis.pose != null).map((p) => p.analysis.pose!);
  const centre = poses.length ? { yawDeg: median(poses.map((p) => p.yawDeg)), pitchDeg: median(poses.map((p) => p.pitchDeg)) } : null;
  const fb = checkStepFrame(action, analysis, { targetYawDeg: spec!.targetYawDeg, targetPitchDeg: spec!.targetPitchDeg }, centre);
  const accepted = analysis.primary != null && quality.faceCount === 1;
  const issues = quality.issues.filter((i) => i !== 'face_turned');
  const guidance = [...guidanceFor(issues)];
  if (!fb.satisfied && fb.reason) guidance.push(fb.reason);
  return { accepted, quality, guidance, stepSatisfied: fb.satisfied, measured: fb.measured ?? undefined };
}

function guidanceFor(issues: readonly (keyof typeof QUALITY_GUIDANCE)[]): string[] {
  return [...new Set(issues.map((i) => QUALITY_GUIDANCE[i]))];
}

const r1 = (v: number) => Math.round(v * 10) / 10;
function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* =================================================================== complete */

interface PreparedFrames {
  frames: { id: string; step: string; action: LivenessAction | 'center'; capturedAt: number; evidenceId: string | null; cropId: string | null; analysis: ImageAnalysis; clientYaw: number | null; clientPitch: number | null }[];
  frontal: PreparedFrames['frames'];
}

async function prepareFrames(ctx: Ctx, checkId: string): Promise<PreparedFrames> {
  // Server receipt order; the liveness time window and step order use server receipt time, not client clocks.
  const rows = await ctx.db.select().from(checkFrames).where(eq(checkFrames.checkId, checkId)).orderBy(asc(checkFrames.seq));
  const frames = rows.map((f) => ({
    id: f.id,
    step: f.step,
    action: f.action,
    capturedAt: f.receivedAt.getTime(),
    evidenceId: f.evidenceId,
    cropId: f.faceCropEvidenceId,
    analysis: frameToAnalysis(ctx, f),
    clientYaw: f.clientYaw,
    clientPitch: f.clientPitch,
  }));
  return { frames, frontal: frames.filter((f) => f.step === 'frontal' || f.action === 'center') };
}

function livenessFrames(p: PreparedFrames): LivenessFrame[] {
  return p.frames.map((f) => ({
    step: f.step === 'frontal' ? 'frontal' : Number(f.step),
    action: f.action,
    analysis: f.analysis,
    capturedAt: f.capturedAt,
    clientYaw: f.clientYaw,
    clientPitch: f.clientPitch,
  }));
}

interface ImagePair {
  full: Buffer | null;
  crop: Buffer | null;
  capturedAt: number;
}

async function loadImages(ctx: Ctx, frame: PreparedFrames['frames'][number] | undefined): Promise<ImagePair | null> {
  if (!frame) return null;
  const ids = [frame.evidenceId, frame.cropId].filter((x): x is string => !!x);
  const rows = ids.length ? await ctx.db.select().from(evidence).where(inArray(evidence.id, ids)) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const full = frame.evidenceId && byId.get(frame.evidenceId) ? await readEvidence(ctx, byId.get(frame.evidenceId)!) : null;
  const crop = frame.cropId && byId.get(frame.cropId) ? await readEvidence(ctx, byId.get(frame.cropId)!) : null;
  return { full, crop, capturedAt: frame.capturedAt };
}

interface Outcome {
  outcome: CompleteCheckResponse['outcome'];
  message: string;
  guidance: string[];
  identity: IdentityCheck | null;
  idPhoto: { decision: IdentityDecision; similarity: number | null } | null;
  attemptsRemaining: number;
}

export async function completeCheck(ctx: Ctx, sessionId: string, instanceId: string, checkId: string): Promise<CompleteCheckResponse> {
  const { check } = await loadCheckFor(ctx, sessionId, checkId, instanceId);
  if (check.status !== 'open') {
    // Idempotent replay of a completed check.
    const stored = (check.result ?? {}) as Partial<CompleteCheckResponse>;
    if (!stored.outcome) throw conflict('check_closed', 'This check is no longer open. Start a new check.');
    return { ...(stored as CompleteCheckResponse), state: await buildCandidateState(ctx, ctx.db, sessionId, instanceId) };
  }
  const now = ctx.now();
  if (now > check.expiresAt.getTime() + 5_000) {
    await ctx.db.update(checks).set({ status: 'expired', completedAt: new Date(now) }).where(eq(checks.id, check.id));
    return {
      outcome: 'failed',
      message: 'The check took too long and expired. Please start it again.',
      guidance: [],
      liveness: null,
      identity: null,
      idPhoto: null,
      attemptsRemaining: 0,
      state: await buildCandidateState(ctx, ctx.db, sessionId, instanceId),
    };
  }

  // ---- heavy, lock-free preparation
  const prepared = await prepareFrames(ctx, check.id);
  const [s0] = await ctx.db.select().from(examSessions).where(eq(examSessions.id, sessionId));
  const [exam] = await ctx.db.select().from(exams).where(eq(exams.id, s0.examId));
  const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, s0.orgId));
  const policy = effectivePolicy(s0, exam, org ?? null);
  const thresholds = orgThresholds(org);

  const spec = check.liveness;
  const liveness: LivenessResultDTO | null = spec
    ? verifyLiveness({ steps: spec.steps, issuedAt: check.issuedAt.getTime(), expiresAt: check.expiresAt.getTime(), targetYawDeg: spec.targetYawDeg, targetPitchDeg: spec.targetPitchDeg }, livenessFrames(prepared), thresholds)
    : null;
  const livenessOk = !liveness || liveness.passed;

  const frontalAnalyses = prepared.frontal.map((f) => f.analysis);
  let reference: ReferenceBuildResult | null = null;
  let aggregate: FrameAggregateResult | null = null;
  let active: ActiveReference | null = null;
  const purpose = check.purpose;
  // Re-checked under the lock in applyContinuation (the authorisation may change meanwhile).
  const reEnroll = reEnrollmentApplies(s0, purpose);
  if (purpose === 'initial' || reEnroll) reference = buildReference(frontalAnalyses, thresholds);
  if (purpose !== 'initial') {
    active = await loadActiveReference(ctx, ctx.db, sessionId);
    if (!active && !reEnroll) throw invalidState('No identity reference exists for this exam');
    if (active) aggregate = aggregateFrames(frontalAnalyses, active.embeddings, thresholds, 'reference');
  }

  // Images for evidence: reference (best frontal) and probe (best probe frame).
  const refFrame = reference?.ok ? prepared.frontal[reference.bestIndex] : undefined;
  const probeFrame = aggregate?.bestProbeIndex != null ? prepared.frontal[aggregate.bestProbeIndex] : prepared.frontal[0];
  const refImages = await loadImages(ctx, refFrame);
  const probeImages = purpose !== 'initial' ? await loadImages(ctx, probeFrame) : null;

  // ID photo comparison (initial only).
  const [cand] = await ctx.db.select().from(candidates).where(eq(candidates.id, s0.candidateId));
  let idPhoto: { decision: IdentityDecision; similarity: number | null; confidence: number } | null = null;
  if (purpose === 'initial' && reference?.ok && policy.identity.idPhotoComparison !== 'off' && cand.idPhotoEmbedding) {
    try {
      const photoEmb = deserializeEmbeddings(ctx.keyring.decrypt(cand.idPhotoEmbedding, idPhotoAad(cand.id)));
      const sims = reference.embeddings.map((e) => maxSimilarity(e, photoEmb));
      const sim = Math.max(...sims);
      const d = decideIdentity(sim, reference.quality, thresholds, 'id_photo');
      idPhoto = { decision: d.decision, similarity: d.similarity, confidence: d.confidence };
    } catch (err) {
      ctx.log.error({ err, candidateId: cand.id }, 'ID photo comparison failed');
      idPhoto = { decision: 'unable_to_verify', similarity: null, confidence: 1 };
    }
  }

  // ---- apply under the session lock
  const outcome = await withSession(ctx, sessionId, async (m) => {
    const [cur] = await m.tx.select().from(checks).where(eq(checks.id, check.id)).for('update');
    if (!cur || cur.status !== 'open') throw conflict('check_closed', 'This check is no longer open. Start a new check.');
    if (m.session.activeInstanceId !== instanceId) throw conflict('superseded', SUPERSEDED_MESSAGE);
    if (requiredCheckFor(m.session, instanceId) !== purpose) throw conflict('check_not_required', 'This check is no longer needed.', { requiredCheck: requiredCheckFor(m.session, instanceId) });
    const ctxInfo: ApplyCtx = { m, ctx, check, policy, thresholds, liveness, livenessOk, reference, aggregate, active, refImages, probeImages, idPhoto, prepared, instanceId };
    const out = purpose === 'initial' ? await applyInitial(ctxInfo) : await applyContinuation(ctxInfo);
    const status = out.outcome === 'passed' ? 'passed' : out.outcome === 'retry' ? 'retry' : out.outcome === 'held' ? 'held' : 'failed';
    const response = {
      outcome: out.outcome,
      message: out.message,
      guidance: out.guidance,
      liveness,
      identity: out.identity ? toIdentityResultDTO(out.identity) : null,
      idPhoto: out.idPhoto,
      attemptsRemaining: out.attemptsRemaining,
    };
    await m.tx.update(checks).set({ status, completedAt: new Date(m.now), result: response as unknown as Record<string, unknown> }).where(eq(checks.id, check.id));
    return response;
  });
  return { ...outcome, state: await buildCandidateState(ctx, ctx.db, sessionId, instanceId) };
}

interface ApplyCtx {
  m: SessionMutation;
  ctx: Ctx;
  check: Check;
  policy: ProctoringPolicy;
  thresholds: IdentityThresholds;
  liveness: LivenessResultDTO | null;
  livenessOk: boolean;
  reference: ReferenceBuildResult | null;
  aggregate: FrameAggregateResult | null;
  active: ActiveReference | null;
  refImages: ImagePair | null;
  probeImages: ImagePair | null;
  idPhoto: { decision: IdentityDecision; similarity: number | null; confidence: number } | null;
  prepared: PreparedFrames;
  instanceId: string;
}

async function insertIdentityCheck(a: ApplyCtx, fields: Partial<typeof identityChecks.$inferInsert> & { decision: IdentityDecision; confidence: number }): Promise<IdentityCheck> {
  const { m } = a;
  const [row] = await m.tx
    .insert(identityChecks)
    .values({
      sessionId: m.session.id,
      checkId: a.check.id,
      trigger: TRIGGER_FOR[a.check.purpose],
      at: new Date(m.now),
      receivedAt: new Date(m.now),
      clientInstanceId: a.instanceId,
      ...fields,
    })
    .returning();
  m.publishIdentityCheck(row.id);
  m.set({ lastIdentityDecision: row.decision, lastIdentityAt: row.at, lastIdentitySimilarity: row.similarity ?? null });
  return row;
}

async function storePair(a: ApplyCtx, pair: ImagePair | null, kind: 'identity_probe' | 'identity_reference', link: { identityCheckId?: string | null; eventId?: string | null }): Promise<EvidenceRow[]> {
  if (!pair) return [];
  const out: EvidenceRow[] = [];
  const { m, ctx } = a;
  const base = { orgId: m.session.orgId, sessionId: m.session.id, candidateId: m.session.candidateId, kind, capturedAt: pair.capturedAt, identityCheckId: link.identityCheckId ?? null, eventId: link.eventId ?? null };
  if (pair.crop) out.push((await storeEvidence(ctx, m.tx, { ...base, reason: 'face_crop', data: pair.crop })).row);
  if (pair.full) out.push((await storeEvidence(ctx, m.tx, { ...base, reason: 'frame', data: pair.full })).row);
  return out;
}

/** Retry (with guidance) or, once attempts are exhausted, hold for human review as identity_unverifiable. */
async function retryOrHold(a: ApplyCtx, why: { message: string; guidance: string[]; identity: IdentityCheck | null; reason: string }): Promise<Outcome> {
  const { m, policy, check } = a;
  const max = policy.identity.maxVerificationAttempts;
  const failedBefore = await failedAttempts(m.tx, m.session, check.purpose, check.id);
  const used = failedBefore + 1;
  if (used >= max) {
    const firstAt = await m.tx
      .select({ issuedAt: checks.issuedAt })
      .from(checks)
      .where(and(eq(checks.sessionId, m.session.id), eq(checks.purpose, check.purpose), gte(checks.issuedAt, m.session.checkAttemptsResetAt ?? new Date(0))))
      .orderBy(asc(checks.issuedAt))
      .limit(1);
    const ev = await m.addEvent({
      type: 'identity_unverifiable',
      source: 'server_identity',
      startedAt: firstAt[0]?.issuedAt.getTime() ?? check.issuedAt.getTime(),
      endedAt: m.now,
      confidence: why.identity?.confidence ?? null,
      details: { purpose: check.purpose, attempts: used, lastReason: why.reason, guidance: why.guidance, livenessPassed: a.livenessOk },
      context: { checkId: check.id },
    });
    if (why.identity) await m.tx.update(identityChecks).set({ eventId: ev.id }).where(eq(identityChecks.id, why.identity.id));
    // The replaced browser stopped observing when the gap began; its open episodes end there, not at the hold.
    if (check.purpose === 'reconnect') await closeReplacedInstanceEvents(m, a.instanceId, reconnectGapStart(m.session, check));
    await holdNow(m, { reason: 'identity_unverifiable', details: { purpose: check.purpose, attempts: used } });
    if (check.purpose !== 'initial') m.set({ verifiedInstanceId: a.instanceId });
    return { outcome: 'held', message: m.session.holdMessage ?? '', guidance: why.guidance, identity: why.identity, idPhoto: null, attemptsRemaining: 0 };
  }
  return { outcome: 'retry', message: why.message, guidance: why.guidance, identity: why.identity, idPhoto: null, attemptsRemaining: max - used };
}

const LIVENESS_RETRY_MESSAGE = 'We could not confirm the live head movements. Follow each instruction on screen, moving your head slowly, and try again.';
const IDENTITY_RETRY_MESSAGE = 'We could not verify your identity from these images. Follow the guidance below and try again.';

/* ------------------------------------------------------------------ initial */

async function applyInitial(a: ApplyCtx): Promise<Outcome> {
  const { m, reference, liveness, policy } = a;
  if (!a.livenessOk) {
    const idRow = await insertIdentityCheck(a, { decision: 'unable_to_verify', confidence: 1, quality: reference?.quality ?? null, guidance: liveness?.reasons ?? [], context: { precededBy: [], periodKind: 'check_in', secondsSincePreviousMatch: null, liveness: false } });
    return retryOrHold(a, { message: LIVENESS_RETRY_MESSAGE, guidance: liveness?.reasons ?? [], identity: idRow, reason: 'liveness_failed' });
  }
  if (!reference || !reference.ok) {
    const guidance = reference?.reasons ?? ['We could not see your face clearly enough.'];
    const q = a.prepared.frontal.map((f) => f.analysis.quality).find((x) => !x.usable) ?? a.prepared.frontal[0]?.analysis.quality ?? null;
    const idRow = await insertIdentityCheck(a, { decision: 'unable_to_verify', confidence: 1, quality: q, guidance, context: { precededBy: [], periodKind: 'check_in', secondsSincePreviousMatch: null } });
    return retryOrHold(a, { message: IDENTITY_RETRY_MESSAGE, guidance, identity: idRow, reason: 'reference_not_established' });
  }

  // Establish the protected reference.
  const refId = randomUUID();
  const [{ maxVersion }] = await m.tx
    .select({ maxVersion: sql<number>`coalesce(max(${identityReferences.version}), 0)::int` })
    .from(identityReferences)
    .where(eq(identityReferences.sessionId, m.session.id));
  const images = await storePair(a, a.refImages, 'identity_reference', {});
  const bestAnalysis = a.prepared.frontal[reference.bestIndex]?.analysis;
  await m.tx.update(identityReferences).set({ active: false, supersededAt: new Date(m.now), supersededReason: 'new_initial_check' }).where(and(eq(identityReferences.sessionId, m.session.id), eq(identityReferences.active, true)));
  await m.tx.insert(identityReferences).values({
    id: refId,
    sessionId: m.session.id,
    candidateId: m.session.candidateId,
    version: maxVersion + 1,
    embeddingsEnc: a.ctx.keyring.encrypt(serializeEmbeddings(reference.embeddings), referenceAad(refId)),
    embeddingCount: reference.embeddings.length,
    quality: reference.quality,
    liveness,
    idPhoto: a.idPhoto ? { decision: a.idPhoto.decision, similarity: a.idPhoto.similarity } : null,
    imageEvidenceIds: images.map((e) => e.id),
    environment: {
      imageBrightness: bestAnalysis?.imageBrightness ?? null,
      faceBrightness: reference.quality?.brightness ?? null,
      cameraLabel: a.check.device.cameraLabel ?? '',
      cameraIdHash: a.check.device.cameraIdHash ?? '',
    },
    checkId: a.check.id,
    active: true,
    createdAt: new Date(m.now),
  });
  const idRow = await insertIdentityCheck(a, {
    decision: 'match',
    similarity: null,
    confidence: 1,
    quality: reference.quality,
    referenceId: refId,
    probeEvidenceId: images[0]?.id ?? null,
    frameEvidenceId: images[1]?.id ?? null,
    context: { precededBy: [], periodKind: 'check_in', secondsSincePreviousMatch: null, referenceCreated: true },
  });
  await m.addEvent({
    type: 'checkin_completed',
    // The catalog text mentions the live-person check; say accurately when the exam rules turned it off.
    observation: liveness ? undefined : 'The camera readiness check was completed; the live-person check is disabled by the exam rules.',
    details: { checkId: a.check.id, livenessSteps: liveness?.steps.length ?? 0, liveness: liveness ? 'passed' : 'off' },
  });
  await m.addEvent({ type: 'reference_created', source: 'server_identity', details: { referenceId: refId, version: maxVersion + 1, embeddingCount: reference.embeddings.length } });
  m.set({ verifiedInstanceId: a.instanceId, checkAttemptsResetAt: new Date(m.now) });
  m.setIdentityState({ ...identityState(m.session), lastMatchAt: m.now });

  let outcome: Outcome = {
    outcome: 'passed',
    message: 'Readiness check complete. You can start the exam when you are ready.',
    guidance: [],
    identity: idRow,
    idPhoto: a.idPhoto ? { decision: a.idPhoto.decision, similarity: a.idPhoto.similarity } : null,
    attemptsRemaining: policy.identity.maxVerificationAttempts,
  };

  // Close check-in, session is ready.
  await m.closeOpenPeriod(m.now);
  m.set({ status: 'ready' });

  if (a.idPhoto) {
    const cand = await m.candidate();
    const photoRow = await insertIdentityCheck(a, {
      trigger: 'id_photo',
      decision: a.idPhoto.decision,
      similarity: a.idPhoto.similarity,
      confidence: a.idPhoto.confidence,
      quality: reference.quality,
      referenceId: refId,
      probeEvidenceId: images[0]?.id ?? null,
      context: { precededBy: [], periodKind: 'check_in', secondsSincePreviousMatch: null, against: 'id_photo' },
    });
    await m.addEvent({
      type: 'id_photo_compared',
      source: 'server_identity',
      details: { decision: a.idPhoto.decision, similarity: a.idPhoto.similarity, policy: policy.identity.idPhotoComparison, identityCheckId: photoRow.id },
    });
    if (a.idPhoto.decision === 'mismatch') {
      const ev = await m.addEvent({
        type: 'identity_mismatch',
        source: 'server_identity',
        confidence: a.idPhoto.confidence,
        observation: 'The candidate at check-in may not be the person in the approved identity photo.',
        details: { against: 'id_photo', similarity: a.idPhoto.similarity, thresholds: { match: a.thresholds.idPhotoMatch, mismatch: a.thresholds.idPhotoMismatch }, identityCheckIds: [photoRow.id] },
        context: { precededBy: [], periodKind: 'check_in', trigger: 'id_photo' },
      });
      await m.tx.update(identityChecks).set({ eventId: ev.id }).where(eq(identityChecks.id, photoRow.id));
      for (const img of images) await copyEvidence(a.ctx, m.tx, img, { kind: 'identity_probe', eventId: ev.id, identityCheckId: photoRow.id });
      if (cand.idPhotoEvidenceId) {
        const [photo] = await m.tx.select().from(evidence).where(eq(evidence.id, cand.idPhotoEvidenceId));
        if (photo) await copyEvidence(a.ctx, m.tx, photo, { kind: 'id_photo', eventId: ev.id });
      }
    }
    if (policy.identity.idPhotoComparison === 'required' && a.idPhoto.decision !== 'match') {
      // Inconclusive / unable to verify is NOT a mismatch: a distinct reason so staff and candidate are told the truth.
      const reason = a.idPhoto.decision === 'mismatch' ? 'id_photo_mismatch' : 'id_photo_unverifiable';
      await holdNow(m, { reason, details: { decision: a.idPhoto.decision, similarity: a.idPhoto.similarity } });
      outcome = { ...outcome, outcome: 'held', message: m.session.holdMessage ?? '' };
    }
  }
  return outcome;
}

/* ------------------------------------------------------------------ resume / reconnect / reverify */

async function environmentContext(a: ApplyCtx): Promise<{ cameraChanged: boolean; notes: string[] }> {
  const { m, check, active } = a;
  const notes: string[] = [];
  // Camera compared with the previous passed check (or the reference enrolment).
  const [prevDevice] = await m.tx
    .select({ cameraLabel: deviceRecords.cameraLabel, cameraIdHash: deviceRecords.cameraIdHash })
    .from(deviceRecords)
    .innerJoin(checks, eq(checks.id, deviceRecords.checkId))
    .where(and(eq(deviceRecords.sessionId, m.session.id), eq(checks.status, 'passed')))
    .orderBy(desc(deviceRecords.at))
    .limit(1);
  const before = prevDevice ?? (active?.ref.environment ? { cameraLabel: active.ref.environment.cameraLabel, cameraIdHash: active.ref.environment.cameraIdHash } : null);
  const now = { cameraLabel: check.device.cameraLabel ?? '', cameraIdHash: check.device.cameraIdHash ?? '' };
  const cameraChanged = !!before && ((before.cameraIdHash && now.cameraIdHash && before.cameraIdHash !== now.cameraIdHash) || (!!before.cameraLabel && !!now.cameraLabel && before.cameraLabel !== now.cameraLabel));
  if (cameraChanged) {
    notes.push(`Camera changed from “${before!.cameraLabel || 'unknown'}” to “${now.cameraLabel || 'unknown'}”.`);
    await m.addEvent({ type: 'camera_changed', source: 'server_system', details: { previousLabel: before!.cameraLabel, newLabel: now.cameraLabel, purpose: check.purpose } });
  }
  const refB = active?.ref.environment?.imageBrightness;
  const probeIdx = a.aggregate?.bestProbeIndex;
  const curB = probeIdx != null ? a.prepared.frontal[probeIdx]?.analysis.imageBrightness : a.prepared.frontal[0]?.analysis.imageBrightness;
  if (refB != null && curB != null && Math.abs(curB - refB) >= BRIGHTNESS_CHANGE) {
    const dir = curB > refB ? 'brighter' : 'darker';
    notes.push(`The scene is noticeably ${dir} than at the identity reference.`);
    await m.addEvent({
      type: 'environment_changed',
      source: 'server_identity',
      observation: `The lighting differs from the identity reference (${dir}). Recorded as context only.`,
      details: { aspect: 'lighting', referenceBrightness: Math.round(refB), currentBrightness: Math.round(curB), contextOnly: true },
    });
  }
  return { cameraChanged, notes };
}

async function applyContinuation(a: ApplyCtx): Promise<Outcome> {
  const { m, check, aggregate, policy, liveness } = a;
  const purpose = check.purpose;
  const s = m.session;
  const checkStart = check.issuedAt.getTime();
  const open = await m.openPeriodRow();
  const pauseStart = s.status === 'paused' && open?.kind === 'paused' ? open.startedAt.getTime() : null;
  const gapStart = purpose === 'reconnect' ? reconnectGapStart(s, check) : null;
  const pre = await precedingContext(m.tx, s.id, checkStart, TRIGGER_FOR[purpose]);
  const st = identityState(s);
  const context = {
    precededBy: pre.precededBy,
    periodKind: open?.kind ?? null,
    secondsSincePreviousMatch: st.lastMatchAt ? Math.round((m.now - st.lastMatchAt) / 1000) : null,
    pauseDurationMs: pauseStart != null ? checkStart - pauseStart : undefined,
    disconnectedMs: gapStart != null ? checkStart - gapStart : undefined,
    livenessPassed: a.livenessOk,
    matchCount: aggregate?.matchCount,
    mismatchCount: aggregate?.mismatchCount,
    unableCount: aggregate?.unableCount,
  };
  const quality = aggregate?.bestProbeIndex != null ? a.prepared.frontal[aggregate.bestProbeIndex]?.analysis.quality : (a.prepared.frontal[0]?.analysis.quality ?? null);
  // Only the reverify check of a hold released with reEnroll=true may replace the reference (see reEnrollmentApplies).
  const reEnroll = reEnrollmentApplies(s, purpose) && !!a.reference;

  if (!a.livenessOk) {
    const decision: IdentityDecision = aggregate?.decision === 'match' ? 'inconclusive' : (aggregate?.decision ?? 'unable_to_verify');
    const idRow = await insertIdentityCheck(a, {
      decision,
      similarity: aggregate?.similarity ?? null,
      confidence: aggregate?.confidence ?? 1,
      quality,
      guidance: liveness?.reasons ?? [],
      referenceId: a.active?.ref.id ?? null,
      context,
    });
    // A failed liveness challenge must not hide frames that clearly show a different person: record the
    // observation with before/after images and apply the mismatch policy (a re-enrolment is judged when it passes).
    if (decision === 'mismatch' && !reEnroll && a.active) {
      const ev = await recordReferenceMismatch(a, idRow, { context, environmentNotes: [], extraDetails: { livenessPassed: false } });
      if (policy.identity.onMismatch === 'hold_for_review') {
        await closeGapPeriods(a, { checkStart, pauseStart, gapStart });
        await holdNow(m, { reason: 'identity_mismatch', source: 'server_identity', details: { eventId: ev.id, purpose, livenessPassed: false } });
        m.set({ verifiedInstanceId: a.instanceId });
        return { outcome: 'held', message: m.session.holdMessage ?? '', guidance: [], identity: idRow, idPhoto: null, attemptsRemaining: 0 };
      }
      // flag_only: recorded; the live-person check still has to be repeated before the exam continues.
    }
    return retryOrHold(a, { message: LIVENESS_RETRY_MESSAGE, guidance: liveness?.reasons ?? [], identity: idRow, reason: 'liveness_failed' });
  }

  const env = await environmentContext(a);
  if (env.cameraChanged && !context.precededBy.includes('camera_change')) context.precededBy.push('camera_change');

  // Staff-authorised re-enrolment: build a NEW reference (old one kept, superseded, audited).
  if (reEnroll) {
    const ref = a.reference!;
    if (!ref.ok) {
      const idRow = await insertIdentityCheck(a, { decision: 'unable_to_verify', confidence: 1, quality, guidance: ref.reasons, context: { ...context, reEnrollment: true } });
      return retryOrHold(a, { message: IDENTITY_RETRY_MESSAGE, guidance: ref.reasons, identity: idRow, reason: 'reference_not_established' });
    }
    const refId = randomUUID();
    const old = a.active?.ref ?? null;
    // Staff authorised a new reference, but reviewers must still see when the person enrolled now does not
    // match the previous reference: record it (before/after images) against the OLD reference, then re-enrol.
    let reEnrollMismatchEventId: string | null = null;
    if (old && aggregate?.decision === 'mismatch') {
      const mmRow = await insertIdentityCheck(a, {
        decision: 'mismatch',
        similarity: aggregate.similarity,
        confidence: aggregate.confidence,
        quality,
        guidance: [],
        referenceId: old.id,
        context: { ...context, reEnrollment: true },
      });
      const ev = await recordReferenceMismatch(a, mmRow, {
        context: { ...context, reEnrolled: true },
        environmentNotes: env.notes,
        // Starts when the check began, while the previous reference was still the one in force.
        startedAt: checkStart,
        observation:
          'At the re-enrolment authorised by an administrator, the person in view did not match the previous identity reference. A new reference was created as authorised; the previous one is kept for comparison.',
        extraDetails: { reEnrolled: true, authorizedBy: s.reEnrollAuthorizedBy, newReferenceId: refId },
      });
      reEnrollMismatchEventId = ev.id;
    }
    const [{ maxVersion }] = await m.tx
      .select({ maxVersion: sql<number>`coalesce(max(${identityReferences.version}), 0)::int` })
      .from(identityReferences)
      .where(eq(identityReferences.sessionId, s.id));
    const refFrame = a.prepared.frontal[ref.bestIndex];
    const images = await storePair(a, await loadImages(a.ctx, refFrame), 'identity_reference', {});
    await m.tx
      .update(identityReferences)
      .set({ active: false, supersededAt: new Date(m.now), supersededReason: 're_enrollment_authorized', supersededBy: s.reEnrollAuthorizedBy })
      .where(and(eq(identityReferences.sessionId, s.id), eq(identityReferences.active, true)));
    await m.tx.insert(identityReferences).values({
      id: refId,
      sessionId: s.id,
      candidateId: s.candidateId,
      version: maxVersion + 1,
      embeddingsEnc: a.ctx.keyring.encrypt(serializeEmbeddings(ref.embeddings), referenceAad(refId)),
      embeddingCount: ref.embeddings.length,
      quality: ref.quality,
      liveness,
      imageEvidenceIds: images.map((e) => e.id),
      environment: { imageBrightness: refFrame?.analysis.imageBrightness ?? null, faceBrightness: ref.quality?.brightness ?? null, cameraLabel: check.device.cameraLabel ?? '', cameraIdHash: check.device.cameraIdHash ?? '' },
      checkId: check.id,
      authorizedBy: s.reEnrollAuthorizedBy,
      active: true,
      createdAt: new Date(m.now),
    });
    const idRow = await insertIdentityCheck(a, {
      decision: 'match',
      similarity: aggregate?.similarity ?? null,
      confidence: 1,
      quality: ref.quality,
      referenceId: refId,
      probeEvidenceId: images[0]?.id ?? null,
      frameEvidenceId: images[1]?.id ?? null,
      context: { ...context, reEnrollment: true, previousReferenceId: old?.id ?? null, decisionAgainstPrevious: aggregate?.decision ?? null },
    });
    await m.addEvent({
      type: 'reference_created',
      source: 'server_identity',
      observation: 'A new identity reference was established after an administrator authorised re-enrolment. The previous reference is kept.',
      details: {
        referenceId: refId,
        version: maxVersion + 1,
        reEnrollment: true,
        previousReferenceId: old?.id ?? null,
        authorizedBy: s.reEnrollAuthorizedBy,
        similarityToPrevious: aggregate?.similarity ?? null,
        decisionAgainstPrevious: aggregate?.decision ?? null,
        mismatchEventId: reEnrollMismatchEventId,
      },
    });
    await audit(m.tx, {
      orgId: s.orgId,
      actorType: 'staff',
      actorId: s.reEnrollAuthorizedBy,
      action: 'reference.re_enrolled',
      targetType: 'session',
      targetId: s.id,
      meta: { newReferenceId: refId, previousReferenceId: old?.id ?? null, checkId: check.id, decisionAgainstPrevious: aggregate?.decision ?? null, mismatchEventId: reEnrollMismatchEventId },
      at: m.now,
    });
    m.set({ reEnrollAuthorized: false, reEnrollAuthorizedBy: null });
    return continueAfterPass(a, idRow, { checkStart, pauseStart, gapStart, similarity: aggregate?.similarity ?? null });
  }

  const agg = aggregate!;
  const probeLinked = agg.decision !== 'match' || policy.evidence.keepMatchingIdentitySamples;
  const baseFields = {
    similarity: agg.similarity,
    confidence: agg.confidence,
    quality,
    guidance: agg.guidance,
    referenceId: a.active?.ref.id ?? null,
    dhash: a.prepared.frontal[agg.bestProbeIndex ?? 0]?.analysis.dhash ?? null,
    context: { ...context, environmentNotes: env.notes },
  };

  if (agg.decision === 'match') {
    const idRow = await insertIdentityCheck(a, { decision: 'match', ...baseFields });
    if (probeLinked) {
      const imgs = await storePair(a, a.probeImages, 'identity_probe', { identityCheckId: idRow.id });
      await m.tx.update(identityChecks).set({ probeEvidenceId: imgs[0]?.id ?? null, frameEvidenceId: imgs[1]?.id ?? null }).where(eq(identityChecks.id, idRow.id));
    }
    return continueAfterPass(a, idRow, { checkStart, pauseStart, gapStart, similarity: agg.similarity });
  }

  if (agg.decision === 'mismatch') {
    const idRow = await insertIdentityCheck(a, { decision: 'mismatch', ...baseFields });
    const ev = await recordReferenceMismatch(a, idRow, { context, environmentNotes: env.notes });
    if (policy.identity.onMismatch === 'hold_for_review') {
      await closeGapPeriods(a, { checkStart, pauseStart, gapStart });
      await holdNow(m, { reason: 'identity_mismatch', source: 'server_identity', details: { eventId: ev.id, purpose } });
      // The person staff will review is at this browser: if staff release without a fresh check, it continues here.
      m.set({ verifiedInstanceId: a.instanceId });
      return { outcome: 'held', message: m.session.holdMessage ?? '', guidance: [], identity: idRow, idPhoto: null, attemptsRemaining: 0 };
    }
    // flag_only: the observation is recorded; the exam continues.
    return continueAfterPass(a, idRow, { checkStart, pauseStart, gapStart, similarity: agg.similarity, flagged: true });
  }

  // unable_to_verify / inconclusive: never presented as a different person.
  const idRow = await insertIdentityCheck(a, { decision: agg.decision, ...baseFields });
  if (probeLinked) {
    const imgs = await storePair(a, a.probeImages, 'identity_probe', { identityCheckId: idRow.id });
    await m.tx.update(identityChecks).set({ probeEvidenceId: imgs[0]?.id ?? null, frameEvidenceId: imgs[1]?.id ?? null }).where(eq(identityChecks.id, idRow.id));
  }
  const guidance = agg.guidance.length ? agg.guidance : ['Face the camera directly with even light on your face, and hold still.'];
  return retryOrHold(a, { message: IDENTITY_RETRY_MESSAGE, guidance, identity: idRow, reason: agg.decision });
}

/**
 * Record an identity_mismatch observation of this check against the ACTIVE (previous) reference, with
 * before/after images: the probe frame of this check and copies of the reference images.
 */
async function recordReferenceMismatch(
  a: ApplyCtx,
  idRow: IdentityCheck,
  o: { context: Record<string, unknown>; environmentNotes: string[]; startedAt?: number; observation?: string; extraDetails?: Record<string, unknown> },
): Promise<EventRow> {
  const { m, check } = a;
  const agg = a.aggregate!;
  const purpose = check.purpose;
  const ev = await m.addEvent({
    type: 'identity_mismatch',
    source: 'server_identity',
    startedAt: o.startedAt,
    confidence: agg.confidence,
    observation:
      o.observation ??
      (purpose === 'resume'
        ? 'A different face may have appeared after the pause: the person at the resume check did not match the identity reference.'
        : purpose === 'reconnect'
          ? 'A different face may have appeared after the browser reconnected: the person at the check did not match the identity reference.'
          : 'The person at the re-verification check did not match the identity reference.'),
    details: {
      against: 'reference',
      purpose,
      similarity: agg.similarity,
      minSimilarity: agg.minSimilarity,
      maxSimilarity: agg.maxSimilarity,
      frames: { match: agg.matchCount, mismatch: agg.mismatchCount, inconclusive: agg.inconclusiveCount, unable: agg.unableCount },
      thresholds: { match: a.thresholds.match, mismatch: a.thresholds.mismatch },
      identityCheckIds: [idRow.id],
      referenceId: a.active?.ref.id ?? null,
      ...(o.extraDetails ?? {}),
    },
    context: { ...o.context, trigger: TRIGGER_FOR[purpose], environmentNotes: o.environmentNotes },
  });
  const probe = await storePair(a, a.probeImages, 'identity_probe', { identityCheckId: idRow.id, eventId: ev.id });
  await m.tx.update(identityChecks).set({ eventId: ev.id, probeEvidenceId: probe[0]?.id ?? null, frameEvidenceId: probe[1]?.id ?? null }).where(eq(identityChecks.id, idRow.id));
  await linkReferenceImages(a, ev.id);
  return ev;
}

/** Start of the unobserved gap a reconnect check closes: the last verified heartbeat of the previous browser. */
function reconnectGapStart(s: Pick<ExamSession, 'lastVerifiedHeartbeatAt'>, check: Pick<Check, 'issuedAt'>): number {
  const checkStart = check.issuedAt.getTime();
  return Math.min(s.lastVerifiedHeartbeatAt?.getTime() ?? checkStart, checkStart);
}

/**
 * A new browser instance replaced the previous one (reconnect): episodes the previous instance reported and
 * left open can never be closed by it, so they end where its observation ended (the gap start) instead of
 * spanning the unobserved gap and the rest of the exam. Server-owned events are not touched.
 */
export async function closeReplacedInstanceEvents(m: SessionMutation, newInstanceId: string, at: number): Promise<number> {
  const open = await m.tx
    .select({ id: events.id, startedAt: events.startedAt, details: events.details, clientInstanceId: events.clientInstanceId })
    .from(events)
    .where(and(eq(events.sessionId, m.session.id), eq(events.status, 'open'), inArray(events.source, [...CLIENT_EVENT_SOURCES])));
  let n = 0;
  for (const e of open) {
    if (e.clientInstanceId === newInstanceId) continue;
    await m.updateEvent(e.id, {
      status: 'closed',
      endedAt: new Date(Math.max(e.startedAt.getTime(), at)),
      details: { ...e.details, closedBy: 'instance_replaced', replacedByInstanceId: newInstanceId },
    });
    n++;
  }
  return n;
}

async function linkReferenceImages(a: ApplyCtx, eventId: string) {
  const ids = a.active?.ref.imageEvidenceIds ?? [];
  if (!ids.length) return;
  const rows = await a.m.tx.select().from(evidence).where(inArray(evidence.id, ids));
  for (const r of rows) await copyEvidence(a.ctx, a.m.tx, r, { kind: 'identity_reference', eventId });
}

/** Close the unobserved/active period that preceded the check and insert the (observed) resume_check period. */
async function closeGapPeriods(a: ApplyCtx, t: { checkStart: number; pauseStart: number | null; gapStart: number | null }) {
  const { m } = a;
  const open = await m.openPeriodRow();
  // Open episodes of the replaced browser end at the gap start (details.closedBy = 'instance_replaced').
  if (a.check.purpose === 'reconnect') await closeReplacedInstanceEvents(m, a.instanceId, t.gapStart ?? t.checkStart);
  if (a.check.purpose === 'reconnect' && open?.kind === 'active') {
    const gs = t.gapStart ?? t.checkStart;
    await m.closeOpenPeriod(gs);
    if (t.checkStart - gs > 0) await m.insertPeriod('disconnected', gs, { endedAt: t.checkStart, reason: 'browser_reconnected', meta: { newInstanceId: a.instanceId } });
  } else if (open) {
    await m.closeOpenPeriod(Math.max(open.startedAt.getTime(), t.checkStart));
  }
  await m.insertPeriod('resume_check', t.checkStart, { endedAt: m.now, reason: a.check.purpose, meta: { checkId: a.check.id } });
  // The browser is back: a reporting outage ends here.
  if (m.session.reportingEventId) await m.closeEvent(m.session.reportingEventId, m.now, { closedBy: 'reconnected' });
  m.set({ reportingEventId: null, reportingInterruptedSince: null });
}

async function continueAfterPass(
  a: ApplyCtx,
  idRow: IdentityCheck,
  t: { checkStart: number; pauseStart: number | null; gapStart: number | null; similarity: number | null; flagged?: boolean },
): Promise<Outcome> {
  const { m, policy, check } = a;
  const purpose = check.purpose;
  const st = identityState(m.session);
  if (st.openUnverifiableEventId) await m.closeEvent(st.openUnverifiableEventId, m.now, { closedBy: 'identity_match' });
  m.setIdentityState({ ...identityState(m.session), openUnverifiableEventId: null, lastMatchAt: t.flagged ? st.lastMatchAt : m.now });
  const base: Outcome = {
    outcome: 'passed',
    message: purpose === 'resume' ? 'Identity confirmed. Welcome back — your exam continues.' : 'Identity confirmed. Your exam continues.',
    guidance: [],
    identity: idRow,
    idPhoto: null,
    attemptsRemaining: policy.identity.maxVerificationAttempts,
  };
  if (!t.flagged) await m.addEvent({ type: 'identity_verified', source: 'server_identity', confidence: idRow.confidence, details: { purpose, similarity: t.similarity, identityCheckId: idRow.id } });
  m.set({ verifiedInstanceId: a.instanceId, checkAttemptsResetAt: new Date(m.now), lastVerifiedHeartbeatAt: new Date(m.now), lastHeartbeatAt: new Date(m.now), lastHeartbeatInstanceId: a.instanceId, connection: 'online' });

  if (m.session.status === 'ready') {
    // Reconnect before the exam started: nothing else changes.
    return base;
  }

  await closeGapPeriods(a, t);

  if (purpose === 'resume' && t.pauseStart != null && policy.pause.maxPauseDurationSec != null && t.checkStart - t.pauseStart > policy.pause.maxPauseDurationSec * 1000) {
    m.set({ status: 'active' });
    await holdNow(m, {
      reason: 'pause_limit',
      details: { pauseDurationMs: t.checkStart - t.pauseStart, maxPauseDurationSec: policy.pause.maxPauseDurationSec },
    });
    return { ...base, outcome: 'held', message: m.session.holdMessage ?? '' };
  }

  const next = m.session.status === 'on_hold' ? (m.session.holdPrevStatus === 'ready' ? 'ready' : 'active') : 'active';
  m.set({ status: next, ...(m.session.status === 'on_hold' ? clearedHold() : {}) });
  if (next === 'active') {
    await m.insertPeriod('active', m.now, { reason: purpose });
    m.clockStart();
    m.resetIdentityCounters();
    if (purpose === 'resume') {
      await m.addEvent({ type: 'session_resumed', details: { pauseDurationMs: t.pauseStart != null ? t.checkStart - t.pauseStart : null, checkId: check.id, similarity: t.similarity } });
    }
  }
  return base;
}

export { TRIGGER_FOR };

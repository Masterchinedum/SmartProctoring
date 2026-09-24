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
  type CheckProgressDTO,
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
  checkStepFrame,
  decideIdentity,
  deserializeEmbeddings,
  advisoryGuidance,
  CALIBRATION,
  cosineSimilarity,
  guidanceForIssues,
  INCONCLUSIVE_GUIDANCE,
  LIVENESS_DEFAULTS,
  NO_EMBEDDING_GUIDANCE,
  qualityScore,
  serializeEmbeddings,
  templateFrom,
  verifyLiveness,
  type FrameAggregateResult,
  type ImageAnalysis,
  type LivenessChallengeSpec,
  type LivenessFrame,
} from '../vision/index.js';
import { assessCheck, CHECK_EVIDENCE, POOR_LIGHT_GUIDANCE, sampleLabel, type CheckAssessment } from './identity-evidence.js';
import { secondOpinion, secondOpinionDetails, type SecondOpinionRecord } from './identity-external.js';
import { buildGallery, ENROL_TARGET_FRAMES, identityFrameIndexes, probeEvidence, scoreReference, type GalleryResult, type ProbeEvidence } from './identity-gallery.js';
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
export const MAX_FRAMES_PER_CHECK = 48;
/**
 * A liveness step the server reports as not satisfied (CheckProgressDTO.steps) may be re-prompted: its frames are
 * judged in windows of LIVENESS_DEFAULTS.maxFramesPerStep, at most MAX_STEP_ATTEMPTS windows per step (bounded
 * chances for a noisy frame; the anti-photo parallax check is unchanged).
 */
export const MAX_STEP_ATTEMPTS = 2;
export const MAX_FRAMES_PER_STEP = LIVENESS_DEFAULTS.maxFramesPerStep * MAX_STEP_ATTEMPTS;
/** Adaptive collection: the server keeps asking for frontal frames (CheckProgressDTO.frontalNeeded) up to this many. */
export const MAX_FRONTAL_FRAMES = 10;
/**
 * ... and up to this many (StartCheckResponse.maxFrontalFrames, the hard cap) while frames are being rejected for
 * image quality (backlight, a dim room) but the usable ones agree: such an attempt is extended instead of ending
 * with too few usable frames.
 */
export const MAX_FRONTAL_FRAMES_EXTENDED = 24;
/** A check extends when at least this share of its frontal frames were unusable. */
const EXTEND_MIN_UNUSABLE_SHARE = 0.5;
/**
 * Usable frames of earlier failed attempts of the same resume / reconnect / reverify check (same reference, within
 * this window) are pooled with the current attempt's — only when the current attempt's own usable frames clearly
 * agree with the reference and with them.
 */
export const POOL_WINDOW_MS = 5 * 60_000;
export const POOL_MAX_FRAMES = 8;
/**
 * A failed attempt caused only by image quality (no or too few usable frames, or evidence only from poor-light
 * frames) counts this much against maxVerificationAttempts: image quality alone must not lead to a hold as fast as a
 * real non-match (the candidate gets lighting guidance and more tries before human review).
 */
export const QUALITY_RETRY_WEIGHT = 0.5;
const BRIGHTNESS_CHANGE = 45;

const TRIGGER_FOR: Record<CheckPurpose, IdentityCheckTrigger> = { initial: 'check_in', resume: 'resume', reconnect: 'reconnect', reverify: 'reverify' };

/**
 * Frontal frames the client uploads first (the minimum; CheckFrameResponse.progress.frontalNeeded asks for more
 * while the evidence is insufficient, up to MAX_FRONTAL_FRAMES). A check that builds a reference (initial, or a
 * staff-authorised re-enrolment) wants ENROL_TARGET_FRAMES for a diverse gallery even when the liveness challenge
 * is off; a comparison wants CALIBRATION.minFramesForDecision.
 */
export function frontalFramesRequired(purpose: CheckPurpose, buildsReference = purpose === 'initial'): number {
  return buildsReference ? ENROL_TARGET_FRAMES : CHECK_EVIDENCE.minFrames;
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

/** Failed attempts since the last reset, quality-only ones weighted QUALITY_RETRY_WEIGHT (unless `weighted` is false). */
async function failedAttempts(db: DbOrTx, s: ExamSession, purpose: CheckPurpose, excludeCheckId?: string, weighted = true): Promise<number> {
  const since = s.checkAttemptsResetAt ?? new Date(0);
  const rows = await db
    .select({ id: checks.id, result: checks.result })
    .from(checks)
    .where(and(eq(checks.sessionId, s.id), eq(checks.purpose, purpose), eq(checks.status, 'retry'), gte(checks.issuedAt, since)));
  return rows.filter((r) => r.id !== excludeCheckId).reduce((a, r) => a + (weighted && (r.result as { _meta?: { qualityOnly?: boolean } } | null)?._meta?.qualityOnly ? QUALITY_RETRY_WEIGHT : 1), 0);
}

const remaining = (max: number, used: number) => Math.max(0, Math.ceil(max - used - 1e-9));

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
        .select({ userAgent: deviceRecords.userAgent, cameraLabel: deviceRecords.cameraLabel, cameraIdHash: deviceRecords.cameraIdHash })
        .from(deviceRecords)
        .where(and(eq(deviceRecords.sessionId, s.id), eq(deviceRecords.clientInstanceId, other)))
        .orderBy(desc(deviceRecords.at))
        .limit(1);
      const differentDevice = !prevDevice || prevDevice.userAgent !== (body.device.userAgent ?? '') || cameraDiffers(prevDevice, body.device);
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
        attempt: (await failedAttempts(m.tx, s, required, undefined, false)) + 1,
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
      attemptsRemaining: remaining(max, failed),
      frontalFramesRequired: frontalFramesRequired(required, required === 'initial' || reEnrollmentApplies(s, required)),
      maxFrontalFrames: MAX_FRONTAL_FRAMES_EXTENDED,
    };
  });
}

/**
 * Whether two device records refer to different cameras. Browsers re-randomise deviceId per origin in
 * private/incognito profiles (every page load), so the label is authoritative when both sides have one;
 * the deviceId hash is only used when a label is missing.
 */
export function cameraDiffers(
  a: { cameraLabel?: string | null; cameraIdHash?: string | null },
  b: { cameraLabel?: string | null; cameraIdHash?: string | null },
): boolean {
  const la = (a.cameraLabel ?? '').trim();
  const lb = (b.cameraLabel ?? '').trim();
  if (la && lb) return la !== lb;
  return !!a.cameraIdHash && !!b.cameraIdHash && a.cameraIdHash !== b.cameraIdHash;
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
  if (forStep >= (step === 'frontal' ? MAX_FRONTAL_FRAMES_EXTENDED : MAX_FRAMES_PER_STEP)) {
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
  const progress = await checkProgress(ctx, check);
  if (step === 'frontal') {
    const accepted = quality.usable && analysis.embedding != null;
    return { accepted, quality, guidance: accepted ? [] : guidanceFor(quality.issues), measured: analysis.pose ? { yawDeg: r1(analysis.pose.yawDeg), pitchDeg: r1(analysis.pose.pitchDeg) } : undefined, progress };
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
  // The step's status as the server will verify it (its best window so far), not just this frame.
  const stepSatisfied = progress.steps.find((x) => x.index === Number(step))?.satisfied ?? fb.satisfied;
  return { accepted, quality, guidance: stepSatisfied ? guidanceFor(issues) : guidance, stepSatisfied, measured: fb.measured ?? undefined, progress };
}

/* =================================================================== adaptive progress */

function livenessSpecOf(check: Pick<Check, 'liveness' | 'issuedAt' | 'expiresAt'>): LivenessChallengeSpec | null {
  const spec = check.liveness;
  return spec ? { steps: spec.steps, issuedAt: check.issuedAt.getTime(), expiresAt: check.expiresAt.getTime(), targetYawDeg: spec.targetYawDeg, targetPitchDeg: spec.targetPitchDeg } : null;
}

/**
 * Liveness frames to verify: frontal frames plus, per step, the first window of LIVENESS_DEFAULTS.maxFramesPerStep
 * frames (receipt order) that satisfies the step, else its latest window (at most MAX_STEP_ATTEMPTS windows).
 * A re-prompted step thus gets a second, bounded chance without letting a client fish with unlimited frames.
 */
export function selectLivenessFrames(frames: readonly LivenessFrame[], spec: LivenessChallengeSpec, thresholds: IdentityThresholds): LivenessFrame[] {
  const W = Math.max(1, LIVENESS_DEFAULTS.maxFramesPerStep);
  const base = frames.filter((f) => f.step === 'frontal');
  const keep = new Set<LivenessFrame>(base);
  for (const step of spec.steps) {
    const sf = frames.filter((f) => f.step === step.index);
    const windows: LivenessFrame[][] = [];
    for (let i = 0; i < sf.length && windows.length < MAX_STEP_ATTEMPTS; i += W) windows.push(sf.slice(i, i + W));
    if (!windows.length) continue;
    let chosen = windows[windows.length - 1];
    if (windows.length > 1) {
      for (const w of windows) {
        const r = verifyLiveness(spec, [...base, ...w], thresholds);
        if (r.steps.find((x) => x.index === step.index)?.passed) {
          chosen = w;
          break;
        }
      }
    }
    for (const f of chosen) keep.add(f);
  }
  return frames.filter((f) => keep.has(f));
}

function verifyCheckLiveness(check: Pick<Check, 'liveness' | 'issuedAt' | 'expiresAt'>, frames: readonly LivenessFrame[], thresholds: IdentityThresholds): LivenessResultDTO | null {
  const spec = livenessSpecOf(check);
  return spec ? verifyLiveness(spec, selectLivenessFrames(frames, spec, thresholds), thresholds) : null;
}

/**
 * The server's running assessment after a frame (CheckFrameResponse.progress): usable frontal frames, how many more
 * it wants (enrolment: a diverse gallery; comparison: enough accumulated evidence either way), the running identity
 * assessment against the protected reference, the liveness steps' status, and whether /complete can be called.
 */
export async function checkProgress(ctx: Ctx, check: Check): Promise<CheckProgressDTO> {
  const [s] = await ctx.db.select().from(examSessions).where(eq(examSessions.id, check.sessionId));
  const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, s.orgId));
  const thresholds = orgThresholds(org);
  const prepared = await prepareFrames(ctx, check.id);
  const frontalSubmitted = prepared.frames.filter((f) => f.step === 'frontal').length;
  const buildsReference = check.purpose === 'initial' || reEnrollmentApplies(s, check.purpose);
  const frontalOnly = prepared.frames.filter((f) => f.step === 'frontal');
  // Frames are being rejected for image quality (backlight, dim room): a condition for extending the attempt.
  const qualityRejecting = frontalOnly.length > 0 && frontalOnly.filter((f) => !f.analysis.quality.usable || !f.analysis.embedding).length >= EXTEND_MIN_UNUSABLE_SHARE * frontalOnly.length;

  let frontalAccepted = prepared.frontal.filter((f) => f.isFrontal && f.analysis.quality.usable && f.analysis.embedding != null).length;
  let frontalNeeded = 0;
  let identity: CheckProgressDTO['identity'] = null;
  let extend = false;
  let limit = MAX_FRONTAL_FRAMES;
  if (buildsReference) {
    const g = buildGallery(prepared.frontal.map((f) => ({ analysis: f.analysis, frontal: f.isFrontal })), thresholds);
    frontalAccepted = g.usableFrontal;
    // Too few clear frames so far, but some came through: keep collecting instead of failing the attempt.
    extend = !g.ok && g.failure === 'too_few' && g.usableFrontal > 0 && qualityRejecting;
    if (g.ok) frontalNeeded = Math.max(0, ENROL_TARGET_FRAMES - g.usableFrontal);
    else frontalNeeded = g.failure === 'too_few' ? Math.max(1, ENROL_TARGET_FRAMES - g.usableFrontal) : 2;
  } else {
    const active = await loadActiveReference(ctx, ctx.db, check.sessionId);
    if (active) {
      const pooled = await pooledEvidence(ctx, s, check, active, prepared.frontal.map((f) => f.analysis), thresholds);
      const current = probeEvidence(prepared.frontal.map((f) => f.analysis), active.embeddings, active.ref.baseline ?? null, 'relaxed');
      const all = [...current, ...pooled];
      const usable = all.filter((f) => f.usable);
      // The usable frames agree with the reference, just not enough of them yet: extend (quality, not identity).
      const agreeing = usable.length > 0 && usable.every((f) => f.llr <= -2) && usable.some((f) => f.llr <= -3);
      const provisional = assessCheck(all, { atLimit: false });
      extend = qualityRejecting && agreeing && (provisional.status === 'pending' || provisional.status === 'uncertain');
      limit = extend ? MAX_FRONTAL_FRAMES_EXTENDED : MAX_FRONTAL_FRAMES;
      const atLimitNow = frontalSubmitted >= limit || prepared.frames.length >= MAX_FRAMES_PER_CHECK;
      const a = assessCheck(all, { atLimit: atLimitNow });
      identity = a.status;
      frontalNeeded = a.status === 'pending' ? Math.max(1, CHECK_EVIDENCE.minFrames - a.usable) : a.status === 'uncertain' ? 2 : 0;
    }
  }
  if (extend) limit = MAX_FRONTAL_FRAMES_EXTENDED;
  const atLimit = frontalSubmitted >= limit || prepared.frames.length >= MAX_FRAMES_PER_CHECK;
  const room = Math.max(0, limit - frontalSubmitted);
  frontalNeeded = atLimit ? 0 : Math.min(frontalNeeded, room);

  const expired = ctx.now() > check.expiresAt.getTime();
  const liveness = verifyCheckLiveness(check, livenessFrames(prepared), thresholds);
  const steps = (liveness?.steps ?? []).map((x) => ({ index: x.index, satisfied: x.passed }));
  const stepFrames = (i: number) => prepared.frames.filter((f) => f.step === String(i)).length;
  const livenessOpen = !expired && prepared.frames.length < MAX_FRAMES_PER_CHECK && steps.some((x) => !x.satisfied && stepFrames(x.index) < MAX_FRAMES_PER_STEP);
  return { frontalAccepted, frontalNeeded, identity, steps, canComplete: expired || (frontalNeeded === 0 && !livenessOpen) };
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

interface PreparedFrame {
  id: string;
  step: string;
  action: LivenessAction | 'center';
  capturedAt: number;
  evidenceId: string | null;
  cropId: string | null;
  analysis: ImageAnalysis;
  clientYaw: number | null;
  clientPitch: number | null;
  /** A frontal frame (step 'frontal' or the 'center' step) rather than a near-frontal liveness frame. */
  isFrontal: boolean;
}

interface PreparedFrames {
  frames: PreparedFrame[];
  /**
   * Identity evidence, receipt order: frontal frames plus liveness frames within NEAR_FRONTAL_* of the candidate's
   * frontal pose (identity-gallery.ts identityFrameIndexes).
   */
  frontal: PreparedFrame[];
}

async function prepareFrames(ctx: Ctx, checkId: string): Promise<PreparedFrames> {
  // Server receipt order; the liveness time window and step order use server receipt time, not client clocks.
  const rows = await ctx.db.select().from(checkFrames).where(eq(checkFrames.checkId, checkId)).orderBy(asc(checkFrames.seq));
  const frames: PreparedFrame[] = rows.map((f) => ({
    id: f.id,
    step: f.step,
    action: f.action,
    capturedAt: f.receivedAt.getTime(),
    evidenceId: f.evidenceId,
    cropId: f.faceCropEvidenceId,
    analysis: frameToAnalysis(ctx, f),
    clientYaw: f.clientYaw,
    clientPitch: f.clientPitch,
    isFrontal: f.step === 'frontal' || f.action === 'center',
  }));
  return { frames, frontal: identityFrameIndexes(frames).map((x) => frames[x.index]) };
}

/**
 * Usable identity frames of earlier failed attempts of the same resume / reconnect / reverify check (same reference,
 * within POOL_WINDOW_MS), as evidence against the reference — only when the current attempt's own usable frames all
 * agree with the reference (at least one clearly) and the pooled frames show the same face as them. So attempt 2
 * builds on attempt 1 in backlight, but frames of an earlier attempt never vouch for someone else now.
 */
async function pooledFrameAnalyses(ctx: Ctx, s: ExamSession, check: Check, active: ActiveReference): Promise<ImageAnalysis[]> {
  if (check.purpose === 'initial') return [];
  const since = Math.max(check.issuedAt.getTime() - POOL_WINDOW_MS, s.checkAttemptsResetAt?.getTime() ?? 0, active.ref.createdAt.getTime());
  const prior = await ctx.db
    .select({ id: checks.id })
    .from(checks)
    .where(and(eq(checks.sessionId, s.id), eq(checks.purpose, check.purpose), eq(checks.status, 'retry'), gte(checks.issuedAt, new Date(since))))
    .orderBy(desc(checks.issuedAt))
    .limit(3);
  const out: ImageAnalysis[] = [];
  for (const p of prior) {
    if (p.id === check.id) continue;
    const frames = await prepareFrames(ctx, p.id);
    for (const f of [...frames.frontal].reverse()) if (f.analysis.quality.usable && f.analysis.embedding && out.length < POOL_MAX_FRAMES) out.push(f.analysis);
  }
  return out;
}

function gatePooled(current: ProbeEvidence[], currentAnalyses: readonly ImageAnalysis[], pooled: ProbeEvidence[], pooledAnalyses: readonly ImageAnalysis[], thresholds: IdentityThresholds): ProbeEvidence[] {
  const cur = current.filter((f) => f.usable && currentAnalyses[f.index].embedding);
  if (!cur.length || cur.some((f) => f.llr > 0) || !cur.some((f) => f.llr <= -3)) return [];
  const t = templateFrom(cur.map((f) => currentAnalyses[f.index].embedding!));
  return pooled.filter((f) => f.usable && pooledAnalyses[f.index].embedding && f.llr <= 0 && cosineSimilarity(pooledAnalyses[f.index].embedding!, t) >= thresholds.match);
}

async function pooledEvidence(ctx: Ctx, s: ExamSession, check: Check, active: ActiveReference, currentAnalyses: readonly ImageAnalysis[], thresholds: IdentityThresholds): Promise<ProbeEvidence[]> {
  const pooledAnalyses = await pooledFrameAnalyses(ctx, s, check, active);
  if (!pooledAnalyses.length) return [];
  const current = probeEvidence(currentAnalyses, active.embeddings, active.ref.baseline ?? null, 'relaxed');
  const pooled = probeEvidence(pooledAnalyses, active.embeddings, active.ref.baseline ?? null, 'relaxed');
  return gatePooled(current, currentAnalyses, pooled, pooledAnalyses, thresholds);
}

/** Assessment of a resume / reconnect / reverify check's frames against the protected reference. */
interface ContinuationIdentity extends FrameAggregateResult {
  assessment: CheckAssessment;
  perFrame: ProbeEvidence[];
  /** Usable frames of earlier attempts that contributed (pooled). */
  pooledFrames: number;
  /** Not decided because of image quality alone (too few usable frames / poor-light-only evidence). */
  qualityOnly: boolean;
}

/**
 * Decide a comparison check on the accumulated evidence of all its identity frames (identity-evidence.ts
 * assessCheck): likely the same person => match; likely a different person (and the mean-embedding score below the
 * match threshold) => mismatch — also when some frames were fair / poor; otherwise inconclusive; no usable frame at
 * all => unable_to_verify (guidance).
 */
function assessContinuation(analyses: readonly ImageAnalysis[], active: ActiveReference, thresholds: IdentityThresholds, pooledAnalyses: readonly ImageAnalysis[] = []): ContinuationIdentity {
  const perFrame = probeEvidence(analyses, active.embeddings, active.ref.baseline ?? null, 'relaxed');
  const pooledAll = probeEvidence(pooledAnalyses, active.embeddings, active.ref.baseline ?? null, 'relaxed');
  const pooled = gatePooled(perFrame, analyses, pooledAll, pooledAnalyses, thresholds);
  const assessment = assessCheck([...perFrame, ...pooled], { atLimit: true });
  const usable = perFrame.filter((f) => f.usable && analyses[f.index].embedding);
  const sims = usable.map((f) => f.similarity!).sort((a, b) => a - b);
  const aggEmb = [...usable.map((f) => analyses[f.index].embedding!), ...pooled.map((f) => pooledAnalyses[f.index].embedding!)];
  const aggSim = aggEmb.length ? scoreReference(aggEmb, active.embeddings) : null;
  let decision: IdentityDecision;
  if (assessment.status === 'likely_match' && aggSim != null && aggSim >= thresholds.mismatch) decision = 'match';
  else if (assessment.status === 'likely_mismatch' && aggSim != null && aggSim < thresholds.match) decision = 'mismatch';
  else if (usable.length === 0) decision = 'unable_to_verify';
  else decision = 'inconclusive';
  const labels = perFrame.map((f) => sampleLabel(f.similarity, analyses[f.index].quality, thresholds, f.usable ? f.llr : null));
  const count = (d: IdentityDecision) => labels.filter((l) => l === d).length;
  const allIssues = analyses.flatMap((a) => a.quality.issues);
  let guidance: string[] = [];
  let confidence: number;
  if (decision === 'match') confidence = Math.round((1 - assessment.posterior) * 10000) / 10000;
  else if (decision === 'mismatch') confidence = assessment.posterior;
  else if (decision === 'unable_to_verify') {
    confidence = 1;
    guidance = allIssues.length ? guidanceForIssues(allIssues) : [NO_EMBEDDING_GUIDANCE];
  } else {
    confidence = 0.5;
    const unusableIssues = perFrame.filter((f) => !f.usable).flatMap((f) => analyses[f.index].quality.issues);
    guidance = unusableIssues.length ? guidanceForIssues(unusableIssues) : [INCONCLUSIVE_GUIDANCE];
    if (assessment.poorLight) {
      // Only poor-light frames pointed away from the reference: ask for light, not "try again".
      const advisory = perFrame.filter((f) => f.usable && f.bucket === 'poor').flatMap((f) => advisoryGuidance(analyses[f.index].quality));
      guidance = [...new Set([...advisory, POOR_LIGHT_GUIDANCE, ...guidance])];
    }
  }
  const pick = (idx: number[], by: (i: number) => number) => idx.reduce<number | null>((b, i) => (b == null || by(i) > by(b) ? i : b), null);
  const usableIdx = usable.map((f) => f.index);
  const bestProbeIndex =
    (decision === 'mismatch' ? pick(usableIdx, (i) => perFrame[i].llr) : pick(usableIdx, (i) => qualityScore(analyses[i].quality))) ??
    pick(
      analyses.map((_, i) => i).filter((i) => analyses[i].primary != null),
      (i) => qualityScore(analyses[i].quality),
    );
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  return {
    decision,
    similarity: aggSim,
    confidence,
    guidance,
    frames: perFrame.map((f, i) => ({ decision: labels[i], similarity: f.similarity, confidence: 1, guidance: [], index: f.index, usable: f.usable })),
    matchCount: count('match'),
    mismatchCount: count('mismatch'),
    inconclusiveCount: count('inconclusive'),
    unableCount: count('unable_to_verify'),
    usableCount: usable.length,
    minSimilarity: sims.length ? r4(sims[0]) : null,
    maxSimilarity: sims.length ? r4(sims[sims.length - 1]) : null,
    medianSimilarity: sims.length ? r4(median(sims)) : null,
    bestProbeIndex,
    assessment,
    perFrame,
    pooledFrames: pooled.length,
    qualityOnly: (decision === 'unable_to_verify' || decision === 'inconclusive') && (usable.length === 0 || assessment.status === 'pending' || assessment.poorLight || usable.length < CHECK_EVIDENCE.minFrames),
  };
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
  /** A retry caused by image quality alone (counts QUALITY_RETRY_WEIGHT against the attempt budget). */
  qualityOnly?: boolean;
}

export async function completeCheck(ctx: Ctx, sessionId: string, instanceId: string, checkId: string): Promise<CompleteCheckResponse> {
  const { check } = await loadCheckFor(ctx, sessionId, checkId, instanceId);
  if (check.status !== 'open') {
    // Idempotent replay of a completed check.
    const { _meta: _ignored, ...stored } = (check.result ?? {}) as Partial<CompleteCheckResponse> & { _meta?: unknown };
    void _ignored;
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

  const liveness: LivenessResultDTO | null = verifyCheckLiveness(check, livenessFrames(prepared), thresholds);
  const livenessOk = !liveness || liveness.passed;

  const frontalAnalyses = prepared.frontal.map((f) => f.analysis);
  let reference: GalleryResult | null = null;
  let aggregate: ContinuationIdentity | null = null;
  let active: ActiveReference | null = null;
  const purpose = check.purpose;
  // Re-checked under the lock in applyContinuation (the authorisation may change meanwhile).
  const reEnroll = reEnrollmentApplies(s0, purpose);
  if (purpose === 'initial' || reEnroll) reference = buildGallery(prepared.frontal.map((f) => ({ analysis: f.analysis, frontal: f.isFrontal })), thresholds);
  if (purpose !== 'initial') {
    active = await loadActiveReference(ctx, ctx.db, sessionId);
    if (!active && !reEnroll) throw invalidState('No identity reference exists for this exam');
    if (active) aggregate = assessContinuation(frontalAnalyses, active, thresholds, await pooledFrameAnalyses(ctx, s0, check, active));
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
      const sim = Math.max(...photoEmb.map((p) => scoreReference(p, reference!.gallery)));
      const d = decideIdentity(sim, reference.quality, thresholds, 'id_photo');
      idPhoto = { decision: d.decision, similarity: d.similarity, confidence: d.confidence };
    } catch (err) {
      ctx.log.error({ err, candidateId: cand.id }, 'ID photo comparison failed');
      idPhoto = { decision: 'unable_to_verify', similarity: null, confidence: 1 };
    }
  }

  // ---- optional external second opinion (docs/EXTERNAL_VERIFIER.md). Outside the lock: it may wait for a network
  // call. Off by default: secondOpinion() then returns null without loading anything, and nothing below changes.
  let second: SecondOpinionRecord | null = null;
  let idPhotoSecond: SecondOpinionRecord | null = null;
  const opinionBase = { org: org ?? null, consentAcceptedAt: s0.consentAcceptedAt, sessionId };
  if (purpose === 'initial' && reference?.ok) {
    if (idPhoto && cand.idPhotoEvidenceId) {
      // The approved ID photo comparison, judged with the ID-photo thresholds.
      const photoId = cand.idPhotoEvidenceId;
      idPhotoSecond = await secondOpinion(ctx, {
        ...opinionBase,
        kind: 'check_in',
        internal: { decision: idPhoto.decision, similarity: idPhoto.similarity },
        thresholds: { match: thresholds.idPhotoMatch, mismatch: thresholds.idPhotoMismatch },
        images: async () => {
          const [photo] = await ctx.db.select().from(evidence).where(eq(evidence.id, photoId));
          const ref = photo ? await readEvidence(ctx, photo) : null;
          const probe = refImages?.full ?? refImages?.crop ?? null;
          return ref && probe ? { reference: [ref], probe } : null;
        },
      });
      if (idPhotoSecond?.changed) idPhoto = { ...idPhoto, decision: idPhotoSecond.decision, confidence: idPhotoSecond.decision === 'inconclusive' ? 0.5 : idPhoto.confidence };
    } else if (livenessOk) {
      // No ID photo: the enrolment's own consistency — the reference frame vs the accepted frame taken last.
      const lastIdx = Math.max(-1, ...reference.accepted.filter((i) => i !== reference!.bestIndex));
      const last = lastIdx >= 0 ? prepared.frontal[lastIdx] : undefined;
      const best = prepared.frontal[reference.bestIndex];
      if (last?.analysis.embedding && best?.analysis.embedding) {
        second = await secondOpinion(ctx, {
          ...opinionBase,
          kind: 'check_in',
          internal: { decision: 'match', similarity: Math.round(cosineSimilarity(best.analysis.embedding, last.analysis.embedding) * 10000) / 10000 },
          thresholds,
          images: async () => {
            const probe = await loadImages(ctx, last);
            const ref = refImages?.full ?? refImages?.crop ?? null;
            const p = probe?.full ?? probe?.crop ?? null;
            return ref && p ? { reference: [ref], probe: p } : null;
          },
        });
      }
    }
  } else if (aggregate && active && !reEnroll && (livenessOk || aggregate.decision === 'mismatch')) {
    const ref = active;
    second = await secondOpinion(ctx, {
      ...opinionBase,
      kind: 'resume',
      internal: { decision: aggregate.decision, similarity: aggregate.similarity },
      thresholds,
      images: async () => {
        const probe = probeImages?.full ?? probeImages?.crop ?? null;
        const refs = await referenceImageBuffers(ctx, ref.ref.imageEvidenceIds);
        return probe && refs.length ? { reference: refs, probe } : null;
      },
    });
    if (second?.changed) aggregate = withSecondOpinion(aggregate, second);
  }

  // ---- apply under the session lock
  const outcome = await withSession(ctx, sessionId, async (m) => {
    const [cur] = await m.tx.select().from(checks).where(eq(checks.id, check.id)).for('update');
    if (!cur || cur.status !== 'open') throw conflict('check_closed', 'This check is no longer open. Start a new check.');
    if (m.session.activeInstanceId !== instanceId) throw conflict('superseded', SUPERSEDED_MESSAGE);
    if (requiredCheckFor(m.session, instanceId) !== purpose) throw conflict('check_not_required', 'This check is no longer needed.', { requiredCheck: requiredCheckFor(m.session, instanceId) });
    const ctxInfo: ApplyCtx = { m, ctx, check, policy, thresholds, liveness, livenessOk, reference, aggregate, active, refImages, probeImages, idPhoto, prepared, instanceId, second, idPhotoSecond };
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
    // _meta (not part of the response): quality-only retries count less against the attempt budget (failedAttempts).
    await m.tx
      .update(checks)
      .set({ status, completedAt: new Date(m.now), result: { ...response, _meta: { qualityOnly: out.qualityOnly === true } } as unknown as Record<string, unknown> })
      .where(eq(checks.id, check.id));
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
  reference: GalleryResult | null;
  aggregate: ContinuationIdentity | null;
  active: ActiveReference | null;
  refImages: ImagePair | null;
  probeImages: ImagePair | null;
  idPhoto: { decision: IdentityDecision; similarity: number | null; confidence: number } | null;
  prepared: PreparedFrames;
  instanceId: string;
  /** External second opinion on this check's identity decision (null when not asked — the default). */
  second: SecondOpinionRecord | null;
  /** External second opinion on the ID-photo comparison (initial check). */
  idPhotoSecond: SecondOpinionRecord | null;
}

/** Reference images for an external comparison: full frames first, then face crops. */
async function referenceImageBuffers(ctx: Ctx, ids: string[]): Promise<Buffer[]> {
  if (!ids.length) return [];
  const rows = await ctx.db.select().from(evidence).where(inArray(evidence.id, ids));
  const ordered = [...rows].sort((a, b) => (a.reason === 'frame' ? 0 : 1) - (b.reason === 'frame' ? 0 : 1));
  const out: Buffer[] = [];
  for (const r of ordered) {
    const data = await readEvidence(ctx, r);
    if (data) out.push(data);
  }
  return out;
}

/** The check decision after the external second opinion (fusion table, docs/EXTERNAL_VERIFIER.md §5). */
function withSecondOpinion(agg: ContinuationIdentity, r: SecondOpinionRecord): ContinuationIdentity {
  if (!r.changed) return agg;
  if (r.decision === 'inconclusive') return { ...agg, decision: 'inconclusive', confidence: 0.5, guidance: [INCONCLUSIVE_GUIDANCE] };
  return { ...agg, decision: r.decision, confidence: Math.max(0.5, Math.round((1 - agg.assessment.posterior) * 10000) / 10000), guidance: [] };
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
async function retryOrHold(a: ApplyCtx, why: { message: string; guidance: string[]; identity: IdentityCheck | null; reason: string; qualityOnly?: boolean }): Promise<Outcome> {
  const { m, policy, check } = a;
  const max = policy.identity.maxVerificationAttempts;
  const failedBefore = await failedAttempts(m.tx, m.session, check.purpose, check.id);
  const used = failedBefore + (why.qualityOnly ? QUALITY_RETRY_WEIGHT : 1);
  if (used >= max - 1e-9) {
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
      details: { purpose: check.purpose, attempts: used, lastReason: why.reason, qualityOnly: why.qualityOnly === true, guidance: why.guidance, livenessPassed: a.livenessOk, ...secondOpinionDetails(a.second) },
      context: { checkId: check.id },
    });
    if (why.identity) await m.tx.update(identityChecks).set({ eventId: ev.id }).where(eq(identityChecks.id, why.identity.id));
    // The replaced browser stopped observing when the gap began; its open episodes end there, not at the hold.
    if (check.purpose === 'reconnect') await closeReplacedInstanceEvents(m, a.instanceId, reconnectGapStart(m.session, check));
    await holdNow(m, { reason: 'identity_unverifiable', details: { purpose: check.purpose, attempts: used } });
    if (check.purpose !== 'initial') m.set({ verifiedInstanceId: a.instanceId });
    return { outcome: 'held', message: m.session.holdMessage ?? '', guidance: why.guidance, identity: why.identity, idPhoto: null, attemptsRemaining: 0 };
  }
  return { outcome: 'retry', message: why.message, guidance: why.guidance, identity: why.identity, idPhoto: null, attemptsRemaining: remaining(max, used), qualityOnly: why.qualityOnly === true };
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
    return retryOrHold(a, { message: IDENTITY_RETRY_MESSAGE, guidance, identity: idRow, reason: 'reference_not_established', qualityOnly: !reference || reference.failure === 'too_few' });
  }
  if (a.second && a.second.decision !== 'match') {
    // The external second opinion contradicted a borderline enrolment (frames possibly of different people):
    // no reference is established from them; retry (flagged for review in the check's context).
    const guidance = [INCONCLUSIVE_GUIDANCE];
    const idRow = await insertIdentityCheck(a, {
      decision: 'inconclusive',
      similarity: a.second.record.internal.similarity,
      confidence: 0.5,
      quality: reference.quality,
      guidance,
      context: { precededBy: [], periodKind: 'check_in', secondsSincePreviousMatch: null, secondOpinion: a.second },
    });
    return retryOrHold(a, { message: IDENTITY_RETRY_MESSAGE, guidance, identity: idRow, reason: 'second_opinion_inconclusive' });
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
    embeddingsEnc: a.ctx.keyring.encrypt(serializeEmbeddings(reference.gallery), referenceAad(refId)),
    embeddingCount: reference.gallery.length,
    baseline: reference.baseline,
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
    context: { precededBy: [], periodKind: 'check_in', secondsSincePreviousMatch: null, referenceCreated: true, ...(a.second ? { secondOpinion: a.second } : {}) },
  });
  await m.addEvent({
    type: 'checkin_completed',
    // The catalog text mentions the live-person check; say accurately when the exam rules turned it off.
    observation: liveness ? undefined : 'The camera readiness check was completed; the live-person check is disabled by the exam rules.',
    details: { checkId: a.check.id, livenessSteps: liveness?.steps.length ?? 0, liveness: liveness ? 'passed' : 'off', ...secondOpinionDetails(a.second) },
  });
  await m.addEvent({ type: 'reference_created', source: 'server_identity', details: { referenceId: refId, version: maxVersion + 1, embeddingCount: reference.gallery.length, framesAccepted: reference.accepted.length, baseline: reference.baseline } });
  m.set({ verifiedInstanceId: a.instanceId, checkAttemptsResetAt: new Date(m.now) });
  // A new reference: mid-exam samples are compared under the enrolment's own conditions.
  m.setIdentityState({ ...identityState(m.session), lastMatchAt: m.now, normalisation: 'continuous' });

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
      context: { precededBy: [], periodKind: 'check_in', secondsSincePreviousMatch: null, against: 'id_photo', ...(a.idPhotoSecond ? { secondOpinion: a.idPhotoSecond } : {}) },
    });
    await m.addEvent({
      type: 'id_photo_compared',
      source: 'server_identity',
      details: { decision: a.idPhoto.decision, similarity: a.idPhoto.similarity, policy: policy.identity.idPhotoComparison, identityCheckId: photoRow.id, ...secondOpinionDetails(a.idPhotoSecond) },
    });
    if (a.idPhoto.decision === 'mismatch') {
      const ev = await m.addEvent({
        type: 'identity_mismatch',
        source: 'server_identity',
        confidence: a.idPhoto.confidence,
        observation: 'The candidate at check-in may not be the person in the approved identity photo.',
        details: { against: 'id_photo', similarity: a.idPhoto.similarity, thresholds: { match: a.thresholds.idPhotoMatch, mismatch: a.thresholds.idPhotoMismatch }, identityCheckIds: [photoRow.id], ...secondOpinionDetails(a.idPhotoSecond) },
        context: { precededBy: [], periodKind: 'check_in', trigger: 'id_photo' },
      });
      await m.tx.update(identityChecks).set({ eventId: ev.id }).where(eq(identityChecks.id, photoRow.id));
      for (const img of images) await copyEvidence(a.ctx, m.tx, img, { kind: 'identity_probe', eventId: ev.id, identityCheckId: photoRow.id });
      if (cand.idPhotoEvidenceId) {
        // The exact photo compared, as this session's evidence (the candidate-level photo has no session).
        const [photo] = await m.tx.select().from(evidence).where(eq(evidence.id, cand.idPhotoEvidenceId));
        if (photo) await copyEvidence(a.ctx, m.tx, photo, { kind: 'id_photo', eventId: ev.id, sessionId: m.session.id });
      }
    }
    if (policy.identity.idPhotoComparison === 'required' && a.idPhoto.decision !== 'match') {
      // Inconclusive / unable to verify is NOT a mismatch: a distinct reason so staff and candidate are told the truth.
      const reason = a.idPhoto.decision === 'mismatch' ? 'id_photo_mismatch' : 'id_photo_unverifiable';
      await holdNow(m, { reason, details: { decision: a.idPhoto.decision, similarity: a.idPhoto.similarity, ...(a.idPhotoSecond ? { needsHumanReview: a.idPhotoSecond.needsHumanReview } : {}) } });
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
  const cameraChanged = !!before && cameraDiffers(before, now);
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
    evidence: aggregate
      ? {
          status: aggregate.assessment.status,
          llr: aggregate.assessment.llr,
          posterior: aggregate.assessment.posterior,
          usableFrames: aggregate.assessment.usable,
          pooledFrames: aggregate.pooledFrames,
          poorLight: aggregate.assessment.poorLight,
          qualityOnly: aggregate.qualityOnly,
          calibrationVersion: CALIBRATION.version,
        }
      : undefined,
    ...(a.second ? { secondOpinion: a.second } : {}),
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
      return retryOrHold(a, { message: IDENTITY_RETRY_MESSAGE, guidance: ref.reasons, identity: idRow, reason: 'reference_not_established', qualityOnly: ref.failure === 'too_few' });
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
      embeddingsEnc: a.ctx.keyring.encrypt(serializeEmbeddings(ref.gallery), referenceAad(refId)),
      embeddingCount: ref.gallery.length,
      baseline: ref.baseline,
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
    return continueAfterPass(a, idRow, { checkStart, pauseStart, gapStart, similarity: aggregate?.similarity ?? null, reEnrolled: true });
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
  return retryOrHold(a, { message: IDENTITY_RETRY_MESSAGE, guidance, identity: idRow, reason: agg.decision, qualityOnly: agg.qualityOnly });
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
      llrSum: agg.assessment.llr,
      posterior: agg.assessment.posterior,
      perFrame: agg.perFrame.map((f) => ({ similarity: f.similarity, bucket: f.bucket, llr: f.usable ? f.llr : null })),
      baseline: a.active?.ref.baseline ?? null,
      calibrationVersion: CALIBRATION.version,
      identityCheckIds: [idRow.id],
      referenceId: a.active?.ref.id ?? null,
      ...secondOpinionDetails(a.second),
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
  t: { checkStart: number; pauseStart: number | null; gapStart: number | null; similarity: number | null; flagged?: boolean; reEnrolled?: boolean },
): Promise<Outcome> {
  const { m, policy, check } = a;
  const purpose = check.purpose;
  const st = identityState(m.session);
  if (st.openUnverifiableEventId) await m.closeEvent(st.openUnverifiableEventId, m.now, { closedBy: 'identity_match' });
  // After a resume / reconnect / reverify the conditions may differ from the enrolment (another day, room or camera):
  // mid-exam samples use the 'relaxed' normalisation from now on — unless a new reference was just enrolled.
  m.setIdentityState({ ...identityState(m.session), openUnverifiableEventId: null, lastMatchAt: t.flagged ? st.lastMatchAt : m.now, normalisation: t.reEnrolled ? 'continuous' : 'relaxed' });
  const base: Outcome = {
    outcome: 'passed',
    message: purpose === 'resume' ? 'Identity confirmed. Welcome back — your exam continues.' : 'Identity confirmed. Your exam continues.',
    guidance: [],
    identity: idRow,
    idPhoto: null,
    attemptsRemaining: policy.identity.maxVerificationAttempts,
  };
  if (!t.flagged) await m.addEvent({ type: 'identity_verified', source: 'server_identity', confidence: idRow.confidence, details: { purpose, similarity: t.similarity, identityCheckId: idRow.id, ...secondOpinionDetails(a.second) } });
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

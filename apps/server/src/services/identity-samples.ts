/**
 * Mid-exam identity samples (POST /api/candidate/identity/sample), ARCHITECTURE §4.5 (identity v2).
 *
 *  - Idempotent on sampleId (a replay returns the stored result).
 *  - Bursts: the client takes `policy.identity.burstSize` frames within ~0.6 s and sends them as separate requests
 *    sharing burstId (burstIndex 0..size-1, any order). Each frame is analysed on arrival and answered per frame;
 *    when all frames arrived (or BURST_TIMEOUT_MS after the first one — the next sample or the sweeper decides it
 *    on the frames received) the burst is decided as ONE sample: identity_checks row, mean embedding of its usable
 *    frames against the protected reference (identity-gallery.ts aggregateBurst). A request without burstId (or
 *    burstSize 1) is a one-frame sample.
 *  - Every decided sample feeds the session's evidence accumulator (identity-evidence.ts: session-normalised,
 *    clamped LLRs from vision/calibration.ts, SPRT thresholds). 'suspect' => a faster sample is requested
 *    (nextSampleInMs ~2.5 s, trigger server_request); 'confirmed_mismatch' => identity_mismatch (integrity, high)
 *    with per-sample evidence, confidence = posterior, then hold_for_review / flag_only per policy. The flagged event
 *    stays open while evidence continues and closes after two clear genuine samples.
 *  - Samples without a usable face image never count as a different person: 3 in a row => identity_unverifiable
 *    (uncertain) with guidance, closed by the next clear result.
 *  - Server-side feed check: >= 3 consecutive samples with an identical dHash => camera_feed_suspect.
 *  - Cadence: every response carries nextSampleInMs (start-up interval right after (re)start, periodic otherwise,
 *    faster while monitoring / suspect). HeartbeatResponse / CandidateSessionState carry `identitySample` requests
 *    (exam_start after a (re)start until a sample arrives; server_request while suspect and the client is late).
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_POLICY, type HoldDTO, type IdentityCheckTrigger, type IdentityDecision, type IdentityEvidenceDTO, type IdentityResultDTO, type IdentitySampleResponse, type ProctoringPolicy, type SessionStatus } from '@sp/shared';
import { and, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { events, evidence, examSessions, identityChecks, identitySampleFrames, type ExamSession, type IdentityCheck, type IdentityCheckContext, type IdentityEngineState, type IdentitySampleFrame, type PendingBurst } from '../db/schema.js';
import { invalidState } from '../lib/errors.js';
import { advisoryGuidance, CALIBRATION, decideIdentity, deserializeEmbeddings, hammingHex, INCONCLUSIVE_GUIDANCE, posteriorSwap, serializeEmbeddings, type ImageAnalysis } from '../vision/index.js';
import { assertInControl } from './candidate-state.js';
import { toHoldDTO } from './dto.js';
import { purgeEvidenceRows, readEvidence, storeEvidence } from './evidence.js';
import { analysisFromSummary, copyEvidence, loadActiveReference, precedingContext, sampleFrameAad, summarizeAnalysis, toIdentityResultDTO, type ActiveReference } from './identity-common.js';
import {
  accumulate,
  CLEAR_MATCH_LLR,
  frameEvidence,
  nextSampleDelayMs,
  sampleLabel,
  POOR_LIGHT_GUIDANCE,
  poorLightSuspect,
  toEvidenceDTO,
  usableBaseline,
  windowSum,
  type ComparisonContext,
  type SessionBaseline,
  type EvidenceEntry,
  type FrameEvidence,
} from './identity-evidence.js';
import { aggregateBurst, scoreReference } from './identity-gallery.js';
import { IDENTITY_SAMPLE_SHARE, sessionHasEvidenceCapacity } from './session-limits.js';
import { holdNow, identityState, withSession, type SessionMutation, type SessionPreload } from './session-state.js';
import { secondOpinion, secondOpinionApplies, secondOpinionDetails, type SecondOpinionRecord } from './identity-external.js';
import { loadOrg, mergePolicy, orgThresholds } from './org.js';
import { fusionPolicyFor } from '../verifiers/index.js';
import { internalStrength, type InternalOpinion } from '../verifiers/fusion.js';

/** A sample captured this long before it arrived is recorded only (it is not live evidence of who is there now). */
export const LATE_SAMPLE_MS = 2 * 60_000;
/** Client clocks are server-corrected; captures up to this long before the period began still belong to it. */
const PERIOD_CLOCK_TOLERANCE_MS = 5_000;

/** Record-only: captured before the current active period began, or far older than its receipt (LATE_SAMPLE_MS). */
export function lateSample(capturedAt: number, receivedAt: number, periodStart: number | null): boolean {
  if (periodStart != null && capturedAt < periodStart - PERIOD_CLOCK_TOLERANCE_MS) return true;
  return receivedAt - capturedAt > LATE_SAMPLE_MS;
}

/** An incomplete burst is decided on the frames received this long after its first frame. */
export const BURST_TIMEOUT_MS = 3_000;
export const UNVERIFIABLE_AFTER = 3;
export const IDENTICAL_SAMPLES_SUSPECT = 3;
const MAX_EVIDENCE_PER_MISMATCH_EVENT = 12;
const MAX_PER_SAMPLE_DETAILS = 50;
/** Frame embeddings of bursts that were never decided (dropped at a pause / hold) are erased after this long. */
const ORPHAN_FRAME_MS = 30_000;

export interface SampleInput {
  sampleId: string;
  trigger: IdentityCheckTrigger;
  capturedAt: number;
  burstId?: string;
  burstIndex?: number;
  burstSize?: number;
}

/**
 * The engine's answer to a sample (and what is stored for idempotent replays): the decision and the session's
 * evidence. Staff-side only — the candidate gets `candidateSampleResponse(answer)`.
 */
interface SampleAnswer {
  result: IdentityResultDTO;
  followUpInMs: number | null;
  status: SessionStatus;
  hold: HoldDTO | null;
  burst?: IdentitySampleResponse['burst'];
  nextSampleInMs?: number | null;
  evidence?: IdentityEvidenceDTO;
}

/**
 * What the candidate is told about a sample: a receipt (was the image usable, guidance about the image) and the
 * cadence — never the decision, the similarity or the evidence state (a live verdict would let a candidate probe the
 * comparison or react to it).
 */
export function candidateSampleResponse(a: SampleAnswer): IdentitySampleResponse {
  const r = a.result;
  const usable = r.decision !== 'unable_to_verify';
  // Unusable image: its quality guidance. Usable: only the lighting guidance a poor-light suspicion adds (never the
  // "could not confirm" wording of an inconclusive comparison).
  const guidance = !usable ? r.guidance : r.guidance.includes(POOR_LIGHT_GUIDANCE) ? r.guidance.filter((g) => g !== INCONCLUSIVE_GUIDANCE) : [];
  return {
    result: { id: r.id, trigger: r.trigger, at: r.at, usable, guidance },
    followUpInMs: a.followUpInMs,
    status: a.status,
    hold: a.hold,
    ...(a.burst ? { burst: a.burst } : {}),
    nextSampleInMs: a.nextSampleInMs ?? null,
  };
}

interface StoredResponse {
  followUpInMs: number | null;
  nextSampleInMs?: number | null;
  burst?: IdentitySampleResponse['burst'];
  evidence?: IdentityEvidenceDTO;
  result?: IdentityResultDTO;
}

function safeHamming(a: string | null, b: string | null): number {
  if (!a || !b) return 64;
  try {
    return hammingHex(a, b);
  } catch {
    return 64;
  }
}

/** Per-session normalisation context of a mid-exam sample (identity-evidence.ts). */
function comparisonContext(trigger: IdentityCheckTrigger, st: Pick<IdentityEngineState, 'normalisation'>): ComparisonContext {
  // After a resume / reconnect / reverify the room, light or camera may differ from enrolment: never the tighter
  // same-session normalisation there (docs/accuracy/identity-v2.md §9).
  return trigger === 'camera_reconnect' || st.normalisation === 'relaxed' ? 'relaxed' : 'continuous';
}

/* =================================================================== entry point */

async function replayCheck(ctx: Ctx, sessionId: string, row: IdentityCheck): Promise<SampleAnswer> {
  const [s] = await ctx.db.select().from(examSessions).where(eq(examSessions.id, sessionId));
  const stored = (row.response ?? {}) as unknown as StoredResponse;
  return {
    result: toIdentityResultDTO(row),
    followUpInMs: stored.followUpInMs ?? null,
    status: s.status,
    hold: toHoldDTO(s),
    ...(stored.burst ? { burst: stored.burst } : {}),
    nextSampleInMs: stored.nextSampleInMs ?? null,
    ...(stored.evidence ? { evidence: stored.evidence } : {}),
  };
}

async function replayFrame(ctx: Ctx, sessionId: string, frame: IdentitySampleFrame): Promise<SampleAnswer> {
  const [s] = await ctx.db.select().from(examSessions).where(eq(examSessions.id, sessionId));
  const stored = (frame.response ?? {}) as unknown as StoredResponse;
  return {
    result: stored.result ?? frameResultDTO(frame),
    followUpInMs: null,
    status: s.status,
    hold: toHoldDTO(s),
    ...(stored.burst ? { burst: stored.burst } : {}),
    nextSampleInMs: stored.nextSampleInMs ?? null,
    ...(stored.evidence ? { evidence: stored.evidence } : {}),
  };
}

function frameResultDTO(f: Pick<IdentitySampleFrame, 'id' | 'trigger' | 'decision' | 'similarity' | 'analysis' | 'capturedAt'>, confidence = 1, guidance: string[] = []): IdentityResultDTO {
  return { id: f.id, trigger: f.trigger, decision: f.decision, similarity: f.similarity ?? null, confidence, quality: f.analysis.quality, guidance, at: f.capturedAt.getTime() };
}

async function findExisting(db: Ctx['db'] | SessionMutation['tx'], sessionId: string, sampleId: string): Promise<{ check?: IdentityCheck; frame?: IdentitySampleFrame }> {
  const [check] = await db
    .select()
    .from(identityChecks)
    .where(and(eq(identityChecks.sessionId, sessionId), eq(identityChecks.sampleId, sampleId)));
  if (check) return { check };
  const [frame] = await db
    .select()
    .from(identitySampleFrames)
    .where(and(eq(identitySampleFrames.sessionId, sessionId), eq(identitySampleFrames.sampleId, sampleId)));
  return frame ? { frame } : {};
}

export async function processIdentitySample(ctx: Ctx, session: ExamSession, instanceId: string, q: SampleInput, jpeg: Buffer, preload?: SessionPreload): Promise<IdentitySampleResponse> {
  return candidateSampleResponse(await processSample(ctx, session, instanceId, q, jpeg, preload));
}

async function processSample(ctx: Ctx, session: ExamSession, instanceId: string, q: SampleInput, jpeg: Buffer, preload?: SessionPreload): Promise<SampleAnswer> {
  const existing = await findExisting(ctx.db, session.id, q.sampleId);
  if (existing.check) return replayCheck(ctx, session.id, existing.check);
  if (existing.frame) return replayFrame(ctx, session.id, existing.frame);

  assertInControl(session, instanceId);
  if (!['active', 'paused', 'on_hold'].includes(session.status)) throw invalidState('Identity samples are only accepted during the exam');

  const active = await loadActiveReference(ctx, ctx.db, session.id);
  if (!active) throw invalidState('No identity reference exists for this exam');
  // Samples the server is waiting for are analysed with interactive priority; routine samples may wait a few seconds
  // while check-in frames keep a candidate waiting. Decided from the server's own state, not the client's trigger
  // label (a client could otherwise label every sample urgent).
  const analysis: ImageAnalysis = await ctx.vision.analyze(jpeg, { embed: true, faceCrop: true, priority: sampleUrgent(identityState(session), sessionPolicy(session), ctx.now()) ? 'interactive' : 'background' });
  const isBurst = q.burstId != null && (q.burstSize ?? 1) > 1;
  const secondOpinionRequests: string[] = [];

  const out = await withSession(
    ctx,
    session.id,
    async (m): Promise<SampleAnswer | { replay: IdentityCheck | IdentitySampleFrame; kind: 'check' | 'frame' }> => {
      const dup = await findExisting(m.tx, session.id, q.sampleId);
      if (dup.check) return { replay: dup.check, kind: 'check' };
      if (dup.frame) return { replay: dup.frame, kind: 'frame' };
      assertInControl(m.session, instanceId);

      const now = m.now;
      const at = Math.min(Number.isFinite(q.capturedAt) ? q.capturedAt : now, now + 5_000);
      const s = m.session;
      const open = await m.openPeriodRow();
      // Late delivery: a sample captured before the current pause/hold is recorded, but drives no actions.
      let recordOnly = false;
      if (s.status !== 'active') {
        if (open && !open.observed && at < open.startedAt.getTime()) recordOnly = true;
        else throw invalidState('The exam is not active');
      } else if (lateSample(at, now, identityState(s).activeSince ?? (open?.kind === 'active' ? open.startedAt.getTime() : null))) {
        // Captured before the current active period began (it belongs to the period before a pause / hold / resume),
        // or long before it arrived (an outbox delivering a backlog): recorded, but it is not live evidence.
        recordOnly = true;
      }
      const env = await sampleEnv(m, active, jpeg.length, secondOpinionRequests);

      // Bursts whose remaining frames never came are decided on what arrived (which may put the exam on hold).
      await decideStaleBursts(m, env, isBurst ? q.burstId! : null);
      await eraseOrphanFrameEmbeddings(m);
      if (!recordOnly && m.session.status !== 'active') recordOnly = true;

      const sim = analysis.embedding ? scoreReference(analysis.embedding, active.embeddings) : null;
      const fe = frameEvidence(analysis.quality, sim, env.baseline, comparisonContext(q.trigger, identityState(m.session)));

      if (!isBurst) {
        return decideSample(m, env, {
          sampleId: q.sampleId,
          trigger: q.trigger,
          at,
          recordOnly,
          frames: [{ analysis, embedding: analysis.embedding, jpeg, evidence: fe, frameRow: null }],
          burst: null,
        });
      }

      // ---- burst frame
      const burstId = q.burstId!;
      const size = Math.max(1, Math.min(5, q.burstSize ?? 1));
      const index = Math.max(0, Math.min(size - 1, q.burstIndex ?? 0));
      const st = identityState(m.session);
      let pending = st.pendingBursts.find((b) => b.id === burstId) ?? null;
      const late = !pending && (recordOnly || (await burstSeen(m, burstId)));
      const label = sampleLabel(sim, analysis.quality, env.thresholds, fe.usable ? fe.llr : null);
      const cmp = decideIdentity(sim, analysis.quality, env.thresholds, 'reference', fe.usable ? { llr: fe.llr } : undefined);
      const keepImages = !late && wantImages(env, label, fe, st);
      const images = keepImages ? await storeSampleImages(m, env, { at, instanceId, jpeg, crop: analysis.faceCropJpeg, identityCheckId: null }) : { probeId: null, frameId: null };
      const frameId = randomUUID();
      const [frame] = await m.tx
        .insert(identitySampleFrames)
        .values({
          id: frameId,
          sessionId: s.id,
          sampleId: q.sampleId,
          burstId,
          burstIndex: index,
          burstSize: size,
          trigger: q.trigger,
          capturedAt: new Date(at),
          receivedAt: new Date(now),
          analysis: summarizeAnalysis(analysis),
          similarity: sim,
          decision: label,
          llr: fe.usable ? fe.llr : null,
          embeddingEnc: !late && analysis.embedding ? ctx.keyring.encrypt(serializeEmbeddings([analysis.embedding]), sampleFrameAad(frameId)) : null,
          probeEvidenceId: images.probeId,
          frameEvidenceId: images.frameId,
          clientInstanceId: instanceId,
        })
        .returning();
      const perFrame: IdentityResultDTO = frameResultDTO(frame, cmp.confidence, cmp.guidance);

      if (late) {
        // A frame of a burst that was already decided (or belongs to a period that ended): recorded, no effect.
        const response: StoredResponse = { followUpInMs: null, nextSampleInMs: null, burst: { id: burstId, received: 1, size, complete: true }, evidence: toEvidenceDTO(st.evidence), result: perFrame };
        await m.tx.update(identitySampleFrames).set({ response: response as unknown as Record<string, unknown> }).where(eq(identitySampleFrames.id, frameId));
        return { result: perFrame, followUpInMs: null, status: m.session.status, hold: toHoldDTO(m.session), burst: response.burst, nextSampleInMs: null, evidence: response.evidence };
      }

      if (!pending) {
        pending = { id: burstId, size, trigger: q.trigger, firstReceivedAt: now, indexes: [] };
        st.pendingBursts = [...st.pendingBursts, pending];
      }
      if (!pending.indexes.includes(index)) pending.indexes = [...pending.indexes, index].sort((a, b) => a - b);
      st.pendingBursts = st.pendingBursts.map((b) => (b.id === burstId ? pending! : b));
      m.setIdentityState(st);

      if (pending.indexes.length >= pending.size) {
        return decideBurst(m, env, pending, { completingSampleId: q.sampleId, recordOnly });
      }
      const response: StoredResponse = { followUpInMs: null, nextSampleInMs: null, burst: { id: burstId, received: pending.indexes.length, size: pending.size, complete: false }, evidence: toEvidenceDTO(st.evidence), result: perFrame };
      await m.tx.update(identitySampleFrames).set({ response: response as unknown as Record<string, unknown> }).where(eq(identitySampleFrames.id, frameId));
      return { result: perFrame, followUpInMs: null, status: m.session.status, hold: toHoldDTO(m.session), burst: response.burst, nextSampleInMs: null, evidence: response.evidence };
    },
    preload,
  );
  if ('replay' in out) return out.kind === 'check' ? replayCheck(ctx, session.id, out.replay as IdentityCheck) : replayFrame(ctx, session.id, out.replay as IdentitySampleFrame);
  if (!secondOpinionRequests.length) return out;
  // A suspected swap waited for the organisation's external second opinion: ask it now (outside the lock), apply the
  // fused result, and answer with the session as it is afterwards (possibly on hold).
  for (const checkId of secondOpinionRequests) {
    try {
      await resolveSwapSecondOpinion(ctx, session.id, checkId);
    } catch (err) {
      // The pending request is retried by the next confirming sample after secondOpinionPendingMs().
      ctx.log.error({ err, sessionId: session.id, checkId }, 'applying the external second opinion failed');
    }
  }
  const [after] = await ctx.db.select().from(examSessions).where(eq(examSessions.id, session.id));
  const running = after.status === 'active';
  return {
    ...out,
    status: after.status,
    hold: toHoldDTO(after),
    evidence: toEvidenceDTO(identityState(after).evidence),
    nextSampleInMs: running ? (out.nextSampleInMs ?? null) : null,
    followUpInMs: running ? out.followUpInMs : null,
  };
}

/**
 * Whether the server is waiting for this sample (vision priority 'interactive'): it asked for one (exam start, a
 * faster look, the watchdog), a follow-up after a non-match is due, the evidence is building up (monitoring /
 * suspect / a flagged mismatch), or the period is in its start-up window (a swap is most likely right after a start).
 */
export function sampleUrgent(
  st: Pick<IdentityEngineState, 'sampleRequest' | 'followUpRequestedAt' | 'evidence' | 'activeSince' | 'openMismatchEventId'>,
  policy: Pick<ProctoringPolicy['identity'], 'startupWindowSec'>,
  now: number,
): boolean {
  if (st.sampleRequest || st.followUpRequestedAt != null || st.openMismatchEventId) return true;
  if (st.evidence?.state && st.evidence.state !== 'consistent') return true;
  return st.activeSince != null && now - st.activeSince < policy.startupWindowSec * 1000;
}

/** The session's policy snapshot (taken at exam start; samples are only accepted after it). */
function sessionPolicy(s: Pick<ExamSession, 'policy'>): ProctoringPolicy['identity'] {
  return (s.policy ? mergePolicy(undefined, s.policy as Record<string, unknown>) : DEFAULT_POLICY).identity;
}

/* =================================================================== deciding samples */

interface SampleEnv {
  ctx: Ctx;
  active: ActiveReference;
  baseline: ActiveReference['ref']['baseline'];
  policy: ProctoringPolicy;
  thresholds: Awaited<ReturnType<SessionMutation['thresholds']>>;
  jpegBytes: number;
  /**
   * Identity checks whose suspected swap waits for the external second opinion: the caller resolves them after the
   * transaction (resolveSwapSecondOpinion — a network call must not run under the session lock).
   */
  secondOpinionRequests: string[];
}

async function sampleEnv(m: SessionMutation, active: ActiveReference, jpegBytes: number, secondOpinionRequests: string[] = []): Promise<SampleEnv> {
  return { ctx: m.ctx, active, baseline: sampleBaseline(active, identityState(m.session)), policy: await m.policy(), thresholds: await m.thresholds(), jpegBytes, secondOpinionRequests };
}

/**
 * The baseline mid-exam samples are normalised against: the current period's own (measured at the resume / reconnect
 * / reverify check that began it, identity-evidence.ts periodBaseline) while the normalisation is 'continuous', else
 * the enrolment baseline.
 */
export function sampleBaseline(active: ActiveReference, st: Pick<IdentityEngineState, 'normalisation' | 'periodBaseline'>): SessionBaseline | null {
  const pb = st.periodBaseline;
  return st.normalisation === 'continuous' && pb && usableBaseline(pb) ? pb : (active.ref.baseline ?? null);
}

function wantImages(env: SampleEnv, label: IdentityDecision, fe: FrameEvidence, st: IdentityEngineState): boolean {
  if (env.policy.evidence.keepMatchingIdentitySamples) return true;
  // Images are kept for samples that did not cleanly match, and for every sample while evidence is building up.
  return label !== 'match' || !fe.usable || fe.llr > CLEAR_MATCH_LLR || st.evidence.state !== 'consistent' || st.openMismatchEventId != null;
}

async function storeSampleImages(
  m: SessionMutation,
  env: SampleEnv,
  o: { at: number; instanceId: string | null; jpeg: Buffer | null; crop: Buffer | null; identityCheckId: string | null },
): Promise<{ probeId: string | null; frameId: string | null; skipped?: boolean }> {
  const s = m.session;
  // Over the samples' share of the per-session storage budget the sample is still compared and decided; only its
  // images are not kept. The rest of the budget stays free for check frames (session-limits.ts).
  const bytes = (o.jpeg?.length ?? 0) + (o.crop?.length ?? 0);
  if (!(await sessionHasEvidenceCapacity(env.ctx, m.tx, s.id, { items: 2, bytes }, IDENTITY_SAMPLE_SHARE))) return { probeId: null, frameId: null, skipped: true };
  const base = { orgId: s.orgId, sessionId: s.id, candidateId: s.candidateId, kind: 'identity_probe' as const, capturedAt: o.at, identityCheckId: o.identityCheckId, clientInstanceId: o.instanceId };
  const probeId = o.crop ? (await storeEvidence(env.ctx, m.tx, { ...base, reason: 'face_crop', data: o.crop })).row.id : null;
  const frameId = o.jpeg ? (await storeEvidence(env.ctx, m.tx, { ...base, reason: 'frame', data: o.jpeg })).row.id : null;
  return { probeId, frameId };
}

async function burstSeen(m: SessionMutation, burstId: string): Promise<boolean> {
  const [row] = await m.tx
    .select({ id: identitySampleFrames.id })
    .from(identitySampleFrames)
    .where(and(eq(identitySampleFrames.sessionId, m.session.id), eq(identitySampleFrames.burstId, burstId)))
    .limit(1);
  return !!row;
}

interface SampleFrameInput {
  analysis: ImageAnalysis;
  embedding: Float32Array | null;
  /** Single-frame samples: the uploaded image (stored only if wanted). Burst frames were stored on arrival. */
  jpeg?: Buffer | null;
  evidence: FrameEvidence;
  frameRow: IdentitySampleFrame | null;
}

interface DecideInput {
  sampleId: string;
  trigger: IdentityCheckTrigger;
  at: number;
  recordOnly: boolean;
  frames: SampleFrameInput[];
  burst: { id: string; size: number; received: number } | null;
}

async function decideBurst(m: SessionMutation, env: SampleEnv, pending: PendingBurst, o: { completingSampleId: string | null; recordOnly: boolean }): Promise<SampleAnswer> {
  const rows = await m.tx
    .select()
    .from(identitySampleFrames)
    .where(and(eq(identitySampleFrames.sessionId, m.session.id), eq(identitySampleFrames.burstId, pending.id), isNull(identitySampleFrames.identityCheckId)))
    .orderBy(identitySampleFrames.burstIndex, identitySampleFrames.receivedAt);
  const frames: SampleFrameInput[] = rows.map((r) => {
    let embedding: Float32Array | null = null;
    if (r.embeddingEnc) {
      try {
        embedding = deserializeEmbeddings(env.ctx.keyring.decrypt(r.embeddingEnc, sampleFrameAad(r.id)))[0] ?? null;
      } catch {
        embedding = null;
      }
    }
    const analysis = analysisFromSummary(r.analysis, embedding);
    const sim = embedding ? scoreReference(embedding, env.active.embeddings) : null;
    return { analysis, embedding, evidence: frameEvidence(r.analysis.quality, sim, env.baseline, comparisonContext(r.trigger, identityState(m.session))), frameRow: r };
  });
  const st = identityState(m.session);
  st.pendingBursts = st.pendingBursts.filter((b) => b.id !== pending.id);
  m.setIdentityState(st);
  const at = frames.length ? Math.round(median(frames.map((f) => f.frameRow!.capturedAt.getTime()))) : m.now;
  return decideSample(m, env, {
    sampleId: o.completingSampleId ?? `burst:${pending.id}`,
    trigger: pending.trigger,
    at,
    recordOnly: o.recordOnly,
    frames,
    burst: { id: pending.id, size: pending.size, received: pending.indexes.length },
  });
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}

/** Decide bursts whose first frame arrived more than BURST_TIMEOUT_MS ago (per-frame fallback on what arrived). */
async function decideStaleBursts(m: SessionMutation, env: SampleEnv, exceptBurstId: string | null): Promise<void> {
  const st = identityState(m.session);
  const stale = st.pendingBursts.filter((b) => b.id !== exceptBurstId && m.now - b.firstReceivedAt >= BURST_TIMEOUT_MS);
  for (const b of stale) {
    if (m.session.status !== 'active') break;
    await decideBurst(m, env, b, { completingSampleId: null, recordOnly: false });
  }
}

async function eraseOrphanFrameEmbeddings(m: SessionMutation): Promise<void> {
  const pendingIds = identityState(m.session).pendingBursts.map((b) => b.id);
  await m.tx
    .update(identitySampleFrames)
    .set({ embeddingEnc: null })
    .where(
      and(
        eq(identitySampleFrames.sessionId, m.session.id),
        isNull(identitySampleFrames.identityCheckId),
        isNotNull(identitySampleFrames.embeddingEnc),
        lt(identitySampleFrames.receivedAt, new Date(m.now - ORPHAN_FRAME_MS)),
        pendingIds.length ? sql`${identitySampleFrames.burstId} not in (${sql.join(pendingIds.map((id) => sql`${id}`), sql`, `)})` : sql`true`,
      ),
    );
}

async function decideSample(m: SessionMutation, env: SampleEnv, d: DecideInput): Promise<SampleAnswer> {
  const { ctx } = env;
  const s = m.session;
  const now = m.now;
  const st0 = identityState(s);
  const context = comparisonContext(d.trigger, st0);

  // ---- the sample's evidence (one burst = one sample)
  let fe: FrameEvidence;
  let rep = 0;
  let burstInfo: Record<string, unknown> | null = null;
  if (d.frames.length === 0) {
    fe = { usable: false, similarity: null, bucket: null, llr: 0 };
  } else if (d.frames.length === 1) {
    fe = d.frames[0].evidence;
  } else {
    const agg = aggregateBurst(
      d.frames.map((f) => ({ embedding: f.embedding, quality: f.analysis.quality })),
      env.active.embeddings,
      env.baseline,
      context,
      env.thresholds,
    );
    fe = agg.evidence;
    rep = agg.representative;
    burstInfo = {
      consistent: agg.consistent,
      scoring: agg.scoring,
      spread: agg.spread,
      usableFrames: agg.usable,
      frameSimilarities: agg.perFrame.map((p) => p.similarity),
      frameLlrs: agg.perFrame.map((p) => (p.usable ? p.llr : null)),
    };
  }
  const repFrame = d.frames[rep];
  const quality = fe.usable ? repFrame.analysis.quality : (repFrame?.analysis.quality ?? null);
  const label = sampleLabel(fe.similarity, quality, env.thresholds, fe.usable ? fe.llr : null);
  const cmp = decideIdentity(fe.similarity, quality, env.thresholds, 'reference', fe.usable ? { llr: fe.llr } : undefined);

  const pre = await precedingContext(m.tx, s.id, d.at, d.trigger);
  const ctxInfo: IdentityCheckContext = {
    precededBy: pre.precededBy,
    periodKind: (await m.openPeriodRow())?.kind ?? null,
    secondsSincePreviousMatch: st0.lastMatchAt ? Math.round((d.at - st0.lastMatchAt) / 1000) : null,
    recentEvents: pre.recentEvents,
    recordOnly: d.recordOnly,
  };
  if (d.burst) ctxInfo.burst = { id: d.burst.id, size: d.burst.size, received: d.burst.received, ...burstInfo };

  // ---- images: single frames are stored now if wanted; burst frames were stored on arrival
  let probeId: string | null = null;
  let frameImageId: string | null = null;
  const checkId = randomUUID();
  if (!d.burst) {
    const f = d.frames[0];
    if (wantImages(env, label, fe, st0)) {
      const imgs = await storeSampleImages(m, env, { at: d.at, instanceId: m.session.activeInstanceId, jpeg: f.jpeg ?? null, crop: f.analysis.faceCropJpeg, identityCheckId: checkId });
      if (imgs.skipped) ctxInfo.evidenceSkipped = 'storage_limit';
      probeId = imgs.probeId;
      frameImageId = imgs.frameId;
    }
  } else {
    const withImages = d.frames.filter((f) => f.frameRow?.probeEvidenceId || f.frameRow?.frameEvidenceId);
    const r = repFrame?.frameRow?.probeEvidenceId || repFrame?.frameRow?.frameEvidenceId ? repFrame.frameRow : (withImages[0]?.frameRow ?? null);
    probeId = r?.probeEvidenceId ?? null;
    frameImageId = r?.frameEvidenceId ?? null;
  }
  // A decided burst keeps the images of its representative frame only; the other frames' images (stored on arrival,
  // before the burst could be judged) are purged after commit, so bursts do not use up the session's storage budget.
  const burstKeptImages = new Set([probeId, frameImageId].filter((x): x is string => !!x));
  const burstExtraImages = d.burst ? d.frames.flatMap((f) => [f.frameRow!.probeEvidenceId, f.frameRow!.frameEvidenceId]).filter((x): x is string => !!x && !burstKeptImages.has(x)) : [];

  const [row] = await m.tx
    .insert(identityChecks)
    .values({
      id: checkId,
      sessionId: s.id,
      sampleId: d.sampleId,
      trigger: d.trigger,
      decision: label,
      similarity: fe.similarity,
      confidence: cmp.confidence,
      quality,
      guidance: cmp.guidance,
      at: new Date(d.at),
      receivedAt: new Date(now),
      probeEvidenceId: probeId ?? frameImageId,
      frameEvidenceId: frameImageId,
      referenceId: env.active.ref.id,
      dhash: repFrame?.analysis.dhash ?? null,
      clientInstanceId: m.session.activeInstanceId,
      context: ctxInfo,
    })
    .returning();
  m.publishIdentityCheck(row.id);
  if (d.burst) {
    const ids = d.frames.map((f) => f.frameRow!.id);
    await m.tx.update(identitySampleFrames).set({ identityCheckId: row.id, embeddingEnc: null }).where(inArray(identitySampleFrames.id, ids));
    if (burstKeptImages.size) await m.tx.update(evidence).set({ identityCheckId: row.id }).where(inArray(evidence.id, [...burstKeptImages]));
    if (burstExtraImages.length) {
      const extra = new Set(burstExtraImages);
      for (const f of d.frames) {
        const r = f.frameRow!;
        if ((r.probeEvidenceId && extra.has(r.probeEvidenceId)) || (r.frameEvidenceId && extra.has(r.frameEvidenceId))) {
          await m.tx
            .update(identitySampleFrames)
            .set({ probeEvidenceId: r.probeEvidenceId && extra.has(r.probeEvidenceId) ? null : r.probeEvidenceId, frameEvidenceId: r.frameEvidenceId && extra.has(r.frameEvidenceId) ? null : r.frameEvidenceId })
            .where(eq(identitySampleFrames.id, r.id));
        }
      }
      m.onCommit(async () => {
        const rows = await ctx.db.select().from(evidence).where(inArray(evidence.id, burstExtraImages));
        await purgeEvidenceRows(ctx, ctx.db, rows, 'identity_burst_frame');
      });
    }
  }

  let followUpInMs: number | null = null;
  let nextSampleInMs: number | null = null;
  let evidenceDTO: IdentityEvidenceDTO = toEvidenceDTO(st0.evidence);
  if (!d.recordOnly) {
    m.set({ lastIdentityDecision: label, lastIdentityAt: new Date(d.at), lastIdentitySimilarity: fe.similarity });
    const r = await applyEvidence(m, env, row, fe, repFrame?.analysis.dhash ?? null);
    followUpInMs = r.followUpInMs;
    nextSampleInMs = r.nextSampleInMs;
    evidenceDTO = r.evidence;
    if (r.poorLight) {
      // Suspicion from poor light only: ask the candidate for more light (the next, faster sample may then decide).
      const guidance = [...new Set([...(quality ? advisoryGuidance(quality) : []), POOR_LIGHT_GUIDANCE, ...row.guidance])];
      await m.tx.update(identityChecks).set({ guidance }).where(eq(identityChecks.id, row.id));
      row.guidance = guidance;
    }
  }
  const evidenceCtx: IdentityCheckContext = { ...ctxInfo, evidence: { llr: fe.usable ? fe.llr : null, bucket: fe.bucket, ...evidenceDTO, calibrationVersion: CALIBRATION.version } };
  // A burst that cleanly matched while nothing was building up: its speculatively stored frame images are not kept.
  const st1 = identityState(m.session);
  const cleanMatch = label === 'match' && fe.usable && fe.llr <= CLEAR_MATCH_LLR && st1.evidence.state === 'consistent' && !st1.openMismatchEventId && !env.policy.evidence.keepMatchingIdentitySamples;
  let finalRow = row;
  if (d.burst && cleanMatch) {
    const imageIds = [...burstKeptImages];
    if (imageIds.length) {
      await m.tx.update(identityChecks).set({ probeEvidenceId: null, frameEvidenceId: null }).where(eq(identityChecks.id, row.id));
      finalRow = { ...finalRow, probeEvidenceId: null, frameEvidenceId: null };
      m.onCommit(async () => {
        const rows = await ctx.db.select().from(evidence).where(inArray(evidence.id, imageIds));
        await purgeEvidenceRows(ctx, ctx.db, rows, 'identity_sample_matched');
      });
    }
  }
  const burst = d.burst ? { id: d.burst.id, received: d.burst.received, size: d.burst.size, complete: true } : undefined;
  const response: StoredResponse = { followUpInMs, nextSampleInMs, evidence: evidenceDTO, ...(burst ? { burst } : {}) };
  await m.tx.update(identityChecks).set({ response: response as unknown as Record<string, unknown>, context: evidenceCtx }).where(eq(identityChecks.id, row.id));
  if (d.burst && d.frames.length) {
    const last = d.frames.find((f) => f.frameRow?.sampleId === d.sampleId)?.frameRow;
    if (last) await m.tx.update(identitySampleFrames).set({ response: { ...response, result: toIdentityResultDTO(finalRow) } as unknown as Record<string, unknown> }).where(eq(identitySampleFrames.id, last.id));
  }
  return {
    result: toIdentityResultDTO(finalRow),
    followUpInMs,
    status: m.session.status,
    hold: toHoldDTO(m.session),
    ...(burst ? { burst } : {}),
    nextSampleInMs,
    evidence: evidenceDTO,
  };
}

/* =================================================================== evidence -> events */

async function applyEvidence(
  m: SessionMutation,
  env: SampleEnv,
  row: IdentityCheck,
  fe: FrameEvidence,
  dhash: string | null,
): Promise<{ followUpInMs: number | null; nextSampleInMs: number | null; evidence: IdentityEvidenceDTO; poorLight?: boolean }> {
  const st = identityState(m.session);
  const at = row.at.getTime();

  // A sample received after the server asked for one satisfies the request (whatever its trigger).
  if (st.sampleRequest && row.receivedAt.getTime() >= st.sampleRequest.since) st.sampleRequest = null;

  // ---- server-side feed integrity: identical frames across samples taken seconds apart
  const identical = safeHamming(st.lastSampleDhash, dhash) === 0;
  st.identicalDhashStreak = identical ? Math.max(2, st.identicalDhashStreak + 1) : 1;
  st.lastSampleDhash = dhash;
  if (st.identicalDhashStreak >= IDENTICAL_SAMPLES_SUSPECT && !st.openFeedSuspectEventId) {
    const ev = await m.addEvent({
      type: 'camera_feed_suspect',
      source: 'server_identity',
      open: true,
      startedAt: at,
      confidence: 0.9,
      observation: 'Several identity images taken seconds apart were pixel-identical, which a live camera does not normally produce.',
      details: { signal: 'identical_identity_samples', samples: st.identicalDhashStreak, dhash },
      context: { trigger: row.trigger },
    });
    st.openFeedSuspectEventId = ev.id;
    if (row.frameEvidenceId) await m.tx.update(evidence).set({ eventId: ev.id }).where(eq(evidence.id, row.frameEvidenceId));
  } else if (st.openFeedSuspectEventId && st.identicalDhashStreak >= IDENTICAL_SAMPLES_SUSPECT) {
    const [cur] = await m.tx.select({ details: events.details }).from(events).where(eq(events.id, st.openFeedSuspectEventId));
    await m.updateEvent(st.openFeedSuspectEventId, { details: { ...(cur?.details ?? {}), samples: st.identicalDhashStreak } });
  } else if (st.openFeedSuspectEventId && !identical) {
    await m.closeEvent(st.openFeedSuspectEventId, at, { closedBy: 'frames_changing' });
    st.openFeedSuspectEventId = null;
  }

  // ---- accumulate
  const res = accumulate(st.evidence, { id: row.id, at, trigger: row.trigger, evidence: fe });
  st.evidence = res.acc;

  // Legacy per-decision counters (kept for staff tooling / reports).
  if (row.decision === 'match') {
    st.consecutiveMatch += 1;
    st.consecutiveMismatch = 0;
    st.consecutiveUnable = 0;
    st.lastMatchAt = at;
  } else if (row.decision === 'mismatch') {
    st.consecutiveMismatch += 1;
    st.consecutiveMatch = 0;
    st.consecutiveUnable = 0;
  } else {
    st.consecutiveUnable += 1;
    st.consecutiveMatch = 0;
  }
  st.pendingMismatchCheckIds = res.acc.window.filter((e) => e.llr > 0).map((e) => e.id);

  // ---- uncertain: no usable face image (never evidence of a different person)
  if (!fe.usable) {
    if (res.acc.unusableStreak >= UNVERIFIABLE_AFTER && !st.openUnverifiableEventId) {
      const ev = await m.addEvent({
        type: 'identity_unverifiable',
        source: 'server_identity',
        open: true,
        startedAt: at,
        confidence: row.confidence,
        details: { samples: res.acc.unusableStreak, lastDecision: row.decision, issues: row.quality?.issues ?? [], guidance: row.guidance, trigger: row.trigger },
        context: { precededBy: row.context?.precededBy ?? [], periodKind: row.context?.periodKind ?? null },
      });
      st.openUnverifiableEventId = ev.id;
      await m.tx.update(identityChecks).set({ eventId: ev.id }).where(eq(identityChecks.id, row.id));
      if (row.probeEvidenceId) await m.tx.update(evidence).set({ eventId: ev.id }).where(eq(evidence.id, row.probeEvidenceId));
    }
  } else if (st.openUnverifiableEventId && (row.decision === 'match' || row.decision === 'mismatch')) {
    await m.closeEvent(st.openUnverifiableEventId, at, { closedBy: row.decision === 'match' ? 'identity_match' : 'clear_image' });
    st.openUnverifiableEventId = null;
  }

  // ---- possible different person
  let held = false;
  const gate = res.transition === 'confirmed' && !st.openMismatchEventId ? await swapGate(m, env, st, row) : null;
  if (gate === 'request' || gate === 'pending' || gate === 'vetoed') {
    // Not confirmed (yet): the external second opinion is asked after this transaction, is still being asked, or
    // recently said "same person" about evidence this borderline. The evidence stays 'suspect' (fast sampling).
    st.evidence = { ...st.evidence, state: 'suspect', confirmedAt: null, clearStreak: 0 };
    if (gate === 'request') {
      st.secondOpinionPending = { checkId: row.id, since: m.now };
      env.secondOpinionRequests.push(row.id);
    } else if (gate === 'vetoed') {
      st.evidence = { ...st.evidence, window: st.evidence.window.slice(-1) };
      await noteSecondOpinionDisagreement(m, st, row, null);
    }
  } else if (gate === 'proceed' || gate === 'proceed_after_veto') {
    const extra = gate === 'proceed_after_veto' ? { needsHumanReview: true, secondOpinionVetoOverriddenBy: 'clear_internal_evidence', secondOpinionCheckId: st.secondOpinionVeto?.checkId ?? null } : {};
    const evId = await openMismatch(m, env, res.acc.window, row, res.sum, res.posterior, extra);
    st.openMismatchEventId = evId;
    st.followUpRequestedAt = null;
    if (env.policy.identity.onMismatch === 'hold_for_review') {
      m.setIdentityState(st);
      await holdNow(m, { reason: 'identity_mismatch', source: 'server_identity', details: { eventId: evId, trigger: row.trigger, posterior: res.posterior } });
      held = true;
    }
  } else if (st.openMismatchEventId && res.transition === 'recovered') {
    await m.closeEvent(st.openMismatchEventId, at, { closedBy: 'identity_consistent' });
    st.openMismatchEventId = null;
  } else if (st.openMismatchEventId && fe.usable) {
    await extendMismatch(m, st.openMismatchEventId, row, fe, res.sum, res.posterior);
  }
  // On hold (hold_for_review): sampling stops; the evidence that led here is in the event.
  if (held) return { followUpInMs: null, nextSampleInMs: null, evidence: toEvidenceDTO(res.acc) };

  // ---- 'suspect' from poor light only (capped evidence): an uncertain observation for staff, lighting guidance
  const poorLight = poorLightSuspect(st.evidence) && !st.openMismatchEventId;
  if (poorLight) await notePoorLightSuspect(m, st, row);

  const nextSampleInMs = nextSampleDelayMs(env.policy.identity, { activeSince: st.activeSince, acc: st.evidence }, m.now);
  const faster = st.evidence.state !== 'consistent' || st.evidence.unusableStreak > 0 || st.openMismatchEventId != null;
  const followUpInMs = faster ? nextSampleInMs : null;
  st.followUpRequestedAt = followUpInMs != null ? m.now : null;
  m.setIdentityState(st);
  return { followUpInMs, nextSampleInMs, evidence: toEvidenceDTO(st.evidence), poorLight };
}


/**
 * The evidence window is 'suspect' only because of poor-quality (dim / backlit / small) frames: record it as an
 * uncertain observation (identity_unverifiable, details.reason 'poor_light_suspect') — never "possible different
 * person"; confirmation waits for a fair or good frame. Closed like any identity_unverifiable by the next clear result.
 */
async function notePoorLightSuspect(m: SessionMutation, st: IdentityEngineState, row: IdentityCheck): Promise<void> {
  const at = row.at.getTime();
  const sum = windowSum(st.evidence.window);
  const details = { poorLightSuspect: true, evidence: sum, lastSampleAt: at, guidance: [POOR_LIGHT_GUIDANCE] };
  if (st.openUnverifiableEventId) {
    const [cur] = await m.tx.select().from(events).where(eq(events.id, st.openUnverifiableEventId));
    if (cur) {
      if (!(cur.details as { poorLightSuspect?: boolean }).poorLightSuspect || (cur.details as { evidence?: number }).evidence !== sum) await m.updateEvent(cur.id, { details: { ...cur.details, ...details } });
      return;
    }
  }
  const ev = await m.addEvent({
    type: 'identity_unverifiable',
    source: 'server_identity',
    open: true,
    startedAt: at,
    confidence: null,
    observation:
      'In poor light the face could not be matched dependably with the identity reference. This is not a finding that a different person is present; more light or a clearer view will settle it.',
    details: { reason: 'poor_light_suspect', trigger: row.trigger, similarity: row.similarity, issues: row.quality?.issues ?? [], identityCheckIds: [row.id], ...details },
    context: { precededBy: row.context?.precededBy ?? [], periodKind: row.context?.periodKind ?? null },
  });
  st.openUnverifiableEventId = ev.id;
  await m.tx.update(identityChecks).set({ eventId: ev.id }).where(eq(identityChecks.id, row.id));
}

const OBSERVATIONS: [string, string][] = [
  ['face_absence', 'A different face may have appeared after the candidate left and returned to the camera view.'],
  ['camera_reconnect', 'A different face may have appeared after the camera was reconnected.'],
  ['camera_disconnect', 'A different face may have appeared after the camera was reconnected.'],
  ['face_track_break', 'A different face may have appeared after the face briefly left the camera view.'],
  ['exam_start', 'A different face may have appeared shortly after the exam started or resumed.'],
];

function perSample(e: EvidenceEntry) {
  return { identityCheckId: e.id, at: e.at, similarity: e.similarity, bucket: e.bucket, llr: e.llr, trigger: e.trigger };
}

async function openMismatch(m: SessionMutation, env: SampleEnv, window: readonly EvidenceEntry[], row: IdentityCheck, sum: number, posterior: number, extra: Record<string, unknown> = {}): Promise<string> {
  const ids = window.map((e) => e.id);
  const rows = ids.length ? await m.tx.select().from(identityChecks).where(inArray(identityChecks.id, ids)) : [row];
  const contributing = window.filter((e) => e.llr > 0);
  const startedAt = Math.min(...(contributing.length ? contributing : window).map((e) => e.at), row.at.getTime());
  const precededBy = [...new Set(rows.flatMap((r) => r.context?.precededBy ?? []))];
  const sims = window.map((e) => e.similarity).filter((x): x is number => x != null);
  const observation = OBSERVATIONS.find(([tag]) => precededBy.includes(tag))?.[1] ?? 'The face in view may belong to a different person than the one who started the exam.';
  const ev = await m.addEvent({
    type: 'identity_mismatch',
    source: 'server_identity',
    open: true,
    startedAt,
    confidence: posterior,
    observation,
    details: {
      against: 'reference',
      samples: contributing.length,
      windowSamples: window.length,
      minSimilarity: sims.length ? Math.min(...sims) : null,
      maxSimilarity: sims.length ? Math.max(...sims) : null,
      identityCheckIds: contributing.map((e) => e.id),
      triggers: window.map((e) => e.trigger),
      perSample: window.map(perSample),
      llrSum: sum,
      posterior,
      baseline: env.baseline ?? null,
      calibrationVersion: CALIBRATION.version,
      sprt: { suspect: CALIBRATION.sprt.suspect, confirm: CALIBRATION.sprt.confirm, clear: CALIBRATION.sprt.clear },
      thresholds: { match: env.thresholds.match, mismatch: env.thresholds.mismatch },
      referenceId: env.active.ref.id,
      ...extra,
    },
    context: { precededBy, trigger: contributing[0]?.trigger ?? row.trigger, periodKind: row.context?.periodKind ?? null },
  });
  const linkIds = (contributing.length ? contributing : window).map((e) => e.id);
  await m.tx.update(identityChecks).set({ eventId: ev.id }).where(inArray(identityChecks.id, linkIds));
  const linked = rows.filter((r) => linkIds.includes(r.id));
  const probeIds = [...new Set(linked.flatMap((r) => [r.probeEvidenceId, r.frameEvidenceId]).filter((x): x is string => !!x))];
  const byCheck = linkIds.length
    ? await m.tx
        .select({ id: evidence.id })
        .from(evidence)
        .where(and(inArray(evidence.identityCheckId, linkIds), isNull(evidence.purgedAt)))
    : [];
  const all = [...new Set([...probeIds, ...byCheck.map((r) => r.id)])].slice(0, MAX_EVIDENCE_PER_MISMATCH_EVENT);
  if (all.length) await m.tx.update(evidence).set({ eventId: ev.id }).where(inArray(evidence.id, all));
  const refIds = env.active.ref.imageEvidenceIds;
  if (refIds.length) {
    const refs = await m.tx.select().from(evidence).where(inArray(evidence.id, refIds));
    for (const r of refs) await copyEvidence(env.ctx, m.tx, r, { kind: 'identity_reference', eventId: ev.id });
  }
  return ev.id;
}

async function extendMismatch(m: SessionMutation, eventId: string, row: IdentityCheck, fe: FrameEvidence, sum: number, posterior: number): Promise<void> {
  const [cur] = await m.tx.select().from(events).where(eq(events.id, eventId));
  if (!cur) return;
  const d = cur.details as { samples?: number; minSimilarity?: number | null; maxSimilarity?: number | null; identityCheckIds?: string[]; perSample?: unknown[]; triggers?: string[] };
  const sim = row.similarity;
  const contributes = fe.llr > 0;
  await m.updateEvent(eventId, {
    confidence: Math.max(cur.confidence ?? 0, posterior),
    details: {
      ...cur.details,
      samples: (d.samples ?? 0) + (contributes ? 1 : 0),
      minSimilarity: sim != null ? Math.min(d.minSimilarity ?? sim, sim) : (d.minSimilarity ?? null),
      maxSimilarity: sim != null ? Math.max(d.maxSimilarity ?? sim, sim) : (d.maxSimilarity ?? null),
      identityCheckIds: contributes ? [...(d.identityCheckIds ?? []), row.id].slice(-MAX_PER_SAMPLE_DETAILS) : (d.identityCheckIds ?? []),
      triggers: [...(d.triggers ?? []), row.trigger].slice(-MAX_PER_SAMPLE_DETAILS),
      perSample: [...(d.perSample ?? []), { identityCheckId: row.id, at: row.at.getTime(), similarity: sim, bucket: fe.bucket, llr: fe.llr, trigger: row.trigger }].slice(-MAX_PER_SAMPLE_DETAILS),
      llrSum: sum,
      posterior,
      lastSampleAt: row.at.getTime(),
    },
  });
  if (!contributes) return;
  await m.tx.update(identityChecks).set({ eventId }).where(eq(identityChecks.id, row.id));
  const [{ n }] = await m.tx.select({ n: sql<number>`count(*)::int` }).from(evidence).where(eq(evidence.eventId, eventId));
  const imgs = await m.tx.select({ id: evidence.id }).from(evidence).where(and(eq(evidence.identityCheckId, row.id), isNull(evidence.purgedAt)));
  const ids = [...new Set([row.probeEvidenceId, row.frameEvidenceId, ...imgs.map((r) => r.id)].filter((x): x is string => !!x))];
  if (ids.length && n < MAX_EVIDENCE_PER_MISMATCH_EVENT) await m.tx.update(evidence).set({ eventId }).where(inArray(evidence.id, ids.slice(0, MAX_EVIDENCE_PER_MISMATCH_EVENT - n)));
}

/* =================================================================== sweeper */

/**
 * Decide bursts whose frames stopped arriving (the client went away mid-burst): called by the sweeper so a burst
 * that shows someone else still counts even when no further sample arrives. Returns the number decided.
 */
export async function decideStaleBurstsForAll(ctx: Ctx, limit = 200): Promise<number> {
  const now = ctx.now();
  const rows = await ctx.db
    .select({ id: examSessions.id })
    .from(examSessions)
    .where(and(eq(examSessions.status, 'active'), sql`jsonb_array_length(coalesce(${examSessions.identityState}->'pendingBursts', '[]'::jsonb)) > 0`))
    .limit(limit);
  let n = 0;
  for (const { id } of rows) {
    const secondOpinionRequests: string[] = [];
    try {
      n += await withSession(ctx, id, async (m) => {
        const st = identityState(m.session);
        if (m.session.status !== 'active' || !st.pendingBursts.some((b) => now - b.firstReceivedAt >= BURST_TIMEOUT_MS)) return 0;
        const active = await loadActiveReference(ctx, m.tx, id);
        if (!active) {
          m.dropPendingBursts();
          return 0;
        }
        const before = st.pendingBursts.length;
        await decideStaleBursts(m, await sampleEnv(m, active, 0, secondOpinionRequests), null);
        return before - identityState(m.session).pendingBursts.length;
      });
      for (const checkId of secondOpinionRequests) await resolveSwapSecondOpinion(ctx, id, checkId);
    } catch (err) {
      ctx.log.error({ err, sessionId: id }, 'deciding stale identity bursts failed');
    }
  }
  return n;
}

/**
 * Erase the embeddings of burst frames that will never be decided, for ANY session (paused, on hold, ended, or active
 * without further samples): frames older than ORPHAN_FRAME_MS without an identity check, except frames of a burst an
 * active session is still collecting. Called by the sweeper; returns the number of frames erased.
 */
export async function eraseOrphanFrameEmbeddingsForAll(ctx: Ctx): Promise<number> {
  const cutoff = new Date(ctx.now() - ORPHAN_FRAME_MS);
  const rows = await ctx.db
    .update(identitySampleFrames)
    .set({ embeddingEnc: null })
    .where(
      and(
        isNull(identitySampleFrames.identityCheckId),
        isNotNull(identitySampleFrames.embeddingEnc),
        lt(identitySampleFrames.receivedAt, cutoff),
        sql`not exists (select 1 from exam_sessions s where s.id = identity_sample_frames.session_id and s.status = 'active' and coalesce(s.identity_state->'pendingBursts', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('id', identity_sample_frames.burst_id)))`,
      ),
    )
    .returning({ id: identitySampleFrames.id });
  return rows.length;
}

export { windowSum };

/* =================================================================== external second opinion (suspected swap) */

/** A pending second opinion is considered lost (e.g. the server restarted) and asked again after at least this long ... */
export const SECOND_OPINION_PENDING_MS = 15_000;
/** ... and never before the provider call itself may have timed out (EXTERNAL_VERIFIER_TIMEOUT_MS, up to 30 s) plus a margin for loading the images and applying the answer. */
const SECOND_OPINION_PENDING_MARGIN_MS = 10_000;

/** How long a requested second opinion is waited for before it is asked again (derived from the configured timeout). */
export function secondOpinionPendingMs(config: Pick<Ctx['config'], 'externalVerifiers'>): number {
  return Math.max(SECOND_OPINION_PENDING_MS, (config.externalVerifiers?.timeoutMs ?? 0) + SECOND_OPINION_PENDING_MARGIN_MS);
}
/** After the provider said "same person" about borderline evidence, borderline confirmations are held off this long. */
export const SECOND_OPINION_VETO_MS = 5 * 60_000;

type SwapGate = 'proceed' | 'proceed_after_veto' | 'request' | 'pending' | 'vetoed';

/**
 * What to do when the accumulator is about to confirm a possible different person. Without an applicable external
 * verifier (the default) always 'proceed' — exactly the behaviour without the feature.
 */
async function swapGate(m: SessionMutation, env: SampleEnv, st: IdentityEngineState, row: IdentityCheck): Promise<SwapGate> {
  if (!secondOpinionApplies(env.ctx, await m.org(), 'suspected_swap', m.session.consentAcceptedAt)) return 'proceed';
  const now = m.now;
  if (st.secondOpinionVeto && now < st.secondOpinionVeto.until) {
    // A clear internal mismatch is never held off by an external opinion (fusion principle 3); a borderline one is.
    // The strength is that of the accumulated evidence (a confirmed SPRT is clear), not the raw similarity.
    const strength = internalStrength(swapOpinion(row, windowSum(st.evidence.window)), fusionPolicyFor(env.thresholds));
    return strength === 'borderline' ? 'vetoed' : 'proceed_after_veto';
  }
  if (st.secondOpinionPending && now - st.secondOpinionPending.since < secondOpinionPendingMs(env.ctx.config)) return 'pending';
  return 'request';
}

/**
 * The internal opinion on a suspected swap for the external fusion: the accumulated evidence decides its strength —
 * a window sum at or above `sprt.confirm` (a confirmed_mismatch) is decisive, so an external "same person" can flag
 * it for review but never overrule it (verifiers/fusion.ts). A look-alike at similarity 0.35–0.45 is not
 * "borderline" when the evidence over several samples is decisive.
 */
export function swapOpinion(row: Pick<IdentityCheck, 'similarity'>, llrSum: number): InternalOpinion {
  return { decision: 'mismatch', similarity: row.similarity ?? null, evidence: { llr: Math.round(llrSum * 10000) / 10000, decisive: llrSum >= CALIBRATION.sprt.confirm } };
}

/**
 * The internal evidence pointed to a different person but the external provider disagreed (fused result
 * inconclusive): an uncertain observation for human review (identity_unverifiable, details.needsHumanReview) —
 * never "possible different person".
 */
async function noteSecondOpinionDisagreement(m: SessionMutation, st: IdentityEngineState, row: IdentityCheck, record: SecondOpinionRecord | null): Promise<void> {
  const at = row.at.getTime();
  if (st.openUnverifiableEventId) {
    const [cur] = await m.tx.select().from(events).where(eq(events.id, st.openUnverifiableEventId));
    if (cur) {
      const d = cur.details as { identityCheckIds?: string[] };
      await m.updateEvent(cur.id, {
        details: {
          ...cur.details,
          needsHumanReview: true,
          reason: 'second_opinion_disagrees',
          ...(record ? { secondOpinion: record } : {}),
          identityCheckIds: [...(d.identityCheckIds ?? []), row.id].slice(-MAX_PER_SAMPLE_DETAILS),
          lastSampleAt: at,
        },
      });
      await m.tx.update(identityChecks).set({ eventId: cur.id }).where(eq(identityChecks.id, row.id));
      return;
    }
  }
  const ev = await m.addEvent({
    type: 'identity_unverifiable',
    source: 'server_identity',
    open: true,
    startedAt: at,
    confidence: null,
    observation:
      'The camera images pointed to a possible change of person, but an independent second comparison indicated the same person. The identity could not be confirmed either way; flagged for human review.',
    details: { reason: 'second_opinion_disagrees', needsHumanReview: true, similarity: row.similarity, trigger: row.trigger, identityCheckIds: [row.id], ...(record ? { secondOpinion: record } : {}) },
    context: { precededBy: row.context?.precededBy ?? [], periodKind: row.context?.periodKind ?? null },
  });
  st.openUnverifiableEventId = ev.id;
  await m.tx.update(identityChecks).set({ eventId: ev.id }).where(eq(identityChecks.id, row.id));
  const imgs = [row.probeEvidenceId, row.frameEvidenceId].filter((x): x is string => !!x);
  if (imgs.length) await m.tx.update(evidence).set({ eventId: ev.id }).where(inArray(evidence.id, imgs));
}

/**
 * Ask the external verifier about a suspected swap (outside any lock), then apply the fused result:
 *  - mismatch (the provider agrees, is unavailable / uncertain, or contradicts a CLEAR internal mismatch — then with
 *    needsHumanReview): confirm now — identity_mismatch with the second opinion in its details, hold / flag per policy;
 *  - inconclusive (the provider is confident it is the same person and the internal evidence was borderline): do not
 *    confirm; identity_unverifiable (uncertain, needsHumanReview) and borderline confirmations are held off for
 *    SECOND_OPINION_VETO_MS.
 * Nothing happens when the request was superseded meanwhile (pause, hold, new period) or the evidence faded.
 */
export async function resolveSwapSecondOpinion(ctx: Ctx, sessionId: string, checkId: string): Promise<void> {
  const [s] = await ctx.db.select().from(examSessions).where(eq(examSessions.id, sessionId));
  const [row] = await ctx.db.select().from(identityChecks).where(eq(identityChecks.id, checkId));
  if (!s || !row) return;
  const org = await loadOrg(ctx.db, s.orgId);
  const active = await loadActiveReference(ctx, ctx.db, sessionId);
  if (!active) return;
  const record = await secondOpinion(ctx, {
    org,
    kind: 'suspected_swap',
    internal: swapOpinion(row, windowSum(identityState(s).evidence.window)),
    thresholds: orgThresholds(org),
    consentAcceptedAt: s.consentAcceptedAt,
    sessionId,
    images: async () => {
      const probeId = row.frameEvidenceId ?? row.probeEvidenceId;
      const [probeRow] = probeId ? await ctx.db.select().from(evidence).where(and(eq(evidence.id, probeId), isNull(evidence.purgedAt))) : [];
      const probe = probeRow ? await readEvidence(ctx, probeRow) : null;
      const refRows = active.ref.imageEvidenceIds.length ? await ctx.db.select().from(evidence).where(inArray(evidence.id, active.ref.imageEvidenceIds)) : [];
      const refs: Buffer[] = [];
      for (const r of [...refRows].sort((a, b) => (a.reason === 'frame' ? 0 : 1) - (b.reason === 'frame' ? 0 : 1))) {
        const data = await readEvidence(ctx, r);
        if (data) refs.push(data);
      }
      return probe && refs.length ? { reference: refs, probe } : null;
    },
  });
  await withSession(ctx, sessionId, async (m) => {
    if (record) {
      const [cur] = await m.tx.select({ context: identityChecks.context }).from(identityChecks).where(eq(identityChecks.id, checkId));
      if (cur) await m.tx.update(identityChecks).set({ context: { ...cur.context, secondOpinion: record } }).where(eq(identityChecks.id, checkId));
    }
    const st = identityState(m.session);
    if (st.secondOpinionPending?.checkId !== checkId) return; // superseded (pause / hold / new period) or resolved
    st.secondOpinionPending = null;
    const sum = windowSum(st.evidence.window);
    if (m.session.status !== 'active' || st.openMismatchEventId || sum < CALIBRATION.sprt.confirm) {
      m.setIdentityState(st);
      return;
    }
    const decision = record?.decision ?? 'mismatch';
    if (decision === 'mismatch') {
      const env = await sampleEnv(m, active, 0);
      const posterior = Math.round(posteriorSwap(sum) * 10000) / 10000;
      st.evidence = { ...st.evidence, state: 'confirmed_mismatch', confirmedAt: m.now, clearStreak: 0 };
      const evId = await openMismatch(m, env, st.evidence.window, row, sum, posterior, secondOpinionDetails(record));
      st.openMismatchEventId = evId;
      st.followUpRequestedAt = null;
      m.setIdentityState(st);
      if (env.policy.identity.onMismatch === 'hold_for_review') {
        await holdNow(m, { reason: 'identity_mismatch', source: 'server_identity', details: { eventId: evId, trigger: row.trigger, posterior, ...(record ? { needsHumanReview: record.needsHumanReview } : {}) } });
      }
      return;
    }
    // The provider is confident it is the same person and the internal evidence was borderline: not confirmed.
    st.secondOpinionVeto = { checkId, until: m.now + SECOND_OPINION_VETO_MS };
    st.evidence = { ...st.evidence, state: 'monitoring', window: [], confirmedAt: null, clearStreak: 0 };
    await noteSecondOpinionDisagreement(m, st, row, record);
    m.setIdentityState(st);
  });
}

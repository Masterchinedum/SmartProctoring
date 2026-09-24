/**
 * The `eval:identity --webcam` report: identity v1 (legacy gate, raw embedding, max-over-reference, 2
 * consecutive mismatches) versus the current pipeline (recalibrated gate, TTA embedding, templates,
 * calibrated LLR + windowed SPRT) on simulated laptop-webcam frames. See docs/accuracy/identity-v2.md.
 */
import { DEFAULT_IDENTITY_THRESHOLDS } from '@sp/shared';
import { CALIBRATION, BUCKET_MODELS, qualityBucket, sampleLLR, type QualityBucket } from '../vision/calibration';
import { QUALITY_GATE, QUALITY_GATE_V1, regateQuality } from '../vision/quality';
import type { FrameRecord, WebcamData } from './webcam-eval';
import {
  conditionTables,
  fitBuckets,
  formatConditionTables,
  gatePipelineQuality,
  scoreTrials,
  sessionsFrom,
  simulateSequential,
  withinSessionSd,
  withinSessionSdFromFrames,
  type BucketFit,
  type ConditionTable,
  type PipelineSpec,
  type SequentialRule,
  type SequentialSimResult,
  type Session,
} from './webcam-metrics';
import { WEBCAM_CONDITIONS, type WebcamCondition } from './webcam-sim';

/** Identity v1 as shipped before the webcam study. */
export function legacyPipeline(embedding = 'v1-raw'): PipelineSpec {
  return { name: 'v1 (legacy)', embedding, quality: gatePipelineQuality(QUALITY_GATE_V1), match: 0.45, mismatch: 0.28, scoring: 'legacy', enrolMin: 3 };
}

/** The current production pipeline (QUALITY_GATE, default embedding recipe, CALIBRATION). */
export function currentPipeline(embedding = 'default'): PipelineSpec {
  return {
    name: 'v2 (current)',
    embedding,
    quality: (r: FrameRecord) => regateQuality(r.quality, r.faces, r.width, r.height, QUALITY_GATE),
    match: CALIBRATION.match,
    mismatch: CALIBRATION.mismatch,
    scoring: 'template',
    enrolMin: CALIBRATION.minFramesForDecision,
    bucket: qualityBucket,
  };
}

export interface PipelineReport {
  pipeline: string;
  enrolment: Record<string, { ok: number; total: number }>;
  /** Enrolment in good or typical light (normal check-in), probes per condition. */
  frames: ConditionTable[];
  checks: ConditionTable[];
  /** Check-in in the SAME poor condition as the probes (dim / backlit). */
  checksSameCondition: ConditionTable[];
  buckets?: BucketFit[];
  sdWithin?: Record<QualityBucket, number>;
  sequential: {
    rule: string;
    genuineSamePhoto: SequentialSimResult;
    genuineCrossPhoto: SequentialSimResult;
    impostor: SequentialSimResult;
    impostorFamily: SequentialSimResult;
    /** Swap while the evidence window holds strong genuine evidence (just above `clear`). */
    impostorAfterGenuine?: SequentialSimResult;
    perCondition: Record<string, { falseConfirmPer1000h: number | undefined; medianSamples: number | null | undefined; detectedWithin3: number | undefined; family3: number | undefined }>;
  };
}

export interface WebcamReport {
  generatedAt: string;
  calibrationVersion: string;
  dataset: { sourcePhotos: number; identities: number; identitiesWithTwoPlus: number; frames: number; families: number };
  latencyMs: { analyzeMean: number | null };
  pipelines: PipelineReport[];
  assumptions: string[];
}

function sequentialFor(p: PipelineSpec, data: WebcamData, runs: number): PipelineReport['sequential'] & { sdWithin: Record<QualityBucket, number>; fits?: BucketFit[] } {
  const all = scoreTrials(data, p, ['good', 'typical', 'dim', 'backlit']);
  // A session compares probes with a reference enrolled in the same or a better condition.
  const sessions = sessionsFrom(all.bursts.filter((b) => b.enrol === 'good' || b.enrol === 'typical' || b.enrol === b.condition));
  // Movement between samples ~ good-light scene-to-scene scatter; frame noise from the scatter inside bursts.
  const sceneSd = withinSessionSd(sessions.filter((s) => s.kind === 'genuine_same'));
  const sd = withinSessionSdFromFrames(all.frames, sceneSd.good);
  const rule: SequentialRule =
    p.scoring === 'legacy'
      ? { type: 'consecutive', mismatch: p.mismatch, confirmations: DEFAULT_IDENTITY_THRESHOLDS.mismatchConfirmations }
      : { type: 'sprt', llr: sampleLLR, params: { ...CALIBRATION.sprt, llrClamp: CALIBRATION.llrClamp } };
  const by = (k: (s: Session) => boolean) => sessions.filter(k);
  const g = (ss: Session[]) => simulateSequential(ss, rule, sd, { mode: 'genuine', runs });
  const i = (ss: Session[], startSum?: number) => simulateSequential(ss, rule, sd, { mode: 'impostor', runs: Math.max(20, Math.round(runs / 5)), startSum });
  const perCondition: PipelineReport['sequential']['perCondition'] = {};
  for (const c of WEBCAM_CONDITIONS) {
    const gs = g(by((s) => s.kind === 'genuine_same' && s.condition === c));
    const im = i(by((s) => s.kind.startsWith('impostor') && s.condition === c));
    const fam = i(by((s) => s.kind === 'impostor_family' && s.condition === c));
    perCondition[c] = { falseConfirmPer1000h: gs.falseConfirmPer1000h, medianSamples: im.medianSamples, detectedWithin3: im.detectedWithin?.[3], family3: fam.detectedWithin?.[3] };
  }
  return {
    rule: rule.type === 'sprt' ? `windowed SPRT ${JSON.stringify(rule.params)}` : `${rule.confirmations} consecutive samples < ${rule.mismatch}`,
    genuineSamePhoto: g(by((s) => s.kind === 'genuine_same')),
    genuineCrossPhoto: g(by((s) => s.kind === 'genuine_cross')),
    impostor: i(by((s) => s.kind.startsWith('impostor'))),
    impostorFamily: i(by((s) => s.kind === 'impostor_family')),
    impostorAfterGenuine: rule.type === 'sprt' ? i(by((s) => s.kind.startsWith('impostor')), CALIBRATION.sprt.clear + 0.01) : undefined,
    perCondition,
    sdWithin: sd,
    fits: p.scoring === 'template' ? fitBuckets(all.bursts.filter((b) => b.enrol === 'good' || b.enrol === 'typical')) : undefined,
  };
}

export function pipelineReport(data: WebcamData, p: PipelineSpec, opts: { runs?: number } = {}): PipelineReport {
  const enrolment: PipelineReport['enrolment'] = {};
  for (const c of ['good', 'typical', 'dim', 'backlit'] as WebcamCondition[]) {
    const refs = scoreTrials(data, p, [c]).refs;
    enrolment[c] = { ok: refs.filter((r) => r.ok).length, total: refs.length };
  }
  const normal = scoreTrials(data, p, ['good', 'typical']);
  const same = ['dim', 'backlit'].flatMap((c) =>
    scoreTrials(data, p, [c as WebcamCondition]).bursts.filter((b) => b.condition === c),
  );
  const seq = sequentialFor(p, data, opts.runs ?? 100);
  const { sdWithin, fits, ...sequential } = seq;
  return {
    pipeline: p.name,
    enrolment,
    frames: conditionTables(normal.frames, { byResolution: true }),
    checks: conditionTables(normal.bursts, { byResolution: true }),
    checksSameCondition: conditionTables(same),
    buckets: fits,
    sdWithin,
    sequential,
  };
}

export function buildWebcamReport(data: WebcamData, pipelines: (PipelineSpec | { pipeline: PipelineSpec; data: WebcamData })[], opts: { runs?: number } = {}): WebcamReport {
  const ids = new Map<string, number>();
  for (const s of data.sources) ids.set(s.identity, (ids.get(s.identity) ?? 0) + 1);
  const ms = data.records.map((r) => r.analyzeMs).filter((v) => Number.isFinite(v));
  return {
    generatedAt: new Date().toISOString(),
    calibrationVersion: CALIBRATION.version,
    dataset: {
      sourcePhotos: data.sources.length,
      identities: ids.size,
      identitiesWithTwoPlus: [...ids.values()].filter((n) => n >= 2).length,
      frames: data.records.length,
      families: new Set(data.sources.map((s) => s.family).filter(Boolean)).size,
    },
    latencyMs: { analyzeMean: ms.length ? Math.round((ms.reduce((a, b) => a + b, 0) / ms.length) * 10) / 10 : null },
    pipelines: pipelines.map((p) => ('pipeline' in p ? pipelineReport(p.data, p.pipeline, opts) : pipelineReport(data, p, opts))),
    assumptions: [
      'Sampling: every 6 s for the first 3 min, then every 15 s; one sample = one burst of 3 frames (one scene).',
      'Consecutive samples of a candidate share person, room, camera and lighting; only frame noise and small movements vary: sample similarity ~ N(session mean, within-session sd of the bucket), sd estimated from the scatter between two independently placed scenes (an upper bound for a seated candidate).',
      'Unusable samples contribute no evidence (v2) / reset the consecutive-mismatch streak (v1).',
      'Genuine "same-photo" sessions stand for mid-exam monitoring (same day); "cross-photo" sessions stand for a candidate resuming days later (other photo: other day, hairstyle, camera; public-figure photos can be years apart), a pessimistic bound.',
      'Swap detection assumes the swap happens right at a sample boundary with an empty evidence window (the engine drops earlier genuine evidence at a track break); impostorAfterGenuine assumes the window held strong genuine evidence.',
    ],
  };
}

export function formatWebcamReport(r: WebcamReport): string {
  const out: string[] = [];
  out.push(`Webcam identity evaluation — calibration ${r.calibrationVersion}`);
  out.push(`dataset: ${r.dataset.sourcePhotos} source photos, ${r.dataset.identities} identities (${r.dataset.identitiesWithTwoPlus} with >= 2 photos), ${r.dataset.families} families, ${r.dataset.frames} simulated frames; analyse ${r.latencyMs.analyzeMean} ms/frame (incl. evaluation variants)`);
  for (const p of r.pipelines) {
    out.push(`\n################ ${p.pipeline}`);
    out.push(`enrolment success (5 check-in frames): ${Object.entries(p.enrolment).map(([c, v]) => `${c} ${v.ok}/${v.total}`).join(', ')}`);
    out.push(formatConditionTables('Per-frame decisions (check-in in good/typical light)', p.frames));
    out.push(formatConditionTables('Checks: 3 frames of one scene decided together (check-in in good/typical light)', p.checks));
    out.push(formatConditionTables('Checks with check-in in the same poor light (dim/backlit)', p.checksSameCondition.filter((t) => t.condition !== 'all' && t.genuineCross.n > 0)));
    if (p.buckets) out.push(`\nbucket fits (burst template vs gallery template; genuine = cross-photo): ${p.buckets.map((b) => `${b.bucket}: gen ${b.genuine.mean}±${b.genuine.sd} (n ${b.genuine.n}) imp ${b.impostor.mean}±${b.impostor.sd} (n ${b.impostor.n})`).join(' | ')}`);
    if (p.sdWithin) out.push(`within-session sd: ${JSON.stringify(p.sdWithin)}`);
    const s = p.sequential;
    out.push(`\nsequential rule: ${s.rule}`);
    out.push(`  false confirmed swaps / 1000 candidate-hours: same-photo ${s.genuineSamePhoto.falseConfirmPer1000h} (suspect ${s.genuineSamePhoto.falseSuspectPer1000h}, bad sessions ${s.genuineSamePhoto.badSessions}/${s.genuineSamePhoto.sessions}); cross-photo ${s.genuineCrossPhoto.falseConfirmPer1000h} (bad ${s.genuineCrossPhoto.badSessions}/${s.genuineCrossPhoto.sessions})`);
    out.push(`  swap detection: median ${s.impostor.medianSamples} samples (${s.impostor.medianSeconds} s), p90 ${s.impostor.p90Samples}, within 3 samples ${s.impostor.detectedWithin?.[3]}%, never (40 samples) ${s.impostor.notDetected}%`);
    out.push(`  family impostors: median ${s.impostorFamily.medianSamples} samples, within 3 ${s.impostorFamily.detectedWithin?.[3]}%, never ${s.impostorFamily.notDetected}%`);
    if (s.impostorAfterGenuine) out.push(`  swap after strong genuine evidence: median ${s.impostorAfterGenuine.medianSamples} samples, within 3 ${s.impostorAfterGenuine.detectedWithin?.[3]}%`);
    out.push(`  per condition: ${Object.entries(s.perCondition).map(([c, v]) => `${c}: FA ${v.falseConfirmPer1000h}/1000h, median ${v.medianSamples}, <=3 ${v.detectedWithin3}%, family <=3 ${v.family3}%`).join(' | ')}`);
  }
  return out.join('\n');
}

export { BUCKET_MODELS };

/**
 * The `eval:identity --webcam` report: identity v1 (legacy gate, raw embedding, max-over-reference, 2
 * consecutive mismatches) versus the current pipeline (recalibrated gate, TTA embedding, templates,
 * calibrated LLR + windowed SPRT) on simulated laptop-webcam frames. See docs/accuracy/identity-v2.md.
 */
import { DEFAULT_IDENTITY_THRESHOLDS } from '@sp/shared';
import { CALIBRATION, BUCKET_MODELS, qualityBucket, sampleLLR, type QualityBucket } from '../vision/calibration';
import { QUALITY_GATE, QUALITY_GATE_V1, regateQuality } from '../vision/quality';
import { decideIdentity } from '../vision/identity';
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
  checkAttempts,
  type BurstTrial,
  type CheckAttempt,
  type FrameTrial,
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
    decide: (sim, q) => decideIdentity(sim, q, { ...DEFAULT_IDENTITY_THRESHOLDS, match: CALIBRATION.match, mismatch: CALIBRATION.mismatch }).decision,
  };
}

/**
 * Production decision logic of the identity engine (services/identity-evidence.ts), injected so the report measures
 * what ships: per-session normalised per-sample LLR and the check assessment. Optional — without it the report uses
 * the plain calibrated `sampleLLR` and a template-score rule for checks.
 */
export interface EngineHooks {
  comparisonLLR(similarity: number, bucket: QualityBucket, baseline: { mean: number; sd: number; n: number } | null, context: 'continuous' | 'relaxed'): { llr: number };
  assessCheck(frames: { usable: boolean; similarity: number | null; bucket: QualityBucket | null; llr: number }[], opts?: { atLimit?: boolean }): { status: string };
}

export interface PerConditionSeq {
  falseConfirmPer1000h: number | undefined;
  falseConfirmCrossPer1000h: number | undefined;
  medianSamples: number | null | undefined;
  detectedWithin3: number | undefined;
  family3: number | undefined;
  /** % of impostor sessions reaching 'suspect' within 3 samples / ever (40 samples). */
  suspectWithin3: number | undefined;
  suspectEver: number | undefined;
}

export interface CheckOutcomeRates {
  n: number;
  pass: number | null;
  uncertain: number | null;
  pending: number | null;
  mismatch: number | null;
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
    perCondition: Record<string, PerConditionSeq>;
    /** Same simulation with the identity engine's per-session normalisation ('continuous' context). */
    normalised?: {
      genuineSamePhoto: SequentialSimResult;
      genuineCrossPhoto: SequentialSimResult;
      impostor: SequentialSimResult;
      impostorFamily: SequentialSimResult;
      perCondition: Record<string, PerConditionSeq>;
    };
  };
  /** Checks decided by the identity engine's assessCheck ('relaxed' context): 3 frames, and 6 frames (adaptive). */
  engineChecks?: Record<string, Record<'genuineSame' | 'genuineCross' | 'impostor' | 'family', { frames3: CheckOutcomeRates; frames6: CheckOutcomeRates }>>;
}

export interface WebcamReport {
  generatedAt: string;
  calibrationVersion: string;
  dataset: { sourcePhotos: number; identities: number; identitiesWithTwoPlus: number; frames: number; families: number };
  latencyMs: { analyzeMean: number | null };
  pipelines: PipelineReport[];
  assumptions: string[];
}

type SimSet = Omit<PipelineReport['sequential'], 'rule' | 'normalised'>;

function simulateAll(sessions: Session[], rule: SequentialRule, sd: Record<QualityBucket, number>, runs: number): SimSet {
  const by = (k: (s: Session) => boolean) => sessions.filter(k);
  const g = (ss: Session[]) => simulateSequential(ss, rule, sd, { mode: 'genuine', runs });
  const i = (ss: Session[], startSum?: number) => simulateSequential(ss, rule, sd, { mode: 'impostor', runs: Math.max(5, Math.round(runs / 10)), startSum });
  const perCondition: PipelineReport['sequential']['perCondition'] = {};
  for (const c of WEBCAM_CONDITIONS) {
    const gs = g(by((s) => s.kind === 'genuine_same' && s.condition === c));
    const gx = g(by((s) => s.kind === 'genuine_cross' && s.condition === c));
    const im = i(by((s) => s.kind.startsWith('impostor') && s.condition === c));
    const fam = i(by((s) => s.kind === 'impostor_family' && s.condition === c));
    perCondition[c] = {
      falseConfirmPer1000h: gs.falseConfirmPer1000h,
      falseConfirmCrossPer1000h: gx.falseConfirmPer1000h,
      medianSamples: im.medianSamples,
      detectedWithin3: im.detectedWithin?.[3],
      family3: fam.detectedWithin?.[3],
      suspectWithin3: im.suspectWithin3,
      suspectEver: im.suspectEver,
    };
  }
  return {
    genuineSamePhoto: g(by((s) => s.kind === 'genuine_same')),
    genuineCrossPhoto: g(by((s) => s.kind === 'genuine_cross')),
    impostor: i(by((s) => s.kind.startsWith('impostor'))),
    impostorFamily: i(by((s) => s.kind === 'impostor_family')),
    impostorAfterGenuine: rule.type === 'sprt' ? i(by((s) => s.kind.startsWith('impostor')), CALIBRATION.sprt.clear + 0.01) : undefined,
    perCondition,
  };
}

function sequentialFor(p: PipelineSpec, data: WebcamData, runs: number, hooks?: EngineHooks): PipelineReport['sequential'] & { sdWithin: Record<QualityBucket, number>; fits?: BucketFit[] } {
  const all = scoreTrials(data, p, ['good', 'typical', 'dim', 'backlit']);
  // A session compares probes with a reference enrolled in the same or a better condition.
  const sessions = sessionsFrom(all.bursts.filter((b) => b.enrol === 'good' || b.enrol === 'typical' || b.enrol === b.condition));
  // Movement between samples ~ good-light scene-to-scene scatter; frame noise from the scatter inside bursts.
  const sceneSd = withinSessionSd(sessions.filter((s) => s.kind === 'genuine_same'));
  const sd = withinSessionSdFromFrames(all.frames, sceneSd.good);
  const rule: SequentialRule =
    p.scoring === 'legacy'
      ? { type: 'consecutive', mismatch: p.mismatch, confirmations: DEFAULT_IDENTITY_THRESHOLDS.mismatchConfirmations }
      : { type: 'sprt', llr: (sim, b) => sampleLLR(sim, b), params: { ...CALIBRATION.sprt, llrClamp: CALIBRATION.llrClamp } };
  const plain = simulateAll(sessions, rule, sd, runs);
  let normalised: PipelineReport['sequential']['normalised'];
  if (hooks && rule.type === 'sprt') {
    const nrule: SequentialRule = { ...rule, llr: (sim, b, session) => hooks.comparisonLLR(sim, b, session.refBaseline, 'continuous').llr };
    const { impostorAfterGenuine: _ignored, ...rest } = simulateAll(sessions, nrule, sd, runs);
    void _ignored;
    normalised = rest;
  }
  return {
    rule: rule.type === 'sprt' ? `windowed SPRT ${JSON.stringify(rule.params)}` : `${rule.confirmations} consecutive samples < ${rule.mismatch}`,
    ...plain,
    normalised,
    sdWithin: sd,
    fits: p.scoring === 'template' ? fitBuckets(all.bursts.filter((b) => b.enrol === 'good' || b.enrol === 'typical')) : undefined,
  };
}

function rates(statuses: string[]): CheckOutcomeRates {
  const n = statuses.length;
  const pc = (st: string) => (n ? Math.round((1000 * statuses.filter((x) => x === st).length) / n) / 10 : null);
  return { n, pass: pc('likely_match'), uncertain: pc('uncertain'), pending: pc('pending'), mismatch: pc('likely_mismatch') };
}

/** Resume / reconnect checks decided by the identity engine's assessCheck, per probe condition. */
function engineChecks(frames: FrameTrial[], bursts: BurstTrial[], hooks: EngineHooks): NonNullable<PipelineReport['engineChecks']> {
  const decide = (a: CheckAttempt) =>
    hooks.assessCheck(
      a.frames.map((f) => ({
        usable: f.usable,
        similarity: f.similarity,
        bucket: f.bucket,
        llr: f.usable && f.similarity != null && f.bucket ? hooks.comparisonLLR(f.similarity, f.bucket, a.refBaseline, 'relaxed').llr : 0,
      })),
      { atLimit: true },
    ).status;
  const a3 = checkAttempts(frames, bursts, 1);
  const a6 = checkAttempts(frames, bursts, 2);
  const out: NonNullable<PipelineReport['engineChecks']> = {};
  for (const c of ['all', ...WEBCAM_CONDITIONS]) {
    const f = (list: CheckAttempt[], kinds: string[]) => rates(list.filter((a) => (c === 'all' || a.condition === c) && kinds.includes(a.kind)).map(decide));
    const row = (kinds: string[]) => ({ frames3: f(a3, kinds), frames6: f(a6, kinds) });
    out[c] = { genuineSame: row(['genuine_same']), genuineCross: row(['genuine_cross']), impostor: row(['impostor', 'impostor_family']), family: row(['impostor_family']) };
  }
  return out;
}

export function pipelineReport(data: WebcamData, p: PipelineSpec, opts: { runs?: number; hooks?: EngineHooks } = {}): PipelineReport {
  const enrolment: PipelineReport['enrolment'] = {};
  for (const c of ['good', 'typical', 'dim', 'backlit'] as WebcamCondition[]) {
    const refs = scoreTrials(data, p, [c]).refs;
    enrolment[c] = { ok: refs.filter((r) => r.ok).length, total: refs.length };
  }
  const normal = scoreTrials(data, p, ['good', 'typical']);
  const same = ['dim', 'backlit'].flatMap((c) =>
    scoreTrials(data, p, [c as WebcamCondition]).bursts.filter((b) => b.condition === c),
  );
  const seq = sequentialFor(p, data, opts.runs ?? 100, p.scoring === 'template' ? opts.hooks : undefined);
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
    ...(opts.hooks && p.scoring === 'template' ? { engineChecks: engineChecks(normal.frames, normal.bursts, opts.hooks) } : {}),
  };
}

export function buildWebcamReport(data: WebcamData, pipelines: (PipelineSpec | { pipeline: PipelineSpec; data: WebcamData })[], opts: { runs?: number; hooks?: EngineHooks } = {}): WebcamReport {
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
    out.push(`  per condition: ${Object.entries(s.perCondition).map(([c, v]) => `${c}: FA ${v.falseConfirmPer1000h}/1000h (cross ${v.falseConfirmCrossPer1000h}), median ${v.medianSamples}, <=3 ${v.detectedWithin3}%, family <=3 ${v.family3}%, suspect <=3 ${v.suspectWithin3}% ever ${v.suspectEver}%`).join(' | ')}`);
    if (s.normalised) {
      const n = s.normalised;
      out.push(`  with the engine's per-session normalisation (continuous): FA same-photo ${n.genuineSamePhoto.falseConfirmPer1000h}/1000h (bad ${n.genuineSamePhoto.badSessions}/${n.genuineSamePhoto.sessions}), cross-photo ${n.genuineCrossPhoto.falseConfirmPer1000h}; swap median ${n.impostor.medianSamples} samples (${n.impostor.medianSeconds} s), <=3 ${n.impostor.detectedWithin?.[3]}%, never ${n.impostor.notDetected}%; family median ${n.impostorFamily.medianSamples}, <=3 ${n.impostorFamily.detectedWithin?.[3]}%, never ${n.impostorFamily.notDetected}%`);
      out.push(`    per condition: ${Object.entries(n.perCondition).map(([c, v]) => `${c}: FA ${v.falseConfirmPer1000h} (cross ${v.falseConfirmCrossPer1000h}), median ${v.medianSamples}, <=3 ${v.detectedWithin3}%, family <=3 ${v.family3}%, suspect <=3 ${v.suspectWithin3}%`).join(' | ')}`);
    }
    if (p.engineChecks) {
      out.push(`\nChecks decided by the identity engine (assessCheck, 'relaxed'): pass / uncertain / pending / MISMATCH %, 3 frames | 6 frames`);
      const f = (r: CheckOutcomeRates) => `${r.pass ?? '-'}/${r.uncertain ?? '-'}/${r.pending ?? '-'}/${r.mismatch ?? '-'} (n ${r.n})`;
      for (const [c, v] of Object.entries(p.engineChecks)) {
        out.push(`  ${c.padEnd(8)} genuine same ${f(v.genuineSame.frames3)} | ${f(v.genuineSame.frames6)}   genuine cross ${f(v.genuineCross.frames3)} | ${f(v.genuineCross.frames6)}   impostor ${f(v.impostor.frames3)} | ${f(v.impostor.frames6)}   family ${f(v.family.frames3)} | ${f(v.family.frames6)}`);
      }
    }
  }
  return out.join('\n');
}

export { BUCKET_MODELS };

/* ------------------------------------------------------------------------------------ markdown */

const pc = (v: number | null | undefined) => (v == null ? '–' : `${v.toFixed(1)} %`);

/** Markdown tables for docs/accuracy/identity-v2.md (`eval:identity --webcam --markdown <file>`). */
export function formatWebcamMarkdown(r: WebcamReport): string {
  const out: string[] = [];
  const [v1, v2] = [r.pipelines.find((p) => p.pipeline.startsWith('v1')), r.pipelines.find((p) => p.pipeline.startsWith('v2'))];
  const conds = ['good', 'typical', 'dim', 'backlit', 'sidelit'];
  out.push(`Calibration \`${r.calibrationVersion}\`; ${r.dataset.sourcePhotos} source photos, ${r.dataset.identitiesWithTwoPlus} enrolled identities, ${r.dataset.families} families, ${r.dataset.frames} simulated frames.`);
  out.push('');
  out.push('**Enrolment** (5 check-in frames in the condition; a reference needs 3 usable frontal frames)');
  out.push('');
  out.push('| | good | typical | dim | backlit |');
  out.push('|---|--:|--:|--:|--:|');
  for (const p of [v1, v2]) if (p) out.push(`| ${p.pipeline} | ${['good', 'typical', 'dim', 'backlit'].map((c) => `${p.enrolment[c].ok}/${p.enrolment[c].total}`).join(' | ')} |`);
  out.push('');
  const table = (title: string, pick: (p: PipelineReport) => ConditionTable[], rows: string[]) => {
    out.push(`**${title}**`);
    out.push('');
    out.push('| condition | pipeline | genuine same-session: match / inconcl. / unable / **mismatch** | genuine other day: match / inconcl. / unable / **mismatch** | impostor: mismatch / inconcl. / unable / **match** | family impostor: mismatch / unable / **match** |');
    out.push('|---|---|---|---|---|---|');
    for (const c of rows) {
      for (const p of [v1, v2]) {
        if (!p) continue;
        const t = pick(p).find((x) => x.condition === c);
        if (!t) continue;
        const d = (x: ConditionTable['genuineSame'], m: 'mismatch' | 'match') =>
          `${pc(x.match)} / ${pc(x.inconclusive)} / ${pc(x.unable)} / **${pc(m === 'mismatch' ? x.mismatch : x.match)}**`;
        const imp = `${pc(t.impostor.mismatch)} / ${pc(t.impostor.inconclusive)} / ${pc(t.impostor.unable)} / **${pc(t.impostor.match)}**`;
        const fam = `${pc(t.family.mismatch)} / ${pc(t.family.unable)} / **${pc(t.family.match)}**`;
        out.push(`| ${c} | ${p.pipeline.split(' ')[0]} | ${d(t.genuineSame, 'mismatch')} | ${d(t.genuineCross, 'mismatch')} | ${imp} | ${fam} |`);
      }
    }
    out.push('');
  };
  table('Per-frame decisions (reference enrolled in good or typical light)', (p) => p.frames, ['all', ...conds]);
  table('Checks: the 3 frames of one burst decided together (v1: aggregateFrames; v2: burst template vs gallery template)', (p) => p.checks, ['all', ...conds, 'good@640x480', 'good@1280x720', 'dim@640x480', 'dim@1280x720']);
  if (v2?.engineChecks) {
    out.push('**Resume / reconnect checks as the identity engine decides them** (`assessCheck`, relaxed context): pass / uncertain / pending (too few usable frames) / **mismatch**, with 3 frames → 6 frames');
    out.push('');
    out.push('| condition | genuine same-session | genuine other day | impostor | family impostor |');
    out.push('|---|---|---|---|---|');
    const f = (x: CheckOutcomeRates) => `${x.pass ?? '–'} / ${x.uncertain ?? '–'} / ${x.pending ?? '–'} / **${x.mismatch ?? '–'}**`;
    for (const [c, v] of Object.entries(v2.engineChecks)) out.push(`| ${c} | ${f(v.genuineSame.frames3)} → ${f(v.genuineSame.frames6)} | ${f(v.genuineCross.frames3)} → ${f(v.genuineCross.frames6)} | ${f(v.impostor.frames3)} → ${f(v.impostor.frames6)} | ${f(v.family.frames3)} → ${f(v.family.frames6)} |`);
    out.push('');
  }
  out.push('**Swap detection during the exam** (simulated sequences, sampling every 6 s for 3 min then 15 s, bursts of 3)');
  out.push('');
  out.push('| condition | pipeline | false confirmed swaps / 1000 h, same session | … other day (resume) | swap confirmed ≤ 3 samples | median samples | family ≤ 3 samples | suspect ≤ 3 samples |');
  out.push('|---|---|--:|--:|--:|--:|--:|--:|');
  for (const c of conds) {
    for (const p of [v1, v2]) {
      if (!p) continue;
      const s = p.sequential.perCondition[c];
      out.push(`| ${c} | ${p.pipeline.split(' ')[0]} | ${s.falseConfirmPer1000h ?? '–'} | ${s.falseConfirmCrossPer1000h ?? '–'} | ${pc(s.detectedWithin3)} | ${s.medianSamples ?? 'never (median)'} | ${pc(s.family3)} | ${pc(s.suspectWithin3)} |`);
    }
    const n = v2?.sequential.normalised?.perCondition[c];
    if (n) out.push(`| ${c} | v2 + session normalisation | ${n.falseConfirmPer1000h ?? '–'} | ${n.falseConfirmCrossPer1000h ?? '–'} | ${pc(n.detectedWithin3)} | ${n.medianSamples ?? 'never (median)'} | ${pc(n.family3)} | ${pc(n.suspectWithin3)} |`);
  }
  out.push('');
  return out.join('\n');
}

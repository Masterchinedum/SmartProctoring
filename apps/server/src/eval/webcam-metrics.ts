/**
 * Metrics over the simulated-webcam frame table (webcam-eval.ts): per-frame decisions, check outcomes,
 * similarity distributions, LLR-model fitting and a Monte-Carlo simulation of the sequential swap test.
 *
 * Terminology
 *   reference   gallery enrolled from one identity's check-in frames (5 frames, one enrolment condition)
 *   genuine     probe of the enrolled person: "same-photo" (same source photo = same day / session, other
 *               capture conditions) or "cross-photo" (another photo of the person = another day, room, camera,
 *               hairstyle, years apart for some public figures — a pessimistic stand-in for resume-after-days)
 *   impostor    probe of anybody else; "family" when both are members of the same family (look-alikes)
 *   burst       the 3 frames of one sample (same scene, captured within ~0.6 s)
 */
import { DEFAULT_IDENTITY_THRESHOLDS, type FaceQuality, type IdentityDecision } from '@sp/shared';
import { aggregateFrames, buildReference, cosineSimilarity, maxSimilarity, scoreAgainst, templateFrom } from '../vision/identity';
import { regateQuality } from '../vision/quality';
import { qualityBucket, rawLLR, type BucketModel, type QualityBucket } from '../vision/calibration';
import type { ImageAnalysis, QualityGate } from '../vision/types';
import type { FrameRecord, WebcamData } from './webcam-eval';
import { WEBCAM_CONDITIONS, type WebcamCondition, type WebcamResolution } from './webcam-sim';

export interface PipelineSpec {
  name: string;
  /** Key into FrameRecord.embeddings. */
  embedding: string;
  /** Quality of a frame under this pipeline's gate. */
  quality: (r: FrameRecord) => FaceQuality;
  match: number;
  mismatch: number;
  /** 'legacy': buildReference + max over reference embeddings, aggregateFrames checks; 'template': mean templates. */
  scoring: 'legacy' | 'template';
  /** Usable frames needed to enrol (template scoring). */
  enrolMin: number;
  /** Bucket of a usable frame (template scoring; for LLR). */
  bucket?: (q: FaceQuality) => QualityBucket;
}

export function gatePipelineQuality(gate: QualityGate): (r: FrameRecord) => FaceQuality {
  return (r) => regateQuality(r.quality, r.faces, r.width, r.height, gate);
}

/* ================================================================================ references */

export interface Reference {
  identity: string;
  photoKey: string;
  family: string | null;
  condition: WebcamCondition;
  ok: boolean;
  embeddings: Float32Array[];
  template: Float32Array | null;
  /** Leave-one-out self-similarity of the gallery frames (session baseline). */
  selfSimilarity: number | null;
}

const REF_MAX_YAW = 20;

function asAnalysis(r: FrameRecord, p: PipelineSpec): ImageAnalysis {
  return {
    width: r.width,
    height: r.height,
    faces: r.faces,
    primary: r.faces[0] ?? null,
    pose: r.pose,
    quality: p.quality(r),
    embedding: r.embeddings?.[p.embedding] ?? null,
    dhash: '0000000000000000',
    faceCropJpeg: null,
    imageBrightness: r.quality.brightness,
  };
}

export function buildReferences(data: WebcamData, p: PipelineSpec): Reference[] {
  const groups = new Map<string, FrameRecord[]>();
  for (const r of data.records) {
    if (r.role !== 'enrol') continue;
    const k = `${r.identity}|${r.condition}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const refs: Reference[] = [];
  for (const frames of groups.values()) {
    const f0 = frames[0];
    const base = { identity: f0.identity, photoKey: f0.photoKey, family: f0.family, condition: f0.condition };
    if (p.scoring === 'legacy') {
      const res = buildReference(
        frames.map((f) => asAnalysis(f, p)),
        { ...DEFAULT_IDENTITY_THRESHOLDS, match: p.match, mismatch: p.mismatch },
      );
      refs.push({ ...base, ok: res.ok, embeddings: res.embeddings, template: res.ok ? templateFrom(res.embeddings) : null, selfSimilarity: null });
    } else {
      const usable = frames
        .map((f) => ({ f, q: p.quality(f), e: f.embeddings?.[p.embedding] }))
        .filter((x) => x.q.usable && x.e && Math.abs(x.q.yawDeg) <= REF_MAX_YAW)
        .map((x) => x.e!);
      const ok = usable.length >= p.enrolMin;
      let self: number | null = null;
      if (ok && usable.length >= 2) {
        const loo = usable.map((e, i) => cosineSimilarity(e, templateFrom(usable.filter((_, j) => j !== i))));
        self = loo.reduce((a, b) => a + b, 0) / loo.length;
      }
      refs.push({ ...base, ok, embeddings: ok ? usable : [], template: ok ? templateFrom(usable) : null, selfSimilarity: self });
    }
  }
  return refs;
}

/* ================================================================================ probes */

export interface Burst {
  key: string;
  photoKey: string;
  identity: string;
  family: string | null;
  condition: WebcamCondition;
  resolution: WebcamResolution;
  scene: number;
  frames: FrameRecord[];
}

export function probeBursts(data: WebcamData): Burst[] {
  const m = new Map<string, Burst>();
  for (const r of data.records) {
    if (r.role !== 'probe') continue;
    const key = `${r.photoKey}|${r.condition}|${r.resolution}|${r.scene}`;
    let b = m.get(key);
    if (!b) {
      b = { key, photoKey: r.photoKey, identity: r.identity, family: r.family, condition: r.condition, resolution: r.resolution, scene: r.scene, frames: [] };
      m.set(key, b);
    }
    b.frames.push(r);
  }
  for (const b of m.values()) b.frames.sort((a, c) => a.frame - c.frame);
  return [...m.values()];
}

export type TrialKind = 'genuine_same' | 'genuine_cross' | 'impostor' | 'impostor_family';

export function trialKind(ref: Pick<Reference, 'identity' | 'photoKey' | 'family'>, probe: Pick<Burst, 'identity' | 'photoKey' | 'family'>): TrialKind {
  if (ref.identity === probe.identity) return ref.photoKey === probe.photoKey ? 'genuine_same' : 'genuine_cross';
  return ref.family && ref.family === probe.family ? 'impostor_family' : 'impostor';
}

export function frameScore(p: PipelineSpec, e: Float32Array, ref: Reference): number {
  return p.scoring === 'legacy' ? maxSimilarity(e, ref.embeddings) : scoreAgainst(e, ref.embeddings);
}

export function label(p: PipelineSpec, usable: boolean, s: number | null): IdentityDecision {
  if (!usable || s == null) return 'unable_to_verify';
  return s >= p.match ? 'match' : s < p.mismatch ? 'mismatch' : 'inconclusive';
}

export interface FrameTrial {
  kind: TrialKind;
  /** `${refKey}|${probeKey}|${scene}`: frames of one burst against one reference. */
  burstKey: string;
  condition: WebcamCondition;
  resolution: WebcamResolution;
  enrol: WebcamCondition;
  usable: boolean;
  similarity: number | null;
  decision: IdentityDecision;
  bucket: QualityBucket | null;
  quality: FaceQuality;
}

export interface BurstTrial {
  kind: TrialKind;
  condition: WebcamCondition;
  resolution: WebcamResolution;
  enrol: WebcamCondition;
  refKey: string;
  probeKey: string;
  scene: number;
  usableFrames: number;
  similarity: number | null;
  /** Check outcome for these frames (legacy: aggregateFrames; template: template score vs labels). */
  decision: IdentityDecision;
  bucket: QualityBucket | null;
}

function modeBucket(bs: QualityBucket[]): QualityBucket | null {
  if (bs.length === 0) return null;
  const order: QualityBucket[] = ['poor', 'fair', 'good'];
  let best: QualityBucket = bs[0];
  let bestN = -1;
  for (const b of order) {
    const n = bs.filter((x) => x === b).length;
    if (n > bestN) {
      best = b;
      bestN = n;
    }
  }
  return best;
}

export interface TrialSet {
  refs: Reference[];
  frames: FrameTrial[];
  bursts: BurstTrial[];
}

/** Score every probe frame / burst against every successfully enrolled reference of the chosen enrolment conditions. */
export function scoreTrials(data: WebcamData, p: PipelineSpec, enrolConditions: readonly WebcamCondition[]): TrialSet {
  const refs = buildReferences(data, p).filter((r) => enrolConditions.includes(r.condition));
  const bursts = probeBursts(data);
  const bucketOf = p.bucket ?? ((q: FaceQuality) => qualityBucket(q));
  const frameT: FrameTrial[] = [];
  const burstT: BurstTrial[] = [];
  const thresholds = { ...DEFAULT_IDENTITY_THRESHOLDS, match: p.match, mismatch: p.mismatch };
  for (const b of bursts) {
    const fq = b.frames.map((f) => ({ f, q: p.quality(f), e: f.embeddings?.[p.embedding] ?? null }));
    const usable = fq.filter((x) => x.q.usable && x.e);
    const buckets = usable.map((x) => bucketOf(x.q));
    for (const ref of refs) {
      if (!ref.ok) continue;
      const kind = trialKind(ref, b);
      for (const x of fq) {
        const s = x.e ? frameScore(p, x.e, ref) : null;
        const ok = x.q.usable && x.e != null;
        frameT.push({ kind, burstKey: `${ref.identity}|${ref.condition}|${b.key}`, condition: b.condition, resolution: b.resolution, enrol: ref.condition, usable: ok, similarity: s, decision: label(p, ok, s), bucket: ok ? bucketOf(x.q) : null, quality: x.q });
      }
      let s: number | null = null;
      let decision: IdentityDecision;
      if (p.scoring === 'legacy') {
        const agg = aggregateFrames(
          fq.map((x) => asAnalysis(x.f, p)),
          ref.embeddings,
          thresholds,
        );
        s = agg.medianSimilarity;
        decision = agg.decision;
      } else {
        s = usable.length ? scoreAgainst(usable.map((x) => x.e!), ref.embeddings) : null;
        decision = label(p, usable.length > 0, s);
      }
      burstT.push({
        kind,
        condition: b.condition,
        resolution: b.resolution,
        enrol: ref.condition,
        refKey: `${ref.identity}|${ref.condition}`,
        probeKey: `${b.photoKey}|${b.condition}|${b.resolution}`,
        scene: b.scene,
        usableFrames: usable.length,
        similarity: s,
        decision,
        bucket: modeBucket(buckets),
      });
    }
  }
  return { refs, frames: frameT, bursts: burstT };
}

/* ================================================================================ summaries */

export interface Dist {
  n: number;
  min: number | null;
  p01: number | null;
  p05: number | null;
  median: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export function dist(values: number[]): Dist {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  const q = (x: number) => (s.length ? round3(s[Math.min(s.length - 1, Math.max(0, Math.round(x * (s.length - 1))))]) : null);
  return { n: s.length, min: q(0), p01: q(0.01), p05: q(0.05), median: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1) };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const pct = (a: number, b: number) => (b > 0 ? Math.round((1000 * a) / b) / 10 : null);

export interface DecisionRates {
  n: number;
  match: number | null;
  inconclusive: number | null;
  unable: number | null;
  mismatch: number | null;
  /** Similarity over usable trials (and over all trials with an embedding). */
  simUsable: Dist;
  simAll: Dist;
}

export function decisionRates(trials: readonly { decision: IdentityDecision; usable?: boolean; usableFrames?: number; similarity: number | null }[]): DecisionRates {
  const n = trials.length;
  const c = (d: IdentityDecision) => trials.filter((t) => t.decision === d).length;
  const usable = trials.filter((t) => (t.usable ?? (t.usableFrames ?? 0) > 0) && t.similarity != null);
  return {
    n,
    match: pct(c('match'), n),
    inconclusive: pct(c('inconclusive'), n),
    unable: pct(c('unable_to_verify'), n),
    mismatch: pct(c('mismatch'), n),
    simUsable: dist(usable.map((t) => t.similarity!)),
    simAll: dist(trials.filter((t) => t.similarity != null).map((t) => t.similarity!)),
  };
}

export interface ConditionTable {
  condition: string;
  genuineSame: DecisionRates;
  genuineCross: DecisionRates;
  impostor: DecisionRates;
  family: DecisionRates;
}

export function conditionTables<T extends { kind: TrialKind; condition: string; resolution: string; decision: IdentityDecision; similarity: number | null }>(
  trials: readonly T[],
  opts: { byResolution?: boolean } = {},
): ConditionTable[] {
  const groups: [string, (t: T) => boolean][] = [['all', () => true]];
  for (const c of WEBCAM_CONDITIONS) {
    groups.push([c, (t) => t.condition === c]);
    if (opts.byResolution) for (const r of ['640x480', '1280x720']) groups.push([`${c}@${r}`, (t) => t.condition === c && t.resolution === r]);
  }
  return groups.map(([name, f]) => {
    const g = trials.filter(f);
    return {
      condition: name,
      genuineSame: decisionRates(g.filter((t) => t.kind === 'genuine_same')),
      genuineCross: decisionRates(g.filter((t) => t.kind === 'genuine_cross')),
      impostor: decisionRates(g.filter((t) => t.kind === 'impostor' || t.kind === 'impostor_family')),
      family: decisionRates(g.filter((t) => t.kind === 'impostor_family')),
    };
  });
}

export function formatConditionTables(title: string, tables: ConditionTable[]): string {
  const f = (v: number | null) => (v == null ? '   -' : v.toFixed(1).padStart(5));
  const s = (v: number | null) => (v == null ? '   - ' : v.toFixed(2).padStart(5));
  const lines = [
    `\n${title}`,
    'condition          | genuine same-photo: n match incl unable MISM | genuine cross-photo: n match incl unable MISM | impostor: n mism incl unable MATCH | family: n mism incl unable MATCH | gen-x sim p05/med | imp sim p99/max | fam max',
  ];
  for (const t of tables) {
    const g = t.genuineSame;
    const x = t.genuineCross;
    const i = t.impostor;
    const fm = t.family;
    lines.push(
      `${t.condition.padEnd(18)} | ${String(g.n).padStart(6)} ${f(g.match)} ${f(g.inconclusive)} ${f(g.unable)} ${f(g.mismatch)} | ${String(x.n).padStart(6)} ${f(x.match)} ${f(x.inconclusive)} ${f(x.unable)} ${f(x.mismatch)} | ${String(i.n).padStart(6)} ${f(i.mismatch)} ${f(i.inconclusive)} ${f(i.unable)} ${f(i.match)} | ${String(fm.n).padStart(5)} ${f(fm.mismatch)} ${f(fm.inconclusive)} ${f(fm.unable)} ${f(fm.match)} | ${s(x.simUsable.p05)}/${s(x.simUsable.median)} | ${s(i.simUsable.p99)}/${s(i.simUsable.max)} | ${s(fm.simUsable.max)}`,
    );
  }
  return lines.join('\n');
}

/* ================================================================================ LLR model fit */

export interface BucketFit {
  bucket: QualityBucket;
  genuine: { n: number; mean: number; sd: number };
  impostor: { n: number; mean: number; sd: number };
}

function meanSd(v: number[]): { n: number; mean: number; sd: number } {
  const n = v.length;
  if (n === 0) return { n: 0, mean: NaN, sd: NaN };
  const m = v.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / Math.max(1, n - 1));
  return { n, mean: round3(m), sd: round3(sd) };
}

/** Gaussian fit of genuine (cross-photo unless `genuineKinds` says otherwise) and impostor burst similarities per bucket. */
export function fitBuckets(bursts: readonly BurstTrial[], genuineKinds: TrialKind[] = ['genuine_cross']): BucketFit[] {
  const out: BucketFit[] = [];
  for (const b of ['good', 'fair', 'poor'] as QualityBucket[]) {
    const g = bursts.filter((t) => t.bucket === b && genuineKinds.includes(t.kind) && t.similarity != null).map((t) => t.similarity!);
    const i = bursts.filter((t) => t.bucket === b && (t.kind === 'impostor' || t.kind === 'impostor_family') && t.similarity != null).map((t) => t.similarity!);
    out.push({ bucket: b, genuine: meanSd(g), impostor: meanSd(i) });
  }
  return out;
}

/* ================================================================================ sequential test simulation */

export interface SprtParams {
  suspect: number;
  confirm: number;
  clear: number;
  maxSamples: number;
  llrClamp: number;
}

export interface SamplingSchedule {
  /** Interval during the start-up window (s), window length (s), interval afterwards (s). */
  startupIntervalSec: number;
  startupWindowSec: number;
  intervalSec: number;
}

export const DEFAULT_SCHEDULE: SamplingSchedule = { startupIntervalSec: 6, startupWindowSec: 180, intervalSec: 15 };

/** Sample times (s) within `hours` of monitoring. */
export function sampleTimes(s: SamplingSchedule, hours = 1): number[] {
  const out: number[] = [];
  let t = 0;
  while (t < hours * 3600) {
    out.push(t);
    t += t < s.startupWindowSec ? s.startupIntervalSec : s.intervalSec;
  }
  return out;
}

/** Windowed accumulator exactly as documented in calibration.ts (`updateEvidence`). */
export function runAccumulator(llrs: Iterable<number>, sprt: SprtParams, start: number[] = []): { confirmAt: number | null; suspectAt: number | null } {
  const win: number[] = [...start];
  let i = 0;
  let suspectAt: number | null = null;
  for (const raw of llrs) {
    const l = Math.max(-sprt.llrClamp, Math.min(sprt.llrClamp, raw));
    win.push(l);
    if (win.length > sprt.maxSamples) win.shift();
    const sum = win.reduce((a, b) => a + b, 0);
    if (sum >= sprt.confirm) return { confirmAt: i, suspectAt: suspectAt ?? i };
    if (sum >= sprt.suspect && suspectAt == null) suspectAt = i;
    if (sum <= sprt.clear) win.length = 0;
    i++;
  }
  return { confirmAt: null, suspectAt };
}

export interface Session {
  key: string;
  kind: TrialKind;
  condition: WebcamCondition;
  resolution: WebcamResolution;
  enrol: WebcamCondition;
  bucket: QualityBucket;
  /** Fraction of this session's bursts with at least one usable frame. */
  usableRate: number;
  /** Similarities of the usable bursts (one per scene). */
  sims: number[];
}

/** Group burst trials into sessions: one reference x one probe photo x condition x resolution (scenes = samples). */
export function sessionsFrom(bursts: readonly BurstTrial[]): Session[] {
  const m = new Map<string, Session & { total: number; usable: number }>();
  for (const b of bursts) {
    const key = `${b.refKey}|${b.probeKey}`;
    let s = m.get(key);
    if (!s) {
      s = { key, kind: b.kind, condition: b.condition, resolution: b.resolution, enrol: b.enrol, bucket: 'good', usableRate: 0, sims: [], total: 0, usable: 0 };
      m.set(key, s);
    }
    s.total++;
    if (b.similarity == null || !b.bucket || b.usableFrames === 0) continue;
    s.usable++;
    s.sims.push(b.similarity);
    if (b.bucket === 'poor' || (b.bucket === 'fair' && s.bucket === 'good')) s.bucket = b.bucket;
  }
  return [...m.values()].map(({ total, usable, ...rest }) => ({ ...rest, usableRate: total ? usable / total : 0 }));
}

/**
 * Within-session sd of a sample (burst template) similarity per bucket, from FRAME noise: the pooled scatter of
 * usable frames around their burst mean (sigma_frame), divided by sqrt(frames per burst), plus a movement term
 * (pose / expression / position changes between samples) taken from good-light scene-to-scene scatter.
 * Scene-to-scene scatter in poor light also contains exposure / noise-level changes BETWEEN simulated scenes
 * (a different room), which overstates the variation between two samples of one candidate.
 */
export function withinSessionSdFromFrames(frames: readonly FrameTrial[], movementSd: number, framesPerBurst = 3): Record<QualityBucket, number> {
  const groups = new Map<string, FrameTrial[]>();
  for (const f of frames) {
    if (!f.usable || f.similarity == null || !f.bucket || !f.kind.startsWith('genuine')) continue;
    groups.set(f.burstKey, [...(groups.get(f.burstKey) ?? []), f]);
  }
  const acc: Record<QualityBucket, { ss: number; n: number }> = { good: { ss: 0, n: 0 }, fair: { ss: 0, n: 0 }, poor: { ss: 0, n: 0 } };
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const m = g.reduce((a, f) => a + f.similarity!, 0) / g.length;
    for (const f of g) {
      acc[f.bucket!].ss += (f.similarity! - m) ** 2;
      acc[f.bucket!].n += (g.length - 1) / g.length;
    }
  }
  const r = (b: QualityBucket) => {
    const sf = acc[b].n > 0 ? Math.sqrt(acc[b].ss / acc[b].n) : 0.05;
    return round3(Math.sqrt((sf * sf) / framesPerBurst + movementSd * movementSd));
  };
  return { good: r('good'), fair: r('fair'), poor: r('poor') };
}

/** Within-session sd of burst similarity per bucket, from sessions with >= 2 scenes (pooled). */
export function withinSessionSd(sessions: readonly Session[]): Record<QualityBucket, number> {
  const acc: Record<QualityBucket, { ss: number; n: number }> = { good: { ss: 0, n: 0 }, fair: { ss: 0, n: 0 }, poor: { ss: 0, n: 0 } };
  for (const s of sessions) {
    if (s.sims.length < 2) continue;
    const m = s.sims.reduce((a, b) => a + b, 0) / s.sims.length;
    for (const v of s.sims) acc[s.bucket].ss += (v - m) * (v - m);
    acc[s.bucket].n += s.sims.length - 1;
  }
  const r = (b: QualityBucket) => (acc[b].n > 0 ? round3(Math.sqrt(acc[b].ss / acc[b].n)) : 0.05);
  return { good: r('good'), fair: r('fair'), poor: r('poor') };
}

function gaussRng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => {
    let x = 0;
    while (x <= 1e-12) x = u();
    return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * u());
  };
}

export interface SequentialSimResult {
  sessions: number;
  runsPerSession: number;
  /** Genuine: expected false confirmed alarms (and suspect states) per 1000 candidate-hours. */
  falseConfirmPer1000h?: number;
  falseSuspectPer1000h?: number;
  /** Genuine: sessions with P(alarm within 1 h) > 0.5 (the dominating "bad sessions"), and their share. */
  badSessions?: number;
  /** Impostor: % detected within k samples, median / p90 samples to confirm, % never detected (within 40 samples). */
  detectedWithin?: Record<number, number>;
  medianSamples?: number | null;
  p90Samples?: number | null;
  /** Median / p90 seconds to confirm at the default schedule (swap at exam start). */
  medianSeconds?: number | null;
  p90Seconds?: number | null;
  notDetected?: number;
}

/** Decision rule of the sequential swap test under evaluation. */
export type SequentialRule =
  | { type: 'sprt'; llr: (s: number, b: QualityBucket) => number; params: SprtParams }
  /** Identity v1: `confirmations` consecutive per-sample mismatches (a match or unusable sample resets). */
  | { type: 'consecutive'; mismatch: number; confirmations: number };

/**
 * Monte-Carlo of a sequential swap rule. Each session's sample similarity is modelled as N(mean of the
 * session's observed usable bursts, within-session sd of its bucket), unusable with probability 1 - usableRate —
 * i.e. consecutive samples of one candidate share the same person / room / camera (strong correlation) and only
 * frame noise and small movements vary between samples.
 */
export function simulateSequential(
  sessions: readonly Session[],
  rule: SequentialRule,
  sdWithin: Record<QualityBucket, number>,
  opts: { mode: 'genuine' | 'impostor'; runs?: number; hours?: number; schedule?: SamplingSchedule; startSum?: number; seed?: number },
): SequentialSimResult {
  const runs = opts.runs ?? 100;
  const rng = gaussRng(opts.seed ?? 12345);
  let ua = (opts.seed ?? 12345) ^ 0x9e3779b9;
  const uni = () => {
    ua ^= ua << 13;
    ua ^= ua >>> 17;
    ua ^= ua << 5;
    return (ua >>> 0) / 4294967296;
  };
  const schedule = opts.schedule ?? DEFAULT_SCHEDULE;
  const times = sampleTimes(schedule, opts.mode === 'genuine' ? (opts.hours ?? 1) : 1);
  const n = opts.mode === 'genuine' ? times.length : 40;
  const runOne = (s: Session, mu: number): { confirmAt: number | null; suspectAt: number | null } => {
    if (rule.type === 'sprt') {
      const seq = (function* () {
        for (let i = 0; i < n; i++) yield uni() < s.usableRate && s.sims.length ? rule.llr(mu + rng() * sdWithin[s.bucket], s.bucket) : 0;
      })();
      const start = opts.startSum != null && opts.startSum !== 0 ? [opts.startSum] : [];
      return runAccumulator(seq, rule.params, start);
    }
    let streak = 0;
    for (let i = 0; i < n; i++) {
      const usable = uni() < s.usableRate && s.sims.length > 0;
      const sim = usable ? mu + rng() * sdWithin[s.bucket] : null;
      if (sim != null && sim < rule.mismatch) streak++;
      else streak = 0;
      if (streak >= rule.confirmations) return { confirmAt: i, suspectAt: i - rule.confirmations + 1 };
    }
    return { confirmAt: null, suspectAt: null };
  };
  if (opts.mode === 'genuine') {
    let confirms = 0;
    let suspects = 0;
    let bad = 0;
    for (const s of sessions) {
      const mu = s.sims.length ? s.sims.reduce((a, b) => a + b, 0) / s.sims.length : 0;
      let c = 0;
      for (let r = 0; r < runs; r++) {
        const res = runOne(s, mu);
        if (res.confirmAt != null) c++;
        if (res.suspectAt != null) suspects++;
      }
      confirms += c;
      if (c / runs > 0.5) bad++;
    }
    const hours = sessions.length * runs * (opts.hours ?? 1);
    return {
      sessions: sessions.length,
      runsPerSession: runs,
      falseConfirmPer1000h: Math.round(((1000 * confirms) / Math.max(1, hours)) * 1000) / 1000,
      falseSuspectPer1000h: Math.round(((1000 * suspects) / Math.max(1, hours)) * 1000) / 1000,
      badSessions: bad,
    };
  }
  const delays: number[] = [];
  let never = 0;
  for (const s of sessions) {
    const mu = s.sims.length ? s.sims.reduce((a, b) => a + b, 0) / s.sims.length : 0;
    for (let r = 0; r < runs; r++) {
      const res = runOne(s, mu);
      if (res.confirmAt == null) never++;
      else delays.push(res.confirmAt + 1);
    }
  }
  const total = sessions.length * runs;
  delays.sort((a, b) => a - b);
  const within: Record<number, number> = {};
  for (const k of [1, 2, 3, 4, 5, 8, 12, 20]) within[k] = Math.round((1000 * delays.filter((d) => d <= k).length) / Math.max(1, total)) / 10;
  const q = (x: number) => {
    const idx = Math.ceil(x * total) - 1;
    return idx < delays.length ? delays[Math.max(0, idx)] : null;
  };
  const sec = (k: number | null) => (k == null ? null : times[Math.min(times.length - 1, k - 1)]);
  const med = q(0.5);
  const p90 = q(0.9);
  return {
    sessions: sessions.length,
    runsPerSession: runs,
    detectedWithin: within,
    medianSamples: med,
    p90Samples: p90,
    medianSeconds: sec(med),
    p90Seconds: sec(p90),
    notDetected: Math.round((1000 * never) / Math.max(1, total)) / 10,
  };
}

/** LLR function from explicit bucket models (for what-if studies with candidate models). */
export function llrFromModels(models: Record<QualityBucket, BucketModel>, clamp: number, monotone = true): (s: number, b: QualityBucket) => number {
  return (s, b) => {
    const m = models[b];
    const x = monotone ? Math.min(s, m.genuine.mean) : s;
    const v = rawLLR(Math.max(x, monotone ? -1 : x), m);
    return Math.max(-clamp, Math.min(clamp, v));
  };
}

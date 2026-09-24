/**
 * Offline identity-accuracy harness.
 *
 * Measures, separately for every capture condition and synthetic perturbation:
 *   - false identity-mismatch rate (genuine probe => 'mismatch')  <- the critical number
 *   - false match rate (impostor probe => 'match' = a missed person swap)
 *   - inconclusive and unable-to-verify rates (routed to guidance / human review)
 *   - genuine / impostor similarity distributions, EER and ROC points
 *   - event-level estimates under the production confirmation rule.
 *
 * Datasets:
 *   folder: <dir>/<subject>/<cond>[+<cond>...]__<name>.<jpg|jpeg|png|webp>
 *           `reference` images (or the first image) enrol the subject; other images are genuine probes;
 *           every image of the other subjects is an impostor probe.
 *   pairs:  CSV "file_x,file_y,Decision" (Yes/No), deepface master.csv style; file_x enrols, file_y probes.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { DEFAULT_IDENTITY_THRESHOLDS, IDENTITY_DECISIONS, type IdentityDecision, type IdentityThresholds, type QualityIssue } from '@sp/shared';
import { buildReference, decideIdentity, scoreAgainst } from '../vision/identity';
import { QUALITY_GATE } from '../vision/quality';
import type { ImageAnalysis, VisionService } from '../vision/types';

/* =============================================================================== datasets */

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export interface EvalImage {
  /** Anonymised id, e.g. "s03/i02". */
  id: string;
  subject: string;
  conditions: string[];
  isReference: boolean;
  path: string;
}

export interface FolderDataset {
  subjects: string[];
  images: EvalImage[];
}

/** Parse "<cond>+<cond>__<name>.jpg" into condition tags ("unspecified" when there is no "__"). */
export function parseConditions(fileName: string): string[] {
  const stem = basename(fileName, extname(fileName));
  const at = stem.indexOf('__');
  if (at <= 0) return ['unspecified'];
  return stem
    .slice(0, at)
    .split('+')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
}

export function loadFolderDataset(dir: string, opts: { anonymize?: boolean } = {}): FolderDataset {
  const root = resolve(dir);
  const subjectDirs = readdirSync(root)
    .filter((d) => statSync(join(root, d)).isDirectory())
    .sort();
  const subjects: string[] = [];
  const images: EvalImage[] = [];
  subjectDirs.forEach((sd, si) => {
    const files = readdirSync(join(root, sd))
      .filter((f) => IMAGE_EXT.has(extname(f).toLowerCase()))
      .sort(naturalCompare);
    if (files.length === 0) return;
    const subject = opts.anonymize === false ? sd : `s${String(si + 1).padStart(2, '0')}`;
    subjects.push(subject);
    // Reference images first (then natural file order), so "i01" is always an enrolment image.
    const tagged = files
      .map((f) => ({ f, conditions: parseConditions(f) }))
      .sort((a, b) => Number(b.conditions.includes('reference')) - Number(a.conditions.includes('reference')));
    const hasRef = tagged.some((t) => t.conditions.includes('reference'));
    tagged.forEach((t, ii) => {
      images.push({
        id: opts.anonymize === false ? `${sd}/${t.f}` : `${subject}/i${String(ii + 1).padStart(2, '0')}`,
        subject,
        conditions: t.conditions.filter((c) => c !== 'reference'),
        isReference: hasRef ? t.conditions.includes('reference') : ii === 0,
        path: join(root, sd, t.f),
      });
    });
  });
  return { subjects, images };
}

export interface PairSpec {
  a: string;
  b: string;
  same: boolean;
}

/** Parse a deepface-style pairs CSV. Exact and reversed duplicates are removed. */
export function loadPairsCsv(csvPath: string): PairSpec[] {
  const lines = readFileSync(csvPath, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const header = lines[0].toLowerCase();
  const body = header.includes('decision') || header.includes('file') ? lines.slice(1) : lines;
  const seen = new Set<string>();
  const out: PairSpec[] = [];
  for (const line of body) {
    const [a, b, d] = line.split(',').map((s) => s.trim());
    if (!a || !b || !d) continue;
    const key = [a, b].sort().join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ a, b, same: /^(yes|true|1|same)$/i.test(d) });
  }
  return out;
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/* ========================================================================== perturbations */

export interface PerturbContext {
  /** Analysis of the unperturbed (normalised) image — landmarks for occlusion / crop. */
  analysis: ImageAnalysis;
}

export interface Perturbation {
  name: string;
  description: string;
  apply(image: Buffer, ctx: PerturbContext): Promise<Buffer | null>;
}

const JPEG_Q = 92;

async function rawOf(image: Buffer): Promise<{ data: Uint8Array; width: number; height: number }> {
  const { data, info } = await sharp(image).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

function encodeRaw(raw: { data: Uint8Array; width: number; height: number }, quality = JPEG_Q): Promise<Buffer> {
  return sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 3 } }).jpeg({ quality }).toBuffer();
}

async function mapPixels(image: Buffer, fn: (v: number, channel: number) => number): Promise<Buffer> {
  const raw = await rawOf(image);
  const lut = [0, 1, 2].map((c) => Uint8Array.from({ length: 256 }, (_, v) => Math.max(0, Math.min(255, Math.round(fn(v, c))))));
  for (let i = 0; i < raw.data.length; i++) raw.data[i] = lut[i % 3][raw.data[i]];
  return encodeRaw(raw);
}

/** Deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function addNoise(image: Buffer, sigma: number, seed = 1234): Promise<Buffer> {
  const raw = await rawOf(image);
  const rnd = prng(seed);
  for (let i = 0; i < raw.data.length; i += 2) {
    const u1 = Math.max(1e-12, rnd());
    const u2 = rnd();
    const r = Math.sqrt(-2 * Math.log(u1));
    const n1 = r * Math.cos(2 * Math.PI * u2) * sigma;
    const n2 = r * Math.sin(2 * Math.PI * u2) * sigma;
    raw.data[i] = Math.max(0, Math.min(255, Math.round(raw.data[i] + n1)));
    if (i + 1 < raw.data.length) raw.data[i + 1] = Math.max(0, Math.min(255, Math.round(raw.data[i + 1] + n2)));
  }
  return encodeRaw(raw);
}

async function lowRes(image: Buffer, width: number, quality = JPEG_Q): Promise<Buffer> {
  const meta = await sharp(image).metadata();
  const small = await sharp(image).resize({ width }).toBuffer();
  return sharp(small).resize(meta.width!, meta.height!, { fit: 'fill' }).jpeg({ quality }).toBuffer();
}

async function fillRect(image: Buffer, rect: { x0: number; y0: number; x1: number; y1: number }, rgb: [number, number, number], texture = 0): Promise<Buffer> {
  const raw = await rawOf(image);
  const rnd = prng(99);
  const x0 = Math.max(0, Math.floor(rect.x0));
  const y0 = Math.max(0, Math.floor(rect.y0));
  const x1 = Math.min(raw.width, Math.ceil(rect.x1));
  const y1 = Math.min(raw.height, Math.ceil(rect.y1));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * raw.width + x) * 3;
      const n = texture ? (rnd() - 0.5) * texture : 0;
      raw.data[p] = Math.max(0, Math.min(255, rgb[0] + n));
      raw.data[p + 1] = Math.max(0, Math.min(255, rgb[1] + n));
      raw.data[p + 2] = Math.max(0, Math.min(255, rgb[2] + n));
    }
  }
  return encodeRaw(raw);
}

function faceGeometry(a: ImageAnalysis) {
  const f = a.primary;
  if (!f) return null;
  const [le, re, nose, ml, mr] = f.landmarks;
  const iod = Math.hypot(re.x - le.x, re.y - le.y);
  return { box: f.box, le, re, nose, ml, mr, iod, mouthY: (ml.y + mr.y) / 2 };
}

export const PERTURBATIONS: Perturbation[] = [
  { name: 'dim', description: 'Dim room: brightness x0.35', apply: (b) => sharp(b).linear(0.35, 0).jpeg({ quality: JPEG_Q }).toBuffer() },
  { name: 'very_dark', description: 'Very dark: brightness x0.15', apply: (b) => sharp(b).linear(0.15, 0).jpeg({ quality: JPEG_Q }).toBuffer() },
  {
    name: 'low_light',
    description: 'Low light with auto-gain: brightness x0.5 plus sensor noise sigma=8',
    apply: async (b) => addNoise(await sharp(b).linear(0.5, 0).jpeg({ quality: JPEG_Q }).toBuffer(), 8, 4321),
  },
  { name: 'overexposed', description: 'Overexposed: x1.8 + 40', apply: (b) => sharp(b).linear(1.8, 40).jpeg({ quality: JPEG_Q }).toBuffer() },
  { name: 'gamma_dark', description: 'Gamma 2.0 (dark mid-tones, e.g. backlit)', apply: (b) => mapPixels(b, (v) => 255 * Math.pow(v / 255, 2.0)) },
  { name: 'gamma_bright', description: 'Gamma 0.5 (washed-out mid-tones)', apply: (b) => mapPixels(b, (v) => 255 * Math.pow(v / 255, 0.5)) },
  { name: 'blur_s2', description: 'Gaussian blur sigma=2 (out of focus / motion)', apply: (b) => sharp(b).blur(2).jpeg({ quality: JPEG_Q }).toBuffer() },
  { name: 'blur_s4', description: 'Gaussian blur sigma=4 (badly out of focus)', apply: (b) => sharp(b).blur(4).jpeg({ quality: JPEG_Q }).toBuffer() },
  { name: 'jpeg_q15', description: 'Heavy JPEG compression q=15 (poor bandwidth)', apply: (b) => sharp(b).jpeg({ quality: 15 }).toBuffer() },
  { name: 'lowres_160', description: 'Low-resolution camera: 160 px wide, upscaled back', apply: (b) => lowRes(b, 160) },
  { name: 'noise', description: 'Sensor noise, Gaussian sigma=12', apply: (b) => addNoise(b, 12) },
  { name: 'warm_cast', description: 'Warm colour cast (tungsten light)', apply: (b) => mapPixels(b, (v, c) => v * [1.15, 1.0, 0.75][c]) },
  { name: 'cool_cast', description: 'Cool colour cast (daylight / LED)', apply: (b) => mapPixels(b, (v, c) => v * [0.8, 1.0, 1.15][c]) },
  {
    name: 'occlusion_mask',
    description: 'Lower face covered (face mask) from mid-nose down',
    apply: async (b, { analysis }) => {
      const g = faceGeometry(analysis);
      if (!g) return null;
      const top = (g.le.y + g.re.y) / 2 + 0.55 * (g.nose.y - (g.le.y + g.re.y) / 2);
      return fillRect(b, { x0: g.box.x - 0.05 * g.box.w, y0: top, x1: g.box.x + 1.05 * g.box.w, y1: g.box.y + 1.1 * g.box.h }, [170, 200, 225], 10);
    },
  },
  {
    name: 'occlusion_hand',
    description: 'Hand over mouth and chin',
    apply: async (b, { analysis }) => {
      const g = faceGeometry(analysis);
      if (!g) return null;
      return fillRect(b, { x0: g.ml.x - 0.6 * g.iod, y0: g.nose.y + 0.25 * g.iod, x1: g.mr.x + 0.6 * g.iod, y1: g.mouthY + 1.1 * g.iod }, [205, 160, 135], 18);
    },
  },
  {
    name: 'crop_cut',
    description: 'Face partly outside the frame (cut at the nose)',
    apply: async (b, { analysis }) => {
      const g = faceGeometry(analysis);
      if (!g) return null;
      const width = Math.max(8, Math.round(g.nose.x));
      const meta = await sharp(b).metadata();
      return sharp(b).extract({ left: 0, top: 0, width: Math.min(width, meta.width!), height: meta.height! }).jpeg({ quality: JPEG_Q }).toBuffer();
    },
  },
  {
    name: 'camera_b',
    description: 'Different camera: low-end webcam (320 px, noise, cool cast, JPEG q=40)',
    apply: async (b) => {
      const cast = await mapPixels(b, (v, c) => v * [0.88, 1.0, 1.08][c]);
      const noisy = await addNoise(cast, 6, 77);
      return lowRes(noisy, 320, 40);
    },
  },
  {
    name: 'camera_c',
    description: 'Different camera: phone in warm indoor light (warm cast, gamma 0.8, slight blur, JPEG q=60)',
    apply: async (b) => {
      const warm = await mapPixels(b, (v, c) => 255 * Math.pow(Math.min(1, (v * [1.1, 1.0, 0.82][c]) / 255), 0.8));
      return sharp(warm).blur(1).jpeg({ quality: 60 }).toBuffer();
    },
  },
];

/* ================================================================================ trials */

export interface Trial {
  kind: 'genuine' | 'impostor';
  /** Condition tags of the probe, or "perturb:<name>", plus "all" for clean trials. */
  groups: string[];
  similarity: number | null;
  decision: IdentityDecision;
  usable: boolean;
  issues: QualityIssue[];
}

export interface Distribution {
  n: number;
  min: number | null;
  p05: number | null;
  median: number | null;
  p95: number | null;
  max: number | null;
}

export interface OutcomeRates {
  n: number;
  match: number;
  mismatch: number;
  inconclusive: number;
  unable_to_verify: number;
  rates: Record<IdentityDecision, number>;
}

export interface EventEstimates {
  /** Assumption stated in the report. */
  assumption: string;
  intervalSec: number;
  confirmations: number;
  samplesPerHour: number;
  /** Expected false identity_mismatch events per candidate-hour, samples independent. */
  falseMismatchEventsPerHourIndependent: number;
  /** If the cause of a genuine mismatch persists (samples perfectly correlated) the event opens once: probability per session. */
  falseMismatchEventProbabilityCorrelated: number;
  /** Probability that a swap raises identity_mismatch within N periodic samples. */
  swapDetectedWithin: { samples: number; minutes: number; probability: number }[];
  /** Probability that a swap is flagged at all (identity_mismatch, or identity_unverifiable after 3 non-matching samples) within N samples. */
  swapFlaggedWithin: { samples: number; minutes: number; probability: number }[];
  expectedMinutesToSwapDetection: number | null;
  /** Resume / reconnect check aggregating `frames` probe frames (aggregateFrames rule), frames independent. */
  resumeCheck: {
    frames: number;
    genuine: Record<IdentityDecision, number>;
    impostor: Record<IdentityDecision, number>;
  };
}

export interface GroupReport {
  group: string;
  description?: string;
  genuine: OutcomeRates & {
    /** THE critical number: genuine probes decided 'mismatch'. */
    falseMismatchRate: number;
    /** Same, among probes that passed the quality gate. */
    falseMismatchRateUsable: number;
    similarity: Distribution;
    /** Similarity of probes that passed the quality gate (the ones decisions are made on). */
    similarityUsable: Distribution;
  };
  impostor: OutcomeRates & {
    /** Impostor probes decided 'match' (missed swap). */
    falseMatchRate: number;
    /** Impostor probes decided 'mismatch' (swap detected per sample). */
    detectionRate: number;
    similarity: Distribution;
    similarityUsable: Distribution;
  };
  /** Most frequent quality issues among genuine probes that were unable_to_verify. */
  topIssues: { issue: QualityIssue; count: number }[];
  eer: { eer: number; threshold: number } | null;
  roc: { threshold: number; fmr: number; fnmr: number }[];
  events: EventEstimates;
}

export interface EvalReport {
  generatedAt: string;
  tool: string;
  mode: 'folder' | 'pairs';
  model: { detector: string; embedder: string };
  thresholds: IdentityThresholds;
  qualityGate: typeof QUALITY_GATE;
  normalisation: string;
  dataset: {
    subjects: number | null;
    images: number;
    enrolled: number;
    enrolmentFailures: number;
    genuineTrials: number;
    impostorTrials: number;
    pairs?: { same: number; different: number; skippedNoFace: number };
  };
  perturbations: { name: string; description: string }[];
  groups: GroupReport[];
  notes: string[];
}

/* ================================================================================ metrics */

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const r4 = (v: number | null) => (v == null ? null : Math.round(v * 10000) / 10000);

export function distribution(values: number[]): Distribution {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, min: r4(s[0] ?? null), p05: r4(quantile(s, 0.05)), median: r4(quantile(s, 0.5)), p95: r4(quantile(s, 0.95)), max: r4(s[s.length - 1] ?? null) };
}

export function outcomeRates(trials: Trial[]): OutcomeRates {
  const n = trials.length;
  const counts = Object.fromEntries(IDENTITY_DECISIONS.map((d) => [d, trials.filter((t) => t.decision === d).length])) as Record<IdentityDecision, number>;
  const rates = Object.fromEntries(IDENTITY_DECISIONS.map((d) => [d, n ? r4(counts[d] / n)! : 0])) as Record<IdentityDecision, number>;
  return { n, ...counts, rates };
}

/** Equal error rate over raw similarities (quality gate ignored). */
export function computeEer(genuine: number[], impostor: number[]): { eer: number; threshold: number } | null {
  if (genuine.length === 0 || impostor.length === 0) return null;
  const cands = [...new Set([...genuine, ...impostor])].sort((a, b) => a - b);
  let best = { eer: 1, threshold: 0, gap: Infinity };
  for (const t of cands) {
    const fnmr = genuine.filter((s) => s < t).length / genuine.length;
    const fmr = impostor.filter((s) => s >= t).length / impostor.length;
    const gap = Math.abs(fnmr - fmr);
    if (gap < best.gap || (gap === best.gap && (fnmr + fmr) / 2 < best.eer)) best = { eer: (fnmr + fmr) / 2, threshold: t, gap };
  }
  return { eer: r4(best.eer)!, threshold: r4(best.threshold)! };
}

export function rocPoints(genuine: number[], impostor: number[], thresholds: number[]): { threshold: number; fmr: number; fnmr: number }[] {
  return thresholds.map((t) => ({
    threshold: t,
    fmr: impostor.length ? r4(impostor.filter((s) => s >= t).length / impostor.length)! : 0,
    fnmr: genuine.length ? r4(genuine.filter((s) => s < t).length / genuine.length)! : 0,
  }));
}

/**
 * Distribution of the aggregateFrames() decision for `m` independent frames whose per-frame outcomes
 * follow `p` (exact enumeration over the 4^m outcome combinations).
 */
export function aggregateOutcomeProbabilities(p: Record<IdentityDecision, number>, m: number): Record<IdentityDecision, number> {
  const decisions = IDENTITY_DECISIONS;
  const out: Record<IdentityDecision, number> = { match: 0, mismatch: 0, inconclusive: 0, unable_to_verify: 0 };
  const need = Math.max(1, Math.min(2, m));
  const total = Math.pow(decisions.length, m);
  for (let code = 0; code < total; code++) {
    let c = code;
    let prob = 1;
    let match = 0;
    let mismatch = 0;
    let usable = 0;
    for (let k = 0; k < m; k++) {
      const d = decisions[c % decisions.length];
      c = Math.floor(c / decisions.length);
      prob *= p[d];
      if (d === 'match') match++;
      if (d === 'mismatch') mismatch++;
      if (d !== 'unable_to_verify') usable++;
    }
    if (prob === 0) continue;
    const decision: IdentityDecision = usable === 0 ? 'unable_to_verify' : match >= need ? 'match' : mismatch >= need && match === 0 ? 'mismatch' : 'inconclusive';
    out[decision] += prob;
  }
  for (const d of decisions) out[d] = r4(out[d])!;
  return out;
}

export function eventEstimates(
  genuineRates: Record<IdentityDecision, number>,
  impostorRates: Record<IdentityDecision, number>,
  opts: { intervalSec?: number; confirmations?: number; unverifiableAfter?: number; resumeFrames?: number } = {},
): EventEstimates {
  const intervalSec = opts.intervalSec ?? 30;
  const k = Math.max(1, opts.confirmations ?? DEFAULT_IDENTITY_THRESHOLDS.mismatchConfirmations);
  const u = Math.max(1, opts.unverifiableAfter ?? 3);
  const m = opts.resumeFrames ?? 3;
  const samplesPerHour = 3600 / intervalSec;
  const pg = genuineRates.mismatch;
  const qm = impostorRates.mismatch;
  const qu = impostorRates.inconclusive + impostorRates.unable_to_verify;
  const Ns = [1, 2, 4, 10, 20];
  const perTrialDetect = Math.pow(qm, k);
  const perTrialFlag = Math.min(1, perTrialDetect + Math.pow(qu, u));
  return {
    assumption:
      'Consecutive samples are treated as independent draws from the per-sample outcome rates measured for this group. Real samples of one ' +
      'candidate are positively correlated (same room, camera, lighting), so the independent figures are optimistic for false alerts and ' +
      'the correlated bound is shown alongside. A follow-up sample is requested immediately after a mismatch, so a confirmed event needs ' +
      `${k} consecutive mismatches.`,
    intervalSec,
    confirmations: k,
    samplesPerHour,
    falseMismatchEventsPerHourIndependent: sig(samplesPerHour * Math.pow(pg, k)),
    falseMismatchEventProbabilityCorrelated: r4(pg)!,
    swapDetectedWithin: Ns.map((n) => ({ samples: n, minutes: (n * intervalSec) / 60, probability: r4(1 - Math.pow(1 - perTrialDetect, n))! })),
    swapFlaggedWithin: Ns.map((n) => ({ samples: n, minutes: (n * intervalSec) / 60, probability: r4(1 - Math.pow(1 - perTrialFlag, n))! })),
    expectedMinutesToSwapDetection: perTrialDetect > 0 ? Math.round(((intervalSec / 60) * 10) / perTrialDetect) / 10 : null,
    resumeCheck: {
      frames: m,
      genuine: aggregateOutcomeProbabilities(genuineRates, m),
      impostor: aggregateOutcomeProbabilities(impostorRates, m),
    },
  };
}

function sig(v: number): number {
  if (v === 0) return 0;
  return Number(v.toPrecision(3));
}

export const ROC_THRESHOLDS = [0.2, 0.24, 0.28, 0.3, 0.32, 0.36, 0.4, 0.45, 0.5, 0.55, 0.6];

export function groupReport(group: string, trials: Trial[], opts: { description?: string; intervalSec?: number; confirmations?: number } = {}): GroupReport {
  const gen = trials.filter((t) => t.kind === 'genuine');
  const imp = trials.filter((t) => t.kind === 'impostor');
  const g = outcomeRates(gen);
  const i = outcomeRates(imp);
  const sims = (list: Trial[]) => list.map((t) => t.similarity).filter((s): s is number => s != null);
  const genSims = sims(gen);
  const impSims = sims(imp);
  const usableGen = gen.filter((t) => t.usable).length;
  const issueCounts = new Map<QualityIssue, number>();
  for (const t of gen) if (t.decision === 'unable_to_verify') for (const is of t.issues) issueCounts.set(is, (issueCounts.get(is) ?? 0) + 1);
  return {
    group,
    description: opts.description,
    genuine: {
      ...g,
      falseMismatchRate: g.rates.mismatch,
      falseMismatchRateUsable: usableGen ? r4(g.mismatch / usableGen)! : 0,
      similarity: distribution(genSims),
      similarityUsable: distribution(sims(gen.filter((t) => t.usable))),
    },
    impostor: {
      ...i,
      falseMatchRate: i.rates.match,
      detectionRate: i.rates.mismatch,
      similarity: distribution(impSims),
      similarityUsable: distribution(sims(imp.filter((t) => t.usable))),
    },
    topIssues: [...issueCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([issue, count]) => ({ issue, count })),
    eer: computeEer(genSims, impSims),
    roc: rocPoints(genSims, impSims, ROC_THRESHOLDS),
    events: eventEstimates(g.rates, i.rates, { intervalSec: opts.intervalSec, confirmations: opts.confirmations }),
  };
}

/* ================================================================================ running */

export interface EvalOptions {
  thresholds?: IdentityThresholds;
  /** Resize every image so its longer side is at most this (default 640, like a webcam frame); 0 = keep. */
  size?: number;
  perturb?: boolean;
  /** Restrict perturbations by name. */
  perturbations?: string[];
  intervalSec?: number;
  anonymize?: boolean;
  onProgress?: (msg: string) => void;
}

const DEFAULT_SIZE = 640;

export async function normaliseImage(buf: Buffer, size: number): Promise<Buffer> {
  const img = sharp(buf).rotate();
  const out = size > 0 ? img.resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true }) : img;
  return out.jpeg({ quality: JPEG_Q }).toBuffer();
}

class AnalysisCache {
  private readonly map = new Map<string, Promise<ImageAnalysis | null>>();
  private readonly buffers = new Map<string, Promise<Buffer>>();
  constructor(
    private readonly vision: VisionService,
    private readonly size: number,
  ) {}
  base(path: string): Promise<Buffer> {
    let b = this.buffers.get(path);
    if (!b) {
      b = normaliseImage(readFileSync(path), this.size);
      this.buffers.set(path, b);
    }
    return b;
  }
  get(path: string, perturbation: Perturbation | null): Promise<ImageAnalysis | null> {
    const key = `${perturbation?.name ?? 'clean'}\u0000${path}`;
    let p = this.map.get(key);
    if (!p) {
      p = (async () => {
        const base = await this.base(path);
        if (!perturbation) return this.vision.analyze(base, { embed: true });
        const clean = await this.get(path, null);
        if (!clean) return null;
        const img = await perturbation.apply(base, { analysis: clean });
        return img ? this.vision.analyze(img, { embed: true }) : null;
      })().catch(() => null);
      this.map.set(key, p);
    }
    return p;
  }
}

function makeTrial(kind: Trial['kind'], groups: string[], probe: ImageAnalysis, refs: Float32Array[], thresholds: IdentityThresholds): Trial {
  // Same score as production (identity v2): probe vs the template of the reference embeddings.
  const sim = probe.embedding && refs.length ? scoreAgainst(probe.embedding, refs) : null;
  const d = decideIdentity(sim, probe.quality, thresholds, 'reference');
  return { kind, groups, similarity: sim, decision: d.decision, usable: probe.quality.usable && sim != null, issues: probe.quality.issues };
}

function selectedPerturbations(opts: EvalOptions): Perturbation[] {
  if (!opts.perturb) return [];
  return opts.perturbations?.length ? PERTURBATIONS.filter((p) => opts.perturbations!.includes(p.name)) : PERTURBATIONS;
}

function baseReport(mode: EvalReport['mode'], thresholds: IdentityThresholds, size: number, perts: Perturbation[]): Omit<EvalReport, 'dataset' | 'groups' | 'notes'> {
  return {
    generatedAt: new Date().toISOString(),
    tool: 'apps/server/src/eval/identity-eval.ts',
    mode,
    model: { detector: 'YuNet face_detection_yunet_2023mar (MIT)', embedder: 'SFace face_recognition_sface_2021dec (Apache-2.0), 128-d, cosine' },
    thresholds,
    qualityGate: QUALITY_GATE,
    normalisation: size > 0 ? `images resized to max side ${size} px and re-encoded as JPEG q=${JPEG_Q} before analysis (webcam-like)` : 'images analysed at original size',
    perturbations: perts.map((p) => ({ name: p.name, description: p.description })),
  };
}

function assembleGroups(trials: Trial[], perts: Perturbation[], opts: EvalOptions, thresholds: IdentityThresholds): GroupReport[] {
  const names = new Set<string>();
  for (const t of trials) for (const g of t.groups) names.add(g);
  const order = (g: string) => (g === 'all' ? 0 : g.startsWith('perturb:') ? 2 : 1);
  return [...names]
    .sort((a, b) => order(a) - order(b) || naturalCompare(a, b))
    .map((g) =>
      groupReport(
        g,
        trials.filter((t) => t.groups.includes(g)),
        {
          description: g === 'all' ? 'All unperturbed probes' : perts.find((p) => `perturb:${p.name}` === g)?.description,
          intervalSec: opts.intervalSec,
          confirmations: thresholds.mismatchConfirmations,
        },
      ),
    );
}

/** Folder dataset: enrol each subject from its reference image(s), probe with everything else. */
export async function runFolderEval(vision: VisionService, dir: string, opts: EvalOptions = {}): Promise<EvalReport> {
  const thresholds = opts.thresholds ?? DEFAULT_IDENTITY_THRESHOLDS;
  const size = opts.size ?? DEFAULT_SIZE;
  const perts = selectedPerturbations(opts);
  const ds = loadFolderDataset(dir, { anonymize: opts.anonymize });
  const cache = new AnalysisCache(vision, size);
  const log = opts.onProgress ?? (() => {});

  // Enrolment.
  const refs = new Map<string, Float32Array[]>();
  let enrolmentFailures = 0;
  for (const subject of ds.subjects) {
    const refImages = ds.images.filter((im) => im.subject === subject && im.isReference);
    const analyses = (await Promise.all(refImages.map((im) => cache.get(im.path, null)))).filter((a): a is ImageAnalysis => a != null);
    let embeddings: Float32Array[] = [];
    if (analyses.length >= 3) {
      const built = buildReference(analyses, thresholds);
      if (built.ok) embeddings = built.embeddings;
    }
    if (embeddings.length === 0) embeddings = analyses.filter((a) => a.quality.usable && a.embedding).map((a) => a.embedding!);
    if (embeddings.length === 0) {
      enrolmentFailures++;
      log(`enrolment failed for ${subject}`);
      continue;
    }
    refs.set(subject, embeddings);
  }

  const trials: Trial[] = [];
  const variants: (Perturbation | null)[] = [null, ...perts];
  for (const variant of variants) {
    log(`analysing ${variant ? variant.name : 'clean'} probes`);
    for (const probe of ds.images) {
      const analysis = await cache.get(probe.path, variant);
      if (!analysis) continue;
      const genuineGroups = variant ? [`perturb:${variant.name}`] : ['all', ...probe.conditions];
      for (const [subject, embeddings] of refs) {
        if (subject === probe.subject) {
          if (probe.isReference) continue; // never compare a reference image with itself
          trials.push(makeTrial('genuine', genuineGroups, analysis, embeddings, thresholds));
        } else {
          trials.push(makeTrial('impostor', variant ? [`perturb:${variant.name}`] : ['all', ...probe.conditions], analysis, embeddings, thresholds));
        }
      }
    }
  }

  const clean = trials.filter((t) => t.groups.includes('all'));
  return {
    ...baseReport('folder', thresholds, size, perts),
    dataset: {
      subjects: ds.subjects.length,
      images: ds.images.length,
      enrolled: refs.size,
      enrolmentFailures,
      genuineTrials: clean.filter((t) => t.kind === 'genuine').length,
      impostorTrials: clean.filter((t) => t.kind === 'impostor').length,
    },
    groups: assembleGroups(trials, perts, opts, thresholds),
    notes: [
      'Genuine trials: each non-reference image vs its own subject reference. Impostor trials: every image vs every other subject reference.',
      'Condition groups come from the file-name tags; a probe with several tags counts in each of them.',
    ],
  };
}

/** Pairs CSV: file_x enrols (single-image reference), file_y is the probe. */
export async function runPairsEval(vision: VisionService, csvPath: string, imagesDir: string | null, opts: EvalOptions = {}): Promise<EvalReport> {
  const thresholds = opts.thresholds ?? DEFAULT_IDENTITY_THRESHOLDS;
  const size = opts.size ?? DEFAULT_SIZE;
  const perts = selectedPerturbations(opts);
  const pairs = loadPairsCsv(csvPath);
  const dir = imagesDir ?? dirname(resolve(csvPath));
  const cache = new AnalysisCache(vision, size);
  const log = opts.onProgress ?? (() => {});
  const images = new Set<string>();
  const trials: Trial[] = [];
  let skipped = 0;
  const variants: (Perturbation | null)[] = [null, ...perts];
  for (const variant of variants) {
    log(`analysing ${variant ? variant.name : 'clean'} pairs`);
    for (const pair of pairs) {
      const pa = join(dir, pair.a);
      const pb = join(dir, pair.b);
      images.add(pa);
      images.add(pb);
      // A pair is unordered: enrol whichever image passes the quality gate (file_x preferred).
      let probePath = pb;
      let ref = await cache.get(pa, null);
      if (!ref || !ref.embedding || !ref.quality.usable) {
        const alt = await cache.get(pb, null);
        if (alt && alt.embedding && alt.quality.usable) {
          ref = alt;
          probePath = pa;
        }
      }
      if (!ref || !ref.embedding || !ref.quality.usable) {
        if (!variant) skipped++;
        continue;
      }
      const probe = await cache.get(probePath, variant);
      if (!probe) continue;
      trials.push(makeTrial(pair.same ? 'genuine' : 'impostor', variant ? [`perturb:${variant.name}`] : ['all'], probe, [ref.embedding], thresholds));
    }
  }
  const clean = trials.filter((t) => t.groups.includes('all'));
  return {
    ...baseReport('pairs', thresholds, size, perts),
    dataset: {
      subjects: null,
      images: images.size,
      enrolled: pairs.length - skipped,
      enrolmentFailures: skipped,
      genuineTrials: clean.filter((t) => t.kind === 'genuine').length,
      impostorTrials: clean.filter((t) => t.kind === 'impostor').length,
      pairs: { same: pairs.filter((p) => p.same).length, different: pairs.filter((p) => !p.same).length, skippedNoFace: skipped },
    },
    groups: assembleGroups(trials, perts, opts, thresholds),
    notes: [
      'Each pair enrols one image as a single-image reference (file_x, or file_y if file_x fails the quality gate; pairs where neither passes are enrolment failures) and probes with the other.',
    ],
  };
}

/* ============================================================================== formatting */

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

export function formatReport(report: EvalReport): string {
  const out: string[] = [];
  const t = report.thresholds;
  out.push(`Identity accuracy — ${report.mode} mode — ${report.generatedAt}`);
  out.push(`Thresholds: match >= ${t.match}, mismatch < ${t.mismatch}, confirmations ${t.mismatchConfirmations}. ${report.normalisation}.`);
  const d = report.dataset;
  out.push(
    `Dataset: ${d.subjects ?? '-'} subjects, ${d.images} images, ${d.genuineTrials} genuine / ${d.impostorTrials} impostor clean trials, ${d.enrolmentFailures} enrolment failures.`,
  );
  out.push('');
  out.push(
    table(
      ['group', 'gen n', 'match', 'inconcl', 'unable', 'FALSE MISMATCH', 'imp n', 'FALSE MATCH', 'swap det.', 'inconcl', 'unable', 'gen usable min/med', 'imp usable med/max', 'EER'],
      report.groups.map((g) => [
        g.group,
        String(g.genuine.n),
        pct(g.genuine.rates.match),
        pct(g.genuine.rates.inconclusive),
        pct(g.genuine.rates.unable_to_verify),
        pct(g.genuine.falseMismatchRate),
        String(g.impostor.n),
        pct(g.impostor.falseMatchRate),
        pct(g.impostor.detectionRate),
        pct(g.impostor.rates.inconclusive),
        pct(g.impostor.rates.unable_to_verify),
        `${fmt(g.genuine.similarityUsable.min)}/${fmt(g.genuine.similarityUsable.median)}`,
        `${fmt(g.impostor.similarityUsable.median)}/${fmt(g.impostor.similarityUsable.max)}`,
        g.eer ? pct(g.eer.eer) : '-',
      ]),
    ),
  );
  const all = report.groups.find((g) => g.group === 'all');
  if (all) {
    const e = all.events;
    out.push('');
    out.push(`Event-level estimates (clean images, ${e.intervalSec}s periodic samples, ${e.confirmations} confirmations; ${e.assumption})`);
    out.push(`  false identity_mismatch events per candidate-hour (independent samples): ${e.falseMismatchEventsPerHourIndependent}`);
    out.push(`  ... if the cause persists (fully correlated samples), probability a session gets one: ${pct(e.falseMismatchEventProbabilityCorrelated)}`);
    out.push(`  swap detected (identity_mismatch) within: ${e.swapDetectedWithin.map((s) => `${s.minutes} min ${pct(s.probability)}`).join(', ')}`);
    out.push(`  swap flagged (mismatch or unverifiable) within: ${e.swapFlaggedWithin.map((s) => `${s.minutes} min ${pct(s.probability)}`).join(', ')}`);
    out.push(
      `  resume check (${e.resumeCheck.frames} frames): genuine => mismatch ${pct(e.resumeCheck.genuine.mismatch)}, match ${pct(e.resumeCheck.genuine.match)}; impostor => match ${pct(e.resumeCheck.impostor.match)}, mismatch ${pct(e.resumeCheck.impostor.mismatch)}`,
    );
  }
  return out.join('\n');
}

const fmt = (v: number | null) => (v == null ? '-' : v.toFixed(2));

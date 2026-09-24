/**
 * Runs the vision agent's webcam identity harness (apps/server/src/eval/webcam-eval.ts + webcam-report.ts, the code
 * behind `pnpm --filter @sp/server eval:identity -- --webcam`) with a DIFFERENT recogniser model, without touching
 * apps/server/src/vision/**:
 *
 *   tsx tools/recognizer/ts/harness.mts --model <onnx> --tag <name> [--recipe v2|flip|raw|v2-plain] [--shards 2]
 *        [--refit <fits.json>] [--runs 100] [--out report.json] [--summary summary.json]
 *
 * - The model is placed (symlinked) as face_recognition_sface_2021dec.onnx in $RECOG_WORK/harness/models-<sha>/ next
 *   to the production YuNet, and passed as `modelsDir` to createVisionService (same engine, same quality gate,
 *   low-light detection pass, alignment, embed-prep recipe, template scoring).
 * - The harness's analysis cache key does not include the model, so a model-specific `engineTag`
 *   (`rec:<tag>:<sha12>:<recipe>`) keeps each model's analyses separate; the rendered frames are shared.
 * - --recipe: v2 (production RECIPE_V2: flip TTA for good/fair, 3x3 denoise for poor frames), v2-plain (flip TTA for
 *   every bucket, no denoise), flip (= v2-plain), raw (RECIPE_V1, single view).
 * - --refit <fits.json>: before any LLR is computed, BUCKET_MODELS are replaced by this model's own per-bucket Gaussian
 *   fits ({good|fair|poor: {genuine:{mean,sd}, impostor:{mean,sd}}}, sd x 1.15 as identity-v2 §6.2 did), i.e. the
 *   decision layer is recalibrated for the model. Use the `fits` written to --summary by a first (unrefit) run.
 *   Everything else in CALIBRATION (SPRT thresholds, frame thresholds, drift model) is left as shipped.
 * - --summary: compact before/after numbers: enrolment per condition, engine check outcomes (3 / 6 frames) per
 *   condition, bucket fits, empirical EER / d' per bucket and per probe condition (burst template vs good/typical
 *   enrolment, genuine = other photo, impostors incl. family), sequential-test detection per condition, and the
 *   MATCHED-DEGRADATION case (reference enrolled in dim / backlit light vs probes in the same condition; bursts and
 *   single frames; all resolutions and 480p): the impostor-inflation risk.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { RECIPE_V1, RECIPE_V2, type EmbeddingRecipe } from '../../../apps/server/src/vision/embed-prep.ts';
import { createVisionService } from '../../../apps/server/src/vision/service.ts';
import { BUCKET_MODELS } from '../../../apps/server/src/vision/calibration.ts';
import type { VisionService } from '../../../apps/server/src/vision/types.ts';
import { defaultFacesetsDir } from '../../../apps/server/src/eval/datasets.ts';
import { buildWebcamData } from '../../../apps/server/src/eval/webcam-eval.ts';
import { buildWebcamReport, currentPipeline } from '../../../apps/server/src/eval/webcam-report.ts';
import { fitBuckets, scoreTrials } from '../../../apps/server/src/eval/webcam-metrics.ts';
import { loadEngineHooks } from '../../../apps/server/src/eval/webcam-cli.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const work = process.env.RECOG_WORK ?? '/tmp/claude-0/recognizer';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    model: { type: 'string', default: join(repo, 'apps/server/models/face_recognition_sface_2021dec.onnx') },
    tag: { type: 'string', default: 'base' },
    recipe: { type: 'string', default: 'v2' },
    shards: { type: 'string', default: '2' },
    shard: { type: 'string' },
    'build-only': { type: 'boolean', default: false },
    refit: { type: 'string' },
    runs: { type: 'string', default: '100' },
    out: { type: 'string' },
    summary: { type: 'string' },
    facesets: { type: 'string' },
  },
});

const RECIPES: Record<string, EmbeddingRecipe> = {
  v2: RECIPE_V2 as EmbeddingRecipe,
  'v2-plain': { id: 'v2-plain', normalize: 'none', flip: true },
  flip: { id: 'flip', normalize: 'none', flip: true },
  raw: RECIPE_V1 as EmbeddingRecipe,
};
const recipe = RECIPES[values.recipe!];
if (!recipe) throw new Error(`unknown recipe ${values.recipe}`);
const modelPath = resolve(values.model!);
const sha = createHash('sha256').update(readFileSync(modelPath)).digest('hex').slice(0, 12);
const engineTag = `rec:${values.tag}:${sha}:${values.recipe}`;
const facesetDir = resolve(values.facesets ?? defaultFacesetsDir());
const modelsDir = join(work, 'harness', `models-${sha}`);
if (!existsSync(join(modelsDir, 'face_recognition_sface_2021dec.onnx'))) {
  mkdirSync(modelsDir, { recursive: true });
  symlinkSync(join(repo, 'apps/server/models/face_detection_yunet_2023mar.onnx'), join(modelsDir, 'face_detection_yunet_2023mar.onnx'));
  symlinkSync(modelPath, join(modelsDir, 'face_recognition_sface_2021dec.onnx'));
}
const dataOpts = { facesetDir, engineTag, recipes: [] as EmbeddingRecipe[] };
const log = (m: string) => process.stderr.write(`[harness ${values.tag}] ${m}\n`);

if (values['build-only']) {
  const [i, n] = (values.shard ?? '0/1').split('/').map(Number);
  const vision = await createVisionService({ modelsDir, workers: 1, embedding: recipe });
  try {
    await buildWebcamData(vision, { ...dataOpts, shard: n > 1 ? { index: i, count: n } : undefined, concurrency: 2, onProgress: log });
  } finally {
    await vision.close();
  }
  process.exit(0);
}

// 1. analyse (parallel shards, cached)
const shards = Math.max(1, Number(values.shards));
await Promise.all(
  Array.from({ length: shards }, (_, i) =>
    new Promise<void>((res, rej) => {
      const args = [...process.execArgv, fileURLToPath(import.meta.url), '--build-only', '--shard', `${i}/${shards}`, '--model', modelPath, '--tag', values.tag!, '--recipe', values.recipe!, '--facesets', facesetDir];
      const child = spawn(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit'] });
      child.on('exit', (code) => (code === 0 ? res() : rej(new Error(`shard ${i} exited with ${code}`))));
      child.on('error', rej);
    }),
  ),
);

// 2. optional recalibration of the decision layer for this model (BEFORE any LLR table is built)
let refitUsed: unknown = null;
if (values.refit) {
  const fits = JSON.parse(readFileSync(resolve(values.refit), 'utf8')).fits as Record<string, { genuine: { mean: number; sd: number }; impostor: { mean: number; sd: number } }>;
  for (const b of ['good', 'fair', 'poor'] as const) {
    const m = BUCKET_MODELS[b] as { genuine: { mean: number; sd: number }; impostor: { mean: number; sd: number } };
    const r2 = (v: number) => Math.round(v * 100) / 100;
    m.genuine.mean = r2(fits[b].genuine.mean);
    m.genuine.sd = r2(fits[b].genuine.sd * 1.15);
    m.impostor.mean = r2(fits[b].impostor.mean);
    m.impostor.sd = r2(fits[b].impostor.sd * 1.15);
  }
  refitUsed = JSON.parse(JSON.stringify(BUCKET_MODELS));
  log(`BUCKET_MODELS refit: ${JSON.stringify(refitUsed)}`);
}

// 3. report (the harness's own code)
const noVision = { analyze: () => Promise.reject(new Error('analysis cache incomplete')) } as unknown as VisionService;
const data = await buildWebcamData(noVision, { ...dataOpts, cachedOnly: true });
const pipeline = currentPipeline('default');
const hooks = await loadEngineHooks();
const report = buildWebcamReport(data, [{ pipeline, data }], { runs: Number(values.runs), hooks });
if (values.out) writeFileSync(resolve(values.out), JSON.stringify({ engineTag, model: modelPath, sha256_12: sha, recipe, refit: refitUsed, report }, null, 1) + '\n');

// 4. threshold-free summary
function eer(gen: number[], imp: number[]): { eer: number; dprime: number } | null {
  if (!gen.length || !imp.length) return null;
  const all = [...gen.map((s) => ({ s, g: 1 })), ...imp.map((s) => ({ s, g: 0 }))].sort((a, b) => b.s - a.s);
  let tp = 0;
  let fp = 0;
  let best = { gap: Infinity, eer: 1 };
  for (const x of all) {
    if (x.g) tp++;
    else fp++;
    const far = fp / imp.length;
    const frr = 1 - tp / gen.length;
    if (Math.abs(far - frr) < best.gap) best = { gap: Math.abs(far - frr), eer: (far + frr) / 2 };
  }
  const ms = (v: number[]) => {
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    return { m, v: v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1) };
  };
  const a = ms(gen);
  const b = ms(imp);
  return { eer: Math.round(best.eer * 10000) / 100, dprime: Math.round(((a.m - b.m) / Math.sqrt((a.v + b.v) / 2)) * 100) / 100 };
}
const trials = scoreTrials(data, pipeline, ['good', 'typical']);
const bursts = trials.bursts.filter((b) => b.similarity != null && b.usableFrames > 0);
const sel = (f: (b: (typeof bursts)[number]) => boolean) => {
  const g = bursts.filter((b) => f(b) && b.kind === 'genuine_cross').map((b) => b.similarity!);
  const i = bursts.filter((b) => f(b) && (b.kind === 'impostor' || b.kind === 'impostor_family')).map((b) => b.similarity!);
  const fam = bursts.filter((b) => f(b) && b.kind === 'impostor_family').map((b) => b.similarity!);
  const q = (v: number[], p: number) => (v.length ? [...v].sort((x, y) => x - y)[Math.min(v.length - 1, Math.floor(p * v.length))] : null);
  return { nGenuine: g.length, nImpostor: i.length, ...eer(g, i), genuineP05: q(g, 0.05), impostorP99: q(i, 0.99), familyP99: q(fam, 0.99) };
};
// MATCHED-DEGRADATION: reference enrolled in the SAME poor condition as the probes (dim room check-in vs dim room
// probes), where SFace impostor similarity inflates. Burst templates and single frames, all resolutions and 480p.
const sameCondition: Record<string, unknown> = {};
for (const c of ['dim', 'backlit'] as const) {
  const t = scoreTrials(data, pipeline, [c]);
  const bs = t.bursts.filter((b) => b.condition === c && b.similarity != null && b.usableFrames > 0);
  const fs = t.frames.filter((f) => f.condition === c && f.similarity != null && f.usable);
  const block = (res: string | null) => {
    const B = bs.filter((b) => !res || b.resolution === res);
    const F = fs.filter((f) => !res || f.resolution === res);
    const pick = (xs: { kind: string; similarity: number | null }[], kinds: string[]) => xs.filter((x) => kinds.includes(x.kind)).map((x) => x.similarity!);
    const q = (v: number[], p: number) => (v.length ? [...v].sort((x, y) => x - y)[Math.min(v.length - 1, Math.floor(p * v.length))] : null);
    const mean = (v: number[]) => (v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 1000) / 1000 : null);
    const gB = pick(B, ['genuine_cross']);
    const iB = pick(B, ['impostor', 'impostor_family']);
    const gF = pick(F, ['genuine_cross']);
    const iF = pick(F, ['impostor', 'impostor_family']);
    return {
      enrolled: t.refs.filter((r) => r.ok).length,
      burst: { ...eer(gB, iB), nGenuine: gB.length, nImpostor: iB.length, genuineMean: mean(gB), genuineP05: q(gB, 0.05), impostorMean: mean(iB), impostorP99: q(iB, 0.99), impostorMax: q(iB, 1), familyMax: q(pick(B, ['impostor_family']), 1) },
      frame: { ...eer(gF, iF), nGenuine: gF.length, nImpostor: iF.length, genuineMean: mean(gF), impostorMean: mean(iF), impostorP99: q(iF, 0.99), impostorMax: q(iF, 1) },
    };
  };
  sameCondition[c] = { all: block(null), '640x480': block('640x480') };
}
const pr = report.pipelines[0];
const fits = Object.fromEntries((pr.buckets ?? fitBuckets(bursts)).map((f) => [f.bucket, { genuine: f.genuine, impostor: f.impostor }]));
const summary = {
  engineTag,
  recipe: values.recipe,
  refit: refitUsed,
  frames: data.records.length,
  enrolment: pr.enrolment,
  checks3: Object.fromEntries(Object.entries(pr.engineChecks ?? {}).map(([c, v]) => [c, Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x.frames3]))])),
  checks6: Object.fromEntries(Object.entries(pr.engineChecks ?? {}).map(([c, v]) => [c, Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x.frames6]))])),
  fits,
  byBucket: Object.fromEntries(['good', 'fair', 'poor'].map((b) => [b, sel((x) => x.bucket === b)])),
  byCondition: Object.fromEntries(['good', 'typical', 'dim', 'backlit', 'sidelit'].map((c) => [c, sel((x) => x.condition === c)])),
  sameCondition,
  sequentialPerCondition: pr.sequential.normalised?.perCondition ?? pr.sequential.perCondition,
  sequential: {
    genuineSamePhoto: pr.sequential.genuineSamePhoto,
    genuineCrossPhoto: pr.sequential.genuineCrossPhoto,
    impostor: pr.sequential.impostor,
    impostorFamily: pr.sequential.impostorFamily,
  },
};
if (values.summary) writeFileSync(resolve(values.summary), JSON.stringify(summary, null, 1) + '\n');
console.log(JSON.stringify({ enrolment: summary.enrolment, byBucket: summary.byBucket, byCondition: summary.byCondition, sameCondition, fits }, null, 1));
process.exit(0);

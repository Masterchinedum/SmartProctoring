/**
 * MATCHED-DEGRADATION impostor false-match rates with paired identity-bootstrap CIs, on the evaluation set, through
 * the production pipeline (currentPipeline: quality gate, buckets, v2 recipe, template scoring), for:
 *   base    the shipped SFace analyses              (tag rec:base:<sha>:<recipe>, from ts/harness.mts)
 *   cand    the candidate's analyses                (tag rec:<tag>:<sha>:<recipe>)
 *   hybrid  candidate embeddings for POOR-bucket frames only, base embeddings for every other frame
 * Cached analyses only (run ts/harness.mts for both models first); no sequential simulation, so it is quick.
 *
 *   tsx tools/recognizer/ts/matched.mts --base <onnx> --cand <onnx> --tag A_mdeg [--recipe v2] [--reps 1000] [--out f.json]
 *
 * For a reference enrolled in condition c (dim, backlit; 5 check-in frames at 640x480) against burst templates (and
 * single frames) of OTHER identities in the same condition: FMR at the variant's own good-light operating threshold
 * (good-light check-in vs good-light probes, impostor FAR 1e-3) and at the fixed match threshold 0.45; the genuine
 * (other photo) pass rate at the same thresholds; deltas vs base with 95 % CIs (identities resampled).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { VisionService } from '../../../apps/server/src/vision/types.ts';
import { defaultFacesetsDir } from '../../../apps/server/src/eval/datasets.ts';
import { buildWebcamData, type WebcamData } from '../../../apps/server/src/eval/webcam-eval.ts';
import { currentPipeline } from '../../../apps/server/src/eval/webcam-report.ts';
import { scoreTrials } from '../../../apps/server/src/eval/webcam-metrics.ts';
import { CALIBRATION } from '../../../apps/server/src/vision/calibration.ts';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    base: { type: 'string' },
    cand: { type: 'string' },
    tag: { type: 'string', default: 'A_mdeg' },
    recipe: { type: 'string', default: 'v2' },
    reps: { type: 'string', default: '1000' },
    out: { type: 'string' },
  },
});
const sha = (p: string) => createHash('sha256').update(readFileSync(resolve(p))).digest('hex').slice(0, 12);
const facesetDir = defaultFacesetsDir();
const noVision = { analyze: () => Promise.reject(new Error('analysis cache incomplete')) } as unknown as VisionService;
const load = (tag: string) => buildWebcamData(noVision, { facesetDir, engineTag: tag, recipes: [], cachedOnly: true });
const base = await load(`rec:base:${sha(values.base!)}:${values.recipe}`);
const cand = await load(`rec:${values.tag}:${sha(values.cand!)}:${values.recipe}`);
const p = currentPipeline('default');
const baseById = new Map(base.records.map((r) => [r.id, r]));
const hybrid: WebcamData = {
  ...cand,
  records: cand.records.map((r) => {
    const q = p.quality(r);
    const poor = q.usable && p.bucket!(q) === 'poor';
    const b = baseById.get(r.id);
    return poor || !b ? r : { ...r, embeddings: b.embeddings };
  }),
};
const variants: [string, WebcamData][] = [['base', base], ['cand', cand], ['hybrid', hybrid]];

// identities
const idOfPhoto = (k: string) => k.split('#')[0];
const ids = [...new Set(base.sources.map((s) => s.identity))].sort();
const idx = new Map(ids.map((s, i) => [s, i]));

// seeded PRNG (mulberry32) for the bootstrap
let seed = 12345;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const reps = Number(values.reps);
const W: Float64Array[] = Array.from({ length: reps }, () => {
  const w = new Float64Array(ids.length);
  for (let k = 0; k < ids.length; k++) w[Math.floor(rnd() * ids.length)]++;
  return w;
});

type T = { s: number; a: number; b: number; imp: boolean; gen: boolean };
function trials(data: WebcamData, enrol: 'good' | 'dim' | 'backlit', cond: string, level: 'burst' | 'frame'): T[] {
  const t = scoreTrials(data, p, [enrol]);
  const out: T[] = [];
  if (level === 'burst') {
    for (const b of t.bursts) {
      if (b.condition !== cond || b.similarity == null || b.usableFrames === 0) continue;
      out.push({ s: b.similarity, a: idx.get(b.refKey.split('|')[0])!, b: idx.get(idOfPhoto(b.probeKey.split('|')[0]))!, imp: b.kind.startsWith('impostor'), gen: b.kind === 'genuine_cross' });
    }
  } else {
    for (const f of t.frames) {
      if (f.condition !== cond || f.similarity == null || !f.usable) continue;
      const [refId, , probe] = f.burstKey.split('|');
      out.push({ s: f.similarity, a: idx.get(refId)!, b: idx.get(idOfPhoto(probe))!, imp: f.kind.startsWith('impostor'), gen: f.kind === 'genuine_cross' });
    }
  }
  return out;
}
function quantile(v: number[], q: number): number {
  const s = [...v].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))];
}
/** FMR (impostor >= thr) and pass (genuine >= thr), point + bootstrap arrays. */
function rates(ts: T[], thr: number) {
  const point = { fmr: 0, pass: 0, nImp: 0, nGen: 0 };
  for (const t of ts) {
    if (t.imp) {
      point.nImp++;
      if (t.s >= thr) point.fmr++;
    } else if (t.gen) {
      point.nGen++;
      if (t.s >= thr) point.pass++;
    }
  }
  const boot = W.map((w) => {
    let fi = 0, ti = 0, pg = 0, tg = 0;
    for (const t of ts) {
      if (t.imp) {
        const x = w[t.a] * w[t.b];
        ti += x;
        if (t.s >= thr) fi += x;
      } else if (t.gen) {
        const x = w[t.a];
        tg += x;
        if (t.s >= thr) pg += x;
      }
    }
    return { fmr: ti ? fi / ti : NaN, pass: tg ? pg / tg : NaN };
  });
  return { fmr: point.nImp ? point.fmr / point.nImp : NaN, pass: point.nGen ? point.pass / point.nGen : NaN, nImp: point.nImp, nGen: point.nGen, boot };
}
const ci = (v: number[]) => {
  const s = v.filter(Number.isFinite).sort((x, y) => x - y);
  return [s[Math.floor(0.025 * (s.length - 1))], s[Math.floor(0.975 * (s.length - 1))]];
};
const pct = (x: number) => Math.round(x * 100000) / 1000;

const result: Record<string, unknown> = { calibrationVersion: CALIBRATION.version, recipe: values.recipe, reps, identities: ids.length };
for (const level of ['burst', 'frame'] as const) {
  // each variant's own good-light operating threshold (impostor FAR 1e-3, good check-in vs good probes)
  const thr: Record<string, number> = {};
  for (const [name, data] of variants) thr[name] = quantile(trials(data, 'good', 'good', level).filter((t) => t.imp).map((t) => t.s), 1 - 1e-3);
  result[`ownGoodThreshold_${level}`] = thr;
  for (const c of ['dim', 'backlit'] as const) {
    const per: Record<string, unknown> = {};
    const R: Record<string, Record<string, ReturnType<typeof rates>>> = {};
    for (const [name, data] of variants) {
      const ts = trials(data, c, c, level);
      R[name] = { own: rates(ts, thr[name]), fixed: rates(ts, CALIBRATION.match) };
    }
    for (const [name] of variants) {
      const row: Record<string, unknown> = {};
      for (const k of ['own', 'fixed'] as const) {
        const r = R[name][k];
        row[k] = {
          nImpostor: r.nImp, nGenuine: r.nGen, fmrPct: pct(r.fmr), fmrCI: ci(r.boot.map((b) => b.fmr)).map(pct), genuinePassPct: pct(r.pass),
          ...(name !== 'base' ? { deltaFmrPct: pct(r.fmr - R.base[k].fmr), deltaFmrCI: ci(r.boot.map((b, i) => b.fmr - R.base[k].boot[i].fmr)).map(pct), deltaPassPct: pct(r.pass - R.base[k].pass), deltaPassCI: ci(r.boot.map((b, i) => b.pass - R.base[k].boot[i].pass)).map(pct) } : {}),
        };
      }
      per[name] = row;
    }
    result[`${c}_${level}`] = per;
  }
}
console.log(JSON.stringify(result, null, 1));
if (values.out) writeFileSync(resolve(values.out), JSON.stringify(result, null, 1) + '\n');
process.exit(0);

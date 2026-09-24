import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveModelsDir } from '../vision/models';
import { createVisionService } from '../vision/service';
import {
  aggregateOutcomeProbabilities,
  computeEer,
  distribution,
  eventEstimates,
  groupReport,
  loadFolderDataset,
  loadPairsCsv,
  parseConditions,
  PERTURBATIONS,
  rocPoints,
  runFolderEval,
  type Trial,
} from './identity-eval';

const tmp = mkdtempSync(join(tmpdir(), 'sp-eval-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('dataset parsing', () => {
  it('parses condition tags from file names', () => {
    expect(parseConditions('reference__001.jpg')).toEqual(['reference']);
    expect(parseConditions('lighting-dim+Glasses__a_b.png')).toEqual(['lighting-dim', 'glasses']);
    expect(parseConditions('plain.jpg')).toEqual(['unspecified']);
  });

  it('loads a folder dataset with anonymised ids and the reference rule', () => {
    const root = join(tmp, 'ds');
    for (const [subject, files] of [
      ['alice', ['reference__1.jpg', 'glasses__2.jpg', 'notes.txt']],
      ['bob', ['camera-b__1.jpg', 'pause-2d__2.jpg']],
    ] as const) {
      mkdirSync(join(root, subject), { recursive: true });
      for (const f of files) writeFileSync(join(root, subject, f), 'x');
    }
    const ds = loadFolderDataset(root);
    expect(ds.subjects).toEqual(['s01', 's02']);
    expect(ds.images).toHaveLength(4);
    expect(ds.images.filter((i) => i.isReference).map((i) => i.id)).toEqual(['s01/i01', 's02/i01']);
    expect(ds.images.find((i) => i.id === 's01/i02')!.conditions).toEqual(['glasses']);
    expect(ds.images.every((i) => !i.id.includes('alice'))).toBe(true);
  });

  it('loads a pairs CSV and removes duplicates', () => {
    const csv = join(tmp, 'pairs.csv');
    writeFileSync(csv, 'file_x,file_y,Decision\na.jpg,b.jpg,Yes\nb.jpg,a.jpg,Yes\na.jpg,c.jpg,No\n\n');
    expect(loadPairsCsv(csv)).toEqual([
      { a: 'a.jpg', b: 'b.jpg', same: true },
      { a: 'a.jpg', b: 'c.jpg', same: false },
    ]);
  });
});

describe('metrics', () => {
  it('distribution quantiles', () => {
    const d = distribution([0.5, 0.1, 0.9, 0.3, 0.7]);
    expect(d).toMatchObject({ n: 5, min: 0.1, median: 0.5, max: 0.9 });
    expect(distribution([]).median).toBeNull();
  });

  it('EER and ROC points', () => {
    expect(computeEer([0.8, 0.9, 0.7], [0.1, 0.2, 0.3])!.eer).toBe(0);
    const overlapping = computeEer([0.3, 0.6, 0.8, 0.9], [0.1, 0.2, 0.4, 0.5])!;
    expect(overlapping.eer).toBeCloseTo(0.25, 5);
    expect(rocPoints([0.3, 0.6], [0.1, 0.5], [0.4])).toEqual([{ threshold: 0.4, fmr: 0.5, fnmr: 0.5 }]);
    expect(computeEer([], [0.1])).toBeNull();
  });

  it('aggregate (resume-check) outcome probabilities follow the aggregateFrames rule', () => {
    const allMatch = aggregateOutcomeProbabilities({ match: 1, mismatch: 0, inconclusive: 0, unable_to_verify: 0 }, 3);
    expect(allMatch.match).toBe(1);
    const allBad = aggregateOutcomeProbabilities({ match: 0, mismatch: 0, inconclusive: 0, unable_to_verify: 1 }, 3);
    expect(allBad.unable_to_verify).toBe(1);
    const p = { match: 0.1, mismatch: 0.8, inconclusive: 0.05, unable_to_verify: 0.05 };
    const agg = aggregateOutcomeProbabilities(p, 3);
    const total = agg.match + agg.mismatch + agg.inconclusive + agg.unable_to_verify;
    expect(total).toBeCloseTo(1, 3);
    // mismatch needs >= 2 mismatches and no match among 3 frames.
    const exact = 0.8 ** 3 + 3 * 0.8 ** 2 * 0.1; // MMM + MM(inconclusive|unable)
    expect(agg.mismatch).toBeCloseTo(exact, 3);
  });

  it('event-level estimates', () => {
    const e = eventEstimates(
      { match: 0.95, mismatch: 0.01, inconclusive: 0.02, unable_to_verify: 0.02 },
      { match: 0, mismatch: 0.9, inconclusive: 0.05, unable_to_verify: 0.05 },
      { intervalSec: 30, confirmations: 2 },
    );
    expect(e.samplesPerHour).toBe(120);
    expect(e.falseMismatchEventsPerHourIndependent).toBeCloseTo(120 * 0.0001, 6);
    expect(e.falseMismatchEventProbabilityCorrelated).toBe(0.01);
    expect(e.swapDetectedWithin[0].probability).toBeCloseTo(0.81, 4);
    expect(e.swapDetectedWithin[1].probability).toBeCloseTo(1 - 0.19 ** 2, 4);
    expect(e.expectedMinutesToSwapDetection).toBeCloseTo(0.5 / 0.81, 1);
    expect(e.assumption).toMatch(/independent/);
  });

  it('group report counts false mismatches and false matches', () => {
    const t = (kind: Trial['kind'], decision: Trial['decision'], similarity: number, usable = true): Trial => ({ kind, groups: ['all'], similarity, decision, usable, issues: usable ? [] : ['too_dark'] });
    const r = groupReport('all', [
      t('genuine', 'match', 0.8),
      t('genuine', 'mismatch', 0.2),
      t('genuine', 'unable_to_verify', 0.1, false),
      t('genuine', 'inconclusive', 0.35),
      t('impostor', 'match', 0.45),
      t('impostor', 'mismatch', 0.1),
      t('impostor', 'mismatch', 0.05),
      t('impostor', 'mismatch', 0.15),
    ]);
    expect(r.genuine.falseMismatchRate).toBe(0.25);
    expect(r.genuine.falseMismatchRateUsable).toBeCloseTo(1 / 3, 4);
    expect(r.genuine.similarityUsable.n).toBe(3);
    expect(r.impostor.falseMatchRate).toBe(0.25);
    expect(r.impostor.detectionRate).toBe(0.75);
    expect(r.topIssues).toEqual([{ issue: 'too_dark', count: 1 }]);
  });

  it('declares every perturbation required by the protocol', () => {
    const names = PERTURBATIONS.map((p) => p.name);
    for (const n of ['dim', 'very_dark', 'overexposed', 'gamma_dark', 'blur_s2', 'blur_s4', 'jpeg_q15', 'lowres_160', 'noise', 'warm_cast', 'cool_cast', 'occlusion_mask', 'occlusion_hand', 'crop_cut', 'camera_b']) {
      expect(names).toContain(n);
    }
  });
});

const FACES = process.env.SP_TEST_FACES_DIR ?? '/tmp/claude-0/faces';
const haveModels = (() => {
  try {
    resolveModelsDir();
    return true;
  } catch {
    return false;
  }
})();
const haveImages = ['obama.jpg', 'obama_small.jpg', 'biden.jpg'].every((f) => existsSync(join(FACES, f)));

describe.skipIf(!haveModels || !haveImages)('folder evaluation on real images', () => {
  it('scores a small dataset with and without perturbations', async () => {
    const root = join(tmp, 'real');
    mkdirSync(join(root, 'a'), { recursive: true });
    mkdirSync(join(root, 'b'), { recursive: true });
    symlinkSync(join(FACES, 'obama.jpg'), join(root, 'a', 'reference__1.jpg'));
    symlinkSync(join(FACES, 'obama_small.jpg'), join(root, 'a', 'camera-b+background__2.jpg'));
    writeFileSync(join(root, 'b', 'reference__1.jpg'), readFileSync(join(FACES, 'biden.jpg')));
    const vision = await createVisionService();
    try {
      const report = await runFolderEval(vision, root, { perturb: true, perturbations: ['very_dark', 'blur_s4', 'cool_cast'] });
      const all = report.groups.find((g) => g.group === 'all')!;
      expect(report.dataset).toMatchObject({ subjects: 2, images: 3, enrolled: 2, genuineTrials: 1, impostorTrials: 3 });
      expect(all.genuine.match).toBe(1);
      expect(all.genuine.falseMismatchRate).toBe(0);
      expect(all.impostor.falseMatchRate).toBe(0);
      expect(all.impostor.mismatch).toBe(3);
      expect(report.groups.find((g) => g.group === 'camera-b')!.genuine.n).toBe(1);
      const dark = report.groups.find((g) => g.group === 'perturb:very_dark')!;
      expect(dark.genuine.falseMismatchRate).toBe(0);
      expect(dark.genuine.unable_to_verify).toBe(1);
      expect(JSON.stringify(report)).not.toMatch(/obama|biden/);
    } finally {
      await vision.close();
    }
  }, 60_000);
});

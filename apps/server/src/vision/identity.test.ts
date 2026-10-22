import { DEFAULT_IDENTITY_THRESHOLDS, QUALITY_GUIDANCE, type FaceQuality } from '@sp/shared';
import { describe, expect, it } from 'vitest';
import { fakeAnalysis, fakeEmbedding } from './fake';
import {
  aggregateFrames,
  bestSimilarity,
  buildReference,
  CONFIDENCE_MARGIN,
  cosineSimilarity,
  decideIdentity,
  INCONCLUSIVE_GUIDANCE,
  maxSimilarity,
  REFERENCE_INCONSISTENT_REASON,
  scoreAgainst,
  templateFrom,
} from './identity';
import type { ImageAnalysis } from './types';

const T = DEFAULT_IDENTITY_THRESHOLDS;
const good = (over: Partial<FaceQuality> = {}): FaceQuality => ({ ...fakeAnalysis({ person: 'x' }).quality, ...over });
const frame = (person: string, over: Parameters<typeof fakeAnalysis>[0] = {}): ImageAnalysis => fakeAnalysis({ person, ...over }, { embed: true });

describe('similarity', () => {
  it('cosine similarity', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 1], [2, 2])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
    expect(() => cosineSimilarity([1], [1, 2])).toThrow();
  });

  it('max over reference embeddings', () => {
    const refs = [fakeEmbedding('a'), fakeEmbedding('b')];
    expect(maxSimilarity(fakeEmbedding('b'), refs)).toBeCloseTo(1, 6);
    expect(bestSimilarity(fakeEmbedding('b'), refs).index).toBe(1);
    expect(maxSimilarity(fakeEmbedding('c'), refs)).toBeCloseTo(0, 6);
    expect(() => maxSimilarity(fakeEmbedding('a'), [])).toThrow();
  });
});

describe('decideIdentity', () => {
  it('a low score on a poor-quality (dim / flat / small) frame is inconclusive with lighting guidance, never mismatch', () => {
    const dim = good({ brightness: 45, contrast: 9 });
    const r = decideIdentity(0.05, dim, T);
    expect(r.decision).toBe('inconclusive');
    expect(r.guidance).toContain(QUALITY_GUIDANCE.too_dark);
    expect(r.guidance).toContain(INCONCLUSIVE_GUIDANCE);
    // The same score on a good frame is strong evidence.
    expect(decideIdentity(0.05, good(), T).decision).toBe('mismatch');
    // A poor frame can still match.
    expect(decideIdentity(0.7, dim, T).decision).toBe('match');
  });

  it('with calibrated evidence, "match" also needs the evidence to favour the candidate (dim-room look-alike => inconclusive)', () => {
    const dim = good({ brightness: 45, contrast: 9 });
    expect(decideIdentity(0.55, dim, T).decision).toBe('match');
    expect(decideIdentity(0.55, dim, T, 'reference', { llr: 2 }).decision).toBe('inconclusive');
    expect(decideIdentity(0.55, dim, T, 'reference', { llr: -3 }).decision).toBe('match');
    // The same through an evidence context: a candidate enrolled in the same dim room (baseline 0.87), mid-exam.
    const ctx = { reference: 'poor' as const, baseline: { mean: 0.87, sd: 0.03, n: 8 }, context: 'continuous' as const, frames: 3 };
    expect(decideIdentity(0.55, dim, T, 'reference', ctx).decision).toBe('inconclusive');
    expect(decideIdentity(0.9, dim, T, 'reference', ctx).decision).toBe('match');
    // Evidence is ignored for ID-photo comparisons; a strong per-sample LLR turns a low good-light score into "mismatch".
    expect(decideIdentity(0.55, dim, T, 'id_photo', { llr: 5 }).decision).toBe('match');
    expect(decideIdentity(0.2, good(), T, 'reference', { llr: 4 }).decision).toBe('mismatch');
    expect(decideIdentity(0.2, good(), T, 'reference', { llr: 0.5 }).decision).toBe('inconclusive');
  });

  it('templates: mean of unit embeddings; scoreAgainst compares burst template with gallery template', () => {
    const a = fakeEmbedding('a');
    const a2 = fakeEmbedding('a', 0.8);
    const t = templateFrom([a, a2]);
    let n = 0;
    for (const v of t) n += v * v;
    expect(Math.sqrt(n)).toBeCloseTo(1, 6);
    expect(cosineSimilarity(t, a)).toBeGreaterThan(cosineSimilarity(a2, a));
    expect(scoreAgainst(a, [a])).toBeCloseTo(1, 6);
    expect(scoreAgainst([a, a2], [a, a2])).toBeCloseTo(1, 6);
    expect(scoreAgainst(fakeEmbedding('b'), [a, a2])).toBeCloseTo(0, 6);
    expect(() => scoreAgainst(a, [])).toThrow();
    expect(() => templateFrom([])).toThrow();
  });

  it('match / inconclusive / mismatch at the configured thresholds', () => {
    expect(decideIdentity(T.match, good(), T).decision).toBe('match');
    expect(decideIdentity(T.match - 0.01, good(), T).decision).toBe('inconclusive');
    expect(decideIdentity(T.mismatch, good(), T).decision).toBe('inconclusive');
    expect(decideIdentity(T.mismatch - 0.0001, good(), T).decision).toBe('mismatch');
  });

  it('never says mismatch for an unusable image; guidance comes from QUALITY_GUIDANCE', () => {
    const r = decideIdentity(0.01, good({ usable: false, issues: ['too_dark', 'blurry'] }), T);
    expect(r.decision).toBe('unable_to_verify');
    expect(r.guidance).toEqual([QUALITY_GUIDANCE.too_dark, QUALITY_GUIDANCE.blurry]);
    expect(decideIdentity(null, good(), T).decision).toBe('unable_to_verify');
    expect(decideIdentity(Number.NaN, good(), T).decision).toBe('unable_to_verify');
    expect(decideIdentity(0.9, null, T).decision).toBe('unable_to_verify');
  });

  it('uses the ID-photo thresholds when comparing with an ID photo', () => {
    expect(decideIdentity(T.idPhotoMatch, good(), T, 'reference').decision).toBe('inconclusive');
    expect(decideIdentity(T.idPhotoMatch, good(), T, 'id_photo').decision).toBe('match');
    expect(decideIdentity(0.25, good(), T, 'reference').decision).toBe('mismatch');
    expect(decideIdentity(0.25, good(), T, 'id_photo').decision).toBe('inconclusive');
  });

  it('confidence grows with distance from the crossed threshold', () => {
    expect(decideIdentity(T.match, good(), T).confidence).toBeCloseTo(0.5);
    expect(decideIdentity(T.match + CONFIDENCE_MARGIN / 2, good(), T).confidence).toBeCloseTo(0.75);
    expect(decideIdentity(0.95, good(), T).confidence).toBe(1);
    expect(decideIdentity(T.mismatch - CONFIDENCE_MARGIN, good(), T).confidence).toBeCloseTo(1);
    const mid = decideIdentity((T.match + T.mismatch) / 2, good(), T);
    expect(mid.decision).toBe('inconclusive');
    expect(mid.confidence).toBeCloseTo(1);
    expect(mid.guidance).toEqual([INCONCLUSIVE_GUIDANCE]);
  });

  it('sanitises inverted thresholds', () => {
    const bad = { ...T, match: 0.3, mismatch: 0.5 };
    expect(decideIdentity(0.35, good(), bad).decision).toBe('match');
    expect(decideIdentity(0.25, good(), bad).decision).toBe('mismatch');
  });
});

describe('buildReference', () => {
  it('builds from consistent frontal frames, best frame first, at most 5 embeddings', () => {
    const frames = [
      frame('alice', { similarity: 0.9, yawDeg: 5 }),
      frame('alice', { yawDeg: 1, pitchDeg: -6, sharpness: 900 }),
      frame('alice', { similarity: 0.85, yawDeg: -4 }),
      frame('alice', { similarity: 0.95 }),
      frame('alice', { similarity: 0.8, yawDeg: 8 }),
      frame('alice', { similarity: 0.99 }),
      frame('alice', { yawDeg: 40 }), // turned: not a reference candidate
    ];
    const r = buildReference(frames);
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.embeddings.length).toBe(5);
    expect(r.bestIndex).toBe(1);
    expect(r.quality).toBe(frames[1].quality);
    // Returned embeddings are copies.
    expect(r.embeddings[0]).not.toBe(frames[1].embedding);
  });

  it('fails when frames show different people', () => {
    const r = buildReference([frame('alice'), frame('alice'), frame('mallory'), frame('alice')]);
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual([REFERENCE_INCONSISTENT_REASON]);
    expect(r.embeddings).toEqual([]);
  });

  it('drops a grey-zone outlier but keeps >= 3 consistent frames', () => {
    // perturbed frames share the same orthogonal component, so similarity between two of them is s^2 + (1-s^2).
    const r = buildReference([frame('bob'), frame('bob'), frame('bob'), frame('bob', { similarity: 0.35 })]);
    expect(r.ok).toBe(true);
    expect(r.embeddings.length).toBe(3);
  });

  it('fails with guidance when fewer than 3 usable frontal frames', () => {
    const r = buildReference([frame('carol'), frame('carol', { usable: false, issues: ['too_dark'] }), frame('carol', { yawDeg: 22 })]);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/Only 1 of 3 frames/);
    expect(r.reasons).toContain(QUALITY_GUIDANCE.too_dark);
    expect(r.reasons).toContain(QUALITY_GUIDANCE.face_turned);
    expect(buildReference([]).ok).toBe(false);
  });

  it('requires embeddings', () => {
    const noEmb = [0, 1, 2].map(() => fakeAnalysis({ person: 'dave' }, { embed: false }));
    expect(buildReference(noEmb).ok).toBe(false);
  });
});

describe('aggregateFrames', () => {
  const refs = [fakeEmbedding('erin')];

  it('match needs two matching frames', () => {
    const r = aggregateFrames([frame('erin'), frame('erin', { similarity: 0.6 }), frame('erin', { usable: false })], refs);
    expect(r.decision).toBe('match');
    expect(r.matchCount).toBe(2);
    expect(r.usableCount).toBe(2);
    expect(r.minSimilarity).toBeCloseTo(0.6, 4);
    expect(r.maxSimilarity).toBeCloseTo(1, 4);
    expect(r.medianSimilarity).toBeCloseTo(0.8, 4);
    expect(r.bestProbeIndex).not.toBeNull();
    expect(r.frames[2].decision).toBe('unable_to_verify');
  });

  it('mismatch needs two usable mismatching frames and no match', () => {
    expect(aggregateFrames([frame('frank'), frame('frank'), frame('frank')], refs).decision).toBe('mismatch');
    expect(aggregateFrames([frame('frank'), frame('frank'), frame('erin')], refs).decision).toBe('inconclusive');
    expect(aggregateFrames([frame('frank'), frame('erin', { usable: false })], refs).decision).toBe('inconclusive');
  });

  it('unable to verify when no frame is usable, with guidance', () => {
    const r = aggregateFrames([frame('erin', { usable: false, issues: ['too_dark'] }), fakeAnalysis({ person: null })], refs);
    expect(r.decision).toBe('unable_to_verify');
    expect(r.guidance).toContain(QUALITY_GUIDANCE.too_dark);
    expect(r.guidance).toContain(QUALITY_GUIDANCE.no_face);
    expect(r.similarity).toBeNull();
  });

  it('grey-zone frames are inconclusive', () => {
    const r = aggregateFrames([frame('erin', { similarity: 0.33 }), frame('erin', { similarity: 0.35 })], refs);
    expect(r.decision).toBe('inconclusive');
    expect(r.guidance).toEqual([INCONCLUSIVE_GUIDANCE]);
  });

  it('a single frame decides on its own', () => {
    expect(aggregateFrames([frame('erin')], refs).decision).toBe('match');
    expect(aggregateFrames([frame('zed')], refs).decision).toBe('mismatch');
  });

  it('bestProbeIndex points at a frame that agrees with the decision', () => {
    const r = aggregateFrames([frame('erin', { usable: false }), frame('erin', { sharpness: 100 }), frame('erin', { sharpness: 900 })], refs);
    expect(r.decision).toBe('match');
    expect(r.bestProbeIndex).toBe(2);
  });
});

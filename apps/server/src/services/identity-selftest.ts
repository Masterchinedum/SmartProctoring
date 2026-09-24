/**
 * Staff camera self-test of the identity pipeline (POST /api/admin/tools/identity-test).
 *
 * An operator enrols a face with their own webcam and then probes with the same or another person to see the
 * quality measurements, guidance, similarity, the per-sample decision and the accumulated evidence exactly as the
 * exam engine computes them (identity-gallery.ts / identity-evidence.ts). Nothing is persisted: galleries live in
 * memory per staff user and test id, expire 15 minutes after their last use and are capped in frames and number.
 * Only the use of the tool is audit-logged (routes/admin/tools.ts), never images or face data.
 */
import { randomUUID } from 'node:crypto';
import type { FaceQuality, IdentityDecision, IdentityTestResponse, IdentityThresholds } from '@sp/shared';
import type { Ctx } from '../context.js';
import { guidanceForIssues, NO_EMBEDDING_GUIDANCE, type ImageAnalysis } from '../vision/index.js';
import { accumulate, EMPTY_ACCUMULATOR, frameEvidence, sampleLabel, toEvidenceDTO, type EvidenceAccumulator, type SessionBaseline } from './identity-evidence.js';
import { buildGallery, scoreReference } from './identity-gallery.js';

export const SELFTEST_TTL_MS = 15 * 60_000;
/** Enrolment frames kept per test (the gallery is built from them). */
export const SELFTEST_MAX_ENROLL_FRAMES = 20;
/** Probes per test (then the test must be reset / re-enrolled). */
export const SELFTEST_MAX_PROBES = 200;
export const SELFTEST_MAX_TESTS_PER_USER = 3;
export const SELFTEST_MAX_TESTS = 500;

interface SelfTest {
  staffId: string;
  testId: string;
  frames: { analysis: ImageAnalysis }[];
  gallery: Float32Array[];
  baseline: SessionBaseline | null;
  acc: EvidenceAccumulator;
  probes: number;
  lastUsedAt: number;
}

export class SelfTestError extends Error {
  constructor(
    readonly code: 'not_enrolled' | 'too_many_frames' | 'too_many_probes',
    message: string,
  ) {
    super(message);
  }
}

/** Transient in-memory galleries (one store per app instance). */
export class IdentitySelfTestStore {
  private readonly tests = new Map<string, SelfTest>();

  private key(staffId: string, testId: string) {
    return `${staffId}:${testId}`;
  }

  /** Drop expired tests. */
  sweep(now: number): void {
    for (const [k, t] of this.tests) if (now - t.lastUsedAt > SELFTEST_TTL_MS) this.tests.delete(k);
  }

  get size(): number {
    return this.tests.size;
  }

  /** Existing (unexpired) test, or null. */
  find(staffId: string, testId: string, now: number): SelfTest | null {
    this.sweep(now);
    return this.tests.get(this.key(staffId, testId)) ?? null;
  }

  /** Existing test or a new one (evicting this user's / everyone's least recently used tests beyond the caps). */
  open(staffId: string, testId: string, now: number): { test: SelfTest; created: boolean } {
    const found = this.find(staffId, testId, now);
    if (found) return { test: found, created: false };
    const mine = [...this.tests.values()].filter((t) => t.staffId === staffId).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    while (mine.length >= SELFTEST_MAX_TESTS_PER_USER) this.tests.delete(this.key(staffId, mine.shift()!.testId));
    if (this.tests.size >= SELFTEST_MAX_TESTS) {
      const oldest = [...this.tests.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
      if (oldest) this.tests.delete(oldest[0]);
    }
    const test: SelfTest = { staffId, testId, frames: [], gallery: [], baseline: null, acc: { ...EMPTY_ACCUMULATOR, window: [] }, probes: 0, lastUsedAt: now };
    this.tests.set(this.key(staffId, testId), test);
    return { test, created: true };
  }

  delete(staffId: string, testId: string): boolean {
    return this.tests.delete(this.key(staffId, testId));
  }
}

const stores = new WeakMap<object, IdentitySelfTestStore>();

/** The self-test store of this app instance. */
export function selfTestStore(ctx: object): IdentitySelfTestStore {
  let s = stores.get(ctx);
  if (!s) {
    s = new IdentitySelfTestStore();
    stores.set(ctx, s);
  }
  return s;
}

function guidanceOf(q: FaceQuality, hasEmbedding: boolean): string[] {
  if (q.issues.length) return guidanceForIssues(q.issues);
  return hasEmbedding ? [] : [NO_EMBEDDING_GUIDANCE];
}

function rebuildGallery(t: SelfTest, thresholds: Pick<IdentityThresholds, 'match' | 'mismatch'>): string[] {
  const embs = t.frames.map((f) => f.analysis.embedding!).filter(Boolean);
  if (t.frames.length >= 3) {
    const g = buildGallery(
      t.frames.map((f) => ({ analysis: f.analysis, frontal: true })),
      thresholds,
    );
    if (g.ok) {
      t.gallery = g.gallery;
      t.baseline = g.baseline;
      return [];
    }
    t.gallery = embs;
    t.baseline = null;
    return g.reasons;
  }
  // Fewer than 3 frames: compare with their template, without per-person normalisation.
  t.gallery = embs;
  t.baseline = null;
  return [];
}

export interface SelfTestInput {
  staffId: string;
  testId: string;
  mode: 'enroll' | 'probe' | 'reset';
  thresholds: IdentityThresholds;
}

/** Run one self-test step. `analyze` is only called for enroll / probe. */
export async function runSelfTest(ctx: Pick<Ctx, 'now' | 'vision'>, input: SelfTestInput, jpeg: Buffer | null): Promise<{ response: IdentityTestResponse; created: boolean }> {
  const store = selfTestStore(ctx);
  const now = ctx.now();
  const empty = (enrolledFrames: number): IdentityTestResponse => ({
    testId: input.testId,
    mode: input.mode,
    quality: null,
    guidance: [],
    enrolledFrames,
    similarity: null,
    decision: null,
    llr: null,
    evidence: null,
    timingsMs: { analyze: 0 },
  });
  if (input.mode === 'reset') {
    store.delete(input.staffId, input.testId);
    return { response: empty(0), created: false };
  }
  if (!jpeg) throw new Error('image required');
  if (input.mode === 'probe') {
    const t = store.find(input.staffId, input.testId, now);
    if (!t || t.gallery.length === 0) throw new SelfTestError('not_enrolled', 'Enrol at least one clear frame (mode=enroll) before probing.');
    if (t.probes >= SELFTEST_MAX_PROBES) throw new SelfTestError('too_many_probes', 'This test has reached its probe limit. Reset it and enrol again.');
  } else {
    const t = store.find(input.staffId, input.testId, now);
    if (t && t.frames.length >= SELFTEST_MAX_ENROLL_FRAMES) throw new SelfTestError('too_many_frames', `A test keeps at most ${SELFTEST_MAX_ENROLL_FRAMES} enrolment frames. Reset it to start again.`);
  }

  const t0 = performance.now();
  const analysis = await ctx.vision.analyze(jpeg, { embed: true, priority: 'interactive' });
  const analyzeMs = Math.round(performance.now() - t0);
  const { test, created } = store.open(input.staffId, input.testId, now);
  test.lastUsedAt = now;
  const quality = analysis.quality;

  if (input.mode === 'enroll') {
    let guidance = guidanceOf(quality, analysis.embedding != null);
    if (quality.usable && analysis.embedding) {
      test.frames.push({ analysis: { ...analysis, faceCropJpeg: null } });
      guidance = [...guidance, ...rebuildGallery(test, input.thresholds)];
      // New enrolment => evidence starts over.
      test.acc = { ...EMPTY_ACCUMULATOR, window: [] };
      test.probes = 0;
    }
    return {
      response: { ...empty(test.frames.length), quality, guidance: [...new Set(guidance)], timingsMs: { analyze: analyzeMs } },
      created,
    };
  }

  // probe
  test.probes += 1;
  const similarity = analysis.embedding ? scoreReference(analysis.embedding, test.gallery) : null;
  const fe = frameEvidence(quality, similarity, test.baseline, 'continuous');
  const decision: IdentityDecision = sampleLabel(similarity, quality, input.thresholds);
  const res = accumulate(test.acc, { id: randomUUID(), at: now, trigger: 'periodic', evidence: fe });
  test.acc = res.acc;
  return {
    response: {
      ...empty(test.frames.length),
      quality,
      guidance: guidanceOf(quality, analysis.embedding != null),
      similarity,
      decision,
      llr: fe.usable ? fe.llr : null,
      evidence: toEvidenceDTO(test.acc),
      timingsMs: { analyze: analyzeMs },
    },
    created,
  };
}

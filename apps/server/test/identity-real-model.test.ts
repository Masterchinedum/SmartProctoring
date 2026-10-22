/**
 * Identity engine v2 with the REAL models (YuNet + SFace) on public test photos, through the same code paths the
 * exam uses (enrolment gallery + baseline, session-normalised evidence, accumulator) via the staff self-test
 * service. Webcam-like enrolment frames are simulated from one photo (crop / exposure / JPEG jitter).
 * Skipped when the models or the photos (SP_TEST_FACES_DIR / SP_TEST_FACESETS_DIR) are absent.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_IDENTITY_THRESHOLDS, type IdentityTestResponse } from '@sp/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSelfTest } from '../src/services/identity-selftest.js';
import { createVisionService, qualityBucket, resolveModelsDir, type VisionService } from '../src/vision/index.js';

const FACES = process.env.SP_TEST_FACES_DIR ?? '/tmp/claude-0/faces';
const FACESETS = process.env.SP_TEST_FACESETS_DIR ?? '/tmp/claude-0/facesets';
const AZ = (name: string) => join(FACESETS, 'azure', `Face__images__${name}.jpg`);
const haveModels = (() => {
  try {
    resolveModelsDir();
    return true;
  } catch {
    return false;
  }
})();
const havePhotos = ['obama.jpg', 'obama_small.jpg', 'biden.jpg'].every((f) => existsSync(join(FACES, f)));
const haveFamily = ['Family1-Dad1', 'Family1-Dad2', 'Family1-Dad3', 'Family1-Son1', 'Family1-Son2'].every((n) => existsSync(AZ(n)));

/** Webcam-like frames of one photo: slight crop / scale, exposure and JPEG-quality jitter, 640x480 max. */
async function frames(file: string, n: number): Promise<Buffer[]> {
  const src = readFileSync(file);
  const meta = await sharp(src).metadata();
  const out: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const s = 1 - 0.03 * i;
    const w = Math.round(meta.width! * s);
    const h = Math.round(meta.height! * s);
    out.push(
      await sharp(src)
        .extract({ left: Math.round((meta.width! - w) / 2), top: Math.round((meta.height! - h) / 2), width: w, height: h })
        .resize({ width: 640, height: 480, fit: 'inside' })
        .modulate({ brightness: 1 - 0.05 * (i % 3) })
        .jpeg({ quality: 85 - i * 3 })
        .toBuffer(),
    );
  }
  return out;
}

describe.skipIf(!haveModels || !(havePhotos || haveFamily))('identity engine with the real models', () => {
  let vision: VisionService;
  let t = 1_000_000;
  // One context object for the whole file: the self-test store is kept per app context.
  const context = { now: () => t, get vision() { return vision; } };
  const ctx = () => context;
  beforeAll(async () => {
    vision = await createVisionService();
  }, 60_000);
  afterAll(async () => vision?.close());

  async function enrol(testId: string, file: string) {
    let last: IdentityTestResponse | null = null;
    for (const b of await frames(file, 6)) last = (await runSelfTest(ctx(), { staffId: 'staff', testId, mode: 'enroll', thresholds: DEFAULT_IDENTITY_THRESHOLDS }, b)).response;
    return last!;
  }
  async function probe(testId: string, file: string, variant = 1) {
    t += 15_000;
    const b = (await frames(file, variant + 1))[variant];
    return (await runSelfTest(ctx(), { staffId: 'staff', testId, mode: 'probe', thresholds: DEFAULT_IDENTITY_THRESHOLDS }, b)).response;
  }

  it.skipIf(!havePhotos)('the same person (another, low-resolution photo) stays consistent; a different person is suspected after two samples and confirmed after three', async () => {
    const e = await enrol('obama', join(FACES, 'obama.jpg'));
    expect(e.enrolledFrames).toBeGreaterThanOrEqual(3);
    const same = await probe('obama', join(FACES, 'obama_small.jpg')); // another photo, low resolution
    expect(same.quality!.usable, JSON.stringify(same.quality)).toBe(true);
    expect(same.decision).toBe('match');
    expect(same.llr!).toBeLessThan(0);
    expect(same.evidence!.state).toBe('consistent');
    const other1 = await probe('obama', join(FACES, 'biden.jpg'));
    expect(other1.decision).toBe('mismatch');
    expect(other1.llr!).toBeGreaterThan(3);
    // The genuine probe before still counts in the evidence window (no track break in a self-test), so the other
    // person is 'suspect' after two samples and confirmed after three (llrClamp 5 < confirm 7 needs >= 2 anyway).
    const other2 = await probe('obama', join(FACES, 'biden.jpg'), 2);
    expect(other2.evidence!.state).toBe('suspect');
    const other3 = await probe('obama', join(FACES, 'biden.jpg'), 3);
    expect(qualityBucket(other3.quality!)).not.toBe('poor');
    expect(other3.evidence!.state).toBe('confirmed_mismatch');
    expect(other3.evidence!.swapProbability).toBeGreaterThan(0.5);
  }, 120_000);

  it.skipIf(!haveFamily)('family photos: the father’s other photos never confirm a mismatch; the son (look-alike) builds evidence', async () => {
    await enrol('dad', AZ('Family1-Dad1'));
    const genuine = [await probe('dad', AZ('Family1-Dad2')), await probe('dad', AZ('Family1-Dad3')), await probe('dad', AZ('Family1-Dad2'), 2)];
    for (const g of genuine) {
      expect(g.evidence!.state).not.toBe('confirmed_mismatch');
    }
    const son = [await probe('dad', AZ('Family1-Son1')), await probe('dad', AZ('Family1-Son2')), await probe('dad', AZ('Family1-Son1'), 2)];
    const usable = son.filter((s) => s.quality?.usable);
    expect(usable.length).toBeGreaterThan(0);
    expect(usable.reduce((a, s) => a + (s.llr ?? 0), 0)).toBeGreaterThan(0);
  }, 120_000);
});

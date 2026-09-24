/**
 * End-to-end tests of the ONNX vision service on real photos. Test images are NOT part of the repo:
 * they are read from SP_TEST_FACES_DIR (default /tmp/claude-0/faces) and every test here is skipped
 * when they (or the models) are missing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { DEFAULT_IDENTITY_THRESHOLDS, QUALITY_GUIDANCE } from '@sp/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReference, cosineSimilarity, decideIdentity, REFERENCE_INCONSISTENT_REASON } from './identity';
import { hammingHex, VisionInputError } from './image';
import { resolveModelsDir } from './models';
import { QUALITY_GATE, regateQuality, resolveGate } from './quality';
import { createVisionService, VisionBusyError, VisionClosedError, type OnnxVisionService } from './service';
import type { ImageAnalysis } from './types';

const FACES = process.env.SP_TEST_FACES_DIR ?? '/tmp/claude-0/faces';
const need = ['obama.jpg', 'obama2.jpg', 'obama_small.jpg', 'biden.jpg', 'two_people.jpg'];
const haveModels = (() => {
  try {
    resolveModelsDir();
    return true;
  } catch {
    return false;
  }
})();
const haveImages = need.every((f) => existsSync(join(FACES, f)));
const img = (f: string) => readFileSync(join(FACES, f));

/** Webcam-like frame: max side 640, JPEG. */
const webcam = (buf: Buffer, size = 640) => sharp(buf).rotate().resize({ width: size, height: size, fit: 'inside' }).jpeg({ quality: 90 }).toBuffer();

describe.skipIf(!haveModels || !haveImages)('OnnxVisionService on real images', () => {
  let vision: OnnxVisionService;
  const cache = new Map<string, ImageAnalysis>();
  const analyze = async (name: string) => {
    let a = cache.get(name);
    if (!a) {
      a = await vision.analyze(await webcam(img(name)), { embed: true, faceCrop: true });
      cache.set(name, a);
    }
    return a;
  };
  const sim = (a: ImageAnalysis, b: ImageAnalysis) => cosineSimilarity(a.embedding!, b.embedding!);

  beforeAll(async () => {
    vision = await createVisionService();
  }, 60_000);
  afterAll(async () => {
    await vision?.close();
  });

  it('detects one face in obama.jpg and two in two_people.jpg', async () => {
    const one = await vision.analyze(img('obama.jpg'));
    expect(one.faces).toHaveLength(1);
    expect(one.primary!.score).toBeGreaterThan(0.9);
    expect(one.width).toBe(910);
    // Landmarks are in original-image coordinates and inside the face box.
    const { box, landmarks } = one.primary!;
    for (const p of landmarks) {
      expect(p.x).toBeGreaterThan(box.x);
      expect(p.x).toBeLessThan(box.x + box.w);
    }
    expect(landmarks[0].x).toBeLessThan(landmarks[1].x);
    const two = await vision.analyze(img('two_people.jpg'));
    expect(two.faces).toHaveLength(2);
    expect(two.quality.issues).toContain('multiple_faces');
    expect(two.quality.usable).toBe(false);
  });

  it('produces a complete analysis: pose, quality, L2-normalised embedding, face crop, dHash', async () => {
    const a = await analyze('obama.jpg');
    expect(a.quality.usable).toBe(true);
    expect(a.quality.issues).toEqual([]);
    expect(Math.abs(a.pose!.yawDeg)).toBeLessThan(10);
    expect(a.embedding).toHaveLength(128);
    expect(Math.hypot(...a.embedding!)).toBeCloseTo(1, 4);
    expect(a.dhash).toMatch(/^[0-9a-f]{16}$/);
    expect(a.imageBrightness).toBeGreaterThan(50);
    const crop = await sharp(a.faceCropJpeg!).metadata();
    expect(crop.format).toBe('jpeg');
    expect(Math.max(crop.width!, crop.height!)).toBeLessThanOrEqual(256);
    const noEmbed = await vision.analyze(img('obama_small.jpg'));
    expect(noEmbed.embedding).toBeNull();
    expect(noEmbed.faceCropJpeg).toBeNull();
  });

  it('same person => match (obama vs obama_small); a turned face is unable_to_verify, never mismatch', async () => {
    const ref = await analyze('obama.jpg');
    const small = await analyze('obama_small.jpg');
    const r = decideIdentity(sim(ref, small), small.quality, DEFAULT_IDENTITY_THRESHOLDS);
    expect(r.decision).toBe('match');
    expect(r.confidence).toBeGreaterThan(0.9);
    // obama2.jpg is turned ~30 degrees: the similarity still clears the match threshold ...
    const turned = await analyze('obama2.jpg');
    expect(sim(ref, turned)).toBeGreaterThan(DEFAULT_IDENTITY_THRESHOLDS.match);
    // ... but the default gate refuses to decide on a turned face (asks the candidate to look at the screen).
    expect(turned.quality.issues).toContain('face_turned');
    expect(decideIdentity(sim(ref, turned), turned.quality).decision).toBe('unable_to_verify');
    const lenient = regateQuality(turned.quality, turned.faces, turned.width, turned.height, resolveGate({ maxAbsYawDeg: 40 }));
    expect(decideIdentity(sim(ref, turned), lenient).decision).toBe('match');
  });

  it('different person => mismatch (obama vs biden)', async () => {
    const ref = await analyze('obama.jpg');
    const other = await analyze('biden.jpg');
    expect(other.quality.usable).toBe(true);
    const r = decideIdentity(sim(ref, other), other.quality);
    expect(r.decision).toBe('mismatch');
    expect(r.similarity!).toBeLessThan(0.2);
  });

  it('dark, blurred, tiny and cut-off versions are unable_to_verify (not mismatch), with guidance', async () => {
    const ref = await analyze('obama.jpg');
    const base = await webcam(img('obama.jpg'));
    const cases: [string, Buffer, string][] = [
      ['very dark', await sharp(base).linear(0.12, 0).jpeg().toBuffer(), 'too_dark'],
      ['blurred', await sharp(base).blur(6).jpeg().toBuffer(), 'blurry'],
      ['tiny', await sharp(base).resize({ width: 70 }).jpeg().toBuffer(), 'face_too_small'],
      ['overexposed', await sharp(base).linear(2.2, 60).jpeg().toBuffer(), 'too_bright'],
      ['cut off', await sharp(base).extract({ left: 0, top: 0, width: Math.round(ref.primary!.landmarks[2].x), height: ref.height }).jpeg().toBuffer(), 'face_cut_off'],
    ];
    for (const [name, buf, issue] of cases) {
      const a = await vision.analyze(buf, { embed: true });
      const s = a.embedding ? sim(ref, a) : null;
      const r = decideIdentity(s, a.quality);
      expect(r.decision, name).toBe('unable_to_verify');
      expect(a.quality.issues, name).toContain(issue);
      expect(r.guidance, name).toContain(QUALITY_GUIDANCE[issue as keyof typeof QUALITY_GUIDANCE]);
    }
  });

  it('a dark frame with no detectable face says why', async () => {
    const black = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 3, g: 3, b: 3 } } }).jpeg().toBuffer();
    const a = await vision.analyze(black, { embed: true });
    expect(a.faces).toHaveLength(0);
    expect(a.embedding).toBeNull();
    expect(a.quality.issues).toEqual(['no_face', 'too_dark']);
  });

  it('dHash is stable for identical frames and differs for a different frame', async () => {
    const buf = await webcam(img('obama.jpg'));
    const a = await vision.analyze(buf);
    const b = await vision.analyze(Buffer.from(buf));
    const c = await vision.analyze(await webcam(img('biden.jpg')));
    expect(a.dhash).toBe(b.dhash);
    expect(hammingHex(a.dhash, c.dhash)).toBeGreaterThan(10);
  });

  it('builds a reference from consistent frames and refuses a mix of people', async () => {
    const base = await webcam(img('obama.jpg'));
    const variants = await Promise.all([
      base,
      sharp(base).linear(0.9, 10).jpeg().toBuffer(),
      sharp(base).extract({ left: 10, top: 10, width: 460, height: 560 }).jpeg().toBuffer(),
      sharp(base).modulate({ brightness: 1.1 }).jpeg({ quality: 70 }).toBuffer(),
    ]);
    const frames = await Promise.all(variants.map((v) => vision.analyze(v, { embed: true })));
    const ok = buildReference(frames);
    expect(ok.reasons).toEqual([]);
    expect(ok.ok).toBe(true);
    expect(ok.embeddings.length).toBeGreaterThanOrEqual(3);
    const mixed = buildReference([...frames.slice(0, 2), await analyze('biden.jpg'), frames[3]]);
    expect(mixed.ok).toBe(false);
    expect(mixed.reasons).toEqual([REFERENCE_INCONSISTENT_REASON]);
  });

  it('processes an ID photo with the relaxed gate', async () => {
    const ok = await vision.processIdPhoto(img('obama_small.jpg'));
    expect(ok.accepted).toBe(true);
    expect(ok.analysis.embedding).not.toBeNull();
    const blank = await sharp({ create: { width: 300, height: 400, channels: 3, background: { r: 200, g: 200, b: 200 } } }).jpeg().toBuffer();
    const rejected = await vision.processIdPhoto(blank);
    expect(rejected.accepted).toBe(false);
    expect(rejected.guidance[0]).toMatch(/No face/);
  });

  it('rejects non-images', async () => {
    await expect(vision.analyze(Buffer.from('not a jpeg'))).rejects.toBeInstanceOf(VisionInputError);
  });

  it('handles concurrent requests and reports stats; 640x480 analyze is fast', async () => {
    const buf = await sharp(img('obama.jpg')).resize(640, 480, { fit: 'cover', position: 'top' }).jpeg({ quality: 85 }).toBuffer();
    const results = await Promise.all(Array.from({ length: 8 }, () => vision.analyze(buf, { embed: true })));
    expect(new Set(results.map((r) => r.dhash)).size).toBe(1);
    for (const r of results) expect(cosineSimilarity(r.embedding!, results[0].embedding!)).toBeCloseTo(1, 5);
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) await vision.analyze(buf, { embed: true });
    const ms = (performance.now() - t0) / 5;
    // Generous bound so slow CI machines do not flake; ~30 ms on a 4-core dev box.
    expect(ms).toBeLessThan(400);
    expect(vision.stats.analyzed).toBeGreaterThan(8);
  });

  it('applies back-pressure and refuses work after close()', async () => {
    const small = await createVisionService({ concurrency: 1, maxQueue: 1 });
    const buf = await webcam(img('obama_small.jpg'));
    const settled = await Promise.allSettled(Array.from({ length: 6 }, () => small.analyze(buf)));
    expect(settled.filter((s) => s.status === 'fulfilled').length).toBeGreaterThanOrEqual(2);
    expect(settled.some((s) => s.status === 'rejected' && s.reason instanceof VisionBusyError)).toBe(true);
    await small.close();
    await expect(small.analyze(buf)).rejects.toBeInstanceOf(VisionClosedError);
  }, 30_000);

  it('uses the configured gate', () => {
    expect(QUALITY_GATE.minInterEyePx).toBe(28);
  });
});

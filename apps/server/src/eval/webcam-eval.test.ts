import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { FACESET_MANIFEST, FACESET_SOURCES, canonicalIdentity, localPath, rawUrl } from './datasets';
import { DEFAULT_SCHEDULE, runAccumulator, sampleTimes, simulateSequential, type Session } from './webcam-metrics';
import { CONDITION_PARAMS, mulberry32, simulateWebcamFrame, WEBCAM_CONDITIONS } from './webcam-sim';

/** A synthetic "photo": a light oval face with dark eyes / mouth on a mid-grey background. */
async function syntheticPhoto(): Promise<{ buf: Buffer; landmarks: { x: number; y: number }[] }> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500">
    <rect width="400" height="500" fill="#777"/>
    <ellipse cx="200" cy="240" rx="110" ry="150" fill="#d8b49a"/>
    <ellipse cx="160" cy="210" rx="16" ry="9" fill="#222"/><ellipse cx="240" cy="210" rx="16" ry="9" fill="#222"/>
    <path d="M200 225 L188 275 L212 275 Z" fill="#b08870"/>
    <rect x="165" y="310" width="70" height="10" rx="5" fill="#733"/></svg>`;
  const buf = await sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer();
  return { buf, landmarks: [{ x: 160, y: 210 }, { x: 240, y: 210 }, { x: 200, y: 265 }, { x: 170, y: 315 }, { x: 230, y: 315 }] };
}

async function faceLuma(jpeg: Buffer, box: { left: number; top: number; width: number; height: number }): Promise<number> {
  const { data } = await sharp(jpeg).extract(box).greyscale().raw().toBuffer({ resolveWithObject: true });
  let s = 0;
  for (const v of data) s += v;
  return s / data.length;
}

describe('webcam simulator', () => {
  it('is deterministic and renders the requested resolution', async () => {
    const { buf, landmarks } = await syntheticPhoto();
    const a = await simulateWebcamFrame(buf, { landmarks }, { condition: 'dim', resolution: '640x480', sceneSeed: 42, frameSeed: 1 });
    const b = await simulateWebcamFrame(buf, { landmarks }, { condition: 'dim', resolution: '640x480', sceneSeed: 42, frameSeed: 1 });
    expect(a.jpeg.equals(b.jpeg)).toBe(true);
    const meta = await sharp(a.jpeg).metadata();
    expect([meta.width, meta.height]).toEqual([640, 480]);
    const hd = await simulateWebcamFrame(buf, { landmarks }, { condition: 'good', resolution: '1280x720', sceneSeed: 42 });
    expect([hd.width, hd.height]).toEqual([1280, 720]);
    // Another frame of the same burst differs (noise), another scene differs more.
    const c = await simulateWebcamFrame(buf, { landmarks }, { condition: 'dim', resolution: '640x480', sceneSeed: 42, frameSeed: 2 });
    expect(c.jpeg.equals(a.jpeg)).toBe(false);
    expect(c.params.interEyePx).toBeCloseTo(a.params.interEyePx, -1);
  });

  it('exposes the face at the condition’s luma and places it at the sampled size', async () => {
    const { buf, landmarks } = await syntheticPhoto();
    for (const condition of ['good', 'dim'] as const) {
      const f = await simulateWebcamFrame(buf, { landmarks }, { condition, resolution: '640x480', sceneSeed: 7, interEye720: 75 });
      expect(f.params.interEyePx).toBeCloseTo(50, 0); // 75 px at 720p = 50 px at 480p
      const [lo, hi] = CONDITION_PARAMS[condition].faceLuma;
      expect(f.params.faceLuma).toBeGreaterThanOrEqual(lo);
      expect(f.params.faceLuma).toBeLessThanOrEqual(hi);
      // Measured luma of the central face region lands near the target (tone curve, noise and JPEG move it a little).
      const cx = 640 * 0.5;
      const measured = await faceLuma(f.jpeg, { left: Math.round(cx - 60), top: 150, width: 120, height: 120 });
      expect(Math.abs(measured - f.params.faceLuma)).toBeLessThan(45);
    }
  });

  it('declares every condition and a seeded PRNG', () => {
    expect([...WEBCAM_CONDITIONS]).toEqual(['good', 'typical', 'dim', 'backlit', 'sidelit']);
    const r1 = mulberry32(5);
    const r2 = mulberry32(5);
    expect([r1(), r1()]).toEqual([r2(), r2()]);
  });
});

describe('datasets manifest', () => {
  it('pins every source to a commit and lists >= 30 identities with >= 2 images', () => {
    for (const s of Object.values(FACESET_SOURCES)) expect(s.commit).toMatch(/^[0-9a-f]{40}$/);
    const counts = new Map<string, number>();
    for (const e of FACESET_MANIFEST) counts.set(canonicalIdentity(e.identity), (counts.get(canonicalIdentity(e.identity)) ?? 0) + 1);
    expect([...counts.values()].filter((n) => n >= 2).length).toBeGreaterThanOrEqual(30);
    expect(FACESET_MANIFEST.some((e) => e.family === 'azure-family1')).toBe(true);
    const e = FACESET_MANIFEST[0];
    expect(rawUrl(e)).toMatch(/^https:\/\/raw\.githubusercontent\.com\/Azure-Samples\/cognitive-services-sample-data-files\/[0-9a-f]{40}\/Face\/images\//);
    expect(localPath('/cache', e)).toBe('/cache/azure/Face__images__Family1-Dad1.jpg');
  });
});

describe('sequential swap test', () => {
  const sprt = { suspect: 3, confirm: 7, clear: -6, maxSamples: 4, llrClamp: 5 };

  it('windowed accumulator: clamps, confirms, clears and forgets old samples', () => {
    expect(runAccumulator([5, 5], sprt).confirmAt).toBe(1); // 5 + 5 >= 7 (a single sample is clamped to 5)
    expect(runAccumulator([9], sprt).confirmAt).toBeNull();
    expect(runAccumulator([4], sprt).suspectAt).toBe(0);
    // Strong genuine evidence clears the window: the impostor then needs two samples from scratch.
    expect(runAccumulator([-5, -5, 4, 4], sprt).confirmAt).toBe(3);
    // Only the last maxSamples samples count.
    expect(runAccumulator([2, 2, 2, -1, -1, -1, -1, 2], sprt).confirmAt).toBeNull();
  });

  it('sample schedule: every 6 s for 3 min, then every 15 s', () => {
    const t = sampleTimes(DEFAULT_SCHEDULE, 1);
    expect(t.slice(0, 3)).toEqual([0, 6, 12]);
    expect(t.filter((x) => x < 180)).toHaveLength(30);
    expect(t.length).toBe(30 + Math.ceil((3600 - 180) / 15));
  });

  it('simulation: an obvious impostor is caught in 2 samples, a clear genuine session never alarms', () => {
    const llr = (s: number) => (s < 0.3 ? 5 : -5);
    const base: Omit<Session, 'kind' | 'sims' | 'bursts'> = { key: 'k', condition: 'good', resolution: '640x480', enrol: 'good', bucket: 'good', usableRate: 1, refSelf: 0.95, refBaseline: null };
    const sd = { good: 0.02, fair: 0.03, poor: 0.04 };
    const bursts = (sims: number[], bucket: 'good' | 'poor' = 'good') => sims.map((sim) => ({ sim, bucket }));
    const imp = simulateSequential([{ ...base, kind: 'impostor', sims: [0.1, 0.12], bursts: bursts([0.1, 0.12]) }], { type: 'sprt', llr, params: sprt }, sd, { mode: 'impostor', runs: 20 });
    expect(imp.medianSamples).toBe(2);
    const gen = simulateSequential([{ ...base, kind: 'genuine_same', sims: [0.9, 0.88], bursts: bursts([0.9, 0.88]) }], { type: 'sprt', llr, params: sprt }, sd, { mode: 'genuine', runs: 5 });
    expect(gen.falseConfirmPer1000h).toBe(0);
    // Poor-light evidence alone never confirms when capped below the confirm threshold.
    const dark = simulateSequential(
      [{ ...base, bucket: 'poor', kind: 'impostor', sims: [0.1], bursts: bursts([0.1], 'poor') }],
      { type: 'sprt', llr, params: { ...sprt, maxPoorEvidence: 4 } },
      sd,
      { mode: 'impostor', runs: 10 },
    );
    expect(dark.notDetected).toBe(100);
  });
});

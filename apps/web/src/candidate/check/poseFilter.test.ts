import { describe, expect, it } from 'vitest';
import { createLivenessTracker } from '@sp/detection';
import type { FaceObservation } from '@sp/shared';
import { PoseSmoother } from './poseFilter';

/** Deterministic uniform noise in [-a, a]. */
function noiseGen(seed: number, a: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (((s >>> 0) / 4294967296) * 2 - 1) * a;
  };
}

/**
 * A candidate at 5 analysed frames/s: frontal 4 s, turns to their right to −`turnDeg` over 1.2 s, holds 2.5 s,
 * back to the centre over 1.2 s, holds 3 s — with per-frame yaw noise ±`noise` (dim room: ±8°, good light: ±1.5°).
 */
function series(turnDeg: number, noise: number, seed = 7): { t: number; yaw: number }[] {
  const rnd = noiseGen(seed, noise);
  const out: { t: number; yaw: number }[] = [];
  const keys: [number, number][] = [[0, 0], [4000, 0], [5200, -turnDeg], [7700, -turnDeg], [8900, 0], [11900, 0]];
  for (let t = 0; t <= 11900; t += 200) {
    let y = 0;
    for (let i = 1; i < keys.length; i++) {
      const [t0, y0] = keys[i - 1]!;
      const [t1, y1] = keys[i]!;
      if (t <= t1) {
        y = y0 + ((y1 - y0) * (t - t0)) / Math.max(1, t1 - t0);
        break;
      }
    }
    out.push({ t, yaw: y + rnd() });
  }
  return out;
}

function face(yaw: number, pitch = 0): FaceObservation {
  return { yaw, pitch, roll: 0, box: { x: 0.4, y: 0.3, w: 0.2, h: 0.3 }, score: 0.9 } as unknown as FaceObservation;
}

/** Frames the tracker would capture for a turn_right step (centre from the frontal part). */
function captures(pts: { t: number; yaw: number }[], smooth: boolean): number {
  const tr = createLivenessTracker({ steps: [{ index: 0, action: 'turn_right', instruction: 'Turn right' }] as never, targetYawDeg: 20, targetPitchDeg: 12, framesPerStep: 3, maxFramesPerStep: 6, awaitVerdict: true });
  tr.setCentre({ yaw: 0, pitch: 0 });
  const sm = new PoseSmoother();
  let n = 0;
  for (const p of pts) {
    const pose = smooth ? sm.push(p.t, p.yaw, 0) : { yaw: p.yaw, pitch: 0 };
    const pr = tr.update(face(pose.yaw, pose.pitch), 1, p.t);
    if (pr.readyToCapture) {
      tr.markCaptured(p.t);
      n++;
    }
  }
  return n;
}

describe('PoseSmoother', () => {
  it('follows a steady pose almost unfiltered in good light (short window)', () => {
    const sm = new PoseSmoother();
    let out = { yaw: 0, pitch: 0, noiseDeg: 0, windowMs: 0 };
    for (const p of series(28, 1.5)) out = sm.push(p.t, p.yaw, 0);
    expect(sm.noise()).toBeLessThan(2);
    expect(out.windowMs).toBeLessThanOrEqual(300);
  });

  it('widens the window when the pose is jittery (dim room) and keeps a held turn steady', () => {
    const sm = new PoseSmoother();
    const held: number[] = [];
    for (const p of series(24, 8)) {
      const o = sm.push(p.t, p.yaw, 0);
      if (p.t >= 6200 && p.t <= 7700) held.push(o.yaw);
    }
    expect(sm.windowMs()).toBeGreaterThan(700);
    // Raw: ±8° around −24; smoothed: within a few degrees of the true pose.
    expect(Math.max(...held) - Math.min(...held)).toBeLessThan(8);
    expect(held.every((y) => y < -16 && y > -32)).toBe(true);
  });

  it('a genuine turn does not inflate the noise estimate in good light', () => {
    const sm = new PoseSmoother();
    for (const p of series(30, 1)) sm.push(p.t, p.yaw, 0);
    expect(sm.noise()).toBeLessThan(2);
  });

  it('reset() drops the history (face lost) but keeps the noise estimate', () => {
    const sm = new PoseSmoother();
    for (const p of series(20, 8)) sm.push(p.t, p.yaw, 0);
    const n = sm.noise();
    sm.reset();
    expect(sm.noise()).toBe(n);
    expect(sm.push(20_000, 12, 3)).toMatchObject({ yaw: 12, pitch: 3 });
  });
});

describe('liveness capture with dim-light pose noise (tracker replay)', () => {
  it('good light: the held turn is captured with or without smoothing', () => {
    expect(captures(series(24, 1.5), false)).toBeGreaterThanOrEqual(3);
    expect(captures(series(24, 1.5), true)).toBeGreaterThanOrEqual(3);
  });

  it('dim room (±8° jitter): raw poses rarely satisfy "stopped at the peak"; smoothed poses are captured', () => {
    let raw = 0;
    let smooth = 0;
    for (let seed = 1; seed <= 20; seed++) {
      if (captures(series(26, 8, seed), false) >= 3) raw++;
      if (captures(series(26, 8, seed), true) >= 3) smooth++;
    }
    expect(smooth).toBeGreaterThanOrEqual(16);
    expect(smooth).toBeGreaterThan(raw);
  });

  it('a head that never turns far enough is still not captured when smoothed (no false progress)', () => {
    for (let seed = 1; seed <= 10; seed++) expect(captures(series(8, 8, seed), true)).toBe(0);
  });
});

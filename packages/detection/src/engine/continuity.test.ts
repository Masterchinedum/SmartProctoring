import { describe, expect, it } from 'vitest';
import type { FaceObservation, NormBox } from '@sp/shared';
import { Driver, face, frame, policy } from '../testing/fixtures';
import { describe as describeFace, person, type Person, type RenderOptions } from '../testing/faces';
import { CONTINUITY } from './detectors/continuity';
import { Rng } from '../eval/prng';

/**
 * Swap triggers on synthetic observation streams (engine/detectors/continuity.ts). Faces carry appearance
 * descriptors rendered from synthetic people (testing/faces.ts), exactly as the browser adapter attaches
 * them. A trigger only means "take an identity sample now" — the server decides.
 */

const BOX: NormBox = { x: 0.36, y: 0.24, w: 0.28, h: 0.42 };
const A = person(11);
const B = person(22);

/** A face observation of person `p` at `box` with pose and rendering options, plus its descriptor. */
function seen(p: Person, box: NormBox = BOX, o: RenderOptions & { pitch?: number } = {}, over: Partial<FaceObservation> = {}): FaceObservation {
  const d = describeFace(p, box, { noise: 3, ...o });
  return { ...face({ box, yaw: o.yaw ?? 0, pitch: o.pitch ?? -5 }), ...over, descriptor: d } as FaceObservation;
}

const swaps = (d: Driver) => [...d.identity('track_break'), ...d.identity('appearance_change')];

describe('appearance_change', () => {
  it('a quick A→B swap in place (no absence, same position and size) is sampled within ~0.6 s', () => {
    const d = new Driver({ identityIntervalSec: 600 });
    d.run(0, 10, (_s, i) => ({ faces: [seen(A, BOX, { seed: i })] }));
    d.run(10, 20, (_s, i) => ({ faces: [seen(B, BOX, { seed: 1000 + i })] }));
    const ac = d.identity('appearance_change');
    expect(ac).toHaveLength(1);
    expect(ac[0].at).toBeGreaterThanOrEqual(10.3);
    expect(ac[0].at).toBeLessThanOrEqual(10.8);
    expect(d.identity('track_break')).toHaveLength(0);
    const fired = d.engine.continuityState().fired;
    expect(fired.map((f) => f.reason)).toEqual(['appearance']);
    expect(fired[0].detail?.patch).toBeGreaterThan(fired[0].detail?.threshold ?? 1);
  });

  it('a swap to someone sitting at a different measured head pose (+15° pitch) still fires', () => {
    const d = new Driver({ identityIntervalSec: 600 });
    d.run(0, 10, (_s, i) => ({ faces: [seen(A, BOX, { seed: i, pitch: -5 })] }));
    d.run(10, 20, (_s, i) => ({ faces: [seen(B, BOX, { seed: 1000 + i, pitch: 10 })] }));
    expect(d.identity('appearance_change')).toHaveLength(1);
  });

  it('a single odd frame (blink, motion blur, hand passing) does not fire: the change must persist ≥ 300 ms', () => {
    const d = new Driver({ identityIntervalSec: 600 });
    d.run(0, 30, (s, i) => ({ faces: [seen(Math.abs(s - 12) < 0.01 || Math.abs(s - 20.2) < 0.01 ? B : A, BOX, { seed: i })] }));
    expect(swaps(d)).toHaveLength(0);
  });

  it('a lasting change (e.g. glasses put on) fires once, then becomes the new baseline', () => {
    const glasses: Person = { ...A, browT: A.browT + 0.08, eyeR: A.eyeR + 0.035, skin: A.skin - 25 };
    const d = new Driver({ identityIntervalSec: 600 });
    d.run(0, 10, (_s, i) => ({ faces: [seen(A, BOX, { seed: i })] }));
    d.run(10, 60, (_s, i) => ({ faces: [seen(glasses, BOX, { seed: 500 + i })] }));
    expect(d.identity('appearance_change').length).toBeLessThanOrEqual(1);
    expect(d.identity('track_break')).toHaveLength(0);
  });
});

describe('track_break', () => {
  it('fires when the face is missing ≥ 250 ms (≥ 2 frames) and comes back within 3 s', () => {
    const d = new Driver({ identityIntervalSec: 600 });
    d.run(0, 10, (_s, i) => ({ faces: [seen(A, BOX, { seed: i })] }));
    d.run(10, 10.6, () => ({ faces: [] })); // 3 frames missing
    d.run(10.6, 16, (_s, i) => ({ faces: [seen(B, BOX, { seed: 800 + i })] }));
    const tb = d.identity('track_break');
    expect(tb).toHaveLength(1);
    expect(tb[0].at).toBeGreaterThanOrEqual(10.6);
    expect(tb[0].at).toBeLessThan(11.4);
    expect(d.engine.continuityState().fired[0]).toMatchObject({ trigger: 'track_break', reason: 'gap' });
  });

  it('a single missed detection frame is not a break; an absence ≥ 3 s is a face_return sample instead', () => {
    const d = new Driver({ identityIntervalSec: 600 });
    d.run(0, 10, (_s, i) => ({ faces: [seen(A, BOX, { seed: i })] }));
    d.tick(10, { faces: [] });
    d.run(10.2, 20, (_s, i) => ({ faces: [seen(A, BOX, { seed: 300 + i })] }));
    expect(swaps(d)).toHaveLength(0);
    d.run(20, 25, () => ({ faces: [] }));
    d.run(25, 30, (_s, i) => ({ faces: [seen(A, BOX, { seed: 600 + i })] }));
    expect(swaps(d)).toHaveLength(0);
    expect(d.identity('face_return')).toHaveLength(1);
  });

  it('fires on a face-box jump between consecutive frames (swap with a position change)', () => {
    const d = new Driver({ identityIntervalSec: 600 });
    const moved: NormBox = { ...BOX, x: BOX.x + 0.26 };
    d.run(0, 10, (_s, i) => ({ faces: [seen(A, BOX, { seed: i })] }));
    d.run(10, 16, (_s, i) => ({ faces: [seen(B, moved, { seed: 700 + i })] }));
    const tb = d.identity('track_break');
    expect(tb).toHaveLength(1);
    expect(tb[0].at).toBeLessThan(10.8);
    expect(d.engine.continuityState().fired[0]).toMatchObject({ reason: 'jump' });
  });

  it('a brief second face (0.6 s) then one face again fires; a long one is sampled as after_multiple_people', () => {
    const d = new Driver({ identityIntervalSec: 600 });
    const other: NormBox = { x: 0.72, y: 0.2, w: 0.18, h: 0.27 };
    d.run(0, 10, (_s, i) => ({ faces: [seen(A, BOX, { seed: i })] }));
    d.run(10, 10.6, (_s, i) => ({ faces: [seen(A, BOX, { seed: 50 + i }), seen(B, other, { seed: 60 + i })] }));
    d.run(10.6, 20, (_s, i) => ({ faces: [seen(A, BOX, { seed: 70 + i })] }));
    expect(d.identity('track_break')).toHaveLength(1);
    d.run(20, 23, (_s, i) => ({ faces: [seen(A, BOX, { seed: 90 + i }), seen(B, other, { seed: 95 + i })] }));
    d.run(23, 30, (_s, i) => ({ faces: [seen(A, BOX, { seed: 99 + i })] }));
    expect(d.identity('track_break')).toHaveLength(1);
    expect(d.identity('after_multiple_people')).toHaveLength(1);
  });

  it('is rate-limited to one swap trigger per 4 s — a second break is deferred, not lost', () => {
    const d = new Driver({ identityIntervalSec: 600 });
    d.run(0, 10, (_s, i) => ({ faces: [seen(A, BOX, { seed: i })] }));
    d.run(10, 10.6, () => ({ faces: [] }));
    d.run(10.6, 12, (_s, i) => ({ faces: [seen(A, BOX, { seed: 200 + i })] }));
    d.run(12, 12.6, () => ({ faces: [] }));
    d.run(12.6, 20, (_s, i) => ({ faces: [seen(A, BOX, { seed: 400 + i })] }));
    const tb = d.identity('track_break');
    expect(tb).toHaveLength(2);
    const fired = d.engine.continuityState().fired;
    expect(fired[1].armedAt).toBeDefined();
    expect(fired[1].armedAt! - fired[0].t).toBeGreaterThanOrEqual(CONTINUITY.minGapMs);
    expect(tb[1].at - tb[0].at).toBeGreaterThanOrEqual(3);
  });

  it('boxes touching the frame edge are not compared (a face leaving the view shrinks its clamped box)', () => {
    const d = new Driver({ identityIntervalSec: 600 });
    d.run(0, 10, (_s, i) => ({ faces: [seen(A, BOX, { seed: i })] }));
    // Leaning out to the right: the clamped box shrinks quickly at the edge.
    d.run(10, 11, (s, i) => {
      const w = 0.28 - (s - 10) * 0.2;
      return { faces: [seen(A, { x: 1 - w, y: BOX.y, w, h: BOX.h }, { seed: 30 + i }, { cutOff: true })] };
    });
    expect(d.identity('track_break')).toHaveLength(0);
  });
});

describe('ordinary behaviour does not trigger swap samples', () => {
  it('two minutes of head movement (±30° yaw, nods), talking, leaning in and out, drifting and lighting changes', () => {
    const rng = new Rng(7);
    const d = new Driver({ identityIntervalSec: 600 });
    d.run(
      0,
      120,
      (s, i) => {
        const yaw = 30 * Math.sin((2 * Math.PI * s) / 9) * (s % 40 < 20 ? 1 : 0.5);
        const pitch = -5 + 12 * Math.sin((2 * Math.PI * s) / 13);
        const lean = 0.28 + 0.1 * Math.max(0, Math.sin((2 * Math.PI * s) / 30)); // leans toward the camera and back
        const cx = 0.5 + 0.05 * Math.sin((2 * Math.PI * s) / 17) + rng.normal(0, 0.004);
        const cy = 0.45 + 0.03 * Math.sin((2 * Math.PI * s) / 23) + rng.normal(0, 0.004);
        const box: NormBox = { x: cx - lean / 2, y: cy - lean * 0.75, w: lean, h: lean * 1.5 };
        const talking = s % 30 > 10 ? Math.abs(Math.sin(s * 9)) : 0;
        const gain = 0.8 + 0.3 * Math.sin((2 * Math.PI * s) / 60); // clouds / a lamp
        return { faces: [seen(A, box, { seed: i, yaw, pitch, mouthOpen: talking, gain, noise: 4 })] };
      },
      5,
    );
    expect(swaps(d)).toEqual([]);
  });

  it('also at a low analysis rate (1.5 fps on a slow machine)', () => {
    const d = new Driver({ identityIntervalSec: 600 });
    d.run(
      0,
      60,
      (s, i) => {
        const cx = 0.5 + 0.08 * Math.sin((2 * Math.PI * s) / 7);
        const w = 0.28 + 0.06 * Math.sin((2 * Math.PI * s) / 11);
        return { faces: [seen(A, { x: cx - w / 2, y: 0.24, w, h: w * 1.5 }, { seed: i, yaw: 15 * Math.sin(s) })] };
      },
      1.5,
    );
    expect(swaps(d)).toEqual([]);
  });

  it('without descriptors (recorded traces, other hosts) only the track-based triggers run', () => {
    const d = new Driver({ identityIntervalSec: 600 });
    d.run(0, 10);
    d.run(10, 10.6, () => ({ faces: [] }));
    d.run(10.6, 20);
    expect(d.identity('track_break')).toHaveLength(1);
    expect(d.identity('appearance_change')).toHaveLength(0);
  });
});

describe('identity samples are not silenced by lighting heuristics', () => {
  /** A dim, low-contrast room: face brightness ~38, frame luma 30, visibility lowered by the dark face region. */
  const dim = { frame: frame({ luma: 30, contrast: 10, sharpness: 20 }) };
  const dimFace = (over: Partial<FaceObservation> = {}) => face({ brightness: 38, visibility: 0.42, ...over });

  it('a dim single face still gets periodic samples while lighting_unusable is open', () => {
    const d = new Driver({ identityIntervalSec: 10, policy: policy({ lightingSec: 3 }) });
    d.run(0, 45, () => ({ ...dim, faces: [dimFace()] }));
    expect(d.engine.status().open).toContain('lighting_unusable');
    expect(d.identity('periodic').map((x) => Math.round(x.at))).toEqual([10, 20, 30, 40]);
  });

  it('a dim single face still gets a track_break sample after a brief interruption', () => {
    const d = new Driver({ identityIntervalSec: 600 });
    d.run(0, 10, () => ({ ...dim, faces: [dimFace()] }));
    d.run(10, 10.6, () => ({ ...dim, faces: [] }));
    d.run(10.6, 15, () => ({ ...dim, faces: [dimFace()] }));
    expect(d.identity('track_break')).toHaveLength(1);
  });

  it('only no face, several faces, a cut-off or a badly obstructed face stop sampling', () => {
    const d = new Driver({ identityIntervalSec: 5 });
    d.run(0, 20, () => ({ faces: [face({ cutOff: true })] }));
    d.run(20, 40, () => ({ faces: [face({ visibility: 0.2 })] }));
    expect(d.identity('periodic')).toHaveLength(0);
    d.run(40, 50, () => ({ faces: [face({ visibility: 0.35 })] }));
    expect(d.identity('periodic').length).toBeGreaterThanOrEqual(1);
  });
});

describe('identity cadence', () => {
  it('samples every startupIntervalSec during the start-up window, then every periodicCheckIntervalSec', () => {
    const d = new Driver({ identityIntervalSec: 15, identityStartupIntervalSec: 6, identityStartupWindowSec: 30 });
    d.run(0, 80);
    expect(d.identity('periodic').map((x) => Math.round(x.at))).toEqual([6, 12, 18, 24, 30, 45, 60, 75]);
  });

  it('follows a host (server) schedule for the next routine sample, then returns to the local interval', () => {
    const d = new Driver({ identityIntervalSec: 15 });
    d.run(0, 5);
    d.engine.scheduleIdentitySample(2000, d.engine.identitySchedule().lastSampleAt! + 5000);
    expect(d.engine.identitySchedule().hostScheduled).toBe(true);
    d.run(5, 40);
    expect(d.identity('periodic').map((x) => Math.round(x.at))).toEqual([7, 22, 37]);
  });

  it('a host sample (exam start, server request) restarts the routine timer', () => {
    const d = new Driver({ identityIntervalSec: 10 });
    d.run(0, 8);
    d.engine.noteIdentitySample(d.engine.identitySchedule().lastSampleAt! + 8000);
    d.run(8, 30);
    expect(d.identity('periodic').map((x) => Math.round(x.at))).toEqual([18, 28]);
  });

  it('the start-up window restarts after a flush (pause / resume)', () => {
    const d = new Driver({ identityIntervalSec: 20, identityStartupIntervalSec: 5, identityStartupWindowSec: 12 });
    d.run(0, 30);
    d.flush(30, 'pause');
    d.run(100, 125);
    expect(d.identity('periodic').map((x) => Math.round(x.at))).toEqual([5, 10, 15, 105, 110, 115]);
  });
});

import { describe, expect, it } from 'vitest';
import type { ActivityTiming, FrameObservation } from '@sp/shared';
import { BASELINE, Driver, face, ms, rel } from '../testing/fixtures';

/**
 * Looking-away detectors with exam-page activity (engine/attention.ts): the learned working region, the
 * typing excuse, looking up, glance patterns and the state kept across periods.
 */

const FAMILY = ['looking_away', 'repeated_looking_away', 'offscreen_attention_pattern'] as const;
const family = (d: Driver) => FAMILY.flatMap((t) => d.of(t));

/** 30 s of reading + mouse use at a work pose (the region is learned). */
function warmUp(d: Driver, yaw = 0, pitch = -5, from = 0, to = 30): void {
  d.run(from, to, (s) => ({ faces: [face({ yaw: yaw + Math.sin(s) * 4, pitch: pitch + Math.cos(s * 1.3) * 2 })], activity: { pointerAt: ms(s), keyAt: null } }));
}

/** Activity with the last key at `keySec` (null = none) and old pointer use. */
const act = (keySec: number | null): ActivityTiming => ({ keyAt: keySec === null ? null : ms(keySec), answerKeyAt: keySec === null ? null : ms(keySec), pointerAt: ms(20) });

describe('looking away while working (exam-page activity)', () => {
  it('hunt-and-peck typing with 2.5 s keyboard glances is not flagged; the same looks without typing are', () => {
    const typingRun = (keys: boolean) => {
      const d = new Driver();
      warmUp(d);
      let lastKey: number | null = null;
      d.run(30, 150, (s) => {
        const c = (s - 30) % 4.5; // 2.5 s at the keyboard, 2 s at the text
        const atKb = c < 2.5;
        if (keys && atKb && c >= 0.5 && Math.round(c * 10) % 3 === 0) lastKey = s;
        return { faces: [atKb ? face({ yaw: 3, pitch: -38, gazeY: -0.6 }) : face({ yaw: -4, pitch: -8 })], activity: act(lastKey) };
      });
      return d;
    };
    expect(family(typingRun(true))).toHaveLength(0);
    expect(family(typingRun(false)).length).toBeGreaterThan(0);
  });

  it('a look down that continues after the typing stopped counts from the last keystroke', () => {
    const d = new Driver();
    warmUp(d);
    // Typing at the keyboard until 33.0, then the phone in the lap (deeper) without typing until 43.
    d.run(30, 33, (s) => ({ faces: [face({ pitch: -36, gazeY: -0.5 })], activity: act(Math.floor(s * 3) / 3) }));
    d.run(33, 43, () => ({ faces: [face({ pitch: -60, gazeY: -0.9 })], activity: act(32.8) }));
    d.run(43, 50, () => ({ faces: [face()], activity: act(32.8) }));
    const eps = d.final('looking_away');
    expect(eps).toHaveLength(1);
    expect(eps[0].details.direction).toBe('down');
    expect(rel(eps[0].startedAt)!).toBeGreaterThanOrEqual(32.7);
    expect(rel(eps[0].startedAt)!).toBeLessThanOrEqual(33.3);
    // Opened ~5 s after the typing stopped (not 5 s after the 3-s excuse ran out).
    expect(d.openedAt('looking_away')!).toBeLessThan(39);
  });

  it('looking up to think: 8 s is not flagged, a look up longer than lookUpSec (15 s) is', () => {
    const d = new Driver();
    warmUp(d);
    d.run(30, 38, () => ({ faces: [face({ pitch: -5 + 42, gazeY: 0.3 })], activity: act(null) }));
    d.run(38, 60, () => ({ faces: [face()], activity: act(null) }));
    expect(family(d)).toHaveLength(0);
    d.run(60, 78, () => ({ faces: [face({ pitch: -5 + 42, gazeY: 0.3 })], activity: act(null) }));
    d.run(78, 85, () => ({ faces: [face()], activity: act(null) }));
    const eps = d.final('looking_away');
    expect(eps).toHaveLength(1);
    expect(eps[0].details.direction).toBe('up');
    expect(d.openedAt('looking_away')!).toBeGreaterThanOrEqual(74.8);
  });

  const glances = (d: Driver, over: Parameters<typeof face>[0], n = 6, every = 15, dur = 2.5, start = 30) => {
    for (let i = 0; i < n; i++) {
      const t = start + i * every;
      d.run(t, t + dur, () => ({ faces: [face(over)], activity: act(null) }));
      d.run(t + dur, t + every, (s) => ({ faces: [face({ yaw: Math.sin(s) * 3 })], activity: { ...act(null), pointerAt: ms(s) } }));
    }
  };

  it('looks up do not form glance patterns (unless clearly beyond the region); the same number of looks to a side does', () => {
    const up = new Driver();
    warmUp(up);
    glances(up, { pitch: -5 + 34, gazeY: 0.3 });
    expect(family(up)).toHaveLength(0);
    // Far above (more than 10° beyond the up limit: notes on the wall above the screen) they do.
    const wall = new Driver();
    warmUp(wall);
    glances(wall, { pitch: -5 + 50, gazeY: 0.4 });
    expect(wall.final('offscreen_attention_pattern')).toHaveLength(1);
    expect(wall.final('offscreen_attention_pattern')[0].details.direction).toBe('up');
    const side = new Driver();
    warmUp(side);
    glances(side, { yaw: 42, gazeX: 0.3 });
    expect(side.final('offscreen_attention_pattern')).toHaveLength(1);
    expect(side.final('offscreen_attention_pattern')[0].details.direction).toBe('left');
  });

  it('same-direction means the same off-screen spot: similar angle but very different distances do not combine', () => {
    const d = new Driver();
    warmUp(d);
    glances(d, { yaw: 31, pitch: -27 }, 2, 15, 2.5, 30);
    glances(d, { yaw: 60, pitch: -60, gazeY: -0.6 }, 2, 15, 2.5, 60);
    expect(d.of('offscreen_attention_pattern')).toHaveLength(0);
    // Four looks at the SAME spot do.
    const e = new Driver();
    warmUp(e);
    glances(e, { yaw: 31, pitch: -27 }, 4, 15, 2.5, 30);
    expect(e.final('offscreen_attention_pattern')).toHaveLength(1);
  });

  it('sustained looks report where attention was measured from', () => {
    const d = new Driver();
    warmUp(d);
    d.run(30, 40, () => ({ faces: [face({ yaw: 45 })], activity: act(null) }));
    d.run(40, 45, () => ({ faces: [face()], activity: act(null) }));
    expect(d.final('looking_away')[0].details.reference).toBe('learned');
    const legacy = new Driver();
    legacy.run(0, 10, () => ({ faces: [face({ yaw: 45 })] }));
    legacy.run(10, 15);
    expect(legacy.final('looking_away')[0].details.reference).toBe('calibration');
  });
});

describe('the working region across pause / resume', () => {
  /** Camera beside an external monitor: work 42° to the side of the calibration. */
  const WORK = 42;
  const atMonitor = (s: number): Partial<FrameObservation> => ({ faces: [face({ yaw: WORK + Math.sin(s) * 3 })], activity: act(null) });

  it('is kept for the next period with the same camera and reset with another camera', () => {
    const a = new Driver();
    a.cameraInfo(0, 'Integrated Camera', 'cam-a');
    warmUp(a, WORK, -5, 0, 40);
    expect(a.engine.attentionInfo().reference).toBe('learned');
    a.run(40, 60, atMonitor);
    expect(family(a)).toHaveLength(0);
    a.flush(60, 'pause');
    const state = a.engine.attentionState();

    // Resume, same camera: reading at the monitor without touching anything is not away.
    const b = new Driver({ attentionState: state });
    b.cameraInfo(100, 'Integrated Camera', 'cam-a');
    b.run(100, 130, atMonitor);
    expect(family(b)).toHaveLength(0);
    expect(b.engine.attentionInfo().reference).toBe('learned');

    // Resume with another camera: the region no longer applies (cold start around the new calibration).
    const c = new Driver({ attentionState: state });
    c.cameraInfo(100, 'USB Camera', 'cam-b');
    c.run(100, 130, atMonitor);
    expect(c.engine.attentionInfo().reference).toBe('cold_start');
    expect(c.final('looking_away').length).toBeGreaterThan(0);
  });

  it('a camera change during the period resets it too', () => {
    const d = new Driver();
    d.cameraInfo(0, 'Integrated Camera', 'cam-a');
    warmUp(d, WORK, -5, 0, 40);
    expect(d.engine.attentionInfo().samples.pointer).toBeGreaterThan(0);
    d.cameraInfo(40, 'USB Camera', 'cam-b');
    d.run(40, 41, atMonitor);
    expect(d.engine.attentionInfo().samples.pointer).toBe(0);
  });

  it('the Driver baseline is the calibration prior', () => {
    const d = new Driver();
    expect(d.engine.attentionInfo().centre).toEqual({ yaw: BASELINE.yaw, pitch: BASELINE.pitch });
  });
});

import { describe, expect, it } from 'vitest';
import type { ActivityTiming, FaceObservation } from '@sp/shared';
import { BASELINE, face, ms, policy } from '../testing/fixtures';
import { ATTENTION, AttentionModel } from './attention';

/** Feed `sec` seconds at 5 Hz from `from`; `f(s)` gives the face and activity per tick. */
function feed(m: AttentionModel, from: number, sec: number, f: (s: number) => { face: FaceObservation; activity?: ActivityTiming }) {
  const out = [];
  for (let i = 0; i < Math.round(sec * 5); i++) {
    const s = from + i / 5;
    const x = f(s);
    out.push(m.assess(ms(s), x.face, x.activity, true));
  }
  return out;
}

/** Activity: pointer moving right now. */
const pointing = (s: number): ActivityTiming => ({ pointerAt: ms(s), keyAt: null });
/** Activity: typing right now (and the pointer used long ago). */
const typing = (s: number): ActivityTiming => ({ keyAt: ms(s), answerKeyAt: ms(s), pointerAt: ms(0) });
/** Activity reported, but nothing recent. */
const idle = (): ActivityTiming => ({ keyAt: null, pointerAt: null });

/** A model that learned a work pose at (yaw, pitch) from 30 s of mouse use. */
function learned(yaw: number, pitch: number, over: Parameters<typeof policy>[0] = {}) {
  const m = new AttentionModel(policy(over));
  m.setBaseline(BASELINE); // yaw 0, pitch −5
  feed(m, 0, 30, (s) => ({ face: face({ yaw: yaw + Math.sin(s) * 4, pitch: pitch + Math.cos(s * 1.3) * 3 }), activity: pointing(s) }));
  return m;
}

describe('AttentionModel: the working region', () => {
  it('without activity reports: the calibration baseline is the centre and the policy thresholds the limits', () => {
    const m = new AttentionModel(policy());
    m.setBaseline(BASELINE);
    const r = feed(m, 0, 10, () => ({ face: face({ yaw: 30, pitch: -5 }) }));
    expect(m.info().reference).toBe('calibration');
    expect(m.info().limits).toEqual({ left: 28, right: 28, up: 35, down: 20 });
    expect(r[r.length - 1].away).toBe(true);
    expect(r[r.length - 1].h).toBeCloseTo(30, 0);
  });

  it('learns the work pose from mouse use (camera beside an external monitor: work 30° to the side)', () => {
    const m = new AttentionModel(policy());
    m.setBaseline(BASELINE);
    // Cold start: centred on the baseline with generous limits.
    const first = feed(m, 0, 0.2, (s) => ({ face: face({ yaw: 30, pitch: -5 }), activity: idle() }))[0];
    expect(m.info().reference).toBe('cold_start');
    expect(first.limits.left).toBeGreaterThan(policy().lookAwayYawDeg + 5);
    feed(m, 1, 30, (s) => ({ face: face({ yaw: 30 + Math.sin(s) * 4, pitch: -5 }), activity: pointing(s) }));
    const info = m.info();
    expect(info.reference).toBe('learned');
    expect(info.centre.yaw).toBeGreaterThan(26);
    expect(info.centre.yaw).toBeLessThan(34);
    expect(info.offsetFromBaseline.yaw).toBeGreaterThan(25);
    // At the work pose (even reading its far side) the candidate is not away; back at the camera, 30° off, they are.
    expect(feed(m, 40, 1, () => ({ face: face({ yaw: 38, pitch: -5 }), activity: idle() })).every((a) => !a.away)).toBe(true);
    expect(feed(m, 50, 1, () => ({ face: face({ yaw: -2, pitch: -5 }), activity: idle() })).every((a) => a.away)).toBe(true);
  });

  it('camera above the screen: the work pose 12° below the calibration is learned; reading the lower screen is not away', () => {
    const m = learned(0, -17);
    expect(m.info().centre.pitch).toBeLessThan(-14);
    const r = feed(m, 40, 5, () => ({ face: face({ yaw: 6, pitch: -22, gazeY: -0.5 }), activity: idle() }));
    expect(r.every((a) => !a.away)).toBe(true);
  });

  it('policy attentionReference = calibration: nothing is learned even with activity', () => {
    const m = new AttentionModel(policy({ attentionReference: 'calibration' }));
    m.setBaseline(BASELINE);
    feed(m, 0, 30, (s) => ({ face: face({ yaw: 30 }), activity: pointing(s) }));
    expect(m.info().reference).toBe('calibration');
    expect(m.info().samples.pointer).toBe(0);
  });

  it('robust centre: a few mouse samples while looking elsewhere do not move it', () => {
    const m = new AttentionModel(policy());
    m.setBaseline(BASELINE);
    feed(m, 0, 40, (s) => ({ face: face({ yaw: s % 10 < 1.5 ? 45 : 0 + Math.sin(s) * 3, pitch: -5 }), activity: pointing(s) }));
    expect(Math.abs(m.info().centre.yaw)).toBeLessThan(4);
    expect(m.info().limits.left).toBeLessThanOrEqual(ATTENTION.maxExtent.side + ATTENTION.marginDeg);
  });

  it('memory is bounded', () => {
    const m = new AttentionModel(policy());
    m.setBaseline(BASELINE);
    feed(m, 0, 600, (s) => ({ face: face({ yaw: Math.sin(s) * 5 }), activity: pointing(s) }));
    const st = m.exportState();
    expect(st.pointer.length).toBeLessThanOrEqual(ATTENTION.caps.pointer * 4);
    expect(m.info().samples.pointer).toBe(ATTENTION.caps.pointer);
  });
});

describe('AttentionModel: typing at the keyboard', () => {
  it('looking down at the keyboard is excused while a key was pressed within typingExcuseSec, not without typing', () => {
    const m = learned(0, -5);
    const kb = face({ yaw: 2, pitch: -35, gazeY: -0.5 });
    const typed = feed(m, 40, 2, (s) => ({ face: kb, activity: typing(s) }));
    expect(typed.every((a) => a.excused && !a.away)).toBe(true);
    // 4 s after the last key: away (looking down without typing).
    const after = m.assess(ms(46), kb, { keyAt: ms(42), answerKeyAt: ms(42), pointerAt: ms(0) }, true);
    expect(after.away).toBe(true);
    expect(after.excused).toBe(false);
    // typingExcuseSec = 0 turns the excuse off.
    const off = learned(0, -5, { typingExcuseSec: 0 });
    expect(off.assess(ms(40), kb, typing(40), true).away).toBe(true);
  });

  it('never excuses a side breach, even while typing (notes beside the laptop)', () => {
    const m = learned(0, -5);
    const a = m.assess(ms(40), face({ yaw: 32, pitch: -30, gazeX: 0.4, gazeY: -0.4 }), typing(40), true);
    expect(a.away).toBe(true);
    expect(a.excused).toBe(false);
  });

  it('learns the keyboard cone only from looks confirmed by a later keystroke', () => {
    const m = learned(0, -5);
    // Hunt-and-peck: looking at the keys (pitch −30) and pressing one every 0.3 s for 20 s.
    feed(m, 40, 20, (s) => ({ face: face({ yaw: Math.sin(s * 2) * 5, pitch: -30 + Math.cos(s) * 2 }), activity: { keyAt: ms(Math.floor(s / 0.3) * 0.3), pointerAt: ms(0) } }));
    const kb = m.info().keyboard;
    expect(m.info().samples.keyboard).toBeGreaterThan(ATTENTION.kbMinSamples);
    expect(kb.bottom).toBeGreaterThan(-45);
    expect(kb.xHi - kb.xLo).toBeLessThanOrEqual(2 * ATTENTION.kbMaxHalfWidth + 0.01);
    // Then the phone in the lap (pitch −55) right after the last key: not learned as keyboard, and away after the excuse.
    const before = m.info().samples.keyboard;
    const r = feed(m, 61, 6, () => ({ face: face({ yaw: 0, pitch: -55, gazeY: -0.9 }), activity: { keyAt: ms(60.9), pointerAt: ms(0) } }));
    expect(m.info().samples.keyboard).toBe(before);
    expect(r[r.length - 1].away).toBe(true);
    expect(r[0].inKeyboard).toBe(false);
  });
});

describe('AttentionModel: looking up', () => {
  it('looking up to think is not away below lookUpPitchDeg; beyond it, it is reported as `up`', () => {
    const m = learned(0, -5);
    expect(m.assess(ms(40), face({ pitch: -5 + 28, gazeY: 0.2 }), idle(), true).away).toBe(false);
    const a = m.assess(ms(41), face({ pitch: -5 + 45, gazeY: 0.3 }), idle(), true);
    expect(a.away).toBe(true);
    expect(a.up).toBe(true);
    // Up and to the side (thinking up-left) is also a look up; far to the side at eye level is not.
    const upLeft = m.assess(ms(42), face({ yaw: 30, pitch: -5 + 20 }), idle(), true);
    expect(upLeft.away && upLeft.up).toBe(true);
    const side = m.assess(ms(43), face({ yaw: 45, pitch: -5 }), idle(), true);
    expect(side.away && !side.up).toBe(true);
    expect(m.upCountsForPatterns(a.v)).toBe(a.v >= a.limits.up + ATTENTION.upPatternExtraDeg);
  });
});

describe('AttentionModel: state across periods', () => {
  it('export / import keeps the learned region; a different camera or a moved baseline resets it', () => {
    const m = learned(25, -5);
    m.setCamera('cam-a');
    const st = m.exportState();
    expect(st.cameraId).toBe('cam-a');
    const same = new AttentionModel(policy(), {}, JSON.parse(JSON.stringify(st)));
    same.setBaseline(BASELINE);
    same.setCamera('cam-a');
    same.assess(ms(100), face({ yaw: 25 }), idle(), true);
    expect(same.info().reference).toBe('learned');
    expect(same.info().centre.yaw).toBeGreaterThan(20);

    const other = new AttentionModel(policy(), {}, st);
    other.setBaseline(BASELINE);
    other.setCamera('cam-b');
    other.assess(ms(100), face({ yaw: 25 }), idle(), true);
    expect(other.info().reference).toBe('cold_start');
    expect(other.info().samples.pointer).toBe(0);

    const moved = new AttentionModel(policy(), {}, st);
    moved.setBaseline({ ...BASELINE, yaw: BASELINE.yaw + ATTENTION.resetShiftDeg + 5 });
    moved.assess(ms(100), face({ yaw: 25 }), idle(), true);
    expect(moved.info().samples.pointer).toBe(0);

    const nudged = new AttentionModel(policy(), {}, st);
    nudged.setBaseline({ ...BASELINE, yaw: BASELINE.yaw + 4 });
    nudged.assess(ms(100), face({ yaw: 25 }), idle(), true);
    expect(nudged.info().reference).toBe('learned');
  });

  it('ignores malformed state', () => {
    const m = new AttentionModel(policy(), {}, { v: 1, cameraId: 'x', prior: null, pointer: [1, 2, 'a', 4, 5] as unknown as number[], typed: [], calm: [], keyboard: [] });
    m.setBaseline(BASELINE);
    expect(m.info().samples.pointer).toBe(0);
  });
});

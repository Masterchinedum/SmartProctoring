import { describe, expect, it } from 'vitest';
import { LIVENESS_INSTRUCTIONS, type FaceObservation, type LivenessStep } from '@sp/shared';
import { createLivenessTracker } from './tracker';
import { face } from '../testing/fixtures';

const steps = (...actions: LivenessStep['action'][]): LivenessStep[] => actions.map((action, index) => ({ index, action, instruction: LIVENESS_INSTRUCTIONS[action] }));

/** Feed a pose for `ms` at 10 Hz starting at t; returns the last progress. */
function hold(tr: ReturnType<typeof createLivenessTracker>, t: number, ms: number, f: Partial<FaceObservation>, count = 1) {
  let p = tr.current();
  for (let x = 0; x <= ms; x += 100) p = tr.update(face(f), count, t + x);
  return p;
}

describe('LivenessTracker', () => {
  it('establishes the centre, then guides each step relative to it; captures framesPerStep frames', () => {
    const tr = createLivenessTracker({ steps: steps('turn_left', 'turn_right'), targetYawDeg: 20, targetPitchDeg: 12 });
    let p = tr.update(face({ yaw: 3, pitch: -4 }), 1, 0);
    expect(p.action).toBe('center');
    expect(p.readyToCapture).toBe(false);
    p = hold(tr, 0, 500, { yaw: 3, pitch: -4 });
    expect(p.action).toBe('turn_left');
    expect(p.stepIndex).toBe(0);
    p = tr.update(face({ yaw: 13, pitch: -4 }), 1, 700);
    expect(p.progress).toBeCloseTo(0.5, 1);
    expect(p.readyToCapture).toBe(false);
    p = hold(tr, 800, 300, { yaw: 25, pitch: -4 });
    expect(p.readyToCapture).toBe(false); // not yet held for 400 ms
    p = hold(tr, 1200, 200, { yaw: 25, pitch: -4 });
    expect(p.readyToCapture).toBe(true);
    expect(p.progress).toBe(1);
    tr.markCaptured(1400);
    expect(tr.current().readyToCapture).toBe(false);
    p = hold(tr, 1500, 200, { yaw: 25, pitch: -4 });
    expect(p.readyToCapture).toBe(true);
    tr.markCaptured(1700);
    p = tr.current();
    expect(p.action).toBe('turn_right');
    expect(p.stepIndex).toBe(1);
    // Turning left more does not help the right turn.
    p = tr.update(face({ yaw: 30, pitch: -4 }), 1, 1800);
    expect(p.progress).toBe(0);
    expect(p.message).toContain('the other way');
    p = hold(tr, 1900, 500, { yaw: -20, pitch: -4 });
    expect(p.readyToCapture).toBe(true);
    tr.markCaptured(2400);
    p = hold(tr, 2500, 300, { yaw: -20, pitch: -4 });
    tr.markCaptured(2800);
    expect(tr.current().done).toBe(true);
  });

  it('is relative to the candidate’s centre (camera mounted to the side)', () => {
    const tr = createLivenessTracker({ steps: steps('turn_left'), targetYawDeg: 20, targetPitchDeg: 12 });
    hold(tr, 0, 500, { yaw: 18, pitch: 0 });
    const p = hold(tr, 600, 500, { yaw: 30, pitch: 0 });
    expect(p.action).toBe('turn_left');
    expect(p.readyToCapture).toBe(false);
    expect(p.progress).toBeCloseTo(0.6, 1);
    expect(hold(tr, 1200, 500, { yaw: 40, pitch: 0 }).readyToCapture).toBe(true);
  });

  it('needs exactly one visible face; problems reset the hold', () => {
    const tr = createLivenessTracker({ steps: steps('look_up'), targetYawDeg: 20, targetPitchDeg: 12 });
    hold(tr, 0, 500, { yaw: 0, pitch: 0 });
    let p = hold(tr, 600, 300, { pitch: 15 });
    expect(p.action).toBe('look_up');
    p = tr.update(face({ pitch: 15 }), 2, 1000);
    expect(p.problem).toBeTruthy();
    expect(p.readyToCapture).toBe(false);
    p = tr.update(null, 0, 1100);
    expect(p.problem).toMatch(/can’t see your face/);
    p = tr.update(face({ pitch: 15, cutOff: true }), 1, 1200);
    expect(p.problem).toBeTruthy();
    // hold restarts after the problem is gone
    p = hold(tr, 1300, 300, { pitch: 15 });
    expect(p.readyToCapture).toBe(false);
    p = hold(tr, 1700, 200, { pitch: 15 });
    expect(p.readyToCapture).toBe(true);
  });

  it('vertical steps need the head roughly level horizontally', () => {
    const tr = createLivenessTracker({ steps: steps('look_down'), targetYawDeg: 20, targetPitchDeg: 12 });
    hold(tr, 0, 500, { yaw: 0, pitch: 0 });
    const p = hold(tr, 600, 600, { yaw: 30, pitch: -15 });
    expect(p.readyToCapture).toBe(false);
    expect(p.message).toMatch(/Face the screen first/);
    expect(hold(tr, 1300, 600, { yaw: 2, pitch: -15 }).readyToCapture).toBe(true);
  });

  it('the center step accepts any steady pose in a generous absolute window (not absolute 0,0)', () => {
    // Laptop camera below the eyes: a candidate looking at the screen reads pitch ≈ −28°.
    const tr = createLivenessTracker({ steps: steps('center', 'look_up'), targetYawDeg: 20, targetPitchDeg: 12, framesPerStep: 1 });
    let p = hold(tr, 0, 300, { yaw: 12, pitch: -28 });
    expect(p.action).toBe('center');
    expect(p.readyToCapture).toBe(false); // not held long enough yet
    p = hold(tr, 400, 300, { yaw: 12, pitch: -28 });
    expect(p.readyToCapture).toBe(true);
    tr.markCaptured(700);
    // The next step is measured from that centre: −28 + 12 = −16 is "up".
    p = hold(tr, 800, 500, { yaw: 12, pitch: -15 });
    expect(p.action).toBe('look_up');
    expect(p.readyToCapture).toBe(true);
    // Outside the sanity window (|pitch| > 35) or moving → not accepted.
    const out = createLivenessTracker({ steps: steps('center'), targetYawDeg: 20, targetPitchDeg: 12 });
    expect(hold(out, 0, 1000, { yaw: 0, pitch: -45 }).readyToCapture).toBe(false);
    let q = out.current();
    for (let x = 0; x < 1000; x += 100) q = out.update(face({ yaw: x % 200 ? 8 : -8, pitch: -10 }), 1, 2000 + x);
    expect(q.readyToCapture).toBe(false);
  });

  it('an explicit center step sets the centre from its captured frames', () => {
    const tr = createLivenessTracker({ steps: steps('center', 'turn_right'), targetYawDeg: 20, targetPitchDeg: 12, framesPerStep: 1 });
    let p = hold(tr, 0, 500, { yaw: 8, pitch: 2 });
    expect(p.action).toBe('center');
    expect(p.readyToCapture).toBe(true);
    tr.markCaptured(500);
    expect(tr.current().action).toBe('turn_right');
    p = hold(tr, 600, 500, { yaw: -10, pitch: 2 });
    expect(p.readyToCapture).toBe(false); // only 18° from the centre (8°)
    p = hold(tr, 1200, 500, { yaw: -14, pitch: 2 });
    expect(p.readyToCapture).toBe(true);
    tr.markCaptured(1700);
    expect(tr.current().done).toBe(true);
    tr.reset();
    expect(tr.current().done).toBe(false);
    expect(tr.current().stepIndex).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { poseFromFivePoints } from './pose';

// Synthetic 3D face (cm): eyes at x=±3.2, nose tip 3.5 below and 2.0 toward camera, mouth corners 6.5 below, 1.0 forward.
const FACE = [
  { x: -3.2, y: 0, z: 0 },
  { x: 3.2, y: 0, z: 0 },
  { x: 0, y: 3.5, z: 2.0 },
  { x: -2.4, y: 6.5, z: 1.0 },
  { x: 2.4, y: 6.5, z: 1.0 },
];
/** Project with yaw (subject-left positive => nose toward +x) and pitch (up positive => nose toward -y). */
function project(yawDeg: number, pitchDeg: number) {
  const y = (yawDeg * Math.PI) / 180;
  const p = (pitchDeg * Math.PI) / 180;
  return FACE.map((v) => {
    const x1 = v.x * Math.cos(y) + v.z * Math.sin(y);
    const z1 = -v.x * Math.sin(y) + v.z * Math.cos(y);
    const y2 = v.y * Math.cos(p) - z1 * Math.sin(p);
    return { x: 320 + x1 * 20, y: 200 + y2 * 20 };
  });
}

describe('poseFromFivePoints', () => {
  it('is ~frontal for a frontal face', () => {
    const r = poseFromFivePoints(project(0, 0));
    expect(Math.abs(r.yawDeg)).toBeLessThan(2);
    expect(Math.abs(r.pitchDeg)).toBeLessThan(3);
  });
  it('yaw sign follows POSE_CONVENTION and magnitude is roughly right', () => {
    expect(poseFromFivePoints(project(30, 0)).yawDeg).toBeGreaterThan(22);
    expect(poseFromFivePoints(project(-30, 0)).yawDeg).toBeLessThan(-22);
  });
  it('pitch sign: up positive, down negative', () => {
    expect(poseFromFivePoints(project(0, 20)).pitchDeg).toBeGreaterThan(10);
    expect(poseFromFivePoints(project(0, -20)).pitchDeg).toBeLessThan(-10);
  });
  it('a flat photo rotated in front of the camera shows no yaw parallax', () => {
    // Flatten the face (z=0) then rotate: nose stays centred between the eyes.
    const flat = FACE.map((v) => ({ ...v, z: 0 }));
    const yaw = (35 * Math.PI) / 180;
    const pts = flat.map((v) => ({ x: 320 + v.x * Math.cos(yaw) * 20, y: 200 + v.y * 20 }));
    expect(Math.abs(poseFromFivePoints(pts).yawDeg)).toBeLessThan(3);
  });
  it('accepts points in either eye order and handles roll', () => {
    const pts = project(25, 0);
    const swapped = [pts[1], pts[0], pts[2], pts[4], pts[3]];
    expect(poseFromFivePoints(swapped).yawDeg).toBeCloseTo(poseFromFivePoints(pts).yawDeg, 5);
    const a = (20 * Math.PI) / 180;
    const rolled = pts.map((p) => ({ x: 320 + (p.x - 320) * Math.cos(a) - (p.y - 200) * Math.sin(a), y: 200 + (p.x - 320) * Math.sin(a) + (p.y - 200) * Math.cos(a) }));
    const r = poseFromFivePoints(rolled);
    expect(r.rollDeg).toBeCloseTo(20, 0);
    expect(r.yawDeg).toBeCloseTo(poseFromFivePoints(pts).yawDeg, 3);
  });
});

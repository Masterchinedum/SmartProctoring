import { describe, expect, it } from 'vitest';
import type { FaceObservation } from '@sp/shared';
import { allRequiredPass, evaluateReadiness, ReadinessSmoother, type ReadinessInput } from './readiness';

function face(p: Partial<FaceObservation> = {}): FaceObservation {
  return { box: { x: 0.35, y: 0.25, w: 0.3, h: 0.4 }, score: 0.9, yaw: 2, pitch: -3, roll: 0, gazeX: 0, gazeY: 0, visibility: 0.95, cutOff: false, brightness: 120, ...p };
}

function input(p: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    cameraState: 'live',
    framesFlowing: true,
    faces: [face()],
    frame: { luma: 110, contrast: 40, sharpness: 150, dhash: '0123456789abcdef', diffFromPrev: 1.2 },
    faceRegion: { mean: 120, std: 35, sharpness: 60 },
    virtualCamera: false,
    ...p,
  };
}

const byId = (items: ReturnType<typeof evaluateReadiness>) => Object.fromEntries(items.map((i) => [i.id, i]));

describe('evaluateReadiness', () => {
  it('passes a good, centred, well-lit single face', () => {
    const items = evaluateReadiness(input());
    expect(allRequiredPass(items)).toBe(true);
    expect(items.every((i) => i.ok)).toBe(true);
  });

  it('fails when the camera is not delivering frames', () => {
    const r = byId(evaluateReadiness(input({ framesFlowing: false })));
    expect(r.frames.ok).toBe(false);
    expect(r.one_face.ok).toBe(false);
    const denied = byId(evaluateReadiness(input({ cameraState: 'no_permission', framesFlowing: false })));
    expect(denied.frames.guidance).toMatch(/Allow camera access/);
  });

  it('requires exactly one face', () => {
    expect(byId(evaluateReadiness(input({ faces: [] }))).one_face).toMatchObject({ ok: false, guidance: expect.stringMatching(/can’t see your face/) });
    const two = byId(evaluateReadiness(input({ faces: [face(), face({ box: { x: 0.05, y: 0.1, w: 0.2, h: 0.3 } })] })));
    expect(two.one_face).toMatchObject({ ok: false, guidance: expect.stringMatching(/More than one face/) });
    // implausible tiny detections do not count as a second person
    expect(byId(evaluateReadiness(input({ faces: [face(), face({ score: 0.3 })] }))).one_face.ok).toBe(true);
  });

  it('guides on size and position', () => {
    expect(byId(evaluateReadiness(input({ faces: [face({ box: { x: 0.45, y: 0.4, w: 0.1, h: 0.14 } })] }))).size_position).toMatchObject({
      ok: false,
      guidance: expect.stringMatching(/Move closer/),
    });
    expect(byId(evaluateReadiness(input({ faces: [face({ box: { x: 0.05, y: 0.3, w: 0.25, h: 0.35 } })] }))).size_position.guidance).toMatch(/Center your face/);
    expect(byId(evaluateReadiness(input({ faces: [face({ cutOff: true })] }))).size_position.ok).toBe(false);
    expect(byId(evaluateReadiness(input({ faces: [face({ yaw: 40 })] }))).size_position.guidance).toMatch(/Look straight/);
    expect(byId(evaluateReadiness(input({ faces: [face({ box: { x: 0.05, y: 0.02, w: 0.9, h: 0.95 } })] }))).size_position.guidance).toMatch(/Move back/);
  });

  it('checks lighting and sharpness', () => {
    expect(byId(evaluateReadiness(input({ faces: [face({ brightness: 30 })] }))).lighting).toMatchObject({ ok: false, guidance: expect.stringMatching(/too dark/) });
    expect(byId(evaluateReadiness(input({ faces: [face({ brightness: 240 })] }))).lighting.guidance).toMatch(/too bright/);
    expect(byId(evaluateReadiness(input({ faceRegion: { mean: 120, std: 5, sharpness: 60 } }))).lighting.guidance).toMatch(/lacks contrast/);
    expect(byId(evaluateReadiness(input({ faceRegion: { mean: 120, std: 35, sharpness: 3 } }))).sharpness).toMatchObject({ ok: false, guidance: expect.stringMatching(/blurry/) });
  });

  it('only warns about a virtual camera', () => {
    const items = evaluateReadiness(input({ virtualCamera: true }));
    expect(byId(items).real_camera.ok).toBe(false);
    expect(allRequiredPass(items)).toBe(true);
  });
});

describe('ReadinessSmoother', () => {
  it('ignores a single bad frame but reacts to sustained problems', () => {
    const sm = new ReadinessSmoother(8, 0.75);
    const good = evaluateReadiness(input());
    const bad = evaluateReadiness(input({ faces: [] }));
    let out = good;
    for (let i = 0; i < 6; i++) out = sm.push(good);
    expect(allRequiredPass(out)).toBe(true);
    out = sm.push(bad);
    expect(allRequiredPass(out)).toBe(true); // one bad frame
    for (let i = 0; i < 4; i++) out = sm.push(bad);
    expect(allRequiredPass(out)).toBe(false);
  });

  it('needs a few frames before anything passes', () => {
    const sm = new ReadinessSmoother();
    const good = evaluateReadiness(input());
    expect(allRequiredPass(sm.push(good))).toBe(false);
    sm.push(good);
    expect(allRequiredPass(sm.push(good))).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { FakeVisionService } from './fake';
import { cosineSimilarity, decideIdentity } from './identity';
import { VisionInputError } from './image';

describe('FakeVisionService', () => {
  it('same person => similarity 1, different people => 0, scripted similarity exact', async () => {
    const v = new FakeVisionService();
    const a1 = await v.analyze(FakeVisionService.encode({ person: 'alice' }), { embed: true });
    const a2 = await v.analyze(FakeVisionService.encode({ person: 'alice', yawDeg: 10 }), { embed: true });
    const b = await v.analyze(FakeVisionService.encode({ person: 'bob' }), { embed: true });
    const grey = await v.analyze(FakeVisionService.encode({ person: 'alice', similarity: 0.33 }), { embed: true });
    expect(cosineSimilarity(a1.embedding!, a2.embedding!)).toBeCloseTo(1, 6);
    expect(cosineSimilarity(a1.embedding!, b.embedding!)).toBeCloseTo(0, 6);
    expect(cosineSimilarity(a1.embedding!, grey.embedding!)).toBeCloseTo(0.33, 6);
    expect(cosineSimilarity(b.embedding!, grey.embedding!)).toBeCloseTo(0, 6);
    expect(decideIdentity(cosineSimilarity(a1.embedding!, grey.embedding!), grey.quality).decision).toBe('inconclusive');
    expect(FakeVisionService.embeddingFor('alice')).toEqual(a1.embedding);
  });

  it('queued specs take precedence over the buffer, then the default spec', async () => {
    const v = new FakeVisionService({ defaultSpec: { person: 'default' } });
    v.enqueue({ person: null }, { person: 'q2', faces: 2 });
    const noFace = await v.analyze(FakeVisionService.encode({ person: 'ignored' }));
    expect(noFace.primary).toBeNull();
    expect(noFace.quality.issues).toEqual(['no_face']);
    const two = await v.analyze(Buffer.from([0xff, 0xd8, 0xff]));
    expect(two.faces).toHaveLength(2);
    expect(two.quality.issues).toEqual(['multiple_faces']);
    expect(two.quality.usable).toBe(false);
    const fromBuffer = await v.analyze(FakeVisionService.encode({ person: 'buf', yawDeg: 40 }), { embed: true });
    expect(fromBuffer.quality.issues).toEqual(['face_turned']);
    expect(fromBuffer.pose?.yawDeg).toBe(40);
    const def = await v.analyze(Buffer.from('anything'), { embed: true, faceCrop: true });
    expect(def.quality.usable).toBe(true);
    expect(def.faceCropJpeg?.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(v.calls).toHaveLength(4);
    expect(v.pending).toBe(0);
  });

  it('encoded buffers look like JPEGs and decode back', () => {
    const buf = FakeVisionService.encode({ person: 'x', brightness: 20, usable: false, issues: ['too_dark'] });
    expect(buf.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(FakeVisionService.decode(buf)).toEqual({ person: 'x', brightness: 20, usable: false, issues: ['too_dark'] });
    expect(FakeVisionService.decode(Buffer.from('plain'))).toBeNull();
  });

  it('distinct dHashes per image unless scripted', async () => {
    const v = new FakeVisionService();
    const x = await v.analyze(FakeVisionService.encode({ person: 'a' }));
    const y = await v.analyze(FakeVisionService.encode({ person: 'a' }));
    expect(x.dhash).toMatch(/^[0-9a-f]{16}$/);
    expect(x.dhash).not.toBe(y.dhash);
    const frozen = await v.analyze(FakeVisionService.encode({ person: 'a', dhash: '00ff00ff00ff00ff' }));
    expect(frozen.dhash).toBe('00ff00ff00ff00ff');
  });

  it('ID photos, corrupt images and close()', async () => {
    const v = new FakeVisionService();
    const ok = await v.processIdPhoto(FakeVisionService.encode({ person: 'alice' }));
    expect(ok.accepted).toBe(true);
    expect(ok.analysis.embedding).not.toBeNull();
    const bad = await v.processIdPhoto(FakeVisionService.encode({ person: null }));
    expect(bad.accepted).toBe(false);
    expect(bad.guidance[0]).toMatch(/No face/);
    await expect(v.analyze(FakeVisionService.encode({ corrupt: true }))).rejects.toBeInstanceOf(VisionInputError);
    await v.close();
    await expect(v.analyze(Buffer.from('x'))).rejects.toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { fakeAnalysis, fakeEmbedding } from './fake';
import { VisionInputError } from './image';
import { ID_PHOTO_QUALITY_GATE } from './quality';
import { RECIPE_V1, RECIPE_V2 } from './embed-prep';
import { decodeAnalysis, decodeFloat32, decodeIdPhotoResult, decodeLoad, decodeOptions, encodeAnalysis, encodeFloat32, encodeIdPhotoResult, encodeOptions, parse, stringify, VisionWireError } from './wire';

/** What the analysis looks like after the HTTP hop (JSON text both ways). */
const hop = (v: unknown) => parse(stringify(v));

describe('vision worker wire format', () => {
  it('round-trips an analysis exactly: Float32 embeddings bit for bit, the face crop, primary = faces[0] (same object)', () => {
    const a = fakeAnalysis({ person: 'alice', faces: 2, yawDeg: 7.25, similarity: 0.83 }, { embed: true });
    a.faceCropJpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    a.embeddingVariants = { v1: fakeEmbedding('alice', 0.5), v2: fakeEmbedding('bob') };
    const b = decodeAnalysis(hop(encodeAnalysis(a)));
    expect(b).toEqual(a);
    expect(b.primary).toBe(b.faces[0]);
    expect(Buffer.isBuffer(b.faceCropJpeg)).toBe(true);
    expect(b.embedding).toBeInstanceOf(Float32Array);
    expect(Array.from(b.embedding!)).toEqual(Array.from(a.embedding!));
    expect(Array.from(b.embeddingVariants!.v1)).toEqual(Array.from(a.embeddingVariants.v1));
  });

  it('keeps "no face" (null primary, embedding, crop) and non-finite numbers, which plain JSON would turn into null', () => {
    const a = fakeAnalysis({ person: null });
    a.quality = { ...a.quality, sharpness: Number.NaN, contrast: Number.POSITIVE_INFINITY, brightness: Number.NEGATIVE_INFINITY };
    const b = decodeAnalysis(hop(encodeAnalysis(a)));
    expect(b.primary).toBeNull();
    expect(b.embedding).toBeNull();
    expect(b.faceCropJpeg).toBeNull();
    expect(b.quality.sharpness).toBeNaN();
    expect(b.quality.contrast).toBe(Number.POSITIVE_INFINITY);
    expect(b.quality.brightness).toBe(Number.NEGATIVE_INFINITY);
  });

  it('encodes Float32 little-endian (a fixed byte layout on every platform)', () => {
    expect(encodeFloat32(new Float32Array([1, -2.5]))).toBe(Buffer.from([0, 0, 0x80, 0x3f, 0, 0, 0x20, 0xc0]).toString('base64'));
    expect(Array.from(decodeFloat32(encodeFloat32(new Float32Array([0.1, 1e-30, -3.4e38]))))).toEqual(Array.from(new Float32Array([0.1, 1e-30, -3.4e38])));
    expect(() => decodeFloat32(Buffer.from([1, 2, 3]).toString('base64'))).toThrow(VisionWireError);
  });

  it('round-trips an ID-photo result', () => {
    const analysis = fakeAnalysis({ person: 'paul' }, { embed: true });
    const r = { accepted: true, analysis, quality: analysis.quality, guidance: [], templateStability: 0.97 };
    expect(decodeIdPhotoResult(hop(encodeIdPhotoResult(r)))).toEqual(r);
  });

  it('refuses malformed answers', () => {
    expect(() => decodeAnalysis({})).toThrow(VisionWireError);
    expect(() => decodeAnalysis({ ...encodeAnalysis(fakeAnalysis({ person: 'a' })), primaryIndex: 3 })).toThrow(/out of range/);
    expect(() => decodeIdPhotoResult({ accepted: 'yes' })).toThrow(VisionWireError);
    expect(() => decodeLoad({ workers: -1 })).toThrow(VisionWireError);
  });

  it('carries every analysis option in X-Vision-Options and validates it on the worker', () => {
    const opts = { embed: true, faceCrop: false, gate: ID_PHOTO_QUALITY_GATE, priority: 'background' as const, embeddingVariants: [RECIPE_V1, RECIPE_V2], enhanceLowLight: false };
    expect(decodeOptions(encodeOptions(opts))).toEqual(opts);
    expect(decodeOptions(encodeOptions({ gate: { maxAbsYawDeg: Number.POSITIVE_INFINITY } }))).toEqual({ gate: { maxAbsYawDeg: Number.POSITIVE_INFINITY } });
    expect(decodeOptions(undefined)).toEqual({});
    expect(decodeOptions(encodeOptions({}))).toEqual({});
    expect(() => decodeOptions('{not json')).toThrow(VisionInputError);
    expect(() => decodeOptions(JSON.stringify({ priority: 'urgent' }))).toThrow(VisionInputError);
    expect(() => decodeOptions(JSON.stringify({ gate: { minBrightness: 'dark' } }))).toThrow(VisionInputError);
    expect(() => decodeOptions(JSON.stringify({ unknown: true }))).toThrow(VisionInputError);
  });
});

import { describe, expect, it } from 'vitest';
import { deserializeEmbeddings, EmbeddingFormatError, readEmbeddingHeader, serializeEmbeddings } from './embeddings';

function randomUnit(seed: number): Float32Array {
  const v = new Float32Array(128);
  let s = seed;
  let n = 0;
  for (let i = 0; i < 128; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    v[i] = s / 2147483648 - 0.5;
    n += v[i] * v[i];
  }
  return v.map((x) => x / Math.sqrt(n));
}

describe('embedding serialization', () => {
  it('round-trips bit-exactly', () => {
    const embs = [randomUnit(1), randomUnit(2), randomUnit(3)];
    const buf = serializeEmbeddings(embs);
    expect(buf.length).toBe(12 + 3 * 128 * 4);
    expect(readEmbeddingHeader(buf)).toEqual({ version: 1, modelId: 1, dim: 128, count: 3 });
    const back = deserializeEmbeddings(buf);
    expect(back).toHaveLength(3);
    back.forEach((e, i) => expect(Array.from(e)).toEqual(Array.from(embs[i])));
  });

  it('round-trips an empty list', () => {
    expect(deserializeEmbeddings(serializeEmbeddings([]))).toEqual([]);
  });

  it('rejects corrupt, truncated, foreign and non-finite data', () => {
    const buf = serializeEmbeddings([randomUnit(4)]);
    expect(() => deserializeEmbeddings(buf.subarray(0, buf.length - 4))).toThrow(EmbeddingFormatError);
    const badMagic = Buffer.from(buf);
    badMagic.write('XXXX', 0, 'ascii');
    expect(() => deserializeEmbeddings(badMagic)).toThrow(/magic/);
    const badVersion = Buffer.from(buf);
    badVersion.writeUInt8(9, 4);
    expect(() => deserializeEmbeddings(badVersion)).toThrow(/version/);
    const otherModel = Buffer.from(buf);
    otherModel.writeUInt8(7, 5);
    expect(() => deserializeEmbeddings(otherModel)).toThrow(/model/);
    expect(deserializeEmbeddings(otherModel, { allowAnyModel: true })).toHaveLength(1);
    const nan = Buffer.from(buf);
    nan.writeFloatLE(Number.NaN, 12);
    expect(() => deserializeEmbeddings(nan)).toThrow(/non-finite/);
    expect(() => serializeEmbeddings([new Float32Array([Number.POSITIVE_INFINITY])])).toThrow();
    expect(() => serializeEmbeddings([new Float32Array(128), new Float32Array(64)])).toThrow(/same dimension/);
    expect(() => deserializeEmbeddings(Buffer.alloc(3))).toThrow(/too short/);
  });
});

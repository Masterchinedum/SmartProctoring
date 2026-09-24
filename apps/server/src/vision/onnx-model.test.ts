import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeInitializersFromInputs } from './onnx-model';
import { resolveModelsDir, SFACE_MODEL_FILE } from './models';

/* ---- a tiny protobuf writer, enough to build ModelProto / GraphProto skeletons ---- */
const varint = (n: number): number[] => {
  const out: number[] = [];
  while (n >= 128) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
};
const ld = (field: number, payload: number[]): number[] => [...varint(field * 8 + 2), ...varint(payload.length), ...payload];
const str = (field: number, s: string) => ld(field, [...Buffer.from(s, 'utf8')]);
const vint = (field: number, v: number) => [...varint(field * 8), ...varint(v)];
const fixed32 = (field: number) => [...varint(field * 8 + 5), 1, 2, 3, 4];

const tensor = (name: string) => [...vint(1, 4), ...str(8, name), ...ld(9, [0, 0, 128, 63])]; // dims, name, raw_data
const valueInfo = (name: string) => [...str(1, name), ...ld(2, [8, 1])];
const graph = (inputs: string[], inits: string[]) => [
  ...ld(1, [...str(1, 'x'), ...str(2, 'y'), ...str(4, 'Relu')]), // node
  ...str(2, 'g'),
  ...inits.flatMap((n) => ld(5, tensor(n))),
  ...inputs.flatMap((n) => ld(11, valueInfo(n))),
  ...ld(12, valueInfo('y')),
];
const model = (g: number[]) => Uint8Array.from([...vint(1, 8), ...str(2, 'test'), ...fixed32(3), ...ld(7, g), ...ld(8, [...str(1, ''), ...vint(2, 13)])]);

describe('removeInitializersFromInputs', () => {
  it('drops graph inputs that are initializers and keeps everything else byte for byte', () => {
    const m = model(graph(['x', 'w', 'b'], ['w', 'b']));
    const r = removeInitializersFromInputs(m);
    expect(r.removed).toBe(2);
    expect(Buffer.from(r.model)).toEqual(Buffer.from(model(graph(['x'], ['w', 'b']))));
  });

  it('returns the model unchanged when no input is an initializer', () => {
    const m = model(graph(['x'], ['w']));
    const r = removeInitializersFromInputs(m);
    expect(r.removed).toBe(0);
    expect(r.model).toBe(m);
  });

  it('handles graphs larger than 127 bytes (multi-byte lengths)', () => {
    const names = Array.from({ length: 40 }, (_, i) => `weight_${i}`);
    const m = model(graph(['x', ...names], names));
    const r = removeInitializersFromInputs(m);
    expect(r.removed).toBe(40);
    expect(Buffer.from(r.model)).toEqual(Buffer.from(model(graph(['x'], names))));
  });

  it('rejects malformed data', () => {
    expect(() => removeInitializersFromInputs(Uint8Array.from([0x3a, 0xff, 0x01]))).toThrow(/truncated/);
    expect(() => removeInitializersFromInputs(Uint8Array.from(vint(1, 8)))).toThrow(/no graph/);
  });

  const sface = (() => {
    try {
      return join(resolveModelsDir(), SFACE_MODEL_FILE);
    } catch {
      return null;
    }
  })();
  it.skipIf(!sface || !existsSync(sface))('makes the SFace weights constants (174 initializer inputs)', () => {
    const buf = readFileSync(sface!);
    const r = removeInitializersFromInputs(buf);
    expect(r.removed).toBe(174);
    expect(r.model.length).toBeLessThan(buf.length);
    expect(removeInitializersFromInputs(r.model).removed).toBe(0);
  });
});

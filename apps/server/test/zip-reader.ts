/** Test helper: an independent ZIP reader for archives written by src/lib/zip.ts (and the personal-data export). */
import { crc32, inflateRawSync } from 'node:zlib';

const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

/**
 * An independent reader: end of central directory (→ ZIP64 end record when there is one) → central directory (ZIP64
 * extended information for offsets) → local headers (checks both agree).
 */
export function readZip(zip: Buffer): Map<string, { data: Buffer; method: number; date: number; time: number }> {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('no end of central directory');
  let count = zip.readUInt16LE(eocd + 10);
  let cdSize = zip.readUInt32LE(eocd + 12);
  let p = zip.readUInt32LE(eocd + 16);
  let cdEnd = eocd;
  // ZIP64: a locator right before the end record points to the ZIP64 end of central directory record.
  if (eocd >= 20 && zip.readUInt32LE(eocd - 20) === 0x07064b50) {
    const z = Number(zip.readBigUInt64LE(eocd - 20 + 8));
    if (zip.readUInt32LE(z) !== 0x06064b50) throw new Error('bad ZIP64 end of central directory record');
    if (count === U16_MAX) count = Number(zip.readBigUInt64LE(z + 32));
    if (cdSize === U32_MAX) cdSize = Number(zip.readBigUInt64LE(z + 40));
    if (p === U32_MAX) p = Number(zip.readBigUInt64LE(z + 48));
    if (Number(zip.readBigUInt64LE(z + 32)) !== count || Number(zip.readBigUInt64LE(z + 40)) !== cdSize || Number(zip.readBigUInt64LE(z + 48)) !== p) {
      throw new Error('ZIP64 end record disagrees with the end of central directory');
    }
    cdEnd = z;
  }
  if (p + cdSize !== cdEnd) throw new Error('central directory size mismatch');
  const out = new Map<string, { data: Buffer; method: number; date: number; time: number }>();
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central header');
    const method = zip.readUInt16LE(p + 10);
    const time = zip.readUInt16LE(p + 12);
    const date = zip.readUInt16LE(p + 14);
    const crc = zip.readUInt32LE(p + 16);
    const csize = zip.readUInt32LE(p + 20);
    const usize = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extra = zip.readUInt16LE(p + 30);
    const comment = zip.readUInt16LE(p + 32);
    let local = zip.readUInt32LE(p + 42);
    if (local === U32_MAX) {
      // ZIP64 extended information: only the offset is in it (sizes fit in 32 bits).
      const x = p + 46 + nameLen;
      if (zip.readUInt16LE(x) !== 0x0001 || zip.readUInt16LE(x + 2) !== 8) throw new Error('bad ZIP64 extended information');
      local = Number(zip.readBigUInt64LE(x + 4));
    }
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error('bad local header');
    if (zip.readUInt32LE(local + 14) !== crc || zip.readUInt32LE(local + 18) !== csize) throw new Error('local / central mismatch');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const body = zip.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    if (data.length !== usize || crc32(data) >>> 0 !== crc) throw new Error(`corrupt entry ${name}`);
    out.set(name, { data, method, date, time });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

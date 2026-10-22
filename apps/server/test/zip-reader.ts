/** Test helper: an independent ZIP reader for archives written by src/lib/zip.ts (and the personal-data export). */
import { crc32, inflateRawSync } from 'node:zlib';

/** An independent reader: end of central directory → central directory → local headers (checks both agree). */
export function readZip(zip: Buffer): Map<string, { data: Buffer; method: number; date: number; time: number }> {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('no end of central directory');
  const count = zip.readUInt16LE(eocd + 10);
  const cdSize = zip.readUInt32LE(eocd + 12);
  let p = zip.readUInt32LE(eocd + 16);
  if (p + cdSize !== eocd) throw new Error('central directory size mismatch');
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
    const local = zip.readUInt32LE(p + 42);
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

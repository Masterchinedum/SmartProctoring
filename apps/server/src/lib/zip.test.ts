import { buffer } from 'node:stream/consumers';
import { crc32, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { zipPathSegment, zipStream, type ZipEntry } from './zip';

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

describe('zip writer', () => {
  it('writes an archive any reader can open: deflated text, stored images, UTF-8 names, DOS times', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(5000, 7)]);
    async function* entries(): AsyncGenerator<ZipEntry> {
      yield { name: 'README.txt', data: 'Hello '.repeat(200), date: new Date('2026-10-21T13:45:30Z') };
      yield { name: 'sessions/1 Prüfung Mathe/session.json', data: JSON.stringify({ a: 1 }) };
      yield { name: 'sessions/1 Prüfung Mathe/images/1.jpg', data: jpeg };
      yield { name: 'empty.txt', data: '' };
    }
    const zip = await buffer(zipStream(entries()));
    const files = readZip(zip);
    expect([...files.keys()]).toEqual(['README.txt', 'sessions/1 Prüfung Mathe/session.json', 'sessions/1 Prüfung Mathe/images/1.jpg', 'empty.txt']);
    expect(files.get('README.txt')!.data.toString()).toBe('Hello '.repeat(200));
    expect(files.get('README.txt')!.method).toBe(8);
    expect(files.get('README.txt')!).toMatchObject({ date: ((2026 - 1980) << 9) | (10 << 5) | 21, time: (13 << 11) | (45 << 5) | 15 });
    expect(files.get('sessions/1 Prüfung Mathe/images/1.jpg')!).toMatchObject({ method: 0 });
    expect(files.get('sessions/1 Prüfung Mathe/images/1.jpg')!.data.equals(jpeg)).toBe(true);
    expect(files.get('empty.txt')!.data.length).toBe(0);
  });

  it('refuses unsafe or duplicate names', async () => {
    for (const name of ['../x', '/abs', 'a//b', 'a\\b', './a', '']) {
      await expect(buffer(zipStream([{ name, data: 'x' }]))).rejects.toThrow(/Invalid ZIP entry name/);
    }
    await expect(
      buffer(
        zipStream([
          { name: 'a', data: '1' },
          { name: 'a', data: '2' },
        ]),
      ),
    ).rejects.toThrow(/Duplicate/);
  });

  it('turns user text into one safe path segment', () => {
    expect(zipPathSegment('Algebra I / Final: "resit"?')).toBe('Algebra I Final resit');
    expect(zipPathSegment('..')).toBe('item');
    expect(zipPathSegment('   ', 'exam')).toBe('exam');
    expect(zipPathSegment('x'.repeat(100))).toHaveLength(60);
    expect(zipPathSegment('a\u0000b\nc')).toBe('a b c');
  });
});

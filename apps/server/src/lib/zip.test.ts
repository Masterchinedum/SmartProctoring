import { buffer } from 'node:stream/consumers';
import { describe, expect, it } from 'vitest';
import { readZip } from '../../test/zip-reader';
import { zipPathSegment, zipStream, type ZipEntry } from './zip';

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

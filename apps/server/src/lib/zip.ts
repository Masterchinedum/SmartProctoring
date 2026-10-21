/**
 * Minimal streaming ZIP writer (PKWARE APPNOTE 6.3, no ZIP64) for data exports: entries are produced one at a time
 * (each is held in memory only while it is written), so an export of many images streams with bounded memory.
 * JSON / text are deflated, JPEGs stored (already compressed). Names are UTF-8 (general purpose flag bit 11).
 * No new dependency: CRC-32 and DEFLATE come from node:zlib.
 */
import { Readable } from 'node:stream';
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** Path inside the archive ("sessions/1/session.json"); see zipPathSegment() for user-provided parts. */
  name: string;
  data: Buffer | string;
  /** Modification time (default: now). */
  date?: Date;
  /** Deflate the data (default: true, except for .jpg / .jpeg / .png / .zip). */
  compress?: boolean;
}

const MAX_ENTRIES = 0xffff;
const MAX_OFFSET = 0xffffffff;

const STORED_EXT = /\.(jpe?g|png|gif|webp|zip|gz)$/i;

/** One safe path segment from user-provided text (exam titles, names): no separators, dots-only or control characters. */
export function zipPathSegment(text: string, fallback = 'item', max = 60): string {
  const cleaned = text
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
  return cleaned && !/^\.+$/.test(cleaned) ? cleaned : fallback;
}

function dosDateTime(d: Date): { date: number; time: number } {
  const year = Math.min(2107, Math.max(1980, d.getUTCFullYear()));
  return {
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
  };
}

function checkName(name: string): Buffer {
  if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some((p) => p === '..' || p === '.' || p === '')) {
    throw new Error(`Invalid ZIP entry name: ${JSON.stringify(name)}`);
  }
  return Buffer.from(name, 'utf8');
}

interface Written {
  name: Buffer;
  method: number;
  date: number;
  time: number;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
}

/** A ZIP archive of `entries` as a byte stream (entries are pulled one at a time). */
export function zipStream(entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>): Readable {
  async function* generate(): AsyncGenerator<Buffer> {
    const written: Written[] = [];
    const seen = new Set<string>();
    let offset = 0;
    for await (const e of entries) {
      if (seen.has(e.name)) throw new Error(`Duplicate ZIP entry name: ${e.name}`);
      seen.add(e.name);
      if (written.length >= MAX_ENTRIES) throw new Error('Too many entries for a ZIP archive without ZIP64');
      const name = checkName(e.name);
      const raw = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : e.data;
      const deflate = e.compress ?? !STORED_EXT.test(e.name);
      const body = deflate ? deflateRawSync(raw) : raw;
      const { date, time } = dosDateTime(e.date ?? new Date());
      const w: Written = { name, method: deflate ? 8 : 0, date, time, crc: crc32(raw) >>> 0, csize: body.length, usize: raw.length, offset };
      if (offset + 30 + name.length + body.length > MAX_OFFSET) throw new Error('ZIP archive larger than 4 GiB (ZIP64 is not supported)');
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0);
      h.writeUInt16LE(20, 4); // version needed
      h.writeUInt16LE(0x0800, 6); // UTF-8 names
      h.writeUInt16LE(w.method, 8);
      h.writeUInt16LE(w.time, 10);
      h.writeUInt16LE(w.date, 12);
      h.writeUInt32LE(w.crc, 14);
      h.writeUInt32LE(w.csize, 18);
      h.writeUInt32LE(w.usize, 22);
      h.writeUInt16LE(name.length, 26);
      h.writeUInt16LE(0, 28);
      yield h;
      yield name;
      yield body;
      offset += 30 + name.length + body.length;
      written.push(w);
    }
    const cdStart = offset;
    for (const w of written) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(0x0314, 4); // made by: Unix, spec 2.0
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(w.method, 10);
      c.writeUInt16LE(w.time, 12);
      c.writeUInt16LE(w.date, 14);
      c.writeUInt32LE(w.crc, 16);
      c.writeUInt32LE(w.csize, 20);
      c.writeUInt32LE(w.usize, 24);
      c.writeUInt16LE(w.name.length, 28);
      // extra (30), comment (32), disk (34), internal attributes (36): 0
      c.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
      c.writeUInt32LE(w.offset, 42);
      yield c;
      yield w.name;
      offset += 46 + w.name.length;
    }
    if (offset > MAX_OFFSET) throw new Error('ZIP archive larger than 4 GiB (ZIP64 is not supported)');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(written.length, 8);
    end.writeUInt16LE(written.length, 10);
    end.writeUInt32LE(offset - cdStart, 12);
    end.writeUInt32LE(cdStart, 16);
    yield end;
  }
  return Readable.from(generate(), { objectMode: false });
}

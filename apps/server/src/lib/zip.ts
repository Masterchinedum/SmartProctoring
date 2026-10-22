/**
 * Minimal streaming ZIP writer (PKWARE APPNOTE 6.3) for data exports: entries are produced one at a time (each is held
 * in memory only while it is written), so an export of many images streams with bounded memory. JSON / text are
 * deflated, JPEGs and recordings stored (already compressed). Names are UTF-8 (general purpose flag bit 11).
 * No new dependency: CRC-32 and DEFLATE come from node:zlib.
 *
 * ZIP64: an export with exam recordings can pass 4 GiB. Each entry stays far below 4 GiB (a recording segment is at
 * most 16 MB), so only positions and counts need ZIP64: an entry that starts beyond 4 GiB gets a ZIP64 extended
 * information field (its offset) in the central directory, and an archive whose central directory starts beyond
 * 4 GiB, or has 65,535 entries or more, ends with a ZIP64 end of central directory record and locator. Smaller
 * archives are written exactly as before.
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

const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
/** Largest single entry: its sizes are written in 32 bits (only offsets and counts use ZIP64). */
const MAX_ENTRY_BYTES = U32_MAX - 1;

const STORED_EXT = /\.(jpe?g|png|gif|webp|zip|gz|webm|mp4)$/i;

export interface ZipStreamOptions {
  /** Offsets / counts from which ZIP64 records are written (default: the 32-bit limits). Tests lower it. */
  zip64At?: { offset?: number; entries?: number };
}

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
export function zipStream(entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>, opts: ZipStreamOptions = {}): Readable {
  const offsetLimit = Math.min(U32_MAX, opts.zip64At?.offset ?? U32_MAX);
  const entryLimit = Math.min(U16_MAX, opts.zip64At?.entries ?? U16_MAX);
  async function* generate(): AsyncGenerator<Buffer> {
    const written: Written[] = [];
    const seen = new Set<string>();
    let offset = 0;
    for await (const e of entries) {
      if (seen.has(e.name)) throw new Error(`Duplicate ZIP entry name: ${e.name}`);
      seen.add(e.name);
      const name = checkName(e.name);
      const raw = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : e.data;
      const deflate = e.compress ?? !STORED_EXT.test(e.name);
      const body = deflate ? deflateRawSync(raw) : raw;
      const { date, time } = dosDateTime(e.date ?? new Date());
      const w: Written = { name, method: deflate ? 8 : 0, date, time, crc: crc32(raw) >>> 0, csize: body.length, usize: raw.length, offset };
      if (body.length > MAX_ENTRY_BYTES || raw.length > MAX_ENTRY_BYTES) throw new Error(`ZIP entry larger than 4 GiB: ${e.name}`);
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
      // An entry starting beyond the 32-bit limit: its offset goes into a ZIP64 extended information field.
      const zip64 = w.offset >= offsetLimit;
      const extra = zip64 ? Buffer.alloc(12) : Buffer.alloc(0);
      if (zip64) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(8, 2);
        extra.writeBigUInt64LE(BigInt(w.offset), 4);
      }
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(zip64 ? 0x032d : 0x0314, 4); // made by: Unix, spec 2.0 (4.5 with ZIP64)
      c.writeUInt16LE(zip64 ? 45 : 20, 6);
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(w.method, 10);
      c.writeUInt16LE(w.time, 12);
      c.writeUInt16LE(w.date, 14);
      c.writeUInt32LE(w.crc, 16);
      c.writeUInt32LE(w.csize, 20);
      c.writeUInt32LE(w.usize, 24);
      c.writeUInt16LE(w.name.length, 28);
      c.writeUInt16LE(extra.length, 30);
      // comment (32), disk (34), internal attributes (36): 0
      c.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
      c.writeUInt32LE(zip64 ? U32_MAX : w.offset, 42);
      yield c;
      yield w.name;
      if (extra.length) yield extra;
      offset += 46 + w.name.length + extra.length;
    }
    const cdSize = offset - cdStart;
    const needZip64 = cdStart >= offsetLimit || cdSize >= offsetLimit || written.length >= entryLimit;
    if (needZip64) {
      // ZIP64 end of central directory record, then its locator.
      const z = Buffer.alloc(56);
      z.writeUInt32LE(0x06064b50, 0);
      z.writeBigUInt64LE(44n, 4); // size of the rest of the record
      z.writeUInt16LE(0x032d, 12); // made by
      z.writeUInt16LE(45, 14); // version needed
      // this disk (16), disk with the central directory (20): 0
      z.writeBigUInt64LE(BigInt(written.length), 24);
      z.writeBigUInt64LE(BigInt(written.length), 32);
      z.writeBigUInt64LE(BigInt(cdSize), 40);
      z.writeBigUInt64LE(BigInt(cdStart), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      // disk with the ZIP64 end record (4): 0
      loc.writeBigUInt64LE(BigInt(offset), 8);
      loc.writeUInt32LE(1, 16); // total disks
      yield z;
      yield loc;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(needZip64 && written.length >= entryLimit ? U16_MAX : written.length, 8);
    end.writeUInt16LE(needZip64 && written.length >= entryLimit ? U16_MAX : written.length, 10);
    end.writeUInt32LE(needZip64 && cdSize >= offsetLimit ? U32_MAX : cdSize, 12);
    end.writeUInt32LE(needZip64 && cdStart >= offsetLimit ? U32_MAX : cdStart, 16);
    yield end;
  }
  return Readable.from(generate(), { objectMode: false });
}

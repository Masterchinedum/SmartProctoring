/**
 * 64-bit difference hash (dHash) and Hamming distance helpers.
 *
 * dHash: the frame is area-averaged down to 9×8 cells; each of the 8 rows yields 8 bits
 * (bit = 1 when a cell is brighter than its right neighbour). Bits are packed row-major, most
 * significant bit first, and rendered as 16 lowercase hex chars. The hash is robust to sensor noise,
 * mild compression and global brightness changes, and sensitive to scene/layout changes — which is
 * what the frozen-feed and replay detectors need.
 */

const HEX_RE = /^[0-9a-f]{16}$/i;

export function dhash64(gray: Uint8Array, width: number, height: number): string {
  if (width <= 0 || height <= 0 || gray.length < width * height) return '0000000000000000';
  const cells = new Float64Array(72); // 9 columns × 8 rows
  const counts = new Uint32Array(72);
  if (width >= 9 && height >= 8) {
    // Precompute column → cell index.
    const colCell = new Uint8Array(width);
    for (let x = 0; x < width; x++) colCell[x] = Math.min(8, Math.floor((x * 9) / width));
    for (let y = 0; y < height; y++) {
      const cy = Math.min(7, Math.floor((y * 8) / height));
      const rowBase = cy * 9;
      const off = y * width;
      for (let x = 0; x < width; x++) {
        const c = rowBase + colCell[x];
        cells[c] += gray[off + x];
        counts[c]++;
      }
    }
    for (let i = 0; i < 72; i++) cells[i] = counts[i] ? cells[i] / counts[i] : 0;
  } else {
    // Tiny inputs: nearest-neighbour sample.
    for (let cy = 0; cy < 8; cy++) {
      for (let cx = 0; cx < 9; cx++) {
        const x = Math.min(width - 1, Math.floor(((cx + 0.5) * width) / 9));
        const y = Math.min(height - 1, Math.floor(((cy + 0.5) * height) / 8));
        cells[cy * 9 + cx] = gray[y * width + x];
      }
    }
  }
  let hi = 0;
  let lo = 0;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const bit = cells[row * 9 + col] > cells[row * 9 + col + 1] ? 1 : 0;
      const idx = row * 8 + col; // 0..63, 0 = MSB
      if (idx < 32) hi = (hi | (bit << (31 - idx))) >>> 0;
      else lo = (lo | (bit << (63 - idx))) >>> 0;
    }
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

export function popcount32(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Parse a 16-hex-char hash into [hi, lo] 32-bit words; null if malformed. */
export function parseHash64(h: string): [number, number] | null {
  if (!HEX_RE.test(h)) return null;
  return [parseInt(h.slice(0, 8), 16) >>> 0, parseInt(h.slice(8), 16) >>> 0];
}

/**
 * Hamming distance between two hex hashes. Hashes of different lengths are compared nibble by nibble
 * over the longer length (missing nibbles count as fully different); non-hex characters count as 4
 * differing bits.
 */
export function hammingHex(a: string, b: string): number {
  if (a.length === 16 && b.length === 16) {
    const pa = parseHash64(a);
    const pb = parseHash64(b);
    if (pa && pb) return popcount32((pa[0] ^ pb[0]) >>> 0) + popcount32((pa[1] ^ pb[1]) >>> 0);
  }
  const n = Math.max(a.length, b.length);
  let d = 0;
  for (let i = 0; i < n; i++) {
    const x = i < a.length ? parseInt(a[i], 16) : NaN;
    const y = i < b.length ? parseInt(b[i], 16) : NaN;
    if (Number.isNaN(x) || Number.isNaN(y)) d += 4;
    else d += popcount32(x ^ y);
  }
  return d;
}

/** Bitwise majority vote across hashes — a robust "median" hash. Empty input → ''. */
export function majorityHash(hashes: readonly string[]): string {
  const parsed = hashes.map(parseHash64).filter((p): p is [number, number] => p !== null);
  if (parsed.length === 0) return '';
  let hi = 0;
  let lo = 0;
  for (let bit = 0; bit < 32; bit++) {
    const mask = 1 << bit;
    let ch = 0;
    let cl = 0;
    for (const [h, l] of parsed) {
      if (h & mask) ch++;
      if (l & mask) cl++;
    }
    if (ch * 2 > parsed.length) hi |= mask;
    if (cl * 2 > parsed.length) lo |= mask;
  }
  return (hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0');
}

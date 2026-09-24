import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/* ------------------------------------------------------------------ random tokens & hashes */

/** 32 random bytes, base64url (43 chars). Used for candidate access tokens and staff session tokens. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Constant-time string comparison (for nonces and similar). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/* ------------------------------------------------------------------ AES-256-GCM keyring */

const MAGIC = Buffer.from('SPE1');
const IV_LEN = 12;
const TAG_LEN = 16;

export interface Keyring {
  /** Key id used for new encryptions. */
  currentKeyId: string;
  /** Encrypt with the current key. `aad` binds the ciphertext to a context (e.g. `evidence:<id>`). */
  encrypt(plaintext: Buffer, aad?: string): Buffer;
  /** Decrypt a blob produced by encrypt() with any known key (current or old). Throws on tampering. */
  decrypt(blob: Buffer, aad?: string): Buffer;
  /** Key id embedded in a blob. */
  keyIdOf(blob: Buffer): string;
  encryptString(s: string, aad?: string): Buffer;
  decryptString(blob: Buffer, aad?: string): string;
}

export function keyIdFor(key: Buffer): string {
  return 'k' + createHash('sha256').update('sp-key-id:').update(key).digest('hex').slice(0, 12);
}

/**
 * Blob layout: "SPE1" | keyIdLen (1 byte) | keyId (utf8) | iv (12) | tag (16) | ciphertext.
 * A fresh random IV is used for every blob.
 */
export function createKeyring(current: Buffer, old: Buffer[] = []): Keyring {
  if (current.length !== 32) throw new Error('Evidence key must be 32 bytes');
  const keys = new Map<string, Buffer>();
  const currentKeyId = keyIdFor(current);
  keys.set(currentKeyId, current);
  for (const k of old) {
    if (k.length !== 32) throw new Error('Old evidence keys must be 32 bytes');
    keys.set(keyIdFor(k), k);
  }

  function parse(blob: Buffer) {
    if (blob.length < MAGIC.length + 1 || !blob.subarray(0, 4).equals(MAGIC)) throw new Error('Not an encrypted blob');
    const idLen = blob[4];
    const keyId = blob.subarray(5, 5 + idLen).toString('utf8');
    const off = 5 + idLen;
    if (blob.length < off + IV_LEN + TAG_LEN) throw new Error('Encrypted blob truncated');
    return {
      keyId,
      iv: blob.subarray(off, off + IV_LEN),
      tag: blob.subarray(off + IV_LEN, off + IV_LEN + TAG_LEN),
      ciphertext: blob.subarray(off + IV_LEN + TAG_LEN),
    };
  }

  const ring: Keyring = {
    currentKeyId,
    encrypt(plaintext, aad) {
      const iv = randomBytes(IV_LEN);
      const cipher = createCipheriv('aes-256-gcm', current, iv);
      if (aad) cipher.setAAD(Buffer.from(aad));
      const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      const idBuf = Buffer.from(currentKeyId, 'utf8');
      return Buffer.concat([MAGIC, Buffer.from([idBuf.length]), idBuf, iv, tag, ct]);
    },
    decrypt(blob, aad) {
      const { keyId, iv, tag, ciphertext } = parse(blob);
      const key = keys.get(keyId);
      if (!key) throw new Error(`Unknown encryption key id ${keyId} (is the key in EVIDENCE_KEY / EVIDENCE_KEYS_OLD?)`);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      if (aad) decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    },
    keyIdOf(blob) {
      return parse(blob).keyId;
    },
    encryptString(s, aad) {
      return ring.encrypt(Buffer.from(s, 'utf8'), aad);
    },
    decryptString(blob, aad) {
      return ring.decrypt(blob, aad).toString('utf8');
    },
  };
  return ring;
}

/* ------------------------------------------------------------------ passwords (scrypt) */

/**
 * scrypt parameters for NEW hashes: N=2^17, r=8, p=1 (≈128 MiB, OWASP guidance). The parameters are stored in
 * every hash, so older hashes (N=2^15) keep verifying; routes/auth.ts rehashes them at the next successful login
 * (passwordNeedsRehash).
 */
export const SCRYPT_PARAMS = { N: 1 << 17, r: 8, p: 1 } as const;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_LEN = 16;
/** Hashes with parameters above these bounds are refused (a corrupted / hostile row must not exhaust memory). */
const SCRYPT_MAX = { N: 1 << 20, r: 32, p: 16, memBytes: 512 * 1024 * 1024 };

/**
 * scrypt runs on libuv's small thread pool (4 threads by default, shared with fs / dns / zlib). Each derivation
 * at N=2^17 takes ~0.4 s and 128 MiB, so at most two run at once; further logins wait here instead of starving
 * file and DNS operations or multiplying memory use.
 */
const SCRYPT_CONCURRENCY = 2;
let scryptActive = 0;
const scryptWaiting: (() => void)[] = [];

async function withScryptSlot<T>(fn: () => Promise<T>): Promise<T> {
  // A finishing derivation hands its slot straight to the next waiter (no window for a third one to slip in).
  if (scryptActive >= SCRYPT_CONCURRENCY) await new Promise<void>((resolve) => scryptWaiting.push(resolve));
  else scryptActive++;
  try {
    return await fn();
  } finally {
    const next = scryptWaiting.shift();
    if (next) next();
    else scryptActive--;
  }
}

/** Memory bound for a derivation: scrypt needs ≈128·N·r (+128·r·p) bytes; allow twice that. */
function scryptMaxmem(N: number, r: number, p: number): number {
  return 2 * 128 * r * (N + p + 2);
}

function scrypt(password: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { N: opts.N, r: opts.r, p: opts.p, maxmem: scryptMaxmem(opts.N, opts.r, opts.p) };
  return withScryptSlot(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        scryptCb(password.normalize('NFKC'), salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
      }),
  );
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parsePasswordHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![N, r, p].every(Number.isInteger)) return null;
  if (N < 2 || N > SCRYPT_MAX.N || (N & (N - 1)) !== 0 || r < 1 || r > SCRYPT_MAX.r || p < 1 || p > SCRYPT_MAX.p) return null;
  if (128 * N * r > SCRYPT_MAX.memBytes) return null;
  const salt = Buffer.from(parts[4], 'base64');
  const hash = Buffer.from(parts[5], 'base64');
  if (salt.length === 0 || hash.length === 0) return null;
  return { N, r, p, salt, hash };
}

/** Format: scrypt$N$r$p$saltB64$hashB64 */
export async function hashPassword(password: string, params: { N: number; r: number; p: number } = SCRYPT_PARAMS): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_LEN);
  const key = await scrypt(password, salt, SCRYPT_KEYLEN, params);
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const h = parsePasswordHash(stored);
  if (!h) return false;
  const key = await scrypt(password, h.salt, h.hash.length, h);
  return key.length === h.hash.length && timingSafeEqual(key, h.hash);
}

/** True when a stored hash uses weaker / different parameters than SCRYPT_PARAMS (rehash after a successful login). */
export function passwordNeedsRehash(stored: string): boolean {
  const h = parsePasswordHash(stored);
  if (!h) return true;
  return h.N < SCRYPT_PARAMS.N || h.r !== SCRYPT_PARAMS.r || h.p !== SCRYPT_PARAMS.p || h.salt.length < SCRYPT_SALT_LEN || h.hash.length < SCRYPT_KEYLEN;
}

/** A hash to compare against when the user does not exist (keeps login timing uniform). */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomToken(16));
  return dummyHash;
}

/* ------------------------------------------------------------------ JPEG sniffing */

export function isJpeg(buf: Buffer | null | undefined): buf is Buffer {
  return !!buf && buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/**
 * Frame size declared by a JPEG's SOFn header(s), read without decoding (largest if several), or null when
 * no frame header is found before the first scan. Walks the marker segments the way libjpeg does (garbage
 * before a marker and 0xFF fill bytes are skipped), so an image the decoder would accept cannot hide its size.
 * Used to refuse decompression bombs (a small file declaring a huge progressive image) before sharp sees them.
 */
export function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let best: { width: number; height: number } | null = null;
  let i = 2;
  while (i < buf.length) {
    while (i < buf.length && buf[i] !== 0xff) i++;
    while (i < buf.length && buf[i] === 0xff) i++;
    if (i >= buf.length) break;
    const marker = buf[i++];
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS: the frame header must come first
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue; // no length field
    if (i + 1 >= buf.length) break;
    const len = (buf[i] << 8) | buf[i + 1];
    if (len < 2) break;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && i + 6 < buf.length) {
      const height = (buf[i + 3] << 8) | buf[i + 4];
      const width = (buf[i + 5] << 8) | buf[i + 6];
      if (!best || width * height > best.width * best.height) best = { width, height };
    }
    i += len;
  }
  return best;
}

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

const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Format: scrypt$N$r$p$saltB64$hashB64 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * SCRYPT_N * SCRYPT_R * 2 });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N < 2 || N > 1 << 20) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  const key = await scrypt(password, salt, expected.length, { N, r, p, maxmem: 128 * N * r * 2 });
  return key.length === expected.length && timingSafeEqual(key, expected);
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

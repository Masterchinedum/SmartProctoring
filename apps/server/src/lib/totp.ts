/**
 * Time-based one-time passwords (RFC 6238 TOTP over RFC 4226 HOTP): HMAC-SHA1, 30-second steps, 6 digits — what
 * every authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…) uses by default.
 *
 * `verifyTotp` accepts the current step and one step either side (clock drift up to ±30 s), never a step at or before
 * `lastUsedStep` (each code works once: a code seen over someone's shoulder cannot be replayed), and compares in
 * constant time. Secrets are 20 random bytes (160 bits, the RFC 4226 recommendation), shown to the user in base32.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_STEP_SEC = 30;
export const TOTP_DIGITS = 6;
/** Steps accepted on either side of the current one. */
export const TOTP_WINDOW = 1;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes base32 (case-insensitive; spaces, dashes and '=' padding ignored). Throws on other characters. */
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

/** RFC 4226 HOTP value for a counter. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SEC);
}

export function totp(secret: Buffer, nowMs: number): string {
  return hotp(secret, totpStep(nowMs));
}

/** Normalises what a person typed: digits only ("123 456" → "123456"). */
export function normaliseCode(input: string): string {
  return input.replace(/\D/g, '');
}

/** The step the code belongs to (to store as lastUsedStep), or null when it is wrong, outside the window or replayed. */
export function verifyTotp(secret: Buffer, input: string, nowMs: number, lastUsedStep: number | null = null): number | null {
  const code = normaliseCode(input);
  if (code.length !== TOTP_DIGITS) return null;
  const now = totpStep(nowMs);
  let matched: number | null = null;
  // Check every candidate step (no early exit) so timing does not reveal which one matched.
  for (let step = now - TOTP_WINDOW; step <= now + TOTP_WINDOW; step++) {
    const ok = timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(code));
    if (ok && matched === null && (lastUsedStep === null || step > lastUsedStep)) matched = step;
  }
  return matched;
}

/** otpauth:// URI for authenticator apps (rendered as a QR code by the staff app). */
export function otpauthUri(opts: { secret: Buffer; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.account)}`;
  const params = new URLSearchParams({ secret: base32Encode(opts.secret), issuer: opts.issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SEC) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* ------------------------------------------------------------------ recovery codes */

/** Unambiguous alphabet (no 0/O, 1/I/L): codes are typed from paper. */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const RECOVERY_CODE_COUNT = 10;

/** "XXXXX-XXXXX" — 10 characters from a 31-letter alphabet ≈ 49.5 bits each, uniformly (rejection sampling). */
export function generateRecoveryCode(): string {
  const n = RECOVERY_ALPHABET.length;
  const limit = 256 - (256 % n); // bytes at or above this would bias the first letters
  const chars: string[] = [];
  while (chars.length < 10) {
    for (const b of randomBytes(16)) {
      if (b < limit && chars.length < 10) chars.push(RECOVERY_ALPHABET[b % n]);
    }
  }
  return `${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`;
}

/** Canonical form for hashing / comparison: upper case, letters and digits only. */
export function normaliseRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

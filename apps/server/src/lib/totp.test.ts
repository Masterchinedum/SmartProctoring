import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateRecoveryCode, generateTotpSecret, hotp, normaliseRecoveryCode, otpauthUri, totp, verifyTotp } from './totp.js';

// RFC 6238 Appendix B (SHA1): secret "12345678901234567890", 8 digits.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC test vectors', () => {
    for (const [t, code] of RFC_VECTORS) expect(hotp(RFC_SECRET, Math.floor(t / 30), 8), `T=${t}`).toBe(code);
  });

  it('matches RFC 4226 HOTP vectors', () => {
    expect([0, 1, 2, 3, 9].map((c) => hotp(RFC_SECRET, c))).toEqual(['755224', '287082', '359152', '969429', '520489']);
  });

  it('accepts the current step and one either side, never older ones or replays', () => {
    const s = generateTotpSecret();
    const now = 1_790_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(s, totp(s, now), now)).toBe(step);
    expect(verifyTotp(s, totp(s, now - 30_000), now)).toBe(step - 1);
    expect(verifyTotp(s, totp(s, now + 30_000), now)).toBe(step + 1);
    expect(verifyTotp(s, totp(s, now - 60_000), now)).toBeNull();
    expect(verifyTotp(s, totp(s, now + 60_000), now)).toBeNull();
    // The same code twice: the second time its step is not after the last used one.
    expect(verifyTotp(s, totp(s, now), now, step)).toBeNull();
    expect(verifyTotp(s, totp(s, now + 30_000), now, step)).toBe(step + 1);
    // Typing tolerance and garbage.
    const c = totp(s, now);
    expect(verifyTotp(s, `${c.slice(0, 3)} ${c.slice(3)}`, now)).toBe(step);
    expect(verifyTotp(s, '12345', now)).toBeNull();
    expect(verifyTotp(s, '', now)).toBeNull();
  });

  it('base32 round-trips and builds an otpauth URI', () => {
    for (let i = 0; i < 20; i++) {
      const b = generateTotpSecret();
      expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
    }
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('mzxw 6ytb-oi==').toString()).toBe('foobar');
    expect(() => base32Decode('ab1')).toThrow();
    const uri = otpauthUri({ secret: RFC_SECRET, account: 'ada@example.edu', issuer: 'SmartProctoring (Test Uni)' });
    expect(uri).toBe(`otpauth://totp/SmartProctoring%20(Test%20Uni):ada%40example.edu?secret=${base32Encode(RFC_SECRET)}&issuer=SmartProctoring+%28Test+Uni%29&algorithm=SHA1&digits=6&period=30`);
  });
});

describe('recovery codes', () => {
  it('are unambiguous, well formed and distinct', () => {
    const codes = Array.from({ length: 500 }, generateRecoveryCode);
    for (const c of codes) expect(c).toMatch(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
    expect(new Set(codes).size).toBe(codes.length);
    expect(normaliseRecoveryCode(' abcde-fghjk ')).toBe('ABCDEFGHJK');
  });
});

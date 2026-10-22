import { describe, expect, it } from 'vitest';
import { cleanCode, formatSecret, looksLikeRecoveryCode, qrMatrix, recoveryCodesFile } from './mfa';
import { staffPageTitle } from '../components/Shell';

describe('two-step sign-in helpers', () => {
  it('builds a square QR matrix with finder patterns', () => {
    const m = qrMatrix('otpauth://totp/SmartProctoring:ada%40example.edu?secret=JBSWY3DPEHPK3PXP&issuer=SmartProctoring');
    const n = m.length;
    expect(n).toBeGreaterThanOrEqual(21);
    expect(m.every((row) => row.length === n)).toBe(true);
    // Finder pattern corners are dark, the separator next to them light.
    for (const [r, c] of [[0, 0], [0, n - 1], [n - 1, 0]]) expect(m[r][c]).toBe(true);
    expect(m[7][7]).toBe(false);
  });

  it('formats secrets and cleans typed codes', () => {
    expect(formatSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
    expect(cleanCode(' 123-456 7')).toBe('123456');
    expect(looksLikeRecoveryCode('ABCDE-FGHJK')).toBe(true);
    expect(looksLikeRecoveryCode('123456')).toBe(false);
  });

  it('writes a recovery codes file', () => {
    const t = recoveryCodesFile(['AAAAA-BBBBB', 'CCCCC-DDDDD'], 'ada@example.edu', 'Test Uni', new Date('2026-10-21T10:00:00Z'));
    expect(t).toContain('Account: ada@example.edu');
    expect(t).toContain('Created: 2026-10-21 10:00 UTC');
    expect(t.split('\n')).toEqual(expect.arrayContaining(['AAAAA-BBBBB', 'CCCCC-DDDDD']));
  });
});

describe('account page', () => {
  it('has its own document title', () => {
    expect(staffPageTitle('/admin/account')).toBe('Account & security — SmartProctoring staff');
  });
});

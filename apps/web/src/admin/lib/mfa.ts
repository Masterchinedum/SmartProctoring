import qrcode from 'qrcode-generator';

/** Two-step sign-in helpers for the staff app. */

/** The QR code of an otpauth:// URI as a module matrix (true = dark), medium error correction. */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** "JBSW Y3DP EHPK 3PXP …" — easier to type into an app by hand. */
export function formatSecret(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

/** Digits only, at most 6 (what a person types or pastes: "123 456", "123-456"). */
export function cleanCode(input: string): string {
  return input.replace(/\D/g, '').slice(0, 6);
}

/** A 6-digit code, or something that looks like a recovery code ("XXXXX-XXXXX"). */
export function looksLikeRecoveryCode(input: string): boolean {
  return input.replace(/[^A-Za-z0-9]/g, '').length === 10 && /[A-Za-z]/.test(input);
}

/** The text file offered for download with fresh recovery codes. */
export function recoveryCodesFile(codes: string[], account: string, org: string, now = new Date()): string {
  return [
    `SmartProctoring recovery codes — ${org}`,
    `Account: ${account}`,
    `Created: ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    'Each code signs you in once when you do not have your authenticator app.',
    'Keep them somewhere safe (a password manager, or printed). Creating new codes makes these invalid.',
    '',
    ...codes,
    '',
  ].join('\n');
}

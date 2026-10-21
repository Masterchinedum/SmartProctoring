/**
 * A self-signed X.509 certificate for test identity providers (SAML signing), built with node:crypto only: the
 * TBSCertificate is DER-encoded here and signed with the key (sha256WithRSAEncryption). Test code — never used to
 * verify anything (signature verification is the SAML library's job).
 */
import { generateKeyPairSync, sign, X509Certificate, type KeyObject } from 'node:crypto';

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, content: Buffer) => Buffer.concat([Buffer.from([tag]), len(content.length), content]);
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const int = (bytes: Buffer) => tlv(0x02, bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
const oid = (hex: string) => tlv(0x06, Buffer.from(hex, 'hex'));
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
const NULL = Buffer.from([0x05, 0x00]);
const SHA256_RSA = oid('2a864886f70d01010b');
const CN = oid('550403');

function utcTime(d: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

export interface TestCertificate {
  privateKey: KeyObject;
  privateKeyPem: string;
  certPem: string;
  /** Base64 DER (as in SAML metadata). */
  certBase64: string;
}

export function selfSignedCertificate(commonName: string, opts: { notBefore?: Date; notAfter?: Date } = {}): TestCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const name = seq(set(seq(CN, utf8(commonName))));
  const notBefore = opts.notBefore ?? new Date(Date.now() - 86_400_000);
  const notAfter = opts.notAfter ?? new Date(Date.now() + 5 * 365 * 86_400_000);
  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))), // version v3
    int(Buffer.from(Date.now().toString(16).padStart(12, '0'), 'hex')),
    seq(SHA256_RSA, NULL),
    name,
    seq(utcTime(notBefore), utcTime(notAfter)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = seq(tbs, seq(SHA256_RSA, NULL), tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const cert = new X509Certificate(der);
  return { privateKey, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), certPem: cert.toString(), certBase64: der.toString('base64') };
}

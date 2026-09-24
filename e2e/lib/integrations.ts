import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ARTIFACTS_DIR, REPO_DIR } from './config';

/**
 * Local stand-ins for the systems SmartProctoring talks to (integrations spec):
 *  - an HTTPS webhook receiver (self-signed certificate for localhost; the server trusts it through
 *    NODE_EXTRA_CA_CERTS, because production mode only allows https:// webhook URLs);
 *  - a minimal SMTP sink (no TLS, no auth) that keeps every message in memory;
 *  - the signature-verification function exactly as documented in docs/INTEGRATION_API.md.
 * Everything lives in the test worker; nothing is written inside the tracked repository.
 */

/* ------------------------------------------------------------------ TLS */

export interface TlsMaterial {
  certPath: string;
  cert: string;
  key: string;
}

/** Self-signed certificate for localhost / 127.0.0.1 (generated once into e2e/.artifacts/tls). */
export function localhostCert(): TlsMaterial {
  const dir = join(ARTIFACTS_DIR, 'tls');
  mkdirSync(dir, { recursive: true });
  const certPath = join(dir, 'localhost-cert.pem');
  const keyPath = join(dir, 'localhost-key.pem');
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '30',
      '-keyout', keyPath, '-out', certPath,
      '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-addext', 'basicConstraints=critical,CA:TRUE',
    ], { stdio: 'pipe' });
  }
  return { certPath, cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') };
}

/* ------------------------------------------------------------------ webhook receiver */

export interface ReceivedWebhook {
  at: number;
  path: string;
  headers: Record<string, string>;
  rawBody: Buffer;
  body: { id: string; type: string; createdAt: number; orgId: string; data: Record<string, unknown> };
  /** HTTP status this receiver answered with. */
  status: number;
}

export class WebhookReceiver {
  readonly requests: ReceivedWebhook[] = [];
  /** Decides the HTTP status for a request (default 200). */
  responder: (r: Omit<ReceivedWebhook, 'status'>) => number = () => 200;
  private constructor(
    private readonly server: https.Server,
    readonly port: number,
  ) {}

  static async start(tls: TlsMaterial): Promise<WebhookReceiver> {
    let self: WebhookReceiver | null = null;
    const server = https.createServer({ cert: tls.cert, key: tls.key }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks);
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v;
        let body: ReceivedWebhook['body'];
        try {
          body = JSON.parse(rawBody.toString('utf8'));
        } catch {
          body = { id: '', type: 'unparseable', createdAt: 0, orgId: '', data: {} };
        }
        const rec = { at: Date.now(), path: req.url ?? '', headers, rawBody, body };
        let status = 200;
        try {
          status = self!.responder(rec);
        } catch {
          status = 500;
        }
        self!.requests.push({ ...rec, status });
        res.writeHead(status, { 'Content-Type': 'text/plain' });
        res.end(status >= 200 && status < 300 ? 'ok' : 'receiver failure (simulated)');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    self = new WebhookReceiver(server, (server.address() as AddressInfo).port);
    return self;
  }

  url(path = '/hooks/smartproctoring'): string {
    return `https://localhost:${this.port}${path}`;
  }

  ofType(type: string): ReceivedWebhook[] {
    return this.requests.filter((r) => r.body.type === type);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.closeAllConnections?.();
      this.server.close(() => resolve());
    });
  }
}

/* ------------------------------------------------------------------ SMTP sink */

export interface ReceivedMail {
  at: number;
  from: string;
  to: string[];
  raw: string;
  subject: string;
  text: string;
  html: string;
  /** Content types of every MIME part. */
  partTypes: string[];
}

function decodeQuotedPrintable(s: string): string {
  const bytes: number[] = [];
  const src = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '=' && /^[0-9A-F]{2}$/i.test(src.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      for (const b of Buffer.from(src[i], 'utf8')) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** RFC 2047 encoded words (=?UTF-8?Q?...?= / =?UTF-8?B?...?=). */
function decodeHeader(v: string): string {
  return v
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g, (_m, _cs: string, enc: string, text: string) =>
      enc.toUpperCase() === 'B' ? Buffer.from(text, 'base64').toString('utf8') : decodeQuotedPrintable(text.replace(/_/g, ' ')),
    );
}

function splitMessage(raw: string): { headers: Record<string, string>; body: string } {
  const i = raw.search(/\r?\n\r?\n/);
  const head = i >= 0 ? raw.slice(0, i) : raw;
  const body = i >= 0 ? raw.slice(i).replace(/^\r?\n\r?\n/, '') : '';
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const c = line.indexOf(':');
    if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
  }
  return { headers, body };
}

function decodeBody(headers: Record<string, string>, body: string): string {
  const enc = (headers['content-transfer-encoding'] ?? '').toLowerCase();
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body);
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  return body;
}

/** Walk a (possibly multipart) message; collect text/plain, text/html and every part's content type. */
function parseMail(raw: string): Pick<ReceivedMail, 'subject' | 'text' | 'html' | 'partTypes'> {
  const out = { subject: '', text: '', html: '', partTypes: [] as string[] };
  const top = splitMessage(raw);
  out.subject = decodeHeader(top.headers.subject ?? '');
  const walk = (headers: Record<string, string>, body: string) => {
    const ct = headers['content-type'] ?? 'text/plain';
    out.partTypes.push(ct.split(';')[0].trim().toLowerCase());
    const boundary = /boundary="?([^";]+)"?/i.exec(ct)?.[1];
    if (/^multipart\//i.test(ct) && boundary) {
      const parts = body.split(`--${boundary}`).slice(1);
      for (const p of parts) {
        if (p.startsWith('--')) break;
        const sub = splitMessage(p.replace(/^\r?\n/, ''));
        walk(sub.headers, sub.body);
      }
      return;
    }
    const decoded = decodeBody(headers, body);
    if (/^text\/html/i.test(ct)) out.html += decoded;
    else if (/^text\/plain/i.test(ct)) out.text += decoded;
  };
  walk(top.headers, top.body);
  return out;
}

/** Minimal SMTP server (RFC 5321 subset: EHLO/HELO, MAIL, RCPT, DATA, RSET, NOOP, QUIT). No TLS, no AUTH. */
export class SmtpSink {
  readonly messages: ReceivedMail[] = [];
  private constructor(
    private readonly server: net.Server,
    readonly port: number,
  ) {}

  static async start(): Promise<SmtpSink> {
    let self: SmtpSink | null = null;
    const server = net.createServer((sock) => {
      sock.setEncoding('utf8');
      let buf = '';
      let inData = false;
      let data: string[] = [];
      let from = '';
      let to: string[] = [];
      const reply = (s: string) => sock.write(`${s}\r\n`);
      reply('220 e2e-smtp-sink ESMTP ready');
      sock.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          if (inData) {
            if (line === '.') {
              inData = false;
              const raw = data.join('\r\n');
              self!.messages.push({ at: Date.now(), from, to, raw, ...parseMail(raw) });
              data = [];
              reply('250 2.0.0 queued');
            } else {
              data.push(line.startsWith('..') ? line.slice(1) : line);
            }
            continue;
          }
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === 'EHLO') {
            sock.write('250-e2e-smtp-sink\r\n250-8BITMIME\r\n250-SMTPUTF8\r\n250 SIZE 26214400\r\n');
          } else if (cmd === 'HELO') {
            reply('250 e2e-smtp-sink');
          } else if (cmd === 'MAIL') {
            from = /<([^>]*)>/.exec(line)?.[1] ?? '';
            to = [];
            reply('250 2.1.0 ok');
          } else if (cmd === 'RCPT') {
            to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
            reply('250 2.1.5 ok');
          } else if (cmd === 'DATA') {
            inData = true;
            data = [];
            reply('354 end data with <CR><LF>.<CR><LF>');
          } else if (cmd === 'RSET') {
            from = '';
            to = [];
            reply('250 2.0.0 ok');
          } else if (cmd === 'NOOP') {
            reply('250 2.0.0 ok');
          } else if (cmd === 'QUIT') {
            reply('221 2.0.0 bye');
            sock.end();
          } else {
            reply('502 5.5.2 command not implemented');
          }
        }
      });
      sock.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    self = new SmtpSink(server, (server.address() as AddressInfo).port);
    return self;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

/* ------------------------------------------------------------------ documented signature check */

export type VerifyFn = (rawBody: string | Buffer, header: string | undefined, secret: string, toleranceSec?: number, nowSec?: number) => boolean;

/**
 * The verification function customers copy from docs/INTEGRATION_API.md (between the verify-snippet
 * markers), loaded verbatim as an ES module — so the suite tests the documentation itself.
 */
export async function documentedVerifier(): Promise<VerifyFn> {
  const doc = readFileSync(join(REPO_DIR, 'docs/INTEGRATION_API.md'), 'utf8');
  const m = /<!-- verify-snippet:start -->\s*```js\n([\s\S]*?)```\s*<!-- verify-snippet:end -->/.exec(doc);
  if (!m) throw new Error('verify snippet markers not found in docs/INTEGRATION_API.md');
  const file = join(ARTIFACTS_DIR, 'verify-smartproctoring.mjs');
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  writeFileSync(file, m[1]);
  const mod = (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)) as { verifySmartProctoringSignature: VerifyFn };
  return mod.verifySmartProctoringSignature;
}

/**
 * Privacy assertions shared by webhook, email and API checks: no image data or evidence links, and no
 * face-similarity scores (keys named like "similarity" must be absent or null; no "similarity 0.xx" text).
 */
export function privacyProblems(value: unknown): string[] {
  const problems: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === 'string') {
      if (/data:image\//i.test(v)) problems.push(`${path}: data:image URI`);
      if (/\/9j\/4AAQ|iVBORw0KGgo/.test(v)) problems.push(`${path}: base64 image data`);
      if (/\/api\/admin\/evidence\//i.test(v)) problems.push(`${path}: evidence URL`);
      if (/similarity\s*[:=]?\s*-?\d/i.test(v)) problems.push(`${path}: similarity score in text`);
      return;
    }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (/similarity/i.test(k) && x != null) problems.push(`${path}.${k}: similarity value ${JSON.stringify(x)}`);
        if (/^(evidence|image|images|imageUrl|url)$/i.test(k) && x != null && (typeof x !== 'string' || /evidence|\.jpe?g|image\//i.test(x))) problems.push(`${path}.${k}: ${JSON.stringify(x).slice(0, 80)}`);
        walk(x, `${path}.${k}`);
      }
    }
  };
  walk(value, '$');
  return problems;
}

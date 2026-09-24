/**
 * Outgoing HTTP for webhooks with SSRF protection.
 *
 *  - isPublicAddress(): fail-closed classification of IPv4/IPv6 literals. Only globally routable unicast
 *    addresses are public; loopback, private (RFC 1918, ULA), link-local (incl. cloud metadata
 *    169.254.169.254), CGNAT, multicast, documentation/benchmark ranges and anything unparseable are not.
 *    IPv4-mapped / -compatible, NAT64 (64:ff9b::/96) and 6to4 addresses are judged by the embedded IPv4.
 *  - validateWebhookUrl(): URL rules applied when staff save a webhook (scheme, credentials, host).
 *  - postJson(): one POST with a hard timeout. Unless private networks are allowed, the destination is
 *    checked at CONNECT time through a custom DNS lookup (every resolved address must be public, and the
 *    socket connects to the address that was checked), so DNS rebinding between validation and delivery
 *    does not help an attacker. Redirects are never followed (3xx counts as a failure).
 */
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/* ------------------------------------------------------------------ IP parsing & classification */

function parseIPv4(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function parseIPv6(input: string): number[] | null {
  let s = input;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  let tail4: number[] | null = null;
  const lastColon = s.lastIndexOf(':');
  if (lastColon < 0) return null;
  if (s.slice(lastColon + 1).includes('.')) {
    tail4 = parseIPv4(s.slice(lastColon + 1));
    if (!tail4) return null;
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...rest];
  }
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const v = Number.parseInt(g, 16);
    bytes.push(v >> 8, v & 0xff);
  }
  if (tail4) bytes.splice(12, 4, ...tail4);
  return bytes;
}

function isPublicV4(b: number[]): boolean {
  const [a, c] = b;
  if (a === 0) return false; // 0.0.0.0/8 "this network"
  if (a === 10) return false; // RFC 1918
  if (a === 100 && (c & 0xc0) === 64) return false; // 100.64.0.0/10 CGNAT
  if (a === 127) return false; // loopback
  if (a === 169 && c === 254) return false; // link-local (incl. cloud metadata endpoints)
  if (a === 172 && (c & 0xf0) === 16) return false; // RFC 1918
  if (a === 192 && c === 0 && (b[2] === 0 || b[2] === 2)) return false; // 192.0.0.0/24 IETF, 192.0.2.0/24 TEST-NET-1
  if (a === 192 && c === 88 && b[2] === 99) return false; // 6to4 relay anycast
  if (a === 192 && c === 168) return false; // RFC 1918
  if (a === 198 && (c & 0xfe) === 18) return false; // 198.18.0.0/15 benchmarking
  if (a === 198 && c === 51 && b[2] === 100) return false; // TEST-NET-2
  if (a === 203 && c === 0 && b[2] === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

function isPublicV6(b: number[]): boolean {
  const allZero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  // ::/96 (unspecified, loopback, IPv4-compatible) and ::ffff:0:0/96 (IPv4-mapped): judge the embedded IPv4.
  if (allZero(0, 12)) return isPublicV4(b.slice(12));
  if (allZero(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPublicV4(b.slice(12));
  // 64:ff9b::/96 NAT64 well-known prefix: embedded IPv4.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && allZero(4, 12)) return isPublicV4(b.slice(12));
  // Only 2000::/3 is global unicast (this excludes ULA fc00::/7, link-local fe80::/10, multicast ff00::/8, 64:ff9b:1::/48, 100::/64 ...).
  if ((b[0] & 0xe0) !== 0x20) return false;
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] < 0x02) return false; // 2001::/23 IETF protocol assignments (Teredo, ORCHID, benchmarking)
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false; // 2001:db8::/32 documentation
  if (b[0] === 0x20 && b[1] === 0x02) return isPublicV4(b.slice(2, 6)); // 2002::/16 6to4: embedded IPv4
  if (b[0] === 0x3f && b[1] === 0xff && (b[2] & 0xf0) === 0) return false; // 3fff::/20 documentation
  return true;
}

/** true only for globally routable unicast addresses. Unparseable input is NOT public (fail closed). */
export function isPublicAddress(address: string): boolean {
  const a = address.trim().replace(/^\[|\]$/g, '');
  const v = net.isIP(a.split('%')[0]);
  if (v === 4) {
    const b = parseIPv4(a);
    return !!b && isPublicV4(b);
  }
  if (v === 6) {
    const b = parseIPv6(a);
    return !!b && isPublicV6(b);
  }
  return false;
}

/* ------------------------------------------------------------------ URL validation */

export class WebhookUrlError extends Error {
  constructor(
    readonly code: 'invalid_url' | 'https_required' | 'credentials_not_allowed' | 'private_address' | 'unresolvable_host',
    message: string,
  ) {
    super(message);
    this.name = 'WebhookUrlError';
  }
}

export interface UrlPolicy {
  requireHttps: boolean;
  allowPrivateNetworks: boolean;
}

function hostOf(u: URL): string {
  return u.hostname.replace(/^\[|\]$/g, '');
}

function resolveAll(host: string, timeoutMs: number): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('DNS lookup timed out')), timeoutMs);
    t.unref?.();
    dnsLookup(host, { all: true, verbatim: true }, (err, addresses) => {
      clearTimeout(t);
      if (err) reject(err);
      else resolve(addresses);
    });
  });
}

/**
 * Validate a webhook URL when it is saved. With private networks disallowed, the host must resolve and every
 * address must be public (the same check is repeated when connecting).
 */
export async function validateWebhookUrl(raw: string, policy: UrlPolicy, dnsTimeoutMs = 3000): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new WebhookUrlError('invalid_url', 'Enter a valid URL, e.g. https://lms.example.com/hooks/proctoring');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new WebhookUrlError('invalid_url', 'Webhook URLs must use https:// (or http:// in development).');
  if (policy.requireHttps && u.protocol !== 'https:') throw new WebhookUrlError('https_required', 'Webhook URLs must use https://.');
  if (u.username || u.password) throw new WebhookUrlError('credentials_not_allowed', 'Do not put credentials in the URL; verify requests with the signature header instead.');
  const host = hostOf(u);
  if (!host) throw new WebhookUrlError('invalid_url', 'The URL has no host name.');
  if (policy.allowPrivateNetworks) return u;
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw new WebhookUrlError('private_address', `${host} is a private, loopback or reserved address; webhooks can only be sent to public internet addresses.`);
    return u;
  }
  let addresses: LookupAddress[];
  try {
    addresses = await resolveAll(host, dnsTimeoutMs);
  } catch {
    throw new WebhookUrlError('unresolvable_host', `The host name ${host} could not be resolved. Check the URL.`);
  }
  if (addresses.length === 0) throw new WebhookUrlError('unresolvable_host', `The host name ${host} could not be resolved. Check the URL.`);
  const bad = addresses.find((a) => !isPublicAddress(a.address));
  if (bad) throw new WebhookUrlError('private_address', `${host} resolves to ${bad.address}, a private, loopback or reserved address; webhooks can only be sent to public internet addresses.`);
  return u;
}

/* ------------------------------------------------------------------ guarded POST */

export interface PostResult {
  ok: boolean;
  statusCode: number | null;
  /** Short human-readable reason when !ok (never contains secrets). */
  error: string | null;
  durationMs: number;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

class BlockedAddressError extends Error {
  code = 'ESSRFBLOCKED';
  constructor(host: string, address: string) {
    super(`Destination ${host} resolves to ${address}, which is not a public address (blocked)`);
    this.name = 'BlockedAddressError';
  }
}

/** DNS lookup that refuses non-public addresses; the socket then connects to exactly the address checked. */
function guardedLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dnsLookup(hostname, { family: options.family ?? 0, hints: options.hints, all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    if (!addresses.length) return callback(Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND' }), '', 0);
    const bad = addresses.find((a) => !isPublicAddress(a.address));
    if (bad) return callback(new BlockedAddressError(hostname, bad.address), '', 0);
    if (options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

function describeError(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  if (e?.name === 'BlockedAddressError') return e.message;
  switch (e?.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'Host name could not be resolved';
    case 'ECONNREFUSED':
      return 'Connection refused';
    case 'ECONNRESET':
      return 'Connection reset by the receiver';
    case 'ETIMEDOUT':
      return 'Connection timed out';
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `TLS certificate problem (${e.code})`;
    default:
      return (e?.message || String(err)).slice(0, 300);
  }
}

const MAX_RESPONSE_BYTES = 64 * 1024;
const SNIPPET_BYTES = 300;

/**
 * POST `body` to `target`. Resolves (never rejects) with the outcome: ok = HTTP 2xx within `timeoutMs`
 * (connect + full response). Response bodies are drained (max 64 KB) and only a short snippet is kept.
 */
export function postJson(target: URL, body: string, headers: Record<string, string>, opts: { timeoutMs: number; allowPrivateNetworks: boolean }): Promise<PostResult> {
  const started = Date.now();
  return new Promise<PostResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (r: Omit<PostResult, 'durationMs'>) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ...r, durationMs: Date.now() - started });
    };
    const host = hostOf(target);
    if (!opts.allowPrivateNetworks && net.isIP(host) && !isPublicAddress(host)) {
      finish({ ok: false, statusCode: null, error: `Destination ${host} is not a public address (blocked)` });
      return;
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      finish({ ok: false, statusCode: null, error: 'Unsupported URL scheme' });
      return;
    }
    const mod = target.protocol === 'https:' ? https : http;
    let req: http.ClientRequest;
    try {
      req = mod.request(target, {
        method: 'POST',
        headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
        agent: false,
        ...(opts.allowPrivateNetworks ? {} : { lookup: guardedLookup as unknown as net.LookupFunction }),
      });
    } catch (err) {
      finish({ ok: false, statusCode: null, error: describeError(err) });
      return;
    }
    timer = setTimeout(() => {
      req.destroy(Object.assign(new Error(`Timed out after ${Math.round(opts.timeoutMs / 1000)} s`), { code: 'ESPTIMEOUT' }));
    }, opts.timeoutMs);
    timer.unref?.();
    req.on('response', (res) => {
      const status = res.statusCode ?? 0;
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        if (size < SNIPPET_BYTES) chunks.push(c);
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) res.destroy();
      });
      const done = () => {
        const ok = status >= 200 && status < 300;
        let snippet = Buffer.concat(chunks).subarray(0, SNIPPET_BYTES).toString('utf8').replace(/\s+/g, ' ').trim();
        if (snippet.length > 200) snippet = `${snippet.slice(0, 200)}…`;
        const redirect = status >= 300 && status < 400 ? ' (redirects are not followed)' : '';
        finish({ ok, statusCode: status, error: ok ? null : `HTTP ${status}${redirect}${snippet ? `: ${snippet}` : ''}` });
      };
      res.on('end', done);
      res.on('close', done);
      res.on('error', done);
    });
    req.on('error', (err) => finish({ ok: false, statusCode: null, error: describeError(err) }));
    req.end(body);
  });
}

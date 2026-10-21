/**
 * Remote vision driver (VISION_DRIVER=remote): a VisionService that sends every analysis to one of a fleet of
 * dedicated vision workers (src/vision-worker) over HTTP, so face analysis scales on its own hosts, independently of
 * the API servers. The in-process pool (service.ts) stays the default and is what development and tests use.
 *
 *  - Workers: VISION_WORKER_URLS, one or more base URLs. A DNS name is re-resolved every `resolveMs` and each of its
 *    addresses is one worker (docker compose `--scale vision=3` behind the service name, a Kubernetes headless
 *    Service); `localhost` and IP literals are used as they are. Two addresses that reach the same worker process
 *    (same instance id) count once.
 *  - Load balancing: least expected wait for the request's priority, from each worker's reported VisionLoad (polled
 *    every `pollMs` and refreshed by every answer) plus the requests sent to it since that report.
 *  - Failures: a worker that refuses connections, rejects the token, or fails `failureThreshold` requests / polls in a
 *    row is skipped (circuit open) until a poll succeeds again (back-off 1 s → 30 s). A request the worker did not
 *    accept (connection failed, a stale keep-alive socket, 503 busy / unavailable) is retried ONCE, on another worker
 *    (or the same one for a stale socket); a request it accepted is never retried (it may still be analysing it), so
 *    load never doubles.
 *  - Errors behave like a saturated local pool: no worker available, every worker busy, or an accepted request that
 *    timed out => VisionBusyError with a Retry-After (HTTP 503 vision_busy: identity samples are retried later, check
 *    frames tell the candidate the server is busy). A corrupt image => VisionInputError (HTTP 400), as in-process.
 *  - `load` aggregates the workers in use (sum of threads, queues, in flight; the best worker's expected wait), so
 *    readiness (≥ 1 worker ready), capacity, admission at exam start, load-aware sampling and /metrics keep working.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { VisionInputError } from './image';
import { DEFAULT_RETRY_AFTER_SEC, MAX_RETRY_AFTER_SEC, retryAfterSecFor, VisionBusyError, VisionClosedError } from './pool';
import type { AnalyzeOptions, IdPhotoCapableVisionService, IdPhotoResult, ImageAnalysis, RemoteFailureReason, VisionByPriority, VisionLoad, VisionObserver, VisionPriority } from './types';
import {
  decodeAnalysis,
  decodeIdPhotoResult,
  decodeLoad,
  decodeTimings,
  encodeOptions,
  MAX_RESPONSE_BYTES,
  OPTIONS_HEADER,
  parse,
  VisionWireError,
  type WireTiming,
  type WorkerErrorBody,
} from './wire';

export interface RemoteVisionLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface RemoteVisionOptions {
  /** Base URLs of the workers (http:// or https://). */
  urls: string[];
  /** VISION_WORKER_TOKEN (the same on every worker). */
  token: string;
  /** Longest wait for an analysis, queue included (VISION_WORKER_TIMEOUT_MS, default 30 000). */
  timeoutMs?: number;
  /** TCP (+ TLS) connection set-up (default 2 000). */
  connectTimeoutMs?: number;
  /** Load poll interval per worker (default 1 000) and its timeout (default 2 000). */
  pollMs?: number;
  pollTimeoutMs?: number;
  /** DNS re-resolution interval of worker names (default 10 000). */
  resolveMs?: number;
  /** Consecutive failures (requests or polls) before a worker in use is skipped (default 3). */
  failureThreshold?: number;
  observer?: VisionObserver;
  log?: RemoteVisionLogger;
  /** Name resolution (tests): every address of `hostname`. */
  lookup?: (hostname: string) => Promise<string[]>;
}

export type RemoteWorkerState = 'unknown' | 'up' | 'unready' | 'down';

export interface RemoteWorkerInfo {
  /** host:port actually connected to (the address of a DNS name). */
  key: string;
  /** The configured URL it came from. */
  source: string;
  state: RemoteWorkerState;
  instanceId: string | null;
  /** Another address reaches the same worker process: not used, not counted. */
  duplicate: boolean;
  /** Analysis threads ready on it (last report). */
  workers: number;
  lastError: string | null;
}

/** When no worker can take an analysis (all down / unready): the client comes back after this (s). */
export const NO_WORKER_RETRY_AFTER_SEC = 5;
/** An accepted request that failed (reset, unexpected answer): the client comes back after this (s). */
const FAILED_REQUEST_RETRY_AFTER_SEC = 5;
/** At most this many workers are tried per analysis (one retry). */
const MAX_ATTEMPTS = 2;
const MIN_COOLDOWN_MS = 1_000;
const MAX_COOLDOWN_MS = 30_000;

interface Origin {
  protocol: 'http:' | 'https:';
  /** What to connect to (an IP address, or the configured host name). */
  address: string;
  port: number;
  /** Host header and TLS server name: the configured host. */
  hostname: string;
  hostHeader: string;
  /** Path prefix of the base URL ('' or '/prefix'). */
  basePath: string;
}

class Endpoint {
  state: RemoteWorkerState = 'unknown';
  snap: VisionLoad | null = null;
  snapAt = 0;
  /** Requests sent since the last report (not yet in `snap`). */
  sentSinceSnap = 0;
  inFlight = 0;
  instanceId: string | null = null;
  failures = 0;
  cooldownMs = MIN_COOLDOWN_MS;
  openUntil = 0;
  lastError: string | null = null;
  polling = false;
  constructor(
    readonly key: string,
    readonly source: string,
    readonly origin: Origin,
  ) {}
}

interface Source {
  url: URL;
  /** A DNS name expanded to all its addresses. */
  dynamic: boolean;
  endpoints: Map<string, Endpoint>;
  resolveError: string | null;
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

/** A request that failed below HTTP. `accepted`: it may have reached the worker (never retried). */
class TransportError extends Error {
  constructor(
    readonly reason: RemoteFailureReason,
    readonly accepted: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

const zero = (): VisionByPriority => ({ interactive: 0, background: 0 });
const PRIORITIES: VisionPriority[] = ['interactive', 'background'];
const STALE_SOCKET_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED']);

function parseRetryAfter(res: RawResponse, body: WorkerErrorBody | null): number {
  const h = Number.parseInt(String(res.headers['retry-after'] ?? ''), 10);
  const v = Number.isFinite(h) ? h : (body?.retryAfterSec ?? DEFAULT_RETRY_AFTER_SEC);
  return Math.min(MAX_RETRY_AFTER_SEC, Math.max(1, Math.round(v)));
}

function tryParse(text: string): WorkerErrorBody | null {
  try {
    const v = parse(text);
    return v && typeof v === 'object' ? (v as WorkerErrorBody) : null;
  } catch {
    return null;
  }
}

async function defaultLookup(hostname: string): Promise<string[]> {
  return [...new Set((await dnsLookup(hostname, { all: true })).map((a) => a.address))];
}

export class RemoteVisionService implements IdPhotoCapableVisionService {
  private readonly sources: Source[];
  private readonly timeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly pollMs: number;
  private readonly pollTimeoutMs: number;
  private readonly resolveMs: number;
  private readonly failureThreshold: number;
  private readonly httpAgent: http.Agent;
  private readonly httpsAgent: https.Agent;
  private readonly lookup: (hostname: string) => Promise<string[]>;
  private timer: NodeJS.Timeout | null = null;
  private lastResolveAt = 0;
  private closed = false;
  private inFlight = 0;
  private rr = 0;
  private lastServiceMs = 100;

  private constructor(private readonly o: RemoteVisionOptions) {
    if (!o.urls.length) throw new Error('The remote vision driver needs at least one worker URL (VISION_WORKER_URLS).');
    this.sources = o.urls.map((raw) => {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Vision worker URL must be http:// or https://: ${raw}`);
      const host = url.hostname.replace(/^\[|\]$/g, '');
      return { url, dynamic: isIP(host) === 0 && host !== 'localhost', endpoints: new Map(), resolveError: null };
    });
    this.timeoutMs = o.timeoutMs ?? 30_000;
    this.connectTimeoutMs = o.connectTimeoutMs ?? 2_000;
    this.pollMs = o.pollMs ?? 1_000;
    this.pollTimeoutMs = o.pollTimeoutMs ?? 2_000;
    this.resolveMs = o.resolveMs ?? 10_000;
    this.failureThreshold = Math.max(1, o.failureThreshold ?? 3);
    this.lookup = o.lookup ?? defaultLookup;
    // Keep-alive: one connection per concurrent analysis, reused frame after frame. No socket cap: requests must reach
    // the worker's own priority queue rather than wait FIFO here. Idle sockets close before the worker's (65 s).
    const agentOpts = { keepAlive: true, timeout: 30_000, maxFreeSockets: 256 };
    this.httpAgent = new http.Agent(agentOpts);
    this.httpsAgent = new https.Agent(agentOpts);
  }

  /** Resolve the workers, ask each for its load once, then keep polling. Starts even when none answers yet. */
  static async create(o: RemoteVisionOptions): Promise<RemoteVisionService> {
    const svc = new RemoteVisionService(o);
    await svc.refresh(true);
    const infos = svc.workerInfo();
    const up = infos.filter((w) => w.state === 'up' && !w.duplicate).length;
    if (up === 0) svc.o.log?.warn({ workers: infos }, 'remote vision: no vision worker is ready yet; face analysis is unavailable until one answers');
    else svc.o.log?.info({ workers: infos.map((w) => ({ key: w.key, state: w.state, threads: w.workers })) }, `remote vision: ${up} of ${infos.length} vision workers ready`);
    svc.timer = setInterval(() => {
      svc.refresh(false).catch((err: unknown) => svc.o.log?.error({ err: (err as Error).message }, 'remote vision: polling the workers failed'));
    }, svc.pollMs);
    svc.timer.unref();
    return svc;
  }

  /* ------------------------------------------------------------------------------- endpoints */

  private *endpoints(): Iterable<Endpoint> {
    for (const s of this.sources) yield* s.endpoints.values();
  }

  private async resolveSources(): Promise<void> {
    this.lastResolveAt = Date.now();
    await Promise.all(
      this.sources.map(async (s) => {
        const host = s.url.hostname.replace(/^\[|\]$/g, '');
        let addresses: string[];
        if (!s.dynamic) addresses = [host];
        else {
          try {
            addresses = await this.lookup(host);
            if (s.resolveError) this.o.log?.info({ source: s.url.origin }, 'remote vision: worker name resolves again');
            s.resolveError = null;
          } catch (err) {
            const msg = (err as Error).message;
            if (s.resolveError !== msg) this.o.log?.warn({ source: s.url.origin, err: msg }, 'remote vision: cannot resolve the vision worker name (keeping the last known addresses)');
            s.resolveError = msg;
            if (s.endpoints.size) return; // keep what worked last
            addresses = [];
          }
        }
        const port = Number(s.url.port || (s.url.protocol === 'https:' ? 443 : 80));
        const seen = new Set<string>();
        for (const address of addresses) {
          const key = `${isIP(address) === 6 ? `[${address}]` : address}:${port}`;
          seen.add(key);
          if (s.endpoints.has(key)) continue;
          s.endpoints.set(
            key,
            new Endpoint(key, s.url.origin + s.url.pathname.replace(/\/+$/, ''), {
              protocol: s.url.protocol as Origin['protocol'],
              address,
              port,
              hostname: host,
              hostHeader: s.url.host,
              basePath: s.url.pathname.replace(/\/+$/, ''),
            }),
          );
        }
        for (const key of [...s.endpoints.keys()]) if (!seen.has(key)) s.endpoints.delete(key); // gone from DNS
      }),
    );
  }

  /** One polling round: re-resolve names when due, then ask every worker that may be asked for its load. */
  private async refresh(initial: boolean): Promise<void> {
    if (this.closed) return;
    if (initial || Date.now() - this.lastResolveAt >= this.resolveMs) await this.resolveSources();
    const now = Date.now();
    await Promise.all(
      [...this.endpoints()].filter((e) => !e.polling && (e.state !== 'down' || now >= e.openUntil)).map((e) => this.poll(e)),
    );
  }

  private async poll(e: Endpoint): Promise<void> {
    e.polling = true;
    try {
      const res = await this.send(e, 'GET', '/v1/load', null, {}, this.pollTimeoutMs);
      if (res.status === 401) return this.failed(e, 'unauthorized', 'the worker rejected VISION_WORKER_TOKEN');
      if (res.status !== 200) return this.failed(e, 'server_error', `load poll answered HTTP ${res.status}`);
      let body: { instanceId?: unknown; load?: unknown };
      try {
        body = parse(res.text) as typeof body;
        this.report(e, decodeLoad(body.load), typeof body.instanceId === 'string' ? body.instanceId : null);
      } catch {
        return this.failed(e, 'bad_response', 'malformed load answer');
      }
    } catch (err) {
      const t = err as TransportError;
      this.failed(e, t.reason ?? 'connect', t.message);
    } finally {
      e.polling = false;
    }
  }

  /** A load report (poll or answer): the worker is alive. */
  private report(e: Endpoint, load: VisionLoad, instanceId: string | null): void {
    if (this.closed) return;
    e.snap = load;
    e.snapAt = Date.now();
    e.sentSinceSnap = 0;
    if (instanceId) e.instanceId = instanceId;
    e.failures = 0;
    e.cooldownMs = MIN_COOLDOWN_MS;
    if (load.serviceMs > 0) this.lastServiceMs = load.serviceMs;
    const next: RemoteWorkerState = load.workers > 0 ? 'up' : 'unready';
    if (next !== e.state) {
      const msg = next === 'up' ? (e.state === 'unknown' ? 'remote vision: worker ready' : 'remote vision: worker ready again') : 'remote vision: worker reachable but has no analysis thread ready';
      (next === 'up' ? this.o.log?.info : this.o.log?.warn)?.call(this.o.log, { worker: e.key, threads: load.workers }, msg);
      e.lastError = next === 'up' ? null : e.lastError;
    }
    e.state = next;
  }

  /**
   * A request or poll failed: count it, and stop using the worker when it is clearly not answering. An analysis that
   * timed out is not held against the worker (`countIt` false): under overload a long queue is expected, the worker
   * dropped the frame when the connection closed, and a hung worker fails its load polls (2 s) anyway.
   */
  private failed(e: Endpoint, reason: RemoteFailureReason, message: string, countIt = true): void {
    if (this.closed) return; // e.g. a poll cut short by close()
    e.lastError = message;
    try {
      this.o.observer?.remoteFailure?.(reason);
    } catch {
      /* metrics must never break analysis */
    }
    if (!countIt) return;
    e.failures++;
    if (reason === 'connect' || reason === 'unauthorized' || e.state !== 'up' || e.failures >= this.failureThreshold) this.open(e, reason, message);
  }

  /** Circuit open: skipped until a poll succeeds (polls back off from 1 s to 30 s). */
  private open(e: Endpoint, reason: RemoteFailureReason, message: string): void {
    const wasUsable = e.state === 'up' || e.state === 'unready';
    e.state = 'down';
    e.openUntil = Date.now() + e.cooldownMs;
    e.cooldownMs = Math.min(MAX_COOLDOWN_MS, e.cooldownMs * 2);
    e.failures = 0;
    if (wasUsable || reason === 'unauthorized') {
      const log = reason === 'unauthorized' ? this.o.log?.error : this.o.log?.warn;
      log?.call(this.o.log, { worker: e.key, reason, err: message }, reason === 'unauthorized' ? 'remote vision: the worker rejected VISION_WORKER_TOKEN (set the same token on the server and the worker); not using it' : 'remote vision: worker not answering; not using it until it answers again');
    }
  }

  /** Workers in use: answering, with a ready thread, one entry per worker process. */
  private active(): Endpoint[] {
    const seen = new Set<string>();
    const out: Endpoint[] = [];
    for (const e of this.endpoints()) {
      if (e.state !== 'up' || !e.snap) continue;
      if (e.instanceId) {
        if (seen.has(e.instanceId)) continue;
        seen.add(e.instanceId);
      }
      out.push(e);
    }
    return out;
  }

  /** Expected queue wait of a new analysis of `priority` on `e`: its report plus what was sent to it since. */
  private expectedWaitMs(e: Endpoint, priority: VisionPriority): number {
    const l = e.snap!;
    return l.estimatedWaitMs[priority] + (e.sentSinceSnap * l.serviceMs) / Math.max(1, l.workers);
  }

  private pick(priority: VisionPriority, exclude: Set<Endpoint>): Endpoint | null {
    const cands = this.active().filter((e) => !exclude.has(e));
    if (!cands.length) return null;
    const start = this.rr++ % cands.length; // equal waits (e.g. all idle) take turns
    let best: Endpoint | null = null;
    let bestWait = Infinity;
    for (let i = 0; i < cands.length; i++) {
      const e = cands[(start + i) % cands.length];
      const w = this.expectedWaitMs(e, priority);
      if (w < bestWait) {
        best = e;
        bestWait = w;
      }
    }
    return best;
  }

  /* ------------------------------------------------------------------------------- transport */

  private send(e: Endpoint, method: 'GET' | 'POST', path: string, body: Buffer | null, headers: Record<string, string>, timeoutMs: number): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const o = e.origin;
      const tls = o.protocol === 'https:';
      let connected = false;
      let responded = false;
      let settled = false;
      let connectTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => req.destroy(Object.assign(new Error(`no answer within ${timeoutMs} ms`), { code: 'SP_TIMEOUT' })), timeoutMs);
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(connectTimer);
        fn();
      };
      const fail = (err: Error & { code?: string }) => done(() => reject(this.classify(err, connected, responded, req.reusedSocket)));
      const req = (tls ? https : http).request(
        {
          host: o.address,
          port: o.port,
          method,
          path: o.basePath + path,
          agent: tls ? this.httpsAgent : this.httpAgent,
          ...(tls && isIP(o.hostname) === 0 ? { servername: o.hostname } : {}),
          headers: {
            host: o.hostHeader,
            authorization: `Bearer ${this.o.token}`,
            accept: 'application/json',
            ...(body ? { 'content-type': 'image/jpeg', 'content-length': String(body.length) } : {}),
            ...headers,
          },
        },
        (res) => {
          responded = true;
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_RESPONSE_BYTES) req.destroy(Object.assign(new Error('answer too large'), { code: 'SP_TOO_LARGE' }));
            else chunks.push(c);
          });
          res.on('end', () => done(() => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') })));
          res.on('error', fail);
          res.on('close', () => {
            if (!res.complete) fail(Object.assign(new Error('answer cut off'), { code: 'ECONNRESET' }));
          });
        },
      );
      req.on('socket', (sock) => {
        if (!sock.connecting) {
          connected = true; // a kept-alive socket
          return;
        }
        connectTimer = setTimeout(() => req.destroy(Object.assign(new Error(`no connection within ${this.connectTimeoutMs} ms`), { code: 'SP_CONNECT_TIMEOUT' })), this.connectTimeoutMs);
        sock.once(tls ? 'secureConnect' : 'connect', () => {
          connected = true;
          clearTimeout(connectTimer);
        });
      });
      req.on('error', fail);
      req.end(body ?? undefined);
    });
  }

  private classify(err: Error & { code?: string }, connected: boolean, responded: boolean, reusedSocket: boolean): TransportError {
    const code = err.code ?? '';
    const msg = `${code ? `${code}: ` : ''}${err.message}`;
    if (!connected) return new TransportError('connect', false, msg); // never reached the worker
    if (reusedSocket && !responded && (STALE_SOCKET_CODES.has(code) || /socket hang up/i.test(err.message))) return new TransportError('reset', false, msg); // closed keep-alive socket
    if (code === 'SP_TIMEOUT') return new TransportError('timeout', true, msg);
    if (code === 'SP_TOO_LARGE') return new TransportError('bad_response', true, msg);
    return new TransportError('reset', true, msg);
  }

  /* ------------------------------------------------------------------------------- analysis */

  private observe(fn: (o: VisionObserver) => void): void {
    try {
      if (this.o.observer) fn(this.o.observer);
    } catch {
      /* metrics must never break analysis */
    }
  }

  /**
   * Send one image to the best worker; on an answer that means "not taken" try one other worker. Returns the decoded
   * answer; throws VisionBusyError / VisionInputError / the worker's analysis error like the local pool.
   */
  private async dispatch<T>(priority: VisionPriority, path: string, image: Buffer, headers: Record<string, string>, decode: (body: Record<string, unknown>) => T, measureOverhead: boolean): Promise<T> {
    if (this.closed) throw new VisionClosedError();
    const tried = new Set<Endpoint>();
    let busyAfterSec: number | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (this.closed) throw new VisionClosedError();
      const e = this.pick(priority, tried);
      if (!e) break;
      tried.add(e);
      e.sentSinceSnap++;
      e.inFlight++;
      this.inFlight++;
      const t0 = performance.now();
      let res: RawResponse;
      try {
        res = await this.send(e, 'POST', path, image, headers, this.timeoutMs);
      } catch (err) {
        const t = err as TransportError;
        if (t.reason === 'reset' && !t.accepted) {
          tried.delete(e); // a stale keep-alive socket: the worker is fine, retry (on a fresh connection)
          continue;
        }
        this.failed(e, t.reason, t.message, t.reason !== 'timeout');
        if (!t.accepted) continue;
        // Taken but not answered in time (closing the connection made the worker drop it if still queued): like a full
        // local queue, the client comes back later.
        this.observe((o) => o.analysisRefused(priority));
        throw new VisionBusyError(t.reason === 'timeout' ? retryAfterSecFor(this.expectedWaitMs(e, priority)) : FAILED_REQUEST_RETRY_AFTER_SEC);
      } finally {
        e.inFlight--;
        this.inFlight--;
      }
      const elapsedMs = performance.now() - t0;

      if (res.status === 200) {
        let out: T;
        let timings: WireTiming[];
        try {
          const body = parse(res.text) as Record<string, unknown>;
          timings = decodeTimings(body.timings);
          out = decode(body);
          this.report(e, decodeLoad(body.load), typeof body.instanceId === 'string' ? body.instanceId : null);
        } catch (err) {
          this.failed(e, 'bad_response', (err as Error).message);
          throw err instanceof VisionWireError ? err : new VisionWireError((err as Error).message);
        }
        this.observe((o) => {
          for (const t of timings) o.analysisEnded({ priority, waitMs: t.waitMs, runMs: t.runMs, ok: true });
          if (measureOverhead) o.remoteRequestEnded?.({ overheadMs: Math.max(0, elapsedMs - timings.reduce((s, t) => s + t.waitMs + t.runMs, 0)) });
        });
        return out;
      }

      const body = tryParse(res.text);
      if (body?.load) {
        try {
          const load = decodeLoad(body.load);
          e.snap = load;
          e.snapAt = Date.now();
          e.sentSinceSnap = 0;
        } catch {
          /* keep the last report */
        }
      }
      if (res.status === 503 && body?.error === 'vision_busy') {
        // Its queue is full: nothing was taken. Another worker may have room; else the shortest Retry-After.
        const after = parseRetryAfter(res, body);
        busyAfterSec = busyAfterSec == null ? after : Math.min(busyAfterSec, after);
        continue;
      }
      if (res.status === 503 && body?.error === 'vision_unavailable') {
        e.state = 'unready'; // no analysis thread ready / shutting down: polls bring it back
        e.lastError = body.message;
        continue;
      }
      if (res.status === 401) {
        this.failed(e, 'unauthorized', 'the worker rejected VISION_WORKER_TOKEN');
        continue;
      }
      if (res.status === 502 || res.status === 503) {
        // A proxy in front of the worker, or a worker closing: not taken.
        this.failed(e, 'server_error', `HTTP ${res.status}`);
        continue;
      }
      if (res.status === 400 || res.status === 413 || res.status === 415) throw new VisionInputError(body?.message ?? 'Unsupported or corrupt image');
      if (res.status === 500 && body?.error === 'analysis_failed') {
        this.observe((o) => o.analysisEnded({ priority, waitMs: 0, runMs: Math.round(elapsedMs), ok: false }));
        const err = new Error(body.message) as Error & { code?: string };
        err.name = body.name ?? 'Error';
        throw err;
      }
      this.failed(e, 'server_error', `HTTP ${res.status}`);
      this.observe((o) => o.analysisRefused(priority));
      throw new VisionBusyError(FAILED_REQUEST_RETRY_AFTER_SEC);
    }
    this.observe((o) => o.analysisRefused(priority));
    throw new VisionBusyError(busyAfterSec ?? NO_WORKER_RETRY_AFTER_SEC);
  }

  async analyze(image: Buffer, opts: AnalyzeOptions = {}): Promise<ImageAnalysis> {
    return this.dispatch(opts.priority ?? 'interactive', '/v1/analyze', image, { [OPTIONS_HEADER]: encodeOptions(opts) }, (b) => decodeAnalysis(b.analysis), true);
  }

  /** One request: the worker analyses the photo and its perturbed copies (template stability) itself. */
  processIdPhoto(image: Buffer): Promise<IdPhotoResult> {
    return this.dispatch('interactive', '/v1/id-photo', image, {}, (b) => decodeIdPhotoResult(b.result), false);
  }

  /* ------------------------------------------------------------------------------- state */

  /** The fleet in use, as one queue (VisionService.load): 0 workers when none is ready. */
  get load(): VisionLoad {
    const act = this.active();
    if (!act.length) return { workers: 0, inFlight: 0, queued: zero(), oldestWaitMs: zero(), serviceMs: this.lastServiceMs, estimatedWaitMs: zero(), maxQueue: 0 };
    const now = Date.now();
    const queued = zero();
    const oldest = zero();
    const estimate = { interactive: Infinity, background: Infinity };
    let workers = 0;
    let inFlight = 0;
    let serviceSum = 0;
    let maxQueue = 0;
    for (const e of act) {
      const l = e.snap!;
      workers += l.workers;
      inFlight += l.inFlight;
      serviceSum += l.serviceMs * l.workers;
      maxQueue += l.maxQueue;
      for (const p of PRIORITIES) {
        queued[p] += l.queued[p];
        oldest[p] = Math.max(oldest[p], l.queued[p] > 0 ? l.oldestWaitMs[p] + (now - e.snapAt) : 0);
        estimate[p] = Math.min(estimate[p], Math.round(this.expectedWaitMs(e, p)));
      }
    }
    return {
      workers,
      inFlight,
      queued,
      oldestWaitMs: oldest,
      serviceMs: Math.round((serviceSum / Math.max(1, workers)) * 10) / 10,
      estimatedWaitMs: estimate,
      maxQueue,
    };
  }

  /** Every worker address and its state (health, metrics, logs). */
  workerInfo(): RemoteWorkerInfo[] {
    const used = new Set(this.active());
    const ids = new Set<string>();
    for (const e of used) if (e.instanceId) ids.add(e.instanceId);
    return [...this.endpoints()].map((e) => ({
      key: e.key,
      source: e.source,
      state: e.state,
      instanceId: e.instanceId,
      duplicate: e.state === 'up' && !used.has(e) && e.instanceId != null && ids.has(e.instanceId),
      workers: e.snap?.workers ?? 0,
      lastError: e.lastError,
    }));
  }

  /** Worker processes per state (duplicates of one process counted once). */
  workerStates(): Record<RemoteWorkerState, number> {
    const out: Record<RemoteWorkerState, number> = { unknown: 0, up: 0, unready: 0, down: 0 };
    for (const w of this.workerInfo()) if (!w.duplicate) out[w.state]++;
    return out;
  }

  /** Analyses waiting for a worker's answer. */
  get pending(): number {
    return this.inFlight;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    // Answers in progress are awaited (bounded), like the local pool lets in-flight analyses finish.
    const deadline = Date.now() + 10_000;
    while (this.inFlight > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }
}

export function createRemoteVisionService(o: RemoteVisionOptions): Promise<RemoteVisionService> {
  return RemoteVisionService.create(o);
}

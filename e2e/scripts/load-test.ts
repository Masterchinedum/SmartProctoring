/**
 * API-level load test: N simulated candidates go through check-in (real JPEG frames → server-side
 * YuNet/SFace) and then run a monitored exam — heartbeats every 5 s, identity samples, proctoring events and
 * answer saves — while we record per-endpoint latency and errors.
 *
 * Usage (server must be running; the staff account must exist):
 *   BASE=http://127.0.0.1:8099 STAFF_EMAIL=... STAFF_PASSWORD=... N=200 DURATION_SEC=360 RAMP_SEC=60 \
 *   FACES_DIR=/path/to/face/jpegs  tsx scripts/load-test.ts
 *
 * FACES_DIR must contain face JPEGs (one per simulated person is ideal; they are reused round-robin).
 * Prints a latency table (whole run, the start-up phase and the steady phase) and writes JSON to OUT
 * (default ./load-report.json).
 *
 * CADENCE (default v2) — how each simulated candidate samples its identity, as the web client does
 * (apps/web/src/candidate/monitoring/runtime.ts + sampler.ts, check/adaptive.ts):
 *   v2: check-in sends frontal frames (≥ 300 ms apart) while the server's `progress.frontalNeeded > 0`
 *       (at least frontalFramesRequired, at most maxFrontalFrames) and completes when `progress.canComplete`;
 *       identity samples are bursts of BURST (3) frames sent concurrently (burstId / burstIndex / burstSize):
 *       one at once at exam start (trigger exam_start), then every STARTUP_SEC (6 s) during the first
 *       STARTUP_WINDOW_SEC (180 s), then every SAMPLE_SEC (15 s) — or after the answer's `nextSampleInMs`
 *       when the server sets it (e.g. 2.5 s while the evidence is inconclusive; trigger server_request then).
 *       A heartbeat's `identitySample` request starts a burst at once, like the client.
 *   v1: the identity-v1 client: frontalFramesRequired frames at check-in, then one-frame samples every
 *       SAMPLE_SEC (default 30 s), no start-up window, server cadence ignored (to compare per-frame cost).
 * The exam policy is created to match (liveness and ID-photo comparison off in both).
 *
 * 503 "server busy" answers are retried after Retry-After (BUSY_RETRIES, default 3), as the web client does.
 * Optional: STAFF_WS=<n> keeps n staff dashboards connected to /api/admin/live during the run (realtime
 * summaries are only built while someone listens); SAMPLE_SEC=<s> changes the routine identity-sample interval
 * (CADENCE=v1 SAMPLE_SEC=1 with enough candidates saturates the vision pool: see "identity samples/s").
 * docs/PERFORMANCE.md describes the method and the reference results.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8099';
const N = Number(process.env.N ?? 100);
const DURATION_SEC = Number(process.env.DURATION_SEC ?? 120);
const RAMP_SEC = Number(process.env.RAMP_SEC ?? 45);
const CADENCE: 'v1' | 'v2' = (process.env.CADENCE ?? 'v2').toLowerCase() === 'v1' ? 'v1' : 'v2';
const V2 = CADENCE === 'v2';
const HEARTBEAT_SEC = 5;
/** Routine identity-sample interval (v2: policy.identity.periodicCheckIntervalSec after the start-up window). */
const SAMPLE_SEC = Number(process.env.SAMPLE_SEC ?? (V2 ? 15 : 30));
/** v2 start-up cadence (policy.identity.startupIntervalSec / startupWindowSec) and burst size (burstSize). */
const STARTUP_SEC = Number(process.env.STARTUP_SEC ?? 6);
const STARTUP_WINDOW_SEC = Number(process.env.STARTUP_WINDOW_SEC ?? 180);
const BURST = Math.max(1, Math.min(5, Number(process.env.BURST ?? 3)));
/** v2 check-in: frontal frames are captured at least this far apart (VerifyStep MIN_CAPTURE_SPACING_MS). */
const CHECK_FRAME_SPACING_MS = 300;
/** v2 burst frames are camera frames this far apart (the runtime analyses ~5 frames/s; sampler.ts). */
const BURST_FRAME_SPACING_MS = 200;
const EVENT_SEC = 20;
const ANSWER_SEC = 25;
const FACES_DIR = process.env.FACES_DIR ?? '/tmp/claude-0/faces/deepface';
const OUT = process.env.OUT ?? 'load-report.json';
const STAFF_WS = Number(process.env.STAFF_WS ?? 0);
/** 503 vision_busy responses are retried after Retry-After up to this many times (the web client retries too). */
const BUSY_RETRIES = Number(process.env.BUSY_RETRIES ?? 3);
const busyRetries = new Map<string, number>();
/** The steady phase starts this long after the ramp (v1) / after the last start-up window (v2). */
const STEADY_AFTER_RAMP_MS = 15_000;

type Stat = { lat: number[]; at: number[]; okAt: boolean[]; errors: Record<string, number>; ok: number };
const stats = new Map<string, Stat>();
function record(label: string, ms: number, status: number | string) {
  let s = stats.get(label);
  if (!s) stats.set(label, (s = { lat: [], at: [], okAt: [], errors: {}, ok: 0 }));
  const ok = typeof status === 'number' && status < 400;
  s.lat.push(ms);
  s.at.push(Date.now());
  s.okAt.push(ok);
  if (ok) s.ok++;
  else s.errors[String(status)] = (s.errors[String(status)] ?? 0) + 1;
}
const checkInFailures = new Map<string, number>();
const failCheckIn = (why: string) => checkInFailures.set(why, (checkInFailures.get(why) ?? 0) + 1);
const checkInFrames: number[] = [];
/** v2: the interval to the next routine burst — by the server's nextSampleInMs, or the client's own schedule. */
const cadence = { server: 0, serverShortened: 0, fallback: 0, heartbeatRequests: 0, holds: 0, intervalsMs: [] as number[] };
const pct = (a: number[], p: number) => (a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : NaN);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function staffLogin(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email: process.env.STAFF_EMAIL ?? 'admin@example.com', password: process.env.STAFF_PASSWORD ?? 'ChangeMe123!' }),
  });
  if (!res.ok) throw new Error(`staff login ${res.status} ${await res.text()}`);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

async function staff<T>(cookie: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, origin: BASE, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** A few noisy JPEG variants per face so consecutive identity samples are never byte-identical. */
async function prepareFaces(): Promise<Buffer[][]> {
  const files = readdirSync(FACES_DIR).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
  if (!files.length) throw new Error(`no images in ${FACES_DIR}`);
  const out: Buffer[][] = [];
  for (const f of files.slice(0, 60)) {
    const { data, info } = await sharp(join(FACES_DIR, f)).rotate().resize(640, 480, { fit: 'contain', background: { r: 110, g: 110, b: 110 } }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const variants: Buffer[] = [];
    for (let v = 0; v < 4; v++) {
      const noisy = Buffer.from(data);
      for (let i = 0; i < noisy.length; i += 7) noisy[i] = Math.max(0, Math.min(255, noisy[i] + ((v * 13 + i) % 9) - 4));
      variants.push(await sharp(noisy, { raw: { width: info.width, height: info.height, channels: 3 } }).jpeg({ quality: 80 }).toBuffer());
    }
    out.push(variants);
  }
  return out;
}

class Candidate {
  instance = randomUUID();
  seq = 0;
  answerSeq = 0;
  frame = 0;
  stopped = false;
  status = 'invited';
  questionIds: string[] = [];
  /** When /start answered (the start-up window runs from here). */
  startedAt = 0;
  /** v2 sampler state: a burst is on its way; a server request (heartbeat identitySample) is waiting. */
  private bursting = false;
  private examStartTaken = false;
  private serverRequest: string | null = null;
  private wake: (() => void) | null = null;
  constructor(
    readonly token: string,
    readonly frames: Buffer[],
  ) {}

  async call(label: string, method: string, path: string, opts: { json?: unknown; jpeg?: Buffer; query?: Record<string, string | number> } = {}): Promise<any> {
    const qs = opts.query ? '?' + new URLSearchParams(Object.entries(opts.query).map(([k, v]) => [k, String(v)])) : '';
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, 'x-client-instance': this.instance };
    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.jpeg) {
      headers['content-type'] = 'image/jpeg';
      body = new Uint8Array(opts.jpeg);
    }
    const t0 = performance.now();
    try {
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(`${BASE}/api/candidate${path}${qs}`, { method, headers, body });
        const text = await res.text();
        // Like the web client: "server busy" (503 + Retry-After) is retried with the same payload. The latency
        // recorded is what the candidate experiences (first send to final answer); retries are counted apart.
        if (res.status === 503 && attempt < BUSY_RETRIES) {
          busyRetries.set(label, (busyRetries.get(label) ?? 0) + 1);
          await sleep(1000 * (Number(res.headers.get('retry-after')) || 2));
          continue;
        }
        record(label, performance.now() - t0, res.status);
        if (!res.ok) return { __error: res.status, text };
        return text ? JSON.parse(text) : {};
      }
    } catch (e) {
      record(label, performance.now() - t0, (e as Error).name);
      return { __error: (e as Error).name };
    }
  }

  nextFrame(): Buffer {
    return this.frames[this.frame++ % this.frames.length];
  }

  async checkIn(): Promise<boolean> {
    const st = await this.call('GET session', 'GET', '/session');
    if (st.__error) return (failCheckIn(`session ${st.__error}`), false);
    await this.call('POST consent', 'POST', '/consent', { json: { noticeVersion: st.consent.notice.version, accepted: true } });
    const chk = await this.call('POST checks', 'POST', '/checks', {
      json: { purpose: 'initial', clientInstanceId: this.instance, device: { cameraLabel: 'Load Test Camera', cameraIdHash: 'f'.repeat(64), userAgent: 'load-test', screen: { width: 1920, height: 1080, isExtended: false } } },
    });
    if (chk.__error) return (failCheckIn(`start check ${chk.__error}`), false);
    const frame = () => this.call('POST check frame', 'POST', `/checks/${chk.checkId}/frames`, { jpeg: this.nextFrame(), query: { step: 'frontal', capturedAt: Date.now() } });
    let sent = 0;
    if (V2) {
      // Adaptive collection (check/adaptive.ts): the minimum first, then more while the server wants more.
      const required = Math.max(1, chk.frontalFramesRequired ?? 5);
      const max = Math.max(required, chk.maxFrontalFrames ?? 10);
      let progress: { frontalNeeded: number; canComplete: boolean } | null = null;
      while (sent < max) {
        if (progress?.canComplete) break;
        if (sent >= required && (!progress || progress.frontalNeeded <= 0)) break;
        const t = Date.now();
        sent++;
        const r = await frame();
        if (r.__error === 429) break; // the server has enough frames: complete with what it has
        if (r.progress) progress = r.progress;
        await sleep(Math.max(0, CHECK_FRAME_SPACING_MS - (Date.now() - t)));
      }
    } else {
      for (; sent < Math.max(3, chk.frontalFramesRequired ?? 3); sent++) await frame();
    }
    checkInFrames.push(sent);
    const done = await this.call('POST check complete', 'POST', `/checks/${chk.checkId}/complete`);
    if (done.outcome !== 'passed') return (failCheckIn(done.__error ? `complete ${done.__error}` : `${done.outcome}: ${String(done.message ?? '').slice(0, 70)}`), false);
    const started = await this.call('POST start', 'POST', '/start');
    if (started.__error) return (failCheckIn(`start ${started.__error}`), false);
    this.status = 'active';
    this.startedAt = Date.now();
    this.questionIds = (started.questions ?? []).map((q: { id: string }) => q.id);
    return true;
  }

  async run(until: number): Promise<void> {
    const loops = [
      this.every(HEARTBEAT_SEC, async () => {
        const hb = await this.call('POST heartbeat', 'POST', '/heartbeat', {
          json: { clientInstanceId: this.instance, clientTime: Date.now(), seq: this.seq++, monitoring: { state: 'ok', faces: 1, label: 'Candidate in view', open: [] }, outboxSize: 0, outboxOldestAt: null, visibility: 'visible', fullscreen: true },
        });
        if (V2) this.onServerSampleRequest(hb?.identitySample);
      }),
      V2
        ? this.sampleLoopV2()
        : this.every(SAMPLE_SEC, () => this.call('POST identity sample', 'POST', '/identity/sample', { jpeg: this.nextFrame(), query: { sampleId: randomUUID(), trigger: 'periodic', capturedAt: Date.now() } })),
      this.every(EVENT_SEC, async () => {
        const id = randomUUID();
        const t = Date.now();
        await this.call('POST events', 'POST', '/events/batch', {
          json: { events: [{ id, type: 'looking_away', phase: 'close', startedAt: t - 6000, endedAt: t, confidence: 0.8, details: { direction: 'left' }, version: 1 }] },
        });
      }),
      this.every(ANSWER_SEC, async () => {
        if (!this.questionIds.length) return;
        const q = this.questionIds[this.answerSeq % this.questionIds.length];
        await this.call('PUT answer', 'PUT', `/answers/${q}`, { json: { value: `answer ${this.answerSeq}`, clientSeq: ++this.answerSeq, answeredAt: Date.now() } });
      }),
    ];
    await this.sleepInterruptible(Math.max(0, until - Date.now()), false);
    this.stopped = true;
    this.wake?.();
    await Promise.all(loops);
  }

  /** HeartbeatResponse.identitySample (sampler.ts serverRequest): exam_start once; others unless a burst is on its way. */
  private onServerSampleRequest(req: { trigger: string; inMs: number } | null | undefined): void {
    if (!req || this.stopped) return;
    if (req.trigger === 'exam_start' && this.examStartTaken) return;
    if (this.bursting || this.serverRequest) return;
    cadence.heartbeatRequests++;
    const fire = () => {
      this.serverRequest = req.trigger;
      this.wake?.();
    };
    if (req.inMs > 0) setTimeout(fire, req.inMs);
    else fire();
  }

  /**
   * Identity v2 cadence (runtime.ts routineCadence): exam_start burst at once; then the next burst after the final
   * answer's nextSampleInMs, or — without it — the start-up / periodic interval. Labelled server_request while the
   * server wants a faster look.
   */
  private async sampleLoopV2(): Promise<void> {
    let trigger = 'exam_start';
    let dueAt = Date.now();
    while (!this.stopped) {
      if (!this.serverRequest) await this.sleepInterruptible(dueAt - Date.now(), true);
      if (this.stopped) break;
      if (this.serverRequest) {
        trigger = this.serverRequest;
        this.serverRequest = null;
      }
      if (trigger === 'exam_start') this.examStartTaken = true;
      const res = await this.burst(trigger);
      const now = Date.now();
      if (res && (res.status === 'on_hold' || res.hold)) {
        cadence.holds++;
        return; // the exam is on hold: the client stops sampling until staff release it
      }
      const inStartup = now - this.startedAt < STARTUP_WINDOW_SEC * 1000;
      let inMs = (inStartup ? STARTUP_SEC : SAMPLE_SEC) * 1000;
      let label = 'periodic';
      if (res && res.nextSampleInMs != null && Number.isFinite(res.nextSampleInMs)) {
        cadence.server++;
        if (res.nextSampleInMs < inMs) cadence.serverShortened++;
        inMs = Math.max(0, res.nextSampleInMs);
      } else {
        cadence.fallback++;
        if (res?.followUpInMs != null) inMs = Math.max(0, res.followUpInMs);
      }
      const state = res?.evidence?.state;
      if (res && (res.followUpInMs != null || state === 'suspect' || state === 'monitoring' || state === 'confirmed_mismatch')) label = 'server_request';
      cadence.intervalsMs.push(inMs);
      trigger = label;
      dueAt = now + inMs;
    }
  }

  /** One burst: BURST camera frames ~200 ms apart, sent concurrently; returns the deciding answer. */
  private async burst(trigger: string): Promise<any> {
    this.bursting = true;
    try {
      const burstId = randomUUID();
      const t = Date.now();
      const t0 = performance.now();
      const answers = await Promise.all(
        Array.from({ length: BURST }, (_, i) =>
          this.call('POST identity sample', 'POST', '/identity/sample', {
            jpeg: this.nextFrame(),
            query: { sampleId: randomUUID(), trigger, capturedAt: t - (BURST - 1 - i) * BURST_FRAME_SPACING_MS, ...(BURST > 1 ? { burstId, burstIndex: i, burstSize: BURST } : {}) },
          }),
        ),
      );
      const failed = answers.find((a) => a?.__error);
      record('identity burst', performance.now() - t0, failed ? failed.__error : 200);
      const held = answers.find((a) => !a?.__error && (a.status === 'on_hold' || a.hold));
      if (held) return held;
      return answers.find((a) => !a?.__error && a.burst?.complete === true) ?? [...answers].reverse().find((a) => !a?.__error) ?? null;
    } finally {
      this.bursting = false;
    }
  }

  private sleepInterruptible(ms: number, wakeable: boolean): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, Math.max(0, ms));
      const self = this;
      function done() {
        clearTimeout(timer);
        if (wakeable && self.wake === done) self.wake = null;
        resolve();
      }
      if (wakeable) this.wake = done;
    });
  }

  private async every(sec: number, fn: () => Promise<unknown>): Promise<void> {
    await sleep(Math.random() * sec * 1000);
    while (!this.stopped) {
      const t0 = Date.now();
      await fn();
      await sleep(Math.max(0, sec * 1000 - (Date.now() - t0)));
    }
  }
}

async function main() {
  console.log(
    `load test: N=${N} ramp=${RAMP_SEC}s steady=${DURATION_SEC}s cadence=${CADENCE} ` +
      (V2 ? `(bursts of ${BURST}, every ${STARTUP_SEC}s for ${STARTUP_WINDOW_SEC}s, then ${SAMPLE_SEC}s)` : `(1 frame every ${SAMPLE_SEC}s)`) +
      ` base=${BASE}`,
  );
  const faces = await prepareFaces();
  const cookie = await staffLogin();
  const identity = V2
    ? { liveness: 'off', idPhotoComparison: 'off', periodicCheckIntervalSec: Math.max(5, SAMPLE_SEC), startupIntervalSec: STARTUP_SEC, startupWindowSec: STARTUP_WINDOW_SEC, burstSize: BURST }
    : { liveness: 'off', idPhotoComparison: 'off', periodicCheckIntervalSec: Math.max(10, SAMPLE_SEC), startupWindowSec: 0, burstSize: 1 };
  const exam = await staff<{ id: string }>(cookie, 'POST', '/api/admin/exams', {
    title: `Load test ${new Date().toISOString()}`,
    durationSec: 3 * 3600,
    policy: { identity, browser: { requireFullscreen: false } },
    questions: [
      { type: 'short_text', prompt: 'Q1', options: [], correct: ['a'], points: 1 },
      { type: 'long_text', prompt: 'Q2', options: [], correct: [], points: 1 },
    ],
  });
  await staff(cookie, 'POST', `/api/admin/exams/${exam.id}/publish`);
  const ids: string[] = [];
  for (let i = 0; i < N; i++) ids.push((await staff<{ id: string }>(cookie, 'POST', '/api/admin/candidates', { name: `Load Candidate ${i + 1}` })).id);
  const links: string[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const r = await staff<{ items: { accessLink: string }[] }>(cookie, 'POST', `/api/admin/exams/${exam.id}/assignments`, { candidateIds: ids.slice(i, i + 200) });
    links.push(...r.items.map((a) => a.accessLink));
  }
  const cands = links.map((l, i) => new Candidate(l.split('/take/')[1], faces[i % faces.length]));

  // Staff dashboards: realtime messages are only built while someone listens.
  const wsCounts: Record<string, number> = {};
  const sockets: WebSocket[] = [];
  for (let i = 0; i < STAFF_WS; i++) {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/admin/live`, { headers: { cookie, origin: BASE } } as unknown as string[]);
    ws.onmessage = (e) => {
      const type = (JSON.parse(String(e.data)) as { type: string }).type;
      wsCounts[type] = (wsCounts[type] ?? 0) + 1;
    };
    sockets.push(ws);
  }

  const t0 = Date.now();
  const endAt = t0 + (RAMP_SEC + DURATION_SEC) * 1000;
  let checkedIn = 0;
  let failedCheckIn = 0;
  // Load average of the box (server, Postgres and this generator share it), sampled every 5 s.
  const loadSamples: { at: number; load1: number }[] = [];
  const sampleLoad = () => loadSamples.push({ at: Date.now(), load1: loadavg()[0] });
  const loadTimer = setInterval(sampleLoad, 5_000);
  const runs = cands.map(async (c, i) => {
    await sleep((i / Math.max(1, cands.length)) * RAMP_SEC * 1000);
    if (await c.checkIn()) {
      checkedIn++;
      await c.run(endAt);
    } else failedCheckIn++;
  });
  const progress = setInterval(() => console.log(`t+${Math.round((Date.now() - t0) / 1000)}s  checked-in ${checkedIn}/${N}  failed ${failedCheckIn}  load ${loadavg()[0].toFixed(2)}`), 15_000);
  await Promise.all(runs);
  clearInterval(progress);
  clearInterval(loadTimer);
  sampleLoad();
  for (const ws of sockets) ws.close();

  // Phases. v1: steady = from ramp end + 15 s. v2: start-up = while every candidate is in its start-up window
  // (last start → first start + window); steady = every candidate at the periodic interval (last start + window + 15 s).
  const starts = cands.map((c) => c.startedAt).filter((t) => t > 0);
  const firstStart = starts.length ? Math.min(...starts) : t0;
  const lastStart = starts.length ? Math.max(...starts) : t0 + RAMP_SEC * 1000;
  let steadyFrom = t0 + RAMP_SEC * 1000 + STEADY_AFTER_RAMP_MS;
  let startup: { from: number; to: number } | null = null;
  if (V2 && STARTUP_WINDOW_SEC > 0) {
    const to = firstStart + STARTUP_WINDOW_SEC * 1000;
    if (to - lastStart > 10_000) startup = { from: lastStart, to };
    const v2Steady = lastStart + STARTUP_WINDOW_SEC * 1000 + STEADY_AFTER_RAMP_MS;
    if (endAt - v2Steady >= 30_000) steadyFrom = v2Steady;
    else console.log(`\n(!) DURATION_SEC too short for a steady phase after the start-up windows (needs ≥ ${Math.ceil((v2Steady - t0) / 1000 - RAMP_SEC + 30)} s): steady = from ramp + 15 s`);
  }
  const steadySec = Math.max(1, (endAt - steadyFrom) / 1000);
  const table = (from: number, to: number, secs: number | null) =>
    [...stats.entries()]
      .map(([label, s]) => {
        const lat = s.lat.filter((_, i) => s.at[i] >= from && s.at[i] < to).sort((a, b) => a - b);
        const n = lat.length;
        return { label, n, perSec: secs ? Math.round((n / secs) * 10) / 10 : null, p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: lat[n - 1] ?? NaN };
      })
      .filter((r) => r.n > 0);
  /** Successful answers per second (a 503 / error was not analysed) of the given labels, within [from, to). */
  const okRate = (labels: string[], from: number, to: number) => {
    let n = 0;
    for (const l of labels) {
      const s = stats.get(l);
      if (s) for (let i = 0; i < s.at.length; i++) if (s.okAt[i] && s.at[i] >= from && s.at[i] < to) n++;
    }
    return Math.round((n / Math.max(1, (to - from) / 1000)) * 10) / 10;
  };
  const loadIn = (from: number, to: number) => {
    const v = loadSamples.filter((x) => x.at >= from && x.at < to).map((x) => x.load1);
    return v.length ? { mean: Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100, max: Math.round(Math.max(...v) * 100) / 100 } : null;
  };
  const phaseRates = (from: number, to: number) => ({
    identitySamples: V2 ? okRate(['identity burst'], from, to) : okRate(['POST identity sample'], from, to),
    burstFrames: okRate(['POST identity sample'], from, to),
    analysedFrames: okRate(['POST identity sample', 'POST check frame'], from, to),
    load: loadIn(from, to),
  });
  const rows = [...stats.entries()].map(([label, s]) => {
    const lat = [...s.lat].sort((a, b) => a - b);
    return { label, n: lat.length, ok: s.ok, errors: s.errors, p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: lat[lat.length - 1] };
  });
  const steady = table(steadyFrom, endAt, steadySec);
  const startupRows = startup ? table(startup.from, startup.to, (startup.to - startup.from) / 1000) : null;
  const rates = { whole: phaseRates(t0, endAt), startup: startup ? phaseRates(startup.from, startup.to) : null, steady: phaseRates(steadyFrom, endAt) };
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  console.log('\nwhole run (ramp + steady)');
  console.log('endpoint                 count     ok   p50ms   p95ms   p99ms   maxms  errors');
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(22)} ${String(r.n).padStart(7)} ${String(r.ok).padStart(6)} ${r.p50.toFixed(0).padStart(7)} ${r.p95.toFixed(0).padStart(7)} ${r.p99.toFixed(0).padStart(7)} ${r.max.toFixed(0).padStart(7)}  ${JSON.stringify(r.errors)}`,
    );
  }
  const printPhase = (rs: ReturnType<typeof table>) => {
    console.log('endpoint                 count  req/s   p50ms   p95ms   p99ms   maxms');
    for (const r of rs) {
      console.log(`${r.label.padEnd(22)} ${String(r.n).padStart(7)} ${String(r.perSec).padStart(6)} ${r.p50.toFixed(0).padStart(7)} ${r.p95.toFixed(0).padStart(7)} ${r.p99.toFixed(0).padStart(7)} ${r.max.toFixed(0).padStart(7)}`);
    }
  };
  const rel = (t: number) => ((t - t0) / 1000).toFixed(0);
  if (startup && startupRows) {
    console.log(`\nstart-up phase (every candidate in its ${STARTUP_WINDOW_SEC} s start-up window: t+${rel(startup.from)}…${rel(startup.to)} s)`);
    printPhase(startupRows);
  }
  console.log(`\nsteady phase (from t+${rel(steadyFrom)} s, ${steadySec.toFixed(0)} s)`);
  printPhase(steady);
  console.log(`\nchecked in ${checkedIn}/${N}, failed ${failedCheckIn}${checkInFailures.size ? ` ${JSON.stringify(Object.fromEntries(checkInFailures))}` : ''}`);
  if (checkInFrames.length) {
    const f = [...checkInFrames].sort((a, b) => a - b);
    console.log(`check-in frames per attempt: mean ${(f.reduce((a, b) => a + b, 0) / f.length).toFixed(1)}, p50 ${pct(f, 50)}, max ${f[f.length - 1]}`);
  }
  const fmtLoad = (l: { mean: number; max: number } | null) => (l ? `${l.mean} (max ${l.max})` : '—');
  for (const [name, r] of [['start-up', rates.startup], ['steady', rates.steady]] as const) {
    if (!r) continue;
    console.log(`identity samples/s (${name}): ${r.identitySamples}${V2 ? ' bursts' : ''}`);
    console.log(`burst frames/s (${name}): ${r.burstFrames}`);
    console.log(`analysed frames/s (${name}): ${r.analysedFrames}`);
    console.log(`load average 1 min (${name}): ${fmtLoad(r.load)}`);
  }
  console.log(`analysed frames/s (whole run): ${rates.whole.analysedFrames}; load average 1 min: ${fmtLoad(rates.whole.load)}`);
  if (V2) {
    const iv = [...cadence.intervalsMs].sort((a, b) => a - b);
    console.log(
      `v2 cadence: ${cadence.server} intervals from nextSampleInMs (${cadence.serverShortened} shorter than the client schedule), ${cadence.fallback} from the client schedule, ` +
        `interval p5 / p50 / p95 ${pct(iv, 5)} / ${pct(iv, 50)} / ${pct(iv, 95)} ms; ${cadence.heartbeatRequests} heartbeat sample requests; ${cadence.holds} holds`,
    );
  }
  if (busyRetries.size) console.log(`503 busy responses retried (as the web client does): ${JSON.stringify(Object.fromEntries(busyRetries))}`);
  if (STAFF_WS) console.log(`staff WebSocket messages: ${JSON.stringify(wsCounts)}`);
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        N,
        RAMP_SEC,
        DURATION_SEC,
        CADENCE,
        SAMPLE_SEC,
        ...(V2 ? { STARTUP_SEC, STARTUP_WINDOW_SEC, BURST } : {}),
        STAFF_WS,
        t0,
        phases: { startup, steadyFrom, endAt, firstStart, lastStart },
        checkedIn,
        failedCheckIn,
        checkInFailures: Object.fromEntries(checkInFailures),
        checkInFrames: { n: checkInFrames.length, mean: checkInFrames.length ? checkInFrames.reduce((a, b) => a + b, 0) / checkInFrames.length : null },
        busyRetries: Object.fromEntries(busyRetries),
        rates,
        cadence: { ...cadence, intervalsMs: undefined },
        rows,
        startupRows,
        steady,
        loadSamples,
        wsCounts,
        health,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

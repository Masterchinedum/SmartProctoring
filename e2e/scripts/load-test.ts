/**
 * API-level load test: N simulated candidates go through check-in (real JPEG frames → server-side
 * YuNet/SFace) and then run a monitored exam — heartbeats every 5 s, periodic identity samples, proctoring
 * events and answer saves — while we record per-endpoint latency and errors.
 *
 * Usage (server must be running; the staff account must exist):
 *   BASE=http://127.0.0.1:8099 STAFF_EMAIL=... STAFF_PASSWORD=... N=200 DURATION_SEC=180 RAMP_SEC=60 \
 *   FACES_DIR=/path/to/face/jpegs  tsx scripts/load-test.ts
 *
 * FACES_DIR must contain face JPEGs (one per simulated person is ideal; they are reused round-robin).
 * Prints a latency table (whole run, and the steady phase after the ramp) and writes JSON to OUT
 * (default ./load-report.json).
 *
 * 503 "server busy" answers are retried after Retry-After (BUSY_RETRIES, default 3), as the web client does.
 * Optional: STAFF_WS=<n> keeps n staff dashboards connected to /api/admin/live during the run (realtime
 * summaries are only built while someone listens); SAMPLE_SEC=<s> changes the identity-sample interval
 * (SAMPLE_SEC=1 with enough candidates saturates the vision pool: see "identity samples/s").
 * docs/PERFORMANCE.md describes the method and the reference results.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8099';
const N = Number(process.env.N ?? 100);
const DURATION_SEC = Number(process.env.DURATION_SEC ?? 120);
const RAMP_SEC = Number(process.env.RAMP_SEC ?? 45);
const HEARTBEAT_SEC = 5;
const SAMPLE_SEC = Number(process.env.SAMPLE_SEC ?? 30);
const EVENT_SEC = 20;
const ANSWER_SEC = 25;
const FACES_DIR = process.env.FACES_DIR ?? '/tmp/claude-0/faces/deepface';
const OUT = process.env.OUT ?? 'load-report.json';
const STAFF_WS = Number(process.env.STAFF_WS ?? 0);
/** 503 vision_busy responses are retried after Retry-After up to this many times (the web client retries too). */
const BUSY_RETRIES = Number(process.env.BUSY_RETRIES ?? 3);
const busyRetries = new Map<string, number>();
/** The steady phase starts this long after the ramp (the last check-ins settle). */
const STEADY_AFTER_RAMP_MS = 15_000;

type Stat = { lat: number[]; at: number[]; errors: Record<string, number>; ok: number };
const stats = new Map<string, Stat>();
function record(label: string, ms: number, status: number | string) {
  let s = stats.get(label);
  if (!s) stats.set(label, (s = { lat: [], at: [], errors: {}, ok: 0 }));
  s.lat.push(ms);
  s.at.push(Date.now());
  if (typeof status === 'number' && status < 400) s.ok++;
  else s.errors[String(status)] = (s.errors[String(status)] ?? 0) + 1;
}
const checkInFailures = new Map<string, number>();
const failCheckIn = (why: string) => checkInFailures.set(why, (checkInFailures.get(why) ?? 0) + 1);
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
    for (let i = 0; i < Math.max(3, chk.frontalFramesRequired ?? 3); i++) {
      await this.call('POST check frame', 'POST', `/checks/${chk.checkId}/frames`, { jpeg: this.nextFrame(), query: { step: 'frontal', capturedAt: Date.now() } });
    }
    const done = await this.call('POST check complete', 'POST', `/checks/${chk.checkId}/complete`);
    if (done.outcome !== 'passed') return (failCheckIn(done.__error ? `complete ${done.__error}` : `${done.outcome}: ${String(done.message ?? '').slice(0, 70)}`), false);
    const started = await this.call('POST start', 'POST', '/start');
    if (started.__error) return (failCheckIn(`start ${started.__error}`), false);
    this.status = 'active';
    this.questionIds = (started.questions ?? []).map((q: { id: string }) => q.id);
    return true;
  }

  async run(until: number): Promise<void> {
    const loops = [
      this.every(HEARTBEAT_SEC, () =>
        this.call('POST heartbeat', 'POST', '/heartbeat', {
          json: { clientInstanceId: this.instance, clientTime: Date.now(), seq: this.seq++, monitoring: { state: 'ok', faces: 1, label: 'Candidate in view', open: [] }, outboxSize: 0, outboxOldestAt: null, visibility: 'visible', fullscreen: true },
        }),
      ),
      this.every(SAMPLE_SEC, () => this.call('POST identity sample', 'POST', '/identity/sample', { jpeg: this.nextFrame(), query: { sampleId: randomUUID(), trigger: 'periodic', capturedAt: Date.now() } })),
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
    await sleep(Math.max(0, until - Date.now()));
    this.stopped = true;
    await Promise.all(loops);
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
  console.log(`load test: N=${N} ramp=${RAMP_SEC}s steady=${DURATION_SEC}s base=${BASE}`);
  const faces = await prepareFaces();
  const cookie = await staffLogin();
  const exam = await staff<{ id: string }>(cookie, 'POST', '/api/admin/exams', {
    title: `Load test ${new Date().toISOString()}`,
    durationSec: 3 * 3600,
    policy: { identity: { liveness: 'off', idPhotoComparison: 'off', periodicCheckIntervalSec: Math.max(10, SAMPLE_SEC) }, browser: { requireFullscreen: false } },
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
  const runs = cands.map(async (c, i) => {
    await sleep((i / Math.max(1, cands.length)) * RAMP_SEC * 1000);
    if (await c.checkIn()) {
      checkedIn++;
      await c.run(endAt);
    } else failedCheckIn++;
  });
  const progress = setInterval(() => console.log(`t+${Math.round((Date.now() - t0) / 1000)}s  checked-in ${checkedIn}/${N}  failed ${failedCheckIn}`), 15_000);
  await Promise.all(runs);
  clearInterval(progress);
  for (const ws of sockets) ws.close();

  const steadyFrom = t0 + RAMP_SEC * 1000 + STEADY_AFTER_RAMP_MS;
  const steadySec = Math.max(1, (endAt - steadyFrom) / 1000);
  const table = (from: number, secs: number | null) =>
    [...stats.entries()]
      .map(([label, s]) => {
        const lat = s.lat.filter((_, i) => s.at[i] >= from).sort((a, b) => a - b);
        const n = lat.length;
        return { label, n, perSec: secs ? Math.round((n / secs) * 10) / 10 : null, p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: lat[n - 1] ?? NaN };
      })
      .filter((r) => r.n > 0);
  const rows = [...stats.entries()].map(([label, s]) => {
    const lat = [...s.lat].sort((a, b) => a - b);
    return { label, n: lat.length, ok: s.ok, errors: s.errors, p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: lat[lat.length - 1] };
  });
  const steady = table(steadyFrom, steadySec);
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  console.log('\nwhole run (ramp + steady)');
  console.log('endpoint                 count     ok   p50ms   p95ms   p99ms   maxms  errors');
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(22)} ${String(r.n).padStart(7)} ${String(r.ok).padStart(6)} ${r.p50.toFixed(0).padStart(7)} ${r.p95.toFixed(0).padStart(7)} ${r.p99.toFixed(0).padStart(7)} ${r.max.toFixed(0).padStart(7)}  ${JSON.stringify(r.errors)}`,
    );
  }
  console.log(`\nsteady phase (from ${RAMP_SEC}+${STEADY_AFTER_RAMP_MS / 1000} s, ${steadySec.toFixed(0)} s)`);
  console.log('endpoint                 count  req/s   p50ms   p95ms   p99ms   maxms');
  for (const r of steady) {
    console.log(`${r.label.padEnd(22)} ${String(r.n).padStart(7)} ${String(r.perSec).padStart(6)} ${r.p50.toFixed(0).padStart(7)} ${r.p95.toFixed(0).padStart(7)} ${r.p99.toFixed(0).padStart(7)} ${r.max.toFixed(0).padStart(7)}`);
  }
  const samples = steady.find((r) => r.label === 'POST identity sample');
  console.log(`\nchecked in ${checkedIn}/${N}, failed ${failedCheckIn}${checkInFailures.size ? ` ${JSON.stringify(Object.fromEntries(checkInFailures))}` : ''}`);
  if (samples) console.log(`identity samples/s (steady): ${samples.perSec}`);
  if (busyRetries.size) console.log(`503 busy responses retried (as the web client does): ${JSON.stringify(Object.fromEntries(busyRetries))}`);
  if (STAFF_WS) console.log(`staff WebSocket messages: ${JSON.stringify(wsCounts)}`);
  writeFileSync(
    OUT,
    JSON.stringify({ at: new Date().toISOString(), N, RAMP_SEC, DURATION_SEC, SAMPLE_SEC, STAFF_WS, checkedIn, failedCheckIn, checkInFailures: Object.fromEntries(checkInFailures), busyRetries: Object.fromEntries(busyRetries), rows, steady, wsCounts, health }, null, 2),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Worker-thread pool for the vision engine. Each worker (worker.ts) owns its own onnxruntime sessions and
 * analyses one image at a time; the main thread only queues work and receives plain results, so inference
 * (synchronous in onnxruntime-node) and the JS pixel loops never block HTTP / database work.
 *
 *  - Two FIFO queues: 'interactive' work (a candidate waits: check frames) goes before 'background' work
 *    (identity samples); background work that waited BACKGROUND_MAX_WAIT_MS alternates with interactive work
 *    (no starvation either way). More than `maxQueue` waiting analyses of one priority => VisionBusyError
 *    (HTTP 503 + Retry-After: the estimated time the work ahead needs, from the measured analysis time).
 *  - `load` is a snapshot of the queue (health, metrics, admission, sampling cadence).
 *  - A worker that crashes fails only its in-flight analysis and is replaced (with backoff).
 *  - Idle workers are unref'ed, so a forgotten pool never keeps a CLI process alive.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { AnalyzeOptions, DetectedFace, ImageAnalysis, VisionByPriority, VisionLoad, VisionObserver, VisionPriority } from './types';
import { reviveAnalysis, reviveError, type SerializedError, type VisionWorkerData, type WorkerRequest, type WorkerResponse } from './worker-protocol';

/** Retry-After (seconds) when there is no better estimate. */
export const DEFAULT_RETRY_AFTER_SEC = 2;
/** A client is never asked to wait longer than this before retrying (seconds). */
export const MAX_RETRY_AFTER_SEC = 30;

/** Suggested wait before retrying, in whole seconds within 1..MAX_RETRY_AFTER_SEC. */
export function retryAfterSecFor(waitMs: number): number {
  return Math.min(MAX_RETRY_AFTER_SEC, Math.max(1, Math.ceil(waitMs / 1000)));
}

export class VisionBusyError extends Error {
  readonly code = 'vision_busy';
  /** Suggested wait before retrying (whole seconds): how long the analyses ahead are expected to take. */
  readonly retryAfterSec: number;
  constructor(retryAfterSec = DEFAULT_RETRY_AFTER_SEC) {
    super('Vision service is overloaded; retry shortly');
    this.name = 'VisionBusyError';
    this.retryAfterSec = retryAfterSec;
  }
}

export class VisionClosedError extends Error {
  readonly code = 'vision_closed';
  constructor() {
    super('Vision service has been closed');
    this.name = 'VisionClosedError';
  }
}

export type WorkerScript =
  /** A JavaScript worker entry (the bundled dist/vision-worker.js). */
  | { kind: 'js'; file: string }
  /** The TypeScript source (development, tests): bootstrapped through tsx's `tsImport` (tsx is a dev dependency). */
  | { kind: 'ts'; file: string; tsxApiUrl: string };

/** Bundled name of the worker entry (tsup.config.ts). */
export const BUNDLED_WORKER_FILE = 'vision-worker.js';

/** ESM entry of `tsx/esm/api` (import condition), resolved from this package. */
function tsxApiUrl(): string {
  try {
    return import.meta.resolve('tsx/esm/api');
  } catch {
    // Runtimes without import.meta.resolve: read the package's export map.
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('tsx/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { exports: Record<string, { import?: { default?: string } }> };
    const rel = pkg.exports['./esm/api']?.import?.default;
    if (!rel) throw new Error('tsx/esm/api not found (tsx is needed to run the vision worker from source)');
    return pathToFileURL(join(dirname(pkgPath), rel)).href;
  }
}

/**
 * Locate the worker entry: `vision-worker.js` next to the bundle (dist/, tsup), else `worker.ts` next to this
 * file (tsx dev server, vitest), loaded through tsx.
 */
export function resolveWorkerScript(here = dirname(fileURLToPath(import.meta.url))): WorkerScript {
  // dist/<chunk>.js -> dist/vision-worker.js (also from a chunk in a sub-folder such as dist/scripts/).
  for (const bundled of [join(here, BUNDLED_WORKER_FILE), join(here, '..', BUNDLED_WORKER_FILE)]) {
    if (existsSync(bundled)) return { kind: 'js', file: bundled };
  }
  const source = join(here, 'worker.ts');
  if (existsSync(source)) return { kind: 'ts', file: source, tsxApiUrl: tsxApiUrl() };
  throw new Error(`Vision worker entry not found next to ${here} (${BUNDLED_WORKER_FILE} or worker.ts)`);
}

function createWorker(script: WorkerScript, workerData: VisionWorkerData): Worker {
  if (script.kind === 'js') return new Worker(script.file, { workerData });
  // `--import tsx` in a worker's execArgv does not reach the worker's module loader; tsImport does.
  const url = JSON.stringify(pathToFileURL(script.file).href);
  const boot = `import(${JSON.stringify(script.tsxApiUrl)})
  .then(({ tsImport }) => tsImport(${url}, ${url}))
  .catch((err) => import('node:worker_threads').then(({ parentPort }) => {
    parentPort.postMessage({ type: 'init_error', error: { name: err && err.name || 'Error', message: String(err && err.message || err) } });
    parentPort.close();
  }));`;
  return new Worker(boot, { eval: true, workerData });
}

type TaskRequest = { type: 'analyze'; image: Uint8Array; opts: AnalyzeOptions } | { type: 'detect'; image: Uint8Array };

export type { VisionPriority };

/** Background work that waited this long alternates with interactive work instead of waiting behind it. */
export const BACKGROUND_MAX_WAIT_MS = 5_000;

/** Analysis time assumed until one has been measured (ms; PERFORMANCE.md §7.4: ≈ 76–93 ms per frame). */
const INITIAL_SERVICE_MS = 100;
/** Weight of the newest measurement in the moving average of the analysis time. */
const SERVICE_MS_ALPHA = 0.1;

interface Task {
  id: number;
  req: TaskRequest;
  priority: VisionPriority;
  enqueuedAt: number;
  /** When a worker took it (0 while queued). */
  startedAt: number;
  resolve: (v: ImageAnalysis | DetectedFace[]) => void;
  reject: (err: Error) => void;
}

interface Slot {
  worker: Worker;
  ready: boolean;
  task: Task | null;
}

export interface VisionPoolOptions {
  size: number;
  maxQueue: number;
  workerData: VisionWorkerData;
  script?: WorkerScript;
  /** Default BACKGROUND_MAX_WAIT_MS. */
  backgroundMaxWaitMs?: number;
  /** Called when a worker dies unexpectedly (logging). */
  onWorkerExit?: (info: { code: number; error: Error | null }) => void;
  /** Queue wait / analysis time of every analysis and every refusal (metrics). */
  observer?: VisionObserver;
}

const START_TIMEOUT_MS = 120_000;
const CLOSE_TIMEOUT_MS = 10_000;
const MAX_RESPAWN_DELAY_MS = 30_000;

export class VisionWorkerPool {
  private readonly slots: Slot[] = [];
  private readonly queues: Record<VisionPriority, Task[]> = { interactive: [], background: [] };
  private lastWasOverdue = false;
  private nextId = 1;
  private closed = false;
  private respawnFailures = 0;
  private lastInitError: Error | null = null;
  private readonly idleWaiters: (() => void)[] = [];
  private serviceMs = INITIAL_SERVICE_MS;
  private serviceMeasured = false;

  private constructor(
    private readonly opts: VisionPoolOptions,
    private readonly script: WorkerScript,
  ) {}

  /** Start `size` workers and wait until every one has loaded and warmed up its models. */
  static async start(opts: VisionPoolOptions): Promise<VisionWorkerPool> {
    const pool = new VisionWorkerPool(opts, opts.script ?? resolveWorkerScript());
    const results = await Promise.allSettled(Array.from({ length: Math.max(1, opts.size) }, () => pool.spawn()));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) {
      await pool.close();
      throw failed.reason;
    }
    return pool;
  }

  get size(): number {
    return this.slots.length;
  }
  get inFlight(): number {
    let n = 0;
    for (const s of this.slots) if (s.task) n++;
    return n;
  }
  get queued(): number {
    return this.queues.interactive.length + this.queues.background.length;
  }

  /**
   * Expected wait before work of `priority` submitted now gets a worker (ms; VisionLoad.estimatedWaitMs). Interactive
   * work waits only behind interactive work; background work behind everything queued (it gets a turn when overdue,
   * so this is an upper estimate).
   */
  estimatedWaitMs(priority: VisionPriority): number {
    const ahead = priority === 'interactive' ? this.queues.interactive.length : this.queued;
    if (ahead === 0 && this.slots.some((s) => s.ready && !s.task)) return 0;
    const workers = Math.max(1, this.readyWorkers);
    return Math.round(((ahead + 1) * this.serviceMs) / workers);
  }

  private taskEnded(task: Task, ok: boolean): void {
    const runMs = Date.now() - task.startedAt;
    if (ok) {
      this.serviceMs = this.serviceMeasured ? this.serviceMs + SERVICE_MS_ALPHA * (runMs - this.serviceMs) : runMs;
      this.serviceMeasured = true;
    }
    try {
      this.opts.observer?.analysisEnded({ priority: task.priority, waitMs: task.startedAt - task.enqueuedAt, runMs, ok });
    } catch {
      /* metrics must never break analysis */
    }
  }

  private get readyWorkers(): number {
    let n = 0;
    for (const s of this.slots) if (s.ready) n++;
    return n;
  }

  get load(): VisionLoad {
    const now = Date.now();
    const oldest = (q: Task[]) => (q.length ? Math.max(0, now - q[0].enqueuedAt) : 0);
    const per = (f: (p: VisionPriority) => number): VisionByPriority => ({ interactive: f('interactive'), background: f('background') });
    return {
      workers: this.readyWorkers,
      inFlight: this.inFlight,
      queued: per((p) => this.queues[p].length),
      oldestWaitMs: per((p) => oldest(this.queues[p])),
      serviceMs: Math.round(this.serviceMs * 10) / 10,
      estimatedWaitMs: per((p) => this.estimatedWaitMs(p)),
      maxQueue: this.opts.maxQueue,
    };
  }

  analyze(image: Buffer, opts: AnalyzeOptions): Promise<ImageAnalysis> {
    const req: TaskRequest = {
      type: 'analyze',
      image,
      opts: {
        embed: opts.embed,
        faceCrop: opts.faceCrop,
        gate: opts.gate,
        ...(opts.embeddingVariants ? { embeddingVariants: opts.embeddingVariants } : {}),
        ...(opts.enhanceLowLight != null ? { enhanceLowLight: opts.enhanceLowLight } : {}),
      },
    };
    return this.submit(req, opts.priority ?? 'interactive').then((a) => reviveAnalysis(a as ImageAnalysis));
  }

  detect(image: Buffer): Promise<DetectedFace[]> {
    return this.submit({ type: 'detect', image }, 'interactive') as Promise<DetectedFace[]>;
  }

  private submit(req: TaskRequest, priority: VisionPriority): Promise<ImageAnalysis | DetectedFace[]> {
    if (this.closed) return Promise.reject(new VisionClosedError());
    const queue = this.queues[priority];
    const free = this.slots.some((s) => s.ready && !s.task);
    if (!free && queue.length >= this.opts.maxQueue) {
      try {
        this.opts.observer?.analysisRefused(priority);
      } catch {
        /* metrics must never break analysis */
      }
      return Promise.reject(new VisionBusyError(retryAfterSecFor(this.estimatedWaitMs(priority))));
    }
    return new Promise((resolve, reject) => {
      queue.push({ id: this.nextId++, req, priority, enqueuedAt: Date.now(), startedAt: 0, resolve, reject });
      this.pump();
    });
  }

  private nextTask(): Task | undefined {
    const bg = this.queues.background;
    const inter = this.queues.interactive;
    // Overdue background work alternates with interactive work, so neither class can starve the other.
    const overdue = bg.length > 0 && Date.now() - bg[0].enqueuedAt >= (this.opts.backgroundMaxWaitMs ?? BACKGROUND_MAX_WAIT_MS);
    if (inter.length && !(overdue && !this.lastWasOverdue)) {
      this.lastWasOverdue = false;
      return inter.shift();
    }
    this.lastWasOverdue = overdue;
    return bg.shift();
  }

  private rejectQueued(err: Error): void {
    for (const t of [...this.queues.interactive.splice(0), ...this.queues.background.splice(0)]) t.reject(err);
  }

  private pump(): void {
    while (this.queued) {
      const slot = this.slots.find((s) => s.ready && !s.task);
      if (!slot) return;
      const task = this.nextTask()!;
      task.startedAt = Date.now();
      slot.task = task;
      slot.worker.ref();
      // The image is copied (structured clone): the caller keeps using its buffer (evidence storage).
      slot.worker.postMessage({ ...task.req, id: task.id } satisfies WorkerRequest);
    }
  }

  private spawn(): Promise<void> {
    return new Promise((resolveStart, rejectStart) => {
      let started = false;
      const worker = createWorker(this.script, this.opts.workerData);
      const slot: Slot = { worker, ready: false, task: null };
      this.slots.push(slot);
      let exitError: Error | null = null;
      const timer = setTimeout(() => {
        if (!started) {
          exitError = new Error(`Vision worker did not start within ${START_TIMEOUT_MS / 1000} s`);
          void worker.terminate();
        }
      }, START_TIMEOUT_MS);
      timer.unref();

      worker.on('message', (msg: WorkerResponse) => {
        if (msg.type === 'ready') {
          started = true;
          clearTimeout(timer);
          slot.ready = true;
          this.respawnFailures = 0;
          this.lastInitError = null;
          worker.unref();
          resolveStart();
          this.pump();
        } else if (msg.type === 'init_error') {
          exitError = reviveError(msg.error);
          void worker.terminate(); // -> 'exit' rejects the start
        } else if (msg.type === 'result') {
          const task = slot.task;
          if (!task || task.id !== msg.id) return;
          slot.task = null;
          this.taskEnded(task, msg.ok);
          if (msg.ok) task.resolve((msg.analysis ?? msg.faces)!);
          else task.reject(reviveError(msg.error));
          if (!this.queued) worker.unref();
          this.pump();
          if (this.inFlight === 0) for (const w of this.idleWaiters.splice(0)) w();
        }
      });
      worker.on('error', (err) => {
        exitError = err;
      });
      worker.on('exit', (code) => {
        clearTimeout(timer);
        const i = this.slots.indexOf(slot);
        if (i >= 0) this.slots.splice(i, 1);
        const err = exitError ?? new Error(`Vision worker exited (code ${code})`);
        if (slot.task) {
          this.taskEnded(slot.task, false);
          slot.task.reject(err);
          slot.task = null;
        }
        if (this.inFlight === 0) for (const w of this.idleWaiters.splice(0)) w();
        if (!started) {
          rejectStart(err);
          if (this.closed) return;
          // A replacement failed to start (models unreadable, out of memory...): fail waiting work instead of
          // letting it hang, and keep trying in the background.
          this.lastInitError = err;
          if (!this.slots.some((s) => s.ready)) this.rejectQueued(err);
        } else if (!this.closed) {
          this.opts.onWorkerExit?.({ code, error: exitError });
        }
        // A crashed worker is replaced; a failed start is retried by whoever called spawn() (scheduleRespawn).
        if (!this.closed && started) this.scheduleRespawn();
      });
    });
  }

  private scheduleRespawn(): void {
    const delay = Math.min(MAX_RESPAWN_DELAY_MS, 1000 * 2 ** this.respawnFailures);
    const t = setTimeout(() => {
      if (this.closed) return;
      this.spawn().catch(() => {
        this.respawnFailures++;
        this.scheduleRespawn();
      });
    }, this.respawnFailures === 0 ? 0 : delay);
    t.unref();
  }

  /** The error of the last failed worker start while no worker is available (diagnostics). */
  get startError(): Error | null {
    return this.lastInitError;
  }

  /** Refuse new work, fail queued work, let in-flight analyses finish, then stop the workers. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectQueued(new VisionClosedError());
    if (this.inFlight > 0) await new Promise<void>((r) => this.idleWaiters.push(r));
    await Promise.all(
      [...this.slots].map(
        (s) =>
          new Promise<void>((done) => {
            const force = setTimeout(() => void s.worker.terminate().finally(done), CLOSE_TIMEOUT_MS);
            s.worker.once('exit', () => {
              clearTimeout(force);
              done();
            });
            s.worker.ref();
            s.worker.postMessage({ type: 'close' } satisfies WorkerRequest);
          }),
      ),
    );
  }
}

export type { SerializedError };

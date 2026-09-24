/**
 * Worker-thread pool for the vision engine. Each worker (worker.ts) owns its own onnxruntime sessions and
 * analyses one image at a time; the main thread only queues work and receives plain results, so inference
 * (synchronous in onnxruntime-node) and the JS pixel loops never block HTTP / database work.
 *
 *  - FIFO queue; more than `maxQueue` waiting analyses => VisionBusyError (HTTP 503 + Retry-After).
 *  - A worker that crashes fails only its in-flight analysis and is replaced (with backoff).
 *  - Idle workers are unref'ed, so a forgotten pool never keeps a CLI process alive.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { AnalyzeOptions, DetectedFace, ImageAnalysis } from './types';
import { reviveAnalysis, reviveError, type SerializedError, type VisionWorkerData, type WorkerRequest, type WorkerResponse } from './worker-protocol';

export class VisionBusyError extends Error {
  readonly code = 'vision_busy';
  constructor() {
    super('Vision service is overloaded; retry shortly');
    this.name = 'VisionBusyError';
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

interface Task {
  id: number;
  req: TaskRequest;
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
  /** Called when a worker dies unexpectedly (logging). */
  onWorkerExit?: (info: { code: number; error: Error | null }) => void;
}

const START_TIMEOUT_MS = 120_000;
const CLOSE_TIMEOUT_MS = 10_000;
const MAX_RESPAWN_DELAY_MS = 30_000;

export class VisionWorkerPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Task[] = [];
  private nextId = 1;
  private closed = false;
  private respawnFailures = 0;
  private lastInitError: Error | null = null;
  private readonly idleWaiters: (() => void)[] = [];

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
    return this.queue.length;
  }

  analyze(image: Buffer, opts: AnalyzeOptions): Promise<ImageAnalysis> {
    return this.submit({ type: 'analyze', image, opts: { embed: opts.embed, faceCrop: opts.faceCrop, gate: opts.gate } }).then((a) => reviveAnalysis(a as ImageAnalysis));
  }

  detect(image: Buffer): Promise<DetectedFace[]> {
    return this.submit({ type: 'detect', image }) as Promise<DetectedFace[]>;
  }

  private submit(req: TaskRequest): Promise<ImageAnalysis | DetectedFace[]> {
    if (this.closed) return Promise.reject(new VisionClosedError());
    const free = this.slots.some((s) => s.ready && !s.task);
    if (!free && this.queue.length >= this.opts.maxQueue) return Promise.reject(new VisionBusyError());
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, req, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    while (this.queue.length) {
      const slot = this.slots.find((s) => s.ready && !s.task);
      if (!slot) return;
      const task = this.queue.shift()!;
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
        } else if (msg.type === 'result') {
          const task = slot.task;
          if (!task || task.id !== msg.id) return;
          slot.task = null;
          if (msg.ok) task.resolve((msg.analysis ?? msg.faces)!);
          else task.reject(reviveError(msg.error));
          if (!this.queue.length) worker.unref();
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
          if (!this.slots.some((s) => s.ready)) for (const t of this.queue.splice(0)) t.reject(err);
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
    for (const t of this.queue.splice(0)) t.reject(new VisionClosedError());
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

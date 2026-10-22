/**
 * Vision service: YuNet face detection + SFace embeddings on onnxruntime-node (CPU).
 *
 * onnxruntime-node's `InferenceSession.run()` is synchronous — it blocks the calling JS thread for the whole
 * inference — so by default the analysis pipeline (engine.ts) runs in a pool of worker threads (pool.ts,
 * worker.ts), each with its own onnxruntime sessions, and the server's event loop stays free for requests.
 * `workers: 0` (VISION_WORKERS=0) runs the engine on the calling thread instead (tools, debugging).
 *
 * Sizing (docs/PERFORMANCE.md): `threads` (VISION_THREADS) is the CPU budget of the vision pool; by default
 * it is split into single-threaded workers (best throughput per core). Work beyond the workers waits in a
 * FIFO queue; more than `maxQueue` waiting analyses are refused with VisionBusyError (map to HTTP 503).
 */
import { availableParallelism } from 'node:os';
import { disableOrtTelemetry, VisionEngine } from './engine';
import { processIdPhoto } from './id-photo';
import { resolveModelsDir } from './models';
import { retryAfterSecFor, VisionBusyError, VisionCancelledError, VisionClosedError, VisionWorkerPool, type WorkerScript } from './pool';
import type { AnalyzeOptions, DetectedFace, IdPhotoCapableVisionService, IdPhotoResult, ImageAnalysis, QualityGate, TimedAnalysis, VisionLoad, VisionObserver } from './types';
import { DEFAULT_DETECT_THRESHOLD } from './detect';
import { DEFAULT_MAX_DECODE_SIDE } from './image';
import type { EmbeddingRecipe } from './embed-prep';

export { VisionBusyError, VisionCancelledError, VisionClosedError };

export interface VisionServiceOptions {
  /** Directory containing the two ONNX files (default: MODELS_DIR or apps/server/models). */
  modelsDir?: string;
  /**
   * Worker threads (env VISION_WORKERS). 0 = analyse on the calling thread (blocks it during inference).
   * Default: `concurrency` if given, else threads / threadsPerWorker.
   */
  workers?: number;
  /** Max analyses in flight: the worker count in pool mode; in-process mode default 2. */
  concurrency?: number;
  /** YuNet score threshold (default 0.6). */
  detectThreshold?: number;
  /**
   * CPU threads for face analysis in total (env VISION_THREADS). Default: CPU count - 1 (min 1, max 8),
   * leaving a core for the event loop.
   */
  threads?: number;
  /** onnxruntime intra-op threads per worker (env VISION_THREADS_PER_WORKER, default 1). */
  threadsPerWorker?: number;
  /** Max side of the decoded working image (default 1280). */
  maxDecodeSide?: number;
  /** Analyses allowed to wait for a worker before VisionBusyError (default 256). */
  maxQueue?: number;
  /** Service-wide quality-gate override (per-call `AnalyzeOptions.gate` is applied on top). */
  gate?: Partial<QualityGate>;
  /** Embedding recipe (default DEFAULT_EMBEDDING_RECIPE; evaluation of older pipelines only). */
  embedding?: EmbeddingRecipe;
  /** Second, low-light-enhanced detection pass when no face is found (default true). */
  enhanceLowLight?: boolean;
  /** Mirror-symmetric head pose (one extra detector pass on frames with a face; default true). */
  symmetricPose?: boolean;
  /**
   * Linux: nice increment for the vision threads (env VISION_NICE, default 0). A positive value lets request
   * handling win when the CPU is saturated, but on a shared host other processes then win over vision too.
   */
  nice?: number;
  /** Worker entry override (tests). */
  workerScript?: WorkerScript;
  /** Unexpected worker exits (logging). */
  onWorkerExit?: (info: { code: number; error: Error | null }) => void;
  /** Queue wait / analysis time of every analysis in pool mode (metrics; not reported in-process). */
  observer?: VisionObserver;
}

export interface VisionStats {
  analyzed: number;
  failed: number;
  avgMs: number;
  inFlight: number;
  queued: number;
  /** Worker threads (0 = in-process). */
  workers: number;
  /** onnxruntime intra-op threads per engine. */
  threadsPerEngine: number;
}

export interface VisionThreading {
  workers: number;
  threadsPerWorker: number;
  /** In-process mode only: analyses in flight. */
  concurrency: number;
}

function envInt(v: string | undefined): number | null {
  if (v == null || v.trim() === '') return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/** Worker / thread counts from options, environment and the CPU count (pure; exported for tests). */
export function resolveVisionThreading(options: VisionServiceOptions, env: NodeJS.ProcessEnv = process.env, cpus = availableParallelism()): VisionThreading {
  const cpu = Math.max(1, cpus);
  const pos = (v: number | null | undefined) => (v != null && v > 0 ? Math.floor(v) : null);
  const perWorker = pos(options.threadsPerWorker) ?? pos(envInt(env.VISION_THREADS_PER_WORKER)) ?? 1;
  const total = pos(options.threads) ?? pos(envInt(env.VISION_THREADS)) ?? Math.min(8, Math.max(1, cpu - 1));
  const explicitWorkers = options.workers ?? envInt(env.VISION_WORKERS);
  if (explicitWorkers != null && explicitWorkers <= 0) {
    return { workers: 0, threadsPerWorker: pos(options.threads) ?? pos(envInt(env.VISION_THREADS)) ?? Math.min(4, cpu), concurrency: pos(options.concurrency) ?? 2 };
  }
  const workers = pos(explicitWorkers) ?? pos(options.concurrency) ?? Math.max(1, Math.floor(total / perWorker));
  return { workers, threadsPerWorker: perWorker, concurrency: workers };
}

/** In-process backend: FIFO semaphore around one engine. */
class Limiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  /** Moving average of one run (ms). */
  serviceMs = 100;
  constructor(
    readonly max: number,
    readonly maxQueue: number,
  ) {}
  get inFlight() {
    return this.active;
  }
  get queued() {
    return this.waiting.length;
  }
  estimatedWaitMs(): number {
    return this.active < this.max ? 0 : Math.round(((this.waiting.length + 1) * this.serviceMs) / this.max);
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    return (await this.runTimed(fn)).value;
  }
  /** run(), plus the time spent waiting for a slot and running (ms). */
  async runTimed<T>(fn: () => Promise<T>): Promise<{ value: T; waitMs: number; runMs: number }> {
    const queuedAt = performance.now();
    if (this.active >= this.max) {
      if (this.waiting.length >= this.maxQueue) throw new VisionBusyError(retryAfterSecFor(this.estimatedWaitMs()));
      await new Promise<void>((res) => this.waiting.push(res));
    } else {
      this.active++;
    }
    const t0 = performance.now();
    try {
      const value = await fn();
      const runMs = performance.now() - t0;
      this.serviceMs += 0.1 * (runMs - this.serviceMs);
      return { value, waitMs: Math.round(t0 - queuedAt), runMs: Math.round(runMs) };
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

interface Backend {
  analyzeTimed(image: Buffer, opts: AnalyzeOptions, signal?: AbortSignal): Promise<TimedAnalysis>;
  detect(image: Buffer): Promise<DetectedFace[]>;
  readonly inFlight: number;
  readonly queued: number;
  readonly load: VisionLoad;
  close(): Promise<void>;
}

class InProcessBackend implements Backend {
  private closed = false;
  constructor(
    private readonly engine: VisionEngine,
    private readonly limiter: Limiter,
  ) {}
  get inFlight() {
    return this.limiter.inFlight;
  }
  get queued() {
    return this.limiter.queued;
  }
  /** One FIFO without priorities: everything counts as interactive; waits are not tracked per item. */
  get load(): VisionLoad {
    const l = this.limiter;
    const wait = l.estimatedWaitMs();
    return {
      workers: this.closed ? 0 : l.max,
      inFlight: l.inFlight,
      queued: { interactive: l.queued, background: 0 },
      oldestWaitMs: { interactive: 0, background: 0 },
      serviceMs: Math.round(l.serviceMs * 10) / 10,
      estimatedWaitMs: { interactive: wait, background: wait },
      maxQueue: l.maxQueue,
    };
  }
  async analyzeTimed(image: Buffer, opts: AnalyzeOptions): Promise<TimedAnalysis> {
    const r = await this.limiter.runTimed(async () => {
      if (this.closed) throw new VisionClosedError();
      return this.engine.analyze(image, opts);
    });
    return { analysis: r.value, waitMs: r.waitMs, runMs: r.runMs };
  }
  detect(image: Buffer): Promise<DetectedFace[]> {
    return this.limiter.run(async () => {
      if (this.closed) throw new VisionClosedError();
      return this.engine.detect(image);
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    // Let in-flight work finish before releasing native sessions.
    while (this.limiter.inFlight > 0) await new Promise((r) => setTimeout(r, 10));
    await this.engine.close();
  }
}

export class OnnxVisionService implements IdPhotoCapableVisionService {
  private closed = false;
  private analyzed = 0;
  private failed = 0;
  private totalMs = 0;

  private constructor(
    private readonly backend: Backend,
    readonly modelsDir: string,
    readonly threading: VisionThreading,
  ) {}

  static async create(options: VisionServiceOptions = {}): Promise<OnnxVisionService> {
    const modelsDir = resolveModelsDir(options.modelsDir);
    const threading = resolveVisionThreading(options);
    disableOrtTelemetry(); // before the workers start: they inherit the environment

    const engineOpts = {
      modelsDir,
      threads: threading.threadsPerWorker,
      detectThreshold: options.detectThreshold ?? DEFAULT_DETECT_THRESHOLD,
      maxDecodeSide: options.maxDecodeSide ?? DEFAULT_MAX_DECODE_SIDE,
      gate: options.gate,
      ...(options.embedding ? { embedding: options.embedding } : {}),
      ...(options.enhanceLowLight != null ? { enhanceLowLight: options.enhanceLowLight } : {}),
      ...(options.symmetricPose != null ? { symmetricPose: options.symmetricPose } : {}),
    };
    const maxQueue = options.maxQueue ?? 256;
    let backend: Backend;
    if (threading.workers === 0) {
      backend = new InProcessBackend(await VisionEngine.create(engineOpts), new Limiter(threading.concurrency, maxQueue));
    } else {
      const nice = options.nice ?? envInt(process.env.VISION_NICE) ?? 0;
      backend = await VisionWorkerPool.start({
        size: threading.workers,
        maxQueue,
        workerData: { engine: engineOpts, nice: Math.max(0, Math.min(19, nice)) },
        script: options.workerScript,
        onWorkerExit: options.onWorkerExit,
        observer: options.observer,
      });
    }
    return new OnnxVisionService(backend, modelsDir, threading);
  }

  get stats(): VisionStats {
    return {
      analyzed: this.analyzed,
      failed: this.failed,
      avgMs: this.analyzed ? Math.round((this.totalMs / this.analyzed) * 10) / 10 : 0,
      inFlight: this.backend.inFlight,
      queued: this.backend.queued,
      workers: this.threading.workers,
      threadsPerEngine: this.threading.threadsPerWorker,
    };
  }

  /** The face-analysis queue right now (VisionService.load). */
  get load(): VisionLoad {
    return this.backend.load;
  }

  async analyze(image: Buffer, opts: AnalyzeOptions = {}): Promise<ImageAnalysis> {
    return (await this.analyzeTimed(image, opts)).analysis;
  }

  /**
   * analyze(), plus the queue wait and analysis time of this image (ms; the dedicated vision worker reports them).
   * `signal` drops the analysis while it is still queued (worker pool only; VisionCancelledError).
   */
  async analyzeTimed(image: Buffer, opts: AnalyzeOptions = {}, signal?: AbortSignal): Promise<TimedAnalysis> {
    if (this.closed) throw new VisionClosedError();
    const t0 = performance.now();
    try {
      const result = await this.backend.analyzeTimed(image, opts, signal);
      this.analyzed++;
      this.totalMs += performance.now() - t0;
      return result;
    } catch (err) {
      if (!(err instanceof VisionBusyError) && !(err instanceof VisionClosedError) && !(err instanceof VisionCancelledError)) this.failed++;
      throw err;
    }
  }

  processIdPhoto(image: Buffer): Promise<IdPhotoResult> {
    return processIdPhoto(this, image);
  }

  /** Detect faces only (no alignment / embedding), in original-image coordinates, primary first. */
  async detect(image: Buffer): Promise<DetectedFace[]> {
    if (this.closed) throw new VisionClosedError();
    return this.backend.detect(image);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.backend.close();
  }
}

/** Load the models (in every worker) and return the analysis service. */
export function createVisionService(opts: VisionServiceOptions = {}): Promise<OnnxVisionService> {
  return OnnxVisionService.create(opts);
}

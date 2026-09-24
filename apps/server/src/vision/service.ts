/**
 * In-process vision service: YuNet face detection + SFace embeddings on onnxruntime-node (CPU).
 *
 * `InferenceSession.run()` executes on native threads (it does not block the event loop); onnxruntime
 * serialises runs, so parallelism comes from the intra-op thread pool (`threads`). The limiter keeps
 * at most `concurrency` analyses in flight so decode (libvips threads), JS pre/post-processing and
 * inference overlap, and rejects work beyond `maxQueue` with VisionBusyError (map to HTTP 503).
 */
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import * as ort from 'onnxruntime-node';
import { poseFromFivePoints } from '@sp/shared';
import { alignFace, type AlignedFace } from './align';
import { DEFAULT_DETECT_THRESHOLD, YUNET_INPUT_SIZE, decodeToDetectedFaces, interEyeDistance, packBgrPlanar, planDetectorInput } from './detect';
import { DEFAULT_MAX_DECODE_SIDE, decodeImage, decodeRegion, encodeJpegRegion, resizeRgb, wholeImageStats, type RgbImage } from './image';
import { resolveModelsDir, SFACE_MODEL_FILE, YUNET_MODEL_FILE } from './models';
import { assessQuality, faceRegionStats, resolveGate } from './quality';
import { processIdPhoto } from './id-photo';
import type { AnalyzeOptions, DetectedFace, HeadPose, IdPhotoCapableVisionService, IdPhotoResult, ImageAnalysis, QualityGate } from './types';

export interface VisionServiceOptions {
  /** Directory containing the two ONNX files (default: MODELS_DIR or apps/server/models). */
  modelsDir?: string;
  /** Max analyses in flight (default 2; <= 0 means auto). */
  concurrency?: number;
  /** YuNet score threshold (default 0.6). */
  detectThreshold?: number;
  /** onnxruntime intra-op threads per session (default min(4, CPU count); env VISION_THREADS). */
  threads?: number;
  /** Max side of the decoded working image (default 1280). */
  maxDecodeSide?: number;
  /** Analyses allowed to wait for a slot before VisionBusyError (default 256). */
  maxQueue?: number;
  /** Service-wide quality-gate override (per-call `AnalyzeOptions.gate` is applied on top). */
  gate?: Partial<QualityGate>;
}

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

/** Minimal FIFO semaphore. */
class Limiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(
    private readonly max: number,
    private readonly maxQueue: number,
  ) {}
  get inFlight() {
    return this.active;
  }
  get queued() {
    return this.waiting.length;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      if (this.waiting.length >= this.maxQueue) throw new VisionBusyError();
      await new Promise<void>((res) => this.waiting.push(res));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/** Faces this small (inter-ocular px in the sampled image) are re-sampled from the full-resolution original. */
const MIN_ALIGN_INTER_EYE = 40;
/** When re-sampling, no need for more than this inter-ocular distance (template is 35 px). */
const MAX_ALIGN_INTER_EYE = 120;
const FACE_CROP_MARGIN = 0.4;
const FACE_CROP_MAX_SIDE = 256;
const FACE_CROP_QUALITY = 85;

export interface VisionStats {
  analyzed: number;
  failed: number;
  avgMs: number;
  inFlight: number;
  queued: number;
}

export class OnnxVisionService implements IdPhotoCapableVisionService {
  private closed = false;
  private readonly limiter: Limiter;
  private readonly gate: QualityGate;
  private analyzed = 0;
  private failed = 0;
  private totalMs = 0;
  /** Reusable detector input buffers (4.9 MB each), at most one per concurrent analysis. */
  private readonly tensorPool: Float32Array[] = [];

  private constructor(
    private readonly detector: ort.InferenceSession,
    private readonly recognizer: ort.InferenceSession,
    readonly modelsDir: string,
    private readonly opts: Required<Omit<VisionServiceOptions, 'modelsDir' | 'gate'>> & { gate?: Partial<QualityGate> },
  ) {
    this.limiter = new Limiter(opts.concurrency, opts.maxQueue);
    this.gate = resolveGate(opts.gate);
  }

  static async create(options: VisionServiceOptions = {}): Promise<OnnxVisionService> {
    const modelsDir = resolveModelsDir(options.modelsDir);
    const cpu = Math.max(1, availableParallelism());
    const envThreads = Number.parseInt(process.env.VISION_THREADS ?? '', 10);
    const threads = options.threads && options.threads > 0 ? options.threads : envThreads > 0 ? envThreads : Math.min(4, cpu);
    const concurrency = options.concurrency && options.concurrency > 0 ? Math.floor(options.concurrency) : 2;
    const sessionOptions: ort.InferenceSession.SessionOptions = {
      logSeverityLevel: 3,
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
      graphOptimizationLevel: 'all',
      executionMode: 'sequential',
      // Two sessions share the CPU: spin-waiting pool threads of one session starve the other (and the
      // event loop / libvips). Measured on 4 cores: detector 15 -> 6 ms, embedder 31 -> 13 ms.
      extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } },
    };
    const [detector, recognizer] = await Promise.all([
      ort.InferenceSession.create(resolve(modelsDir, YUNET_MODEL_FILE), sessionOptions),
      ort.InferenceSession.create(resolve(modelsDir, SFACE_MODEL_FILE), sessionOptions),
    ]);
    const svc = new OnnxVisionService(detector, recognizer, modelsDir, {
      concurrency,
      threads,
      detectThreshold: options.detectThreshold ?? DEFAULT_DETECT_THRESHOLD,
      maxDecodeSide: options.maxDecodeSide ?? DEFAULT_MAX_DECODE_SIDE,
      maxQueue: options.maxQueue ?? 256,
      gate: options.gate,
    });
    await svc.warmUp();
    return svc;
  }

  get stats(): VisionStats {
    return {
      analyzed: this.analyzed,
      failed: this.failed,
      avgMs: this.analyzed ? Math.round((this.totalMs / this.analyzed) * 10) / 10 : 0,
      inFlight: this.limiter.inFlight,
      queued: this.limiter.queued,
    };
  }

  private async warmUp(): Promise<void> {
    const det = new Float32Array(3 * YUNET_INPUT_SIZE * YUNET_INPUT_SIZE);
    await this.detector.run({ [this.detector.inputNames[0]]: new ort.Tensor('float32', det, [1, 3, YUNET_INPUT_SIZE, YUNET_INPUT_SIZE]) });
    await this.recognizer.run({ [this.recognizer.inputNames[0]]: new ort.Tensor('float32', new Float32Array(3 * 112 * 112), [1, 3, 112, 112]) });
  }

  async analyze(image: Buffer, opts: AnalyzeOptions = {}): Promise<ImageAnalysis> {
    if (this.closed) throw new VisionClosedError();
    return this.limiter.run(async () => {
      if (this.closed) throw new VisionClosedError();
      const t0 = performance.now();
      try {
        const result = await this.analyzeNow(image, opts);
        this.analyzed++;
        this.totalMs += performance.now() - t0;
        return result;
      } catch (err) {
        this.failed++;
        throw err;
      }
    });
  }

  processIdPhoto(image: Buffer): Promise<IdPhotoResult> {
    return processIdPhoto(this, image);
  }

  /** Detect faces only (no alignment / embedding), in original-image coordinates, primary first. */
  async detect(image: Buffer): Promise<DetectedFace[]> {
    if (this.closed) throw new VisionClosedError();
    return this.limiter.run(async () => {
      if (this.closed) throw new VisionClosedError();
      return this.detectDecoded(await decodeImage(image, this.opts.maxDecodeSide));
    });
  }

  private async detectDecoded(img: RgbImage & { origWidth: number; origHeight: number }): Promise<DetectedFace[]> {
    const plan = planDetectorInput(img.width, img.height);
    const detImg = plan.resize ? await resizeRgb(img, plan.width, plan.height) : img;
    const tensor = packBgrPlanar(detImg, YUNET_INPUT_SIZE, this.tensorPool.pop());
    let outputs: ort.InferenceSession.ReturnType;
    try {
      outputs = await this.detector.run({
        [this.detector.inputNames[0]]: new ort.Tensor('float32', tensor, [1, 3, YUNET_INPUT_SIZE, YUNET_INPUT_SIZE]),
      });
    } finally {
      if (this.tensorPool.length < this.opts.concurrency) this.tensorPool.push(tensor);
    }
    return decodeToDetectedFaces(outputs, this.opts.detectThreshold, detImg.width / img.origWidth, detImg.height / img.origHeight);
  }

  private async analyzeNow(image: Buffer, opts: AnalyzeOptions): Promise<ImageAnalysis> {
    const gate = opts.gate ? resolveGate(opts.gate, this.gate) : this.gate;
    const img = await decodeImage(image, this.opts.maxDecodeSide);
    const whole = wholeImageStats(img);
    const faces = await this.detectDecoded(img);
    const primary = faces[0] ?? null;

    let aligned: AlignedFace | null = null;
    let pose: HeadPose | null = null;
    if (primary) {
      const p = poseFromFivePoints(primary.landmarks);
      pose = { yawDeg: p.yawDeg, pitchDeg: p.pitchDeg, rollDeg: p.rollDeg };
      aligned = await this.alignPrimary(image, img, primary.landmarks, interEyeDistance(primary));
    }
    const stats = aligned ? faceRegionStats(aligned) : null;
    const quality = assessQuality(
      { width: img.origWidth, height: img.origHeight, faces, pose, stats, imageBrightness: whole.brightness, imageContrast: whole.contrast },
      gate,
    );
    const embedding = opts.embed && aligned ? await this.embed(aligned) : null;
    const faceCropJpeg = opts.faceCrop && primary ? await this.faceCrop(img, primary.box) : null;
    return {
      width: img.origWidth,
      height: img.origHeight,
      faces,
      primary,
      pose,
      quality,
      embedding,
      dhash: whole.dhash,
      faceCropJpeg,
      imageBrightness: Math.round(whole.brightness * 100) / 100,
    };
  }

  /**
   * Align from the working image, or — when the working image was downscaled and the face ended up
   * small — from a full-resolution decode of the face region.
   */
  private async alignPrimary(
    image: Buffer,
    img: RgbImage & { origWidth: number; origHeight: number; scale: number },
    landmarksOrig: readonly { x: number; y: number }[],
    interEyeOrig: number,
  ): Promise<AlignedFace> {
    if (img.scale < 1 && interEyeOrig * img.scale < MIN_ALIGN_INTER_EYE) {
      const xs = landmarksOrig.map((p) => p.x);
      const ys = landmarksOrig.map((p) => p.y);
      const pad = 2.2 * interEyeOrig;
      const left = Math.max(0, Math.floor(Math.min(...xs) - pad));
      const top = Math.max(0, Math.floor(Math.min(...ys) - pad));
      const right = Math.min(img.origWidth, Math.ceil(Math.max(...xs) + pad));
      const bottom = Math.min(img.origHeight, Math.ceil(Math.max(...ys) + pad));
      if (right - left >= 8 && bottom - top >= 8) {
        const want = Math.min(1, MAX_ALIGN_INTER_EYE / Math.max(1, interEyeOrig));
        const maxSide = Math.max(right - left, bottom - top) * want;
        try {
          const region = await decodeRegion(image, { left, top, width: right - left, height: bottom - top }, Math.max(16, Math.round(maxSide)));
          const lm = landmarksOrig.map((p) => ({ x: (p.x - left) * region.scale, y: (p.y - top) * region.scale }));
          return alignFace(region, lm);
        } catch {
          // fall back to the working image
        }
      }
    }
    return alignFace(
      img,
      landmarksOrig.map((p) => ({ x: p.x * img.scale, y: p.y * img.scale })),
    );
  }

  private async embed(face: AlignedFace): Promise<Float32Array> {
    const out = await this.recognizer.run({
      [this.recognizer.inputNames[0]]: new ort.Tensor('float32', face.rgb, [1, 3, face.size, face.size]),
    });
    const t = out[this.recognizer.outputNames[0]];
    const raw = t.data as Float32Array;
    const e = new Float32Array(raw.length);
    let norm = 0;
    for (let i = 0; i < raw.length; i++) norm += raw[i] * raw[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < raw.length; i++) e[i] = raw[i] / norm;
    return e;
  }

  private async faceCrop(img: RgbImage & { scale: number }, box: { x: number; y: number; w: number; h: number }): Promise<Buffer | null> {
    const s = img.scale;
    const side = Math.max(box.w, box.h) * (1 + 2 * FACE_CROP_MARGIN) * s;
    const cx = (box.x + box.w / 2) * s;
    const cy = (box.y + box.h / 2) * s;
    const left = Math.max(0, Math.floor(cx - side / 2));
    const top = Math.max(0, Math.floor(cy - side / 2));
    const right = Math.min(img.width, Math.ceil(cx + side / 2));
    const bottom = Math.min(img.height, Math.ceil(cy + side / 2));
    if (right - left < 2 || bottom - top < 2) return null;
    return encodeJpegRegion(img, { left, top, width: right - left, height: bottom - top }, FACE_CROP_MAX_SIDE, FACE_CROP_QUALITY);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Let in-flight work finish before releasing native sessions.
    while (this.limiter.inFlight > 0) await new Promise((r) => setTimeout(r, 10));
    await Promise.allSettled([this.detector.release(), this.recognizer.release()]);
  }
}

/** Load both models once and return the analysis service. */
export function createVisionService(opts: VisionServiceOptions = {}): Promise<OnnxVisionService> {
  return OnnxVisionService.create(opts);
}

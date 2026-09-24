/**
 * The analysis pipeline itself: YuNet face detection + SFace embeddings on onnxruntime-node (CPU), plus
 * decoding, letterboxing, alignment, quality statistics and face crops.
 *
 * `InferenceSession.run()` of onnxruntime-node is SYNCHRONOUS: it blocks the calling JS thread for the
 * whole inference (the intra-op pool only splits the work). So an engine must never run on the server's
 * main thread under load: service.ts runs one engine per worker thread (worker.ts) and keeps the event loop
 * free for HTTP / database work. Concurrent calls are safe (in-process mode overlaps decoding and inference).
 */
import { poseFromFivePoints } from '@sp/shared';
import * as ort from 'onnxruntime-node';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { alignFace, type AlignedFace } from './align';
import { DEFAULT_DETECT_THRESHOLD, YUNET_INPUT_SIZE, decodeToDetectedFaces, interEyeDistance, packBgrPlanar, planDetectorInput } from './detect';
import { DEFAULT_MAX_DECODE_SIDE, DETECT_ENHANCE_BLUR_SIGMA, blurRgb, decodeImage, decodeRegion, encodeJpegRegion, enhanceForDetection, resizeRgb, wholeImageStats, type RgbImage } from './image';
import { SFACE_MODEL_FILE, YUNET_MODEL_FILE } from './models';
import { removeInitializersFromInputs } from './onnx-model';
import { DEFAULT_EMBEDDING_RECIPE } from './embeddings';
import { combineViews, l2normalize, recipeViews, type EmbeddingRecipe } from './embed-prep';
import { assessQuality, faceRegionStats, resolveGate } from './quality';
import type { AnalyzeOptions, DetectedFace, HeadPose, ImageAnalysis, QualityGate } from './types';

export interface VisionEngineOptions {
  /** Directory containing the two ONNX files (already resolved). */
  modelsDir: string;
  /** onnxruntime intra-op threads per session. */
  threads: number;
  /** YuNet score threshold (default 0.6). */
  detectThreshold?: number;
  /** Max side of the decoded working image (default 1280). */
  maxDecodeSide?: number;
  /** Engine-wide quality-gate override (per-call `AnalyzeOptions.gate` is applied on top). */
  gate?: Partial<QualityGate>;
  /** How `ImageAnalysis.embedding` is computed (default DEFAULT_EMBEDDING_RECIPE). */
  embedding?: EmbeddingRecipe;
  /**
   * When the detector finds no face, run it again on a denoised, locally contrast-enhanced copy (default true).
   * Dim-room / backlit webcam frames: detection 64 % -> 90 %+ on the simulator (docs/accuracy/identity-v2.md);
   * costs one extra detector pass (~30 ms) on face-less frames only. The enhanced copy is used to find the
   * face; statistics, alignment and the embedding use the original pixels.
   */
  enhanceLowLight?: boolean;
}

/** Faces this small (inter-ocular px in the sampled image) are re-sampled from the full-resolution original. */
const MIN_ALIGN_INTER_EYE = 40;
/** When re-sampling, no need for more than this inter-ocular distance (template is 35 px). */
const MAX_ALIGN_INTER_EYE = 120;
const FACE_CROP_MARGIN = 0.4;
const FACE_CROP_MAX_SIDE = 256;
const FACE_CROP_QUALITY = 85;

/**
 * Load a model with its weights treated as constants (onnx-model.ts): the SFace file lists its initializers as
 * graph inputs, which blocks constant folding (measured: SFace 37 -> 29 ms per face on one thread, identical
 * embeddings). Falls back to loading the file as is if the rewrite fails.
 */
async function createSession(path: string, options: ort.InferenceSession.SessionOptions): Promise<ort.InferenceSession> {
  let model: Uint8Array | null = null;
  try {
    model = removeInitializersFromInputs(await readFile(path)).model;
  } catch {
    model = null;
  }
  return model ? ort.InferenceSession.create(model, options) : ort.InferenceSession.create(path, options);
}

/**
 * Faces found only on the enhanced (low-light) detection pass were not detectable in the original frame: their
 * detector score is capped below the 'fair' quality bucket (calibration.ts), so they count as poor-quality
 * evidence however confident the detector was on the enhanced copy.
 */
export const ENHANCED_DETECTION_MAX_SCORE = 0.79;

function capEnhancedScores(faces: DetectedFace[]): DetectedFace[] {
  return faces.map((f) => (f.score > ENHANCED_DETECTION_MAX_SCORE ? { ...f, score: ENHANCED_DETECTION_MAX_SCORE } : f));
}

export class VisionEngine {
  private readonly gate: QualityGate;
  private readonly detectThreshold: number;
  private readonly maxDecodeSide: number;
  private readonly recipe: EmbeddingRecipe;
  private readonly enhanceLowLight: boolean;
  /** Reusable detector input buffers (4.9 MB each), one per concurrent analysis (in-process mode). */
  private readonly tensorPool: Float32Array[] = [];

  private constructor(
    private readonly detector: ort.InferenceSession,
    private readonly recognizer: ort.InferenceSession,
    opts: VisionEngineOptions,
  ) {
    this.gate = resolveGate(opts.gate);
    this.detectThreshold = opts.detectThreshold ?? DEFAULT_DETECT_THRESHOLD;
    this.maxDecodeSide = opts.maxDecodeSide ?? DEFAULT_MAX_DECODE_SIDE;
    this.recipe = opts.embedding ?? DEFAULT_EMBEDDING_RECIPE;
    this.enhanceLowLight = opts.enhanceLowLight ?? true;
  }

  static async create(opts: VisionEngineOptions): Promise<VisionEngine> {
    const sessionOptions: ort.InferenceSession.SessionOptions = {
      logSeverityLevel: 3,
      intraOpNumThreads: Math.max(1, Math.floor(opts.threads)),
      interOpNumThreads: 1,
      graphOptimizationLevel: 'all',
      executionMode: 'sequential',
      // Several sessions share the CPU: spin-waiting pool threads of one session starve the others (and the
      // event loop / libvips). Measured on 4 cores: detector 15 -> 6 ms, embedder 31 -> 13 ms.
      extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } },
    };
    const [detector, recognizer] = await Promise.all([
      createSession(resolve(opts.modelsDir, YUNET_MODEL_FILE), sessionOptions),
      createSession(resolve(opts.modelsDir, SFACE_MODEL_FILE), sessionOptions),
    ]);
    const engine = new VisionEngine(detector, recognizer, opts);
    await engine.warmUp();
    return engine;
  }

  private async warmUp(): Promise<void> {
    const det = new Float32Array(3 * YUNET_INPUT_SIZE * YUNET_INPUT_SIZE);
    await this.detector.run({ [this.detector.inputNames[0]]: new ort.Tensor('float32', det, [1, 3, YUNET_INPUT_SIZE, YUNET_INPUT_SIZE]) });
    await this.recognizer.run({ [this.recognizer.inputNames[0]]: new ort.Tensor('float32', new Float32Array(3 * 112 * 112), [1, 3, 112, 112]) });
  }

  /** Detect faces only (no alignment / embedding), in original-image coordinates, primary first. */
  async detect(image: Buffer): Promise<DetectedFace[]> {
    const img = await decodeImage(image, this.maxDecodeSide);
    const faces = await this.detectDecoded(img);
    return faces.length === 0 && this.enhanceLowLight ? capEnhancedScores(await this.detectDecoded(img, true)) : faces;
  }

  async analyze(image: Buffer, opts: AnalyzeOptions = {}): Promise<ImageAnalysis> {
    const gate = opts.gate ? resolveGate(opts.gate, this.gate) : this.gate;
    const img = await decodeImage(image, this.maxDecodeSide);
    const whole = wholeImageStats(img);
    let faces = await this.detectDecoded(img);
    if (faces.length === 0 && (opts.enhanceLowLight ?? this.enhanceLowLight)) faces = capEnhancedScores(await this.detectDecoded(img, true));
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
    const embedding = opts.embed && aligned ? await this.embedRecipe(aligned, this.recipe) : null;
    let embeddingVariants: Record<string, Float32Array> | undefined;
    if (opts.embeddingVariants?.length && aligned) {
      embeddingVariants = {};
      for (const r of opts.embeddingVariants) embeddingVariants[r.id] = await this.embedRecipe(aligned, r);
    }
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
      ...(embeddingVariants ? { embeddingVariants } : {}),
    };
  }

  private async detectDecoded(img: RgbImage & { origWidth: number; origHeight: number }, enhanced = false): Promise<DetectedFace[]> {
    const plan = planDetectorInput(img.width, img.height);
    let detImg = plan.resize ? await resizeRgb(img, plan.width, plan.height) : img;
    if (enhanced) detImg = enhanceForDetection(await blurRgb(detImg, DETECT_ENHANCE_BLUR_SIGMA), 6, 3);
    const tensor = packBgrPlanar(detImg, YUNET_INPUT_SIZE, this.tensorPool.pop());
    let outputs: ort.InferenceSession.ReturnType;
    try {
      outputs = await this.detector.run({
        [this.detector.inputNames[0]]: new ort.Tensor('float32', tensor, [1, 3, YUNET_INPUT_SIZE, YUNET_INPUT_SIZE]),
      });
    } finally {
      if (this.tensorPool.length < 4) this.tensorPool.push(tensor);
    }
    return decodeToDetectedFaces(outputs, this.detectThreshold, detImg.width / img.origWidth, detImg.height / img.origHeight);
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

  /** Embedding of an aligned face under a recipe: normalize(sum of the unit embeddings of its views). */
  private async embedRecipe(face: AlignedFace, recipe: EmbeddingRecipe): Promise<Float32Array> {
    const views = recipeViews(face, recipe);
    const units: Float32Array[] = [];
    for (const v of views) units.push(await this.embedInput(v, face.size));
    return units.length === 1 ? units[0] : combineViews(units);
  }

  private async embedInput(input: Float32Array, size: number): Promise<Float32Array> {
    const out = await this.recognizer.run({
      [this.recognizer.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, size, size]),
    });
    const t = out[this.recognizer.outputNames[0]];
    return l2normalize(Float32Array.from(t.data as Float32Array));
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

  /** Release the native sessions. The engine must be idle. */
  async close(): Promise<void> {
    await Promise.allSettled([this.detector.release(), this.recognizer.release()]);
  }
}

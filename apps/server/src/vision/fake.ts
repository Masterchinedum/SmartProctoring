/**
 * Deterministic stand-in for the vision service, for integration tests of the server (no models, no
 * real images). Each analysed "image" is described by a FakeImageSpec, taken from (in order):
 *   1. specs queued with `enqueue()`,
 *   2. a spec embedded in the uploaded buffer with `FakeVisionService.encode(spec)`,
 *   3. the default spec (`defaultSpec` option / `setDefault()`).
 *
 * Embeddings are keyed by `person`: the same person always gets the same unit vector, different
 * people get exactly orthogonal vectors (similarity 0) — rows of a 128x128 Hadamard matrix — and
 * `similarity: s` produces a vector with cosine exactly `s` to that person's vector (and 0 to everyone
 * else), which makes grey-zone / inconclusive outcomes easy to script.
 */
import sharp from 'sharp';
import type { FaceQuality, QualityIssue } from '@sp/shared';
import { VisionInputError } from './image';
import { processIdPhoto } from './id-photo';
import type { AnalyzeOptions, DetectedFace, HeadPose, IdPhotoCapableVisionService, IdPhotoResult, ImageAnalysis, Point } from './types';

export interface FakeImageSpec {
  /** Identity key. Same key => identical embedding. null/undefined (and faces unset) => no face. */
  person?: string | null;
  /** Number of faces in view (default: 1 when `person` is set, else 0). */
  faces?: number;
  yawDeg?: number;
  pitchDeg?: number;
  rollDeg?: number;
  /** Quality-gate outcome. Default: usable when exactly one face, |yaw|,|pitch| <= 25 and no issues. */
  usable?: boolean;
  /** Quality issues to report. Default: derived (no_face / multiple_faces / face_turned; 'blurry' if usable === false). */
  issues?: QualityIssue[];
  /** Cosine similarity of this image's embedding to `person`'s base embedding (default 1). */
  similarity?: number;
  detectionScore?: number;
  brightness?: number;
  sharpness?: number;
  interEyePx?: number;
  /** Whole-image dHash. Default: unique per analysed image (like real camera noise); repeat a value to simulate a frozen / replayed frame. */
  dhash?: string;
  width?: number;
  height?: number;
  /** analyze() rejects with VisionInputError, like a corrupt upload. */
  corrupt?: boolean;
}

export interface FakeVisionOptions {
  defaultSpec?: FakeImageSpec;
  /** Artificial delay per analyze() call, ms. */
  latencyMs?: number;
}

const DIM = 128;
const MARKER = Buffer.from('SPFAKE1:', 'ascii');
const JPEG_SOI = Buffer.from([0xff, 0xd8, 0xff, 0xfe]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

/* ------------------------------------------------------------------ deterministic embeddings */

const rowOf = new Map<string, number>();
const usedRows = new Set<number>();

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function popcount(v: number): number {
  let c = 0;
  while (v) {
    v &= v - 1;
    c++;
  }
  return c;
}

function hadamardRow(key: string): Float32Array {
  let row = rowOf.get(key);
  if (row === undefined) {
    if (usedRows.size >= DIM) throw new Error(`FakeVisionService supports at most ${DIM} distinct embedding keys per process`);
    row = fnv1a(key) % DIM;
    while (usedRows.has(row)) row = (row + 1) % DIM;
    rowOf.set(key, row);
    usedRows.add(row);
  }
  const v = new Float32Array(DIM);
  const s = 1 / Math.sqrt(DIM);
  for (let j = 0; j < DIM; j++) v[j] = popcount(row & j) % 2 ? -s : s;
  return v;
}

/** The embedding the fake produces for `person` (optionally at an exact similarity to the base vector). */
export function fakeEmbedding(person: string, similarity = 1): Float32Array {
  const base = hadamardRow(`person:${person}`);
  const s = Math.max(-1, Math.min(1, similarity));
  if (s === 1) return base;
  const other = hadamardRow(`perturb:${person}`);
  const c = Math.sqrt(Math.max(0, 1 - s * s));
  const e = new Float32Array(DIM);
  for (let j = 0; j < DIM; j++) e[j] = s * base[j] + c * other[j];
  return e;
}

/* ------------------------------------------------------------------------ synthetic geometry */

// 3-D face model (cm): eyes, nose tip (2 cm in front of the eye plane), mouth corners.
const FACE3D = [
  { x: -3.2, y: 0, z: 0 },
  { x: 3.2, y: 0, z: 0 },
  { x: 0, y: 3.5, z: 2.0 },
  { x: -2.4, y: 6.5, z: 1.0 },
  { x: 2.4, y: 6.5, z: 1.0 },
];

/** Landmarks of a synthetic face with the given pose (POSE_CONVENTION), centred at (cx, cy). */
export function syntheticLandmarks(yawDeg: number, pitchDeg: number, cx: number, cy: number, pxPerCm: number): [Point, Point, Point, Point, Point] {
  const y = (yawDeg * Math.PI) / 180;
  const p = (pitchDeg * Math.PI) / 180;
  return FACE3D.map((v) => {
    const x1 = v.x * Math.cos(y) + v.z * Math.sin(y);
    const z1 = -v.x * Math.sin(y) + v.z * Math.cos(y);
    const y2 = v.y * Math.cos(p) - z1 * Math.sin(p);
    return { x: cx + x1 * pxPerCm, y: cy + (y2 - 3.2) * pxPerCm };
  }) as [Point, Point, Point, Point, Point];
}

/* ------------------------------------------------------------------------------ the service */

let dhashCounter = 0;
let cropJpeg: Promise<Buffer> | null = null;
function placeholderCrop(): Promise<Buffer> {
  cropJpeg ??= sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 128, g: 118, b: 110 } } }).jpeg({ quality: 80 }).toBuffer();
  return cropJpeg;
}

/** Build an ImageAnalysis from a spec (synchronous core of FakeVisionService; handy in unit tests). */
export function fakeAnalysis(spec: FakeImageSpec, opts: AnalyzeOptions = {}): ImageAnalysis {
  const width = spec.width ?? 640;
  const height = spec.height ?? 480;
  const n = Math.max(0, Math.floor(spec.faces ?? (spec.person != null ? 1 : 0)));
  const yawDeg = spec.yawDeg ?? 0;
  const pitchDeg = spec.pitchDeg ?? 0;
  const rollDeg = spec.rollDeg ?? 0;
  const pxPerCm = (spec.interEyePx ?? 80) / 6.4;
  const faces: DetectedFace[] = [];
  for (let k = 0; k < n; k++) {
    const cx = width / 2 + (k === 0 ? 0 : (k % 2 ? 1 : -1) * width * 0.3);
    const cy = height / 2;
    const lm = syntheticLandmarks(k === 0 ? yawDeg : 0, k === 0 ? pitchDeg : 0, cx, cy, pxPerCm * (k === 0 ? 1 : 0.8));
    const w = 16 * pxPerCm * (k === 0 ? 1 : 0.8);
    faces.push({ box: { x: cx - w / 2, y: cy - w * 0.6, w, h: w * 1.2 }, score: k === 0 ? (spec.detectionScore ?? 0.92) : 0.85, landmarks: lm });
  }
  const primary = faces[0] ?? null;
  const pose: HeadPose | null = primary ? { yawDeg, pitchDeg, rollDeg } : null;

  let issues: QualityIssue[];
  if (spec.issues) issues = [...spec.issues];
  else {
    issues = [];
    if (n === 0) issues.push('no_face');
    if (n > 1) issues.push('multiple_faces');
    if (n > 0 && (Math.abs(yawDeg) > 25 || Math.abs(pitchDeg) > 25)) issues.push('face_turned');
    if (spec.usable === false && issues.length === 0) issues.push('blurry');
  }
  const usable = issues.length === 0 && (spec.usable ?? true) && n > 0;
  const quality: FaceQuality = {
    faceCount: n,
    detectionScore: primary ? primary.score : 0,
    interEyePx: primary ? (spec.interEyePx ?? 80) : 0,
    faceWidthRatio: primary ? Math.min(1, primary.box.w / width) : 0,
    brightness: spec.brightness ?? 125,
    contrast: 45,
    sharpness: spec.sharpness ?? 450,
    yawDeg: primary ? yawDeg : 0,
    pitchDeg: primary ? pitchDeg : 0,
    cutOff: issues.includes('face_cut_off'),
    issues,
    usable,
  };
  const embedding = opts.embed && primary && spec.person != null ? fakeEmbedding(spec.person, spec.similarity ?? 1) : null;
  const dhash = spec.dhash ?? (((fnv1a(JSON.stringify(spec)) ^ Math.imul(++dhashCounter, 0x9e3779b1)) >>> 0).toString(16).padStart(8, '0') + fnv1a(`${dhashCounter}`).toString(16).padStart(8, '0'));
  return { width, height, faces, primary, pose, quality, embedding, dhash, faceCropJpeg: null, imageBrightness: spec.brightness ?? 125 };
}

export class FakeVisionService implements IdPhotoCapableVisionService {
  private readonly queue: FakeImageSpec[] = [];
  private defaultSpec: FakeImageSpec;
  private readonly latencyMs: number;
  private closed = false;
  /** Every analyze() call, in order. */
  readonly calls: { spec: FakeImageSpec; opts: AnalyzeOptions; at: number }[] = [];

  constructor(options: FakeVisionOptions = {}) {
    this.defaultSpec = options.defaultSpec ?? { person: 'candidate' };
    this.latencyMs = options.latencyMs ?? 0;
  }

  /** A JPEG-looking buffer (SOI + COM segment + EOI) that carries `spec` for the fake to read. */
  static encode(spec: FakeImageSpec): Buffer {
    return Buffer.concat([JPEG_SOI, MARKER, Buffer.from(JSON.stringify(spec), 'utf8'), JPEG_EOI]);
  }

  /** Parse a spec embedded with encode(); null if the buffer does not carry one. */
  static decode(image: Buffer): FakeImageSpec | null {
    const at = image.indexOf(MARKER);
    if (at < 0) return null;
    const end = image.lastIndexOf(JPEG_EOI);
    try {
      return JSON.parse(image.subarray(at + MARKER.length, end > at ? end : image.length).toString('utf8')) as FakeImageSpec;
    } catch {
      return null;
    }
  }

  /** Embedding the fake produces for a person (for seeding references directly in tests). */
  static embeddingFor(person: string, similarity = 1): Float32Array {
    return fakeEmbedding(person, similarity);
  }

  /** Queue specs consumed by the next analyze() calls (FIFO), regardless of the buffer content. */
  enqueue(...specs: FakeImageSpec[]): this {
    this.queue.push(...specs);
    return this;
  }

  setDefault(spec: FakeImageSpec): this {
    this.defaultSpec = spec;
    return this;
  }

  get pending(): number {
    return this.queue.length;
  }

  async analyze(image: Buffer, opts: AnalyzeOptions = {}): Promise<ImageAnalysis> {
    if (this.closed) throw new Error('FakeVisionService closed');
    const spec = this.queue.shift() ?? FakeVisionService.decode(image) ?? this.defaultSpec;
    this.calls.push({ spec, opts, at: Date.now() });
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    if (spec.corrupt) throw new VisionInputError('Unsupported or corrupt image');
    const analysis = fakeAnalysis(spec, opts);
    if (opts.faceCrop && analysis.primary) analysis.faceCropJpeg = await placeholderCrop();
    return analysis;
  }

  processIdPhoto(image: Buffer): Promise<IdPhotoResult> {
    return processIdPhoto(this, image);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

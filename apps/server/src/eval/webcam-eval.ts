/**
 * Webcam-condition evaluation data: renders every source photo of the public identity sets (datasets.ts) as
 * simulated laptop-webcam frames (webcam-sim.ts), analyses them with the vision service, and returns a
 * compact per-frame table (quality measurements, detections and one or more embeddings) that the metrics
 * in webcam-metrics.ts work on. Rendered frames and analyses are cached on disk, so re-scoring is instant.
 *
 * Frame plan (defaults):
 *   enrolment  per identity with >= 2 usable photos: the most frontal photo, 5 frames ("session" jitter) at
 *              640x480 in each of ENROL_CONDITIONS
 *   probes     every usable photo x condition x resolution x scene (2) x burst frame (3, "burst" jitter)
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FaceQuality } from '@sp/shared';
import type { DetectedFace, QualityGate, VisionService } from '../vision/types';
import type { EmbeddingRecipe } from '../vision/embed-prep';
import { DEFAULT_EMBEDDING_RECIPE } from '../vision/embeddings';
import { loadFaceset, type LocalFaceset } from './datasets';
import { simulateWebcamFrame, WEBCAM_CONDITIONS, WEBCAM_RESOLUTIONS, type WebcamCondition, type WebcamResolution } from './webcam-sim';

/** Bump when the simulator output changes (invalidates cached frames). */
export const SIM_VERSION = 3;
export const ENROL_CONDITIONS: readonly WebcamCondition[] = ['good', 'typical', 'dim', 'backlit'];

export interface SourcePhoto {
  key: string;
  identity: string;
  family: string | null;
  file: string;
  /** Primary face landmarks and pose in the original photo. */
  landmarks: { x: number; y: number }[];
  yawDeg: number;
  interEyePx: number;
}

export type FrameRole = 'enrol' | 'probe' | 'room';

export interface FrameJob {
  id: string;
  photo: SourcePhoto;
  /**
   * 'enrol': check-in frames; 'probe': independent scenes (another room / light / placement); 'room': a person
   * captured in the SAME scene (room, camera, light) as `host`'s enrolment — mid-exam continuity, and an impostor
   * sitting down in the candidate's room.
   */
  role: FrameRole;
  condition: WebcamCondition;
  resolution: WebcamResolution;
  scene: number;
  frame: number;
  /** role 'room': the enrolment photo whose scene is reused. */
  host?: SourcePhoto;
}

export interface FrameRecord {
  id: string;
  photoKey: string;
  identity: string;
  family: string | null;
  role: FrameRole;
  /** role 'room': photo key of the host enrolment whose scene was reused. */
  hostPhotoKey?: string;
  condition: WebcamCondition;
  resolution: WebcamResolution;
  scene: number;
  frame: number;
  width: number;
  height: number;
  faces: DetectedFace[];
  quality: FaceQuality;
  pose: { yawDeg: number; pitchDeg: number; rollDeg: number } | null;
  /** Simulated capture parameters (inter-eye px, face luma, noise ...). */
  sim: Record<string, number | string>;
  /** recipe id -> embedding (null when no face). */
  embeddings: Record<string, Float32Array> | null;
  analyzeMs: number;
}

export interface WebcamDataOptions {
  facesetDir?: string;
  /** Frame cache directory (default <facesetDir>/_frames). */
  framesDir?: string;
  conditions?: readonly WebcamCondition[];
  resolutions?: readonly WebcamResolution[];
  scenes?: number;
  burst?: number;
  enrolFrames?: number;
  enrolConditions?: readonly WebcamCondition[];
  /** Embedding recipes to compute for every frame (the first one is also `analysis.embedding`'s recipe id alias 'default'). */
  recipes?: readonly EmbeddingRecipe[];
  /** Permissive gate used for analysis (issues are re-derived later per pipeline). */
  gate?: Partial<QualityGate>;
  /** Render/analyse only jobs with index % shardCount === shardIndex (parallel prerendering). */
  shard?: { index: number; count: number };
  /** Limit identities (quick runs). */
  maxIdentities?: number;
  onProgress?: (msg: string) => void;
  concurrency?: number;
  /** Use cached analyses only (skip frames that were not analysed yet). */
  cachedOnly?: boolean;
  /** Identifies the vision-service configuration in the analysis cache key (e.g. 'v1', 'v2'). */
  engineTag?: string;
  /**
   * Same-room frames (role 'room'): per enrolled identity and condition, the enrolment photo (`genuineBursts`
   * bursts) and the person's other photos (1 burst each) in the enrolment scene, plus 1 burst of each of
   * `impostorsPerHost` other people (seeded choice) and every family member in that same scene.
   */
  room?: { conditions: readonly WebcamCondition[]; impostorsPerHost: number; genuineBursts: number };
  /** Use this analysis-cache key instead of the computed one (re-reading an older cache). */
  cacheKey?: string;
}

/** Deterministic 31-bit seed from a string. */
export function seedOf(s: string): number {
  return createHash('sha256').update(s).digest().readUInt32LE(0) & 0x7fffffff;
}

/** Analyse the original photos (primary face landmarks) and keep those with exactly one clear primary face. */
export async function prepareSources(vision: VisionService, faceset: LocalFaceset, onProgress?: (m: string) => void): Promise<SourcePhoto[]> {
  const out: SourcePhoto[] = [];
  const counters = new Map<string, number>();
  for (const img of faceset.images) {
    const a = await vision.analyze(readFileSync(img.file), {});
    if (!a.primary || !a.pose) {
      onProgress?.(`skip ${img.source}/${img.path}: no face`);
      continue;
    }
    const n = (counters.get(img.identity) ?? 0) + 1;
    counters.set(img.identity, n);
    const [l, r] = a.primary.landmarks;
    out.push({
      key: `${img.identity}#${n}`,
      identity: img.identity,
      family: img.family ?? null,
      file: img.file,
      landmarks: a.primary.landmarks.map((p) => ({ x: p.x, y: p.y })),
      yawDeg: a.pose.yawDeg,
      interEyePx: Math.hypot(r.x - l.x, r.y - l.y),
    });
  }
  return out;
}

/** Enrolment photo of an identity: the most frontal one (a candidate faces the camera at check-in). */
export function enrolmentPhoto(photos: readonly SourcePhoto[]): SourcePhoto {
  return [...photos].sort((a, b) => Math.abs(a.yawDeg) - Math.abs(b.yawDeg) || a.key.localeCompare(b.key))[0];
}

export function planFrames(sources: readonly SourcePhoto[], opts: WebcamDataOptions = {}): FrameJob[] {
  const conditions = opts.conditions ?? WEBCAM_CONDITIONS;
  const resolutions = opts.resolutions ?? WEBCAM_RESOLUTIONS;
  const scenes = opts.scenes ?? 2;
  const burst = opts.burst ?? 3;
  const enrolFrames = opts.enrolFrames ?? 5;
  const enrolConditions = opts.enrolConditions ?? ENROL_CONDITIONS;
  const byId = new Map<string, SourcePhoto[]>();
  for (const s of sources) byId.set(s.identity, [...(byId.get(s.identity) ?? []), s]);
  let ids = [...byId.keys()];
  if (opts.maxIdentities) ids = ids.slice(0, opts.maxIdentities);
  const keep = new Set(ids);
  const jobs: FrameJob[] = [];
  for (const id of ids) {
    const photos = byId.get(id)!;
    if (photos.length < 2) continue;
    const ref = enrolmentPhoto(photos);
    for (const c of enrolConditions) {
      for (let f = 0; f < enrolFrames; f++) {
        jobs.push({ id: `enrol|${ref.key}|${c}|640x480|0|${f}`, photo: ref, role: 'enrol', condition: c, resolution: '640x480', scene: 0, frame: f });
      }
    }
  }
  if (opts.room) {
    const enrolled = ids.filter((id) => byId.get(id)!.length >= 2);
    const refOf = (id: string) => enrolmentPhoto(byId.get(id)!);
    const push = (host: SourcePhoto, photo: SourcePhoto, c: WebcamCondition, bursts: number) => {
      for (let sc = 1; sc <= bursts; sc++) {
        for (let f = 0; f < burst; f++) {
          jobs.push({ id: `room|${host.key}|${photo.key}|${c}|640x480|${sc}|${f}`, photo, host, role: 'room', condition: c, resolution: '640x480', scene: sc, frame: f });
        }
      }
    };
    for (const id of enrolled) {
      const host = refOf(id);
      const others = ids.filter((o) => o !== id);
      // Seeded choice of impostors for this host (stable across runs), plus every family member.
      const ranked = [...others].sort((a, b) => seedOf(`${id}|${a}`) - seedOf(`${id}|${b}`));
      const family = others.filter((o) => host.family && byId.get(o)![0].family === host.family);
      const chosen = [...new Set([...family, ...ranked.slice(0, opts.room.impostorsPerHost)])];
      for (const c of opts.room.conditions) {
        push(host, host, c, opts.room.genuineBursts);
        for (const p of byId.get(id)!) if (p.key !== host.key) push(host, p, c, 1);
        for (const o of chosen) push(host, enrolmentPhoto(byId.get(o)!), c, 1);
      }
    }
  }
  for (const p of sources) {
    if (!keep.has(p.identity)) continue;
    for (const c of conditions) {
      for (const r of resolutions) {
        for (let sc = 1; sc <= scenes; sc++) {
          for (let f = 0; f < burst; f++) jobs.push({ id: `probe|${p.key}|${c}|${r}|${sc}|${f}`, photo: p, role: 'probe', condition: c, resolution: r, scene: sc, frame: f });
        }
      }
    }
  }
  return jobs;
}

function framePath(dir: string, job: FrameJob): string {
  const safe = (k: string) => k.replace(/[^a-zA-Z0-9_-]+/g, '_');
  const role = job.role === 'room' ? `room-${safe(job.host!.key)}` : job.role;
  return join(dir, `v${SIM_VERSION}`, safe(job.photo.key), `${role}-${job.condition}-${job.resolution}-s${job.scene}-f${job.frame}.jpg`);
}

/** Scene seed of a job: 'room' frames reuse the host's enrolment scene (same room, camera and light). */
function sceneSeedOf(job: FrameJob): number {
  if (job.role === 'room') return seedOf(`enrol|${job.host!.key}|${job.condition}|${job.resolution}|0`);
  return seedOf(`${job.role}|${job.photo.key}|${job.condition}|${job.resolution}|${job.scene}`);
}

/** Simulated JPEG for a job (rendered once, then read from the cache). */
export async function renderJob(dir: string, job: FrameJob, srcCache: Map<string, Buffer>): Promise<{ jpeg: Buffer; params: Record<string, number | string> }> {
  const file = framePath(dir, job);
  const meta = file.replace(/\.jpg$/, '.json');
  if (existsSync(file) && existsSync(meta)) return { jpeg: readFileSync(file), params: JSON.parse(readFileSync(meta, 'utf8')) };
  let src = srcCache.get(job.photo.file);
  if (!src) {
    src = readFileSync(job.photo.file);
    srcCache.set(job.photo.file, src);
    if (srcCache.size > 32) srcCache.delete(srcCache.keys().next().value!);
  }
  const fr = await simulateWebcamFrame(src, { landmarks: job.photo.landmarks }, {
    condition: job.condition,
    resolution: job.resolution,
    sceneSeed: sceneSeedOf(job),
    // Room frames: new frame noise and the small movements of a seated person (distinct from the enrolment frames).
    frameSeed: job.role === 'room' ? 100 + 10 * job.scene + job.frame : job.frame,
    jitter: job.role === 'probe' ? 'burst' : 'session',
  });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, fr.jpeg);
  writeFileSync(meta, JSON.stringify(fr.params));
  return { jpeg: fr.jpeg, params: fr.params };
}

/* ------------------------------------------------------------------------------ analysis cache */

export function pipelineKey(opts: WebcamDataOptions): string {
  const recipes = (opts.recipes ?? []).map((r) => `${r.id}:${r.normalize}:${r.flip}`).join(',');
  return createHash('sha256')
    .update(
      JSON.stringify({
        SIM_VERSION,
        recipes,
        gate: opts.gate ?? {},
        ...(opts.engineTag ? { engine: opts.engineTag } : {}),
        // The v1 engine pins its own recipe; every other configuration embeds with the current default.
        ...(opts.engineTag === 'v1' ? {} : { def: `${DEFAULT_EMBEDDING_RECIPE.id}:${DEFAULT_EMBEDDING_RECIPE.normalize}:${DEFAULT_EMBEDDING_RECIPE.flip}:${JSON.stringify(DEFAULT_EMBEDDING_RECIPE.poor ?? null)}` }),
      }),
    )
    .digest('hex')
    .slice(0, 12);
}

interface CachedRecord extends Omit<FrameRecord, 'embeddings'> {
  embeddings: Record<string, string> | null;
}

const f32ToB64 = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
const b64ToF32 = (s: string) => {
  const b = Buffer.from(s, 'base64');
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

function loadCache(file: string): Map<string, FrameRecord> {
  const m = new Map<string, FrameRecord>();
  if (!existsSync(file)) return m;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as CachedRecord;
      const emb = r.embeddings ? Object.fromEntries(Object.entries(r.embeddings).map(([k, v]) => [k, b64ToF32(v)])) : null;
      m.set(r.id, { ...r, embeddings: emb });
    } catch {
      // ignore a torn line
    }
  }
  return m;
}

function serializeRecord(r: FrameRecord): string {
  const c: CachedRecord = { ...r, embeddings: r.embeddings ? Object.fromEntries(Object.entries(r.embeddings).map(([k, v]) => [k, f32ToB64(v)])) : null };
  return JSON.stringify(c);
}

export interface WebcamData {
  sources: SourcePhoto[];
  records: FrameRecord[];
  recipes: string[];
  facesetDir: string;
  pipelineKey: string;
}

/**
 * Render (cached) and analyse (cached) every planned frame. The vision service should use a permissive gate
 * (`opts.gate`) — issues are re-derived by each pipeline under evaluation.
 */
export async function buildWebcamData(vision: VisionService, opts: WebcamDataOptions = {}): Promise<WebcamData> {
  const faceset = loadFaceset(opts.facesetDir);
  if (faceset.images.length === 0) throw new Error(`No images in ${faceset.dir}. Run: pnpm --filter @sp/server eval:fetch-faces`);
  const framesDir = opts.framesDir ?? join(faceset.dir, '_frames');
  const log = opts.onProgress ?? (() => {});
  const sourcesFile = join(framesDir, `sources-v${SIM_VERSION}.json`);
  let sources: SourcePhoto[];
  if (existsSync(sourcesFile)) {
    sources = (JSON.parse(readFileSync(sourcesFile, 'utf8')) as SourcePhoto[]).map((s) => ({ ...s, file: join(faceset.dir, s.file) }));
  } else {
    sources = await prepareSources(vision, faceset, log);
    mkdirSync(framesDir, { recursive: true });
    writeFileSync(sourcesFile, JSON.stringify(sources.map((s) => ({ ...s, file: s.file.slice(faceset.dir.length + 1) }))));
  }
  const jobs = planFrames(sources, opts).filter((_, i) => !opts.shard || i % opts.shard.count === opts.shard.index);
  const key = opts.cacheKey ?? pipelineKey(opts);
  const cacheFile = join(framesDir, `analysis-${key}${opts.shard ? `-shard${opts.shard.index}` : ''}.jsonl`);
  // Analyses already cached by any earlier run (unsharded file and every shard file of this configuration).
  const cache = loadCache(join(framesDir, `analysis-${key}.jsonl`));
  for (let i = 0; i < 16; i++) {
    const f = join(framesDir, `analysis-${key}-shard${i}.jsonl`);
    if (existsSync(f)) for (const [k, v] of loadCache(f)) if (!cache.has(k)) cache.set(k, v);
  }
  const recipes = opts.recipes ?? [];
  const todo = opts.cachedOnly ? [] : jobs.filter((j) => !cache.has(j.id));
  log(`${jobs.length} frames planned (${sources.length} source photos), ${jobs.length - todo.length} cached, ${todo.length} to render/analyse`);
  const srcCache = new Map<string, Buffer>();
  const pending: string[] = [];
  let done = 0;
  const t0 = Date.now();
  const flush = () => {
    if (pending.length === 0) return;
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, pending.join('\n') + '\n', { flag: 'a' });
    pending.length = 0;
  };
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= todo.length) return;
      const job = todo[i];
      const { jpeg, params } = await renderJob(framesDir, job, srcCache);
      const ta = performance.now();
      const a = await vision.analyze(jpeg, { embed: true, gate: opts.gate, embeddingVariants: recipes.length ? [...recipes] : undefined, priority: 'background' });
      const rec: FrameRecord = {
        id: job.id,
        photoKey: job.photo.key,
        identity: job.photo.identity,
        family: job.photo.family,
        role: job.role,
        ...(job.host ? { hostPhotoKey: job.host.key } : {}),
        condition: job.condition,
        resolution: job.resolution,
        scene: job.scene,
        frame: job.frame,
        width: a.width,
        height: a.height,
        faces: a.faces,
        quality: a.quality,
        pose: a.pose,
        sim: params,
        embeddings: a.embedding ? { default: a.embedding, ...(a.embeddingVariants ?? {}) } : null,
        analyzeMs: Math.round((performance.now() - ta) * 10) / 10,
      };
      cache.set(job.id, rec);
      pending.push(serializeRecord(rec));
      if (pending.length >= 50) flush();
      done++;
      if (done % 250 === 0) log(`${done}/${todo.length} frames (${((Date.now() - t0) / done).toFixed(0)} ms/frame)`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 3) }, worker));
  flush();
  return { sources, records: jobs.map((j) => cache.get(j.id)!).filter(Boolean), recipes: ['default', ...recipes.map((r) => r.id)], facesetDir: faceset.dir, pipelineKey: key };
}

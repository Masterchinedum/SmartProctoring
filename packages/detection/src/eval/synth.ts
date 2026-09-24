import type { CameraState, FaceObservation, FrameMetrics, FrameObservation, NormBox, ObjectObservation } from '@sp/shared';
import { Rng } from './prng';

/**
 * Synthetic FrameObservation traces for offline evaluation and tests.
 *
 * The generator simulates what the browser host would report: a candidate whose head pose follows an
 * Ornstein–Uhlenbeck process around their normal pose (±3–8° jitter), eye gaze noise, occasional
 * reading posture, and a coarse 9×8 "image" (scene + face + body blobs + per-cell noise) from which the
 * frame luma / contrast / dHash / frame difference are derived — so hashes change a little with small
 * movements, a lot with big ones, and never repeat exactly on a live camera. Scripted segments inject
 * the behaviours and faults to detect; random nuisance events (dropped faces, one-frame extra face /
 * phone / dark frame, brief glances < 1 s) must NOT produce events.
 *
 * All times in segments are seconds from the start of the trace.
 */

export interface NoiseOptions {
  /** Stationary std-dev of head yaw / pitch jitter (deg). */
  poseJitterDeg: number;
  /** Gaze noise std-dev (−1..1 units). */
  gazeJitter: number;
  /** Probability per tick that the face landmarker misses the face. */
  dropFaceProb: number;
  /** One-frame spurious extra face, per minute. */
  extraFaceBlipPerMin: number;
  /** One-object-tick spurious phone detection, per minute. */
  phoneBlipPerMin: number;
  /** One-frame dark/garbage frame, per minute. */
  darkFramePerMin: number;
  /** Brief glances (0.3–0.9 s) per minute. */
  briefGlancePerMin: number;
  /** Reading-down posture (−6..−12° for 2–6 s) per minute. */
  readingPerMin: number;
  /** Per-pixel sensor noise → mean abs frame difference of a static scene. */
  sensorNoise: number;
  /** Object detector misses the candidate's 'person' box with this probability. */
  personMissProb: number;
}

export const DEFAULT_NOISE: NoiseOptions = {
  poseJitterDeg: 3.5,
  gazeJitter: 0.07,
  dropFaceProb: 0.004,
  extraFaceBlipPerMin: 0.25,
  phoneBlipPerMin: 0.25,
  darkFramePerMin: 0.25,
  briefGlancePerMin: 1.2,
  readingPerMin: 0.6,
  sensorNoise: 1.2,
  personMissProb: 0.08,
};

export const NO_NOISE: NoiseOptions = {
  poseJitterDeg: 0,
  gazeJitter: 0,
  dropFaceProb: 0,
  extraFaceBlipPerMin: 0,
  phoneBlipPerMin: 0,
  darkFramePerMin: 0,
  briefGlancePerMin: 0,
  readingPerMin: 0,
  sensorNoise: 1.2,
  personMissProb: 0,
};

interface Span {
  start: number;
  end: number;
}

export type Segment =
  /** Turn head (deg offsets from normal pose) and/or eyes. */
  | (Span & { kind: 'look'; yaw?: number; pitch?: number; gazeX?: number; gazeY?: number })
  /** No face (candidate out of view). */
  | (Span & { kind: 'absent' })
  /** Additional face in view. */
  | (Span & { kind: 'extraFace'; box?: NormBox; score?: number })
  /** Additional 'person' boxes from the object detector (count = total persons incl. candidate). */
  | (Span & { kind: 'persons'; count: number; missProb?: number })
  /** Object detector sees an object. */
  | (Span & { kind: 'object'; label: string; score: number; missProb?: number })
  | (Span & { kind: 'covered' })
  | (Span & { kind: 'frozen' })
  | (Span & { kind: 'dark'; luma?: number; faceBrightness?: number; faceMissProb?: number })
  | (Span & { kind: 'bright'; luma?: number; faceBrightness?: number })
  /** Pre-recorded footage (with motion) of `loopSec` played in a loop instead of the live camera. */
  | (Span & { kind: 'replay'; loopSec: number })
  | (Span & { kind: 'camera'; state: Exclude<CameraState, 'live'> })
  /** Move the face centre / size. */
  | (Span & { kind: 'move'; cx?: number; cy?: number; width?: number })
  /** Very still candidate (tiny jitter, no nuisance glances). */
  | (Span & { kind: 'still' })
  /** Face partly out of the image. */
  | (Span & { kind: 'cutoff' })
  /** Face covered / unclear. */
  | (Span & { kind: 'occluded'; visibility?: number })
  /** Person visible to the object detector but no face. */
  | (Span & { kind: 'personNoFace' })
  /** Analysis throughput drop. */
  | (Span & { kind: 'lowFps'; fps: number })
  /** Lively natural motion (head turns within ±20°, gestures). */
  | (Span & { kind: 'motion' });

export interface PersonProfile {
  yaw: number;
  pitch: number;
  cx: number;
  cy: number;
  width: number;
  brightness: number;
}

export interface SynthSpec {
  seed: number;
  durationSec: number;
  /** Face-landmarker tick rate (default 5). */
  fps?: number;
  /** Object detector period (default 1 s). */
  objectEverySec?: number;
  /** Epoch ms of the first tick (default 1.7e12). */
  t0?: number;
  noise?: Partial<NoiseOptions>;
  segments?: Segment[];
  person?: Partial<PersonProfile>;
  /** Seed of the room/background (default: `seed`). Replay clips are recorded in the same room. */
  sceneSeed?: number;
}

export interface SynthTrace {
  t0: number;
  observations: FrameObservation[];
  person: PersonProfile;
}

/* ------------------------------------------------------------------ image model */

const GW = 9;
const GH = 8;

function makeScene(rng: Rng): Float64Array {
  const g = new Float64Array(GW * GH);
  const a = rng.range(-6, 6);
  const b = rng.range(-6, 6);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) g[y * GW + x] = 115 + a * (x - 4) + b * (y - 3.5) + rng.normal(0, 22);
  return g;
}

function addBlob(g: Float64Array, cx: number, cy: number, sx: number, sy: number, amp: number): void {
  for (let y = 0; y < GH; y++) {
    const dy = (y + 0.5 - cy * GH) / Math.max(0.2, sy * GH);
    for (let x = 0; x < GW; x++) {
      const dx = (x + 0.5 - cx * GW) / Math.max(0.2, sx * GW);
      g[y * GW + x] += amp * Math.exp(-0.5 * (dx * dx + dy * dy));
    }
  }
}

function hashGrid(g: Float64Array): string {
  let hi = 0;
  let lo = 0;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const bit = g[row * GW + col] > g[row * GW + col + 1] ? 1 : 0;
      const idx = row * 8 + col;
      if (idx < 32) hi = (hi | (bit << (31 - idx))) >>> 0;
      else lo = (lo | (bit << (63 - idx))) >>> 0;
    }
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

function gridStats(g: Float64Array): { mean: number; std: number } {
  let s = 0;
  let q = 0;
  for (const v of g) {
    s += v;
    q += v * v;
  }
  const mean = s / g.length;
  return { mean, std: Math.sqrt(Math.max(0, q / g.length - mean * mean)) };
}

function flipBits(hash: string, rng: Rng, p: number): string {
  let hi = parseInt(hash.slice(0, 8), 16) >>> 0;
  let lo = parseInt(hash.slice(8), 16) >>> 0;
  for (let i = 0; i < 32; i++) {
    if (rng.chance(p)) hi = (hi ^ (1 << i)) >>> 0;
    if (rng.chance(p)) lo = (lo ^ (1 << i)) >>> 0;
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

/* ------------------------------------------------------------------ person dynamics */

class Ou {
  x: number;
  constructor(
    public mean: number,
    public std: number,
    public theta: number,
    rng: Rng,
  ) {
    this.x = mean + (std > 0 ? rng.normal(0, std) : 0);
  }
  step(dt: number, rng: Rng, mean = this.mean, stdScale = 1): number {
    const sigma = this.std * stdScale * Math.sqrt(2 * this.theta);
    this.x += this.theta * (mean - this.x) * dt + sigma * Math.sqrt(dt) * rng.gauss();
    return this.x;
  }
}

interface Nuisance {
  kind: 'glance' | 'reading';
  start: number;
  end: number;
  yaw: number;
  pitch: number;
}

function active<T extends Segment['kind']>(segs: Segment[], kind: T, s: number): Extract<Segment, { kind: T }>[] {
  return segs.filter((g) => g.kind === kind && s >= g.start && s < g.end) as Extract<Segment, { kind: T }>[];
}

/* ------------------------------------------------------------------ generator */

export function synthesize(spec: SynthSpec): SynthTrace {
  const rng = new Rng(spec.seed);
  const noise: NoiseOptions = { ...DEFAULT_NOISE, ...(spec.noise ?? {}) };
  const segs = spec.segments ?? [];
  const baseFps = spec.fps ?? 5;
  const objEvery = spec.objectEverySec ?? 1;
  const t0 = spec.t0 ?? 1_700_000_000_000;
  const person: PersonProfile = {
    yaw: rng.range(-8, 8),
    pitch: rng.range(-12, 2),
    cx: rng.range(0.44, 0.56),
    cy: rng.range(0.4, 0.5),
    width: rng.range(0.24, 0.32),
    brightness: rng.range(105, 145),
    ...(spec.person ?? {}),
  };
  const scene = makeScene(new Rng(spec.sceneSeed ?? spec.seed));
  const sim = new PersonState(rng, person, noise);

  // Pre-recorded clips for replay segments (same room, same person, lively motion).
  const clips = new Map<Segment, FrameObservation[]>();
  for (const g of segs) {
    if (g.kind !== 'replay') continue;
    const clip = synthesize({
      seed: spec.seed * 7919 + 17,
      durationSec: g.loopSec,
      fps: baseFps,
      objectEverySec: objEvery,
      t0: 0,
      noise: { ...noise, briefGlancePerMin: 0, extraFaceBlipPerMin: 0, phoneBlipPerMin: 0, darkFramePerMin: 0, dropFaceProb: 0 },
      segments: [{ kind: 'motion', start: 0, end: g.loopSec }],
      person,
      sceneSeed: spec.sceneSeed ?? spec.seed,
    }).observations;
    clips.set(g, clip);
  }

  const out: FrameObservation[] = [];
  const nuisances: Nuisance[] = [];
  let s = 0;
  let lastObjS = -Infinity;
  let prevGrid: Float64Array | null = null;
  let lastLive: FrameObservation | null = null;
  let lastObjects: ObjectObservation[] | null = null;

  while (s < spec.durationSec) {
    const lowFps = active(segs, 'lowFps', s)[0];
    const fps = lowFps ? lowFps.fps : baseFps;
    const dt = 1 / fps;
    const t = t0 + Math.round(s * 1000);
    const cam = active(segs, 'camera', s)[0];
    const objectTick = s - lastObjS >= objEvery - 1e-6;
    if (objectTick) lastObjS = s;

    if (cam) {
      out.push({ t, camera: cam.state, frame: null, faces: [], objects: null, fps });
      prevGrid = null;
      lastLive = null;
      s += dt;
      continue;
    }

    // Frozen feed: the same image analysed again (identical results, zero difference).
    if (active(segs, 'frozen', s).length && lastLive && lastLive.frame) {
      out.push({
        t,
        camera: 'live',
        frame: { ...lastLive.frame, diffFromPrev: 0 },
        faces: lastLive.faces.map((f) => ({ ...f, box: { ...f.box } })),
        objects: objectTick ? (lastObjects ?? []).map((o) => ({ ...o, box: { ...o.box } })) : null,
        fps,
      });
      s += dt;
      continue;
    }

    // Replay: pre-recorded footage looped, lightly re-encoded.
    const rep = active(segs, 'replay', s)[0];
    if (rep) {
      const clip = clips.get(rep)!;
      const idx = Math.floor((s - rep.start) * baseFps + 1e-6) % clip.length;
      const src = clip[idx];
      const frame: FrameMetrics | null = src.frame
        ? { ...src.frame, dhash: flipBits(src.frame.dhash, rng, 0.006), diffFromPrev: Math.max(0.3, (src.frame.diffFromPrev ?? 1) + rng.normal(0, 0.15)) }
        : null;
      let objects: ObjectObservation[] | null = null;
      if (objectTick) {
        // Find the nearest object tick in the clip.
        let j = idx;
        while (j >= 0 && clip[j].objects === null) j--;
        objects = (j >= 0 ? clip[j].objects : []) ?? [];
      }
      const obs: FrameObservation = { t, camera: 'live', frame, faces: src.faces.map((f) => ({ ...f, box: { ...f.box } })), objects, fps };
      out.push(obs);
      lastLive = obs;
      if (objectTick) lastObjects = objects;
      prevGrid = null;
      s += dt;
      continue;
    }

    const still = active(segs, 'still', s).length > 0;
    const motion = active(segs, 'motion', s).length > 0;

    // Random nuisance behaviours (not during scripted looks / stillness).
    if (!still) {
      if (rng.poisson(noise.briefGlancePerMin, dt)) {
        const d = rng.range(0.3, 0.9);
        const dir = rng.pick([
          [40, 0],
          [-40, 0],
          [0, -34],
          [30, -26],
          [-30, -26],
        ]);
        nuisances.push({ kind: 'glance', start: s, end: s + d, yaw: dir[0] + rng.normal(0, 4), pitch: dir[1] + rng.normal(0, 3) });
      }
      if (rng.poisson(noise.readingPerMin, dt)) nuisances.push({ kind: 'reading', start: s, end: s + rng.range(2, 6), yaw: rng.normal(0, 3), pitch: rng.range(-12, -6) });
    }
    while (nuisances.length && nuisances[0].end < s - 1) nuisances.shift();

    // Target pose.
    let tYaw = person.yaw;
    let tPitch = person.pitch;
    let tGx = 0;
    let tGy = -0.08;
    const looks = active(segs, 'look', s);
    for (const l of looks) {
      tYaw += l.yaw ?? 0;
      tPitch += l.pitch ?? 0;
      tGx += l.gazeX ?? 0;
      tGy += l.gazeY ?? 0;
    }
    if (!looks.length) {
      for (const n of nuisances) {
        if (s >= n.start && s < n.end) {
          tYaw += n.yaw;
          tPitch += n.pitch;
        }
      }
    }
    const mv = active(segs, 'move', s)[0];
    const tCx = mv?.cx ?? person.cx;
    const tCy = mv?.cy ?? person.cy;
    const tW = mv?.width ?? person.width;
    sim.step(dt, { yaw: tYaw, pitch: tPitch, gx: tGx, gy: tGy, cx: tCx, cy: tCy, w: tW }, still ? 0.12 : 1, motion);

    // Presence.
    const absent = active(segs, 'absent', s).length > 0;
    const noFaceBody = active(segs, 'personNoFace', s).length > 0;
    const dark = active(segs, 'dark', s)[0];
    const bright = active(segs, 'bright', s)[0];
    const covered = active(segs, 'covered', s).length > 0;
    const darkBlip = !covered && rng.poisson(noise.darkFramePerMin, dt);
    const bodyPresent = !absent;
    let facePresent = !absent && !noFaceBody && !rng.chance(noise.dropFaceProb);
    if (dark && rng.chance(dark.faceMissProb ?? 0.25)) facePresent = false;

    // Image.
    const g = new Float64Array(scene);
    if (bodyPresent) {
      const fx = sim.cx + (sim.yawV - person.yaw) * 0.0012;
      const fy = sim.cy - (sim.pitchV - person.pitch) * 0.0012;
      addBlob(g, fx, fy, sim.w * 0.45, sim.w * 0.6, 45);
      addBlob(g, sim.cx, Math.min(0.98, sim.cy + sim.w * 1.6), sim.w * 1.1, sim.w * 0.9, -38);
      if (sim.hand) addBlob(g, sim.hand.x, sim.hand.y, 0.07, 0.09, sim.hand.amp);
    }
    for (let i = 0; i < g.length; i++) g[i] += rng.normal(0, 0.35);
    let frame: FrameMetrics;
    const faceBrightness = dark ? (dark.faceBrightness ?? 30) : bright ? (bright.faceBrightness ?? 242) : sim.brightness;
    if (covered || darkBlip) {
      const cg = new Float64Array(GW * GH);
      for (let i = 0; i < cg.length; i++) cg[i] = 8 + rng.normal(0, 0.6);
      frame = { luma: 8 + rng.normal(0, 0.8), contrast: Math.abs(2 + rng.normal(0, 0.4)), sharpness: 3 + rng.range(0, 2), dhash: hashGrid(cg), diffFromPrev: prevGrid ? 0.5 + rng.range(0, 0.3) : null };
      if (darkBlip && prevGrid) frame.diffFromPrev = 60;
      prevGrid = covered ? cg : null;
      facePresent = false;
    } else {
      const scale = dark ? (dark.luma ?? 28) / 115 : bright ? (bright.luma ?? 232) / 115 : 1;
      const gs = scale === 1 ? g : g.map((v) => v * scale);
      const st = gridStats(gs);
      const motionDiff = prevGrid ? meanAbsDiff(gs, prevGrid) * 0.8 : 0;
      frame = {
        luma: round2(st.mean + rng.normal(0, 0.3)),
        contrast: round2(Math.sqrt(st.std * st.std + (15 * scale) ** 2)),
        sharpness: round2(Math.max(1, (dark ? 25 : 160) + rng.normal(0, dark ? 4 : 15))),
        dhash: hashGrid(gs),
        diffFromPrev: prevGrid ? round2(Math.max(0.2, noise.sensorNoise * scale ** 0.5 + rng.normal(0, 0.12) + motionDiff)) : null,
      };
      prevGrid = gs;
    }

    // Faces.
    const faces: FaceObservation[] = [];
    if (facePresent) faces.push(sim.face(rng, faceBrightness, active(segs, 'cutoff', s).length > 0, active(segs, 'occluded', s)[0]?.visibility ?? null, !!dark));
    const extra = active(segs, 'extraFace', s)[0];
    const extraBlip = !covered && rng.poisson(noise.extraFaceBlipPerMin, dt);
    if (!covered && (extra || extraBlip)) {
      const box = extra?.box ?? { x: rng.range(0.72, 0.8), y: rng.range(0.15, 0.3), w: 0.16, h: 0.24 };
      faces.push({
        box,
        score: extra?.score ?? 0.85,
        yaw: rng.normal(-15, 5),
        pitch: rng.normal(-5, 3),
        roll: 0,
        gazeX: 0,
        gazeY: 0,
        visibility: 0.9,
        cutOff: false,
        brightness: 110,
      });
    }

    // Objects (~1 Hz).
    let objects: ObjectObservation[] | null = null;
    if (objectTick) {
      objects = [];
      if (!covered) {
        if (bodyPresent && !rng.chance(noise.personMissProb)) {
          objects.push({ label: 'person', score: round2(rng.range(0.75, 0.92)), box: { x: Math.max(0, sim.cx - sim.w * 1.1), y: Math.max(0, sim.cy - sim.w), w: Math.min(1, sim.w * 2.2), h: Math.min(1, 1 - (sim.cy - sim.w)) } });
        }
        const ps = active(segs, 'persons', s)[0];
        if (ps) for (let k = 1; k < ps.count; k++) if (!rng.chance(ps.missProb ?? 0.15)) objects.push({ label: 'person', score: round2(rng.range(0.65, 0.85)), box: { x: 0.78 - 0.12 * (k - 1), y: 0.1, w: 0.14, h: 0.5 } });
        for (const o of active(segs, 'object', s)) {
          if (!rng.chance(o.missProb ?? 0.1)) objects.push({ label: o.label, score: round2(Math.min(0.99, Math.max(0.05, o.score + rng.normal(0, 0.05)))), box: { x: 0.15, y: 0.6, w: 0.12, h: 0.18 } });
        }
        if (rng.poisson(noise.phoneBlipPerMin, objEvery)) objects.push({ label: 'cell phone', score: round2(rng.range(0.55, 0.75)), box: { x: 0.2, y: 0.7, w: 0.08, h: 0.12 } });
      }
      lastObjects = objects;
    }

    const obs: FrameObservation = { t, camera: 'live', frame, faces, objects, fps };
    out.push(obs);
    lastLive = obs;
    s += dt;
  }
  return { t0, observations: out, person };
}

class PersonState {
  yaw: Ou;
  pitch: Ou;
  gx: Ou;
  gy: Ou;
  cxOu: Ou;
  cyOu: Ou;
  wOu: Ou;
  // Smoothed targets (head turns take ~0.15 s).
  sy: number;
  sp: number;
  sgx = 0;
  sgy = -0.08;
  brightness: number;
  hand: { x: number; y: number; amp: number } | null = null;
  cx: number;
  cy: number;
  w: number;
  yawV: number;
  pitchV: number;
  gazeX = 0;
  gazeY = -0.08;
  private motionTarget = { yaw: 0, pitch: 0, cx: 0, until: 0 };
  private tAcc = 0;

  constructor(
    private rng: Rng,
    p: PersonProfile,
    noise: NoiseOptions,
  ) {
    this.yaw = new Ou(0, noise.poseJitterDeg, 1.2, rng);
    this.pitch = new Ou(0, noise.poseJitterDeg * 0.75, 1.2, rng);
    this.gx = new Ou(0, noise.gazeJitter, 2, rng);
    this.gy = new Ou(0, noise.gazeJitter, 2, rng);
    this.cxOu = new Ou(0, 0.008, 0.3, rng);
    this.cyOu = new Ou(0, 0.006, 0.3, rng);
    this.wOu = new Ou(0, 0.006, 0.3, rng);
    this.sy = p.yaw;
    this.sp = p.pitch;
    this.brightness = p.brightness;
    this.cx = p.cx;
    this.cy = p.cy;
    this.w = p.width;
    this.yawV = p.yaw;
    this.pitchV = p.pitch;
  }

  step(dt: number, tg: { yaw: number; pitch: number; gx: number; gy: number; cx: number; cy: number; w: number }, jitter: number, motion: boolean): void {
    const r = this.rng;
    this.tAcc += dt;
    let { yaw, pitch, cx } = tg;
    if (motion) {
      if (this.tAcc >= this.motionTarget.until) {
        // Leaning, shifting and gesturing: visible whole-image changes every 1–2.5 s.
        this.motionTarget = { yaw: r.range(-18, 18), pitch: r.range(-10, 8), cx: r.range(-0.09, 0.09), until: this.tAcc + r.range(1, 2.5) };
        this.hand = r.chance(0.6) ? { x: r.range(0.15, 0.85), y: r.range(0.45, 0.9), amp: r.pick([-1, 1]) * r.range(50, 90) } : null;
      }
      yaw += this.motionTarget.yaw;
      pitch += this.motionTarget.pitch;
      cx += this.motionTarget.cx;
    } else this.hand = null;
    const a = Math.min(1, dt / 0.15);
    this.sy += (yaw - this.sy) * a;
    this.sp += (pitch - this.sp) * a;
    this.sgx += (tg.gx - this.sgx) * a;
    this.sgy += (tg.gy - this.sgy) * a;
    this.yawV = this.sy + this.yaw.step(dt, r, 0, jitter) + r.normal(0, 0.8 * jitter);
    this.pitchV = this.sp + this.pitch.step(dt, r, 0, jitter) + r.normal(0, 0.8 * jitter);
    this.gazeX = this.sgx + this.gx.step(dt, r, 0, jitter);
    this.gazeY = this.sgy + this.gy.step(dt, r, 0, jitter);
    const ca = Math.min(1, dt / (motion ? 0.25 : 0.6));
    this.cx += (cx + this.cxOu.step(dt, r, 0, jitter) - this.cx) * ca;
    this.cy += (tg.cy + this.cyOu.step(dt, r, 0, jitter) - this.cy) * ca;
    this.w += (tg.w + this.wOu.step(dt, r, 0, jitter) - this.w) * ca;
  }

  face(rng: Rng, brightness: number, cutOff: boolean, occludedVis: number | null, dark: boolean): FaceObservation {
    const w = this.w;
    const h = w * 1.5;
    let x = this.cx - w / 2;
    let vis = Math.min(1, Math.max(0, rng.normal(0.95, 0.02)));
    if (cutOff) {
      x = 1 - w * 0.6; // 40 % of the face outside the right edge
      vis = 0.62;
    }
    if (occludedVis !== null) vis = Math.min(vis, occludedVis + rng.normal(0, 0.03));
    if (dark) vis = Math.min(vis, 0.5 + rng.normal(0, 0.05));
    const box = { x: Math.max(0, x), y: Math.max(0, this.cy - h / 2), w: cutOff ? 1 - Math.max(0, x) : w, h };
    return {
      box,
      score: round2(Math.min(0.99, rng.normal(0.93, 0.02))),
      yaw: round2(this.yawV),
      pitch: round2(this.pitchV),
      roll: round2(rng.normal(0, 2)),
      gazeX: round3(Math.max(-1, Math.min(1, this.gazeX))),
      gazeY: round3(Math.max(-1, Math.min(1, this.gazeY))),
      visibility: round3(vis),
      cutOff,
      brightness: round2(brightness + rng.normal(0, 2)),
    };
  }
}

function meanAbsDiff(a: Float64Array, b: Float64Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * Builds REALISTIC fake-camera videos (Y4M) for the e2e suite from the vision team's laptop-webcam simulator
 * (apps/server/src/eval/webcam-sim.ts). Called by lib/realistic.ts `ensureRealisticFixtures` with a job file:
 *
 *   tsx scripts/make-realistic.ts <job.json>
 *   job = { facesetsDir, cacheDir, people: {id: {file}}, scenes: {id: {sceneSeed, resolution, interEye720}},
 *           fixtures: [{ name, out, spec: RwFixtureSpec }] }
 *
 * How a video is made:
 *  1. Source photo → YuNet landmarks → a crop around the head and shoulders (≤ 150 px inter-eye).
 *  2. webcam-sim renders the person in the scene's room under the condition (exposure, noise, blur, colour, JPEG),
 *     K frames with different frame seeds (independent noise, ±1 px / ±0.5° burst jitter); the EMPTY room is
 *     rendered with the same scene seed (same room, light and camera).
 *  3. A person layer = the rendered frame × a head-and-shoulders mask (webcam-sim's own geometry, located from
 *     the landmarks YuNet finds in the render). The room plate is exposure-matched to the person frame.
 *  4. Every video frame composes the room and the person layer(s) at the current offset: natural sway
 *     (a few px of head / body movement), leaving (moving up and out), sitting down, sliding, cross-dissolves
 *     (lighting changes, no-gap swaps), plus fresh sensor noise so no two frames are identical.
 *  5. Head turns (active liveness, glances): the SOURCE photo is warped (nose-vs-eyes parallax, as in
 *     synth-headturn.ts) before rendering, so the turn goes through the same webcam degradation.
 *
 * Output: YUV4MPEG2 C420 at the scene's resolution (Chromium delivers the file's own size to the app).
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { createVisionService } from '../../apps/server/src/vision/index.js';
import { simulateWebcamFrame } from '../../apps/server/src/eval/webcam-sim.js';
import type { RwCondition, RwFixtureSpec, RwSegment, Shot } from '../lib/realistic';

interface Job {
  facesetsDir: string;
  cacheDir: string;
  people: Record<string, { file: string }>;
  scenes: Record<string, { sceneSeed: number; resolution: '1280x720' | '640x480'; interEye720: number }>;
  fixtures: { name: string; out: string; spec: RwFixtureSpec }[];
}

type Pt = { x: number; y: number };
type Vision = Awaited<ReturnType<typeof createVisionService>>;

const job: Job = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
mkdirSync(job.cacheDir, { recursive: true });
const SIM_SRC = readFileSync(new URL('../../apps/server/src/eval/webcam-sim.ts', import.meta.url));
const SIM_HASH = createHash('sha256').update(SIM_SRC).digest('hex').slice(0, 12);
/** Distinct rendered frames per (person, scene, condition, pose): cycled, with fresh noise on top. */
const K_STEADY = 6;
const K_TURN = 2;
/**
 * A full liveness turn: the warp amplitude (nose shift in inter-ocular units) is calibrated PER PERSON and
 * direction so that YuNet measures ±TURN_DEG of yaw relative to the unwarped photo — what a candidate asked to
 * "turn your head" does (a fixed amplitude gave +25° / −16° on an already slightly turned photo).
 */
const TURN_DEG = 25;
/** Sideways head translation at a full turn (inter-ocular units). */
const HEAD_SHIFT = 0.25;
/** Glances: this fraction of a full turn (≈ ±6°). */
const GLANCE_FRAC = 0.25;

let vision: Vision;
const log = (m: string) => console.log(`[make-realistic] ${m}`);

/* ------------------------------------------------------------------------------------ sources */

interface Source {
  jpeg: Buffer;
  rgb: Buffer;
  w: number;
  h: number;
  landmarks: Pt[];
  ie: number;
}
const sources = new Map<string, Promise<Source>>();

function source(who: string): Promise<Source> {
  let p = sources.get(who);
  if (!p) sources.set(who, (p = loadSource(who)));
  return p;
}

async function loadSource(who: string): Promise<Source> {
  const file = join(job.facesetsDir, job.people[who]!.file);
  const buf = readFileSync(file);
  const a = await vision.analyze(buf, {});
  if (!a.primary) throw new Error(`no face in ${file}`);
  const lm = a.primary.landmarks;
  const ie = Math.hypot(lm[1].x - lm[0].x, lm[1].y - lm[0].y);
  const mx = (lm[0].x + lm[1].x) / 2;
  const my = (lm[0].y + lm[1].y) / 2;
  const left = Math.max(0, Math.floor(mx - 2.8 * ie));
  const top = Math.max(0, Math.floor(my - 2.3 * ie));
  const right = Math.min(a.width, Math.ceil(mx + 2.8 * ie));
  const bottom = Math.min(a.height, Math.ceil(my + 4.6 * ie));
  const scale = Math.min(1, 150 / ie);
  const w = Math.max(8, Math.round((right - left) * scale));
  const h = Math.max(8, Math.round((bottom - top) * scale));
  const { data } = await sharp(buf).rotate().extract({ left, top, width: right - left, height: bottom - top }).resize(w, h, { fit: 'fill', kernel: 'lanczos3' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const jpeg = await sharp(data, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 96 }).toBuffer();
  const landmarks = lm.map((p) => ({ x: (p.x - left) * scale, y: (p.y - top) * scale }));
  return { jpeg, rgb: data, w, h, landmarks, ie: ie * scale };
}

/**
 * A head pose: `amp` = warp amplitude of the source photo (nose shift in inter-ocular units, > 0 = subject's left);
 * `mirror` = the rendered LEFT turn by `amp`, mirrored about the eye midpoint when composed — used for right turns
 * where the warp saturates on that side of an (already slightly turned) photo. The embedding is flip-invariant (flip
 * test-time augmentation), so the mirrored face is the same identity for the server; pose estimators see an
 * ordinary right turn of the same magnitude as the left one.
 */
interface TurnPose {
  amp: number;
  mirror: boolean;
}
const FRONTAL: TurnPose = { amp: 0, mirror: false };

/** Head turn on the source photo: shift the nose region (and a little of the face) sideways relative to the eyes. */
const warpCache = new Map<string, Promise<{ jpeg: Buffer; landmarks: Pt[] }>>();
function warpedSource(who: string, amp: number): Promise<{ jpeg: Buffer; landmarks: Pt[] }> {
  const key = `${who}:${amp.toFixed(2)}`;
  let p = warpCache.get(key);
  if (!p) {
    p = (async () => ({ jpeg: await makeWarp(who, amp), landmarks: (await source(who)).landmarks }))();
    warpCache.set(key, p);
  }
  return p;
}

async function makeWarp(who: string, amp: number): Promise<Buffer> {
  const s = await source(who);
  if (Math.abs(amp) < 1e-6) return s.jpeg;
  const { w: W, h: H, rgb: data, ie: iod } = s;
  const nose = s.landmarks[2];
  const res = Buffer.alloc(W * H * 3);
  const r = iod * 0.9;
  const faceR = iod * 1.8;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - nose.x;
      const dy = y - nose.y;
      const noseShift = amp * iod * Math.exp((-(dx * dx + dy * dy * 0.6) / (r * r)) * 1.5);
      const faceShift = amp * iod * 0.35 * Math.exp((-(dx * dx + dy * dy) / (faceR * faceR)) * 1.2);
      const sx = x - noseShift - faceShift;
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const xa = Math.min(W - 1, Math.max(0, x0));
      const xb = Math.min(W - 1, Math.max(0, x0 + 1));
      const o = (y * W + x) * 3;
      for (let c = 0; c < 3; c++) res[o + c] = Math.round(data[(y * W + xa) * 3 + c] * (1 - fx) + data[(y * W + xb) * 3 + c] * fx);
    }
  }
  return sharp(res, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 96 }).toBuffer();
}

/**
 * Warp amplitudes giving +TURN_DEG (subject's left, yaw+) and −TURN_DEG of yaw, measured by YuNet on the RENDERED
 * webcam frame of `who` in `scene` (good light) — the webcam's downscale / blur shrink the measured turn.
 */
interface TurnCalibration {
  left: number;
  right: number;
  /** Right turns use the mirrored left turn (the warp could not reach the target to the right). */
  rightMirror: boolean;
  yaw0: number;
}
const turnCache = new Map<string, Promise<TurnCalibration>>();
function turnAmps(who: string, scene: string): Promise<TurnCalibration> {
  const key = `${who}/${scene}`;
  let p = turnCache.get(key);
  if (!p) {
    p = (async () => {
      const yawAt = async (amp: number) => {
        const r = await render(who, scene, 'good', { amp, mirror: false }, 0);
        const jpeg = await sharp(r.rgb, { raw: { width: r.w, height: r.h, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
        return (await vision.analyze(jpeg, {})).pose?.yawDeg ?? NaN;
      };
      const yaw0 = await yawAt(0);
      // The warp's measured yaw is not monotonic for every photo (hair / expression): scan, take the smallest
      // amplitude reaching the target, else the one with the largest turn.
      const solve = async (dir: 1 | -1) => {
        let best = { amp: 0.05, d: -Infinity };
        for (let a = 0.05; a <= 0.6 + 1e-9; a += 0.05) {
          const amp = Math.round(a * 100) / 100;
          const d = dir * ((await yawAt(dir * amp)) - yaw0);
          if (!Number.isFinite(d)) continue;
          if (d >= TURN_DEG) return { amp: dir * amp, reached: true };
          if (d > best.d) best = { amp, d };
        }
        log(`head-turn for ${who} in ${scene} (${dir > 0 ? 'left' : 'right'}): target ${TURN_DEG}° not reached (at most ${best.d.toFixed(1)}°)`);
        return { amp: dir * best.amp, reached: false };
      };
      const left = await solve(1);
      const right = await solve(-1);
      const r: TurnCalibration = { left: left.amp, right: right.reached || !left.reached ? right.amp : -left.amp, rightMirror: !right.reached && left.reached, yaw0 };
      log(`head-turn amplitudes for ${who} in ${scene}: left ${r.left}, right ${r.rightMirror ? `mirrored left ${-r.right}` : r.right} (frontal yaw ${yaw0.toFixed(1)}°, target ±${TURN_DEG}°)`);
      return r;
    })();
    turnCache.set(key, p);
  }
  return p;
}

/** Head pose for a normalised turn u ∈ [-1, 1] (u > 0 = subject's left), amplitude quantised to 0.01. */
async function ampFor(s: Shot, u: number): Promise<TurnPose> {
  if (Math.abs(u) < 1e-6) return FRONTAL;
  const t = await turnAmps(s.who, s.scene);
  if (u > 0) return { amp: Math.round(u * t.left * 100) / 100, mirror: false };
  if (t.rightMirror) return { amp: Math.round(-u * -t.right * 100) / 100, mirror: true };
  return { amp: Math.round(-u * t.right * 100) / 100, mirror: false };
}

/* ------------------------------------------------------------------------------------ renders */

interface Raster {
  rgb: Buffer;
  w: number;
  h: number;
}

const renderCache = new Map<string, Promise<Raster>>();

async function decodeRaster(jpeg: Buffer): Promise<Raster> {
  const { data, info } = await sharp(jpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgb: data, w: info.width, h: info.height };
}

/** One webcam-sim render (cached on disk): person `who` (or the empty room when who = null) in head pose `pose`. */
function render(who: string | null, scene: string, cond: RwCondition, pose: TurnPose, frameSeed: number): Promise<Raster> {
  if (pose.mirror) throw new Error('render(): mirrored poses are composed from the left turn (paint mirror)');
  const sc = job.scenes[scene]!;
  const srcFile = who ? join(job.facesetsDir, job.people[who]!.file) : '';
  const key = createHash('sha256')
    .update(JSON.stringify({ who, file: job.people[who ?? '']?.file ?? null, mtime: who ? String(readFileSync(srcFile).length) : '', sc, cond, amp: pose.amp.toFixed(2), frameSeed, SIM_HASH, v: 2 }))
    .digest('hex')
    .slice(0, 24);
  let p = renderCache.get(key);
  if (p) return p;
  p = (async () => {
    const file = join(job.cacheDir, `${key}.jpg`);
    if (existsSync(file)) return decodeRaster(readFileSync(file));
    const s = await source(who ?? firstPerson());
    const w = who ? await warpedSource(who, pose.amp) : null;
    const src = w ? w.jpeg : s.jpeg;
    // The empty room: the same scene with the subject placed far outside the source image.
    const landmarks = w ? w.landmarks : s.landmarks.map((q) => ({ x: q.x + 1e6, y: q.y + 1e6 }));
    const fr = await simulateWebcamFrame(src, { landmarks }, { condition: cond, resolution: sc.resolution, sceneSeed: sc.sceneSeed, frameSeed, interEye720: sc.interEye720, jitter: 'burst' });
    writeFileSync(file, fr.jpeg);
    if (who && frameSeed % 100 === 1 && Math.abs(pose.amp) < 1e-6) renderParams.set(`${who}/${scene}/${cond}`, fr.params);
    return decodeRaster(fr.jpeg);
  })();
  renderCache.set(key, p);
  return p;
}
const renderParams = new Map<string, unknown>();

function firstPerson(): string {
  return Object.keys(job.people)[0]!;
}

/* ------------------------------------------------------------------------------------ person layers */

interface Layer {
  /** Head-and-shoulders mask 0..1 (float, output resolution). */
  mask: Float32Array;
  eyeMid: Pt;
  ie: number;
}
const layerCache = new Map<string, Promise<Layer>>();

/** Mask of `who` in `scene` (same placement in every condition: located on the 'good' render). */
function layerOf(who: string, scene: string): Promise<Layer> {
  const key = `${who}/${scene}`;
  let p = layerCache.get(key);
  if (!p) layerCache.set(key, (p = makeLayer(who, scene)));
  return p;
}

async function makeLayer(who: string, scene: string): Promise<Layer> {
  const r = await render(who, scene, 'good', FRONTAL, 0);
  const jpeg = await sharp(r.rgb, { raw: { width: r.w, height: r.h, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  const a = await vision.analyze(jpeg, {});
  if (!a.primary) throw new Error(`no face found in the render of ${who} in ${scene}`);
  const [le, re] = a.primary.landmarks;
  const ie = Math.hypot(re.x - le.x, re.y - le.y);
  const eyeMid = { x: (le.x + re.x) / 2, y: (le.y + re.y) / 2 };
  const roll = Math.atan2(re.y - le.y, re.x - le.x);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  // webcam-sim geometry (eye-line units), slightly enlarged so the blur halo stays with the person.
  const headA = 1.3 * ie;
  const headB = 1.8 * ie;
  const headCy = 0.55 * ie;
  const neckHalf = 1.95 * ie;
  const neckTop = 1.6 * ie;
  const neckBottom = 3.6 * ie;
  const feather = 0.4 * ie;
  const mask = new Float32Array(r.w * r.h);
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const dx = x - eyeMid.x;
      const dy = y - eyeMid.y;
      const fu = dx * cr + dy * sr;
      const fv = -dx * sr + dy * cr;
      const er = Math.hypot(fu / headA, (fv - headCy) / headB);
      let m = er <= 1 ? 1 : Math.max(0, 1 - ((er - 1) * headA) / feather);
      if (fv > neckTop && fv < neckBottom + feather) {
        const mx = Math.max(0, Math.min(1, (neckHalf - Math.abs(fu)) / feather));
        const my = Math.max(0, Math.min(1, (neckBottom + feather - fv) / feather));
        m = Math.max(m, Math.min(mx, my));
      }
      mask[y * r.w + x] = m;
    }
  }
  return { mask, eyeMid, ie };
}

/** Room plate exposure-matched to a person frame (per-channel gain + offset fitted outside the person). */
const matchCache = new Map<string, Promise<Float32Array>>();
function matchedRoom(who: string, scene: string, cond: RwCondition): Promise<Float32Array> {
  const key = `${who}/${scene}/${cond}`;
  let p = matchCache.get(key);
  if (!p) {
    p = (async () => {
      const [room, person, layer] = await Promise.all([render(null, scene, cond, FRONTAL, 1), render(who, scene, cond, FRONTAL, 1), layerOf(who, scene)]);
      const out = new Float32Array(room.rgb.length);
      for (let c = 0; c < 3; c++) {
        let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (let i = 0; i < layer.mask.length; i += 5) {
          if (layer.mask[i] > 0) continue;
          const xv = room.rgb[i * 3 + c];
          const yv = person.rgb[i * 3 + c];
          if (xv < 4 || xv > 250 || yv < 4 || yv > 250) continue;
          n++; sx += xv; sy += yv; sxx += xv * xv; sxy += xv * yv;
        }
        const den = n * sxx - sx * sx;
        const g = n > 100 && den > 1e-6 ? (n * sxy - sx * sy) / den : 1;
        const o = n > 100 ? (sy - g * sx) / n : 0;
        for (let i = c; i < out.length; i += 3) out[i] = Math.max(0, Math.min(255, room.rgb[i] * g + o));
      }
      return out;
    })();
    matchCache.set(key, p);
  }
  return p;
}

async function rawRoom(scene: string, cond: RwCondition): Promise<Float32Array> {
  const r = await render(null, scene, cond, FRONTAL, 1);
  return Float32Array.from(r.rgb);
}

/* ------------------------------------------------------------------------------------ composition */

const smooth = (u: number) => {
  const t = Math.max(0, Math.min(1, u));
  return t * t * (3 - 2 * t);
};

interface Placed {
  shot: Shot;
  /** Offset in output px. */
  dx: number;
  dy: number;
  /** Head turn (source warp, possibly mirrored). */
  amp: TurnPose;
  alpha: number;
}

/**
 * Paint a person layer onto `out` (float RGB) with an integer offset; `mirror` reflects the layer (person and mask)
 * about the vertical line through its eye midpoint.
 */
function paint(out: Float32Array, W: number, H: number, frame: Raster, layer: Layer, dx: number, dy: number, alpha: number, mirror = false): void {
  const ix = Math.round(dx);
  const iy = Math.round(dy);
  const src = frame.rgb;
  const m = layer.mask;
  const ex2 = Math.round(2 * layer.eyeMid.x);
  for (let y = Math.max(0, iy); y < Math.min(H, H + iy); y++) {
    const sy = y - iy;
    let o = (y * W + Math.max(0, ix)) * 3;
    for (let x = Math.max(0, ix); x < Math.min(W, W + ix); x++, o += 3) {
      const lx = mirror ? ex2 - (x - ix) : x - ix;
      if (lx < 0 || lx >= W) continue;
      const si = sy * W + lx;
      const a = m[si] * alpha;
      if (a <= 0) continue;
      const s3 = si * 3;
      out[o] += a * (src[s3] - out[o]);
      out[o + 1] += a * (src[s3 + 1] - out[o + 1]);
      out[o + 2] += a * (src[s3 + 2] - out[o + 2]);
    }
  }
}

/** Continuous head / upper-body sway (output px) — periodic in `loop` seconds when given. */
function sway(t: number, ie: number, loop: number | undefined, still = false): { dx: number; dy: number } {
  const k = still ? 0.15 : 1;
  const [p1, p2, p3] = loop ? [loop, loop / 2, loop / 3] : [6.3, 2.9, 4.1];
  return {
    dx: k * ie * (0.16 * Math.sin((2 * Math.PI * t) / p1) + 0.05 * Math.sin((2 * Math.PI * t) / p2 + 1.3)),
    dy: k * ie * (0.06 * Math.sin((2 * Math.PI * t) / p3 + 0.4) + 0.03 * Math.sin((2 * Math.PI * t) / p2)),
  };
}

/** Short glances (looking at another part of the screen): ~every 7 s a 1.2 s head turn of ±GLANCE_FRAC (normalised). */
function glance(t: number): number {
  const period = 7.3;
  const k = Math.floor(t / period);
  const u = t - k * period;
  const dir = [1, -1, 0.6, -0.5, 1, -1][k % 6]!;
  const e = u < 0.4 ? smooth(u / 0.4) : u < 1.6 ? 1 : u < 2.0 ? 1 - smooth((u - 1.6) / 0.4) : 0;
  return Math.round((dir * GLANCE_FRAC * e) / 0.125) * 0.125;
}

/**
 * One head-turn cycle (seconds, normalised turn): turn left, hold, back to the centre and look at the screen for 3 s,
 * turn right, hold, centre for 3 s. A recorded video cannot follow the instructions, so the centre pauses are long
 * enough for the frontal pictures / 'look at the screen' step whenever the check happens to start.
 */
const HEADTURN_CYCLE: readonly (readonly [number, number])[] = [[1.2, 1], [2.5, 1], [1.2, 0], [3, 0], [1.2, -1], [2.5, -1], [1.2, 0], [3, 0]];

/** Liveness turn timeline (normalised, as synth-headturn.ts): frontal hold, then cycles left → centre → right → centre. */
function headturnAmp(t: number, frontalSec: number, cycles: number): number {
  const keys: [number, number][] = [[0, 0], [frontalSec, 0]];
  let tt = frontalSec;
  for (let i = 0; i < cycles; i++) {
    for (const [dur, amp] of HEADTURN_CYCLE) {
      tt += dur;
      keys.push([tt, amp]);
    }
  }
  for (let i = 1; i < keys.length; i++) {
    const [t1, a1] = keys[i]!;
    const [t0, a0] = keys[i - 1]!;
    if (t <= t1) return a0 + (a1 - a0) * smooth(t1 === t0 ? 1 : (t - t0) / (t1 - t0));
  }
  return 0;
}

function headturnSeconds(frontalSec: number, cycles: number): number {
  return frontalSec + cycles * HEADTURN_CYCLE.reduce((a, [d]) => a + d, 0);
}

function segSeconds(s: RwSegment): number {
  return 'headturn' in s ? headturnSeconds(s.frontalSec, s.cycles) : s.seconds;
}

/** What is in view at time `t` of the segment: background plate(s) and placed people. */
async function frameAt(spec: RwFixtureSpec, W: number, H: number, seg: RwSegment, tSeg: number, t: number, fIdx: number, prevShot: Shot | null): Promise<Float32Array> {
  const people: Placed[] = [];
  let bg: Float32Array;
  const loop = spec.loopSeconds;
  const layerFor = (s: Shot) => layerOf(s.who, s.scene);
  if ('hold' in seg) {
    const l = await layerFor(seg.hold);
    const sw = sway(t, l.ie, loop, seg.motion === 'still');
    const u = seg.glances ? glance(t) : 0;
    people.push({ shot: seg.hold, dx: sw.dx + u * HEAD_SHIFT * l.ie, dy: sw.dy, amp: await ampFor(seg.hold, u), alpha: 1 });
    bg = await matchedRoom(seg.hold.who, seg.hold.scene, seg.hold.cond);
  } else if ('headturn' in seg) {
    const l = await layerFor(seg.headturn);
    const sw = sway(t, l.ie, loop, true);
    const u = Math.round(headturnAmp(tSeg, seg.frontalSec, seg.cycles) / 0.125) * 0.125;
    people.push({ shot: seg.headturn, dx: sw.dx + u * HEAD_SHIFT * l.ie, dy: sw.dy, amp: await ampFor(seg.headturn, u), alpha: 1 });
    bg = await matchedRoom(seg.headturn.who, seg.headturn.scene, seg.headturn.cond);
  } else if ('leave' in seg) {
    const l = await layerFor(seg.leave);
    const e = smooth(tSeg / seg.seconds);
    const sw = sway(t, l.ie, loop);
    people.push({ shot: seg.leave, dx: sw.dx + e * 1.2 * l.ie, dy: sw.dy - e * (l.eyeMid.y + 3.4 * l.ie), amp: FRONTAL, alpha: 1 });
    bg = await matchedRoom(seg.leave.who, seg.leave.scene, seg.leave.cond);
  } else if ('empty' in seg) {
    // Auto-exposure re-adapts to the empty room over ~1 s.
    const raw = await rawRoom(seg.empty.scene, seg.empty.cond);
    const from = prevShot ? await matchedRoom(prevShot.who, prevShot.scene, prevShot.cond) : raw;
    const e = smooth(tSeg / 1.0);
    bg = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) bg[i] = from[i] + e * (raw[i] - from[i]);
  } else if ('enter' in seg) {
    const l = await layerFor(seg.enter);
    const e = smooth(tSeg / seg.seconds);
    const sw = sway(t, l.ie, loop);
    people.push({ shot: seg.enter, dx: sw.dx + (1 - e) * 1.6 * l.ie, dy: sw.dy - (1 - e) * (l.eyeMid.y + 3.4 * l.ie), amp: FRONTAL, alpha: 1 });
    const raw = await rawRoom(seg.enter.scene, seg.enter.cond);
    const to = await matchedRoom(seg.enter.who, seg.enter.scene, seg.enter.cond);
    bg = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) bg[i] = raw[i] + e * (to[i] - raw[i]);
  } else if ('blend' in seg) {
    // Two complete compositions, cross-dissolved.
    const [s1, s2] = seg.blend;
    const a = smooth(tSeg / seg.seconds);
    const c1 = await compose(W, H, [{ shot: s1, ...(await swayed(s1, t, loop)), amp: FRONTAL, alpha: 1 }], await matchedRoom(s1.who, s1.scene, s1.cond), fIdx);
    const c2 = await compose(W, H, [{ shot: s2, ...(await swayed(s2, t, loop)), amp: FRONTAL, alpha: 1 }], await matchedRoom(s2.who, s2.scene, s2.cond), fIdx);
    for (let i = 0; i < c1.length; i++) c1[i] += a * (c2[i] - c1[i]);
    return c1;
  } else {
    const [s1, s2] = seg.slide;
    const e = smooth(tSeg / seg.seconds);
    const l1 = await layerFor(s1);
    const l2 = await layerFor(s2);
    const w1 = await swayed(s1, t, loop);
    const w2 = await swayed(s2, t, loop);
    people.push({ shot: s1, dx: w1.dx - e * (l1.eyeMid.x + 2.8 * l1.ie), dy: w1.dy, amp: FRONTAL, alpha: 1 });
    people.push({ shot: s2, dx: w2.dx + (1 - e) * (W - l2.eyeMid.x + 2.8 * l2.ie), dy: w2.dy, amp: FRONTAL, alpha: 1 });
    const b1 = await matchedRoom(s1.who, s1.scene, s1.cond);
    const b2 = await matchedRoom(s2.who, s2.scene, s2.cond);
    bg = new Float32Array(b1.length);
    for (let i = 0; i < b1.length; i++) bg[i] = b1[i] + e * (b2[i] - b1[i]);
  }
  return compose(W, H, people, bg, fIdx);
}

async function swayed(s: Shot, t: number, loop: number | undefined): Promise<{ dx: number; dy: number }> {
  const l = await layerOf(s.who, s.scene);
  return sway(t, l.ie, loop);
}

/** Frame-seed offset of the fixture being built (RwFixtureSpec.variant * 100). */
let seedBase = 0;

async function compose(W: number, H: number, people: Placed[], bg: Float32Array, fIdx: number): Promise<Float32Array> {
  const out = Float32Array.from(bg);
  for (const p of people) {
    const turning = Math.abs(p.amp.amp) > 1e-6;
    const k = turning ? K_TURN : K_STEADY;
    const frame = await render(p.shot.who, p.shot.scene, p.shot.cond, { amp: p.amp.amp, mirror: false }, seedBase + 1 + (fIdx % k));
    if (frame.w !== W || frame.h !== H) throw new Error(`render size ${frame.w}x${frame.h} != ${W}x${H}`);
    paint(out, W, H, frame, await layerOf(p.shot.who, p.shot.scene), p.dx, p.dy, p.alpha, p.amp.mirror);
  }
  return out;
}

/* ------------------------------------------------------------------------------------ Y4M */

let noiseState = 0x9e3779b9;
function toI420(rgb: Float32Array, W: number, H: number, noise: number): Buffer {
  const ySize = W * H;
  const cSize = (W / 2) * (H / 2);
  const o = Buffer.alloc(ySize + 2 * cSize);
  let st = noiseState;
  for (let i = 0, p = 0; i < ySize; i++, p += 3) {
    st ^= st << 13;
    st ^= st >>> 17;
    st ^= st << 5;
    // Triangular noise in [-noise, noise] (cheap, zero mean).
    const n = (((st >>> 0) & 0xffff) / 65535 + ((st >>> 16) & 0xffff) / 65535 - 1) * noise;
    const v = 0.257 * rgb[p] + 0.504 * rgb[p + 1] + 0.098 * rgb[p + 2] + 16 + n;
    o[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
  noiseState = st;
  for (let y = 0; y < H / 2; y++) {
    for (let x = 0; x < W / 2; x++) {
      // 2×2 average for chroma.
      let r = 0, g = 0, b = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        const i = ((y * 2 + dy) * W + x * 2 + dx) * 3;
        r += rgb[i]; g += rgb[i + 1]; b += rgb[i + 2];
      }
      r /= 4; g /= 4; b /= 4;
      o[ySize + y * (W / 2) + x] = Math.max(0, Math.min(255, Math.round(-0.148 * r - 0.291 * g + 0.439 * b + 128)));
      o[ySize + cSize + y * (W / 2) + x] = Math.max(0, Math.min(255, Math.round(0.439 * r - 0.368 * g - 0.071 * b + 128)));
    }
  }
  return o;
}

function lastShot(seg: RwSegment): Shot | null {
  if ('hold' in seg) return seg.hold;
  if ('leave' in seg) return seg.leave;
  if ('enter' in seg) return seg.enter;
  if ('blend' in seg) return seg.blend[1];
  if ('slide' in seg) return seg.slide[1];
  if ('headturn' in seg) return seg.headturn;
  return null;
}

async function build(name: string, out: string, spec: RwFixtureSpec): Promise<void> {
  const [W, H] = spec.resolution === '1280x720' ? [1280, 720] : [640, 480];
  const fd = openSync(out, 'w');
  writeSync(fd, `YUV4MPEG2 W${W} H${H} F${spec.fps}:1 Ip A1:1 C420jpeg\n`);
  // A variant = the same scene at another moment: other noise / jitter realisations, sway shifted by 1/3 period.
  seedBase = (spec.variant ?? 0) * 100;
  let t = (spec.variant ?? 0) * (spec.loopSeconds ? spec.loopSeconds / 3 : 1.7);
  const tStart = t;
  let fIdx = 0;
  let prev: Shot | null = null;
  const t0 = Date.now();
  for (const seg of spec.segments) {
    const dur = segSeconds(seg);
    const n = Math.max(1, Math.round(dur * spec.fps));
    for (let i = 0; i < n; i++) {
      const tSeg = i / spec.fps;
      const rgb = await frameAt(spec, W, H, seg, tSeg, t + tSeg, fIdx, prev);
      writeSync(fd, 'FRAME\n');
      writeSync(fd, toI420(rgb, W, H, 3));
      fIdx++;
    }
    t += n / spec.fps;
    prev = lastShot(seg) ?? prev;
  }
  closeSync(fd);
  log(`${name}: ${fIdx} frames, ${(t - tStart).toFixed(1)} s, ${W}x${H} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

async function main() {
  vision = await createVisionService({});
  try {
    for (const f of job.fixtures) {
      await build(f.name, f.out, f.spec);
      console.log(`DONE ${f.name}`);
    }
    for (const [k, v] of renderParams) log(`render params ${k}: ${JSON.stringify(v)}`);
  } finally {
    await vision.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_DIR, FIXTURES_DIR, REPO_DIR } from './config';

/**
 * REALISTIC webcam fixtures (scenarios 20-25): laptop-webcam frames rendered by the vision team's webcam
 * simulator (apps/server/src/eval/webcam-sim.ts: auto-exposure, sensor noise, optics / NR blur, colour cast,
 * JPEG) from public multi-image identity sets, composed into fake-camera videos with natural head sway, small
 * glances, people leaving / sitting down, lighting changes and synthetic head turns (scripts/make-realistic.ts).
 *
 * The earlier fixtures (lib/fixtures.ts) are sharp, well-lit studio photos at 640×480 — the owner's real laptop
 * webcam showed failures they could not reproduce. These fixtures are what a candidate's webcam actually
 * delivers, at the resolution the app receives (Chromium's file camera delivers the Y4M's own size: a 1280×720
 * file gives the app a 720p track like most laptop webcams, 640×480 a VGA track like older USB webcams).
 *
 * Images come from E2E_FACESETS_DIR (default /tmp/claude-0/facesets, the vision team's cache, see
 * docs/accuracy/identity-v2.md §2) and are never copied into the repository; renders and videos go to
 * e2e/.fixtures/realistic (gitignored).
 */

export const FACESETS_DIR = process.env.E2E_FACESETS_DIR || process.env.SP_FACESETS_DIR || '/tmp/claude-0/facesets';
export const RW_DIR = join(FIXTURES_DIR, 'realistic');

/** People (source photos, relative to FACESETS_DIR). */
export const RW_PEOPLE = {
  /** Candidate A on exam day (frontal, hair tied back). */
  A: { file: 'deepface/tests__unit__dataset__img47.jpg', label: 'candidate A (deepface p03, photo img47)' },
  /** Candidate A on ANOTHER day: different photo — hair down with a side parting, smiling, other make-up. */
  A2: { file: 'deepface/tests__unit__dataset__img8.jpg', label: 'candidate A, another day (deepface p03, photo img8)' },
  /** Candidate A on a third day (hair up, other make-up): the other-room head-turn fixture (its photo turns symmetrically). */
  A3: { file: 'deepface/tests__unit__dataset__img51.jpg', label: 'candidate A, a third day (deepface p03, photo img51)' },
  /**
   * Person B — a plausible substitute: same gender, similar colouring (SFace similarity to A's photos 0.25–0.36 on
   * the source photos; the most A-like non-relative in the sets).
   */
  B: { file: 'face_recognition/examples__knn_examples__train__rose_leslie__img2.jpg', label: 'person B (face_recognition rose_leslie img2)' },
  /** Family impostor pair (Azure Face samples, same family): son and father (source-photo similarity 0.23–0.30). */
  SON: { file: 'azure/Face__images__Family1-Son1.jpg', label: 'Family1 son (Son1)' },
  DAD: { file: 'azure/Face__images__Family1-Dad3.jpg', label: 'Family1 father (Dad3)' },
} as const;
export type RwPerson = keyof typeof RW_PEOPLE;

/**
 * Scenes: `sceneSeed` draws the room, placement and — within each condition's range — exposure, noise, blur,
 * colour cast and JPEG quality (webcam-sim). Seeds were chosen so every parameter sits near the MIDDLE of its
 * range (no best case, no worst case). `interEye720` fixes the viewing distance (inter-eye px at 720p).
 */
export const RW_SCENES = {
  /** Candidate's desk at home: laptop webcam, 1280×720, ~60 cm (inter-eye 75 px). */
  home: { sceneSeed: 11008, resolution: '1280x720', interEye720: 75, label: 'home desk, laptop webcam 1280×720, inter-eye 75 px' },
  /** The same laptop webcam in VGA mode (older laptops / browsers that pick 640×480). */
  home480: { sceneSeed: 11008, resolution: '640x480', interEye720: 75, label: 'home desk, webcam 640×480, inter-eye 50 px' },
  /** Another room and another (VGA USB) camera, sitting further back: warm light, low JPEG quality. */
  other: { sceneSeed: 10308, resolution: '640x480', interEye720: 58, label: 'another room, USB webcam 640×480, inter-eye 39 px' },
} as const;
export type RwScene = keyof typeof RW_SCENES;
export type RwCondition = 'good' | 'typical' | 'dim' | 'backlit' | 'sidelit';
export const RW_CONDITIONS: readonly RwCondition[] = ['good', 'typical', 'dim', 'backlit', 'sidelit'];

export interface Shot {
  who: RwPerson;
  scene: RwScene;
  cond: RwCondition;
}

/**
 * Timeline segments (seconds). Every person layer sways continuously (head / upper-body movement of a few
 * pixels, `motion: 'still'` = almost none); `glances` adds short head turns of ~5–8° (looking around the screen).
 */
export type RwSegment =
  | { hold: Shot; seconds: number; motion?: 'sway' | 'still'; glances?: boolean }
  /** Nobody in view (the room of `scene` / `cond`); auto-exposure re-adapts over ~1 s. */
  | { empty: { scene: RwScene; cond: RwCondition }; seconds: number }
  /** The person stands up and leaves (moves up / sideways out of view). */
  | { leave: Shot; seconds: number }
  /** A person comes into view and sits down (from the top right). */
  | { enter: Shot; seconds: number }
  /** Cross-dissolve between two shots: a lighting change (same person) or a no-gap swap (other person). */
  | { blend: [Shot, Shot]; seconds: number }
  /** No-gap swap: the first person slides out to the left while the second slides in from the right. */
  | { slide: [Shot, Shot]; seconds: number }
  /** Frontal, then cycles of turning left / right (synthetic nose-vs-eyes parallax, ±~20°) — active liveness. */
  | { headturn: Shot; frontalSec: number; cycles: number };

export interface RwFixtureSpec {
  resolution: '1280x720' | '640x480';
  fps: number;
  /** Sway periods divide this length, so a looping video has no jump at the loop point. */
  loopSeconds?: number;
  segments: RwSegment[];
  /**
   * Another moment of the same shots: different sensor-noise / jitter realisations (frame seeds) and sway phase, so
   * two fixtures of the same person and light (e.g. check-in and a later resume) never replay identical frames.
   */
  variant?: number;
  /** Human description (report). */
  about: string;
}

const hold = (who: RwPerson, scene: RwScene, cond: RwCondition, seconds: number, extra: { glances?: boolean; motion?: 'sway' | 'still' } = {}): RwSegment => ({ hold: { who, scene, cond }, seconds, ...extra });
const shot = (who: RwPerson, scene: RwScene, cond: RwCondition): Shot => ({ who, scene, cond });

/** A 6 s steady loop of one person in one condition (natural sway, loops seamlessly). */
function steady(who: RwPerson, scene: RwScene, cond: RwCondition, about: string, variant = 0): RwFixtureSpec {
  return { resolution: RW_SCENES[scene].resolution, fps: 5, loopSeconds: 6, segments: [hold(who, scene, cond, 6)], about, variant };
}

/** Swap timeline: the reference person for `aSec`, a transition, then the other person for `bSec`. */
function swapSpec(a: Shot, b: Shot, kind: 'gap' | 'blend' | 'slide', about: string, aSec = SWAP_AT_SEC, bSec = 45): RwFixtureSpec {
  const segs: RwSegment[] = [{ hold: a, seconds: aSec }];
  if (kind === 'gap') segs.push({ leave: a, seconds: 0.8 }, { empty: { scene: a.scene, cond: a.cond }, seconds: 1.0 }, { enter: b, seconds: 0.8 });
  else if (kind === 'blend') segs.push({ blend: [a, b], seconds: 0.5 });
  else segs.push({ slide: [a, b], seconds: 0.5 });
  segs.push({ hold: b, seconds: bSec });
  return { resolution: RW_SCENES[a.scene].resolution, fps: 5, segments: segs, about };
}

/** Seconds of camera time at which a swap fixture starts its transition (A in view before). */
export const SWAP_AT_SEC = 35;
/** Camera time at which the new person is fully in view, per swap kind. */
export const SWAP_DONE_SEC = { gap: SWAP_AT_SEC + 2.6, blend: SWAP_AT_SEC + 0.5, slide: SWAP_AT_SEC + 0.5 } as const;
/** Seconds the new person stays in view before the video loops back to the reference person. */
export const SWAP_B_SEC = 45;

export const RW_FIXTURES = {
  /* ------------------------------------------------ steady (10 s loops) */
  rwA_good: steady('A', 'home', 'good', 'A, home, good light'),
  rwA_typical: steady('A', 'home', 'typical', 'A, home, typical indoor light'),
  rwA_dim: steady('A', 'home', 'dim', 'A, home, dim evening light'),
  rwA_backlit: steady('A', 'home', 'backlit', 'A, home, window behind'),
  rwA_sidelit: steady('A', 'home', 'sidelit', 'A, home, lamp to one side'),
  /** The same room and light LATER (resume): other frames than the check-in fixture. */
  rwA_typical_later: steady('A', 'home', 'typical', 'A, home, typical indoor light, later (other frames)', 1),
  rwA2_typical: steady('A2', 'home', 'typical', 'A on another day (other photo: hair down, smiling), home, typical'),
  rwA2_dim: steady('A2', 'home', 'dim', 'A on another day (other photo), home, dim evening light'),
  rwA2_backlit: steady('A2', 'home', 'backlit', 'A on another day (other photo), home, window behind'),
  rwA_typical480: steady('A', 'home480', 'typical', 'A, home, typical, 640×480'),
  rwA_dim480: steady('A', 'home480', 'dim', 'A, home, dim, 640×480'),
  rwA2_other_typical: steady('A2', 'other', 'typical', 'A on another day, another room + USB camera 640×480, typical'),
  rwA2_other_dim: steady('A2', 'other', 'dim', 'A on another day, another room + USB camera 640×480, dim'),
  rwA2_other_sidelit: steady('A2', 'other', 'sidelit', 'A on another day, another room + USB camera 640×480, side lamp'),
  rwB_good: steady('B', 'home', 'good', 'B, home, good light'),
  rwB_typical: steady('B', 'home', 'typical', 'B, home, typical'),
  rwB_dim: steady('B', 'home', 'dim', 'B, home, dim'),
  rwB_backlit: steady('B', 'home', 'backlit', 'B, home, window behind'),
  rwB_sidelit: steady('B', 'home', 'sidelit', 'B, home, side lamp'),
  rwB_typical480: steady('B', 'home480', 'typical', 'B, home, typical, 640×480'),
  rwSON_typical: steady('SON', 'home', 'typical', 'Family1 son, home, typical'),
  rwDAD_typical: steady('DAD', 'home', 'typical', 'Family1 father, home, typical'),
  rwDAD_dim: steady('DAD', 'home', 'dim', 'Family1 father, home, dim'),

  /* ------------------------------------------------ quick swaps (A for 35 s from camera start, then B) */
  rwSwapGap: swapSpec(shot('A', 'home', 'typical'), shot('B', 'home', 'typical'), 'gap', 'A (typical) leaves at 35 s, room empty ~1 s, B sits down at ~37.6 s'),
  rwSwapBlend: swapSpec(shot('A', 'home', 'typical'), shot('B', 'home', 'typical'), 'blend', 'A → B without a gap: 0.5 s cross-dissolve at 35 s'),
  rwFamilySwap: swapSpec(shot('SON', 'home', 'typical'), shot('DAD', 'home', 'typical'), 'gap', 'son (candidate) leaves at 35 s, his father sits down'),
  /* 640×480 variants (VGA camera; also keeps the fixture set's disk footprint down: 720p video is 6.9 MB/s) */
  rwSwapGap480: swapSpec(shot('A', 'home480', 'typical'), shot('B', 'home480', 'typical'), 'gap', 'gap swap at 640×480'),
  rwSwapSlide480: swapSpec(shot('A', 'home480', 'typical'), shot('B', 'home480', 'typical'), 'slide', 'A slides out while B slides in (0.5 s at 35 s), 640×480'),
  rwSwapDimBlend480: swapSpec(shot('A', 'home480', 'dim'), shot('B', 'home480', 'dim'), 'blend', 'no-gap swap in a dim room, 640×480'),
  rwFamilySwapBlend480: swapSpec(shot('SON', 'home480', 'typical'), shot('DAD', 'home480', 'typical'), 'blend', 'son → father without a gap, 640×480'),

  /* ------------------------------------------------ genuine candidate, long runs (loop) */
  rwGenuineLong: {
    resolution: '1280x720',
    fps: 5,
    about: 'A for 90 s (loops): typical → dim (lamp off) → typical → side lamp → typical, head sway and glances throughout',
    segments: [
      hold('A', 'home', 'typical', 20, { glances: true }),
      { blend: [shot('A', 'home', 'typical'), shot('A', 'home', 'dim')], seconds: 3 },
      hold('A', 'home', 'dim', 22, { glances: true }),
      { blend: [shot('A', 'home', 'dim'), shot('A', 'home', 'typical')], seconds: 3 },
      hold('A', 'home', 'typical', 12, { glances: true }),
      { blend: [shot('A', 'home', 'typical'), shot('A', 'home', 'sidelit')], seconds: 2 },
      hold('A', 'home', 'sidelit', 16, { glances: true }),
      { blend: [shot('A', 'home', 'sidelit'), shot('A', 'home', 'typical')], seconds: 2 },
      hold('A', 'home', 'typical', 10, { glances: true }),
    ],
  },
  rwGenuineDim: {
    resolution: '1280x720',
    fps: 5,
    about: 'A for 60 s (loops), mostly dim: dim → desk lamp on (typical) → dim → window light (backlit) → dim, sway and glances',
    segments: [
      hold('A', 'home', 'dim', 15, { glances: true }),
      { blend: [shot('A', 'home', 'dim'), shot('A', 'home', 'typical')], seconds: 2 },
      hold('A', 'home', 'typical', 8, { glances: true }),
      { blend: [shot('A', 'home', 'typical'), shot('A', 'home', 'dim')], seconds: 2 },
      hold('A', 'home', 'dim', 15, { glances: true }),
      { blend: [shot('A', 'home', 'dim'), shot('A', 'home', 'backlit')], seconds: 2 },
      hold('A', 'home', 'backlit', 8, { glances: true }),
      { blend: [shot('A', 'home', 'backlit'), shot('A', 'home', 'dim')], seconds: 2 },
      hold('A', 'home', 'dim', 6, { glances: true }),
    ],
  },

  /* ------------------------------------------------ active liveness (head turns) */
  rwTurnA_typical: { resolution: '1280x720', fps: 5, about: 'A, home, typical: frontal 14 s, then 3 cycles left / centre / right / centre', segments: [{ headturn: shot('A', 'home', 'typical'), frontalSec: 14, cycles: 3 }] },
  rwTurnA_typical_later: { resolution: '1280x720', fps: 5, variant: 1, about: 'A, home, typical, later (other frames): frontal 14 s, then 3 cycles', segments: [{ headturn: shot('A', 'home', 'typical'), frontalSec: 14, cycles: 3 }] },
  rwTurnA_dim: { resolution: '1280x720', fps: 5, about: 'A, home, dim: frontal 14 s, then 3 cycles', segments: [{ headturn: shot('A', 'home', 'dim'), frontalSec: 14, cycles: 3 }] },
  rwTurnA2_other: { resolution: '640x480', fps: 5, about: 'A on another day (photo img51), other room + USB camera, side lamp: frontal 14 s, 3 cycles', segments: [{ headturn: shot('A3', 'other', 'sidelit'), frontalSec: 14, cycles: 3 }] },
} satisfies Record<string, RwFixtureSpec>;

export type RwFixtureName = keyof typeof RW_FIXTURES;

export function rwFixturePath(name: RwFixtureName): string {
  return join(RW_DIR, `${name}.y4m`);
}

export function rwPersonFile(who: RwPerson): string {
  return join(FACESETS_DIR, RW_PEOPLE[who].file);
}

function peopleOf(spec: RwFixtureSpec): RwPerson[] {
  const s = new Set<RwPerson>();
  for (const seg of spec.segments) {
    if ('hold' in seg) s.add(seg.hold.who);
    else if ('leave' in seg) s.add(seg.leave.who);
    else if ('enter' in seg) s.add(seg.enter.who);
    else if ('blend' in seg) seg.blend.forEach((x) => s.add(x.who));
    else if ('slide' in seg) seg.slide.forEach((x) => s.add(x.who));
    else if ('headturn' in seg) s.add(seg.headturn.who);
  }
  return [...s];
}

export function rwFixtureAvailable(name: RwFixtureName): boolean {
  return existsSync(FACESETS_DIR) && peopleOf(RW_FIXTURES[name]).every((p) => existsSync(rwPersonFile(p)));
}

/**
 * Versions of the builder (scripts/make-realistic.ts): bump COMPOSE when the composition changes (rebuilds every
 * fixture), TURNS when head turns / glances change (rebuilds only fixtures with head movement). A change of the
 * simulator (webcam-sim.ts) rebuilds everything.
 */
export const RW_BUILDER_VERSION = { compose: 3, turns: 4 } as const;
const SIMULATOR = join(REPO_DIR, 'apps/server/src/eval/webcam-sim.ts');

function hasTurns(spec: RwFixtureSpec): boolean {
  return spec.segments.some((s) => 'headturn' in s || ('hold' in s && s.glances));
}

function specHash(name: RwFixtureName): string {
  const spec = RW_FIXTURES[name];
  const h = createHash('sha256').update(JSON.stringify(spec));
  h.update(`compose:${RW_BUILDER_VERSION.compose}`);
  if (hasTurns(spec)) h.update(`turns:${RW_BUILDER_VERSION.turns}`);
  h.update(existsSync(SIMULATOR) ? readFileSync(SIMULATOR) : '');
  for (const p of peopleOf(spec)) h.update(RW_PEOPLE[p].file).update(String(statSync(rwPersonFile(p)).mtimeMs));
  for (const seg of spec.segments) h.update(JSON.stringify(seg));
  h.update(JSON.stringify(RW_SCENES));
  return h.digest('hex').slice(0, 16);
}

/**
 * Builds the missing / outdated realistic fixtures (one builder process for all of them: it shares the vision
 * models and the rendered frames). `only` limits the set (e.g. E2E_RW_ONLY=rwSwapGap,rwA_typical).
 */
export function ensureRealisticFixtures(log: (m: string) => void = () => undefined, only?: RwFixtureName[]): { built: RwFixtureName[]; skipped: RwFixtureName[] } {
  mkdirSync(RW_DIR, { recursive: true });
  const manifestPath = join(RW_DIR, 'manifest.json');
  const manifest: Record<string, string> = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  const names = (only?.length ? only : (Object.keys(RW_FIXTURES) as RwFixtureName[])).filter((n) => n in RW_FIXTURES);
  const skipped = names.filter((n) => !rwFixtureAvailable(n));
  const todo = names.filter((n) => rwFixtureAvailable(n) && !(manifest[n] === specHash(n) && existsSync(rwFixturePath(n))));
  if (!todo.length) return { built: [], skipped };
  log(`building realistic webcam fixtures: ${todo.join(', ')} (scripts/make-realistic.ts; first build takes a few minutes)`);
  // Outdated videos go first (720p video is 6.9 MB/s: keeping old and new side by side would double the footprint).
  for (const n of todo) for (const f of [rwFixturePath(n), `${rwFixturePath(n)}.tmp`]) if (existsSync(f)) unlinkSync(f);
  const jobFile = join(RW_DIR, `job-${process.pid}.json`);
  writeFileSync(
    jobFile,
    JSON.stringify({
      facesetsDir: FACESETS_DIR,
      cacheDir: join(RW_DIR, 'renders'),
      people: RW_PEOPLE,
      scenes: RW_SCENES,
      fixtures: todo.map((n) => ({ name: n, out: `${rwFixturePath(n)}.tmp`, spec: RW_FIXTURES[n] })),
    }),
  );
  const r = spawnSync(join(E2E_DIR, 'node_modules/.bin/tsx'), [join(E2E_DIR, 'scripts/make-realistic.ts'), jobFile], { cwd: E2E_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  unlinkSync(jobFile);
  // The builder prints "DONE <name>" after each finished video: keep those even when a later one failed.
  const done = new Set((r.stdout ?? '').split('\n').filter((l) => l.startsWith('DONE ')).map((l) => l.slice(5).trim()));
  const built: RwFixtureName[] = [];
  for (const n of todo) {
    if (!done.has(n) || !existsSync(`${rwFixturePath(n)}.tmp`)) continue;
    renameSync(`${rwFixturePath(n)}.tmp`, rwFixturePath(n));
    manifest[n] = specHash(n);
    built.push(n);
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  writeFileSync(join(RW_DIR, 'build-log.txt'), `${r.stdout}\n${r.stderr}`);
  if (r.status !== 0) throw new Error(`make-realistic.ts failed: ${r.stderr || r.stdout}`);
  return { built, skipped };
}

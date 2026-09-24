import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { makeY4m, type Segment } from '../scripts/make-y4m';
import { E2E_DIR, FIXTURES_DIR, faceImage, facesAvailable } from './config';

/**
 * Fake-camera fixtures, generated once per machine into e2e/.fixtures (gitignored) from the face images in
 * E2E_FACES_DIR. Nothing derived from the face images is ever written inside the tracked repository.
 *
 * Chrome's file camera starts the video from frame 0 every time the camera device is opened (the
 * candidate app opens it at the camera check and keeps it open through the exam) and loops at the end.
 * Times below are therefore "seconds since the camera check started". Check-in (readiness, calibration,
 * identity frames) takes ~10–25 s, so every fixture shows the reference person for >= 45 s first.
 */

/** Stills derived from the source images (4:3, 640x480 — the camera frame size). */
const STILLS = {
  /** Candidate A: head and shoulders, face ~40 % of the frame width, centred. */
  'a.jpg': { src: 'obama.jpg', crop: { left: 115, top: 0, width: 750, height: 562 } },
  /**
   * Candidate B (a different person), frontal, same framing. (biden.jpg is not used for B: his head is
   * turned 22–29° depending on the crop, right at the server's 25° pose gate, so the honest outcome for
   * it is "unable to verify" — not the dependable different-person evidence this scenario needs.)
   */
  'b.jpg': { src: 'deepface/img30.jpg', crop: { left: 0, top: 0, width: 1339, height: 1004 } },
  /** Two people side by side. */
  'two.jpg': { src: 'two_people.jpg', crop: { left: 0, top: 0, width: 1126, height: 661 } },
  /** The same room without anyone in it (textured background, no face). */
  'room.jpg': { src: 'obama.jpg', crop: { left: 0, top: 0, width: 330, height: 248 } },
  /** Candidate A in a dark room (face below the server quality gate's minimum brightness of 40). */
  'a-dark.jpg': { src: 'obama.jpg', crop: { left: 115, top: 0, width: 750, height: 562 }, darken: 0.25 },
  /**
   * Candidate A in a dim room: bright enough for the browser's readiness checklist (face brightness
   * >= 55) but too little contrast for a dependable server-side comparison (face contrast ~16.6 < 18).
   */
  'a-dim.jpg': { src: 'obama.jpg', crop: { left: 115, top: 0, width: 750, height: 562 }, darken: 0.44 },
} as const;
export type StillName = keyof typeof STILLS;

export const FIXTURE_SPECS = {
  /** Candidate A, steady (loops). */
  a: [{ src: 'a.jpg', seconds: 30 }],
  /** Candidate B, steady (loops). */
  b: [{ src: 'b.jpg', seconds: 30 }],
  /** A for 60 s, then B (person swap during the exam without leaving the frame). */
  swap: [
    { src: 'a.jpg', seconds: 60 },
    { src: 'b.jpg', seconds: 150 },
  ],
  /** A, then a second person joins for 20 s, then A alone again. */
  two: [
    { src: 'a.jpg', seconds: 50 },
    { src: 'two.jpg', seconds: 20 },
    { src: 'a.jpg', seconds: 90 },
  ],
  /** A, empty room for 16 s (absence), A returns, then the lens is covered for 14 s, then A again. */
  absence: [
    { src: 'a.jpg', seconds: 50 },
    { src: 'room.jpg', seconds: 16 },
    { src: 'a.jpg', seconds: 25 },
    { src: 'black', seconds: 14 },
    { src: 'a.jpg', seconds: 90 },
  ],
  /** A in a dim room for 30 s, then the light is switched on. */
  dimThenLight: [
    { src: 'a-dim.jpg', seconds: 30 },
    { src: 'a.jpg', seconds: 90 },
  ],
  /** A sitting elsewhere: smaller in the frame and further to the side (another seat / camera position). */
  aMoved: [{ src: 'a.jpg', seconds: 30, scale: 0.72, shiftX: -90 }],
  /** A, the room is dark from 50 s to 90 s, then the light is back. */
  darkPeriod: [
    { src: 'a.jpg', seconds: 50 },
    { src: 'a-dark.jpg', seconds: 40 },
    { src: 'a.jpg', seconds: 90 },
  ],
} satisfies Record<string, Segment[]>;

/**
 * Synthetic videos made by scripts (run as a subprocess): `headturn` = candidate A, frontal for 10 s,
 * then repeated cycles of turning left / right and back (real nose-vs-eyes parallax, identity preserved),
 * for the ACTIVE liveness path (scripts/synth-headturn.ts).
 */
export const SYNTH_SPECS = {
  headturn: { script: 'synth-headturn.ts', still: 'a.jpg' as StillName, args: ['5', '10', '6'] },
} as const;

export type FixtureName = keyof typeof FIXTURE_SPECS | keyof typeof SYNTH_SPECS;

function isSynth(name: FixtureName): name is keyof typeof SYNTH_SPECS {
  return name in SYNTH_SPECS;
}

/** Source images each fixture needs. */
export function fixtureSources(name: FixtureName): string[] {
  if (isSynth(name)) return [STILLS[SYNTH_SPECS[name].still].src];
  const stills = new Set<string>(FIXTURE_SPECS[name].map((s) => s.src).filter((s) => s in STILLS));
  return [...new Set([...stills].map((s) => STILLS[s as StillName].src))];
}

export function fixtureAvailable(name: FixtureName): boolean {
  return facesAvailable(...fixtureSources(name));
}

export function fixturePath(name: FixtureName): string {
  return join(FIXTURES_DIR, `${name}.y4m`);
}

export function stillPath(name: StillName): string {
  return join(FIXTURES_DIR, 'stills', name);
}

async function makeStill(name: StillName): Promise<void> {
  const def = STILLS[name];
  let img = sharp(faceImage(def.src)).rotate().extract(def.crop).resize(640, 480, { fit: 'contain', background: { r: 118, g: 112, b: 104 } });
  if ('darken' in def) img = img.linear(def.darken, 0);
  await img.jpeg({ quality: 92 }).toFile(stillPath(name));
}

function specHash(name: keyof typeof FIXTURE_SPECS): string {
  const h = createHash('sha256').update(JSON.stringify(FIXTURE_SPECS[name]));
  for (const s of FIXTURE_SPECS[name]) if (s.src in STILLS) h.update(JSON.stringify(STILLS[s.src as StillName]));
  return h.digest('hex').slice(0, 16);
}

function buildSynth(name: keyof typeof SYNTH_SPECS, out: string): void {
  const spec = SYNTH_SPECS[name];
  const r = spawnSync(join(E2E_DIR, 'node_modules/.bin/tsx'), [join(E2E_DIR, 'scripts', spec.script), stillPath(spec.still), out, ...spec.args], { cwd: E2E_DIR, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${spec.script} failed: ${r.stderr || r.stdout}`);
}

/** Builds the stills and every Y4M whose spec changed (or is missing). Returns the fixtures that were built. */
export async function ensureFixtures(log: (m: string) => void = () => undefined): Promise<{ built: FixtureName[]; skipped: FixtureName[] }> {
  mkdirSync(join(FIXTURES_DIR, 'stills'), { recursive: true });
  const manifestPath = join(FIXTURES_DIR, 'manifest.json');
  const manifest: Record<string, string> = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  const built: FixtureName[] = [];
  const skipped: FixtureName[] = [];
  for (const name of Object.keys(STILLS) as StillName[]) {
    if (!facesAvailable(STILLS[name].src)) continue;
    const key = `still:${name}`;
    const hash = createHash('sha256').update(JSON.stringify(STILLS[name])).update(String(statSync(faceImage(STILLS[name].src)).mtimeMs)).digest('hex').slice(0, 16);
    if (manifest[key] === hash && existsSync(stillPath(name))) continue;
    await makeStill(name);
    manifest[key] = hash;
  }
  for (const name of Object.keys(SYNTH_SPECS) as (keyof typeof SYNTH_SPECS)[]) {
    if (!fixtureAvailable(name)) {
      skipped.push(name);
      continue;
    }
    const spec = SYNTH_SPECS[name];
    const script = join(E2E_DIR, 'scripts', spec.script);
    const hash = createHash('sha256').update(JSON.stringify(spec)).update(readFileSync(script)).update(manifest[`still:${spec.still}`] ?? '').digest('hex').slice(0, 16);
    if (manifest[`y4m:${name}`] === hash && existsSync(fixturePath(name))) continue;
    log(`building fake-camera fixture ${name}.y4m (${spec.script})`);
    const tmp = `${fixturePath(name)}.tmp`;
    buildSynth(name, tmp);
    renameSync(tmp, fixturePath(name));
    manifest[`y4m:${name}`] = hash;
    built.push(name);
  }
  for (const name of Object.keys(FIXTURE_SPECS) as (keyof typeof FIXTURE_SPECS)[]) {
    if (!fixtureAvailable(name)) {
      skipped.push(name);
      continue;
    }
    const hash = specHash(name) + FIXTURE_SPECS[name].map((s) => (s.src in STILLS ? manifest[`still:${s.src}`] : s.src)).join('');
    if (manifest[`y4m:${name}`] === hash && existsSync(fixturePath(name))) continue;
    log(`building fake-camera fixture ${name}.y4m`);
    const segs: Segment[] = FIXTURE_SPECS[name].map((s) => ({ ...s, src: s.src in STILLS ? stillPath(s.src as StillName) : s.src }));
    const tmp = `${fixturePath(name)}.tmp`;
    await makeY4m(tmp, segs, 5, 640, 480);
    renameSync(tmp, fixturePath(name));
    manifest[`y4m:${name}`] = hash;
    built.push(name);
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  return { built, skipped };
}

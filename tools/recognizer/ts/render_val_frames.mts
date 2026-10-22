/**
 * Renders the held-out VALIDATION portraits (training source, public domain; never evaluation identities) with the
 * vision agent's TypeScript webcam simulator (apps/server/src/eval/webcam-sim.ts) and analyses them with the
 * production vision service, so model selection can watch the MATCHED-DEGRADATION impostor behaviour (dim-room
 * reference vs dim-room probes of OTHER people) in the evaluation simulator's domain, without touching the
 * evaluation identities.
 *
 *   tsx tools/recognizer/ts/render_val_frames.mts <names.txt> <portrait dir> <out dir>
 *
 * Per portrait: conditions good / dim / backlit at 640x480, scene 1, burst frames 0..2 (+ 1280x720 scene 2 frame 0).
 * Output: <out>/<name>-<cond>-<res>-s<scene>-f<frame>.jpg and <out>/frames.jsonl (landmarks from the production
 * detector incl. the low-light pass, quality, and the production v2 embedding for reference).
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createVisionService } from '../../../apps/server/src/vision/service.ts';
import { simulateWebcamFrame, type WebcamCondition, type WebcamResolution } from '../../../apps/server/src/eval/webcam-sim.ts';

const [namesFile, srcDir, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const names = readFileSync(namesFile, 'utf8').split(/\r?\n/).filter(Boolean);
const seed = (s: string) => createHash('sha256').update(s).digest().readUInt32LE(0) & 0x7fffffff;
const vision = await createVisionService({ workers: 1 });
const out = join(outDir, 'frames.jsonl');
const done = new Set(existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).file) : []);
const plan: { cond: WebcamCondition; res: WebcamResolution; scene: number; frames: number[] }[] = [
  { cond: 'good', res: '640x480', scene: 1, frames: [0, 1, 2] },
  { cond: 'dim', res: '640x480', scene: 1, frames: [0, 1, 2] },
  { cond: 'backlit', res: '640x480', scene: 1, frames: [0, 1, 2] },
  { cond: 'dim', res: '1280x720', scene: 2, frames: [0] },
  { cond: 'backlit', res: '1280x720', scene: 2, frames: [0] },
];
let n = 0;
for (const name of names) {
  const src = readFileSync(join(srcDir, name));
  const a0 = await vision.analyze(src, {});
  if (!a0.primary) continue;
  for (const p of plan) {
    for (const f of p.frames) {
      const file = join(outDir, `${name.replace(/\.jpg$/, '')}-${p.cond}-${p.res}-s${p.scene}-f${f}.jpg`);
      if (done.has(file)) continue;
      const fr = await simulateWebcamFrame(src, { landmarks: a0.primary.landmarks }, {
        condition: p.cond, resolution: p.res, sceneSeed: seed(`val|${name}|${p.cond}|${p.res}|${p.scene}`), frameSeed: f, jitter: 'burst',
      });
      writeFileSync(file, fr.jpeg);
      const a = await vision.analyze(fr.jpeg, { embed: true });
      appendFileSync(out, JSON.stringify({
        file, portrait: name, condition: p.cond, resolution: p.res, scene: p.scene, frame: f,
        landmarks: a.primary?.landmarks.map((q) => [q.x, q.y]) ?? null, usable: a.quality.usable, issues: a.quality.issues,
        embedding: a.embedding ? Array.from(a.embedding) : null,
      }) + '\n');
      n++;
    }
  }
}
await vision.close();
console.log(`rendered ${n} frames`);

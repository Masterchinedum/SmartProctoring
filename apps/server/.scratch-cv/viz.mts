import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { createVisionService } from '../src/vision/index.ts';
import { simulateWebcamFrame, WEBCAM_CONDITIONS } from '../src/eval/webcam-sim.ts';
const files = process.argv.slice(3);
const vision = await createVisionService({ workers: 0 });
const tiles: Buffer[] = [];
for (const f of files) {
  const src = readFileSync(f);
  const a = await vision.analyze(src, {});
  for (const c of WEBCAM_CONDITIONS) {
    const t0 = performance.now();
    const fr = await simulateWebcamFrame(src, { landmarks: a.primary!.landmarks }, { condition: c, resolution: process.argv[2] as any, sceneSeed: 3 });
    const ms = performance.now() - t0;
    const b = await vision.analyze(fr.jpeg, { embed: true });
    console.log(c, fr.params, Math.round(ms) + 'ms', 'quality', b.quality.issues, b.quality.brightness, b.quality.contrast, b.quality.sharpness, b.quality.interEyePx);
    tiles.push(await sharp(fr.jpeg).resize(320).toBuffer());
  }
}
const w = 320, h = tiles.length ? (await sharp(tiles[0]).metadata()).height! : 0;
await sharp({ create: { width: w * 5, height: h * files.length, channels: 3, background: '#000' } }).composite(tiles.map((t, i) => ({ input: t, left: (i % 5) * w, top: Math.floor(i / 5) * h }))).jpeg().toFile('/tmp/claude-0/-home-user-SmartProctoring/c528aa25-f56c-51ce-8300-e79ef4b36c0d/scratchpad/sim.jpg');
await vision.close();

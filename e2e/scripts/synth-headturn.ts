/**
 * Synthetic "live person turning their head" fake-camera video for testing the ACTIVE liveness path.
 *
 * A still photo cannot pass the live-person check because rotating a flat picture produces no parallax
 * between the nose and the eyes. To exercise the passing path end-to-end we synthesise that parallax: a
 * smooth local warp shifts the nose region (and, less, the face centre) sideways relative to the eyes,
 * which is what a real head turn looks like to both MediaPipe (browser) and YuNet (server). Identity is
 * preserved (SFace similarity to the original ≈ 0.75–0.9), so the resulting video models "the same
 * person, turning left and right".
 *
 * Timeline (looped by Chrome): frontal hold, then repeated cycles of turn-left → hold → centre → turn-right
 * → hold → centre, so whichever order the server's randomised challenge asks for appears within one cycle.
 *
 * Usage: tsx scripts/synth-headturn.ts <face.jpg> <out.y4m> [fps=10] [frontalSec=10] [cycles=6]
 * (landmarks come from the server's YuNet model; run from the repo with node_modules installed.)
 */
import { openSync, writeSync, closeSync } from 'node:fs';
import sharp from 'sharp';
import { createVisionService } from '../../apps/server/src/vision/index.js';

const W = 640;
const H = 480;
/** Nose-shift amplitude in inter-ocular distances; ±0.35 ≈ ±20° measured yaw change on the server. */
const TURN_AMP = 0.35;

async function main() {
  const [src, out, fpsArg, frontalArg, cyclesArg] = process.argv.slice(2);
  if (!src || !out) throw new Error('usage: synth-headturn.ts <face.jpg> <out.y4m> [fps] [frontalSec] [cycles]');
  const fps = Number(fpsArg ?? 10);
  const frontalSec = Number(frontalArg ?? 10);
  const cycles = Number(cyclesArg ?? 6);

  const { data } = await sharp(src).rotate().resize(W, H, { fit: 'contain', background: { r: 120, g: 120, b: 120 } }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const vision = await createVisionService({});
  const jpeg = await sharp(data, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
  const analysis = await vision.analyze(jpeg, {});
  await vision.close();
  if (!analysis.primary) throw new Error(`no face found in ${src}`);
  const [e1, e2, nose] = analysis.primary.landmarks;
  const iod = Math.hypot(e2.x - e1.x, e2.y - e1.y);

  const warpCache = new Map<number, Buffer>();
  const warp = (amp: number): Buffer => {
    const key = Math.round(amp * 100) / 100;
    const hit = warpCache.get(key);
    if (hit) return hit;
    const res = Buffer.alloc(W * H * 3);
    const r = iod * 0.9;
    const faceR = iod * 1.8;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = x - nose.x;
        const dy = y - nose.y;
        const noseShift = key * iod * Math.exp((-(dx * dx + dy * dy * 0.6) / (r * r)) * 1.5);
        const faceShift = key * iod * 0.35 * Math.exp((-(dx * dx + dy * dy) / (faceR * faceR)) * 1.2);
        const sx = x - noseShift - faceShift;
        const x0 = Math.floor(sx);
        const fx = sx - x0;
        const xa = Math.min(W - 1, Math.max(0, x0));
        const xb = Math.min(W - 1, Math.max(0, x0 + 1));
        const o = (y * W + x) * 3;
        for (let c = 0; c < 3; c++) res[o + c] = Math.round(data[(y * W + xa) * 3 + c] * (1 - fx) + data[(y * W + xb) * 3 + c] * fx);
      }
    }
    warpCache.set(key, res);
    return res;
  };

  // Amplitude timeline (seconds). Positive amp = nose toward image right = subject turns to THEIR left (yaw+).
  const keyframes: [number, number][] = [[0, 0], [frontalSec, 0]];
  let t = frontalSec;
  for (let i = 0; i < cycles; i++) {
    for (const [dur, amp] of [[1.2, TURN_AMP], [2.5, TURN_AMP], [1.2, 0], [1.5, 0], [1.2, -TURN_AMP], [2.5, -TURN_AMP], [1.2, 0], [1.5, 0]] as const) {
      t += dur;
      keyframes.push([t, amp]);
    }
  }
  const ampAt = (time: number): number => {
    for (let i = 1; i < keyframes.length; i++) {
      const [t1, a1] = keyframes[i];
      const [t0, a0] = keyframes[i - 1];
      if (time <= t1) {
        const u = t1 === t0 ? 1 : (time - t0) / (t1 - t0);
        const s = u * u * (3 - 2 * u); // smoothstep
        return a0 + (a1 - a0) * s;
      }
    }
    return 0;
  };

  const fd = openSync(out, 'w');
  writeSync(fd, `YUV4MPEG2 W${W} H${H} F${fps}:1 Ip A1:1 C420jpeg\n`);
  const total = Math.round(t * fps);
  for (let f = 0; f < total; f++) {
    const rgb = warp(Math.round(ampAt(f / fps) * 20) / 20); // quantise to reuse warps
    writeSync(fd, 'FRAME\n');
    writeSync(fd, toI420(rgb, f));
  }
  closeSync(fd);
  console.log(`wrote ${out}: ${total} frames, ${(t).toFixed(1)} s, iod ${iod.toFixed(1)} px`);
}

function toI420(rgb: Buffer, frame: number): Buffer {
  const ySize = W * H;
  const cSize = (W / 2) * (H / 2);
  const o = Buffer.alloc(ySize + 2 * cSize);
  const dx = Math.round(Math.sin(frame / 3) * 1); // tiny jitter so the feed is never "frozen"
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = Math.min(W - 1, Math.max(0, x - dx));
      const i = (y * W + sx) * 3;
      const n = (Math.random() - 0.5) * 6;
      o[y * W + x] = Math.max(0, Math.min(255, Math.round(0.257 * rgb[i] + 0.504 * rgb[i + 1] + 0.098 * rgb[i + 2] + 16 + n)));
    }
  }
  for (let y = 0; y < H / 2; y++) {
    for (let x = 0; x < W / 2; x++) {
      const i = (y * 2 * W + x * 2) * 3;
      o[ySize + y * (W / 2) + x] = Math.max(0, Math.min(255, Math.round(-0.148 * rgb[i] - 0.291 * rgb[i + 1] + 0.439 * rgb[i + 2] + 128)));
      o[ySize + cSize + y * (W / 2) + x] = Math.max(0, Math.min(255, Math.round(0.439 * rgb[i] - 0.368 * rgb[i + 1] - 0.071 * rgb[i + 2] + 128)));
    }
  }
  return o;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

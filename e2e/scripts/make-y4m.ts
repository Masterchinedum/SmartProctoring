/**
 * Builds a Y4M (YUV4MPEG2, C420) video from still images for Chromium's fake camera:
 *   chromium --use-fake-device-for-media-stream --use-file-for-fake-video-capture=<file>.y4m
 *
 * Each segment shows an image (letterboxed to WxH) for N seconds with a little per-frame jitter and
 * sensor-like noise so the feed is not "frozen". A segment with src "black" renders a covered lens,
 * "empty" renders an empty grey room (no face).
 *
 * Usage: tsx scripts/make-y4m.ts out.y4m '[{"src":"a.jpg","seconds":6},{"src":"empty","seconds":3}]' [fps=5] [w=640] [h=480]
 */
import { openSync, writeSync, closeSync } from 'node:fs';
import sharp from 'sharp';

export interface Segment { src: string; seconds: number; jitter?: boolean; shiftX?: number; scale?: number }

async function loadFrame(src: string, w: number, h: number, scale = 1, shiftX = 0): Promise<Buffer> {
  if (src === 'black' || src === 'empty') {
    const v = src === 'black' ? 3 : 150;
    return Buffer.alloc(w * h * 3, v);
  }
  const iw = Math.round(w * scale), ih = Math.round(h * scale);
  const img = await sharp(src).rotate().resize(iw, ih, { fit: 'contain', background: { r: 120, g: 120, b: 120 } }).removeAlpha().raw().toBuffer();
  const out = Buffer.alloc(w * h * 3, 120);
  const ox = Math.round((w - iw) / 2 + shiftX), oy = Math.round((h - ih) / 2);
  for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) {
    const dx = x + ox, dy = y + oy;
    if (dx < 0 || dy < 0 || dx >= w || dy >= h) continue;
    const si = (y * iw + x) * 3, di = (dy * w + dx) * 3;
    out[di] = img[si]; out[di + 1] = img[si + 1]; out[di + 2] = img[si + 2];
  }
  return out;
}

function rgbToI420(rgb: Buffer, w: number, h: number, dx: number, dy: number, noise: number): Buffer {
  const ySize = w * h, cSize = (w / 2) * (h / 2);
  const out = Buffer.alloc(ySize + 2 * cSize);
  const px = (x: number, y: number) => {
    const sx = Math.min(w - 1, Math.max(0, x - dx)), sy = Math.min(h - 1, Math.max(0, y - dy));
    return (sy * w + sx) * 3;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = px(x, y);
    const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
    const n = noise ? (Math.random() - 0.5) * noise : 0;
    out[y * w + x] = Math.max(0, Math.min(255, Math.round(0.257 * r + 0.504 * g + 0.098 * b + 16 + n)));
  }
  for (let y = 0; y < h / 2; y++) for (let x = 0; x < w / 2; x++) {
    const i = px(x * 2, y * 2);
    const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
    out[ySize + y * (w / 2) + x] = Math.max(0, Math.min(255, Math.round(-0.148 * r - 0.291 * g + 0.439 * b + 128)));
    out[ySize + cSize + y * (w / 2) + x] = Math.max(0, Math.min(255, Math.round(0.439 * r - 0.368 * g - 0.071 * b + 128)));
  }
  return out;
}

export async function makeY4m(outPath: string, segments: Segment[], fps = 5, w = 640, h = 480): Promise<void> {
  const fd = openSync(outPath, 'w');
  writeSync(fd, `YUV4MPEG2 W${w} H${h} F${fps}:1 Ip A1:1 C420jpeg\n`);
  for (const seg of segments) {
    const rgb = await loadFrame(seg.src, w, h, seg.scale ?? 1, seg.shiftX ?? 0);
    const frames = Math.max(1, Math.round(seg.seconds * fps));
    for (let f = 0; f < frames; f++) {
      const jitter = seg.jitter !== false && seg.src !== 'black';
      const dx = jitter ? Math.round(Math.sin(f / 3) * 2) : 0;
      const dy = jitter ? Math.round(Math.cos(f / 4) * 1) : 0;
      writeSync(fd, 'FRAME\n');
      writeSync(fd, rgbToI420(rgb, w, h, dx, dy, seg.src === 'black' ? 1 : 6));
    }
  }
  closeSync(fd);
}

if (process.argv[1] && process.argv[1].endsWith('make-y4m.ts')) {
  const [out, spec, fps, w, h] = process.argv.slice(2);
  if (!out || !spec) {
    console.error('usage: make-y4m.ts out.y4m <segments-json> [fps] [w] [h]');
    process.exit(1);
  }
  makeY4m(out, JSON.parse(spec), Number(fps ?? 5), Number(w ?? 640), Number(h ?? 480)).then(() => console.log('wrote', out));
}

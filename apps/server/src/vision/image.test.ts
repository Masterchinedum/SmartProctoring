import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { decodeImage, dhashFromGray, hammingHex, luma, VisionInputError, wholeImageStats } from './image';

function grayGradient(w: number, h: number, dir: 'lr' | 'rl'): Float32Array {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = dir === 'lr' ? (x * 255) / (w - 1) : 255 - (x * 255) / (w - 1);
  return g;
}

describe('dHash', () => {
  it('is 16 hex chars; brightness decreasing left->right sets every bit', () => {
    expect(dhashFromGray(grayGradient(90, 80, 'rl'), 90, 80)).toBe('ffffffffffffffff');
    expect(dhashFromGray(grayGradient(90, 80, 'lr'), 90, 80)).toBe('0000000000000000');
  });

  it('matches between the RGB single-pass and the gray implementation', () => {
    const w = 45;
    const h = 40;
    const rgb = new Uint8Array(w * h * 3);
    const gray = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const v = (i * 37) % 251;
      rgb[3 * i] = rgb[3 * i + 1] = rgb[3 * i + 2] = v;
      gray[i] = luma(v, v, v);
    }
    expect(wholeImageStats({ data: rgb, width: w, height: h }).dhash).toBe(dhashFromGray(gray, w, h));
  });

  it('computes Hamming distances between hex strings', () => {
    expect(hammingHex('ffffffffffffffff', '0000000000000000')).toBe(64);
    expect(hammingHex('0f', '0e')).toBe(1);
    expect(hammingHex('abc', '0abc')).toBe(0);
    expect(() => hammingHex('zz', '00')).toThrow();
  });
});

describe('wholeImageStats', () => {
  it('reports mean / std luminance', () => {
    const w = 200;
    const h = 160;
    const uniform = wholeImageStats({ data: new Uint8Array(w * h * 3).fill(100), width: w, height: h });
    expect(uniform.brightness).toBeCloseTo(100, 0);
    expect(uniform.contrast).toBeCloseTo(0, 5);
    // Left half black, right half 200 => mean 100, std 100.
    const data = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) data.fill(200, (y * w + w / 2) * 3, (y * w + w) * 3);
    const split = wholeImageStats({ data, width: w, height: h });
    expect(split.brightness).toBeCloseTo(100, 0);
    expect(split.contrast).toBeCloseTo(100, 0);
  });
});

describe('decodeImage', () => {
  it('applies EXIF orientation and downscales to the working size', async () => {
    const jpg = await sharp({ create: { width: 300, height: 100, channels: 3, background: { r: 200, g: 10, b: 10 } } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const img = await decodeImage(jpg, 1280);
    expect([img.origWidth, img.origHeight]).toEqual([100, 300]);
    expect([img.width, img.height]).toEqual([100, 300]);
    const small = await decodeImage(jpg, 150);
    expect(small.height).toBe(150);
    expect(small.scale).toBeCloseTo(0.5, 2);
    expect(small.data.length).toBe(small.width * small.height * 3);
  });

  it('converts grayscale and alpha images to RGB', async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } } })
      .png()
      .toBuffer();
    const img = await decodeImage(png);
    expect(img.data.length).toBe(300);
    const gray = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 90, g: 90, b: 90 } } })
      .toColourspace('b-w')
      .png()
      .toBuffer();
    const g = await decodeImage(gray);
    expect(g.data.length).toBe(300);
    expect(g.data[0]).toBe(g.data[1]);
  });

  it('rejects garbage with VisionInputError', async () => {
    await expect(decodeImage(Buffer.from('definitely not an image'))).rejects.toBeInstanceOf(VisionInputError);
    await expect(decodeImage(Buffer.alloc(0))).rejects.toBeInstanceOf(VisionInputError);
  });
});

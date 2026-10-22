import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { chromium, firefox, test, webkit, type Browser, type BrowserContext, type BrowserContextOptions, type BrowserType, type LaunchOptions, type Page } from '@playwright/test';
import sharp from 'sharp';
import { cameraModeFor, FIREFOX_PREFS, type BrowserName, type CameraMode } from './browsers';
import { CHROMIUM_EXECUTABLE, HEADED } from './config';

/**
 * The candidate's camera in browsers without Chromium's file-backed fake capture device (Firefox, WebKit) — and in
 * Chromium with E2E_CAMERA=shim, which is how the shim is developed and checked against the device mode.
 *
 * Shim = an init script that replaces navigator.mediaDevices.getUserMedia / enumerateDevices with a stream from
 * HTMLCanvasElement.captureStream(). The canvas shows the frames of the SAME Y4M fixture the Chromium device plays:
 * the test process reads frame i of the file, converts it to RGB (BT.601, like the browser does for the device's
 * I420 frames) and hands it to the page as a JPEG (quality 95) through a Playwright binding, one second of video per
 * call — no network request, so it works offline (scenario 09) and under the app's CSP. Behaviour modelled on
 * Chromium's file camera:
 *
 *  - frame 0 when the camera is opened (getUserMedia resolves once the first 2 s are decoded, a camera's warm-up),
 *    then the file's own frame rate (5 fps), looping at the end; the next 3 s are fetched and decoded ahead, a late
 *    frame keeps the previous one on screen (like a camera dropping frames); the `mute` events a browser fires on a
 *    canvas track that briefly got no frame (the page's main thread was busy) are hidden from the app;
 *  - one camera per page: tracks opened while another is live share its timeline; when the last track is stopped
 *    the camera closes, and the next open starts again at frame 0 (pause, hold, reconnect, re-verification).
 *    Difference: Chromium shares ONE device among all pages of a browser; the shim has one per page (no core
 *    scenario has two pages of the same browser with the camera open on a time-dependent fixture);
 *  - the fixture's own size (the app asks for 1280×720 ideal and gets 640×480, as from the device); constraints the
 *    file cannot meet (exact / min / max width, height, frame rate, aspect ratio, deviceId, facingMode) fail with
 *    OverconstrainedError; getSettings() reports deviceId, groupId, size and frame rate; a stable fake deviceId and a
 *    label the monitoring engine recognises as a fake camera (`camera_feed_suspect`, as with Chromium's device);
 *  - "no camera" (a browser launched without a fixture): enumerateDevices() lists no camera and getUserMedia()
 *    rejects with NotFoundError — the no-camera accommodation scenario.
 */

export const FRAME_BINDING = '__spE2eCameraFrame';
export const SHIM_CAMERA_LABEL = 'Fake camera (e2e canvas shim)';
const SHIM_DEVICE_ID = createHash('sha256').update('sp-e2e-canvas-camera:device').digest('hex');
const SHIM_GROUP_ID = createHash('sha256').update('sp-e2e-canvas-camera:group').digest('hex');
/** Frames fetched ahead of the one on screen (3 s at 5 fps: a fetch can take seconds on a loaded machine). */
const PREFETCH = 15;

/** The project's browser (Playwright `browserName`); Chromium outside a test (scripts). */
export function currentBrowser(): BrowserName {
  try {
    const use = test.info().project.use as { browserName?: BrowserName; defaultBrowserType?: BrowserName };
    return use.browserName ?? use.defaultBrowserType ?? 'chromium';
  } catch {
    return 'chromium';
  }
}

export function cameraMode(): CameraMode {
  return cameraModeFor(currentBrowser());
}

/* ------------------------------------------------------------------------------------------------ Y4M frames */

const JPEG_CACHE = new Map<string, Buffer>();
const JPEG_PENDING = new Map<string, Promise<Buffer>>();
let jpegCacheBytes = 0;
const JPEG_CACHE_MAX_BYTES = 96 * 1024 * 1024;

/** Random access to the frames of a YUV4MPEG2 (4:2:0) file, as JPEG. */
export class Y4mVideo {
  private static readonly open = new Map<string, Y4mVideo>();
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frames: number;
  private readonly fd: number;
  private readonly dataStart: number;
  private readonly frameStride: number;
  private readonly frameHeader: number;

  static get(path: string): Y4mVideo {
    let v = Y4mVideo.open.get(path);
    if (!v) Y4mVideo.open.set(path, (v = new Y4mVideo(path)));
    return v;
  }

  private constructor(readonly path: string) {
    const fd = openSync(path, 'r');
    try {
      const head = Buffer.alloc(1024);
      const n = readSync(fd, head, 0, head.length, 0);
      const nl = head.subarray(0, n).indexOf(0x0a);
      const line = nl > 0 ? head.subarray(0, nl).toString('ascii') : '';
      if (!line.startsWith('YUV4MPEG2 ')) throw new Error(`${path}: not a YUV4MPEG2 file`);
      const tok = (c: string) => line.split(' ').find((t) => t.startsWith(c))?.slice(1);
      this.width = Number(tok('W'));
      this.height = Number(tok('H'));
      const [num, den] = (tok('F') ?? '5:1').split(':').map(Number);
      this.fps = num! / (den || 1);
      const colour = tok('C') ?? '420jpeg';
      if (!colour.startsWith('420')) throw new Error(`${path}: colour space C${colour} is not supported (4:2:0 only)`);
      const fh = head.subarray(nl + 1, n).indexOf(0x0a);
      if (head.subarray(nl + 1, nl + 6).toString('ascii') !== 'FRAME' || fh < 0) throw new Error(`${path}: no FRAME header after the stream header`);
      this.frameHeader = fh + 1;
      this.dataStart = nl + 1;
      this.frameStride = this.frameHeader + (this.width * this.height * 3) / 2;
      this.frames = Math.floor((fstatSync(fd).size - this.dataStart) / this.frameStride);
      if (!(this.width > 0 && this.height > 0 && this.fps > 0 && this.frames > 0)) throw new Error(`${path}: unexpected header "${line}"`);
      this.fd = fd;
    } catch (e) {
      closeSync(fd);
      throw e;
    }
  }

  /** Frame i (modulo the length) as packed RGB, BT.601 limited range with the chroma of each 2×2 block. */
  rgb(i: number): Buffer {
    const { width: w, height: h } = this;
    const f = ((i % this.frames) + this.frames) % this.frames;
    const yuv = Buffer.alloc(this.frameStride - this.frameHeader);
    readSync(this.fd, yuv, 0, yuv.length, this.dataStart + f * this.frameStride + this.frameHeader);
    const out = Buffer.alloc(w * h * 3);
    const px = new Uint8ClampedArray(out.buffer, out.byteOffset, out.length);
    const cw = w >> 1;
    const uOff = w * h;
    const vOff = uOff + cw * (h >> 1);
    for (let y = 0; y < h; y++) {
      const crow = (y >> 1) * cw;
      for (let x = 0; x < w; x++) {
        const c = 298 * (yuv[y * w + x]! - 16) + 128;
        const d = yuv[uOff + crow + (x >> 1)]! - 128;
        const e = yuv[vOff + crow + (x >> 1)]! - 128;
        const o = (y * w + x) * 3;
        px[o] = (c + 409 * e) >> 8;
        px[o + 1] = (c - 100 * d - 208 * e) >> 8;
        px[o + 2] = (c + 516 * d) >> 8;
      }
    }
    return out;
  }

  /** Frame i as a JPEG (quality 95; the source is 4:2:0 already). Cached per worker (bounded), encoded once. */
  jpeg(i: number): Promise<Buffer> {
    const key = `${this.path}#${((i % this.frames) + this.frames) % this.frames}`;
    const hit = JPEG_CACHE.get(key);
    if (hit) {
      JPEG_CACHE.delete(key);
      JPEG_CACHE.set(key, hit);
      return Promise.resolve(hit);
    }
    let p = JPEG_PENDING.get(key);
    if (!p) {
      p = sharp(this.rgb(i), { raw: { width: this.width, height: this.height, channels: 3 } })
        .jpeg({ quality: 95, chromaSubsampling: '4:2:0' })
        .toBuffer()
        .then((buf) => {
          JPEG_CACHE.set(key, buf);
          jpegCacheBytes += buf.length;
          for (const [k, v] of JPEG_CACHE) {
            if (jpegCacheBytes <= JPEG_CACHE_MAX_BYTES) break;
            JPEG_CACHE.delete(k);
            jpegCacheBytes -= v.length;
          }
          return buf;
        })
        .finally(() => JPEG_PENDING.delete(key));
      JPEG_PENDING.set(key, p);
    }
    return p;
  }
}

/* ------------------------------------------------------------------------------------------------ browsers */

/** What a candidate browser's camera shows (shim mode): a Y4M fixture, or nothing (no camera connected). */
type CameraSource = { y4m: string } | { y4m: null };
const SOURCES = new WeakMap<Browser | BrowserContext, CameraSource>();
/** The shim's frame statistics per page, as last reported with a frame request (readable after the page closed). */
export interface ShimStats {
  fetched: number;
  failed: number;
  msTotal: number;
  msMax: number;
  lagMax: number;
  /** `mute` events of the shim's canvas tracks (not passed on to the app, see openTrack). */
  mutes: number;
  /** How late the frame timer ran (ms, total / worst, over `ticks`): how busy the page's main thread was. */
  lateTotal: number;
  lateMax: number;
  ticks: number;
}
const STATS = new WeakMap<Page, ShimStats>();
export function shimStats(page: Page): ShimStats | null {
  return STATS.get(page) ?? null;
}
const INSTALLED = new WeakSet<BrowserContext>();

function browserType(name: BrowserName): BrowserType {
  return name === 'firefox' ? firefox : name === 'webkit' ? webkit : chromium;
}

function launchOptions(name: BrowserName): LaunchOptions {
  if (name === 'firefox') return { headless: !HEADED, firefoxUserPrefs: FIREFOX_PREFS };
  if (name === 'webkit') return { headless: !HEADED };
  // Same flags as the device mode minus the fake capture device: timers and the camera keep running in background tabs.
  return { headless: !HEADED, executablePath: CHROMIUM_EXECUTABLE, args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] };
}

/** A candidate browser (the project's browser type) whose camera shim plays `y4m` — or has no camera (null). */
export async function launchShimCamera(y4m: string | null): Promise<Browser> {
  if (y4m) Y4mVideo.get(y4m); // fail here, not in the page, when the file is unusable
  const browser = await browserType(currentBrowser()).launch(launchOptions(currentBrowser()));
  SOURCES.set(browser, { y4m });
  return browser;
}

/** Persistent profile + camera shim (see launchPersistentCamera in lib/candidate.ts). */
export async function launchShimPersistentCamera(y4m: string, userDataDir: string, options: BrowserContextOptions): Promise<BrowserContext> {
  Y4mVideo.get(y4m);
  const name = currentBrowser();
  const context = await browserType(name).launchPersistentContext(userDataDir, { ...launchOptions(name), ...options, ...cameraPermissions() });
  SOURCES.set(context, { y4m });
  return context;
}

/**
 * Context options that let the page use the camera: Chromium grants the permission (device and shim mode alike);
 * Playwright's Firefox and WebKit have no camera permission to grant, and the shim needs none.
 */
export function cameraPermissions(): { permissions?: string[] } {
  return currentBrowser() === 'chromium' ? { permissions: ['camera'] } : {};
}

/**
 * Shim mode: installs the camera shim (frame binding + init script) in a candidate context, once, before any page
 * is created. The camera is the one its browser (or persistent context) was launched with; a browser launched by
 * Playwright itself (the `browser` fixture) has no camera. Device mode: nothing to do.
 */
export async function installCamera(context: BrowserContext): Promise<void> {
  if (cameraMode() !== 'shim' || INSTALLED.has(context)) return;
  INSTALLED.add(context);
  const browser = context.browser();
  const source = SOURCES.get(context) ?? (browser ? SOURCES.get(browser) : undefined) ?? { y4m: null };
  if (!source.y4m) {
    await context.addInitScript(fakeCameraInit, { mode: 'none', width: 0, height: 0, fps: 0, frames: 0, label: '', deviceId: '', groupId: '', binding: '', prefetch: 0 } satisfies ShimConfig);
    return;
  }
  const video = Y4mVideo.get(source.y4m);
  // Encode the first seconds now, while the page loads: the camera's warm-up then reads them from the cache.
  for (let i = 0; i < Math.min(video.frames, 3 * Math.round(video.fps)); i++) void video.jpeg(i).catch(() => undefined);
  // Frames [first, first + count) as base64 JPEGs (the page asks for one second of video at a time).
  await context.exposeBinding(FRAME_BINDING, async (caller, first: number, count: number, stats?: ShimStats) => {
    if (stats && caller.page) STATS.set(caller.page, stats);
    return Promise.all(Array.from({ length: Math.max(1, Math.min(60, Number(count) || 1)) }, async (_, k) => (await video.jpeg((Number(first) || 0) + k)).toString('base64')));
  });
  await context.addInitScript(fakeCameraInit, {
    mode: 'video',
    width: video.width,
    height: video.height,
    fps: video.fps,
    frames: video.frames,
    label: SHIM_CAMERA_LABEL,
    deviceId: SHIM_DEVICE_ID,
    groupId: SHIM_GROUP_ID,
    binding: FRAME_BINDING,
    prefetch: PREFETCH,
    captureFps: currentBrowser() === 'webkit' ? video.fps : undefined,
  } satisfies ShimConfig);
}

/* ------------------------------------------------------------------------------------------------ in the page */

interface ShimConfig {
  mode: 'video' | 'none';
  width: number;
  height: number;
  fps: number;
  frames: number;
  label: string;
  deviceId: string;
  groupId: string;
  binding: string;
  prefetch: number;
  /**
   * WebKit: capture the canvas at this frame rate (a timer) and show it opaque at 64×48 px in the corner — with
   * change-driven capture of a 2 px transparent canvas its <video> stayed on the first frame. Other engines:
   * change-driven capture plus requestFrame().
   */
  captureFps?: number;
}

type Drawable = ImageBitmap | HTMLImageElement;

/** Init script (serialised into every document of the context; runs before the app's code). */
function fakeCameraInit(cfg: ShimConfig): void {
  let md = navigator.mediaDevices as MediaDevices | undefined;
  const w = window as unknown as Record<string, unknown>;
  // A secure page without mediaDevices: the engine exposes no capture API at all (Playwright's WebKit on macOS), so the
  // shim supplies the object too. An insecure page keeps none: the app reports it, exactly like the real browser.
  if (!md && window.isSecureContext && cfg.mode === 'video') {
    md = new EventTarget() as MediaDevices;
    Object.defineProperty(navigator, 'mediaDevices', { value: md, configurable: true });
  }
  if (!md || w.__spFakeCamera) return;
  const { width, height, fps, frames } = cfg;
  /** Frames per binding call: one second of video. */
  const CHUNK = Math.max(1, Math.round(fps));

  const fail = (name: string, message: string, constraint?: string): Error => {
    let e: Error;
    try {
      e = new DOMException(message, name);
    } catch {
      e = new Error(message);
      e.name = name;
    }
    if (constraint) Object.defineProperty(e, 'constraint', { value: constraint });
    return e;
  };

  const info = () => {
    const d = { deviceId: cfg.deviceId, groupId: cfg.groupId, kind: 'videoinput', label: cfg.label };
    return { ...d, toJSON: () => d } as unknown as MediaDeviceInfo;
  };
  md.enumerateDevices = async () => (cfg.mode === 'video' ? [info()] : []);

  /** First constraint the fixture cannot meet (bare values are "ideal" and never fail), or null. */
  const violated = (vc: MediaTrackConstraints | undefined): string | null => {
    if (!vc || typeof vc !== 'object') return null;
    const num = (name: string, c: unknown, v: number): string | null => {
      if (c == null || typeof c !== 'object') return null;
      const r = c as { exact?: number; min?: number; max?: number };
      if (r.exact != null && Math.abs(r.exact - v) > 1e-6) return name;
      if (r.min != null && r.min > v + 1e-6) return name;
      if (r.max != null && r.max < v - 1e-6) return name;
      return null;
    };
    const str = (name: string, c: unknown, v: string): string | null => {
      if (c == null || typeof c !== 'object' || Array.isArray(c)) return null;
      const exact = (c as { exact?: string | string[] }).exact;
      if (exact == null) return null;
      return (Array.isArray(exact) ? exact : [exact]).includes(v) ? null : name;
    };
    return (
      str('deviceId', vc.deviceId, cfg.deviceId) ??
      str('groupId', vc.groupId, cfg.groupId) ??
      str('facingMode', vc.facingMode, 'user') ??
      num('width', vc.width, width) ??
      num('height', vc.height, height) ??
      num('frameRate', vc.frameRate, fps) ??
      num('aspectRatio', vc.aspectRatio, width / height)
    );
  };

  /* One camera per document: a canvas with a frame clock started at open; its tracks are canvas captures. */
  const dev = {
    canvas: null as HTMLCanvasElement | null,
    ctx: null as CanvasRenderingContext2D | null,
    tracks: new Set<MediaStreamTrack>(),
    running: false,
    starting: null as Promise<void> | null,
    t0: 0,
    /** Frame number (not modulo) due now / last drawn; index of the frame on the canvas. */
    due: -1,
    shownN: -1,
    shownIdx: -1,
    timer: 0 as unknown as ReturnType<typeof setTimeout>,
    images: new Map<number, Promise<Drawable | null>>(),
    inflight: 0,
    /** When the frame timer is due (performance.now()). */
    dueAt: 0,
    /** Diagnostics: frames fetched, their total / slowest fetch + decode time, the largest lag seen (frames). */
    stats: { fetched: 0, failed: 0, msTotal: 0, msMax: 0, lagMax: 0, mutes: 0, lateTotal: 0, lateMax: 0, ticks: 0 },
  };

  const decode = async (b64: string): Promise<Drawable> => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  /**
   * Frames come from the test process (Playwright binding) in chunks of one second of video — one call, one
   * delivery task in the page per chunk — and are decoded on arrival; the chunks of the next `prefetch` frames are
   * kept loaded, at most two requests at a time (in order, so the frames due next are never queued behind later
   * ones). The page's main thread is shared with the app's own analysis, so fewer, earlier tasks keep the frames on
   * time on a loaded machine.
   */
  const chunkOf = (i: number) => Math.floor(i / CHUNK);
  const fetchChunk = (c: number) => {
    const first = c * CHUNK;
    const count = Math.min(CHUNK, frames - first);
    const t = performance.now();
    const settle: ((v: Promise<Drawable | null> | null) => void)[] = [];
    for (let k = 0; k < count; k++) dev.images.set(first + k, new Promise<Drawable | null>((r) => settle.push(r)));
    dev.inflight++;
    Promise.resolve()
      .then(() => (w[cfg.binding] as (first: number, count: number, stats: unknown) => Promise<string[]>)(first, count, { ...dev.stats }))
      .then((list) => {
        settle.forEach((r, k) =>
          r(
            decode(list[k]!).then(
              (img) => {
                const ms = performance.now() - t;
                dev.stats.fetched++;
                dev.stats.msTotal += ms;
                dev.stats.msMax = Math.max(dev.stats.msMax, ms);
                return img;
              },
              () => {
                dev.stats.failed++;
                return null;
              },
            ),
          ),
        );
      })
      .catch(() => {
        dev.stats.failed += count;
        settle.forEach((r) => r(null));
      })
      .finally(() => {
        dev.inflight--;
        prefetch();
      });
  };
  const frame = (i: number): Promise<Drawable | null> => {
    if (!dev.images.has(i)) fetchChunk(chunkOf(i));
    return dev.images.get(i)!;
  };
  const prefetch = () => {
    if (!dev.running) return;
    const n = Math.max(0, Math.floor(((performance.now() - dev.t0) * fps) / 1000));
    for (let k = 1; k <= cfg.prefetch && dev.inflight < 2; k++) {
      const first = chunkOf((n + k) % frames) * CHUNK;
      if (!dev.images.has(first)) fetchChunk(first / CHUNK);
    }
  };
  const release = (p: Promise<Drawable | null>) => void p.then((img) => img && 'close' in img && img.close());
  /** Drops the chunks outside [cur, cur + prefetch] (except the frame on the canvas). */
  const evict = (cur: number) => {
    const keep = new Set<number>([chunkOf(Math.max(0, dev.shownIdx))]);
    for (let k = 0; k <= cfg.prefetch; k++) keep.add(chunkOf((cur + k) % frames));
    for (const [i, p] of dev.images) {
      if (keep.has(chunkOf(i))) continue;
      dev.images.delete(i);
      release(p);
    }
  };
  const draw = (img: Drawable) => {
    try {
      dev.ctx!.drawImage(img, 0, 0, width, height);
    } catch {
      /* image closed in the meantime: the next frame follows */
      return;
    }
    // Capture this frame now on every track: without an explicit request an engine captures only when it notices the
    // canvas changed, and WebKit's tracks kept showing an old frame while the video clock ran on.
    for (const t of dev.tracks) (t as MediaStreamTrack & { requestFrame?: () => void }).requestFrame?.();
  };
  const show = async (n: number) => {
    const img = await frame(n % frames);
    if (!img || !dev.running || n <= dev.shownN) return; // a later frame is already on the canvas
    draw(img);
    dev.shownN = n;
    dev.shownIdx = n % frames;
  };
  const tick = () => {
    if (!dev.running) return;
    if (dev.dueAt) {
      const late = Math.max(0, performance.now() - dev.dueAt);
      dev.stats.ticks++;
      dev.stats.lateTotal += late;
      dev.stats.lateMax = Math.max(dev.stats.lateMax, late);
    }
    const n = Math.floor(((performance.now() - dev.t0) * fps) / 1000);
    if (n !== dev.due) {
      dev.due = n;
      void show(n);
    }
    dev.stats.lagMax = Math.max(dev.stats.lagMax, n - dev.shownN);
    evict(n % frames);
    prefetch();
    const wait = Math.max(4, dev.t0 + ((n + 1) * 1000) / fps - performance.now());
    dev.dueAt = performance.now() + wait;
    dev.timer = setTimeout(tick, wait);
  };
  const start = async () => {
    if (!dev.canvas) {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      c.setAttribute('aria-hidden', 'true');
      c.setAttribute('data-sp-e2e-camera', '');
      const size = cfg.captureFps ? { width: '64px', height: '48px', opacity: '1' } : { width: '2px', height: '2px', opacity: '0' };
      Object.assign(c.style, { position: 'fixed', left: '0', top: '0', ...size, pointerEvents: 'none' });
      // In the document (not only in memory) and inside the viewport, so that every engine keeps painting it and
      // capturing its frames (engines may skip work for content outside the viewport).
      document.documentElement.appendChild(c);
      dev.canvas = c;
      dev.ctx = c.getContext('2d', { alpha: false });
    }
    // Warm-up, like a camera starting: the first two seconds of video are decoded before the stream is handed out,
    // so frames flow steadily from the first moment (the readiness check measures exactly that).
    const warm = Math.min(frames, 2 * CHUNK);
    const ready = await Promise.all(Array.from({ length: warm }, (_, i) => frame(i)));
    const first = ready[0];
    if (!first || !dev.ctx) throw fail('NotReadableError', 'The e2e camera shim could not read the first frame of its fixture');
    dev.t0 = performance.now();
    dev.running = true;
    draw(first);
    dev.due = dev.shownN = dev.shownIdx = 0;
    tick();
  };
  const stopCamera = () => {
    dev.running = false;
    clearTimeout(dev.timer);
    for (const p of dev.images.values()) release(p);
    dev.images.clear();
    dev.due = dev.shownN = dev.shownIdx = -1;
    dev.dueAt = 0;
  };

  const openTrack = (constraints: MediaTrackConstraints): MediaStreamTrack => {
    const track = (cfg.captureFps ? dev.canvas!.captureStream(cfg.captureFps) : dev.canvas!.captureStream()).getVideoTracks()[0]!;
    let current: MediaTrackConstraints = { ...constraints };
    const settings: MediaTrackSettings = { deviceId: cfg.deviceId, groupId: cfg.groupId, width, height, frameRate: fps, aspectRatio: width / height, facingMode: 'user' };
    const stop = track.stop.bind(track);
    const clone = track.clone.bind(track);
    const listen = track.addEventListener.bind(track);
    const unlisten = track.removeEventListener.bind(track);
    // A browser may mute a canvas track that gets no new frame for a moment — the page's main thread, shared with
    // the app's face analysis, was too busy to draw. A camera does not stop because a page is busy, so these mute
    // events are an artefact of the shim: they are counted (stats) but never reach the app.
    listen('mute', () => dev.stats.mutes++);
    const artefact = (type: string) => type === 'mute' || type === 'unmute';
    const own = (value: unknown) => ({ value, configurable: true, writable: true });
    Object.defineProperties(track, {
      label: { value: cfg.label, configurable: true },
      muted: { get: () => false, configurable: true },
      onmute: own(null),
      onunmute: own(null),
      addEventListener: own((type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) => {
        if (fn && !artefact(type)) listen(type, fn, opts);
      }),
      removeEventListener: own((type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions) => {
        if (fn && !artefact(type)) unlisten(type, fn, opts);
      }),
      getSettings: own(() => ({ ...settings, resizeMode: 'none' })),
      getCapabilities: own(() => ({
        deviceId: cfg.deviceId,
        groupId: cfg.groupId,
        width: { min: 1, max: width },
        height: { min: 1, max: height },
        frameRate: { min: 0, max: fps },
        aspectRatio: { min: 1 / height, max: width },
        facingMode: ['user'],
        resizeMode: ['none'],
      })),
      getConstraints: own(() => ({ ...current })),
      applyConstraints: own(async (next: MediaTrackConstraints = {}) => {
        const bad = violated(next);
        if (bad) throw fail('OverconstrainedError', `The camera cannot satisfy the ${bad} constraint`, bad);
        current = { ...next };
      }),
      clone: own(() => (dev.running && track.readyState === 'live' ? openTrack(current) : clone())),
      stop: own(() => {
        stop();
        if (dev.tracks.delete(track) && dev.tracks.size === 0) stopCamera();
      }),
    });
    dev.tracks.add(track);
    // A new capture delivers frames from the next draw on: repaint the frame on the canvas now.
    const cur = dev.images.get(dev.shownIdx);
    if (cur) void cur.then((img) => img && dev.running && draw(img));
    return track;
  };

  // Every request and its outcome, for the failure diagnostics (`__spFakeCamera.calls`).
  const calls: string[] = [];
  const record = <T,>(what: string, p: Promise<T>): Promise<T> => {
    const k = calls.push(`${what}: pending`) - 1;
    return p.then(
      (v) => ((calls[k] = `${what}: ok`), v),
      (e: unknown) => {
        calls[k] = `${what}: ${(e as Error)?.name ?? 'error'} ${(e as Error)?.message ?? ''}`.trim();
        throw e;
      },
    );
  };
  md.getUserMedia = (constraints?: MediaStreamConstraints): Promise<MediaStream> =>
    record(`getUserMedia(${JSON.stringify(constraints ?? {}).slice(0, 200)})`, getUserMedia(constraints));
  const getUserMedia = async (constraints?: MediaStreamConstraints): Promise<MediaStream> => {
    const c = constraints ?? {};
    if (!c.video && !c.audio) throw new TypeError("Failed to execute 'getUserMedia': At least one of audio and video must be requested");
    if (c.audio || cfg.mode !== 'video') throw fail('NotFoundError', 'Requested device not found');
    const vc = c.video === true ? {} : (c.video as MediaTrackConstraints);
    const bad = violated(vc);
    if (bad) throw fail('OverconstrainedError', `The camera cannot satisfy the ${bad} constraint`, bad);
    if (!dev.running) {
      dev.starting ??= start().finally(() => (dev.starting = null));
      await dev.starting;
    }
    return new MediaStream([openTrack(vc)]);
  };

  // Also on the prototype: WebKit on macOS hands the page a different MediaDevices object than the one this script
  // saw, whose getUserMedia was still the native one (a permission prompt Playwright cannot answer there).
  const proto = (window as unknown as { MediaDevices?: { prototype: MediaDevices } }).MediaDevices?.prototype;
  if (proto && proto !== md) {
    proto.getUserMedia = md.getUserMedia;
    proto.enumerateDevices = md.enumerateDevices;
  }

  // Diagnostics for tests (e.g. `page.evaluate(() => __spFakeCamera.frame())`).
  // `lag()`: frames the canvas is behind the clock (0 = on time).
  w.__spFakeCamera = {
    calls,
    mode: cfg.mode,
    width,
    height,
    fps,
    frames,
    label: cfg.label,
    liveTracks: () => dev.tracks.size,
    frame: () => dev.shownIdx,
    lag: () => (dev.running ? Math.floor(((performance.now() - dev.t0) * fps) / 1000) - dev.shownN : 0),
    stats: () => ({ ...dev.stats }),
  };
}

/**
 * Test doubles for the exam recording modules (jsdom has no MediaRecorder, MediaStream or real tracks).
 */
import type { MediaRecorderLike } from '../monitoring/recorder';

export class FakeTrack {
  readyState: 'live' | 'ended' = 'live';
  settings: Record<string, unknown>;
  stopped = false;
  clones: FakeTrack[] = [];
  private listeners = new Map<string, Set<() => void>>();
  /** What applying constraints to a clone does to this (its source) track: nothing, or a size change. */
  cloneChangesSource: Record<string, unknown> | null = null;
  source: FakeTrack | null = null;
  constructor(
    readonly kind: 'video' | 'audio',
    settings: Record<string, unknown> = {},
  ) {
    this.settings = { ...settings };
  }
  getSettings() {
    return { ...this.settings };
  }
  getConstraints() {
    return {};
  }
  async applyConstraints(c: MediaTrackConstraints) {
    const w = (c.width as { max?: number } | undefined)?.max;
    const h = (c.height as { max?: number } | undefined)?.max;
    if (w && (this.settings.width as number) > w) this.settings.width = w;
    if (h && (this.settings.height as number) > h) this.settings.height = h;
    if (this.source?.cloneChangesSource) Object.assign(this.source.settings, this.source.cloneChangesSource);
  }
  clone() {
    const c = new FakeTrack(this.kind, this.settings);
    c.source = this;
    this.clones.push(c);
    return c as unknown as MediaStreamTrack & FakeTrack;
  }
  stop() {
    this.stopped = true;
    this.readyState = 'ended';
  }
  addEventListener(type: string, fn: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  }
  /** The browser ends the track (unplugged camera, "Stop sharing"). */
  end() {
    this.readyState = 'ended';
    for (const fn of this.listeners.get('ended') ?? []) fn();
  }
}

export class FakeMediaStream {
  readonly tracks: FakeTrack[];
  constructor(tracks: (FakeTrack | MediaStreamTrack)[] = []) {
    this.tracks = tracks as FakeTrack[];
  }
  getTracks() {
    return [...this.tracks];
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
}

/** Install FakeMediaStream as the global MediaStream (jsdom has none). */
export function installFakeMediaStream(): void {
  (globalThis as unknown as { MediaStream: unknown }).MediaStream = FakeMediaStream;
}

/**
 * A MediaRecorder double: `stop()` delivers its data and fires onstop asynchronously, like the real one. Every
 * instance is kept in `FakeRecorder.instances`.
 */
export class FakeRecorder implements MediaRecorderLike {
  static instances: FakeRecorder[] = [];
  static supported: string[] = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm'];
  static failConstruct = false;
  static bytes = 1000;
  static isTypeSupported(t: string) {
    return FakeRecorder.supported.includes(t);
  }
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  readonly mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(
    readonly stream: FakeMediaStream,
    readonly options: MediaRecorderOptions = {},
  ) {
    if (FakeRecorder.failConstruct) throw new DOMException('not supported', 'NotSupportedError');
    this.mimeType = options.mimeType ?? 'video/webm';
    FakeRecorder.instances.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    queueMicrotask(() => {
      if (FakeRecorder.bytes > 0) this.ondataavailable?.({ data: new Blob([new Uint8Array(FakeRecorder.bytes)], { type: this.mimeType }) });
      this.onstop?.();
    });
  }
  /** The recorder stops by itself (its tracks ended). */
  stopBySelf() {
    this.stop();
  }
  static reset() {
    FakeRecorder.instances = [];
    FakeRecorder.supported = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm'];
    FakeRecorder.failConstruct = false;
    FakeRecorder.bytes = 1000;
  }
}

/** Let queued microtasks and promise chains run. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

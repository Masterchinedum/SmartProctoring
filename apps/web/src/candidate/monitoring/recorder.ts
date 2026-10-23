import { RECORDING_SEGMENT_MS, type RecordingStream } from '@sp/shared';

/**
 * Segmented recording of one media stream (exam recording, policy.recording).
 *
 * MediaRecorder is restarted every RECORDING_SEGMENT_MS on the same tracks, so every segment is a complete file with
 * its own header: it plays on its own, a lost segment never breaks the others, and staff play a list of segments
 * with absolute start times. The next recorder starts right after the previous one is asked to stop (they overlap by
 * a few milliseconds rather than leaving a gap); each finished segment is handed over as a Blob with its sequence
 * number, start (server clock) and duration.
 *
 * Conservative bitrates keep an hour of exam near 300 MB with webcam, microphone and screen (docs/OPERATIONS.md):
 * webcam ~640×480 at 15 fps, 350 kbit/s video + 32 kbit/s Opus; screen ≤ 1280 px at 5 fps, 300 kbit/s.
 */

export const CAMERA_VIDEO_BPS = 350_000;
export const CAMERA_AUDIO_BPS = 32_000;
export const SCREEN_VIDEO_BPS = 300_000;
/** The webcam recording's size and frame rate (a clone of the camera track, scaled down: the camera itself is unchanged). */
export const CAMERA_RECORDING_CONSTRAINTS: MediaTrackConstraints = { width: { max: 640 }, height: { max: 480 }, frameRate: { max: 15 } };

/** The part of MediaRecorder this module uses (tests pass a fake). */
export interface MediaRecorderLike {
  readonly state: 'inactive' | 'recording' | 'paused';
  readonly mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}

export interface MediaRecorderCtor {
  new (stream: MediaStream, options?: MediaRecorderOptions): MediaRecorderLike;
  isTypeSupported?(type: string): boolean;
}

export interface RecorderEnv {
  MediaRecorder?: MediaRecorderCtor;
  /** Server-synced clock (epoch ms): segment start times are compared with the exam's periods on the server. */
  now: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
}

/** The browser's MediaRecorder, if any. */
export function browserMediaRecorder(): MediaRecorderCtor | undefined {
  return typeof MediaRecorder === 'function' ? (MediaRecorder as unknown as MediaRecorderCtor) : undefined;
}

const WITH_AUDIO = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4'];
const VIDEO_ONLY = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm', 'video/mp4;codecs=avc1.42E01E', 'video/mp4'];

/**
 * The media type to record: WebM with VP8 (cheapest to encode next to the in-browser face analysis), then VP9, then
 * MP4 (Safari records only MP4). null: the browser's default (whatever it produces is stored as such).
 */
export function pickMimeType(withAudio: boolean, isTypeSupported: ((t: string) => boolean) | undefined): string | null {
  if (!isTypeSupported) return null;
  for (const t of withAudio ? WITH_AUDIO : VIDEO_ONLY) {
    try {
      if (isTypeSupported(t)) return t;
    } catch {
      /* a browser that throws for unknown types */
    }
  }
  return null;
}

export interface SegmentInfo {
  stream: RecordingStream;
  seq: number;
  /** Server-clock epoch ms when the segment started. */
  startedAt: number;
  durationMs: number;
  /** What the browser produced, e.g. video/webm;codecs=vp8,opus. */
  mimeType: string;
}

export interface SegmentedRecorderOptions {
  stream: MediaStream;
  kind: RecordingStream;
  mimeType: string | null;
  videoBitsPerSecond: number;
  audioBitsPerSecond?: number;
  segmentMs?: number;
  /** First sequence number (a restart continues the numbering of the same page). */
  firstSeq?: number;
  env: RecorderEnv;
  onSegment: (blob: Blob, info: SegmentInfo) => void;
  /** The recorder could not start or stopped by itself (`reason`: recorder_unavailable, recorder_error, stopped_unexpectedly). */
  onError: (reason: string, err?: unknown) => void;
}

interface Running {
  rec: MediaRecorderLike;
  seq: number;
  startedAt: number;
  chunks: Blob[];
  /** Resolves once its data was handed over (after onstop). */
  done: Promise<void>;
  /** We asked it to stop (rotation or stop()); any other stop is unexpected. */
  stopping: boolean;
}

export class SegmentedRecorder {
  private current: Running | null = null;
  private nextSeq: number;
  private timer: unknown = null;
  private running = false;
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly opts: SegmentedRecorderOptions) {
    this.nextSeq = opts.firstSeq ?? 0;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** The sequence number the next segment gets. */
  get nextSequence(): number {
    return this.nextSeq;
  }

  /** Start recording. False (and onError) when the browser cannot record this stream. */
  start(): boolean {
    if (this.running) return true;
    this.running = true;
    const seg = this.begin();
    if (!seg) {
      this.running = false;
      return false;
    }
    this.current = seg;
    this.arm();
    return true;
  }

  private arm(): void {
    const set = this.opts.env.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.timer = set(() => this.rotate(), this.opts.segmentMs ?? RECORDING_SEGMENT_MS);
  }

  private disarm(): void {
    if (this.timer != null) (this.opts.env.clearTimeout ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  private begin(): Running | null {
    const Ctor = this.opts.env.MediaRecorder;
    if (!Ctor) {
      this.opts.onError('recorder_unavailable');
      return null;
    }
    const options: MediaRecorderOptions = { videoBitsPerSecond: this.opts.videoBitsPerSecond };
    if (this.opts.audioBitsPerSecond) options.audioBitsPerSecond = this.opts.audioBitsPerSecond;
    if (this.opts.mimeType) options.mimeType = this.opts.mimeType;
    let rec: MediaRecorderLike;
    try {
      rec = new Ctor(this.opts.stream, options);
    } catch (err) {
      this.opts.onError('recorder_unavailable', err);
      return null;
    }
    let resolve!: () => void;
    const seg: Running = { rec, seq: this.nextSeq, startedAt: this.opts.env.now(), chunks: [], done: new Promise<void>((r) => (resolve = r)), stopping: false };
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) seg.chunks.push(e.data);
    };
    rec.onerror = (e) => {
      if (seg !== this.current) return;
      this.fail('recorder_error', e);
    };
    rec.onstop = () => {
      const durationMs = Math.max(0, Math.round(this.opts.env.now() - seg.startedAt));
      if (seg.chunks.length) {
        const mimeType = rec.mimeType || seg.chunks[0].type || this.opts.mimeType || 'video/webm';
        const blob = new Blob(seg.chunks, { type: mimeType });
        try {
          this.opts.onSegment(blob, { stream: this.opts.kind, seq: seg.seq, startedAt: Math.round(seg.startedAt), durationMs, mimeType });
        } catch (err) {
          console.warn('[recorder] segment handler failed', err);
        }
      }
      resolve();
      // A recorder that stopped on its own (its tracks ended): the recording is interrupted.
      if (!seg.stopping && seg === this.current) this.fail('stopped_unexpectedly');
    };
    try {
      rec.start();
    } catch (err) {
      this.opts.onError('recorder_unavailable', err);
      return null;
    }
    this.nextSeq++;
    return seg;
  }

  private finish(seg: Running): Promise<void> {
    seg.stopping = true;
    if (seg.rec.state !== 'inactive') {
      try {
        seg.rec.stop();
      } catch {
        /* already stopped: onstop has run or will not run */
      }
    }
    // Never wait for ever on a recorder that does not report its stop.
    const settled = Promise.race([seg.done, new Promise<void>((r) => setTimeout(r, 5000))]);
    this.pending.add(settled);
    void settled.finally(() => this.pending.delete(settled));
    return settled;
  }

  private rotate(): void {
    this.timer = null;
    if (!this.running || !this.current) return;
    const old = this.current;
    const next = this.begin();
    this.current = next;
    void this.finish(old);
    if (next) this.arm();
    else this.running = false;
  }

  private fail(reason: string, err?: unknown): void {
    if (!this.running) return;
    this.running = false;
    this.disarm();
    const seg = this.current;
    this.current = null;
    if (seg) void this.finish(seg);
    this.opts.onError(reason, err);
  }

  /** Stop recording; resolves once the last segment was handed over. */
  async stop(): Promise<void> {
    this.running = false;
    this.disarm();
    const seg = this.current;
    this.current = null;
    if (seg) await this.finish(seg);
    await Promise.allSettled([...this.pending]);
  }
}

/**
 * The webcam track to record: a clone of the camera's track scaled down to 640×480 at 15 fps, so the camera itself
 * (identity images at its full resolution, the face analysis) is not changed. Should applying the constraints to the
 * clone change the original (a browser that does not scale clones independently), the original's constraints are
 * restored and the original is recorded as it is (the bitrate still bounds the size). `owned`: stop it when done.
 */
export async function recordingVideoTrack(source: MediaStreamTrack): Promise<{ track: MediaStreamTrack; owned: boolean }> {
  const before = safeSettings(source);
  let clone: MediaStreamTrack;
  try {
    clone = source.clone();
  } catch {
    return { track: source, owned: false };
  }
  try {
    await clone.applyConstraints(CAMERA_RECORDING_CONSTRAINTS);
  } catch {
    /* recorded at the camera's size */
  }
  const after = safeSettings(source);
  if (before.width !== after.width || before.height !== after.height) {
    clone.stop();
    try {
      await source.applyConstraints(source.getConstraints());
    } catch {
      /* best effort */
    }
    return { track: source, owned: false };
  }
  return { track: clone, owned: true };
}

function safeSettings(t: MediaStreamTrack): MediaTrackSettings {
  try {
    return t.getSettings();
  } catch {
    return {};
  }
}

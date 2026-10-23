/**
 * Screen sharing for exams that record the screen (policy.recording.screen).
 *
 * `getDisplayMedia` needs a user gesture, so the candidate shares from a button: before the start (ready screen) and
 * whenever sharing stopped during the exam (the exam is covered until they share again). The exam requires the
 * ENTIRE screen: where the browser reports what was shared (`displaySurface`, Chromium and Firefox), a window or a
 * tab is refused with an explanation and the candidate asks again; where it does not (older Safari), the surface is
 * "unknown" and accepted — the browser's own picker then decides.
 *
 * Capture is kept small for recording: at most 1280 px on the longer side and 5 frames per second.
 */

export type SurfaceKind = 'monitor' | 'window' | 'browser' | 'unknown';

/** What the shared track says it shows. */
export function surfaceOf(track: Pick<MediaStreamTrack, 'getSettings'> | null | undefined): SurfaceKind {
  let s: string | undefined;
  try {
    s = (track?.getSettings() as MediaTrackSettings & { displaySurface?: string } | undefined)?.displaySurface;
  } catch {
    s = undefined;
  }
  return s === 'monitor' || s === 'window' || s === 'browser' ? s : 'unknown';
}

/** Whether a shared surface is acceptable: the entire screen, or unknown (the browser does not say). */
export function surfaceAccepted(surface: SurfaceKind): boolean {
  return surface === 'monitor' || surface === 'unknown';
}

/** Longest side and frame rate of the screen capture. */
export const SCREEN_MAX_SIDE = 1280;
export const SCREEN_FRAME_RATE = 5;

/**
 * Options for getDisplayMedia: the entire screen offered first, no audio, the exam tab itself excluded, no switching
 * the shared surface mid-way. Browsers ignore dictionary members they do not know (selfBrowserSurface,
 * surfaceSwitching, monitorTypeSurfaces are Chromium's); `requestScreen` retries with the bare minimum if a browser
 * rejects them anyway.
 */
export function displayMediaOptions(): DisplayMediaStreamOptions & Record<string, unknown> {
  return {
    video: {
      displaySurface: 'monitor',
      frameRate: { ideal: SCREEN_FRAME_RATE, max: SCREEN_FRAME_RATE },
      width: { max: SCREEN_MAX_SIDE },
      height: { max: SCREEN_MAX_SIDE },
    } as MediaTrackConstraints,
    audio: false,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'exclude',
    monitorTypeSurfaces: 'include',
  };
}

export type ShareFailure = 'not_entire_screen' | 'cancelled' | 'unsupported' | 'failed';

/** Candidate-facing explanation of why sharing did not work. */
export function describeShareFailure(reason: ShareFailure): string {
  switch (reason) {
    case 'not_entire_screen':
      return 'You shared a window or a browser tab. This exam records your entire screen: choose “Entire screen” (or your screen) in the sharing window, then select Share.';
    case 'cancelled':
      return 'Screen sharing was not started. Select “Share your screen” again and choose your entire screen. If no sharing window appears, your computer may block screen sharing for this browser: on a Mac, allow it in System Settings → Privacy & Security → Screen Recording, then reopen the browser.';
    case 'unsupported':
      return 'This browser cannot share your screen. Use a current version of Chrome, Edge or Firefox on a computer.';
    default:
      return 'Your screen could not be shared. Try again; if it keeps failing, restart your browser.';
  }
}

/** Map a getDisplayMedia error onto a failure reason. */
export function shareFailureOf(err: unknown): ShareFailure {
  const name = (err as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'AbortError' || name === 'PermissionDeniedError') return 'cancelled';
  if (name === 'NotSupportedError' || name === 'TypeError') return 'unsupported';
  return 'failed';
}

export interface ScreenSnapshot {
  /** A shared screen is being captured right now. */
  live: boolean;
  stream: MediaStream | null;
  surface: SurfaceKind;
  /** Increments with every new share. */
  generation: number;
  /** Candidate-facing explanation of the last failed attempt. */
  problem: string | null;
  /** When the last share ended while it was wanted (sharing stopped by the candidate or the system), else null. */
  endedAt: number | null;
  requesting: boolean;
}

type Listener = (s: ScreenSnapshot) => void;

export interface ScreenCaptureEnv {
  getDisplayMedia?: (opts: DisplayMediaStreamOptions) => Promise<MediaStream>;
  now?: () => number;
  /** How often the track's state is polled (an `ended` event is not fired when a track is stopped from script). */
  pollMs?: number;
}

/** Owns the shared-screen stream across screens (ready screen → exam → pause). */
export class ScreenCapture {
  private snap: ScreenSnapshot = { live: false, stream: null, surface: 'unknown', generation: 0, problem: null, endedAt: null, requesting: false };
  private readonly listeners = new Set<Listener>();
  private track: MediaStreamTrack | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly env: ScreenCaptureEnv = {}) {}

  get state(): ScreenSnapshot {
    return this.snap;
  }

  /** Whether this browser can share a screen at all. */
  static supported(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(p: Partial<ScreenSnapshot>): void {
    this.snap = { ...this.snap, ...p };
    for (const fn of this.listeners) {
      try {
        fn(this.snap);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  private now(): number {
    return this.env.now?.() ?? Date.now();
  }

  /**
   * Ask the candidate to share their entire screen (call from a click). Resolves with the outcome; on success the
   * snapshot is live. A window or tab is stopped again and refused (`not_entire_screen`).
   */
  async request(): Promise<{ ok: true; surface: SurfaceKind } | { ok: false; reason: ShareFailure }> {
    const gdm = this.env.getDisplayMedia ?? (ScreenCapture.supported() ? (o: DisplayMediaStreamOptions) => navigator.mediaDevices.getDisplayMedia(o) : undefined);
    if (!gdm) {
      this.set({ problem: describeShareFailure('unsupported') });
      return { ok: false, reason: 'unsupported' };
    }
    this.set({ requesting: true });
    let stream: MediaStream;
    try {
      try {
        stream = await gdm(displayMediaOptions());
      } catch (err) {
        // An older browser that rejects options it does not know: ask with the bare minimum.
        if ((err as { name?: string })?.name !== 'TypeError') throw err;
        stream = await gdm({ video: true, audio: false });
      }
    } catch (err) {
      const reason = shareFailureOf(err);
      this.set({ requesting: false, problem: describeShareFailure(reason) });
      return { ok: false, reason };
    }
    const track = stream.getVideoTracks()[0];
    const surface = surfaceOf(track);
    if (!track || !surfaceAccepted(surface)) {
      stream.getTracks().forEach((t) => t.stop());
      this.set({ requesting: false, problem: describeShareFailure(track ? 'not_entire_screen' : 'failed') });
      return { ok: false, reason: track ? 'not_entire_screen' : 'failed' };
    }
    // Some browsers ignore the size in getDisplayMedia: scale down afterwards (best effort).
    try {
      const st = track.getSettings();
      if ((st.width ?? 0) > SCREEN_MAX_SIDE || (st.height ?? 0) > SCREEN_MAX_SIDE || (st.frameRate ?? 0) > SCREEN_FRAME_RATE) {
        await track.applyConstraints({ width: { max: SCREEN_MAX_SIDE }, height: { max: SCREEN_MAX_SIDE }, frameRate: { max: SCREEN_FRAME_RATE } });
      }
    } catch {
      /* the recorder's bitrate still bounds the size */
    }
    this.release();
    this.track = track;
    track.addEventListener('ended', this.onEnded);
    this.poll = setInterval(() => {
      if (this.track && this.track.readyState === 'ended') this.onEnded();
    }, this.env.pollMs ?? 1000);
    this.set({ live: true, stream, surface, generation: this.snap.generation + 1, problem: null, endedAt: null, requesting: false });
    return { ok: true, surface };
  }

  /** Sharing ended outside our control (the browser's "Stop sharing", a sleeping computer, a display unplugged). */
  private readonly onEnded = () => {
    if (!this.snap.live) return;
    this.release();
    this.set({ live: false, stream: null, endedAt: this.now() });
  };

  private release(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    if (this.track) {
      this.track.removeEventListener('ended', this.onEnded);
      this.track.stop();
    }
    this.snap.stream?.getTracks().forEach((t) => t.stop());
    this.track = null;
  }

  /** Stop sharing (pause, hold, end of the exam): not an "ended" by the candidate. */
  stop(): void {
    const wasLive = this.snap.live || this.track != null;
    this.release();
    if (wasLive || this.snap.endedAt != null || this.snap.problem) this.set({ live: false, stream: null, endedAt: null, problem: null, requesting: false });
  }
}

import type { CameraState } from '@sp/shared';
import { sha256Hex } from '../api';

/**
 * Camera manager: owns the webcam MediaStream and a hidden, un-mirrored <video> element used for
 * analysis and snapshots. Previews attach the same stream to their own (CSS-mirrored) element.
 *
 * Tracks the camera state (live / muted / ended / no_permission / unavailable) from track events,
 * the Permissions API and devicechange, and re-acquires the camera automatically with backoff while
 * the camera is wanted.
 */

export interface CameraInfo {
  deviceId: string;
  label: string;
  /** SHA-256 of deviceId — the raw id never leaves the browser. */
  deviceIdHash: string;
  width: number;
  height: number;
}

export interface CameraSnapshot {
  state: CameraState;
  /** Whether a start was requested and not stopped. */
  wanted: boolean;
  starting: boolean;
  info: CameraInfo | null;
  stream: MediaStream | null;
  /** Candidate-facing explanation of the last problem, if any. */
  problem: string | null;
  /** Increments every time a new stream is acquired. */
  generation: number;
}

export type CameraListener = (s: CameraSnapshot) => void;

/**
 * HD for identity evidence (face crops are taken at the camera's native resolution); analysis runs on a
 * downscaled copy. `ideal` lets the browser pick the closest mode the camera supports (many laptop cameras
 * give 1280×720; others 640×480). If the camera refuses to start in HD, a standard-definition retry follows.
 */
export const HD_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 15, max: 30 },
};
export const SD_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 640 },
  height: { ideal: 480 },
  frameRate: { ideal: 15 },
};

const PREFERRED_KEY = 'sp:camera:preferred';

export function describeCameraError(err: unknown): { state: CameraState; message: string } {
  const name = (err as { name?: string })?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return {
        state: 'no_permission',
        message:
          'Camera access is blocked. Allow camera access for this page (use the camera icon in the address bar or your browser’s site settings), then try again.',
      };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return { state: 'unavailable', message: 'No camera was found. Connect a camera and try again.' };
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return {
        state: 'unavailable',
        message: 'The camera could not be started. It may be in use by another application (for example a video call). Close other apps using the camera and try again.',
      };
    default:
      return { state: 'unavailable', message: 'The camera could not be started. Check that it is connected and try again.' };
  }
}

export function loadPreferredCamera(): string | null {
  try {
    return localStorage.getItem(PREFERRED_KEY);
  } catch {
    return null;
  }
}

function savePreferredCamera(id: string): void {
  try {
    localStorage.setItem(PREFERRED_KEY, id);
  } catch {
    /* storage unavailable */
  }
}

export class CameraManager {
  readonly video: HTMLVideoElement;
  private snapshot: CameraSnapshot = { state: 'unavailable', wanted: false, starting: false, info: null, stream: null, problem: null, generation: 0 };
  private readonly listeners = new Set<CameraListener>();
  private track: MediaStreamTrack | null = null;
  private preferredId: string | null = loadPreferredCamera();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 1000;
  private permissionStatus: PermissionStatus | null = null;
  private startSeq = 0;
  private disposed = false;

  constructor() {
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
    this.video.setAttribute('aria-hidden', 'true');
    this.video.setAttribute('data-sp-analysis', '');
    Object.assign(this.video.style, { position: 'fixed', left: '-10000px', top: '0', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none' });
    document.body.appendChild(this.video);
    navigator.mediaDevices?.addEventListener?.('devicechange', this.onDeviceChange);
    void this.watchPermission();
  }

  get state(): CameraSnapshot {
    return this.snapshot;
  }

  get preferredDeviceId(): string | null {
    return this.preferredId;
  }

  subscribe(fn: CameraListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<CameraSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const fn of this.listeners) {
      try {
        fn(this.snapshot);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  async listCameras(): Promise<MediaDeviceInfo[]> {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter((d) => d.kind === 'videoinput');
    } catch {
      return [];
    }
  }

  /** Start (or switch) the camera. Resolves once frames are playing or the attempt failed. */
  async start(deviceId?: string | null): Promise<boolean> {
    if (this.disposed) return false;
    if (deviceId) this.preferredId = deviceId;
    this.set({ wanted: true });
    this.clearRetry();
    return this.acquire(deviceId ?? this.preferredId ?? null);
  }

  private async acquire(deviceId: string | null, hd = true): Promise<boolean> {
    const seq = ++this.startSeq;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.set({ state: 'unavailable', problem: 'This browser cannot access a camera on this page.', starting: false });
      return false;
    }
    this.set({ starting: true });
    let stream: MediaStream;
    const base = hd ? HD_CONSTRAINTS : SD_CONSTRAINTS;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { ...base, deviceId: { exact: deviceId } } : base,
        audio: false,
      });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (hd && (name === 'OverconstrainedError' || name === 'NotReadableError' || name === 'AbortError')) {
        // Some cameras / drivers refuse an HD mode: try standard definition before anything else.
        if (seq !== this.startSeq) return false;
        return this.acquire(deviceId, false);
      }
      if (deviceId && (name === 'OverconstrainedError' || name === 'NotFoundError' || name === 'NotReadableError')) {
        // The chosen camera is gone or busy: fall back to any camera.
        if (seq !== this.startSeq) return false;
        return this.acquire(null);
      }
      if (seq !== this.startSeq) return false;
      const d = describeCameraError(err);
      this.set({ state: d.state, problem: d.message, starting: false });
      this.scheduleRetry();
      return false;
    }
    if (seq !== this.startSeq || !this.snapshot.wanted || this.disposed) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    this.releaseTracks();
    const track = stream.getVideoTracks()[0];
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      this.set({ state: 'unavailable', problem: 'The camera did not provide video.', starting: false });
      this.scheduleRetry();
      return false;
    }
    this.track = track;
    track.addEventListener('ended', this.onEnded);
    track.addEventListener('mute', this.onMute);
    track.addEventListener('unmute', this.onUnmute);
    this.video.srcObject = stream;
    try {
      await this.video.play();
    } catch {
      /* autoplay of a muted inline video is allowed; play() may reject if interrupted by a new load */
    }
    await this.waitForFrames(3000);
    const settings = track.getSettings();
    const id = settings.deviceId ?? deviceId ?? '';
    if (id) {
      this.preferredId = id;
      savePreferredCamera(id);
    }
    const info: CameraInfo = {
      deviceId: id,
      label: track.label || '',
      deviceIdHash: await sha256Hex(id || track.label || ''),
      width: this.video.videoWidth || settings.width || 0,
      height: this.video.videoHeight || settings.height || 0,
    };
    if (seq !== this.startSeq) {
      // Stopped or superseded while waiting for frames: never leave this stream running.
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    this.retryDelay = 1000;
    this.set({
      state: track.muted ? 'muted' : 'live',
      info,
      stream,
      problem: null,
      starting: false,
      generation: this.snapshot.generation + 1,
    });
    return true;
  }

  private waitForFrames(timeoutMs: number): Promise<void> {
    if (this.video.readyState >= 2 && this.video.videoWidth > 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.video.removeEventListener('loadeddata', done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.video.addEventListener('loadeddata', done);
    });
  }

  /** Whether the analysis video currently has a decodable frame. */
  isVideoReady(): boolean {
    return this.snapshot.state === 'live' && this.video.readyState >= 2 && this.video.videoWidth > 0 && !this.video.paused;
  }

  stop(): void {
    this.startSeq++;
    this.clearRetry();
    this.releaseTracks();
    this.video.srcObject = null;
    this.set({ wanted: false, starting: false, stream: null, state: 'unavailable', problem: null });
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.onDeviceChange);
    if (this.permissionStatus) this.permissionStatus.onchange = null;
    this.video.remove();
    this.listeners.clear();
  }

  private releaseTracks(): void {
    if (this.track) {
      this.track.removeEventListener('ended', this.onEnded);
      this.track.removeEventListener('mute', this.onMute);
      this.track.removeEventListener('unmute', this.onUnmute);
    }
    const s = this.snapshot.stream;
    s?.getTracks().forEach((t) => t.stop());
    // The current track may belong to a stream that an in-flight start() has not published yet.
    this.track?.stop();
    this.track = null;
  }

  private readonly onEnded = () => {
    if (!this.snapshot.wanted) return;
    this.set({ state: 'ended', problem: 'The camera stopped. Check that it is still connected — we are trying to reconnect it.' });
    this.scheduleRetry(500);
  };

  private readonly onMute = () => {
    if (!this.snapshot.wanted) return;
    this.set({ state: 'muted', problem: 'The camera stopped sending video. Another application may be using it.' });
  };

  private readonly onUnmute = () => {
    if (!this.snapshot.wanted) return;
    this.set({ state: 'live', problem: null });
  };

  private readonly onDeviceChange = () => {
    if (!this.snapshot.wanted) return;
    const s = this.snapshot.state;
    if (s !== 'live' && s !== 'muted') {
      this.clearRetry();
      void this.acquire(this.preferredId);
      return;
    }
    // If our device disappeared, the track normally ends; double-check the list.
    void this.listCameras().then((cams) => {
      const id = this.snapshot.info?.deviceId;
      if (id && cams.length > 0 && cams.every((c) => c.deviceId && c.deviceId !== id)) {
        this.set({ state: 'ended', problem: 'The camera was disconnected. We are trying to reconnect it.' });
        this.scheduleRetry(300);
      }
    });
  };

  private async watchPermission(): Promise<void> {
    try {
      const status = await navigator.permissions?.query({ name: 'camera' as PermissionName });
      if (!status || this.disposed) return;
      this.permissionStatus = status;
      status.onchange = () => {
        if (!this.snapshot.wanted) return;
        if (status.state === 'denied') {
          this.releaseTracks();
          this.set({ state: 'no_permission', problem: describeCameraError({ name: 'NotAllowedError' }).message, stream: null });
          this.scheduleRetry(5000);
        } else if (status.state === 'granted' && this.snapshot.state !== 'live') {
          this.clearRetry();
          void this.acquire(this.preferredId);
        }
      };
    } catch {
      /* Permissions API for camera not supported (e.g. Firefox) */
    }
  }

  private scheduleRetry(delay?: number): void {
    if (!this.snapshot.wanted || this.disposed) return;
    this.clearRetry();
    const d = delay ?? this.retryDelay;
    this.retryDelay = Math.min(15_000, Math.max(1000, this.retryDelay * 2));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.snapshot.wanted && this.snapshot.state !== 'live') void this.acquire(this.preferredId);
    }, d);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}

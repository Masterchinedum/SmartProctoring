import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraManager, describeCameraError } from './camera';

class FakeTrack extends EventTarget {
  muted = false;
  readyState: 'live' | 'ended' = 'live';
  stop = vi.fn(() => {
    this.readyState = 'ended';
  });
  constructor(
    readonly label: string,
    private readonly deviceId: string,
  ) {
    super();
  }
  getSettings() {
    return { deviceId: this.deviceId, width: 640, height: 480 };
  }
}

function fakeStream(track: FakeTrack) {
  return { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
}

function domError(name: string) {
  const e = new Error(name);
  e.name = name;
  return e;
}

describe('CameraManager', () => {
  let tracks: FakeTrack[];
  let getUserMedia: ReturnType<typeof vi.fn>;
  let failNext: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    tracks = [];
    failNext = [];
    getUserMedia = vi.fn(async (c: MediaStreamConstraints) => {
      const f = failNext.shift();
      if (f) throw domError(f);
      const video = c.video as MediaTrackConstraints;
      const exact = (video.deviceId as { exact?: string } | undefined)?.exact;
      const t = new FakeTrack(exact === 'cam-2' ? 'USB Camera' : 'Integrated Camera', exact ?? 'cam-1');
      tracks.push(t);
      return fakeStream(t);
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: Object.assign(new EventTarget(), { getUserMedia, enumerateDevices: vi.fn(async () => [{ kind: 'videoinput', deviceId: 'cam-1', label: 'Integrated Camera' }]) }),
    });
    // jsdom has no media playback: pretend frames are decodable.
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, get: () => 4 });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 640 });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 480 });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { configurable: true, get: () => null, set: () => undefined });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('opens the camera un-mirrored at ~640×480 without audio and reports a hashed device id', async () => {
    const cam = new CameraManager();
    expect(await cam.start()).toBe(true);
    expect(getUserMedia).toHaveBeenCalledWith({ video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15 } }, audio: false });
    expect(cam.state.state).toBe('live');
    expect(cam.state.info?.label).toBe('Integrated Camera');
    expect(cam.state.info?.deviceIdHash).toMatch(/^[0-9a-f]{64}$/);
    expect(cam.state.info?.deviceIdHash).not.toContain('cam-1');
    expect(cam.state.generation).toBe(1);
    cam.dispose();
  });

  it('re-acquires the camera after the track ends', async () => {
    const cam = new CameraManager();
    await cam.start();
    tracks[0].dispatchEvent(new Event('ended'));
    expect(cam.state.state).toBe('ended');
    expect(cam.state.problem).toMatch(/camera stopped/i);
    await vi.advanceTimersByTimeAsync(600);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(cam.state.state).toBe('live'));
    expect(cam.state.generation).toBe(2);
    cam.dispose();
  });

  it('reports muted / unmuted tracks', async () => {
    const cam = new CameraManager();
    await cam.start();
    tracks[0].dispatchEvent(new Event('mute'));
    expect(cam.state.state).toBe('muted');
    tracks[0].dispatchEvent(new Event('unmute'));
    expect(cam.state.state).toBe('live');
    cam.dispose();
  });

  it('maps a denied permission and retries with backoff', async () => {
    failNext = ['NotAllowedError', 'NotAllowedError'];
    const cam = new CameraManager();
    expect(await cam.start()).toBe(false);
    expect(cam.state.state).toBe('no_permission');
    expect(cam.state.problem).toMatch(/Allow camera access/);
    await vi.advanceTimersByTimeAsync(1000);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(cam.state.state).toBe('no_permission');
    await vi.advanceTimersByTimeAsync(2000);
    expect(getUserMedia).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(cam.state.state).toBe('live'));
    cam.dispose();
  });

  it('falls back to any camera when the chosen one is gone', async () => {
    failNext = ['OverconstrainedError'];
    const cam = new CameraManager();
    expect(await cam.start('cam-9')).toBe(true);
    expect((getUserMedia.mock.calls[0][0].video as MediaTrackConstraints).deviceId).toEqual({ exact: 'cam-9' });
    expect((getUserMedia.mock.calls[1][0].video as MediaTrackConstraints).deviceId).toBeUndefined();
    expect(cam.state.state).toBe('live');
    cam.dispose();
  });

  it('switches cameras and stops the previous track', async () => {
    const cam = new CameraManager();
    await cam.start();
    await cam.start('cam-2');
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(cam.state.info?.label).toBe('USB Camera');
    expect(cam.preferredDeviceId).toBe('cam-2');
    cam.dispose();
  });

  it('stop() while a start is still waiting for the first frames releases the new track', async () => {
    // Regression (e2e scenario 4): the stream obtained by an in-flight start() was not yet published in
    // the snapshot, so stop() released only the previous stream — the new track stayed live (camera on
    // during a hold/pause, and the device kept running).
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, get: () => 0 });
    const cam = new CameraManager();
    const started = cam.start();
    await vi.waitFor(() => expect(tracks).toHaveLength(1));
    cam.stop();
    await vi.advanceTimersByTimeAsync(3_500);
    expect(await started).toBe(false);
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(cam.state.state).not.toBe('live');
    expect(cam.state.stream).toBeNull();
    cam.dispose();
  });

  it('a re-acquire (devicechange) while the first start waits for frames stops the first track', async () => {
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, get: () => 0 });
    const cam = new CameraManager();
    const first = cam.start();
    await vi.waitFor(() => expect(tracks).toHaveLength(1));
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
    await vi.waitFor(() => expect(tracks).toHaveLength(2));
    expect(tracks[0].stop).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(7_000);
    expect(await first).toBe(false);
    await vi.waitFor(() => expect(cam.state.state).toBe('live'));
    expect(tracks[1].readyState).toBe('live');
    cam.stop();
    expect(tracks.every((t) => t.readyState === 'ended')).toBe(true);
    cam.dispose();
  });

  it('stop() while getUserMedia is pending discards the stream it returns', async () => {
    let resolve!: (s: MediaStream) => void;
    getUserMedia.mockImplementationOnce(() => new Promise<MediaStream>((r) => (resolve = r)));
    const cam = new CameraManager();
    const started = cam.start();
    cam.stop();
    const t = new FakeTrack('Integrated Camera', 'cam-1');
    resolve(fakeStream(t));
    expect(await started).toBe(false);
    expect(t.stop).toHaveBeenCalled();
    expect(cam.state.state).not.toBe('live');
    cam.dispose();
  });

  it('stop() releases the camera and does not re-acquire', async () => {
    const cam = new CameraManager();
    await cam.start();
    cam.stop();
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(cam.state.wanted).toBe(false);
    tracks[0].dispatchEvent(new Event('ended'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    cam.dispose();
  });
});

describe('describeCameraError', () => {
  it('gives candidate-facing guidance', () => {
    expect(describeCameraError({ name: 'NotReadableError' })).toMatchObject({ state: 'unavailable', message: expect.stringMatching(/another application/) });
    expect(describeCameraError({ name: 'NotFoundError' }).message).toMatch(/No camera was found/);
    expect(describeCameraError({ name: 'SecurityError' }).state).toBe('no_permission');
  });
});

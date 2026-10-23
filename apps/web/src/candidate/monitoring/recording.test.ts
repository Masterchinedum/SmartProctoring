import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventUpsert, RecordingPlan, RecordingStream } from '@sp/shared';
import { FakeMediaStream, FakeRecorder, FakeTrack, flush, installFakeMediaStream } from '../test/mediaFakes';
import type { CameraSnapshot } from './camera';
import type { MediaRecorderCtor } from './recorder';
import { ExamRecording } from './recording';
import type { ScreenSnapshot } from './screen';

installFakeMediaStream();

/** A tiny observable value (stands in for the camera manager / screen capture). */
class Subject<T> {
  private fns = new Set<(v: T) => void>();
  constructor(public state: T) {}
  subscribe(fn: (v: T) => void) {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  set(patch: Partial<T>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.fns) fn(this.state);
  }
}

const camSnap = (stream: MediaStream | null, generation: number): CameraSnapshot => ({ state: stream ? 'live' : 'unavailable', wanted: true, starting: false, info: null, stream, problem: null, generation });
const screenSnap = (p: Partial<ScreenSnapshot> = {}): ScreenSnapshot => ({ live: false, stream: null, surface: 'unknown', generation: 0, problem: null, endedAt: null, requesting: false, ...p });
const PLAN: RecordingPlan = { any: true, camera: true, audio: true, screen: true };

describe('exam recording run', () => {
  let now = 1_790_000_000_000;
  let events: EventUpsert[];
  let queued: { stream: RecordingStream; seq: number; startedAt: number; durationMs: number; instanceId: string; mimeType: string; size: number }[];
  let camera: Subject<CameraSnapshot>;
  let screen: Subject<ScreenSnapshot>;
  let mic: FakeTrack;
  let sequence: Record<RecordingStream, number>;
  let problems: (string | null)[];

  beforeEach(() => {
    vi.useFakeTimers();
    FakeRecorder.reset();
    now = 1_790_000_000_000;
    events = [];
    queued = [];
    problems = [];
    sequence = { camera: 0, screen: 0 };
    camera = new Subject(camSnap(new FakeMediaStream([new FakeTrack('video', { width: 1280, height: 720 })]) as unknown as MediaStream, 1));
    screen = new Subject(screenSnap());
    mic = new FakeTrack('audio');
  });
  afterEach(() => vi.useRealTimers());

  function run(over: Partial<ConstructorParameters<typeof ExamRecording>[0]> = {}) {
    return new ExamRecording({
      plan: PLAN,
      camera,
      screen,
      queue: { put: async (blob, m) => void queued.push({ ...m, size: blob.size }) },
      instanceId: 'inst-page-1',
      now: () => now,
      putEvent: async (e) => void events.push(e),
      sequence,
      getUserMedia: async () => new FakeMediaStream([mic]) as unknown as MediaStream,
      MediaRecorder: FakeRecorder as unknown as MediaRecorderCtor,
      onProblem: (m) => problems.push(m),
      retryMs: 1000,
      ...over,
    });
  }

  async function advance(ms: number) {
    now += ms;
    await vi.advanceTimersByTimeAsync(ms);
    await flush(10);
  }

  const recordersFor = (kind: 'video+audio' | 'screen') =>
    FakeRecorder.instances.filter((r) => (kind === 'screen' ? r.options.videoBitsPerSecond === 300_000 : r.options.videoBitsPerSecond === 350_000));

  it('records the webcam with the microphone (never asking the camera for sound), in parts queued with this page and its numbering', async () => {
    const r = run();
    await r.start();
    await flush(10);
    const [cam] = recordersFor('video+audio');
    expect(cam.stream.getAudioTracks()).toEqual([mic]);
    const video = cam.stream.getVideoTracks()[0];
    expect(video).not.toBe(camera.state.stream!.getVideoTracks()[0]); // a scaled-down clone
    expect(video.getSettings()).toMatchObject({ width: 640, height: 480 });
    expect(cam.options).toMatchObject({ mimeType: 'video/webm;codecs=vp8,opus', audioBitsPerSecond: 32_000 });
    await advance(30_000);
    await advance(10_000);
    await r.stop();
    expect(queued.map((q) => [q.stream, q.seq, q.startedAt - 1_790_000_000_000, q.durationMs, q.instanceId])).toEqual([
      ['camera', 0, 0, 30_000, 'inst-page-1'],
      ['camera', 1, 30_000, 10_000, 'inst-page-1'],
    ]);
    // The clone and the microphone are released; the camera itself is not.
    expect((video as unknown as FakeTrack).stopped).toBe(true);
    expect(mic.stopped).toBe(true);
    expect(camera.state.stream!.getVideoTracks()[0]).toMatchObject({ stopped: false });
    // The next run of the same page (after a resume) continues the numbering: the server keys parts by it.
    expect(sequence.camera).toBe(2);
    const again = run();
    await again.start();
    await flush(10);
    await advance(5000);
    await again.stop();
    expect(queued.at(-1)).toMatchObject({ stream: 'camera', seq: 2 });
  });

  it('starts a new recording on the new tracks when the camera restarts', async () => {
    const r = run({ plan: { any: true, camera: true, audio: false, screen: false } });
    await r.start();
    await flush(10);
    await advance(8000);
    camera.set(camSnap(new FakeMediaStream([new FakeTrack('video', { width: 640, height: 480 })]) as unknown as MediaStream, 2));
    await flush(20);
    expect(queued.map((q) => [q.seq, q.durationMs])).toEqual([[0, 8000]]);
    expect(recordersFor('video+audio')).toHaveLength(2);
    expect(recordersFor('video+audio')[1].stream.getVideoTracks()[0].source).toBe(camera.state.stream!.getVideoTracks()[0]);
    // The camera goes away: the part ends; nothing records until a camera is back.
    await advance(3000);
    camera.set(camSnap(null, 2));
    await flush(20);
    expect(queued.map((q) => q.seq)).toEqual([0, 1]);
    await r.stop();
    expect(events).toEqual([]);
  });

  it('records the shared screen; a stopped share opens screen_share_stopped until the screen is shared again', async () => {
    const shareTrack = new FakeTrack('video', { displaySurface: 'monitor' });
    const r = run({ plan: { any: true, camera: false, audio: false, screen: true } });
    await r.start();
    await flush(10);
    expect(recordersFor('screen')).toHaveLength(0); // not shared yet: the exam is covered, nothing to record
    screen.set(screenSnap({ live: true, stream: new FakeMediaStream([shareTrack]) as unknown as MediaStream, generation: 1, surface: 'monitor' }));
    await flush(10);
    expect(recordersFor('screen')).toHaveLength(1);
    expect(recordersFor('screen')[0].options).toMatchObject({ mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 300_000 });
    expect(recordersFor('screen')[0].options.audioBitsPerSecond).toBeUndefined();
    await advance(12_000);
    const stoppedAt = now;
    screen.set(screenSnap({ live: false, stream: null, generation: 1, endedAt: stoppedAt }));
    await flush(10);
    expect(queued.map((q) => [q.stream, q.durationMs])).toEqual([['screen', 12_000]]);
    expect(events).toEqual([expect.objectContaining({ type: 'screen_share_stopped', phase: 'open', startedAt: stoppedAt, endedAt: null, version: 1, clientInstanceId: 'inst-page-1' })]);
    expect(r.screenShareStopped).toBe(true);
    await advance(20_000);
    screen.set(screenSnap({ live: true, stream: new FakeMediaStream([new FakeTrack('video')]) as unknown as MediaStream, generation: 2 }));
    await flush(10);
    expect(events[1]).toMatchObject({ id: events[0].id, type: 'screen_share_stopped', phase: 'close', startedAt: stoppedAt, endedAt: stoppedAt + 20_000, version: 2 });
    expect(recordersFor('screen')).toHaveLength(2);
    expect(r.screenShareStopped).toBe(false);
    await advance(5000);
    await r.stop();
    expect(queued.map((q) => [q.stream, q.seq])).toEqual([
      ['screen', 0],
      ['screen', 1],
    ]);
  });

  it('a recorder that stops because sharing ended is not a recording failure (no interruption, no retry)', async () => {
    const shareTrack = new FakeTrack('video', { displaySurface: 'monitor' });
    const r = run({ plan: { any: true, camera: false, audio: false, screen: true } });
    await r.start();
    screen.set(screenSnap({ live: true, stream: new FakeMediaStream([shareTrack]) as unknown as MediaStream, generation: 1 }));
    await flush(10);
    // The browser ends the track: the recorder stops by itself before the share is reported as ended.
    shareTrack.end();
    recordersFor('screen')[0].stopBySelf();
    await flush(10);
    screen.set(screenSnap({ live: false, generation: 1, endedAt: now }));
    await flush(10);
    await advance(10_000);
    expect(events.map((e) => e.type)).toEqual(['screen_share_stopped']);
    expect(recordersFor('screen')).toHaveLength(1);
    expect(queued.map((q) => q.stream)).toEqual(['screen']);
    await r.stop();
  });

  it('closes an open screen_share_stopped span when the run stops (pause, end)', async () => {
    const r = run({ plan: { any: true, camera: false, audio: false, screen: true } });
    await r.start();
    screen.set(screenSnap({ live: true, stream: new FakeMediaStream([new FakeTrack('video')]) as unknown as MediaStream, generation: 1 }));
    await flush(10);
    screen.set(screenSnap({ live: false, generation: 1, endedAt: now }));
    await flush(10);
    await advance(4000);
    await r.stop();
    expect(events.map((e) => [e.type, e.phase])).toEqual([
      ['screen_share_stopped', 'open'],
      ['screen_share_stopped', 'close'],
    ]);
    expect(events[1].endedAt! - events[1].startedAt).toBe(4000);
  });

  it('records the webcam without sound when the microphone is unavailable (a technical event, never a block)', async () => {
    const r = run({ plan: { any: true, camera: true, audio: true, screen: false }, getUserMedia: async () => Promise.reject(new DOMException('busy', 'NotReadableError')) });
    await r.start();
    await flush(10);
    expect(events).toEqual([expect.objectContaining({ type: 'recording_interrupted', details: { stream: 'microphone', reason: 'microphone_unavailable' } })]);
    const [cam] = recordersFor('video+audio');
    expect(cam.stream.getAudioTracks()).toEqual([]);
    expect(cam.options.mimeType).toBe('video/webm;codecs=vp8');
    expect(problems).toEqual([]);
    await r.stop();
  });

  it('tries again after a recorder failure, and tells the candidate only when nothing at all can be recorded', async () => {
    const r = run({ plan: { any: true, camera: true, audio: false, screen: false } });
    await r.start();
    await flush(10);
    for (let i = 0; i < 4; i++) {
      FakeRecorder.instances.at(-1)!.stopBySelf();
      await flush(10);
      await advance(1000);
    }
    const interruptions = events.filter((e) => e.type === 'recording_interrupted');
    expect(interruptions).toHaveLength(4);
    expect(interruptions[0].details).toEqual({ stream: 'camera', reason: 'stopped_unexpectedly' });
    expect(problems.filter(Boolean)).toHaveLength(1);
    expect(problems[0]).toMatch(/not working in this browser/);
    await r.stop();

    events = [];
    problems = [];
    const none = run({ MediaRecorder: undefined });
    vi.stubGlobal('MediaRecorder', undefined);
    await none.start();
    expect(events.map((e) => e.details)).toEqual([
      { stream: 'camera', reason: 'recorder_unavailable' },
      { stream: 'screen', reason: 'recorder_unavailable' },
    ]);
    expect(problems[0]).toMatch(/not working/);
    vi.unstubAllGlobals();
  });
});

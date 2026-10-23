import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeMediaStream, FakeRecorder, FakeTrack, flush, installFakeMediaStream } from '../test/mediaFakes';
import { pickMimeType, recordingVideoTrack, SegmentedRecorder, type MediaRecorderCtor, type SegmentInfo } from './recorder';

installFakeMediaStream();

describe('choosing what to record', () => {
  it('prefers WebM VP8 (+ Opus with sound), then VP9, then MP4; the browser default when it cannot say', () => {
    const all = (t: string) => t.startsWith('video/');
    expect(pickMimeType(true, all)).toBe('video/webm;codecs=vp8,opus');
    expect(pickMimeType(false, all)).toBe('video/webm;codecs=vp8');
    expect(pickMimeType(true, (t) => t === 'video/webm;codecs=vp9,opus')).toBe('video/webm;codecs=vp9,opus');
    // Safari: MP4 only.
    expect(pickMimeType(true, (t) => t.startsWith('video/mp4'))).toBe('video/mp4;codecs=avc1.42E01E,mp4a.40.2');
    expect(pickMimeType(false, (t) => t === 'video/mp4')).toBe('video/mp4');
    expect(pickMimeType(true, () => false)).toBeNull();
    expect(pickMimeType(true, undefined)).toBeNull();
    expect(
      pickMimeType(false, () => {
        throw new Error('unknown');
      }),
    ).toBeNull();
  });
});

describe('segmented recording', () => {
  let now = 1_790_000_000_000;
  beforeEach(() => {
    vi.useFakeTimers();
    FakeRecorder.reset();
    now = 1_790_000_000_000;
  });
  afterEach(() => vi.useRealTimers());

  function recorder(extra: Partial<ConstructorParameters<typeof SegmentedRecorder>[0]> = {}) {
    const segments: { blob: Blob; info: SegmentInfo }[] = [];
    const errors: string[] = [];
    const rec = new SegmentedRecorder({
      stream: new FakeMediaStream([new FakeTrack('video')]) as unknown as MediaStream,
      kind: 'camera',
      mimeType: 'video/webm;codecs=vp8,opus',
      videoBitsPerSecond: 350_000,
      audioBitsPerSecond: 32_000,
      segmentMs: 30_000,
      env: { MediaRecorder: FakeRecorder as unknown as MediaRecorderCtor, now: () => now },
      onSegment: (blob, info) => segments.push({ blob, info }),
      onError: (reason) => errors.push(reason),
      ...extra,
    });
    return { rec, segments, errors };
  }

  async function advance(ms: number) {
    now += ms;
    await vi.advanceTimersByTimeAsync(ms);
    await flush();
  }

  it('restarts the recorder every segment so every part is a complete file, numbered, timed, with the bitrates asked for', async () => {
    const { rec, segments, errors } = recorder();
    expect(rec.start()).toBe(true);
    expect(FakeRecorder.instances).toHaveLength(1);
    expect(FakeRecorder.instances[0].options).toEqual({ mimeType: 'video/webm;codecs=vp8,opus', videoBitsPerSecond: 350_000, audioBitsPerSecond: 32_000 });
    await advance(30_000);
    // The next recorder starts at once: no gap between the parts.
    expect(FakeRecorder.instances).toHaveLength(2);
    expect(FakeRecorder.instances[0].state).toBe('inactive');
    expect(FakeRecorder.instances[1].state).toBe('recording');
    expect(segments.map((s) => s.info)).toEqual([{ stream: 'camera', seq: 0, startedAt: 1_790_000_000_000, durationMs: 30_000, mimeType: 'video/webm;codecs=vp8,opus' }]);
    expect(segments[0].blob.size).toBe(1000);
    expect(segments[0].blob.type).toBe('video/webm;codecs=vp8,opus');
    await advance(30_000);
    await advance(12_000);
    await rec.stop();
    expect(segments.map((s) => [s.info.seq, s.info.startedAt - 1_790_000_000_000, s.info.durationMs])).toEqual([
      [0, 0, 30_000],
      [1, 30_000, 30_000],
      [2, 60_000, 12_000],
    ]);
    expect(rec.nextSequence).toBe(3);
    expect(rec.isRunning).toBe(false);
    await advance(60_000);
    expect(FakeRecorder.instances).toHaveLength(3);
    expect(errors).toEqual([]);
  });

  it('continues the numbering of the page after a restart', async () => {
    const { rec, segments } = recorder({ firstSeq: 7 });
    rec.start();
    await advance(5000);
    await rec.stop();
    expect(segments.map((s) => s.info.seq)).toEqual([7]);
  });

  it('reports a browser that cannot record, and a recorder that stops by itself (its part is still kept)', async () => {
    FakeRecorder.failConstruct = true;
    const a = recorder();
    expect(a.rec.start()).toBe(false);
    expect(a.errors).toEqual(['recorder_unavailable']);
    FakeRecorder.failConstruct = false;
    const none = recorder({ env: { now: () => now } });
    expect(none.rec.start()).toBe(false);
    expect(none.errors).toEqual(['recorder_unavailable']);

    const b = recorder();
    b.rec.start();
    await advance(4000);
    FakeRecorder.instances[FakeRecorder.instances.length - 1].stopBySelf();
    await flush();
    expect(b.errors).toEqual(['stopped_unexpectedly']);
    expect(b.segments.map((s) => s.info.durationMs)).toEqual([4000]);
    expect(b.rec.isRunning).toBe(false);
    // No more rotations after a failure.
    const count = FakeRecorder.instances.length;
    await advance(60_000);
    expect(FakeRecorder.instances).toHaveLength(count);
  });

  it('keeps no empty parts', async () => {
    FakeRecorder.bytes = 0;
    const { rec, segments } = recorder();
    rec.start();
    await advance(30_000);
    await rec.stop();
    expect(segments).toEqual([]);
  });
});

describe('the webcam track recorded', () => {
  it('is a scaled-down clone, leaving the camera as it is', async () => {
    const cam = new FakeTrack('video', { width: 1280, height: 720 });
    const { track, owned } = await recordingVideoTrack(cam as unknown as MediaStreamTrack);
    expect(owned).toBe(true);
    expect(track).not.toBe(cam);
    expect(track.getSettings()).toMatchObject({ width: 640, height: 480 });
    expect(cam.getSettings()).toMatchObject({ width: 1280, height: 720 });
  });

  it('is the camera track itself where scaling a clone would change the camera', async () => {
    const cam = new FakeTrack('video', { width: 1280, height: 720 });
    cam.cloneChangesSource = { width: 640, height: 480 };
    const { track, owned } = await recordingVideoTrack(cam as unknown as MediaStreamTrack);
    expect(owned).toBe(false);
    expect(track).toBe(cam);
    expect(cam.clones[0].stopped).toBe(true);
  });
});

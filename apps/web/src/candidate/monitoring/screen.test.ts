import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeMediaStream, FakeTrack } from '../test/mediaFakes';
import { describeShareFailure, displayMediaOptions, ScreenCapture, shareFailureOf, surfaceAccepted, surfaceOf } from './screen';

const shared = (surface?: string, settings: Record<string, unknown> = { width: 1280, height: 800, frameRate: 5 }) => {
  const track = new FakeTrack('video', surface ? { ...settings, displaySurface: surface } : settings);
  return { track, stream: new FakeMediaStream([track]) as unknown as MediaStream };
};

describe('which surface was shared', () => {
  it('accepts the entire screen, or a browser that does not say; refuses a window or a tab', () => {
    expect(surfaceOf(shared('monitor').track as unknown as MediaStreamTrack)).toBe('monitor');
    expect(surfaceOf(shared('window').track as unknown as MediaStreamTrack)).toBe('window');
    expect(surfaceOf(shared('browser').track as unknown as MediaStreamTrack)).toBe('browser');
    expect(surfaceOf(shared().track as unknown as MediaStreamTrack)).toBe('unknown');
    expect(surfaceOf(shared('application').track as unknown as MediaStreamTrack)).toBe('unknown');
    expect(surfaceOf(null)).toBe('unknown');
    expect(
      surfaceOf({
        getSettings: () => {
          throw new Error('x');
        },
      }),
    ).toBe('unknown');
    expect([surfaceAccepted('monitor'), surfaceAccepted('unknown'), surfaceAccepted('window'), surfaceAccepted('browser')]).toEqual([true, true, false, false]);
  });

  it('asks for the entire screen, small and slow, without audio or the exam tab', () => {
    const o = displayMediaOptions();
    expect(o).toMatchObject({ audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'include' });
    expect(o.video).toMatchObject({ displaySurface: 'monitor', frameRate: { max: 5 }, width: { max: 1280 }, height: { max: 1280 } });
  });

  it('explains each failure plainly', () => {
    expect(shareFailureOf({ name: 'NotAllowedError' })).toBe('cancelled');
    expect(shareFailureOf({ name: 'NotSupportedError' })).toBe('unsupported');
    expect(shareFailureOf({ name: 'InvalidStateError' })).toBe('failed');
    expect(describeShareFailure('not_entire_screen')).toMatch(/Entire screen/);
    expect(describeShareFailure('cancelled')).toMatch(/Screen Recording/);
  });
});

describe('screen capture', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps an entire-screen share live until it ends; reports when the candidate (or the system) stopped it', async () => {
    const s = shared('monitor');
    const gdm = vi.fn(async () => s.stream);
    const cap = new ScreenCapture({ getDisplayMedia: gdm, now: () => 42 });
    const seen: boolean[] = [];
    cap.subscribe((x) => seen.push(x.live));
    expect(await cap.request()).toEqual({ ok: true, surface: 'monitor' });
    expect(gdm).toHaveBeenCalledWith(displayMediaOptions());
    expect(cap.state).toMatchObject({ live: true, surface: 'monitor', generation: 1, problem: null, endedAt: null });
    s.track.end();
    expect(cap.state).toMatchObject({ live: false, stream: null, endedAt: 42 });
    expect(seen.at(-1)).toBe(false);
  });

  it('notices a share stopped without an "ended" event (a track stopped from script)', async () => {
    const s = shared('monitor');
    const cap = new ScreenCapture({ getDisplayMedia: async () => s.stream, now: () => 7, pollMs: 500 });
    await cap.request();
    s.track.readyState = 'ended';
    await vi.advanceTimersByTimeAsync(500);
    expect(cap.state).toMatchObject({ live: false, endedAt: 7 });
  });

  it('refuses a window or a tab (and stops it); asks again with the bare minimum when the browser rejects the options', async () => {
    const w = shared('window');
    const cap = new ScreenCapture({ getDisplayMedia: async () => w.stream });
    expect(await cap.request()).toEqual({ ok: false, reason: 'not_entire_screen' });
    expect(w.track.stopped).toBe(true);
    expect(cap.state).toMatchObject({ live: false, problem: describeShareFailure('not_entire_screen') });

    const ok = shared();
    const calls: unknown[] = [];
    const picky = new ScreenCapture({
      getDisplayMedia: async (o) => {
        calls.push(o);
        if (calls.length === 1) throw new TypeError('unknown member');
        return ok.stream;
      },
    });
    expect(await picky.request()).toEqual({ ok: true, surface: 'unknown' });
    expect(calls[1]).toEqual({ video: true, audio: false });
  });

  it('reports a cancelled picker; stopping it (pause, end) is not a stop by the candidate', async () => {
    const cancelled = new ScreenCapture({ getDisplayMedia: async () => Promise.reject(new DOMException('denied', 'NotAllowedError')) });
    expect(await cancelled.request()).toEqual({ ok: false, reason: 'cancelled' });
    expect(cancelled.state.problem).toBe(describeShareFailure('cancelled'));
    const s = shared('monitor');
    const cap = new ScreenCapture({ getDisplayMedia: async () => s.stream });
    await cap.request();
    cap.stop();
    expect(s.track.stopped).toBe(true);
    expect(cap.state).toMatchObject({ live: false, endedAt: null, problem: null });
    expect(await new ScreenCapture({}).request()).toMatchObject({ ok: false });
  });

  it('scales a large share down after the fact (some browsers ignore the size asked for)', async () => {
    const s = shared('monitor', { width: 2560, height: 1440, frameRate: 30 });
    const cap = new ScreenCapture({ getDisplayMedia: async () => s.stream });
    await cap.request();
    expect(s.track.getSettings()).toMatchObject({ width: 1280, height: 1280 });
  });
});

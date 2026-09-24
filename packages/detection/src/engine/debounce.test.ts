import { describe, expect, it } from 'vitest';
import { Debouncer, Hysteresis } from './debounce';
import { EpisodeBook } from './episodes';
import { sequentialIdFactory } from '../util/id';
import { directionOf, awayThresholds, attentionAngle, angleDiff } from './context';
import { DEFAULT_POLICY } from '@sp/shared';
import { classifyCameraLabel, isVirtualCameraLabel } from '../camera/label';

const P = { onsetMs: 1000, clearMs: 500, minFraction: 0.7, gapTolMs: 300, minTicks: 3 };

function feed(d: Debouncer, seq: (boolean | null)[], dt = 100, t0 = 0) {
  const ev: { t: number; e: NonNullable<ReturnType<Debouncer['step']>> }[] = [];
  seq.forEach((v, i) => {
    const e = d.step(t0 + i * dt, v);
    if (e) ev.push({ t: t0 + i * dt, e });
  });
  return ev;
}

describe('Debouncer', () => {
  it('onset after the duration with the real start; clear after the hysteresis with the real end', () => {
    const d = new Debouncer(P);
    const seq = [false, false, ...Array(15).fill(true), ...Array(10).fill(false)];
    const ev = feed(d, seq);
    expect(ev[0]).toEqual({ t: 1200, e: { kind: 'onset', startedAt: 200 } });
    expect(ev[1]).toEqual({ t: 2200, e: { kind: 'clear', endedAt: 1700 } });
  });

  it('tolerates short dropouts but not long gaps', () => {
    const d = new Debouncer(P);
    const seq = [true, true, true, false, true, true, true, false, true, true, true, true];
    expect(feed(d, seq)[0].e).toEqual({ kind: 'onset', startedAt: 0 });
    const g = new Debouncer(P);
    const gap = [true, true, true, false, false, false, false, ...Array(12).fill(true)];
    const ev = feed(g, gap);
    expect(ev[0].e).toEqual({ kind: 'onset', startedAt: 700 });
  });

  it('needs the minimum fraction of ticks', () => {
    const d = new Debouncer({ ...P, gapTolMs: 1000 });
    const seq = Array.from({ length: 40 }, (_, i) => i % 2 === 0);
    expect(feed(d, seq)).toHaveLength(0);
  });

  it('unknown ticks neither support nor break a short run, but end an active one after clearMs', () => {
    const d = new Debouncer(P);
    const ev = feed(d, [true, true, null, true, true, true, true, true, true, true, true, true, null, null, null, null, null, null]);
    expect(ev.map((x) => x.e.kind)).toEqual(['onset', 'clear']);
    expect(ev[1].e).toEqual({ kind: 'clear', endedAt: 1200 });
  });

  it('a single true tick never triggers', () => {
    const d = new Debouncer({ ...P, onsetMs: 0, minTicks: 3 });
    expect(feed(d, [true, false, false, false, false])).toHaveLength(0);
  });

  it('confidence is in [0,1] and stays readable when the close is described', () => {
    const d = new Debouncer(P);
    feed(d, [...Array(15).fill(true), ...Array(6).fill(false)]);
    expect(d.active).toBe(false);
    expect(d.confidence(2000)).toBeGreaterThan(0.5);
    expect(d.idle).toBe(true);
    d.step(3000, false);
    expect(d.confidence(3000)).toBe(0);
  });
});

describe('Hysteresis', () => {
  it('turns on after onMs and off after offMs', () => {
    const h = new Hysteresis(300, 200);
    const out: (string | null)[] = [];
    [true, true, true, true, false, false, false, true].forEach((v, i) => out.push(h.step(i * 100, v)));
    expect(out).toEqual([null, null, null, 'on', null, null, 'off', null]);
  });
});

describe('EpisodeBook', () => {
  const book = () =>
    new EpisodeBook({ idFactory: sequentialIdFactory(), mergeGapMs: 10_000, maxShots: 2, periodicShotMs: 30_000, minUpdateMs: 10_000, peakSpacingMs: 3000 });
  const data = { confidence: 0.8, details: {}, observation: 'x' };

  it('open / throttled updates / close / merge / markers', () => {
    const b = book();
    const o = b.begin('k', 'looking_away', 0, 5000, data, 'a').update;
    expect(o).toMatchObject({ phase: 'open', version: 1, captureSnapshot: 'onset', startedAt: 0, endedAt: null });
    expect(b.touch('k', 6000, 'a', () => data)).toBeNull();
    expect(b.touch('k', 7000, 'b', () => data)).toBeNull(); // material change but throttled
    const u = b.touch('k', 15_001, 'b', () => data)!;
    expect(u).toMatchObject({ phase: 'update', version: 2 });
    expect(u.captureSnapshot).toBeUndefined();
    const p = b.touch('k', 36_000, 'b', () => data)!;
    expect(p.captureSnapshot).toBe('periodic');
    expect(b.touch('k', 70_000, 'b', () => data)).toBeNull(); // shots capped at 2
    const c = b.end('k', 71_000, 72_000, data)!;
    expect(c).toMatchObject({ phase: 'close', version: 4, endedAt: 71_000 });
    const m = b.begin('k', 'looking_away', 80_000, 85_000, data).update;
    expect(m).toMatchObject({ episodeId: o.episodeId, phase: 'update', version: 5, startedAt: 0, endedAt: null });
    expect(m.details.occurrences).toBe(2);
    const n = b.begin('k2', 'camera_changed', 0, 0, data).update;
    expect(n.episodeId).not.toBe(o.episodeId);
    const mk = b.marker('camera_changed', 1234, data);
    expect(mk).toMatchObject({ phase: 'close', startedAt: 1234, endedAt: 1234, version: 1 });
  });
});

describe('direction helpers', () => {
  const th = awayThresholds(DEFAULT_POLICY.detection);
  it('8-way buckets from the candidate’s perspective', () => {
    expect(directionOf(40, 0, th)).toBe('left');
    expect(directionOf(-40, 0, th)).toBe('right');
    expect(directionOf(0, -30, th)).toBe('down');
    expect(directionOf(0, 30, th)).toBe('up');
    expect(directionOf(30, -25, th)).toBe('down_left');
    expect(directionOf(-30, -25, th)).toBe('down_right');
    expect(directionOf(30, 28, th)).toBe('up_left');
    expect(directionOf(-30, 28, th)).toBe('up_right');
    expect(angleDiff(attentionAngle(22, -30, th), attentionAngle(20, -36, th))).toBeLessThan(15);
    expect(angleDiff(170, -170)).toBe(20);
  });
});

describe('camera labels', () => {
  it('flags virtual cameras, treats phone apps as lower-confidence, ignores real webcams', () => {
    for (const l of ['OBS Virtual Camera', 'ManyCam Virtual Webcam', 'Snap Camera', 'XSplit VCam', 'e2eSoft VCam', 'SplitCam Video Driver', 'CamTwist', 'Logi Capture', 'NVIDIA Broadcast', 'Virtual Camera', 'fake_device_0'])
      expect(isVirtualCameraLabel(l)).toBe(true);
    for (const l of ['FaceTime HD Camera', 'Integrated Webcam (0bda:5634)', 'HD Pro Webcam C920 (046d:082d)', 'USB2.0 HD UVC WebCam', '', 'Microsoft® LifeCam HD-3000'])
      expect(isVirtualCameraLabel(l)).toBe(false);
    for (const l of ['DroidCam Source 3', 'Iriun Webcam', 'Camo', 'EpocCam Camera']) {
      const c = classifyCameraLabel(l);
      expect(c.kind).toBe('phone_as_webcam');
      expect(c.confidence).toBeLessThan(classifyCameraLabel('OBS Virtual Camera').confidence);
    }
  });
});

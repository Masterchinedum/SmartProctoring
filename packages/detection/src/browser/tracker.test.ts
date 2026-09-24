import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type BrowserPolicy, type EpisodeUpdate } from '@sp/shared';
import { createBrowserSignalTracker } from './tracker';
import { sequentialIdFactory } from '../util/id';

const T = (s: number) => 1_700_000_000_000 + s * 1000;
const rel = (t: number | null) => (t === null ? null : (t - T(0)) / 1000);

function tracker(over: Partial<BrowserPolicy> = {}) {
  return createBrowserSignalTracker({ ...DEFAULT_POLICY.browser, ...over }, { idFactory: sequentialIdFactory() });
}

describe('BrowserSignalTracker', () => {
  it('tab hidden opens immediately (with an onset snapshot) and closes when visible', () => {
    const b = tracker();
    const o = b.visibility(true, T(10));
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ type: 'tab_hidden', phase: 'open', captureSnapshot: 'onset', confidence: 1, version: 1 });
    expect(rel(o[0].startedAt)).toBe(10);
    const c = b.visibility(false, T(25));
    expect(c[0]).toMatchObject({ type: 'tab_hidden', phase: 'close', version: 2 });
    expect(rel(c[0].endedAt)).toBe(25);
    expect(c[0].details.totalSec).toBe(15);
    expect(c[0].observation).toBe('The exam tab was hidden for 15 s.');
  });

  it('respects flagTabHidden = false', () => {
    const b = tracker({ flagTabHidden: false });
    expect(b.visibility(true, T(1))).toHaveLength(0);
  });

  it('window blur is reported only after windowBlurMinSec, starting at the blur time', () => {
    const b = tracker({ windowBlurMinSec: 2 });
    expect(b.focus(false, T(10))).toHaveLength(0);
    expect(b.tick(T(11))).toHaveLength(0);
    const o = b.tick(T(12.1));
    expect(o[0]).toMatchObject({ type: 'window_unfocused', phase: 'open' });
    expect(rel(o[0].startedAt)).toBe(10);
    const c = b.focus(true, T(15));
    expect(c[0]).toMatchObject({ type: 'window_unfocused', phase: 'close' });
    expect(rel(c[0].endedAt)).toBe(15);
    // Short blur ignored.
    const s = tracker();
    s.focus(false, T(1));
    expect(s.focus(true, T(2))).toHaveLength(0);
    expect(s.tick(T(10))).toHaveLength(0);
  });

  it('a pending blur followed by hidden becomes tab_hidden from the blur time (no window_unfocused)', () => {
    const b = tracker();
    b.focus(false, T(10));
    const o = b.visibility(true, T(10.3));
    expect(o.map((u) => u.type)).toEqual(['tab_hidden']);
    expect(rel(o[0].startedAt)).toBe(10);
    // while hidden, blur time does not accumulate
    expect(b.tick(T(20))).toHaveLength(0);
    const v = b.visibility(false, T(30));
    expect(v.map((u) => `${u.type}:${u.phase}`)).toEqual(['tab_hidden:close']);
    // visible again but still unfocused → a new blur period starts at the visible time
    const w = b.tick(T(32.5));
    expect(w[0]).toMatchObject({ type: 'window_unfocused', phase: 'open' });
    expect(rel(w[0].startedAt)).toBe(30);
  });

  it('an already-reported blur is closed when the page becomes hidden', () => {
    const b = tracker();
    b.focus(false, T(10));
    b.tick(T(13));
    const o = b.visibility(true, T(14));
    expect(o.map((u) => `${u.type}:${u.phase}`)).toEqual(['window_unfocused:close', 'tab_hidden:open']);
    expect(rel(o[0].endedAt)).toBe(14);
    expect(rel(o[1].startedAt)).toBe(14);
  });

  it('fullscreen exit only when fullscreen is required', () => {
    const off = tracker({ requireFullscreen: false });
    expect(off.fullscreen(true, T(1))).toHaveLength(0);
    expect(off.fullscreen(false, T(2))).toHaveLength(0);
    const on = tracker({ requireFullscreen: true });
    expect(on.fullscreen(true, T(1))).toHaveLength(0);
    const o = on.fullscreen(false, T(5));
    expect(o[0]).toMatchObject({ type: 'fullscreen_exited', phase: 'open' });
    expect(on.fullscreen(false, T(6))).toHaveLength(0);
    const c = on.fullscreen(true, T(9));
    expect(c[0]).toMatchObject({ type: 'fullscreen_exited', phase: 'close' });
    expect(rel(c[0].endedAt)).toBe(9);
  });

  it('clipboard attempts aggregate into one episode until quiet', () => {
    const b = tracker();
    const all: EpisodeUpdate[] = [];
    all.push(...b.clipboard('copy', T(10)));
    all.push(...b.clipboard('paste', T(11)));
    all.push(...b.clipboard('paste', T(12)));
    for (let s = 13; s <= 25; s++) all.push(...b.tick(T(s)));
    const ids = new Set(all.map((u) => u.episodeId));
    expect(ids.size).toBe(1);
    expect(all[0]).toMatchObject({ type: 'clipboard_attempt', phase: 'open', captureSnapshot: 'onset' });
    const close = all[all.length - 1];
    expect(close.phase).toBe('close');
    expect(rel(close.startedAt)).toBe(10);
    expect(rel(close.endedAt)).toBe(12);
    expect(close.details).toMatchObject({ copy: 1, cut: 0, paste: 2, total: 3, blocked: true });
    expect(close.observation).toContain('3 copy/cut/paste actions');
    expect(all.length).toBeLessThanOrEqual(3);
  });

  it('repeated tab switches within the merge gap are one event', () => {
    const b = tracker();
    const all = [...b.visibility(true, T(10)), ...b.visibility(false, T(12)), ...b.visibility(true, T(15)), ...b.visibility(false, T(17))];
    expect(new Set(all.map((u) => u.episodeId)).size).toBe(1);
    expect(all.map((u) => u.phase)).toEqual(['open', 'close', 'update', 'close']);
    const last = all[3];
    expect(last.details.count).toBe(2);
    expect(last.details.totalSec).toBe(4);
    expect(rel(last.startedAt)).toBe(10);
    expect(rel(last.endedAt)).toBe(17);
    // Far apart → separate events.
    const c = tracker();
    const x = [...c.visibility(true, T(10)), ...c.visibility(false, T(12)), ...c.visibility(true, T(40)), ...c.visibility(false, T(41))];
    expect(new Set(x.map((u) => u.episodeId)).size).toBe(2);
  });

  it('additional display marker once per change to true', () => {
    const b = tracker();
    expect(b.displays(null, T(1))).toHaveLength(0);
    const m = b.displays(true, T(2));
    expect(m[0]).toMatchObject({ type: 'additional_display_detected', phase: 'close', version: 1 });
    expect(m[0].startedAt).toBe(m[0].endedAt);
    expect(b.displays(true, T(3))).toHaveLength(0);
    expect(b.displays(false, T(4))).toHaveLength(0);
    expect(b.displays(true, T(5))).toHaveLength(1);
  });

  it('flush closes everything open', () => {
    const b = tracker();
    b.visibility(true, T(1));
    b.fullscreen(false, T(1));
    b.clipboard('cut', T(2));
    const f = b.flush(T(5));
    expect(f.map((u) => `${u.type}:${u.phase}`).sort()).toEqual(['clipboard_attempt:close', 'fullscreen_exited:close', 'tab_hidden:close']);
    expect(b.flush(T(6))).toHaveLength(0);
  });
});

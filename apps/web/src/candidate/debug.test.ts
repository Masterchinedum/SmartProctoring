import { describe, expect, it, vi } from 'vitest';
import { DebugStore, debugEnabled } from './debug';

describe('candidate debug overlay switch', () => {
  it('is enabled only by ?debug=1 (or true)', () => {
    expect(debugEnabled('?debug=1')).toBe(true);
    expect(debugEnabled('?trace=1&debug=true')).toBe(true);
    expect(debugEnabled('?debug=0')).toBe(false);
    expect(debugEnabled('')).toBe(false);
  });

  it('collects nothing without the flag', () => {
    const d = new DebugStore(false);
    const fn = vi.fn();
    d.subscribe(fn);
    d.trigger({ at: 1, trigger: 'track_break', source: 'engine' });
    d.checkFrame({ at: 1, step: 'frontal', accepted: true, guidance: [], quality: null });
    expect(fn).not.toHaveBeenCalled();
    expect(d.snapshot(null)).toEqual({ triggers: [], lastBurst: null, lastCheckFrame: null, lastCheckOutcome: null, runtime: null });
  });

  it('keeps the latest triggers, check frame and burst when enabled', () => {
    const d = new DebugStore(true);
    const fn = vi.fn();
    d.subscribe(fn);
    for (let i = 0; i < 30; i++) d.trigger({ at: i, trigger: 'periodic', source: 'engine' });
    d.checkFrame({ at: 5, step: 1, accepted: false, guidance: ['Turn a little further'], quality: null, stepSatisfied: false });
    const s = d.snapshot(null);
    expect(s.triggers).toHaveLength(25);
    expect(s.triggers[0].at).toBe(5);
    expect(s.lastCheckFrame?.stepSatisfied).toBe(false);
    expect(fn).toHaveBeenCalledTimes(31);
  });
});

import { describe, expect, it } from 'vitest';
import { ClockSync, Countdown } from './clock';

describe('ClockSync', () => {
  it('estimates the offset from the request midpoint', () => {
    const c = new ClockSync();
    // client sent at 1000, got the reply at 1200; server stamped 6100 => server is 5000 ms ahead
    expect(c.addSample(6100, 1000, 1200)).toBe(5000);
    expect(c.now(2000)).toBe(7000);
    expect(c.toLocal(7000)).toBe(2000);
    expect(c.synced).toBe(true);
  });

  it('prefers the sample with the lowest round-trip time', () => {
    const c = new ClockSync(4);
    c.addSample(10_000 + 5000, 10_000, 10_020); // rtt 20 => offset 4990
    c.addSample(20_000 + 7000, 20_000, 22_000); // rtt 2000 (slow, asymmetric) => offset 6000
    expect(c.offsetMs).toBe(4990);
  });

  it('forgets old samples beyond the window', () => {
    const c = new ClockSync(2);
    c.addSample(1010, 1000, 1000); // rtt 0 => offset 10
    c.addSample(2100, 2000, 2100); // rtt 100 => offset 50
    c.addSample(3100, 3000, 3100); // rtt 100 => offset 50
    expect(c.offsetMs).toBe(50);
  });

  it('ignores invalid samples', () => {
    const c = new ClockSync();
    c.addSample(Number.NaN, 1, 2);
    expect(c.synced).toBe(false);
    expect(c.offsetMs).toBe(0);
  });
});

describe('Countdown', () => {
  it('counts down while running and stays put while stopped', () => {
    const cd = new Countdown(0);
    cd.sync(60_000, true, 1_000);
    expect(cd.remaining(1_000)).toBe(60_000);
    expect(cd.remaining(11_000)).toBe(50_000);
    expect(cd.remaining(1_000_000)).toBe(0);
    cd.sync(30_000, false, 20_000);
    expect(cd.running).toBe(false);
    expect(cd.remaining(20_000)).toBe(30_000);
    expect(cd.remaining(90_000)).toBe(30_000); // paused clock does not move
  });

  it('accounts for the time elapsed since the report when re-syncing', () => {
    const cd = new Countdown(0);
    // server says 60 s remaining at server time 1000; we apply it at server-now 1500
    cd.sync(60_000, true, 1_000, 1_500);
    expect(cd.remaining(1_500)).toBe(59_500);
  });

  it('ignores tiny corrections to avoid visible jitter, applies large ones', () => {
    const cd = new Countdown(900);
    cd.sync(60_000, true, 0);
    cd.sync(50_400, true, 10_000); // predicted 50_000, reported 50_400 => within tolerance, ignored
    expect(cd.remaining(10_000)).toBe(50_000);
    cd.sync(45_000, true, 10_000); // 5 s off => applied
    expect(cd.remaining(10_000)).toBe(45_000);
  });

  it('applies running-state changes even when the value is close', () => {
    const cd = new Countdown(900);
    cd.sync(10_000, true, 0);
    cd.sync(9_000, false, 1_000);
    expect(cd.running).toBe(false);
    expect(cd.remaining(5_000)).toBe(9_000);
  });

  it('freeze stops the local mirror at the current value', () => {
    const cd = new Countdown();
    cd.sync(10_000, true, 0);
    cd.freeze(4_000);
    expect(cd.remaining(9_000)).toBe(6_000);
    expect(cd.running).toBe(false);
  });

  it('never goes negative', () => {
    const cd = new Countdown();
    cd.sync(-5, true, 0);
    expect(cd.remaining(10)).toBe(0);
  });
});

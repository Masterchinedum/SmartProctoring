import { describe, expect, it } from 'vitest';
import { LoadMonitor } from './load-monitor';

const log = { warn: () => {} } as never;
const pool = (waiting: number) => ({ totalCount: 20, idleCount: 0, waitingCount: waiting }) as never;

describe('LoadMonitor', () => {
  it('samples the event loop, the DB pool and the vision queue', () => {
    const m = new LoadMonitor({ pool: pool(3), vision: { stats: { inFlight: 3, queued: 7, workers: 3 } }, log });
    const s = m.sample();
    expect(s).toMatchObject({ dbTotal: 20, dbWaiting: 3, visionInFlight: 3, visionQueued: 7, visionWorkers: 3 });
    expect(m.snapshot).toBe(s);
    expect(m.overloaded(s)).toEqual([]);
  });

  it('names what is overloaded', () => {
    const m = new LoadMonitor({ pool: pool(40), vision: { stats: { inFlight: 3, queued: 100, workers: 3 } }, log });
    expect(m.overloaded({ ...m.sample(), eventLoopP99Ms: 450 })).toEqual(['event loop lagging', 'database pool exhausted', 'face analysis queue long']);
    // A vision service without stats (FakeVisionService) is fine.
    const n = new LoadMonitor({ pool: pool(0), vision: {}, log });
    expect(n.sample().visionQueued).toBeNull();
  });
});

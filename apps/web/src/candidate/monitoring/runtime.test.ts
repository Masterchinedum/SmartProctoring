import { describe, expect, it } from 'vitest';
import { eventUpsertSchema, type EpisodeUpdate } from '@sp/shared';
import { episodeToUpsert, toFlushReason } from './runtime';
import { TraceRecorder, traceEnabled } from './trace';

describe('episodeToUpsert', () => {
  const ep: EpisodeUpdate = {
    episodeId: '0d6f3a4e-8c1b-4c55-9d7e-2a1b3c4d5e6f',
    type: 'multiple_people',
    phase: 'open',
    startedAt: 1_700_000_000_000.4,
    endedAt: null,
    confidence: 1.2,
    observation: 'x'.repeat(800),
    details: { faces: 2 },
    version: 1,
    captureSnapshot: 'onset',
  };

  it('produces a valid EventUpsert with the original timestamps', () => {
    const u = episodeToUpsert(ep, 'instance-1234');
    expect(() => eventUpsertSchema.parse(u)).not.toThrow();
    expect(u).toMatchObject({ id: ep.episodeId, type: 'multiple_people', phase: 'open', startedAt: 1_700_000_000_000, endedAt: null, version: 1, clientInstanceId: 'instance-1234' });
    expect(u.confidence).toBe(1);
    expect(u.observation).toHaveLength(500);
    expect('captureSnapshot' in u).toBe(false);
  });

  it('keeps close phases and end times', () => {
    const u = episodeToUpsert({ ...ep, phase: 'close', endedAt: 1_700_000_005_000, version: 3, confidence: Number.NaN }, 'i-12345678');
    expect(u).toMatchObject({ phase: 'close', endedAt: 1_700_000_005_000, version: 3, confidence: 0 });
  });
});

describe('toFlushReason', () => {
  it('maps host reasons to engine flush reasons', () => {
    expect(toFlushReason('pause')).toBe('pause');
    expect(toFlushReason('paused')).toBe('pause');
    expect(toFlushReason('submit')).toBe('submit');
    expect(toFlushReason('terminated')).toBe('submit');
    expect(toFlushReason('on_hold')).toBe('hold');
    expect(toFlushReason('check_required')).toBe('stop');
  });
});

describe('TraceRecorder', () => {
  it('is enabled by ?trace=1 only', () => {
    expect(traceEnabled('?trace=1')).toBe(true);
    expect(traceEnabled('?x=1&trace=true')).toBe(true);
    expect(traceEnabled('?trace=0')).toBe(false);
    expect(traceEnabled('')).toBe(false);
  });

  it('exports bounded JSONL with a meta header', () => {
    const t = new TraceRecorder({ instanceId: 'abc' }, 3);
    for (let i = 0; i < 5; i++) t.observation({ t: i, camera: 'live', frame: null, faces: [], objects: null });
    t.marker(10, 'monitoring_stop');
    const lines = t.toJsonl().trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ kind: 'meta', format: 'sp-trace/1', instanceId: 'abc', droppedLines: 3 });
    expect(lines).toHaveLength(4);
    expect(lines.slice(1).map((l) => l.kind)).toEqual(['obs', 'obs', 'marker']);
    expect(t.observationCount).toBe(2);
  });
});

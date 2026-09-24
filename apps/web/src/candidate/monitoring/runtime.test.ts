import { describe, expect, it } from 'vitest';
import { eventUpsertSchema, type EpisodeUpdate } from '@sp/shared';
import { DEFAULT_POLICY, type IdentitySampleResponse } from '@sp/shared';
import { vi } from 'vitest';
import { episodeToUpsert, MonitoringRuntime, SampleTriggerQueue, toFlushReason, type RuntimeDeps } from './runtime';
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

describe('isSoftwareRenderer', () => {
  it('recognises software WebGL renderers', async () => {
    const { isSoftwareRenderer } = await import('./vision');
    expect(isSoftwareRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)')).toBe(true);
    expect(isSoftwareRenderer('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe(true);
    expect(isSoftwareRenderer(null)).toBe(true);
    expect(isSoftwareRenderer('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(false);
    expect(isSoftwareRenderer('Apple M1')).toBe(false);
  });
});

describe('SampleTriggerQueue', () => {
  it('keeps the most important waiting trigger', () => {
    const q = new SampleTriggerQueue();
    q.push('periodic', 0);
    q.push('face_return', 1);
    q.push('after_obstruction', 2);
    expect(q.take(3)).toBe('face_return');
    expect(q.take(3)).toBeNull();
    q.push('camera_reconnect', 0);
    q.push('periodic', 0);
    expect(q.take(0)).toBe('camera_reconnect');
  });

  it('expires stale requests except server follow-ups', () => {
    const q = new SampleTriggerQueue(1000);
    q.push('face_return', 0);
    expect(q.take(5000)).toBeNull();
    q.push('follow_up', 0);
    expect(q.take(5000)).toBe('follow_up');
  });
});

describe('MonitoringRuntime.handleSampleResult', () => {
  function makeRuntime() {
    const deps = {
      api: {},
      outbox: {},
      camera: {},
      clock: { now: () => Date.now() },
      policy: DEFAULT_POLICY,
      instanceId: 'instance-0001',
      baseline: null,
      onSignal: vi.fn(),
      onHold: vi.fn(),
    } as unknown as RuntimeDeps & { onSignal: ReturnType<typeof vi.fn>; onHold: ReturnType<typeof vi.fn> };
    return { rt: new MonitoringRuntime(deps), deps };
  }
  const result = (decision: 'match' | 'unable_to_verify' | 'mismatch', guidance: string[] = []): IdentitySampleResponse => ({
    result: { id: 'r', trigger: 'periodic', decision, similarity: null, confidence: 0.5, quality: null, guidance, at: 1 },
    followUpInMs: null,
    status: 'active',
    hold: null,
  });

  it('shows the server guidance when the image could not be verified, and clears it after a match', () => {
    const { rt, deps } = makeRuntime();
    rt.handleSampleResult(result('unable_to_verify', ['Your face is too dark. Turn on a light.']));
    expect(deps.onSignal).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'candidate_prompt', key: 'identity_guidance', message: expect.stringContaining('Your face is too dark') }),
    );
    rt.handleSampleResult(result('match'));
    expect(deps.onSignal).toHaveBeenLastCalledWith({ kind: 'candidate_prompt_clear', key: 'identity_guidance' });
  });

  it('switches to the hold screen when the server holds the exam', () => {
    const { rt, deps } = makeRuntime();
    rt.handleSampleResult({ ...result('mismatch'), status: 'on_hold' });
    expect(deps.onHold).toHaveBeenCalled();
    expect(deps.onSignal).not.toHaveBeenCalled();
  });
});

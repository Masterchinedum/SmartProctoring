import { describe, expect, it } from 'vitest';
import { eventUpsertSchema, type EpisodeUpdate } from '@sp/shared';
import { DEFAULT_POLICY, type IdentitySampleResponse } from '@sp/shared';
import { vi } from 'vitest';
import { episodeToUpsert, MonitoringRuntime, routineCadence, SampleTriggerQueue, stripDescriptors, toFlushReason, type RuntimeDeps } from './runtime';
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

  it('exports bounded JSONL in the evaluation harness format', async () => {
    const t = new TraceRecorder({ instanceId: 'abc' }, 4);
    t.baseline({ yaw: 0, pitch: -5, cx: 0.5, cy: 0.45, faceWidth: 0.3, luma: 120, dhash: '0123456789abcdef', capturedAt: 1, samples: 12 });
    t.camera(1, 'Integrated Camera', 'ab12');
    for (let i = 0; i < 5; i++) t.observation({ t: 10 + i, camera: 'live', frame: null, faces: [], objects: null });
    t.flush(20, 'pause');
    const text = t.toJsonl();
    const lines = text.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ $: 'meta', format: 'sp-trace/1', instanceId: 'abc', droppedLines: 4 });
    expect(lines).toHaveLength(5);
    expect(t.observationCount).toBe(3);
    // The detection harness parses it unchanged.
    const { parseTraceJsonl } = await import('../../../../../packages/detection/src/eval/runner');
    const records = parseTraceJsonl(text);
    expect(records.filter((r) => !('$' in r))).toHaveLength(3);
    expect(records.at(-1)).toEqual({ $: 'flush', t: 20, reason: 'pause' });
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
  const result = (usable: boolean, guidance: string[] = []): IdentitySampleResponse => ({
    result: { id: 'r', trigger: 'periodic', usable, guidance, at: 1 },
    followUpInMs: null,
    status: 'active',
    hold: null,
  });

  it('shows the server guidance when the image could not be used, and clears it after a usable image', () => {
    const { rt, deps } = makeRuntime();
    rt.handleSampleResult(result(false, ['Your face is too dark. Turn on a light.']));
    expect(deps.onSignal).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'candidate_prompt', key: 'identity_guidance', message: expect.stringContaining('Your face is too dark') }),
    );
    rt.handleSampleResult(result(true));
    expect(deps.onSignal).toHaveBeenLastCalledWith({ kind: 'candidate_prompt_clear', key: 'identity_guidance' });
  });

  it('shows lighting guidance for a usable image when the server sends it (poor light), without a verdict', () => {
    const { rt, deps } = makeRuntime();
    rt.handleSampleResult(result(true, ['Add light in front of you.']));
    expect(deps.onSignal).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'candidate_prompt', key: 'identity_guidance', message: 'Add light in front of you.' }));
  });

  it('switches to the hold screen when the server holds the exam', () => {
    const { rt, deps } = makeRuntime();
    rt.handleSampleResult({ ...result(true), status: 'on_hold' });
    expect(deps.onHold).toHaveBeenCalled();
    expect(deps.onSignal).not.toHaveBeenCalled();
  });
});

describe('routineCadence (server-driven sampling)', () => {
  const base: IdentitySampleResponse = {
    result: { id: 'r', trigger: 'periodic', usable: true, guidance: [], at: 1 },
    followUpInMs: null,
    status: 'active',
    hold: null,
  };

  it('v2: next routine burst after nextSampleInMs — periodic unless the server wants a faster look', () => {
    expect(routineCadence({ ...base, nextSampleInMs: 6000 })).toEqual({ inMs: 6000, label: 'periodic', followUpInMs: null });
  });

  it('v2: labelled server_request while the server wants a faster look (followUpInMs, the only cadence hint)', () => {
    expect(routineCadence({ ...base, nextSampleInMs: 2500, followUpInMs: 2500 })).toEqual({ inMs: 2500, label: 'server_request', followUpInMs: null });
    expect(routineCadence({ ...base, nextSampleInMs: 3000 }).label).toBe('periodic');
  });

  it('v2 without a time: the follow-up delay, else the policy interval', () => {
    expect(routineCadence({ ...base, nextSampleInMs: null, followUpInMs: 3000 }).inMs).toBe(3000);
    expect(routineCadence({ ...base, nextSampleInMs: null }).inMs).toBeNull();
  });

  it('the candidate response carries no verdict or evidence state', () => {
    const keys = Object.keys(base.result).sort();
    expect(keys).toEqual(['at', 'guidance', 'id', 'trigger', 'usable']);
    expect('evidence' in base).toBe(false);
  });

  it('an older server (no v2 fields): its follow-up sample as before, routine sampling at the policy interval', () => {
    expect(routineCadence({ ...base, followUpInMs: 4000 })).toEqual({ inMs: null, label: 'periodic', followUpInMs: 4000 });
  });
});

describe('stripDescriptors', () => {
  it('removes the appearance descriptors from traced observations (and keeps everything else)', () => {
    const face = { box: { x: 0, y: 0, w: 0.3, h: 0.4 }, score: 0.9, yaw: 1, pitch: 2, roll: 0, gazeX: 0, gazeY: 0, visibility: 1, cutOff: false };
    const obs = { t: 1, camera: 'live' as const, frame: null, faces: [{ ...face, descriptor: { patch: new Float32Array(256), geom: [1] } }], objects: null };
    const out = stripDescriptors(obs);
    expect('descriptor' in out.faces[0]).toBe(false);
    expect(out.faces[0]).toEqual(face);
    expect(stripDescriptors({ ...obs, faces: [face] }).faces[0]).toBe(face);
  });
});

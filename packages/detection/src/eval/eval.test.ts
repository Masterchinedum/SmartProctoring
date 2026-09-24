import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '@sp/shared';
import { aggregate, parseLabels, parseTraceJsonl, runRecordedTrace, runScenario } from './runner';
import { finalizeMetrics, matchTrace, type PredEpisode } from './metrics';
import { SCENARIOS } from './scenarios';
import { synthesize } from './synth';

const pred = (type: PredEpisode['type'], s: number, e: number | null, openedAt = s + 1): PredEpisode => ({
  id: `${type}-${s}`,
  type,
  startedAt: s * 1000,
  endedAt: e === null ? null : e * 1000,
  openedAt: openedAt * 1000,
  confidence: 0.8,
  versions: 2,
  snapshots: 1,
  details: {},
});

describe('matchTrace / finalizeMetrics', () => {
  it('counts TP / FP / FN / duplicates and latency by type + temporal overlap', () => {
    const labels = [
      { type: 'candidate_absent' as const, start: 10_000, end: 22_000 },
      { type: 'candidate_absent' as const, start: 100_000, end: 110_000 },
      { type: 'looking_away' as const, start: 50_000, end: 58_000, optional: true },
    ];
    const preds = [
      pred('candidate_absent', 10, 22, 18),
      pred('candidate_absent', 15, 20), // duplicate of the first issue
      pred('candidate_absent', 300, 310), // false positive
      pred('looking_away', 51, 57), // overlaps an optional label → ignored
      pred('phone_detected', 70, 75), // false positive of another type
    ];
    const m = matchTrace(labels, preds, 600_000, 600_000);
    const a = m.get('candidate_absent')!;
    expect(a).toMatchObject({ tp: 1, fp: 1, fn: 1, duplicates: 1, gt: 2 });
    expect(a.latenciesSec).toEqual([8]);
    expect(m.get('looking_away')).toMatchObject({ tp: 0, fp: 0, fn: 0 });
    expect(m.get('phone_detected')).toMatchObject({ fp: 1 });
    const f = finalizeMetrics('candidate_absent', a);
    expect(f.precision).toBe(0.5);
    expect(f.recall).toBe(0.5);
    expect(f.oneEventPerIssue).toBe(false);
    expect(f.cleanHours).toBeCloseTo((600 - 22) / 3600, 3);
    expect(f.falseAlertsPerHour).toBeGreaterThan(0);
  });
});

describe('synthesize', () => {
  it('is deterministic per seed and produces live 5 Hz observations with ~1 Hz objects', () => {
    const a = synthesize({ seed: 11, durationSec: 20 });
    const b = synthesize({ seed: 11, durationSec: 20 });
    expect(a.observations).toEqual(b.observations);
    expect(a.observations.length).toBeGreaterThanOrEqual(99);
    const withObjects = a.observations.filter((o) => o.objects !== null).length;
    expect(withObjects).toBeGreaterThanOrEqual(19);
    expect(withObjects).toBeLessThanOrEqual(21);
    expect(a.observations.every((o) => o.camera === 'live')).toBe(true);
  });
});

describe('scenario runs', () => {
  const pick = (name: string) => SCENARIOS.find((s) => s.name === name)!;

  it('every scenario builds and its labels are within the trace', () => {
    for (const sc of SCENARIOS) {
      const b = sc.build(1);
      for (const l of b.labels) {
        expect(l.start).toBeGreaterThanOrEqual(0);
        expect(l.end).toBeLessThanOrEqual(b.spec.durationSec);
      }
    }
  });

  it('produces sane per-detector metrics and one event per ongoing issue', () => {
    const names = ['absence_12s', 'multi_face_1_5s', 'multi_face_30s', 'phone_5s', 'look_away_8s', 'covered_lens', 'camera_disconnect', 'brief_glances', 'still_person'];
    const runs = names.map((n) => runScenario(pick(n), 1));
    const rep = aggregate(runs, DEFAULT_POLICY.detection, [1]);
    const by = (t: string) => rep.byType.find((m) => m.type === t)!;
    for (const t of ['candidate_absent', 'multiple_people', 'phone_detected', 'looking_away', 'camera_covered', 'camera_disconnected']) {
      expect(by(t).recall).toBe(1);
      expect(by(t).precision).toBe(1);
      expect(by(t).duplicates).toBe(0);
    }
    expect(by('multiple_people').tp).toBe(2);
    expect(by('candidate_absent').latencyMeanSec!).toBeGreaterThan(7.5);
    expect(by('candidate_absent').latencyMeanSec!).toBeLessThan(10.5);
    expect(rep.checks.noDuplicateEvents).toBe(true);
    expect(rep.checks.oneEventPerOngoingIssue).toBe(true);
    expect(rep.checks.cleanSessionFalseAlertsPerHour).toBe(0);
    expect(rep.checks.maxMsPerTick).toBeLessThan(1);
    expect(rep.monitoredHours).toBeGreaterThan(0.2);
  });

  it('recorded traces: JSONL + labels (seconds relative to the first observation) → same metrics', () => {
    const tr = synthesize({ seed: 5, durationSec: 60, segments: [{ kind: 'absent', start: 20, end: 34 }] });
    const jsonl = [
      '# recorded by the web app trace recorder',
      JSON.stringify({ $: 'meta', app: 'test' }),
      JSON.stringify({ $: 'camera', t: tr.t0, label: 'Integrated Camera', deviceIdHash: 'abc' }),
      ...tr.observations.map((o) => JSON.stringify(o)),
    ].join('\n');
    const records = parseTraceJsonl(jsonl);
    expect(records.length).toBe(tr.observations.length + 2);
    const labels = parseLabels(JSON.stringify([{ type: 'candidate_absent', start: 20, end: 34 }]));
    const run = runRecordedTrace('rec', records, labels);
    const c = run.counts.get('candidate_absent')!;
    expect(c).toMatchObject({ tp: 1, fp: 0, fn: 0 });
    expect(() => parseLabels('[{"type":"nope","start":1,"end":2}]')).toThrow(/unknown event type/);
    expect(() => parseTraceJsonl('{"x":1}')).toThrow(/not a FrameObservation/);
  });
});

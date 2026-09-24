import { DEFAULT_POLICY, EVENT_TYPES, type Baseline, type DetectionPolicy, type EngineSignal, type EpisodeUpdate, type EventType, type FrameObservation } from '@sp/shared';
import { createBaselineCalibrator } from '../baseline/calibrator';
import { createMonitoringEngine } from '../engine/engine';
import { sequentialIdFactory } from '../util/id';
import { addCounts, emptyCounts, finalizeMetrics, matchTrace, type Label, type PredEpisode, type TraceTypeCounts, type TypeMetrics } from './metrics';
import type { Scenario } from './scenarios';
import { synthesize } from './synth';

/**
 * Trace replay and scoring. Pure (no Node APIs) so it can also run in a browser dev page.
 *
 * Trace format (JSONL, one record per line):
 *   - a FrameObservation (has `t` and `camera`), or
 *   - a control record: {"$":"camera","t":…,"label":"…","deviceIdHash":"…"}   (setCameraInfo)
 *                       {"$":"baseline","baseline":{…Baseline}}              (setBaseline)
 *                       {"$":"flush","t":…,"reason":"pause"|"submit"|"hold"|"stop"}
 *                       {"$":"meta", …anything}                               (ignored)
 */
export type ControlRecord =
  | { $: 'camera'; t: number; label: string; deviceIdHash: string }
  | { $: 'baseline'; baseline: Baseline }
  | { $: 'flush'; t: number; reason: 'pause' | 'submit' | 'hold' | 'stop' }
  | { $: 'meta'; [k: string]: unknown };

export type TraceRecord = FrameObservation | ControlRecord;

export interface ReplayOptions {
  policy?: DetectionPolicy;
  identityIntervalSec?: number;
  /** When the trace has no baseline record, calibrate from its first N seconds (like check-in). Default 5. */
  calibrateSec?: number;
  evidence?: { maxScreenshotsPerEvent: number; periodicScreenshotSec: number };
}

export interface ReplayResult {
  preds: PredEpisode[];
  updates: { at: number; update: EpisodeUpdate }[];
  signals: { at: number; signal: EngineSignal }[];
  startT: number;
  endT: number;
  monitoredMs: number;
  baseline: Baseline | null;
  ticks: number;
  /** Mean engine time per ingest (ms) — performance sanity check. */
  msPerTick: number;
}

function isControl(r: TraceRecord): r is ControlRecord {
  return typeof (r as ControlRecord).$ === 'string';
}

function now(): number {
  const p = (globalThis as { performance?: { now(): number } }).performance;
  return p ? p.now() : Date.now();
}

export function replayTrace(records: readonly TraceRecord[], opts: ReplayOptions = {}): ReplayResult {
  const policy = opts.policy ?? DEFAULT_POLICY.detection;
  const engine = createMonitoringEngine({
    policy,
    identityIntervalSec: opts.identityIntervalSec ?? DEFAULT_POLICY.identity.periodicCheckIntervalSec,
    evidence: opts.evidence ?? { maxScreenshotsPerEvent: DEFAULT_POLICY.evidence.maxScreenshotsPerEvent, periodicScreenshotSec: DEFAULT_POLICY.evidence.periodicScreenshotSec },
    idFactory: sequentialIdFactory(),
  });
  const obsList = records.filter((r): r is FrameObservation => !isControl(r));
  const startT = obsList.length ? obsList[0].t : 0;
  const endT = obsList.length ? obsList[obsList.length - 1].t : 0;

  // Baseline: explicit record, else calibrate from the first seconds (what the host does at check-in).
  let baseline: Baseline | null = null;
  const explicit = records.find((r): r is Extract<ControlRecord, { $: 'baseline' }> => isControl(r) && r.$ === 'baseline');
  if (!explicit) {
    const cal = createBaselineCalibrator();
    const until = startT + (opts.calibrateSec ?? 5) * 1000;
    for (const o of obsList) {
      if (o.t > until) break;
      cal.add(o);
    }
    baseline = cal.result();
    if (baseline) engine.setBaseline(baseline);
  }

  const byId = new Map<string, PredEpisode>();
  const updates: ReplayResult['updates'] = [];
  const signals: ReplayResult['signals'] = [];
  const collect = (at: number, eps: EpisodeUpdate[], sigs: EngineSignal[]) => {
    for (const u of eps) {
      updates.push({ at, update: u });
      const prev = byId.get(u.episodeId);
      const snap = u.captureSnapshot ? 1 : 0;
      if (!prev) {
        byId.set(u.episodeId, {
          id: u.episodeId,
          type: u.type,
          startedAt: u.startedAt,
          endedAt: u.endedAt,
          openedAt: at,
          confidence: u.confidence,
          versions: u.version,
          snapshots: snap,
          details: u.details,
        });
      } else if (u.version > prev.versions) {
        prev.startedAt = u.startedAt;
        prev.endedAt = u.endedAt;
        prev.confidence = u.confidence;
        prev.versions = u.version;
        prev.snapshots += snap;
        prev.details = u.details;
      }
    }
    for (const s of sigs) signals.push({ at, signal: s });
  };

  let ticks = 0;
  let spent = 0;
  let lastT = startT;
  for (const r of records) {
    if (isControl(r)) {
      if (r.$ === 'camera') {
        const o = engine.setCameraInfo({ label: r.label, deviceIdHash: r.deviceIdHash }, r.t);
        collect(r.t, o.episodes, o.signals);
      } else if (r.$ === 'baseline') {
        engine.setBaseline(r.baseline);
        baseline = r.baseline;
      } else if (r.$ === 'flush') {
        const o = engine.flush(r.t, r.reason);
        collect(r.t, o.episodes, o.signals);
      }
      continue;
    }
    const a = now();
    const o = engine.ingest(r);
    spent += now() - a;
    ticks++;
    lastT = r.t;
    collect(r.t, o.episodes, o.signals);
  }
  const f = engine.flush(lastT, 'stop');
  collect(lastT, f.episodes, f.signals);
  return {
    preds: [...byId.values()],
    updates,
    signals,
    startT,
    endT,
    monitoredMs: Math.max(0, endT - startT),
    baseline,
    ticks,
    msPerTick: ticks ? spent / ticks : 0,
  };
}

/* ------------------------------------------------------------------ scenarios */

export interface ScenarioRun {
  scenario: string;
  seed: number;
  durationSec: number;
  labels: Label[];
  result: ReplayResult;
  counts: Map<EventType, TraceTypeCounts>;
}

export function runScenario(sc: Scenario, seed: number, opts: ReplayOptions = {}): ScenarioRun {
  const b = sc.build(seed);
  const trace = synthesize(b.spec);
  const records: TraceRecord[] = [{ $: 'camera', t: trace.t0, label: b.cameraLabel ?? 'Integrated Webcam (0bda:5634)', deviceIdHash: 'cam-a' }, ...trace.observations];
  const result = replayTrace(records, opts);
  const labels: Label[] = b.labels.map((l) => ({ ...l, start: trace.t0 + l.start * 1000, end: trace.t0 + l.end * 1000 }));
  return { scenario: sc.name, seed, durationSec: b.spec.durationSec, labels, result, counts: matchTrace(labels, result.preds, result.monitoredMs, result.endT) };
}

/** Score a recorded trace against its labels (labels in epoch ms, or seconds from the first observation if < 1e11). */
export function runRecordedTrace(name: string, records: TraceRecord[], rawLabels: Label[], opts: ReplayOptions = {}): ScenarioRun {
  const result = replayTrace(records, opts);
  const labels = rawLabels.map((l) => (l.start < 1e11 ? { ...l, start: result.startT + l.start * 1000, end: result.startT + l.end * 1000 } : l));
  return { scenario: name, seed: 0, durationSec: result.monitoredMs / 1000, labels, result, counts: matchTrace(labels, result.preds, result.monitoredMs, result.endT) };
}

/* ------------------------------------------------------------------ aggregation */

export interface ScenarioSummary {
  scenario: string;
  runs: number;
  monitoredMin: number;
  expected: Partial<Record<EventType, number>>;
  detected: Partial<Record<EventType, number>>;
  falsePositives: Partial<Record<EventType, number>>;
  missed: Partial<Record<EventType, number>>;
  duplicates: number;
  msPerTick: number;
}

export interface EvalReport {
  version: 1;
  generatedAt: string;
  engine: '@sp/detection';
  policy: DetectionPolicy;
  seeds: number[];
  monitoredHours: number;
  byType: TypeMetrics[];
  scenarios: ScenarioSummary[];
  checks: {
    noDuplicateEvents: boolean;
    oneEventPerOngoingIssue: boolean;
    cleanSessionFalseAlertsPerHour: number | null;
    maxMsPerTick: number;
  };
}

export function aggregate(runs: ScenarioRun[], policy: DetectionPolicy, seeds: number[]): EvalReport {
  const totals = new Map<EventType, TraceTypeCounts>();
  let monitoredMs = 0;
  for (const run of runs) {
    monitoredMs += run.result.monitoredMs;
    for (const type of EVENT_TYPES) {
      if (!totals.has(type)) totals.set(type, emptyCounts());
      const c = run.counts.get(type);
      if (c) addCounts(totals.get(type)!, c);
      // Types absent from this run: its whole monitored time is clean for them.
      else totals.get(type)!.cleanMs += run.result.monitoredMs;
    }
  }
  const relevant = [...totals.entries()].filter(([type, c]) => c.gt > 0 || c.pred > 0 || CLIENT_VISION_TYPES.includes(type));
  const byType = relevant.map(([type, c]) => finalizeMetrics(type, c));

  const byScenario = new Map<string, ScenarioRun[]>();
  for (const r of runs) byScenario.set(r.scenario, [...(byScenario.get(r.scenario) ?? []), r]);
  const scenarios: ScenarioSummary[] = [];
  for (const [name, list] of byScenario) {
    const s: ScenarioSummary = { scenario: name, runs: list.length, monitoredMin: 0, expected: {}, detected: {}, falsePositives: {}, missed: {}, duplicates: 0, msPerTick: 0 };
    let spent = 0;
    for (const r of list) {
      s.monitoredMin += r.result.monitoredMs / 60000;
      spent += r.result.msPerTick;
      for (const [type, c] of r.counts) {
        if (c.gt) s.expected[type] = (s.expected[type] ?? 0) + c.gt;
        if (c.tp) s.detected[type] = (s.detected[type] ?? 0) + c.tp;
        if (c.fp) s.falsePositives[type] = (s.falsePositives[type] ?? 0) + c.fp;
        if (c.fn) s.missed[type] = (s.missed[type] ?? 0) + c.fn;
        s.duplicates += c.duplicates;
      }
    }
    s.monitoredMin = Math.round(s.monitoredMin * 10) / 10;
    s.msPerTick = Math.round((spent / list.length) * 1000) / 1000;
    scenarios.push(s);
  }

  const clean = runs.filter((r) => r.labels.length === 0);
  const cleanHours = clean.reduce((a, r) => a + r.result.monitoredMs, 0) / 3_600_000;
  const cleanFp = clean.reduce((a, r) => a + [...r.counts.values()].reduce((x, c) => x + c.fp, 0), 0);
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    engine: '@sp/detection',
    policy,
    seeds,
    monitoredHours: Math.round((monitoredMs / 3_600_000) * 1000) / 1000,
    byType,
    scenarios,
    checks: {
      noDuplicateEvents: byType.every((m) => m.duplicates === 0),
      oneEventPerOngoingIssue: byType.every((m) => m.oneEventPerIssue),
      cleanSessionFalseAlertsPerHour: cleanHours > 0 ? Math.round((cleanFp / cleanHours) * 1000) / 1000 : null,
      maxMsPerTick: Math.round(Math.max(0, ...runs.map((r) => r.result.msPerTick)) * 1000) / 1000,
    },
  };
}

/** Client-vision event types always listed in reports (even with no GT / predictions). */
export const CLIENT_VISION_TYPES: EventType[] = [
  'candidate_absent',
  'multiple_people',
  'looking_away',
  'repeated_looking_away',
  'offscreen_attention_pattern',
  'unusual_movement',
  'phone_detected',
  'unauthorized_object',
  'face_obstructed',
  'camera_covered',
  'camera_frozen',
  'lighting_unusable',
  'camera_feed_suspect',
  'camera_disconnected',
  'camera_permission_lost',
  'monitoring_degraded',
];

/* ------------------------------------------------------------------ parsing (pure) */

/** Parse JSONL trace text. Blank lines and lines starting with '#' or '//' are skipped. */
export function parseTraceJsonl(text: string): TraceRecord[] {
  const out: TraceRecord[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const s = line.trim();
    if (!s || s.startsWith('#') || s.startsWith('//')) return;
    let v: unknown;
    try {
      v = JSON.parse(s);
    } catch (e) {
      throw new Error(`trace line ${i + 1}: invalid JSON (${(e as Error).message})`);
    }
    if (!v || typeof v !== 'object') throw new Error(`trace line ${i + 1}: expected an object`);
    const r = v as Record<string, unknown>;
    if (typeof r.$ === 'string') {
      out.push(r as unknown as ControlRecord);
      return;
    }
    if (typeof r.t !== 'number' || typeof r.camera !== 'string') throw new Error(`trace line ${i + 1}: not a FrameObservation (needs numeric "t" and "camera")`);
    out.push({
      t: r.t,
      camera: r.camera as FrameObservation['camera'],
      frame: (r.frame as FrameObservation['frame']) ?? null,
      faces: Array.isArray(r.faces) ? (r.faces as FrameObservation['faces']) : [],
      objects: Array.isArray(r.objects) ? (r.objects as FrameObservation['objects']) : null,
      ...(typeof r.fps === 'number' ? { fps: r.fps } : {}),
    });
  });
  return out;
}

/** Parse a labels JSON array: [{type, start, end, optional?}]. */
export function parseLabels(text: string): Label[] {
  const v = JSON.parse(text) as unknown;
  const arr = Array.isArray(v) ? v : Array.isArray((v as { labels?: unknown })?.labels) ? (v as { labels: unknown[] }).labels : null;
  if (!arr) throw new Error('labels: expected a JSON array of {type, start, end}');
  return arr.map((x, i) => {
    const l = x as Record<string, unknown>;
    if (typeof l.type !== 'string' || !(EVENT_TYPES as readonly string[]).includes(l.type)) throw new Error(`labels[${i}]: unknown event type ${String(l.type)}`);
    if (typeof l.start !== 'number' || typeof l.end !== 'number' || l.end < l.start) throw new Error(`labels[${i}]: needs numeric start <= end`);
    return { type: l.type as EventType, start: l.start, end: l.end, optional: l.optional === true, note: typeof l.note === 'string' ? l.note : undefined };
  });
}

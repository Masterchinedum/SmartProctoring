import type { EventType } from '@sp/shared';
import { mean, percentile, round } from '../util/math';

/** Ground-truth episode. `optional` labels are neither required (no FN if missed) nor penalised (no FP). */
export interface Label {
  type: EventType;
  /** Epoch ms. */
  start: number;
  end: number;
  optional?: boolean;
  note?: string;
}

/** Final state of one predicted episode (latest version) plus when it was first reported. */
export interface PredEpisode {
  id: string;
  type: EventType;
  startedAt: number;
  endedAt: number | null;
  /** Observation time at which phase 'open' was emitted (onset latency reference). */
  openedAt: number;
  confidence: number;
  versions: number;
  snapshots: number;
  details: Record<string, unknown>;
}

export interface TraceTypeCounts {
  tp: number;
  fp: number;
  fn: number;
  duplicates: number;
  latenciesSec: number[];
  /** Monitored time not covered by any label of this type (ms). */
  cleanMs: number;
  gt: number;
  pred: number;
  /** GT episodes matched by exactly one predicted episode. */
  singleEventIssues: number;
  fpEpisodes: { startedAt: number; endedAt: number | null; confidence: number }[];
  fnLabels: { start: number; end: number }[];
}

export interface TypeMetrics {
  type: EventType;
  gt: number;
  pred: number;
  tp: number;
  fp: number;
  fn: number;
  duplicates: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  cleanHours: number;
  falseAlertsPerHour: number;
  latencyMeanSec: number | null;
  latencyP95Sec: number | null;
  /** Every matched ongoing issue appeared as exactly one event. */
  oneEventPerIssue: boolean;
}

/** Matching tolerance: predicted and GT intervals must overlap after widening each side by this. */
export const MATCH_TOLERANCE_MS = 2000;

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number, tol: number): number {
  return Math.min(aEnd, bEnd + tol) - Math.max(aStart, bStart - tol);
}

function union(intervals: [number, number][]): number {
  const s = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cs = -Infinity;
  let ce = -Infinity;
  for (const [a, b] of s) {
    if (a > ce) {
      if (ce > cs) total += ce - cs;
      cs = a;
      ce = b;
    } else ce = Math.max(ce, b);
  }
  if (ce > cs) total += ce - cs;
  return total;
}

/**
 * Match predicted episodes to labels of the same type by temporal overlap (one-to-one, largest overlap
 * first). Unmatched predictions overlapping an already-matched label count as DUPLICATES (the same
 * ongoing issue reported more than once); unmatched predictions overlapping only optional labels are
 * ignored; the rest are false positives.
 */
export function matchTrace(
  labels: Label[],
  preds: PredEpisode[],
  monitoredMs: number,
  endT: number,
  tol = MATCH_TOLERANCE_MS,
): Map<EventType, TraceTypeCounts> {
  const types = new Set<EventType>([...labels.map((l) => l.type), ...preds.map((p) => p.type)]);
  const out = new Map<EventType, TraceTypeCounts>();
  for (const type of types) {
    const L = labels.filter((l) => l.type === type);
    const P = preds.filter((p) => p.type === type);
    const pEnd = (p: PredEpisode) => p.endedAt ?? endT;
    const pairs: { li: number; pi: number; ov: number }[] = [];
    L.forEach((l, li) =>
      P.forEach((p, pi) => {
        const ov = overlap(p.startedAt, pEnd(p), l.start, l.end, tol);
        if (ov > 0) pairs.push({ li, pi, ov });
      }),
    );
    pairs.sort((a, b) => b.ov - a.ov);
    const lMatched = new Map<number, number>();
    const pMatched = new Set<number>();
    for (const pr of pairs) {
      if (lMatched.has(pr.li) || pMatched.has(pr.pi)) continue;
      lMatched.set(pr.li, pr.pi);
      pMatched.add(pr.pi);
    }
    const c: TraceTypeCounts = {
      tp: 0,
      fp: 0,
      fn: 0,
      duplicates: 0,
      latenciesSec: [],
      cleanMs: Math.max(0, monitoredMs - union(L.map((l) => [l.start, l.end]))),
      gt: L.filter((l) => !l.optional).length,
      pred: P.length,
      singleEventIssues: 0,
      fpEpisodes: [],
      fnLabels: [],
    };
    const perLabel = new Map<number, number>();
    L.forEach((l, li) => {
      const pi = lMatched.get(li);
      if (pi !== undefined) {
        perLabel.set(li, 1);
        if (!l.optional) {
          c.tp++;
          c.latenciesSec.push((P[pi].openedAt - l.start) / 1000);
        }
      } else if (!l.optional) {
        c.fn++;
        c.fnLabels.push({ start: l.start, end: l.end });
      }
    });
    P.forEach((p, pi) => {
      if (pMatched.has(pi)) return;
      const hits = pairs.filter((pr) => pr.pi === pi);
      const hitRequired = hits.find((h) => lMatched.has(h.li) && !L[h.li].optional);
      if (hitRequired) {
        c.duplicates++;
        perLabel.set(hitRequired.li, (perLabel.get(hitRequired.li) ?? 1) + 1);
        return;
      }
      if (hits.length > 0) return; // overlaps only optional / already-matched-optional labels
      c.fp++;
      c.fpEpisodes.push({ startedAt: p.startedAt, endedAt: p.endedAt, confidence: p.confidence });
    });
    L.forEach((l, li) => {
      if (!l.optional && perLabel.get(li) === 1) c.singleEventIssues++;
    });
    out.set(type, c);
  }
  return out;
}

export function emptyCounts(): TraceTypeCounts {
  return { tp: 0, fp: 0, fn: 0, duplicates: 0, latenciesSec: [], cleanMs: 0, gt: 0, pred: 0, singleEventIssues: 0, fpEpisodes: [], fnLabels: [] };
}

export function addCounts(into: TraceTypeCounts, c: TraceTypeCounts): void {
  into.tp += c.tp;
  into.fp += c.fp;
  into.fn += c.fn;
  into.duplicates += c.duplicates;
  into.latenciesSec.push(...c.latenciesSec);
  into.cleanMs += c.cleanMs;
  into.gt += c.gt;
  into.pred += c.pred;
  into.singleEventIssues += c.singleEventIssues;
  into.fpEpisodes.push(...c.fpEpisodes);
  into.fnLabels.push(...c.fnLabels);
}

export function finalizeMetrics(type: EventType, c: TraceTypeCounts): TypeMetrics {
  const precision = c.tp + c.fp > 0 ? c.tp / (c.tp + c.fp) : null;
  const recall = c.tp + c.fn > 0 ? c.tp / (c.tp + c.fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : precision === null && recall === null ? null : 0;
  const cleanHours = c.cleanMs / 3_600_000;
  return {
    type,
    gt: c.gt,
    pred: c.pred,
    tp: c.tp,
    fp: c.fp,
    fn: c.fn,
    duplicates: c.duplicates,
    precision: precision === null ? null : round(precision, 3),
    recall: recall === null ? null : round(recall, 3),
    f1: f1 === null ? null : round(f1, 3),
    cleanHours: round(cleanHours, 3),
    falseAlertsPerHour: cleanHours > 0 ? round(c.fp / cleanHours, 3) : 0,
    latencyMeanSec: c.latenciesSec.length ? round(mean(c.latenciesSec), 2) : null,
    latencyP95Sec: c.latenciesSec.length ? round(percentile(c.latenciesSec, 95), 2) : null,
    oneEventPerIssue: c.duplicates === 0 && c.singleEventIssues === c.tp,
  };
}

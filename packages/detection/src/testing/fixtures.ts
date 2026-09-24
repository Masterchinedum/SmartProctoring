/**
 * Test helpers (not exported from the package entry point): hand-built observations and a small driver
 * that feeds an engine at a fixed tick rate and collects everything it emits.
 */
import { DEFAULT_POLICY, type Baseline, type DetectionPolicy, type EngineSignal, type EpisodeUpdate, type EventType, type FaceObservation, type FrameMetrics, type FrameObservation } from '@sp/shared';
import { createMonitoringEngine, type EngineOptions, type MonitoringEngine } from '../engine/engine';
import { sequentialIdFactory } from '../util/id';

export const T0 = 1_700_000_000_000;
export const ms = (sec: number) => T0 + Math.round(sec * 1000);

export const BASELINE: Baseline = { yaw: 0, pitch: -5, cx: 0.5, cy: 0.45, faceWidth: 0.28, luma: 115, dhash: '0f0f0f0f0f0f0f0f', capturedAt: T0, samples: 20 };

export function face(over: Partial<FaceObservation> = {}): FaceObservation {
  return {
    box: { x: 0.36, y: 0.24, w: 0.28, h: 0.42 },
    score: 0.93,
    yaw: 0,
    pitch: -5,
    roll: 0,
    gazeX: 0,
    gazeY: -0.05,
    visibility: 0.95,
    cutOff: false,
    brightness: 125,
    ...over,
  };
}

export function secondFace(over: Partial<FaceObservation> = {}): FaceObservation {
  return face({ box: { x: 0.74, y: 0.18, w: 0.16, h: 0.24 }, score: 0.85, yaw: -12, ...over });
}

/** Live frame metrics; by default frame-to-frame noise (not frozen) and a stable dHash. */
export function frame(over: Partial<FrameMetrics> = {}): FrameMetrics {
  return { luma: 115, contrast: 48, sharpness: 160, dhash: '0f0f0f0f0f0f0f0f', diffFromPrev: 1.2, ...over };
}

export function policy(over: Partial<DetectionPolicy> = {}): DetectionPolicy {
  return { ...DEFAULT_POLICY.detection, ...over, enabled: { ...DEFAULT_POLICY.detection.enabled, ...(over.enabled ?? {}) } };
}

export interface Emitted {
  at: number;
  update: EpisodeUpdate;
}

export class Driver {
  readonly engine: MonitoringEngine;
  readonly updates: Emitted[] = [];
  readonly signals: { at: number; signal: EngineSignal }[] = [];
  t = 0;

  constructor(opts: Partial<EngineOptions> & { baseline?: Baseline | null } = {}) {
    this.engine = createMonitoringEngine({
      policy: opts.policy ?? policy(),
      identityIntervalSec: opts.identityIntervalSec ?? 30,
      identityStartupIntervalSec: opts.identityStartupIntervalSec,
      identityStartupWindowSec: opts.identityStartupWindowSec,
      evidence: opts.evidence ?? { maxScreenshotsPerEvent: 4, periodicScreenshotSec: 30 },
      baseline: opts.baseline === undefined ? BASELINE : opts.baseline,
      idFactory: opts.idFactory ?? sequentialIdFactory(),
      recalibrateOnCameraChange: opts.recalibrateOnCameraChange,
    });
  }

  /** Ingest one observation at `sec` (seconds from T0). */
  tick(sec: number, over: Partial<FrameObservation> = {}): { episodes: EpisodeUpdate[]; signals: EngineSignal[] } {
    this.t = sec;
    const o: FrameObservation = { t: ms(sec), camera: 'live', frame: frame(), faces: [face()], objects: null, fps: 5, ...over };
    const out = this.engine.ingest(o);
    for (const u of out.episodes) this.updates.push({ at: o.t, update: u });
    for (const s of out.signals) this.signals.push({ at: o.t, signal: s });
    return out;
  }

  /**
   * Feed ticks at `fps` for [from, to) seconds. `fn(sec, i)` returns overrides per tick; objects run at
   * 1 Hz unless `fn` sets `objects` explicitly.
   */
  run(from: number, to: number, fn: (sec: number, i: number) => Partial<FrameObservation> = () => ({}), fps = 5): void {
    const n = Math.round((to - from) * fps);
    for (let i = 0; i < n; i++) {
      const sec = Math.round((from + i / fps) * 1000) / 1000;
      this.tick(sec, fn(sec, i));
    }
  }

  cameraInfo(sec: number, label: string, deviceIdHash: string) {
    const out = this.engine.setCameraInfo({ label, deviceIdHash }, ms(sec));
    for (const u of out.episodes) this.updates.push({ at: ms(sec), update: u });
    for (const s of out.signals) this.signals.push({ at: ms(sec), signal: s });
    return out;
  }

  flush(sec: number, reason: 'pause' | 'submit' | 'hold' | 'stop' = 'stop') {
    const out = this.engine.flush(ms(sec), reason);
    for (const u of out.episodes) this.updates.push({ at: ms(sec), update: u });
    for (const s of out.signals) this.signals.push({ at: ms(sec), signal: s });
    return out;
  }

  of(type: EventType): EpisodeUpdate[] {
    return this.updates.filter((u) => u.update.type === type).map((u) => u.update);
  }

  /** Distinct episode ids of a type. */
  ids(type: EventType): string[] {
    return [...new Set(this.of(type).map((u) => u.episodeId))];
  }

  /** Latest version of each episode of a type. */
  final(type: EventType): EpisodeUpdate[] {
    const m = new Map<string, EpisodeUpdate>();
    for (const u of this.of(type)) {
      const p = m.get(u.episodeId);
      if (!p || u.version > p.version) m.set(u.episodeId, u);
    }
    return [...m.values()];
  }

  openedAt(type: EventType): number | null {
    const e = this.updates.find((u) => u.update.type === type && u.update.phase === 'open');
    return e ? (e.at - T0) / 1000 : null;
  }

  identity(trigger?: string): { at: number; trigger: string }[] {
    return this.signals
      .filter((s) => s.signal.kind === 'identity_sample' && (!trigger || (s.signal as { trigger: string }).trigger === trigger))
      .map((s) => ({ at: (s.at - T0) / 1000, trigger: (s.signal as { trigger: string }).trigger }));
  }

  prompts(key: string): { at: number; kind: string }[] {
    return this.signals
      .filter((s) => (s.signal.kind === 'candidate_prompt' || s.signal.kind === 'candidate_prompt_clear') && s.signal.key === key)
      .map((s) => ({ at: (s.at - T0) / 1000, kind: s.signal.kind }));
  }
}

/** Seconds from T0. */
export const rel = (t: number | null) => (t === null ? null : (t - T0) / 1000);


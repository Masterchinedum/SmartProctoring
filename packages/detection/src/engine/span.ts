import type { EventType } from '@sp/shared';
import { Debouncer, type DebounceParams } from './debounce';
import type { DetectorHost } from './context';
import type { EpisodeData } from './episodes';

export type FlushReason = 'pause' | 'submit' | 'hold' | 'stop';

export interface DescribeInput {
  phase: 'open' | 'update' | 'close';
  t: number;
  /** Episode start (original start when merged). */
  startedAt: number;
  endedAt: number | null;
  durationSec: number;
  confidence: number;
  /** Set when closed by flush(). */
  closedBy?: FlushReason;
}

export interface Description {
  details: Record<string, unknown>;
  observation: string;
  /** Override the debouncer-derived confidence. */
  confidence?: number;
}

export interface SpanHooks {
  /** Build details + observation (called only when an update is actually emitted). */
  describe(d: DescribeInput): Description;
  /** Cheap key; when it changes a (throttled) 'update' is emitted. */
  material?(): string;
}

/** A peak snapshot request is honoured only if it can be taken within this time. */
const PEAK_TTL_MS = 2000;

/**
 * A debounced condition bound to one episode slot: onset → begin (or merge into the previous episode),
 * while active → throttled touch, clear → end. Detectors supply hooks that turn their statistics into
 * details and an observation sentence.
 */
export class Span {
  readonly deb: Debouncer;
  epStart: number | null = null;
  private peakAt = -Infinity;
  /** Called after onset with whether the episode merged into the previous one. */
  onBegin: ((merged: boolean, t: number) => void) | null = null;
  onEnd: ((endedAt: number, t: number, closedBy?: FlushReason) => void) | null = null;

  constructor(
    private host: DetectorHost,
    readonly type: EventType,
    readonly key: string,
    params: DebounceParams,
    private hooks: SpanHooks,
  ) {
    this.deb = new Debouncer(params);
  }

  get active(): boolean {
    return this.deb.active;
  }

  /** Ask for an evidence snapshot at the next touch (e.g. more people appeared). */
  requestPeak(t: number): void {
    this.peakAt = t;
  }

  /** Feed one tick. Returns 'onset' / 'clear' on transitions. */
  feed(t: number, v: boolean | null, score = 1): 'onset' | 'clear' | null {
    const ev = this.deb.step(t, v, score);
    if (ev?.kind === 'onset') {
      this.begin(ev.startedAt, t);
      return 'onset';
    }
    if (ev?.kind === 'clear') {
      this.end(ev.endedAt, t);
      return 'clear';
    }
    if (this.deb.active) this.touch(t);
    return null;
  }

  /** Clear an active sparse span that has not been fed for `maxSilenceMs`. */
  expire(t: number, maxSilenceMs: number): boolean {
    const ev = this.deb.expire(t, maxSilenceMs);
    if (ev?.kind === 'clear') {
      this.end(ev.endedAt, t);
      return true;
    }
    return false;
  }

  touch(t: number): void {
    if (this.epStart === null || !this.host.book.isOpen(this.key)) return;
    const start = this.epStart;
    const peak = t - this.peakAt <= PEAK_TTL_MS;
    const u = this.host.book.touch(this.key, t, this.hooks.material?.() ?? '', () => this.data(this.hooks.describe(this.input('update', t, start, null)), t), { peak });
    if (u) {
      if (u.captureSnapshot === 'peak') this.peakAt = -Infinity;
      this.host.episodes.push(u);
    }
  }

  flush(t: number, reason: FlushReason): void {
    if (this.deb.active && this.host.book.isOpen(this.key)) this.end(this.deb.firstOff ?? t, t, reason);
    this.deb.reset();
    this.peakAt = -Infinity;
  }

  reset(): void {
    this.deb.reset();
    this.epStart = null;
    this.peakAt = -Infinity;
  }

  private begin(startedAt: number, t: number): void {
    const merging = this.host.book.wouldMerge(this.key, startedAt);
    const start = merging && this.epStart !== null ? this.epStart : startedAt;
    const d = this.hooks.describe(this.input('open', t, start, null));
    const { update, merged } = this.host.book.begin(this.key, this.type, startedAt, t, this.data(d, t), this.hooks.material?.() ?? '');
    this.epStart = update.startedAt;
    this.host.episodes.push(update);
    this.onBegin?.(merged, t);
  }

  private end(endedAt: number, t: number, closedBy?: FlushReason): void {
    if (this.epStart === null || !this.host.book.isOpen(this.key)) return;
    const d = this.hooks.describe(this.input('close', t, this.epStart, endedAt, closedBy));
    const details = closedBy ? { ...d.details, closedBy } : d.details;
    const u = this.host.book.end(this.key, endedAt, t, this.data({ ...d, details }, t));
    if (u) this.host.episodes.push(u);
    this.onEnd?.(endedAt, t, closedBy);
  }

  private input(phase: DescribeInput['phase'], t: number, startedAt: number, endedAt: number | null, closedBy?: FlushReason): DescribeInput {
    const until = endedAt ?? t;
    return {
      phase,
      t,
      startedAt,
      endedAt,
      durationSec: Math.max(0, Math.round((until - startedAt) / 100) / 10),
      confidence: this.deb.confidence(t),
      closedBy,
    };
  }

  private data(d: Description, t: number): EpisodeData {
    return { confidence: d.confidence ?? this.deb.confidence(t), details: d.details, observation: d.observation };
  }
}

/** Duration phrase for observation sentences, e.g. "12 s", "3 min 05 s", "1 h 04 min". */
export function dur(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m > 0) return `${m} min ${String(s).padStart(2, '0')} s`;
  return `${s} s`;
}

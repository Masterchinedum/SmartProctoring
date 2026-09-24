import type { Baseline, EpisodeUpdate, FrameObservation } from '@sp/shared';

/**
 * Trace recorder for accuracy evaluation (enabled with `?trace=1`).
 *
 * Records exactly what the monitoring runtime passed to the engine, in the JSONL format the detection
 * evaluation harness replays unchanged (packages/detection/src/eval/runner.ts, docs/accuracy/detection.md §7):
 *   {"$":"meta", …}                                      first line: format, start time, user agent (ignored by replay)
 *   FrameObservation                                     one per engine.ingest()
 *   {"$":"camera","t":…,"label":"…","deviceIdHash":"…"}  engine.setCameraInfo()
 *   {"$":"baseline","baseline":{…}}                      engine.setBaseline()
 *   {"$":"flush","t":…,"reason":"pause"|"submit"|"hold"|"stop"}  engine.flush()
 *   {"$":"meta","kind":"episode","episode":{…}}           what the live engine reported (for comparison; ignored by replay)
 * Observations contain only numbers derived from the camera (face boxes, pose, frame statistics) — no images.
 * The file is kept in memory (bounded) and downloaded by the candidate; nothing is uploaded.
 */

export const TRACE_FORMAT = 'sp-trace/1';

type TraceLine =
  | FrameObservation
  | { $: 'camera'; t: number; label: string; deviceIdHash: string }
  | { $: 'baseline'; baseline: Baseline }
  | { $: 'flush'; t: number; reason: 'pause' | 'submit' | 'hold' | 'stop' }
  | { $: 'meta'; kind: 'episode'; episode: EpisodeUpdate }
  | { $: 'meta'; kind: 'marker'; t: number; label: string; data?: Record<string, unknown> };

export function traceEnabled(search: string = typeof window !== 'undefined' ? window.location.search : ''): boolean {
  const v = new URLSearchParams(search).get('trace');
  return v === '1' || v === 'true';
}

export class TraceRecorder {
  private lines: TraceLine[] = [];
  private dropped = 0;
  private obsCount = 0;
  private readonly startedAt = Date.now();

  constructor(
    private readonly meta: Record<string, unknown> = {},
    private readonly maxLines = 40_000,
  ) {}

  private push(line: TraceLine): void {
    this.lines.push(line);
    if ('camera' in line && !('$' in line)) this.obsCount++;
    if (this.lines.length > this.maxLines) {
      const drop = this.lines.length - this.maxLines;
      for (const l of this.lines.slice(0, drop)) if (!('$' in l)) this.obsCount--;
      this.lines.splice(0, drop);
      this.dropped += drop;
    }
  }

  observation(obs: FrameObservation): void {
    this.push(obs);
  }

  camera(t: number, label: string, deviceIdHash: string): void {
    this.push({ $: 'camera', t, label, deviceIdHash });
  }

  baseline(baseline: Baseline): void {
    this.push({ $: 'baseline', baseline });
  }

  flush(t: number, reason: 'pause' | 'submit' | 'hold' | 'stop'): void {
    this.push({ $: 'flush', t, reason });
  }

  episode(episode: EpisodeUpdate): void {
    this.push({ $: 'meta', kind: 'episode', episode });
  }

  marker(t: number, label: string, data?: Record<string, unknown>): void {
    this.push({ $: 'meta', kind: 'marker', t, label, data });
  }

  get size(): number {
    return this.lines.length;
  }

  get observationCount(): number {
    return this.obsCount;
  }

  toJsonl(): string {
    const head = {
      $: 'meta',
      format: TRACE_FORMAT,
      startedAt: this.startedAt,
      exportedAt: Date.now(),
      droppedLines: this.dropped,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      ...this.meta,
    };
    return [JSON.stringify(head), ...this.lines.map((l) => JSON.stringify(l))].join('\n') + '\n';
  }

  download(filename = `trace-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`): void {
    const blob = new Blob([this.toJsonl()], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

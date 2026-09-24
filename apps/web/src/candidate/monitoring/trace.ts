import type { EpisodeUpdate, FrameObservation } from '@sp/shared';

/**
 * Trace recorder for accuracy evaluation (enabled with `?trace=1`).
 *
 * Keeps the most recent FrameObservations (bounded ring) plus the episodes the engine produced, and
 * exports them as JSONL so real sessions can be labelled and replayed through the detection
 * evaluation harness (see docs/accuracy/detection.md). Observations contain only numbers derived
 * from the camera (face boxes, pose, frame statistics) — no images.
 *
 * Line format:
 *   {"kind":"meta", ...}                  first line: format version, start time, user agent, fps target
 *   {"kind":"obs","obs":FrameObservation}  one per analysed tick
 *   {"kind":"episode","episode":EpisodeUpdate}
 *   {"kind":"marker","t":…,"label":"…"}    lifecycle markers (monitoring start/stop, camera change)
 */

export const TRACE_FORMAT = 'sp-trace/1';

type TraceLine =
  | { kind: 'obs'; obs: FrameObservation }
  | { kind: 'episode'; episode: EpisodeUpdate }
  | { kind: 'marker'; t: number; label: string; data?: Record<string, unknown> };

export function traceEnabled(search: string = typeof window !== 'undefined' ? window.location.search : ''): boolean {
  const v = new URLSearchParams(search).get('trace');
  return v === '1' || v === 'true';
}

export class TraceRecorder {
  private lines: TraceLine[] = [];
  private dropped = 0;
  private readonly startedAt = Date.now();

  constructor(
    private readonly meta: Record<string, unknown> = {},
    private readonly maxLines = 40_000,
  ) {}

  private push(line: TraceLine): void {
    this.lines.push(line);
    if (this.lines.length > this.maxLines) {
      const drop = this.lines.length - this.maxLines;
      this.lines.splice(0, drop);
      this.dropped += drop;
    }
  }

  observation(obs: FrameObservation): void {
    this.push({ kind: 'obs', obs });
  }

  episode(ep: EpisodeUpdate): void {
    this.push({ kind: 'episode', episode: ep });
  }

  marker(t: number, label: string, data?: Record<string, unknown>): void {
    this.push({ kind: 'marker', t, label, data });
  }

  get size(): number {
    return this.lines.length;
  }

  get observationCount(): number {
    let n = 0;
    for (const l of this.lines) if (l.kind === 'obs') n++;
    return n;
  }

  toJsonl(): string {
    const head = {
      kind: 'meta',
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

/**
 * Per-instance overload signal for operators (docs/PERFORMANCE.md "When to add instances").
 *
 * Every `intervalMs` it samples the event-loop delay, the Postgres pool queue and the vision queue; when one of
 * them is over its threshold it logs ONE warning per `warnEveryMs` with the numbers, e.g.
 *   {"loadMonitor":{"eventLoopP99Ms":312,"dbWaiting":14,"visionQueued":180,...},"msg":"server overloaded ..."}
 * Sustained warnings mean this instance is at its knee: add an instance (Redis + load balancer) or CPU.
 */
import { monitorEventLoopDelay, performance, type IntervalHistogram } from 'node:perf_hooks';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';

export interface LoadSnapshot {
  eventLoopP99Ms: number;
  eventLoopMaxMs: number;
  /** Share of wall time the event loop was busy (0..1). */
  eventLoopUtilization: number;
  dbTotal: number;
  dbIdle: number;
  dbWaiting: number;
  visionInFlight: number | null;
  visionQueued: number | null;
  visionWorkers: number | null;
}

export interface LoadMonitorOptions {
  pool: pg.Pool;
  vision: unknown;
  log: FastifyBaseLogger;
  intervalMs?: number;
  warnEveryMs?: number;
  thresholds?: { eventLoopP99Ms?: number; dbWaiting?: number; visionQueuedPerWorker?: number };
}

type VisionStatsLike = { stats?: { inFlight?: number; queued?: number; workers?: number } };

export class LoadMonitor {
  private readonly hist: IntervalHistogram;
  private timer: NodeJS.Timeout | null = null;
  private lastElu = performance.eventLoopUtilization();
  private lastWarnAt = 0;
  private last: LoadSnapshot | null = null;

  constructor(private readonly o: LoadMonitorOptions) {
    this.hist = monitorEventLoopDelay({ resolution: 20 });
  }

  start(): void {
    if (this.timer) return;
    this.hist.enable();
    this.timer = setInterval(() => this.tick(), this.o.intervalMs ?? 10_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.hist.disable();
  }

  /** The last sample (null before the first interval). */
  get snapshot(): LoadSnapshot | null {
    return this.last;
  }

  /** @internal exported for tests */
  sample(): LoadSnapshot {
    const elu = performance.eventLoopUtilization(this.lastElu);
    this.lastElu = performance.eventLoopUtilization();
    const v = (this.o.vision as VisionStatsLike | null)?.stats;
    const snap: LoadSnapshot = {
      eventLoopP99Ms: Math.round(this.hist.percentile(99) / 1e6),
      eventLoopMaxMs: Math.round(this.hist.max / 1e6),
      eventLoopUtilization: Math.round(elu.utilization * 100) / 100,
      dbTotal: this.o.pool.totalCount,
      dbIdle: this.o.pool.idleCount,
      dbWaiting: this.o.pool.waitingCount,
      visionInFlight: v?.inFlight ?? null,
      visionQueued: v?.queued ?? null,
      visionWorkers: v?.workers ?? null,
    };
    this.hist.reset();
    this.last = snap;
    return snap;
  }

  /** Which thresholds the snapshot exceeds. */
  overloaded(s: LoadSnapshot): string[] {
    const t = this.o.thresholds ?? {};
    const out: string[] = [];
    if (s.eventLoopP99Ms > (t.eventLoopP99Ms ?? 200)) out.push('event loop lagging');
    if (s.dbWaiting > (t.dbWaiting ?? 5)) out.push('database pool exhausted');
    if (s.visionQueued != null && s.visionQueued > (t.visionQueuedPerWorker ?? 20) * Math.max(1, s.visionWorkers ?? 1)) out.push('face analysis queue long');
    return out;
  }

  private tick(): void {
    const s = this.sample();
    const why = this.overloaded(s);
    const now = Date.now();
    if (why.length && now - this.lastWarnAt >= (this.o.warnEveryMs ?? 60_000)) {
      this.lastWarnAt = now;
      this.o.log.warn({ loadMonitor: s }, `server overloaded (${why.join(', ')}): requests are queuing; see docs/PERFORMANCE.md (add an instance or CPU)`);
    }
  }
}

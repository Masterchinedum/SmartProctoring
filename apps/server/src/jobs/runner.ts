/**
 * Periodic background jobs. Each job run is guarded by a Postgres advisory lock, so with several server
 * instances only one runs a given job at a time. Jobs only run when background jobs are enabled
 * (config.sweeperEnabled / buildApp({ jobs })).
 *
 * Register from any plugin before the app is ready:
 *   app.ctx.jobs.register({ name: 'retention', intervalMs: 3_600_000, run: (ctx) => runRetention(ctx) });
 */
import type { Ctx } from '../context.js';

export interface JobDefinition {
  name: string;
  intervalMs: number;
  /** Run once shortly after start-up (default true). */
  runAtStart?: boolean;
  run(ctx: Ctx): Promise<unknown>;
}

function lockIdFor(name: string): number {
  let h = 0x2d1f;
  for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) | 0;
  return 727_000_000 + (Math.abs(h) % 1_000_000);
}

export class JobRunner {
  private readonly jobs: JobDefinition[] = [];
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly inFlight = new Map<string, Promise<void>>();
  private started = false;
  private stopped = false;

  constructor(private readonly ctx: Ctx) {}

  register(job: JobDefinition): void {
    if (this.jobs.some((j) => j.name === job.name)) throw new Error(`Job ${job.name} already registered`);
    this.jobs.push(job);
    if (this.started) this.schedule(job);
  }

  list(): string[] {
    return this.jobs.map((j) => j.name);
  }

  /** True once start() was called (background jobs enabled) and until stop(). */
  get isStarted(): boolean {
    return this.started && !this.stopped;
  }

  /** Run a job now (respecting the lock). Returns false if another instance holds the lock. */
  async runNow(name: string): Promise<boolean> {
    const job = this.jobs.find((j) => j.name === name);
    if (!job) throw new Error(`Unknown job ${name}`);
    return this.execute(job);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const j of this.jobs) this.schedule(j);
  }

  private schedule(job: JobDefinition) {
    const t = setInterval(() => void this.execute(job), job.intervalMs);
    t.unref?.();
    this.timers.push(t);
    if (job.runAtStart !== false) {
      const first = setTimeout(() => void this.execute(job), 2_000 + Math.floor(Math.random() * 2_000));
      first.unref?.();
      this.timers.push(first);
    }
  }

  private async execute(job: JobDefinition): Promise<boolean> {
    if (this.stopped) return false;
    if (this.inFlight.has(job.name)) return false;
    let ran = false;
    const p = (async () => {
      const client = await this.ctx.database.pool.connect();
      const lock = lockIdFor(job.name);
      try {
        const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [lock]);
        if (!rows[0]?.ok) return;
        try {
          ran = true;
          await job.run(this.ctx);
        } finally {
          await client.query('SELECT pg_advisory_unlock($1)', [lock]);
        }
      } catch (err) {
        this.ctx.log.error({ err, job: job.name }, 'background job failed');
      } finally {
        client.release();
      }
    })();
    this.inFlight.set(job.name, p);
    try {
      await p;
    } finally {
      this.inFlight.delete(job.name);
    }
    return ran;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    await Promise.allSettled([...this.inFlight.values()]);
  }
}

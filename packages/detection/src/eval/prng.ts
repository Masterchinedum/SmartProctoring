/** Deterministic PRNG (mulberry32) with a few distributions, so evaluation runs are reproducible. */
export class Rng {
  private s: number;
  private spare: number | null = null;

  constructor(seed: number) {
    this.s = (seed >>> 0) ^ 0x9e3779b9;
    for (let i = 0; i < 4; i++) this.next();
  }

  /** Uniform [0, 1). */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  int(lo: number, hiInclusive: number): number {
    return Math.floor(this.range(lo, hiInclusive + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /** Standard normal (Box–Muller). */
  gauss(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    while (u <= Number.EPSILON) u = this.next();
    v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }

  normal(mean: number, std: number): number {
    return mean + std * this.gauss();
  }

  /** Poisson-process event: probability of ≥1 event in dt seconds at `perMin` events per minute. */
  poisson(perMin: number, dtSec: number): boolean {
    return this.chance(1 - Math.exp(-(perMin / 60) * dtSec));
  }
}

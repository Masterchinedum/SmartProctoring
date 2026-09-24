/** Small numeric helpers shared by the engine, calibrator and eval harness. Pure, allocation-light. */

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Median of a numeric array (does not mutate the input). Returns NaN for an empty array. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Median absolute deviation (unscaled). */
export function mad(values: readonly number[], center = median(values)): number {
  if (values.length === 0) return NaN;
  return median(values.map((v) => Math.abs(v - center)));
}

/** Linear-interpolated percentile, p in 0..100. NaN for an empty array. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const idx = clamp((p / 100) * (s.length - 1), 0, s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

export function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Seconds (rounded to 0.1) between two epoch-ms timestamps. */
export function secs(fromMs: number, toMs: number): number {
  return Math.round((toMs - fromMs) / 100) / 10;
}

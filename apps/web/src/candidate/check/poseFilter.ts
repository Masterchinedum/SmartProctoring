/**
 * Noise-adaptive smoothing of the head pose that drives the liveness tracker.
 *
 * Why: the in-browser face model's yaw is steady in good light (±1–2° frame to frame on a still head) but jumps by
 * ±8° in a dim room (webcam noise; measured on realistic webcam video, docs/accuracy/end-to-end.md). The liveness
 * tracker captures a step frame only when the head has STOPPED at the PEAK of the turn (offset range ≤ 4° over
 * 300 ms, within 3° of the largest offset of the last second). On raw dim-light poses that almost never happens:
 * the candidate holds a correct turn, no step frame is sent, and the attempt stalls or the challenge expires.
 *
 * The filter keeps a short history of the tracked face's pose and returns the MEDIAN over a window whose length
 * follows the measured pose noise: ~250 ms (practically raw) when the pose is steady, up to ~1 s when it is
 * jittery. The noise estimate is the median absolute frame-to-frame yaw change over the last ~20 frames, so a
 * genuine turn (a few frames of large change) does not inflate it. The server measures every uploaded frame
 * itself; smoothing only decides WHEN the client captures.
 */
export interface SmoothedPose {
  yaw: number;
  pitch: number;
  /** Current noise estimate (deg per frame) and the window used (ms), for diagnostics. */
  noiseDeg: number;
  windowMs: number;
}

export interface PoseSmootherOptions {
  /** Window when the pose is steady / very noisy (ms). */
  minWindowMs?: number;
  maxWindowMs?: number;
  /** Noise (median |Δyaw| per frame, deg) at or below which the minimum window is used, and at or above which the maximum is. */
  quietDeg?: number;
  noisyDeg?: number;
  /** Frame-to-frame changes remembered for the noise estimate. */
  noiseFrames?: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export class PoseSmoother {
  private readonly o: Required<PoseSmootherOptions>;
  private buf: { t: number; yaw: number; pitch: number }[] = [];
  private diffs: number[] = [];
  private last: { t: number; yaw: number } | null = null;

  constructor(opts: PoseSmootherOptions = {}) {
    this.o = { minWindowMs: 250, maxWindowMs: 1000, quietDeg: 2, noisyDeg: 6, noiseFrames: 20, ...opts };
  }

  /** The face was lost (or more than one face): start the window afresh (the noise estimate is kept). */
  reset(): void {
    this.buf = [];
    this.last = null;
  }

  /** Current noise estimate: median absolute frame-to-frame yaw change (deg); 0 before enough frames. */
  noise(): number {
    return this.diffs.length >= 4 ? median(this.diffs) : 0;
  }

  windowMs(): number {
    const { minWindowMs, maxWindowMs, quietDeg, noisyDeg } = this.o;
    const n = this.noise();
    const u = Math.max(0, Math.min(1, (n - quietDeg) / Math.max(1e-6, noisyDeg - quietDeg)));
    return minWindowMs + u * (maxWindowMs - minWindowMs);
  }

  /** Add the pose of analysed frame at time `t` (ms) and return the smoothed pose. */
  push(t: number, yaw: number, pitch: number): SmoothedPose {
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return { yaw, pitch, noiseDeg: this.noise(), windowMs: this.windowMs() };
    if (this.last && t > this.last.t && t - this.last.t < 1000) {
      this.diffs.push(Math.abs(yaw - this.last.yaw));
      if (this.diffs.length > this.o.noiseFrames) this.diffs.shift();
    }
    this.last = { t, yaw };
    this.buf.push({ t, yaw, pitch });
    const w = this.windowMs();
    while (this.buf.length > 1 && this.buf[0]!.t < t - w) this.buf.shift();
    return { yaw: median(this.buf.map((b) => b.yaw)), pitch: median(this.buf.map((b) => b.pitch)), noiseDeg: this.noise(), windowMs: w };
  }
}

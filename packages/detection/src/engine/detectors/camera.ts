import type { CameraState, EventType } from '@sp/shared';
import { Hysteresis } from '../debounce';
import { K, type DetectorHost, type TickContext } from '../context';
import { dur, Span, type FlushReason } from '../span';
import { round } from '../../util/math';

type NonLive = 'disconnected' | 'permission';

function nonLiveKind(c: CameraState): NonLive | null {
  if (c === 'live') return null;
  return c === 'no_permission' ? 'permission' : 'disconnected';
}

const TYPE: Record<NonLive, EventType> = { disconnected: 'camera_disconnected', permission: 'camera_permission_lost' };

/**
 * camera_disconnected ('ended' / 'muted' / 'unavailable' ≥ 2 s) and camera_permission_lost
 * ('no_permission' ≥ 1 s). Closed immediately when the camera is live again; a non-live period ≥ 1 s
 * arms a 'camera_reconnect' identity sample. Robust to sparse ticks: if the host only reports the
 * state change and the recovery, an episode ≥ onset is still emitted (open + close together).
 */
export class CameraStateDetector {
  private kind: NonLive | null = null;
  private since: number | null = null;
  private nonLiveSince: number | null = null;
  private states = new Set<CameraState>();
  private openKind: NonLive | null = null;

  constructor(private host: DetectorHost) {}

  /** Returns true when the camera just came back after a non-live period (frame state should reset). */
  step(ctx: TickContext): boolean {
    const t = ctx.t;
    const k = nonLiveKind(ctx.camera);
    let restarted = false;
    if (k !== this.kind) {
      if (this.kind !== null && this.since !== null) this.finish(this.kind, this.since, t);
      if (k === null) {
        if (this.nonLiveSince !== null && t - this.nonLiveSince >= K.reconnectSampleMinMs) this.host.identity.arm('camera_reconnect');
        restarted = this.nonLiveSince !== null;
        this.nonLiveSince = null;
      } else if (this.nonLiveSince === null) this.nonLiveSince = t;
      this.kind = k;
      this.since = k ? t : null;
      this.states.clear();
    }
    if (k !== null && this.since !== null) {
      this.states.add(ctx.camera);
      if (this.openKind === null && t - this.since >= this.onset(k)) this.open(k, this.since, t);
    }
    return restarted;
  }

  /** Whether the camera has been non-live (any duration). */
  get nonLive(): boolean {
    return this.kind !== null;
  }

  label(t: number): string | null {
    if (this.kind === null) return null;
    const s = this.since !== null ? Math.round((t - this.since) / 1000) : 0;
    return this.kind === 'permission' ? `Camera permission lost (${s} s)` : `Camera not delivering video (${s} s)`;
  }

  flush(t: number, reason: FlushReason): void {
    if (this.openKind !== null) {
      const u = this.host.book.end(TYPE[this.openKind], t, t, this.data(this.openKind, this.since ?? t, t, true, reason));
      if (u) this.host.episodes.push(u);
      this.openKind = null;
    }
    this.reset();
  }

  reset(): void {
    this.kind = null;
    this.since = null;
    this.nonLiveSince = null;
    this.openKind = null;
    this.states.clear();
  }

  private onset(k: NonLive): number {
    return k === 'permission' ? K.permissionOnsetMs : K.disconnectOnsetMs;
  }

  private open(k: NonLive, since: number, t: number): void {
    const { update } = this.host.book.begin(TYPE[k], TYPE[k], since, t, this.data(k, since, t, false));
    this.host.episodes.push(update);
    this.openKind = k;
  }

  private finish(k: NonLive, since: number, t: number): void {
    if (this.openKind !== k && t - since >= this.onset(k)) this.open(k, since, t);
    if (this.openKind === k) {
      const u = this.host.book.end(TYPE[k], t, t, this.data(k, since, t, true));
      if (u) this.host.episodes.push(u);
      this.openKind = null;
    }
  }

  private data(k: NonLive, since: number, t: number, closed: boolean, closedBy?: FlushReason) {
    const d = Math.round((t - since) / 100) / 10;
    const details: Record<string, unknown> = { cameraStates: [...this.states], durationSec: d };
    if (closedBy) details.closedBy = closedBy;
    const observation =
      k === 'permission'
        ? closed
          ? `The browser did not allow camera access for ${dur(d)}.`
          : 'The browser no longer allows the exam to use the camera.'
        : closed
          ? `The camera stopped delivering video for ${dur(d)}.`
          : 'The camera stopped delivering video.';
    return { confidence: 1, details, observation };
  }
}

/** camera_covered: whole frame very dark and flat (or near-uniform) for ≥ coveredSec. */
export class CoveredDetector {
  readonly span: Span;
  private prompt = new Hysteresis(1500, 1000);
  private minLuma = Infinity;
  private maxContrast = 0;

  constructor(private host: DetectorHost) {
    const p = host.policy;
    this.span = new Span(host, 'camera_covered', 'camera_covered', { onsetMs: p.coveredSec * 1000, clearMs: p.clearSec * 1000, minFraction: 0.7, gapTolMs: 800, minTicks: 3 }, {
      describe: (d) => ({
        details: { durationSec: d.durationSec, minLuma: round(this.minLuma, 1), maxContrast: round(this.maxContrast, 1) },
        observation:
          d.phase === 'close'
            ? `The camera image was almost completely dark or uniform for ${dur(d.durationSec)}, as if the lens was covered.`
            : 'The camera image is almost completely dark or uniform, as if the lens is covered.',
      }),
    });
    this.span.onEnd = (_e, _t, closedBy) => {
      if (!closedBy) host.identity.arm('after_obstruction');
    };
  }

  step(ctx: TickContext): void {
    const v = ctx.live && ctx.frame ? ctx.covered : null;
    if (v && ctx.frame) {
      if (this.span.deb.idle) {
        this.minLuma = Infinity;
        this.maxContrast = 0;
      }
      this.minLuma = Math.min(this.minLuma, ctx.frame.luma);
      this.maxContrast = Math.max(this.maxContrast, ctx.frame.contrast);
    }
    this.span.feed(ctx.t, v, 1);
    const ch = this.prompt.step(ctx.t, v);
    if (ch) this.host.prompts.set('camera_covered', ch === 'on', this.host.signals);
  }

  get active(): boolean {
    return this.span.active;
  }

  flush(t: number, reason: FlushReason): void {
    this.span.flush(t, reason);
    this.reset();
  }

  reset(): void {
    this.span.reset();
    this.prompt.reset();
    this.minLuma = Infinity;
    this.maxContrast = 0;
  }
}

/** camera_frozen: frame difference ≈ 0 and identical dHash for ≥ frozenSec while live. */
export class FrozenDetector {
  readonly span: Span;

  constructor(private host: DetectorHost) {
    const p = host.policy;
    this.span = new Span(host, 'camera_frozen', 'camera_frozen', { onsetMs: p.frozenSec * 1000, clearMs: p.clearSec * 1000, minFraction: 0.8, gapTolMs: 600, minTicks: 5 }, {
      describe: (d) => ({
        details: { durationSec: d.durationSec },
        observation: d.phase === 'close' ? `The camera image did not change for ${dur(d.durationSec)}.` : 'The camera image has stopped changing, as if frozen.',
      }),
    });
    this.span.onBegin = () => host.prompts.set('camera_frozen', true, host.signals);
    this.span.onEnd = () => host.prompts.set('camera_frozen', false, host.signals);
  }

  step(ctx: TickContext): void {
    const v = ctx.live && ctx.frame && ctx.frame.diffFromPrev != null && !ctx.covered ? ctx.frozenRaw : null;
    this.span.feed(ctx.t, v, 1);
  }

  get active(): boolean {
    return this.span.active;
  }

  flush(t: number, reason: FlushReason): void {
    this.span.flush(t, reason);
    this.host.prompts.set('camera_frozen', false, this.host.signals);
    this.span.reset();
  }

  reset(): void {
    this.span.reset();
  }
}

/** lighting_unusable: frame luma < 35 / > 225 or face brightness < 40 / > 235 for ≥ lightingSec. */
export class LightingDetector {
  readonly span: Span;
  private darkPrompt = new Hysteresis(3000, 2000);
  private brightPrompt = new Hysteresis(3000, 2000);
  private dark = 0;
  private bright = 0;
  private lumaSum = 0;
  private lumaN = 0;
  private faceSum = 0;
  private faceN = 0;

  constructor(private host: DetectorHost) {
    const p = host.policy;
    this.span = new Span(host, 'lighting_unusable', 'lighting_unusable', { onsetMs: p.lightingSec * 1000, clearMs: p.clearSec * 1000, minFraction: 0.7, gapTolMs: 1500, minTicks: 5 }, {
      material: () => this.condition(),
      describe: (d) => {
        const cond = this.condition();
        const luma = this.lumaN ? round(this.lumaSum / this.lumaN, 1) : null;
        const face = this.faceN ? round(this.faceSum / this.faceN, 1) : null;
        const what = cond === 'too_bright' ? 'too bright' : 'too dark';
        return {
          details: { durationSec: d.durationSec, condition: cond, meanFrameLuma: luma, meanFaceBrightness: face },
          observation:
            d.phase === 'close'
              ? `The image was ${what} for dependable monitoring for ${dur(d.durationSec)}.`
              : `The image is ${what} for dependable monitoring.`,
        };
      },
    });
  }

  step(ctx: TickContext): void {
    const v = ctx.live && ctx.frame && !ctx.covered ? ctx.lightingBad : null;
    if (v && ctx.frame) {
      if (this.span.deb.idle) this.resetStats();
      const isDark = ctx.frameDark || ctx.faceDark;
      if (isDark) this.dark++;
      else this.bright++;
      this.lumaSum += ctx.frame.luma;
      this.lumaN++;
      const fb = ctx.primary?.brightness;
      if (typeof fb === 'number' && Number.isFinite(fb)) {
        this.faceSum += fb;
        this.faceN++;
      }
    }
    this.span.feed(ctx.t, v, 1);
    const darkNow = v === null ? null : ctx.frameDark || ctx.faceDark;
    const brightNow = v === null ? null : (ctx.frameBright || ctx.faceBright) && !(ctx.frameDark || ctx.faceDark);
    const a = this.darkPrompt.step(ctx.t, darkNow);
    if (a) this.host.prompts.set('too_dark', a === 'on', this.host.signals);
    const b = this.brightPrompt.step(ctx.t, brightNow);
    if (b) this.host.prompts.set('too_bright', b === 'on', this.host.signals);
  }

  get active(): boolean {
    return this.span.active;
  }

  condition(): 'too_dark' | 'too_bright' {
    return this.bright > this.dark ? 'too_bright' : 'too_dark';
  }

  flush(t: number, reason: FlushReason): void {
    this.span.flush(t, reason);
    this.reset();
  }

  reset(): void {
    this.span.reset();
    this.darkPrompt.reset();
    this.brightPrompt.reset();
    this.resetStats();
  }

  private resetStats(): void {
    this.dark = this.bright = this.lumaSum = this.lumaN = this.faceSum = this.faceN = 0;
  }
}

/** monitoring_degraded: analysis throughput below 1.5 fps for ≥ 15 s while the camera is live. */
export class DegradedDetector {
  readonly span: Span;
  private minFps = Infinity;
  private fpsSum = 0;
  private fpsN = 0;

  constructor(host: DetectorHost) {
    this.span = new Span(host, 'monitoring_degraded', 'monitoring_degraded', { onsetMs: K.lowFpsOnsetMs, clearMs: 5000, minFraction: 0.7, gapTolMs: 20000, minTicks: 3 }, {
      describe: (d) => {
        const mean = this.fpsN ? round(this.fpsSum / this.fpsN, 1) : null;
        return {
          details: { durationSec: d.durationSec, meanFps: mean, minFps: Number.isFinite(this.minFps) ? round(this.minFps, 1) : null, requiredFps: K.lowFps },
          observation:
            d.phase === 'close'
              ? `Camera analysis ran slower than required (about ${mean ?? '?'} frames per second) for ${dur(d.durationSec)}.`
              : `Camera analysis is running slower than required (about ${mean ?? '?'} frames per second).`,
        };
      },
    });
  }

  step(ctx: TickContext): void {
    const v = ctx.live ? ctx.fps < K.lowFps : null;
    if (v) {
      if (this.span.deb.idle) {
        this.minFps = Infinity;
        this.fpsSum = 0;
        this.fpsN = 0;
      }
      this.minFps = Math.min(this.minFps, ctx.fps);
      this.fpsSum += ctx.fps;
      this.fpsN++;
    }
    this.span.feed(ctx.t, v, 1);
  }

  get active(): boolean {
    return this.span.active;
  }

  flush(t: number, reason: FlushReason): void {
    this.span.flush(t, reason);
    this.span.reset();
  }

  reset(): void {
    this.span.reset();
  }
}

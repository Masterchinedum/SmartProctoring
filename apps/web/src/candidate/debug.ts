import type { CheckFrameResponse, CompleteCheckResponse, IdentityCheckTrigger } from '@sp/shared';
import type { RuntimeDebug } from './monitoring/runtime';
import type { BurstResult } from './monitoring/sampler';

/**
 * Candidate debug diagnostics, enabled only with `?debug=1` on the take URL (for the product owner and
 * support, to validate a real webcam). Collects what the page can see — never anything the candidate
 * should not: no reference data, only the server's answers to this page's own requests.
 */

export function debugEnabled(search: string = typeof window !== 'undefined' ? window.location.search : ''): boolean {
  const v = new URLSearchParams(search).get('debug');
  return v === '1' || v === 'true';
}

export interface DebugTrigger {
  at: number;
  trigger: IdentityCheckTrigger | 'check_frame';
  source: 'engine' | 'host' | 'server' | 'check';
  reason?: string;
}

export interface DebugCheckFrame {
  at: number;
  step: number | 'frontal';
  accepted: boolean;
  guidance: string[];
  quality: CheckFrameResponse['quality'] | null;
  stepSatisfied?: boolean;
  measured?: { yawDeg: number; pitchDeg: number };
  progress?: CheckFrameResponse['progress'];
  /** Crop sent (px) — the identity evidence resolution. */
  crop?: { width: number; height: number; face: boolean };
}

export interface DebugSnapshot {
  triggers: DebugTrigger[];
  lastBurst: BurstResult | null;
  lastCheckFrame: DebugCheckFrame | null;
  lastCheckOutcome: { at: number; outcome: CompleteCheckResponse['outcome']; message: string } | null;
  runtime: RuntimeDebug | null;
}

export class DebugStore {
  private triggers: DebugTrigger[] = [];
  private lastBurst: BurstResult | null = null;
  private lastCheckFrame: DebugCheckFrame | null = null;
  private lastCheckOutcome: DebugSnapshot['lastCheckOutcome'] = null;
  private readonly listeners = new Set<() => void>();

  constructor(readonly enabled: boolean) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  trigger(t: DebugTrigger): void {
    if (!this.enabled) return;
    this.triggers = [...this.triggers, t].slice(-25);
    this.changed();
  }

  burst(r: BurstResult): void {
    if (!this.enabled) return;
    this.lastBurst = r;
    this.changed();
  }

  checkFrame(f: DebugCheckFrame): void {
    if (!this.enabled) return;
    this.lastCheckFrame = f;
    this.changed();
  }

  checkOutcome(res: CompleteCheckResponse): void {
    if (!this.enabled) return;
    this.lastCheckOutcome = { at: Date.now(), outcome: res.outcome, message: res.message };
    this.changed();
  }

  snapshot(runtime: RuntimeDebug | null): DebugSnapshot {
    return { triggers: this.triggers, lastBurst: this.lastBurst, lastCheckFrame: this.lastCheckFrame, lastCheckOutcome: this.lastCheckOutcome, runtime };
  }
}

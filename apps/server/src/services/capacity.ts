/**
 * Can this instance safely take more exam starts? A separate question from "is the process alive" and "can it serve
 * requests" (routes/public.ts), on purpose: an instance whose face-analysis queue is long still serves its own
 * candidates (heartbeats, answers and events stay fast, docs/PERFORMANCE.md §7.2), so a load balancer must not take
 * it out of rotation for it — that would push its candidates onto the other instances exactly at an exam-start peak.
 * This signal is for admission at exam start, for operators and for autoscalers (docs/OPERATIONS.md §5).
 */
import type { Config } from '../config.js';
import type { Ctx } from '../context.js';
import type { LoadSnapshot } from '../lib/load-monitor.js';
import type { VisionLoad } from '../vision/types.js';

export const CAPACITY_REASONS = ['vision_unavailable', 'vision_queue_long', 'event_loop_lagging', 'database_pool_exhausted'] as const;
export type CapacityReason = (typeof CAPACITY_REASONS)[number];

export interface CapacityStatus {
  accepting: boolean;
  reasons: CapacityReason[];
  /** Expected wait of a new identity sample in the face-analysis queue (ms); null when not measured. */
  visionWaitMs: number | null;
}

/**
 * Identity samples queue as background work, and a started exam sends a burst of them for its first minutes, so the
 * background wait (the estimate, or what the oldest waiting sample has already waited if that is longer) decides.
 */
export function assessCapacity(limits: Config['capacity'], vision: VisionLoad | undefined, monitor: LoadSnapshot | null): CapacityStatus {
  const reasons: CapacityReason[] = [];
  if (vision && vision.workers === 0) reasons.push('vision_unavailable');
  const visionWaitMs = vision ? Math.max(vision.estimatedWaitMs.background, vision.oldestWaitMs.background) : null;
  if (visionWaitMs != null && visionWaitMs > limits.maxVisionWaitMs) reasons.push('vision_queue_long');
  if (monitor && monitor.eventLoopP99Ms > limits.maxEventLoopP99Ms) reasons.push('event_loop_lagging');
  if (monitor && monitor.dbWaiting > limits.maxDbWaiting) reasons.push('database_pool_exhausted');
  return { accepting: reasons.length === 0, reasons, visionWaitMs };
}

/**
 * How hard to space routine identity samples out (0..1): 0 while a new sample would wait less than half the vision
 * limit, rising linearly to 1 at the limit (services/identity-evidence.ts loadAwareDelayMs).
 */
export function samplingPressure(limits: Config['capacity'], visionWaitMs: number | null): number {
  if (visionWaitMs == null) return 0;
  const from = limits.maxVisionWaitMs / 2;
  return Math.min(1, Math.max(0, (visionWaitMs - from) / (limits.maxVisionWaitMs - from)));
}

/** This instance, now (the event-loop and database numbers are the load monitor's last 10-s sample). */
export function currentCapacity(ctx: Pick<Ctx, 'config' | 'vision' | 'loadMonitor'>): CapacityStatus {
  return assessCapacity(ctx.config.capacity, ctx.vision.load, ctx.loadMonitor.snapshot);
}

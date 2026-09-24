import type { SessionSummaryDTO } from '@sp/shared';

/**
 * How current is what staff see about a candidate's connection?
 *
 * Whether a candidate is offline is decided by the server, not here: the sweeper flips `connection` to 'offline'
 * after the exam's heartbeatTimeoutSec (policy, default 20 s) and pushes the summary. While a session is online
 * the server refreshes its summary on routine heartbeats at least every SUMMARY_KEEPALIVE_MS (apps/server
 * realtime/notifier.ts LIVE_DEFAULTS.keepaliveMs) and the browser heartbeats every CANDIDATE_HEARTBEAT_MS, so a
 * healthy session's monitoring / heartbeat time is at most ~15 s old on screen. The UI only qualifies it ("as of
 * 40s ago") past LIVE_STALE_AFTER_MS — never for a healthy session.
 */
export const SUMMARY_KEEPALIVE_MS = 10_000;
export const CANDIDATE_HEARTBEAT_MS = 5_000;
/**
 * keepalive + heartbeat interval + 10 s margin (delivery, batching, clock correction). It also equals the default
 * heartbeatTimeoutSec (20 s) + the sweeper interval (5 s): under the default policy a browser that stops
 * heartbeating is marked offline by the server before the UI would qualify its data.
 */
export const LIVE_STALE_AFTER_MS = SUMMARY_KEEPALIVE_MS + CANDIDATE_HEARTBEAT_MS + 10_000;

type Liveness = Pick<SessionSummaryDTO, 'status' | 'connection' | 'lastHeartbeatAt' | 'monitoring'>;

const ENDED = new Set<SessionSummaryDTO['status']>(['submitted', 'terminated']);

/** Online (per the server) but no refresh for longer than a healthy session can go without one. */
export function monitoringStale(s: Pick<SessionSummaryDTO, 'connection' | 'monitoring'>, now: number): boolean {
  return s.connection === 'online' && s.monitoring != null && now - s.monitoring.at > LIVE_STALE_AFTER_MS;
}

export type HeartbeatView =
  /** No heartbeat yet. */
  | { kind: 'none' }
  /** Online and current: heartbeats are arriving (the exact time is only a tooltip — it lags by design). */
  | { kind: 'live'; at: number }
  /** Online per the server, but nothing newer has reached this screen for a while: show the plain time. */
  | { kind: 'delayed'; at: number }
  /** The server marked the connection offline. */
  | { kind: 'offline'; at: number }
  /** The exam has ended. */
  | { kind: 'ended'; at: number };

export function heartbeatView(s: Liveness, now: number): HeartbeatView {
  const at = s.lastHeartbeatAt;
  if (at == null) return { kind: 'none' };
  if (ENDED.has(s.status)) return { kind: 'ended', at };
  if (s.connection !== 'online') return { kind: 'offline', at };
  return now - at > LIVE_STALE_AFTER_MS ? { kind: 'delayed', at } : { kind: 'live', at };
}

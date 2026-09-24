import { describe, expect, it } from 'vitest';
import { makeSession } from '../test/fixtures';
import { CANDIDATE_HEARTBEAT_MS, heartbeatView, LIVE_STALE_AFTER_MS, monitoringStale, SUMMARY_KEEPALIVE_MS } from './liveness';

const NOW = 1_000_000;
const mon = (at: number) => ({ state: 'ok' as const, faces: 1, label: 'Candidate in view', open: [], lookDirection: null, at });

describe('liveness: offline is the server’s call, healthy sessions never look stale', () => {
  it('the stale threshold covers the server keepalive plus a heartbeat interval with margin', () => {
    expect(SUMMARY_KEEPALIVE_MS).toBe(10_000);
    expect(LIVE_STALE_AFTER_MS).toBe(25_000);
    expect(LIVE_STALE_AFTER_MS).toBeGreaterThan(SUMMARY_KEEPALIVE_MS + CANDIDATE_HEARTBEAT_MS);
  });

  it('a healthy online session (last refresh up to keepalive + heartbeat interval old) is not stale', () => {
    // Worst case for a healthy session: keepalive just missed by a heartbeat, plus delivery.
    const worst = SUMMARY_KEEPALIVE_MS + CANDIDATE_HEARTBEAT_MS + 2_000;
    expect(monitoringStale(makeSession({ connection: 'online', monitoring: mon(NOW - worst) }), NOW)).toBe(false);
    expect(heartbeatView(makeSession({ status: 'active', connection: 'online', lastHeartbeatAt: NOW - worst }), NOW)).toEqual({ kind: 'live', at: NOW - worst });
  });

  it('is only qualified when online but nothing arrived for longer than a healthy session can go without', () => {
    expect(monitoringStale(makeSession({ connection: 'online', monitoring: mon(NOW - LIVE_STALE_AFTER_MS - 1) }), NOW)).toBe(true);
    expect(heartbeatView(makeSession({ status: 'active', connection: 'online', lastHeartbeatAt: NOW - 40_000 }), NOW)).toEqual({ kind: 'delayed', at: NOW - 40_000 });
  });

  it('offline and ended sessions are shown as such, whatever the age', () => {
    expect(monitoringStale(makeSession({ connection: 'offline', monitoring: mon(NOW - 60_000) }), NOW)).toBe(false); // the "Not reporting" line covers it
    expect(heartbeatView(makeSession({ status: 'active', connection: 'offline', lastHeartbeatAt: NOW - 3_000 }), NOW).kind).toBe('offline');
    expect(heartbeatView(makeSession({ status: 'submitted', connection: 'online', lastHeartbeatAt: NOW - 3_000 }), NOW).kind).toBe('ended');
    expect(heartbeatView(makeSession({ lastHeartbeatAt: null }), NOW)).toEqual({ kind: 'none' });
    expect(monitoringStale(makeSession({ connection: 'online', monitoring: null }), NOW)).toBe(false);
  });
});

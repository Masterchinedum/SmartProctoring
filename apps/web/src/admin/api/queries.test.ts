import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { EventDTO, SessionDetailDTO, TimelineItemDTO } from '@sp/shared';
import { makeCheck, makeEvent, makePeriod, makeSession } from '../test/fixtures';
import { toDashboardState, type DashboardState } from '../lib/liveState';
import { applyEvent, applyIdentityCheck, applyPauseRequestMessage, applySessionSummary, qk } from './queries';

function setup() {
  const qc = new QueryClient();
  const s = makeSession({ id: 'S1' });
  qc.setQueryData<DashboardState>(qk.dashboard, toDashboardState({ serverTime: 0, sessions: [s], recentEvents: [], pending: { pauseRequests: [], holds: [] } }, 0));
  const detail = { summary: s, identityChecks: [], pauseRequests: [], periods: [], references: [], notes: [], devices: [] } as unknown as SessionDetailDTO;
  qc.setQueryData(qk.session('S1'), detail);
  const p = makePeriod('active', 0, null);
  qc.setQueryData<{ items: TimelineItemDTO[] }>(qk.timeline('S1'), { items: [{ kind: 'period', at: 0, period: p }] });
  qc.setQueryData<{ items: EventDTO[] }>(qk.sessionEvents('S1'), { items: [] });
  qc.setQueryData(qk.sessions({}), { items: [s], total: 1 });
  return { qc, s };
}

describe('realtime cache patching', () => {
  it('patches a new event into the feed, timeline and event list', () => {
    const { qc } = setup();
    const ev = { ...makeEvent('phone_detected', 100), sessionId: 'S1' };
    const r = applyEvent(qc, ev, { candidateName: 'Ada', examTitle: 'Algebra' });
    expect(r.isNew).toBe(true);
    expect(qc.getQueryData<DashboardState>(qk.dashboard)!.recentEvents[0]).toMatchObject({ id: ev.id, candidateName: 'Ada' });
    expect(qc.getQueryData<{ items: TimelineItemDTO[] }>(qk.timeline('S1'))!.items.map((i) => i.kind)).toEqual(['period', 'event']);
    expect(qc.getQueryData<{ items: EventDTO[] }>(qk.sessionEvents('S1'))!.items).toHaveLength(1);
    // second delivery of the same event is an update, not a duplicate
    expect(applyEvent(qc, { ...ev, endedAt: 200 }, { candidateName: 'Ada', examTitle: 'Algebra' }).isNew).toBe(false);
    expect(qc.getQueryData<{ items: EventDTO[] }>(qk.sessionEvents('S1'))!.items).toHaveLength(1);
  });

  it('upserts session summaries everywhere they are cached', () => {
    const { qc, s } = setup();
    applySessionSummary(qc, { ...s, pauseCount: 2, connection: 'offline', reportingInterruptedSince: 5 });
    expect(qc.getQueryData<DashboardState>(qk.dashboard)!.sessions[0].connection).toBe('offline');
    expect(qc.getQueryData<SessionDetailDTO>(qk.session('S1'))!.summary.pauseCount).toBe(2);
    expect(qc.getQueryData<{ items: { pauseCount: number }[] }>(qk.sessions({}))!.items[0].pauseCount).toBe(2);
    // an unknown session is added to the dashboard board
    applySessionSummary(qc, makeSession({ id: 'S2' }));
    expect(qc.getQueryData<DashboardState>(qk.dashboard)!.sessions.map((x) => x.id)).toEqual(['S2', 'S1']);
  });

  it('applies identity checks and pause requests', () => {
    const { qc } = setup();
    applyIdentityCheck(qc, 'S1', makeCheck('mismatch', 50));
    expect(qc.getQueryData<SessionDetailDTO>(qk.session('S1'))!.identityChecks).toHaveLength(1);
    expect(qc.getQueryData<{ items: TimelineItemDTO[] }>(qk.timeline('S1'))!.items.some((i) => i.kind === 'identity_check')).toBe(true);
    const req = { id: 'r1', requestedAt: 1, reason: null, status: 'pending' as const, decidedAt: null, decidedBy: null, decisionNote: null };
    applyPauseRequestMessage(qc, 'S1', req);
    expect(qc.getQueryData<DashboardState>(qk.dashboard)!.sessions[0].pendingPauseRequest?.id).toBe('r1');
    applyPauseRequestMessage(qc, 'S1', { ...req, status: 'approved' });
    expect(qc.getQueryData<DashboardState>(qk.dashboard)!.sessions[0].pendingPauseRequest).toBeNull();
    expect(qc.getQueryData<SessionDetailDTO>(qk.session('S1'))!.pauseRequests).toHaveLength(1);
  });

  it('marks the timeline stale when periods change', async () => {
    const { qc, s } = setup();
    applySessionSummary(qc, { ...s, status: 'paused' });
    expect(qc.getQueryState(qk.timeline('S1'))!.isInvalidated).toBe(true);
  });
});

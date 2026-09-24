import { describe, expect, it } from 'vitest';
import type { LiveEventDTO, PauseRequestDTO } from '@sp/shared';
import { makeEvent, makeSession } from '../test/fixtures';
import { applyFeedEvent, applyPauseRequest, boardGroup, groupSessions, matchesSearch, needsAttention, toDashboardState, upsertSession } from './liveState';

const live = (ev: ReturnType<typeof makeEvent>): LiveEventDTO => ({ ...ev, candidateName: 'Ada', examTitle: 'Algebra' });
const request = (patch: Partial<PauseRequestDTO> = {}): PauseRequestDTO => ({
  id: 'pr1',
  requestedAt: 100,
  reason: 'Bathroom',
  status: 'pending',
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  ...patch,
});

describe('board grouping', () => {
  it('maps status + connection to board groups', () => {
    expect(boardGroup(makeSession({ status: 'active', connection: 'online' }))).toBe('active');
    expect(boardGroup(makeSession({ status: 'active', connection: 'offline' }))).toBe('disconnected');
    expect(boardGroup(makeSession({ status: 'paused', connection: 'offline' }))).toBe('paused');
    expect(boardGroup(makeSession({ status: 'on_hold' }))).toBe('on_hold');
    expect(boardGroup(makeSession({ status: 'submitted' }))).toBe('completed');
    expect(boardGroup(makeSession({ status: 'terminated' }))).toBe('completed');
    expect(boardGroup(makeSession({ status: 'invited', connection: 'never_connected' }))).toBe('not_started');
    expect(boardGroup(makeSession({ status: 'ready' }))).toBe('not_started');
  });

  it('groups and orders sessions (completed by end time, newest first)', () => {
    const s1 = makeSession({ status: 'submitted', endedAt: 10 });
    const s2 = makeSession({ status: 'submitted', endedAt: 20 });
    const s3 = makeSession({ status: 'active', startedAt: 5 });
    const g = groupSessions([s1, s2, s3]);
    expect(g.completed.map((s) => s.id)).toEqual([s2.id, s1.id]);
    expect(g.active).toEqual([s3]);
    expect(g.paused).toEqual([]);
  });

  it('searches candidate, email and exam', () => {
    const s = makeSession();
    expect(matchesSearch(s, 'ada')).toBe(true);
    expect(matchesSearch(s, 'ALGEBRA')).toBe(true);
    expect(matchesSearch(s, 'example.com')).toBe(true);
    expect(matchesSearch(s, 'zzz')).toBe(false);
    expect(matchesSearch(s, '  ')).toBe(true);
  });
});

describe('session upsert', () => {
  it('replaces by id or prepends', () => {
    const a = makeSession();
    const b = makeSession();
    expect(upsertSession([a], b).map((s) => s.id)).toEqual([b.id, a.id]);
    const updated = upsertSession([a, b], { ...a, pauseCount: 3 });
    expect(updated[0].pauseCount).toBe(3);
    expect(updated).toHaveLength(2);
  });
});

describe('flags feed', () => {
  it('prepends new non-neutral events and updates existing ones in place', () => {
    const e1 = live(makeEvent('phone_detected', 1));
    const e2 = live(makeEvent('multiple_people', 2));
    let r = applyFeedEvent([], e1);
    expect(r.isNew).toBe(true);
    r = applyFeedEvent(r.feed, e2);
    expect(r.feed.map((e) => e.id)).toEqual([e2.id, e1.id]);
    const closed = { ...e1, status: 'closed' as const, endedAt: 50 };
    r = applyFeedEvent(r.feed, closed);
    expect(r.isNew).toBe(false);
    expect(r.feed.map((e) => e.id)).toEqual([e2.id, e1.id]);
    expect(r.feed[1].endedAt).toBe(50);
  });

  it('never adds neutral events and caps the feed length', () => {
    const neutral = live(makeEvent('session_paused', 1));
    expect(applyFeedEvent([], neutral).feed).toEqual([]);
    let feed: LiveEventDTO[] = [];
    for (let i = 0; i < 5; i++) feed = applyFeedEvent(feed, live(makeEvent('tab_hidden', i)), 3).feed;
    expect(feed).toHaveLength(3);
    expect(feed[0].startedAt).toBe(4);
  });

  it('drops neutral events from the initial dashboard payload', () => {
    const st = toDashboardState(
      {
        serverTime: 1,
        sessions: [makeSession()],
        recentEvents: [live(makeEvent('session_started', 1)), live(makeEvent('phone_detected', 2))],
        pending: { pauseRequests: [], holds: [] },
      },
      99,
    );
    expect(st.recentEvents).toHaveLength(1);
    expect(st.sessions[0].receivedAt).toBe(99);
  });
});

describe('pause requests and attention', () => {
  it('applies pending and decided requests', () => {
    const s = makeSession();
    const pending = applyPauseRequest(s, request());
    expect(pending.pendingPauseRequest?.id).toBe('pr1');
    expect(applyPauseRequest(pending, request({ status: 'approved' })).pendingPauseRequest).toBeNull();
    // a decision for another request leaves the current one untouched
    expect(applyPauseRequest(pending, request({ id: 'other', status: 'denied' })).pendingPauseRequest?.id).toBe('pr1');
  });

  it('derives needs-attention items from sessions and keeps unknown pending entries', () => {
    const withReq = { ...makeSession({ pendingPauseRequest: request() }), receivedAt: 0 };
    const held = { ...makeSession({ status: 'on_hold', hold: { reason: 'identity_mismatch', since: 5, message: '', canReverify: false } }), receivedAt: 0 };
    const r = needsAttention({
      sessions: [withReq, held],
      pending: {
        pauseRequests: [
          { sessionId: withReq.id, candidateName: 'x', examTitle: 'y', request: request() }, // duplicate of a known session: ignored
          { sessionId: 'unknown', candidateName: 'Grace', examTitle: 'Z', request: request({ id: 'pr2', requestedAt: 150 }) },
        ],
        holds: [],
      },
    });
    expect(r.pauses.map((p) => p.request.id)).toEqual(['pr1', 'pr2']);
    expect(r.holds.map((h) => h.sessionId)).toEqual([held.id]);
  });
});

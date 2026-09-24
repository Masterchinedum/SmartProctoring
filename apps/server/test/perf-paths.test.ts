/**
 * Hot-path behaviour kept cheap under load (docs/PERFORMANCE.md):
 *  - the routine heartbeat is one conditional UPDATE (no transaction) and falls back to the locked path whenever
 *    it would do more (commands to deliver, outage to close, concurrent change);
 *  - realtime summaries are only built for observed organisations, coalesced per session, and not sent for
 *    changes staff cannot see (heartbeat timestamps) except as a slow keepalive.
 */
import type { LiveMessage } from '@sp/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveCandidateSession } from '../src/auth/candidate.js';
import { examSessions, sessionCommands } from '../src/db/schema.js';
import { LocalBus } from '../src/realtime/bus.js';
import { LiveNotifier } from '../src/realtime/notifier.js';
import { heartbeat } from '../src/services/candidate-actions.js';
import { staffVisibleKey } from '../src/services/dto.js';
import { withSession } from '../src/services/session-state.js';
import { hb, startedSession } from './flow.js';
import { createTestEnv, type CandidateClient, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env?.close();
});

/** Count transactions (withSession) started through ctx.db. */
function countTransactions(e: TestEnv) {
  const db = e.ctx.db as unknown as { transaction: (...a: unknown[]) => unknown };
  const orig = db.transaction.bind(db);
  const counter = { n: 0, restore: () => void (db.transaction = orig) };
  db.transaction = (...a: unknown[]) => {
    counter.n++;
    return orig(...a);
  };
  return counter;
}

const body = (c: CandidateClient, extra: Record<string, unknown> = {}) => ({
  clientInstanceId: c.instanceId,
  clientTime: env.clock.t,
  seq: 1,
  monitoring: { state: 'ok' as const, faces: 1, label: 'Candidate in view', open: [] },
  outboxSize: 0,
  outboxOldestAt: null,
  visibility: 'visible' as const,
  fullscreen: true,
  ...extra,
});

async function row(id: string) {
  const [s] = await env.ctx.db.select().from(examSessions).where(eq(examSessions.id, id));
  return s;
}

describe('heartbeat fast path', () => {
  it('a routine heartbeat is a single statement with the same effect as the locked path', async () => {
    const s = await env.newSession();
    const c = await startedSession(env, env.candidateClient(s.token));
    expect((await hb(c)).statusCode).toBe(200); // first heartbeat after start
    env.clock.advance(5_000);
    const tx = countTransactions(env);
    try {
      const r = await hb(c, { seq: 2, monitoring: { state: 'attention', faces: 0, label: 'Nobody in view', open: ['candidate_absent'] }, currentQuestionIndex: 2 });
      expect(r.statusCode, r.body).toBe(200);
      expect(tx.n).toBe(0);
      const res = r.json();
      expect(res).toMatchObject({ status: 'active', timerRunning: true, requiredCheck: null, commands: [], serverTime: env.clock.t });
      const after = await row(s.id);
      expect(after.lastHeartbeatAt!.getTime()).toBe(env.clock.t);
      expect(after.lastVerifiedHeartbeatAt!.getTime()).toBe(env.clock.t);
      expect(after.connection).toBe('online');
      expect(after.monitoring).toMatchObject({ state: 'attention', faces: 0, label: 'Nobody in view', open: ['candidate_absent'], at: env.clock.t });
      expect(after.currentQuestionIndex).toBe(2);
      expect(after.instanceUsage?.seq?.streams[0].last).toBe(2);
    } finally {
      tx.restore();
    }
  });

  it('falls back to the locked path to deliver queued commands', async () => {
    const s = await env.newSession();
    const c = await startedSession(env, env.candidateClient(s.token));
    await env.ctx.db.insert(sessionCommands).values({ sessionId: s.id, command: { kind: 'pause_denied', note: 'not now' }, createdAt: new Date(env.clock.t) });
    const tx = countTransactions(env);
    try {
      const r = await hb(c);
      expect(r.statusCode).toBe(200);
      expect(r.json().commands).toEqual([{ kind: 'pause_denied', note: 'not now' }]);
      expect(tx.n).toBe(1);
      expect((await hb(c)).json().commands).toEqual([]); // delivered once
    } finally {
      tx.restore();
    }
  });

  it('does not overwrite a row that changed after the request loaded it (xmin guard)', async () => {
    const s = await env.newSession();
    const c = await startedSession(env, env.candidateClient(s.token));
    const loaded = await resolveCandidateSession(env.ctx, { headers: { authorization: `Bearer ${s.token}`, 'x-client-instance': c.instanceId } } as never);
    // A concurrent change (e.g. staff put the session on hold) commits after the request loaded the row.
    await withSession(env.ctx, s.id, async (m) => {
      m.set({ pauseCount: 7 });
    });
    const tx = countTransactions(env);
    try {
      const res = await heartbeat(env.ctx, s.id, c.instanceId, body(c), { ip: '127.0.0.1', userAgent: 'lightMyRequest' }, loaded);
      expect(res.status).toBe('active');
      expect(tx.n).toBe(1); // re-done under the row lock on the fresh row
      const after = await row(s.id);
      expect(after.pauseCount).toBe(7);
      expect(after.lastHeartbeatAt!.getTime()).toBe(env.clock.t);
    } finally {
      tx.restore();
    }
  });

  it('uses the locked path when the heartbeat ends an outage (reporting_interrupted is closed)', async () => {
    const s = await env.newSession();
    const c = await startedSession(env, env.candidateClient(s.token));
    await withSession(env.ctx, s.id, async (m) => {
      const ev = await m.addEvent({ type: 'reporting_interrupted', open: true, startedAt: env.clock.t - 30_000 });
      m.set({ connection: 'offline', reportingEventId: ev.id });
    });
    const tx = countTransactions(env);
    try {
      expect((await hb(c)).statusCode).toBe(200);
      expect(tx.n).toBe(1);
      const after = await row(s.id);
      expect(after.reportingEventId).toBeNull();
      expect(after.connection).toBe('online');
    } finally {
      tx.restore();
    }
  });
});

describe('staff-visible changes', () => {
  it('ignores heartbeat timestamps and the monitoring time, not what staff see', async () => {
    const s = await row(env.session.id);
    const base = staffVisibleKey(s);
    expect(staffVisibleKey({ ...s, lastHeartbeatAt: new Date(1), updatedAt: new Date(2), lastVerifiedHeartbeatAt: new Date(3) })).toBe(base);
    const mon = { state: 'ok' as const, faces: 1, label: 'x', open: [], at: 1 };
    expect(staffVisibleKey({ ...s, monitoring: mon })).toBe(staffVisibleKey({ ...s, monitoring: { ...mon, at: 99 } }));
    expect(staffVisibleKey({ ...s, monitoring: mon })).not.toBe(staffVisibleKey({ ...s, monitoring: { ...mon, faces: 2 } }));
    expect(staffVisibleKey({ ...s, connection: 'offline' })).not.toBe(staffVisibleKey({ ...s, connection: 'online' }));
    expect(staffVisibleKey({ ...s, status: 'paused' })).not.toBe(base);
  });
});

describe('LiveNotifier', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** A notifier on its own bus, counting database reads. */
  function harness(opts = { sessionIntervalMs: 150, keepaliveMs: 600, batchMs: 10 }) {
    const bus = new LocalBus();
    let reads = 0;
    const db = new Proxy(env.ctx.db, {
      get(target, prop, receiver) {
        if (prop === 'select') reads++;
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const live = new LiveNotifier({ ...env.ctx, bus, db }, opts);
    const got: LiveMessage[] = [];
    return { bus, live, got, reads: () => reads, listen: () => bus.subscribe(env.org.id, (m) => got.push(m)) };
  }

  it('does no work for an organisation nobody watches', async () => {
    const h = harness();
    h.live.sessionChanged(env.session.id, { orgId: env.org.id });
    h.live.eventChanged('00000000-0000-4000-8000-000000000000', env.session.id, env.org.id);
    h.live.identityCheck(env.session.id, '00000000-0000-4000-8000-000000000001', env.org.id);
    await wait(60);
    expect(h.reads()).toBe(0);
    expect(h.got).toEqual([]);
    h.live.close();
  });

  it('coalesces visible changes per session (first at once, then one trailing summary)', async () => {
    const h = harness();
    const off = h.listen();
    const sent = () => h.got.filter((m) => m.type === 'session').length;
    for (let i = 0; i < 5; i++) h.live.sessionChanged(env.session.id, { orgId: env.org.id }); // one load covers all
    await wait(60);
    expect(sent()).toBe(1);
    for (let i = 0; i < 5; i++) h.live.sessionChanged(env.session.id, { orgId: env.org.id }); // inside the interval
    await wait(40);
    expect(sent()).toBe(1);
    await wait(150);
    expect(sent()).toBe(2); // trailing edge: the last change is always delivered
    off();
    h.live.close();
  });

  it('sends invisible changes only as a keepalive', async () => {
    const h = harness();
    const off = h.listen();
    h.live.sessionChanged(env.session.id, { orgId: env.org.id, visible: false }); // nothing sent yet: goes out
    await wait(40);
    expect(h.got).toHaveLength(1);
    h.live.sessionChanged(env.session.id, { orgId: env.org.id, visible: false });
    await wait(250); // past the visible interval, inside the keepalive
    expect(h.got).toHaveLength(1);
    await wait(400);
    h.live.sessionChanged(env.session.id, { orgId: env.org.id, visible: false });
    await wait(40);
    expect(h.got).toHaveLength(2);
    off();
    h.live.close();
  });

  it('loads the summaries of many sessions with one query set', async () => {
    const sessions = await Promise.all([env.newSession(), env.newSession(), env.newSession()]);
    const h = harness();
    const off = h.listen();
    for (const s of sessions) h.live.sessionChanged(s.id, { orgId: env.org.id });
    await wait(80);
    const ids = h.got.filter((m): m is Extract<LiveMessage, { type: 'session' }> => m.type === 'session').map((m) => m.session.id);
    expect(ids.sort()).toEqual(sessions.map((s) => s.id).sort());
    expect(h.reads()).toBeLessThanOrEqual(3); // summaries + counts + pending pause requests
    off();
    h.live.close();
  });
});

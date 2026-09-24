/**
 * P2-2: the final report must not claim monitoring for time when the candidate's browser was gone.
 *
 * A reporting outage (reporting_interrupted, from the last heartbeat) is observed only if the same browser came
 * back (closedBy 'heartbeat_resumed') or something it captured meanwhile was delivered late. Otherwise — the exam
 * ended while the browser was gone, or the outage is still going on — the time is unobserved: finalizeSession
 * materialises a 'disconnected' period (reason browser_not_returned) and the report never says "monitoring ran"
 * or "delivered later" for it. Controlled clock throughout.
 */
import type { PeriodDTO, SessionDetailDTO, SessionReportDTO } from '@sp/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { events } from '../../src/db/schema.js';
import { sweepOnce } from '../../src/jobs/sweeper.js';
import { unobservedOutages, withUnobservedOutages } from '../../src/services/reporting-gaps.js';
import { hb, startedSession } from '../flow.js';
import { createTestEnv, type CandidateClient, type TestEnv } from '../helpers.js';
import { clientEvent, json, MIN, staffApi, type Api } from './fixtures.js';

let env: TestEnv;
let admin: Api;
beforeAll(async () => {
  env = await createTestEnv();
  admin = await staffApi(env, 'admin');
});
afterAll(async () => env?.close());

const HB_TIMEOUT_MS = 20_000; // policy default heartbeatTimeoutSec

/** A started exam whose browser heartbeats once `activeMs` after the start and then disappears (sweeper times it out). */
async function browserGoesAway(activeMs: number, examId?: string): Promise<{ sessionId: string; c: CandidateClient; started: number; lastHb: number }> {
  const cand = await env.newCandidate('Gina Gone');
  const s = await env.newSession({ candidateId: cand.id, examId });
  const c = await startedSession(env, env.candidateClient(s.token));
  const started = env.clock.t;
  env.clock.advance(activeMs);
  json(await hb(c));
  const lastHb = env.clock.t;
  env.clock.advance(HB_TIMEOUT_MS + 5_000);
  expect((await sweepOnce(env.ctx)).timedOut).toBeGreaterThanOrEqual(1);
  return { sessionId: s.id, c, started, lastHb };
}

async function report(sessionId: string): Promise<SessionReportDTO> {
  admin = await staffApi(env, 'admin'); // fresh staff session after moving the clock
  return json<SessionReportDTO>(await admin.get(`/sessions/${sessionId}/report`));
}

async function reportingEvent(sessionId: string) {
  const [ev] = await env.ctx.db.select().from(events).where(and(eq(events.sessionId, sessionId), eq(events.type, 'reporting_interrupted')));
  return ev;
}

const dur = (p: PeriodDTO, endAt: number) => (p.endedAt ?? endAt) - p.startedAt;

describe('browser disappears and never returns', () => {
  it('staff end: the gap is a disconnected period, not monitoring; no "delivered later" and no "no unobserved periods"', async () => {
    const { sessionId, c, started, lastHb } = await browserGoesAway(35_000);
    // An episode the browser opened just before it went away (it can never close it).
    const lookingAway = await clientEvent(c, { type: 'looking_away', startedAt: lastHb - 3_000, endedAt: null, confidence: 0.8 });
    env.clock.set(lastHb + 5 * MIN);
    const endedAt = env.clock.t;
    json(await admin.post(`/sessions/${sessionId}/terminate`, { reason: 'Candidate unreachable' }));

    const r = await report(sessionId);
    expect(r.periods.map((p) => p.kind)).toEqual(['check_in', 'active', 'disconnected']);
    const active = r.periods[1];
    const gap = r.periods[2];
    expect(active).toMatchObject({ startedAt: started, endedAt: lastHb });
    expect(gap).toMatchObject({ startedAt: lastHb, endedAt, observed: false, reason: 'browser_not_returned' });
    expect(r.totals.activeMs).toBe(35_000);
    expect(r.totals.disconnectedMs).toBe(5 * MIN);
    expect(r.totals.unobservedMs).toBe(5 * MIN);
    expect(r.totals.observedMs).toBe(dur(r.periods[0], endedAt) + 35_000);

    const obs = r.observations.join('\n');
    expect(obs).toMatch(/Monitoring ran for 35s of active exam time across 1 active period\./);
    expect(obs).toMatch(/The candidate’s browser stopped reporting at \d\d:\d\d UTC and did not return \(5m 00s until the end of the exam\); this period was not observed\./);
    expect(obs).toMatch(/Live reporting from the candidate’s browser was interrupted 1 time \(5m 00s in total\)\./);
    expect(obs).not.toMatch(/delivered later/);
    const lim = r.limitations.join('\n');
    expect(lim).not.toMatch(/There were no unobserved periods/);
    expect(lim).toMatch(/No observations were made during unobserved periods: browser not reporting at \d\d:\d\d UTC \(5m 00s\)\./);
    expect(lim).toMatch(/Live reporting was interrupted for 5m 00s; nothing captured during it was delivered, so that time is listed as unobserved\./);
    expect(lim).not.toMatch(/delivered later/);

    // The gone browser's open episode ends where its observation ended, not at the end of the exam.
    const [la] = await env.ctx.db.select().from(events).where(eq(events.id, lookingAway));
    expect(la).toMatchObject({ status: 'closed', endedAt: new Date(lastHb), details: expect.objectContaining({ closedBy: 'browser_not_returned' }) });
    expect((await reportingEvent(sessionId)).details).toMatchObject({ closedBy: 'session_end' });
    // The session's own period list (detail view) has the same unobserved period.
    const detail = json<SessionDetailDTO>(await admin.get(`/sessions/${sessionId}`));
    expect(detail.periods.find((p) => p.kind === 'disconnected')).toMatchObject({ startedAt: lastHb, endedAt, reason: 'browser_not_returned', observed: false });
  });

  it('time expiry while offline (clock keeps running): the gap up to the expiry is unobserved', async () => {
    const { exam } = await env.newExam({ durationSec: 300 });
    const { sessionId, started, lastHb } = await browserGoesAway(40_000, exam.id);
    env.clock.advance(10 * MIN);
    expect((await sweepOnce(env.ctx)).expired).toBeGreaterThanOrEqual(1);
    const r = await report(sessionId);
    const expiredAt = started + 300_000;
    expect(r.session).toMatchObject({ status: 'submitted', endReason: 'time_expired', endedAt: expiredAt });
    expect(r.periods.filter((p) => p.kind !== 'check_in').map((p) => [p.kind, p.startedAt, p.endedAt, p.reason])).toEqual([
      ['active', started, lastHb, null],
      ['disconnected', lastHb, expiredAt, 'browser_not_returned'],
    ]);
    expect(r.totals.activeMs).toBe(40_000);
    expect(r.totals.disconnectedMs).toBe(expiredAt - lastHb);
    expect(r.observations.join('\n')).toMatch(/submitted automatically when the exam time ran out/);
    expect(r.observations.join('\n')).toMatch(/stopped reporting at \d\d:\d\d UTC and did not return \(4m 20s until the end of the exam\)/);
  });

  it('a hold placed while the browser was already gone: the active tail before the hold is unobserved too', async () => {
    const { sessionId, started, lastHb } = await browserGoesAway(30_000);
    env.clock.set(lastHb + MIN);
    const heldAt = env.clock.t;
    json(await admin.post(`/sessions/${sessionId}/hold`, { note: 'Trying to reach the candidate' }));
    env.clock.advance(2 * MIN);
    const endedAt = env.clock.t;
    admin = await staffApi(env, 'admin');
    json(await admin.post(`/sessions/${sessionId}/terminate`, { reason: 'Unreachable' }));
    const r = await report(sessionId);
    expect(r.periods.filter((p) => p.kind !== 'check_in').map((p) => [p.kind, p.startedAt, p.endedAt])).toEqual([
      ['active', started, lastHb],
      ['disconnected', lastHb, heldAt],
      ['on_hold', heldAt, endedAt],
    ]);
    expect(r.totals).toMatchObject({ activeMs: 30_000, disconnectedMs: heldAt - lastHb, heldMs: 2 * MIN, unobservedMs: endedAt - lastHb });
  });

  it('an interim report during an ongoing outage does not count it as monitoring', async () => {
    const { sessionId, started, lastHb } = await browserGoesAway(30_000);
    env.clock.set(lastHb + 2 * MIN);
    const r = await report(sessionId);
    expect(r.periods.filter((p) => p.kind !== 'check_in').map((p) => [p.kind, p.startedAt, p.endedAt, p.observed, p.reason])).toEqual([
      ['active', started, lastHb, true, null],
      ['disconnected', lastHb, null, false, 'browser_not_reporting'],
    ]);
    expect(r.totals.activeMs).toBe(30_000);
    expect(r.totals.disconnectedMs).toBe(2 * MIN);
    expect(r.observations.join('\n')).toMatch(/The candidate’s browser has not reported since \d\d:\d\d UTC \(2m 00s so far\); this period is not observed\./);
    expect(r.limitations.join('\n')).toMatch(/browser not reporting at \d\d:\d\d UTC \(2m 00s, ongoing\)/);
  });
});

describe('outages that were observed', () => {
  it('something captured during the outage was delivered late: observed, and the report says so', async () => {
    const { sessionId, c, started, lastHb } = await browserGoesAway(30_000);
    env.clock.advance(30_000);
    // The browser's outbox delivers an episode from inside the outage (> 30 s after it ended -> deliveredLate).
    await clientEvent(c, { type: 'tab_hidden', startedAt: lastHb + 5_000, endedAt: lastHb + 10_000, confidence: 1 });
    env.clock.set(lastHb + 3 * MIN);
    json(await admin.post(`/sessions/${sessionId}/terminate`, { reason: 'Ended' }));
    const r = await report(sessionId);
    expect(r.periods.map((p) => p.kind)).toEqual(['check_in', 'active']);
    expect(r.totals.activeMs).toBe(lastHb + 3 * MIN - started);
    expect(r.totals.disconnectedMs).toBe(0);
    expect(r.observations.join('\n')).toMatch(/interrupted 1 time \(3m 00s in total\); 1 event captured during the interruption was delivered later with its original timestamps\./);
    expect(r.limitations.join('\n')).toMatch(/Live reporting was interrupted for 3m 00s; observations captured during the interruption were delivered later with their original timestamps\./);
  });

  it('the same browser came back without late data: observed, but no claim that anything was delivered later', async () => {
    const { sessionId, c, started, lastHb } = await browserGoesAway(30_000);
    env.clock.advance(MIN);
    json(await hb(c)); // back: closes the outage (heartbeat_resumed)
    const back = env.clock.t;
    expect((await reportingEvent(sessionId)).details).toMatchObject({ closedBy: 'heartbeat_resumed' });
    env.clock.advance(MIN);
    json(await c.req('POST', '/api/candidate/submit'));
    const r = await report(sessionId);
    expect(r.periods.map((p) => p.kind)).toEqual(['check_in', 'active']);
    expect(r.totals.activeMs).toBe(env.clock.t - started);
    const lim = r.limitations.join('\n');
    expect(lim).toMatch(new RegExp(`Live reporting was interrupted for ${Math.round((back - lastHb) / 1000 / 60)}m \\d\\ds\\.`));
    expect(lim).not.toMatch(/delivered later|listed as unobserved/);
    expect(lim).toMatch(/There were no unobserved periods/);
    expect(r.observations.join('\n')).not.toMatch(/delivered later/);
  });
});

describe('withUnobservedOutages (older data / holds begun while the browser was gone)', () => {
  const P = (kind: PeriodDTO['kind'], startedAt: number, endedAt: number | null): PeriodDTO => ({ id: `${kind}${startedAt}`, kind, observed: ['check_in', 'active', 'resume_check'].includes(kind), startedAt, endedAt, reason: null, meta: {} });
  const out = (id: string, startedAt: number, endedAt: number | null, closedBy?: string) => ({ id, startedAt, endedAt, details: closedBy ? { closedBy } : {} });

  it('cuts an unconfirmed outage out of the active period it overlaps; leaves resumed / late-delivered ones alone', () => {
    const periods = [P('check_in', 0, 10), P('active', 10, 100)];
    const gaps = unobservedOutages([out('a', 40, 100, 'session_end'), out('b', 15, 20, 'heartbeat_resumed'), out('c', 22, 30, 'reconnected')], [{ start: 25, end: 25 }], 100);
    expect(gaps.map((g) => g.eventId)).toEqual(['a']); // b: same browser back; c: something from it arrived late
    const split = withUnobservedOutages(periods, gaps);
    expect(split.map((p) => [p.kind, p.startedAt, p.endedAt, p.reason])).toEqual([
      ['check_in', 0, 10, null],
      ['active', 10, 40, null],
      ['disconnected', 40, 100, 'browser_not_returned'],
    ]);
    expect(split[1].id).toBe('active10');
  });

  it('a hold begun while the browser was gone: only the active tail before the hold becomes unobserved', () => {
    const periods = [P('active', 0, 50), P('on_hold', 50, 90)];
    const split = withUnobservedOutages(periods, unobservedOutages([out('a', 30, 90, 'session_end')], [], 90));
    expect(split.map((p) => [p.kind, p.startedAt, p.endedAt])).toEqual([
      ['active', 0, 30],
      ['disconnected', 30, 50],
      ['on_hold', 50, 90],
    ]);
  });

  it('an ongoing outage leaves an open unobserved period at the end of the open active period', () => {
    const split = withUnobservedOutages([P('active', 0, null)], unobservedOutages([out('a', 30, null)], [], 80));
    expect(split.map((p) => [p.kind, p.startedAt, p.endedAt, p.reason])).toEqual([
      ['active', 0, 30, null],
      ['disconnected', 30, null, 'browser_not_reporting'],
    ]);
  });
});

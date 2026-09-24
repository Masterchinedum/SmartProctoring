/**
 * Final session report: exact period totals with a controlled clock, observational narrative,
 * limitations, counts and notable events.
 */
import type { PeriodDTO, SessionReportDTO } from '@sp/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { periodTotals, unionDurationMs } from '../../src/services/reports.js';
import { hb, runCheck, sample, startedSession } from '../flow.js';
import { createTestEnv, type TestEnv } from '../helpers.js';
import { clientEvent, json, MIN, screenshot, staffApi, type Api } from './fixtures.js';

let env: TestEnv;
let reviewer: Api;
let report: SessionReportDTO;
let marks: { checkInStart: number; started: number; paused: number; resumeCheck: number; resumed: number; ended: number };
let flagId: string;
let dismissedId: string;

beforeAll(async () => {
  env = await createTestEnv();
  reviewer = await staffApi(env, 'reviewer');
  const c = env.candidateClient();
  const checkInStart = env.clock.t;
  await startedSession(env, c);
  const started = env.clock.t;
  env.clock.advance(10 * MIN);
  flagId = await clientEvent(c, { type: 'multiple_people', startedAt: env.clock.t - 60_000, endedAt: env.clock.t - 48_000, confidence: 0.87 });
  await screenshot(c, flagId, env.clock.t - 55_000, { person: 'alice', faces: 2 });
  dismissedId = await clientEvent(c, { type: 'phone_detected', startedAt: env.clock.t - 40_000, endedAt: env.clock.t - 37_000, confidence: 0.55 });
  await clientEvent(c, { type: 'tab_hidden', startedAt: env.clock.t - 30_000, endedAt: env.clock.t - 25_000, confidence: 1 });
  await clientEvent(c, { type: 'tab_hidden', startedAt: env.clock.t - 20_000, endedAt: env.clock.t - 5_000, confidence: 1 });
  await clientEvent(c, { type: 'monitoring_degraded', startedAt: env.clock.t - 200_000, endedAt: env.clock.t - 20_000, confidence: 1 });
  expect(json(await sample(env, c, { person: 'alice' })).result.decision).toBe('match');
  json(await hb(c));
  // Pause of exactly 7 minutes (the paused period ends when the resume check starts).
  const paused = env.clock.t;
  expect(json(await c.req('POST', '/api/candidate/pause', { reason: 'Fire alarm, test' })).outcome).toBe('paused');
  env.clock.advance(7 * MIN);
  const resumeCheck = env.clock.t;
  expect((await runCheck(env, c, 'resume')).complete!.outcome).toBe('passed');
  const resumed = env.clock.t;
  env.clock.advance(15 * MIN);
  for (let i = 0; i < 3; i++) {
    expect(json(await sample(env, c, { person: 'alice' })).result.decision).toBe('match');
    env.clock.advance(30_000);
  }
  const ended = env.clock.t;
  json(await c.req('POST', '/api/candidate/submit'));
  marks = { checkInStart, started, paused, resumeCheck, resumed, ended };

  json(await reviewer.post(`/events/${dismissedId}/review`, { status: 'dismissed', note: 'A calculator' }));
  json(await reviewer.post(`/events/${flagId}/review`, { status: 'reviewed' }));
  json(await reviewer.post(`/sessions/${env.session.id}/notes`, { text: 'Reviewed with the invigilator.' }));
  report = json(await reviewer.get(`/sessions/${env.session.id}/report`));
});
afterAll(async () => env?.close());

describe('session report totals', () => {
  it('computes exact paused / unobserved / active time from the periods', () => {
    const t = report.totals;
    expect(t.pausedMs).toBe(7 * MIN);
    expect(t.unobservedMs).toBe(7 * MIN);
    expect(t.disconnectedMs).toBe(0);
    expect(t.heldMs).toBe(0);
    expect(t.pauseCount).toBe(1);
    const activeExpected = marks.paused - marks.started + (marks.ended - marks.resumed);
    expect(t.activeMs).toBe(activeExpected);
    // the clock stops during pauses (policy default) -> exam time used == active time
    expect(t.examTimeUsedMs).toBe(activeExpected);
    expect(t.wallClockMs).toBe(marks.ended - marks.checkInStart);
    const periods = report.periods;
    const dur = (p: PeriodDTO) => p.endedAt! - p.startedAt;
    const observed = periods.filter((p) => p.observed).reduce((s, p) => s + dur(p), 0);
    expect(t.observedMs).toBe(observed);
    expect(t.observedMs + t.unobservedMs).toBeLessThanOrEqual(t.wallClockMs);
    expect(periods.map((p) => p.kind)).toEqual(['check_in', 'active', 'paused', 'resume_check', 'active']);
    expect(periods.find((p) => p.kind === 'paused')).toMatchObject({ startedAt: marks.paused, endedAt: marks.resumeCheck });
  });

  it('counts events per category with review status and per type', () => {
    expect(report.eventCounts.integrity).toEqual({ total: 4, dismissed: 1, reviewed: 1, unreviewed: 2 });
    expect(report.eventCounts.technical).toEqual({ total: 1, dismissed: 0, reviewed: 0, unreviewed: 1 });
    expect(report.eventCounts.neutral.total).toBeGreaterThan(3);
    const tab = report.byType.find((b) => b.type === 'tab_hidden')!;
    expect(tab).toMatchObject({ title: 'Left the exam tab', category: 'integrity', count: 2, totalDurationMs: 20_000, dismissed: 0 });
    expect(report.byType.find((b) => b.type === 'phone_detected')).toMatchObject({ count: 1, dismissed: 1 });
    expect(report.byType[0].category).toBe('integrity');
  });

  it('lists notable events (integrity + uncertain, not dismissed) by severity, with evidence', () => {
    expect(report.notableEvents.map((e) => e.type)).toEqual(['multiple_people', 'tab_hidden', 'tab_hidden']);
    expect(report.notableEvents[0].evidence).toHaveLength(1);
    expect(report.notableEvents.map((e) => e.id)).not.toContain(dismissedId);
  });

  it('summarises identity checks factually', () => {
    expect(report.identity.referenceCreatedAt).toEqual(expect.any(Number));
    expect(report.identity.mismatches).toBe(0);
    expect(report.identity.matches).toBe(report.identity.checks);
    expect(report.identity.summary).toBe('The person in view matched the identity reference at check-in, after 1 resume and 4 routine checks.');
  });

  it('writes observations about pauses ("not observed"), behaviour and delivery, without accusations', () => {
    const text = report.observations.join('\n');
    expect(text).toMatch(/^The exam started at \d\d:\d\d UTC and was submitted by the candidate at \d\d:\d\d UTC\.$/m);
    expect(text).toMatch(/Paused at \d\d:\d\d UTC for 7m 00s \(reason given: “Fire alarm, test”; the exam clock was stopped\) and resumed at \d\d:\d\d UTC after the readiness and identity checks; this period was not observed\./);
    expect(text).toMatch(/More than one person in view at \d\d:\d\d UTC for 12s \(confidence 87%\)\./);
    expect(text).toMatch(/Left the exam tab: 2 times, 20s in total; the longest began at \d\d:\d\d UTC and lasted 15s\.$/m);
    expect(text).not.toMatch(/Phone visible/); // dismissed
    expect(text).toMatch(/identity checks were recorded: \d+ matched\./);
    expect(text).not.toMatch(/cheat|violation|guilty|fraud/i);
    expect(report.reviewerNotes.map((n) => n.text)).toEqual(['Reviewed with the invigilator.']);
    expect(report.score).toMatchObject({ maxPoints: 10, autoGraded: false });
  });

  it('lists fixed and session-specific limitations', () => {
    const text = report.limitations.join('\n');
    expect(text).toMatch(/cannot observe other monitors, other devices, or the room outside the camera’s view/);
    expect(text).toMatch(/No observations were made during unobserved periods: pause at \d\d:\d\d UTC \(7m 00s\)\./);
    expect(text).toMatch(/probabilistic/);
    expect(text).toMatch(/“Unable to verify” .* not evidence of a different person/);
    expect(text).toMatch(/Camera analysis was degraded for 3m 00s on this device/);
  });

  it('includes session, exam and candidate headers', () => {
    expect(report.generatedAt).toBe(env.clock.t);
    expect(report.session).toMatchObject({ id: env.session.id, status: 'submitted' });
    expect(report.exam).toEqual({ id: env.exam.id, title: 'Sample Exam', durationSec: 3600 });
    expect(report.candidate).toMatchObject({ id: env.candidate.id, name: 'Alice Candidate' });
  });

  it('works for a session that has not started', async () => {
    const cand = await env.newCandidate('Nora NotStarted');
    const s = await env.newSession({ candidateId: cand.id });
    const r = json<SessionReportDTO>(await reviewer.get(`/sessions/${s.id}/report`));
    expect(r.totals).toMatchObject({ wallClockMs: 0, observedMs: 0, unobservedMs: 0, pauseCount: 0, examTimeUsedMs: 0 });
    expect(r.identity.summary).toMatch(/No identity reference has been established yet/);
    expect(r.observations[0]).toMatch(/has not completed the readiness check/);
    expect(r.limitations.join('\n')).toMatch(/no unobserved periods/);
  });
});

describe('period arithmetic', () => {
  const P = (kind: PeriodDTO['kind'], startedAt: number, endedAt: number | null): PeriodDTO => ({ id: `${kind}${startedAt}`, kind, observed: ['check_in', 'active', 'resume_check'].includes(kind), startedAt, endedAt, reason: null, meta: {} });

  it('gives unobserved periods precedence when periods overlap and clips open periods at the end', () => {
    // active 0..100 with a retroactive disconnected 40..60 inside it; open paused from 100.
    const t = periodTotals([P('active', 0, 100), P('disconnected', 40, 60), P('paused', 100, null)], 130);
    expect(t.byKind.active).toBe(80);
    expect(t.byKind.disconnected).toBe(20);
    expect(t.byKind.paused).toBe(30);
    expect(t.observedMs).toBe(80);
    expect(t.unobservedMs).toBe(50);
    expect(t.uncoveredMs).toBe(0);
  });

  it('reports gaps between periods separately', () => {
    const t = periodTotals([P('check_in', 0, 10), P('active', 50, 70)], 70);
    expect(t.observedMs).toBe(30);
    expect(t.uncoveredMs).toBe(40);
  });

  it('merges overlapping event spans', () => {
    const e = (s: number, end: number) => ({ startedAt: s, durationMs: end - s, status: 'closed' }) as never;
    expect(unionDurationMs([e(0, 10), e(5, 20), e(30, 40)], 100)).toBe(30);
  });
});

describe('report: disconnections and holds', () => {
  it('accounts a reconnect gap as disconnected (not observed) and describes a hold released with a fresh check', async () => {
    const cand = await env.newCandidate('Rex Reconnect');
    const s = await env.newSession({ candidateId: cand.id });
    const c = await startedSession(env, env.candidateClient(s.token));
    env.clock.advance(MIN);
    json(await hb(c));
    const lastHeartbeat = env.clock.t;
    // The browser crashes; 2 minutes later the candidate reopens the link in a new browser.
    env.clock.advance(2 * MIN);
    const c2 = c.withInstance(`inst-new-${Date.now()}`);
    const reconnectStart = env.clock.t;
    expect((await runCheck(env, c2, 'reconnect')).complete!.outcome).toBe('passed');
    env.clock.advance(MIN);
    // Staff hold the exam, then release it requiring a fresh identity check, which the candidate passes.
    json(await reviewer.post(`/sessions/${s.id}/hold`, { note: 'Phone call to candidate' }));
    env.clock.advance(4 * MIN);
    json(await reviewer.post(`/sessions/${s.id}/release`, { requireCheck: true }));
    env.clock.advance(30_000);
    expect((await runCheck(env, c2, 'reverify')).complete!.outcome).toBe('passed');
    env.clock.advance(MIN);
    json(await c2.req('POST', '/api/candidate/submit'));

    const r = json<SessionReportDTO>(await reviewer.get(`/sessions/${s.id}/report`));
    const disc = r.periods.find((p) => p.kind === 'disconnected')!;
    expect(disc).toMatchObject({ startedAt: lastHeartbeat, endedAt: reconnectStart, observed: false });
    expect(r.totals.disconnectedMs).toBe(2 * MIN);
    const held = r.periods.find((p) => p.kind === 'on_hold')!;
    expect(r.totals.heldMs).toBe(held.endedAt! - held.startedAt);
    expect(r.totals.heldMs).toBeGreaterThanOrEqual(4 * MIN + 30_000);
    expect(r.totals.unobservedMs).toBe(r.totals.disconnectedMs + r.totals.heldMs);
    const text = r.observations.join('\n');
    expect(text).toMatch(/The candidate’s browser was disconnected from \d\d:\d\d UTC to \d\d:\d\d UTC \(2m 00s\); this period was not observed\./);
    expect(text).toMatch(/The exam was on hold from \d\d:\d\d UTC for \d+m \d\ds because a staff member placed it on hold; a staff member released the hold at \d\d:\d\d UTC and required a fresh identity check and the candidate passed the identity check at \d\d:\d\d UTC\. This period was not observed\./);
    expect(r.limitations.join('\n')).toMatch(/No observations were made during unobserved periods: disconnection at \d\d:\d\d UTC \(2m 00s\) and hold at \d\d:\d\d UTC/);
    expect(r.identity.summary).toMatch(/^The person in view matched the identity reference at check-in, after 2 reconnections or re-verifications/);
  });
});

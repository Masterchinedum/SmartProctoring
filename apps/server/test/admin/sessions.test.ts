/**
 * Staff API: dashboard, session list/detail, timeline, events (filters, CSV), notes, review decisions and
 * lifecycle actions.
 */
import type { EventDTO, PeriodDTO, SessionSummaryDTO, TimelineItemDTO } from '@sp/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, examSessions } from '../../src/db/schema.js';
import { compareTimelineItems, mergeTimeline } from '../../src/services/reports-timeline.js';
import { consent, hb, runCheck, startedSession } from '../flow.js';
import { createTestEnv, type CandidateClient, type TestEnv } from '../helpers.js';
import { clientEvent, json, MIN, screenshot, staffApi, type Api } from './fixtures.js';

let env: TestEnv;
let reviewer: Api;
let admin: Api;
let c: CandidateClient;
let flagId: string;
let tabId: string;

beforeAll(async () => {
  env = await createTestEnv();
  reviewer = await staffApi(env, 'reviewer');
  admin = await staffApi(env, 'admin');
  // Main session: started, one flag with a screenshot, a tab switch, then paused and resumed.
  c = await startedSession(env);
  env.clock.advance(2 * MIN);
  flagId = await clientEvent(c, { type: 'multiple_people', startedAt: env.clock.t - 30_000, endedAt: env.clock.t - 18_000, confidence: 0.87 });
  await screenshot(c, flagId, env.clock.t - 25_000, { person: 'alice', faces: 2 });
  tabId = await clientEvent(c, { type: 'tab_hidden', startedAt: env.clock.t - 10_000, endedAt: env.clock.t - 4_000, confidence: 1 });
  expect(json(await c.req('POST', '/api/candidate/pause', { reason: 'Bathroom' })).outcome).toBe('paused');
  env.clock.advance(3 * MIN);
  expect((await runCheck(env, c, 'resume')).complete!.outcome).toBe('passed');
  env.clock.advance(MIN);
});
afterAll(async () => env?.close());

describe('dashboard', () => {
  it('lists live and recently ended sessions, non-neutral recent events with names, pending pause requests and holds', async () => {
    // A finished session (ended 2 h ago -> included) and one that ended 30 h ago (excluded).
    const oldCand = await env.newCandidate('Olga Old');
    const old = await env.newSession({ candidateId: oldCand.id });
    const oc = await startedSession(env, env.candidateClient(old.token));
    json(await oc.req('POST', '/api/candidate/submit'));
    env.clock.advance(28 * 60 * MIN);
    const recentCand = await env.newCandidate('Rita Recent');
    const recent = await env.newSession({ candidateId: recentCand.id });
    const rc = await startedSession(env, env.candidateClient(recent.token));
    json(await rc.req('POST', '/api/candidate/submit'));
    env.clock.advance(2 * 60 * MIN);
    // Staff cookies expire after 8 idle hours of (test) clock time: mint fresh ones after the jump.
    reviewer = await staffApi(env, 'reviewer');
    admin = await staffApi(env, 'admin');

    // Pending pause request (exam requiring approval) and a staff hold.
    const { exam: approvalExam } = await env.newExam({ title: 'Approval Exam', policy: { pause: { requireApproval: true } } });
    const pCand = await env.newCandidate('Paula Pending');
    const p = await env.newSession({ examId: approvalExam.id, candidateId: pCand.id });
    const pc = await startedSession(env, env.candidateClient(p.token));
    expect(json(await pc.req('POST', '/api/candidate/pause', { reason: 'Doorbell' })).outcome).toBe('pending_approval');
    const hCand = await env.newCandidate('Hugo Held');
    const h = await env.newSession({ candidateId: hCand.id });
    await startedSession(env, env.candidateClient(h.token));
    json(await reviewer.post(`/sessions/${h.id}/hold`, { note: 'Checking something' }));
    const reviewerFresh = reviewer;

    const d = json(await reviewerFresh.get('/dashboard'));
    expect(d.serverTime).toBe(env.clock.t);
    const ids = d.sessions.map((s: SessionSummaryDTO) => s.id);
    expect(ids).toEqual(expect.arrayContaining([env.session.id, recent.id, p.id, h.id]));
    expect(ids).not.toContain(old.id);
    expect(d.recentEvents.length).toBeGreaterThanOrEqual(2);
    expect(d.recentEvents.every((e: EventDTO) => e.category !== 'neutral')).toBe(true);
    const flag = d.recentEvents.find((e: EventDTO) => e.id === flagId);
    expect(flag).toMatchObject({ candidateName: 'Alice Candidate', examTitle: 'Sample Exam', type: 'multiple_people' });
    expect(flag.evidence).toHaveLength(1);
    // newest arrival first
    const arrival = d.recentEvents.map((e: EventDTO) => e.receivedAt);
    expect(arrival).toEqual([...arrival].sort((a, b) => b - a));
    expect(d.pending.pauseRequests).toHaveLength(1);
    expect(d.pending.pauseRequests[0]).toMatchObject({ sessionId: p.id, candidateName: 'Paula Pending', examTitle: 'Approval Exam', request: { status: 'pending', reason: 'Doorbell' } });
    expect(d.pending.holds).toEqual([{ sessionId: h.id, candidateName: 'Hugo Held', examTitle: 'Sample Exam', hold: expect.objectContaining({ reason: 'staff' }) }]);

    // Staff approve the pause from the dashboard -> paused.
    const summary = json(await reviewerFresh.post(`/sessions/${p.id}/pause-requests/${d.pending.pauseRequests[0].request.id}/decision`, { approve: true, note: 'OK' }));
    expect(summary.status).toBe('paused');
    const again = await reviewerFresh.post(`/sessions/${p.id}/pause-requests/${d.pending.pauseRequests[0].request.id}/decision`, { approve: false });
    expect(again.statusCode).toBe(409);
  });
});

describe('session list', () => {
  it('filters by status, exam, connection and text, with paging and totals', async () => {
    const all = json(await reviewer.get('/sessions', { limit: 100 }));
    expect(all.total).toBe(all.items.length);
    expect(all.total).toBe(5);
    const active = json(await reviewer.get('/sessions', { status: 'active' }));
    expect(active.items.every((s: SessionSummaryDTO) => s.status === 'active')).toBe(true);
    const multi = json(await reviewer.get('/sessions', { status: 'active,on_hold' }));
    expect(multi.total).toBe(active.total + json(await reviewer.get('/sessions', { status: 'on_hold' })).total);
    expect((await reviewer.get('/sessions', { status: 'nonsense' })).statusCode).toBe(400);
    expect((await reviewer.get('/sessions', { examId: 'nope' })).statusCode).toBe(400);

    const byText = json(await reviewer.get('/sessions', { q: 'paula' }));
    expect(byText.items.map((s: SessionSummaryDTO) => s.candidate.name)).toEqual(['Paula Pending']);
    const byTitle = json(await reviewer.get('/sessions', { q: 'approval exam' }));
    expect(byTitle.total).toBe(1);
    const wildcard = json(await reviewer.get('/sessions', { q: '%' }));
    expect(wildcard.total).toBe(0);
    const byEmail = json(await reviewer.get('/sessions', { q: 'hugo@candidate' }));
    expect(byEmail.total).toBe(1);

    const byExam = json(await reviewer.get('/sessions', { examId: env.exam.id, limit: 100 }));
    expect(byExam.items.every((s: SessionSummaryDTO) => s.exam.id === env.exam.id)).toBe(true);
    const never = json(await reviewer.get('/sessions', { connection: 'never_connected' }));
    expect(never.items.every((s: SessionSummaryDTO) => s.connection === 'never_connected')).toBe(true);

    const page1 = json(await reviewer.get('/sessions', { limit: 2, offset: 0 }));
    const page2 = json(await reviewer.get('/sessions', { limit: 2, offset: 2 }));
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(all.total);
    expect(page2.items.map((s: SessionSummaryDTO) => s.id)).not.toContain(page1.items[0].id);
  });
});

describe('session detail and timeline', () => {
  it('returns the full detail DTO', async () => {
    const d = json(await reviewer.get(`/sessions/${env.session.id}`));
    expect(d.summary).toMatchObject({ id: env.session.id, status: 'active', pauseCount: 1, candidate: { name: 'Alice Candidate' } });
    expect(d.policy.pause.timerBehavior).toBe('stop');
    expect(d.periods.map((p: PeriodDTO) => p.kind)).toEqual(['check_in', 'active', 'paused', 'resume_check', 'active']);
    expect(d.periods.find((p: PeriodDTO) => p.kind === 'paused')).toMatchObject({ observed: false, reason: 'Bathroom' });
    expect(d.identityChecks.length).toBeGreaterThanOrEqual(2);
    expect(d.references).toHaveLength(1);
    expect(d.references[0].images.length).toBeGreaterThan(0);
    expect(d.devices.length).toBeGreaterThanOrEqual(2);
    expect(d.consent.acceptedAt).toEqual(expect.any(Number));
    expect(d.consent.noticeVersion).toEqual(expect.any(String));
    expect(d.score).toBeNull();
    expect(Array.isArray(d.pauseRequests)).toBe(true);
  });

  it('merges periods, events and identity checks in a deterministic chronological order', async () => {
    const t1 = json(await reviewer.get(`/sessions/${env.session.id}/timeline`)).items as TimelineItemDTO[];
    const t2 = json(await reviewer.get(`/sessions/${env.session.id}/timeline`)).items as TimelineItemDTO[];
    const key = (i: TimelineItemDTO) => `${i.kind}:${i.kind === 'period' ? i.period.id : i.kind === 'event' ? i.event.id : i.check.id}`;
    expect(t1.map(key)).toEqual(t2.map(key));
    for (let i = 1; i < t1.length; i++) expect(compareTimelineItems(t1[i - 1], t1[i])).toBeLessThanOrEqual(0);
    const kinds = new Set(t1.map((i) => i.kind));
    expect(kinds).toEqual(new Set(['period', 'event', 'identity_check']));
    // At the pause instant the paused period comes before the session_paused event.
    const paused = t1.findIndex((i) => i.kind === 'period' && i.period.kind === 'paused');
    const pausedEv = t1.findIndex((i) => i.kind === 'event' && i.event.type === 'session_paused');
    expect(t1[paused].at).toBe(t1[pausedEv].at);
    expect(paused).toBeLessThan(pausedEv);
    // Periods appear in order, the flag and tab switch before the pause.
    const flag = t1.findIndex((i) => i.kind === 'event' && i.event.id === flagId);
    expect(flag).toBeLessThan(paused);
  });

  it('orders equal timestamps deterministically: period, event (arrival), identity check', () => {
    const period = { id: 'p1', kind: 'active', observed: true, startedAt: 1000, endedAt: null, reason: null, meta: {} } as PeriodDTO;
    const ev = (id: string) => ({ id, startedAt: 1000 }) as EventDTO;
    const check = { id: 'c1', at: 1000 } as never;
    const order = new Map([
      ['e-b', 0],
      ['e-a', 1],
    ]);
    const merged = mergeTimeline([period], [ev('e-a'), ev('e-b')], [check], order);
    expect(merged.map((i) => (i.kind === 'period' ? 'p1' : i.kind === 'event' ? i.event.id : 'c1'))).toEqual(['p1', 'e-b', 'e-a', 'c1']);
    const noOrder = mergeTimeline([period], [ev('e-b'), ev('e-a')], [check]);
    expect(noOrder.map((i) => (i.kind === 'event' ? i.event.id : i.kind))).toEqual(['period', 'e-a', 'e-b', 'identity_check']);
  });
});

describe('events: filters, CSV, review, notes', () => {
  it('filters session events by category, type, severity, review status and since', async () => {
    const sid = env.session.id;
    const all = json(await reviewer.get(`/sessions/${sid}/events`)).items as EventDTO[];
    const starts = all.map((e) => e.startedAt);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    const integrity = json(await reviewer.get(`/sessions/${sid}/events`, { category: 'integrity' })).items as EventDTO[];
    expect(integrity.map((e) => e.id).sort()).toEqual([flagId, tabId].sort());
    expect(json(await reviewer.get(`/sessions/${sid}/events`, { type: 'tab_hidden' })).items.map((e: EventDTO) => e.id)).toEqual([tabId]);
    expect(json(await reviewer.get(`/sessions/${sid}/events`, { type: 'tab_hidden,multiple_people' })).items).toHaveLength(2);
    expect(json(await reviewer.get(`/sessions/${sid}/events`, { type: 'no_such_type' })).items).toHaveLength(0);
    expect(json(await reviewer.get(`/sessions/${sid}/events`, { severity: 'high' })).items.map((e: EventDTO) => e.id)).toEqual([flagId]);
    expect(json(await reviewer.get(`/sessions/${sid}/events`, { review: 'unreviewed', category: 'neutral' })).items.length).toBeGreaterThan(0);
    const since = json(await reviewer.get(`/sessions/${sid}/events`, { since: env.clock.t + 1 })).items;
    expect(since).toHaveLength(0);
    expect((await reviewer.get(`/sessions/${sid}/events`, { category: 'bogus' })).statusCode).toBe(400);
  });

  it('reviews and dismisses events with notes, audit entries and realtime-visible state', async () => {
    const r1 = json(await reviewer.post(`/events/${flagId}/review`, { status: 'reviewed', note: 'Second person is a poster' }));
    expect(r1.review).toMatchObject({ status: 'reviewed', by: env.users.reviewer.id, byName: 'Test reviewer', note: 'Second person is a poster', at: env.clock.t });
    const r2 = json(await reviewer.post(`/events/${tabId}/review`, { status: 'dismissed' }));
    expect(r2.review.status).toBe('dismissed');
    const r3 = json(await reviewer.post(`/events/${tabId}/review`, { status: 'unreviewed' }));
    expect(r3.review).toMatchObject({ status: 'unreviewed', by: null, at: null, note: null });
    json(await reviewer.post(`/events/${tabId}/review`, { status: 'dismissed', note: 'Notification popup' }));
    expect((await reviewer.post(`/events/${tabId}/review`, { status: 'maybe' })).statusCode).toBe(400);

    const note = json(await reviewer.post(`/events/${flagId}/notes`, { text: '  Called the candidate.  ' }));
    expect(note).toMatchObject({ eventId: flagId, sessionId: env.session.id, authorName: 'Test reviewer', text: 'Called the candidate.' });
    expect((await reviewer.post(`/events/${flagId}/notes`, { text: '   ' })).statusCode).toBe(400);
    expect(json(await reviewer.get(`/events/${flagId}/notes`)).items).toHaveLength(1);
    const ev = json(await reviewer.get(`/events/${flagId}`));
    expect(ev.notesCount).toBe(1);
    env.clock.advance(1000);
    const sessionNote = json(await reviewer.post(`/sessions/${env.session.id}/notes`, { text: 'Overall fine.' }));
    expect(sessionNote.eventId).toBeNull();
    const detail = json(await reviewer.get(`/sessions/${env.session.id}`));
    expect(detail.notes.map((n: { text: string }) => n.text)).toEqual(['Called the candidate.', 'Overall fine.']);
    // dismissed events drop out of the summary counts
    expect(detail.summary.counts.integrity).toBe(1);

    const audits = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'event.review'), eq(auditLog.targetId, tabId)));
    expect(audits.map((a) => a.meta)).toEqual([
      expect.objectContaining({ from: 'unreviewed', to: 'dismissed' }),
      expect.objectContaining({ from: 'dismissed', to: 'unreviewed' }),
      expect.objectContaining({ from: 'unreviewed', to: 'dismissed', note: 'Notification popup' }),
    ]);
    const noteAudit = await env.ctx.db.select().from(auditLog).where(eq(auditLog.action, 'note.created'));
    expect(noteAudit).toHaveLength(2);

    // org-wide feed with filters
    const feed = json(await reviewer.get('/events', { review: 'dismissed' })).items;
    expect(feed.map((e: EventDTO) => e.id)).toEqual([tabId]);
    expect(feed[0]).toMatchObject({ candidateName: 'Alice Candidate', examTitle: 'Sample Exam' });
    const neutral = json(await reviewer.get('/events', { category: 'neutral', limit: 5 })).items;
    expect(neutral).toHaveLength(5);
    expect(json(await reviewer.get('/events')).items.every((e: EventDTO) => e.category !== 'neutral')).toBe(true);
  });

  it('exports events as CSV with proper escaping', async () => {
    const tricky = 'He said "hi", then left\nand =cmd|calc came back';
    const id = await clientEvent(c, { type: 'looking_away', startedAt: env.clock.t - 9_000, endedAt: env.clock.t - 2_500, confidence: 0.734567, observation: tricky });
    const res = await reviewer.get(`/sessions/${env.session.id}/events.csv`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="session-${env.session.id}-events.csv"`);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const body = res.body;
    expect(body.startsWith('﻿id,type,category,severity,title,observation,startedAt,endedAt,durationSec,confidence,reviewStatus,reviewedBy,deliveredLate,evidenceCount\r\n')).toBe(true);
    const row = body.split('\r\n').find((l) => l.startsWith(id))!;
    expect(row).toBeDefined();
    const endAt = new Date(env.clock.t - 2_500).toISOString();
    expect(body).toContain(
      `${id},looking_away,integrity,low,Sustained looking away,"He said ""hi"", then left\nand =cmd|calc came back",${new Date(env.clock.t - 9_000).toISOString()},${endAt},6.5,0.7346,unreviewed,,false,0\r\n`,
    );
    const flagRow = body.split('\r\n').find((l) => l.startsWith(flagId))!;
    expect(flagRow).toMatch(/,reviewed,Test reviewer,false,1$/);
    // filters apply to the CSV too
    const filtered = await reviewer.get(`/sessions/${env.session.id}/events.csv`, { type: 'tab_hidden' });
    expect(filtered.body.trim().split('\r\n')).toHaveLength(2);
  });
});

describe('lifecycle actions', () => {
  it('hold, release, extend, legal hold, regenerate link, staff submit and terminate go through session actions', async () => {
    const cand = await env.newCandidate('Leo Lifecycle');
    const s = await env.newSession({ candidateId: cand.id });
    const lc = await startedSession(env, env.candidateClient(s.token));
    const held = json(await reviewer.post(`/sessions/${s.id}/hold`, { note: 'Manual check' }));
    expect(held).toMatchObject({ status: 'on_hold', hold: { reason: 'staff' }, timerRunning: false });
    const released = json(await reviewer.post(`/sessions/${s.id}/release`, { requireCheck: false }));
    expect(released).toMatchObject({ status: 'active', hold: null, timerRunning: true });
    expect((await reviewer.post(`/sessions/${s.id}/release`, {})).statusCode).toBe(409);

    const before = released.remainingMs;
    const ext = json(await admin.post(`/sessions/${s.id}/extend`, { minutes: 15, note: 'Accommodation' }));
    expect(ext.remainingMs).toBe(before + 15 * MIN);
    expect((await admin.post(`/sessions/${s.id}/extend`, { minutes: 0 })).statusCode).toBe(400);

    const lh = json(await admin.post(`/sessions/${s.id}/legal-hold`, { enabled: true }));
    expect(lh.legalHold).toBe(true);
    const [row] = await env.ctx.db.select().from(examSessions).where(eq(examSessions.id, s.id));
    expect(row.legalHold).toBe(true);

    const link = json(await admin.post(`/sessions/${s.id}/regenerate-link`));
    expect(link.accessLink).toMatch(/^http:\/\/exam\.test\/take\//);
    expect(link.accessLink).not.toBe(s.link);
    expect((await lc.req('GET', '/api/candidate/session')).statusCode).toBe(401);
    const newToken = link.accessLink.split('/take/')[1];
    const nc = env.candidateClient(newToken, lc.instanceId);
    expect((await nc.req('GET', '/api/candidate/session')).statusCode).toBe(200);
    expect(json(await hb(nc)).status).toBe('active');

    const submitted = json(await admin.post(`/sessions/${s.id}/submit`, { note: 'Time is up (room closing)' }));
    expect(submitted).toMatchObject({ status: 'submitted', endReason: 'staff_submitted' });
    expect((await admin.post(`/sessions/${s.id}/terminate`, { reason: 'x' })).statusCode).toBe(409);

    const cand2 = await env.newCandidate('Tom Terminated');
    const s2 = await env.newSession({ candidateId: cand2.id });
    await consent(env.candidateClient(s2.token));
    expect((await admin.post(`/sessions/${s2.id}/terminate`, {})).statusCode).toBe(400);
    const term = json(await admin.post(`/sessions/${s2.id}/terminate`, { reason: 'Withdrawn from the exam' }));
    expect(term).toMatchObject({ status: 'terminated', endReason: 'staff_terminated' });

    const actions = (await env.ctx.db.select().from(auditLog).where(eq(auditLog.targetId, s.id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['session.hold', 'session.release', 'session.time_extended', 'session.legal_hold_on', 'session.link_regenerated', 'session.staff_submit']));
  });
});

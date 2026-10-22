/**
 * The per-exam "Require a single display" rule (policy.browser.requireSingleDisplay): the start is refused while the
 * browser reports more than one display (session-state.ts startExam), a display connected during the exam puts it on
 * hold for staff (ingest.ts), a browser that cannot tell is not held back (the unknown display count is recorded), the
 * assistive-technology accommodation waives it, and without the rule nothing changes.
 */
import { randomUUID } from 'node:crypto';
import type { AccommodationDTO, CandidateSessionState, SessionDetailDTO, SessionReportDTO, SessionSummaryDTO } from '@sp/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { events, examSessions } from '../src/db/schema.js';
import { json, staffApi, type Api } from './admin/fixtures.js';
import { consent, DEVICE, runCheck } from './flow.js';
import { createTestEnv, type CandidateClient, type TestEnv } from './helpers.js';

let env: TestEnv;
let admin: Api;
let ruleExamId: string;

beforeAll(async () => {
  env = await createTestEnv();
  ruleExamId = (await env.newExam({ title: 'Single display exam', policy: { browser: { requireSingleDisplay: true } } })).exam.id;
});
// Staff cookies expire after an hour of test-clock time: a fresh one per test.
beforeEach(async () => {
  admin = await staffApi(env, 'admin');
});
afterAll(async () => env?.close());

const row = async (id: string) => (await env.ctx.db.select().from(examSessions).where(eq(examSessions.id, id)))[0];
const eventsOf = (id: string, type: string) =>
  env.ctx.db
    .select()
    .from(events)
    .where(and(eq(events.sessionId, id), eq(events.type, type as never)))
    .orderBy(asc(events.startedAt));
const device = (isExtended: boolean | null) => ({ ...DEVICE, screen: { ...DEVICE.screen, isExtended } });
const start = (c: CandidateClient, screen?: { isExtended: boolean | null }) => c.req('POST', '/api/candidate/start', screen ? { screen: { width: 1920, height: 1080, ...screen } } : undefined);
const displayMarker = () => ({
  id: randomUUID(),
  type: 'additional_display_detected',
  phase: 'close',
  startedAt: env.clock.t,
  endedAt: env.clock.t,
  confidence: 1,
  details: { isExtended: true },
  version: 1,
});

/** A fresh candidate checked in on `examId` (ready to start); the check reported `isExtended`. */
async function readySession(examId: string, isExtended: boolean | null = false, name = 'Dana Display') {
  const cand = await env.newCandidate(name);
  const s = await env.newSession({ examId, candidateId: cand.id });
  const c = env.candidateClient(s.token);
  await consent(c);
  const { complete } = await runCheck(env, c, 'initial', { device: device(isExtended) as typeof DEVICE });
  expect(complete!.outcome).toBe('passed');
  return { s, c, cand };
}

async function startedSession(examId: string, name?: string) {
  const r = await readySession(examId, false, name);
  json(await start(r.c, { isExtended: false }));
  return r;
}

describe('before the exam starts', () => {
  it('refuses the start while the browser reports more than one display, and starts once it reports one', async () => {
    const { s, c } = await readySession(ruleExamId);
    const refused = await start(c, { isExtended: true });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'single_display_required', message: expect.stringMatching(/More than one display is connected.*disconnect any additional displays/) });
    expect(await row(s.id)).toMatchObject({ status: 'ready', startedAt: null, runningSince: null });
    expect(await eventsOf(s.id, 'session_started')).toHaveLength(0);

    const started = json<CandidateSessionState>(await start(c, { isExtended: false }));
    expect(started.session.status).toBe('active');
    const [ev] = await eventsOf(s.id, 'session_started');
    expect(ev.details).toMatchObject({ displays: 'single' });
    expect(ev.observation).toBe('The exam was started.');
  });

  it('without a display report in the start request, what this browser’s check reported decides', async () => {
    const { s, c } = await readySession(ruleExamId, true);
    // The check itself is not held back (the candidate may still disconnect the display before the start).
    expect((await row(s.id)).status).toBe('ready');
    const refused = await start(c);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('single_display_required');
    const d = json<SessionDetailDTO>(await admin.get(`/sessions/${s.id}`));
    expect(d.devices.map((x) => x.displays)).toEqual(['extended']);
    expect(json<CandidateSessionState>(await start(c, { isExtended: false })).session.status).toBe('active');
  });

  it('a browser that cannot tell is not held back; the start, the devices and the report say the display count is unknown', async () => {
    const { s, c } = await readySession(ruleExamId, null);
    expect(json<CandidateSessionState>(await start(c, { isExtended: null })).session.status).toBe('active');
    const [ev] = await eventsOf(s.id, 'session_started');
    expect(ev.details).toMatchObject({ displays: 'unknown' });
    expect(ev.observation).toMatch(/does not report how many displays are connected \(only Chrome and Edge do\)/);
    const d = json<SessionDetailDTO>(await admin.get(`/sessions/${s.id}`));
    expect(d.devices.map((x) => x.displays)).toEqual(['unknown']);
    const report = json<SessionReportDTO>(await admin.get(`/sessions/${s.id}/report`));
    expect(report.limitations.join(' ')).toMatch(/requires a single display, but the candidate’s browser does not report how many displays are connected/);
  });

  it('the assistive-technology accommodation waives the rule for that candidate (recorded as an exception)', async () => {
    const cand = await env.newCandidate('Asa Assistive');
    json<AccommodationDTO>(await admin.post(`/candidates/${cand.id}/accommodations`, { kind: 'assistive_technology', basis: 'accessibility' }));
    const s = await env.newSession({ examId: ruleExamId, candidateId: cand.id });
    const c = env.candidateClient(s.token);
    await consent(c);
    expect((await runCheck(env, c, 'initial', { device: device(true) as typeof DEVICE })).complete!.outcome).toBe('passed');
    expect(json<CandidateSessionState>(await start(c, { isExtended: true })).session.status).toBe('active');
    const r = await row(s.id);
    expect((r.policy as { browser: { requireSingleDisplay: boolean } }).browser.requireSingleDisplay).toBe(false);
    expect(r.accommodations!.exceptions!.find((e) => e.path === 'browser.requireSingleDisplay')).toMatchObject({ from: true, to: false, kinds: ['assistive_technology'] });
    // A display connected later is recorded as before, without a hold.
    expect(json(await c.req('POST', '/api/candidate/events/batch', { events: [displayMarker()] })).results[0].result).toBe('created');
    expect((await row(s.id)).status).toBe('active');
  });
});

describe('during the exam', () => {
  it('a display connected mid-exam puts the exam on hold for staff, with a plain message; releasing it lets the candidate continue', async () => {
    const { s, c } = await startedSession(ruleExamId, 'Hal Hold');
    env.clock.advance(60_000);
    const lookingAway = { id: randomUUID(), type: 'looking_away', phase: 'open', startedAt: env.clock.t - 2_000, endedAt: null, confidence: 0.8, details: {}, version: 1 };
    const marker = displayMarker();
    const res = json(await c.req('POST', '/api/candidate/events/batch', { events: [lookingAway, marker] }));
    expect(res.results.map((r: { result: string }) => r.result)).toEqual(['created', 'created']);

    expect(await row(s.id)).toMatchObject({ status: 'on_hold', holdReason: 'additional_display', holdCanReverify: false, runningSince: null });
    const [held] = await eventsOf(s.id, 'session_held');
    expect(held.details).toMatchObject({ reason: 'additional_display', previousStatus: 'active', eventId: marker.id });
    expect(held.observation).toMatch(/more than one display is connected, and the exam allows only one/);
    const [display] = await eventsOf(s.id, 'additional_display_detected');
    expect(display).toMatchObject({ category: 'neutral', severity: 'info' });
    // The hold closed what the batch left open.
    const [away] = await eventsOf(s.id, 'looking_away');
    expect(away.status).toBe('closed');

    const state = json<CandidateSessionState>(await c.req('GET', '/api/candidate/session'));
    expect(state.session.hold).toMatchObject({ reason: 'additional_display', canReverify: false });
    expect(state.session.hold!.message).toMatch(/additional display was connected.*disconnect the additional display.*administrator will review this and release the hold/);
    expect(state.session.hold!.message).not.toMatch(/cheat|violation|suspicious/i);
    expect(state.questions).toBeNull();
    const d = json<SessionDetailDTO>(await admin.get(`/sessions/${s.id}`));
    expect(d.summary.hold?.reason).toBe('additional_display');

    env.clock.advance(120_000);
    const released = json<SessionSummaryDTO>(await admin.post(`/sessions/${s.id}/release`, { requireCheck: false, note: 'Display disconnected, confirmed by phone.' }));
    expect(released).toMatchObject({ status: 'active', hold: null });
    const [rel] = await eventsOf(s.id, 'hold_released');
    expect(rel.details).toMatchObject({ reason: 'additional_display', requireCheck: false });
    expect((await row(s.id)).runningSince).not.toBeNull();
    expect(json<CandidateSessionState>(await c.req('GET', '/api/candidate/session')).session.status).toBe('active');

    const report = json<SessionReportDTO>(await admin.get(`/sessions/${s.id}/report`));
    expect(report.observations.join(' ')).toMatch(/on hold from .* because the browser reported an additional display and the exam allows only one display; a staff member released the hold/);

    // Still connected when monitoring starts again: on hold again.
    env.clock.advance(5_000);
    json(await c.req('POST', '/api/candidate/events/batch', { events: [displayMarker()] }));
    expect(await row(s.id)).toMatchObject({ status: 'on_hold', holdReason: 'additional_display' });
    expect(await eventsOf(s.id, 'session_held')).toHaveLength(2);
  });

  it('a late or repeated delivery of the same event does not hold again; a paused exam is not held', async () => {
    const { s, c } = await startedSession(ruleExamId, 'Rita Repeat');
    const marker = displayMarker();
    json(await c.req('POST', '/api/candidate/events/batch', { events: [marker] }));
    expect((await row(s.id)).status).toBe('on_hold');
    json(await admin.post(`/sessions/${s.id}/release`, { requireCheck: false }));
    env.clock.advance(1_000);
    expect(json(await c.req('POST', '/api/candidate/events/batch', { events: [marker] })).results[0].result).toBe('stale');
    expect((await row(s.id)).status).toBe('active');

    // Paused: monitoring is stopped; a display marker from before the pause is stored, but nothing is held.
    env.clock.advance(1_000);
    const beforePause = displayMarker();
    env.clock.advance(1_000);
    expect(json(await c.req('POST', '/api/candidate/pause', {})).outcome).toBe('paused');
    expect(json(await c.req('POST', '/api/candidate/events/batch', { events: [beforePause] })).results[0].result).toBe('created');
    expect((await row(s.id)).status).toBe('paused');
    expect(await eventsOf(s.id, 'session_held')).toHaveLength(1);
  });
});

describe('without the rule', () => {
  it('today’s behaviour: the start is never refused for displays, and a connected display is a neutral event without a hold', async () => {
    const { s, c } = await readySession(env.exam.id, true, 'Olly Off');
    expect(json<CandidateSessionState>(await start(c, { isExtended: true })).session.status).toBe('active');
    const [ev] = await eventsOf(s.id, 'session_started');
    expect(ev.details).not.toHaveProperty('displays');
    expect(json(await c.req('POST', '/api/candidate/events/batch', { events: [displayMarker()] })).results[0].result).toBe('created');
    expect(await row(s.id)).toMatchObject({ status: 'active', holdReason: null });
    expect(await eventsOf(s.id, 'session_held')).toHaveLength(0);
    const report = json<SessionReportDTO>(await admin.get(`/sessions/${s.id}/report`));
    expect(report.observations.join(' ')).toMatch(/the browser reported more than one connected display; activity on other displays cannot be observed/);
    expect(report.limitations.join(' ')).not.toMatch(/single display/);
  });
});

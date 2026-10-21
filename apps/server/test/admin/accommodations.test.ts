/**
 * Accommodations (services/accommodations.ts, routes/admin/accommodations.ts): grant / revoke records, their reach
 * into unstarted sessions (snapshot, extra time), the policy each attempt runs under (frozen at start, with the exam
 * rules they changed), what staff, reports, the candidate and integrations see, and the two identity modes they can
 * switch on: identity verified by staff ('attest' checks, staff_verification holds) and no camera.
 */
import type { AccommodationDTO, CandidateSessionState, SessionDetailDTO, SessionReportDTO, StartCheckResponse } from '@sp/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accommodations, auditLog, events, examSessions, identityReferences } from '../../src/db/schema.js';
import { consent, hb, runCheck, startCheck, startedSession } from '../flow.js';
import { createTestEnv, type CandidateClient, type TestEnv } from '../helpers.js';
import { json, MIN, otherOrg, staffApi, type Api } from './fixtures.js';

let env: TestEnv;
let admin: Api;
let reviewer: Api;

beforeAll(async () => {
  env = await createTestEnv();
  admin = await staffApi(env, 'admin');
  reviewer = await staffApi(env, 'reviewer');
});
afterAll(async () => env?.close());

const sessionRow = async (id: string) => (await env.ctx.db.select().from(examSessions).where(eq(examSessions.id, id)))[0];
const grant = (candidateId: string, body: Record<string, unknown>) => admin.post(`/candidates/${candidateId}/accommodations`, { basis: 'accessibility', ...body });

async function assigned(name: string, examId = env.exam.id) {
  const cand = await env.newCandidate(name);
  const s = await env.newSession({ examId, candidateId: cand.id });
  return { cand, sessionId: s.id, c: env.candidateClient(s.token) };
}

describe('records', () => {
  it('grants, lists and revokes with validation, admin-only writes, notes for admins only, and an audit trail without the note', async () => {
    const cand = await env.newCandidate('Rita Records');
    const bad = [
      { kind: 'extra_time', params: {} },
      { kind: 'extra_time', params: { percent: 25 }, basis: 'medical' },
      { kind: 'teleport', params: {} },
      { kind: 'extra_time', params: { percent: 25 }, validUntil: env.clock.t - 1 },
      { kind: 'extra_time', params: { percent: 25 }, examId: '00000000-0000-4000-8000-000000000000' },
    ];
    for (const b of bad) expect((await grant(cand.id, b)).statusCode, JSON.stringify(b)).toBe(400);
    const other = await otherOrg(env);
    expect((await grant(cand.id, { kind: 'extra_time', params: { percent: 25 }, examId: other.exam.id })).statusCode).toBe(400);
    expect((await reviewer.post(`/candidates/${cand.id}/accommodations`, { kind: 'rest_breaks', basis: 'other' })).statusCode).toBe(403);
    expect((await other.api.post(`/candidates/${cand.id}/accommodations`, { kind: 'rest_breaks', basis: 'other' })).statusCode).toBe(404);

    const a = json<AccommodationDTO>(await grant(cand.id, { kind: 'extra_time', params: { percent: 25 }, note: 'Approved by disability services, ref 4711' }));
    expect(a).toMatchObject({ kind: 'extra_time', params: { percent: 25, minutes: 0 }, label: 'Extra time: +25 %', basis: 'accessibility', exam: null, status: 'active', note: 'Approved by disability services, ref 4711', grantedBy: { id: env.users.admin.id } });
    const [row] = await env.ctx.db.select().from(accommodations).where(eq(accommodations.id, a.id));
    expect(row.noteEnc!.toString('latin1')).not.toContain('disability'); // encrypted at rest

    expect(json(await reviewer.get(`/candidates/${cand.id}/accommodations`)).items[0]).toMatchObject({ id: a.id, note: null });
    expect(json(await admin.get(`/candidates/${cand.id}/accommodations`)).items[0].note).toBe('Approved by disability services, ref 4711');
    expect((await other.api.get(`/candidates/${cand.id}/accommodations`)).statusCode).toBe(404);

    expect((await admin.post(`/accommodations/${a.id}/revoke`, {})).statusCode).toBe(400);
    expect((await other.api.post(`/accommodations/${a.id}/revoke`, { reason: 'x' })).statusCode).toBe(404);
    const revoked = json<AccommodationDTO>(await admin.post(`/accommodations/${a.id}/revoke`, { reason: 'Entered for the wrong candidate' }));
    expect(revoked).toMatchObject({ status: 'revoked', revokedBy: { id: env.users.admin.id }, revokeReason: 'Entered for the wrong candidate' });
    expect((await admin.post(`/accommodations/${a.id}/revoke`, { reason: 'again' })).json().error).toBe('already_revoked');

    const audits = await env.ctx.db.select().from(auditLog).where(eq(auditLog.targetId, cand.id));
    expect(audits.map((x) => x.action).sort()).toEqual(['accommodation.granted', 'accommodation.revoked']);
    expect(JSON.stringify(audits.map((x) => x.meta))).not.toContain('disability services');

    const expiring = json<AccommodationDTO>(await grant(cand.id, { kind: 'rest_breaks', validUntil: env.clock.t + 1000 }));
    env.clock.advance(2000);
    const list = json(await admin.get(`/candidates/${cand.id}/accommodations`)).items as AccommodationDTO[];
    expect(list.find((x) => x.id === expiring.id)!.status).toBe('expired');
  });
});

describe('extra time and unstarted sessions', () => {
  it('follows grants and revocations until the exam starts, keeps staff extensions, and respects the exam scope', async () => {
    const { cand, sessionId } = await assigned('Ella Extra');
    expect((await sessionRow(sessionId)).durationMs).toBe(3_600_000);
    const half = json<AccommodationDTO>(await grant(cand.id, { kind: 'extra_time', params: { percent: 50 } }));
    expect(await sessionRow(sessionId)).toMatchObject({ durationMs: 5_400_000, accommodations: { extraTimeMs: 1_800_000, items: [{ id: half.id, kind: 'extra_time' }] } });
    // Another exam only: not this session.
    const { exam: other } = await env.newExam({ title: 'Other exam' });
    json(await grant(cand.id, { kind: 'extra_time', params: { minutes: 15 }, examId: other.id }));
    expect((await sessionRow(sessionId)).durationMs).toBe(5_400_000);
    // A later assignment to that exam gets it at creation.
    const s2 = await env.newSession({ examId: other.id, candidateId: cand.id });
    expect((await sessionRow(s2.id)).durationMs).toBe(3_600_000 + 1_800_000 + 15 * MIN);

    json(await admin.post(`/accommodations/${half.id}/revoke`, { reason: 'Replaced by 25 %' }));
    const s = await sessionRow(sessionId);
    expect(s.durationMs).toBe(3_600_000);
    expect(s.accommodations).toBeNull();

    // The summary carries the kinds; the candidate sees plain labels.
    json(await grant(cand.id, { kind: 'extra_time', params: { percent: 25 } }));
    expect(json(await reviewer.get(`/sessions/${sessionId}`)).summary.accommodations).toEqual(['extra_time']);
  });

  it('freezes at start: a later revocation does not change a running attempt', async () => {
    const { cand, sessionId, c } = await assigned('Fred Frozen');
    const a = json<AccommodationDTO>(await grant(cand.id, { kind: 'extra_time', params: { minutes: 30 } }));
    await startedSession(env, c);
    expect(await sessionRow(sessionId)).toMatchObject({ durationMs: 3_600_000 + 30 * MIN, status: 'active' });
    json(await admin.post(`/accommodations/${a.id}/revoke`, { reason: 'Granted in error' }));
    expect(await sessionRow(sessionId)).toMatchObject({ durationMs: 3_600_000 + 30 * MIN, accommodations: { items: [{ id: a.id }] } });
  });
});

describe('policy exceptions', () => {
  let sessionId: string;
  let c: CandidateClient;

  beforeAll(async () => {
    // An exam whose own rules are stricter than the accommodations: pauses need approval, at most one.
    const { exam } = await env.newExam({ title: 'Strict exam', policy: { pause: { requireApproval: true, maxPauses: 1 } } });
    const a = await assigned('Paula Policy', exam.id);
    sessionId = a.sessionId;
    c = a.c;
    for (const g of [
      { kind: 'rest_breaks', params: { maxPauses: 4 } },
      { kind: 'assistive_technology' },
      { kind: 'detection_exemptions', params: { lookingAway: true, movement: true } },
      { kind: 'no_liveness_challenge' },
    ]) {
      json(await grant(a.cand.id, g));
    }
  });

  it('applies before start (checks run without the head-turn challenge) and tells the candidate in plain words', async () => {
    await consent(c);
    const start = json<StartCheckResponse>(await startCheck(c, 'initial'));
    expect(start).toMatchObject({ mode: 'face', liveness: null });
    const state = json<CandidateSessionState>(await c.req('GET', '/api/candidate/session'));
    expect(state.accommodations).toEqual([
      'Rest breaks: you can pause the exam without asking; the clock stops while you are paused',
      'Assistive technology: fullscreen is not required and switching to your tools is not recorded',
      'Some camera observations are turned off (looking away, unusual movement)',
      'No head-turn challenge during camera checks',
    ]);
    expect(state.exam.policy.browser.requireFullscreen).toBe(false);
  });

  it('freezes the applied policy at start with an accommodations_applied event listing every changed rule', async () => {
    const check = await runCheck(env, c, 'initial');
    expect(check.complete!.outcome).toBe('passed');
    json(await c.req('POST', '/api/candidate/start'));
    const s = await sessionRow(sessionId);
    const policy = s.policy as Record<string, Record<string, unknown>>;
    expect(policy.pause).toMatchObject({ allowed: true, requireApproval: false, maxPauses: 4 });
    expect(policy.detection.enabled).toMatchObject({ lookingAway: false, movement: false, absence: true });
    expect(s.accommodations!.exceptions!.map((e) => e.path).sort()).toEqual(
      ['browser.blockClipboard', 'browser.flagWindowBlur', 'browser.requireFullscreen', 'detection.enabled.lookingAway', 'detection.enabled.movement', 'identity.liveness', 'pause.maxPauses', 'pause.requireApproval'].sort(),
    );
    const [ev] = await env.ctx.db.select().from(events).where(and(eq(events.sessionId, sessionId), eq(events.type, 'accommodations_applied')));
    expect(ev).toMatchObject({ category: 'neutral' });
    expect(ev.observation).toBe('Approved accommodations were applied: Rest breaks, up to 4; Assistive technology; Not observed: looking away, unusual movement; No head-turn challenge.');

    // Rest breaks: a pause needs no approval.
    expect(json(await c.req('POST', '/api/candidate/pause', {})).outcome).toBe('paused');
  });

  it('shows staff the accommodations and exceptions, and the report attributes each limitation correctly', async () => {
    const d = json<SessionDetailDTO>(await reviewer.get(`/sessions/${sessionId}`));
    expect(d.summary.accommodations).toEqual(['rest_breaks', 'assistive_technology', 'detection_exemptions', 'no_liveness_challenge']);
    expect(d.accommodations!.items.map((i) => i.label)).toEqual(['Rest breaks, up to 4', 'Assistive technology', 'Not observed: looking away, unusual movement', 'No head-turn challenge']);
    expect(d.accommodations!.exceptions.find((e) => e.path === 'detection.enabled.lookingAway')).toMatchObject({ from: true, to: false, kinds: ['detection_exemptions'], label: 'Looking away observed' });
    expect(d.accommodations!.items[0]).not.toHaveProperty('basis'); // what changed, not why

    const r = json<SessionReportDTO>(await reviewer.get(`/sessions/${sessionId}/report`));
    expect(r.accommodations!.items).toHaveLength(4);
    expect(r.limitations).toEqual(
      expect.arrayContaining([
        'The live-person (head-turn) check was not used for this candidate (approved accommodation); identity checks relied on face comparison only.',
        'These observations were turned off for this candidate (approved accommodation): looking away, unusual movement. Their absence from this report is not a finding.',
      ]),
    );
    // The exam's own rules did not turn these off: no "the exam rules turned off …" sentences.
    expect(r.limitations.join(' ')).not.toMatch(/exam rules turned off|turned off by the exam rules/);
  });
});

describe('identity verified by staff', () => {
  let cand: { id: string };
  let sessionId: string;
  let c: CandidateClient;

  beforeAll(async () => {
    const a = await assigned('Sami Staff');
    ({ cand, sessionId, c } = a);
    json(await grant(cand.id, { kind: 'staff_identity_verification', params: { reverifyOnContinue: false } }));
  });

  it('check-in is an attest check: no frames, no face processing, then a staff_verification hold', async () => {
    await consent(c);
    const state = json<CandidateSessionState>(await c.req('GET', '/api/candidate/session'));
    expect(state.exam.policy.identity).toMatchObject({ verification: 'staff', liveness: 'off', idPhotoComparison: 'off' });
    expect(state.consent.notice.monitored.join(' ')).toMatch(/A staff member verifies your identity before the exam starts; no automated face comparison is made/);
    expect(state.consent.notice.stored.join(' ')).not.toMatch(/identity reference/);

    const r = await runCheck(env, c, 'initial');
    expect(r.start).toMatchObject({ mode: 'attest', liveness: null, frontalFramesRequired: 0, maxFrontalFrames: 0 });
    expect(r.frontalSent).toBe(0);
    expect(r.complete).toMatchObject({ outcome: 'held', message: expect.stringMatching(/A staff member will now verify your identity/) });
    expect(r.complete!.state.session.hold).toMatchObject({ reason: 'staff_verification' });
    expect(await env.ctx.db.select().from(identityReferences).where(eq(identityReferences.sessionId, sessionId))).toHaveLength(0);
  });

  it('frames are refused for an attest check', async () => {
    // A fresh attest check (staff hold released via reverify would need one): emulate a client sending frames.
    const other = await assigned('Frank Frames');
    json(await grant(other.cand.id, { kind: 'staff_identity_verification' }));
    await consent(other.c);
    const start = json<StartCheckResponse>(await startCheck(other.c, 'initial'));
    const fr = await other.c.jpeg(`/api/candidate/checks/${start.checkId}/frames`, { person: 'frank' }, { step: 'frontal', capturedAt: env.clock.t });
    expect(fr.json()).toMatchObject({ error: 'frames_not_needed' });
  });

  it('releasing the hold requires recording how identity was verified; then the candidate can start', async () => {
    expect((await reviewer.post(`/sessions/${sessionId}/release`, {})).json()).toMatchObject({ error: 'verification_required' });
    const released = json(await reviewer.post(`/sessions/${sessionId}/release`, { verification: { method: 'video_call', note: 'Student card shown' } }));
    expect(released.status).toBe('ready');
    const [ev] = await env.ctx.db.select().from(events).where(and(eq(events.sessionId, sessionId), eq(events.type, 'identity_verified_by_staff')));
    expect(ev.details).toEqual({ method: 'video_call', note: 'Student card shown', by: env.users.reviewer.id, purpose: 'initial' });
    const [a] = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.targetId, sessionId), eq(auditLog.action, 'session.identity_verified_by_staff')));
    expect(a.meta).toEqual({ method: 'video_call', purpose: 'initial' });

    const started = json(await c.req('POST', '/api/candidate/start'));
    expect(started.session.status).toBe('active');
    expect(started.session.identitySample ?? null).toBeNull();
  });

  it('takes no identity samples during the exam, and pauses resume without a face check', async () => {
    const h = json(await hb(c));
    expect(h.identitySample).toBeNull();
    env.clock.advance(10 * MIN); // the sample watchdog would have asked long ago
    expect(json(await hb(c)).identitySample).toBeNull();
    const sample = await c.jpeg('/api/candidate/identity/sample', { person: 'sami' }, { sampleId: crypto.randomUUID(), trigger: 'periodic', capturedAt: env.clock.t });
    expect(sample.json()).toMatchObject({ error: 'identity_samples_off' });
    const noSamples = await env.ctx.db.select().from(events).where(and(eq(events.sessionId, sessionId), eq(events.type, 'identity_unverifiable')));
    expect(noSamples).toHaveLength(0);

    expect(json(await c.req('POST', '/api/candidate/pause', { reason: 'Break' })).outcome).toBe('paused');
    env.clock.advance(2 * MIN);
    const resumed = await runCheck(env, c, 'resume');
    expect(resumed.start.mode).toBe('attest');
    expect(resumed.complete).toMatchObject({ outcome: 'passed' });
    expect((await sessionRow(sessionId)).status).toBe('active');
  });

  it('shows the staff verifications on the session and in the report', async () => {
    const d = json<SessionDetailDTO>(await reviewer.get(`/sessions/${sessionId}`));
    expect(d.staffVerifications).toEqual([{ at: expect.any(Number), by: { id: env.users.reviewer.id, name: 'Test reviewer' }, method: 'video_call', purpose: 'initial', note: 'Student card shown' }]);
    const r = json<SessionReportDTO>(await reviewer.get(`/sessions/${sessionId}/report`));
    expect(r.identity.summary).toMatch(/^Identity was verified by staff instead of the automated face check: \d\d:\d\d UTC \(video call, Test reviewer\)\. No automated identity comparisons were made\.$/);
    expect(r.limitations).toContain('Identity was verified by staff instead of automated face comparison (approved accommodation) at check-in; continuity after pauses and reconnections was not verified automatically.');
  });

  it('with reverifyOnContinue a reconnection waits for staff again, and releasing resumes the exam', async () => {
    const a = await assigned('Rhea Reverify');
    json(await grant(a.cand.id, { kind: 'staff_identity_verification', params: { reverifyOnContinue: true } }));
    await consent(a.c);
    expect((await runCheck(env, a.c, 'initial')).complete!.outcome).toBe('held');
    json(await reviewer.post(`/sessions/${a.sessionId}/release`, { verification: { method: 'in_person' } }));
    json(await a.c.req('POST', '/api/candidate/start'));
    env.clock.advance(5 * MIN);
    // The page is reloaded: a new browser instance must pass a (reconnect) check.
    const reloaded = a.c.withInstance(`inst-reload-${Date.now()}`);
    const r = await runCheck(env, reloaded, 'reconnect');
    expect(r.complete).toMatchObject({ outcome: 'held' });
    const s = await sessionRow(a.sessionId);
    expect(s).toMatchObject({ status: 'on_hold', holdReason: 'staff_verification', runningSince: null });
    json(await reviewer.post(`/sessions/${a.sessionId}/release`, { verification: { method: 'video_call' } }));
    expect(await sessionRow(a.sessionId)).toMatchObject({ status: 'active', runningSince: expect.any(Date) });
    const verifications = json<SessionDetailDTO>(await reviewer.get(`/sessions/${a.sessionId}`)).staffVerifications;
    expect(verifications.map((v) => [v.method, v.purpose])).toEqual([
      ['in_person', 'initial'],
      ['video_call', 'reconnect'],
    ]);
  });
});

describe('no camera', () => {
  it('runs the exam without any camera processing and says so to the candidate, staff and integrations', async () => {
    const a = await assigned('Nora NoCam');
    json(await grant(a.cand.id, { kind: 'no_camera', basis: 'technical', params: {} }));
    const state = json<CandidateSessionState>(await a.c.req('GET', '/api/candidate/session'));
    expect(state.exam.policy.camera.enabled).toBe(false);
    expect(Object.values(state.exam.policy.detection.enabled).every((v) => v === false)).toBe(true);
    expect(state.exam.policy.evidence.screenshots).toBe(false);
    const notice = state.consent.notice;
    expect(notice.monitored.join(' ')).not.toMatch(/webcam/i);
    expect(notice.monitored.join(' ')).toMatch(/No camera is used for your exam/);
    expect(notice.stored).toContain('No camera images of any kind.');

    await consent(a.c);
    const r = await runCheck(env, a.c, 'initial', { device: { cameraLabel: '', cameraIdHash: '', userAgent: 'vitest', screen: { width: 1920, height: 1080, isExtended: false } } });
    expect(r.complete!.outcome).toBe('held');
    const [checkin] = await env.ctx.db.select().from(events).where(and(eq(events.sessionId, a.sessionId), eq(events.type, 'checkin_completed')));
    expect(checkin.observation).toBe('No camera is used for this candidate. Identity is verified by a staff member.');
    json(await reviewer.post(`/sessions/${a.sessionId}/release`, { verification: { method: 'in_person' } }));
    json(await a.c.req('POST', '/api/candidate/start'));

    const report = json<SessionReportDTO>(await reviewer.get(`/sessions/${a.sessionId}/report`));
    expect(report.limitations).toContain(
      'No camera was used for this candidate (approved accommodation): there are no camera observations, no images and no automated identity checks. Identity was verified by staff.',
    );
    expect(report.limitations.join(' ')).not.toMatch(/turned off by the exam rules|The exam rules turned off/);

    const key = json(await admin.post('/api-keys', { name: 'LMS' })).secret;
    const api = json(await env.app.inject({ method: 'GET', url: `/api/v1/sessions/${a.sessionId}`, headers: { authorization: `Bearer ${key}` } }));
    expect(api.accommodations).toEqual(['no_camera']);
  });
});

/**
 * Exam versions (services/exam-versions.ts, services/regrade.ts, routes/admin/exams.ts): every attempt keeps the version
 * it started with — the questions it is served, the answers it may give, its grading and its report — while staff edit
 * freely; regrades (preview, apply, history, timeline, webhook, audit); a draft started directly; export / import;
 * concurrent edits; the integration API's view.
 */
import type { CreatedApiKeyDTO, ExamDTO, ExamExport, ExamInput, ExamVersionDTO, ExamVersionSummaryDTO, RegradeResultDTO, SessionDetailDTO, SessionReportDTO } from '@sp/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, events, examSessions, examVersions, webhookDeliveries } from '../../src/db/schema.js';
import { startedSession } from '../flow.js';
import { createTestEnv, type CandidateClient, type TestEnv } from '../helpers.js';
import { json, otherOrg, staffApi, type Api } from './fixtures.js';

let env: TestEnv;
let admin: Api;
let reviewer: Api;

beforeAll(async () => {
  env = await createTestEnv();
  admin = await staffApi(env, 'admin');
  reviewer = await staffApi(env, 'reviewer');
});
afterAll(async () => env?.close());

const GEOGRAPHY: ExamInput = {
  title: 'Geography',
  description: 'Final',
  instructions: 'Answer every question.',
  durationSec: 1800,
  policy: {},
  questions: [
    // The key is wrong on purpose: Canberra is correct. Version 2 fixes it.
    { type: 'single_choice', prompt: 'Capital of Australia?', options: [{ id: 'a', text: 'Sydney' }, { id: 'b', text: 'Canberra' }], correct: ['a'], points: 2 },
    { type: 'short_text', prompt: 'Longest river?', options: [], correct: ['Nile'], points: 1 },
    { type: 'numeric', prompt: 'How many continents?', options: [], correct: ['7'], points: 1 },
  ],
};

async function publishedExam(input: ExamInput = GEOGRAPHY): Promise<ExamDTO> {
  const draft = json<ExamDTO>(await admin.post('/exams', input));
  return json<ExamDTO>(await admin.post(`/exams/${draft.id}/publish`));
}

async function attempt(examId: string, name: string): Promise<{ c: CandidateClient; sessionId: string }> {
  const cand = await env.newCandidate(name);
  const [a] = json(await admin.post(`/exams/${examId}/assignments`, { candidateIds: [cand.id] })).items;
  const c = env.candidateClient(a.accessLink.split('/take/')[1]);
  await startedSession(env, c);
  return { c, sessionId: a.sessionId };
}

let seq = 0;
const answer = (c: CandidateClient, questionId: string, value: unknown) => c.req('PUT', `/api/candidate/answers/${questionId}`, { value, clientSeq: ++seq, answeredAt: env.clock.t });
const versionsOf = async (examId: string) => json<{ items: ExamVersionSummaryDTO[] }>(await reviewer.get(`/exams/${examId}/versions`)).items;
const scoreOf = async (sessionId: string) => (await env.ctx.db.select().from(examSessions).where(eq(examSessions.id, sessionId)))[0].score;

describe('attempts are pinned to the version they started with', () => {
  let exam: ExamDTO;
  let v1: ExamDTO['questions'];
  let early: { c: CandidateClient; sessionId: string };
  let late: { c: CandidateClient; sessionId: string };

  beforeAll(async () => {
    exam = await publishedExam();
    v1 = exam.questions;
    early = await attempt(exam.id, 'Early Eve');
    // Fix the key, reword q2, drop q3, add q4 and rename the exam: version 2.
    const edited = json<ExamDTO>(
      await admin.put(`/exams/${exam.id}`, {
        ...GEOGRAPHY,
        title: 'Geography (revised)',
        questions: [{ ...v1[0], correct: ['b'] }, { ...v1[1], prompt: 'Longest river on Earth?' }, { type: 'short_text', prompt: 'Highest mountain?', options: [], correct: ['Everest'], points: 1 }],
      }),
    );
    expect(edited.currentVersion!.number).toBe(2);
    exam = edited;
    late = await attempt(exam.id, 'Late Leo');
  });

  it('serves each attempt the questions and title of its own version', async () => {
    const e = json(await early.c.req('GET', '/api/candidate/session'));
    expect(e.exam.title).toBe('Geography');
    expect(e.questions.map((q: { id: string; prompt: string }) => [q.id, q.prompt])).toEqual(v1.map((q) => [q.id, q.prompt]));
    const l = json(await late.c.req('GET', '/api/candidate/session'));
    expect(l.exam.title).toBe('Geography (revised)');
    expect(l.questions.map((q: { prompt: string }) => q.prompt)).toEqual(['Capital of Australia?', 'Longest river on Earth?', 'Highest mountain?']);
  });

  it("accepts answers only to the attempt's own questions", async () => {
    const [q1, q2, q3] = v1;
    const q4 = exam.questions[2].id;
    json(await answer(early.c, q1.id, 'b'));
    json(await answer(early.c, q2.id, 'Nile'));
    json(await answer(early.c, q3.id, '7')); // removed in version 2, still part of this attempt
    expect((await answer(early.c, q4, 'Everest')).json()).toMatchObject({ error: 'question_not_found' });
    expect((await answer(late.c, q3.id, '7')).json()).toMatchObject({ error: 'question_not_found' });
    json(await answer(late.c, q1.id, 'b'));
    json(await answer(late.c, q4, 'Everest'));
  });

  it("grades each attempt with its own version's answer keys", async () => {
    json(await early.c.req('POST', '/api/candidate/submit'));
    json(await late.c.req('POST', '/api/candidate/submit'));
    const versions = await versionsOf(exam.id);
    expect(await scoreOf(early.sessionId)).toMatchObject({ points: 2, maxPoints: 4, keysVersionId: versions[1].id }); // the wrong v1 key: Canberra scores 0
    expect(await scoreOf(late.sessionId)).toMatchObject({ points: 3, maxPoints: 4, keysVersionId: versions[0].id });
  });

  it('shows the version on session summaries, the report and the version list', async () => {
    const sessions = json(await reviewer.get(`/exams/${exam.id}/sessions`)).items;
    const byId = new Map(sessions.map((s: { id: string; examVersion: { number: number } }) => [s.id, s.examVersion.number]));
    expect([byId.get(early.sessionId), byId.get(late.sessionId)]).toEqual([1, 2]);
    const detail = json<SessionDetailDTO>(await reviewer.get(`/sessions/${early.sessionId}`));
    expect(detail.summary.examVersion).toMatchObject({ number: 1 });
    expect(detail.score).toMatchObject({ points: 2, maxPoints: 4, regrades: [] });
    const report = json<SessionReportDTO>(await reviewer.get(`/sessions/${early.sessionId}/report`));
    expect(report.exam).toMatchObject({ title: 'Geography', version: 1 });
    expect(json<SessionReportDTO>(await reviewer.get(`/sessions/${late.sessionId}/report`)).exam).toMatchObject({ title: 'Geography (revised)', version: 2 });
    const versions = await versionsOf(exam.id);
    expect(versions.map((v) => [v.number, v.sessions])).toEqual([
      [2, { started: 1, finished: 1 }],
      [1, { started: 1, finished: 1 }],
    ]);
    expect(versions[0].changes).toEqual({
      added: [exam.questions[2].id],
      removed: [v1[2].id],
      changed: [
        { questionId: v1[0].id, fields: ['correct'] },
        { questionId: v1[1].id, fields: ['prompt'] },
      ],
      exam: ['title'],
    });
  });

  it('returns a version with its questions and answer keys (reviewer); other organisations get 404', async () => {
    const [, first] = await versionsOf(exam.id);
    const v = json<ExamVersionDTO>(await reviewer.get(`/exams/${exam.id}/versions/${first.id}`));
    expect(v).toMatchObject({ number: 1, title: 'Geography', reason: 'published', current: false, durationSec: 1800 });
    expect(v.questions.map((q) => [q.id, q.correct])).toEqual(v1.map((q) => [q.id, q.correct]));
    const other = await otherOrg(env);
    expect((await other.api.get(`/exams/${exam.id}/versions`)).statusCode).toBe(404);
    expect((await other.api.get(`/exams/${exam.id}/versions/${first.id}`)).statusCode).toBe(404);
    expect((await reviewer.get(`/exams/${other.exam.id}/versions`)).statusCode).toBe(404);
    // A version of another exam under this exam's URL.
    const [otherV] = await env.ctx.db.select().from(examVersions).where(eq(examVersions.examId, other.exam.id));
    expect((await admin.get(`/exams/${exam.id}/versions/${otherV.id}`)).statusCode).toBe(404);
  });

  describe('regrade', () => {
    let hookId: string;
    let body: { sessionsOnVersionId: string; keysFromVersionId: string; reason: string };

    beforeAll(async () => {
      hookId = json(await admin.post('/webhooks', { url: 'http://127.0.0.1:9/hook', events: ['session.regraded'] })).webhook.id;
      const [v2, v1v] = await versionsOf(exam.id);
      body = { sessionsOnVersionId: v1v.id, keysFromVersionId: v2.id, reason: 'Question 1 had the wrong answer marked as correct.' };
    });

    it('validates the request and is admin-only', async () => {
      expect((await reviewer.post(`/exams/${exam.id}/regrade`, body)).statusCode).toBe(403);
      expect((await admin.post(`/exams/${exam.id}/regrade`, { ...body, reason: '  ' })).statusCode).toBe(400);
      const other = await otherOrg(env);
      const [otherV] = await env.ctx.db.select().from(examVersions).where(eq(examVersions.examId, other.exam.id));
      expect((await admin.post(`/exams/${exam.id}/regrade`, { ...body, keysFromVersionId: otherV.id })).json()).toMatchObject({ error: 'exam_version_not_found' });
      expect((await other.api.post(`/exams/${exam.id}/regrade`, body)).statusCode).toBe(404);
    });

    it('previews without writing anything', async () => {
      const preview = json<RegradeResultDTO>(await admin.post(`/exams/${exam.id}/regrade`, body));
      expect(preview).toEqual({
        applied: false,
        changedQuestions: [{ questionId: v1[0].id, prompt: 'Capital of Australia?', correct: { from: ['a'], to: ['b'] }, points: { from: 2, to: 2 } }],
        sessions: [{ sessionId: early.sessionId, candidateName: 'Early Eve', before: { points: 2, maxPoints: 4 }, after: { points: 4, maxPoints: 4 }, changed: true }],
        inProgress: 0,
      });
      expect(await scoreOf(early.sessionId)).toMatchObject({ points: 2 });
      expect(await env.ctx.db.select().from(events).where(and(eq(events.sessionId, early.sessionId), eq(events.type, 'score_regraded')))).toHaveLength(0);
    });

    it('applies: new score with history, a timeline entry, a webhook and audit entries; repeating changes nothing', async () => {
      const applied = json<RegradeResultDTO>(await admin.post(`/exams/${exam.id}/regrade`, { ...body, apply: true }));
      expect(applied).toMatchObject({ applied: true, sessions: [{ sessionId: early.sessionId, after: { points: 4, maxPoints: 4 }, changed: true }] });
      const score = await scoreOf(early.sessionId);
      expect(score).toMatchObject({ points: 4, maxPoints: 4, keysVersionId: body.keysFromVersionId });
      expect(score!.regrades).toEqual([{ at: env.clock.t, by: env.users.admin.id, reason: body.reason, keysFromVersionId: body.keysFromVersionId, keysFromVersion: 2, previous: { points: 2, maxPoints: 4 } }]);
      expect(score!.perQuestion.find((q) => q.questionId === v1[0].id)).toMatchObject({ points: 2, correct: true });

      const [ev] = await env.ctx.db.select().from(events).where(and(eq(events.sessionId, early.sessionId), eq(events.type, 'score_regraded')));
      expect(ev).toMatchObject({ category: 'neutral', source: 'staff' });
      expect(ev.observation).toBe('An administrator regraded the exam with the answer keys of version 2 (score 2/4 → 4/4).');
      expect(ev.details).toMatchObject({ keysFromVersion: 2, before: { points: 2, maxPoints: 4 }, after: { points: 4, maxPoints: 4 }, reason: body.reason });

      const detail = json<SessionDetailDTO>(await reviewer.get(`/sessions/${early.sessionId}`));
      expect(detail.score!.regrades).toEqual([{ at: env.clock.t, byStaffId: env.users.admin.id, reason: body.reason, keysFromVersion: 2, previous: { points: 2, maxPoints: 4 } }]);

      const [delivery] = await env.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, hookId));
      expect(delivery.eventType).toBe('session.regraded');
      expect(delivery.payload).toMatchObject({ type: 'session.regraded', data: { sessionId: early.sessionId, score: { points: 4, maxPoints: 4 }, reason: body.reason } });

      const audits = await env.ctx.db.select().from(auditLog).where(eq(auditLog.actorId, env.users.admin.id));
      expect(audits.find((a) => a.action === 'session.regraded' && a.targetId === early.sessionId)?.meta).toMatchObject({ keysFromVersion: 2, before: { points: 2 }, after: { points: 4 } });
      expect(audits.find((a) => a.action === 'exam.regraded' && a.targetId === exam.id)?.meta).toMatchObject({ sessionsOnVersion: 1, keysFromVersion: 2, sessions: 1, unchanged: 0, reason: body.reason });

      // The same regrade again: nothing changes, nothing is written.
      const again = json<RegradeResultDTO>(await admin.post(`/exams/${exam.id}/regrade`, { ...body, apply: true }));
      expect(again).toMatchObject({ applied: false, sessions: [{ changed: false, before: { points: 4 }, after: { points: 4 } }] });
      expect((await scoreOf(early.sessionId))!.regrades).toHaveLength(1);
      expect(await env.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, hookId))).toHaveLength(1);
    });

    it('counts attempts still in progress on the version instead of regrading them', async () => {
      const [v2] = await versionsOf(exam.id);
      // A third version (a points change) with an attempt in progress, regraded with... version 2's keys.
      json(await admin.put(`/exams/${exam.id}`, { ...GEOGRAPHY, title: exam.title, questions: exam.questions.map((q, i) => ({ ...q, points: i === 2 ? 3 : q.points })) }));
      const running = await attempt(exam.id, 'Running Rae');
      const [v3] = await versionsOf(exam.id);
      expect(v3.number).toBe(3);
      const r = json<RegradeResultDTO>(await admin.post(`/exams/${exam.id}/regrade`, { sessionsOnVersionId: v3.id, keysFromVersionId: v2.id, reason: 'Points back to 1.' }));
      expect(r).toMatchObject({ applied: false, sessions: [], inProgress: 1 });
      expect(r.changedQuestions.map((c) => [c.questionId, c.points])).toEqual([[exam.questions[2].id, { from: 3, to: 1 }]]);
      json(await running.c.req('POST', '/api/candidate/submit'));
    });
  });
});

describe('an exam started before it was published (seed data, tests)', () => {
  it('versions the content each attempt starts with and reuses an unchanged version', async () => {
    const draft = json<ExamDTO>(await admin.post('/exams', { ...GEOGRAPHY, title: 'Draft run' }));
    expect(draft.currentVersion).toBeNull();
    const start = async (name: string) => {
      const cand = await env.newCandidate(name);
      const s = await env.newSession({ examId: draft.id, candidateId: cand.id });
      await startedSession(env, env.candidateClient(s.token));
      return (await env.ctx.db.select().from(examSessions).where(eq(examSessions.id, s.id)))[0].examVersionId;
    };
    const a = await start('Draft One');
    json(await admin.put(`/exams/${draft.id}`, { ...GEOGRAPHY, title: 'Draft run', questions: draft.questions.slice(0, 2) }));
    const b = await start('Draft Two');
    const c = await start('Draft Three');
    const versions = await versionsOf(draft.id);
    expect(versions.map((v) => [v.number, v.reason, v.createdBy, v.questionCount])).toEqual([
      [2, 'started', null, 2],
      [1, 'started', null, 3],
    ]);
    expect([a, b, c]).toEqual([versions[1].id, versions[0].id, versions[0].id]);
    // Publishing the unchanged draft keeps version 2.
    expect(json<ExamDTO>(await admin.post(`/exams/${draft.id}/publish`)).currentVersion!.number).toBe(2);
  });
});

describe('export and import', () => {
  let exam: ExamDTO;
  beforeAll(async () => {
    exam = await publishedExam({ ...GEOGRAPHY, title: 'Physik für Anfänger: Teil 1/2', policy: { pause: { allowed: false } } });
    json(await admin.put(`/exams/${exam.id}`, { ...GEOGRAPHY, title: exam.title, policy: { pause: { allowed: false } }, questions: exam.questions.map((q) => ({ ...q, points: 5 })) }));
  });

  it('exports the current content, or any version, as a portable document with answer keys (admin only)', async () => {
    const res = await admin.get(`/exams/${exam.id}/export`);
    expect(res.headers['content-disposition']).toBe('attachment; filename="physik-fur-anfanger-teil-12.exam.json"');
    const doc = json<ExamExport>(res);
    expect(doc).toMatchObject({ format: 'smartproctoring.exam', formatVersion: 1, exportedAt: env.clock.t, source: { examId: exam.id, version: null, title: exam.title } });
    expect(doc.exam).toMatchObject({ title: exam.title, durationSec: 1800, instructions: GEOGRAPHY.instructions, policy: { pause: { allowed: false } } });
    expect(doc.exam.questions).toEqual(GEOGRAPHY.questions.map((q) => ({ ...q, points: 5 })));
    expect(JSON.stringify(doc)).not.toContain(exam.questions[0].id); // no question ids

    const [, first] = await versionsOf(exam.id);
    const v1doc = json<ExamExport>(await admin.get(`/exams/${exam.id}/export`, { versionId: first.id }));
    expect(v1doc.source).toMatchObject({ version: 1 });
    expect(v1doc.exam.questions.map((q) => q.points)).toEqual([2, 1, 1]);

    expect((await reviewer.get(`/exams/${exam.id}/export`)).statusCode).toBe(403);
    expect((await admin.get(`/exams/${exam.id}/export`, { versionId: 'nope' })).json()).toMatchObject({ error: 'exam_version_not_found' });
    expect((await admin.get(`/exams/${exam.id}/export`, { versionId: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);
    const exported = (await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'exam.exported'), eq(auditLog.targetId, exam.id)))).map((a) => a.meta);
    expect(exported).toEqual([{ version: null }, { version: 1 }]);
  });

  it('imports an export as a new draft (round trip) and rejects other documents', async () => {
    const doc = json<ExamExport>(await admin.get(`/exams/${exam.id}/export`));
    const imported = json<ExamDTO>(await admin.post('/exams/import', doc));
    expect(imported).toMatchObject({ title: exam.title, status: 'draft', currentVersion: null, durationSec: 1800 });
    expect(imported.id).not.toBe(exam.id);
    expect(imported.policy.pause.allowed).toBe(false);
    expect(imported.questions.map(({ id: _id, ...q }) => q)).toEqual(doc.exam.questions);
    expect(imported.questions.map((q) => q.id)).not.toContain(exam.questions[0].id);
    // Exporting the import gives the same exam content.
    expect(json<ExamExport>(await admin.get(`/exams/${imported.id}/export`)).exam).toEqual(doc.exam);
    const [a] = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'exam.imported'), eq(auditLog.targetId, imported.id)));
    expect(a.meta).toMatchObject({ title: exam.title, questions: 3, source: { examId: exam.id, version: null } });

    expect((await admin.post('/exams/import', { ...doc, format: 'other' })).statusCode).toBe(400);
    expect((await admin.post('/exams/import', { ...doc, formatVersion: 2 })).statusCode).toBe(400);
    const badKey = await admin.post('/exams/import', { ...doc, exam: { ...doc.exam, questions: [{ ...doc.exam.questions[0], correct: ['zz'] }] } });
    expect(badKey.statusCode).toBe(400);
    expect(badKey.json().details[0].path).toBe('questions.0.correct');
    expect((await reviewer.post('/exams/import', doc)).statusCode).toBe(403);
  });
});

describe('concurrency', () => {
  it('gives concurrent edits of a published exam distinct, consecutive version numbers', async () => {
    const exam = await publishedExam({ ...GEOGRAPHY, title: 'Busy exam' });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => admin.put(`/exams/${exam.id}`, { ...GEOGRAPHY, title: `Busy exam ${i}` })));
    expect(results.map((r) => r.statusCode)).toEqual(Array(6).fill(200));
    const numbers = (await versionsOf(exam.id)).map((v) => v.number);
    expect(numbers).toEqual([7, 6, 5, 4, 3, 2, 1]);
  });
});

describe('integration API', () => {
  it('reports the current version of exams and the version and regrade count of sessions', async () => {
    const created = json<CreatedApiKeyDTO>(await admin.post('/api-keys', { name: 'LMS' }));
    const v1 = (url: string) => env.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${created.secret}` } });
    const exam = await publishedExam({ ...GEOGRAPHY, title: 'API exam' });
    json(await admin.put(`/exams/${exam.id}`, { ...GEOGRAPHY, title: 'API exam', questions: [{ ...exam.questions[0], correct: ['b'] }, exam.questions[1]] }));
    const items = json(await v1('/exams')).items;
    expect(items.find((e: { id: string }) => e.id === exam.id)).toEqual({ id: exam.id, title: 'API exam', status: 'published', durationSec: 1800, version: 2 });
    const { c, sessionId } = await attempt(exam.id, 'Api Ann');
    json(await answer(c, exam.questions[0].id, 'a'));
    json(await c.req('POST', '/api/candidate/submit'));
    const s = json(await v1(`/sessions/${sessionId}`));
    expect(s).toMatchObject({ examVersion: 2, score: { points: 0, maxPoints: 3, autoGraded: true, regraded: 0 } });
  });
});

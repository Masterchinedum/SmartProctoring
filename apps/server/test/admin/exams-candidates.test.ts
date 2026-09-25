/**
 * Staff API: exams (CRUD, publish/archive, non-breaking edits after publication), assignments (dedupe),
 * candidates (CRUD, delete rules) and approved ID photos (accept / reject with FakeVisionService).
 */
import type { CandidateDTO, ExamDTO, ExamInput } from '@sp/shared';
import { and, eq } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answers, auditLog, candidates, evidence, examSessions } from '../../src/db/schema.js';
import { deserializeEmbeddings } from '../../src/vision/embeddings.js';
import { FakeVisionService } from '../../src/vision/fake.js';
import { startedSession } from '../flow.js';
import { createTestEnv, type TestEnv } from '../helpers.js';
import { json, staffApi, type Api } from './fixtures.js';

let env: TestEnv;
let admin: Api;
let reviewer: Api;

beforeAll(async () => {
  env = await createTestEnv();
  admin = await staffApi(env, 'admin');
  reviewer = await staffApi(env, 'reviewer');
});
afterAll(async () => env?.close());

const baseExam: ExamInput = {
  title: 'Chemistry 101',
  description: 'Midterm',
  instructions: 'No notes.',
  durationSec: 1800,
  policy: { pause: { requireApproval: true }, unknownSection: { x: 1 } },
  questions: [
    { type: 'single_choice', prompt: 'H2O is?', options: [{ id: 'a', text: 'Water' }, { id: 'b', text: 'Salt' }], correct: ['a'], points: 1 },
    { type: 'short_text', prompt: 'Symbol for gold?', options: [], correct: ['Au'], points: 2 },
  ],
};

describe('exams', () => {
  let exam: ExamDTO;

  it('creates a draft exam with validated, sanitised policy and stable question ids', async () => {
    exam = json(await admin.post('/exams', baseExam));
    expect(exam).toMatchObject({ title: 'Chemistry 101', status: 'draft', durationSec: 1800, stats: { assigned: 0, active: 0, completed: 0, flagged: 0 } });
    expect(exam.policy.pause.requireApproval).toBe(true);
    expect(exam.policy.pause.timerBehavior).toBe('stop'); // defaults filled
    expect((exam.policy as Record<string, unknown>).unknownSection).toBeUndefined();
    expect(exam.questions.map((q) => q.prompt)).toEqual(['H2O is?', 'Symbol for gold?']);
    expect(exam.questions[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(json(await reviewer.get(`/exams/${exam.id}`))).toEqual(exam);
    expect(json(await reviewer.get('/exams')).items.map((e: ExamDTO) => e.id)).toContain(exam.id);

    const bad = await admin.post('/exams', { ...baseExam, policy: { pause: { maxPauses: -1 } } });
    expect(bad.statusCode).toBe(400);
    expect(JSON.stringify(bad.json().details)).toContain('pause.maxPauses');
    const badQ = await admin.post('/exams', { ...baseExam, questions: [{ type: 'single_choice', prompt: 'x', options: [{ id: 'a', text: 'A' }], correct: ['z'] }] });
    expect(badQ.statusCode).toBe(400);
    expect(badQ.json().details.map((d: { path: string }) => d.path)).toEqual(['questions.0.options', 'questions.0.correct']);
  });

  it('allows free edits while a draft', async () => {
    const [q1, q2] = exam.questions;
    const edited = json(
      await admin.put(`/exams/${exam.id}`, {
        ...baseExam,
        title: 'Chemistry 101 (v2)',
        questions: [{ ...q2 }, { type: 'numeric', prompt: 'pH of water?', options: [], correct: ['7±0.1'], points: 1 }],
      }),
    );
    expect(edited.title).toBe('Chemistry 101 (v2)');
    expect(edited.questions.map((q: { id: string }) => q.id)[0]).toBe(q2.id);
    expect(edited.questions.map((q: { id: string }) => q.id)).not.toContain(q1.id);
    exam = edited;
  });

  it('publishes, then only allows non-breaking edits (409 with an explanation otherwise)', async () => {
    exam = json(await admin.post(`/exams/${exam.id}/publish`));
    expect(exam.status).toBe('published');
    const qs = exam.questions;
    const body = (questions: unknown[]) => ({ ...baseExam, title: exam.title, questions });

    const removed = await admin.put(`/exams/${exam.id}`, body([qs[0]]));
    expect(removed.statusCode).toBe(409);
    expect(removed.json()).toMatchObject({ error: 'question_removal_not_allowed', details: { questionIds: [qs[1].id] } });
    expect(removed.json().message).toMatch(/existing answers/);

    expect((await admin.put(`/exams/${exam.id}`, body([qs[1], qs[0]]))).json().error).toBe('question_reorder_not_allowed');
    expect((await admin.put(`/exams/${exam.id}`, body([{ ...qs[0], type: 'long_text' }, qs[1]]))).json().error).toBe('question_type_change_not_allowed');

    // Non-breaking: reword, change points / answer key, append a question (with a client id that is ignored).
    const ok = json(
      await admin.put(`/exams/${exam.id}`, body([{ ...qs[0], prompt: 'Symbol for gold (element)?', points: 3 }, { ...qs[1], correct: ['7±0.2'] }, { id: 'client-made-up', type: 'long_text', prompt: 'Explain.', options: [], correct: [], points: 5 }])),
    );
    expect(ok.questions.map((q: { id: string }) => q.id).slice(0, 2)).toEqual([qs[0].id, qs[1].id]);
    expect(ok.questions[2].id).not.toBe('client-made-up');
    expect(ok.questions[0]).toMatchObject({ prompt: 'Symbol for gold (element)?', points: 3 });

    // A choice question can gain options but not lose them.
    const choice = json(await admin.post('/exams', baseExam));
    json(await admin.post(`/exams/${choice.id}/publish`));
    const cq = choice.questions[0];
    const lose = await admin.put(`/exams/${choice.id}`, { ...baseExam, questions: [{ ...cq, options: [cq.options[0], { id: 'c', text: 'Ice' }], correct: ['a'] }, choice.questions[1]] });
    expect(lose.json()).toMatchObject({ error: 'option_removal_not_allowed', details: { optionIds: ['b'] } });
    const gain = json(
      await admin.put(`/exams/${choice.id}`, { ...baseExam, questions: [{ ...cq, options: [...cq.options.map((o: { id: string; text: string }) => ({ ...o, text: o.text.toUpperCase() })), { id: 'c', text: 'Ice' }] }, choice.questions[1]] }),
    );
    expect(gain.questions[0].options.map((o: { id: string }) => o.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps existing answers valid across edits of an exam in progress', async () => {
    const cand = await env.newCandidate('Edith Edit');
    const assigned = json(await admin.post(`/exams/${exam.id}/assignments`, { candidateIds: [cand.id] }));
    const c = env.candidateClient(assigned.items[0].accessLink.split('/take/')[1]);
    await startedSession(env, c);
    const q0 = exam.questions[0].id;
    json(await c.req('PUT', `/api/candidate/answers/${q0}`, { value: 'Au', clientSeq: 1, answeredAt: env.clock.t }));
    const current = json(await reviewer.get(`/exams/${exam.id}`));
    json(await admin.put(`/exams/${exam.id}`, { ...baseExam, title: current.title, questions: current.questions.map((q: { prompt: string }) => ({ ...q, prompt: `${q.prompt} ` })) }));
    const [a] = await env.ctx.db.select().from(answers).where(eq(answers.questionId, q0));
    expect(a.value).toBe('Au');
    const st = json(await c.req('GET', '/api/candidate/session'));
    expect(st.questions.map((q: { id: string }) => q.id)).toEqual(current.questions.map((q: { id: string }) => q.id));
  });

  it('archives (read-only, no new assignments) and lists exam sessions', async () => {
    const sessions = json(await reviewer.get(`/exams/${exam.id}/sessions`));
    expect(sessions.items).toHaveLength(1);
    const stats = json(await reviewer.get(`/exams/${exam.id}`)).stats;
    expect(stats).toMatchObject({ assigned: 1, active: 1, completed: 0 });
    const archived = json(await admin.post(`/exams/${exam.id}/archive`));
    expect(archived.status).toBe('archived');
    expect((await admin.put(`/exams/${exam.id}`, { ...baseExam })).json().error).toBe('exam_archived');
    const cand = await env.newCandidate('Late Larry');
    expect((await admin.post(`/exams/${exam.id}/assignments`, { candidateIds: [cand.id] })).json().error).toBe('exam_not_published');
    const actions = (await env.ctx.db.select().from(auditLog).where(eq(auditLog.targetId, exam.id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['exam.created', 'exam.updated', 'exam.published', 'exam.assigned', 'exam.archived']));
  });

  it('refuses assignments to a draft exam', async () => {
    const draft = json(await admin.post('/exams', baseExam));
    expect((await admin.post(`/exams/${draft.id}/assignments`, { candidateIds: [env.candidate.id] })).statusCode).toBe(409);
  });
});

describe('assignments', () => {
  it('creates sessions with access links and skips candidates that already have an unfinished session', async () => {
    const a = await env.newCandidate('Anna Assign');
    const b = await env.newCandidate('Ben Assign');
    const first = json(await admin.post(`/exams/${env.exam.id}/assignments`, { candidateIds: [a.id, b.id, a.id] }));
    expect(first.items).toHaveLength(2);
    expect(first.items.every((i: { existing: boolean }) => i.existing === false)).toBe(true);
    expect(first.items[0]).toMatchObject({ candidateId: a.id, candidateName: 'Anna Assign', accessLink: expect.stringMatching(/^http:\/\/exam\.test\/take\/[\w-]{40,}$/) });

    const c = await env.newCandidate('Cleo Assign');
    const second = json(await admin.post(`/exams/${env.exam.id}/assignments`, { candidateIds: [a.id, b.id, c.id] }));
    expect(second.items.map((i: { existing: boolean }) => i.existing)).toEqual([true, true, false]);
    expect(second.items[0].sessionId).toBe(first.items[0].sessionId);
    expect(second.items[0].accessLink).toBe(first.items[0].accessLink);
    const rows = await env.ctx.db.select().from(examSessions).where(and(eq(examSessions.examId, env.exam.id), eq(examSessions.candidateId, a.id)));
    expect(rows).toHaveLength(1);

    // After the session ends, the candidate can be assigned again (a retake).
    json(await admin.post(`/sessions/${first.items[0].sessionId}/terminate`, { reason: 'Rescheduled' }));
    const third = json(await admin.post(`/exams/${env.exam.id}/assignments`, { candidateIds: [a.id] }));
    expect(third.items[0].existing).toBe(false);
    expect(third.items[0].sessionId).not.toBe(first.items[0].sessionId);

    const unknown = await admin.post(`/exams/${env.exam.id}/assignments`, { candidateIds: ['00000000-0000-4000-8000-000000000000', 'not-an-id'] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().details[0].message).toMatch(/not-an-id/);
    expect((await admin.post(`/exams/${env.exam.id}/assignments`, { candidateIds: [] })).statusCode).toBe(400);
  });
});

describe('candidates', () => {
  it('creates, lists, searches and updates candidates; external ids are unique per organisation', async () => {
    const cand = json<CandidateDTO>(await admin.post('/candidates', { name: '  Zoe Zed ', email: 'zoe@example.com', externalId: 'Z-1' }));
    expect(cand).toMatchObject({ name: 'Zoe Zed', email: 'zoe@example.com', externalId: 'Z-1', idPhoto: null, sessions: [] });
    expect((await admin.post('/candidates', { name: 'Other Zoe', externalId: 'Z-1' })).statusCode).toBe(409);
    expect((await admin.post('/candidates', { name: 'Bad Email', email: 'nope' })).statusCode).toBe(400);
    const found = json(await reviewer.get('/candidates', { q: 'z-1' }));
    expect(found.items.map((c: CandidateDTO) => c.id)).toEqual([cand.id]);
    const updated = json<CandidateDTO>(await admin.put(`/candidates/${cand.id}`, { name: 'Zoe Zed-Smith', email: null, externalId: 'Z-1' }));
    expect(updated).toMatchObject({ name: 'Zoe Zed-Smith', email: null, externalId: 'Z-1' });
    const all = json(await reviewer.get('/candidates'));
    const names = all.items.map((c: CandidateDTO) => c.name);
    expect(names).toEqual([...names].sort((x: string, y: string) => x.toLowerCase().localeCompare(y.toLowerCase())));
    const withSessions = json<CandidateDTO>(await reviewer.get(`/candidates/${env.candidate.id}`));
    expect(withSessions.sessions[0]).toMatchObject({ id: env.session.id, examTitle: 'Sample Exam', status: 'invited' });
  });

  it('accepts a usable ID photo (encrypted evidence + template) and replaces an older one', async () => {
    const cand = json<CandidateDTO>(await admin.post('/candidates', { name: 'Paul Photo' }));
    const res = json(await admin.jpeg(`/candidates/${cand.id}/id-photo`, { person: 'paul' }));
    expect(res).toMatchObject({ accepted: true, guidance: [], quality: { usable: true, faceCount: 1 } });
    expect(res.candidate.idPhoto).toMatchObject({ evidenceId: expect.any(String), approvedAt: env.clock.t });
    const [row] = await env.ctx.db.select().from(candidates).where(eq(candidates.id, cand.id));
    expect(row.idPhotoApprovedBy).toBe(env.users.admin.id);
    const emb = deserializeEmbeddings(env.ctx.keyring.decrypt(row.idPhotoEmbedding!, `idphoto:${cand.id}`));
    expect(Array.from(emb[0])).toEqual(Array.from(FakeVisionService.embeddingFor('paul')));
    const img = await reviewer.get(`/evidence/${res.candidate.idPhoto.evidenceId}`);
    expect(img.statusCode).toBe(200);

    const second = json(await admin.jpeg(`/candidates/${cand.id}/id-photo`, { person: 'paul', brightness: 140 }));
    expect(second.candidate.idPhoto.evidenceId).not.toBe(res.candidate.idPhoto.evidenceId);
    const [old] = await env.ctx.db.select().from(evidence).where(eq(evidence.id, res.candidate.idPhoto.evidenceId));
    expect(old).toMatchObject({ purgeReason: 'id_photo_replaced' });
    expect(old.purgedAt).not.toBeNull();
    expect((await reviewer.get(`/evidence/${old.id}`)).statusCode).toBe(410);

    const removed = json<CandidateDTO>(await admin.del(`/candidates/${cand.id}/id-photo`));
    expect(removed.idPhoto).toBeNull();
    const [after] = await env.ctx.db.select().from(candidates).where(eq(candidates.id, cand.id));
    expect(after.idPhotoEmbedding).toBeNull();
    const audits = (await env.ctx.db.select().from(auditLog).where(eq(auditLog.targetId, cand.id))).map((a) => a.action);
    expect(audits).toEqual(expect.arrayContaining(['candidate.created', 'candidate.id_photo_approved', 'candidate.id_photo_removed']));
  });

  it('rejects an unusable ID photo with guidance and stores nothing', async () => {
    const cand = json<CandidateDTO>(await admin.post('/candidates', { name: 'Nina NoFace' }));
    const before = (await env.ctx.db.select().from(evidence)).length;
    const body = json(await admin.jpeg(`/candidates/${cand.id}/id-photo`, { person: null }));
    expect(body).toMatchObject({ accepted: false, quality: { usable: false, issues: ['no_face'] }, candidate: { id: cand.id, idPhoto: null } });
    expect(body.guidance[0]).toMatch(/No face was found/);
    const [rej] = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'candidate.id_photo_rejected'), eq(auditLog.targetId, cand.id)));
    expect(rej.meta).toEqual({ issues: ['no_face'] });
    expect((await env.ctx.db.select().from(evidence)).length).toBe(before);
    const [row] = await env.ctx.db.select().from(candidates).where(eq(candidates.id, cand.id));
    expect(row.idPhotoEmbedding).toBeNull();

    const two = json(await admin.jpeg(`/candidates/${cand.id}/id-photo`, { person: 'x', faces: 2 }));
    expect(two.accepted).toBe(false);
    expect(two.guidance.join(' ')).toMatch(/More than one face/);
    expect((await admin.jpeg(`/candidates/${cand.id}/id-photo`, { corrupt: true })).json()).toMatchObject({ error: 'invalid_image' });
    expect((await admin.inject({ method: 'PUT', url: `/api/admin/candidates/${cand.id}/id-photo`, headers: { 'content-type': 'image/jpeg' }, payload: Buffer.from('not a jpeg at all') })).statusCode).toBe(415);
    expect((await admin.inject({ method: 'PUT', url: `/api/admin/candidates/${cand.id}/id-photo`, headers: { 'content-type': 'image/png' }, payload: Buffer.from([1, 2, 3]) })).statusCode).toBe(415);
    const big = Buffer.concat([FakeVisionService.encode({ person: 'x' }), Buffer.alloc(5 * 1024 * 1024 + 10)]);
    expect((await admin.jpeg(`/candidates/${cand.id}/id-photo`, big)).statusCode).toBe(413);
    // up to 5 MB is accepted (larger than the 1 MB candidate frame limit)
    const large = Buffer.concat([FakeVisionService.encode({ person: 'nina' }), Buffer.alloc(3 * 1024 * 1024)]);
    expect(json(await admin.jpeg(`/candidates/${cand.id}/id-photo`, large)).accepted).toBe(true);
  });

  it('refuses to delete a candidate with an unfinished session; afterwards deletes records, images and templates', async () => {
    const cand = json<CandidateDTO>(await admin.post('/candidates', { name: 'Dora Delete' }));
    json(await admin.jpeg(`/candidates/${cand.id}/id-photo`, { person: 'dora' }));
    const assigned = json(await admin.post(`/exams/${env.exam.id}/assignments`, { candidateIds: [cand.id] }));
    const sid = assigned.items[0].sessionId;
    await startedSession(env, env.candidateClient(assigned.items[0].accessLink.split('/take/')[1]), 'dora');
    const refused = await admin.del(`/candidates/${cand.id}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'candidate_has_open_sessions', details: { sessionIds: [sid] } });

    json(await admin.post(`/sessions/${sid}/terminate`, { reason: 'Withdrawn' }));
    json(await admin.post(`/sessions/${sid}/legal-hold`, { enabled: true }));
    expect((await admin.del(`/candidates/${cand.id}`)).json().error).toBe('candidate_under_legal_hold');
    json(await admin.post(`/sessions/${sid}/legal-hold`, { enabled: false }));

    // Images that still exist (a passed check's surplus frame images are purged when it passes, by design).
    const ev = (await env.ctx.db.select().from(evidence).where(eq(evidence.sessionId, sid))).filter((e) => e.purgedAt == null);
    expect(ev.length).toBeGreaterThan(0);
    const files = ev.map((e) => env.storage.resolveKey(e.storageKey));
    expect(files.every((f) => existsSync(f))).toBe(true);
    expect(json(await admin.del(`/candidates/${cand.id}`))).toEqual({ ok: true });
    expect(files.some((f) => existsSync(f))).toBe(false);
    expect(await env.ctx.db.select().from(evidence).where(eq(evidence.sessionId, sid))).toHaveLength(0);
    expect(await env.ctx.db.select().from(evidence).where(eq(evidence.candidateId, cand.id))).toHaveLength(0);
    expect(await env.ctx.db.select().from(examSessions).where(eq(examSessions.id, sid))).toHaveLength(0);
    expect((await reviewer.get(`/candidates/${cand.id}`)).statusCode).toBe(404);
    const [a] = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'candidate.deleted'), eq(auditLog.targetId, cand.id)));
    expect(a.meta).toMatchObject({ sessionsDeleted: 1 });
  });
});

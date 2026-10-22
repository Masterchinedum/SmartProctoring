/**
 * The optional external second opinion wired into the identity engine (docs/EXTERNAL_VERIFIER.md), with a mocked
 * Amazon Rekognition client: check-in (enrolment consistency, ID photo with ID-photo thresholds), resume checks and
 * suspected swaps during the exam. Off => exactly the previous behaviour; the provider agrees; the provider
 * contradicts a borderline decision (inconclusive + human review, never "different person" from it alone); a clear
 * internal decision — including a mismatch the accumulated evidence decided, whatever its raw similarity — is kept
 * but flagged; provider errors fail open.
 */
import type { CompleteCheckResponse, IdentitySampleResponse, OrgSettingsDTO } from '@sp/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { events, examSessions, identityChecks } from '../src/db/schema.js';
import { loadIdentityCheckDTOs } from '../src/services/dto.js';
import { identityState } from '../src/services/session-state.js';
import type { SecondOpinionRecord } from '../src/services/identity-external.js';
import { awsRekognitionProvider, VerifierRegistry } from '../src/verifiers/registry.js';
import { json, staffApi, type Api } from './admin/fixtures.js';
import { burst, consent, runCheck, startedSession } from './flow.js';
import { createTestEnv, type TestEnv } from './helpers.js';
import { awsError, faceMatch, MockRekognition } from './verifiers/mock-rekognition.js';

let env: TestEnv;
let admin: Api;
let mock: MockRekognition;

const awsWithKey = { provider: 'aws-rekognition', region: 'eu-west-1', accessKeyId: 'AKIATESTEXAMPLE7Q2W', secretAccessKey: 'tEsT/Secret+AccessKey0123456789abcdefWXYZ' } as const;
const SAME = () => faceMatch(99.1);
const DIFFERENT = () => faceMatch(3.2);
const FAILING = () => {
  throw awsError('InternalServerError', 'provider exploded', 500);
};

beforeAll(async () => {
  env = await createTestEnv();
  admin = await staffApi(env, 'admin');
  mock = new MockRekognition(SAME);
  env.ctx.verifiers = new VerifierRegistry({ providers: [awsRekognitionProvider({ createClient: (cfg) => mock.factory(cfg), retryBackoffMs: 1 })] });
});
afterAll(async () => env?.close());

const eventsOf = async (id: string) => env.ctx.db.select().from(events).where(eq(events.sessionId, id)).orderBy(events.startedAt);
const checksOf = async (id: string) => env.ctx.db.select().from(identityChecks).where(eq(identityChecks.sessionId, id)).orderBy(identityChecks.at, identityChecks.receivedAt);
const sessionRow = async (id: string) => (await env.ctx.db.select().from(examSessions).where(eq(examSessions.id, id)))[0];
const opinionOf = (row: { context: unknown }) => (row.context as { secondOpinion?: SecondOpinionRecord }).secondOpinion;

async function freshSession(policy?: Record<string, unknown>, candidateId?: string) {
  const examId = policy ? (await env.newExam({ policy })).exam.id : env.exam.id;
  const s = await env.newSession({ examId, candidateId });
  return { s, c: env.candidateClient(s.token) };
}

/** Started exam with a clean exam_start burst. */
async function started(policy?: Record<string, unknown>) {
  const x = await freshSession(policy);
  await startedSession(env, x.c);
  await burst(env, x.c, [{ person: 'alice' }, { person: 'alice' }, { person: 'alice' }], { trigger: 'exam_start' });
  return x;
}

/** Two bursts of `spec` (a track break, then the requested fast sample). Returns the second response. */
async function swapBursts(c: ReturnType<TestEnv['candidateClient']>, spec: object) {
  env.clock.advance(6_000);
  const first = (await burst(env, c, [spec, spec, spec], { trigger: 'track_break' })).last as IdentitySampleResponse;
  env.clock.advance(2_500);
  const second = (await burst(env, c, [spec, spec, spec], { trigger: 'server_request' })).last as IdentitySampleResponse;
  return { first, second };
}

describe('external verifier off (the default)', () => {
  it('configured but not used for any decision point: no call, behaviour and records unchanged', async () => {
    const s = json<OrgSettingsDTO>(await admin.put('/settings', { externalVerifier: awsWithKey }));
    expect(s.externalVerifier).toMatchObject({ active: false });
    const { s: sess, c } = await started();
    await c.req('POST', '/api/candidate/pause', {});
    expect((await runCheck(env, c, 'resume')).complete!.outcome).toBe('passed');
    await burst(env, c, [{ person: 'alice' }, { person: 'alice' }, { person: 'alice' }], { trigger: 'exam_start' });
    const { second } = await swapBursts(c, { person: 'mallory' });
    expect(second.status).toBe('on_hold');
    expect(mock.inputs).toHaveLength(0);
    for (const r of await checksOf(sess.id)) expect(opinionOf(r)).toBeUndefined();
    const mm = (await eventsOf(sess.id)).find((e) => e.type === 'identity_mismatch')!;
    expect(mm.details).not.toHaveProperty('secondOpinion');
    expect(mm.details).not.toHaveProperty('needsHumanReview');
    const dtos = await loadIdentityCheckDTOs(env.ctx.db, sess.id);
    expect(dtos.every((d) => !('secondOpinion' in d))).toBe(true);
  });
});

describe('external verifier on (check-in, resume, suspected swap)', () => {
  beforeAll(async () => {
    env.clock.advance(60_000);
    const s = json<OrgSettingsDTO>(await admin.put('/settings', { externalVerifier: { useFor: { checkIn: true, resume: true, suspectedSwap: true } } }));
    expect(s.externalVerifier).toMatchObject({ active: true, enabledAt: env.clock.t });
    env.clock.advance(1_000); // candidates below consent after enablement (their notice names the provider)
  });

  it('the provider agrees: check-in, resume and a confirmed swap record the second opinion', async () => {
    mock.handler = SAME;
    const n0 = mock.inputs.length;
    const { s, c } = await started();
    // check-in: one comparison (no ID photo => the enrolment's own consistency), agreeing
    expect(mock.inputs.length).toBe(n0 + 1);
    expect(mock.inputs[n0].SourceImage?.Bytes?.length).toBeGreaterThan(0);
    expect(mock.inputs[n0].TargetImage?.Bytes?.length).toBeGreaterThan(0);
    const checkIn = (await checksOf(s.id)).find((r) => r.trigger === 'check_in')!;
    expect(opinionOf(checkIn)).toMatchObject({ kind: 'check_in', outcome: 'agree', decision: 'match', needsHumanReview: false, provider: 'aws-rekognition' });
    // routine matching samples are never sent
    expect(mock.inputs.length).toBe(n0 + 1);

    await c.req('POST', '/api/candidate/pause', {});
    const resumed = (await runCheck(env, c, 'resume')).complete!;
    expect(resumed.outcome).toBe('passed');
    expect(mock.inputs.length).toBe(n0 + 2);
    const resumeRow = (await checksOf(s.id)).find((r) => r.trigger === 'resume')!;
    expect(opinionOf(resumeRow)).toMatchObject({ kind: 'resume', outcome: 'agree', needsHumanReview: false });
    const verified = (await eventsOf(s.id)).find((e) => e.type === 'identity_verified')!;
    expect(verified.details).toMatchObject({ needsHumanReview: false, secondOpinion: { outcome: 'agree' } });
    const dto = (await loadIdentityCheckDTOs(env.ctx.db, s.id)).find((d) => d.trigger === 'resume')!;
    expect(dto.secondOpinion).toMatchObject({ provider: 'aws-rekognition', outcome: 'agree', needsHumanReview: false, externalSimilarity: 0.991, internalDecision: 'match' });

    // suspected swap: the provider says "different person" too => confirmed as before
    await burst(env, c, [{ person: 'alice' }, { person: 'alice' }, { person: 'alice' }], { trigger: 'exam_start' });
    mock.handler = DIFFERENT;
    const { first, second } = await swapBursts(c, { person: 'mallory' });
    expect(first.status).toBe('active'); // 'suspect' after the first burst (staff side)
    expect(second.status).toBe('on_hold');
    expect(second.hold!.reason).toBe('identity_mismatch');
    expect(mock.inputs.length).toBe(n0 + 3); // one call, at confirmation
    const mm = (await eventsOf(s.id)).find((e) => e.type === 'identity_mismatch')!;
    expect(mm.details).toMatchObject({ needsHumanReview: false, secondOpinion: { kind: 'suspected_swap', outcome: 'agree', decision: 'mismatch' }, samples: 2 });
    expect(JSON.stringify(mm.details)).not.toMatch(/SPFAKE|Bytes/);
  });

  it('a suspected swap the SPRT confirmed is never overruled by a confident "same person" (a look-alike is not "borderline"): confirmed, flagged for review', async () => {
    const { s, c } = await started();
    mock.handler = SAME;
    const n0 = mock.inputs.length;
    // A look-alike: 0.30 is close to the mismatch threshold by raw similarity, but the accumulated evidence over two
    // bursts (a strong drop from this person's own level) is decisive.
    const lookAlike = { person: 'alice', similarity: 0.3 };
    const { second } = await swapBursts(c, lookAlike);
    expect(mock.inputs.length).toBe(n0 + 1);
    expect(second.status).toBe('on_hold');
    const evs = await eventsOf(s.id);
    const mm = evs.find((e) => e.type === 'identity_mismatch')!;
    expect(mm.details).toMatchObject({
      needsHumanReview: true,
      secondOpinion: { outcome: 'disagreement_flagged', decision: 'mismatch', internalStrength: 'clear', record: { internal: { decision: 'mismatch', evidence: { decisive: true } } } },
    });
    expect(evs.filter((e) => e.type === 'identity_unverifiable' && (e.details as { reason?: string }).reason === 'second_opinion_disagrees')).toHaveLength(0);
    const st = identityState(await sessionRow(s.id));
    expect(st.secondOpinionVeto ?? null).toBeNull();
    const confirming = (await checksOf(s.id)).find((r) => opinionOf(r)?.kind === 'suspected_swap')!;
    expect(opinionOf(confirming)).toMatchObject({ needsHumanReview: true, externalBand: 'same', internalStrength: 'clear' });
  });

  it('resume: a mismatch the frames decided (likely_mismatch) is kept even when its raw similarity looks borderline — flagged for review', async () => {
    const { s, c } = await started();
    await c.req('POST', '/api/candidate/pause', {});
    mock.handler = SAME;
    const { complete, identity } = await runCheck(env, c, 'resume', { spec: { person: 'alice', similarity: 0.25 } });
    expect(complete!.outcome).toBe('held');
    expect(identity!.decision).toBe('mismatch');
    const row = (await checksOf(s.id)).filter((r) => r.trigger === 'resume').pop()!;
    expect(opinionOf(row)).toMatchObject({ outcome: 'disagreement_flagged', internalDecision: 'mismatch', decision: 'mismatch', internalStrength: 'clear', needsHumanReview: true });
    const mm = (await eventsOf(s.id)).find((e) => e.type === 'identity_mismatch')!;
    expect(mm.details).toMatchObject({ needsHumanReview: true });
  });

  it('resume: an internally inconclusive check is resolved by a confident "same person" (passes first time)', async () => {
    const { s, c } = await started();
    await c.req('POST', '/api/candidate/pause', {});
    mock.handler = SAME;
    // 0.38 after a pause (relaxed normalisation): neither clearly the same nor clearly different => internally inconclusive.
    const { complete, identity } = await runCheck(env, c, 'resume', { spec: { person: 'alice', similarity: 0.38 } });
    expect(complete!.outcome, JSON.stringify(complete)).toBe('passed');
    expect(identity!.decision).toBe('match');
    const row = (await checksOf(s.id)).filter((r) => r.trigger === 'resume').pop()!;
    expect(opinionOf(row)).toMatchObject({ outcome: 'resolved_by_external', internalDecision: 'inconclusive', decision: 'match', needsHumanReview: false });
  });

  it('resume: a clear mismatch the provider contradicts is still held — flagged for human review', async () => {
    const { s, c } = await started();
    await c.req('POST', '/api/candidate/pause', {});
    mock.handler = SAME;
    const { complete, identity } = await runCheck(env, c, 'resume', { spec: { person: 'mallory' } });
    expect(complete!.outcome).toBe('held');
    expect(identity!.decision).toBe('mismatch');
    const mm = (await eventsOf(s.id)).find((e) => e.type === 'identity_mismatch')!;
    expect(mm.details).toMatchObject({ needsHumanReview: true, secondOpinion: { outcome: 'disagreement_flagged', decision: 'mismatch' } });
  });

  it('provider errors fail open: resume and swap decisions are the internal ones, the failure is recorded', async () => {
    const { s, c } = await started();
    mock.handler = FAILING;
    await c.req('POST', '/api/candidate/pause', {});
    const resumed = (await runCheck(env, c, 'resume')).complete!;
    expect(resumed.outcome).toBe('passed');
    const resumeRow = (await checksOf(s.id)).filter((r) => r.trigger === 'resume').pop()!;
    expect(opinionOf(resumeRow)).toMatchObject({ outcome: 'external_unusable', externalBand: 'error', decision: 'match', needsHumanReview: false });
    await burst(env, c, [{ person: 'alice' }, { person: 'alice' }, { person: 'alice' }], { trigger: 'exam_start' });
    const { second } = await swapBursts(c, { person: 'mallory' });
    expect(second.status).toBe('on_hold');
    const mm = (await eventsOf(s.id)).find((e) => e.type === 'identity_mismatch')!;
    expect(mm.details).toMatchObject({ needsHumanReview: false, secondOpinion: { outcome: 'external_unusable', record: { external: { status: 'error', error: 'provider_error' } } } });
    mock.handler = SAME;
  });

  it('check-in with an approved ID photo: judged with the ID-photo thresholds; a confident "same" resolves an inconclusive comparison', async () => {
    const cand = await env.newCandidate('Photo Owner');
    const up = json(await admin.jpeg(`/candidates/${cand.id}/id-photo`, { person: 'id-owner' }));
    expect(up.accepted).toBe(true);
    mock.handler = SAME;
    const { s, c } = await freshSession({ identity: { idPhotoComparison: 'required' } }, cand.id);
    await consent(c);
    const n0 = mock.inputs.length;
    // 0.36 against the photo is between the ID-photo thresholds (0.24 / 0.42): inconclusive internally.
    const run = await runCheck(env, c, 'initial', { spec: { person: 'id-owner', similarity: 0.36 } });
    const r = run.complete as CompleteCheckResponse;
    expect(mock.inputs.length).toBe(n0 + 1); // only the ID-photo comparison is sent at check-in
    expect(run.idPhoto).toMatchObject({ decision: 'match' });
    expect(r.outcome).toBe('passed');
    const photoRow = (await checksOf(s.id)).find((x) => x.trigger === 'id_photo')!;
    expect(opinionOf(photoRow)).toMatchObject({ kind: 'check_in', outcome: 'resolved_by_external', internalDecision: 'inconclusive', decision: 'match' });
    const compared = (await eventsOf(s.id)).find((e) => e.type === 'id_photo_compared')!;
    expect(compared.details).toMatchObject({ decision: 'match', secondOpinion: { outcome: 'resolved_by_external' } });
    const held = await env.ctx.db.select().from(events).where(and(eq(events.sessionId, s.id), eq(events.type, 'session_held')));
    expect(held).toHaveLength(0);
  });

  it('candidates who consented before the provider was enabled are never sent', async () => {
    // Switch the provider off and on again: enabledAt moves past this candidate's consent.
    const { s, c } = await freshSession();
    await consent(c);
    env.clock.advance(1_000);
    json(await admin.put('/settings', { externalVerifier: { useFor: { checkIn: false, resume: false, suspectedSwap: false } } }));
    env.clock.advance(1_000);
    json(await admin.put('/settings', { externalVerifier: { useFor: { checkIn: true, resume: true, suspectedSwap: true } } }));
    const n0 = mock.inputs.length;
    expect((await runCheck(env, c, 'initial')).complete!.outcome).toBe('passed');
    expect(mock.inputs.length).toBe(n0);
    expect(opinionOf((await checksOf(s.id)).find((r) => r.trigger === 'check_in')!)).toBeUndefined();
  });
});

/**
 * Model governance (services/decision-configs.ts, services/calibration.ts, routes/admin/governance.ts): versioned
 * identity thresholds — proposal with a reason, preview on recent samples, approval by a second administrator
 * (self-approval only without another one), rejection / withdrawal, immediate rollback to an approved version,
 * thresholds no longer changed through Settings — the version stamped on every identity decision, and the
 * calibration-by-condition and drift reports.
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_IDENTITY_THRESHOLDS, type CalibrationDTO, type DecisionConfigDTO, type DecisionConfigImpactDTO, type DecisionConfigsDTO, type DriftDTO, type SessionReportDTO, type TimelineItemDTO } from '@sp/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, deviceRecords, events, identityChecks, organizations } from '../src/db/schema.js';
import { CALIBRATION } from '../src/vision/calibration.js';
import { json, MIN, otherOrg, staffApi, type Api } from './admin/fixtures.js';
import { sample, sampleDecision, startedSession } from './flow.js';
import { createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let admin: Api;
let owner: Api;
let reviewer: Api;

beforeAll(async () => {
  env = await createTestEnv();
});
beforeEach(async () => {
  [admin, owner, reviewer] = await Promise.all([staffApi(env, 'admin'), staffApi(env, 'owner'), staffApi(env, 'reviewer')]);
});
afterAll(async () => env?.close());

const list = async (api: Api = admin) => json<DecisionConfigsDTO>(await api.get('/decision-configs'));
const NEW = { ...DEFAULT_IDENTITY_THRESHOLDS, mismatch: Math.round((DEFAULT_IDENTITY_THRESHOLDS.mismatch - 0.04) * 100) / 100 };

describe('decision configurations', () => {
  it('starts from the release defaults (version 1) and no longer changes thresholds through Settings', async () => {
    const l = await list(reviewer);
    expect(l.items).toHaveLength(1);
    expect(l.items[0]).toMatchObject({ version: 1, status: 'active', releaseDefaults: true, thresholds: DEFAULT_IDENTITY_THRESHOLDS, proposedBy: null });
    expect(l).toMatchObject({ releaseDefaults: DEFAULT_IDENTITY_THRESHOLDS, calibrationVersion: CALIBRATION.version });
    const refused = await admin.put('/settings', { identityThresholds: { mismatch: 0.2 } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('decision_config_required');
    expect((await reviewer.post('/decision-configs', { thresholds: NEW, note: 'Reviewers cannot propose.' })).statusCode).toBe(403);
  });

  it('is proposed with a reason, previewed, and approved by a second administrator; decisions record the version', async () => {
    // Recent samples to preview on: one just under the current mismatch threshold, one well above match.
    const s = await env.newSession();
    const c = await startedSession(env, env.candidateClient(s.token));
    env.clock.advance(MIN);
    await sample(env, c, { person: 'alice' });
    const [anyCheck] = await env.ctx.db.select().from(identityChecks).where(eq(identityChecks.sessionId, s.id));
    expect(anyCheck).toMatchObject({ decisionConfigVersion: 1, calibrationVersion: CALIBRATION.version });
    expect(anyCheck.modelVersion).toMatch(/\S/);
    const t = DEFAULT_IDENTITY_THRESHOLDS;
    for (const similarity of [t.mismatch - 0.01, t.match + 0.1]) {
      await env.ctx.db.insert(identityChecks).values({ sessionId: s.id, trigger: 'periodic', decision: 'inconclusive', similarity, confidence: 0.5, at: new Date(env.clock.t), receivedAt: new Date(env.clock.t) });
    }

    expect((await admin.post('/decision-configs', { thresholds: NEW, note: 'short' })).statusCode).toBe(400);
    expect((await admin.post('/decision-configs', { thresholds: { ...NEW, mismatch: 0.9 }, note: 'Mismatch above match is invalid.' })).statusCode).toBe(400);
    expect((await admin.post('/decision-configs', { thresholds: DEFAULT_IDENTITY_THRESHOLDS, note: 'Nothing changes here at all.' })).json().error).toBe('no_change');
    const p = json<DecisionConfigDTO>(await admin.post('/decision-configs', { thresholds: NEW, note: 'Pilot: too many inconclusive samples in dim rooms.' }));
    expect(p).toMatchObject({ version: 2, status: 'proposed', basedOnVersion: 1, thresholds: NEW, releaseDefaults: false, proposedBy: { name: 'Test admin' } });
    expect((await owner.post('/decision-configs', { thresholds: { ...NEW, match: 0.5 }, note: 'A second proposal at the same time.' })).json().error).toBe('proposal_open');

    const impact = json<DecisionConfigImpactDTO>(await owner.get(`/decision-configs/${p.id}/impact`));
    expect(impact.samples).toBeGreaterThanOrEqual(3);
    expect(impact.changes).toEqual([{ from: 'mismatch', to: 'inconclusive', count: 1 }]);

    // Four eyes: not by the proposer while another administrator exists.
    const self = await admin.post(`/decision-configs/${p.id}/approve`, {});
    expect(self.statusCode).toBe(403);
    expect(self.json().error).toBe('four_eyes_required');
    const approved = json<DecisionConfigDTO>(await owner.post(`/decision-configs/${p.id}/approve`, { note: 'Checked the pilot data.' }));
    expect(approved).toMatchObject({ status: 'active', decidedBy: { name: 'Test owner' }, decisionNote: 'Checked the pilot data.', selfApproved: false });
    const l = await list();
    expect(l.items.map((c) => [c.version, c.status])).toEqual([
      [2, 'active'],
      [1, 'retired'],
    ]);
    // Exams started while each version was active.
    expect(l.items.map((c) => c.sessions)).toEqual([0, 1]);
    const later = await env.newSession();
    await startedSession(env, env.candidateClient(later.token));
    expect((await list()).items.map((c) => c.sessions)).toEqual([1, 1]);
    const [org] = await env.ctx.db.select().from(organizations).where(eq(organizations.id, env.org.id));
    expect(org.settings).toMatchObject({ identityThresholds: NEW, decisionConfigVersion: 2 });

    // The next decision (in an exam already in progress) uses and records version 2.
    env.clock.advance(MIN);
    expect(await sampleDecision(env, json(await sample(env, c, { person: 'alice' })))).toBe('match');
    const checks = await env.ctx.db.select().from(identityChecks).where(eq(identityChecks.sessionId, s.id));
    expect(checks.at(-1)!.decisionConfigVersion).toBe(2);
    // The staff timeline and report show which versions decided.
    const timeline = json<{ items: TimelineItemDTO[] }>(await reviewer.get(`/sessions/${s.id}/timeline`)).items;
    const versions = timeline.flatMap((i) => (i.kind === 'identity_check' ? [i.check.versions?.decisionConfig] : []));
    expect(versions).toContain(1);
    expect(versions.at(-1)).toBe(2);
    const report = json<SessionReportDTO>(await reviewer.get(`/sessions/${s.id}/report`));
    expect(report.identity.versions).toEqual({ decisionConfigs: [1, 2], calibrations: [CALIBRATION.version], models: [anyCheck.modelVersion] });
    const actions = (await env.ctx.db.select().from(auditLog).where(eq(auditLog.targetType, 'decision_config'))).map((a) => a.action);
    expect(actions).toEqual(['decision_config.proposed', 'decision_config.approved']);
  });

  it('can be rejected by another administrator or withdrawn by its proposer', async () => {
    const p = json<DecisionConfigDTO>(await owner.post('/decision-configs', { thresholds: { ...NEW, match: 0.5 }, note: 'Stricter matching after an incident.' }));
    expect((await owner.post(`/decision-configs/${p.id}/reject`, {})).json().error).toBe('four_eyes_required');
    expect((await admin.post(`/decision-configs/${p.id}/withdraw`, {})).json().error).toBe('not_proposer');
    expect(json<DecisionConfigDTO>(await admin.post(`/decision-configs/${p.id}/reject`, { note: 'Not enough evidence.' })).status).toBe('rejected');
    const q = json<DecisionConfigDTO>(await owner.post('/decision-configs', { thresholds: { ...NEW, match: 0.5 }, note: 'Second try with the evidence attached.' }));
    expect(json<DecisionConfigDTO>(await owner.post(`/decision-configs/${q.id}/withdraw`, {})).status).toBe('withdrawn');
    expect((await owner.post(`/decision-configs/${q.id}/approve`, {})).json().error).toBe('not_proposed');
    expect((await list()).items.find((c) => c.status === 'active')!.version).toBe(2);
  });

  it('restores an approved version at once (withdrawing an open proposal); back to the release defaults', async () => {
    const open = json<DecisionConfigDTO>(await admin.post('/decision-configs', { thresholds: { ...NEW, match: 0.48 }, note: 'Pending while the incident happens.' }));
    const v1 = (await list()).items.find((c) => c.version === 1)!;
    expect((await admin.post(`/decision-configs/${v1.id}/rollback`, { note: 'x' })).statusCode).toBe(400);
    expect((await admin.post(`/decision-configs/${open.id}/rollback`, { note: 'Not a retired version.' })).json().error).toBe('not_retired');
    const r = json<DecisionConfigDTO>(await admin.post(`/decision-configs/${v1.id}/rollback`, { note: 'False suspicions rose after v2: back to the defaults.' }));
    expect(r).toMatchObject({ status: 'active', rollbackOfVersion: 1, basedOnVersion: 2, releaseDefaults: true, thresholds: DEFAULT_IDENTITY_THRESHOLDS });
    const l = await list();
    expect(l.items.find((c) => c.id === open.id)!.status).toBe('withdrawn');
    expect(l.items.filter((c) => c.status === 'active').map((c) => c.version)).toEqual([r.version]);
    const [org] = await env.ctx.db.select().from(organizations).where(eq(organizations.id, env.org.id));
    expect(org.settings.identityThresholds).toBeUndefined();
    expect(org.settings.decisionConfigVersion).toBe(r.version);
    const [rolled] = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'decision_config.rolled_back'), eq(auditLog.targetId, r.id)));
    expect(rolled.meta).toMatchObject({ restores: 1, replaces: 2 });
  });

  it('lets the only administrator approve their own proposal, recorded as such', async () => {
    const other = await otherOrg(env);
    const p = json<DecisionConfigDTO>(await other.api.post('/decision-configs', { thresholds: NEW, note: 'Small college, one administrator.' }));
    const a = json<DecisionConfigDTO>(await other.api.post(`/decision-configs/${p.id}/approve`, {}));
    expect(a).toMatchObject({ status: 'active', selfApproved: true });
    // Organisations never see each other's configurations.
    expect((await admin.get(`/decision-configs/${p.id}/impact`)).statusCode).toBe(404);
  });
});

describe('calibration and drift', () => {
  it('breaks identity decisions down by condition and by version', async () => {
    const s = await env.newSession();
    // Two months ago: apart from the other tests' samples and outside the drift windows.
    const t0 = env.clock.t - 60 * 86_400_000;
    await env.ctx.db.insert(deviceRecords).values({
      sessionId: s.id,
      at: new Date(t0),
      clientInstanceId: 'i1',
      purpose: 'initial',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      videoHeight: 480,
    });
    const at = new Date(t0);
    const row = (decision: 'match' | 'unable_to_verify', brightness: number) => ({
      sessionId: s.id,
      trigger: 'periodic' as const,
      decision,
      similarity: decision === 'match' ? 0.7 : null,
      confidence: 0.8,
      quality: { brightness } as never,
      at,
      receivedAt: at,
      decisionConfigVersion: 7,
      calibrationVersion: 'test-cal',
      modelVersion: 'test-model',
    });
    await env.ctx.db.insert(identityChecks).values([row('match', 140), row('match', 150), row('unable_to_verify', 40)]);
    const c = json<CalibrationDTO>(await reviewer.get('/metrics/calibration', { from: t0 - MIN, to: t0 + MIN }));
    expect(c.samples).toBe(3);
    const seg = (dim: string, name: string) => c.segments.find((x) => x.dimension === dim && x.segment === name);
    expect(seg('lighting', 'typical')).toMatchObject({ samples: 2, match: 2 });
    expect(seg('lighting', 'dark')).toMatchObject({ samples: 1, unableToVerify: 1 });
    expect(seg('browser', 'Safari')).toMatchObject({ samples: 3 });
    expect(seg('os', 'macOS')).toMatchObject({ samples: 3 });
    expect(seg('resolution', 'low (≤ 480p)')).toMatchObject({ samples: 3 });
    expect(seg('decisionConfig', 'v7')).toMatchObject({ samples: 3 });
    expect(seg('calibration', 'test-cal')).toMatchObject({ samples: 3 });
    expect((await reviewer.get('/metrics/calibration', { from: 10, to: 5 })).statusCode).toBe(400);
  });

  it('records the version of the browser detectors on the events they raise', async () => {
    const s = await env.newSession();
    const c = await startedSession(env, env.candidateClient(s.token));
    env.clock.advance(MIN);
    const ev = (id: string) => ({ id, type: 'phone_detected', phase: 'close', startedAt: env.clock.t - 5000, endedAt: env.clock.t, confidence: 0.9, details: {}, version: 1 });
    const [a, b] = [randomUUID(), randomUUID()];
    expect((await c.req('POST', '/api/candidate/events/batch', { events: [ev(a)], engineVersion: 'detectors-test.1' })).statusCode).toBe(200);
    expect((await c.req('POST', '/api/candidate/events/batch', { events: [ev(b)] })).statusCode).toBe(200);
    expect((await c.req('POST', '/api/candidate/events/batch', { events: [ev(randomUUID())], engineVersion: 'not a version!' })).statusCode).toBe(400);
    const rows = await env.ctx.db.select({ id: events.id, v: events.engineVersion }).from(events).where(inArray(events.id, [a, b]));
    expect(Object.fromEntries(rows.map((r) => [r.id, r.v]))).toEqual({ [a]: 'detectors-test.1', [b]: null });
    // First seen: listed with the drift report's version changes.
    expect(json<DriftDTO>(await reviewer.get('/metrics/drift')).changes).toContainEqual(expect.objectContaining({ kind: 'engine', label: 'Browser detectors detectors-test.1' }));
  });

  it('flags a rate that changed significantly in the last week, with the version changes next to it', async () => {
    const s = await env.newSession();
    const now = env.clock.t;
    const mk = (n: number, decision: 'match' | 'unable_to_verify', daysAgo: number) =>
      Array.from({ length: n }, (_, i) => ({
        sessionId: s.id,
        trigger: 'periodic' as const,
        decision,
        similarity: null,
        confidence: 0.5,
        at: new Date(now - daysAgo * 86_400_000 - i * 1000),
        receivedAt: new Date(now),
        calibrationVersion: 'drift-cal',
      }));
    // Baseline (10–30 days ago): 3 % could not verify; last week: 20 %.
    await env.ctx.db.insert(identityChecks).values([...mk(388, 'match', 15), ...mk(12, 'unable_to_verify', 15), ...mk(160, 'match', 2), ...mk(40, 'unable_to_verify', 2)]);
    const d = json<DriftDTO>(await reviewer.get('/metrics/drift'));
    const overall = d.signals.find((x) => x.area === 'identity' && x.metric === 'unable_to_verify_rate' && x.dimension === 'overall')!;
    expect(overall.comparison.drift).toBe(true);
    expect(overall.comparison.recent.rate).toBeGreaterThan(overall.comparison.baseline.rate!);
    expect(d.signals[0].comparison.drift).toBe(true); // drifting signals first
    expect(d.changes.map((c) => c.kind)).toContain('decision_config');
    expect(d.recent.to - d.recent.from).toBe(7 * 86_400_000);
  });
});

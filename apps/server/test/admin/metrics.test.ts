/**
 * Staff API: detection-quality metrics from reviewer decisions and identity checks, and offline
 * evaluation report uploads.
 */
import type { DetectionQualityDTO } from '@sp/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluationReports, events, examSessions, identityChecks } from '../../src/db/schema.js';
import { precision } from '../../src/services/metrics.js';
import { sample, startedSession } from '../flow.js';
import { createTestEnv, type TestEnv } from '../helpers.js';
import { clientEvent, json, MIN, otherOrg, staffApi, type Api } from './fixtures.js';

let env: TestEnv;
let reviewer: Api;
let admin: Api;
let t0: number;
let mismatchEventId: string;

beforeAll(async () => {
  env = await createTestEnv();
  reviewer = await staffApi(env, 'reviewer');
  admin = await staffApi(env, 'admin');
  t0 = env.clock.t;
  const c = await startedSession(env);
  env.clock.advance(5 * MIN);
  const t = env.clock.t;
  const mp = [];
  for (let i = 0; i < 3; i++) mp.push(await clientEvent(c, { type: 'multiple_people', startedAt: t - 100_000 + i * 20_000, endedAt: t - 95_000 + i * 20_000, confidence: 0.8 }));
  const tabs = [await clientEvent(c, { type: 'tab_hidden', startedAt: t - 30_000, endedAt: t - 25_000 }), await clientEvent(c, { type: 'tab_hidden', startedAt: t - 20_000, endedAt: t - 15_000 })];
  await clientEvent(c, { type: 'phone_detected', startedAt: t - 10_000, endedAt: t - 8_000, confidence: 0.6 });
  json(await reviewer.post(`/events/${mp[0]}/review`, { status: 'reviewed' }));
  json(await reviewer.post(`/events/${mp[1]}/review`, { status: 'reviewed' }));
  json(await reviewer.post(`/events/${mp[2]}/review`, { status: 'dismissed' }));
  for (const id of tabs) json(await reviewer.post(`/events/${id}/review`, { status: 'dismissed' }));
  // identity: two routine matches, then a different person (periodic + follow-up) -> identity_mismatch
  for (let i = 0; i < 2; i++) {
    env.clock.advance(30_000);
    expect(json(await sample(env, c, { person: 'alice' })).result.decision).toBe('match');
  }
  env.clock.advance(30_000);
  json(await sample(env, c, { person: 'mallory' }));
  env.clock.advance(4_000);
  json(await sample(env, c, { person: 'mallory' }, 'follow_up'));
  const [mm] = await env.ctx.db.select().from(events).where(eq(events.type, 'identity_mismatch'));
  mismatchEventId = mm.id;
  json(await reviewer.post(`/events/${mismatchEventId}/review`, { status: 'dismissed', note: 'Same person, poor angle' }));
});
afterAll(async () => env?.close());

describe('detection quality', () => {
  it('computes per-detector totals, review outcomes and the precision proxy', async () => {
    const m = json<DetectionQualityDTO>(await reviewer.get('/metrics/detection-quality', { from: t0, to: env.clock.t }));
    expect(m.from).toBe(t0);
    expect(m.to).toBe(env.clock.t);
    const by = Object.fromEntries(m.byType.map((b) => [b.type, b]));
    expect(by.multiple_people).toEqual({ type: 'multiple_people', category: 'integrity', total: 3, reviewed: 2, dismissed: 1, unreviewed: 0, precision: 0.6667 });
    expect(by.tab_hidden).toMatchObject({ total: 2, reviewed: 0, dismissed: 2, precision: 0 });
    expect(by.phone_detected).toMatchObject({ total: 1, unreviewed: 1, precision: null });
    expect(by.identity_mismatch).toMatchObject({ total: 1, dismissed: 1, precision: 0 });
    expect(m.byType.every((b) => b.category !== 'neutral')).toBe(true);
    expect(m.byType[0].category).toBe('integrity');
  });

  it('counts identity decisions overall and by trigger, and mismatch review outcomes', async () => {
    const m = json<DetectionQualityDTO>(await reviewer.get('/metrics/detection-quality', { from: t0, to: env.clock.t }));
    const [{ n }] = await env.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(identityChecks)
      .innerJoin(examSessions, eq(examSessions.id, identityChecks.sessionId))
      .where(eq(examSessions.orgId, env.org.id));
    expect(m.identity.checks).toBe(n);
    expect(Object.values(m.identity.byDecision).reduce((a, b) => a + b, 0)).toBe(n);
    expect(m.identity.byDecision.mismatch).toBe(2);
    expect(m.identity.byTrigger.periodic).toEqual({ match: 2, mismatch: 1, inconclusive: 0, unable_to_verify: 0 });
    expect(m.identity.byTrigger.follow_up).toEqual({ match: 0, mismatch: 1, inconclusive: 0, unable_to_verify: 0 });
    expect(m.identity.byTrigger.check_in.match).toBeGreaterThanOrEqual(1);
    expect(Object.keys(m.identity.byTrigger)).toContain('id_photo');
    expect(m.identity.mismatchEventsDismissed).toBe(1);
    expect(m.identity.mismatchEventsConfirmed).toBe(0);
    expect(m.offlineEvaluation).toBeNull();
  });

  it('respects the time range and the organisation', async () => {
    const before = json<DetectionQualityDTO>(await reviewer.get('/metrics/detection-quality', { from: t0 - 10 * MIN, to: t0 - MIN }));
    expect(before.byType).toEqual([]);
    expect(before.identity.checks).toBe(0);
    const dflt = json<DetectionQualityDTO>(await reviewer.get('/metrics/detection-quality'));
    expect(dflt.to).toBe(env.clock.t);
    expect(dflt.from).toBe(0); // no range = all time
    expect(dflt.byType.length).toBeGreaterThan(0);
    expect((await reviewer.get('/metrics/detection-quality', { from: 10, to: 5 })).statusCode).toBe(400);
    const other = await otherOrg(env);
    const theirs = json<DetectionQualityDTO>(await other.api.get('/metrics/detection-quality', { from: t0, to: env.clock.t }));
    expect(theirs.byType).toEqual([]);
    expect(theirs.identity.checks).toBe(0);
  });

  it('precision helper', () => {
    expect(precision(0, 0)).toBeNull();
    expect(precision(1, 2)).toBe(0.3333);
    expect(precision(5, 0)).toBe(1);
  });
});

describe('offline evaluation reports', () => {
  it('stores uploaded eval reports and returns the latest per kind', async () => {
    const report1 = { generatedAt: '2026-09-01T00:00:00Z', tool: 'identity-eval', mode: 'folder', groups: [{ name: 'all', fmr: 0.001 }] };
    const up = json(await admin.post('/metrics/offline-evaluation', report1));
    expect(up).toMatchObject({ kind: 'identity-eval', id: expect.any(String) });
    env.clock.advance(1000);
    const report2 = { ...report1, generatedAt: '2026-09-20T00:00:00Z', groups: [{ name: 'all', fmr: 0.0005 }] };
    json(await admin.post('/metrics/offline-evaluation', report2));
    env.clock.advance(1000);
    json(await admin.post('/metrics/offline-evaluation', { kind: 'Detection Eval', report: { scenarios: 12 } }));
    // a report shipped for all organisations
    await env.ctx.db.insert(evaluationReports).values({ orgId: null, kind: 'baseline', report: { note: 'release baseline' }, createdAt: new Date(env.clock.t - 60 * MIN) });

    const m = json<DetectionQualityDTO>(await reviewer.get('/metrics/detection-quality'));
    const off = m.offlineEvaluation as { reports: { kind: string; createdAt: number; global: boolean; report: Record<string, unknown> }[] };
    expect(off.reports.map((r) => r.kind)).toEqual(['detection-eval', 'identity-eval', 'baseline']);
    expect(off.reports[1].report).toEqual(report2);
    expect(off.reports[2].global).toBe(true);

    expect((await admin.post('/metrics/offline-evaluation', [1, 2])).statusCode).toBe(400);
    expect((await admin.post('/metrics/offline-evaluation', { groups: [] })).json().details[0].path).toBe('kind');
    // other organisations never see this organisation's uploads (only global ones)
    const other = await otherOrg(env);
    const theirs = json<DetectionQualityDTO>(await other.api.get('/metrics/detection-quality'));
    expect((theirs.offlineEvaluation as { reports: { kind: string }[] }).reports.map((r) => r.kind)).toEqual(['baseline']);
    const audits = json(await admin.get('/audit-log', { action: 'metrics.' }));
    expect(audits.total).toBe(3);
  });
});

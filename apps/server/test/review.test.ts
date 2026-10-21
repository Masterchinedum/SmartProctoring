/**
 * Reviewer workflow (services/review.ts, routes/admin/events.ts, routes/admin/review.ts): structured resolutions
 * with history and override reasons, explanations and incidents on the event detail, bulk and incident decisions,
 * the review queue (assignment, escalation, service-level targets), resolving / reopening a session's review (with
 * the timeline entry and the outcome-only webhook), and policy exceptions kept out of flags.
 */
import type { BulkReviewResultDTO, CreatedWebhookDTO, EventDetailDTO, ReviewQueueDTO, SessionDetailDTO, SessionReportDTO, SessionReviewDTO, SessionSummaryDTO } from '@sp/shared';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, eventReviews, events, staffUsers, webhookDeliveries } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/crypto.js';
import { clientEvent, json, MIN, staffApi, type Api } from './admin/fixtures.js';
import { startedSession } from './flow.js';
import { createTestEnv, TEST_PASSWORD, type CandidateClient, type TestEnv } from './helpers.js';

let env: TestEnv;
let reviewer: Api;
let reviewer2: Api;
let admin: Api;

beforeAll(async () => {
  env = await createTestEnv({ policy: { detection: { lookAwaySec: 7 } } });
  reviewer = await staffApi(env, 'reviewer');
  admin = await staffApi(env, 'admin');
  const [r2] = await env.ctx.db
    .insert(staffUsers)
    .values({ orgId: env.org.id, email: `rev2-${randomUUID().slice(0, 6)}@test.example`, name: 'Second Reviewer', role: 'reviewer', passwordHash: await hashPassword(TEST_PASSWORD), createdAt: new Date(env.clock.t), updatedAt: new Date(env.clock.t) })
    .returning();
  reviewer2 = await staffApi(env, r2);
});
// The tests move the clock by many minutes: fresh staff sessions for each (the idle timeout is 60 minutes).
beforeEach(async () => {
  if (!reviewer) return;
  [reviewer, reviewer2, admin] = await Promise.all([staffApi(env, reviewer.user), staffApi(env, reviewer2.user), staffApi(env, admin.user)]);
});
afterAll(async () => env?.close());

/** A session of a new candidate that started 15 minutes ago (events up to then are within the exam). */
async function started(): Promise<{ id: string; c: CandidateClient }> {
  const s = await env.newSession();
  const c = await startedSession(env, env.candidateClient(s.token));
  env.clock.advance(15 * MIN);
  return { id: s.id, c };
}

const review = (api: Api, id: string, body: Record<string, unknown>) => api.post(`/events/${id}/review`, body);

describe('event decisions', () => {
  it('records a resolution (with the implied status), keeps the history and requires a reason to change someone else’s decision', async () => {
    const { c } = await started();
    const t = env.clock.t;
    const id = await clientEvent(c, { type: 'tab_hidden', startedAt: t - 20_000, endedAt: t - 15_000 });

    const first = json<EventDetailDTO>(await review(reviewer, id, { resolution: 'no_concern', note: 'Closed a notification.' }));
    expect(first.review).toMatchObject({ status: 'reviewed', resolution: 'no_concern', by: reviewer.user.id, note: 'Closed a notification.' });

    // Another reviewer disagrees: without a reason it is refused; with one it is an override.
    const refused = await review(reviewer2, id, { resolution: 'concern' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe('reason_required');
    const second = json<EventDetailDTO>(await review(reviewer2, id, { resolution: 'concern', note: 'Tab switch lasted through two questions.' }));
    expect(second.review).toMatchObject({ status: 'reviewed', resolution: 'concern', by: reviewer2.user.id });
    expect(second.history.map((h) => [h.reviewerName, h.resolution, h.overrides])).toEqual([
      ['Test reviewer', 'no_concern', false],
      ['Second Reviewer', 'concern', true],
    ]);
    // The first reviewer can revise their own decision… of which the second is now the owner: a reason again.
    expect((await review(reviewer, id, { status: 'unreviewed' })).json().error).toBe('reason_required');
    const reset = json<EventDetailDTO>(await review(reviewer, id, { status: 'unreviewed', note: 'Discussed: decide after the call with the candidate.' }));
    expect(reset.review).toMatchObject({ status: 'unreviewed', resolution: null, by: null, note: null });

    const audits = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'event.review'), eq(auditLog.targetId, id)));
    expect(audits.map((a) => (a.meta as { overrides?: boolean }).overrides ?? false)).toEqual([false, true, true]);
    expect(audits[1].meta).toMatchObject({ from: 'reviewed', to: 'reviewed', fromResolution: 'no_concern', resolution: 'concern', previousReviewerId: reviewer.user.id });

    // The exportable trail: who changed the decision and why (administrators only; the export is audited too).
    expect((await reviewer.get('/audit-log.csv')).statusCode).toBe(403);
    const csv = await admin.get('/audit-log.csv', { action: 'event.review', targetId: id });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['x-audit-truncated']).toBe('false');
    const lines = csv.body.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toBe('at,actorType,actorId,actorName,action,targetType,targetId,details');
    expect(lines).toHaveLength(4);
    const override = lines.find((l) => l.includes('Second Reviewer'));
    expect(override).toContain('Tab switch lasted through two questions.');
    expect(override).toContain('""overrides"":true');
    const [exp] = await env.ctx.db.select().from(auditLog).where(eq(auditLog.action, 'audit_log.exported'));
    expect(exp.meta).toMatchObject({ rows: 3, matched: 3, filters: { action: 'event.review', targetId: id } });
    expect((await admin.get('/audit-log', { action: 'event.review', targetId: id, from: env.clock.t + 1 })).json().total).toBe(0);
  });

  it('accepts a plain status from older clients; refuses resolutions that do not fit the event', async () => {
    const { c } = await started();
    const t = env.clock.t;
    const cam = await clientEvent(c, { type: 'camera_frozen', startedAt: t - 30_000, endedAt: t - 20_000 });
    const plain = json<EventDetailDTO>(await review(reviewer, cam, { status: 'dismissed' }));
    expect(plain.review).toMatchObject({ status: 'dismissed', resolution: null });
    const bad = await review(reviewer, cam, { resolution: 'concern', note: 'x' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('resolution_not_applicable');
    expect((await review(reviewer, cam, { status: 'reviewed', resolution: 'false_detection' })).statusCode).toBe(400);
    const [started_] = await env.ctx.db.select().from(events).where(and(eq(events.sessionId, (await env.ctx.db.select().from(events).where(eq(events.id, cam)))[0].sessionId), eq(events.type, 'session_started')));
    expect((await review(reviewer, started_.id, { resolution: 'no_concern' })).json().error).toBe('resolution_not_applicable');
  });
});

describe('event detail', () => {
  it('explains the event with the session’s rules, names coinciding conditions and its incident', async () => {
    const { c } = await started();
    const t = env.clock.t;
    const dark = await clientEvent(c, { type: 'lighting_unusable', startedAt: t - 60_000, endedAt: t - 10_000 });
    const away = await clientEvent(c, { type: 'looking_away', startedAt: t - 40_000, endedAt: t - 31_000, details: { durationSec: 9, direction: 'left', maxYawOffsetDeg: 33 } });
    const later = await clientEvent(c, { type: 'tab_hidden', startedAt: t - 5 * MIN, endedAt: t - 5 * MIN + 4000 });
    const d = json<EventDetailDTO>(await reviewer.get(`/events/${away}`));
    expect(d.explanation.rule).toContain('at least 7 s'); // the exam's lookAwaySec, not the default 5
    expect(d.explanation.measured).toContain('Direction: to the left.');
    expect(d.explanation.factors).toContainEqual({ effect: 'weakens', text: 'Lighting too poor to assess at the same time: camera observations in this period are less reliable.' });
    expect(d.incident).toMatchObject({ id: dark, eventIds: [dark, away], category: 'integrity' });
    expect(d.incident!.eventIds).not.toContain(later);
    expect(d.history).toEqual([]);
  });
});

describe('bulk and incident decisions', () => {
  it('decides technical and low-severity events in bulk, never higher-severity flags or others’ decisions', async () => {
    const { c } = await started();
    const t = env.clock.t;
    const frozen = await clientEvent(c, { type: 'camera_frozen', startedAt: t - 10 * MIN, endedAt: t - 10 * MIN + 8000 }); // technical, medium
    const glance = await clientEvent(c, { type: 'looking_away', startedAt: t - 8 * MIN, endedAt: t - 8 * MIN + 6000 }); // integrity, low
    const tab = await clientEvent(c, { type: 'tab_hidden', startedAt: t - 6 * MIN, endedAt: t - 6 * MIN + 5000 }); // integrity, medium
    const decided = await clientEvent(c, { type: 'window_unfocused', startedAt: t - 4 * MIN, endedAt: t - 4 * MIN + 3000 }); // integrity, low
    json(await review(reviewer2, decided, { resolution: 'concern', note: 'Long unfocus.' }));
    const r = json<BulkReviewResultDTO>(await reviewer.post('/events/review-bulk', { eventIds: [frozen, glance, tab, decided, randomUUID()], resolution: 'technical', note: 'Old laptop camera.' }));
    // The technical problem and the low-severity glance; not the medium tab switch or someone else's decision.
    expect(r.updated.sort()).toEqual([frozen, glance].sort());
    const reasons = Object.fromEntries(r.skipped.map((s) => [s.id, s.reason]));
    expect(reasons[tab]).toBe('not_eligible');
    expect(reasons[decided]).toBe('decided_by_someone_else');
    expect(Object.values(reasons)).toContain('not_found');
    const [g] = await env.ctx.db.select().from(events).where(eq(events.id, glance));
    expect(g).toMatchObject({ reviewStatus: 'reviewed', resolution: 'technical' });
    const history = await env.ctx.db.select().from(eventReviews).where(eq(eventReviews.eventId, frozen));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ bulk: true, resolution: 'technical', note: 'Old laptop camera.' });
  });

  it('decides the events of one incident together whatever their severity, and nothing outside it', async () => {
    const { c } = await started();
    const other = await started();
    const t = env.clock.t;
    const phone = await clientEvent(c, { type: 'phone_detected', startedAt: t - 70_000, endedAt: t - 60_000 }); // high
    const tab = await clientEvent(c, { type: 'tab_hidden', startedAt: t - 55_000, endedAt: t - 50_000 }); // medium, 5 s later
    const far = await clientEvent(c, { type: 'tab_hidden', startedAt: t - 10 * MIN, endedAt: t - 10 * MIN + 5000 });
    const elsewhere = await clientEvent(other.c, { type: 'tab_hidden', startedAt: t - 55_000, endedAt: t - 50_000 });
    // The incident is identified by its first event; events of another session or incident are not part of it.
    const r = json<BulkReviewResultDTO>(await reviewer.post('/events/review-bulk', { eventIds: [phone, tab, far, elsewhere], resolution: 'no_concern', note: 'Calculator app, permitted.', incidentId: phone }));
    expect(r.updated.sort()).toEqual([phone, tab].sort());
    expect(r.skipped.sort((a, b) => a.id.localeCompare(b.id))).toEqual([{ id: far, reason: 'not_in_incident' }, { id: elsewhere, reason: 'not_in_incident' }].sort((a, b) => a.id.localeCompare(b.id)));
    expect((await reviewer.post('/events/review-bulk', { eventIds: [far], resolution: 'no_concern', incidentId: randomUUID() })).statusCode).toBe(404);
    expect((await reviewer.post('/events/review-bulk', { eventIds: [far], resolution: 'no_concern', incidentId: tab })).statusCode).toBe(404); // not an incident's first event
  });
});

describe('review queue and session review', () => {
  it('lists sessions with undecided flags with their due time; assignment, escalation, resolution and reopening', async () => {
    const { id, c } = await started();
    const t0 = env.clock.t;
    const flag = await clientEvent(c, { type: 'tab_hidden', startedAt: t0 - 5000, endedAt: t0 - 1000 });
    const q = async (api: Api, view = 'all') => json<ReviewQueueDTO>(await api.get('/review-queue', { view }));
    const all = await q(reviewer);
    const item = all.items.find((s) => s.id === id)!;
    expect(item.review).toMatchObject({ state: 'none', assignee: null, undecided: { integrity: 1, uncertain: 0, technical: 0 }, topSeverity: 'medium', due: { kind: 'flags', overdue: false } });
    expect(item.review!.due!.dueAt - item.review!.due!.since).toBe(72 * 3_600_000);
    expect(all.sla).toEqual({ holdMinutes: 15, flagHours: 72 });
    expect((await q(reviewer, 'unassigned')).items.some((s) => s.id === id)).toBe(true);

    // Reviewers assign themselves; only administrators assign others.
    expect((await reviewer.post(`/sessions/${id}/review/assign`, { assigneeId: reviewer2.user.id })).json().error).toBe('assign_self_only');
    const mine = json<SessionReviewDTO>(await reviewer.post(`/sessions/${id}/review/assign`, { assigneeId: reviewer.user.id }));
    expect(mine).toMatchObject({ state: 'open', assignee: { id: reviewer.user.id, name: 'Test reviewer' } });
    expect((await q(reviewer, 'mine')).items.map((s) => s.id)).toContain(id);
    expect((await q(reviewer2, 'mine')).items.map((s) => s.id)).not.toContain(id);
    expect((await reviewer2.post(`/sessions/${id}/review/assign`, { assigneeId: null })).json().error).toBe('assign_self_only');
    json(await admin.post(`/sessions/${id}/review/assign`, { assigneeId: reviewer2.user.id }));

    // Escalate; an escalated review is resolved by an administrator, after the exam ended and every flag is decided.
    expect((await reviewer.post(`/sessions/${id}/review/escalate`, { note: 'x' })).statusCode).toBe(400);
    const esc = json<SessionReviewDTO>(await reviewer.post(`/sessions/${id}/review/escalate`, { note: 'Pattern across the whole exam; needs a second look.' }));
    expect(esc).toMatchObject({ state: 'escalated', escalation: { by: { id: reviewer.user.id }, note: 'Pattern across the whole exam; needs a second look.' } });
    expect((await q(admin, 'escalated')).items.map((s) => s.id)).toContain(id);
    expect((await admin.post(`/sessions/${id}/review/resolve`, { outcome: 'no_concerns' })).json().error).toBe('session_in_progress');
    expect((await c.req('POST', '/api/candidate/submit', {})).statusCode).toBe(200);
    const undecided = await admin.post(`/sessions/${id}/review/resolve`, { outcome: 'no_concerns' });
    expect(undecided.statusCode).toBe(409);
    expect(undecided.json()).toMatchObject({ error: 'undecided_flags', details: { undecided: 1 } });
    json(await review(reviewer2, flag, { resolution: 'concern', note: 'Left the exam twice.' }));
    expect((await reviewer.post(`/sessions/${id}/review/resolve`, { outcome: 'concerns', note: 'Refer.' })).json().error).toBe('escalated_admin_only');
    expect((await admin.post(`/sessions/${id}/review/resolve`, { outcome: 'concerns' })).statusCode).toBe(400); // a note is required
    const hook = json<CreatedWebhookDTO>(await admin.post('/webhooks', { url: 'http://127.0.0.1:9/hook', events: ['session.reviewed'], description: 'review' }));
    const resolved = json<SessionReviewDTO>(await admin.post(`/sessions/${id}/review/resolve`, { outcome: 'concerns', note: 'Refer to the integrity panel; confidential detail.' }));
    expect(resolved).toMatchObject({ state: 'resolved', outcome: 'concerns', resolution: { outcome: 'concerns', note: 'Refer to the integrity panel; confidential detail.', by: { id: admin.user.id } }, due: null });
    expect((await admin.post(`/sessions/${id}/review/resolve`, { outcome: 'no_concerns' })).json().error).toBe('review_resolved');

    // Timeline entry and an outcome-only webhook.
    const detail = json<SessionDetailDTO>(await reviewer.get(`/sessions/${id}`));
    expect(detail.review).toMatchObject({ state: 'resolved', outcome: 'concerns' });
    const timeline = json<{ items: { kind: string; event?: { type: string; observation: string } }[] }>(await reviewer.get(`/sessions/${id}/timeline`));
    const done = timeline.items.find((i) => i.event?.type === 'review_completed');
    expect(done?.event?.observation).toBe('Staff completed the review of this exam: integrity concerns — refer.');
    const [delivery] = await env.ctx.db.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.webhookId, hook.webhook.id), eq(webhookDeliveries.eventType, 'session.reviewed')));
    expect((delivery.payload as { data: Record<string, unknown> }).data).toMatchObject({ sessionId: id, outcome: 'concerns' });
    expect(JSON.stringify(delivery.payload)).not.toContain('confidential');
    // The printed report carries the outcome, the incidents and why each notable event was recorded.
    const report = json<SessionReportDTO>(await reviewer.get(`/sessions/${id}/report`));
    expect(report.review).toMatchObject({ state: 'resolved', outcome: 'concerns', resolution: { note: 'Refer to the integrity panel; confidential detail.' } });
    expect(report.incidents?.map((i) => i.eventIds)).toEqual([[flag]]);
    expect(report.explanations?.[flag]?.rule).toMatch(/exam page was hidden/);
    expect(report.notableEvents.find((e) => e.id === flag)?.review).toMatchObject({ status: 'reviewed', resolution: 'concern' });
    expect((await q(reviewer, 'resolved')).items.map((s) => s.id)).toContain(id);
    expect((await q(reviewer)).items.map((s) => s.id)).not.toContain(id);

    // Reopen: back in the queue, outcome cleared, recorded.
    expect((await reviewer.post(`/sessions/${id}/review/reopen`, { note: 'no' })).statusCode).toBe(400);
    const reopened = json<SessionReviewDTO>(await reviewer.post(`/sessions/${id}/review/reopen`, { note: 'The candidate appealed with new information.' }));
    expect(reopened).toMatchObject({ state: 'open', outcome: null, resolution: null, escalation: null });
    expect((await q(reviewer)).items.map((s) => s.id)).toContain(id);
    const actions = (await env.ctx.db.select().from(auditLog).where(eq(auditLog.targetId, id))).map((a) => a.action).filter((a) => a.startsWith('review.'));
    expect(actions).toEqual(['review.assigned', 'review.assigned', 'review.escalated', 'review.resolved', 'review.reopened']);
  });

  it('applies the hold target to held exams and marks overdue reviews; the targets are organisation settings', async () => {
    const { id } = await started();
    json(await reviewer.post(`/sessions/${id}/hold`, { note: 'Checking the room.' }));
    const q = async () => json<ReviewQueueDTO>(await reviewer.get('/review-queue', { view: 'overdue' }));
    const summary = async () => json<SessionDetailDTO>(await reviewer.get(`/sessions/${id}`)).summary;
    let s: SessionSummaryDTO = await summary();
    expect(s.review!.due).toMatchObject({ kind: 'hold', overdue: false });
    expect(s.review!.due!.dueAt - s.review!.due!.since).toBe(15 * MIN);
    expect((await q()).items.map((x) => x.id)).not.toContain(id);
    env.clock.advance(16 * MIN);
    expect((await q()).items.map((x) => x.id)).toContain(id);
    // The review backlog is visible to monitoring (cluster gauges, docs/prometheus-alerts.yml).
    const gauge = async (name: string) => {
      await new Promise((r) => setTimeout(r, 1100)); // past the cluster snapshot cache
      const line = (await env.ctx.metrics.registry.metrics()).split('\n').find((l) => l.startsWith(`${name} `));
      return line ? Number(line.split(' ')[1]) : null;
    };
    expect(await gauge('sp_cluster_review_holds_overdue')).toBe(1);
    expect(await gauge('sp_cluster_review_flags_undecided')).toBeGreaterThan(0);
    expect(await gauge('sp_cluster_review_oldest_undecided_flag_seconds')).toBeGreaterThan(0);
    // A longer target: no longer overdue.
    expect((await reviewer.put('/settings', { reviewSla: { holdMinutes: 30 } })).statusCode).toBe(403); // admin only
    const settings = json<{ reviewSla: { holdMinutes: number; flagHours: number } }>(await admin.put('/settings', { reviewSla: { holdMinutes: 30 } }));
    expect(settings.reviewSla).toEqual({ holdMinutes: 30, flagHours: 72 });
    expect((await admin.put('/settings', { reviewSla: { holdMinutes: 0 } })).statusCode).toBe(400);
    expect((await q()).items.map((x) => x.id)).not.toContain(id);
    expect(await gauge('sp_cluster_review_holds_overdue')).toBe(0);
    s = await summary();
    expect(s.review!.due).toMatchObject({ kind: 'hold', overdue: false });
    json(await admin.put('/settings', { reviewSla: { holdMinutes: 15 } }));
  });
});

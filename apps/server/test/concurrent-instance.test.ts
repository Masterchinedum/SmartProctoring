/**
 * Security review #7 (detection only): the verified browser instance id copied to a second device. Signals: a
 * different User-Agent, two interleaved heartbeat `seq` streams, two networks alternating within 60 s. A single
 * network change (mobile), a counter restart, dual-stack v4/v6 switching or a page reload never trigger it.
 */
import { and, eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { events, examSessions, type InstanceUsage } from '../src/db/schema.js';
import { hashIp, networkOf, observeInstanceUsage, type UsageObservation } from '../src/services/instance-usage.js';
import { DEVICE, hb, runCheck, startedSession } from './flow.js';
import { createTestEnv, type CandidateClient, type TestEnv } from './helpers.js';

/* ------------------------------------------------------------------ pure detection */

const UA = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140';
function run(steps: Partial<UsageObservation>[], instanceId = 'inst-1'): { signals: (string | null)[]; last: InstanceUsage } {
  let u: InstanceUsage | null = null;
  const signals: (string | null)[] = [];
  let t = 0;
  for (const s of steps) {
    t = s.at ?? t + 5_000;
    const v = observeInstanceUsage(u, instanceId, { ip: '198.51.100.10', userAgent: UA, ...s, at: t });
    signals.push(v.signal);
    u = v.usage;
  }
  return { signals, last: u! };
}
const noSignal = (r: { signals: (string | null)[] }) => expect(r.signals.every((x) => x === null), JSON.stringify(r.signals)).toBe(true);

describe('observeInstanceUsage', () => {
  it('groups addresses by network and never stores raw addresses', () => {
    expect(networkOf('198.51.100.10')).toEqual({ family: 4, net: 'v4:198.51.100' });
    expect(networkOf('::ffff:198.51.100.10')).toEqual({ family: 4, net: 'v4:198.51.100' });
    expect(networkOf('2001:db8:1:2:aaaa::1')).toEqual({ family: 6, net: 'v6:2001:0db8:0001:0002' });
    expect(networkOf('2001:db8::1')).toEqual({ family: 6, net: 'v6:2001:0db8:0000:0000' });
    const { last } = run([{ ip: '198.51.100.10' }, { ip: '203.0.113.7' }]);
    expect(last.ipHashes).toEqual([hashIp('198.51.100.10'), hashIp('203.0.113.7')]);
    expect(JSON.stringify(last)).not.toMatch(/198\.51|203\.0|Mozilla/);
    expect(last.ipHashes.every((h) => /^[0-9a-f]{16}$/.test(h))).toBe(true);
  });

  it('ignores a single network change, a return after a minute, moving on, and dual-stack or same-subnet switching', () => {
    noSignal(run([{ ip: '198.51.100.10' }, { ip: '198.51.100.10' }, { ip: '203.0.113.7' }, { ip: '203.0.113.7' }, { ip: '203.0.113.9' }]));
    noSignal(run([{ ip: '198.51.100.10' }, { ip: '203.0.113.7' }, { ip: '198.51.100.10' }])); // one flap back
    noSignal(run([{ ip: '198.51.100.10', at: 0 }, { ip: '203.0.113.7', at: 30_000 }, { ip: '198.51.100.10', at: 70_000 }, { ip: '203.0.113.7', at: 110_000 }]));
    noSignal(run([{ ip: '10.1.1.1' }, { ip: '10.1.2.1' }, { ip: '10.1.3.1' }, { ip: '10.1.4.1' }])); // travelling
    noSignal(run(Array.from({ length: 12 }, (_, i) => ({ ip: i % 2 ? '2001:db8:1:2::5' : '198.51.100.10' })))); // happy eyeballs
    noSignal(run(Array.from({ length: 12 }, (_, i) => ({ ip: i % 2 ? '198.51.100.11' : '198.51.100.10' })))); // egress pool
  });

  it('flags two networks alternating within 60 s', () => {
    const r = run([{ ip: '198.51.100.10' }, { ip: '203.0.113.7' }, { ip: '198.51.100.10' }, { ip: '203.0.113.7' }]);
    expect(r.signals).toEqual([null, null, null, 'ip_alternating']);
  });

  it('flags a User-Agent change for the same instance, not a new instance', () => {
    expect(run([{}, {}, { userAgent: 'Mozilla/5.0 (iPhone) Safari/18' }]).signals).toEqual([null, null, 'ua_changed']);
    let u = observeInstanceUsage(null, 'inst-1', { ip: '198.51.100.10', userAgent: UA, at: 0 }).usage;
    const other = observeInstanceUsage(u, 'inst-2', { ip: '198.51.100.10', userAgent: 'Something else', at: 1000 });
    expect(other.signal).toBeNull();
    expect(other.usage.instanceId).toBe('inst-2');
    u = other.usage;
    expect(observeInstanceUsage(u, 'inst-2', { ip: '198.51.100.10', userAgent: 'Something else', at: 2000 }).changed).toBe(false);
  });

  it('follows heartbeat seq: monotonic, duplicates, late deliveries and a counter restart are fine; interleaving is not', () => {
    noSignal(run(Array.from({ length: 20 }, (_, i) => ({ seq: i + 1 }))));
    noSignal(run([{ seq: 1 }, { seq: 1 }, { seq: 1 }])); // test clients / retries
    noSignal(run([{ seq: 5 }, { seq: 6 }, { seq: 5 }, { seq: 7 }, { seq: 8 }])); // late heartbeat
    noSignal(run([...Array.from({ length: 30 }, (_, i) => ({ seq: i + 1 })), ...Array.from({ length: 30 }, (_, i) => ({ seq: i + 1 }))])); // restart
    noSignal(run([{ seq: 3 }, { seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }])); // early restart absorbed
    // A second copy counting on its own: 57, 1, 58 -> interleaved.
    const copy = run([...Array.from({ length: 5 }, (_, i) => ({ seq: 53 + i })), { seq: 1 }, { seq: 58 }]);
    expect(copy.signals.at(-1)).toBe('seq_interleaved');
    expect(copy.signals.slice(0, -1).every((x) => x === null)).toBe(true);
    // ... or the copy continuing after the original reported again.
    expect(run([{ seq: 40 }, { seq: 41 }, { seq: 1 }, { seq: 42 }]).signals.at(-1)).toBe('seq_interleaved');
    expect(run([{ seq: 40 }, { seq: 1 }, { seq: 2 }]).signals).toEqual([null, null, null]);
    expect(run([{ seq: 40 }, { seq: 41 }, { seq: 1 }, { seq: 42 }, { seq: 2 }]).signals.slice(3)).toEqual(['seq_interleaved', 'seq_interleaved']);
    // The old stream went quiet more than a minute before: a restart, not a copy.
    noSignal(run([{ seq: 40, at: 0 }, { seq: 1, at: 70_000 }, { seq: 41, at: 75_000 }]));
  });
});

/* ------------------------------------------------------------------ through the API */

describe('concurrent use of a copied instance id', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv();
  });
  afterAll(async () => {
    await env?.close();
  });

  const as = (c: CandidateClient, opts: { ip?: string; ua?: string } = {}) => ({
    req: (method: InjectOptions['method'], url: string, body?: unknown) =>
      env.app.inject({
        method,
        url,
        remoteAddress: opts.ip ?? '127.0.0.1',
        headers: { authorization: `Bearer ${c.token}`, 'x-client-instance': c.instanceId, ...(opts.ua ? { 'user-agent': opts.ua } : {}) },
        ...(body !== undefined ? { payload: body as InjectOptions['payload'] } : {}),
      }),
    hb: (seq: number) =>
      env.app.inject({
        method: 'POST',
        url: '/api/candidate/heartbeat',
        remoteAddress: opts.ip ?? '127.0.0.1',
        headers: { authorization: `Bearer ${c.token}`, 'x-client-instance': c.instanceId, ...(opts.ua ? { 'user-agent': opts.ua } : {}) },
        payload: { clientInstanceId: c.instanceId, clientTime: 0, seq, monitoring: { state: 'ok', faces: 1, label: 'ok', open: [] }, outboxSize: 0, outboxOldestAt: null },
      }),
  });
  const multiEvents = async (sessionId: string) => env.ctx.db.select().from(events).where(and(eq(events.sessionId, sessionId), eq(events.type, 'multiple_instances')));
  const sessionRow = async (id: string) => (await env.ctx.db.select().from(examSessions).where(eq(examSessions.id, id)))[0];

  it('a second device with another browser: event, reconnect check required, writes refused until it passes', async () => {
    const s = await env.newSession();
    const c = await startedSession(env, env.candidateClient(s.token));
    const original = as(c); // same address / browser as the check-in
    expect((await original.hb(1)).json().requiredCheck).toBeNull();
    env.clock.advance(5_000);
    // The accomplice reads the questions with the copied instance id.
    const copy = as(c, { ip: '203.0.113.50', ua: 'Mozilla/5.0 (Macintosh) Safari/18' });
    const read = await copy.req('GET', '/api/candidate/session');
    expect(read.statusCode).toBe(200);
    expect(read.json().questions).toBeNull();
    expect(read.json().session.requiredCheck).toBe('reconnect');

    const [ev] = await multiEvents(s.id);
    expect(ev).toBeTruthy();
    expect(ev.details).toMatchObject({ signal: 'ua_changed', uaChanged: true, instanceId: c.instanceId, detectedBy: 'concurrent_use', ipHashes: [hashIp('127.0.0.1'), hashIp('203.0.113.50')] });
    expect(JSON.stringify(ev)).not.toMatch(/127\.0\.0\.1|203\.0\.113\.50|Safari/);
    expect(ev).toMatchObject({ category: 'integrity', source: 'server_system' });
    const row = await sessionRow(s.id);
    expect(row.verifiedInstanceId).toBeNull();
    expect(row.status).toBe('active');

    // The original browser is told to re-check; answers are refused until then.
    env.clock.advance(5_000);
    const beat = (await original.hb(2)).json();
    expect(beat.requiredCheck).toBe('reconnect');
    expect(beat.commands).toContainEqual(expect.objectContaining({ kind: 'require_check', purpose: 'reconnect' }));
    const save = await original.req('PUT', `/api/candidate/answers/${env.questions[0].id}`, { value: 'b', clientSeq: 1, answeredAt: env.clock.t });
    expect(save.statusCode).toBe(409);
    expect(save.json().error).toBe('check_required');

    // Passing the reconnect check restores control (and no further event without new evidence).
    const { complete } = await runCheck(env, c, 'reconnect');
    expect(complete!.outcome).toBe('passed');
    expect((await sessionRow(s.id)).verifiedInstanceId).toBe(c.instanceId);
    expect((await original.hb(3)).json().requiredCheck).toBeNull();
    expect((await original.req('PUT', `/api/candidate/answers/${env.questions[0].id}`, { value: 'b', clientSeq: 2, answeredAt: env.clock.t })).statusCode).toBe(200);
    expect(await multiEvents(s.id)).toHaveLength(1);
  });

  it('two copies of the page heartbeating with interleaved seq', async () => {
    const s = await env.newSession();
    const c = await startedSession(env, env.candidateClient(s.token));
    const a = as(c);
    for (let i = 1; i <= 6; i++) {
      env.clock.advance(5_000);
      expect((await a.hb(i)).json().requiredCheck).toBeNull();
    }
    env.clock.advance(1_000);
    expect((await a.hb(1)).json().requiredCheck).toBeNull(); // copy starts counting: not yet evidence
    env.clock.advance(1_000);
    expect((await a.hb(7)).json().requiredCheck).toBe('reconnect'); // the original continues -> interleaved
    const [ev] = await multiEvents(s.id);
    expect(ev.details).toMatchObject({ signal: 'seq_interleaved', uaChanged: false });
  });

  it('the same browser alternating between two networks within a minute', async () => {
    const s = await env.newSession();
    const c = await startedSession(env, env.candidateClient(s.token));
    const home = as(c); // 127.0.0.1, as at check-in
    const phone = as(c, { ip: '203.0.113.50' });
    let seq = 0;
    expect((await home.hb(++seq)).statusCode).toBe(200);
    env.clock.advance(3_000);
    expect((await phone.req('GET', '/api/candidate/session')).json().session.requiredCheck).toBeNull();
    env.clock.advance(3_000);
    expect((await home.hb(++seq)).json().requiredCheck).toBeNull();
    env.clock.advance(3_000);
    expect((await phone.req('GET', '/api/candidate/session')).json().session.requiredCheck).toBe('reconnect');
    const [ev] = await multiEvents(s.id);
    expect(ev.details).toMatchObject({ signal: 'ip_alternating', uaChanged: false });
    expect((ev.details as { ipHashes: string[] }).ipHashes).toEqual([hashIp('127.0.0.1'), hashIp('203.0.113.50')]);
  });

  it('never fires for a mobile network change or a page reload on the same device', async () => {
    const s = await env.newSession();
    const c = await startedSession(env, env.candidateClient(s.token));
    const wifi = as(c);
    const lte = as(c, { ip: '203.0.113.50' });
    let seq = 0;
    for (let i = 0; i < 3; i++) {
      env.clock.advance(5_000);
      expect((await wifi.hb(++seq)).json().requiredCheck).toBeNull();
    }
    for (let i = 0; i < 3; i++) {
      env.clock.advance(5_000);
      expect((await lte.hb(++seq)).json().requiredCheck).toBeNull();
    }
    // Reload: a new page instance (same browser, same camera) takes over after a reconnect check.
    env.clock.advance(5_000);
    const reloaded = env.candidateClient(s.token);
    const { complete } = await runCheck(env, reloaded, 'reconnect', { device: DEVICE });
    expect(complete!.outcome).toBe('passed');
    const r = as(reloaded, { ip: '203.0.113.50' });
    for (let i = 1; i <= 3; i++) {
      env.clock.advance(5_000);
      expect((await r.hb(i)).json().requiredCheck).toBeNull();
    }
    expect((await hb(reloaded)).json().requiredCheck).toBeNull();
    expect(await multiEvents(s.id)).toHaveLength(0);
  });
});

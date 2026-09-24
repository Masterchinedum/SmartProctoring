import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDatabase, migrate } from '../src/db/index.js';
import { staffUsers } from '../src/db/schema.js';
import { createKeyring, hashPassword, isJpeg, verifyPassword } from '../src/lib/crypto.js';
import { MemoryStorage } from '../src/lib/storage.js';
import { LocalBus, RedisBus } from '../src/realtime/bus.js';
import { bootstrapAdmin } from '../src/services/bootstrap.js';
import { generateLivenessSteps } from '../src/services/checks.js';
import { isAnswerCorrect } from '../src/services/grading.js';
import { FakeVisionService } from '../src/vision/fake.js';
import { createTestEnv, type TestEnv } from './helpers.js';

describe('crypto', () => {
  it('AES-GCM keyring: round trip, AAD binding, tamper detection, key rotation', () => {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    const old = createKeyring(k1);
    const blob = old.encrypt(Buffer.from('secret image'), 'evidence:1');
    expect(blob.includes(Buffer.from('secret image'))).toBe(false);
    expect(old.decrypt(blob, 'evidence:1').toString()).toBe('secret image');
    expect(() => old.decrypt(blob, 'evidence:2')).toThrow();
    const t = Buffer.from(blob);
    t[t.length - 1] ^= 1;
    expect(() => old.decrypt(t, 'evidence:1')).toThrow();
    // two encryptions differ (fresh IV)
    expect(old.encrypt(Buffer.from('x')).equals(old.encrypt(Buffer.from('x')))).toBe(false);
    const rotated = createKeyring(k2, [k1]);
    expect(rotated.decrypt(blob, 'evidence:1').toString()).toBe('secret image');
    expect(rotated.keyIdOf(rotated.encrypt(Buffer.from('y')))).toBe(rotated.currentKeyId);
    expect(() => createKeyring(k2).decrypt(blob, 'evidence:1')).toThrow(/Unknown encryption key/);
  });

  it('scrypt password hashing', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('JPEG sniffing', () => {
    expect(isJpeg(FakeVisionService.encode({ person: 'a' }))).toBe(true);
    expect(isJpeg(Buffer.from('\x89PNG\r\n'))).toBe(false);
  });
});

describe('grading', () => {
  it('grades each question type', () => {
    expect(isAnswerCorrect('single_choice', ['b'], 'b')).toBe(true);
    expect(isAnswerCorrect('single_choice', ['b'], 'a')).toBe(false);
    expect(isAnswerCorrect('multiple_choice', ['a', 'c'], ['c', 'a'])).toBe(true);
    expect(isAnswerCorrect('multiple_choice', ['a', 'c'], ['a'])).toBe(false);
    expect(isAnswerCorrect('short_text', ['Paris', 'paris france'], '  PARIS ')).toBe(true);
    expect(isAnswerCorrect('short_text', ['Paris'], 'Lyon')).toBe(false);
    expect(isAnswerCorrect('numeric', ['3.14'], 3.1400000001)).toBe(true);
    expect(isAnswerCorrect('numeric', ['3.14'], '3,14')).toBe(true);
    expect(isAnswerCorrect('numeric', ['3.14'], 3.15)).toBe(false);
    expect(isAnswerCorrect('numeric', ['1.00|0.01'], 1.009)).toBe(true);
    expect(isAnswerCorrect('long_text', [], 'essay')).toBeNull();
    expect(isAnswerCorrect('single_choice', ['b'], null)).toBe(false);
  });
});

describe('liveness challenge', () => {
  it('always starts with center and contains both horizontal turns in random order', () => {
    const orders = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const steps = generateLivenessSteps(2);
      expect(steps[0].action).toBe('center');
      const acts = steps.map((s) => s.action);
      expect(acts).toContain('turn_left');
      expect(acts).toContain('turn_right');
      expect(steps.map((s) => s.index)).toEqual(steps.map((_, j) => j));
      orders.add(acts.join(','));
      const four = generateLivenessSteps(4).map((s) => s.action);
      expect(four).toHaveLength(5);
      expect(four).toEqual(expect.arrayContaining(['look_up', 'look_down']));
      expect(generateLivenessSteps(3).filter((a) => a.action === 'look_up' || a.action === 'look_down')).toHaveLength(1);
    }
    expect(orders.size).toBe(2);
  });
});

describe('config', () => {
  it('refuses to start in production without secrets', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', PUBLIC_URL: 'https://x' })).toThrow(/EVIDENCE_KEY/);
    expect(() => loadConfig({ NODE_ENV: 'production', PUBLIC_URL: 'https://x', EVIDENCE_KEY: randomBytes(32).toString('base64') })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ EVIDENCE_KEY: 'short' })).toThrow(/32 bytes/);
    const dev = loadConfig({});
    expect(dev.warnings.join(' ')).toMatch(/DEVELOPMENT key/);
    expect(dev.port).toBe(8080);
  });

  it('reads capacity settings (Postgres pool, statement timeout, vision workers)', () => {
    const dflt = loadConfig({});
    expect(dflt.db).toEqual({ poolMax: 20, statementTimeoutMs: 60_000 });
    expect(dflt.visionWorkers).toBeNull(); // derived from VISION_THREADS / CPU count by the vision service
    const tuned = loadConfig({ PG_POOL_MAX: '40', PG_STATEMENT_TIMEOUT_MS: '0', VISION_WORKERS: '0', VISION_CONCURRENCY: '3' });
    expect(tuned.db).toEqual({ poolMax: 40, statementTimeoutMs: 0 });
    expect(tuned.visionWorkers).toBe(0);
    expect(tuned.visionConcurrency).toBe(3);
    expect(() => loadConfig({ PG_POOL_MAX: 'many' })).toThrow(/Invalid integer/);
  });
});

describe('realtime bus', () => {
  it('LocalBus delivers per organisation', async () => {
    const bus = new LocalBus();
    const got: string[] = [];
    const off = bus.subscribe('org-a', (m) => got.push(m.type));
    bus.subscribe('org-b', () => got.push('wrong-org'));
    bus.publish('org-a', { type: 'hello', serverTime: 1 });
    await new Promise((r) => setTimeout(r, 10));
    off();
    bus.publish('org-a', { type: 'hello', serverTime: 2 });
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual(['hello']);
    await bus.close();
  });

  it('RedisBus fans out across instances (skipped when Redis is unavailable)', async () => {
    let a: RedisBus;
    let b: RedisBus;
    try {
      a = await Promise.race([RedisBus.connect('redis://127.0.0.1:6379'), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))]);
      b = await RedisBus.connect('redis://127.0.0.1:6379');
    } catch {
      console.warn('Redis not reachable; skipping RedisBus test');
      return;
    }
    const org = `org-${randomBytes(4).toString('hex')}`;
    const got: number[] = [];
    b.subscribe(org, (m) => m.type === 'hello' && got.push(m.serverTime));
    await new Promise((r) => setTimeout(r, 200));
    a.publish(org, { type: 'hello', serverTime: 42 });
    for (let i = 0; i < 50 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([42]);
    await a.close();
    await b.close();
  });
});

describe('bootstrap and static web', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv();
  });
  afterAll(async () => env?.close());

  it('applies the statement timeout to pooled connections, and migrations lift it', async () => {
    const db = createDatabase(env.ctx.config.databaseUrl, { max: 2, statementTimeoutMs: 1234 });
    try {
      const { rows } = await db.pool.query('show statement_timeout');
      expect(rows[0].statement_timeout).toBe('1234ms');
      await migrate(db); // already migrated: runs with statement_timeout 0, then restores it
      const after = await db.pool.query('show statement_timeout');
      expect(after.rows[0].statement_timeout).toBe('1234ms');
    } finally {
      await db.close();
    }
  });

  it('creates the first owner only when no staff exist', async () => {
    const ctx = { ...env.ctx, config: { ...env.ctx.config, bootstrap: { email: 'boot@example.com', password: 'Bootstrap-Pass-1', orgName: 'Boot Org' } } };
    await bootstrapAdmin(ctx);
    const [{ n }] = await env.ctx.db.select({ n: sql<number>`count(*)::int` }).from(staffUsers).where(sql`${staffUsers.email} = 'boot@example.com'`);
    expect(n).toBe(0); // staff already exist in the test org
    await env.ctx.db.execute(sql`DELETE FROM staff_users`);
    await bootstrapAdmin(ctx);
    await bootstrapAdmin(ctx);
    const rows = await env.ctx.db.select().from(staffUsers);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: 'boot@example.com', role: 'owner' });
    const login = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'boot@example.com', password: 'Bootstrap-Pass-1' } });
    expect(login.statusCode).toBe(200);
    expect(login.json().org.name).toBe('Boot Org');
  });

  it('serves the SPA with fallback for client routes and JSON 404s for /api', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'sp-web-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>SmartProctoring</title>');
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'assets', 'app-abc.js'), 'console.log(1)');
    writeFileSync(join(dist, 'robots.txt'), 'User-agent: *');
    const app = await buildApp({
      config: { ...env.config, webDistDir: dist },
      database: env.ctx.database,
      vision: new FakeVisionService(),
      storage: new MemoryStorage(),
      bus: new LocalBus(),
      migrate: false,
      jobs: false,
      bootstrap: false,
    });
    try {
      const idx = await app.inject({ method: 'GET', url: '/take/some-token' });
      expect(idx.statusCode).toBe(200);
      expect(idx.body).toContain('SmartProctoring');
      expect(idx.headers['content-security-policy']).toContain("worker-src 'self' blob:");
      expect(idx.headers['referrer-policy']).toBe('no-referrer');
      const asset = await app.inject({ method: 'GET', url: '/assets/app-abc.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['cache-control']).toContain('immutable');
      expect(asset.body).toBe('console.log(1)');
      const rootFile = await app.inject({ method: 'GET', url: '/robots.txt' });
      expect(rootFile.statusCode).toBe(200);
      expect(rootFile.headers['cache-control']).toBe('public, max-age=86400');
      expect(idx.headers['cache-control']).toBe('no-cache');
      const head = await app.inject({ method: 'HEAD', url: '/admin/sessions' });
      expect(head.statusCode).toBe(200);
      // @fastify/static >= 10.1.2: no directory listings, no escaping the web root (encoded or not).
      const secret = join(dist, '..', `${basename(dist)}-secret.txt`);
      writeFileSync(secret, 'TOP-SECRET');
      try {
        for (const url of [
          `/..%2f${basename(dist)}-secret.txt`,
          `/assets/..%2f..%2f${basename(dist)}-secret.txt`,
          `/%2e%2e/${basename(dist)}-secret.txt`,
          `/assets%2fapp-abc.js`,
          '/assets/',
          '/assets',
        ]) {
          const r = await app.inject({ method: 'GET', url });
          expect(r.body, url).not.toContain('TOP-SECRET');
          expect(r.body, url).not.toContain('app-abc.js');
          if (r.statusCode === 200) expect(r.body, url).toContain('SmartProctoring'); // SPA fallback only
        }
      } finally {
        rmSync(secret, { force: true });
      }
      const api404 = await app.inject({ method: 'GET', url: '/api/nope' });
      expect(api404.statusCode).toBe(404);
      expect(api404.json().error).toBe('not_found');
      expect(api404.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

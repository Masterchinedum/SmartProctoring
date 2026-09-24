/**
 * Security review #8: key rotation tooling. Data written under key K1; EVIDENCE_KEY rotated to K2 (K1 moved to
 * EVIDENCE_KEYS_OLD); `rekey` re-encrypts every encrypted column and evidence blob; then K1 is removed and
 * everything still decrypts — through the services and through a server that only knows K2.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Ctx } from '../src/context.js';
import { auditLog, candidates, checkFrames, evidence, examSessions, identityReferences, webhooks } from '../src/db/schema.js';
import { createKeyring, keyIdFor, sha256Hex, type Keyring } from '../src/lib/crypto.js';
import { LocalBus } from '../src/realtime/bus.js';
import { accessLinkFor } from '../src/services/dto.js';
import { purgeEvidenceRows, readEvidence } from '../src/services/evidence.js';
import { frameAad, idPhotoAad, referenceAad } from '../src/services/identity-common.js';
import { COLUMN_TARGETS, EVIDENCE_TARGET, rekeyAll, rekeyAllExclusive, REKEY_LOCK_KEY, type RekeyCtx } from '../src/services/rekey.js';
import { readWebhookSecret } from '../src/services/webhooks.js';
import { FakeVisionService } from '../src/vision/fake.js';
import { clientEvent, json, MIN, screenshot, staffApi } from './admin/fixtures.js';
import { runCheck, startedSession } from './flow.js';
import { createTestEnv, type CandidateClient, type TestEnv } from './helpers.js';

const K1 = Buffer.alloc(32, 7); // createTestEnv's EVIDENCE_KEY
const K2 = randomBytes(32);
const K0 = randomBytes(32); // never configured

let env: TestEnv;
const ring = (current: Buffer, old: Buffer[] = []) => createKeyring(current, old);
const rekeyCtx = (keyring: Keyring): RekeyCtx => ({ database: env.ctx.database, db: env.ctx.db, storage: env.storage, keyring, now: env.clock.now, log: env.ctx.log });

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env?.close();
});

/** Every encrypted value (column targets + live evidence blobs) must decrypt with `keyring` under its AAD. */
async function assertAllDecrypt(keyring: Keyring) {
  const n: Record<string, number> = {};
  for (const [name, rows] of [
    ['id_photo_embeddings', (await env.ctx.db.select({ id: candidates.id, v: candidates.idPhotoEmbedding }).from(candidates).where(isNotNull(candidates.idPhotoEmbedding))).map((r) => ({ ...r, aad: idPhotoAad(r.id) }))],
    ['reference_embeddings', (await env.ctx.db.select({ id: identityReferences.id, v: identityReferences.embeddingsEnc }).from(identityReferences).where(isNotNull(identityReferences.embeddingsEnc))).map((r) => ({ ...r, aad: referenceAad(r.id) }))],
    ['check_frame_embeddings', (await env.ctx.db.select({ id: checkFrames.id, v: checkFrames.embeddingEnc }).from(checkFrames).where(isNotNull(checkFrames.embeddingEnc))).map((r) => ({ ...r, aad: frameAad(r.id) }))],
    ['access_tokens', (await env.ctx.db.select({ id: examSessions.id, v: examSessions.accessTokenEnc }).from(examSessions).where(isNotNull(examSessions.accessTokenEnc))).map((r) => ({ ...r, aad: `access-token:${r.id}` }))],
  ] as const) {
    for (const r of rows) keyring.decrypt(r.v!, r.aad);
    n[name] = rows.length;
  }
  const hooks = await env.ctx.db.select().from(webhooks);
  for (const h of hooks) expect(readWebhookSecret({ keyring }, h)).toMatch(/^whsec_/);
  n.webhook_secrets = hooks.length;
  const ev = await env.ctx.db.select().from(evidence).where(isNull(evidence.purgedAt));
  for (const row of ev) {
    const data = await readEvidence({ storage: env.storage, keyring }, row);
    expect(data, row.id).not.toBeNull();
    expect(sha256Hex(data!)).toBe(row.sha256);
  }
  n[EVIDENCE_TARGET] = ev.length;
  return n;
}

describe('rekey after rotating EVIDENCE_KEY', () => {
  let session: { id: string; token: string };
  let c: CandidateClient;
  let webhookId: string;
  let purgedId: string;

  it('has data under the old key everywhere', async () => {
    const admin = await staffApi(env, 'admin');
    // ID photo (embedding + evidence), a session with check-in (reference, frames, evidence, access token),
    // an event screenshot, a webhook secret, and a purged evidence row.
    const cand = await env.newCandidate('Paul Photo');
    json(await admin.jpeg(`/candidates/${cand.id}/id-photo`, { person: 'alice' }));
    session = await env.newSession({ candidateId: cand.id });
    c = await startedSession(env, env.candidateClient(session.token));
    env.clock.advance(MIN);
    const evId = await clientEvent(c, { type: 'phone_detected', startedAt: env.clock.t - 5000, endedAt: env.clock.t - 1000 });
    await screenshot(c, evId, env.clock.t - 3000);
    purgedId = await screenshot(c, evId, env.clock.t - 2000);
    const [p] = await env.ctx.db.select().from(evidence).where(eq(evidence.id, purgedId));
    await purgeEvidenceRows(env.ctx, env.ctx.db, [p], 'test');
    webhookId = json(await admin.post('/webhooks', { url: 'http://127.0.0.1:9/hook', events: ['session.held'], description: 'x' })).webhook.id;

    const counts = await assertAllDecrypt(ring(K1));
    for (const [k, v] of Object.entries(counts)) expect(v, k).toBeGreaterThan(0);
  });

  it('dry run counts what is under the old key and changes nothing', async () => {
    const keyring = ring(K2, [K1]);
    const [before] = await env.ctx.db.select().from(evidence).where(and(isNull(evidence.purgedAt), eq(evidence.sessionId, session.id))).limit(1);
    const blobBefore = await env.storage.get(before.storageKey);
    const s = await rekeyAll(rekeyCtx(keyring), { dryRun: true });
    expect(s.dryRun).toBe(true);
    expect(s.currentKeyId).toBe(keyIdFor(K2));
    for (const t of s.targets) expect(t.outdated, t.target).toBeGreaterThan(0);
    expect(s.targets.every((t) => t.rekeyed === 0)).toBe(true);
    expect(Object.keys(s.remaining)).toEqual([keyIdFor(K1)]);
    expect((await env.storage.get(before.storageKey))!.equals(blobBefore!)).toBe(true);
    expect(await env.ctx.db.select().from(auditLog).where(eq(auditLog.action, 'keys.rekeyed'))).toHaveLength(0);
  });

  it('resumes an interrupted run (blob rewritten, row not yet updated) without double encryption', async () => {
    const keyring = ring(K2, [K1]);
    const [row] = await env.ctx.db.select().from(evidence).where(and(isNull(evidence.purgedAt), eq(evidence.sessionId, session.id))).limit(1);
    const aad = `evidence:${row.id}`;
    await env.storage.put(row.storageKey, keyring.encrypt(keyring.decrypt((await env.storage.get(row.storageKey))!, aad), aad));
    expect(row.keyId).toBe(keyIdFor(K1));
    const s = await rekeyAll(rekeyCtx(keyring), { only: [EVIDENCE_TARGET], batchSize: 1 });
    expect(s.targets[0].rekeyed).toBe(s.targets[0].outdated);
    const [after] = await env.ctx.db.select().from(evidence).where(eq(evidence.id, row.id));
    expect(after.keyId).toBe(keyIdFor(K2));
    expect(sha256Hex((await readEvidence({ storage: env.storage, keyring: ring(K2) }, after))!)).toBe(row.sha256);
  });

  it('re-encrypts everything in batches, audits, and is idempotent', async () => {
    const keyring = ring(K2, [K1]);
    const progress: string[] = [];
    const s = await rekeyAllExclusive(rekeyCtx(keyring), { batchSize: 2, onProgress: (p) => progress.push(`${p.target}:${p.done}/${p.total}`) });
    expect(s).not.toBeNull();
    expect(s!.failures).toEqual([]);
    expect(s!.remaining).toEqual({});
    for (const t of s!.targets) expect(t.rekeyed + t.skipped, t.target).toBe(t.outdated);
    expect(progress.length).toBeGreaterThan(COLUMN_TARGETS.length);
    const [a] = await env.ctx.db.select().from(auditLog).where(eq(auditLog.action, 'keys.rekeyed'));
    expect(a).toMatchObject({ actorType: 'system', targetType: 'keyring', targetId: keyIdFor(K2) });
    expect((a.meta as { remaining: object }).remaining).toEqual({});
    // Purged evidence stays purged (no blob resurrected).
    const [p] = await env.ctx.db.select().from(evidence).where(eq(evidence.id, purgedId));
    expect(p.purgedAt).not.toBeNull();
    expect(await env.storage.get(p.storageKey)).toBeNull();

    const again = await rekeyAll(rekeyCtx(keyring));
    expect(again.targets.every((t) => t.outdated === 0 && t.rekeyed === 0)).toBe(true);
    expect((await rekeyAll(rekeyCtx(keyring), { dryRun: true })).remaining).toEqual({});
  });

  it('refuses to run twice at the same time', async () => {
    const client = await env.ctx.database.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [REKEY_LOCK_KEY]);
      expect(await rekeyAllExclusive(rekeyCtx(ring(K2, [K1])))).toBeNull();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [REKEY_LOCK_KEY]);
      client.release();
    }
  });

  it('after removing the old key everything still decrypts, also in a server that only knows the new key', async () => {
    await assertAllDecrypt(ring(K2));
    await expect(assertAllDecrypt(ring(K1))).rejects.toThrow();

    const app2 = await buildApp({
      config: { ...env.config, evidenceKey: K2, evidenceKeysOld: [] },
      database: env.ctx.database,
      vision: new FakeVisionService({ defaultSpec: { person: 'alice' } }),
      storage: env.storage,
      bus: new LocalBus(),
      now: env.clock.now,
      migrate: false,
      jobs: false,
      bootstrap: false,
      serveWeb: false,
    });
    try {
      const cookie = (await staffApi(env, 'admin')).cookie;
      const detail = await app2.inject({ method: 'GET', url: `/api/admin/sessions/${session.id}`, headers: { cookie } });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().summary.accessLink).toBe(accessLinkFor({ config: env.config, keyring: ring(K2) } as Pick<Ctx, 'config' | 'keyring'>, (await env.ctx.db.select().from(examSessions).where(eq(examSessions.id, session.id)))[0]));
      expect(detail.json().summary.accessLink).toContain(session.token);
      const [ev] = await env.ctx.db.select().from(evidence).where(and(isNull(evidence.purgedAt), eq(evidence.sessionId, session.id))).limit(1);
      const img = await app2.inject({ method: 'GET', url: `/api/admin/evidence/${ev.id}`, headers: { cookie } });
      expect(img.statusCode).toBe(200);
      expect(img.headers['content-type']).toBe('image/jpeg');

      // The identity reference (re-encrypted) is used by a reconnect check on the new-key server.
      const inst = `inst-${randomBytes(6).toString('hex')}`;
      const on2 = (token: string, instanceId: string): CandidateClient => ({
        token,
        instanceId,
        req: (method, url, body) =>
          app2.inject({ method, url, headers: { authorization: `Bearer ${token}`, 'x-client-instance': instanceId }, ...(body !== undefined ? { payload: body as InjectOptions['payload'] } : {}) }),
        jpeg: (url, spec, query = {}, method = 'POST') =>
          app2.inject({
            method,
            url,
            query: Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
            headers: { authorization: `Bearer ${token}`, 'x-client-instance': instanceId, 'content-type': 'image/jpeg' },
            payload: Buffer.isBuffer(spec) ? spec : FakeVisionService.encode(spec),
          }),
        withInstance: (id) => on2(token, id),
      });
      env.clock.advance(10_000);
      const { complete } = await runCheck(env, on2(session.token, inst), 'reconnect', { spec: { person: 'alice' } });
      expect(complete!.outcome).toBe('passed');
      const { complete: other } = await runCheck(env, on2(session.token, `${inst}-b`), 'reconnect', { spec: { person: 'mallory' } });
      expect(other!.outcome).not.toBe('passed');
    } finally {
      await app2.close();
    }
  });

  it('reports what it cannot decrypt (key not configured) and keeps going', async () => {
    const rogue = ring(K0);
    await env.ctx.db.update(webhooks).set({ secretEnc: rogue.encryptString('whsec_x', `webhook-secret:${webhookId}`) }).where(eq(webhooks.id, webhookId));
    const s = await rekeyAll(rekeyCtx(ring(K2, [K1])));
    expect(s.failures).toEqual([{ target: 'webhook_secrets', id: webhookId, error: expect.stringMatching(/Unknown encryption key id/) }]);
    expect(s.remaining).toEqual({ [keyIdFor(K0)]: 1 });
  });
});

describe('rekey coverage', () => {
  it('covers every encrypted (bytea) column of the schema', async () => {
    const schema = await import('../src/db/schema.js');
    const { getTableColumns, isTable } = await import('drizzle-orm');
    const bytea: string[] = [];
    for (const t of Object.values(schema)) {
      if (!isTable(t)) continue;
      for (const col of Object.values(getTableColumns(t))) if (col.getSQLType() === 'bytea') bytea.push(col.name);
    }
    expect(bytea.sort()).toEqual(COLUMN_TARGETS.map((t) => t.col.name).sort());
  });
});

describe('rekey CLI', () => {
  it('dry-run / run / dry-run with exit codes and progress', async () => {
    const e = await createTestEnv();
    try {
      // Something under K1 (the env key).
      await startedSession(e, e.candidateClient(e.session.token));
      const run = promisify(execFile);
      const cli = async (...args: string[]) => {
        try {
          const r = await run(process.execPath, ['--import', 'tsx', 'src/scripts/rekey-cli.ts', ...args], {
            cwd: new URL('..', import.meta.url).pathname,
            env: {
              ...process.env,
              NODE_ENV: 'test',
              DATABASE_URL: e.config.databaseUrl,
              STORAGE_DRIVER: 'fs',
              STORAGE_DIR: (e.config.storage as { dir: string }).dir,
              EVIDENCE_KEY: K2.toString('base64'),
              EVIDENCE_KEYS_OLD: K1.toString('base64'),
              LOG_LEVEL: 'silent',
            },
          });
          return { code: 0, out: r.stdout, err: r.stderr };
        } catch (err) {
          const x = err as { code: number; stdout: string; stderr: string };
          return { code: x.code, out: x.stdout, err: x.stderr };
        }
      };
      expect((await cli('--batch-size', '0')).code).toBe(2);
      expect((await cli('--only', 'nope')).code).toBe(2);
      const dry = await cli('--dry-run');
      expect(dry.code, dry.err).toBe(3);
      expect(dry.out).toContain('DRY RUN');
      expect(dry.out).toContain(`EVIDENCE_KEYS_OLD ${keyIdFor(K1)}: still needed`);
      const real = await cli('--batch-size', '3');
      expect(real.code, real.out + real.err).toBe(0);
      expect(real.out).toMatch(/evidence_blobs\s+\d+\/\d+ re-encrypted/);
      expect(real.err).toMatch(/reference_embeddings: \d+\/\d+/);
      const after = await cli('--dry-run', '--json');
      expect(after.code).toBe(0);
      expect(JSON.parse(after.out)).toMatchObject({ dryRun: true, remaining: {}, oldKeyIds: [keyIdFor(K1)] });
      expect((await cli('--dry-run')).out).toContain(`EVIDENCE_KEYS_OLD ${keyIdFor(K1)}: no longer needed — can be removed`);
    } finally {
      await e.close();
    }
  });
});

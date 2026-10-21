/**
 * Data residency (roadmap #17): operator-configured evidence storage locations (STORAGE_LOCATIONS), the
 * organisation's choice for new images (owner only, audited), evidence rows that remember their location so every
 * read and delete goes there (staff route, ID-photo copies, purge, retention, rekey, export), the start-up check, the
 * per-location storage metrics, and `storage:move` for existing images (dry run, run, idempotent re-run, resume after
 * a failure, legal hold, deleted rows, races with purges, the advisory lock, the CLI). Two fs locations in temp dirs.
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { EvidenceStorageDTO, OrgSettingsDTO } from '@sp/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { auditLog, evidence, examSessions, organizations, type EvidenceRow } from '../src/db/schema.js';
import { createKeyring, sha256Hex } from '../src/lib/crypto.js';
import { FsStorage, MemoryStorage, StorageLocations, type BlobStorage } from '../src/lib/storage.js';
import { LocalBus } from '../src/realtime/bus.js';
import { purgeEvidenceRows, readEvidence, storeEvidence } from '../src/services/evidence.js';
import { StorageLocationsConfigError } from '../src/services/evidence-storage.js';
import { rekeyAll } from '../src/services/rekey.js';
import { DAY_MS, runRetention } from '../src/services/retention.js';
import { moveOrgEvidence, moveOrgEvidenceExclusive, movedStorageKey, STORAGE_MOVE_LOCK_KEY, StorageMoveError, type StorageMoveCtx } from '../src/services/storage-move.js';
import { FakeVisionService } from '../src/vision/fake.js';
import { clientEvent, json, MIN, otherOrg, screenshot, staffApi, type Api } from './admin/fixtures.js';
import { startedSession } from './flow.js';
import { createTestEnv, type TestEnv } from './helpers.js';
import { readZip } from './zip-reader.js';

const tempDirs: string[] = [];
const tempDir = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const euEnv = (dir: string): Record<string, string> => ({
  STORAGE_LOCATIONS: 'eu',
  STORAGE_LOCATION_EU_DRIVER: 'fs',
  STORAGE_LOCATION_EU_DIR: dir,
  STORAGE_LOCATION_EU_LABEL: 'EU (Frankfurt)',
});

/** Evidence blob files under a directory (fs storage writes `<key>` files; temporary `.tmp` files excluded). */
function blobFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.bin')).sort();
}

const evidenceRow = async (env: TestEnv, id: string): Promise<EvidenceRow> => (await env.ctx.db.select().from(evidence).where(eq(evidence.id, id)))[0];
const evidenceOfSession = (env: TestEnv, sessionId: string) => env.ctx.db.select().from(evidence).where(and(eq(evidence.sessionId, sessionId), isNull(evidence.purgedAt)));
const audits = (env: TestEnv, action: string) => env.ctx.db.select().from(auditLog).where(eq(auditLog.action, action));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** Images of passed checks are deleted right after the response (after commit): let that finish before looking. */
const settle = () => new Promise((r) => setTimeout(r, 200));

/* =================================================================== configuration */

describe('storage locations: configuration', () => {
  const base = { NODE_ENV: 'test', STORAGE_DRIVER: 'fs', STORAGE_DIR: '/data/evidence' };

  it('keeps the existing STORAGE_* configuration as the only location, `default`, when nothing else is configured', () => {
    const c = loadConfig(base);
    expect(c.storageLocations).toEqual([{ name: 'default', label: 'Default storage', storage: { driver: 'fs', dir: '/data/evidence' } }]);
    expect(c.storage).toBe(c.storageLocations[0].storage);
    expect(loadConfig({ ...base, STORAGE_LABEL: 'US (Virginia)' }).storageLocations[0].label).toBe('US (Virginia)');
  });

  it('reads further locations from STORAGE_LOCATIONS + STORAGE_LOCATION_<NAME>_* (fs and s3)', () => {
    const c = loadConfig({
      ...base,
      STORAGE_LOCATIONS: 'eu, uk-south',
      STORAGE_LOCATION_EU_DRIVER: 's3',
      STORAGE_LOCATION_EU_S3_BUCKET: 'sp-evidence-eu',
      STORAGE_LOCATION_EU_S3_REGION: 'eu-central-1',
      STORAGE_LOCATION_EU_S3_PREFIX: '/proctoring/',
      STORAGE_LOCATION_EU_LABEL: 'EU (Frankfurt)',
      STORAGE_LOCATION_UK_SOUTH_DRIVER: 'fs',
      STORAGE_LOCATION_UK_SOUTH_DIR: '/data/uk',
    });
    expect(c.warnings.filter((w) => w.startsWith('STORAGE'))).toEqual([]);
    expect(c.storageLocations.map((l) => [l.name, l.label])).toEqual([
      ['default', 'Default storage'],
      ['eu', 'EU (Frankfurt)'],
      ['uk-south', 'uk-south'],
    ]);
    expect(c.storageLocations[1].storage).toEqual({ driver: 's3', bucket: 'sp-evidence-eu', region: 'eu-central-1', endpoint: null, accessKeyId: null, secretAccessKey: null, forcePathStyle: false, prefix: 'proctoring' });
    expect(c.storageLocations[2].storage).toEqual({ driver: 'fs', dir: '/data/uk' });
  });

  it('refuses to start on an inconsistent location, naming the variable', () => {
    const bad: [Record<string, string>, RegExp][] = [
      [{ STORAGE_LOCATIONS: 'eu' }, /STORAGE_LOCATION_EU_DRIVER is required/],
      [{ STORAGE_LOCATIONS: 'eu', STORAGE_LOCATION_EU_DRIVER: 'ftp' }, /unknown STORAGE_LOCATION_EU_DRIVER "ftp" \(expected fs or s3\)/],
      [{ STORAGE_LOCATIONS: 'eu', STORAGE_LOCATION_EU_DRIVER: 'fs' }, /STORAGE_LOCATION_EU_DIR is required/],
      [{ STORAGE_LOCATIONS: 'eu', STORAGE_LOCATION_EU_DRIVER: 's3', STORAGE_LOCATION_EU_S3_REGION: 'eu-central-1' }, /STORAGE_LOCATION_EU_S3_BUCKET is required/],
      [{ STORAGE_LOCATIONS: 'eu', STORAGE_LOCATION_EU_DRIVER: 's3', STORAGE_LOCATION_EU_S3_BUCKET: 'b' }, /STORAGE_LOCATION_EU_S3_REGION is required/],
      [{ STORAGE_LOCATIONS: 'eu', STORAGE_LOCATION_EU_DRIVER: 's3', STORAGE_LOCATION_EU_S3_BUCKET: 'b', STORAGE_LOCATION_EU_S3_REGION: 'r', STORAGE_LOCATION_EU_S3_ACCESS_KEY_ID: 'AKIA' }, /set both .*S3_ACCESS_KEY_ID and .*S3_SECRET_ACCESS_KEY, or neither/],
      [{ STORAGE_LOCATIONS: 'default' }, /"default" is the location configured by STORAGE_DRIVER/],
      [{ STORAGE_LOCATIONS: 'EU' }, /invalid location name "EU"/],
      [{ STORAGE_LOCATIONS: 'eu_1' }, /invalid location name "eu_1"/],
      [{ STORAGE_LOCATIONS: 'eu,eu', STORAGE_LOCATION_EU_DRIVER: 'fs', STORAGE_LOCATION_EU_DIR: '/data/eu' }, /lists "eu" twice/],
      [{ STORAGE_LOCATIONS: 'eu', STORAGE_LOCATION_EU_DRIVER: 'fs', STORAGE_LOCATION_EU_DIR: '/data/evidence' }, /"default" and "eu" point to the same place/],
      [{ STORAGE_LOCATIONS: 'eu', STORAGE_LOCATION_EU_DRIVER: 'fs', STORAGE_LOCATION_EU_DIR: '/data/evidence/eu' }, /"default" and "eu" point to the same place/],
      [{ STORAGE_LOCATIONS: 'eu', STORAGE_LOCATION_EU_DRIVER: 'fs', STORAGE_LOCATION_EU_DIR: '/data/eu', STORAGE_LOCATION_EU_LABEL: 'x'.repeat(81) }, /STORAGE_LOCATION_EU_LABEL must be a single line/],
    ];
    for (const [env, msg] of bad) expect(() => loadConfig({ ...base, ...env }), JSON.stringify(env)).toThrow(msg);
    const s3 = { STORAGE_DRIVER: 's3', S3_BUCKET: 'shared', S3_REGION: 'us-east-1', STORAGE_LOCATIONS: 'eu', STORAGE_LOCATION_EU_DRIVER: 's3', STORAGE_LOCATION_EU_S3_BUCKET: 'shared', STORAGE_LOCATION_EU_S3_REGION: 'eu-central-1' };
    expect(() => loadConfig({ NODE_ENV: 'test', ...s3 })).toThrow(/point to the same place/);
    expect(() => loadConfig({ NODE_ENV: 'test', ...s3, S3_PREFIX: 'us', STORAGE_LOCATION_EU_S3_PREFIX: 'eu' })).not.toThrow();
  });

  it('warns about storage location variables it ignores (a typo would otherwise go unnoticed)', () => {
    const c = loadConfig({ ...base, STORAGE_LOCATIONS: 'eu', STORAGE_LOCATION_EU_DRIVER: 'fs', STORAGE_LOCATION_EU_DIR: '/data/eu', STORAGE_LOCATION_EU_BUCKET: 'x', STORAGE_LOCATION_US_DRIVER: 's3' });
    expect(c.warnings.filter((w) => w.startsWith('STORAGE'))).toEqual([
      expect.stringMatching(/^STORAGE_LOCATION_EU_BUCKET is ignored: not a storage location setting/),
      'STORAGE_LOCATION_US_DRIVER is ignored: its location is not listed in STORAGE_LOCATIONS.',
    ]);
  });
});

/* =================================================================== settings, new evidence, reads and deletes */

describe('data residency with two locations', () => {
  let env: TestEnv;
  let euDir: string;
  let eu: FsStorage;
  let owner: Api;
  let admin: Api;
  /** On disk: the file of an evidence row in its own location. */
  const fileOf = (row: EvidenceRow) => (row.storageLocation === 'eu' ? eu.resolveKey(row.storageKey) : env.storage.resolveKey(row.storageKey));
  const staffImage = async (id: string) => {
    const res = await admin.get(`/evidence/${id}`);
    return { status: res.statusCode, data: res.rawPayload };
  };

  beforeAll(async () => {
    euDir = tempDir('sp-evidence-eu-');
    env = await createTestEnv({ env: euEnv(euDir) });
    eu = new FsStorage(euDir);
    owner = await staffApi(env, 'owner');
    admin = await staffApi(env, 'admin');
  });
  afterAll(async () => env?.close());

  it('lists the configured locations to administrators — names, labels and regions only, never where or how they are stored', async () => {
    const dto = json<EvidenceStorageDTO>(await admin.get('/evidence-storage'));
    expect(dto).toEqual({
      current: 'default',
      locations: [
        { name: 'default', label: 'Default storage', region: null, isDefault: true },
        { name: 'eu', label: 'EU (Frankfurt)', region: null, isDefault: false },
      ],
      stored: [
        { location: 'default', images: 0 },
        { location: 'eu', images: 0 },
      ],
    });
    const raw = (await admin.get('/evidence-storage')).body;
    expect(raw).not.toContain(euDir);
    expect(raw).not.toContain((env.config.storage as { dir: string }).dir);
    expect((await (await staffApi(env, 'reviewer')).get('/evidence-storage')).statusCode).toBe(403);
    expect(json<OrgSettingsDTO>(await admin.get('/settings')).evidenceLocation).toBe('default');
  });

  it('only an owner chooses the location, only among the configured ones; the change is audited', async () => {
    expect(json(await admin.put('/settings', { evidenceLocation: 'eu' }), 403)).toMatchObject({ error: 'owner_required' });
    // Posting back the value in use is fine for anyone (a settings form sends everything).
    expect(json<OrgSettingsDTO>(await admin.put('/settings', { evidenceLocation: 'default', privacyContact: 'privacy@test.example' })).evidenceLocation).toBe('default');
    expect(json(await owner.put('/settings', { evidenceLocation: 'mars' }), 400)).toMatchObject({ error: 'unknown_storage_location', details: [{ path: 'evidenceLocation' }] });
    expect((await owner.put('/settings', { evidenceLocation: 'Not a name!' })).statusCode).toBe(400);

    expect(json<OrgSettingsDTO>(await owner.put('/settings', { evidenceLocation: 'eu' })).evidenceLocation).toBe('eu');
    const [org] = await env.ctx.db.select().from(organizations).where(eq(organizations.id, env.org.id));
    expect(org.settings.evidenceLocation).toBe('eu');
    const entry = (await audits(env, 'settings.updated')).find((a) => (a.meta as { fields: string[] }).fields.includes('evidenceLocation'));
    expect(entry).toMatchObject({ actorId: env.users.owner.id, meta: { evidenceLocation: { from: 'default', to: 'eu' } } });

    // Back to the default: nothing stored (the default is not written into the organisation's settings).
    expect(json<OrgSettingsDTO>(await owner.put('/settings', { evidenceLocation: 'default' })).evidenceLocation).toBe('default');
    const [after] = await env.ctx.db.select().from(organizations).where(eq(organizations.id, env.org.id));
    expect(after.settings).not.toHaveProperty('evidenceLocation');
  });

  /** Shared with the next test: a candidate with one session from before the switch and one from after it. */
  let mixed: { candidateId: string; before: string; after: string; idPhotoId: string };

  it('stores new evidence in the organisation’s location; earlier images stay readable where they were written', async () => {
    const cand = await env.newCandidate('Mia Mixed');
    // An approved ID photo uploaded while the organisation still used the default location.
    const photo = json<{ candidate: { idPhoto: { evidenceId: string } } }>(await admin.jpeg(`/candidates/${cand.id}/id-photo`, { person: 'alice' }));
    const idPhotoId = photo.candidate.idPhoto.evidenceId;
    const { exam } = await env.newExam({ policy: { identity: { idPhotoComparison: 'advisory', liveness: 'off' } } as Record<string, unknown> });

    // Session 1 before the switch: check-in images and a screenshot in `default`.
    const s1 = await env.newSession({ candidateId: cand.id, examId: exam.id });
    const c1 = await startedSession(env, env.candidateClient(s1.token));
    env.clock.advance(MIN);
    const ev1 = await clientEvent(c1, { type: 'multiple_people', startedAt: env.clock.t - 20_000, endedAt: env.clock.t - 10_000 });
    await screenshot(c1, ev1, env.clock.t - 15_000, { person: 'alice', faces: 2 });
    json(await c1.req('POST', '/api/candidate/submit'));
    await settle();
    const before = await evidenceOfSession(env, s1.id);
    expect(before.length).toBeGreaterThan(1);
    expect(before.every((r) => r.storageLocation === null && existsSync(env.storage.resolveKey(r.storageKey)))).toBe(true);
    expect(blobFiles(euDir)).toEqual([]);

    json(await owner.put('/settings', { evidenceLocation: 'eu' }));

    // Session 2 after it — checked in by someone else, so the ID-photo comparison attaches a copy of the photo.
    const s2 = await env.newSession({ candidateId: cand.id, examId: exam.id });
    const c2 = await startedSession(env, env.candidateClient(s2.token), 'bob');
    env.clock.advance(MIN);
    const ev2 = await clientEvent(c2, { type: 'multiple_people', startedAt: env.clock.t - 20_000, endedAt: env.clock.t - 10_000 });
    const shot2 = await screenshot(c2, ev2, env.clock.t - 15_000, { person: 'bob', faces: 2 });
    json(await c2.req('POST', '/api/candidate/submit'));
    await settle();
    const after = await evidenceOfSession(env, s2.id);
    expect(after.map((r) => r.kind)).toEqual(expect.arrayContaining(['identity_reference', 'event_screenshot', 'id_photo']));
    for (const r of after) {
      expect(r.storageLocation, `${r.kind} ${r.id}`).toBe('eu');
      expect(existsSync(eu.resolveKey(r.storageKey))).toBe(true);
      expect(existsSync(env.storage.resolveKey(r.storageKey))).toBe(false);
    }
    // The copy was read from `default` (where the photo on file is) and written to `eu`.
    const copy = after.find((r) => r.kind === 'id_photo')!;
    expect((await evidenceRow(env, idPhotoId)).storageLocation).toBeNull();
    expect(copy.sha256).toBe((await evidenceRow(env, idPhotoId)).sha256);
    expect((await evidenceRow(env, shot2)).storageLocation).toBe('eu');

    // Staff read both, each from its own location (and every view is still audited).
    for (const r of [...before, ...after, await evidenceRow(env, idPhotoId)]) {
      const img = await staffImage(r.id);
      expect(img.status, `${r.kind} in ${r.storageLocation ?? 'default'}`).toBe(200);
      expect(sha(img.data)).toBe(r.sha256);
    }
    const dto = json<EvidenceStorageDTO>(await admin.get('/evidence-storage'));
    expect(dto.current).toBe('eu');
    expect(dto.stored).toEqual([
      { location: 'default', images: before.length + 1 },
      { location: 'eu', images: after.length },
    ]);
    mixed = { candidateId: cand.id, before: s1.id, after: s2.id, idPhotoId };
  });

  it('exports, re-encrypts, purges and applies retention across both locations', async () => {
    // Personal-data export: the images of both sessions, decrypted.
    const req = json<{ id: string }>(await admin.post('/privacy-requests', { kind: 'access', subject: 'Mia Mixed', candidateId: mixed.candidateId }));
    const zip = readZip((await admin.get(`/privacy-requests/${req.id}/export`)).rawPayload);
    const images = [...zip.entries()].filter(([n]) => n.endsWith('.jpg'));
    const expected = [...(await evidenceOfSession(env, mixed.before)), ...(await evidenceOfSession(env, mixed.after)), await evidenceRow(env, mixed.idPhotoId)];
    expect(images.length).toBe(expected.length);
    expect(new Set(images.map(([, e]) => sha(e.data)))).toEqual(new Set(expected.map((r) => r.sha256)));
    expect(zip.get('README.txt')!.data.toString('utf8')).not.toContain('could not be decrypted');

    // Re-encryption after a key rotation: every blob rewritten in its own location, readable with the new key only.
    const K1 = Buffer.alloc(32, 7);
    const K2 = randomBytes(32);
    const rotated = createKeyring(K2, [K1]);
    const rekey = await rekeyAll({ database: env.ctx.database, db: env.ctx.db, storage: env.ctx.storage, storageLocations: env.ctx.storageLocations, keyring: rotated, now: env.clock.now, log: env.ctx.log }, { only: ['evidence_blobs'] });
    expect(rekey.failures).toEqual([]);
    expect(rekey.targets[0]).toMatchObject({ target: 'evidence_blobs', missing: 0, failed: 0 });
    expect(rekey.targets[0].rekeyed).toBeGreaterThanOrEqual(expected.length);
    const k2only = createKeyring(K2);
    for (const r of expected) {
      const now = await evidenceRow(env, r.id);
      expect(now.storageLocation).toBe(r.storageLocation);
      expect(sha256Hex((await readEvidence({ storage: env.ctx.storage, storageLocations: env.ctx.storageLocations, keyring: k2only }, now))!)).toBe(r.sha256);
    }
    // Back to K1 so the rest of the suite (and the server's keyring) reads them.
    expect((await rekeyAll({ database: env.ctx.database, db: env.ctx.db, storage: env.ctx.storage, storageLocations: env.ctx.storageLocations, keyring: createKeyring(K1, [K2]), now: env.clock.now, log: env.ctx.log }, { only: ['evidence_blobs'] })).failures).toEqual([]);

    // A purge of rows in both locations deletes each file where it is.
    const one = (await evidenceOfSession(env, mixed.before))[0];
    const two = (await evidenceOfSession(env, mixed.after))[0];
    expect(await purgeEvidenceRows(env.ctx, env.ctx.db, [one, two], 'test')).toBe(2);
    expect(existsSync(fileOf(one))).toBe(false);
    expect(existsSync(fileOf(two))).toBe(false);
    expect((await staffImage(two.id)).status).toBe(410);

    // Retention, 31 days after both sessions ended: everything else of both sessions, in both locations.
    const files = [...(await evidenceOfSession(env, mixed.before)), ...(await evidenceOfSession(env, mixed.after))].map(fileOf);
    expect(files.length).toBeGreaterThan(0);
    const summary = await runRetention(env.ctx, { now: env.clock.t + 31 * DAY_MS });
    expect(summary.failures).toEqual([]);
    expect(summary.sessions.map((s) => s.sessionId)).toEqual(expect.arrayContaining([mixed.before, mixed.after]));
    expect(files.filter((f) => existsSync(f))).toEqual([]);
    expect(await evidenceOfSession(env, mixed.before)).toEqual([]);
    expect(await evidenceOfSession(env, mixed.after)).toEqual([]);
    // The photo on file is candidate data, not session evidence: kept in `default`.
    expect(existsSync(fileOf(await evidenceRow(env, mixed.idPhotoId)))).toBe(true);
  });
});

/* =================================================================== storage:move */

describe('storage:move', () => {
  let env: TestEnv;
  let euDir: string;
  let defaultDir: string;
  /** Rows of the seeded organisation (5 screenshots on the session, 1 deleted, 1 ID photo). */
  let seeded: string[];
  let purgedId: string;
  let otherOrgEvidence: string;

  const moveCtx = (over: { default?: BlobStorage; eu?: BlobStorage } = {}): StorageMoveCtx => {
    const storageLocations = StorageLocations.fromConfig(env.config.storageLocations, { provided: { default: over.default ?? env.ctx.storage, eu: over.eu ?? env.ctx.storageLocations.get('eu') } });
    return { database: env.ctx.database, db: env.ctx.db, storage: storageLocations.default, storageLocations, keyring: env.ctx.keyring, now: env.clock.now, log: env.ctx.log };
  };
  const live = async () => env.ctx.db.select().from(evidence).where(and(eq(evidence.orgId, env.org.id), isNull(evidence.purgedAt)));
  const readAll = async (rows: EvidenceRow[]) => {
    for (const r of rows) {
      const now = await evidenceRow(env, r.id);
      expect(sha256Hex((await readEvidence(env.ctx, now))!), `evidence ${r.id} readable from ${now.storageLocation ?? 'default'}`).toBe(r.sha256);
    }
  };
  const store = async (opts: { sessionId?: string | null; candidateId?: string | null; orgId?: string } = {}) =>
    (
      await storeEvidence(env.ctx, env.ctx.db, {
        orgId: opts.orgId ?? env.org.id,
        sessionId: opts.sessionId === undefined ? env.session.id : opts.sessionId,
        candidateId: opts.candidateId === undefined ? env.candidate.id : opts.candidateId,
        kind: 'event_screenshot',
        reason: 'onset',
        capturedAt: env.clock.t,
        data: FakeVisionService.encode({ person: 'alice' }),
      })
    ).row;

  beforeAll(async () => {
    euDir = tempDir('sp-evidence-eu-move-');
    env = await createTestEnv({ env: euEnv(euDir) });
    defaultDir = (env.config.storage as { dir: string }).dir;
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push(await store());
    const purged = await store();
    await purgeEvidenceRows(env.ctx, env.ctx.db, [purged], 'test');
    purgedId = purged.id;
    rows.push(await store({ sessionId: null })); // a candidate-level image (like an ID photo)
    seeded = rows.map((r) => r.id);
    // The session is under legal hold: moving is not deleting.
    await env.ctx.db.update(examSessions).set({ legalHold: true }).where(eq(examSessions.id, env.session.id));
    const other = await otherOrg(env);
    otherOrgEvidence = (await store({ orgId: other.org.id, sessionId: other.session.id, candidateId: other.candidate.id })).id;
  });
  afterAll(async () => env?.close());

  it('a dry run counts what would move and changes nothing', async () => {
    const files = blobFiles(defaultDir);
    const s = await moveOrgEvidence(moveCtx(), { orgId: env.org.id, to: 'eu', dryRun: true });
    expect(s).toMatchObject({ dryRun: true, organisation: 'Test University', to: 'eu', before: { default: 6 }, after: { eu: 6 }, toMove: 6, moved: 0, remaining: 6, evidenceLocation: 'default' });
    expect(blobFiles(defaultDir)).toEqual(files);
    expect(blobFiles(euDir)).toEqual([]);
    expect((await live()).every((r) => r.storageLocation === null)).toBe(true);
    expect(await audits(env, 'evidence.storage_moved')).toEqual([]);
  });

  it('moves every image — copied, verified, switched, old copy deleted — despite the legal hold; deleted rows and other organisations untouched; audited', async () => {
    const rows = await live();
    const s = await moveOrgEvidence(moveCtx(), { orgId: env.org.id, to: 'eu', batchSize: 2 });
    expect(s).toMatchObject({ dryRun: false, before: { default: 6 }, after: { eu: 6 }, toMove: 6, moved: 6, skipped: 0, missing: 0, failed: 0, leftBehind: 0, remaining: 0, failures: [] });
    const now = await live();
    expect(now.map((r) => r.id).sort()).toEqual([...seeded].sort());
    for (const r of now) {
      const old = rows.find((x) => x.id === r.id)!;
      expect(r.storageLocation).toBe('eu');
      expect(r.storageKey).not.toBe(old.storageKey);
      expect(r.storageKey).toBe(movedStorageKey(old, 'eu'));
      expect(r.storageKey.startsWith(`o/${env.org.id}/`)).toBe(true);
      expect(existsSync(join(euDir, r.storageKey))).toBe(true);
      expect(existsSync(join(defaultDir, old.storageKey))).toBe(false);
      expect(r.keyId).toBe(old.keyId);
    }
    await readAll(rows);
    expect(blobFiles(euDir)).toHaveLength(6);
    // The deleted row stays a tombstone where it was; the other organisation's image is not touched.
    expect(await evidenceRow(env, purgedId)).toMatchObject({ storageLocation: null, purgedAt: expect.any(Date) });
    const other = await evidenceRow(env, otherOrgEvidence);
    expect(other.storageLocation).toBeNull();
    expect(existsSync(join(defaultDir, other.storageKey))).toBe(true);
    const [a] = await audits(env, 'evidence.storage_moved');
    expect(a).toMatchObject({ orgId: env.org.id, actorType: 'system', targetType: 'organization', targetId: env.org.id, meta: { to: 'eu', moved: 6, remaining: 0, before: { default: 6 }, after: { eu: 6 } } });
  });

  it('a re-run finds nothing to do; moving back restores the default location (rollback)', async () => {
    const again = await moveOrgEvidence(moveCtx(), { orgId: env.org.id, to: 'eu' });
    expect(again).toMatchObject({ toMove: 0, moved: 0, remaining: 0, before: { eu: 6 } });
    const rows = await live();
    const back = await moveOrgEvidence(moveCtx(), { orgId: env.org.id, to: 'default' });
    expect(back).toMatchObject({ toMove: 6, moved: 6, remaining: 0, after: { default: 6 } });
    expect((await live()).every((r) => r.storageLocation === null)).toBe(true);
    expect(blobFiles(euDir)).toEqual([]);
    await readAll(rows);
  });

  it('resumes after a failure part-way; a stray copy left by an interrupted run is overwritten, not duplicated', async () => {
    const rows = (await live()).sort((x, y) => x.id.localeCompare(y.id));
    // A previous run was killed after writing this copy and before switching the row: garbage at the target key.
    const strayKey = movedStorageKey(rows[0], 'eu');
    mkdirSync(dirname(join(euDir, strayKey)), { recursive: true });
    writeFileSync(join(euDir, strayKey), 'partial copy');
    // The target store fails on its 3rd write (disk full, network…).
    const real = new FsStorage(euDir);
    let puts = 0;
    const flaky: BlobStorage = {
      driver: 'fs',
      put: async (k, d) => {
        if (++puts === 3) throw new Error('disk full');
        return real.put(k, d);
      },
      get: (k) => real.get(k),
      delete: (k) => real.delete(k),
    };
    const first = await moveOrgEvidence(moveCtx({ eu: flaky }), { orgId: env.org.id, to: 'eu' });
    expect(first).toMatchObject({ toMove: 6, moved: 5, failed: 1, remaining: 1 });
    expect(first.failures).toEqual([{ id: rows[2].id, location: 'default', error: 'disk full' }]);
    // Nothing is unreadable in between: the failed row still points at its original.
    await readAll(rows);
    expect((await evidenceRow(env, rows[2].id)).storageLocation).toBeNull();

    const second = await moveOrgEvidence(moveCtx(), { orgId: env.org.id, to: 'eu' });
    expect(second).toMatchObject({ toMove: 1, moved: 1, failed: 0, remaining: 0 });
    await readAll(rows);
    expect(blobFiles(euDir)).toHaveLength(6); // one file per image: the stray copy was overwritten
    expect(readFileSync(join(euDir, strayKey)).toString()).not.toBe('partial copy');
    expect(blobFiles(defaultDir).filter((f) => f.startsWith(`o/${env.org.id}/`))).toEqual([]);
  });

  it('refuses a copy that does not verify; reports an old copy it could not delete (the image is read from its new place)', async () => {
    const rows = (await live()).sort((x, y) => x.id.localeCompare(y.id));
    // A target that corrupts what it stores: nothing is switched, the bad copies are removed.
    const real = new FsStorage(defaultDir);
    const corrupting: BlobStorage = { driver: 'fs', put: (k, d) => real.put(k, Buffer.concat([d.subarray(0, d.length - 1), Buffer.from([d[d.length - 1] ^ 1])])), get: (k) => real.get(k), delete: (k) => real.delete(k) };
    const bad = await moveOrgEvidence(moveCtx({ default: corrupting }), { orgId: env.org.id, to: 'default', batchSize: 4 });
    expect(bad).toMatchObject({ moved: 0, failed: 6, remaining: 6 });
    expect((await live()).every((r) => r.storageLocation === 'eu')).toBe(true);
    expect(blobFiles(defaultDir).filter((f) => f.startsWith(`o/${env.org.id}/`))).toEqual([]);
    await readAll(rows);

    // The old location refuses deletes: moved anyway, the leftover is listed with its key.
    const euReal = new FsStorage(euDir);
    const undeletable: BlobStorage = { driver: 'fs', put: (k, d) => euReal.put(k, d), get: (k) => euReal.get(k), delete: async () => Promise.reject(new Error('AccessDenied')) };
    const s = await moveOrgEvidence(moveCtx({ eu: undeletable }), { orgId: env.org.id, to: 'default' });
    expect(s).toMatchObject({ moved: 6, leftBehind: 6, remaining: 0 });
    expect(s.failures[0]).toMatchObject({ location: 'eu', key: rows[0].storageKey, error: expect.stringContaining('old copy could not be deleted: AccessDenied') });
    expect(blobFiles(euDir)).toHaveLength(6);
    await readAll(rows);
    for (const f of blobFiles(euDir)) rmSync(join(euDir, f));
  });

  it('a purge that read the row before it moved deletes the moved copy too; a reader holding the old row still finds the image', async () => {
    const [stale] = await live();
    const data = (await readEvidence(env.ctx, stale))!;
    expect((await moveOrgEvidence(moveCtx(), { orgId: env.org.id, to: 'eu' })).remaining).toBe(0);
    const moved = await evidenceRow(env, stale.id);
    expect(moved.storageLocation).toBe('eu');
    // readEvidence with the row as it was before the move follows it to its new place.
    expect((await readEvidence(env.ctx, stale))!.equals(data)).toBe(true);
    expect(await purgeEvidenceRows(env.ctx, env.ctx.db, [stale], 'test')).toBe(1);
    expect(existsSync(join(euDir, moved.storageKey))).toBe(false);
    expect(existsSync(join(defaultDir, stale.storageKey))).toBe(false);
    expect((await evidenceRow(env, stale.id)).purgedAt).not.toBeNull();
  });

  it('refuses an unknown organisation or location; runs one move at a time', async () => {
    await expect(moveOrgEvidence(moveCtx(), { orgId: randomUUID(), to: 'eu' })).rejects.toThrow(StorageMoveError);
    await expect(moveOrgEvidence(moveCtx(), { orgId: env.org.id, to: 'mars' })).rejects.toThrow(/Unknown storage location "mars" \(configured: default, eu\)/);
    const client = await env.ctx.database.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [STORAGE_MOVE_LOCK_KEY]);
      expect(await moveOrgEvidenceExclusive(moveCtx(), { orgId: env.org.id, to: 'default' })).toBeNull();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [STORAGE_MOVE_LOCK_KEY]);
      client.release();
    }
    expect((await moveOrgEvidenceExclusive(moveCtx(), { orgId: env.org.id, to: 'default', dryRun: true }))?.toMove).toBeGreaterThan(0);
  });

  it('CLI: arguments, dry run, run and re-run with exit codes and progress', async () => {
    const run = promisify(execFile);
    const cli = async (...args: string[]) => {
      try {
        const r = await run(process.execPath, ['--import', 'tsx', 'src/scripts/storage-move-cli.ts', ...args], {
          cwd: new URL('..', import.meta.url).pathname,
          env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: env.config.databaseUrl, STORAGE_DRIVER: 'fs', STORAGE_DIR: defaultDir, ...euEnv(euDir), EVIDENCE_KEY: Buffer.alloc(32, 7).toString('base64'), LOG_LEVEL: 'silent' },
        });
        return { code: 0, out: r.stdout, err: r.stderr };
      } catch (err) {
        const x = err as { code: number; stdout: string; stderr: string };
        return { code: x.code, out: x.stdout, err: x.stderr };
      }
    };
    expect((await cli('--to', 'default')).code).toBe(2);
    expect((await cli('--org', 'nope', '--to', 'default')).code).toBe(2);
    expect((await cli('--org', env.org.id, '--to', 'default', '--batch', '0')).code).toBe(2);
    const unknown = await cli('--', '--org', env.org.id, '--to', 'mars');
    expect(unknown.code).toBe(4);
    expect(unknown.err).toContain('Unknown storage location "mars"');
    expect((await cli('--org', randomUUID(), '--to', 'default')).code).toBe(4);

    const dry = await cli('--org', env.org.id, '--to', 'default', '--dry-run');
    expect(dry.code, dry.out + dry.err).toBe(3);
    expect(dry.out).toContain('DRY RUN');
    expect(dry.out).toMatch(/would move:\s+5 image\(s\)/);
    const real = await cli('--org', env.org.id, '--to', 'default', '--batch', '3');
    expect(real.code, real.out + real.err).toBe(0);
    expect(real.out).toMatch(/moved:\s+5\/5/);
    expect(real.out).toContain('every image of this organisation is in "default"');
    expect(real.err).toMatch(/from eu: 3\/5/);
    const again = await cli('--org', env.org.id, '--to', 'default', '--json');
    expect(again.code).toBe(0);
    expect(JSON.parse(again.out)).toMatchObject({ toMove: 0, moved: 0, remaining: 0, to: 'default', evidenceLocation: 'default' });
    const toEu = await cli('--org', env.org.id, '--to', 'eu', '--dry-run');
    expect(toEu.out).toContain('the organisation stores NEW images in "default"');
  });
});

/* =================================================================== start-up check, metrics */

describe('start-up check and metrics per location', () => {
  let env: TestEnv;
  let euDir: string;
  beforeAll(async () => {
    euDir = tempDir('sp-evidence-eu-check-');
    env = await createTestEnv({ env: euEnv(euDir) });
  });
  afterAll(async () => env?.close());

  const build = (config = env.config, storageLocations?: Record<string, BlobStorage>) =>
    buildApp({ config, database: env.ctx.database, vision: env.vision, storage: new MemoryStorage(), storageLocations, bus: new LocalBus(), now: env.clock.now, migrate: false, jobs: false, bootstrap: false, serveWeb: false });

  it('refuses to start while an organisation’s location, or a location holding evidence, is not configured', async () => {
    const withoutEu = { ...env.config, storageLocations: env.config.storageLocations.filter((l) => l.name === 'default') };
    const appOk = await build(withoutEu);
    await appOk.close();

    await env.ctx.db.update(organizations).set({ settings: { ...env.org.settings, evidenceLocation: 'eu' } }).where(eq(organizations.id, env.org.id));
    await expect(build(withoutEu)).rejects.toThrow(StorageLocationsConfigError);
    await expect(build(withoutEu)).rejects.toThrow(/organisation "Test University" \(.+\) stores its new evidence images in "eu"/);
    const row = await storeEvidence(env.ctx, env.ctx.db, { orgId: env.org.id, sessionId: env.session.id, kind: 'event_screenshot', capturedAt: env.clock.t, data: FakeVisionService.encode({ person: 'alice' }) });
    expect(row.row.storageLocation).toBe('eu');

    // The organisation went back to the default, but its images are still in `eu`.
    await env.ctx.db.update(organizations).set({ settings: { ...env.org.settings } }).where(eq(organizations.id, env.org.id));
    await expect(build(withoutEu)).rejects.toThrow(new RegExp(`evidence images are stored in "eu" \\(organisation ${env.org.id}: 1\\)`));
    // … deleted images do not count.
    await purgeEvidenceRows(env.ctx, env.ctx.db, [row.row], 'test');
    const app = await build(withoutEu);
    await app.close();
  });

  it('counts failed operations per location (sp_evidence_storage_errors_total{location})', async () => {
    const broken = new MemoryStorage();
    broken.put = async () => {
      throw new Error('bucket unreachable');
    };
    const app = await build(env.config, { eu: broken });
    try {
      await app.ctx.db.update(organizations).set({ settings: { ...env.org.settings, evidenceLocation: 'eu' } }).where(eq(organizations.id, env.org.id));
      await expect(storeEvidence(app.ctx, app.ctx.db, { orgId: env.org.id, sessionId: env.session.id, kind: 'event_screenshot', capturedAt: env.clock.t, data: FakeVisionService.encode({ person: 'alice' }) })).rejects.toThrow('bucket unreachable');
      const text = await app.ctx.metrics.registry.metrics();
      expect(text).toContain('sp_evidence_storage_errors_total{op="put",location="eu"} 1');
      expect(app.ctx.storageLocations.list().map((l) => l.name)).toEqual(['default', 'eu']);
    } finally {
      await env.ctx.db.update(organizations).set({ settings: { ...env.org.settings } }).where(eq(organizations.id, env.org.id));
      await app.close();
    }
  });
});

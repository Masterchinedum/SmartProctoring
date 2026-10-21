/**
 * Migration upgrades. The test template database is migrated while empty, so a migration that moves data is checked
 * here instead: a database is migrated up to the migration before it, filled with rows as the old schema stored them
 * (raw SQL — the current schema's types do not describe old tables), then migrated to the latest schema.
 */
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase, findMigrationsDir, migrate, type Database } from '../src/db/index.js';
import { DEFAULT_IDENTITY_THRESHOLDS, resolvePolicy } from '@sp/shared';
import { decisionConfigs, eventReviews, events, evidence, examSessions, exams, examVersions, organizations, privacyRequests } from '../src/db/schema.js';
import { calibrationBreakdown } from '../src/services/calibration.js';
import { ensureDecisionConfigs, listDecisionConfigs } from '../src/services/decision-configs.js';
import { gradeSession } from '../src/services/grading.js';
import { loadJobStatus, recordJobFinish, recordJobStart } from '../src/services/job-status.js';
import { createPrivacyRequest } from '../src/services/privacy-requests.js';
import { createKeyring, sha256Hex } from '../src/lib/crypto.js';
import { MemoryStorage } from '../src/lib/storage.js';
import { readEvidence } from '../src/services/evidence.js';
import { assertStorageLocationsConfigured, evidenceCountsByLocation, evidenceLocationsInUse } from '../src/services/evidence-storage.js';
import { orgSettings } from '../src/services/org.js';
import { sessionWindow, windowColumns } from '../src/services/scheduling.js';
import { sessionExamContent, versionForStart } from '../src/services/exam-versions.js';
import { dbUrl, TEST_ADMIN_URL } from './global-setup.js';

interface Journal {
  entries: { idx: number; tag: string }[];
}

const created: { name: string; database: Database; folder: string }[] = [];

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: TEST_ADMIN_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** A fresh database migrated up to and including the migration `tag` (and a pool on it). */
async function databaseAt(tag: string): Promise<Database> {
  const source = findMigrationsDir();
  const journal = JSON.parse(readFileSync(join(source, 'meta', '_journal.json'), 'utf8')) as Journal;
  const upTo = journal.entries.findIndex((e) => e.tag === tag);
  if (upTo < 0) throw new Error(`unknown migration ${tag}`);
  const folder = mkdtempSync(join(tmpdir(), 'sp-migrations-'));
  const keep = new Set(journal.entries.slice(0, upTo + 1).map((e) => `${e.tag}.sql`));
  for (const f of readdirSync(source)) if (keep.has(f)) cpSync(join(source, f), join(folder, f));
  cpSync(join(source, 'meta'), join(folder, 'meta'), { recursive: true });
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo + 1) }));

  const name = `proctor_mig_${randomBytes(5).toString('hex')}`;
  await admin((c) => c.query(`CREATE DATABASE "${name}"`));
  const database = createDatabase(dbUrl(name), { max: 3 });
  created.push({ name, database, folder });
  await migrate(database, { migrationsFolder: folder });
  return database;
}

afterAll(async () => {
  for (const { name, database, folder } of created) {
    await database.close();
    rmSync(folder, { recursive: true, force: true });
    await admin((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
  }
});

describe('0007_exam_versions', () => {
  it('gives every visible or started exam version 1 and pins started attempts to it', async () => {
    const database = await databaseAt('0006_exam_start_admission');
    const sql = (text: string, values: unknown[] = []) => database.pool.query(text, values);
    const one = async (text: string, values: unknown[] = []) => (await sql(text, values)).rows[0];

    const org = (await one(`INSERT INTO organizations (name) VALUES ('Old Org') RETURNING id`)).id;
    const cand = (await one(`INSERT INTO candidates (org_id, name) VALUES ($1, 'Old Candidate') RETURNING id`, [org])).id;
    const exam = async (title: string, status: string) =>
      (await one(`INSERT INTO exams (org_id, title, duration_sec, status, policy) VALUES ($1, $2, 600, $3, '{"pause":{"allowed":false}}') RETURNING id`, [org, title, status])).id;
    const question = async (examId: string, position: number, prompt: string, correct: string[], points = 1) =>
      (
        await one(
          `INSERT INTO questions (exam_id, position, type, prompt, options, correct, points) VALUES ($1, $2, 'single_choice', $3, '[{"id":"a","text":"A"},{"id":"b","text":"B"}]', $4, $5) RETURNING id`,
          [examId, position, prompt, JSON.stringify(correct), points],
        )
      ).id;
    let tokenSeq = 0;
    const session = async (examId: string, started: boolean, status = started ? 'active' : 'invited') =>
      (
        await one(`INSERT INTO exam_sessions (org_id, exam_id, candidate_id, access_token_hash, duration_ms, status, started_at) VALUES ($1, $2, $3, $4, 600000, $5, $6) RETURNING id`, [
          org,
          examId,
          cand,
          `hash-${++tokenSeq}`,
          status,
          started ? new Date() : null,
        ])
      ).id;

    const published = await exam('Published', 'published');
    const q2 = await question(published, 1, 'Second', ['b'], 2);
    const q1 = await question(published, 0, 'First', ['a']);
    const pubStarted = await session(published, true);
    const pubInvited = await session(published, false);
    const archived = await exam('Archived', 'archived');
    await question(archived, 0, 'Only', ['a']);
    const draftStarted = await exam('Draft (seeded and started)', 'draft');
    await question(draftStarted, 0, 'Q', ['b']);
    const draftRun = await session(draftStarted, true, 'submitted');
    const draftIdle = await exam('Draft (untouched)', 'draft');
    await question(draftIdle, 0, 'Q', ['a']);
    await session(draftIdle, false);
    const empty = await exam('Published without questions', 'published');
    await sql(`INSERT INTO answers (session_id, question_id, value, client_seq, answered_at, saved_at) VALUES ($1, $2, '"a"', 1, now(), now()), ($1, $3, '"a"', 2, now(), now())`, [pubStarted, q1, q2]);

    await migrate(database); // the real folder: applies 0007 and anything after it

    const db = database.db;
    const versions = await db.select().from(examVersions);
    const byExam = new Map(versions.map((v) => [v.examId, v]));
    expect([...byExam.keys()].sort()).toEqual([published, archived, draftStarted, empty].sort());
    expect(versions.every((v) => v.number === 1 && v.reason === 'migrated' && v.contentHash === null && v.createdBy === null)).toBe(true);
    const pv = byExam.get(published)!;
    expect(pv).toMatchObject({ title: 'Published', durationSec: 600, policy: { pause: { allowed: false } }, changes: { added: [], removed: [], changed: [], exam: [] } });
    expect(pv.questions).toEqual([
      { id: q1, type: 'single_choice', prompt: 'First', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], correct: ['a'], points: 1 },
      { id: q2, type: 'single_choice', prompt: 'Second', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], correct: ['b'], points: 2 },
    ]);
    expect(byExam.get(empty)!.questions).toEqual([]);

    const current = new Map((await db.select({ id: exams.id, v: exams.currentVersionId }).from(exams)).map((r) => [r.id, r.v]));
    expect(current.get(published)).toBe(pv.id);
    expect(current.get(draftStarted)).toBe(byExam.get(draftStarted)!.id);
    expect(current.get(draftIdle)).toBeNull();

    const pinned = new Map((await db.select({ id: examSessions.id, v: examSessions.examVersionId }).from(examSessions)).map((r) => [r.id, r.v]));
    expect(pinned.get(pubStarted)).toBe(pv.id);
    expect(pinned.get(draftRun)).toBe(byExam.get(draftStarted)!.id);
    expect(pinned.get(pubInvited)).toBeNull(); // pinned when it starts

    // The upgraded data works with the versioned code paths.
    const [s] = await db.select().from(examSessions).where(eq(examSessions.id, pubStarted));
    expect((await sessionExamContent(db, s)).version?.id).toBe(pv.id);
    expect(await gradeSession(db, s, Date.now())).toMatchObject({ points: 1, maxPoints: 3, keysVersionId: pv.id });
    const later = await db.transaction((tx) => versionForStart(tx, published, Date.now()));
    expect(later.id).toBe(pv.id);
    // A draft never versioned gets version 1 when an attempt starts (under the exam row lock).
    const idleVersion = await db.transaction((tx) => versionForStart(tx, draftIdle, Date.now()));
    expect(idleVersion).toMatchObject({ number: 1, reason: 'started', contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });
});

describe('0010_review_workflow', () => {
  it('re-categorises policy exceptions and starts the review history with the existing decisions', async () => {
    const database = await databaseAt('0009_staff_mfa');
    const sql = (text: string, values: unknown[] = []) => database.pool.query(text, values);
    const one = async (text: string, values: unknown[] = []) => (await sql(text, values)).rows[0];
    const org = (await one(`INSERT INTO organizations (name) VALUES ('Old Org') RETURNING id`)).id;
    const cand = (await one(`INSERT INTO candidates (org_id, name) VALUES ($1, 'Old Candidate') RETURNING id`, [org])).id;
    const exam = (await one(`INSERT INTO exams (org_id, title, duration_sec, status, policy) VALUES ($1, 'Old', 600, 'published', '{}') RETURNING id`, [org])).id;
    const session = (await one(`INSERT INTO exam_sessions (org_id, exam_id, candidate_id, access_token_hash, duration_ms, status) VALUES ($1, $2, $3, 'h', 600000, 'submitted') RETURNING id`, [org, exam, cand])).id;
    const reviewer = (await one(`INSERT INTO staff_users (org_id, email, name, role, password_hash) VALUES ($1, 'rev@old.example', 'Old Reviewer', 'reviewer', 'x') RETURNING id`, [org])).id;
    const reviewedAt = new Date('2026-10-01T10:00:00Z');
    let n = 0;
    const event = async (type: string, category: string, review: string, by: string | null, note: string | null) => {
      const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      await sql(
        `INSERT INTO events (id, org_id, session_id, type, category, severity, source, status, title, observation, started_at, first_received_at, received_at, review_status, reviewed_by, reviewed_at, review_note)
         VALUES ($1, $2, $3, $4, $5, 'low', 'client_vision', 'closed', 't', 'o', now(), now(), now(), $6, $7, $8, $9)`,
        [id, org, session, type, category, review, by, review === 'unreviewed' ? null : reviewedAt, note],
      );
      return id;
    };
    const reviewed = await event('looking_away', 'integrity', 'reviewed', reviewer, 'Looked at notes on the desk.');
    const dismissedByGone = await event('multiple_people', 'integrity', 'dismissed', '00000000-0000-4000-8000-0000000000ff', null);
    const open = await event('tab_hidden', 'integrity', 'unreviewed', null, null);
    const acc = await event('accommodations_applied', 'neutral', 'unreviewed', null, null);
    const staffVer = await event('identity_verified_by_staff', 'neutral', 'unreviewed', null, null);

    await migrate(database);

    const db = database.db;
    const cats = new Map((await db.select({ id: events.id, c: events.category, r: events.resolution }).from(events)).map((r) => [r.id, r]));
    expect(cats.get(acc)?.c).toBe('exception');
    expect(cats.get(staffVer)?.c).toBe('exception');
    expect(cats.get(reviewed)).toEqual({ id: reviewed, c: 'integrity', r: null });
    const history = await db.select().from(eventReviews);
    expect(history.map((h) => h.eventId).sort()).toEqual([reviewed, dismissedByGone].sort());
    expect(history.find((h) => h.eventId === reviewed)).toMatchObject({ reviewerId: reviewer, status: 'reviewed', resolution: null, note: 'Looked at notes on the desk.', previousStatus: 'unreviewed', overrides: false, at: reviewedAt, sessionId: session, orgId: org });
    // A reviewer who no longer exists: the decision is kept without a reviewer.
    expect(history.find((h) => h.eventId === dismissedByGone)).toMatchObject({ reviewerId: null, status: 'dismissed' });
    expect(history.some((h) => h.eventId === open)).toBe(false);
  });
});

describe('0011_model_governance', () => {
  it('turns the thresholds an organisation had into version 1; earlier decisions stay unrecorded', async () => {
    const database = await databaseAt('0010_review_workflow');
    const sql = (text: string, values: unknown[] = []) => database.pool.query(text, values);
    const one = async (text: string, values: unknown[] = []) => (await sql(text, values)).rows[0];
    // Customised (partially) through Settings before versioned configurations existed.
    const custom = (await one(`INSERT INTO organizations (name, settings) VALUES ('Custom Org', $1) RETURNING id`, [JSON.stringify({ identityThresholds: { match: 0.5, mismatch: 0.28 } })])).id;
    const plain = (await one(`INSERT INTO organizations (name) VALUES ('Plain Org') RETURNING id`)).id;
    const cand = (await one(`INSERT INTO candidates (org_id, name) VALUES ($1, 'Old Candidate') RETURNING id`, [custom])).id;
    const exam = (await one(`INSERT INTO exams (org_id, title, duration_sec, status, policy) VALUES ($1, 'Old', 600, 'published', '{}') RETURNING id`, [custom])).id;
    const session = (await one(`INSERT INTO exam_sessions (org_id, exam_id, candidate_id, access_token_hash, duration_ms, status) VALUES ($1, $2, $3, 'h', 600000, 'submitted') RETURNING id`, [custom, exam, cand])).id;
    const at = new Date();
    await sql(`INSERT INTO identity_checks (session_id, trigger, decision, similarity, confidence, at, received_at) VALUES ($1, 'periodic', 'match', 0.7, 0.9, $2, $2)`, [session, at]);

    await migrate(database);

    const db = database.db;
    const now = Date.now();
    const v1 = await ensureDecisionConfigs(db, custom, now);
    expect(v1).toMatchObject({ version: 1, status: 'active', thresholds: { ...DEFAULT_IDENTITY_THRESHOLDS, match: 0.5, mismatch: 0.28 } });
    expect((await listDecisionConfigs(db, custom))[0]).toMatchObject({ version: 1, releaseDefaults: false, thresholds: { match: 0.5, mismatch: 0.28 } });
    expect(await ensureDecisionConfigs(db, plain, now)).toMatchObject({ version: 1, thresholds: null });
    expect((await listDecisionConfigs(db, plain))[0]).toMatchObject({ releaseDefaults: true, thresholds: DEFAULT_IDENTITY_THRESHOLDS });
    // Idempotent.
    expect((await ensureDecisionConfigs(db, custom, now)).id).toBe(v1.id);
    expect(await db.select().from(decisionConfigs)).toHaveLength(2);
    // Decisions made before the upgrade carry no versions.
    const c = await calibrationBreakdown(db, custom, at.getTime() - 60_000, at.getTime() + 60_000);
    expect(c.segments.find((s) => s.dimension === 'decisionConfig')).toMatchObject({ segment: 'unrecorded', samples: 1 });
    expect(c.segments.find((s) => s.dimension === 'model')).toMatchObject({ segment: 'unrecorded', samples: 1 });
  });
});

describe('0012_privacy_operations', () => {
  it('adds the privacy register and job status beside existing data; an erased candidate leaves the request in place', async () => {
    const database = await databaseAt('0011_model_governance');
    const sql = (text: string, values: unknown[] = []) => database.pool.query(text, values);
    const one = async (text: string, values: unknown[] = []) => (await sql(text, values)).rows[0];
    const org = (await one(`INSERT INTO organizations (name) VALUES ('Old Org') RETURNING id`)).id;
    const cand = (await one(`INSERT INTO candidates (org_id, name) VALUES ($1, 'Old Candidate') RETURNING id`, [org])).id;
    const exam = (await one(`INSERT INTO exams (org_id, title, duration_sec, status, policy) VALUES ($1, 'Old', 600, 'published', '{}') RETURNING id`, [org])).id;
    const session = (await one(`INSERT INTO exam_sessions (org_id, exam_id, candidate_id, access_token_hash, duration_ms, status, end_reason) VALUES ($1, $2, $3, 'h', 600000, 'terminated', 'staff_terminated') RETURNING id`, [org, exam, cand])).id;

    await migrate(database);

    const db = database.db;
    const now = Date.now();
    const keyring = createKeyring(Buffer.alloc(32, 3));
    const req = await createPrivacyRequest({ keyring }, db, { id: null, orgId: org }, { kind: 'erasure', subject: 'Old Candidate', candidateId: cand, channel: 'letter', details: 'Delete me.' }, now);
    expect(req).toMatchObject({ status: 'open', candidateId: cand, source: 'staff' });
    await recordJobStart(db, 'retention', now);
    await recordJobFinish(db, 'retention', now, { summary: { sessionsEvidencePurged: 0, evidenceItemsPurged: 0, sessionsEventMetadataPurged: 0, skippedLegalHold: 0, failures: 0 } });
    expect(await loadJobStatus(db, 'retention')).toMatchObject({ lastError: null, lastSuccessAt: new Date(now) });
    await sql(`DELETE FROM candidates WHERE id = $1`, [cand]);
    const [kept] = await db.select().from(privacyRequests).where(eq(privacyRequests.id, req.id));
    expect(kept).toMatchObject({ candidateId: null, subject: 'Old Candidate' });
    expect(keyring.decryptString(kept.detailsEnc!, `privacy-request:${req.id}`)).toBe('Delete me.');
    expect(await db.select().from(examSessions).where(eq(examSessions.id, session))).toHaveLength(0);
  });
});

describe('0013_data_residency', () => {
  it('keeps existing evidence and organisations on the default location; their images stay readable', async () => {
    const database = await databaseAt('0012_privacy_operations');
    const sql = (text: string, values: unknown[] = []) => database.pool.query(text, values);
    const one = async (text: string, values: unknown[] = []) => (await sql(text, values)).rows[0];
    const org = (await one(`INSERT INTO organizations (name, settings) VALUES ('Old Org', '{"evidenceRetentionDays": 30}') RETURNING id`)).id;
    const cand = (await one(`INSERT INTO candidates (org_id, name) VALUES ($1, 'Old Candidate') RETURNING id`, [org])).id;
    const exam = (await one(`INSERT INTO exams (org_id, title, duration_sec, status, policy) VALUES ($1, 'Old', 600, 'published', '{}') RETURNING id`, [org])).id;
    const session = (await one(`INSERT INTO exam_sessions (org_id, exam_id, candidate_id, access_token_hash, duration_ms) VALUES ($1, $2, $3, 'h', 600000) RETURNING id`, [org, exam, cand])).id;
    const keyring = createKeyring(Buffer.alloc(32, 5));
    const storage = new MemoryStorage();
    const image = Buffer.from('old jpeg bytes');
    const ids = [randomUUID(), randomUUID()];
    for (const [i, id] of ids.entries()) {
      const key = `o/${org}/s/${session}/${id}.0a0b0c0d.bin`;
      await storage.put(key, keyring.encrypt(image, `evidence:${id}`));
      await sql(
        `INSERT INTO evidence (id, org_id, session_id, candidate_id, kind, captured_at, storage_key, byte_size, sha256, key_id, purged_at) VALUES ($1, $2, $3, $4, 'event_screenshot', now(), $5, $6, $7, $8, $9)`,
        [id, org, session, cand, key, image.length, sha256Hex(image), keyring.currentKeyId, i === 1 ? new Date() : null],
      );
    }

    await migrate(database);

    const db = database.db;
    const rows = await db.select().from(evidence).where(eq(evidence.orgId, org));
    expect(rows.map((r) => r.storageLocation)).toEqual([null, null]);
    const live = rows.find((r) => r.id === ids[0])!;
    expect((await readEvidence({ storage, keyring }, live))!.equals(image)).toBe(true);
    const [o] = await db.select().from(organizations).where(eq(organizations.id, org));
    expect(orgSettings(o).evidenceLocation).toBe('default');
    expect(await evidenceLocationsInUse(db)).toEqual([]);
    await expect(assertStorageLocationsConfigured(db, ['default'])).resolves.toBeUndefined();
    expect(await evidenceCountsByLocation(db, org)).toEqual({ default: 1 });
    const indexes = (await sql(`SELECT indexname FROM pg_indexes WHERE tablename = 'evidence'`)).rows.map((r) => r.indexname);
    expect(indexes).toEqual(expect.arrayContaining(['evidence_org_location_idx', 'evidence_location_idx']));
    // A location in use is found through the new index.
    await sql(`UPDATE evidence SET storage_location = 'eu' WHERE id = $1`, [ids[0]]);
    expect(await evidenceLocationsInUse(db)).toEqual(['eu']);
    await expect(assertStorageLocationsConfigured(db, ['default'])).rejects.toThrow(/evidence images are stored in "eu"/);
  });
});

describe('0014_scheduling_recovery', () => {
  it('adds the scheduling window and the reconnect count to existing sessions: no window, nothing counted', async () => {
    const database = await databaseAt('0013_data_residency');
    const sql = (text: string, values: unknown[] = []) => database.pool.query(text, values);
    const one = async (text: string, values: unknown[] = []) => (await sql(text, values)).rows[0];
    const org = (await one(`INSERT INTO organizations (name) VALUES ('Old Org') RETURNING id`)).id;
    const cand = (await one(`INSERT INTO candidates (org_id, name) VALUES ($1, 'Old Candidate') RETURNING id`, [org])).id;
    const exam = (await one(`INSERT INTO exams (org_id, title, duration_sec, status, policy) VALUES ($1, 'Old', 600, 'published', '{}') RETURNING id`, [org])).id;
    const invited = (await one(`INSERT INTO exam_sessions (org_id, exam_id, candidate_id, access_token_hash, duration_ms) VALUES ($1, $2, $3, 'h1', 600000) RETURNING id`, [org, exam, cand])).id;
    const active = (
      await one(
        `INSERT INTO exam_sessions (org_id, exam_id, candidate_id, access_token_hash, duration_ms, status, connection, started_at, policy) VALUES ($1, $2, $3, 'h2', 600000, 'active', 'offline', now(), '{"pause":{"allowed":true}}') RETURNING id`,
        [org, exam, cand],
      )
    ).id;

    await migrate(database);

    const rows = await database.db.select().from(examSessions);
    for (const r of rows) expect(r).toMatchObject({ windowStartsAt: null, windowEndsAt: null, reconnectCount: 0 });
    expect(sessionWindow(rows.find((r) => r.id === invited)!)).toBeNull();
    // An old policy snapshot has no resume policy: no limit applies to the exam in progress.
    expect(resolvePolicy(rows.find((r) => r.id === active)!.policy).resume).toEqual({ maxReconnects: null, maxOfflineMinutes: null, onLimit: 'hold' });
    const startsAt = Date.parse('2026-11-02T09:00:00Z');
    await database.db.update(examSessions).set(windowColumns({ startsAt, endsAt: null })).where(eq(examSessions.id, invited));
    const [after] = await database.db.select().from(examSessions).where(eq(examSessions.id, invited));
    expect(sessionWindow(after)).toEqual({ startsAt, endsAt: null });
    const idx = await one(`SELECT indexdef FROM pg_indexes WHERE indexname = 'exam_sessions_offline_idx'`);
    expect(idx.indexdef).toMatch(/WHERE \(connection = 'offline'::text\)/);
  });
});

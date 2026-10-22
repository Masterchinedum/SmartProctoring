/**
 * Moving an organisation's evidence images to another storage location (data residency; the `storage:move` CLI,
 * docs/OPERATIONS.md §2). New images already follow the organisation's setting (services/evidence.ts); this moves
 * the ones stored before it changed.
 *
 * For every evidence row of the organisation that is not deleted and not in the target location — per source
 * location, in primary-key order, in batches:
 *   1. read the blob (ciphertext, as stored) from the row's location;
 *   2. write it to the target location under a new key: the same layout with a suffix derived from the old key and the
 *      target (`.m<hash>.bin`), so a re-run after a crash rewrites the same object, and the new key never equals the
 *      old one (even if two locations shared a store, the old copy's deletion could not hit the new one);
 *   3. verify: read the copy back, decrypt it with the row's AAD and compare the plaintext's SHA-256 with
 *      evidence.sha256 — a copy that does not verify is deleted and the row stays where it was;
 *   4. compare-and-set: point the row at the new location and key only while it still has the old ones and is not
 *      purged (a concurrent purge, re-encryption or move is never overwritten; a copy nobody points at is deleted);
 *   5. delete the old blob.
 *
 * A crash between steps leaves every row pointing at a complete, readable blob: before step 4 the old one (the stray
 * copy is overwritten by the next run), after it the new one (the old copy may stay behind — once a dry run reports
 * nothing left in the old location, everything under the organisation's prefix `o/<orgId>/` there can be deleted).
 * Idempotent and resumable: rows already in the target are not selected again. Deleted rows (tombstones) are skipped.
 * A legal hold does not stop a move: the image is kept, only its place changes. Runs under its own advisory lock (one
 * move at a time); safe while the servers, the retention job and `rekey` run (each re-checks the row it changes).
 */
import { createHash } from 'node:crypto';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import type { Database } from '../db/index.js';
import { evidence, organizations, type EvidenceRow } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { sha256Hex } from '../lib/crypto.js';
import { evidenceStorageKey, locationName, storageAt, storedLocation } from '../lib/storage.js';
import { evidenceAad, evidenceAtLocation } from './evidence.js';
import { evidenceCountsByLocation } from './evidence-storage.js';
import { orgSettings } from './org.js';

/** Its own lock: moving, re-encryption (727274011) and retention (727274010) may run at the same time. */
export const STORAGE_MOVE_LOCK_KEY = 727_274_012;
export const STORAGE_MOVE_DEFAULT_BATCH = 100;

export type StorageMoveCtx = Pick<Ctx, 'db' | 'storage' | 'storageLocations' | 'keyring' | 'now' | 'log'> & { database: Database };

export interface StorageMoveOptions {
  orgId: string;
  /** Target location name (`default` or one of STORAGE_LOCATIONS). */
  to: string;
  dryRun?: boolean;
  batchSize?: number;
  onProgress?: (p: { from: string; done: number; total: number }) => void;
}

export interface StorageMoveFailure {
  id: string;
  /** Where the image was (location name). */
  location: string;
  error: string;
  /** For an old copy that could not be deleted: its key in `location` (delete it by hand). */
  key?: string;
}

export interface StorageMoveSummary {
  orgId: string;
  organisation: string;
  to: string;
  dryRun: boolean;
  /** Images (not deleted) per location before the run. */
  before: Record<string, number>;
  /** … and after it (a dry run: what a run would leave, assuming nothing fails). */
  after: Record<string, number>;
  /** Images outside the target location before the run. */
  toMove: number;
  moved: number;
  /** Deleted, moved or changed by someone else while being moved (nothing to do). */
  skipped: number;
  /** Rows whose blob is not in their location (nothing to move; listed in failures). */
  missing: number;
  failed: number;
  /** Moved, but the old copy could not be deleted (location and key in failures). */
  leftBehind: number;
  /** Images outside the target location after the run (a dry run: now, i.e. toMove). */
  remaining: number;
  failures: StorageMoveFailure[];
  /** The organisation's setting for NEW images; when it is not `to`, new images keep going elsewhere. */
  evidenceLocation: string;
  durationMs: number;
}

export class StorageMoveError extends Error {
  constructor(
    readonly code: 'organisation_not_found' | 'unknown_location',
    message: string,
  ) {
    super(message);
    this.name = 'StorageMoveError';
  }
}

/** Key of a blob moved to `to`: the evidence key layout with a suffix derived from the old key and the target. */
export function movedStorageKey(row: Pick<EvidenceRow, 'id' | 'orgId' | 'sessionId' | 'candidateId' | 'storageKey'>, to: string): string {
  const base = evidenceStorageKey(row.orgId, row.sessionId, row.candidateId, row.id);
  const h = createHash('sha256').update(`${row.storageKey}\n${to}`).digest('hex');
  const key = base.replace(/\.bin$/, `.m${h.slice(0, 10)}.bin`);
  return key !== row.storageKey ? key : base.replace(/\.bin$/, `.m${h.slice(10, 20)}.bin`);
}

type MoveOutcome = 'moved' | 'skipped' | 'missing';

async function moveOne(ctx: StorageMoveCtx, row: EvidenceRow, to: string, failures: StorageMoveFailure[]): Promise<MoveOutcome | 'left_behind'> {
  const from = row.storageLocation;
  const src = storageAt(ctx, from);
  const dst = storageAt(ctx, to);
  const blob = await src.get(row.storageKey);
  if (!blob) {
    failures.push({ id: row.id, location: locationName(from), error: 'the image is missing from its storage location (nothing to move)' });
    return 'missing';
  }
  const newKey = movedStorageKey(row, to);
  await dst.put(newKey, blob);
  try {
    const back = await dst.get(newKey);
    if (!back) throw new Error('the copy could not be read back from the target location');
    if (sha256Hex(ctx.keyring.decrypt(back, evidenceAad(row.id))) !== row.sha256) throw new Error('the copy does not match the original image (SHA-256)');
  } catch (err) {
    await dst.delete(newKey).catch(() => {});
    throw err;
  }
  const toStored = storedLocation(to);
  const updated = await ctx.db
    .update(evidence)
    // The copy is the stored ciphertext: its key id is whatever the blob says (a concurrent rekey may differ).
    .set({ storageLocation: toStored, storageKey: newKey, keyId: ctx.keyring.keyIdOf(blob) })
    .where(and(eq(evidence.id, row.id), eq(evidence.storageKey, row.storageKey), evidenceAtLocation(from), isNull(evidence.purgedAt)))
    .returning({ id: evidence.id });
  if (!updated.length) {
    // Purged or changed meanwhile: do not leave the copy behind (unless the row points at it).
    const [now] = await ctx.db.select({ storageKey: evidence.storageKey, storageLocation: evidence.storageLocation, purgedAt: evidence.purgedAt }).from(evidence).where(eq(evidence.id, row.id));
    if (!now || now.purgedAt || now.storageKey !== newKey || now.storageLocation !== toStored) await dst.delete(newKey);
    return 'skipped';
  }
  try {
    await src.delete(row.storageKey);
  } catch (err) {
    failures.push({ id: row.id, location: locationName(from), key: row.storageKey, error: `moved, but the old copy could not be deleted: ${(err as Error).message}` });
    return 'left_behind';
  }
  return 'moved';
}

/** Move (or, with dryRun, count) an organisation's evidence images into one storage location. */
export async function moveOrgEvidence(ctx: StorageMoveCtx, opts: StorageMoveOptions): Promise<StorageMoveSummary> {
  const started = Date.now();
  const { orgId, to } = opts;
  const batch = Math.max(1, Math.min(5000, opts.batchSize ?? STORAGE_MOVE_DEFAULT_BATCH));
  if (!ctx.storageLocations.has(to)) {
    throw new StorageMoveError('unknown_location', `Unknown storage location "${to}" (configured: ${ctx.storageLocations.list().map((l) => l.name).join(', ')}).`);
  }
  const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, orgId));
  if (!org) throw new StorageMoveError('organisation_not_found', `No organisation with id ${orgId}.`);

  const before = await evidenceCountsByLocation(ctx.db, orgId);
  const sources = Object.keys(before)
    .filter((l) => l !== to && before[l] > 0)
    .sort();
  const toMove = sources.reduce((n, l) => n + before[l], 0);
  const failures: StorageMoveFailure[] = [];
  const counts = { moved: 0, skipped: 0, missing: 0, failed: 0, leftBehind: 0 };

  if (!opts.dryRun) {
    for (const from of sources) {
      let lastId: string | null = null;
      let done = 0;
      for (;;) {
        const rows: EvidenceRow[] = await ctx.db
          .select()
          .from(evidence)
          .where(and(eq(evidence.orgId, orgId), evidenceAtLocation(storedLocation(from)), isNull(evidence.purgedAt), lastId ? gt(evidence.id, lastId) : undefined))
          .orderBy(asc(evidence.id))
          .limit(batch);
        if (rows.length === 0) break;
        for (const row of rows) {
          lastId = row.id;
          try {
            const outcome = await moveOne(ctx, row, to, failures);
            if (outcome === 'left_behind') {
              counts.moved++;
              counts.leftBehind++;
            } else counts[outcome]++;
          } catch (err) {
            counts.failed++;
            failures.push({ id: row.id, location: from, error: (err as Error).message });
            ctx.log.error({ err, evidenceId: row.id, from, to }, 'storage move: image not moved');
          }
        }
        done += rows.length;
        opts.onProgress?.({ from, done, total: before[from] });
      }
    }
  }

  const after = opts.dryRun ? { [to]: (before[to] ?? 0) + toMove } : await evidenceCountsByLocation(ctx.db, orgId);
  // A dry run changes nothing: what is outside the target now stays there.
  const remaining = opts.dryRun ? toMove : Object.entries(after).reduce((n, [l, c]) => n + (l === to ? 0 : c), 0);
  const summary: StorageMoveSummary = {
    orgId,
    organisation: org.name,
    to,
    dryRun: !!opts.dryRun,
    before,
    after,
    toMove,
    ...counts,
    remaining,
    failures,
    evidenceLocation: orgSettings(org).evidenceLocation,
    durationMs: Date.now() - started,
  };
  if (!opts.dryRun) {
    await audit(ctx.db, {
      orgId,
      actorType: 'system',
      action: 'evidence.storage_moved',
      targetType: 'organization',
      targetId: orgId,
      meta: { to, before, after, moved: counts.moved, skipped: counts.skipped, missing: counts.missing, failed: counts.failed, leftBehind: counts.leftBehind, remaining },
      at: ctx.now(),
    });
  }
  return summary;
}

/** moveOrgEvidence() under an advisory lock; null when another move is running. */
export async function moveOrgEvidenceExclusive(ctx: StorageMoveCtx, opts: StorageMoveOptions): Promise<StorageMoveSummary | null> {
  const client = await ctx.database.pool.connect();
  let locked = false;
  try {
    const res = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [STORAGE_MOVE_LOCK_KEY]);
    locked = res.rows[0]?.locked === true;
    if (!locked) return null;
    return await moveOrgEvidence(ctx, opts);
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [STORAGE_MOVE_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

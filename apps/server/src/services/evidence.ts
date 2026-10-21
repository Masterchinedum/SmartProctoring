/**
 * Evidence store: encrypts JPEGs (AES-256-GCM, per-blob IV, AAD bound to the evidence id), stores the
 * ciphertext in blob storage and metadata in the `evidence` table. Reading for staff is audit-logged.
 * Purging deletes the blob and leaves a metadata tombstone (purgedAt, purgeReason).
 *
 * Data residency: new blobs go to the organisation's storage location (settings.evidenceLocation; only looked up
 * when the server has more than one location), recorded in evidence.storage_location (null = default). Every read and
 * delete goes to the row's own location (storageFor), so images are found where they were written — or where
 * `storage:move` (services/storage-move.ts) moved them.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import type { DbOrTx, Tx } from '../db/index.js';
import { candidates, checkFrames, evidence, identityReferences, identitySampleFrames, organizations, type EvidenceKind, type EvidenceRow } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { sha256Hex } from '../lib/crypto.js';
import { evidenceStorageKey, storageAt, storedLocation, type BlobStorage } from '../lib/storage.js';

/** `storageLocations` is optional so single-store callers (tests, older tooling) keep working with the default store. */
type StorageCtx = Pick<Ctx, 'storage'> & Partial<Pick<Ctx, 'storageLocations'>>;
type EvidenceCtx = StorageCtx & Pick<Ctx, 'keyring' | 'now' | 'log'>;

export interface StoreEvidenceInput {
  /** Client-provided id for idempotent uploads; generated if omitted. */
  id?: string;
  orgId: string;
  sessionId?: string | null;
  candidateId?: string | null;
  eventId?: string | null;
  identityCheckId?: string | null;
  kind: EvidenceKind;
  reason?: string | null;
  capturedAt: number;
  data: Buffer;
  contentType?: string;
  clientInstanceId?: string | null;
}

export interface StoreEvidenceResult {
  row: EvidenceRow;
  duplicate: boolean;
}

const aadFor = (id: string) => `evidence:${id}`;
/** AAD of an evidence blob (services/rekey.ts and services/storage-move.ts decrypt with it). */
export const evidenceAad = aadFor;

/** Condition: evidence.storage_location is `location` (a stored value; null = the default location). */
export function evidenceAtLocation(location: string | null): SQL {
  return location == null ? isNull(evidence.storageLocation) : eq(evidence.storageLocation, location);
}

/** The store holding an evidence row's blob: its own storage location (null = default). */
export function storageFor(ctx: StorageCtx, row: Pick<EvidenceRow, 'storageLocation'>): BlobStorage {
  return storageAt(ctx, row.storageLocation);
}

/**
 * Where new evidence of an organisation goes: its chosen storage location (null = default). Not looked up at all
 * when the server has only the default location.
 */
export async function evidenceLocationFor(ctx: StorageCtx, db: DbOrTx, orgId: string): Promise<string | null> {
  if (!ctx.storageLocations || ctx.storageLocations.size <= 1) return null;
  const [o] = await db
    .select({ location: sql<string | null>`${organizations.settings}->>'evidenceLocation'` })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return storedLocation(o?.location);
}

/** Delete one blob, logging (not throwing) a failure — including a location this server does not have. */
async function deleteQuietly(ctx: EvidenceCtx, location: string | null, key: string, evidenceId: string, msg: string): Promise<void> {
  try {
    await storageAt(ctx, location).delete(key);
  } catch (err) {
    ctx.log.error({ err, evidenceId, storageLocation: location }, msg);
  }
}

/**
 * Blobs storeEvidence wrote inside a transaction run by transactionWithEvidence, by transaction handle. The blob is
 * written before its row, so a transaction that rolls back (an error after the upload, a lost database connection)
 * would leave an encrypted image no row points to — one retention can never find and delete.
 */
const uncommittedBlobs = new WeakMap<object, StoredBlob[]>();

/** A blob written by storeEvidence: its evidence id, key and the storage location it went to (null = default). */
interface StoredBlob {
  id: string;
  key: string;
  location: string | null;
}

/**
 * ctx.db.transaction() for work that stores evidence: blobs written in a transaction that rolled back are deleted
 * again. When the transaction failed at COMMIT (the connection was lost: the outcome is unknown), only the blobs
 * whose rows did not make it are deleted; if that cannot be checked, they are kept (a blob without a row is
 * recoverable; a row without its blob is not).
 */
export async function transactionWithEvidence<T>(ctx: EvidenceCtx & Pick<Ctx, 'db'>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const blobs: StoredBlob[] = [];
  let reachedCommit = false;
  try {
    return await ctx.db.transaction(async (tx) => {
      uncommittedBlobs.set(tx, blobs);
      const out = await fn(tx);
      reachedCommit = true;
      return out;
    });
  } catch (err) {
    if (blobs.length) await discardUncommittedBlobs(ctx, blobs, reachedCommit);
    throw err;
  }
}

async function discardUncommittedBlobs(ctx: EvidenceCtx & Pick<Ctx, 'db'>, blobs: StoredBlob[], commitUnknown: boolean): Promise<void> {
  let orphans = blobs;
  if (commitUnknown) {
    try {
      const kept = await ctx.db
        .select({ key: evidence.storageKey })
        .from(evidence)
        .where(inArray(evidence.storageKey, blobs.map((b) => b.key)));
      const committed = new Set(kept.map((r) => r.key));
      orphans = blobs.filter((b) => !committed.has(b.key));
    } catch (err) {
      ctx.log.warn({ err, blobs: blobs.length }, 'evidence blobs of a transaction whose commit failed are kept (cannot check whether it committed)');
      return;
    }
  }
  for (const b of orphans) await deleteQuietly(ctx, b.location, b.key, b.id, 'failed to delete the evidence blob of a rolled-back transaction');
}

/** The evidence row of a stored blob could not be inserted: the blob must not outlive it (deleted where it was written). */
async function discardFailedInsert(ctx: EvidenceCtx, db: DbOrTx, blob: StoredBlob): Promise<void> {
  // Inside transactionWithEvidence the failed statement aborted the transaction: nothing was written. Elsewhere the
  // statement may have committed although its answer was lost (connection failure): delete only once that is ruled
  // out (in an aborted transaction the check fails, and the blob is kept).
  if (!uncommittedBlobs.has(db)) {
    try {
      const [row] = await db.select({ id: evidence.id }).from(evidence).where(eq(evidence.storageKey, blob.key));
      if (row) return;
    } catch {
      return;
    }
  }
  await deleteQuietly(ctx, blob.location, blob.key, blob.id, 'failed to delete the blob of an evidence row that was not written');
}

/** Encrypt + store. Idempotent on `id` (a second upload with the same id returns duplicate=true). */
export async function storeEvidence(ctx: EvidenceCtx, db: DbOrTx, input: StoreEvidenceInput): Promise<StoreEvidenceResult> {
  const id = input.id ?? randomUUID();
  // Only a caller-provided id can already exist (idempotent client uploads); a fresh UUID cannot.
  if (input.id) {
    const existing = await db.select().from(evidence).where(eq(evidence.id, id));
    if (existing[0]) return { row: existing[0], duplicate: true };
  }

  const blob = ctx.keyring.encrypt(input.data, aadFor(id));
  const baseKey = evidenceStorageKey(input.orgId, input.sessionId ?? null, input.candidateId ?? null, id);
  const storageKey = baseKey.replace(/\.bin$/, `.${randomBytes(4).toString('hex')}.bin`);
  const storageLocation = await evidenceLocationFor(ctx, db, input.orgId);
  const store = storageAt(ctx, storageLocation);
  await store.put(storageKey, blob);
  let inserted: EvidenceRow[];
  try {
    inserted = await db
      .insert(evidence)
      .values({
        id,
        orgId: input.orgId,
        sessionId: input.sessionId ?? null,
        candidateId: input.candidateId ?? null,
        eventId: input.eventId ?? null,
        identityCheckId: input.identityCheckId ?? null,
        kind: input.kind,
        reason: input.reason ?? null,
        capturedAt: new Date(input.capturedAt),
        storageKey,
        storageLocation,
        byteSize: input.data.length,
        sha256: sha256Hex(input.data),
        keyId: ctx.keyring.currentKeyId,
        contentType: input.contentType ?? 'image/jpeg',
        clientInstanceId: input.clientInstanceId ?? null,
        createdAt: new Date(ctx.now()),
      })
      .onConflictDoNothing({ target: evidence.id })
      .returning();
  } catch (err) {
    await discardFailedInsert(ctx, db, { id, key: storageKey, location: storageLocation });
    throw err;
  }
  // Written in a transaction that may still roll back: transactionWithEvidence deletes the blob again if it does.
  uncommittedBlobs.get(db)?.push({ id, key: storageKey, location: storageLocation });
  if (!inserted[0]) {
    // Lost a race with a concurrent upload of the same id.
    await store.delete(storageKey).catch(() => {});
    const [row] = await db.select().from(evidence).where(eq(evidence.id, id));
    return { row, duplicate: true };
  }
  return { row: inserted[0], duplicate: false };
}

/**
 * Decrypt an evidence blob, from the row's storage location. Returns null if purged or missing. Does NOT audit (use
 * readEvidenceForStaff). With `ctx.db`, a blob moved by `storage:move` after the row was read is found at its new place.
 */
export async function readEvidence(ctx: StorageCtx & Pick<Ctx, 'keyring'> & Partial<Pick<Ctx, 'db'>>, row: EvidenceRow): Promise<Buffer | null> {
  if (row.purgedAt) return null;
  let blob = await storageFor(ctx, row).get(row.storageKey);
  if (!blob && ctx.db) {
    const [now] = await ctx.db
      .select({ storageKey: evidence.storageKey, storageLocation: evidence.storageLocation, purgedAt: evidence.purgedAt })
      .from(evidence)
      .where(eq(evidence.id, row.id));
    if (now && !now.purgedAt && (now.storageKey !== row.storageKey || now.storageLocation !== row.storageLocation)) blob = await storageFor(ctx, now).get(now.storageKey);
  }
  if (!blob) return null;
  return ctx.keyring.decrypt(blob, aadFor(row.id));
}

export interface StaffActor {
  id: string;
  orgId: string;
  ip?: string | null;
}

/**
 * Staff access to an evidence image: checks org, decrypts, and writes an `evidence.view` audit record.
 * Returns null when not found / other org; `{ row, data: null }` when purged or blob missing.
 */
export async function readEvidenceForStaff(ctx: Ctx, evidenceId: string, actor: StaffActor): Promise<{ row: EvidenceRow; data: Buffer | null } | null> {
  const [row] = await ctx.db.select().from(evidence).where(eq(evidence.id, evidenceId));
  if (!row || row.orgId !== actor.orgId) return null;
  const data = await readEvidence(ctx, row);
  await audit(ctx.db, {
    orgId: actor.orgId,
    actorType: 'staff',
    actorId: actor.id,
    action: 'evidence.view',
    targetType: 'evidence',
    targetId: row.id,
    meta: { kind: row.kind, sessionId: row.sessionId, candidateId: row.candidateId, eventId: row.eventId, available: data != null },
    ip: actor.ip ?? null,
    at: ctx.now(),
  });
  return { row, data };
}

/** Purge blobs and tombstone the rows. Returns the number purged. */
export async function purgeEvidenceRows(ctx: EvidenceCtx, db: DbOrTx, rows: EvidenceRow[], reason: string): Promise<number> {
  let n = 0;
  for (const row of rows) {
    if (row.purgedAt) continue;
    try {
      await storageFor(ctx, row).delete(row.storageKey);
    } catch (err) {
      ctx.log.error({ err, evidenceId: row.id, storageLocation: row.storageLocation }, 'failed to delete evidence blob; will retry on next purge');
      continue;
    }
    // RETURNING gives the row's place as of the tombstone: a concurrent `storage:move` may have moved the blob since
    // `row` was read.
    const [after] = await db
      .update(evidence)
      .set({ purgedAt: new Date(ctx.now()), purgeReason: reason })
      .where(and(eq(evidence.id, row.id), isNull(evidence.purgedAt)))
      .returning({ storageKey: evidence.storageKey, storageLocation: evidence.storageLocation });
    // Delete once more after the tombstone: a concurrent re-encryption (services/rekey.ts) that read the blob
    // before the first delete may have written it back; it re-checks purgedAt after writing, and this covers the
    // other order. Idempotent. A blob moved meanwhile is deleted at its new place too.
    await deleteQuietly(ctx, row.storageLocation, row.storageKey, row.id, 'failed to delete evidence blob after purge');
    if (after && (after.storageKey !== row.storageKey || after.storageLocation !== row.storageLocation)) {
      await deleteQuietly(ctx, after.storageLocation, after.storageKey, row.id, 'failed to delete moved evidence blob after purge');
    }
    n++;
  }
  return n;
}

/**
 * Purge everything biometric/visual for a session: evidence blobs, reference embeddings, per-frame embeddings.
 * Event/identity-check metadata is kept (tombstones). Caller writes the audit record and sets exam_sessions.evidencePurgedAt.
 */
export async function purgeSessionEvidence(ctx: EvidenceCtx, db: DbOrTx, sessionId: string, reason: string): Promise<{ evidence: number }> {
  const rows = await db
    .select()
    .from(evidence)
    .where(and(eq(evidence.sessionId, sessionId), isNull(evidence.purgedAt)));
  const n = await purgeEvidenceRows(ctx, db, rows, reason);
  const now = new Date(ctx.now());
  await db.update(identityReferences).set({ embeddingsEnc: null, purgedAt: now }).where(and(eq(identityReferences.sessionId, sessionId), isNull(identityReferences.purgedAt)));
  await db.update(checkFrames).set({ embeddingEnc: null }).where(eq(checkFrames.sessionId, sessionId));
  await db.update(identitySampleFrames).set({ embeddingEnc: null }).where(eq(identitySampleFrames.sessionId, sessionId));
  return { evidence: n };
}

/**
 * Remove a candidate's approved ID photo (blob + embedding). Copies attached to a session's event (the photo an
 * identity event was compared with) are that session's evidence: retention and legal hold govern them.
 */
export async function purgeCandidateIdPhoto(ctx: EvidenceCtx, db: DbOrTx, candidateId: string, reason: string): Promise<void> {
  const rows = await db
    .select()
    .from(evidence)
    .where(and(eq(evidence.candidateId, candidateId), eq(evidence.kind, 'id_photo'), isNull(evidence.sessionId), isNull(evidence.purgedAt)));
  await purgeEvidenceRows(ctx, db, rows, reason);
  await db
    .update(candidates)
    .set({ idPhotoEvidenceId: null, idPhotoEmbedding: null, idPhotoQuality: null, idPhotoApprovedAt: null, idPhotoApprovedBy: null, updatedAt: new Date(ctx.now()) })
    .where(eq(candidates.id, candidateId));
}

export async function loadEvidenceRows(db: DbOrTx, ids: string[]): Promise<EvidenceRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(evidence).where(inArray(evidence.id, ids));
}

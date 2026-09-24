/**
 * Evidence store: encrypts JPEGs (AES-256-GCM, per-blob IV, AAD bound to the evidence id), stores the
 * ciphertext in blob storage and metadata in the `evidence` table. Reading for staff is audit-logged.
 * Purging deletes the blob and leaves a metadata tombstone (purgedAt, purgeReason).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import type { DbOrTx } from '../db/index.js';
import { candidates, checkFrames, evidence, identityReferences, type EvidenceKind, type EvidenceRow } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { sha256Hex } from '../lib/crypto.js';
import { evidenceStorageKey } from '../lib/storage.js';

type EvidenceCtx = Pick<Ctx, 'storage' | 'keyring' | 'now' | 'log'>;

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

/** Encrypt + store. Idempotent on `id` (a second upload with the same id returns duplicate=true). */
export async function storeEvidence(ctx: EvidenceCtx, db: DbOrTx, input: StoreEvidenceInput): Promise<StoreEvidenceResult> {
  const id = input.id ?? randomUUID();
  const existing = await db.select().from(evidence).where(eq(evidence.id, id));
  if (existing[0]) return { row: existing[0], duplicate: true };

  const blob = ctx.keyring.encrypt(input.data, aadFor(id));
  const baseKey = evidenceStorageKey(input.orgId, input.sessionId ?? null, input.candidateId ?? null, id);
  const storageKey = baseKey.replace(/\.bin$/, `.${randomBytes(4).toString('hex')}.bin`);
  await ctx.storage.put(storageKey, blob);
  const inserted = await db
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
      byteSize: input.data.length,
      sha256: sha256Hex(input.data),
      keyId: ctx.keyring.currentKeyId,
      contentType: input.contentType ?? 'image/jpeg',
      clientInstanceId: input.clientInstanceId ?? null,
      createdAt: new Date(ctx.now()),
    })
    .onConflictDoNothing({ target: evidence.id })
    .returning();
  if (!inserted[0]) {
    // Lost a race with a concurrent upload of the same id.
    await ctx.storage.delete(storageKey).catch(() => {});
    const [row] = await db.select().from(evidence).where(eq(evidence.id, id));
    return { row, duplicate: true };
  }
  return { row: inserted[0], duplicate: false };
}

/** Decrypt an evidence blob. Returns null if purged or missing. Does NOT audit (use readEvidenceForStaff). */
export async function readEvidence(ctx: Pick<Ctx, 'storage' | 'keyring'>, row: EvidenceRow): Promise<Buffer | null> {
  if (row.purgedAt) return null;
  const blob = await ctx.storage.get(row.storageKey);
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
      await ctx.storage.delete(row.storageKey);
    } catch (err) {
      ctx.log.error({ err, evidenceId: row.id }, 'failed to delete evidence blob; will retry on next purge');
      continue;
    }
    await db
      .update(evidence)
      .set({ purgedAt: new Date(ctx.now()), purgeReason: reason })
      .where(and(eq(evidence.id, row.id), isNull(evidence.purgedAt)));
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
  return { evidence: n };
}

/** Remove a candidate's approved ID photo (blob + embedding). */
export async function purgeCandidateIdPhoto(ctx: EvidenceCtx, db: DbOrTx, candidateId: string, reason: string): Promise<void> {
  const rows = await db
    .select()
    .from(evidence)
    .where(and(eq(evidence.candidateId, candidateId), eq(evidence.kind, 'id_photo'), isNull(evidence.purgedAt)));
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

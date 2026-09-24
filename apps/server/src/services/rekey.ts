/**
 * Re-encryption after an EVIDENCE_KEY rotation (security review #8): everything encrypted under a key other than
 * the current one is decrypted (old keys come from EVIDENCE_KEYS_OLD) and encrypted again with the current key and
 * the same AAD, so old keys can eventually be removed.
 *
 *   database columns (bytea, key id in the blob header):
 *     candidates.id_photo_embedding          idphoto:<candidateId>
 *     identity_references.embeddings_enc    reference:<referenceId>
 *     check_frames.embedding_enc            frame:<frameId>
 *     exam_sessions.access_token_enc        access-token:<sessionId>
 *     webhooks.secret_enc                   webhook-secret:<webhookId>
 *   evidence blobs (storage; evidence.key_id)  evidence:<evidenceId>   (purged rows have no blob)
 *   organizations.settings.externalVerifier.credentialsEnc (base64 in JSON)  external-verifier:<orgId>
 *
 * Batches in primary-key order, each row on its own: a row is only rewritten if it still holds the ciphertext that
 * was read (compare-and-set), so concurrent writers, purges and re-uploads are never overwritten. Idempotent and
 * resumable — a re-run skips everything already under the current key. Evidence blobs are replaced in place
 * (atomic put) before `evidence.key_id` is updated; a crash in between leaves a blob whose header already names
 * the current key (still readable), which the next run just records. `--dry-run` only counts.
 *
 * Runs under an advisory lock (one re-encryption at a time).
 */
import { and, asc, eq, gt, isNotNull, isNull, ne, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Ctx } from '../context.js';
import type { Database, Db } from '../db/index.js';
import { candidates, checkFrames, evidence, examSessions, identityReferences, identitySampleFrames, organizations, webhooks } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { verifierCredentialsAad } from '../verifiers/settings.js';
import { frameAad, idPhotoAad, referenceAad, sampleFrameAad } from './identity-common.js';

/**
 * Its own lock: re-encryption and the retention job (RETENTION_LOCK_KEY 727274010) are safe to run concurrently
 * (compare-and-set here, delete-after-tombstone in purgeEvidenceRows). Sharing the retention key made `rekey` fail
 * with "another re-encryption is running" whenever a server was running retention — e.g. right after the restart
 * the rotation procedure requires (retention runs at start) — and blocked retention during a long re-encryption.
 */
export const REKEY_LOCK_KEY = 727_274_011;
export const REKEY_DEFAULT_BATCH = 200;

export type RekeyCtx = Pick<Ctx, 'db' | 'storage' | 'keyring' | 'now' | 'log'> & { database: Database };

interface ColumnTarget {
  name: string;
  table: PgTable;
  id: PgColumn;
  col: PgColumn;
  aad: (id: string) => string;
}

/** Every encrypted database column. Keep in sync with keyring.encrypt() call sites (SERVER_NOTES.md "Encrypted AADs"). */
export const COLUMN_TARGETS: ColumnTarget[] = [
  { name: 'id_photo_embeddings', table: candidates, id: candidates.id, col: candidates.idPhotoEmbedding, aad: idPhotoAad },
  { name: 'reference_embeddings', table: identityReferences, id: identityReferences.id, col: identityReferences.embeddingsEnc, aad: referenceAad },
  { name: 'check_frame_embeddings', table: checkFrames, id: checkFrames.id, col: checkFrames.embeddingEnc, aad: frameAad },
  { name: 'sample_frame_embeddings', table: identitySampleFrames, id: identitySampleFrames.id, col: identitySampleFrames.embeddingEnc, aad: sampleFrameAad },
  { name: 'access_tokens', table: examSessions, id: examSessions.id, col: examSessions.accessTokenEnc, aad: (id) => `access-token:${id}` },
  { name: 'webhook_secrets', table: webhooks, id: webhooks.id, col: webhooks.secretEnc, aad: (id) => `webhook-secret:${id}` },
];
export const EVIDENCE_TARGET = 'evidence_blobs';
/** External verifier key pairs: base64 ciphertext inside organizations.settings (verifiers/settings.ts). */
export const VERIFIER_CREDENTIALS_TARGET = 'external_verifier_credentials';
export const REKEY_TARGETS = [...COLUMN_TARGETS.map((t) => t.name), EVIDENCE_TARGET, VERIFIER_CREDENTIALS_TARGET];

const verifierCredentialsSql = sql<string | null>`${organizations.settings}->'externalVerifier'->>'credentialsEnc'`;

/** Organisations with a stored verifier key pair (few rows: one per organisation at most). */
async function verifierCredentialRows(db: Db): Promise<{ id: string; enc: string }[]> {
  const rows = await db.select({ id: organizations.id, enc: verifierCredentialsSql }).from(organizations).where(sql`${verifierCredentialsSql} IS NOT NULL`).orderBy(asc(organizations.id));
  return rows.filter((r): r is { id: string; enc: string } => typeof r.enc === 'string' && r.enc.length > 0);
}

/** Key id in a base64 keyring blob ('?' if it is not one of ours). */
function keyIdOfBase64(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length <= 5 || buf.subarray(0, 4).toString('latin1') !== 'SPE1') return '?';
  return buf.subarray(5, 5 + buf[4]).toString('utf8');
}

/** Key id embedded in an encrypted bytea value ("SPE1" | len | keyId | …), '?' if it is not one of our blobs. */
function keyIdSql(col: PgColumn): SQL<string> {
  return sql<string>`CASE WHEN length(${col}) > 5 AND substring(${col} from 1 for 4) = '\\x53504531'::bytea
    THEN convert_from(substring(${col} from 6 for get_byte(${col}, 4)), 'UTF8') ELSE '?' END`;
}

export interface RekeyTargetSummary {
  target: string;
  /** Items found under a key other than the current one (before this run). */
  outdated: number;
  rekeyed: number;
  /** Changed or deleted concurrently (nothing to do: the new value is under the current key or gone). */
  skipped: number;
  /** Evidence rows whose blob is missing from storage. */
  missing: number;
  failed: number;
}

export interface RekeySummary {
  dryRun: boolean;
  currentKeyId: string;
  targets: RekeyTargetSummary[];
  /** Items still encrypted under each non-current key id AFTER the run (for a dry run: what a run would do). */
  remaining: Record<string, number>;
  failures: { target: string; id: string; error: string }[];
  durationMs: number;
}

export interface RekeyProgress {
  target: string;
  done: number;
  total: number;
}

export interface RekeyOptions {
  dryRun?: boolean;
  batchSize?: number;
  /** Limit to these targets (REKEY_TARGETS). */
  only?: string[];
  onProgress?: (p: RekeyProgress) => void;
}

/** Count items per key id for every target (current key included). */
export async function countByKeyId(db: Db, only?: string[]): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {};
  for (const t of COLUMN_TARGETS) {
    if (only && !only.includes(t.name)) continue;
    const rows = await db
      .select({ keyId: keyIdSql(t.col), n: sql<number>`count(*)::int` })
      .from(t.table)
      .where(isNotNull(t.col))
      .groupBy(sql`1`);
    out[t.name] = Object.fromEntries(rows.map((r) => [r.keyId, r.n]));
  }
  if (!only || only.includes(EVIDENCE_TARGET)) {
    const rows = await db
      .select({ keyId: evidence.keyId, n: sql<number>`count(*)::int` })
      .from(evidence)
      .where(isNull(evidence.purgedAt))
      .groupBy(evidence.keyId);
    out[EVIDENCE_TARGET] = Object.fromEntries(rows.map((r) => [r.keyId, r.n]));
  }
  if (!only || only.includes(VERIFIER_CREDENTIALS_TARGET)) {
    const byKey: Record<string, number> = {};
    for (const r of await verifierCredentialRows(db)) byKey[keyIdOfBase64(r.enc)] = (byKey[keyIdOfBase64(r.enc)] ?? 0) + 1;
    out[VERIFIER_CREDENTIALS_TARGET] = byKey;
  }
  return out;
}

function remainingFrom(counts: Record<string, Record<string, number>>, currentKeyId: string): Record<string, number> {
  const rem: Record<string, number> = {};
  for (const byKey of Object.values(counts)) {
    for (const [k, n] of Object.entries(byKey)) if (k !== currentKeyId && n > 0) rem[k] = (rem[k] ?? 0) + n;
  }
  return rem;
}

async function rekeyColumn(ctx: RekeyCtx, t: ColumnTarget, sum: RekeyTargetSummary, failures: RekeySummary['failures'], batch: number, onProgress?: RekeyOptions['onProgress']): Promise<void> {
  const current = ctx.keyring.currentKeyId;
  const key = columnKey(t);
  let lastId: string | null = null;
  let done = 0;
  for (;;) {
    const conds = [isNotNull(t.col), ne(keyIdSql(t.col), current), lastId ? gt(t.id, lastId) : undefined];
    const rows: { id: string; blob: Buffer | null }[] = await ctx.db
      .select({ id: sql<string>`${t.id}`, blob: sql<Buffer | null>`${t.col}` })
      .from(t.table)
      .where(and(...conds))
      .orderBy(asc(t.id))
      .limit(batch);
    if (rows.length === 0) break;
    for (const r of rows) {
      lastId = r.id;
      if (!r.blob) continue;
      try {
        const plain = ctx.keyring.decrypt(r.blob, t.aad(r.id));
        const next = ctx.keyring.encrypt(plain, t.aad(r.id));
        const updated = await ctx.db
          .update(t.table)
          .set({ [key]: next } as Record<string, unknown>)
          .where(and(eq(t.id, r.id), sql`${t.col} = ${r.blob}`))
          .returning({ id: sql<string>`${t.id}` });
        if (updated.length) sum.rekeyed++;
        else sum.skipped++;
      } catch (err) {
        sum.failed++;
        failures.push({ target: t.name, id: r.id, error: (err as Error).message });
      }
    }
    done += rows.length;
    onProgress?.({ target: t.name, done, total: sum.outdated });
  }
}

/** Property name of the target column in the drizzle table (for .set()). */
function columnKey(t: ColumnTarget): string {
  const cols = (t.table as unknown as Record<string, unknown>) ?? {};
  for (const [k, v] of Object.entries(cols)) if (v === t.col) return k;
  throw new Error(`column ${t.col.name} not found on its table`);
}

async function rekeyEvidence(ctx: RekeyCtx, sum: RekeyTargetSummary, failures: RekeySummary['failures'], batch: number, onProgress?: RekeyOptions['onProgress']): Promise<void> {
  const current = ctx.keyring.currentKeyId;
  let lastId: string | null = null;
  let done = 0;
  for (;;) {
    const rows = await ctx.db
      .select({ id: evidence.id, storageKey: evidence.storageKey, keyId: evidence.keyId })
      .from(evidence)
      .where(and(isNull(evidence.purgedAt), ne(evidence.keyId, current), lastId ? gt(evidence.id, lastId) : undefined))
      .orderBy(asc(evidence.id))
      .limit(batch);
    if (rows.length === 0) break;
    for (const r of rows) {
      lastId = r.id;
      const aad = `evidence:${r.id}`;
      try {
        const blob = await ctx.storage.get(r.storageKey);
        if (!blob) {
          sum.missing++;
          continue;
        }
        // The blob header is authoritative (a previous run may have stopped after writing the blob).
        if (ctx.keyring.keyIdOf(blob) !== current) {
          const next = ctx.keyring.encrypt(ctx.keyring.decrypt(blob, aad), aad);
          await ctx.storage.put(r.storageKey, next);
        }
        const updated = await ctx.db
          .update(evidence)
          .set({ keyId: current })
          .where(and(eq(evidence.id, r.id), eq(evidence.storageKey, r.storageKey), isNull(evidence.purgedAt)))
          .returning({ id: evidence.id });
        if (updated.length) {
          sum.rekeyed++;
        } else {
          // Purged (or moved) while we were writing: make sure the blob we wrote does not outlive the purge.
          const [now] = await ctx.db.select({ purgedAt: evidence.purgedAt, storageKey: evidence.storageKey }).from(evidence).where(eq(evidence.id, r.id));
          if (!now || now.purgedAt || now.storageKey !== r.storageKey) await ctx.storage.delete(r.storageKey);
          sum.skipped++;
        }
      } catch (err) {
        sum.failed++;
        failures.push({ target: EVIDENCE_TARGET, id: r.id, error: (err as Error).message });
      }
    }
    done += rows.length;
    onProgress?.({ target: EVIDENCE_TARGET, done, total: sum.outdated });
  }
}

async function rekeyVerifierCredentials(ctx: RekeyCtx, sum: RekeyTargetSummary, failures: RekeySummary['failures'], onProgress?: RekeyOptions['onProgress']): Promise<void> {
  const current = ctx.keyring.currentKeyId;
  let done = 0;
  for (const r of await verifierCredentialRows(ctx.db)) {
    if (keyIdOfBase64(r.enc) === current) continue;
    try {
      const aad = verifierCredentialsAad(r.id);
      const next = ctx.keyring.encrypt(ctx.keyring.decrypt(Buffer.from(r.enc, 'base64'), aad), aad).toString('base64');
      // Compare-and-set on the ciphertext that was read (an administrator may have replaced the key meanwhile).
      const updated = await ctx.db
        .update(organizations)
        .set({ settings: sql`jsonb_set(${organizations.settings}, '{externalVerifier,credentialsEnc}', to_jsonb(${next}::text))` })
        .where(and(eq(organizations.id, r.id), sql`${verifierCredentialsSql} = ${r.enc}`))
        .returning({ id: organizations.id });
      if (updated.length) sum.rekeyed++;
      else sum.skipped++;
    } catch (err) {
      sum.failed++;
      failures.push({ target: VERIFIER_CREDENTIALS_TARGET, id: r.id, error: (err as Error).message });
    }
    onProgress?.({ target: VERIFIER_CREDENTIALS_TARGET, done: ++done, total: sum.outdated });
  }
}

/** Re-encrypt (or, with dryRun, count) everything not under the current key. */
export async function rekeyAll(ctx: RekeyCtx, opts: RekeyOptions = {}): Promise<RekeySummary> {
  const started = Date.now();
  const current = ctx.keyring.currentKeyId;
  const batch = Math.max(1, Math.min(5000, opts.batchSize ?? REKEY_DEFAULT_BATCH));
  const only = opts.only?.length ? opts.only : undefined;
  const before = await countByKeyId(ctx.db, only);
  const targets: RekeyTargetSummary[] = [];
  const failures: RekeySummary['failures'] = [];
  for (const name of REKEY_TARGETS) {
    if (only && !only.includes(name)) continue;
    const outdated = Object.entries(before[name] ?? {}).reduce((a, [k, n]) => a + (k === current ? 0 : n), 0);
    const sum: RekeyTargetSummary = { target: name, outdated, rekeyed: 0, skipped: 0, missing: 0, failed: 0 };
    targets.push(sum);
    if (opts.dryRun || outdated === 0) continue;
    if (name === EVIDENCE_TARGET) await rekeyEvidence(ctx, sum, failures, batch, opts.onProgress);
    else if (name === VERIFIER_CREDENTIALS_TARGET) await rekeyVerifierCredentials(ctx, sum, failures, opts.onProgress);
    else await rekeyColumn(ctx, COLUMN_TARGETS.find((t) => t.name === name)!, sum, failures, batch, opts.onProgress);
  }
  const after = opts.dryRun ? before : await countByKeyId(ctx.db, only);
  const summary: RekeySummary = { dryRun: !!opts.dryRun, currentKeyId: current, targets, remaining: remainingFrom(after, current), failures, durationMs: Date.now() - started };
  if (!opts.dryRun) {
    await audit(ctx.db, {
      orgId: null,
      actorType: 'system',
      action: 'keys.rekeyed',
      targetType: 'keyring',
      targetId: current,
      meta: {
        currentKeyId: current,
        targets: Object.fromEntries(targets.map((t) => [t.target, { outdated: t.outdated, rekeyed: t.rekeyed, skipped: t.skipped, missing: t.missing, failed: t.failed }])),
        remaining: summary.remaining,
        failures: failures.length,
      },
      at: ctx.now(),
    });
  }
  return summary;
}

/** rekeyAll() under an advisory lock; null when another re-encryption is running. */
export async function rekeyAllExclusive(ctx: RekeyCtx, opts: RekeyOptions = {}): Promise<RekeySummary | null> {
  const client = await ctx.database.pool.connect();
  let locked = false;
  try {
    const res = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [REKEY_LOCK_KEY]);
    locked = res.rows[0]?.locked === true;
    if (!locked) return null;
    return await rekeyAll(ctx, opts);
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [REKEY_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

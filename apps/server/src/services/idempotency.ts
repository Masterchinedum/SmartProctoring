/**
 * `Idempotency-Key` for the integration API's POST endpoints (docs/INTEGRATION_API.md, "Idempotency").
 *
 * A client may send `Idempotency-Key: <1–255 characters>` so a retry (after a timeout or a dropped connection) cannot
 * apply a request twice. Keys are scoped to the organisation (shared by all its API keys) and kept 24 hours.
 *
 *  1. preHandler `idempotencyGuard` (after authentication and the scope check): without the header nothing happens.
 *     Otherwise it INSERTs (org, key, method, path, request hash) ON CONFLICT DO NOTHING — the unique index is the lock:
 *     the request that inserts owns the key and runs the handler.
 *  2. Any other request with that key finds the row: a row older than 24 h, or one still "in progress" after 60 s (the
 *     server stopped mid-request), is deleted and the insert retried; a different request hash (method, path, query
 *     or canonical JSON body) → 422 idempotency_key_reused; still in progress → 409 idempotency_key_in_use with
 *     Retry-After; completed → the stored status and body are replayed with `Idempotent-Replayed: true`.
 *  3. onSend hook `storeIdempotentResponse` (owner only): a 2xx response is stored, encrypted with the keyring (it can
 *     contain candidates' exam links; AAD `api-idempotency:<id>`, covered by `rekey`); any other status deletes the row,
 *     so a failed request — which changed nothing, every POST runs in one transaction — can be retried with the same key.
 *
 * The `api-idempotency` job (jobs/integrations.ts, hourly) deletes rows older than 24 h; lookups ignore them earlier.
 */
import { IDEMPOTENCY_IN_PROGRESS_TIMEOUT_SEC, IDEMPOTENCY_KEY_PATTERN, IDEMPOTENCY_KEY_TTL_HOURS, IDEMPOTENT_REPLAYED_HEADER } from '@sp/shared';
import { and, eq, lte } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getApiKey } from '../auth/api-key.js';
import type { Ctx } from '../context.js';
import { apiIdempotencyKeys } from '../db/schema.js';
import { sha256Hex } from '../lib/crypto.js';
import { conflict, HttpError } from '../lib/errors.js';

export const IDEMPOTENCY_TTL_MS = IDEMPOTENCY_KEY_TTL_HOURS * 3600_000;
export const IDEMPOTENCY_IN_PROGRESS_TIMEOUT_MS = IDEMPOTENCY_IN_PROGRESS_TIMEOUT_SEC * 1000;
export const IDEMPOTENCY_JOB = 'api-idempotency';
export const IDEMPOTENCY_JOB_INTERVAL_MS = 3600_000;

export const idempotencyResponseAad = (id: string) => `api-idempotency:${id}`;

/** Requests that own their idempotency row (id), until the response is recorded. */
const owners = new WeakMap<FastifyRequest, string>();

/** JSON with object keys sorted at every level, so key order never changes the request hash. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = norm((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value ?? null));
}

export function idempotencyRequestHash(method: string, path: string, query: string, body: unknown): string {
  return sha256Hex(JSON.stringify([method.toUpperCase(), path, query, canonicalJson(body)]));
}

function inUse(reply: FastifyReply): HttpError {
  reply.header('Retry-After', '1');
  return conflict('idempotency_key_in_use', 'A request with this Idempotency-Key is still being processed. Retry in a moment.');
}

/** preHandler for idempotent routes (after requireApiKey / requireScope). */
export async function idempotencyGuard(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  const raw = req.headers['idempotency-key'];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(raw)) {
    throw new HttpError(400, 'invalid_idempotency_key', 'The Idempotency-Key header must be 1–255 characters: letters, digits and - _ . : ~ + / = (a random UUID is ideal).');
  }
  const ctx = req.server.ctx;
  const key = getApiKey(req);
  const q = req.url.indexOf('?');
  const path = q >= 0 ? req.url.slice(0, q) : req.url;
  const hash = idempotencyRequestHash(req.method, path, q >= 0 ? req.url.slice(q + 1) : '', req.body);
  const scoped = and(eq(apiIdempotencyKeys.orgId, key.orgId), eq(apiIdempotencyKeys.key, raw));

  for (let attempt = 0; attempt < 3; attempt++) {
    const now = ctx.now();
    const [mine] = await ctx.db
      .insert(apiIdempotencyKeys)
      .values({ orgId: key.orgId, key: raw, apiKeyId: key.id, method: req.method, path, requestHash: hash, createdAt: new Date(now) })
      .onConflictDoNothing({ target: [apiIdempotencyKeys.orgId, apiIdempotencyKeys.key] })
      .returning({ id: apiIdempotencyKeys.id });
    if (mine) {
      owners.set(req, mine.id);
      return undefined;
    }
    const [row] = await ctx.db.select().from(apiIdempotencyKeys).where(scoped);
    if (!row) continue; // deleted in the meantime: try to take it again
    const age = now - row.createdAt.getTime();
    if (age >= IDEMPOTENCY_TTL_MS || (row.statusCode == null && age >= IDEMPOTENCY_IN_PROGRESS_TIMEOUT_MS)) {
      // Expired, or abandoned mid-request: the key is free again (by id: never a newer row of a concurrent request).
      await ctx.db.delete(apiIdempotencyKeys).where(eq(apiIdempotencyKeys.id, row.id));
      continue;
    }
    if (row.requestHash !== hash) {
      throw new HttpError(
        422,
        'idempotency_key_reused',
        `This Idempotency-Key was already used for a different request (${row.method} ${row.path}, or another body) in the last ${IDEMPOTENCY_KEY_TTL_HOURS} hours. Use a new key for a new request.`,
      );
    }
    if (row.statusCode == null || !row.responseEnc) throw inUse(reply);
    const body = ctx.keyring.decryptString(row.responseEnc, idempotencyResponseAad(row.id));
    req.log.info({ idempotencyRecord: row.id, status: row.statusCode }, 'idempotent request replayed');
    return reply.code(row.statusCode).header(IDEMPOTENT_REPLAYED_HEADER, 'true').type('application/json; charset=utf-8').send(body);
  }
  throw inUse(reply);
}

/** onSend hook for idempotent routes: store a successful response, release the key otherwise. */
export async function storeIdempotentResponse(req: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
  const id = owners.get(req);
  if (!id) return payload;
  owners.delete(req);
  const ctx = req.server.ctx;
  try {
    if (reply.statusCode >= 200 && reply.statusCode < 300 && typeof payload === 'string') {
      await ctx.db
        .update(apiIdempotencyKeys)
        .set({ statusCode: reply.statusCode, responseEnc: ctx.keyring.encryptString(payload, idempotencyResponseAad(id)), completedAt: new Date(ctx.now()) })
        .where(eq(apiIdempotencyKeys.id, id));
    } else {
      await ctx.db.delete(apiIdempotencyKeys).where(eq(apiIdempotencyKeys.id, id));
    }
  } catch (err) {
    // The row stays "in progress" and frees itself after IDEMPOTENCY_IN_PROGRESS_TIMEOUT_MS.
    req.log.warn({ err }, 'could not record the response for its Idempotency-Key');
  }
  return payload;
}

/** Delete records 24 h old or older (hourly job; the same boundary as the lookup). */
export async function purgeIdempotencyKeys(ctx: Pick<Ctx, 'db' | 'now'>): Promise<number> {
  const rows = await ctx.db
    .delete(apiIdempotencyKeys)
    .where(lte(apiIdempotencyKeys.createdAt, new Date(ctx.now() - IDEMPOTENCY_TTL_MS)))
    .returning({ id: apiIdempotencyKeys.id });
  return rows.length;
}

/**
 * Outgoing webhooks: durable outbox + delivery.
 *
 * Enqueue: services/integration-events.ts turns the events touched by a session mutation into
 * notifications and calls enqueueWebhookNotifications() INSIDE the session transaction, so a delivery row
 * exists if and only if the domain change committed. (webhookId, dedupeKey) is unique, so replays of the same
 * change never enqueue twice.
 *
 * Delivery (job 'webhooks', every 5 s under the JobRunner advisory lock, kicked right after commits):
 *  - claims due rows with FOR UPDATE SKIP LOCKED and a lease (next_attempt_at = now + timeout + 60 s), so a
 *    crash mid-send only delays the retry; concurrent senders (job, "test", "redeliver") never double-claim;
 *  - POSTs the JSON envelope with `X-SmartProctoring-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`,
 *    `X-SmartProctoring-Event`, `X-SmartProctoring-Delivery` (idempotency key) and a 10 s timeout, through the
 *    SSRF guard (lib/net-guard.ts);
 *  - 2xx = delivered. Anything else is retried with backoff 30 s, 1 min, 2 min, 5 min, 15 min, 30 min, 1 h, 2 h, 6 h
 *    (10 attempts in total, ~10.5 h), then marked failed. When an endpoint looks down (network error, timeout,
 *    408/429/5xx) the rest of that webhook's batch is deferred instead of hammering it;
 *  - a webhook whose endpoint failed `disableAfterFailures` consecutive attempts over at least
 *    `disableMinFailingMs` (no success in between) is disabled automatically (audit 'webhook.auto_disabled',
 *    UI badge, best-effort email to the alert recipients). Re-enabling resets the counter; pending deliveries
 *    are then sent (deliveries older than 72 h expire).
 * Delivery rows (which contain candidate names) are deleted 30 days after creation.
 */
import { createHmac, randomUUID } from 'node:crypto';
import {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  SEVERITY_RANK,
  type Severity,
  type WebhookDTO,
  type WebhookDeliveryDTO,
  type WebhookDeliveryType,
  type WebhookEnvelope,
  type WebhookEventType,
} from '@sp/shared';
import { and, asc, eq, inArray, lt, lte, ne, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import type { DbOrTx } from '../db/index.js';
import { organizations, webhookDeliveries, webhooks, type Webhook, type WebhookDelivery } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { randomToken } from '../lib/crypto.js';
import { postJson, type PostResult } from '../lib/net-guard.js';
import { orgSettings } from './org.js';

export const WEBHOOK_JOB = 'webhooks';
export const WEBHOOK_SECRET_PREFIX = 'whsec_';
/** Wait after the n-th failed attempt (index n-1). maxAttempts (10) = this list + 1. */
export const WEBHOOK_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000];
export const WEBHOOK_DELIVERY_RETENTION_MS = 30 * 24 * 3600_000;
export const WEBHOOK_PENDING_EXPIRY_MS = 72 * 3600_000;
export const MAX_WEBHOOKS_PER_ORG = 20;
export const DELIVERY_LIST_LIMIT = 100;
const CLAIM_BATCH = 50;
const CONCURRENCY = 4;
const LEASE_EXTRA_MS = 60_000;
const HOUSEKEEPING_INTERVAL_MS = 10 * 60_000;

/* ------------------------------------------------------------------ secrets & signatures */

export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomToken(32)}`;
}

const secretAad = (webhookId: string) => `webhook-secret:${webhookId}`;

export function encryptWebhookSecret(ctx: Pick<Ctx, 'keyring'>, webhookId: string, secret: string): Buffer {
  return ctx.keyring.encryptString(secret, secretAad(webhookId));
}

export function readWebhookSecret(ctx: Pick<Ctx, 'keyring'>, row: Pick<Webhook, 'id' | 'secretEnc'>): string {
  return ctx.keyring.decryptString(row.secretEnc, secretAad(row.id));
}

/** `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>` */
export function signWebhookBody(secret: string, body: string, unixSeconds: number): string {
  const v1 = createHmac('sha256', secret).update(`${unixSeconds}.${body}`).digest('hex');
  return `t=${unixSeconds},v1=${v1}`;
}

export function backoffMs(failedAttempts: number): number {
  return WEBHOOK_BACKOFF_MS[Math.max(0, Math.min(failedAttempts, WEBHOOK_BACKOFF_MS.length) - 1)];
}

/* ------------------------------------------------------------------ DTOs */

export function toWebhookDTO(row: Webhook, pendingDeliveries = 0): WebhookDTO {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    events: row.events,
    minSeverity: row.minSeverity,
    active: row.active,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    lastSuccessAt: row.lastSuccessAt?.getTime() ?? null,
    lastFailureAt: row.lastFailureAt?.getTime() ?? null,
    failureCount: row.failureCount,
    disabledAt: row.disabledAt?.getTime() ?? null,
    disabledReason: row.disabledReason ?? null,
    pendingDeliveries,
  };
}

export function toWebhookDeliveryDTO(row: WebhookDelivery, maxAttempts: number, withPayload = false): WebhookDeliveryDTO {
  return {
    id: row.id,
    webhookId: row.webhookId,
    eventType: row.eventType,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.eventType === 'ping' ? 1 : maxAttempts,
    nextAttemptAt: row.status === 'pending' ? row.nextAttemptAt.getTime() : null,
    lastAttemptAt: row.lastAttemptAt?.getTime() ?? null,
    lastStatusCode: row.lastStatusCode ?? null,
    lastError: row.lastError ?? null,
    createdAt: row.createdAt.getTime(),
    deliveredAt: row.deliveredAt?.getTime() ?? null,
    sessionId: row.sessionId ?? null,
    ...(withPayload ? { payload: row.payload as unknown as WebhookEnvelope } : {}),
  };
}

export async function pendingCounts(db: DbOrTx, webhookIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (webhookIds.length === 0) return out;
  const rows = await db
    .select({ webhookId: webhookDeliveries.webhookId, n: sql<number>`count(*)::int` })
    .from(webhookDeliveries)
    .where(and(inArray(webhookDeliveries.webhookId, webhookIds), eq(webhookDeliveries.status, 'pending')))
    .groupBy(webhookDeliveries.webhookId);
  for (const r of rows) out.set(r.webhookId, r.n);
  return out;
}

/* ------------------------------------------------------------------ enqueue (inside the domain transaction) */

export interface WebhookNotification {
  type: WebhookEventType;
  /** Stable key of the domain change, e.g. `event.created:<eventId>`. */
  dedupeKey: string;
  sessionId: string | null;
  data: Record<string, unknown>;
  /** For event.* notifications: filtered by each webhook's minSeverity. */
  severity?: Severity | null;
}

/** Insert one delivery per (active subscribed webhook, notification). Returns the number of new rows. */
export async function enqueueWebhookNotifications(db: DbOrTx, orgId: string, notifications: WebhookNotification[], now: number, hooks?: Pick<Webhook, 'id' | 'events' | 'minSeverity'>[]): Promise<number> {
  if (notifications.length === 0) return 0;
  const targets =
    hooks ??
    (await db
      .select({ id: webhooks.id, events: webhooks.events, minSeverity: webhooks.minSeverity })
      .from(webhooks)
      .where(and(eq(webhooks.orgId, orgId), eq(webhooks.active, true))));
  const rows: (typeof webhookDeliveries.$inferInsert)[] = [];
  for (const h of targets) {
    for (const n of notifications) {
      if (!h.events.includes(n.type)) continue;
      if (n.severity && SEVERITY_RANK[n.severity] < SEVERITY_RANK[h.minSeverity]) continue;
      const id = randomUUID();
      const envelope: WebhookEnvelope = { id, type: n.type, createdAt: now, orgId, data: n.data };
      rows.push({
        id,
        webhookId: h.id,
        orgId,
        eventType: n.type,
        dedupeKey: n.dedupeKey,
        sessionId: n.sessionId,
        payload: envelope as unknown as Record<string, unknown>,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(now),
        createdAt: new Date(now),
      });
    }
  }
  if (rows.length === 0) return 0;
  const inserted = await db.insert(webhookDeliveries).values(rows).onConflictDoNothing().returning({ id: webhookDeliveries.id });
  return inserted.length;
}

/* ------------------------------------------------------------------ delivery */

export interface DeliveryRunSummary {
  attempted: number;
  succeeded: number;
  failed: number;
  /** Deliveries postponed because their endpoint looked down in this run. */
  deferred: number;
  disabled: number;
}

type AttemptOutcome = PostResult & { transient: boolean; final: boolean; disabled: boolean };

function isTransient(r: PostResult): boolean {
  if (r.ok) return false;
  if (r.statusCode == null) return true; // network error, timeout, blocked
  return r.statusCode === 408 || r.statusCode === 429 || r.statusCode >= 500;
}

/** Claim due deliveries of active webhooks (lease = next_attempt_at pushed into the future). */
async function claimDue(ctx: Ctx, limit: number, onlyIds?: string[]): Promise<WebhookDelivery[]> {
  const now = ctx.now();
  const lease = new Date(now + ctx.config.webhooks.timeoutMs + LEASE_EXTRA_MS);
  return ctx.db.transaction(async (tx) => {
    const conds = onlyIds
      ? [inArray(webhookDeliveries.id, onlyIds), eq(webhookDeliveries.status, 'pending')]
      : [eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextAttemptAt, new Date(now)), eq(webhooks.active, true)];
    const due = await tx
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
      .where(and(...conds))
      .orderBy(asc(webhookDeliveries.nextAttemptAt), asc(webhookDeliveries.createdAt))
      .limit(limit)
      .for('update', { of: webhookDeliveries, skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(webhookDeliveries)
      .set({ nextAttemptAt: lease })
      .where(
        inArray(
          webhookDeliveries.id,
          due.map((d) => d.id),
        ),
      )
      .returning();
  });
}

async function recordAttempt(ctx: Ctx, d: WebhookDelivery, hook: Webhook, r: PostResult): Promise<AttemptOutcome> {
  const cfg = ctx.config.webhooks;
  const now = ctx.now();
  const attempts = d.attempts + 1;
  const isPing = d.eventType === 'ping';
  const max = isPing ? 1 : cfg.maxAttempts;
  const transient = isTransient(r);
  const lastError = r.error ? r.error.slice(0, 500) : null;
  if (r.ok) {
    await ctx.db
      .update(webhookDeliveries)
      .set({ status: 'succeeded', attempts, lastAttemptAt: new Date(now), lastStatusCode: r.statusCode, lastError: null, deliveredAt: new Date(now), nextAttemptAt: new Date(now) })
      .where(eq(webhookDeliveries.id, d.id));
    if (!isPing) await ctx.db.update(webhooks).set({ lastSuccessAt: new Date(now), failureCount: 0, failingSince: null }).where(eq(webhooks.id, hook.id));
    return { ...r, transient: false, final: true, disabled: false };
  }
  const final = attempts >= max;
  await ctx.db
    .update(webhookDeliveries)
    .set({
      status: final ? 'failed' : 'pending',
      attempts,
      lastAttemptAt: new Date(now),
      lastStatusCode: r.statusCode,
      lastError,
      nextAttemptAt: new Date(final ? now : now + backoffMs(attempts)),
    })
    .where(eq(webhookDeliveries.id, d.id));
  if (isPing) return { ...r, transient, final, disabled: false };
  const [h] = await ctx.db
    .update(webhooks)
    .set({ lastFailureAt: new Date(now), failureCount: sql`${webhooks.failureCount} + 1`, failingSince: sql`coalesce(${webhooks.failingSince}, ${new Date(now)}::timestamptz)` })
    .where(eq(webhooks.id, hook.id))
    .returning();
  let disabled = false;
  if (h && h.active && h.failureCount >= cfg.disableAfterFailures && h.failingSince && now - h.failingSince.getTime() >= cfg.disableMinFailingMs) {
    disabled = await autoDisable(ctx, h, lastError);
  }
  return { ...r, transient, final, disabled };
}

async function autoDisable(ctx: Ctx, h: Webhook, lastError: string | null): Promise<boolean> {
  const now = ctx.now();
  const [row] = await ctx.db
    .update(webhooks)
    .set({ active: false, disabledAt: new Date(now), disabledReason: 'failures', updatedAt: new Date(now) })
    .where(and(eq(webhooks.id, h.id), eq(webhooks.active, true)))
    .returning();
  if (!row) return false;
  const host = safeHost(h.url);
  await audit(ctx.db, {
    orgId: h.orgId,
    actorType: 'system',
    action: 'webhook.auto_disabled',
    targetType: 'webhook',
    targetId: h.id,
    meta: { host, failureCount: h.failureCount, failingSince: h.failingSince?.getTime() ?? null, lastError },
    at: now,
  });
  ctx.log.warn({ webhookId: h.id, host, failureCount: h.failureCount }, 'webhook disabled after repeated delivery failures');
  void notifyDisabledByEmail(ctx, h, host, lastError);
  return true;
}

/** Best effort: tell the alert recipients that a webhook was switched off (no queue, no retry). */
async function notifyDisabledByEmail(ctx: Ctx, h: Webhook, host: string, lastError: string | null): Promise<void> {
  if (!ctx.mailer) return;
  try {
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, h.orgId));
    const recipients = orgSettings(org).alertRecipients;
    if (!org || recipients.length === 0) return;
    const url = `${ctx.config.publicUrl}/admin/integrations`;
    await ctx.mailer.send({
      to: recipients,
      subject: `[SmartProctoring] Webhook to ${host} was disabled after repeated failures`,
      text:
        `SmartProctoring (${org.name}) stopped sending notifications to the webhook at ${host} because ${h.failureCount} delivery attempts in a row failed.\n` +
        `${lastError ? `Last error: ${lastError}\n` : ''}\nNotifications that could not be delivered are kept for 72 hours. Fix the receiving endpoint, then re-enable the webhook:\n${url}\n`,
    });
  } catch (err) {
    ctx.log.warn({ err }, 'could not email the webhook-disabled notice');
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid URL';
  }
}

/** Send one claimed delivery and record the outcome. */
async function attempt(ctx: Ctx, d: WebhookDelivery, hook: Webhook): Promise<AttemptOutcome> {
  const cfg = ctx.config.webhooks;
  let result: PostResult;
  let target: URL | null = null;
  try {
    target = new URL(hook.url);
  } catch {
    target = null;
  }
  if (!target) {
    result = { ok: false, statusCode: null, error: 'The webhook URL is invalid', durationMs: 0 };
  } else if (cfg.requireHttps && target.protocol !== 'https:') {
    result = { ok: false, statusCode: null, error: 'Only https:// webhook URLs are allowed', durationMs: 0 };
  } else {
    let secret: string | null = null;
    try {
      secret = readWebhookSecret(ctx, hook);
    } catch {
      secret = null;
    }
    if (!secret) {
      result = { ok: false, statusCode: null, error: 'The signing secret could not be decrypted (was EVIDENCE_KEY changed?). Rotate the secret.', durationMs: 0 };
    } else {
      const body = JSON.stringify(d.payload);
      const t = Math.floor(ctx.now() / 1000);
      result = await postJson(
        target,
        body,
        {
          'Content-Type': 'application/json; charset=utf-8',
          'User-Agent': 'SmartProctoring-Webhooks/1.0',
          [WEBHOOK_EVENT_HEADER]: d.eventType,
          [WEBHOOK_DELIVERY_HEADER]: d.id,
          'X-SmartProctoring-Attempt': String(d.attempts + 1),
          [WEBHOOK_SIGNATURE_HEADER]: signWebhookBody(secret, body, t),
        },
        { timeoutMs: cfg.timeoutMs, allowPrivateNetworks: cfg.allowPrivateNetworks },
      );
    }
  }
  return recordAttempt(ctx, d, hook, result);
}

async function processClaimed(ctx: Ctx, claimed: WebhookDelivery[], sum: DeliveryRunSummary): Promise<void> {
  const byHook = new Map<string, WebhookDelivery[]>();
  for (const d of claimed) byHook.set(d.webhookId, [...(byHook.get(d.webhookId) ?? []), d]);
  const hookRows = await ctx.db.select().from(webhooks).where(inArray(webhooks.id, [...byHook.keys()]));
  const hooks = new Map(hookRows.map((h) => [h.id, h]));
  const queue = [...byHook.entries()];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [hookId, list] = next;
      const hook = hooks.get(hookId);
      // New deliveries first, then retries (a single failing payload must not block the others).
      list.sort((a, b) => a.attempts - b.attempts || a.createdAt.getTime() - b.createdAt.getTime());
      for (let i = 0; i < list.length; i++) {
        if (!hook || !hook.active) {
          await release(ctx, list.slice(i), 0);
          break;
        }
        const out = await attempt(ctx, list[i], hook);
        sum.attempted++;
        if (out.ok) sum.succeeded++;
        else if (out.final) sum.failed++;
        if (out.disabled) {
          sum.disabled++;
          hook.active = false;
        }
        if (!out.ok && out.transient && i + 1 < list.length) {
          // The endpoint looks down: postpone the rest of its batch without counting attempts.
          await release(ctx, list.slice(i + 1), WEBHOOK_BACKOFF_MS[0]);
          sum.deferred += list.length - i - 1;
          break;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
}

async function release(ctx: Ctx, list: WebhookDelivery[], delayMs: number): Promise<void> {
  if (list.length === 0) return;
  await ctx.db
    .update(webhookDeliveries)
    .set({ nextAttemptAt: new Date(ctx.now() + delayMs) })
    .where(
      and(
        inArray(
          webhookDeliveries.id,
          list.map((d) => d.id),
        ),
        eq(webhookDeliveries.status, 'pending'),
      ),
    );
}

const runState = new WeakMap<object, { rerun: boolean; timer: NodeJS.Timeout | null; lastHousekeeping: number }>();
function stateFor(ctx: Ctx) {
  let st = runState.get(ctx);
  if (!st) {
    st = { rerun: false, timer: null, lastHousekeeping: 0 };
    runState.set(ctx, st);
  }
  return st;
}

/** One delivery run (the 'webhooks' job; tests call it directly). */
export async function deliverDueWebhooks(ctx: Ctx, opts: { budgetMs?: number } = {}): Promise<DeliveryRunSummary> {
  const sum: DeliveryRunSummary = { attempted: 0, succeeded: 0, failed: 0, deferred: 0, disabled: 0 };
  const st = stateFor(ctx);
  const until = Date.now() + (opts.budgetMs ?? 30_000);
  for (;;) {
    st.rerun = false;
    const claimed = await claimDue(ctx, CLAIM_BATCH);
    if (claimed.length) await processClaimed(ctx, claimed, sum);
    if ((claimed.length < CLAIM_BATCH && !st.rerun) || Date.now() >= until) break;
  }
  if (Date.now() - st.lastHousekeeping >= HOUSEKEEPING_INTERVAL_MS) {
    st.lastHousekeeping = Date.now();
    await webhookHousekeeping(ctx);
  }
  return sum;
}

/** Expire deliveries stuck pending for 72 h (inactive webhook) and delete delivery records after 30 days. */
export async function webhookHousekeeping(ctx: Pick<Ctx, 'db' | 'now'>): Promise<{ expired: number; deleted: number }> {
  const now = ctx.now();
  const expired = await ctx.db
    .update(webhookDeliveries)
    .set({ status: 'failed', lastError: 'Not delivered within 72 hours (the webhook was disabled or its endpoint was unreachable).', nextAttemptAt: new Date(now) })
    .where(and(eq(webhookDeliveries.status, 'pending'), lt(webhookDeliveries.createdAt, new Date(now - WEBHOOK_PENDING_EXPIRY_MS))))
    .returning({ id: webhookDeliveries.id });
  const deleted = await ctx.db
    .delete(webhookDeliveries)
    .where(and(ne(webhookDeliveries.status, 'pending'), lt(webhookDeliveries.createdAt, new Date(now - WEBHOOK_DELIVERY_RETENTION_MS))))
    .returning({ id: webhookDeliveries.id });
  return { expired: expired.length, deleted: deleted.length };
}

/**
 * Attempt one delivery right now (staff "test" and "redeliver"). The delivery is claimed like the job does,
 * so it is never sent twice concurrently. Returns the fresh row (null if another sender holds it).
 */
export async function deliverNow(ctx: Ctx, deliveryId: string): Promise<WebhookDelivery | null> {
  const [d] = await claimDue(ctx, 1, [deliveryId]);
  if (!d) return null;
  const [hook] = await ctx.db.select().from(webhooks).where(eq(webhooks.id, d.webhookId));
  if (!hook) return null;
  await attempt(ctx, d, hook);
  const [fresh] = await ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId));
  return fresh ?? null;
}

/** Create a 'ping' delivery for a webhook (sent immediately by the caller via deliverNow). */
export async function createPingDelivery(ctx: Ctx, hook: Webhook, sentBy: { id: string; name: string }): Promise<string> {
  const now = ctx.now();
  const id = randomUUID();
  const envelope: WebhookEnvelope = {
    id,
    type: 'ping',
    createdAt: now,
    orgId: hook.orgId,
    data: { webhookId: hook.id, message: 'Test notification from SmartProctoring. No action is required.', sentBy: sentBy.name },
  };
  await ctx.db.insert(webhookDeliveries).values({
    id,
    webhookId: hook.id,
    orgId: hook.orgId,
    eventType: 'ping' satisfies WebhookDeliveryType,
    dedupeKey: `ping:${id}`,
    sessionId: null,
    payload: envelope as unknown as Record<string, unknown>,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: new Date(now),
    createdAt: new Date(now),
  });
  return id;
}

/* ------------------------------------------------------------------ kick after commit */

/** Ask the delivery job to run soon (no-op when background jobs are not running, e.g. in tests). */
export function kickWebhookDelivery(ctx: Ctx): void {
  if (!ctx.jobs?.isStarted || !ctx.jobs.list().includes(WEBHOOK_JOB)) return;
  const st = stateFor(ctx);
  st.rerun = true;
  if (st.timer) return;
  st.timer = setTimeout(() => {
    st.timer = null;
    void ctx.jobs.runNow(WEBHOOK_JOB).catch((err) => ctx.log.warn({ err }, 'webhook kick failed'));
  }, 25);
  st.timer.unref?.();
}

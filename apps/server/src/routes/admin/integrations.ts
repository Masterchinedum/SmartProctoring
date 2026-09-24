/**
 * Staff API — integrations: API keys, webhooks, email-alert test, integration status. All [admin].
 *
 *   GET  /integrations/status                   -> IntegrationStatusDTO
 *   GET  /api-keys                              -> { items: ApiKeyDTO[] }   (newest first, revoked included)
 *   POST /api-keys {name}                       -> CreatedApiKeyDTO          (the key is returned ONCE)
 *   POST /api-keys/:id/revoke                   -> ApiKeyDTO
 *   GET  /webhooks                              -> { items: WebhookDTO[] }
 *   POST /webhooks  WebhookInput                -> CreatedWebhookDTO         (the signing secret is returned ONCE)
 *   GET  /webhooks/:id                          -> WebhookDTO
 *   PUT  /webhooks/:id  WebhookUpdate           -> WebhookDTO   (active=true re-enables and resets the failure count)
 *   DELETE /webhooks/:id                        -> { ok: true }
 *   POST /webhooks/:id/rotate-secret            -> CreatedWebhookDTO
 *   POST /webhooks/:id/test                     -> WebhookDeliveryDTO        (a 'ping', sent immediately, not retried)
 *   GET  /webhooks/:id/deliveries               -> { items: WebhookDeliveryDTO[] }  (latest 100, without payloads)
 *   GET  /webhooks/deliveries/:id               -> WebhookDeliveryDTO (with payload)
 *   POST /webhooks/deliveries/:id/redeliver     -> WebhookDeliveryDTO        (same delivery id; attempted now, then normal retries)
 *   POST /email-alerts/test {to?}               -> { ok: true, recipients }  (409 smtp_not_configured, 502 email_failed)
 *
 * Every create / revoke / update / delete / rotate / redeliver is audit-logged. Secrets never appear in logs,
 * audit entries or later responses; the audit log records the webhook host, not the full URL.
 */
import {
  apiKeyCreateSchema,
  emailTestSchema,
  webhookInputSchema,
  webhookUpdateSchema,
  type ApiKeyDTO,
  type CreatedApiKeyDTO,
  type CreatedWebhookDTO,
  type IntegrationStatusDTO,
  type WebhookDTO,
  type WebhookDeliveryDTO,
} from '@sp/shared';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { generateApiKey, toApiKeyDTO } from '../../auth/api-key.js';
import { getStaff, requireStaff } from '../../auth/staff.js';
import type { DbOrTx } from '../../db/index.js';
import { apiKeys, staffUsers, webhookDeliveries, webhooks, type Webhook } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { conflict, HttpError, notFound, validationFailed } from '../../lib/errors.js';
import { validateWebhookUrl, WebhookUrlError } from '../../lib/net-guard.js';
import { composeTestEmail } from '../../services/email-alerts.js';
import { orgSettings } from '../../services/org.js';
import {
  createPingDelivery,
  deliverNow,
  DELIVERY_LIST_LIMIT,
  encryptWebhookSecret,
  generateWebhookSecret,
  MAX_WEBHOOKS_PER_ORG,
  pendingCounts,
  toWebhookDeliveryDTO,
  toWebhookDTO,
} from '../../services/webhooks.js';
import { idParam, loadOrgRow, noStore } from './common.js';

export const MAX_ACTIVE_API_KEYS_PER_ORG = 25;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

async function loadScopedWebhook(db: DbOrTx, orgId: string, id: string, lock = false): Promise<Webhook> {
  const q = db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.id, id), eq(webhooks.orgId, orgId)));
  const [row] = lock ? await q.for('update') : await q;
  if (!row) throw notFound('Webhook not found', 'webhook_not_found');
  return row;
}

async function webhookDTO(db: DbOrTx, row: Webhook): Promise<WebhookDTO> {
  const counts = await pendingCounts(db, [row.id]);
  return toWebhookDTO(row, counts.get(row.id) ?? 0);
}

export const integrationRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const admin = { preHandler: requireStaff('admin') };
  const cfg = ctx.config.webhooks;

  async function checkedUrl(raw: string): Promise<string> {
    try {
      return (await validateWebhookUrl(raw, { requireHttps: cfg.requireHttps, allowPrivateNetworks: cfg.allowPrivateNetworks })).toString();
    } catch (err) {
      if (err instanceof WebhookUrlError) throw new HttpError(400, 'invalid_webhook_url', err.message, [{ path: 'url', message: err.message, reason: err.code }]);
      throw err;
    }
  }

  /* ------------------------------------------------------------------ status */

  app.get('/integrations/status', admin, async (): Promise<IntegrationStatusDTO> => ({
    apiBaseUrl: `${ctx.config.publicUrl}/api/v1`,
    email: { available: !!ctx.mailer, from: ctx.mailer?.from ?? null },
    webhooks: {
      httpsRequired: cfg.requireHttps,
      privateNetworksAllowed: cfg.allowPrivateNetworks,
      maxAttempts: cfg.maxAttempts,
      timeoutMs: cfg.timeoutMs,
      disableAfterFailures: cfg.disableAfterFailures,
    },
  }));

  /* ------------------------------------------------------------------ API keys */

  app.get('/api-keys', admin, async (req): Promise<{ items: ApiKeyDTO[] }> => {
    const staff = getStaff(req);
    const rows = await ctx.db
      .select({ key: apiKeys, creatorName: staffUsers.name })
      .from(apiKeys)
      .leftJoin(staffUsers, eq(staffUsers.id, apiKeys.createdBy))
      .where(eq(apiKeys.orgId, staff.orgId))
      .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
    return { items: rows.map((r) => toApiKeyDTO(r.key, r.creatorName)) };
  });

  app.post('/api-keys', admin, async (req, reply): Promise<CreatedApiKeyDTO> => {
    const staff = getStaff(req);
    const body = apiKeyCreateSchema.parse(req.body ?? {});
    const now = ctx.now();
    const { key, prefix, hash } = generateApiKey();
    const row = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`api-keys:${staff.orgId}`}))`);
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(apiKeys)
        .where(and(eq(apiKeys.orgId, staff.orgId), isNull(apiKeys.revokedAt)));
      if (n >= MAX_ACTIVE_API_KEYS_PER_ORG) throw conflict('too_many_api_keys', `An organisation can have at most ${MAX_ACTIVE_API_KEYS_PER_ORG} active API keys. Revoke unused keys first.`);
      const [k] = await tx
        .insert(apiKeys)
        .values({ orgId: staff.orgId, name: body.name, prefix, keyHash: hash, scope: 'integration', createdBy: staff.id, createdAt: new Date(now) })
        .returning();
      await audit(tx, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'api_key.created', targetType: 'api_key', targetId: k.id, meta: { name: k.name, prefix }, ip: req.ip, at: now });
      return k;
    });
    noStore(reply);
    return { apiKey: toApiKeyDTO(row, staff.name), secret: key };
  });

  app.post('/api-keys/:id/revoke', admin, async (req): Promise<ApiKeyDTO> => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'API key', 'api_key_not_found');
    const now = ctx.now();
    const row = await ctx.db.transaction(async (tx) => {
      const [k] = await tx
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.id, id), eq(apiKeys.orgId, staff.orgId)))
        .for('update');
      if (!k) throw notFound('API key not found', 'api_key_not_found');
      if (k.revokedAt) return k;
      const [u] = await tx
        .update(apiKeys)
        .set({ revokedAt: new Date(now), revokedBy: staff.id })
        .where(eq(apiKeys.id, id))
        .returning();
      await audit(tx, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'api_key.revoked', targetType: 'api_key', targetId: id, meta: { name: k.name, prefix: k.prefix }, ip: req.ip, at: now });
      return u;
    });
    const [creator] = row.createdBy ? await ctx.db.select({ name: staffUsers.name }).from(staffUsers).where(eq(staffUsers.id, row.createdBy)) : [];
    return toApiKeyDTO(row, creator?.name ?? null);
  });

  /* ------------------------------------------------------------------ webhooks */

  app.get('/webhooks', admin, async (req): Promise<{ items: WebhookDTO[] }> => {
    const staff = getStaff(req);
    const rows = await ctx.db.select().from(webhooks).where(eq(webhooks.orgId, staff.orgId)).orderBy(webhooks.createdAt, webhooks.id);
    const counts = await pendingCounts(
      ctx.db,
      rows.map((r) => r.id),
    );
    return { items: rows.map((r) => toWebhookDTO(r, counts.get(r.id) ?? 0)) };
  });

  app.post('/webhooks', admin, async (req, reply): Promise<CreatedWebhookDTO> => {
    const staff = getStaff(req);
    const body = webhookInputSchema.parse(req.body ?? {});
    const url = await checkedUrl(body.url);
    const now = ctx.now();
    const secret = generateWebhookSecret();
    const row = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`webhooks:${staff.orgId}`}))`);
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(webhooks).where(eq(webhooks.orgId, staff.orgId));
      if (n >= MAX_WEBHOOKS_PER_ORG) throw conflict('too_many_webhooks', `An organisation can have at most ${MAX_WEBHOOKS_PER_ORG} webhooks.`);
      const id = crypto.randomUUID();
      const [w] = await tx
        .insert(webhooks)
        .values({
          id,
          orgId: staff.orgId,
          url,
          description: body.description,
          secretEnc: encryptWebhookSecret(ctx, id, secret),
          events: [...new Set(body.events)],
          minSeverity: body.minSeverity,
          active: body.active,
          disabledAt: body.active ? null : new Date(now),
          disabledReason: body.active ? null : 'staff',
          createdBy: staff.id,
          createdAt: new Date(now),
          updatedAt: new Date(now),
        })
        .returning();
      await audit(tx, {
        orgId: staff.orgId,
        actorType: 'staff',
        actorId: staff.id,
        action: 'webhook.created',
        targetType: 'webhook',
        targetId: w.id,
        meta: { host: hostOf(url), events: w.events, minSeverity: w.minSeverity, active: w.active },
        ip: req.ip,
        at: now,
      });
      return w;
    });
    noStore(reply);
    return { webhook: toWebhookDTO(row, 0), secret };
  });

  app.get('/webhooks/:id', admin, async (req) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Webhook', 'webhook_not_found');
    return webhookDTO(ctx.db, await loadScopedWebhook(ctx.db, staff.orgId, id));
  });

  app.put('/webhooks/:id', admin, async (req) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Webhook', 'webhook_not_found');
    const body = webhookUpdateSchema.parse(req.body ?? {});
    const url = body.url !== undefined ? await checkedUrl(body.url) : undefined;
    const now = ctx.now();
    const row = await ctx.db.transaction(async (tx) => {
      const cur = await loadScopedWebhook(tx, staff.orgId, id, true);
      const patch: Partial<typeof webhooks.$inferInsert> = {};
      const changed: string[] = [];
      if (url !== undefined && url !== cur.url) {
        patch.url = url;
        changed.push('url');
      }
      if (body.description !== undefined && body.description !== cur.description) {
        patch.description = body.description;
        changed.push('description');
      }
      if (body.events !== undefined) {
        const evs = [...new Set(body.events)];
        if (JSON.stringify([...evs].sort()) !== JSON.stringify([...cur.events].sort())) {
          patch.events = evs;
          changed.push('events');
        }
      }
      if (body.minSeverity !== undefined && body.minSeverity !== cur.minSeverity) {
        patch.minSeverity = body.minSeverity;
        changed.push('minSeverity');
      }
      if (body.active === true && !cur.active) {
        Object.assign(patch, { active: true, disabledAt: null, disabledReason: null, failureCount: 0, failingSince: null });
        changed.push('active');
      } else if (body.active === false && cur.active) {
        Object.assign(patch, { active: false, disabledAt: new Date(now), disabledReason: 'staff' as const });
        changed.push('active');
      }
      if (changed.length === 0) return cur;
      const [u] = await tx
        .update(webhooks)
        .set({ ...patch, updatedAt: new Date(now) })
        .where(eq(webhooks.id, id))
        .returning();
      if (patch.active === true) {
        // Re-enabled: notifications that waited while it was off are sent on the next run.
        await tx
          .update(webhookDeliveries)
          .set({ nextAttemptAt: new Date(now) })
          .where(and(eq(webhookDeliveries.webhookId, id), eq(webhookDeliveries.status, 'pending')));
      }
      await audit(tx, {
        orgId: staff.orgId,
        actorType: 'staff',
        actorId: staff.id,
        action: 'webhook.updated',
        targetType: 'webhook',
        targetId: id,
        meta: { fields: changed, host: hostOf(u.url), ...(changed.includes('active') ? { active: u.active } : {}) },
        ip: req.ip,
        at: now,
      });
      return u;
    });
    return webhookDTO(ctx.db, row);
  });

  app.delete('/webhooks/:id', admin, async (req) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Webhook', 'webhook_not_found');
    const now = ctx.now();
    await ctx.db.transaction(async (tx) => {
      const cur = await loadScopedWebhook(tx, staff.orgId, id, true);
      await tx.delete(webhooks).where(eq(webhooks.id, id));
      await audit(tx, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'webhook.deleted', targetType: 'webhook', targetId: id, meta: { host: hostOf(cur.url) }, ip: req.ip, at: now });
    });
    return { ok: true };
  });

  app.post('/webhooks/:id/rotate-secret', admin, async (req, reply): Promise<CreatedWebhookDTO> => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Webhook', 'webhook_not_found');
    const now = ctx.now();
    const secret = generateWebhookSecret();
    const row = await ctx.db.transaction(async (tx) => {
      await loadScopedWebhook(tx, staff.orgId, id, true);
      const [u] = await tx
        .update(webhooks)
        .set({ secretEnc: encryptWebhookSecret(ctx, id, secret), updatedAt: new Date(now) })
        .where(eq(webhooks.id, id))
        .returning();
      await audit(tx, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'webhook.secret_rotated', targetType: 'webhook', targetId: id, meta: { host: hostOf(u.url) }, ip: req.ip, at: now });
      return u;
    });
    noStore(reply);
    return { webhook: await webhookDTO(ctx.db, row), secret };
  });

  app.post('/webhooks/:id/test', { ...admin, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req): Promise<WebhookDeliveryDTO> => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Webhook', 'webhook_not_found');
    const hook = await loadScopedWebhook(ctx.db, staff.orgId, id);
    const deliveryId = await createPingDelivery(ctx, hook, { id: staff.id, name: staff.name });
    const d = await deliverNow(ctx, deliveryId);
    const [row] = d ? [d] : await ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId));
    return toWebhookDeliveryDTO(row, cfg.maxAttempts);
  });

  app.get('/webhooks/:id/deliveries', admin, async (req): Promise<{ items: WebhookDeliveryDTO[] }> => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Webhook', 'webhook_not_found');
    await loadScopedWebhook(ctx.db, staff.orgId, id);
    const rows = await ctx.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, id))
      .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
      .limit(DELIVERY_LIST_LIMIT);
    return { items: rows.map((r) => toWebhookDeliveryDTO(r, cfg.maxAttempts)) };
  });

  async function loadScopedDelivery(orgId: string, id: string) {
    const [row] = await ctx.db
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.orgId, orgId)));
    if (!row) throw notFound('Delivery not found', 'delivery_not_found');
    return row;
  }

  app.get('/webhooks/deliveries/:id', admin, async (req, reply): Promise<WebhookDeliveryDTO> => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Delivery', 'delivery_not_found');
    noStore(reply);
    return toWebhookDeliveryDTO(await loadScopedDelivery(staff.orgId, id), cfg.maxAttempts, true);
  });

  app.post('/webhooks/deliveries/:id/redeliver', { ...admin, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req): Promise<WebhookDeliveryDTO> => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Delivery', 'delivery_not_found');
    const cur = await loadScopedDelivery(staff.orgId, id);
    if (cur.eventType === 'ping') throw conflict('ping_not_redeliverable', 'Test pings are not redelivered; send a new test instead.');
    const now = ctx.now();
    await ctx.db.transaction(async (tx) => {
      // Same delivery id (the receiver's idempotency key); the retry budget starts again.
      await tx
        .update(webhookDeliveries)
        .set({ status: 'pending', attempts: 0, nextAttemptAt: new Date(now), deliveredAt: null })
        .where(eq(webhookDeliveries.id, id));
      await audit(tx, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'webhook.redelivered', targetType: 'webhook_delivery', targetId: id, meta: { webhookId: cur.webhookId, eventType: cur.eventType, previousStatus: cur.status }, ip: req.ip, at: now });
    });
    const d = (await deliverNow(ctx, id)) ?? (await loadScopedDelivery(staff.orgId, id));
    return toWebhookDeliveryDTO(d, cfg.maxAttempts);
  });

  /* ------------------------------------------------------------------ email */

  app.post('/email-alerts/test', { ...admin, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const staff = getStaff(req);
    const body = emailTestSchema.parse(req.body ?? {});
    if (!ctx.mailer) throw conflict('smtp_not_configured', 'Email is not configured on this server (SMTP_HOST, SMTP_FROM ...). Ask your system administrator.');
    const org = await loadOrgRow(ctx, staff.orgId);
    const recipients = body.to ? [body.to.toLowerCase()] : orgSettings(org).alertRecipients;
    if (recipients.length === 0) throw validationFailed('No recipients', [{ path: 'to', message: 'Add alert recipients (or give an address) first' }]);
    try {
      await ctx.mailer.send(composeTestEmail(org.name, ctx.config.publicUrl, recipients, staff.name));
    } catch (err) {
      req.log.warn({ err }, 'test email failed');
      throw new HttpError(502, 'email_failed', `The email server did not accept the message: ${((err as Error)?.message ?? 'unknown error').slice(0, 300)}`);
    }
    await audit(ctx.db, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'email.test_sent', targetType: 'organization', targetId: staff.orgId, meta: { recipients: recipients.length }, ip: req.ip, at: ctx.now() });
    return { ok: true, recipients };
  });
};

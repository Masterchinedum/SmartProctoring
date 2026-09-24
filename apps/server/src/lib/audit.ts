import type { DbOrTx } from '../db/index.js';
import { auditLog } from '../db/schema.js';

export interface AuditEntry {
  orgId: string | null;
  /** 'api_key': an organisation API key on the integration API (actorId = api_keys.id). */
  actorType: 'staff' | 'candidate' | 'system' | 'api_key';
  actorId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  meta?: Record<string, unknown>;
  ip?: string | null;
  /** Epoch ms; pass ctx.now(). */
  at: number;
}

/**
 * Append an audit record. Actions use dotted names, e.g. `evidence.view`, `session.hold`,
 * `reference.re_enrolled`, `auth.login`, `auth.login_failed`.
 */
export async function audit(db: DbOrTx, e: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    orgId: e.orgId,
    at: new Date(e.at),
    actorType: e.actorType,
    actorId: e.actorId ?? null,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId ?? null,
    meta: e.meta ?? {},
    ip: e.ip ?? null,
  });
}

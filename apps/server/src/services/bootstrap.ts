import { sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { staffUsers } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { hashPassword } from '../lib/crypto.js';
import { createOrganization } from './org.js';

/** On first start: if no staff user exists and BOOTSTRAP_ADMIN_* is set, create the organisation and its owner. */
export async function bootstrapAdmin(ctx: Ctx): Promise<void> {
  const { email, password, orgName } = ctx.config.bootstrap;
  const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(staffUsers);
  if (n > 0) return;
  if (!email || !password) {
    ctx.log.warn('No staff users exist. Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD (or run the seed script) to create the first owner.');
    return;
  }
  if (password.length < 10) throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 10 characters');
  await ctx.db.transaction(async (tx) => {
    // Serialise concurrent bootstraps from several instances.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(727274002)`);
    const [{ n: again }] = await tx.select({ n: sql<number>`count(*)::int` }).from(staffUsers);
    if (again > 0) return;
    const now = ctx.now();
    const org = await createOrganization(tx, orgName, {}, now);
    const [user] = await tx
      .insert(staffUsers)
      .values({ orgId: org.id, email: email.trim().toLowerCase(), name: 'Owner', role: 'owner', passwordHash: await hashPassword(password), createdAt: new Date(now), updatedAt: new Date(now) })
      .returning();
    await audit(tx, { orgId: org.id, actorType: 'system', action: 'bootstrap.owner_created', targetType: 'staff_user', targetId: user.id, meta: { email: user.email }, at: now });
    ctx.log.info(`Bootstrap: created organisation "${orgName}" and owner ${user.email}`);
  });
}

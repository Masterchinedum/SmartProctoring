/**
 * Data residency: which storage locations are in use, and what an organisation sees about them.
 *
 *  - assertStorageLocationsConfigured(): at start-up, every location an organisation has chosen for new evidence, and
 *    every location still holding evidence that is not deleted, must be configured — otherwise images would be written
 *    to (or looked for in) the wrong place. The server refuses to start and says what to do.
 *  - evidenceStorageSummary(): the configured locations (names, labels, regions — never buckets, directories or
 *    credentials), the organisation's choice and how many of its images each location holds (GET /evidence-storage).
 *
 * Moving existing blobs between locations: services/storage-move.ts (`storage:move`).
 */
import type { EvidenceStorageDTO } from '@sp/shared';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import type { Db, DbOrTx } from '../db/index.js';
import { evidence, organizations } from '../db/schema.js';
import { locationName } from '../lib/storage.js';
import { orgSettings } from './org.js';

export class StorageLocationsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageLocationsConfigError';
  }
}

/**
 * Distinct storage locations (stored values, i.e. not `default`) holding evidence that is not deleted. A loose index
 * scan over evidence_location_idx: one index probe per location, whatever the number of rows.
 */
export async function evidenceLocationsInUse(db: DbOrTx): Promise<string[]> {
  const res = await db.execute<{ loc: string }>(sql`
    WITH RECURSIVE l(loc) AS (
      (SELECT storage_location FROM evidence WHERE storage_location IS NOT NULL AND purged_at IS NULL ORDER BY storage_location LIMIT 1)
      UNION ALL
      SELECT (SELECT e.storage_location FROM evidence e WHERE e.storage_location > l.loc AND e.storage_location IS NOT NULL AND e.purged_at IS NULL ORDER BY e.storage_location LIMIT 1)
      FROM l WHERE l.loc IS NOT NULL
    )
    SELECT loc FROM l WHERE loc IS NOT NULL`);
  return res.rows.map((r) => r.loc);
}

const evidenceLocationSetting = sql<string | null>`${organizations.settings}->>'evidenceLocation'`;

/** Refuse to start when a location in use is not configured (data would go to, or be looked for in, the wrong place). */
export async function assertStorageLocationsConfigured(db: Db, configured: string[]): Promise<void> {
  const known = new Set(configured);
  const problems: string[] = [];
  const chosen = await db
    .select({ id: organizations.id, name: organizations.name, location: evidenceLocationSetting })
    .from(organizations)
    .where(sql`${evidenceLocationSetting} IS NOT NULL`);
  for (const o of chosen) {
    const loc = locationName(o.location);
    if (!known.has(loc)) problems.push(`organisation "${o.name}" (${o.id}) stores its new evidence images in "${loc}"`);
  }
  for (const loc of await evidenceLocationsInUse(db)) {
    if (known.has(loc)) continue;
    const byOrg = await db
      .select({ orgId: evidence.orgId, n: count() })
      .from(evidence)
      .where(and(eq(evidence.storageLocation, loc), isNull(evidence.purgedAt)))
      .groupBy(evidence.orgId)
      .orderBy(sql`2 desc`)
      .limit(5);
    problems.push(`evidence images are stored in "${loc}" (${byOrg.map((r) => `organisation ${r.orgId}: ${r.n}`).join(', ')}${byOrg.length === 5 ? ', …' : ''})`);
  }
  if (problems.length) {
    throw new StorageLocationsConfigError(
      `Evidence storage location(s) in use but not configured: ${problems.join('; ')}. ` +
        'Configure them again (STORAGE_LOCATIONS and STORAGE_LOCATION_<NAME>_*, docs/OPERATIONS.md §2). To retire a location, ' +
        'first have each organisation choose another one (Settings), move its evidence with storage:move, and only then remove it.',
    );
  }
}

/** Images (not deleted) of an organisation per storage location name. */
export async function evidenceCountsByLocation(db: DbOrTx, orgId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ location: evidence.storageLocation, n: count() })
    .from(evidence)
    .where(and(eq(evidence.orgId, orgId), isNull(evidence.purgedAt)))
    .groupBy(evidence.storageLocation);
  const out: Record<string, number> = {};
  for (const r of rows) out[locationName(r.location)] = (out[locationName(r.location)] ?? 0) + r.n;
  return out;
}

/** GET /api/admin/evidence-storage */
export async function evidenceStorageSummary(ctx: Pick<Ctx, 'db' | 'storageLocations'>, orgId: string): Promise<EvidenceStorageDTO> {
  const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, orgId));
  const counts = await evidenceCountsByLocation(ctx.db, orgId);
  const locations = ctx.storageLocations.list().map((l) => ({ name: l.name, label: l.label, region: l.region, isDefault: l.name === 'default' }));
  const names = new Set(locations.map((l) => l.name));
  return {
    current: orgSettings(org).evidenceLocation,
    locations,
    stored: [
      ...locations.map((l) => ({ location: l.name, images: counts[l.name] ?? 0 })),
      // Cannot happen while the start-up check holds; listed rather than hidden if it ever does.
      ...Object.entries(counts)
        .filter(([name]) => !names.has(name))
        .map(([location, images]) => ({ location, images })),
    ],
  };
}

/**
 * Versioned identity decision configurations (packages/shared/src/governance.ts).
 *
 * The thresholds that turn a face similarity into a per-sample label are an organisation's to set, but never in one
 * step: a change is proposed with a reason, previewed against recent samples, and approved by a second
 * administrator (four eyes — self-approval only when the organisation has no other active administrator, and then
 * recorded as such). Approval activates the version; every identity decision is stamped with the version (and the
 * server's calibration and recogniser model) that made it. Rolling back restores an earlier version as a new one,
 * immediately — it returns to a configuration that was already approved, for use during an incident.
 *
 * Version 1 is created on first use from what the organisation had (its stored thresholds, else the release
 * defaults). A version without thresholds follows the release defaults, so organisations that never customised them
 * keep getting improved defaults with server upgrades. The active version is mirrored into the organisation settings
 * (identityThresholds, decisionConfigVersion), which the decision paths already read: a change applies to the next
 * decision, including in exams in progress.
 */
import {
  DEFAULT_IDENTITY_THRESHOLDS,
  type DecisionConfigDTO,
  type DecisionConfigImpactDTO,
  type DecisionThresholds,
  type SampleLabel,
  type StaffRole,
} from '@sp/shared';
import { and, desc, eq, gte, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/index.js';
import { decisionConfigs, examSessions, identityChecks, organizations, staffUsers, type DecisionConfig, type Organization } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { orgSettings } from './org.js';

export const IMPACT_WINDOW_DAYS = 30;

/** The thresholds a version applies (release defaults for a version without its own). */
export function effectiveThresholds(c: Pick<DecisionConfig, 'thresholds'>): DecisionThresholds {
  return { ...DEFAULT_IDENTITY_THRESHOLDS, ...(c.thresholds ?? {}) };
}

/** Version 1 from what the organisation has, when it has no configuration yet. Returns the active version. */
export async function ensureDecisionConfigs(db: DbOrTx, orgId: string, now: number): Promise<DecisionConfig> {
  const [active] = await db
    .select()
    .from(decisionConfigs)
    .where(and(eq(decisionConfigs.orgId, orgId), eq(decisionConfigs.status, 'active')));
  if (active) return active;
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  if (!org) throw notFound('Organisation not found');
  const custom = org.settings?.identityThresholds ? orgSettings(org).identityThresholds : null;
  const [row] = await db
    .insert(decisionConfigs)
    .values({
      orgId,
      version: 1,
      status: 'active',
      thresholds: custom,
      note: custom ? 'The thresholds in use before versioned configurations.' : 'The release defaults.',
      proposedAt: new Date(now),
      decidedAt: new Date(now),
      activatedAt: new Date(now),
    })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  // Created concurrently.
  const [again] = await db
    .select()
    .from(decisionConfigs)
    .where(and(eq(decisionConfigs.orgId, orgId), eq(decisionConfigs.status, 'active')));
  return again;
}

async function nextVersion(db: DbOrTx, orgId: string): Promise<number> {
  const [r] = await db
    .select({ v: sql<number>`coalesce(max(${decisionConfigs.version}), 0)::int` })
    .from(decisionConfigs)
    .where(eq(decisionConfigs.orgId, orgId));
  return (r?.v ?? 0) + 1;
}

/** Make `row` the active version: retire the previous one and mirror it into the organisation settings. */
async function activate(db: DbOrTx, org: Organization, row: DecisionConfig, now: number): Promise<void> {
  await db
    .update(decisionConfigs)
    .set({ status: 'retired', retiredAt: new Date(now) })
    .where(and(eq(decisionConfigs.orgId, org.id), eq(decisionConfigs.status, 'active'), ne(decisionConfigs.id, row.id)));
  await db.update(decisionConfigs).set({ status: 'active', activatedAt: new Date(now) }).where(eq(decisionConfigs.id, row.id));
  const settings = { ...(org.settings ?? {}) };
  if (row.thresholds) settings.identityThresholds = effectiveThresholds(row);
  else delete settings.identityThresholds;
  settings.decisionConfigVersion = row.version;
  await db.update(organizations).set({ settings, updatedAt: new Date(now) }).where(eq(organizations.id, org.id));
}

async function lockOrg(db: DbOrTx, orgId: string): Promise<Organization> {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).for('update');
  if (!org) throw notFound('Organisation not found');
  return org;
}

type Actor = { id: string; orgId: string; role: StaffRole; ip?: string };

export async function proposeDecisionConfig(db: DbOrTx, actor: Actor, req: { thresholds: DecisionThresholds; note: string }, now: number): Promise<DecisionConfig> {
  await lockOrg(db, actor.orgId);
  const active = await ensureDecisionConfigs(db, actor.orgId, now);
  const [open] = await db
    .select({ id: decisionConfigs.id, version: decisionConfigs.version })
    .from(decisionConfigs)
    .where(and(eq(decisionConfigs.orgId, actor.orgId), eq(decisionConfigs.status, 'proposed')));
  if (open) throw conflict('proposal_open', `Version ${open.version} is waiting for approval. Decide or withdraw it first.`);
  const cur = effectiveThresholds(active);
  if (JSON.stringify(cur) === JSON.stringify(req.thresholds)) throw conflict('no_change', 'These are the thresholds already in use.');
  const [row] = await db
    .insert(decisionConfigs)
    .values({ orgId: actor.orgId, version: await nextVersion(db, actor.orgId), status: 'proposed', thresholds: req.thresholds, note: req.note.trim(), basedOnVersion: active.version, proposedBy: actor.id, proposedAt: new Date(now) })
    .returning();
  await audit(db, { orgId: actor.orgId, actorType: 'staff', actorId: actor.id, action: 'decision_config.proposed', targetType: 'decision_config', targetId: row.id, meta: { version: row.version, from: cur, to: req.thresholds, note: row.note }, ip: actor.ip, at: now });
  return row;
}

async function loadScoped(db: DbOrTx, orgId: string, id: string): Promise<DecisionConfig> {
  const [row] = await db
    .select()
    .from(decisionConfigs)
    .where(and(eq(decisionConfigs.id, id), eq(decisionConfigs.orgId, orgId)))
    .for('update');
  if (!row) throw notFound('Configuration not found', 'decision_config_not_found');
  return row;
}

/** Other active administrators / owners who could approve instead of the proposer. */
async function otherApprovers(db: DbOrTx, orgId: string, exceptId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(staffUsers)
    .where(and(eq(staffUsers.orgId, orgId), inArray(staffUsers.role, ['admin', 'owner']), eq(staffUsers.disabled, false), ne(staffUsers.id, exceptId)));
  return r?.n ?? 0;
}

export async function decideDecisionConfig(db: DbOrTx, actor: Actor, id: string, decision: 'approve' | 'reject' | 'withdraw', note: string | null, now: number): Promise<DecisionConfig> {
  const org = await lockOrg(db, actor.orgId);
  const row = await loadScoped(db, actor.orgId, id);
  if (row.status !== 'proposed') throw conflict('not_proposed', `Version ${row.version} is not waiting for approval.`);
  let selfApproved = false;
  if (decision === 'withdraw') {
    if (row.proposedBy !== actor.id) throw forbidden('Only the person who proposed it can withdraw it', 'not_proposer');
  } else if (row.proposedBy === actor.id) {
    // Four eyes: someone else decides — unless nobody else could.
    if (decision === 'reject' || (await otherApprovers(db, actor.orgId, actor.id)) > 0) throw forbidden('Another administrator must approve or reject a change you proposed', 'four_eyes_required');
    selfApproved = true;
  }
  const status = decision === 'approve' ? 'active' : decision === 'reject' ? 'rejected' : 'withdrawn';
  await db
    .update(decisionConfigs)
    .set({ status: decision === 'approve' ? 'proposed' : status, decidedBy: actor.id, decidedAt: new Date(now), decisionNote: note, selfApproved })
    .where(eq(decisionConfigs.id, row.id));
  if (decision === 'approve') await activate(db, org, { ...row, decidedBy: actor.id }, now);
  await audit(db, {
    orgId: actor.orgId,
    actorType: 'staff',
    actorId: actor.id,
    action: `decision_config.${decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'withdrawn'}`,
    targetType: 'decision_config',
    targetId: row.id,
    meta: { version: row.version, note, ...(selfApproved ? { selfApproved: true } : {}) },
    ip: actor.ip,
    at: now,
  });
  const [after] = await db.select().from(decisionConfigs).where(eq(decisionConfigs.id, row.id));
  return after;
}

/**
 * Restore an earlier version as a new active version, immediately (it was approved before). A proposal waiting for
 * approval is withdrawn: it was made against the configuration being replaced.
 */
export async function rollbackDecisionConfig(db: DbOrTx, actor: Actor, id: string, note: string, now: number): Promise<DecisionConfig> {
  const org = await lockOrg(db, actor.orgId);
  const target = await loadScoped(db, actor.orgId, id);
  if (target.status !== 'retired') throw conflict('not_retired', 'Only an earlier, previously active version can be restored.');
  const active = await ensureDecisionConfigs(db, actor.orgId, now);
  const withdrawn = await db
    .update(decisionConfigs)
    .set({ status: 'withdrawn', decidedBy: actor.id, decidedAt: new Date(now), decisionNote: `Withdrawn: version ${target.version} was restored.` })
    .where(and(eq(decisionConfigs.orgId, actor.orgId), eq(decisionConfigs.status, 'proposed')))
    .returning({ id: decisionConfigs.id, version: decisionConfigs.version });
  for (const w of withdrawn) {
    await audit(db, { orgId: actor.orgId, actorType: 'staff', actorId: actor.id, action: 'decision_config.withdrawn', targetType: 'decision_config', targetId: w.id, meta: { version: w.version, byRollback: true }, ip: actor.ip, at: now });
  }
  const [row] = await db
    .insert(decisionConfigs)
    .values({
      orgId: actor.orgId,
      version: await nextVersion(db, actor.orgId),
      status: 'proposed',
      thresholds: target.thresholds,
      note: note.trim(),
      basedOnVersion: active.version,
      rollbackOfVersion: target.version,
      proposedBy: actor.id,
      proposedAt: new Date(now),
      decidedBy: actor.id,
      decidedAt: new Date(now),
    })
    .returning();
  await activate(db, org, row, now);
  await audit(db, { orgId: actor.orgId, actorType: 'staff', actorId: actor.id, action: 'decision_config.rolled_back', targetType: 'decision_config', targetId: row.id, meta: { version: row.version, restores: target.version, replaces: active.version, note: row.note }, ip: actor.ip, at: now });
  const [after] = await db.select().from(decisionConfigs).where(eq(decisionConfigs.id, row.id));
  return after;
}

export async function listDecisionConfigs(db: DbOrTx, orgId: string): Promise<DecisionConfigDTO[]> {
  const rows = await db.select().from(decisionConfigs).where(eq(decisionConfigs.orgId, orgId)).orderBy(desc(decisionConfigs.version));
  const ids = [...new Set(rows.flatMap((r) => [r.proposedBy, r.decidedBy]).filter((x): x is string => !!x))];
  const people = ids.length ? await db.select({ id: staffUsers.id, name: staffUsers.name }).from(staffUsers).where(inArray(staffUsers.id, ids)) : [];
  const who = (id: string | null) => (id ? { id, name: people.find((p) => p.id === id)?.name ?? 'Former staff member' } : null);
  // Exams started while each version was active (version 1 also covers everything before it was recorded).
  // exam_sessions_org_started_idx keeps this one index range per version.
  const windows = rows.filter((r) => r.activatedAt);
  const counts = windows.length
    ? await Promise.all(
        windows.map(async (r) => {
          const [c] = await db
            .select({ n: sql<number>`count(*)::int` })
            .from(examSessions)
            .where(
              and(
                eq(examSessions.orgId, orgId),
                isNotNull(examSessions.startedAt),
                r.version === 1 ? undefined : gte(examSessions.startedAt, r.activatedAt!),
                r.retiredAt ? lt(examSessions.startedAt, r.retiredAt) : undefined,
              ),
            );
          return [r.id, c?.n ?? 0] as const;
        }),
      )
    : [];
  const sessionsById = new Map<string, number>(counts);
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    status: r.status,
    thresholds: effectiveThresholds(r),
    releaseDefaults: r.thresholds == null,
    note: r.note,
    basedOnVersion: r.basedOnVersion ?? null,
    rollbackOfVersion: r.rollbackOfVersion ?? null,
    proposedBy: who(r.proposedBy),
    proposedAt: r.proposedAt.getTime(),
    decidedBy: who(r.decidedBy),
    decidedAt: r.decidedAt?.getTime() ?? null,
    decisionNote: r.decisionNote ?? null,
    selfApproved: r.selfApproved,
    activatedAt: r.activatedAt?.getTime() ?? null,
    retiredAt: r.retiredAt?.getTime() ?? null,
    sessions: sessionsById.get(r.id) ?? 0,
  }));
}

/**
 * How the proposed thresholds would have labelled the last IMPACT_WINDOW_DAYS of identity samples, against the active
 * ones. Counted in SQL (one row per label pair), so the preview costs the same for any number of samples.
 */
export async function decisionConfigImpact(db: DbOrTx, orgId: string, id: string, now: number): Promise<DecisionConfigImpactDTO> {
  const [row] = await db
    .select()
    .from(decisionConfigs)
    .where(and(eq(decisionConfigs.id, id), eq(decisionConfigs.orgId, orgId)));
  if (!row) throw notFound('Configuration not found', 'decision_config_not_found');
  const active = await ensureDecisionConfigs(db, orgId, now);
  const cur = effectiveThresholds(active);
  const next = effectiveThresholds(row);
  const from = now - IMPACT_WINDOW_DAYS * 86_400_000;
  // labelSimilarity() in SQL: at or above match => match, below mismatch => mismatch, else inconclusive.
  const label = (match: number, mismatch: number) =>
    sql`case when ${identityChecks.similarity} >= ${match} then 'match' when ${identityChecks.similarity} < ${mismatch} then 'mismatch' else 'inconclusive' end`;
  const photo = sql`${identityChecks.trigger} = 'id_photo'`;
  const rows = await db
    .select({
      photo: sql<boolean>`${photo}`,
      a: sql<SampleLabel>`case when ${photo} then ${label(cur.idPhotoMatch, cur.idPhotoMismatch)} else ${label(cur.match, cur.mismatch)} end`,
      b: sql<SampleLabel>`case when ${photo} then ${label(next.idPhotoMatch, next.idPhotoMismatch)} else ${label(next.match, next.mismatch)} end`,
      n: sql<number>`count(*)::int`,
    })
    .from(identityChecks)
    .innerJoin(examSessions, eq(examSessions.id, identityChecks.sessionId))
    .where(and(eq(examSessions.orgId, orgId), gte(identityChecks.at, new Date(from)), isNotNull(identityChecks.similarity)))
    .groupBy(sql`1`, sql`2`, sql`3`);
  const tally = (rs: typeof rows) =>
    rs
      .filter((r) => r.a !== r.b)
      .map((r) => ({ from: r.a, to: r.b, count: r.n }))
      .sort((x, y) => y.count - x.count);
  const samples = rows.filter((r) => !r.photo);
  const photos = rows.filter((r) => r.photo);
  return {
    from,
    to: now,
    samples: samples.reduce((a, r) => a + r.n, 0),
    changes: tally(samples),
    idPhotoComparisons: photos.reduce((a, r) => a + r.n, 0),
    idPhotoChanges: tally(photos),
  };
}

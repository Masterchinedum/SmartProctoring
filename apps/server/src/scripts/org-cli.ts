/**
 * Operator commands for organisations: sandbox / production, quotas, the sandbox clean-up (docs/OPERATIONS.md).
 *
 *   pnpm --filter @sp/server org:create -- --name "<name>" --owner-email <address> [--owner-name "<name>"]
 *        [--kind sandbox|production] [--exams <n|unlimited>] [--candidates <n|unlimited>] [--sessions-per-month <n|unlimited>]
 *        [--purge-after-days <n>] [--reason "<ticket>"] [--json]
 *   pnpm --filter @sp/server org:set -- --org <id> [--kind sandbox|production] [--confirm-purge]
 *        [--exams <n|unlimited|default>] [--candidates …] [--sessions-per-month …] [--reset-quotas]
 *        [--purge-after-days <n|default>] [--reason "<ticket>"] [--json]
 *   pnpm --filter @sp/server org:list [-- --json]
 *   pnpm --filter @sp/server sandbox:purge [-- --dry-run] [--org <id>] [--json]
 *   node apps/server/dist/scripts/org.js <create|set|list|purge> …     (in the Docker image)
 *
 * Uses the same environment as the server (DATABASE_URL; STORAGE_* incl. STORAGE_LOCATIONS and EVIDENCE_KEY for
 * `purge`). Every change is written to the organisation's audit log (actor `system`, with --reason). `org:create`
 * prints the first owner's temporary password once — hand it over through a trusted channel; it is never stored in
 * clear. `--kind sandbox` on an existing production organisation needs --confirm-purge (its old data will be deleted).
 *
 * Exit codes: 0 done, 1 error, 2 bad arguments, 3 confirmation needed (org:set) / items could not be deleted
 * (sandbox:purge), 4 unknown organisation (org:set, sandbox:purge --org) or the owner address is taken (org:create),
 * 75 another clean-up is running (sandbox:purge).
 */
import { parseArgs } from 'node:util';
import { MAX_QUOTA, ORG_KINDS, QUOTA_KINDS, QUOTA_LABELS, quotaResetDate, type OrgKind, type QuotaKind } from '@sp/shared';
import pino from 'pino';
import { loadConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { createDatabase } from '../db/index.js';
import { organizations } from '../db/schema.js';
import { createKeyring } from '../lib/crypto.js';
import { StorageLocations } from '../lib/storage.js';
import { eq } from 'drizzle-orm';
import { runSandboxPurgeExclusive, type SandboxPurgeSummary } from '../services/sandbox-purge.js';
import { createOrganizationWithOwner, describeOrganization, listOrganizations, TenancyError, updateOrganizationTenancy, type OrganizationDescription, type QuotaSetting } from '../services/tenancy.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUOTA_FLAGS: Record<QuotaKind, string> = { exams: 'exams', candidates: 'candidates', sessionsPerMonth: 'sessions-per-month' };

const USAGE = {
  create:
    'Usage: org:create --name "<organisation>" --owner-email <address> [--owner-name "<name>"] [--kind sandbox|production] [--exams <n|unlimited>] [--candidates <n|unlimited>] [--sessions-per-month <n|unlimited>] [--purge-after-days <n>] [--reason "<ticket>"] [--json]',
  set: 'Usage: org:set --org <organisation id> [--kind sandbox|production] [--confirm-purge] [--exams <n|unlimited|default>] [--candidates <…>] [--sessions-per-month <…>] [--reset-quotas] [--purge-after-days <n|default>] [--reason "<ticket>"] [--json]',
  list: 'Usage: org:list [--json]',
  purge: 'Usage: sandbox:purge [--dry-run] [--org <sandbox organisation id>] [--json]',
} as const;
type Command = keyof typeof USAGE;

class UsageError extends Error {}

function quotaSetting(flag: string, raw: string | undefined, allowDefault: boolean): QuotaSetting | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'unlimited' || v === 'none') return null;
  if (allowDefault && v === 'default') return 'default';
  const n = Number(v);
  if (!/^\d+$/.test(v) || n > MAX_QUOTA) throw new UsageError(`--${flag} must be a whole number from 0 to ${MAX_QUOTA} or "unlimited"${allowDefault ? ' or "default"' : ''}`);
  return n;
}

function purgeDays(raw: string | undefined, allowDefault: boolean): number | null | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (allowDefault && v === 'default') return null;
  if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 365) throw new UsageError(`--purge-after-days must be a whole number of days from 1 to 365${allowDefault ? ' or "default"' : ''}`);
  return Number(v);
}

function kindArg(raw: string | undefined): OrgKind | undefined {
  if (raw === undefined) return undefined;
  if (!(ORG_KINDS as readonly string[]).includes(raw)) throw new UsageError('--kind must be "sandbox" or "production"');
  return raw as OrgKind;
}

const limitText = (v: number | null) => (v == null ? 'no limit' : v.toLocaleString('en-GB'));

function describe(d: OrganizationDescription): string {
  const lines = [`${d.name} (${d.id})`, `  kind:            ${d.kind}${d.kind === 'sandbox' ? ` — data is deleted ${d.sandboxPurgeDays} days after its last use` : ''}`];
  if (d.owners.length) lines.push(`  owners:          ${d.owners.join(', ')}`);
  for (const q of d.usage.quotas) {
    const override = q.quota in d.overrides ? ' (set by operator)' : d.kind === 'sandbox' && q.limit != null ? ' (sandbox default)' : '';
    lines.push(`  ${`${QUOTA_LABELS[q.quota]}:`.padEnd(34)} ${q.used.toLocaleString('en-GB')} of ${limitText(q.limit)}${override}${q.level === 'reached' ? ' — LIMIT REACHED' : q.level === 'warning' ? ' — nearly reached' : ''}`);
  }
  lines.push(`  monthly count starts again on ${quotaResetDate(d.usage.period.resetsAt)} (00:00 UTC)`);
  return lines.join('\n');
}

function printPurge(s: SandboxPurgeSummary): void {
  const lines = [`Sandbox clean-up ${s.dryRun ? 'DRY RUN (nothing deleted) ' : ''}as of ${new Date(s.now).toISOString()} — ${s.organisations.length} sandbox organisation(s)`];
  for (const o of s.organisations) {
    lines.push(`  ${o.name} (${o.orgId}), data last used before ${new Date(o.cutoff).toISOString()} (${o.purgeAfterDays} days):`);
    lines.push(`    sessions ${s.dryRun ? 'to delete' : 'deleted'}: ${o.sessionsDeleted}, images: ${o.evidenceItemsPurged}, candidates: ${o.candidatesDeleted}`);
    if (o.skippedLegalHold) lines.push(`    kept under legal hold: ${o.skippedLegalHold} session(s)${o.legalHoldSessionIds.length ? ` (${o.legalHoldSessionIds.join(', ')})` : ''}`);
    for (const f of o.failures.slice(0, 20)) lines.push(`    - ${f.target} ${f.id}: ${f.error}`);
  }
  lines.push(`  duration: ${s.durationMs} ms`);
  console.log(lines.join('\n'));
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0] as Command;
  if (!command || !(command in USAGE)) {
    console.error(`Unknown command "${argv[0] ?? ''}". ${Object.values(USAGE).join('\n')}`);
    return 2;
  }
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      // `pnpm … org:create -- --name …` passes the `--` through: ignore it.
      args: argv.slice(1).filter((a) => a !== '--'),
      options: {
        name: { type: 'string' },
        'owner-email': { type: 'string' },
        'owner-name': { type: 'string' },
        org: { type: 'string' },
        kind: { type: 'string' },
        exams: { type: 'string' },
        candidates: { type: 'string' },
        'sessions-per-month': { type: 'string' },
        'reset-quotas': { type: 'boolean', default: false },
        'purge-after-days': { type: 'string' },
        'confirm-purge': { type: 'boolean', default: false },
        reason: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE[command]}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE[command]);
    return 0;
  }
  const str = (k: string) => (typeof values[k] === 'string' ? (values[k] as string) : undefined);
  const reason = str('reason')?.trim();

  let quotas: Partial<Record<QuotaKind, QuotaSetting>> = {};
  let kind: OrgKind | undefined;
  let days: number | null | undefined;
  try {
    if (reason && reason.length > 500) throw new UsageError('--reason must be at most 500 characters');
    if (command === 'create' || command === 'set') {
      for (const q of QUOTA_KINDS) {
        const v = quotaSetting(QUOTA_FLAGS[q], str(QUOTA_FLAGS[q]), command === 'set');
        if (v !== undefined) quotas[q] = v;
      }
      kind = kindArg(str('kind'));
      days = purgeDays(str('purge-after-days'), command === 'set');
    }
    if (command === 'create') {
      if (!str('name')?.trim()) throw new UsageError('--name is required');
      if (!/^[^\s@]+@[^\s@]+$/.test(str('owner-email')?.trim() ?? '')) throw new UsageError('--owner-email <address> is required');
    }
    if (command === 'set') {
      if (!UUID_RE.test(str('org') ?? '')) throw new UsageError('--org <organisation id> is required (org:list shows them)');
      if (kind === undefined && !Object.keys(quotas).length && days === undefined && !values['reset-quotas']) throw new UsageError('nothing to change: give --kind, a quota, --reset-quotas or --purge-after-days');
    }
    if (command === 'purge' && str('org') !== undefined && !UUID_RE.test(str('org')!)) throw new UsageError('--org must be an organisation id');
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n${USAGE[command]}`);
    return 2;
  }

  const config = loadConfig();
  const log = pino({ level: process.env.LOG_LEVEL ?? 'warn', base: { app: 'org-cli' } });
  const database = createDatabase(config.databaseUrl, { max: 3, applicationName: 'smartproctoring-org' });
  const storageLocations = command === 'purge' ? StorageLocations.fromConfig(config.storageLocations) : null;
  const ctx = { db: database.db, now: () => Date.now() };
  try {
    if (command === 'create') {
      const r = await createOrganizationWithOwner(ctx, { name: str('name')!, kind: kind ?? 'production', ownerEmail: str('owner-email')!, ownerName: str('owner-name'), quotas, sandboxPurgeDays: days ?? null, reason });
      const d = await describeOrganization(database.db, r.org, ctx.now());
      if (values.json) {
        console.log(JSON.stringify({ organisation: d, owner: r.owner, temporaryPassword: r.temporaryPassword }, null, 2));
        return 0;
      }
      console.log(
        [
          `Created organisation`,
          describe(d),
          `  first owner:     ${r.owner.name} <${r.owner.email}>`,
          `  temporary password: ${r.temporaryPassword}`,
          '    (shown once — hand it over through a trusted channel; they sign in at the staff app and change it on their account page)',
        ].join('\n'),
      );
      return 0;
    }
    if (command === 'set') {
      const r = await updateOrganizationTenancy(ctx, { orgId: str('org')!.toLowerCase(), kind, quotas, resetQuotas: !!values['reset-quotas'], sandboxPurgeDays: days, confirmPurge: !!values['confirm-purge'], reason });
      const d = await describeOrganization(database.db, r.org, ctx.now());
      if (values.json) {
        console.log(JSON.stringify({ organisation: d, changed: r.changed }, null, 2));
        return 0;
      }
      console.log([r.changed.length ? `Updated (${r.changed.join(', ')}); recorded in the organisation's audit log` : 'Nothing changed', describe(d)].join('\n'));
      return 0;
    }
    if (command === 'list') {
      const all = await listOrganizations(database.db, ctx.now());
      if (values.json) console.log(JSON.stringify({ organisations: all }, null, 2));
      else console.log(all.length ? all.map(describe).join('\n\n') : 'No organisations.');
      return 0;
    }
    // purge
    const orgId = str('org')?.toLowerCase();
    if (orgId) {
      const [o] = await database.db.select({ kind: organizations.kind }).from(organizations).where(eq(organizations.id, orgId));
      if (!o || o.kind !== 'sandbox') {
        console.error(o ? 'That organisation is not a sandbox: the clean-up never touches production organisations.' : `No organisation has the id ${orgId}.`);
        return 4;
      }
    }
    const summary = await runSandboxPurgeExclusive(
      { database, db: database.db, storage: storageLocations!.default, storageLocations: storageLocations!, keyring: createKeyring(config.evidenceKey, config.evidenceKeysOld), now: ctx.now, log: log as unknown as Ctx['log'] },
      { dryRun: !!values['dry-run'], orgId },
    );
    if (!summary) {
      console.error('Another sandbox clean-up is running right now; try again later.');
      return 75;
    }
    if (values.json) console.log(JSON.stringify(summary, null, 2));
    else printPurge(summary);
    return summary.totals.failures ? 3 : 0;
  } catch (err) {
    if (err instanceof TenancyError) {
      console.error(err.message);
      return err.code === 'confirm_required' ? 3 : err.code === 'invalid' ? 2 : 4;
    }
    throw err;
  } finally {
    await storageLocations?.close();
    await database.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('Organisation command failed:', err);
    process.exit(1);
  },
);

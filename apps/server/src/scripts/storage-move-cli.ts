/**
 * Move an organisation's evidence images to another storage location (data residency).
 *
 *   pnpm --filter @sp/server storage:move -- --org <orgId> --to <location> [--dry-run] [--batch <n>] [--json]
 *   node apps/server/dist/scripts/storage-move.js --org <orgId> --to <location> [--dry-run] ...
 *
 * Uses the same environment as the server (DATABASE_URL, STORAGE_*, STORAGE_LOCATIONS + STORAGE_LOCATION_<NAME>_*,
 * EVIDENCE_KEY, EVIDENCE_KEYS_OLD). Every image is copied, verified (decrypted and compared with its SHA-256), the
 * database row switched to the new place, then the old copy deleted. Safe to run while the servers are up, safe to
 * interrupt and re-run (it continues where it stopped). Moving back is the same command with the old location
 * (docs/OPERATIONS.md §2).
 *
 * Exit codes: 0 every image of the organisation is in the target location, 1 error, 2 bad arguments, 3 images remain
 * outside it (a dry run: images would be moved; otherwise failed / missing / changed concurrently — see the output),
 * 4 unknown organisation or location, 75 another move is running (try again later).
 */
import { parseArgs } from 'node:util';
import pino from 'pino';
import { loadConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { createDatabase } from '../db/index.js';
import { createKeyring } from '../lib/crypto.js';
import { StorageLocations } from '../lib/storage.js';
import { moveOrgEvidenceExclusive, STORAGE_MOVE_DEFAULT_BATCH, StorageMoveError, type StorageMoveSummary } from '../services/storage-move.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function counts(c: Record<string, number>): string {
  const e = Object.entries(c).filter(([, n]) => n > 0);
  return e.length ? e.map(([l, n]) => `${l} ${n}`).join(', ') : 'none';
}

function printSummary(s: StorageMoveSummary, label: string): void {
  const lines = [`Evidence storage move ${s.dryRun ? 'DRY RUN (nothing changed) ' : ''}— organisation "${s.organisation}" (${s.orgId}) → ${s.to} (${label})`];
  lines.push(`  images before: ${counts(s.before)}`);
  if (s.dryRun) {
    lines.push(`  would move:    ${s.toMove} image(s)`);
  } else {
    const extra = [s.skipped ? `${s.skipped} changed concurrently` : '', s.missing ? `${s.missing} missing from storage` : '', s.failed ? `${s.failed} FAILED` : ''].filter(Boolean).join(', ');
    lines.push(`  moved:         ${s.moved}/${s.toMove}${extra ? ` (${extra})` : ''}`);
    lines.push(`  images after:  ${counts(s.after)}`);
    if (s.leftBehind) lines.push(`  old copies left behind (moved; delete by hand): ${s.leftBehind}`);
  }
  lines.push(s.remaining ? `  ${s.remaining} image(s) ${s.dryRun ? 'are' : 'remain'} outside "${s.to}"` : `  every image of this organisation is in "${s.to}"`);
  if (s.evidenceLocation !== s.to) {
    lines.push(`  NOTE: the organisation stores NEW images in "${s.evidenceLocation}". Its owner changes that in Settings → Where evidence images are stored.`);
  }
  for (const f of s.failures.slice(0, 20)) lines.push(`    - ${f.id} [${f.location}${f.key ? ` ${f.key}` : ''}]: ${f.error}`);
  if (s.failures.length > 20) lines.push(`    … ${s.failures.length - 20} more`);
  lines.push(`  duration: ${s.durationMs} ms`);
  console.log(lines.join('\n'));
}

async function main(): Promise<number> {
  let values: { org?: string; to?: string; 'dry-run'?: boolean; json?: boolean; batch?: string; 'batch-size'?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      // `pnpm … storage:move -- --org …` passes the `--` through: ignore a leading one.
      args: process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--')),
      options: {
        org: { type: 'string' },
        to: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        batch: { type: 'string' },
        'batch-size': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  const usage = `Usage: storage:move --org <organisation id> --to <location> [--dry-run] [--batch <n, default ${STORAGE_MOVE_DEFAULT_BATCH}>] [--json]`;
  if (values.help) {
    console.log(usage);
    return 0;
  }
  if (!values.org || !UUID_RE.test(values.org) || !values.to) {
    console.error(`${!values.org || !values.to ? '--org and --to are required' : '--org must be an organisation id (UUID)'}\n${usage}`);
    return 2;
  }
  const rawBatch = values.batch ?? values['batch-size'];
  const batchSize = rawBatch != null ? Number(rawBatch) : STORAGE_MOVE_DEFAULT_BATCH;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) {
    console.error('--batch must be an integer between 1 and 5000');
    return 2;
  }

  const config = loadConfig();
  const log = pino({ level: process.env.LOG_LEVEL ?? 'warn', base: { app: 'storage-move-cli' } });
  const database = createDatabase(config.databaseUrl, { max: 4, applicationName: 'smartproctoring-storage-move' });
  const storageLocations = StorageLocations.fromConfig(config.storageLocations);
  const keyring = createKeyring(config.evidenceKey, config.evidenceKeysOld);
  try {
    const progress = values.json ? undefined : (p: { from: string; done: number; total: number }) => process.stderr.write(`  from ${p.from}: ${Math.min(p.done, p.total)}/${p.total}\n`);
    const summary = await moveOrgEvidenceExclusive(
      { database, db: database.db, storage: storageLocations.default, storageLocations, keyring, now: () => Date.now(), log: log as unknown as Ctx['log'] },
      { orgId: values.org, to: values.to, dryRun: values['dry-run'], batchSize, onProgress: progress },
    );
    if (!summary) {
      console.error('Another evidence storage move is running right now; try again later.');
      return 75;
    }
    if (values.json) console.log(JSON.stringify(summary, null, 2));
    else printSummary(summary, storageLocations.list().find((l) => l.name === summary.to)?.label ?? summary.to);
    return summary.remaining || summary.failed ? 3 : 0;
  } catch (err) {
    if (err instanceof StorageMoveError) {
      console.error(err.message);
      return 4;
    }
    throw err;
  } finally {
    await storageLocations.close();
    await database.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('Evidence storage move failed:', err);
    process.exit(1);
  },
);

/**
 * Run the retention job once and print a summary.
 *
 *   pnpm --filter @sp/server retention:run [-- --dry-run] [--json] [--max <n>]
 *   node apps/server/dist/scripts/retention.js [--dry-run] [--json]
 *
 * Uses the same environment as the server (DATABASE_URL, STORAGE_*, EVIDENCE_KEY...). Holds the same
 * advisory lock as the in-server hourly job, so it never runs concurrently with it.
 *
 * Exit codes: 0 success, 1 error, 2 bad arguments, 3 some sessions failed (see output), 75 another
 * instance is currently running retention (try again later).
 */
import { parseArgs } from 'node:util';
import pino from 'pino';
import { loadConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { createDatabase } from '../db/index.js';
import { createKeyring } from '../lib/crypto.js';
import { createStorage } from '../lib/storage.js';
import { runRetentionExclusive, type RetentionLockCtx, type RetentionSummary } from '../services/retention.js';

function printSummary(s: RetentionSummary): void {
  const lines = [
    `Retention ${s.dryRun ? 'DRY RUN (nothing deleted) ' : ''}as of ${new Date(s.now).toISOString()}`,
    `  evidence purged:        ${s.sessionsEvidencePurged} session(s), ${s.evidenceItemsPurged} item(s)`,
    `  event metadata deleted: ${s.sessionsEventMetadataPurged} session(s), ${s.eventsDeleted} event(s), ${s.identityChecksDeleted} identity check(s)`,
    `  kept (legal hold):      ${s.skippedLegalHold} session(s) past their retention date`,
    `  failures:               ${s.failures.length}`,
    ...s.failures.map((f) => `    - ${f.sessionId} [${f.phase}]: ${f.error}`),
    `  duration:               ${s.durationMs} ms`,
  ];
  console.log(lines.join('\n'));
}

async function main(): Promise<number> {
  let values: { 'dry-run'?: boolean; json?: boolean; max?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      // `pnpm <script> -- --flag` forwards the separator; drop a leading '--'.
      args: process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--')),
      options: {
        'dry-run': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        max: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  if (values.help) {
    console.log('Usage: retention:run [--dry-run] [--json] [--max <sessions per phase>]');
    return 0;
  }
  const max = values.max != null ? Number(values.max) : undefined;
  if (max != null && (!Number.isInteger(max) || max < 1)) {
    console.error('--max must be a positive integer');
    return 2;
  }

  const config = loadConfig();
  const log = pino({ level: process.env.LOG_LEVEL ?? 'warn', base: { app: 'retention-cli' } });
  const database = createDatabase(config.databaseUrl, { max: 4, applicationName: 'smartproctoring-retention' });
  const storage = createStorage(config.storage);
  try {
    const ctx: RetentionLockCtx = {
      database,
      db: database.db,
      storage,
      keyring: createKeyring(config.evidenceKey, config.evidenceKeysOld),
      now: () => Date.now(),
      log: log as unknown as Ctx['log'],
    };
    const summary = await runRetentionExclusive(ctx, { dryRun: values['dry-run'], maxSessions: max });
    if (!summary) {
      console.error('Another instance is running the retention job right now; try again later.');
      return 75;
    }
    if (values.json) console.log(JSON.stringify(summary, null, 2));
    else printSummary(summary);
    return summary.failures.length ? 3 : 0;
  } finally {
    await storage.close?.();
    await database.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('Retention failed:', err);
    process.exit(1);
  },
);

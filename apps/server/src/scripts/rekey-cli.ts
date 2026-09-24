/**
 * Re-encrypt everything still encrypted under an old evidence key (after rotating EVIDENCE_KEY).
 *
 *   pnpm --filter @sp/server rekey [--dry-run] [--batch-size <n>] [--only <target,...>] [--json]
 *   node apps/server/dist/scripts/rekey.js [--dry-run] ...
 *
 * Uses the same environment as the server (DATABASE_URL, STORAGE_*, EVIDENCE_KEY, EVIDENCE_KEYS_OLD). Rotate first
 * (new key in EVIDENCE_KEY, previous one(s) in EVIDENCE_KEYS_OLD, servers restarted), then run this. Safe to run
 * while the servers are up, safe to interrupt and re-run (it continues where it stopped). Drop an old key from
 * EVIDENCE_KEYS_OLD only once `rekey --dry-run` reports nothing left under it (docs/OPERATIONS.md §3).
 *
 * Exit codes: 0 nothing left under old keys, 1 error, 2 bad arguments, 3 items remain under old keys or failed
 * (see output), 75 another re-encryption is running (try again later).
 */
import { parseArgs } from 'node:util';
import pino from 'pino';
import { loadConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { createDatabase } from '../db/index.js';
import { createKeyring, keyIdFor } from '../lib/crypto.js';
import { createStorage } from '../lib/storage.js';
import { REKEY_DEFAULT_BATCH, REKEY_TARGETS, rekeyAllExclusive, type RekeySummary } from '../services/rekey.js';

function printSummary(s: RekeySummary, oldKeyIds: string[]): void {
  const lines = [`Re-encryption ${s.dryRun ? 'DRY RUN (nothing changed) ' : ''}— current key ${s.currentKeyId}`];
  const w = Math.max(...s.targets.map((t) => t.target.length));
  for (const t of s.targets) {
    const extra = [t.skipped ? `${t.skipped} changed concurrently` : '', t.missing ? `${t.missing} blob(s) missing` : '', t.failed ? `${t.failed} FAILED` : ''].filter(Boolean).join(', ');
    lines.push(`  ${t.target.padEnd(w)}  ${s.dryRun ? `${t.outdated} under an old key` : `${t.rekeyed}/${t.outdated} re-encrypted`}${extra ? ` (${extra})` : ''}`);
  }
  const rem = Object.entries(s.remaining);
  lines.push(rem.length ? `  still under old keys: ${rem.map(([k, n]) => `${k}: ${n}`).join(', ')}` : '  nothing is encrypted under an old key');
  for (const id of oldKeyIds) {
    lines.push(`  EVIDENCE_KEYS_OLD ${id}: ${s.remaining[id] ? `still needed (${s.remaining[id]} item(s))` : 'no longer needed — can be removed'}`);
  }
  const unknown = Object.keys(s.remaining).filter((k) => k !== s.currentKeyId && !oldKeyIds.includes(k));
  if (unknown.length) lines.push(`  key id(s) not configured (cannot be decrypted): ${unknown.join(', ')}`);
  for (const f of s.failures.slice(0, 20)) lines.push(`    - ${f.target} ${f.id}: ${f.error}`);
  if (s.failures.length > 20) lines.push(`    … ${s.failures.length - 20} more failure(s)`);
  lines.push(`  duration: ${s.durationMs} ms`);
  console.log(lines.join('\n'));
}

async function main(): Promise<number> {
  let values: { 'dry-run'?: boolean; json?: boolean; 'batch-size'?: string; only?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      // `pnpm … rekey -- --dry-run` passes the `--` through: ignore a leading one.
      args: process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--')),
      options: {
        'dry-run': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        'batch-size': { type: 'string' },
        only: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  if (values.help) {
    console.log(`Usage: rekey [--dry-run] [--batch-size <n, default ${REKEY_DEFAULT_BATCH}>] [--only <${REKEY_TARGETS.join('|')}>,...] [--json]`);
    return 0;
  }
  const batchSize = values['batch-size'] != null ? Number(values['batch-size']) : REKEY_DEFAULT_BATCH;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) {
    console.error('--batch-size must be an integer between 1 and 5000');
    return 2;
  }
  const only = values.only ? values.only.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const unknownTargets = (only ?? []).filter((t) => !REKEY_TARGETS.includes(t));
  if (unknownTargets.length) {
    console.error(`Unknown target(s): ${unknownTargets.join(', ')} (expected ${REKEY_TARGETS.join(', ')})`);
    return 2;
  }

  const config = loadConfig();
  const log = pino({ level: process.env.LOG_LEVEL ?? 'warn', base: { app: 'rekey-cli' } });
  const database = createDatabase(config.databaseUrl, { max: 4, applicationName: 'smartproctoring-rekey' });
  const storage = createStorage(config.storage);
  const keyring = createKeyring(config.evidenceKey, config.evidenceKeysOld);
  const oldKeyIds = config.evidenceKeysOld.map(keyIdFor);
  try {
    const progress = values.json
      ? undefined
      : (p: { target: string; done: number; total: number }) => process.stderr.write(`  ${p.target}: ${Math.min(p.done, p.total)}/${p.total}\n`);
    const summary = await rekeyAllExclusive(
      { database, db: database.db, storage, keyring, now: () => Date.now(), log: log as unknown as Ctx['log'] },
      { dryRun: values['dry-run'], batchSize, only, onProgress: progress },
    );
    if (!summary) {
      console.error('Another re-encryption is running right now; try again later.');
      return 75;
    }
    if (values.json) console.log(JSON.stringify({ ...summary, oldKeyIds }, null, 2));
    else printSummary(summary, oldKeyIds);
    return summary.failures.length || Object.keys(summary.remaining).length ? 3 : 0;
  } finally {
    await storage.close?.();
    await database.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('Re-encryption failed:', err);
    process.exit(1);
  },
);

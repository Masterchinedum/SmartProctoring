/**
 * Databases at a given migration for upgrade tests (test/migration-upgrades.test.ts, test/schema-drift.test.ts): a
 * fresh database migrated up to and including one migration of drizzle/meta/_journal.json, plus catalog helpers.
 */
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createDatabase, findMigrationsDir, migrate, type Database } from '../src/db/index.js';
import { dbUrl, TEST_ADMIN_URL } from './global-setup.js';

export interface JournalEntry {
  idx: number;
  tag: string;
}

export function readJournal(): JournalEntry[] {
  const journal = JSON.parse(readFileSync(join(findMigrationsDir(), 'meta', '_journal.json'), 'utf8')) as { entries: JournalEntry[] };
  return journal.entries;
}

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: TEST_ADMIN_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export interface MigrationDb {
  name: string;
  database: Database;
  /** Drop the database and the temporary migrations folder. */
  drop(): Promise<void>;
}

/** A fresh database migrated up to and including `tag` (null: empty, no migration applied). */
export async function databaseAt(tag: string | null): Promise<MigrationDb> {
  const source = findMigrationsDir();
  const journal = JSON.parse(readFileSync(join(source, 'meta', '_journal.json'), 'utf8')) as { entries: JournalEntry[] };
  const upTo = tag == null ? -1 : journal.entries.findIndex((e) => e.tag === tag);
  if (tag != null && upTo < 0) throw new Error(`unknown migration ${tag}`);
  const name = `proctor_mig_${randomBytes(5).toString('hex')}`;
  await admin((c) => c.query(`CREATE DATABASE "${name}"`));
  const database = createDatabase(dbUrl(name), { max: 3, applicationName: 'smartproctoring-migration-test' });
  let folder: string | null = null;
  const drop = async () => {
    await database.close().catch(() => {});
    if (folder) rmSync(folder, { recursive: true, force: true });
    await admin((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
  };
  if (upTo >= 0) {
    folder = mkdtempSync(join(tmpdir(), 'sp-migrations-'));
    const keep = new Set(journal.entries.slice(0, upTo + 1).map((e) => `${e.tag}.sql`));
    for (const f of readdirSync(source)) if (keep.has(f)) cpSync(join(source, f), join(folder, f));
    cpSync(join(source, 'meta'), join(folder, 'meta'), { recursive: true });
    writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo + 1) }));
    try {
      await migrate(database, { migrationsFolder: folder });
    } catch (err) {
      await drop();
      throw err;
    }
  }
  return { name, database, drop };
}

/* ------------------------------------------------------------------ catalog */

export interface CatalogColumn {
  table: string;
  name: string;
  /** format_type(): 'uuid', 'text', 'timestamp with time zone', 'jsonb', 'bigint', 'text[]'... */
  type: string;
  notNull: boolean;
  /** pg_get_expr of the default, or null. */
  default: string | null;
  identity: boolean;
  generated: boolean;
  /** For enum types: their labels in order. */
  enumLabels: string[] | null;
}

export interface CatalogForeignKey {
  name: string;
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: string;
  onUpdate: string;
}

export interface CatalogIndex {
  name: string;
  table: string;
  unique: boolean;
  /** Key columns (or expressions) as Postgres prints them. */
  columns: string[];
  where: string | null;
  /** Backs a primary key or unique constraint (not a CREATE INDEX of its own). */
  constraint: boolean;
}

export interface Catalog {
  tables: string[];
  columns: CatalogColumn[];
  primaryKeys: Map<string, { name: string; columns: string[] }>;
  uniqueConstraints: { name: string; table: string; columns: string[] }[];
  foreignKeys: CatalogForeignKey[];
  indexes: CatalogIndex[];
  checks: { name: string; table: string; definition: string }[];
}

const FK_ACTIONS: Record<string, string> = { a: 'no action', r: 'restrict', c: 'cascade', n: 'set null', d: 'set default' };

/** The public schema of a database, from pg_catalog. */
export async function readCatalog(pool: pg.Pool): Promise<Catalog> {
  const q = async <T extends pg.QueryResultRow>(text: string) => (await pool.query<T>(text)).rows;
  const keyCols = (rel: string, keys: string) =>
    `array(SELECT a.attname::text FROM unnest(${keys}) WITH ORDINALITY k(n, i) JOIN pg_attribute a ON a.attrelid = ${rel} AND a.attnum = k.n ORDER BY k.i)`;
  const [tables, columns, constraints, indexes] = await Promise.all([
    q<{ name: string }>(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`),
    q<{ table: string; name: string; type: string; not_null: boolean; default: string | null; identity: string; generated: string; enum_labels: string[] | null }>(
      `SELECT c.relname AS table, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
              pg_get_expr(d.adbin, d.adrelid) AS default, a.attidentity AS identity, a.attgenerated AS generated,
              (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = a.atttypid) AS enum_labels
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY c.relname, a.attnum`,
    ),
    q<{ name: string; type: string; table: string; columns: string[]; ref_table: string | null; ref_columns: string[] | null; on_delete: string; on_update: string; definition: string }>(
      `SELECT con.conname AS name, con.contype AS type, src.relname AS table, ${keyCols('con.conrelid', 'con.conkey')} AS columns,
              dst.relname AS ref_table, CASE WHEN con.contype = 'f' THEN ${keyCols('con.confrelid', 'con.confkey')} END AS ref_columns,
              con.confdeltype AS on_delete, con.confupdtype AS on_update, pg_get_constraintdef(con.oid) AS definition
         FROM pg_constraint con
         JOIN pg_class src ON src.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = src.relnamespace
         LEFT JOIN pg_class dst ON dst.oid = con.confrelid
        WHERE n.nspname = 'public' AND con.contype IN ('p', 'u', 'f', 'c')
        ORDER BY 1`,
    ),
    q<{ name: string; table: string; unique: boolean; columns: string[]; where: string | null; constraint: boolean }>(
      `SELECT ic.relname AS name, tc.relname AS table, i.indisunique AS unique,
              array(SELECT pg_get_indexdef(i.indexrelid, k.i::int, true) FROM generate_series(1, i.indnkeyatts) AS k(i) ORDER BY k.i) AS columns,
              pg_get_expr(i.indpred, i.indrelid, true) AS where,
              EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid AND con.contype IN ('p', 'u')) AS constraint
         FROM pg_index i
         JOIN pg_class ic ON ic.oid = i.indexrelid
         JOIN pg_class tc ON tc.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = tc.relnamespace
        WHERE n.nspname = 'public'
        ORDER BY 1`,
    ),
  ]);
  return {
    tables: tables.map((t) => t.name),
    columns: columns.map((c) => ({ table: c.table, name: c.name, type: c.type, notNull: c.not_null, default: c.default, identity: c.identity !== '', generated: c.generated !== '', enumLabels: c.enum_labels })),
    primaryKeys: new Map(constraints.filter((c) => c.type === 'p').map((c) => [c.table, { name: c.name, columns: c.columns }])),
    uniqueConstraints: constraints.filter((c) => c.type === 'u').map((c) => ({ name: c.name, table: c.table, columns: c.columns })),
    foreignKeys: constraints
      .filter((c) => c.type === 'f')
      .map((c) => ({ name: c.name, table: c.table, columns: c.columns, refTable: c.ref_table!, refColumns: c.ref_columns!, onDelete: FK_ACTIONS[c.on_delete] ?? c.on_delete, onUpdate: FK_ACTIONS[c.on_update] ?? c.on_update })),
    indexes,
    checks: constraints.filter((c) => c.type === 'c').map((c) => ({ name: c.name, table: c.table, definition: c.definition })),
  };
}

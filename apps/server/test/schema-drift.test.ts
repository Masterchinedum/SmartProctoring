/**
 * Schema drift: what the migrations build must be exactly what src/db/schema.ts declares.
 *
 *  1. schema.ts against the latest migration snapshot (drizzle-kit's own diff, as `drizzle-kit generate` computes it):
 *     no statements — an edit of schema.ts without a generated migration fails here.
 *  2. A database migrated from scratch against that snapshot (tables, columns with type / NOT NULL / default, primary
 *     keys, unique constraints, foreign keys with their actions, indexes with uniqueness, key columns and partial
 *     predicates, check constraints): a migration whose SQL was edited by hand, custom SQL that changes what the
 *     snapshot says, or a missing snapshot fails here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema.js';
import { findMigrationsDir } from '../src/db/index.js';
import { databaseAt, readCatalog, readJournal, type Catalog, type MigrationDb } from './migration-db.js';

interface SnapshotColumn {
  name: string;
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  default?: unknown;
}
interface SnapshotIndex {
  name: string;
  columns: { expression: string; isExpression: boolean }[];
  isUnique: boolean;
  where?: string;
}
interface SnapshotTable {
  name: string;
  schema: string;
  columns: Record<string, SnapshotColumn>;
  indexes: Record<string, SnapshotIndex>;
  foreignKeys: Record<string, { name: string; tableFrom: string; tableTo: string; columnsFrom: string[]; columnsTo: string[]; onDelete?: string; onUpdate?: string }>;
  compositePrimaryKeys: Record<string, { name: string; columns: string[] }>;
  uniqueConstraints: Record<string, { name: string; columns: string[] }>;
  checkConstraints: Record<string, { name: string; value: string }>;
}
interface Snapshot {
  tables: Record<string, SnapshotTable>;
  enums: Record<string, { name: string; values: string[] }>;
}

function latestSnapshot(): Snapshot {
  const entries = readJournal();
  const last = entries[entries.length - 1];
  return JSON.parse(readFileSync(join(findMigrationsDir(), 'meta', `${String(last.idx).padStart(4, '0')}_snapshot.json`), 'utf8')) as Snapshot;
}

/** Postgres' spelling of a drizzle snapshot column type. */
function pgType(t: string): string {
  const map: Record<string, string> = { bigserial: 'bigint', serial: 'integer', smallserial: 'smallint', timestamptz: 'timestamp with time zone', varchar: 'character varying', int: 'integer' };
  return map[t] ?? t;
}

/** Defaults compared on what they mean: Postgres adds casts to literals and spells serial defaults as nextval(). */
function normDefault(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const text = String(v).trim();
  const json = /^'(.*)'::jsonb$/s.exec(text);
  if (json) return `${canonicalJson(JSON.parse(json[1].replace(/''/g, "'")))}::jsonb`;
  return text
    .replace(/::(text|character varying|integer|bigint|boolean|double precision|numeric)\b/g, '')
    .replace(/^\((.*)\)$/, '$1')
    .trim();
}

/** JSON with object keys sorted (Postgres stores jsonb with its own key order). */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Index predicates: Postgres reprints them with parentheses, casts and = ANY (ARRAY[...]) for IN lists. */
function normWhere(w: string | null | undefined): string | null {
  if (!w) return null;
  return w
    .replace(/"([a-z_]+)"\."([a-z_]+)"/g, '$2')
    .replace(/"([a-z_]+)"/g, '$1')
    .replace(/::text(\[\])?/g, '')
    .replace(/\s+in\s+\(([^)]*)\)/gi, (_m, list: string) => ` = ANY (ARRAY[${list.split(',').map((x) => x.trim()).join(', ')}])`)
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function compare(snapshot: Snapshot, db: Catalog): string[] {
  const diffs: string[] = [];
  const snapTables = new Map(Object.values(snapshot.tables).filter((t) => t.schema === '' || t.schema === 'public').map((t) => [t.name, t]));
  for (const name of db.tables) if (!snapTables.has(name)) diffs.push(`table ${name}: in the database, not in schema.ts`);
  for (const [name, t] of snapTables) {
    if (!db.tables.includes(name)) {
      diffs.push(`table ${name}: in schema.ts, not created by the migrations`);
      continue;
    }
    // Columns
    const dbCols = new Map(db.columns.filter((c) => c.table === name).map((c) => [c.name, c]));
    for (const c of dbCols.keys()) if (!t.columns[c]) diffs.push(`${name}.${c}: in the database, not in schema.ts`);
    for (const c of Object.values(t.columns)) {
      const d = dbCols.get(c.name);
      if (!d) {
        diffs.push(`${name}.${c.name}: in schema.ts, not in the database`);
        continue;
      }
      if (d.type !== pgType(c.type)) diffs.push(`${name}.${c.name}: type ${d.type} in the database, ${c.type} in schema.ts`);
      if (d.notNull !== c.notNull) diffs.push(`${name}.${c.name}: ${d.notNull ? 'NOT NULL' : 'nullable'} in the database, ${c.notNull ? 'NOT NULL' : 'nullable'} in schema.ts`);
      const serial = /serial$/.test(c.type);
      const dbDefault = serial ? null : normDefault(d.default);
      if (serial && !/^nextval\(/.test(d.default ?? '')) diffs.push(`${name}.${c.name}: not a sequence default in the database`);
      if (!serial && dbDefault !== normDefault(c.default)) diffs.push(`${name}.${c.name}: default ${dbDefault ?? 'none'} in the database, ${normDefault(c.default) ?? 'none'} in schema.ts`);
    }
    // Primary key
    const single = Object.values(t.columns).filter((c) => c.primaryKey).map((c) => c.name);
    const composite = Object.values(t.compositePrimaryKeys)[0];
    const wantPk = composite ? composite.columns : single;
    const pk = db.primaryKeys.get(name);
    if (JSON.stringify(pk?.columns ?? []) !== JSON.stringify(wantPk)) diffs.push(`${name}: primary key (${pk?.columns.join(', ') ?? 'none'}) in the database, (${wantPk.join(', ') || 'none'}) in schema.ts`);
    if (composite && pk && pk.name !== composite.name) diffs.push(`${name}: primary key named ${pk.name} in the database, ${composite.name} in schema.ts`);
    // Unique constraints
    const dbUq = new Map(db.uniqueConstraints.filter((u) => u.table === name).map((u) => [u.name, u]));
    for (const u of Object.values(t.uniqueConstraints)) {
      const d = dbUq.get(u.name);
      if (!d) diffs.push(`${name}: unique constraint ${u.name} missing in the database`);
      else if (JSON.stringify(d.columns) !== JSON.stringify(u.columns)) diffs.push(`${name}: unique constraint ${u.name} on (${d.columns}) in the database, (${u.columns}) in schema.ts`);
      dbUq.delete(u.name);
    }
    for (const u of dbUq.keys()) diffs.push(`${name}: unique constraint ${u} in the database, not in schema.ts`);
    // Foreign keys
    const dbFk = new Map(db.foreignKeys.filter((f) => f.table === name).map((f) => [f.name, f]));
    for (const f of Object.values(t.foreignKeys)) {
      const d = dbFk.get(f.name);
      dbFk.delete(f.name);
      if (!d) {
        diffs.push(`${name}: foreign key ${f.name} missing in the database`);
        continue;
      }
      const want = `(${f.columnsFrom}) -> ${f.tableTo}(${f.columnsTo}) on delete ${f.onDelete ?? 'no action'} on update ${f.onUpdate ?? 'no action'}`;
      const got = `(${d.columns}) -> ${d.refTable}(${d.refColumns}) on delete ${d.onDelete} on update ${d.onUpdate}`;
      if (want !== got) diffs.push(`${name}: foreign key ${f.name} is ${got} in the database, ${want} in schema.ts`);
    }
    for (const f of dbFk.keys()) diffs.push(`${name}: foreign key ${f} in the database, not in schema.ts`);
    // Indexes (those that back a primary key / unique constraint are compared above)
    const dbIdx = new Map(db.indexes.filter((i) => i.table === name && !i.constraint).map((i) => [i.name, i]));
    for (const i of Object.values(t.indexes)) {
      const d = dbIdx.get(i.name);
      dbIdx.delete(i.name);
      if (!d) {
        diffs.push(`${name}: index ${i.name} missing in the database`);
        continue;
      }
      if (d.unique !== i.isUnique) diffs.push(`${name}: index ${i.name} is ${d.unique ? '' : 'not '}unique in the database, ${i.isUnique ? '' : 'not '}unique in schema.ts`);
      const want = i.columns.map((c) => (c.isExpression ? c.expression.replace(/"/g, '').toLowerCase() : c.expression));
      // (Postgres quotes column names that are keywords, e.g. "position")
      const got = d.columns.map((c, k) => (i.columns[k]?.isExpression ? c.replace(/"/g, '').toLowerCase() : c.replace(/^"(.*)"$/, '$1')));
      if (JSON.stringify(want) !== JSON.stringify(got)) diffs.push(`${name}: index ${i.name} on (${got.join(', ')}) in the database, (${want.join(', ')}) in schema.ts`);
      if (normWhere(d.where) !== normWhere(i.where)) diffs.push(`${name}: index ${i.name} WHERE ${d.where ?? '-'} in the database, ${i.where ?? '-'} in schema.ts`);
    }
    for (const i of dbIdx.keys()) diffs.push(`${name}: index ${i} in the database, not in schema.ts`);
    // Check constraints (names)
    const dbChecks = new Set(db.checks.filter((c) => c.table === name).map((c) => c.name));
    for (const c of Object.values(t.checkConstraints)) if (!dbChecks.delete(c.name)) diffs.push(`${name}: check constraint ${c.name} missing in the database`);
    for (const c of dbChecks) diffs.push(`${name}: check constraint ${c} in the database, not in schema.ts`);
  }
  return diffs;
}

describe('schema drift', () => {
  let migrated: MigrationDb;
  beforeAll(async () => {
    migrated = await databaseAt(readJournal().at(-1)!.tag);
  });
  afterAll(async () => {
    await migrated?.drop();
  });

  it('schema.ts needs no new migration (drizzle-kit generate would produce nothing)', async () => {
    const { generateDrizzleJson, generateMigration } = await import('drizzle-kit/api');
    const statements = await generateMigration(latestSnapshot() as never, generateDrizzleJson(schema as unknown as Record<string, unknown>) as never);
    expect(statements, 'schema.ts changed without a migration: run `pnpm --filter @sp/server db:generate --name <name>`').toEqual([]);
  });

  it('the migrations build exactly the schema of the latest snapshot', async () => {
    const snapshot = latestSnapshot();
    expect(Object.keys(snapshot.enums)).toEqual([]); // compare() does not cover enum types yet: extend it when one is added
    const catalog = await readCatalog(migrated.database.pool);
    expect(catalog.tables.length).toBeGreaterThan(30);
    expect(compare(snapshot, catalog)).toEqual([]);
  });

  it('notices drift (self-check of the comparison)', async () => {
    const snapshot = structuredClone(latestSnapshot());
    const catalog = await readCatalog(migrated.database.pool);
    const events = Object.values(snapshot.tables).find((t) => t.name === 'events')!;
    events.columns.severity.notNull = false;
    events.columns.extra_column = { name: 'extra_column', type: 'text', primaryKey: false, notNull: false };
    delete events.indexes[Object.keys(events.indexes)[0]];
    const undecided = events.indexes.events_undecided_flags_idx;
    undecided.where = `"events"."review_status" = 'reviewed'`;
    const diffs = compare(snapshot, catalog);
    expect(diffs.some((d) => d.startsWith('events.severity: NOT NULL in the database'))).toBe(true);
    expect(diffs).toContain('events.extra_column: in schema.ts, not in the database');
    expect(diffs.some((d) => /^events: index \w+ in the database, not in schema.ts$/.test(d))).toBe(true);
    expect(diffs.some((d) => d.startsWith('events: index events_undecided_flags_idx WHERE'))).toBe(true);
  });
});

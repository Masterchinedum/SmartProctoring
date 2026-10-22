/**
 * Upgrades from every earlier migration to the latest, with data in every table.
 *
 * The test template database is migrated while empty, so a migration that breaks on existing rows (a NOT NULL column
 * without a default, a unique index over duplicates, a type change the stored values do not survive, a data step that
 * assumes something about the rows) would only fail in production. For each migration 0000 … latest-1 (read from the
 * journal, so new migrations are covered without editing this file): a database is migrated up to it, one row is
 * written into every table as that schema stored it (generated from the catalog: every column the schema has, foreign
 * keys pointing at the rows written before), then the database is migrated to the latest schema. Every row must still
 * be there with the values of the columns it had, and the current code must be able to read every table.
 *
 * Migrations that move data in specific ways have their own cases with hand-written rows in test/migrations.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { databaseAt, readCatalog, readJournal, type Catalog, type CatalogColumn, type MigrationDb } from './migration-db.js';

/**
 * Values a column holds in practice where a generic value of its type would not be realistic (and a later migration
 * reads it). `table.column`; the generic choice is used otherwise.
 */
const REALISTIC: Record<string, unknown> = {
  'exams.status': 'published',
  'exam_sessions.status': 'submitted',
  'questions.type': 'single_choice',
  'questions.options': [{ id: 'a', text: 'A' }],
  'questions.correct': ['a'],
  'events.category': 'integrity',
  'events.type': 'looking_away',
  'events.review_status': 'reviewed',
  'staff_users.role': 'reviewer',
  'privacy_requests.status': 'open',
  // CHECK organizations_kind_check (0017): production | sandbox.
  'organizations.kind': 'sandbox',
  'organizations.quotas': { candidates: 10, sessionsPerMonth: null },
  'org_usage.month': '2026-01',
};

/**
 * Columns a later migration rewrites on purpose, `table.column` -> the migration that does it. The row's other
 * columns must survive unchanged.
 */
const REWRITTEN_BY_MIGRATION: Record<string, string> = {};

const SEED_TIME = '2026-01-15T10:00:00.000Z';

function genericValue(c: CatalogColumn): unknown {
  const key = `${c.table}.${c.name}`;
  if (key in REALISTIC) {
    const v = REALISTIC[key];
    return typeof v === 'object' ? JSON.stringify(v) : v;
  }
  if (c.enumLabels?.length) return c.enumLabels[0];
  const t = c.type;
  if (t.endsWith('[]')) return '{}';
  if (t === 'uuid') return randomUUID();
  if (t === 'text' || t.startsWith('character varying') || t === 'citext') return `${c.name} of ${c.table}`;
  if (t === 'integer' || t === 'smallint' || t === 'bigint') return 1;
  if (t === 'double precision' || t === 'real' || t.startsWith('numeric')) return 0.5;
  if (t === 'boolean') return true;
  if (t.startsWith('timestamp') || t === 'date') return SEED_TIME;
  if (t === 'jsonb' || t === 'json') return JSON.stringify({ seeded: true });
  if (t === 'bytea') return Buffer.from([1, 2, 3, 4]);
  if (t === 'inet') return '192.0.2.1';
  throw new Error(`no seed value for ${key} (${t}): add it to genericValue()`);
}

interface SeededRow {
  table: string;
  pk: Record<string, unknown>;
  /** The row as row_to_json() printed it right after the insert. */
  before: Record<string, unknown>;
}

/** One row in every table, parents first (NOT NULL foreign keys decide the order; nullable ones point at rows written earlier). */
async function seedEveryTable(pool: pg.Pool, cat: Catalog): Promise<SeededRow[]> {
  const fksOf = (t: string) => cat.foreignKeys.filter((f) => f.table === t);
  const colsOf = (t: string) => cat.columns.filter((c) => c.table === t);
  const required = (t: string) => fksOf(t).filter((f) => f.refTable !== t && f.columns.some((col) => colsOf(t).find((c) => c.name === col)?.notNull));
  const order: string[] = [];
  const pending = new Set(cat.tables);
  while (pending.size) {
    const ready = [...pending].filter((t) => required(t).every((f) => order.includes(f.refTable)));
    if (!ready.length) throw new Error(`cyclic NOT NULL foreign keys among ${[...pending].join(', ')}`);
    for (const t of ready.sort()) {
      order.push(t);
      pending.delete(t);
    }
  }
  const rows = new Map<string, Record<string, unknown>>();
  const seeded: SeededRow[] = [];
  for (const table of order) {
    const values = new Map<string, unknown>();
    for (const f of fksOf(table)) {
      const parent = rows.get(f.refTable);
      if (parent && f.refTable !== table) f.columns.forEach((col, i) => values.set(col, parent[f.refColumns[i]]));
    }
    const fkCols = new Set(fksOf(table).flatMap((f) => f.columns));
    for (const c of colsOf(table)) {
      if (values.has(c.name) || c.identity || c.generated || /^nextval\(/.test(c.default ?? '')) continue;
      if (fkCols.has(c.name)) continue; // no parent row (self reference): left null
      values.set(c.name, genericValue(c));
    }
    const cols = [...values.keys()];
    const sql = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`;
    let inserted: Record<string, unknown>;
    try {
      inserted = (await pool.query(sql, [...values.values()])).rows[0];
    } catch (err) {
      throw new Error(`seeding ${table} failed: ${(err as Error).message}`);
    }
    rows.set(table, inserted);
    const pkCols = cat.primaryKeys.get(table)?.columns ?? [];
    const pk = Object.fromEntries(pkCols.map((c) => [c, inserted[c]]));
    seeded.push({ table, pk, before: await rowJson(pool, table, pk) });
  }
  return seeded;
}

async function rowJson(pool: pg.Pool, table: string, pk: Record<string, unknown>): Promise<Record<string, unknown>> {
  const keys = Object.keys(pk);
  if (!keys.length) throw new Error(`${table} has no primary key`);
  const { rows } = await pool.query<{ j: Record<string, unknown> }>(`SELECT row_to_json(t) AS j FROM "${table}" t WHERE ${keys.map((k, i) => `"${k}" = $${i + 1}`).join(' AND ')}`, Object.values(pk));
  return rows[0]?.j;
}

const journal = readJournal();
const latest = journal[journal.length - 1];
const drops: MigrationDb[] = [];
afterAll(async () => {
  await Promise.all(drops.map((d) => d.drop()));
});

describe.concurrent('upgrade to the latest migration from every earlier one, with a row in every table', () => {
  for (const from of journal.slice(0, -1)) {
    it(`from ${from.tag}`, async () => {
      const mdb = await databaseAt(from.tag);
      drops.push(mdb);
      const pool = mdb.database.pool;
      const old = await readCatalog(pool);
      const seeded = await seedEveryTable(pool, old);
      expect(seeded.map((s) => s.table).sort()).toEqual([...old.tables].sort());

      try {
        await migrate(mdb.database); // the real folder: every later migration
      } catch (err) {
        const cause = (err as { cause?: { message?: string } }).cause?.message;
        throw new Error(`upgrading from ${from.tag} with data failed: ${cause ?? (err as Error).message}`);
      }

      const now = await readCatalog(pool);
      const problems: string[] = [];
      for (const s of seeded) {
        if (!now.tables.includes(s.table)) continue; // dropped on purpose by a later migration
        const after = await rowJson(pool, s.table, s.pk);
        if (!after) {
          problems.push(`${s.table}: the row is gone`);
          continue;
        }
        for (const [col, v] of Object.entries(s.before)) {
          if (!(col in after) || REWRITTEN_BY_MIGRATION[`${s.table}.${col}`]) continue; // dropped / rewritten on purpose
          if (JSON.stringify(after[col]) !== JSON.stringify(v)) problems.push(`${s.table}.${col}: ${JSON.stringify(v)} became ${JSON.stringify(after[col])}`);
        }
      }
      expect(problems).toEqual([]);

      // The current code reads every table of the upgraded database (all columns, its types and parsers).
      for (const table of Object.values(schema as Record<string, unknown>).filter((v): v is PgTable => is(v, PgTable))) {
        const rows = await mdb.database.db.select().from(table);
        if (seeded.some((s) => s.table === getTableName(table))) expect(rows.length, getTableName(table)).toBeGreaterThan(0);
      }
      expect(now.tables.length).toBeGreaterThanOrEqual(old.tables.length);
      expect((await pool.query(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)).rows[0].n).toBe(latest.idx + 1);
    });
  }
});

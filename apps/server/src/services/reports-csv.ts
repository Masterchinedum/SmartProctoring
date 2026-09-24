/**
 * CSV export of a session's events (RFC 4180: comma separated, CRLF line endings, fields containing
 * a comma, quote or line break are quoted and quotes doubled). Output starts with a UTF-8 BOM so
 * spreadsheet applications detect the encoding.
 *
 * Text cells that a spreadsheet would interpret as a formula (leading `=`, `+`, `-`, `@`, tab or CR)
 * are prefixed with an apostrophe (OWASP "CSV injection" guidance). Numbers are written as numbers.
 */
import type { EventDTO } from '@sp/shared';

export const EVENTS_CSV_COLUMNS = [
  'id',
  'type',
  'category',
  'severity',
  'title',
  'observation',
  'startedAt',
  'endedAt',
  'durationSec',
  'confidence',
  'reviewStatus',
  'reviewedBy',
  'deliveredLate',
  'evidenceCount',
] as const;

export const CSV_BOM = '﻿';

type Cell = string | number | boolean | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;

/** Escape one CSV cell. */
export function csvCell(value: Cell): string {
  if (value == null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  let s = value;
  if (FORMULA_START.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRow(cells: Cell[]): string {
  return cells.map(csvCell).join(',');
}

const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
const round = (v: number | null, digits: number) => (v == null ? null : Math.round(v * 10 ** digits) / 10 ** digits);

export function eventCsvCells(e: EventDTO): Cell[] {
  return [
    e.id,
    e.type,
    e.category,
    e.severity,
    e.title,
    e.observation,
    iso(e.startedAt),
    iso(e.endedAt),
    e.durationMs == null ? null : round(e.durationMs / 1000, 3),
    round(e.confidence, 4),
    e.review.status,
    e.review.byName ?? e.review.by,
    e.deliveredLate,
    e.evidence.length,
  ];
}

/** Full CSV document (BOM + header + one row per event, CRLF-terminated). */
export function eventsToCsv(events: EventDTO[]): string {
  const lines = [csvRow([...EVENTS_CSV_COLUMNS]), ...events.map((e) => csvRow(eventCsvCells(e)))];
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

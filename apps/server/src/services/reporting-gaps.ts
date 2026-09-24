/**
 * Reporting outages that were never shown to have been observed.
 *
 * `reporting_interrupted` (opened by the sweeper when an active exam's browser stops heartbeating, starting at the
 * last heartbeat) only says the server stopped hearing from the candidate's browser. Whether that time was
 * nevertheless observed is known only afterwards:
 *  - the same browser came back (details.closedBy 'heartbeat_resumed'): it kept its monitoring state and its
 *    outbox delivers what it captured meanwhile, with the original timestamps -> observed;
 *  - something the browser captured during the outage reached the server late (a client event, a screenshot, an
 *    identity sample) -> observed;
 *  - otherwise — the exam ended while the browser was gone ('session_end'), another browser took over
 *    ('reconnected'), or the outage is still going on — nothing shows that monitoring ran: that time is NOT
 *    observed (unknown) and must not be reported as monitoring.
 *
 * finalizeSession() materialises such a gap as a 'disconnected' period (reason `browser_not_returned`), mirroring
 * the retroactive 'disconnected' period a reconnect check inserts (checks.ts closeGapPeriods). The report
 * (reports.ts) derives the same split for sessions whose gap was not materialised (still ongoing, older data).
 */
import type { PeriodDTO } from '@sp/shared';
import { and, eq, gte, inArray, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db/index.js';
import { events, evidence, identityChecks } from '../db/schema.js';

/** A client capture that reaches the server later than this after it happened was delivered late (outbox). */
export const LATE_DELIVERY_MS = 30_000;

/** The only way an outage is closed by the SAME browser coming back (candidate-actions.ts heartbeat). */
export const OUTAGE_RESUMED_BY = 'heartbeat_resumed';

/** Period reason of a materialised gap: the browser stopped reporting and did not come back before the end. */
export const GAP_NOT_RETURNED = 'browser_not_returned';
/** Report-only reason: the browser stopped reporting and nothing from that time ever arrived (ongoing, or older data). */
export const GAP_NOT_REPORTING = 'browser_not_reporting';

const CLIENT_SOURCES = ['client_browser', 'client_vision'] as const;

export interface Span {
  start: number;
  end: number;
}

/**
 * What the candidate's browser captured that reached the server late, as time spans: client events (their
 * extent), event screenshots and identity samples (the capture instant). `within`: only captures overlapping it.
 */
export async function loadLateCaptures(db: DbOrTx, sessionId: string, within?: Span): Promise<Span[]> {
  const late = sql.raw(String(LATE_DELIVERY_MS));
  const evWindow: SQL[] = within ? [lte(events.startedAt, new Date(within.end)), or(isNull(events.endedAt), gte(events.endedAt, new Date(within.start)))!] : [];
  // Sequential: `db` may be a transaction (one connection).
  const evRows = await db
    .select({ startedAt: events.startedAt, endedAt: events.endedAt })
    .from(events)
    .where(and(eq(events.sessionId, sessionId), eq(events.deliveredLate, true), inArray(events.source, [...CLIENT_SOURCES]), ...evWindow));
  const shotRows = await db
    .select({ at: evidence.capturedAt })
    .from(evidence)
    .where(
      and(
        eq(evidence.sessionId, sessionId),
        eq(evidence.kind, 'event_screenshot'),
        sql`${evidence.createdAt} - ${evidence.capturedAt} > (${late} * interval '1 millisecond')`,
        ...(within ? [gte(evidence.capturedAt, new Date(within.start)), lte(evidence.capturedAt, new Date(within.end))] : []),
      ),
    );
  const sampleRows = await db
    .select({ at: identityChecks.at })
    .from(identityChecks)
    .where(
      and(
        eq(identityChecks.sessionId, sessionId),
        isNotNull(identityChecks.sampleId),
        sql`${identityChecks.receivedAt} - ${identityChecks.at} > (${late} * interval '1 millisecond')`,
        ...(within ? [gte(identityChecks.at, new Date(within.start)), lte(identityChecks.at, new Date(within.end))] : []),
      ),
    );
  return [
    ...evRows.map((r) => ({ start: r.startedAt.getTime(), end: (r.endedAt ?? r.startedAt).getTime() })),
    ...shotRows.map((r) => ({ start: r.at.getTime(), end: r.at.getTime() })),
    ...sampleRows.map((r) => ({ start: r.at.getTime(), end: r.at.getTime() })),
  ];
}

/** Late captures that happened inside the outage (after its start, not after its end). */
export function capturesWithin(late: Span[], outage: Span): Span[] {
  return late.filter((l) => l.end > outage.start && l.start <= outage.end);
}

export interface OutageLike {
  id: string;
  startedAt: number;
  endedAt: number | null;
  details: Record<string, unknown>;
}

export interface UnobservedOutage {
  eventId: string;
  start: number;
  /** Clipped to `endAt` while the outage is still going on. */
  end: number;
  ongoing: boolean;
  closedBy: string | null;
}

/**
 * The reporting outages nothing shows to have been observed: not closed by the same browser coming back, and
 * nothing captured during them was delivered late. `endAt`: end of the session (or now).
 */
export function unobservedOutages(outages: OutageLike[], late: Span[], endAt: number): UnobservedOutage[] {
  const out: UnobservedOutage[] = [];
  for (const e of outages) {
    const closedBy = typeof e.details?.closedBy === 'string' ? e.details.closedBy : null;
    if (e.endedAt != null && closedBy === OUTAGE_RESUMED_BY) continue;
    const span = { start: e.startedAt, end: Math.min(e.endedAt ?? endAt, endAt) };
    if (span.end <= span.start) continue;
    if (capturesWithin(late, span).length) continue;
    out.push({ eventId: e.id, start: span.start, end: span.end, ongoing: e.endedAt == null, closedBy });
  }
  return out;
}

/**
 * The periods with the unobserved outages cut out of the 'active' periods: each overlap becomes a 'disconnected'
 * (unobserved) period, so the list stays chronological and non-overlapping (the report's totals, bar and table all
 * read it). Other kinds are untouched (paused / on hold / disconnected are unobserved already; check periods run
 * with the browser present). Ids: the first piece of a split period keeps its id.
 */
export function withUnobservedOutages(periods: PeriodDTO[], outages: UnobservedOutage[]): PeriodDTO[] {
  if (!outages.length) return periods;
  const out: PeriodDTO[] = [];
  for (const p of periods) {
    if (p.kind !== 'active') {
      out.push(p);
      continue;
    }
    const pEnd = p.endedAt ?? Number.POSITIVE_INFINITY;
    const cuts = outages
      .map((o) => ({ o, a: Math.max(p.startedAt, o.start), b: Math.min(pEnd, o.end) }))
      .filter((c) => c.b > c.a)
      .sort((x, y) => x.a - y.a);
    if (!cuts.length) {
      out.push(p);
      continue;
    }
    let cursor = p.startedAt;
    let pieces = 0;
    let stillOpen = false;
    const activePiece = (from: number, to: number | null) => {
      out.push({ ...p, id: pieces === 0 ? p.id : `${p.id}~${pieces}`, startedAt: from, endedAt: to });
      pieces++;
    };
    for (const c of cuts) {
      const a = Math.max(c.a, cursor);
      if (c.b <= a) continue;
      if (a > cursor) activePiece(cursor, a);
      // An ongoing outage that reaches the end of an open period stays open (the browser is still gone).
      const open = c.o.ongoing && p.endedAt == null && c.b >= c.o.end;
      out.push({
        id: `outage:${c.o.eventId}:${p.id}`,
        kind: 'disconnected',
        observed: false,
        startedAt: a,
        endedAt: open ? null : c.b,
        reason: c.o.closedBy === 'session_end' ? GAP_NOT_RETURNED : GAP_NOT_REPORTING,
        meta: { derivedFrom: 'reporting_interrupted', eventId: c.o.eventId, closedBy: c.o.closedBy },
      });
      cursor = c.b;
      if (open) {
        stillOpen = true;
        break;
      }
    }
    if (!stillOpen && (p.endedAt == null || cursor < p.endedAt)) activePiece(cursor, p.endedAt);
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

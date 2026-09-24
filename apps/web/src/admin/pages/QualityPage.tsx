import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CATEGORY_LABELS, EVENT_CATEGORIES, IDENTITY_DECISIONS, type DetectionQualityDTO } from '@sp/shared';
import { api, shouldRetry } from '../api/client';
import { qk } from '../api/queries';
import { formatDate, formatPercent, humanizeKey } from '../lib/format';
import { DECISION_LABELS, eventTypeTitle, TRIGGER_LABELS } from '../lib/labels';
import { CategoryBadge, DecisionBadge } from '../components/Badges';
import { EmptyState, ErrorState, KeyValueTable, Loading, PageHeader } from '../components/Common';

const RANGES = [
  { id: '7', label: 'Last 7 days', days: 7 },
  { id: '30', label: 'Last 30 days', days: 30 },
  { id: '90', label: 'Last 90 days', days: 90 },
  { id: 'all', label: 'All time', days: null },
] as const;

/** Minimum reviewer decisions before a precision figure is shown without a caveat. */
const MIN_DECISIONS = 10;

export function QualityPage() {
  const [range, setRange] = useState<(typeof RANGES)[number]['id']>('30');
  const params = useMemo(() => {
    const r = RANGES.find((x) => x.id === range)!;
    // Round to the hour so the query key is stable across renders.
    const to = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
    return r.days ? { from: to - r.days * 86_400_000, to } : {};
  }, [range]);
  const q = useQuery({ queryKey: qk.quality(params), queryFn: () => api.detectionQuality(params), retry: shouldRetry, placeholderData: keepPreviousData });

  return (
    <div className="stack quality-page">
      <PageHeader
        title="Detection quality"
        subtitle="How reliable each detector has been in practice, measured from reviewer decisions."
        actions={
          <select aria-label="Time range" value={range} onChange={(e) => setRange(e.target.value as typeof range)}>
            {RANGES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        }
      />
      <div className="guidance">
        <div className="guidance-title">How accuracy is measured</div>
        <p>
          <strong>In production</strong>, every non-neutral event is reviewed by staff as <em>reviewed</em> (the observation was correct) or <em>dismissed</em> (false
          positive). For each detector, the precision proxy is <code>reviewed ÷ (reviewed + dismissed)</code>. It only covers events that were raised — it cannot show
          missed detections — and is only meaningful once enough events have been reviewed.
        </p>
        <p>
          <strong>Person-swap detection</strong> is tracked separately: how many “possible different person” events reviewers confirmed versus dismissed (false
          identity mismatches), and how identity checks were decided for each trigger (resume, face return, camera reconnect…). “Could not verify” decisions are
          image-quality outcomes and are never counted as mismatches.
        </p>
        <p>
          <strong>Offline evaluation</strong> measures false match / false non-match / unable-to-verify rates on a labelled dataset across lighting, cameras, glasses,
          hairstyles, clothing, backgrounds and pause lengths, and replays labelled scenarios through the behaviour detectors (precision, recall, false alerts per hour).
          See <code>docs/accuracy/</code> and <code>docs/ARCHITECTURE.md</code> §9 for the methodology.
        </p>
      </div>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : <QualityBody d={q.data} />}
    </div>
  );
}

function QualityBody({ d }: { d: DetectionQualityDTO }) {
  const rows = [...d.byType].sort((a, b) => EVENT_CATEGORIES.indexOf(a.category) - EVENT_CATEGORIES.indexOf(b.category) || b.total - a.total);
  const idDecided = d.identity.mismatchEventsConfirmed + d.identity.mismatchEventsDismissed;
  const triggers = Object.keys(d.identity.byTrigger).sort();
  return (
    <>
      <div className="muted small">
        Period: {d.from ? formatDate(d.from) : 'start'} – {formatDate(d.to)}
      </div>
      <section className="card stack">
        <h2>Per-detector results</h2>
        {rows.length === 0 ? (
          <EmptyState title="No events in this period" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Detector / event type</th>
                  <th>Category</th>
                  <th>Total</th>
                  <th>Confirmed (reviewed)</th>
                  <th>Dismissed</th>
                  <th>Unreviewed</th>
                  <th>Precision proxy</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const decided = r.reviewed + r.dismissed;
                  return (
                    <tr key={r.type}>
                      <td>{eventTypeTitle(r.type)}</td>
                      <td>
                        <CategoryBadge category={r.category} />
                      </td>
                      <td>{r.total}</td>
                      <td>{r.reviewed}</td>
                      <td>{r.dismissed}</td>
                      <td>{r.unreviewed}</td>
                      <td>
                        {r.precision == null ? (
                          <span className="muted small">no decisions yet</span>
                        ) : (
                          <span className="precision">
                            <span className="confidence-track" aria-hidden>
                              <span className="confidence-fill" style={{ width: `${Math.round(r.precision * 100)}%` }} />
                            </span>
                            {formatPercent(r.precision)}
                            {decided < MIN_DECISIONS ? <span className="muted small"> (only {decided} reviewed)</span> : null}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="muted small">Neutral session changes ({CATEGORY_LABELS.neutral.toLowerCase()}s) are not reviewed and have no precision.</div>
      </section>

      <div className="grid-2">
        <section className="card stack">
          <h2>Possible different person — reviewer outcomes</h2>
          <div className="stats-row">
            <div className="stat stat-danger">
              <div className="stat-value">{d.identity.mismatchEventsConfirmed}</div>
              <div className="stat-label">Confirmed by reviewers</div>
            </div>
            <div className="stat">
              <div className="stat-value">{d.identity.mismatchEventsDismissed}</div>
              <div className="stat-label">Dismissed (false mismatch)</div>
            </div>
            <div className="stat">
              <div className="stat-value">{idDecided ? formatPercent(d.identity.mismatchEventsDismissed / idDecided) : '—'}</div>
              <div className="stat-label">False-mismatch share</div>
            </div>
          </div>
          <div className="muted small">
            Share of reviewed “possible different person” events that reviewers dismissed. A high share suggests thresholds or capture conditions need attention.
          </div>
        </section>
        <section className="card stack">
          <h2>Identity decisions ({d.identity.checks} checks)</h2>
          <div className="row">
            {IDENTITY_DECISIONS.map((dec) => (
              <span key={dec} className="decision-count">
                <DecisionBadge decision={dec} /> <strong>{d.identity.byDecision[dec] ?? 0}</strong>
              </span>
            ))}
          </div>
        </section>
      </div>

      <section className="card stack">
        <h2>Identity decisions by trigger</h2>
        {triggers.length === 0 ? (
          <div className="muted">No identity checks in this period.</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Trigger</th>
                  {IDENTITY_DECISIONS.map((dec) => (
                    <th key={dec}>{DECISION_LABELS[dec]}</th>
                  ))}
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {triggers.map((t) => {
                  const row = d.identity.byTrigger[t] ?? {};
                  const total = IDENTITY_DECISIONS.reduce((n, dec) => n + (row[dec] ?? 0), 0);
                  return (
                    <tr key={t}>
                      <td>{(TRIGGER_LABELS as Record<string, string>)[t] ?? humanizeKey(t)}</td>
                      {IDENTITY_DECISIONS.map((dec) => (
                        <td key={dec}>
                          {row[dec] ?? 0}
                          {total > 0 && (row[dec] ?? 0) > 0 ? <span className="muted small"> ({formatPercent((row[dec] ?? 0) / total)})</span> : null}
                        </td>
                      ))}
                      <td>{total}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card stack">
        <h2>Offline evaluation</h2>
        {d.offlineEvaluation == null ? (
          <div className="muted">
            No offline evaluation report has been stored yet. Run <code>pnpm --filter @sp/server eval:identity</code> against a consented, labelled dataset to measure
            false match / false non-match rates per condition before launch.
          </div>
        ) : (
          <OfflineEvaluation value={d.offlineEvaluation} />
        )}
      </section>
    </>
  );
}

/** Renders an arbitrary evaluation report: scalars as key/values, arrays of objects as tables. */
function OfflineEvaluation({ value }: { value: unknown }) {
  if (value == null || typeof value !== 'object') return <div>{String(value)}</div>;
  const entries = Object.entries(value as Record<string, unknown>);
  const scalars = Object.fromEntries(entries.filter(([, v]) => v === null || typeof v !== 'object' || (Array.isArray(v) && v.every((x) => typeof x !== 'object'))));
  const tables = entries.filter(([, v]) => Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) as [string, Record<string, unknown>[]][];
  const objects = entries.filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v)) as [string, Record<string, unknown>][];
  return (
    <div className="stack">
      {Object.keys(scalars).length ? <KeyValueTable data={scalars} /> : null}
      {objects.map(([k, v]) => (
        <div key={k}>
          <h4>{humanizeKey(k)}</h4>
          <OfflineEvaluation value={v} />
        </div>
      ))}
      {tables.map(([k, rows]) => {
        const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
        return (
          <div key={k} className="table-wrap">
            <h4>{humanizeKey(k)}</h4>
            <table className="table compact">
              <thead>
                <tr>
                  {cols.map((c) => (
                    <th key={c}>{humanizeKey(c)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    {cols.map((c) => (
                      <td key={c}>{formatCell(c, r[c])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      <details>
        <summary className="small">Raw report</summary>
        <pre className="kv-json">{JSON.stringify(value, null, 2)}</pre>
      </details>
    </div>
  );
}

function formatCell(key: string, v: unknown): string {
  if (typeof v === 'number') {
    if (/(rate|fmr|fnmr|precision|recall|share)/i.test(key) && v >= 0 && v <= 1) return formatPercent(v, 1);
    return Number.isInteger(v) ? String(v) : v.toFixed(3);
  }
  if (v == null) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CATEGORY_LABELS, EVENT_CATEGORIES, IDENTITY_DECISIONS, RESOLUTION_INFO, type DetectionQualityDTO, type ReviewResolution } from '@sp/shared';
import { api, shouldRetry } from '../api/client';
import { qk } from '../api/queries';
import { formatDate, formatPercent, humanizeKey } from '../lib/format';
import { DECISION_LABELS, eventTypeTitle, TRIGGER_LABELS } from '../lib/labels';
import { CategoryBadge, DecisionBadge } from '../components/Badges';
import { EmptyState, ErrorState, Loading, PageHeader } from '../components/Common';
import { OfflineEvaluationSection } from './OfflineEvaluation';
import { CalibrationPanel, DecisionConfigPanel, DriftPanel } from './QualityGovernance';

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
          <strong>In production</strong>, reviewers decide every flag with a conclusion: an integrity concern, accurate but no concern, covered by an accommodation, a
          technical problem, inconclusive, or a false detection. For each detector, the precision proxy is <code>correct ÷ (correct + false detections)</code> —
          “inconclusive” decisions are left out, since the reviewer could not tell. It only covers events that were raised — it cannot show missed detections — and is
          only meaningful once enough events have been decided. When one reviewer changes another’s decision, it counts as a disagreement.
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
        <p>
          <strong>Governance</strong>: identity decisions are broken down by capture conditions and by the versions that made them (decision configuration,
          calibration, recogniser model); drift compares the last week with the four weeks before. The identity thresholds themselves are versioned: changed only
          through a proposal approved by a second administrator, and restorable at once.
        </p>
      </div>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : <QualityBody d={q.data} />}
      <CalibrationPanel from={params.from ?? 0} to={params.to} />
      <DriftPanel />
      <DecisionConfigPanel />
    </div>
  );
}

/** "Integrity concern 3, Accurate, no concern 5" for a tooltip. */
function resolutionBreakdown(byResolution: DetectionQualityDTO['byType'][number]['byResolution']): string {
  const parts = Object.entries(byResolution).map(([k, n]) => `${RESOLUTION_INFO[k as ReviewResolution].label}: ${n}`);
  return parts.length ? parts.join(', ') : 'No structured conclusions yet';
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
                  <th>Kept (reviewed)</th>
                  <th>Inconclusive</th>
                  <th>False detections</th>
                  <th>Undecided</th>
                  <th>Disagreements</th>
                  <th>Precision proxy</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const decided = r.reviewed - r.inconclusive + r.dismissed;
                  return (
                    <tr key={r.type}>
                      <td>{eventTypeTitle(r.type)}</td>
                      <td>
                        <CategoryBadge category={r.category} />
                      </td>
                      <td>{r.total}</td>
                      <td title={resolutionBreakdown(r.byResolution)}>{r.reviewed}</td>
                      <td>{r.inconclusive}</td>
                      <td>{r.dismissed}</td>
                      <td>{r.unreviewed}</td>
                      <td>{r.overridden || <span className="muted">0</span>}</td>
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
        <div className="muted small">Session changes and policy exceptions (pauses, resumes, camera changes, accommodations…) are not reviewed and have no precision.</div>
        <div className="small" data-testid="reviewer-agreement">
          <strong>Reviewer agreement:</strong> {d.reviewers.decisions} decision{d.reviewers.decisions === 1 ? '' : 's'} in this period,{' '}
          {d.reviewers.overrides} changed another reviewer’s decision
          {d.reviewers.overrideRate != null ? ` (${formatPercent(d.reviewers.overrideRate, 1)})` : ''}. Frequent changes for one detector suggest its guidance or thresholds need
          attention.
        </div>
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

      <OfflineEvaluationSection value={d.offlineEvaluation} />
    </>
  );
}

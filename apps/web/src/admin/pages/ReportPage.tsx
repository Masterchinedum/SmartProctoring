import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CATEGORY_LABELS, EVENT_CATEGORIES, type SessionReportDTO } from '@sp/shared';
import { api, shouldRetry } from '../api/client';
import { qk } from '../api/queries';
import { formatDateTime, formatDuration, formatPercent, formatSimilarity, formatTime } from '../lib/format';
import { DECISION_LABELS, END_REASON_LABELS, PERIOD_LABELS, STATUS_LABELS } from '../lib/labels';
import { CategoryBadge, DecisionBadge, ReviewBadge, SeverityBadge } from '../components/Badges';
import { ErrorState, Loading } from '../components/Common';
import { EvidenceImage } from '../components/EvidenceImage';

export function ReportPage() {
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: qk.report(id), queryFn: () => api.sessionReport(id), retry: shouldRetry });
  if (q.isPending) return <Loading label="Generating report…" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return <Report r={q.data} sessionId={id} onRefresh={() => void q.refetch()} refreshing={q.isFetching} />;
}

function Report({ r, sessionId, onRefresh, refreshing }: { r: SessionReportDTO; sessionId: string; onRefresh: () => void; refreshing: boolean }) {
  const t = r.totals;
  const s = r.session;
  const observedPct = t.wallClockMs > 0 ? t.observedMs / t.wallClockMs : 0;
  const periods = [...r.periods].sort((a, b) => a.startedAt - b.startedAt);
  return (
    <article className="report">
      <div className="report-toolbar no-print">
        <Link to={`/admin/sessions/${sessionId}`}>← Back to session</Link>
        <div className="spacer" />
        <button type="button" className="btn" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>
          Print / Save as PDF
        </button>
      </div>

      <header className="report-header">
        <div>
          <div className="report-kicker">Exam session report</div>
          <h1>{r.candidate.name}</h1>
          <div>
            {r.exam.title} · allotted {formatDuration(r.exam.durationSec * 1000)}
          </div>
          <div className="muted small">
            {r.candidate.email ? <>{r.candidate.email} · </> : null}
            {r.candidate.externalId ? <>Candidate ID {r.candidate.externalId} · </> : null}
            Session {s.id}
          </div>
        </div>
        <div className="report-meta small">
          <div>
            Status: <strong>{STATUS_LABELS[s.status]}</strong>
            {s.endReason ? <> — {END_REASON_LABELS[s.endReason]}</> : null}
          </div>
          <div>Started: {formatDateTime(s.startedAt)}</div>
          <div>Ended: {formatDateTime(s.endedAt)}</div>
          <div>Report generated: {formatDateTime(r.generatedAt)}</div>
        </div>
      </header>

      <div className="report-disclaimer small">
        This report lists observations made by automated proctoring for human review. It does not determine that misconduct occurred. Unobserved periods (pauses,
        disconnections, holds) carry no observations.
      </div>

      <section className="report-section">
        <h2>Summary</h2>
        <div className="report-totals">
          <Total label="Wall-clock time" value={formatDuration(t.wallClockMs)} />
          <Total label="Observed" value={formatDuration(t.observedMs)} sub={formatPercent(observedPct)} />
          <Total label="Unobserved" value={formatDuration(t.unobservedMs)} sub={formatPercent(t.wallClockMs > 0 ? t.unobservedMs / t.wallClockMs : 0)} />
          <Total label="Active" value={formatDuration(t.activeMs)} />
          <Total label="Paused" value={formatDuration(t.pausedMs)} sub={`${t.pauseCount} pause${t.pauseCount === 1 ? '' : 's'}`} />
          <Total label="Disconnected" value={formatDuration(t.disconnectedMs)} />
          <Total label="On hold" value={formatDuration(t.heldMs)} />
          <Total label="Exam time used" value={formatDuration(t.examTimeUsedMs)} sub={`of ${formatDuration(r.exam.durationSec * 1000)}`} />
          {r.score ? (
            <Total
              label="Score"
              value={`${r.score.points} / ${r.score.maxPoints}`}
              sub={r.score.autoGraded ? 'auto-graded' : 'includes manually graded questions'}
            />
          ) : null}
        </div>
        <div className="observed-bar" aria-label={`Observed ${formatPercent(observedPct)} of wall-clock time`}>
          {periods.map((p) => {
            const w = t.wallClockMs > 0 ? (((p.endedAt ?? r.generatedAt) - p.startedAt) / t.wallClockMs) * 100 : 0;
            return <span key={p.id} className={`ob-seg ob-${p.kind}${p.observed ? ' observed' : ' unobserved'}`} style={{ width: `${Math.max(0, w)}%` }} title={`${PERIOD_LABELS[p.kind]} ${formatTime(p.startedAt)}–${formatTime(p.endedAt)}`} />;
          })}
        </div>
        <div className="small muted observed-legend">
          <span className="legend-swatch observed" /> observed <span className="legend-swatch unobserved" /> unobserved
        </div>
      </section>

      <section className="report-section">
        <h2>Periods (every active period, pause and resume)</h2>
        {periods.length === 0 ? (
          <div className="muted">No periods recorded.</div>
        ) : (
          <table className="table compact">
            <thead>
              <tr>
                <th>#</th>
                <th>Period</th>
                <th>Monitoring</th>
                <th>Start</th>
                <th>End</th>
                <th>Duration</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {periods.map((p, i) => (
                <tr key={p.id} className={p.observed ? '' : 'row-unobserved'}>
                  <td>{i + 1}</td>
                  <td>
                    <strong>{PERIOD_LABELS[p.kind]}</strong>
                  </td>
                  <td>{p.observed ? 'Observed' : 'Unobserved'}</td>
                  <td>{formatDateTime(p.startedAt)}</td>
                  <td>{p.endedAt ? formatDateTime(p.endedAt) : 'ongoing'}</td>
                  <td>{formatDuration((p.endedAt ?? r.generatedAt) - p.startedAt)}</td>
                  <td>{p.reason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="report-section">
        <h2>Identity</h2>
        <p>{r.identity.summary}</p>
        <table className="table compact report-identity">
          <tbody>
            <tr>
              <th>Reference established</th>
              <td>{formatDateTime(r.identity.referenceCreatedAt)}</td>
            </tr>
            <tr>
              <th>Identity checks</th>
              <td>{r.identity.checks}</td>
            </tr>
            <tr>
              <th>{DECISION_LABELS.match}</th>
              <td>{r.identity.matches}</td>
            </tr>
            <tr>
              <th>{DECISION_LABELS.mismatch}</th>
              <td>{r.identity.mismatches}</td>
            </tr>
            <tr>
              <th>{DECISION_LABELS.inconclusive}</th>
              <td>{r.identity.inconclusive}</td>
            </tr>
            <tr>
              <th>{DECISION_LABELS.unable_to_verify}</th>
              <td>
                {r.identity.unableToVerify} <span className="muted small">(not evidence of a different person)</span>
              </td>
            </tr>
            <tr>
              <th>ID photo comparison</th>
              <td>
                {r.identity.idPhoto ? (
                  <>
                    <DecisionBadge decision={r.identity.idPhoto.decision} />{' '}
                    {r.identity.idPhoto.similarity != null ? `similarity ${formatSimilarity(r.identity.idPhoto.similarity)}` : ''}
                  </>
                ) : (
                  'Not performed'
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="report-section">
        <h2>Events by category</h2>
        <table className="table compact">
          <thead>
            <tr>
              <th>Category</th>
              <th>Total</th>
              <th>Reviewed</th>
              <th>Dismissed (false positive)</th>
              <th>Unreviewed</th>
            </tr>
          </thead>
          <tbody>
            {EVENT_CATEGORIES.map((c) => {
              const v = r.eventCounts[c] ?? { total: 0, reviewed: 0, dismissed: 0, unreviewed: 0 };
              return (
                <tr key={c}>
                  <td>
                    <CategoryBadge category={c} /> <span className="small muted">{CATEGORY_LABELS[c]}</span>
                  </td>
                  <td>{v.total}</td>
                  <td>{c === 'neutral' ? '—' : v.reviewed}</td>
                  <td>{c === 'neutral' ? '—' : v.dismissed}</td>
                  <td>{c === 'neutral' ? '—' : v.unreviewed}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="report-section">
        <h2>Events by type</h2>
        {r.byType.length === 0 ? (
          <div className="muted">No events.</div>
        ) : (
          <table className="table compact">
            <thead>
              <tr>
                <th>Type</th>
                <th>Category</th>
                <th>Count</th>
                <th>Total duration</th>
                <th>Dismissed</th>
              </tr>
            </thead>
            <tbody>
              {[...r.byType]
                .sort((a, b) => EVENT_CATEGORIES.indexOf(a.category) - EVENT_CATEGORIES.indexOf(b.category) || b.count - a.count)
                .map((row) => (
                  <tr key={row.type}>
                    <td>{row.title}</td>
                    <td>
                      <CategoryBadge category={row.category} />
                    </td>
                    <td>{row.count}</td>
                    <td>{row.totalDurationMs ? formatDuration(row.totalDurationMs) : '—'}</td>
                    <td>{row.category === 'neutral' ? '—' : row.dismissed}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="report-section">
        <h2>Notable events</h2>
        {r.notableEvents.length === 0 ? (
          <div className="muted">No notable events.</div>
        ) : (
          <ol className="notable-list">
            {r.notableEvents.map((e) => (
              <li key={e.id} className={`notable notable-${e.category}`}>
                <div className="notable-body">
                  <div className="row tight">
                    <strong>{formatTime(e.startedAt)}</strong>
                    <CategoryBadge category={e.category} />
                    <SeverityBadge severity={e.severity} />
                    <strong>{e.title}</strong>
                    <ReviewBadge status={e.review.status} />
                  </div>
                  <div>{e.observation}</div>
                  <div className="small muted">
                    {e.durationMs != null ? <>Duration {formatDuration(e.durationMs)} · </> : e.endedAt == null ? <>Ongoing · </> : null}
                    {e.confidence != null ? <>confidence {formatPercent(e.confidence)} · </> : null}
                    {e.deliveredLate ? <>delivered late · </> : null}
                    {formatDateTime(e.startedAt)}
                  </div>
                  {e.review.note ? (
                    <div className="small">
                      Reviewer ({e.review.byName ?? 'staff'}): <q>{e.review.note}</q>
                    </div>
                  ) : null}
                </div>
                <div className="notable-images">
                  {e.evidence.slice(0, 2).map((ev) => (
                    <EvidenceImage key={ev.id} evidence={ev} size="small" />
                  ))}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="report-section">
        <h2>Observations</h2>
        {r.observations.length ? (
          <ul>
            {r.observations.map((o, i) => (
              <li key={i}>{o}</li>
            ))}
          </ul>
        ) : (
          <div className="muted">No observations.</div>
        )}
      </section>

      <section className="report-section">
        <h2>Reviewer notes</h2>
        {r.reviewerNotes.length ? (
          <ul className="notes">
            {[...r.reviewerNotes]
              .sort((a, b) => a.createdAt - b.createdAt)
              .map((n) => (
                <li key={n.id} className="note">
                  <div className="note-meta">
                    <strong>{n.authorName}</strong> · {formatDateTime(n.createdAt)}
                    {n.eventId ? ' · on an event' : ''}
                  </div>
                  <div className="note-text">{n.text}</div>
                </li>
              ))}
          </ul>
        ) : (
          <div className="muted">No reviewer notes.</div>
        )}
      </section>

      <section className="report-section">
        <h2>Limitations</h2>
        <ul className="small">
          {r.limitations.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </section>
    </article>
  );
}

function Total({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="total">
      <div className="total-value">{value}</div>
      <div className="total-label">{label}</div>
      {sub ? <div className="total-sub muted small">{sub}</div> : null}
    </div>
  );
}

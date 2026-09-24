import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { SESSION_STATUSES } from '@sp/shared';
import { api, shouldRetry } from '../api/client';
import { qk } from '../api/queries';
import { formatSimilarity } from '../lib/format';
import { STATUS_LABELS } from '../lib/labels';
import { CategoryCounts, ConnectionBadge, DecisionBadge, StatusBadge } from '../components/Badges';
import { EmptyState, ErrorState, Loading, PageHeader, Pager } from '../components/Common';
import { Countdown, RelativeTime, TimeOfDay } from '../components/Time';

const LIMIT = 50;

export function SessionsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const status = params.get('status') ?? '';
  const examId = params.get('examId') ?? '';
  const connection = params.get('connection') ?? '';
  const qParam = params.get('q') ?? '';
  const offset = Number(params.get('offset') ?? 0) || 0;
  const [search, setSearch] = useState(qParam);

  // Debounce the search box into the URL.
  useEffect(() => {
    if (search === qParam) return;
    const t = setTimeout(() => update({ q: search, offset: '' }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  const listParams = { status, examId, connection, q: qParam, limit: LIMIT, offset };
  const q = useQuery({
    queryKey: qk.sessions(listParams),
    queryFn: () => api.sessions(listParams),
    placeholderData: keepPreviousData,
    retry: shouldRetry,
    refetchInterval: 30_000,
  });
  const exams = useQuery({ queryKey: qk.exams, queryFn: api.exams, retry: shouldRetry, staleTime: 60_000 });
  const receivedAt = q.dataUpdatedAt || Date.now();

  return (
    <div className="stack">
      <PageHeader title="Sessions" subtitle="Every exam session, with live status. Open a session for its timeline, evidence and report." />
      <div className="filter-bar">
        <input type="text" placeholder="Search candidate name, email or ID…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" className="grow" />
        <select aria-label="Status" value={status} onChange={(e) => update({ status: e.target.value, offset: '' })}>
          <option value="">All statuses</option>
          {SESSION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <select aria-label="Exam" value={examId} onChange={(e) => update({ examId: e.target.value, offset: '' })}>
          <option value="">All exams</option>
          {exams.data?.items.map((x) => (
            <option key={x.id} value={x.id}>
              {x.title}
            </option>
          ))}
        </select>
        <select aria-label="Connection" value={connection} onChange={(e) => update({ connection: e.target.value, offset: '' })}>
          <option value="">Any connection</option>
          <option value="online">Online</option>
          <option value="offline">Disconnected</option>
          <option value="never_connected">Not connected yet</option>
        </select>
      </div>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <EmptyState title="No sessions found">{status || examId || connection || qParam ? 'Try clearing the filters.' : 'Assign candidates to an exam to create sessions.'}</EmptyState>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table table-clickable">
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th>Exam</th>
                  <th>Status</th>
                  <th>Started</th>
                  <th>Remaining</th>
                  <th>Pauses</th>
                  <th>Flags</th>
                  <th>Unreviewed</th>
                  <th>Last identity check</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((s) => (
                  <tr key={s.id} onClick={() => navigate(`/admin/sessions/${s.id}`)}>
                    <td>
                      <Link to={`/admin/sessions/${s.id}`} onClick={(e) => e.stopPropagation()}>
                        <strong>{s.candidate.name}</strong>
                      </Link>
                      <div className="muted small">{s.candidate.email ?? s.candidate.externalId ?? ''}</div>
                    </td>
                    <td>{s.exam.title}</td>
                    <td>
                      <div className="row tight">
                        <StatusBadge status={s.status} />
                        {s.status !== 'submitted' && s.status !== 'terminated' ? <ConnectionBadge connection={s.connection} /> : null}
                      </div>
                      {s.reportingInterruptedSince ? (
                        <div className="text-danger small">
                          Reporting interrupted <RelativeTime at={s.reportingInterruptedSince} prefix="since " />
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <TimeOfDay at={s.startedAt} />
                    </td>
                    <td>
                      {s.status === 'submitted' || s.status === 'terminated' ? (
                        <span className="muted">—</span>
                      ) : (
                        <Countdown remainingMs={s.remainingMs} timerRunning={s.timerRunning} receivedAt={receivedAt} />
                      )}
                    </td>
                    <td>{s.pauseCount}</td>
                    <td>
                      <CategoryCounts counts={s.counts} compact />
                    </td>
                    <td>{s.counts.unreviewed > 0 ? <span className="badge badge-warning">{s.counts.unreviewed}</span> : <span className="muted">0</span>}</td>
                    <td>
                      {s.identity.lastDecision ? (
                        <>
                          <DecisionBadge decision={s.identity.lastDecision} />
                          <div className="muted small">
                            <RelativeTime at={s.identity.lastAt} />
                            {s.identity.lastSimilarity != null ? ` · ${formatSimilarity(s.identity.lastSimilarity)}` : ''}
                          </div>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager total={q.data.total} limit={LIMIT} offset={offset} onChange={(o) => update({ offset: o ? String(o) : '' })} />
        </>
      )}
    </div>
  );
}

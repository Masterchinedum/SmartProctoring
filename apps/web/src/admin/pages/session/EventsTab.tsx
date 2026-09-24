import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, shouldRetry } from '../../api/client';
import { qk } from '../../api/queries';
import { eventMatches, presentTypes, sortEvents, type EventFilterState, type EventSortKey } from '../../lib/filters';
import { formatPercent } from '../../lib/format';
import { CategoryBadge, ReviewBadge, SeverityBadge } from '../../components/Badges';
import { EmptyState, ErrorState, Loading } from '../../components/Common';
import { EventFilterBar } from '../../components/EventFilterBar';
import { EvidenceImage } from '../../components/EvidenceImage';
import { Clock, LiveDuration } from '../../components/Time';

export function EventsTab({
  sessionId,
  filters,
  onFilters,
  onOpenEvent,
}: {
  sessionId: string;
  filters: EventFilterState;
  onFilters: (f: EventFilterState) => void;
  onOpenEvent: (id: string) => void;
}) {
  const q = useQuery({ queryKey: qk.sessionEvents(sessionId), queryFn: () => api.sessionEvents(sessionId), retry: shouldRetry });
  const [sort, setSort] = useState<{ key: EventSortKey; dir: 'asc' | 'desc' }>({ key: 'time', dir: 'asc' });
  const all = q.data?.items;
  const types = useMemo(() => presentTypes(all ?? []), [all]);
  const rows = useMemo(() => sortEvents((all ?? []).filter((e) => eventMatches(e, filters)), sort.key, sort.dir), [all, filters, sort]);

  if (q.isPending) return <Loading label="Loading events…" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;

  const header = (key: EventSortKey, label: string) => {
    const active = sort.key === key;
    return (
      <th aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button
          type="button"
          className="sort-btn"
          onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 'asc' ? 'desc' : 'asc') : key === 'time' ? 'asc' : 'desc' }))}
        >
          {label} {active ? (sort.dir === 'asc' ? '▲' : '▼') : <span className="muted">↕</span>}
        </button>
      </th>
    );
  };

  return (
    <div className="stack">
      <EventFilterBar filters={filters} onChange={onFilters} types={types} shown={rows.length} total={all?.length ?? 0} />
      {rows.length === 0 ? (
        <EmptyState title={all?.length ? 'No events match these filters' : 'No events recorded'} />
      ) : (
        <div className="table-wrap">
          <table className="table table-clickable events-table">
            <thead>
              <tr>
                {header('time', 'Started')}
                {header('type', 'Event')}
                {header('severity', 'Severity')}
                {header('duration', 'Duration')}
                <th>Confidence</th>
                <th>Review</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} onClick={() => onOpenEvent(e.id)} className={`row-cat-${e.category}`}>
                  <td className="nowrap">
                    <Clock at={e.startedAt} />
                  </td>
                  <td>
                    <div className="row tight">
                      <CategoryBadge category={e.category} />
                      <strong>{e.title}</strong>
                      {e.status === 'open' ? <span className="badge badge-warning">Ongoing</span> : null}
                      {e.deliveredLate ? <span className="badge badge-technical">Delivered late</span> : null}
                    </div>
                    <div className="muted small clamp-2">{e.observation}</div>
                  </td>
                  <td>
                    <SeverityBadge severity={e.severity} />
                  </td>
                  <td className="nowrap">{e.endedAt != null || e.status === 'open' ? <LiveDuration from={e.startedAt} to={e.endedAt} /> : <span className="muted">instant</span>}</td>
                  <td>{e.confidence != null ? formatPercent(e.confidence) : <span className="muted">n/a</span>}</td>
                  <td>
                    {e.category === 'neutral' ? <span className="muted small">n/a</span> : <ReviewBadge status={e.review.status} />}
                    {e.notesCount ? <div className="muted small">{e.notesCount} note(s)</div> : null}
                  </td>
                  <td>{e.evidence.length ? <EvidenceImage evidence={e.evidence[0]} size="thumb" alt="" /> : <span className="muted small">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

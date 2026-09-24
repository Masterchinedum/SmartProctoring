import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { AuditLogEntryDTO } from '@sp/shared';
import { api, shouldRetry } from '../api/client';
import { qk } from '../api/queries';
import { formatDateTime, formatDetailValue, humanizeKey } from '../lib/format';
import { describeDetailValue } from '../lib/labels';
import { EmptyState, ErrorState, Loading, PageHeader, Pager } from '../components/Common';

const LIMIT = 50;

/** Common audit actions offered as suggestions (the filter accepts any text). */
const COMMON_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'auth.password_changed',
  'candidate.consent',
  'candidate.created',
  'candidate.deleted',
  'candidate.id_photo_approved',
  'candidate.id_photo_rejected',
  'candidate.id_photo_removed',
  'candidate.updated',
  'event.review',
  'evidence.view',
  'exam.archived',
  'exam.assigned',
  'exam.created',
  'exam.published',
  'exam.updated',
  'metrics.offline_evaluation_uploaded',
  'note.created',
  'reference.re_enrolled',
  'retention.purge',
  'session.events_exported',
  'session.hold',
  'session.legal_hold_off',
  'session.legal_hold_on',
  'session.link_regenerated',
  'session.release',
  'session.release_reenroll_authorized',
  'session.staff_submit',
  'session.terminate',
  'session.time_extended',
  'settings.updated',
  'user.created',
  'user.updated',
];

export function AuditLogPage() {
  const [action, setAction] = useState('');
  const [debounced, setDebounced] = useState('');
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(action.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [action]);
  const params = { limit: LIMIT, offset, action: debounced || undefined };
  const q = useQuery({ queryKey: qk.audit(params), queryFn: () => api.auditLog(params), retry: shouldRetry, placeholderData: keepPreviousData });
  const seen = [...new Set([...(q.data?.items.map((i) => i.action) ?? []), ...COMMON_ACTIONS])].sort();

  return (
    <div className="stack">
      <PageHeader title="Audit log" subtitle="Every evidence view, review decision, hold, release, termination, re-enrolment, settings change and retention purge." />
      <div className="filter-bar">
        <input type="text" list="audit-actions" placeholder="Filter by action, e.g. evidence.view" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Action" />
        <datalist id="audit-actions">
          {seen.map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
        {action ? (
          <button type="button" className="btn btn-sm" onClick={() => setAction('')}>
            Clear
          </button>
        ) : null}
      </div>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <EmptyState title="No audit entries" />
      ) : (
        <>
          <div className="table-wrap">
            <table className="table audit-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Target</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap small">{formatDateTime(e.at)}</td>
                    <td>
                      {e.actorName ?? (e.actorType === 'system' ? 'System' : e.actorType === 'candidate' ? 'Candidate' : '—')}
                      <div className="muted small">{e.actorType}</div>
                    </td>
                    <td>
                      <code>{e.action}</code>
                    </td>
                    <td className="small">
                      <TargetLink e={e} />
                    </td>
                    <td className="small">
                      <AuditMeta meta={e.meta} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager total={q.data.total} limit={LIMIT} offset={offset} onChange={setOffset} />
        </>
      )}
    </div>
  );
}

function TargetLink({ e }: { e: AuditLogEntryDTO }) {
  const id = e.targetId;
  const sessionId = typeof e.meta.sessionId === 'string' ? e.meta.sessionId : null;
  let to: string | null = null;
  if (id && (e.targetType === 'session' || e.targetType === 'exam_session')) to = `/admin/sessions/${id}`;
  else if (id && e.targetType === 'exam') to = `/admin/exams/${id}`;
  else if (id && e.targetType === 'candidate') to = `/admin/candidates/${id}`;
  else if (id && e.targetType === 'event' && sessionId) to = `/admin/sessions/${sessionId}?event=${id}`;
  else if (sessionId) to = `/admin/sessions/${sessionId}`;
  return (
    <>
      {humanizeKey(e.targetType)}
      {id ? (
        <div className="mono muted" title={id}>
          {to ? <Link to={to}>{id.slice(0, 8)}…</Link> : `${id.slice(0, 8)}…`}
        </div>
      ) : null}
    </>
  );
}

function AuditMeta({ meta }: { meta: Record<string, unknown> }) {
  const entries = Object.entries(meta ?? {});
  if (!entries.length) return <span className="muted">—</span>;
  return (
    <span className="kv-inline">
      {entries.slice(0, 6).map(([k, v]) => (
        <span key={k}>
          <span className="muted">{humanizeKey(k)}:</span> {truncate(describeDetailValue(k, v) ?? formatDetailValue(k, v), 80)}
        </span>
      ))}
      {entries.length > 6 ? <span className="muted">+{entries.length - 6} more</span> : null}
    </span>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

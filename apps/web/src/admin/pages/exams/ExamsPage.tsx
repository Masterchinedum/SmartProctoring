import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ExamDTO } from '@sp/shared';
import { api, shouldRetry } from '../../api/client';
import { qk } from '../../api/queries';
import { useAuth } from '../../auth';
import { formatDateTime, formatDuration } from '../../lib/format';
import { EmptyState, ErrorState, Loading, PageHeader } from '../../components/Common';

export const EXAM_STATUS_CLASS: Record<ExamDTO['status'], string> = {
  draft: 'badge',
  published: 'badge badge-success',
  archived: 'badge badge-neutral',
};
export const EXAM_STATUS_LABEL: Record<ExamDTO['status'], string> = { draft: 'Draft', published: 'Published', archived: 'Archived' };

export function ExamsPage() {
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'' | ExamDTO['status']>('');
  const q = useQuery({ queryKey: qk.exams, queryFn: api.exams, retry: shouldRetry });
  const list = (q.data?.items ?? []).filter((e) => !status || e.status === status).sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <div className="stack">
      <PageHeader
        title="Exams"
        subtitle="Exam content, proctoring rules and candidate assignments."
        actions={
          isAdmin ? (
            <Link className="btn btn-primary" to="/admin/exams/new">
              New exam
            </Link>
          ) : null
        }
      />
      <div className="filter-bar">
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
        </select>
      </div>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState title="No exams yet">{isAdmin ? 'Create an exam, publish it, then assign candidates to generate access links.' : 'An administrator has not created any exams yet.'}</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table table-clickable">
            <thead>
              <tr>
                <th>Exam</th>
                <th>Status</th>
                <th>Duration</th>
                <th>Questions</th>
                <th>Assigned</th>
                <th>In progress</th>
                <th>Completed</th>
                <th>With flags</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {list.map((e) => (
                <tr key={e.id} onClick={() => navigate(`/admin/exams/${e.id}`)}>
                  <td>
                    <Link to={`/admin/exams/${e.id}`} onClick={(ev) => ev.stopPropagation()}>
                      <strong>{e.title}</strong>
                    </Link>
                    {e.description ? <div className="muted small clamp-2">{e.description}</div> : null}
                  </td>
                  <td>
                    <span className={EXAM_STATUS_CLASS[e.status]}>{EXAM_STATUS_LABEL[e.status]}</span>
                  </td>
                  <td>{formatDuration(e.durationSec * 1000)}</td>
                  <td>{e.questions.length}</td>
                  <td>{e.stats.assigned}</td>
                  <td>{e.stats.active}</td>
                  <td>{e.stats.completed}</td>
                  <td>{e.stats.flagged ? <span className="badge badge-warning">{e.stats.flagged}</span> : 0}</td>
                  <td className="small">{formatDateTime(e.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ExamDTO } from '@sp/shared';
import { api, errorMessage, shouldRetry } from '../../api/client';
import { qk } from '../../api/queries';
import { useAuth } from '../../auth';
import { readExamFile } from '../../lib/examVersions';
import { formatDateTime, formatDuration, pluralize } from '../../lib/format';
import { EmptyState, ErrorState, Loading, PageHeader } from '../../components/Common';
import { ConfirmDialog } from '../../components/Modal';

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
            <>
              <ImportExamButton />
              <Link className="btn btn-primary" to="/admin/exams/new">
                New exam
              </Link>
            </>
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
                    {e.currentVersion ? <span className="muted small"> v{e.currentVersion.number}</span> : null}
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

/** Import an exported exam file (…exam.json) as a new draft exam. */
function ImportExamButton() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ doc: unknown; title: string; questions: number } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (doc: unknown) => api.importExam(doc),
    onSuccess: (exam) => {
      qc.setQueryData(qk.exam(exam.id), exam);
      void qc.invalidateQueries({ queryKey: qk.exams });
      navigate(`/admin/exams/${exam.id}`);
    },
  });
  return (
    <>
      <button type="button" className="btn" onClick={() => input.current?.click()}>
        Import…
      </button>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        hidden
        data-testid="exam-import-file"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          const r = await readExamFile(file);
          m.reset();
          if (r.ok) setPending(r);
          else setFileError(r.error);
        }}
      />
      {fileError ? (
        <ConfirmDialog title="Cannot import this file" message={fileError} confirmLabel="Choose another file" onConfirm={() => {
            setFileError(null);
            input.current?.click();
          }} onCancel={() => setFileError(null)} />
      ) : null}
      {pending ? (
        <ConfirmDialog
          title="Import exam?"
          message={
            <>
              <strong>{pending.title || 'Untitled exam'}</strong> ({pluralize(pending.questions, 'question')}) will be created as a new <strong>draft</strong>, with its answer keys and
              proctoring rules. Review it, then publish it to assign candidates.
            </>
          }
          confirmLabel="Import as draft"
          busy={m.isPending}
          error={m.isError ? errorMessage(m.error) : null}
          onConfirm={() => m.mutate(pending.doc)}
          onCancel={() => setPending(null)}
        />
      ) : null}
    </>
  );
}

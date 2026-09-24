import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AssignmentDTO, ExamDTO } from '@sp/shared';
import { api, errorMessage, shouldRetry } from '../../api/client';
import { qk } from '../../api/queries';
import { useAuth } from '../../auth';
import { formatDuration } from '../../lib/format';
import { QUESTION_TYPE_LABELS } from '../../lib/examForm';
import { ALL_POLICY_FIELDS, changedFromDefault, formatPolicyValue, getPath, POLICY_GROUPS } from '../../lib/policyForm';
import { CategoryCounts, ConnectionBadge, StatusBadge } from '../../components/Badges';
import { CopyButton, EmptyState, ErrorState, Loading, PageHeader } from '../../components/Common';
import { ConfirmDialog } from '../../components/Modal';
import { TimeOfDay } from '../../components/Time';
import { EXAM_STATUS_CLASS, EXAM_STATUS_LABEL } from './ExamsPage';

export function ExamDetailPage() {
  const { id = '' } = useParams();
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const exam = useQuery({ queryKey: qk.exam(id), queryFn: () => api.exam(id), retry: shouldRetry });
  const [confirm, setConfirm] = useState<null | 'publish' | 'archive'>(null);
  const setExam = (e: ExamDTO) => {
    qc.setQueryData(qk.exam(id), e);
    void qc.invalidateQueries({ queryKey: qk.exams });
    setConfirm(null);
  };
  const publish = useMutation({ mutationFn: () => api.publishExam(id), onSuccess: setExam });
  const archive = useMutation({ mutationFn: () => api.archiveExam(id), onSuccess: setExam });

  if (exam.isPending) return <Loading />;
  if (exam.isError) return <ErrorState error={exam.error} onRetry={() => void exam.refetch()} />;
  const e = exam.data;
  const points = e.questions.reduce((s, q) => s + (q.points ?? 0), 0);

  return (
    <div className="stack">
      <PageHeader
        back={<Link to="/admin/exams">← Exams</Link>}
        title={
          <>
            {e.title} <span className={EXAM_STATUS_CLASS[e.status]}>{EXAM_STATUS_LABEL[e.status]}</span>
          </>
        }
        subtitle={`${formatDuration(e.durationSec * 1000)} · ${e.questions.length} question${e.questions.length === 1 ? '' : 's'} · ${points} point${points === 1 ? '' : 's'}`}
        actions={
          isAdmin ? (
            <>
              <Link className="btn" to={`/admin/exams/${id}/edit`}>
                Edit
              </Link>
              {e.status === 'draft' ? (
                <button type="button" className="btn btn-primary" onClick={() => setConfirm('publish')}>
                  Publish…
                </button>
              ) : null}
              {e.status !== 'archived' ? (
                <button type="button" className="btn" onClick={() => setConfirm('archive')}>
                  Archive…
                </button>
              ) : null}
            </>
          ) : null
        }
      />
      <div className="stats-row">
        <div className="stat">
          <div className="stat-value">{e.stats.assigned}</div>
          <div className="stat-label">Assigned</div>
        </div>
        <div className="stat stat-success">
          <div className="stat-value">{e.stats.active}</div>
          <div className="stat-label">In progress</div>
        </div>
        <div className="stat">
          <div className="stat-value">{e.stats.completed}</div>
          <div className="stat-label">Completed</div>
        </div>
        <div className={`stat${e.stats.flagged ? ' stat-warning' : ''}`}>
          <div className="stat-value">{e.stats.flagged}</div>
          <div className="stat-label">With flags</div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card stack">
          <h2>Overview</h2>
          {e.description ? <p className="pre-wrap">{e.description}</p> : <p className="muted">No description.</p>}
          <details>
            <summary>Candidate instructions</summary>
            {e.instructions ? <p className="pre-wrap">{e.instructions}</p> : <p className="muted">None.</p>}
          </details>
          <details>
            <summary>Questions ({e.questions.length})</summary>
            <ol className="question-summary">
              {e.questions.map((q) => (
                <li key={q.id}>
                  <span className="muted small">{QUESTION_TYPE_LABELS[q.type]} · {q.points} pt</span>
                  <div className="clamp-2">{q.prompt}</div>
                </li>
              ))}
            </ol>
          </details>
        </div>
        <PolicySummary exam={e} />
      </div>

      {isAdmin ? <AssignPanel exam={e} /> : null}
      <ExamSessions examId={id} />

      {confirm === 'publish' ? (
        <ConfirmDialog
          title="Publish this exam?"
          message="Candidates can then be assigned and start the exam with their access link. Check the questions and proctoring rules first."
          confirmLabel="Publish"
          busy={publish.isPending}
          error={publish.isError ? errorMessage(publish.error) : null}
          onConfirm={() => publish.mutate()}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
      {confirm === 'archive' ? (
        <ConfirmDialog
          title="Archive this exam?"
          message="Archived exams accept no new assignments. Existing sessions and their evidence are kept according to the retention policy."
          confirmLabel="Archive"
          busy={archive.isPending}
          error={archive.isError ? errorMessage(archive.error) : null}
          onConfirm={() => archive.mutate()}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </div>
  );
}

function PolicySummary({ exam }: { exam: ExamDTO }) {
  const p = exam.policy;
  const changed = changedFromDefault(p);
  const key = (path: string) => {
    const f = ALL_POLICY_FIELDS.find((x) => x.path === path)!;
    return formatPolicyValue(f, getPath(p, path));
  };
  return (
    <div className="card stack">
      <h2>Proctoring rules</h2>
      <table className="kv-table">
        <tbody>
          <tr>
            <th>Live-person check</th>
            <td>{key('identity.liveness')}</td>
          </tr>
          <tr>
            <th>ID photo comparison</th>
            <td>{key('identity.idPhotoComparison')}</td>
          </tr>
          <tr>
            <th>On possible different person</th>
            <td>{key('identity.onMismatch')}</td>
          </tr>
          <tr>
            <th>Pausing</th>
            <td>
              {p.pause.allowed ? (
                <>
                  Allowed{p.pause.requireApproval ? ', needs approval' : ''}
                  {p.pause.requireReason ? ', reason required' : ''} · clock {p.pause.timerBehavior === 'stop' ? 'stops' : 'keeps running'}
                  {p.pause.maxPauses != null ? ` · max ${p.pause.maxPauses}` : ''}
                </>
              ) : (
                'Not allowed'
              )}
            </td>
          </tr>
          <tr>
            <th>Fullscreen required</th>
            <td>{key('browser.requireFullscreen')}</td>
          </tr>
          <tr>
            <th>Screenshots</th>
            <td>{key('evidence.screenshots')}</td>
          </tr>
          <tr>
            <th>Evidence retention</th>
            <td>{key('retention.evidenceDays')}</td>
          </tr>
        </tbody>
      </table>
      <div className="small muted">
        {changed.length === 0 ? 'All other settings use the product defaults.' : `${changed.length} setting${changed.length === 1 ? '' : 's'} differ from the product defaults:`}
      </div>
      {changed.length ? (
        <ul className="small changed-list">
          {changed.map((path) => {
            const f = ALL_POLICY_FIELDS.find((x) => x.path === path)!;
            const group = POLICY_GROUPS.find((g) => g.fields.includes(f));
            return (
              <li key={path}>
                <span className="muted">{group?.title} ›</span> {f.label}: <strong>{formatPolicyValue(f, getPath(p, path))}</strong>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function AssignPanel({ exam }: { exam: ExamDTO }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<AssignmentDTO[] | null>(null);
  const candidates = useQuery({ queryKey: qk.candidates(''), queryFn: () => api.candidates(), retry: shouldRetry });
  const sessions = useQuery({ queryKey: qk.examSessions(exam.id), queryFn: () => api.examSessions(exam.id), retry: shouldRetry });
  const assigned = useMemo(() => new Set((sessions.data?.items ?? []).map((s) => s.candidate.id)), [sessions.data]);
  const list = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (candidates.data?.items ?? []).filter(
      (c) => !needle || c.name.toLowerCase().includes(needle) || (c.email ?? '').toLowerCase().includes(needle) || (c.externalId ?? '').toLowerCase().includes(needle),
    );
  }, [candidates.data, search]);
  const m = useMutation({
    mutationFn: () => api.assign(exam.id, [...selected]),
    onSuccess: (r) => {
      setResults(r.items);
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: qk.examSessions(exam.id) });
      void qc.invalidateQueries({ queryKey: qk.exam(exam.id) });
      void qc.invalidateQueries({ queryKey: qk.dashboard });
    },
  });
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const selectable = list.filter((c) => !assigned.has(c.id));
  const allSelected = selectable.length > 0 && selectable.every((c) => selected.has(c.id));

  return (
    <section className="card stack">
      <div className="row">
        <h2>Assign candidates</h2>
        <div className="spacer" />
        <Link to="/admin/candidates" className="small">
          Manage candidates
        </Link>
      </div>
      {exam.status !== 'published' ? (
        <div className="banner banner-info small">
          {exam.status === 'draft' ? 'Publish the exam before assigning candidates.' : 'This exam is archived and accepts no new assignments.'}
        </div>
      ) : null}
      {results ? (
        <div className="banner banner-success stack">
          <div className="row">
            <strong>
              {results.length} access link{results.length === 1 ? '' : 's'} created.
            </strong>
            <span className="small">Send each candidate their own link. Links are personal — anyone with a link can open that candidate’s exam.</span>
            <div className="spacer" />
            <CopyButton text={results.map((r) => `${r.candidateName}\t${r.accessLink}`).join('\n')} label="Copy all (name + link)" />
            <button type="button" className="btn btn-sm" onClick={() => setResults(null)}>
              Close
            </button>
          </div>
          <table className="table compact">
            <tbody>
              {results.map((r) => (
                <tr key={r.sessionId}>
                  <td>
                    {r.candidateName}
                    {r.existing ? (
                      <span className="badge" title="The candidate already had an unfinished session for this exam; its existing link is shown.">
                        existing session
                      </span>
                    ) : null}
                  </td>
                  <td className="mono small break">{r.accessLink}</td>
                  <td>
                    <CopyButton text={r.accessLink} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="row">
        <input type="text" placeholder="Filter candidates…" value={search} onChange={(e) => setSearch(e.target.value)} className="grow" aria-label="Filter candidates" />
        <label className="inline">
          <input
            type="checkbox"
            checked={allSelected}
            disabled={selectable.length === 0}
            onChange={(e) => setSelected(e.target.checked ? new Set([...selected, ...selectable.map((c) => c.id)]) : new Set([...selected].filter((id) => !selectable.some((c) => c.id === id))))}
          />
          Select all shown
        </label>
        <button type="button" className="btn btn-primary" disabled={selected.size === 0 || m.isPending || exam.status === 'archived'} onClick={() => m.mutate()}>
          {m.isPending ? 'Assigning…' : `Assign ${selected.size || ''} selected`}
        </button>
      </div>
      {m.isError ? <div className="banner banner-danger">{errorMessage(m.error)}</div> : null}
      {candidates.isPending ? (
        <Loading />
      ) : candidates.isError ? (
        <ErrorState error={candidates.error} onRetry={() => void candidates.refetch()} />
      ) : list.length === 0 ? (
        <div className="muted">
          No candidates{search ? ' match the filter' : ''}. <Link to="/admin/candidates">Add candidates</Link>.
        </div>
      ) : (
        <div className="assign-list">
          {list.map((c) => {
            const already = assigned.has(c.id);
            return (
              <label key={c.id} className={`assign-item inline${already ? ' disabled' : ''}`}>
                <input type="checkbox" disabled={already} checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                <span>
                  <strong>{c.name}</strong>
                  <span className="muted small"> {c.email ?? c.externalId ?? ''}</span>
                  {already ? <span className="badge">already assigned</span> : null}
                  {c.idPhoto ? <span className="badge badge-info">ID photo</span> : null}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ExamSessions({ examId }: { examId: string }) {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: qk.examSessions(examId), queryFn: () => api.examSessions(examId), retry: shouldRetry });
  return (
    <section className="card stack">
      <h2>Sessions</h2>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <EmptyState title="No candidates assigned yet" />
      ) : (
        <div className="table-wrap">
          <table className="table table-clickable">
            <thead>
              <tr>
                <th>Candidate</th>
                <th>Status</th>
                <th>Started</th>
                <th>Flags</th>
                <th>Unreviewed</th>
                <th>Access link</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((s) => (
                <tr key={s.id} onClick={() => navigate(`/admin/sessions/${s.id}`)}>
                  <td>
                    <strong>{s.candidate.name}</strong>
                    <div className="muted small">{s.candidate.email ?? s.candidate.externalId ?? ''}</div>
                  </td>
                  <td>
                    <div className="row tight">
                      <StatusBadge status={s.status} />
                      {s.status !== 'submitted' && s.status !== 'terminated' ? <ConnectionBadge connection={s.connection} /> : null}
                    </div>
                  </td>
                  <td>
                    <TimeOfDay at={s.startedAt} />
                  </td>
                  <td>
                    <CategoryCounts counts={s.counts} compact />
                  </td>
                  <td>{s.counts.unreviewed}</td>
                  <td onClick={(ev) => ev.stopPropagation()}>{s.accessLink ? <CopyButton text={s.accessLink} label="Copy link" /> : <span className="muted small">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

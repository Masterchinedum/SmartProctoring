import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ExamDTO, ExamVersionSummaryDTO, RegradeResultDTO } from '@sp/shared';
import { api, errorMessage, shouldRetry } from '../../api/client';
import { qk } from '../../api/queries';
import { formatDateTime, formatDuration, pluralize } from '../../lib/format';
import { QUESTION_TYPE_LABELS } from '../../lib/examForm';
import { changesScoring, describeChanges, downloadJson, exportFileName, formatAnswerKey, formatScore, regradeSources, VERSION_REASON_LABEL } from '../../lib/examVersions';
import { ErrorState, Loading } from '../../components/Common';
import { Modal } from '../../components/Modal';

/**
 * The exam's versions: what each one changed, how many attempts it carries, and (admins) export and regrade. Every
 * attempt keeps the version it started with, so this is the record of what each candidate actually answered.
 */
export function ExamVersionsPanel({ exam, isAdmin }: { exam: ExamDTO; isAdmin: boolean }) {
  const q = useQuery({ queryKey: qk.examVersions(exam.id), queryFn: () => api.examVersions(exam.id), retry: shouldRetry });
  const [viewing, setViewing] = useState<ExamVersionSummaryDTO | null>(null);
  const [regradeWith, setRegradeWith] = useState<ExamVersionSummaryDTO | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const exportVersion = useMutation({
    mutationFn: (v: ExamVersionSummaryDTO) => api.exportExam(exam.id, v.id),
    onSuccess: (doc, v) => {
      setExportError(null);
      downloadJson(doc, exportFileName(exam.title, v.number));
    },
    onError: (err) => setExportError(errorMessage(err)),
  });

  const versions = q.data?.items ?? [];
  const oldest = versions.length ? versions[versions.length - 1] : null;
  return (
    <section className="card stack" aria-labelledby="exam-versions-title">
      <div className="row">
        <h2 id="exam-versions-title">Versions</h2>
        <div className="spacer" />
        {exam.currentVersion ? <span className="small muted">Candidates who start now get version {exam.currentVersion.number}.</span> : null}
      </div>
      <p className="small muted">
        Publishing, and every later edit of a published exam, creates a new version. Each attempt keeps the version it started with — its questions, options and answer keys — so an edit
        never changes what a candidate already sees or how they are graded. A corrected answer key reaches finished attempts only through a regrade.
      </p>
      {exportError ? (
        <div className="banner banner-danger" role="alert">
          {exportError}
        </div>
      ) : null}
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : versions.length === 0 ? (
        <div className="muted small">No versions yet: the first version is created when the exam is published.</div>
      ) : (
        <div className="table-wrap">
          <table className="table compact" data-testid="exam-versions">
            <thead>
              <tr>
                <th>Version</th>
                <th>Created</th>
                <th>Changes</th>
                <th>Questions</th>
                <th>Attempts</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => {
                const canRegradeOthers = isAdmin && regradeSources(versions, v).length > 0;
                return (
                  <tr key={v.id} data-testid={`exam-version-${v.number}`}>
                    <td>
                      <strong>v{v.number}</strong> {v.current ? <span className="badge badge-success">current</span> : null}
                    </td>
                    <td className="small">
                      {formatDateTime(v.createdAt)}
                      <div className="muted">
                        {VERSION_REASON_LABEL[v.reason]}
                        {v.createdBy ? ` · ${v.createdBy.name}` : ''}
                      </div>
                    </td>
                    <td className="small">
                      <ChangeList version={v} first={v.id === oldest?.id} />
                    </td>
                    <td className="small">
                      {v.questionCount} · {pluralize(v.totalPoints, 'point')}
                    </td>
                    <td className="small">
                      {v.sessions.started} started
                      <div className="muted">{v.sessions.finished} finished</div>
                    </td>
                    <td>
                      <div className="row tight">
                        <button type="button" className="btn btn-sm" onClick={() => setViewing(v)}>
                          View
                        </button>
                        {isAdmin ? (
                          <button type="button" className="btn btn-sm" disabled={exportVersion.isPending} onClick={() => exportVersion.mutate(v)}>
                            Export
                          </button>
                        ) : null}
                        {canRegradeOthers ? (
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => setRegradeWith(v)}
                            title={`Re-score finished attempts of earlier versions with the answer keys of v${v.number}`}
                          >
                            Regrade with v{v.number}…
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {viewing ? <VersionDialog examId={exam.id} version={viewing} onClose={() => setViewing(null)} /> : null}
      {regradeWith ? <RegradeDialog exam={exam} versions={versions} keys={regradeWith} onClose={() => setRegradeWith(null)} /> : null}
    </section>
  );
}

function ChangeList({ version, first }: { version: ExamVersionSummaryDTO; first: boolean }) {
  const lines = describeChanges(version.changes, { first: first && version.reason !== 'migrated' });
  if (version.reason === 'migrated' && first) return <span className="muted">Content when versioning was introduced</span>;
  if (!lines.length) return <span className="muted">No content changes</span>;
  return (
    <ul className="changed-list">
      {lines.map((l) => (
        <li key={l} className={l.startsWith('Answer key') || l.startsWith('Points') ? 'text-warning' : undefined}>
          {l}
        </li>
      ))}
    </ul>
  );
}

function VersionDialog({ examId, version, onClose }: { examId: string; version: ExamVersionSummaryDTO; onClose: () => void }) {
  const q = useQuery({ queryKey: qk.examVersion(examId, version.id), queryFn: () => api.examVersion(examId, version.id), retry: shouldRetry, staleTime: Infinity });
  const changed = useMemo(() => new Map(version.changes.changed.map((c) => [c.questionId, c.fields])), [version]);
  const added = useMemo(() => new Set(version.changes.added), [version]);
  return (
    <Modal title={`Version ${version.number}`} onClose={onClose} wide>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <div className="stack">
          <div className="small muted">
            {VERSION_REASON_LABEL[q.data.reason]} {formatDateTime(q.data.createdAt)}
            {q.data.createdBy ? ` by ${q.data.createdBy.name}` : ''} · {formatDuration(q.data.durationSec * 1000)} · {pluralize(q.data.questions.length, 'question')} ·{' '}
            {pluralize(q.data.totalPoints, 'point')}
            {q.data.contentHash ? (
              <>
                {' '}
                · <span title={`sha256 ${q.data.contentHash}`}>fingerprint {q.data.contentHash.slice(0, 12)}</span>
              </>
            ) : null}
          </div>
          <h3>{q.data.title}</h3>
          {q.data.instructions ? (
            <details>
              <summary>Candidate instructions</summary>
              <p className="pre-wrap">{q.data.instructions}</p>
            </details>
          ) : null}
          <ol className="question-summary" data-testid="version-questions">
            {q.data.questions.map((qq) => {
              const fields = changed.get(qq.id);
              return (
                <li key={qq.id}>
                  <span className="muted small">
                    {QUESTION_TYPE_LABELS[qq.type]} · {qq.points} pt
                    {added.has(qq.id) && version.number > 1 ? <span className="badge badge-info">new</span> : null}
                    {fields?.length ? <span className="badge badge-warning">changed: {fields.join(', ')}</span> : null}
                  </span>
                  <div className="pre-wrap">{qq.prompt}</div>
                  {qq.options.length ? (
                    <ul className="small">
                      {qq.options.map((o) => (
                        <li key={o.id}>
                          {o.text} {qq.correct.includes(o.id) ? <strong className="text-success">✓ correct</strong> : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="small">
                      <span className="muted">Answer key:</span> {formatAnswerKey(qq, qq.correct)}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </Modal>
  );
}

/**
 * Regrade finished attempts of an earlier version with the answer keys / points of `keys`. Always previews first; the
 * apply step shows exactly what will change and asks for a reason, which is recorded on every regraded attempt.
 */
export function RegradeDialog({ exam, versions, keys, onClose }: { exam: ExamDTO; versions: ExamVersionSummaryDTO[]; keys: ExamVersionSummaryDTO; onClose: () => void }) {
  const qc = useQueryClient();
  const sources = regradeSources(versions, keys);
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<RegradeResultDTO | null>(null);
  const [applied, setApplied] = useState<RegradeResultDTO | null>(null);
  const keysVersion = useQuery({ queryKey: qk.examVersion(exam.id, keys.id), queryFn: () => api.examVersion(exam.id, keys.id), retry: shouldRetry, staleTime: Infinity });
  const body = (apply: boolean) => ({ sessionsOnVersionId: sourceId, keysFromVersionId: keys.id, apply, reason: reason.trim() });
  const run = useMutation({
    mutationFn: (apply: boolean) => api.regradeExam(exam.id, body(apply)),
    onSuccess: (r) => {
      if (r.applied) {
        setApplied(r);
        void qc.invalidateQueries({ queryKey: qk.examSessions(exam.id) });
        void qc.invalidateQueries({ queryKey: qk.examVersions(exam.id) });
        for (const s of r.sessions) void qc.invalidateQueries({ queryKey: qk.session(s.sessionId) });
      } else setPreview(r);
    },
  });
  const source = sources.find((s) => s.id === sourceId);
  const question = (id: string) => keysVersion.data?.questions.find((x) => x.id === id);
  const result = applied ?? preview;
  const moved = (result?.sessions ?? []).filter((s) => s.changed);

  return (
    <Modal
      title={`Regrade with the answer keys of v${keys.number}`}
      onClose={onClose}
      wide
      footer={
        applied ? (
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose} disabled={run.isPending}>
              Cancel
            </button>
            <button type="button" className="btn" disabled={!sourceId || !reason.trim() || run.isPending} onClick={() => run.mutate(false)}>
              {run.isPending && !preview ? 'Calculating…' : preview ? 'Recalculate preview' : 'Preview'}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="regrade-apply"
              disabled={!preview || moved.length === 0 || !reason.trim() || run.isPending}
              onClick={() => run.mutate(true)}
            >
              {run.isPending && preview ? 'Regrading…' : `Regrade ${pluralize(moved.length, 'attempt')}`}
            </button>
          </>
        )
      }
    >
      <div className="stack">
        <p className="small">
          Finished attempts keep the questions and options their candidates saw; only the answer keys and points of questions that also exist in v{keys.number} are taken over. Each
          regraded attempt gets a “Score regraded” entry in its timeline with the score before and after, integrations receive a <code>session.regraded</code> webhook, and the
          regrade is recorded in the audit log.
        </p>
        {!changesScoring(keys.changes) && keys.number > 1 ? (
          <div className="banner banner-info small">v{keys.number} itself did not change answer keys or points; the preview shows whether it differs from the version you pick.</div>
        ) : null}
        <div className="grid-2">
          <label>
            Attempts that started on
            <select
              value={sourceId}
              disabled={!!applied}
              onChange={(e) => {
                setSourceId(e.target.value);
                setPreview(null);
              }}
            >
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  v{s.number} — {pluralize(s.sessions.finished, 'finished attempt')}
                </option>
              ))}
            </select>
          </label>
          <label>
            Reason (recorded with each regraded attempt)
            <textarea value={reason} disabled={!!applied} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} placeholder="e.g. Question 4 had the wrong answer marked as correct." />
          </label>
        </div>
        {run.isError ? (
          <div className="banner banner-danger" role="alert">
            {errorMessage(run.error)}
          </div>
        ) : null}
        {applied ? (
          <div className="banner banner-success" role="status">
            Regraded {pluralize(moved.length, 'attempt')} of v{source?.number ?? '?'} with the answer keys of v{keys.number}. Attempts whose score did not change were left as they were.
          </div>
        ) : null}
        {result && result.inProgress > 0 ? (
          <div className="banner banner-warning small" role="status">
            {pluralize(result.inProgress, 'attempt')} on v{source?.number} {result.inProgress === 1 ? 'is' : 'are'} still in progress. {result.inProgress === 1 ? 'It is' : 'They are'} graded with
            the keys of v{source?.number} on finishing — run the regrade again once {result.inProgress === 1 ? 'it has' : 'they have'} finished.
          </div>
        ) : null}
        {result ? (
          result.changedQuestions.length === 0 ? (
            <div className="banner banner-info" role="status">
              v{source?.number} and v{keys.number} have the same answer keys and points for every question they share — there is nothing to regrade.
            </div>
          ) : (
            <>
              <h3>Questions whose scoring changes ({result.changedQuestions.length})</h3>
              <table className="table compact" data-testid="regrade-questions">
                <thead>
                  <tr>
                    <th>Question</th>
                    <th>Answer key</th>
                    <th>Points</th>
                  </tr>
                </thead>
                <tbody>
                  {result.changedQuestions.map((c) => (
                    <tr key={c.questionId}>
                      <td className="small clamp-2">{c.prompt}</td>
                      <td className="small">
                        {c.correct.from.join() === c.correct.to.join() ? (
                          <span className="muted">unchanged</span>
                        ) : (
                          <>
                            <s>{formatAnswerKey(question(c.questionId), c.correct.from)}</s> → <strong>{formatAnswerKey(question(c.questionId), c.correct.to)}</strong>
                          </>
                        )}
                      </td>
                      <td className="small">{c.points.from === c.points.to ? c.points.to : `${c.points.from} → ${c.points.to}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3>
                Finished attempts ({result.sessions.length}) · {pluralize(moved.length, 'result')} {applied ? 'changed' : 'change'}
              </h3>
              <div className="table-wrap regrade-sessions">
                <table className="table compact" data-testid="regrade-sessions">
                  <thead>
                    <tr>
                      <th>Candidate</th>
                      <th>Before</th>
                      <th>After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.sessions.map((s) => {
                      const delta = s.after.points - s.before.points;
                      return (
                        <tr key={s.sessionId} className={s.changed ? undefined : 'muted'}>
                          <td>
                            <Link to={`/admin/sessions/${s.sessionId}`}>{s.candidateName}</Link>
                            {s.changed ? null : <span className="small"> · unchanged</span>}
                          </td>
                          <td className="small">{formatScore(s.before)}</td>
                          <td className="small">
                            {formatScore(s.after)}{' '}
                            {delta !== 0 ? <span className={delta > 0 ? 'text-success' : 'text-danger'}>({delta > 0 ? '+' : ''}{Math.round(delta * 100) / 100})</span> : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )
        ) : null}
      </div>
    </Modal>
  );
}

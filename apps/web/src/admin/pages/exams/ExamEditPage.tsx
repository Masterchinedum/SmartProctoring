import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_POLICY, type ExamDTO, type ProctoringPolicy } from '@sp/shared';
import { api, errorMessage, shouldRetry } from '../../api/client';
import { qk } from '../../api/queries';
import { draftToExamInput, examToDraft, validateExamDraft, type ExamDraft } from '../../lib/examForm';
import { normalizePolicy, validatePolicy } from '../../lib/policyForm';
import { ErrorState, Loading, PageHeader } from '../../components/Common';
import { PolicyEditor } from '../../components/PolicyEditor';
import { QuestionsEditor } from './QuestionsEditor';

export function ExamEditPage() {
  const { id } = useParams();
  const isNew = !id;
  const exam = useQuery({ queryKey: qk.exam(id ?? ''), queryFn: () => api.exam(id!), enabled: !isNew, retry: shouldRetry });
  // Org default policy: starting point for new exams and the "reset" target.
  const settings = useQuery({ queryKey: qk.settings, queryFn: api.settings, retry: shouldRetry, staleTime: 60_000 });
  const orgDefault = settings.data ? normalizePolicy(settings.data.defaultPolicy) : DEFAULT_POLICY;

  if (!isNew && exam.isPending) return <Loading />;
  if (!isNew && exam.isError) return <ErrorState error={exam.error} onRetry={() => void exam.refetch()} />;
  if (isNew && settings.isPending) return <Loading />;
  return <ExamForm key={id ?? 'new'} exam={isNew ? null : exam.data!} orgDefault={orgDefault} />;
}

function ExamForm({ exam, orgDefault }: { exam: ExamDTO | null; orgDefault: ProctoringPolicy }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<ExamDraft>(() => examToDraft(exam, orgDefault));
  const [showErrors, setShowErrors] = useState(false);
  const [invalidPolicy, setInvalidPolicy] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const change = (patch: Partial<ExamDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };
  const errors = validateExamDraft(draft);
  const policyCheck = validatePolicy(draft.policy);
  const policyErrors = policyCheck.ok ? {} : policyCheck.errors;
  const hasErrors = Object.keys(errors).length > 0 || !policyCheck.ok || invalidPolicy.length > 0;

  const save = useMutation({
    mutationFn: () => {
      const input = draftToExamInput(draft);
      return exam ? api.updateExam(exam.id, input) : api.createExam(input);
    },
    onSuccess: (saved) => {
      setDirty(false);
      qc.setQueryData(qk.exam(saved.id), saved);
      void qc.invalidateQueries({ queryKey: qk.exams });
      navigate(`/admin/exams/${saved.id}`);
    },
  });

  const submit = () => {
    setShowErrors(true);
    if (hasErrors) return;
    save.mutate();
  };

  return (
    <form
      className="stack exam-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <PageHeader
        back={<Link to={exam ? `/admin/exams/${exam.id}` : '/admin/exams'}>← {exam ? 'Exam' : 'Exams'}</Link>}
        title={exam ? `Edit: ${exam.title}` : 'New exam'}
        subtitle={exam?.status === 'published' ? 'This exam is published. Changes can affect candidates who have not finished yet — avoid editing questions or rules while sessions are in progress.' : undefined}
      />

      <section className="card stack">
        <h2>Basics</h2>
        <label>
          Title
          <input type="text" value={draft.title} onChange={(e) => change({ title: e.target.value })} maxLength={300} aria-invalid={showErrors && !!errors.title} />
          {showErrors && errors.title ? <span className="text-danger small">{errors.title}</span> : null}
        </label>
        <label>
          Description (shown to staff and candidates)
          <textarea value={draft.description} onChange={(e) => change({ description: e.target.value })} maxLength={5000} rows={2} />
        </label>
        <label>
          Instructions for candidates
          <textarea value={draft.instructions} onChange={(e) => change({ instructions: e.target.value })} maxLength={20000} rows={4} />
        </label>
        <label className="duration-field">
          Duration (minutes)
          <input type="number" min={1} max={1440} step="any" value={draft.durationMin} onChange={(e) => change({ durationMin: e.target.value })} aria-invalid={showErrors && !!errors.durationMin} />
          {showErrors && errors.durationMin ? <span className="text-danger small">{errors.durationMin}</span> : null}
        </label>
      </section>

      <section className="stack">
        <h2>Questions</h2>
        <QuestionsEditor questions={draft.questions} onChange={(questions) => change({ questions })} showErrors={showErrors} />
      </section>

      <section className="stack">
        <div className="row">
          <h2>Proctoring policy</h2>
          <div className="spacer" />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              change({ policy: orgDefault });
            }}
          >
            Reset to organisation default
          </button>
        </div>
        <PolicyEditor value={draft.policy} onChange={(policy) => change({ policy })} defaults={orgDefault} defaultsLabel="Organisation default" errors={policyErrors} onValidity={setInvalidPolicy} />
      </section>

      <div className="sticky-actions">
        {showErrors && hasErrors ? <span className="text-danger">Fix the highlighted fields before saving.</span> : null}
        {save.isError ? <span className="text-danger">{errorMessage(save.error)}</span> : null}
        <div className="spacer" />
        <Link className="btn" to={exam ? `/admin/exams/${exam.id}` : '/admin/exams'}>
          Cancel
        </Link>
        <button type="submit" className="btn btn-primary" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : exam ? 'Save changes' : 'Create exam'}
        </button>
      </div>
    </form>
  );
}

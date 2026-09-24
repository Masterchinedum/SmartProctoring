import { QUESTION_TYPES, type QuestionType } from '@sp/shared';
import {
  changeQuestionType,
  isChoice,
  moveItem,
  newQuestion,
  nextOptionId,
  QUESTION_TYPE_LABELS,
  questionError,
  totalPoints,
  type QuestionDraft,
} from '../../lib/examForm';

export function QuestionsEditor({ questions, onChange, showErrors }: { questions: QuestionDraft[]; onChange: (q: QuestionDraft[]) => void; showErrors: boolean }) {
  const update = (i: number, q: QuestionDraft) => onChange(questions.map((x, j) => (j === i ? q : x)));
  const remove = (i: number) => onChange(questions.filter((_, j) => j !== i));
  return (
    <div className="stack questions-editor">
      {questions.length === 0 ? <div className="muted">No questions yet. An exam can be proctored without questions (e.g. an external paper), but most exams add them here.</div> : null}
      {questions.map((q, i) => (
        <QuestionCard
          key={q.key}
          index={i}
          count={questions.length}
          q={q}
          error={showErrors ? questionError(q) : null}
          onChange={(nq) => update(i, nq)}
          onRemove={() => remove(i)}
          onMove={(to) => onChange(moveItem(questions, i, to))}
        />
      ))}
      <div className="row">
        <button type="button" className="btn" onClick={() => onChange([...questions, newQuestion('single_choice')])}>
          + Add question
        </button>
        <span className="muted small">
          {questions.length} question{questions.length === 1 ? '' : 's'} · {totalPoints(questions)} points total
        </span>
      </div>
    </div>
  );
}

function QuestionCard({
  index,
  count,
  q,
  error,
  onChange,
  onRemove,
  onMove,
}: {
  index: number;
  count: number;
  q: QuestionDraft;
  error: string | null;
  onChange: (q: QuestionDraft) => void;
  onRemove: () => void;
  onMove: (to: number) => void;
}) {
  return (
    <div className={`card question-card${error ? ' has-error' : ''}`}>
      <div className="row question-head">
        <strong>Question {index + 1}</strong>
        <select aria-label="Question type" value={q.type} onChange={(e) => onChange(changeQuestionType(q, e.target.value as QuestionType))}>
          {QUESTION_TYPES.map((t) => (
            <option key={t} value={t}>
              {QUESTION_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <label className="inline small">
          Points
          <input
            type="number"
            min={0}
            step="any"
            className="points-input"
            value={Number.isFinite(q.points) ? q.points : ''}
            onChange={(e) => onChange({ ...q, points: e.target.value === '' ? NaN : Number(e.target.value) })}
          />
        </label>
        <div className="spacer" />
        <button type="button" className="btn btn-sm" disabled={index === 0} onClick={() => onMove(index - 1)} aria-label="Move up" title="Move up">
          ↑
        </button>
        <button type="button" className="btn btn-sm" disabled={index === count - 1} onClick={() => onMove(index + 1)} aria-label="Move down" title="Move down">
          ↓
        </button>
        <button type="button" className="btn btn-sm" onClick={onRemove}>
          Remove
        </button>
      </div>
      <label>
        Prompt
        <textarea value={q.prompt} onChange={(e) => onChange({ ...q, prompt: e.target.value })} rows={2} maxLength={20000} />
      </label>
      {isChoice(q.type) ? <OptionsEditor q={q} onChange={onChange} /> : null}
      {q.type === 'short_text' ? (
        <label>
          Accepted answers (one per line, case-insensitive)
          <textarea
            value={q.correct.join('\n')}
            onChange={(e) => onChange({ ...q, correct: e.target.value.split('\n') })}
            rows={2}
            placeholder="Leave empty to grade manually"
          />
        </label>
      ) : null}
      {q.type === 'numeric' ? (
        <label>
          Correct value
          <input type="text" inputMode="decimal" value={q.correct[0] ?? ''} onChange={(e) => onChange({ ...q, correct: e.target.value ? [e.target.value] : [] })} placeholder="e.g. 42" />
        </label>
      ) : null}
      {q.type === 'long_text' ? <div className="muted small">Long-text answers are graded manually.</div> : null}
      {error ? <div className="text-danger small">{error}</div> : null}
    </div>
  );
}

function OptionsEditor({ q, onChange }: { q: QuestionDraft; onChange: (q: QuestionDraft) => void }) {
  const single = q.type === 'single_choice';
  const setCorrect = (id: string, on: boolean) => {
    if (single) onChange({ ...q, correct: on ? [id] : [] });
    else onChange({ ...q, correct: on ? [...new Set([...q.correct, id])] : q.correct.filter((c) => c !== id) });
  };
  return (
    <div className="options-editor">
      <div className="muted small">Options — mark the correct {single ? 'answer' : 'answers'}. The option id is what is stored with each answer.</div>
      {q.options.map((o, i) => (
        <div key={i} className="option-row">
          <input
            type={single ? 'radio' : 'checkbox'}
            name={`correct-${q.key}`}
            checked={q.correct.includes(o.id)}
            onChange={(e) => setCorrect(o.id, e.target.checked)}
            aria-label={`Option ${o.id} is correct`}
            title="Correct answer"
          />
          <input
            type="text"
            className="option-id"
            value={o.id}
            maxLength={50}
            aria-label="Option id"
            onChange={(e) => {
              const id = e.target.value;
              const options = q.options.map((x, j) => (j === i ? { ...x, id } : x));
              const correct = q.correct.map((c) => (c === o.id ? id : c));
              onChange({ ...q, options, correct });
            }}
          />
          <input
            type="text"
            className="grow"
            value={o.text}
            placeholder={`Option ${i + 1}`}
            maxLength={2000}
            aria-label="Option text"
            onChange={(e) => onChange({ ...q, options: q.options.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })}
          />
          <button type="button" className="btn btn-sm" disabled={i === 0} onClick={() => onChange({ ...q, options: moveItem(q.options, i, i - 1) })} aria-label="Move option up">
            ↑
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={i === q.options.length - 1}
            onClick={() => onChange({ ...q, options: moveItem(q.options, i, i + 1) })}
            aria-label="Move option down"
          >
            ↓
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onChange({ ...q, options: q.options.filter((_, j) => j !== i), correct: q.correct.filter((c) => c !== o.id) })}
            aria-label="Remove option"
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-sm" onClick={() => onChange({ ...q, options: [...q.options, { id: nextOptionId(q.options), text: '' }] })}>
        + Add option
      </button>
    </div>
  );
}

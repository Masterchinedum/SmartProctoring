import { useEffect, useId, useState } from 'react';
import type { AnswerValue, CandidateQuestionDTO } from '@sp/shared';
import { useFocusOnMount } from '../../../lib/a11y';
import { normaliseAnswer } from '../../answers';

/**
 * Renders one question with the input for its type. Values are reported normalised.
 *
 * Accessibility: the question is a <fieldset> whose <legend> holds the question number (an <h2> that
 * receives the focus when the question is shown), the points and the prompt, so screen readers read the
 * whole question when the focus enters its answer controls; radio / checkbox options are native inputs
 * with their text as the label (arrow keys / Space work as usual).
 */
export function QuestionView({
  question,
  value,
  onChange,
  total,
}: {
  question: CandidateQuestionDTO;
  value: AnswerValue;
  onChange: (v: AnswerValue) => void;
  total?: number;
}) {
  const q = question;
  const name = `q-${q.id}`;
  const promptId = `${name}-prompt`;
  const headingRef = useFocusOnMount<HTMLHeadingElement>();
  return (
    <fieldset className="cand-question" data-testid="question" data-question-id={q.id} data-question-type={q.type}>
      <legend className="cand-question-legend">
        <span className="cand-question-head">
          <h2 ref={headingRef} tabIndex={-1} className="cand-question-number" id={`${name}-heading`}>
            Question {q.index + 1}
            {total ? ` of ${total}` : ''}
          </h2>
          <span className="muted small">
            {q.points} point{q.points === 1 ? '' : 's'}
          </span>
        </span>
        <span className="cand-question-prompt cand-pre" id={promptId}>
          {q.prompt}
        </span>
        {q.type === 'multiple_choice' && <span className="cand-question-hint muted small">Select all that apply.</span>}
      </legend>
      {q.type === 'single_choice' && (
        <div className="cand-options">
          {q.options.map((o) => (
            <label key={o.id} className={`inline cand-option ${value === o.id ? 'selected' : ''}`}>
              <input type="radio" name={name} value={o.id} checked={value === o.id} onChange={() => onChange(o.id)} />
              <span>{o.text}</span>
            </label>
          ))}
          {value != null && (
            <button type="button" className="btn btn-sm cand-clear" onClick={() => onChange(null)}>
              Clear answer
            </button>
          )}
        </div>
      )}
      {q.type === 'multiple_choice' && (
        <div className="cand-options">
          {q.options.map((o) => {
            const list = Array.isArray(value) ? value : [];
            const checked = list.includes(o.id);
            return (
              <label key={o.id} className={`inline cand-option ${checked ? 'selected' : ''}`}>
                <input
                  type="checkbox"
                  name={name}
                  value={o.id}
                  checked={checked}
                  onChange={(e) => onChange(normaliseAnswer('multiple_choice', e.target.checked ? [...list, o.id] : list.filter((x) => x !== o.id)))}
                />
                <span>{o.text}</span>
              </label>
            );
          })}
        </div>
      )}
      {q.type === 'short_text' && (
        <label>
          <span className="cand-answer-label">Your answer</span>
          <input
            type="text"
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            maxLength={2000}
            autoComplete="off"
            spellCheck={false}
            data-testid="answer-input"
          />
        </label>
      )}
      {q.type === 'long_text' && (
        <label>
          <span className="cand-answer-label">Your answer</span>
          <textarea value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} rows={10} maxLength={100_000} data-testid="answer-input" />
        </label>
      )}
      {q.type === 'numeric' && <NumericInput value={value} onChange={onChange} />}
    </fieldset>
  );
}

/** Keeps the typed text locally (so "3." or "-" can be typed) and reports the parsed number. */
function NumericInput({ value, onChange }: { value: AnswerValue; onChange: (v: AnswerValue) => void }) {
  const [text, setText] = useState(typeof value === 'number' ? String(value) : '');
  const inputId = useId();
  const errorId = useId();
  useEffect(() => {
    const parsed = normaliseAnswer('numeric', text);
    if (parsed !== value) setText(typeof value === 'number' ? String(value) : '');
    // Only re-sync when the stored value changes from outside (e.g. restore after reload).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const parsed = normaliseAnswer('numeric', text);
  const invalid = text.trim() !== '' && parsed === null;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <label htmlFor={inputId} className="cand-answer-label">
        Your answer (a number)
      </label>
      <input
        id={inputId}
        type="text"
        inputMode="decimal"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = normaliseAnswer('numeric', e.target.value);
          if (n !== null || e.target.value.trim() === '') onChange(n);
        }}
        aria-invalid={invalid}
        aria-describedby={errorId}
        autoComplete="off"
        data-testid="answer-input"
      />
      {/* Always present (outside the label), so the message is announced politely when it appears. */}
      <span id={errorId} className="small cand-field-error" aria-live="polite">
        {invalid ? 'Enter a number, for example 42 or 3.5' : ''}
      </span>
    </div>
  );
}

import { useEffect, useState } from 'react';
import type { AnswerValue, CandidateQuestionDTO } from '@sp/shared';
import { normaliseAnswer } from '../../answers';

/** Renders one question with the input for its type. Values are reported normalised. */
export function QuestionView({ question, value, onChange }: { question: CandidateQuestionDTO; value: AnswerValue; onChange: (v: AnswerValue) => void }) {
  const q = question;
  const name = `q-${q.id}`;
  return (
    <fieldset className="cand-question" data-testid="question" data-question-id={q.id} data-question-type={q.type}>
      <legend className="cand-question-legend">
        <span className="cand-question-number">Question {q.index + 1}</span>
        <span className="muted small">
          {q.points} point{q.points === 1 ? '' : 's'}
        </span>
      </legend>
      <div className="cand-question-prompt cand-pre" id={`${name}-prompt`}>
        {q.prompt}
      </div>
      {q.type === 'single_choice' && (
        <div className="cand-options" role="radiogroup" aria-labelledby={`${name}-prompt`}>
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
        <div className="cand-options" role="group" aria-labelledby={`${name}-prompt`}>
          <p className="muted small">Select all that apply.</p>
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
          <span className="sr-only">Your answer</span>
          <input
            type="text"
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            maxLength={2000}
            autoComplete="off"
            spellCheck={false}
            aria-labelledby={`${name}-prompt`}
            data-testid="answer-input"
          />
        </label>
      )}
      {q.type === 'long_text' && (
        <label>
          <span className="sr-only">Your answer</span>
          <textarea
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            rows={10}
            maxLength={100_000}
            aria-labelledby={`${name}-prompt`}
            data-testid="answer-input"
          />
        </label>
      )}
      {q.type === 'numeric' && <NumericInput value={value} onChange={onChange} labelledBy={`${name}-prompt`} />}
    </fieldset>
  );
}

/** Keeps the typed text locally (so "3." or "-" can be typed) and reports the parsed number. */
function NumericInput({ value, onChange, labelledBy }: { value: AnswerValue; onChange: (v: AnswerValue) => void; labelledBy: string }) {
  const [text, setText] = useState(typeof value === 'number' ? String(value) : '');
  useEffect(() => {
    const parsed = normaliseAnswer('numeric', text);
    if (parsed !== value) setText(typeof value === 'number' ? String(value) : '');
    // Only re-sync when the stored value changes from outside (e.g. restore after reload).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const parsed = normaliseAnswer('numeric', text);
  const invalid = text.trim() !== '' && parsed === null;
  return (
    <label>
      <span className="sr-only">Your answer (a number)</span>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = normaliseAnswer('numeric', e.target.value);
          if (n !== null || e.target.value.trim() === '') onChange(n);
        }}
        aria-invalid={invalid}
        aria-labelledby={labelledBy}
        autoComplete="off"
        data-testid="answer-input"
      />
      {invalid && <span className="small" style={{ color: 'var(--danger)' }}>Enter a number, for example 42 or 3.5</span>}
    </label>
  );
}

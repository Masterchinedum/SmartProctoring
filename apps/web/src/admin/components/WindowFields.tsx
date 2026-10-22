import { localTimeZone, type WindowFormValues } from '../lib/scheduling';

/**
 * The two inputs of a scheduling window (opening / closing time, the staff member's own time zone), used by the
 * assignment panel and the reschedule dialog. Either may stay empty (open-ended). The hint and any error describe
 * both inputs (WCAG 1.3.1 / 3.3.1).
 */
export function WindowFields({
  idPrefix,
  legend,
  value,
  onChange,
  error,
  disabled = false,
}: {
  idPrefix: string;
  legend: string;
  value: WindowFormValues;
  onChange: (v: WindowFormValues) => void;
  error: { field: 'opens' | 'closes'; message: string } | null;
  disabled?: boolean;
}) {
  const hintId = `${idPrefix}-hint`;
  const errId = `${idPrefix}-error`;
  const describedBy = (field: 'opens' | 'closes') => (error?.field === field ? `${errId} ${hintId}` : hintId);
  return (
    <fieldset className="window-fields stack">
      <legend>{legend}</legend>
      <div className="row">
        <label htmlFor={`${idPrefix}-opens`}>
          Opens
          <input
            id={`${idPrefix}-opens`}
            type="datetime-local"
            value={value.opens}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, opens: e.target.value })}
            aria-invalid={error?.field === 'opens'}
            aria-describedby={describedBy('opens')}
          />
        </label>
        <label htmlFor={`${idPrefix}-closes`}>
          Closes
          <input
            id={`${idPrefix}-closes`}
            type="datetime-local"
            value={value.closes}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, closes: e.target.value })}
            aria-invalid={error?.field === 'closes'}
            aria-describedby={describedBy('closes')}
          />
        </label>
      </div>
      <p className="muted small" id={hintId}>
        Times in your time zone ({localTimeZone()}); the candidate sees them in theirs. Leave both empty for no window. The candidate can do the camera and identity check
        from 30 minutes before the opening and start the exam until the closing; an exam that has started is never cut off.
      </p>
      {error ? (
        <div className="text-danger small" id={errId} role="alert">
          {error.message}
        </div>
      ) : null}
    </fieldset>
  );
}

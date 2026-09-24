import { useEffect, useState } from 'react';
import { DEFAULT_POLICY, type ProctoringPolicy } from '@sp/shared';
import { formatPolicyValue, getPath, parsePolicyNumber, POLICY_GROUPS, setPath, type PolicyField } from '../lib/policyForm';

/**
 * Editor for every field of the proctoring policy, grouped. Numeric inputs keep their own text so
 * partially typed values are allowed; invalid inputs are reported through `onValidity`.
 */
export function PolicyEditor({
  value,
  onChange,
  defaults = DEFAULT_POLICY,
  defaultsLabel = 'Default',
  errors = {},
  onValidity,
  disabled = false,
}: {
  value: ProctoringPolicy;
  onChange: (p: ProctoringPolicy) => void;
  defaults?: ProctoringPolicy;
  defaultsLabel?: string;
  errors?: Record<string, string>;
  onValidity?: (invalidPaths: string[]) => void;
  disabled?: boolean;
}) {
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  useEffect(() => {
    onValidity?.(Object.keys(invalid).filter((k) => invalid[k]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invalid]);

  const set = (path: string, v: unknown) => onChange(setPath(value, path, v));
  const markInvalid = (path: string, bad: boolean) => setInvalid((m) => (m[path] === bad ? m : { ...m, [path]: bad }));

  return (
    <div className="policy-editor">
      {POLICY_GROUPS.map((g) => {
        const changed = g.fields.filter((f) => getPath(value, f.path) !== getPath(defaults, f.path)).length;
        const body = (
          <>
            <p className="muted small policy-group-desc">{g.description}</p>
            <div className="policy-fields">
              {g.fields.map((f) => (
                <PolicyFieldRow
                  key={f.path}
                  field={f}
                  value={getPath(value, f.path)}
                  defaultValue={getPath(defaults, f.path)}
                  defaultsLabel={defaultsLabel}
                  error={errors[f.path]}
                  disabled={disabled}
                  onChange={(v) => set(f.path, v)}
                  onInvalid={(bad) => markInvalid(f.path, bad)}
                />
              ))}
            </div>
          </>
        );
        return g.advanced ? (
          <details key={g.id} className="policy-group card advanced">
            <summary>
              <h3>
                {g.title} <span className="muted small">(advanced)</span>
                {changed ? <span className="badge badge-info">{changed} changed</span> : null}
              </h3>
            </summary>
            {body}
          </details>
        ) : (
          <fieldset key={g.id} className="policy-group card">
            <legend>
              <h3>
                {g.title}
                {changed ? <span className="badge badge-info">{changed} changed</span> : null}
              </h3>
            </legend>
            {body}
          </fieldset>
        );
      })}
    </div>
  );
}

function PolicyFieldRow({
  field,
  value,
  defaultValue,
  defaultsLabel,
  error,
  disabled,
  onChange,
  onInvalid,
}: {
  field: PolicyField;
  value: unknown;
  defaultValue: unknown;
  defaultsLabel: string;
  error?: string;
  disabled: boolean;
  onChange: (v: unknown) => void;
  onInvalid: (bad: boolean) => void;
}) {
  const changed = value !== defaultValue;
  const id = `pf-${field.path.replace(/\./g, '-')}`;
  // The default, help text and any error are the input's description (WCAG 1.3.1 / 3.3.1).
  const hintId = `${id}-hint`;
  let input: React.ReactNode;
  if (field.kind === 'boolean') {
    input = (
      <label className="switch">
        <input id={id} type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-describedby={hintId} />
        <span>{value ? 'On' : 'Off'}</span>
      </label>
    );
  } else if (field.kind === 'enum') {
    input = (
      <select id={id} value={String(value)} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-describedby={hintId}>
        {field.options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else {
    input = <NumberInput id={id} hintId={hintId} field={field} value={value as number | null} disabled={disabled} onChange={onChange} onInvalid={onInvalid} />;
  }
  return (
    <div className={`policy-field${changed ? ' changed' : ''}`}>
      <label htmlFor={id} className="pf-label">
        {field.label}
        {changed ? (
          <>
            <span className="changed-dot" title="Changed from default" aria-hidden />
            <span className="visually-hidden">(changed from default)</span>
          </>
        ) : null}
      </label>
      <div className="pf-input">{input}</div>
      <div className="pf-hint small muted" id={hintId}>
        {defaultsLabel}: {formatPolicyValue(field, defaultValue)}
        {field.help ? <div className="pf-help">{field.help}</div> : null}
        {error ? <div className="text-danger">{error}</div> : null}
      </div>
    </div>
  );
}

function NumberInput({
  id,
  hintId,
  field,
  value,
  disabled,
  onChange,
  onInvalid,
}: {
  id: string;
  hintId: string;
  field: PolicyField;
  value: number | null;
  disabled: boolean;
  onChange: (v: number | null) => void;
  onInvalid: (bad: boolean) => void;
}) {
  const [text, setText] = useState(value == null ? '' : String(value));
  const [err, setErr] = useState<string | null>(null);
  // Sync when the value changes from outside (e.g. reset to defaults).
  useEffect(() => {
    const parsed = parsePolicyNumber(field, text);
    if (!('value' in parsed) || parsed.value !== value) {
      setText(value == null ? '' : String(value));
      setErr(null);
      onInvalid(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const nullable = field.kind === 'nullableInteger';
  return (
    <div className="num-input">
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={field.min}
        max={field.max}
        step={field.step ?? (field.kind === 'number' ? 'any' : 1)}
        value={text}
        disabled={disabled}
        placeholder={nullable ? field.nullLabel : undefined}
        onChange={(e) => {
          setText(e.target.value);
          const r = parsePolicyNumber(field, e.target.value);
          if ('error' in r) {
            setErr(r.error);
            onInvalid(true);
          } else {
            setErr(null);
            onInvalid(false);
            onChange(r.value);
          }
        }}
        aria-invalid={Boolean(err)}
        aria-describedby={err ? `${id}-err ${hintId}` : hintId}
      />
      {field.unit ? <span className="unit">{field.unit}</span> : null}
      {nullable ? (
        <label className="inline small">
          <input
            type="checkbox"
            checked={value == null}
            disabled={disabled}
            onChange={(e) => {
              if (e.target.checked) {
                setText('');
                setErr(null);
                onInvalid(false);
                onChange(null);
              } else {
                const start = field.min ?? 1;
                setText(String(start));
                onChange(start);
              }
            }}
          />
          {field.nullLabel}
        </label>
      ) : null}
      {err ? (
        <span className="text-danger small" id={`${id}-err`} role="alert">
          {err}
        </span>
      ) : null}
    </div>
  );
}

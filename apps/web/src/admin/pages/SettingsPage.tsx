import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_IDENTITY_THRESHOLDS, DEFAULT_POLICY, type OrgSettingsDTO } from '@sp/shared';
import { api, errorMessage, shouldRetry } from '../api/client';
import { qk } from '../api/queries';
import { normalizePolicy, validatePolicy } from '../lib/policyForm';
import { ErrorState, Loading, PageHeader } from '../components/Common';
import { PolicyEditor } from '../components/PolicyEditor';

export function SettingsPage() {
  const q = useQuery({ queryKey: qk.settings, queryFn: api.settings, retry: shouldRetry });
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return <SettingsForm key={JSON.stringify(q.data)} initial={q.data} />;
}

interface Draft {
  name: string;
  evidenceRetentionDays: string;
  eventRetentionDays: string;
  privacyContact: string;
  match: string;
  mismatch: string;
  idPhotoMatch: string;
  idPhotoMismatch: string;
  mismatchConfirmations: string;
}

function toDraft(s: OrgSettingsDTO): Draft {
  return {
    name: s.name,
    evidenceRetentionDays: String(s.evidenceRetentionDays),
    eventRetentionDays: String(s.eventRetentionDays),
    privacyContact: s.privacyContact,
    match: String(s.identityThresholds.match),
    mismatch: String(s.identityThresholds.mismatch),
    idPhotoMatch: String(s.identityThresholds.idPhotoMatch),
    idPhotoMismatch: String(s.identityThresholds.idPhotoMismatch),
    mismatchConfirmations: String(s.identityThresholds.mismatchConfirmations),
  };
}

/** Validation for the settings form; returns messages keyed by field. Exported for tests. */
export function validateSettingsDraft(d: Draft): Record<string, string> {
  const e: Record<string, string> = {};
  const int = (v: string) => Number.isInteger(Number(v)) && v.trim() !== '';
  const unit = (v: string) => v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1;
  if (!d.name.trim()) e.name = 'Required';
  if (!int(d.evidenceRetentionDays) || +d.evidenceRetentionDays < 1 || +d.evidenceRetentionDays > 3650) e.evidenceRetentionDays = 'Whole number of days, 1–3650';
  if (!int(d.eventRetentionDays) || +d.eventRetentionDays < 30 || +d.eventRetentionDays > 3650) e.eventRetentionDays = 'Whole number of days, 30–3650';
  for (const k of ['match', 'mismatch', 'idPhotoMatch', 'idPhotoMismatch'] as const) if (!unit(d[k])) e[k] = 'A number between 0 and 1';
  if (!e.match && !e.mismatch && +d.mismatch >= +d.match) e.mismatch = 'Must be lower than the match threshold';
  if (!e.idPhotoMatch && !e.idPhotoMismatch && +d.idPhotoMismatch >= +d.idPhotoMatch) e.idPhotoMismatch = 'Must be lower than the ID-photo match threshold';
  if (!int(d.mismatchConfirmations) || +d.mismatchConfirmations < 1 || +d.mismatchConfirmations > 10) e.mismatchConfirmations = 'Whole number, 1–10';
  return e;
}

function SettingsForm({ initial }: { initial: OrgSettingsDTO }) {
  const qc = useQueryClient();
  const [d, setD] = useState<Draft>(() => toDraft(initial));
  const [policy, setPolicy] = useState(() => normalizePolicy(initial.defaultPolicy));
  const [invalidPolicy, setInvalidPolicy] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const errors = validateSettingsDraft(d);
  const policyCheck = validatePolicy(policy);
  const hasErrors = Object.keys(errors).length > 0 || !policyCheck.ok || invalidPolicy.length > 0;
  const thresholdsChanged =
    +d.match !== initial.identityThresholds.match ||
    +d.mismatch !== initial.identityThresholds.mismatch ||
    +d.idPhotoMatch !== initial.identityThresholds.idPhotoMatch ||
    +d.idPhotoMismatch !== initial.identityThresholds.idPhotoMismatch ||
    +d.mismatchConfirmations !== initial.identityThresholds.mismatchConfirmations;

  const set = (patch: Partial<Draft>) => {
    setD((x) => ({ ...x, ...patch }));
    setSaved(false);
  };
  const m = useMutation({
    mutationFn: () =>
      api.updateSettings({
        name: d.name.trim(),
        evidenceRetentionDays: Number(d.evidenceRetentionDays),
        eventRetentionDays: Number(d.eventRetentionDays),
        privacyContact: d.privacyContact.trim(),
        defaultPolicy: policy,
        identityThresholds: {
          match: Number(d.match),
          mismatch: Number(d.mismatch),
          idPhotoMatch: Number(d.idPhotoMatch),
          idPhotoMismatch: Number(d.idPhotoMismatch),
          mismatchConfirmations: Number(d.mismatchConfirmations),
        },
      }),
    onSuccess: (s) => {
      qc.setQueryData(qk.settings, s);
      void qc.invalidateQueries({ queryKey: qk.me });
      setSaved(true);
    },
  });

  const field = (key: keyof Draft, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}, hint?: string) => (
    <label>
      {label}
      <input value={d[key]} onChange={(e) => set({ [key]: e.target.value } as Partial<Draft>)} aria-invalid={!!errors[key]} {...props} />
      {hint ? <span className="muted small">{hint}</span> : null}
      {errors[key] ? <span className="text-danger small">{errors[key]}</span> : null}
    </label>
  );

  return (
    <form
      className="stack settings-page"
      onSubmit={(e) => {
        e.preventDefault();
        if (!hasErrors) m.mutate();
      }}
    >
      <PageHeader title="Settings" subtitle="Organisation-wide defaults. Individual exams can override the proctoring policy and evidence retention." />
      <section className="card stack">
        <h2>Organisation</h2>
        <div className="grid-2">
          {field('name', 'Organisation name', { type: 'text', maxLength: 200 })}
          {field('privacyContact', 'Privacy contact', { type: 'text', maxLength: 500 }, 'Shown to candidates in the privacy notice (email or URL).')}
        </div>
      </section>
      <section className="card stack">
        <h2>Retention</h2>
        <div className="grid-2">
          {field(
            'evidenceRetentionDays',
            'Keep screenshots and identity images for (days after the session ends)',
            { type: 'number', min: 1, max: 3650, step: 1 },
            'Sessions under legal hold are not purged. Exams may set their own period.',
          )}
          {field('eventRetentionDays', 'Keep event records (without images) for (days)', { type: 'number', min: 30, max: 3650, step: 1 })}
        </div>
      </section>
      <section className="card stack">
        <h2>Identity decision thresholds</h2>
        <div className="banner banner-warning small">
          <strong>Change these only on the basis of an offline evaluation on your own consented data</strong> (see the Quality page and <code>docs/accuracy/</code>).
          Raising the match threshold or lowering the mismatch threshold increases “inconclusive” results; moving the mismatch threshold up increases false “possible
          different person” events, which put genuine candidates on hold. Changes apply to new identity checks only and are audit-logged.
        </div>
        <div className="grid-2">
          {field('match', 'Match threshold (same person at or above)', { type: 'number', min: 0, max: 1, step: 0.01 }, `Default ${DEFAULT_IDENTITY_THRESHOLDS.match}`)}
          {field('mismatch', 'Mismatch threshold (possible different person below)', { type: 'number', min: 0, max: 1, step: 0.01 }, `Default ${DEFAULT_IDENTITY_THRESHOLDS.mismatch}`)}
          {field('idPhotoMatch', 'ID photo: match threshold', { type: 'number', min: 0, max: 1, step: 0.01 }, `Default ${DEFAULT_IDENTITY_THRESHOLDS.idPhotoMatch}`)}
          {field('idPhotoMismatch', 'ID photo: mismatch threshold', { type: 'number', min: 0, max: 1, step: 0.01 }, `Default ${DEFAULT_IDENTITY_THRESHOLDS.idPhotoMismatch}`)}
          {field(
            'mismatchConfirmations',
            'Consecutive mismatches before raising an event',
            { type: 'number', min: 1, max: 10, step: 1 },
            `Default ${DEFAULT_IDENTITY_THRESHOLDS.mismatchConfirmations}. Single samples never raise an event on their own.`,
          )}
        </div>
        {thresholdsChanged ? <div className="banner banner-danger small">You are changing identity thresholds.</div> : null}
      </section>
      <section className="stack">
        <div className="row">
          <h2>Default proctoring policy</h2>
          <div className="spacer" />
          <button type="button" className="btn btn-sm" onClick={() => setPolicy(DEFAULT_POLICY)}>
            Reset to product defaults
          </button>
        </div>
        <p className="muted small">Used as the starting point for new exams.</p>
        <PolicyEditor
          value={policy}
          onChange={(p) => {
            setPolicy(p);
            setSaved(false);
          }}
          defaults={DEFAULT_POLICY}
          defaultsLabel="Product default"
          errors={policyCheck.ok ? {} : policyCheck.errors}
          onValidity={setInvalidPolicy}
        />
      </section>
      <div className="sticky-actions">
        {hasErrors ? <span className="text-danger">Fix the highlighted fields before saving.</span> : null}
        {m.isError ? <span className="text-danger">{errorMessage(m.error)}</span> : null}
        {saved ? <span className="text-success">Settings saved.</span> : null}
        <div className="spacer" />
        <button type="submit" className="btn btn-primary" disabled={hasErrors || m.isPending}>
          {m.isPending ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </form>
  );
}

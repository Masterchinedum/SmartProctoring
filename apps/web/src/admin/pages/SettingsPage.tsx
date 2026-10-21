import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_POLICY, MFA_REQUIREMENT_LABEL, MFA_REQUIREMENTS, mfaRequiredFor, type MfaRequirement, type OrgSettingsDTO } from '@sp/shared';
import { useAuth } from '../auth';
import { api, errorMessage, shouldRetry } from '../api/client';
import { qk } from '../api/queries';
import { normalizePolicy, validatePolicy } from '../lib/policyForm';
import { ErrorState, Loading, PageHeader } from '../components/Common';
import { PolicyEditor } from '../components/PolicyEditor';

export function SettingsPage() {
  const q = useQuery({ queryKey: qk.settings, queryFn: api.settings, retry: shouldRetry });
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <div className="stack">
      <SettingsForm key={JSON.stringify(q.data)} initial={q.data} />
      <ReviewTargetsSection key={`sla-${JSON.stringify(q.data.reviewSla)}`} settings={q.data} />
      <SecuritySection settings={q.data} />
    </div>
  );
}

/** Service-level targets for review work: shown in the review queue, on the dashboard and as monitoring metrics. */
function ReviewTargetsSection({ settings }: { settings: OrgSettingsDTO }) {
  const qc = useQueryClient();
  const [hold, setHold] = useState(String(settings.reviewSla.holdMinutes));
  const [flags, setFlags] = useState(String(settings.reviewSla.flagHours));
  const h = Number(hold);
  const f = Number(flags);
  const valid = Number.isInteger(h) && h >= 1 && h <= 1440 && Number.isInteger(f) && f >= 1 && f <= 720;
  const changed = h !== settings.reviewSla.holdMinutes || f !== settings.reviewSla.flagHours;
  const m = useMutation({
    mutationFn: () => api.updateSettings({ reviewSla: { holdMinutes: h, flagHours: f } }),
    onSuccess: (s) => {
      qc.setQueryData(qk.settings, s);
      void qc.invalidateQueries({ queryKey: qk.reviewQueueAll });
    },
  });
  return (
    <section className="card stack" aria-labelledby="sla-title" data-testid="settings-review-targets">
      <h2 id="sla-title">Review targets</h2>
      <p className="small muted">
        How quickly staff should decide. A held exam keeps the candidate waiting, so its target is in minutes. Reviews past a target are marked overdue in the review queue and
        on the dashboard, and counted in the monitoring metrics.
      </p>
      <form
        className="grid-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && changed) m.mutate();
        }}
      >
        <label>
          Decide a held exam within (minutes)
          <input type="number" min={1} max={1440} value={hold} onChange={(e) => setHold(e.target.value)} required />
        </label>
        <label>
          Decide flags within (hours)
          <input type="number" min={1} max={720} value={flags} onChange={(e) => setFlags(e.target.value)} required />
        </label>
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={!valid || !changed || m.isPending}>
            {m.isPending ? 'Saving…' : 'Save targets'}
          </button>
        </div>
      </form>
      {m.isError ? <div className="banner banner-danger" role="alert">{errorMessage(m.error)}</div> : null}
    </section>
  );
}

/** Who must use two-step sign-in. Only an owner can change it (an admin could otherwise exempt administrators). */
function SecuritySection({ settings }: { settings: OrgSettingsDTO }) {
  const { isOwner } = useAuth();
  const qc = useQueryClient();
  const [value, setValue] = useState<MfaRequirement>(settings.requireMfa);
  const users = useQuery({ queryKey: qk.users, queryFn: api.users, retry: shouldRetry });
  const m = useMutation({
    mutationFn: () => api.updateSettings({ requireMfa: value }),
    onSuccess: (s) => {
      qc.setQueryData(qk.settings, s);
      void qc.invalidateQueries({ queryKey: qk.me });
    },
  });
  const active = (users.data?.items ?? []).filter((u) => !u.disabled);
  const without = active.filter((u) => !u.mfaEnabledAt && mfaRequiredFor(value, u.role));
  return (
    <section className="card stack" aria-labelledby="security-title" data-testid="settings-security">
      <h2 id="security-title">Two-step sign-in</h2>
      <p className="small muted">
        Staff who must use it and have not set it up can only set it up at their next request — nothing else is available to them until they have. Everyone can turn it on for
        themselves under Account &amp; security.
      </p>
      <label>
        Requirement
        <select value={value} disabled={!isOwner || m.isPending} onChange={(e) => setValue(e.target.value as MfaRequirement)} aria-describedby="mfa-req-hint">
          {MFA_REQUIREMENTS.map((r) => (
            <option key={r} value={r}>
              {MFA_REQUIREMENT_LABEL[r]}
            </option>
          ))}
        </select>
        <span id="mfa-req-hint" className="small muted">
          {isOwner ? 'Changes are recorded in the audit log.' : 'Only an owner can change this.'}
        </span>
      </label>
      {users.data ? (
        <div className="small">
          {active.filter((u) => u.mfaEnabledAt).length} of {active.length} active staff use two-step sign-in.
          {value !== 'off' && without.length ? ` ${without.length} required staff have not set it up yet: ${without.map((u) => u.name).join(', ')}.` : ''}
        </div>
      ) : null}
      {m.isError ? <div className="banner banner-danger" role="alert">{errorMessage(m.error)}</div> : null}
      {isOwner ? (
        <div className="row">
          <button type="button" className="btn btn-primary" disabled={value === settings.requireMfa || m.isPending} onClick={() => m.mutate()}>
            {m.isPending ? 'Saving…' : 'Save requirement'}
          </button>
        </div>
      ) : null}
    </section>
  );
}

interface Draft {
  name: string;
  evidenceRetentionDays: string;
  eventRetentionDays: string;
  abandonAfterDays: string;
  privacyContact: string;
}

function toDraft(s: OrgSettingsDTO): Draft {
  return {
    name: s.name,
    evidenceRetentionDays: String(s.evidenceRetentionDays),
    eventRetentionDays: String(s.eventRetentionDays),
    abandonAfterDays: String(s.abandonAfterDays),
    privacyContact: s.privacyContact,
  };
}

/** Validation for the settings form; returns messages keyed by field. Exported for tests. */
export function validateSettingsDraft(d: Draft): Record<string, string> {
  const e: Record<string, string> = {};
  const int = (v: string) => Number.isInteger(Number(v)) && v.trim() !== '';
  if (!d.name.trim()) e.name = 'Required';
  if (!int(d.evidenceRetentionDays) || +d.evidenceRetentionDays < 1 || +d.evidenceRetentionDays > 3650) e.evidenceRetentionDays = 'Whole number of days, 1–3650';
  if (!int(d.eventRetentionDays) || +d.eventRetentionDays < 30 || +d.eventRetentionDays > 3650) e.eventRetentionDays = 'Whole number of days, 30–3650';
  if (!int(d.abandonAfterDays) || +d.abandonAfterDays < 1 || +d.abandonAfterDays > 3650) e.abandonAfterDays = 'Whole number of days, 1–3650';
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
        abandonAfterDays: Number(d.abandonAfterDays),
        privacyContact: d.privacyContact.trim(),
        defaultPolicy: policy,
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
      <PageHeader
        title="Settings"
        subtitle="Organisation-wide defaults. Individual exams can override the proctoring policy and evidence retention."
        actions={
          <Link className="btn" to="/admin/integrations">
            Integrations: API keys, webhooks, email alerts, face verifier ›
          </Link>
        }
      />
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
          {field(
            'abandonAfterDays',
            'Close unfinished sessions after this many days without activity',
            { type: 'number', min: 1, max: 3650, step: 1 },
            'Invited, ready, paused or on-hold sessions (and started sessions whose timer is stopped) with no candidate or staff activity are closed as “closed after inactivity” — no score, answers kept — so the retention periods above can apply.',
          )}
        </div>
      </section>
      <section className="card stack" data-testid="settings-thresholds">
        <h2>Identity decision thresholds</h2>
        <p className="small">
          Version {initial.decisionConfigVersion}: same person at or above <strong>{initial.identityThresholds.match}</strong>, possible different person below{' '}
          <strong>{initial.identityThresholds.mismatch}</strong> (ID photo: {initial.identityThresholds.idPhotoMatch} / {initial.identityThresholds.idPhotoMismatch};{' '}
          {initial.identityThresholds.mismatchConfirmations} confirmations).
        </p>
        <p className="small muted">
          The thresholds are versioned. A change is proposed with a reason, previewed on recent identity samples and approved by a second administrator; an earlier
          version can be restored at once. Every identity decision records the version that made it.
        </p>
        <div>
          <Link className="btn btn-sm" to="/admin/quality">
            Decision configuration on the Detection quality page ›
          </Link>
        </div>
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

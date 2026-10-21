import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type CalibrationSegmentDTO,
  type DecisionConfigDTO,
  type DecisionThresholds,
  type DriftSignalDTO,
} from '@sp/shared';
import { api, errorMessage, shouldRetry } from '../api/client';
import { qk } from '../api/queries';
import { useAuth } from '../auth';
import { formatDate, formatDateTime, formatPercent } from '../lib/format';
import { CALIBRATION_DIMENSION_LABELS, DRIFT_METRIC_LABELS, driftSegmentLabel, impactSummary, rate, thresholdChanges, validateThresholdDraft, type ThresholdDraft } from '../lib/governance';
import { EmptyState, ErrorState, Loading } from '../components/Common';
import { Modal } from '../components/Modal';

const STATUS_CLASS: Record<DecisionConfigDTO['status'], string> = {
  active: 'badge badge-success',
  proposed: 'badge badge-warning',
  retired: 'badge',
  rejected: 'badge badge-danger',
  withdrawn: 'badge',
};
const STATUS_LABEL: Record<DecisionConfigDTO['status'], string> = { active: 'Active', proposed: 'Waiting for approval', retired: 'Retired', rejected: 'Rejected', withdrawn: 'Withdrawn' };

const FIELDS: { key: keyof DecisionThresholds; label: string; step: number; hint: string }[] = [
  { key: 'match', label: 'Match at or above', step: 0.01, hint: 'Similarity of a sample to the reference that counts as the same person.' },
  { key: 'mismatch', label: 'Mismatch below', step: 0.01, hint: 'Similarity below which a sample counts as evidence of a different person.' },
  { key: 'idPhotoMatch', label: 'ID photo: match at or above', step: 0.01, hint: 'Same, for the comparison with the approved ID photo.' },
  { key: 'idPhotoMismatch', label: 'ID photo: mismatch below', step: 0.01, hint: '' },
  { key: 'mismatchConfirmations', label: 'Confirmations', step: 1, hint: 'Non-matching samples in a row for a confirmed mismatch (older decision path).' },
];

/** Versioned identity decision thresholds: propose → preview → approval by a second administrator; rollback. */
export function DecisionConfigPanel() {
  const { user } = useAuth();
  const isAdmin = user.role !== 'reviewer';
  const q = useQuery({ queryKey: qk.decisionConfigs, queryFn: api.decisionConfigs, retry: shouldRetry });
  const [proposing, setProposing] = useState(false);
  const [rollback, setRollback] = useState<DecisionConfigDTO | null>(null);
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const items = q.data.items;
  const active = items.find((c) => c.status === 'active');
  const proposal = items.find((c) => c.status === 'proposed');
  return (
    <section className="card stack" aria-labelledby="decision-config-title" data-testid="decision-config">
      <div className="row">
        <h2 id="decision-config-title">Identity decision configuration</h2>
        {active ? <span className="badge badge-success">v{active.version} active</span> : null}
      </div>
      <p className="small muted">
        The thresholds that label each identity sample. Changes are proposed with a reason, previewed on the last 30 days of samples, and approved by a second
        administrator; every decision records the version that made it. The recogniser model ({q.data.modelVersion}) and its calibration ({q.data.calibrationVersion})
        ship with the server.
      </p>
      {active ? <ThresholdTable config={active} /> : null}
      {proposal ? (
        <ProposalCard proposal={proposal} active={active} canDecide={isAdmin} isProposer={proposal.proposedBy?.id === user.id} />
      ) : isAdmin ? (
        <div className="row">
          <button type="button" className="btn" onClick={() => setProposing(true)} data-testid="propose-config">
            Propose new thresholds…
          </button>
        </div>
      ) : null}
      <details className="decision-history">
        <summary>History ({items.length} version{items.length === 1 ? '' : 's'})</summary>
        <table className="table compact">
          <thead>
            <tr>
              <th>Version</th>
              <th>Status</th>
              <th>Thresholds</th>
              <th>Why</th>
              <th>Approved / decided</th>
              <th>Exams started</th>
              <th>
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id} data-testid={`config-v${c.version}`}>
                <td>
                  v{c.version}
                  {c.rollbackOfVersion ? <div className="small muted">restores v{c.rollbackOfVersion}</div> : null}
                </td>
                <td>
                  <span className={STATUS_CLASS[c.status]}>{STATUS_LABEL[c.status]}</span>
                </td>
                <td className="small">{c.releaseDefaults ? 'Release defaults' : `match ≥ ${c.thresholds.match}, mismatch < ${c.thresholds.mismatch}`}</td>
                <td className="small">{c.note}</td>
                <td className="small">
                  {c.decidedBy ? (
                    <>
                      {c.decidedBy.name}, {formatDate(c.decidedAt)}
                      {c.selfApproved ? <div className="muted">self-approved (no other administrator)</div> : null}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td>{c.sessions}</td>
                <td>
                  {isAdmin && c.status === 'retired' ? (
                    <button type="button" className="btn btn-sm" onClick={() => setRollback(c)}>
                      Restore…
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      {proposing && active ? <ProposeDialog active={active} onClose={() => setProposing(false)} /> : null}
      {rollback && active ? <RollbackDialog target={rollback} active={active} onClose={() => setRollback(null)} /> : null}
    </section>
  );
}

function ThresholdTable({ config }: { config: DecisionConfigDTO }) {
  return (
    <div className="small">
      {config.releaseDefaults ? <span className="badge">Release defaults</span> : null} Match ≥ <strong>{config.thresholds.match}</strong> · mismatch &lt;{' '}
      <strong>{config.thresholds.mismatch}</strong> · ID photo: match ≥ <strong>{config.thresholds.idPhotoMatch}</strong>, mismatch &lt;{' '}
      <strong>{config.thresholds.idPhotoMismatch}</strong> · confirmations <strong>{config.thresholds.mismatchConfirmations}</strong>
      {config.activatedAt ? <span className="muted"> · active since {formatDateTime(config.activatedAt)}</span> : null}
    </div>
  );
}

function useConfigInvalidation() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: qk.decisionConfigs });
    void qc.invalidateQueries({ queryKey: qk.settings });
  };
}

function ProposalCard({ proposal, active, canDecide, isProposer }: { proposal: DecisionConfigDTO; active: DecisionConfigDTO | undefined; canDecide: boolean; isProposer: boolean }) {
  const invalidate = useConfigInvalidation();
  const [note, setNote] = useState('');
  const impact = useQuery({ queryKey: qk.decisionConfigImpact(proposal.id), queryFn: () => api.decisionConfigImpact(proposal.id), enabled: canDecide, retry: shouldRetry });
  const m = useMutation({ mutationFn: (d: 'approve' | 'reject' | 'withdraw') => api.decideDecisionConfig(proposal.id, d, note.trim() || undefined), onSuccess: invalidate });
  const changes = active ? thresholdChanges(active.thresholds, proposal.thresholds) : [];
  return (
    <div className="banner banner-warning stack" data-testid="config-proposal">
      <div>
        <strong>Version {proposal.version} is waiting for approval</strong> — proposed by {proposal.proposedBy?.name ?? 'staff'} on {formatDateTime(proposal.proposedAt)}.
      </div>
      <ul className="small">
        {changes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <blockquote className="review-note">{proposal.note}</blockquote>
      {impact.data ? (
        <div className="small" data-testid="config-impact">
          {impactSummary(impact.data)}
        </div>
      ) : impact.isPending && canDecide ? (
        <div className="small muted">Previewing the effect on recent samples…</div>
      ) : null}
      {canDecide ? (
        <>
          <label>
            Note (optional)
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
          </label>
          <div className="row tight">
            {isProposer ? (
              <button type="button" className="btn btn-sm" disabled={m.isPending} onClick={() => m.mutate('withdraw')}>
                Withdraw
              </button>
            ) : null}
            <button type="button" className="btn btn-sm btn-danger" disabled={m.isPending} onClick={() => m.mutate('reject')} data-testid="config-reject">
              Reject
            </button>
            <button type="button" className="btn btn-sm btn-primary" disabled={m.isPending} onClick={() => m.mutate('approve')} data-testid="config-approve">
              Approve and activate
            </button>
          </div>
          {isProposer ? <div className="small muted">You proposed it: another administrator approves it (unless there is no other active administrator).</div> : null}
        </>
      ) : null}
      {m.isError ? <div className="banner banner-danger" role="alert">{errorMessage(m.error)}</div> : null}
    </div>
  );
}

function ProposeDialog({ active, onClose }: { active: DecisionConfigDTO; onClose: () => void }) {
  const invalidate = useConfigInvalidation();
  const [values, setValues] = useState<ThresholdDraft>(() => Object.fromEntries(FIELDS.map((f) => [f.key, String(active.thresholds[f.key])])) as ThresholdDraft);
  const [note, setNote] = useState('');
  const errors = validateThresholdDraft(values);
  const valid = Object.keys(errors).length === 0;
  const thresholds = Object.fromEntries(FIELDS.map((f) => [f.key, Number(values[f.key])])) as unknown as DecisionThresholds;
  const changes = valid ? thresholdChanges(active.thresholds, thresholds) : [];
  const m = useMutation({
    mutationFn: () => api.proposeDecisionConfig({ thresholds, note: note.trim() }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  return (
    <Modal
      title="Propose new identity thresholds"
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={m.isPending}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={m.isPending || !valid || note.trim().length < 10} onClick={() => m.mutate()} data-testid="propose-submit">
            Propose
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="small">
          Nothing changes until another administrator approves it. Base changes on evidence (the calibration below, the accuracy reports in docs/accuracy, a pilot) — lowering the
          mismatch threshold makes the system slower to suspect a different person; raising it makes false suspicions more likely.
        </p>
        <div className="grid-2">
          {FIELDS.map((f) => (
            <label key={f.key}>
              {f.label}
              <input
                type="number"
                step={f.step}
                min={f.key === 'mismatchConfirmations' ? 1 : 0}
                max={f.key === 'mismatchConfirmations' ? 10 : 1}
                value={values[f.key]}
                aria-invalid={!!errors[f.key]}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                data-testid={`threshold-${f.key}`}
              />
              {f.hint ? <span className="small muted">{f.hint}</span> : null}
              {errors[f.key] ? <span className="text-danger small">{errors[f.key]}</span> : null}
            </label>
          ))}
        </div>
        {changes.length ? (
          <div className="small">
            <strong>Compared with v{active.version}:</strong> {changes.join('; ')}
          </div>
        ) : null}
        <label>
          Why (shown to the approver; at least 10 characters)
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} data-testid="propose-note" />
        </label>
        {m.isError ? <div className="banner banner-danger" role="alert">{errorMessage(m.error)}</div> : null}
      </div>
    </Modal>
  );
}

function RollbackDialog({ target, active, onClose }: { target: DecisionConfigDTO; active: DecisionConfigDTO; onClose: () => void }) {
  const invalidate = useConfigInvalidation();
  const [note, setNote] = useState('');
  const m = useMutation({
    mutationFn: () => api.rollbackDecisionConfig(target.id, note.trim()),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  return (
    <Modal
      title={`Restore version ${target.version}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={m.isPending}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" disabled={m.isPending || note.trim().length < 10} onClick={() => m.mutate()} data-testid="rollback-submit">
            Restore now
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="small">
          Version {target.version} was approved before, so it is restored at once as a new version (replacing v{active.version}) and applies to the next identity decision,
          including in exams in progress. A proposal waiting for approval is withdrawn.
        </p>
        <ul className="small">
          {thresholdChanges(active.thresholds, target.thresholds).map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <label>
          Why (at least 10 characters)
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} data-testid="rollback-note" />
        </label>
        {m.isError ? <div className="banner banner-danger" role="alert">{errorMessage(m.error)}</div> : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ calibration by condition */

export function CalibrationPanel({ from, to }: { from?: number; to?: number }) {
  const [dim, setDim] = useState<CalibrationSegmentDTO['dimension']>('lighting');
  const q = useQuery({ queryKey: qk.calibration({ from, to }), queryFn: () => api.calibration({ from, to }), retry: shouldRetry });
  return (
    <section className="card stack" aria-labelledby="calibration-title" data-testid="calibration">
      <div className="row">
        <h2 id="calibration-title">Identity decisions by condition</h2>
        <label className="inline small">
          Break down by
          <select value={dim} onChange={(e) => setDim(e.target.value as CalibrationSegmentDTO['dimension'])}>
            {Object.entries(CALIBRATION_DIMENSION_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="small muted">
        How identity samples were decided under different conditions. “Could not verify” rising in one segment (e.g. dim light or one browser) points at capture conditions,
        not at candidates. No demographic data is collected; fairness across people is measured in consented pilots.
      </p>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.samples === 0 ? (
        <EmptyState title="No identity samples in this period" />
      ) : (
        <div className="table-wrap">
          <table className="table compact">
            <thead>
              <tr>
                <th>{CALIBRATION_DIMENSION_LABELS[dim]}</th>
                <th>Samples</th>
                <th>Same person</th>
                <th>Inconclusive</th>
                <th>Different person</th>
                <th>Could not verify</th>
              </tr>
            </thead>
            <tbody>
              {q.data.segments
                .filter((s) => s.dimension === dim)
                .map((s) => (
                  <tr key={s.segment}>
                    <td>{s.segment}</td>
                    <td>{s.samples}</td>
                    <td>{formatPercent(rate(s.match, s.samples), 1)}</td>
                    <td>{formatPercent(rate(s.inconclusive, s.samples), 1)}</td>
                    <td>{formatPercent(rate(s.mismatch, s.samples), 1)}</td>
                    <td>{formatPercent(rate(s.unableToVerify, s.samples), 1)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ drift */

export function DriftPanel() {
  const q = useQuery({ queryKey: qk.drift, queryFn: api.drift, retry: shouldRetry });
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const drifting = q.data.signals.filter((s) => s.comparison.drift);
  return (
    <section className="card stack" aria-labelledby="drift-title" data-testid="drift">
      <h2 id="drift-title">Drift: last 7 days against the 28 days before</h2>
      <p className="small muted">
        A signal is flagged only when the change is both large (at least 2 percentage points) and very unlikely to be chance (|z| ≥ 3) with enough data on both sides. Look at
        the version changes first.
      </p>
      {q.data.changes.length ? (
        <div className="small">
          <strong>Changes in this period:</strong>{' '}
          {q.data.changes.map((c, i) => (
            <span key={`${c.kind}-${c.at}`}>
              {i ? ' · ' : ''}
              {c.label} ({formatDate(c.at)})
            </span>
          ))}
        </div>
      ) : null}
      {drifting.length === 0 ? (
        <div className="small" data-testid="drift-none">
          No drift detected ({q.data.signals.length} signal{q.data.signals.length === 1 ? '' : 's'} compared).
        </div>
      ) : (
        <table className="table compact" data-testid="drift-signals">
          <thead>
            <tr>
              <th>Signal</th>
              <th>Segment</th>
              <th>Before</th>
              <th>Last 7 days</th>
              <th>Change</th>
            </tr>
          </thead>
          <tbody>
            {drifting.map((s) => (
              <DriftRow key={`${s.metric}:${s.dimension}:${s.segment}`} s={s} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function DriftRow({ s }: { s: DriftSignalDTO }) {
  const c = s.comparison;
  return (
    <tr>
      <td>{DRIFT_METRIC_LABELS[s.metric]}</td>
      <td>{driftSegmentLabel(s)}</td>
      <td>
        {formatPercent(c.baseline.rate, 1)} <span className="small muted">({c.baseline.k}/{c.baseline.n})</span>
      </td>
      <td>
        {formatPercent(c.recent.rate, 1)} <span className="small muted">({c.recent.k}/{c.recent.n})</span>
      </td>
      <td className={c.delta != null && c.delta > 0 ? 'text-danger' : ''}>
        {c.delta != null ? `${c.delta > 0 ? '+' : ''}${(c.delta * 100).toFixed(1)} pp` : '—'} <span className="small muted">z {c.z}</span>
      </td>
    </tr>
  );
}

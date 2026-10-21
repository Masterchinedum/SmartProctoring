import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ACCOMMODATION_BASES,
  ACCOMMODATION_BASIS_LABEL,
  ACCOMMODATION_CATALOG,
  EXEMPTIBLE_DETECTORS,
  SUPPORT_PERSON_ROLES,
  type AccommodationDTO,
  type AccommodationKind,
} from '@sp/shared';
import { api, errorMessage, shouldRetry } from '../../api/client';
import { qk } from '../../api/queries';
import { ACCOMMODATION_OPTIONS, emptyGrant, grantBody, STATUS_CLASS, STATUS_LABEL, type GrantDraft } from '../../lib/accommodations';
import { formatDate, formatDateTime } from '../../lib/format';
import { ErrorState, Loading } from '../../components/Common';
import { ConfirmDialog, Modal } from '../../components/Modal';

const DETECTOR_LABEL: Record<(typeof EXEMPTIBLE_DETECTORS)[number], string> = {
  absence: 'Absence',
  lookingAway: 'Looking away',
  movement: 'Unusual movement',
  obstruction: 'Face covered / out of view',
  objects: 'Objects (phones, books…)',
  multiplePeople: 'Other people in view',
};
const ROLE_LABEL: Record<(typeof SUPPORT_PERSON_ROLES)[number], string> = { reader: 'Reader', scribe: 'Scribe', interpreter: 'Interpreter', assistant: 'Assistant', other: 'Other' };

/**
 * A candidate's accommodations: approved exceptions to exam rules. A grant reaches the candidate's sessions that have
 * not started yet; a started exam keeps the accommodations it started with.
 */
export function AccommodationsPanel({ candidateId, canEdit }: { candidateId: string; canEdit: boolean }) {
  const q = useQuery({ queryKey: qk.accommodations(candidateId), queryFn: () => api.accommodations(candidateId), retry: shouldRetry });
  const [granting, setGranting] = useState(false);
  const [revoking, setRevoking] = useState<AccommodationDTO | null>(null);
  const [showPast, setShowPast] = useState(false);
  const qc = useQueryClient();
  const revoke = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.revokeAccommodation(id, reason),
    onSuccess: () => {
      setRevoking(null);
      void qc.invalidateQueries({ queryKey: qk.accommodations(candidateId) });
      void qc.invalidateQueries({ queryKey: qk.sessionsAll });
    },
  });
  const items = q.data?.items ?? [];
  const active = items.filter((a) => a.status === 'active');
  const past = items.filter((a) => a.status !== 'active');

  return (
    <section className="card stack" aria-labelledby="accommodations-title" data-testid="accommodations">
      <div className="row">
        <h2 id="accommodations-title">Accommodations</h2>
        <div className="spacer" />
        {canEdit ? (
          <button type="button" className="btn btn-sm" onClick={() => setGranting(true)}>
            Add accommodation…
          </button>
        ) : null}
      </div>
      <p className="small muted">
        Approved exceptions to exam rules, such as extra time or identity verified by staff. They apply to this candidate’s exams that have not started yet; an exam already started
        keeps what it started with. Every change is recorded in the audit log, and each exam shows exactly which rules were changed.
      </p>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : active.length === 0 ? (
        <div className="muted small">No active accommodations.</div>
      ) : (
        <AccommodationList items={active} canEdit={canEdit} onRevoke={setRevoking} />
      )}
      {past.length ? (
        <details open={showPast} onToggle={(e) => setShowPast((e.target as HTMLDetailsElement).open)}>
          <summary className="small">Ended ({past.length})</summary>
          <AccommodationList items={past} canEdit={false} onRevoke={setRevoking} />
        </details>
      ) : null}
      {granting ? <GrantDialog candidateId={candidateId} onClose={() => setGranting(false)} /> : null}
      {revoking ? (
        <ConfirmDialog
          title="Revoke accommodation?"
          message={
            <>
              <strong>{revoking.label}</strong> stops applying to this candidate’s exams that have not started yet. Exams already started keep it.
            </>
          }
          requireText="Reason (recorded in the audit log)"
          confirmLabel="Revoke"
          danger
          busy={revoke.isPending}
          error={revoke.isError ? errorMessage(revoke.error) : null}
          onConfirm={(reason) => revoke.mutate({ id: revoking.id, reason })}
          onCancel={() => setRevoking(null)}
        />
      ) : null}
    </section>
  );
}

function AccommodationList({ items, canEdit, onRevoke }: { items: AccommodationDTO[]; canEdit: boolean; onRevoke: (a: AccommodationDTO) => void }) {
  return (
    <ul className="accommodation-list">
      {items.map((a) => (
        <li key={a.id} data-testid={`accommodation-${a.kind}`}>
          <div className="row tight">
            <strong>{a.label}</strong>
            <span className={STATUS_CLASS[a.status]}>{STATUS_LABEL[a.status]}</span>
            <div className="spacer" />
            {canEdit && a.status === 'active' ? (
              <button type="button" className="btn btn-sm" onClick={() => onRevoke(a)}>
                Revoke…
              </button>
            ) : null}
          </div>
          <div className="small muted">
            {a.exam ? `Only for ${a.exam.title}` : 'All exams'} · {ACCOMMODATION_BASIS_LABEL[a.basis]} · granted {formatDateTime(a.grantedAt)}
            {a.grantedBy ? ` by ${a.grantedBy.name}` : ''}
            {a.validUntil ? ` · until ${formatDate(a.validUntil)}` : ''}
          </div>
          {a.revokedAt ? (
            <div className="small muted">
              Revoked {formatDateTime(a.revokedAt)}
              {a.revokedBy ? ` by ${a.revokedBy.name}` : ''}: {a.revokeReason}
            </div>
          ) : null}
          {a.note ? <div className="small pre-wrap accommodation-note">{a.note}</div> : null}
        </li>
      ))}
    </ul>
  );
}

function GrantDialog({ candidateId, onClose }: { candidateId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [d, setD] = useState<GrantDraft>(() => emptyGrant());
  const [error, setError] = useState<string | null>(null);
  const exams = useQuery({ queryKey: qk.exams, queryFn: api.exams, retry: shouldRetry });
  const m = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.grantAccommodation(candidateId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.accommodations(candidateId) });
      void qc.invalidateQueries({ queryKey: qk.candidate(candidateId) });
      void qc.invalidateQueries({ queryKey: qk.sessionsAll });
      onClose();
    },
  });
  const set = (patch: Partial<GrantDraft>) => {
    setError(null);
    setD((x) => ({ ...x, ...patch }));
  };
  const info = ACCOMMODATION_CATALOG[d.kind];
  const submit = () => {
    const r = grantBody(d);
    if (!r.ok) setError(r.error);
    else m.mutate(r.body);
  };

  return (
    <Modal
      title="Add accommodation"
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={m.isPending}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={m.isPending}>
            {m.isPending ? 'Saving…' : 'Add accommodation'}
          </button>
        </>
      }
    >
      <div className="stack">
        <label>
          Accommodation
          <select value={d.kind} onChange={(e) => set({ kind: e.target.value as AccommodationKind })}>
            {ACCOMMODATION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="small muted">{info.description}</span>
        </label>

        {d.kind === 'extra_time' ? (
          <div className="grid-2">
            <label>
              Extra time (% of the exam’s duration)
              <input type="number" min={0} max={300} step={5} value={d.percent} onChange={(e) => set({ percent: e.target.value })} />
            </label>
            <label>
              Plus minutes
              <input type="number" min={0} max={600} value={d.minutes} onChange={(e) => set({ minutes: e.target.value })} placeholder="0" />
            </label>
          </div>
        ) : null}
        {d.kind === 'rest_breaks' ? (
          <div className="grid-2">
            <label>
              Number of breaks (empty: no limit)
              <input type="number" min={1} max={50} value={d.maxPauses} onChange={(e) => set({ maxPauses: e.target.value })} />
            </label>
            <label>
              Length of each break in minutes (empty: no limit)
              <input type="number" min={1} max={240} value={d.maxPauseMinutes} onChange={(e) => set({ maxPauseMinutes: e.target.value })} />
            </label>
          </div>
        ) : null}
        {d.kind === 'detection_exemptions' ? (
          <fieldset className="stack tight">
            <legend>Observations to turn off</legend>
            {EXEMPTIBLE_DETECTORS.map((k) => (
              <label key={k} className="inline">
                <input type="checkbox" checked={d.detectors[k]} onChange={(e) => set({ detectors: { ...d.detectors, [k]: e.target.checked } })} />
                {DETECTOR_LABEL[k]}
              </label>
            ))}
          </fieldset>
        ) : null}
        {d.kind === 'support_person' ? (
          <label>
            Role
            <select value={d.role} onChange={(e) => set({ role: e.target.value as GrantDraft['role'] })}>
              {SUPPORT_PERSON_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {d.kind === 'staff_identity_verification' || d.kind === 'no_camera' ? (
          <label className="inline">
            <input type="checkbox" checked={d.reverifyOnContinue} onChange={(e) => set({ reverifyOnContinue: e.target.checked })} />
            Staff also verify identity again after each pause or reconnection (the exam waits for them)
          </label>
        ) : null}

        <div className="grid-2">
          <label>
            Applies to
            <select value={d.examId} onChange={(e) => set({ examId: e.target.value })}>
              <option value="">All of this candidate’s exams</option>
              {(exams.data?.items ?? [])
                .filter((e) => e.status !== 'archived')
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    Only {e.title}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Ends (optional)
            <input type="date" value={d.validUntil} onChange={(e) => set({ validUntil: e.target.value })} />
          </label>
        </div>
        <label>
          Basis
          <select value={d.basis} onChange={(e) => set({ basis: e.target.value as GrantDraft['basis'] })}>
            {ACCOMMODATION_BASES.map((b) => (
              <option key={b} value={b}>
                {ACCOMMODATION_BASIS_LABEL[b]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Note for administrators (optional)
          <textarea value={d.note} onChange={(e) => set({ note: e.target.value })} maxLength={2000} rows={2} placeholder="e.g. Approved by disability services, reference 2026-114" />
          <span className="small muted">Encrypted, and visible to administrators only. Do not record diagnoses or health details.</span>
        </label>
        {error || m.isError ? (
          <div className="banner banner-danger" role="alert">
            {error ?? errorMessage(m.error)}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

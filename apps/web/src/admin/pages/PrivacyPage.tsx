import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MAX_PRIVACY_EXTENSION_DAYS,
  PRIVACY_DUE_SOON_DAYS,
  PRIVACY_REQUEST_CHANNELS,
  PRIVACY_REQUEST_INFO,
  PRIVACY_REQUEST_KINDS,
  PRIVACY_REQUEST_STATUSES,
  type CreatePrivacyRequest,
  type PrivacyRequestDTO,
  type PrivacyRequestStatus,
  type UpdatePrivacyRequest,
} from '@sp/shared';
import { api, errorMessage, shouldRetry } from '../api/client';
import { qk } from '../api/queries';
import { tabProps } from '../../lib/a11y';
import { formatDate, formatDateTime, pluralize } from '../lib/format';
import {
  CHANNEL_LABEL,
  dueLabel,
  isClosed,
  localDate,
  OPS_STATUS_CLASS,
  OPS_STATUS_LABEL,
  receivedAtFromDate,
  REQUEST_STATUS_CLASS,
  REQUEST_STATUS_LABEL,
  retentionJobLine,
  validateExtension,
  validateNewRequest,
  type NewRequestDraft,
} from '../lib/privacy';
import { EmptyState, ErrorState, Loading, PageHeader, Stat } from '../components/Common';
import { ConfirmDialog, Modal } from '../components/Modal';

type ListFilter = 'open' | 'closed' | 'all';
const FILTERS: readonly ListFilter[] = ['open', 'closed', 'all'];
const FILTER_LABEL: Record<ListFilter, string> = { open: 'Open', closed: 'Closed', all: 'All' };

/** Privacy operations: the register of data-subject requests, deletion on schedule, and operational checks (admin). */
export function PrivacyPage() {
  return (
    <div className="stack">
      <PageHeader
        title="Privacy"
        subtitle="Requests people make about their data, with their legal deadlines; what the retention job deletes and when; and checks that the system is doing its job."
      />
      <OpsChecksSection />
      <RequestsSection />
      <RetentionSection />
    </div>
  );
}

/* ------------------------------------------------------------------ operational checks */

function OpsChecksSection() {
  const q = useQuery({ queryKey: qk.opsChecks, queryFn: api.opsChecks, retry: shouldRetry, refetchInterval: 60_000 });
  return (
    <section className="card stack" aria-labelledby="ops-title" data-testid="ops-checks">
      <h2 id="ops-title">Operational checks</h2>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <table className="table compact">
          <thead>
            <tr>
              <th>Check</th>
              <th>Status</th>
              <th>What was found</th>
            </tr>
          </thead>
          <tbody>
            {q.data.checks.map((c) => (
              <tr key={c.id} data-testid={`ops-${c.id}`}>
                <td>{c.label}</td>
                <td>
                  <span className={OPS_STATUS_CLASS[c.status]}>{OPS_STATUS_LABEL[c.status]}</span>
                </td>
                <td className="small">{c.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ requests */

function RequestsSection() {
  const [filter, setFilter] = useState<ListFilter>('open');
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useQuery({ queryKey: qk.privacyRequests({ status: filter }), queryFn: () => api.privacyRequests({ status: filter }), retry: shouldRetry, placeholderData: keepPreviousData });
  const now = Date.now();
  const selected = q.data?.items.find((r) => r.id === openId) ?? null;
  return (
    <section className="card stack" aria-labelledby="requests-title" data-testid="privacy-requests">
      <div className="row">
        <h2 id="requests-title">Requests</h2>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)} data-testid="new-privacy-request">
          Record a request…
        </button>
      </div>
      <p className="small muted">
        Record every request about personal data the day it arrives: the legal deadline (one month) counts from then. Exports and erasures are done from the request, so the
        register shows how each one was answered.
      </p>
      {q.data ? (
        <div className="stats-row">
          <Stat label="Open" value={q.data.counts.open} />
          <Stat label="Overdue" value={q.data.counts.overdue} tone={q.data.counts.overdue ? 'danger' : undefined} />
          <Stat label={`Due within ${PRIVACY_DUE_SOON_DAYS} days`} value={q.data.counts.dueSoon} tone={q.data.counts.dueSoon ? 'warning' : undefined} />
        </div>
      ) : null}
      <div className="chips" role="tablist" aria-label="Requests to show">
        {FILTERS.map((f) => (
          <button key={f} type="button" className={`chip${filter === f ? ' on' : ''}`} {...tabProps('privacy', FILTERS, f, filter, setFilter)}>
            {FILTER_LABEL[f]}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="privacy-panel" aria-labelledby={`privacy-tab-${filter}`}>
        {q.isPending ? (
          <Loading />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : q.data.items.length === 0 ? (
          <EmptyState title={filter === 'open' ? 'No open requests' : 'No requests'}>Requests you record appear here.</EmptyState>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Received</th>
                <th>Request</th>
                <th>From</th>
                <th>Deadline</th>
                <th>Status</th>
                <th>Assigned to</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((r) => (
                <tr key={r.id} data-testid={`privacy-request-${r.id}`}>
                  <td>{formatDate(r.receivedAt)}</td>
                  <td>
                    <button type="button" className="link-btn" onClick={() => setOpenId(r.id)}>
                      {PRIVACY_REQUEST_INFO[r.kind].label}
                    </button>
                    {r.source === 'candidate' ? <div className="small muted">made in the exam app</div> : null}
                  </td>
                  <td>
                    {r.subject}
                    {r.candidate ? (
                      <div className="small">
                        <Link to={`/admin/candidates/${r.candidate.id}`}>Candidate record</Link>
                      </div>
                    ) : null}
                  </td>
                  <td>{r.overdue ? <span className="badge badge-danger">{dueLabel(r, now)}</span> : <span className="small">{dueLabel(r, now)}</span>}</td>
                  <td>
                    <span className={REQUEST_STATUS_CLASS[r.status]}>{REQUEST_STATUS_LABEL[r.status]}</span>
                  </td>
                  <td className="small">{r.assignee?.name ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {creating ? <NewRequestDialog onClose={() => setCreating(false)} onCreated={(id) => setOpenId(id)} /> : null}
      {selected ? <RequestDialog request={selected} onClose={() => setOpenId(null)} /> : null}
    </section>
  );
}

function useInvalidatePrivacy() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: qk.privacyAll });
    void qc.invalidateQueries({ queryKey: qk.opsChecks });
  };
}

function NewRequestDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const invalidate = useInvalidatePrivacy();
  const today = localDate(Date.now());
  const [draft, setDraft] = useState<NewRequestDraft>({ kind: 'access', subject: '', candidateId: '', channel: 'email', receivedOn: today, details: '' });
  const [search, setSearch] = useState('');
  const [touched, setTouched] = useState(false);
  const candidates = useQuery({ queryKey: qk.candidates(search.trim()), queryFn: () => api.candidates(search.trim() || undefined), enabled: search.trim().length >= 2, retry: shouldRetry });
  const errors = validateNewRequest(draft, today);
  const valid = Object.keys(errors).length === 0;
  const set = <K extends keyof NewRequestDraft>(k: K, v: NewRequestDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const m = useMutation({
    mutationFn: () =>
      api.createPrivacyRequest({
        kind: draft.kind as CreatePrivacyRequest['kind'],
        subject: draft.subject.trim(),
        candidateId: draft.candidateId || null,
        channel: draft.channel as CreatePrivacyRequest['channel'],
        receivedAt: receivedAtFromDate(draft.receivedOn, today),
        details: draft.details.trim() || undefined,
      }),
    onSuccess: (r) => {
      invalidate();
      onClose();
      onCreated(r.id);
    },
  });
  const err = (k: keyof NewRequestDraft) => (touched && errors[k] ? <span className="text-danger small">{errors[k]}</span> : null);
  return (
    <Modal
      title="Record a privacy request"
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={m.isPending}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={m.isPending}
            onClick={() => {
              setTouched(true);
              if (valid) m.mutate();
            }}
            data-testid="create-privacy-request"
          >
            {m.isPending ? 'Saving…' : 'Record request'}
          </button>
        </>
      }
    >
      <div className="stack">
        <label>
          What was asked
          <select value={draft.kind} onChange={(e) => set('kind', e.target.value)}>
            {PRIVACY_REQUEST_KINDS.filter((k) => k !== 'consent_withdrawal').map((k) => (
              <option key={k} value={k}>
                {PRIVACY_REQUEST_INFO[k].label}
              </option>
            ))}
          </select>
          {draft.kind ? <span className="small muted">{PRIVACY_REQUEST_INFO[draft.kind as keyof typeof PRIVACY_REQUEST_INFO].help}</span> : null}
        </label>
        <label>
          From (name, email or reference)
          <input value={draft.subject} onChange={(e) => set('subject', e.target.value)} maxLength={200} aria-invalid={touched && !!errors.subject} />
          {err('subject')}
        </label>
        <fieldset className="stack-tight">
          <legend>Candidate record (optional)</legend>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name, email or external ID" aria-label="Search candidates" />
          {candidates.data && search.trim().length >= 2 ? (
            <select value={draft.candidateId} onChange={(e) => set('candidateId', e.target.value)} aria-label="Candidate">
              <option value="">No candidate record</option>
              {candidates.data.items.slice(0, 50).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.email ? ` (${c.email})` : ''}
                </option>
              ))}
            </select>
          ) : (
            <span className="small muted">Link the request to a candidate to export or erase their data from it.</span>
          )}
        </fieldset>
        <div className="grid-2">
          <label>
            Received by
            <select value={draft.channel} onChange={(e) => set('channel', e.target.value)}>
              {PRIVACY_REQUEST_CHANNELS.filter((c) => c !== 'candidate_app').map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_LABEL[c]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Received on
            <input type="date" value={draft.receivedOn} max={today} onChange={(e) => set('receivedOn', e.target.value)} aria-invalid={touched && !!errors.receivedOn} />
            {err('receivedOn')}
          </label>
        </div>
        <label>
          What the person asked (kept encrypted; administrators only)
          <textarea value={draft.details} onChange={(e) => set('details', e.target.value)} rows={4} maxLength={4000} />
          {err('details')}
        </label>
        {m.isError ? (
          <div className="banner banner-danger" role="alert">
            {errorMessage(m.error)}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function RequestDialog({ request: r, onClose }: { request: PrivacyRequestDTO; onClose: () => void }) {
  const invalidate = useInvalidatePrivacy();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: qk.users, queryFn: api.users, retry: shouldRetry });
  const [status, setStatus] = useState<PrivacyRequestStatus>(r.status);
  const [assigneeId, setAssigneeId] = useState(r.assignee?.id ?? '');
  const [resolution, setResolution] = useState(r.resolutionNote ?? '');
  const [extDays, setExtDays] = useState(r.extension ? String(r.extension.days) : '');
  const [extReason, setExtReason] = useState('');
  const [confirmErase, setConfirmErase] = useState(false);
  const closed = isClosed(r);
  const closing = (status === 'completed' || status === 'rejected') && status !== r.status;
  const extending = extDays !== '' && extDays !== String(r.extension?.days ?? '');
  const extError = extending ? validateExtension(extDays, extReason, r.extension?.days ?? null) : null;
  const resolutionError = closing && resolution.trim().length < 5 ? 'Say how the request was answered (at least 5 characters).' : null;
  const patch: UpdatePrivacyRequest = {
    ...(status !== r.status ? { status } : {}),
    ...(assigneeId !== (r.assignee?.id ?? '') ? { assigneeId: assigneeId || null } : {}),
    // Closing always carries the note (the server requires it with the status, even when saved before).
    ...(resolution.trim() !== (r.resolutionNote ?? '') || closing ? { resolutionNote: resolution.trim() } : {}),
    ...(extending && !extError ? { extension: { days: Number(extDays), reason: extReason.trim() } } : {}),
  };
  const dirty = Object.keys(patch).length > 0;
  const save = useMutation({ mutationFn: () => api.updatePrivacyRequest(r.id, patch), onSuccess: invalidate });
  const erase = useMutation({
    mutationFn: () => api.erasePrivacyRequest(r.id),
    onSuccess: () => {
      setConfirmErase(false);
      invalidate();
      void qc.invalidateQueries({ queryKey: qk.candidatesAll });
    },
  });
  const assignable = (users.data?.items ?? []).filter((u) => !u.disabled && u.role !== 'reviewer');
  const info = PRIVACY_REQUEST_INFO[r.kind];
  return (
    <Modal
      title={info.label}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn btn-primary" disabled={!dirty || !!extError || !!resolutionError || save.isPending} onClick={() => save.mutate()} data-testid="save-privacy-request">
            {save.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </>
      }
    >
      <div className="stack" data-testid="privacy-request-detail">
        <p className="small muted">{info.help}</p>
        <table className="kv-table">
          <tbody>
            <tr>
              <th scope="row">From</th>
              <td>
                {r.subject}
                {r.candidate ? (
                  <>
                    {' '}
                    · <Link to={`/admin/candidates/${r.candidate.id}`}>{r.candidate.name}</Link>
                  </>
                ) : r.erasedAt ? (
                  <span className="muted"> · candidate erased {formatDateTime(r.erasedAt)}</span>
                ) : null}
              </td>
            </tr>
            <tr>
              <th scope="row">Received</th>
              <td>
                {formatDate(r.receivedAt)} · {CHANNEL_LABEL[r.channel]}
                {r.source === 'candidate' ? ' (made by the candidate in the exam app)' : r.createdBy ? ` · recorded by ${r.createdBy.name}` : ''}
              </td>
            </tr>
            <tr>
              <th scope="row">Deadline</th>
              <td>
                {formatDate(r.dueAt)} — {r.overdue ? <span className="badge badge-danger">{dueLabel(r, Date.now())}</span> : dueLabel(r, Date.now())}
                {r.extension ? (
                  <div className="small muted">
                    Extended by {pluralize(r.extension.days, 'day')}: {r.extension.reason}
                  </div>
                ) : null}
              </td>
            </tr>
            {r.sessionId ? (
              <tr>
                <th scope="row">Exam session</th>
                <td>
                  <Link to={`/admin/sessions/${r.sessionId}`}>Open the session</Link>
                </td>
              </tr>
            ) : null}
            {r.exportedAt ? (
              <tr>
                <th scope="row">Data exported</th>
                <td>{formatDateTime(r.exportedAt)}</td>
              </tr>
            ) : null}
            {r.closedAt ? (
              <tr>
                <th scope="row">Closed</th>
                <td>
                  {formatDateTime(r.closedAt)}
                  {r.closedBy ? ` by ${r.closedBy.name}` : ''}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {r.details ? (
          <div>
            <h3 className="small">What was asked</h3>
            <blockquote className="review-note" style={{ whiteSpace: 'pre-wrap' }}>
              {r.details}
            </blockquote>
          </div>
        ) : null}

        {r.candidate ? (
          <div className="row tight">
            <a className="btn" href={api.privacyExportUrl(r.id)} download onClick={() => setTimeout(invalidate, 1500)} data-testid="privacy-export">
              Export the candidate’s data (ZIP)
            </a>
            {r.kind === 'erasure' && !closed ? (
              <button type="button" className="btn btn-danger" onClick={() => setConfirmErase(true)} data-testid="privacy-erase">
                Erase the candidate…
              </button>
            ) : null}
          </div>
        ) : null}
        {erase.isSuccess ? (
          <div className="banner banner-success" role="status">
            The candidate and their records were erased ({pluralize(erase.data.sessionsDeleted, 'session')}, {pluralize(erase.data.evidencePurged, 'image')}). Complete the request once you have told the person.
          </div>
        ) : null}

        <div className="grid-2">
          <label>
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value as PrivacyRequestStatus)}>
              {PRIVACY_REQUEST_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {REQUEST_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Assigned to
            <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">Nobody</option>
              {assignable.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
              {r.assignee && !assignable.some((u) => u.id === r.assignee!.id) ? <option value={r.assignee.id}>{r.assignee.name}</option> : null}
            </select>
          </label>
        </div>
        <label>
          How it was answered{closing ? '' : ' (required to complete or reject)'}
          <textarea value={resolution} onChange={(e) => setResolution(e.target.value)} rows={3} maxLength={4000} aria-invalid={!!resolutionError} />
          {resolutionError ? <span className="text-danger small">{resolutionError}</span> : null}
        </label>
        {!closed ? (
          <fieldset className="stack-tight">
            <legend>Extend the deadline (up to {MAX_PRIVACY_EXTENSION_DAYS} days in total, with the reason you tell the person)</legend>
            <div className="grid-2">
              <label>
                Extra days in total
                <input type="number" min={1} max={MAX_PRIVACY_EXTENSION_DAYS} value={extDays} onChange={(e) => setExtDays(e.target.value)} />
              </label>
              <label>
                Reason
                <input value={extReason} onChange={(e) => setExtReason(e.target.value)} maxLength={1000} />
              </label>
            </div>
            {extError ? <span className="text-danger small">{extError}</span> : null}
          </fieldset>
        ) : null}
        {save.isError ? (
          <div className="banner banner-danger" role="alert">
            {errorMessage(save.error)}
          </div>
        ) : save.isSuccess && !dirty ? (
          <div className="banner banner-success" role="status">
            Saved.
          </div>
        ) : null}
      </div>
      {confirmErase && r.candidate ? (
        <ConfirmDialog
          title="Erase this candidate?"
          danger
          confirmLabel="Erase permanently"
          busy={erase.isPending}
          error={erase.isError ? errorMessage(erase.error) : null}
          message={
            <>
              <p>
                <strong>{r.candidate.name}</strong>, their exam sessions, answers, events and images are deleted permanently. This cannot be undone. The request stays in the
                register.
              </p>
              <p className="small muted">Refused while an exam of theirs is still running or under legal hold.</p>
            </>
          }
          onConfirm={() => erase.mutate()}
          onCancel={() => setConfirmErase(false)}
        />
      ) : null}
    </Modal>
  );
}

/* ------------------------------------------------------------------ retention */

function RetentionSection() {
  const q = useQuery({ queryKey: qk.retentionPreview, queryFn: () => api.retentionPreview(30), retry: shouldRetry });
  const now = Date.now();
  return (
    <section className="card stack" aria-labelledby="retention-title" data-testid="retention-preview">
      <h2 id="retention-title">Deletion schedule</h2>
      <p className="small muted">
        Images are deleted when each session’s retention period ends (Settings, or the exam’s own rule); event records follow later. A legal hold keeps a session’s images until
        it is lifted.
      </p>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <div className={`banner ${q.data.job.lastError ? 'banner-danger' : q.data.job.stale ? 'banner-warning' : 'banner-info'}`} role="status" data-testid="retention-job">
            {retentionJobLine(q.data.job, now)}
          </div>
          {q.data.overdue.sessions > 0 ? (
            <div className="banner banner-warning" role="status" data-testid="retention-overdue">
              {pluralize(q.data.overdue.evidenceItems, 'image')} of {pluralize(q.data.overdue.sessions, 'session')} are past their
              deletion date (since {formatDate(q.data.overdue.oldestDueAt)}).
            </div>
          ) : null}
          <h3>Next 30 days</h3>
          {q.data.days.length === 0 ? (
            <p className="small muted">No images are due for deletion in the next 30 days.</p>
          ) : (
            <table className="table compact" data-testid="retention-days">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Sessions</th>
                  <th>Images</th>
                </tr>
              </thead>
              <tbody>
                {q.data.days.map((d) => (
                  <tr key={d.date}>
                    <td>{d.date}</td>
                    <td>{d.sessions}</td>
                    <td>{d.evidenceItems}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="small muted">
            Event records (no images) of {pluralize(q.data.eventMetadataSessions, 'session')} are deleted in the same period.
          </p>
          <h3>Legal holds</h3>
          {q.data.legalHolds.length === 0 ? (
            <p className="small muted">No session is under legal hold.</p>
          ) : (
            <table className="table compact" data-testid="legal-holds">
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th>Exam</th>
                  <th>Ended</th>
                  <th>Images kept</th>
                </tr>
              </thead>
              <tbody>
                {q.data.legalHolds.map((h) => (
                  <tr key={h.sessionId}>
                    <td>
                      <Link to={`/admin/sessions/${h.sessionId}`}>{h.candidateName}</Link>
                    </td>
                    <td>{h.examTitle}</td>
                    <td>{h.endedAt ? formatDate(h.endedAt) : 'Not ended'}</td>
                    <td>{h.evidenceItems}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

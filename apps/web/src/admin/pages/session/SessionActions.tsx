import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { STAFF_VERIFICATION_METHOD_LABEL, STAFF_VERIFICATION_METHODS, type SessionDetailDTO, type SessionSummaryDTO, type StaffVerificationMethod } from '@sp/shared';
import { api, errorMessage } from '../../api/client';
import { afterSessionAction } from '../../api/queries';
import { useAuth } from '../../auth';
import { CopyButton } from '../../components/Common';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { Clock, RelativeTime } from '../../components/Time';
import { WindowFields } from '../../components/WindowFields';
import { END_REASON_LABELS } from '../../lib/labels';
import { formatDuration } from '../../lib/format';
import { parseReopenMinutes, parseWindowForm, toLocalInput, type WindowFormValues } from '../../lib/scheduling';

type Dialog = null | 'hold' | 'release' | 'terminate' | 'submit' | 'extend' | 'regenerate' | 'legal' | 'reschedule' | 'reopen';

/** Staff actions for a session, filtered by role and session state. */
export function SessionActions({ d }: { d: SessionDetailDTO }) {
  const s = d.summary;
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [link, setLink] = useState<string | null>(null);
  const terminal = s.status === 'submitted' || s.status === 'terminated';
  const legalHold = s.legalHold;
  const accessLink = link ?? s.accessLink;

  const done = (res?: SessionSummaryDTO) => {
    afterSessionAction(qc, res, s.id);
    setDialog(null);
  };

  const hold = useMutation({ mutationFn: (note: string) => api.hold(s.id, note), onSuccess: done });
  const terminate = useMutation({ mutationFn: (reason: string) => api.terminate(s.id, reason), onSuccess: done });
  const submit = useMutation({ mutationFn: (note: string) => api.staffSubmit(s.id, note), onSuccess: done });
  const legal = useMutation({ mutationFn: (enabled: boolean) => api.legalHold(s.id, enabled), onSuccess: done });
  const regenerate = useMutation({
    mutationFn: () => api.regenerateLink(s.id),
    onSuccess: (r) => {
      setLink(r.accessLink);
      done();
    },
  });

  const canHold = s.status === 'active' || s.status === 'paused' || s.status === 'ready' || s.status === 'invited';
  const canSubmit = s.status === 'active' || s.status === 'paused' || s.status === 'on_hold';
  // The window can change until the exam starts (services/scheduling.ts); an ended exam may be reopened (services/recovery.ts).
  const canReschedule = !terminal && s.startedAt == null;

  return (
    <div className="actions-bar no-print">
      <div className="row">
        {s.status === 'on_hold' ? (
          <button type="button" className={s.hold?.canReverify ? 'btn' : 'btn btn-primary'} onClick={() => setDialog('release')}>
            {s.hold?.reason === 'staff_verification' ? 'Verify identity…' : s.hold?.canReverify ? 'Change release…' : 'Release hold…'}
          </button>
        ) : null}
        {canHold ? (
          <button type="button" className="btn" onClick={() => setDialog('hold')}>
            Put on hold…
          </button>
        ) : null}
        {isAdmin && !terminal && s.status !== 'invited' ? (
          <button type="button" className="btn" onClick={() => setDialog('extend')}>
            Extend time…
          </button>
        ) : null}
        {isAdmin && canSubmit ? (
          <button type="button" className="btn" onClick={() => setDialog('submit')}>
            Submit on behalf…
          </button>
        ) : null}
        {isAdmin && canReschedule ? (
          <button type="button" className="btn" onClick={() => setDialog('reschedule')}>
            Reschedule…
          </button>
        ) : null}
        {isAdmin && terminal ? (
          <button type="button" className="btn" onClick={() => setDialog('reopen')}>
            Reopen for recovery…
          </button>
        ) : null}
        {isAdmin && !terminal ? (
          <button type="button" className="btn btn-danger" onClick={() => setDialog('terminate')}>
            Terminate…
          </button>
        ) : null}
      </div>
      <div className="spacer" />
      <div className="row">
        <Link className="btn" to={`/admin/sessions/${s.id}/report`}>
          Open report
        </Link>
        <a className="btn" href={api.sessionCsvUrl(s.id)} download>
          Export CSV
        </a>
        {accessLink ? <CopyButton text={accessLink} label="Copy access link" className="btn" /> : null}
        {isAdmin && !terminal ? (
          <button type="button" className="btn" onClick={() => setDialog('regenerate')}>
            Regenerate link…
          </button>
        ) : null}
        {isAdmin ? (
          <button type="button" className="btn" onClick={() => setDialog('legal')} title="Legal hold suspends retention purges for this session">
            {legalHold === true ? 'Remove legal hold…' : legalHold === false ? 'Place legal hold…' : 'Legal hold…'}
          </button>
        ) : null}
      </div>
      {link ? (
        <div className="banner banner-success new-link">
          New access link: <code>{link}</code> <CopyButton text={link} />
          <span className="muted small"> The previous link no longer works.</span>
        </div>
      ) : null}

      {dialog === 'hold' ? (
        <ConfirmDialog
          title="Put this exam on hold?"
          message={
            <>
              The candidate will be stopped and the exam clock pauses until a reviewer releases the hold. The hold period is recorded as unobserved.
            </>
          }
          optionalText="Note (shown in the timeline and audit log)"
          confirmLabel="Put on hold"
          busy={hold.isPending}
          error={hold.isError ? errorMessage(hold.error) : null}
          onConfirm={(t) => hold.mutate(t)}
          onCancel={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'release' ? <ReleaseDialog d={d} onDone={done} onCancel={() => setDialog(null)} /> : null}
      {dialog === 'extend' ? <ExtendDialog sessionId={s.id} onDone={done} onCancel={() => setDialog(null)} /> : null}
      {dialog === 'reschedule' ? <RescheduleDialog d={d} onDone={done} onCancel={() => setDialog(null)} /> : null}
      {dialog === 'reopen' ? <ReopenDialog d={d} onDone={done} onCancel={() => setDialog(null)} /> : null}
      {dialog === 'terminate' ? (
        <ConfirmDialog
          title="Terminate this exam?"
          message={
            <>
              <p>The exam ends immediately and the candidate cannot continue. Answers given so far are kept. This cannot be undone.</p>
              <p className="muted small">Describe the reason factually — it appears in the report and audit log.</p>
            </>
          }
          requireText="Reason"
          confirmLabel="Terminate exam"
          danger
          busy={terminate.isPending}
          error={terminate.isError ? errorMessage(terminate.error) : null}
          onConfirm={(t) => terminate.mutate(t)}
          onCancel={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'submit' ? (
        <ConfirmDialog
          title="Submit the exam on the candidate’s behalf?"
          message="The exam ends now and the answers saved so far are submitted for grading."
          optionalText="Note (optional)"
          confirmLabel="Submit exam"
          busy={submit.isPending}
          error={submit.isError ? errorMessage(submit.error) : null}
          onConfirm={(t) => submit.mutate(t)}
          onCancel={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'regenerate' ? (
        <ConfirmDialog
          title="Regenerate the access link?"
          message="A new link is created and the current link stops working immediately. Send the new link to the candidate."
          confirmLabel="Regenerate link"
          busy={regenerate.isPending}
          error={regenerate.isError ? errorMessage(regenerate.error) : null}
          onConfirm={() => regenerate.mutate()}
          onCancel={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'legal' ? (
        <LegalHoldDialog
          current={legalHold}
          busy={legal.isPending}
          error={legal.isError ? errorMessage(legal.error) : null}
          onSet={(enabled) => legal.mutate(enabled)}
          onCancel={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

function ReleaseDialog({ d, onDone, onCancel }: { d: SessionDetailDTO; onDone: (s: SessionSummaryDTO) => void; onCancel: () => void }) {
  if (d.summary.hold?.reason === 'staff_verification') return <VerifyIdentityDialog d={d} onDone={onDone} onCancel={onCancel} />;
  return <ReleaseHoldDialog d={d} onDone={onDone} onCancel={onCancel} />;
}

/**
 * Identity verified by staff (an accommodation): the staff member confirms they verified the candidate and how. That
 * releases the hold without a further check; it is recorded on the timeline, in the report and the audit log.
 */
function VerifyIdentityDialog({ d, onDone, onCancel }: { d: SessionDetailDTO; onDone: (s: SessionSummaryDTO) => void; onCancel: () => void }) {
  const [method, setMethod] = useState<StaffVerificationMethod | ''>('');
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const m = useMutation({
    mutationFn: () => api.release(d.summary.id, { requireCheck: false, reEnroll: false, verification: { method: method as StaffVerificationMethod, note: note.trim() || undefined } }),
    onSuccess: onDone,
  });
  const started = d.summary.startedAt != null;
  return (
    <Modal
      title="Verify the candidate’s identity"
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={m.isPending}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" data-testid="verify-identity" onClick={() => m.mutate()} disabled={!method || !confirmed || m.isPending}>
            {m.isPending ? 'Saving…' : started ? 'Verified — continue the exam' : 'Verified — candidate may start'}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="small">
          {d.summary.candidate.name}’s identity is verified by staff instead of the automated face check (an approved accommodation). Verify them by your organisation’s procedure —
          for example a video call where they show photo ID — then record how.
        </p>
        <label>
          How did you verify their identity?
          <select value={method} onChange={(e) => setMethod(e.target.value as StaffVerificationMethod)}>
            <option value="">Choose…</option>
            {STAFF_VERIFICATION_METHODS.map((x) => (
              <option key={x} value={x}>
                {STAFF_VERIFICATION_METHOD_LABEL[x]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Note (optional; recorded in the timeline)
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} placeholder="e.g. Student card shown on camera, name and photo match." />
        </label>
        <label className="inline">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />I confirm that I verified this person is {d.summary.candidate.name}.
        </label>
        {m.isError ? <div className="banner banner-danger" role="alert">{errorMessage(m.error)}</div> : null}
      </div>
    </Modal>
  );
}

function ReleaseHoldDialog({ d, onDone, onCancel }: { d: SessionDetailDTO; onDone: (s: SessionSummaryDTO) => void; onCancel: () => void }) {
  const [note, setNote] = useState('');
  const [requireCheck, setRequireCheck] = useState(true);
  const [reEnroll, setReEnroll] = useState(false);
  const staffVerified = d.policy.identity.verification === 'staff';
  const m = useMutation({ mutationFn: () => api.release(d.summary.id, { note, requireCheck: requireCheck || reEnroll, reEnroll: !staffVerified && reEnroll }), onSuccess: onDone });
  const reason = d.summary.hold?.reason;
  return (
    <Modal
      title="Release hold"
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={m.isPending}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => m.mutate()} disabled={m.isPending}>
            {m.isPending ? 'Releasing…' : 'Release hold'}
          </button>
        </>
      }
    >
      <div className="stack">
        {reason === 'identity_mismatch' ? (
          <div className="banner banner-info small">
            Before releasing, compare the reference and later images (Identity tab → “Compare images”). Changes in clothing, hair, glasses, background or lighting are not evidence of a
            different person.
          </div>
        ) : null}
        {reason === 'additional_display' ? (
          <div className="banner banner-info small" data-testid="release-display-note">
            The candidate was asked to disconnect the additional display. The display check runs again when the exam continues: if more than one display is still connected, the exam
            is put on hold again.
          </div>
        ) : null}
        <label>
          Note (recorded in the timeline and audit log)
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={3} placeholder="e.g. Verified identity by video call with photo ID." />
        </label>
        <label className="inline">
          <input type="checkbox" checked={requireCheck || reEnroll} disabled={reEnroll} onChange={(e) => setRequireCheck(e.target.checked)} />
          Require a fresh identity check before the candidate continues (recommended)
        </label>
        {staffVerified ? null : (
          <label className="inline">
            <input type="checkbox" checked={reEnroll} onChange={(e) => setReEnroll(e.target.checked)} />
            Authorise re-enrolment of the identity reference
          </label>
        )}
        {reEnroll ? (
          <div className="banner banner-warning small">
            <strong>Only use this if you have confirmed by other means that the person now present is the registered candidate</strong> (for example a video call with photo ID).
            At the next check a <em>new</em> identity reference is created from the person in front of the camera, and later checks compare against it. The previous
            reference is kept for review. This action is audit-logged.
          </div>
        ) : null}
        {m.isError ? <div className="banner banner-danger" role="alert">{errorMessage(m.error)}</div> : null}
      </div>
    </Modal>
  );
}

function ExtendDialog({ sessionId, onDone, onCancel }: { sessionId: string; onDone: (s: SessionSummaryDTO) => void; onCancel: () => void }) {
  const [minutes, setMinutes] = useState('10');
  const [note, setNote] = useState('');
  const n = Number(minutes);
  const valid = Number.isInteger(n) && n >= 1 && n <= 1440;
  const m = useMutation({ mutationFn: () => api.extendTime(sessionId, n, note), onSuccess: onDone });
  return (
    <Modal
      title="Extend exam time"
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={m.isPending}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => m.mutate()} disabled={!valid || m.isPending}>
            {m.isPending ? 'Saving…' : `Add ${valid ? n : '…'} min`}
          </button>
        </>
      }
    >
      <div className="stack">
        <label>
          Minutes to add
          <input
            type="number"
            min={1}
            max={1440}
            step={1}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            aria-invalid={!valid}
            aria-describedby={!valid ? 'extend-minutes-error' : undefined}
          />
        </label>
        {!valid ? (
          <div className="text-danger small" id="extend-minutes-error">
            Enter a whole number of minutes between 1 and 1440.
          </div>
        ) : null}
        <label>
          Reason (e.g. accommodation, technical problem)
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} />
        </label>
        {m.isError ? <div className="banner banner-danger" role="alert">{errorMessage(m.error)}</div> : null}
      </div>
    </Modal>
  );
}

/** Set, change or clear the window in which the candidate can start the exam (before it starts). */
function RescheduleDialog({ d, onDone, onCancel }: { d: SessionDetailDTO; onDone: (s: SessionSummaryDTO) => void; onCancel: () => void }) {
  const w = d.summary.window ?? null;
  const [form, setForm] = useState<WindowFormValues>({ opens: toLocalInput(w?.startsAt), closes: toLocalInput(w?.endsAt) });
  const [note, setNote] = useState('');
  const parsed = parseWindowForm(form, Date.now());
  const m = useMutation({ mutationFn: () => api.reschedule(d.summary.id, parsed.ok ? parsed.window : null, note.trim()), onSuccess: onDone });
  return (
    <Modal
      title="Reschedule the exam"
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={m.isPending}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => m.mutate()} disabled={!parsed.ok || m.isPending}>
            {m.isPending ? 'Saving…' : parsed.ok && !parsed.window ? 'Remove the window' : 'Save window'}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="small">
          {d.summary.candidate.name} can start the exam only inside this window. The access link stays the same; tell the candidate about the new time. The change is recorded
          in the timeline and the audit log.
        </p>
        <WindowFields idPrefix="reschedule-window" legend="When the candidate can start" value={form} onChange={setForm} error={parsed.ok ? null : { field: parsed.field, message: parsed.error }} />
        <label>
          Note (optional; recorded in the timeline)
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} placeholder="e.g. Moved after the candidate reported illness." />
        </label>
        {m.isError ? <div className="banner banner-danger" role="alert">{errorMessage(m.error)}</div> : null}
      </div>
    </Modal>
  );
}

/**
 * Reopen an ended exam for recovery. The server decides whether it may (SessionDetailDTO.reopen, shared
 * reopenEligibility): when it may not, the dialog says why and offers nothing else.
 */
function ReopenDialog({ d, onDone, onCancel }: { d: SessionDetailDTO; onDone: (s: SessionSummaryDTO) => void; onCancel: () => void }) {
  const e = d.reopen;
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(e && e.started && e.remainingMs < 60_000 ? '10' : '0');
  const mins = parseReopenMinutes(minutes, e?.remainingMs ?? 0, e?.started ?? true);
  const reasonOk = reason.trim().length >= 5;
  const m = useMutation({ mutationFn: () => api.reopen(d.summary.id, reason.trim(), mins.ok ? mins.minutes : 0), onSuccess: onDone });
  const allowed = e?.allowed === true;
  const endedHow = d.summary.endReason ? END_REASON_LABELS[d.summary.endReason] : 'Ended';
  return (
    <Modal
      title="Reopen the exam for recovery"
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={m.isPending}>
            {allowed ? 'Cancel' : 'Close'}
          </button>
          {allowed ? (
            <button type="button" className="btn btn-primary" data-testid="confirm-reopen" onClick={() => m.mutate()} disabled={!reasonOk || !mins.ok || m.isPending}>
              {m.isPending ? 'Reopening…' : 'Reopen exam'}
            </button>
          ) : null}
        </>
      }
    >
      <div className="stack">
        <p className="small">
          How it ended: <strong>{endedHow}</strong>.
          {e?.started ? <> Exam time left: {formatDuration(e.remainingMs)}.</> : null}
        </p>
        {!e ? (
          <div className="banner banner-info small">The server did not say whether this exam can be reopened. Reload the page and try again.</div>
        ) : !allowed ? (
          <div className="banner banner-warning small" data-testid="reopen-refused">
            {e.message}
          </div>
        ) : (
          <>
            <div className="banner banner-info small">
              {e.message} Ask the candidate to open their exam link again (or reload the exam page). The reopening is recorded in the timeline, the report and the audit log,
              and integrations are notified.
            </div>
            <label htmlFor="reopen-reason">
              Reason (required; recorded in the timeline and the audit log, not sent to integrations)
              <textarea
                id="reopen-reason"
                value={reason}
                onChange={(ev) => setReason(ev.target.value)}
                maxLength={1000}
                rows={3}
                placeholder="e.g. Power cut at the test centre; the candidate continues from where they stopped."
                aria-describedby="reopen-reason-hint"
              />
            </label>
            <div className="muted small" id="reopen-reason-hint">
              At least 5 characters. Describe what happened factually.
            </div>
            <label htmlFor="reopen-minutes">
              Minutes to add to the exam time
              <input
                id="reopen-minutes"
                type="number"
                min={0}
                max={1440}
                step={1}
                value={minutes}
                onChange={(ev) => setMinutes(ev.target.value)}
                aria-invalid={!mins.ok}
                aria-describedby={!mins.ok ? 'reopen-minutes-error' : undefined}
              />
            </label>
            {!mins.ok ? (
              <div className="text-danger small" id="reopen-minutes-error">
                {mins.error}
              </div>
            ) : null}
          </>
        )}
        {m.isError ? <div className="banner banner-danger" role="alert">{errorMessage(m.error)}</div> : null}
      </div>
    </Modal>
  );
}

function LegalHoldDialog({
  current,
  busy,
  error,
  onSet,
  onCancel,
}: {
  current: boolean | undefined;
  busy: boolean;
  error: string | null;
  onSet: (enabled: boolean) => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      title="Legal hold"
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          {current !== true ? (
            <button type="button" className="btn btn-primary" onClick={() => onSet(true)} disabled={busy}>
              Place legal hold
            </button>
          ) : null}
          {current !== false ? (
            <button type="button" className="btn" onClick={() => onSet(false)} disabled={busy}>
              Remove legal hold
            </button>
          ) : null}
        </>
      }
    >
      <div className="stack">
        <p>
          While a session is under legal hold (for example during an appeal), its screenshots and identity images are <strong>not deleted</strong> by the retention policy.
          Removing the hold lets the normal retention schedule resume. Both actions are audit-logged.
        </p>
        <p className="muted small">Current state: {current === true ? 'on legal hold' : current === false ? 'not on legal hold' : 'not reported by the server'}.</p>
        {error ? <div className="banner banner-danger" role="alert">{error}</div> : null}
      </div>
    </Modal>
  );
}

/** Pending pause request with Approve / Deny, shown above the tabs. */
export function PauseDecisionBanner({ d }: { d: SessionDetailDTO }) {
  const qc = useQueryClient();
  const req = d.summary.pendingPauseRequest;
  const [note, setNote] = useState('');
  const m = useMutation({
    mutationFn: (approve: boolean) => api.decidePause(d.summary.id, req!.id, approve, note),
    onSuccess: (s) => afterSessionAction(qc, s, d.summary.id),
  });
  if (!req || req.status !== 'pending') return null;
  return (
    <div className="banner banner-warning pause-banner no-print">
      <div>
        <strong>Pause requested</strong> at <Clock at={req.requestedAt} /> (<RelativeTime at={req.requestedAt} />)
        {req.reason ? (
          <>
            {' '}
            — reason: <q>{req.reason}</q>
          </>
        ) : (
          ' — no reason given'
        )}
        .
      </div>
      <div className="row">
        <input
          type="text"
          placeholder="Note to candidate (optional)"
          aria-label="Note to candidate (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={1000}
          className="grow"
        />
        <button type="button" className="btn btn-primary btn-sm" disabled={m.isPending} onClick={() => m.mutate(true)}>
          Approve pause
        </button>
        <button type="button" className="btn btn-sm" disabled={m.isPending} onClick={() => m.mutate(false)}>
          Deny
        </button>
      </div>
      {m.isError ? <div className="text-danger small">{errorMessage(m.error)}</div> : null}
    </div>
  );
}

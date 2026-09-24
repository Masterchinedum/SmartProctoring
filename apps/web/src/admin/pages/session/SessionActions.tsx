import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SessionDetailDTO, SessionSummaryDTO } from '@sp/shared';
import { api, errorMessage } from '../../api/client';
import { afterSessionAction } from '../../api/queries';
import { useAuth } from '../../auth';
import { CopyButton } from '../../components/Common';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { Clock, RelativeTime } from '../../components/Time';

type Dialog = null | 'hold' | 'release' | 'terminate' | 'submit' | 'extend' | 'regenerate' | 'legal';

/** Staff actions for a session, filtered by role and session state. */
export function SessionActions({ d }: { d: SessionDetailDTO }) {
  const s = d.summary;
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [link, setLink] = useState<string | null>(null);
  const terminal = s.status === 'submitted' || s.status === 'terminated';
  const legalHold = (s as { legalHold?: boolean }).legalHold;
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

  return (
    <div className="actions-bar no-print">
      <div className="row">
        {s.status === 'on_hold' ? (
          <button type="button" className="btn btn-primary" onClick={() => setDialog('release')}>
            Release hold…
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
  const [note, setNote] = useState('');
  const [requireCheck, setRequireCheck] = useState(true);
  const [reEnroll, setReEnroll] = useState(false);
  const m = useMutation({ mutationFn: () => api.release(d.summary.id, { note, requireCheck: requireCheck || reEnroll, reEnroll }), onSuccess: onDone });
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
        <label>
          Note (recorded in the timeline and audit log)
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={3} placeholder="e.g. Verified identity by video call with photo ID." />
        </label>
        <label className="inline">
          <input type="checkbox" checked={requireCheck || reEnroll} disabled={reEnroll} onChange={(e) => setRequireCheck(e.target.checked)} />
          Require a fresh identity check before the candidate continues (recommended)
        </label>
        <label className="inline">
          <input type="checkbox" checked={reEnroll} onChange={(e) => setReEnroll(e.target.checked)} />
          Authorise re-enrolment of the identity reference
        </label>
        {reEnroll ? (
          <div className="banner banner-warning small">
            <strong>Only use this if you have confirmed by other means that the person now present is the registered candidate</strong> (for example a video call with photo ID).
            At the next check a <em>new</em> identity reference is created from the person in front of the camera, and later checks compare against it. The previous
            reference is kept for review. This action is audit-logged.
          </div>
        ) : null}
        {m.isError ? <div className="banner banner-danger">{errorMessage(m.error)}</div> : null}
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
          <input type="number" min={1} max={1440} step={1} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        </label>
        {!valid ? <div className="text-danger small">Enter a whole number of minutes between 1 and 1440.</div> : null}
        <label>
          Reason (e.g. accommodation, technical problem)
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} />
        </label>
        {m.isError ? <div className="banner banner-danger">{errorMessage(m.error)}</div> : null}
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
        {error ? <div className="banner banner-danger">{error}</div> : null}
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
        <input type="text" placeholder="Note to candidate (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} className="grow" />
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

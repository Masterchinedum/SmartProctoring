import { useState } from 'react';
import { formatDuration, type CandidateSessionState } from '@sp/shared';
import { errorMessage, formatTime, useController } from '../../context';
import { Modal, Spinner } from '../../components/common';

export function pauseAvailability(state: CandidateSessionState): { allowed: boolean; reason: string | null; remaining: number | null } {
  const p = state.exam.policy.pause;
  if (!p.allowed) return { allowed: false, reason: 'Pausing is not allowed for this exam.', remaining: null };
  if (p.maxPauses != null) {
    const remaining = Math.max(0, p.maxPauses - state.session.pauseCount);
    if (remaining === 0) return { allowed: false, reason: 'You have used all pauses allowed for this exam.', remaining };
    return { allowed: true, reason: null, remaining };
  }
  return { allowed: true, reason: null, remaining: null };
}

export function PauseDialog({ state, onClose }: { state: CandidateSessionState; onClose: () => void }) {
  const ctrl = useController();
  const p = state.exam.policy.pause;
  const pending = state.session.pauseRequest?.status === 'pending' ? state.session.pauseRequest : null;
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const avail = pauseAvailability(state);

  const submit = async () => {
    if (p.requireReason && !reason.trim()) {
      setError('Please give a reason for the pause.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await ctrl.requestPause(reason.trim() || undefined);
      if (res.outcome === 'denied') setError(res.message || 'The pause could not be started.');
      else if (res.outcome === 'pending_approval') setInfo(res.message || null);
      // 'paused' switches the screen.
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await ctrl.cancelPause();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (pending) {
    return (
      <Modal title="Waiting for approval" onClose={onClose}>
        <div className="stack" data-testid="pause-pending">
          <p>
            Your pause request was sent at {formatTime(pending.requestedAt)} and is waiting for the exam administrator. You can keep working on your exam while you
            wait — monitoring continues until the pause is approved.
          </p>
          {info && <p className="muted">{info}</p>}
          <div className="row">
            <Spinner label="Waiting for approval…" />
          </div>
          {error && (
            <div className="banner banner-danger" role="alert">
              {error}
            </div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={cancel} disabled={busy}>
              Cancel request
            </button>
            <button className="btn btn-primary" onClick={onClose} data-autofocus>
              Keep working
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Pause the exam" onClose={busy ? undefined : onClose}>
      <div className="stack" data-testid="pause-dialog">
        <ul>
          <li>While paused, camera monitoring stops completely and nothing is observed.</li>
          <li>{p.timerBehavior === 'stop' ? 'The exam clock stops during the pause.' : 'The exam clock keeps running during the pause.'}</li>
          <li>You can close the window. To continue, open the same exam link again; you will repeat the camera and identity check.</li>
          {p.maxPauseDurationSec != null && (
            <li>If the pause lasts longer than {formatDuration(p.maxPauseDurationSec * 1000)}, an administrator must approve before you can continue.</li>
          )}
          {avail.remaining != null && <li>Pauses left after this one: {avail.remaining - 1}.</li>}
          {p.requireApproval && <li>The exam administrator must approve the pause first.</li>}
        </ul>
        <label>
          Reason {p.requireReason ? '(required)' : '(optional)'}
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={3} data-testid="pause-reason" />
        </label>
        {error && (
          <div className="banner banner-danger" role="alert">
            {error}
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose} disabled={busy} data-autofocus>
            Continue exam
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy} data-testid="pause-confirm">
            {busy ? 'Pausing…' : p.requireApproval ? 'Request pause' : 'Pause exam'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function SubmitDialog({ total, answered, onClose }: { total: number; answered: number; onClose: () => void }) {
  const ctrl = useController();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unanswered = total - answered;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await ctrl.submit();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Modal title="Submit your exam?" onClose={busy ? undefined : onClose}>
      <div className="stack" data-testid="submit-dialog">
        <p>
          You have answered <strong>{answered}</strong> of <strong>{total}</strong> questions.
          {unanswered > 0 && (
            <>
              {' '}
              <strong>{unanswered}</strong> question{unanswered === 1 ? ' is' : 's are'} unanswered.
            </>
          )}
        </p>
        <p>After you submit you cannot change your answers.</p>
        {error && (
          <div className="banner banner-danger" role="alert">
            {error}
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose} disabled={busy} data-autofocus>
            Back to exam
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy} data-testid="submit-confirm">
            {busy ? 'Submitting…' : 'Submit exam'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

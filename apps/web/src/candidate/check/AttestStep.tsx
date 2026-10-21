import { useState } from 'react';
import type { CheckPurpose, CompleteCheckResponse, StartCheckResponse } from '@sp/shared';
import { errorMessage, useController, useSnapshot } from '../context';
import { ScreenHeading } from '../components/common';
import { deviceInfo } from './VerifyStep';

/**
 * The check when identity is verified by a staff member (an approved arrangement): no pictures are taken. At check-in
 * the next screen asks the candidate to wait for staff; after a pause or reconnection the exam continues (or waits for
 * staff again when the arrangement says so).
 */
export function AttestStep({ purpose, onResult }: { purpose: CheckPurpose; onResult: (res: CompleteCheckResponse, check: StartCheckResponse) => void }) {
  const ctrl = useController();
  const snap = useSnapshot();
  const policy = snap.state?.exam.policy;
  const camera = policy?.camera?.enabled !== false;
  const reverify = policy?.identity.staffReverifyOnContinue === true;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const check = await ctrl.api.startCheck({ purpose, clientInstanceId: ctrl.instanceId, device: await deviceInfo(ctrl) });
      if (check.mode !== 'attest') {
        // The arrangement changed meanwhile: reload so the right check is shown.
        await ctrl.load();
        return;
      }
      onResult(await ctrl.api.completeCheck(check.checkId), check);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const initial = purpose === 'initial';
  return (
    <div className="stack" data-testid="attest-step" data-purpose={purpose}>
      <ScreenHeading>{initial ? 'Identity check by a staff member' : purpose === 'resume' ? 'Resume your exam' : 'Continue your exam'}</ScreenHeading>
      {initial ? (
        <>
          <p className="cand-lead">As arranged with your organisation, a staff member verifies your identity instead of the automated face check.</p>
          <p>
            {camera ? 'Your camera works. ' : 'Your exam runs without a camera. '}
            Select <strong>Continue</strong>, then keep this page open: a staff member will verify your identity — for example in a video call where you show your photo ID — and
            your exam can start right after. No exam time is used while you wait.
          </p>
        </>
      ) : (
        <p className="cand-lead">
          {reverify
            ? 'Select Continue. A staff member will verify your identity again before your exam continues; the exam clock stays stopped until then.'
            : 'Select Continue to return to your exam. Your answers and remaining time are saved.'}
        </p>
      )}
      {error ? (
        <div className="banner banner-danger" role="alert">
          {error}
        </div>
      ) : null}
      <div className="row">
        <button type="button" className="btn btn-primary btn-lg" onClick={() => void go()} disabled={busy} data-testid="attest-continue">
          {busy ? 'One moment…' : 'Continue'}
        </button>
      </div>
    </div>
  );
}

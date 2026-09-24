import { useCallback, useState } from 'react';
import type { Baseline, CheckPurpose, CompleteCheckResponse, StartCheckResponse } from '@sp/shared';
import { useController, useSnapshot } from '../context';
import { BrandHeader, ContactLine, Page, Toasts } from '../components/common';
import { enterFullscreen } from '../screens/exam/ExamScreen';
import { CalibrationStep } from './CalibrationStep';
import { ReadinessStep } from './ReadinessStep';
import { VerifyStep } from './VerifyStep';

type Step = 'intro' | 'camera' | 'calibrate' | 'verify' | 'result';

const INTRO: Record<CheckPurpose, { title: string; body: string[] } | null> = {
  initial: null,
  resume: {
    title: 'Resume your exam',
    body: [
      'Before you continue we repeat the camera check and the live-person check, and compare you with the identity reference from the start of the exam.',
      'A different room, camera, lighting, clothing or hairstyle is fine — what matters is that the same person continues.',
      'Your answers, your place in the exam and your remaining time are saved.',
    ],
  },
  reconnect: {
    title: 'Continue your exam',
    body: [
      'This exam is already in progress, but this browser window has not been verified yet — for example because the page was reloaded, the browser was restarted, or the exam was opened on another device.',
      'To continue, please repeat the camera check and the live-person and identity check. Your answers and remaining time are saved.',
      'If the exam is still open in another window, that window will be disconnected.',
    ],
  },
  reverify: {
    title: 'Verify your identity again',
    body: [
      'Please repeat the camera check and the live-person and identity check so that your exam can continue.',
      'Make sure your face is well lit, you are alone in view of the camera, and nothing covers your face.',
    ],
  },
};

export function CheckFlow({ purpose, onCancel }: { purpose: CheckPurpose; onCancel?: () => void }) {
  const ctrl = useController();
  const snap = useSnapshot();
  const intro = INTRO[purpose];
  const [step, setStep] = useState<Step>(intro ? 'intro' : 'camera');
  const [result, setResult] = useState<{ res: CompleteCheckResponse; check: StartCheckResponse } | null>(null);
  const [verifyKey, setVerifyKey] = useState(0);

  const onCalibrated = useCallback(
    (b: Baseline | null) => {
      ctrl.setCalibration(b, purpose);
      setStep('verify');
    },
    [ctrl, purpose],
  );

  const onResult = useCallback(
    (res: CompleteCheckResponse, check: StartCheckResponse) => {
      setResult({ res, check });
      if (res.outcome === 'held' || (res.outcome === 'passed' && res.state.session.status !== 'active')) {
        // Hold screen / ready screen take over.
        void ctrl.applyState(res.state);
        return;
      }
      setStep('result');
    },
    [ctrl],
  );

  const title = snap.state?.exam.title;
  let body: React.ReactNode = null;
  if (step === 'intro' && intro) {
    body = (
      <div className="stack" data-testid="check-intro" data-purpose={purpose}>
        <h1>{intro.title}</h1>
        {intro.body.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
        <div className="row">
          <button className="btn btn-primary btn-lg" onClick={() => setStep('camera')} data-testid="check-intro-continue">
            Start the check
          </button>
          {onCancel && (
            <button className="btn" onClick={onCancel}>
              Back
            </button>
          )}
        </div>
      </div>
    );
  } else if (step === 'camera') {
    body = <ReadinessStep onReady={() => setStep('calibrate')} />;
  } else if (step === 'calibrate') {
    body = <CalibrationStep onDone={onCalibrated} />;
  } else if (step === 'verify') {
    body = <VerifyStep key={verifyKey} purpose={purpose} onResult={onResult} onBackToSetup={() => setStep('camera')} />;
  } else if (step === 'result' && result) {
    body = (
      <CheckResult
        purpose={purpose}
        res={result.res}
        onRetry={() => {
          setVerifyKey((k) => k + 1);
          setStep('verify');
        }}
        onBackToSetup={() => setStep('camera')}
      />
    );
  }

  return (
    <Page wide>
      <BrandHeader title={title} />
      <main className="card">{body}</main>
      <Toasts />
    </Page>
  );
}

function CheckResult({ purpose, res, onRetry, onBackToSetup }: { purpose: CheckPurpose; res: CompleteCheckResponse; onRetry: () => void; onBackToSetup: () => void }) {
  const ctrl = useController();
  const [busy, setBusy] = useState(false);
  const requireFs = res.state.exam.policy.browser.requireFullscreen;

  if (res.outcome === 'passed') {
    const cont = async () => {
      setBusy(true);
      if (requireFs) await enterFullscreen();
      await ctrl.applyState(res.state);
    };
    return (
      <div className="stack" data-testid="check-passed">
        <h1>Check complete</h1>
        <div className="banner banner-success">{res.message || 'Thank you — you can continue your exam.'}</div>
        <p>Your answers and remaining time are exactly as you left them.{requireFs ? ' The exam continues in fullscreen mode.' : ''}</p>
        <div className="row">
          <button className="btn btn-primary btn-lg" onClick={cont} disabled={busy} data-testid="check-continue" autoFocus>
            {purpose === 'resume' ? 'Resume exam' : 'Continue exam'}
          </button>
        </div>
      </div>
    );
  }

  if (res.outcome === 'retry') {
    return (
      <div className="stack" data-testid="check-retry">
        <h1>Let’s try that again</h1>
        <p className="cand-lead">{res.message || 'We could not complete the check this time.'}</p>
        {res.guidance.length > 0 && (
          <ul className="cand-guidance-list">
            {res.guidance.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        )}
        <p className="muted">
          Attempts remaining: <strong>{res.attemptsRemaining}</strong>
        </p>
        <div className="row">
          <button className="btn btn-primary btn-lg" onClick={onRetry} data-testid="check-try-again" autoFocus>
            Try again
          </button>
          <button className="btn" onClick={onBackToSetup}>
            Check my camera setup
          </button>
        </div>
        <ContactLine />
      </div>
    );
  }

  // failed
  return (
    <div className="stack" data-testid="check-failed">
      <h1>The check could not be completed</h1>
      <p className="cand-lead">{res.message}</p>
      {res.guidance.length > 0 && (
        <ul className="cand-guidance-list">
          {res.guidance.map((g, i) => (
            <li key={i}>{g}</li>
          ))}
        </ul>
      )}
      <div className="row">
        <button className="btn btn-primary" onClick={() => void ctrl.applyState(res.state)}>
          Continue
        </button>
      </div>
      <ContactLine />
    </div>
  );
}

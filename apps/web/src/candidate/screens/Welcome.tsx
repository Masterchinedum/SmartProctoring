import { useEffect, useId, useState } from 'react';
import { formatDuration } from '@sp/shared';
import { errorMessage, useController, useSnapshot } from '../context';
import { BrandHeader, Page, PrivacyNotice, ScreenHeading, Spinner } from '../components/common';
import { checkSystemRequirements, type RequirementResult } from '../sysreq';

/** Viewport narrower than this (on a small device) → "you need a computer with a webcam" notice. */
const SMALL_VIEWPORT_PX = 700;

function smallDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const narrow = window.innerWidth < SMALL_VIEWPORT_PX;
  // A zoomed-in desktop browser also has a narrow viewport: only warn when the screen itself is small
  // or the main pointer is a finger (phones, tablets).
  const smallScreen = (window.screen?.width ?? Number.POSITIVE_INFINITY) < SMALL_VIEWPORT_PX;
  const touch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  return narrow && (smallScreen || touch);
}

function useSmallDevice(): boolean {
  const [small, setSmall] = useState(smallDevice);
  useEffect(() => {
    const on = () => setSmall(smallDevice());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return small;
}

export function WelcomeScreen() {
  const ctrl = useController();
  const { state } = useSnapshot();
  const [reqs, setReqs] = useState<RequirementResult[] | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);
  const small = useSmallDevice();
  const consentHintId = useId();

  const requireFullscreen = state?.exam.policy.browser.requireFullscreen ?? false;
  useEffect(() => {
    let alive = true;
    void checkSystemRequirements({ requireFullscreen }).then((r) => alive && setReqs(r));
    return () => {
      alive = false;
    };
  }, [requireFullscreen]);

  if (!state) return null;
  const { exam, candidate, consent } = state;
  const blocking = reqs?.filter((r) => r.required && !r.ok) ?? [];
  const canContinue = !!reqs && blocking.length === 0 && agreed && !busy;
  const noCamera = reqs?.some((r) => r.id === 'camera_present' && !r.ok) ?? false;

  const onContinue = async () => {
    setBusy(true);
    setError(null);
    try {
      await ctrl.acceptConsent();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const p = exam.policy;
  return (
    <Page>
      <BrandHeader title={exam.title} />
      <main className="stack" aria-labelledby="welcome-title">
        {(small || noCamera) && <DeviceNotice small={small} noCamera={noCamera} />}
        <section className="card stack">
          <ScreenHeading id="welcome-title" title="Welcome">
            {exam.title}
          </ScreenHeading>
          <p className="muted">Welcome, {candidate.name}.</p>
          {exam.description && <p className="cand-pre">{exam.description}</p>}
          <dl className="cand-facts">
            <div>
              <dt>Duration</dt>
              <dd>{formatDuration(exam.durationSec * 1000)}</dd>
            </div>
            <div>
              <dt>Questions</dt>
              <dd>{exam.questionCount}</dd>
            </div>
            <div>
              <dt>Pauses</dt>
              <dd>
                {!p.pause.allowed
                  ? 'Not allowed'
                  : `${p.pause.maxPauses == null ? 'Allowed' : `Up to ${p.pause.maxPauses}`}${p.pause.requireApproval ? ', need approval' : ''}${p.pause.timerBehavior === 'stop' ? ' (clock stops)' : ' (clock keeps running)'}`}
              </dd>
            </div>
            <div>
              <dt>Fullscreen</dt>
              <dd>{p.browser.requireFullscreen ? 'Required' : 'Not required'}</dd>
            </div>
          </dl>
          {exam.instructions && (
            <div>
              <h2>Instructions</h2>
              <p className="cand-pre">{exam.instructions}</p>
            </div>
          )}
        </section>

        <section className="card stack" aria-labelledby="access-title" data-testid="accessibility-note">
          <h2 id="access-title">Accessibility &amp; accommodations</h2>
          <p>
            You can take this exam with a keyboard alone and with a screen reader. Saved answers, time reminders and monitoring messages are announced, and you can
            zoom the page.
          </p>
          <p>
            If you need an accommodation — for example, if you cannot turn your head for the live-person check, need extra time, or the camera checks are difficult
            for you — please contact <strong>{consent.notice.contact}</strong> before your exam. The exam can be set up without the head-movement check, and exam staff
            can give you extra time.
          </p>
        </section>

        <section className="card stack" aria-labelledby="req-title">
          <h2 id="req-title">System check</h2>
          {!reqs ? (
            <Spinner label="Checking your browser…" />
          ) : (
            <ul className="cand-checklist" data-testid="requirements">
              {reqs.map((r) => (
                <li key={r.id} className={r.ok ? 'ok' : r.required ? 'fail' : 'warn'}>
                  <span className="cand-check-icon" aria-hidden="true">
                    {r.ok ? '✓' : r.required ? '✕' : '!'}
                  </span>
                  <div>
                    <div>
                      {r.label}
                      <span className="sr-only">{r.ok ? ' — OK' : r.required ? ' — required, not met' : ' — warning'}</span>
                    </div>
                    {!r.ok && <div className="muted small">{r.help}</div>}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {blocking.length > 0 && (
            <div className="banner banner-danger" role="alert">
              Your browser or device does not meet the requirements above. Fix the items marked ✕ and reload this page.
            </div>
          )}
        </section>

        <section className="card stack" aria-labelledby="privacy-title">
          <h2 id="privacy-title">Privacy notice: camera monitoring</h2>
          <p>
            This exam is proctored. Before you start we will check your camera and confirm that you are a live person, and we will establish a protected reference of
            your face so we can check that the same person continues the exam. Please read what is monitored and what is kept.
          </p>
          <PrivacyNotice notice={consent.notice} />
          <label className="inline cand-consent">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} data-testid="consent-checkbox" />
            <span>I have read the privacy notice and I agree to camera monitoring and identity checks for this exam.</span>
          </label>
          {error && (
            <div className="banner banner-danger" role="alert">
              {error}
            </div>
          )}
          <div className="row">
            <button
              type="button"
              className="btn btn-primary btn-lg"
              disabled={!canContinue}
              onClick={onContinue}
              aria-describedby={!agreed ? consentHintId : undefined}
              data-testid="consent-continue"
            >
              {busy ? 'Saving…' : 'Agree and continue'}
            </button>
            <button type="button" className="btn" onClick={() => setDeclined(true)}>
              I do not agree
            </button>
          </div>
          {!agreed && reqs && blocking.length === 0 && (
            <p className="muted small" id={consentHintId}>
              To continue, tick the box above to confirm that you agree.
            </p>
          )}
          {/* Persistent live region: the message is announced when it appears. */}
          <div role="status">
            {declined && (
              <div className="banner banner-info">
                You cannot take this proctored exam without agreeing to monitoring. If you do not agree or need an accommodation, contact{' '}
                <strong>{consent.notice.contact}</strong> before your exam. Nothing has been recorded.
              </div>
            )}
          </div>
        </section>
      </main>
    </Page>
  );
}

/** Friendly (non-blocking) notice for phones / small screens and devices without a camera. */
function DeviceNotice({ small, noCamera }: { small: boolean; noCamera: boolean }) {
  return (
    <div className="banner banner-warning stack" style={{ gap: 6 }} role="note" aria-labelledby="device-notice-title" data-testid="device-notice">
      <strong id="device-notice-title">This exam needs a computer with a webcam</strong>
      {small && (
        <span>
          It looks like you are using a phone or a small screen. For the camera checks and the exam itself, please open your exam link on a laptop or desktop computer
          with a webcam. If your camera works here, you can still continue. (If you are on a computer and have zoomed in, you can ignore this message.)
        </span>
      )}
      {noCamera && (
        <span>
          We could not find a camera on this device. Connect a webcam — or switch to a computer that has one — and reload this page. If your camera is connected, you
          can continue: the camera check on the next page will confirm it.
        </span>
      )}
    </div>
  );
}

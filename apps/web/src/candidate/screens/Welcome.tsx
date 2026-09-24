import { useEffect, useState } from 'react';
import { formatDuration } from '@sp/shared';
import { errorMessage, useController, useSnapshot } from '../context';
import { BrandHeader, Page, PrivacyNotice, Spinner } from '../components/common';
import { checkSystemRequirements, type RequirementResult } from '../sysreq';

export function WelcomeScreen() {
  const ctrl = useController();
  const { state } = useSnapshot();
  const [reqs, setReqs] = useState<RequirementResult[] | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);

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
        <section className="card stack">
          <h1 id="welcome-title">{exam.title}</h1>
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
            <button className="btn btn-primary btn-lg" disabled={!canContinue} onClick={onContinue} data-testid="consent-continue">
              {busy ? 'Saving…' : 'Agree and continue'}
            </button>
            <button className="btn" onClick={() => setDeclined(true)}>
              I do not agree
            </button>
          </div>
          {declined && (
            <div className="banner banner-info" role="status">
              You cannot take this proctored exam without agreeing to monitoring. If you do not agree or need an accommodation, contact{' '}
              <strong>{consent.notice.contact}</strong> before your exam. Nothing has been recorded.
            </div>
          )}
        </section>
      </main>
    </Page>
  );
}

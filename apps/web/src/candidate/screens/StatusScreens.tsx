import { useEffect, useState } from 'react';
import { formatDuration, type EndReason } from '@sp/shared';
import { errorMessage, formatDateTime, formatTime, useController, useSnapshot } from '../context';
import { BrandHeader, CameraPreview, ContactLine, CountdownDisplay, Page, PrivacyNoticeDialog, ReportingBanner, Spinner, Toasts } from '../components/common';
import { enterFullscreen } from './exam/ExamScreen';

/* ------------------------------------------------------------------ ready */

export function ReadyScreen() {
  const ctrl = useController();
  const snap = useSnapshot();
  const state = snap.state!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNotice, setShowNotice] = useState(false);
  const p = state.exam.policy;

  // Keep the camera on so monitoring can start immediately with the exam.
  useEffect(() => {
    if (!ctrl.camera.state.wanted) void ctrl.camera.start();
  }, [ctrl]);

  const start = async () => {
    setBusy(true);
    setError(null);
    if (p.browser.requireFullscreen) await enterFullscreen();
    try {
      await ctrl.startExam();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Page>
      <BrandHeader title={state.exam.title} />
      <main className="stack">
        <section className="card stack" data-testid="ready-screen">
          <h1>You are ready to start</h1>
          <div className="banner banner-success">Your camera and identity checks are complete.</div>
          <div className="cand-setup">
            <CameraPreview stream={snap.camera.stream} className="cand-preview-medium" />
            <div className="stack">
              <dl className="cand-facts">
                <div>
                  <dt>Exam</dt>
                  <dd>{state.exam.title}</dd>
                </div>
                <div>
                  <dt>Duration</dt>
                  <dd>{formatDuration(state.session.durationMs)}</dd>
                </div>
                <div>
                  <dt>Questions</dt>
                  <dd>{state.exam.questionCount}</dd>
                </div>
              </dl>
              <ul>
                <li>The clock starts when you press “Start exam”.</li>
                <li>Your answers are saved automatically as you type.</li>
                {p.browser.requireFullscreen && <li>The exam runs in fullscreen mode. Leaving fullscreen is recorded.</li>}
                {p.browser.blockClipboard && <li>Copy and paste are disabled during the exam.</li>}
                {p.pause.allowed ? (
                  <li>
                    You can pause the exam{p.pause.requireApproval ? ' with the administrator’s approval' : ''}; the clock {p.pause.timerBehavior === 'stop' ? 'stops' : 'keeps running'}{' '}
                    during a pause.
                  </li>
                ) : (
                  <li>Pausing is not allowed in this exam.</li>
                )}
                <li>
                  Monitoring runs while the exam is active.{' '}
                  <button className="cand-link" onClick={() => setShowNotice(true)}>
                    What is monitored?
                  </button>
                </li>
              </ul>
            </div>
          </div>
          {error && (
            <div className="banner banner-danger" role="alert">
              {error}
            </div>
          )}
          <div className="row">
            <button className="btn btn-primary btn-lg" onClick={start} disabled={busy} data-testid="start-exam">
              {busy ? 'Starting…' : 'Start exam'}
            </button>
          </div>
        </section>
      </main>
      {showNotice && <PrivacyNoticeDialog notice={state.consent.notice} onClose={() => setShowNotice(false)} />}
      <Toasts />
    </Page>
  );
}

/* ------------------------------------------------------------------ paused */

export function PausedScreen({ onResume }: { onResume: () => void }) {
  const snap = useSnapshot();
  const state = snap.state!;
  const p = state.exam.policy.pause;
  const req = state.session.pauseRequest;
  const pausedAt = req?.status === 'approved' ? (req.decidedAt ?? req.requestedAt) : snap.pausedAtLocal;
  const running = state.session.timerRunning;
  return (
    <Page>
      <BrandHeader title={state.exam.title} />
      <main className="stack">
        <ReportingBanner />
        <section className="card stack" data-testid="paused-screen">
          <h1>Your exam is paused</h1>
          <dl className="cand-facts">
            <div>
              <dt>Paused</dt>
              <dd>{pausedAt ? formatDateTime(pausedAt) : 'Yes'}</dd>
            </div>
            {(req?.reason ?? snap.pauseReasonLocal) && (
              <div>
                <dt>Your reason</dt>
                <dd>{req?.reason ?? snap.pauseReasonLocal}</dd>
              </div>
            )}
            <div>
              <dt>Exam clock</dt>
              <dd>{running ? 'Keeps running during the pause' : 'Stopped during the pause'}</dd>
            </div>
          </dl>
          <CountdownDisplay label={running ? 'Time remaining (clock running)' : 'Time remaining'} />
          <ul>
            <li>Monitoring is stopped. Nothing is observed or recorded while the exam is paused.</li>
            <li>Your answers, your place in the exam and your remaining time are saved.</li>
            <li>
              <strong>You can close this window.</strong> To continue later, open the same exam link again.
            </li>
            <li>When you resume, you will repeat the camera check and the live-person and identity check.</li>
            {p.maxPauseDurationSec != null && <li>If the pause lasts longer than {formatDuration(p.maxPauseDurationSec * 1000)}, an administrator must approve before you can continue.</li>}
          </ul>
          <div className="row">
            <button className="btn btn-primary btn-lg" onClick={onResume} data-testid="resume-button">
              Resume exam
            </button>
          </div>
          <ContactLine />
        </section>
      </main>
      <Toasts />
    </Page>
  );
}

/* ------------------------------------------------------------------ on hold */

export function HoldScreen({ onReverify }: { onReverify: () => void }) {
  const ctrl = useController();
  const snap = useSnapshot();
  const state = snap.state!;
  const hold = state.session.hold;
  const [refreshing, setRefreshing] = useState(false);
  return (
    <Page>
      <BrandHeader title={state.exam.title} />
      <main className="stack">
        <ReportingBanner />
        <section className="card stack" data-testid="hold-screen">
          <h1>Your exam is on hold</h1>
          <p className="cand-lead">{hold?.message ?? 'Your exam is on hold while an administrator reviews it.'}</p>
          <dl className="cand-facts">
            {hold?.since && (
              <div>
                <dt>Since</dt>
                <dd>{formatDateTime(hold.since)}</dd>
              </div>
            )}
            <div>
              <dt>Exam clock</dt>
              <dd>Stopped while on hold</dd>
            </div>
          </dl>
          <CountdownDisplay />
          <p>Your answers and remaining time are saved. This page updates automatically when the administrator responds; you can also close it and open the exam link later.</p>
          <div className="row">
            {hold?.canReverify && (
              <button className="btn btn-primary btn-lg" onClick={onReverify} data-testid="reverify-button">
                Verify again
              </button>
            )}
            <button
              className="btn"
              disabled={refreshing}
              onClick={async () => {
                setRefreshing(true);
                await ctrl.load();
                setRefreshing(false);
              }}
            >
              {refreshing ? 'Checking…' : 'Check status now'}
            </button>
          </div>
          <ContactLine />
        </section>
      </main>
      <Toasts />
    </Page>
  );
}

/* ------------------------------------------------------------------ ended */

const END_TEXT: Record<EndReason, string> = {
  candidate_submitted: 'You submitted your exam.',
  time_expired: 'The exam time ran out, and your saved answers were submitted automatically.',
  staff_submitted: 'Your exam was submitted by the exam administrator.',
  staff_terminated: 'Your exam was ended by the exam administrator.',
};

export function EndedScreen() {
  const snap = useSnapshot();
  const state = snap.state!;
  const terminated = state.session.status === 'terminated';
  const pending = snap.outbox?.size ?? 0;
  useEffect(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }, []);
  return (
    <Page>
      <BrandHeader title={state.exam.title} />
      <main className="stack">
        <section className="card stack" data-testid="ended-screen" data-status={state.session.status}>
          <h1>{terminated ? 'Your exam has ended' : 'Your exam has been submitted'}</h1>
          <p className="cand-lead">{state.session.endReason ? END_TEXT[state.session.endReason] : terminated ? END_TEXT.staff_terminated : END_TEXT.candidate_submitted}</p>
          {!terminated && <p>Thank you. Monitoring has stopped and your camera is off. You can close this window.</p>}
          {terminated && <p>Monitoring has stopped and your camera is off. If you have questions about this, contact your exam administrator.</p>}
          {pending > 0 && (
            <p className="muted small" role="status">
              Finishing sending {pending} monitoring item{pending === 1 ? '' : 's'}… You may keep this page open for a moment.
            </p>
          )}
          <ContactLine />
        </section>
      </main>
    </Page>
  );
}

/* ------------------------------------------------------------------ fatal / errors */

export function FatalScreen({ kind, message }: { kind: 'invalid_link' | 'superseded'; message: string }) {
  return (
    <Page>
      <BrandHeader />
      <main className="stack">
        <section className="card stack" data-testid={kind === 'superseded' ? 'superseded-screen' : 'invalid-link-screen'} role="alert">
          {kind === 'superseded' ? (
            <>
              <h1>This exam continues in another window</h1>
              <p className="cand-lead">The exam was opened in another browser window or on another device, so this window has been disconnected.</p>
              <p>Your answers are saved. Continue in the other window — or, if you want to continue here instead, reload this page. You will repeat the camera and identity check.</p>
              <p className="muted small">{message}</p>
              <div className="row">
                <button className="btn btn-primary" onClick={() => window.location.reload()}>
                  Continue in this window
                </button>
              </div>
            </>
          ) : (
            <>
              <h1>This exam link is not valid</h1>
              <p className="cand-lead">{message}</p>
              <p>Check that you opened the complete link from your invitation. If the problem continues, contact your exam administrator for a new link.</p>
            </>
          )}
        </section>
      </main>
    </Page>
  );
}

export function LoadingScreen({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <Page>
      <BrandHeader />
      <main className="stack">
        <section className="card stack">
          {error ? (
            <>
              <h1>We could not load your exam</h1>
              <p role="alert">{error}</p>
              <div className="row">
                <button className="btn btn-primary" onClick={onRetry}>
                  Try again
                </button>
              </div>
            </>
          ) : (
            <Spinner label="Loading your exam…" />
          )}
        </section>
      </main>
    </Page>
  );
}


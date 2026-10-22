import { useEffect, useState } from 'react';
import { formatDuration, type CandidateEndReason } from '@sp/shared';
import { CandidateApiError } from '../api';
import { errorMessage, formatDateTime, formatTime, useController, useNow, useSnapshot } from '../context';
import { formatWhen, startOpensAt, windowScreenText } from '../window';
import { exitFullscreen } from '../fullscreen';
import { BrandHeader, CameraPreview, ContactLine, CountdownDisplay, Page, PrivacyNoticeDialog, ReportingBanner, ScreenHeading, Spinner, Toasts, TraceDownload } from '../components/common';
import { enterFullscreen } from './exam/ExamScreen';

/* ------------------------------------------------------------------ ready */

export function ReadyScreen() {
  const ctrl = useController();
  const snap = useSnapshot();
  const state = snap.state!;
  const [busy, setBusy] = useState(false);
  const [deferred, setDeferred] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNotice, setShowNotice] = useState(false);
  const p = state.exam.policy;
  // Checked in before the scheduling window opened: the exam can be started at the opening (./window.ts). The page
  // ticks every second only while an opening time is ahead.
  useNow(state.session.window?.startsAt != null && state.session.window.startsAt > ctrl.serverNow() ? 1000 : 3_600_000);
  const opensAt = startOpensAt(state, ctrl.serverNow());

  // Keep the camera on so monitoring can start immediately with the exam (never for an exam without a camera).
  const cameraOn = p.camera?.enabled !== false;
  useEffect(() => {
    if (cameraOn && !ctrl.camera.state.wanted) void ctrl.camera.start();
  }, [ctrl, cameraOn]);

  const start = async () => {
    setBusy(true);
    setError(null);
    if (p.browser.requireFullscreen) await enterFullscreen();
    try {
      // While the server is busy the start is retried by itself (the exam clock has not started).
      await ctrl.startExam(() => setDeferred(true));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
      setDeferred(false);
      // Outside the scheduling window: the state shows when it opens / that it closed.
      if (e instanceof CandidateApiError && (e.code === 'exam_window_not_open' || e.code === 'exam_window_closed')) void ctrl.load();
    }
  };

  return (
    <Page>
      <BrandHeader title={state.exam.title} />
      <main className="stack">
        <section className="card stack" data-testid="ready-screen">
          <ScreenHeading>You are ready to start</ScreenHeading>
          <div className="banner banner-success">Your camera and identity checks are complete.</div>
          <div className="cand-setup">
            <CameraPreview stream={snap.camera.stream} className="cand-preview-medium" label="Your camera preview (mirrored)" />
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
                  <button type="button" className="cand-link" onClick={() => setShowNotice(true)}>
                    What is monitored?
                  </button>
                </li>
              </ul>
            </div>
          </div>
          {opensAt != null && (
            <div className="banner banner-info" data-testid="opens-at">
              The exam opens on {formatWhen(opensAt)} (your time). You can start it then — in {formatDuration(opensAt - ctrl.serverNow())}. Keep this page open; the button
              becomes available by itself.
            </div>
          )}
          {error && (
            <div className="banner banner-danger" role="alert">
              {error}
            </div>
          )}
          <div className="row">
            <button type="button" className="btn btn-primary btn-lg" onClick={start} disabled={busy || opensAt != null} data-testid="start-exam">
              {busy ? (deferred ? 'Waiting to start…' : 'Starting…') : 'Start exam'}
            </button>
          </div>
          {/* Persistent live region: announced once when the start is held back. */}
          <p role="status" className="muted" data-testid="start-deferred">
            {deferred ? 'Many candidates are starting at the same time. Your exam will start by itself in a moment — your exam time has not started yet.' : ''}
          </p>
        </section>
      </main>
      {showNotice && <PrivacyNoticeDialog notice={state.consent.notice} onClose={() => setShowNotice(false)} canWithdraw={state.consent.accepted} />}
      <Toasts />
    </Page>
  );
}

/* ------------------------------------------------------------------ paused */

export function PausedScreen({ onResume }: { onResume: () => void }) {
  const ctrl = useController();
  const snap = useSnapshot();
  // No camera while paused (e.g. after a cancelled resume check).
  useEffect(() => ctrl.releaseIdleCamera(), [ctrl]);
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
          <ScreenHeading>Your exam is paused</ScreenHeading>
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
            <button type="button" className="btn btn-primary btn-lg" onClick={onResume} data-testid="resume-button">
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
  // No camera while on hold — also when the hold came from a check (monitoring never ran) or the ready screen.
  useEffect(() => ctrl.releaseIdleCamera(), [ctrl]);
  const state = snap.state!;
  const hold = state.session.hold;
  const [refreshing, setRefreshing] = useState(false);
  // Reopened for recovery by an administrator: not a hold the candidate has to wait out.
  const recovery = hold?.reason === 'recovery';
  return (
    <Page>
      <BrandHeader title={state.exam.title} />
      <main className="stack">
        <ReportingBanner />
        <section className="card stack" data-testid="hold-screen" data-reason={hold?.reason ?? ''}>
          <ScreenHeading>{recovery ? 'Your exam has been reopened' : 'Your exam is on hold'}</ScreenHeading>
          {/* Blocking state: announced assertively when the screen appears (the heading also gets the focus). */}
          <p className="cand-lead" role="alert">
            {hold?.message ?? 'Your exam is on hold while an administrator reviews it.'}
          </p>
          <dl className="cand-facts">
            {hold?.since && (
              <div>
                <dt>Since</dt>
                <dd>{formatDateTime(hold.since)}</dd>
              </div>
            )}
            <div>
              <dt>Exam clock</dt>
              <dd>{recovery ? 'Stopped until you pass the check' : 'Stopped while on hold'}</dd>
            </div>
          </dl>
          <CountdownDisplay />
          <p>
            {recovery
              ? 'Your answers and remaining time are saved. When you are ready, start the camera and identity check; your exam continues right after it.'
              : 'Your answers and remaining time are saved. This page updates automatically when the administrator responds; you can also close it and open the exam link later.'}
          </p>
          <div className="row">
            {hold?.canReverify && (
              <button type="button" className="btn btn-primary btn-lg" onClick={onReverify} data-testid="reverify-button">
                {recovery ? 'Continue to the identity check' : 'Verify again'}
              </button>
            )}
            <button
              type="button"
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

const END_TEXT: Record<CandidateEndReason | 'abandoned', string> = {
  candidate_submitted: 'You submitted your exam.',
  time_expired: 'The exam time ran out, and your saved answers were submitted automatically.',
  staff_submitted: 'Your exam was submitted by the exam administrator.',
  staff_terminated: 'Your exam was ended by the exam administrator.',
  candidate_withdrew: 'You withdrew your consent, so your exam has ended. Your face images were deleted. The exam provider will contact you about another way to take the exam.',
  abandoned: 'This exam was closed because it was not continued for a long time. Your saved answers are kept.',
  resume_limit: 'Your exam was interrupted more often or for longer than the exam rules allow, so it ended. Your saved answers were submitted.',
};

function endText(reason: string | null, terminated: boolean): string {
  if (reason && reason in END_TEXT) return END_TEXT[reason as keyof typeof END_TEXT];
  return terminated ? END_TEXT.staff_terminated : END_TEXT.candidate_submitted;
}

export function EndedScreen() {
  const ctrl = useController();
  const snap = useSnapshot();
  const state = snap.state!;
  const terminated = state.session.status === 'terminated';
  const pending = snap.outbox?.size ?? 0;
  useEffect(() => {
    void exitFullscreen().catch(() => undefined);
    // "Your camera is off": also when the exam ended while no monitoring ran (e.g. terminated from the ready screen).
    ctrl.releaseIdleCamera();
  }, [ctrl]);
  return (
    <Page>
      <BrandHeader title={state.exam.title} />
      <main className="stack">
        <section className="card stack" data-testid="ended-screen" data-status={state.session.status}>
          <ScreenHeading>{terminated ? 'Your exam has ended' : 'Your exam has been submitted'}</ScreenHeading>
          <p className="cand-lead">{endText(state.session.endReason, terminated)}</p>
          {!terminated && <p>Thank you. Monitoring has stopped and your camera is off. You can close this window.</p>}
          {terminated && <p>Monitoring has stopped and your camera is off. If you have questions about this, contact your exam administrator.</p>}
          {snap.answerNotice && (
            <p className="muted" role="status" data-testid="answers-not-saved">
              {snap.answerNotice}
            </p>
          )}
          {pending > 0 && (
            <p className="muted small" role="status">
              Finishing sending {pending} monitoring item{pending === 1 ? '' : 's'}… You may keep this page open for a moment.
            </p>
          )}
          <ContactLine />
          {ctrl.trace && <TraceDownload />}
        </section>
      </main>
    </Page>
  );
}

/* ------------------------------------------------------------------ scheduling window */

/**
 * The exam has not started and its scheduling window does not allow going further now: it opens later (before the
 * check-in may begin) or it has closed. Times in the candidate's own time zone. The page refreshes every minute (an
 * administrator may reschedule) and at the opening (the router re-renders at window boundaries).
 */
export function WindowScreen({ phase }: { phase: 'before_check_in' | 'closed' }) {
  const ctrl = useController();
  const snap = useSnapshot();
  const state = snap.state!;
  const [checking, setChecking] = useState(false);
  useEffect(() => ctrl.releaseIdleCamera(), [ctrl]);
  useEffect(() => {
    const id = setInterval(() => void ctrl.load(), 60_000);
    return () => clearInterval(id);
  }, [ctrl]);
  const text = windowScreenText(state.session.window, phase);
  return (
    <Page>
      <BrandHeader title={state.exam.title} />
      <main className="stack">
        <section className="card stack" data-testid="window-screen" data-phase={phase}>
          <ScreenHeading>{text.heading}</ScreenHeading>
          <p className="cand-lead">{text.lead}</p>
          <ul>
            {text.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <dl className="cand-facts">
            <div>
              <dt>Exam</dt>
              <dd>{state.exam.title}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{formatDuration(state.session.durationMs)}</dd>
            </div>
          </dl>
          <div className="row">
            <button
              type="button"
              className="btn"
              disabled={checking}
              onClick={async () => {
                setChecking(true);
                await ctrl.load();
                setChecking(false);
              }}
            >
              {checking ? 'Checking…' : 'Check again'}
            </button>
          </div>
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
              <ScreenHeading>This exam continues in another window</ScreenHeading>
              <p className="cand-lead">The exam was opened in another browser window or on another device, so this window has been disconnected.</p>
              <p>Your answers are saved. Continue in the other window — or, if you want to continue here instead, reload this page. You will repeat the camera and identity check.</p>
              <p className="muted small">{message}</p>
              <div className="row">
                <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
                  Continue in this window
                </button>
              </div>
            </>
          ) : (
            <>
              <ScreenHeading>This exam link is not valid</ScreenHeading>
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
              <ScreenHeading>We could not load your exam</ScreenHeading>
              <p role="alert">{error}</p>
              <div className="row">
                <button type="button" className="btn btn-primary" onClick={onRetry}>
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


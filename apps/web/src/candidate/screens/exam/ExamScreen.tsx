import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { AnswerValue } from '@sp/shared';
import { useController, useSnapshot } from '../../context';
import { CameraPreview, CountdownDisplay, PrivacyNoticeDialog, ReportingBanner, Spinner, Toasts } from '../../components/common';
import { PauseDialog, pauseAvailability, SubmitDialog } from './Dialogs';
import { QuestionView } from './QuestionView';

function useFullscreen(): boolean {
  const [fs, setFs] = useState(() => !!document.fullscreenElement);
  useEffect(() => {
    const on = () => setFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  return fs;
}

export async function enterFullscreen(): Promise<boolean> {
  if (document.fullscreenElement) return true;
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    return true;
  } catch {
    return false;
  }
}

const STATUS_TEXT: Record<string, string> = {
  ok: 'Monitoring active',
  attention: 'Monitoring active — please check the camera view',
  degraded: 'Monitoring limited',
  off: 'Monitoring starting',
};

export function ExamScreen() {
  const ctrl = useController();
  const snap = useSnapshot();
  const state = snap.state!;
  const questions = useMemo(() => [...(state.questions ?? [])].sort((a, b) => a.index - b.index), [state.questions]);
  const answers = ctrl.answers;
  useSyncExternalStore(
    useCallback((fn: () => void) => answers?.subscribe(fn) ?? (() => undefined), [answers]),
    () => answers?.snapshotVersion ?? 0,
  );
  const [current, setCurrent] = useState(() => Math.min(Math.max(0, ctrl.getCurrentQuestionIndex() || state.session.currentQuestionIndex || 0), Math.max(0, questions.length - 1)));
  const [dialog, setDialog] = useState<null | 'pause' | 'submit' | 'privacy'>(null);
  const fullscreen = useFullscreen();
  const policy = state.exam.policy;
  const requireFs = policy.browser.requireFullscreen;

  useEffect(() => {
    ctrl.setCurrentQuestionIndex(current);
  }, [ctrl, current]);

  // Keep the pending-approval dialog visible after a reload.
  const pendingPause = state.session.pauseRequest?.status === 'pending';
  useEffect(() => {
    if (pendingPause) setDialog((d) => d ?? 'pause');
  }, [pendingPause]);

  if (!answers || !snap.answersReady) {
    return (
      <div className="cand-page">
        <Spinner label="Loading your exam…" />
      </div>
    );
  }

  const q = questions[current];
  const answeredCount = answers.answeredCount(questions.map((x) => x.id));
  const setAnswer = (v: AnswerValue) => q && answers.set(q.id, v);
  const pa = pauseAvailability(state);
  const mon = snap.monitoring;
  const monState = !snap.monitoringActive ? 'off' : (mon?.state ?? 'off');
  const cameraProblem = snap.camera.state !== 'live' && snap.monitoringActive ? snap.camera.problem ?? 'The camera is not available. We are trying to reconnect it.' : null;

  return (
    <div className="cand-exam" data-testid="exam-screen">
      <header className="cand-exam-header">
        <div className="cand-exam-title">
          <strong>{state.exam.title}</strong>
          <span className="muted small">{state.candidate.name}</span>
        </div>
        <CountdownDisplay />
        <div className="spacer" />
        <div className={`cand-selfview cand-mon-${monState}`}>
          <CameraPreview stream={snap.camera.stream} className="cand-preview-mini" label="Your camera (self-view)" />
          <div className="stack" style={{ gap: 2 }}>
            <span className="cand-mon-status" data-testid="monitoring-status">
              <span className={`cand-dot cand-dot-${monState}`} aria-hidden="true" />
              {STATUS_TEXT[monState] ?? 'Monitoring active'}
            </span>
            <button className="cand-link" onClick={() => setDialog('privacy')} data-testid="what-is-monitored">
              Monitoring active — what is monitored?
            </button>
          </div>
        </div>
        {pa.allowed && (
          <button className="btn" onClick={() => setDialog('pause')} data-testid="pause-button">
            {pendingPause ? 'Pause requested…' : 'Pause'}
          </button>
        )}
        <button className="btn btn-primary" onClick={() => setDialog('submit')} data-testid="submit-button">
          Submit
        </button>
      </header>

      <div className="cand-exam-banners">
        <ReportingBanner />
        {cameraProblem && (
          <div className="banner banner-warning" role="status">
            {cameraProblem}
          </div>
        )}
        {snap.prompts.map((p) => (
          <div key={p.key} className={`banner ${p.severity === 'warning' ? 'banner-warning' : 'banner-info'} cand-prompt`} role="status" aria-live="polite" data-testid="candidate-prompt">
            {p.message}
          </div>
        ))}
        {snap.timeUp && (
          <div className="banner banner-info" role="status">
            Time is up. Your answers are being submitted…
          </div>
        )}
      </div>

      <div className="cand-exam-body">
        <nav className="cand-qnav" aria-label="Questions">
          <div className="muted small">
            {answeredCount} of {questions.length} answered
          </div>
          <ol>
            {questions.map((x, i) => {
              const answered = answers.isAnswered(x.id);
              return (
                <li key={x.id}>
                  <button
                    className={`cand-qnav-item ${i === current ? 'current' : ''} ${answered ? 'answered' : ''}`}
                    onClick={() => setCurrent(i)}
                    aria-current={i === current ? 'step' : undefined}
                    aria-label={`Question ${i + 1}${answered ? ', answered' : ', not answered'}`}
                    data-testid={`qnav-${i}`}
                  >
                    {i + 1}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
        <main className="cand-exam-main">
          {q ? (
            <>
              <QuestionView key={q.id} question={q} value={answers.get(q.id)} onChange={setAnswer} />
              <div className="row cand-exam-nav">
                <button className="btn" onClick={() => setCurrent((c) => Math.max(0, c - 1))} disabled={current === 0} data-testid="prev-question">
                  ← Previous
                </button>
                <span className="muted small" aria-live="polite">
                  {answers.isAnswered(q.id) ? 'Answer saved automatically' : 'Not answered yet'}
                </span>
                <div className="spacer" />
                {current < questions.length - 1 ? (
                  <button className="btn btn-primary" onClick={() => setCurrent((c) => Math.min(questions.length - 1, c + 1))} data-testid="next-question">
                    Next →
                  </button>
                ) : (
                  <button className="btn btn-primary" onClick={() => setDialog('submit')}>
                    Review and submit
                  </button>
                )}
              </div>
            </>
          ) : (
            <p>This exam has no questions.</p>
          )}
          {ctrl.trace && <TraceTools />}
        </main>
      </div>

      {requireFs && !fullscreen && !dialog && (
        <div className="cand-fs-overlay" role="dialog" aria-modal="true" aria-labelledby="fs-title" data-testid="fullscreen-overlay">
          <div className="card stack" style={{ maxWidth: 480 }}>
            <h2 id="fs-title">Return to fullscreen</h2>
            <p>This exam must be taken in fullscreen mode. Leaving fullscreen is recorded for the exam administrator. Your answers are saved.</p>
            <button className="btn btn-primary btn-lg" onClick={() => void enterFullscreen()} autoFocus data-testid="fullscreen-return">
              Return to fullscreen
            </button>
          </div>
        </div>
      )}

      {dialog === 'pause' && <PauseDialog state={state} onClose={() => setDialog(null)} />}
      {dialog === 'submit' && <SubmitDialog total={questions.length} answered={answeredCount} onClose={() => setDialog(null)} />}
      {dialog === 'privacy' && <PrivacyNoticeDialog notice={state.consent.notice} onClose={() => setDialog(null)} />}
      <Toasts />
    </div>
  );
}

function TraceTools() {
  const ctrl = useController();
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((x) => x + 1), 2000);
    return () => clearInterval(id);
  }, []);
  const t = ctrl.trace;
  if (!t) return null;
  return (
    <div className="card cand-trace" data-testid="trace-tools">
      <strong>Evaluation trace</strong> <span className="muted small">{t.observationCount} observations recorded</span>{' '}
      <button className="btn btn-sm" onClick={() => t.download()} data-testid="trace-download">
        Download trace (JSONL)
      </button>
    </div>
  );
}

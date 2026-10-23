import { useRef, useState } from 'react';
import { useDialogFocus } from '../../lib/a11y';
import { useController, useSnapshot } from '../context';

/**
 * Sharing the entire screen for an exam that records it (policy.recording.screen). `getDisplayMedia` needs a click,
 * so sharing is a step before the start (ready screen) and a cover over the exam whenever sharing stopped
 * (ScreenShareOverlay) — like the "Return to fullscreen" cover.
 */

function useShare() {
  const ctrl = useController();
  const [busy, setBusy] = useState(false);
  const share = async () => {
    setBusy(true);
    try {
      await ctrl.shareScreen();
    } finally {
      setBusy(false);
    }
  };
  return { busy, share };
}

/** The "Share your screen" step on the ready screen: Start stays disabled until the entire screen is shared. */
export function ScreenShareStep() {
  const snap = useSnapshot();
  const { busy, share } = useShare();
  const sc = snap.screen;
  return (
    <section className="card stack" aria-labelledby="screen-share-title" data-testid="screen-share-step" data-live={sc.live ? '1' : '0'}>
      <h2 id="screen-share-title">Share your screen</h2>
      <p>
        This exam records your entire screen while you take it, so the exam administrator can see what was on your screen during the exam. Select “Share your screen”
        and choose <strong>Entire screen</strong> (or your screen) — not a window or a browser tab. If you have more than one screen, choose the one you will use for
        the exam.
      </p>
      <p className="muted small">
        Before you share, close anything you do not want recorded, such as messages, e-mail or other documents. Recording starts when you start the exam and stops when
        it is paused or ends.
      </p>
      {sc.live ? (
        <div className="banner banner-success" role="status" data-testid="screen-share-status">
          Your screen is shared.
          {sc.surface === 'unknown' ? ' Your browser does not say what you shared — make sure it is your entire screen.' : ''}
        </div>
      ) : (
        <>
          {sc.problem && (
            <div className="banner banner-warning" role="alert" data-testid="screen-share-problem">
              {sc.problem}
            </div>
          )}
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={() => void share()} disabled={busy || sc.requesting} data-testid="screen-share-button">
              {busy || sc.requesting ? 'Waiting for you to choose…' : 'Share your screen'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Blocking cover while the exam records the screen but it is not shared (sharing stopped during the exam, or the exam
 * continues after a pause or a reload). No Escape: it must be answered. The exam clock keeps running meanwhile.
 */
export function ScreenShareOverlay() {
  const snap = useSnapshot();
  const { busy, share } = useShare();
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, { initialFocus: () => ref.current?.querySelector<HTMLElement>('[data-testid="screen-share-again"]') });
  const stopped = snap.screen.endedAt != null;
  return (
    <div className="cand-fs-overlay" role="dialog" aria-modal="true" aria-labelledby="ss-title" aria-describedby="ss-desc" data-testid="screen-share-overlay" ref={ref}>
      <div className="card stack" style={{ maxWidth: 520 }}>
        <h2 id="ss-title">{stopped ? 'Share your screen again to continue' : 'Share your screen to continue'}</h2>
        <p id="ss-desc">
          {stopped
            ? 'Your screen is no longer being shared. This exam records your entire screen, so the exam is covered until you share it again. This is recorded for the exam administrator. Your answers are saved; the exam time keeps running.'
            : 'This exam records your entire screen. Share your entire screen to continue the exam. Your answers are saved; the exam time keeps running.'}
        </p>
        {snap.screen.problem && (
          <div className="banner banner-warning" role="alert" data-testid="screen-share-problem">
            {snap.screen.problem}
          </div>
        )}
        <button type="button" className="btn btn-primary btn-lg" onClick={() => void share()} disabled={busy || snap.screen.requesting} data-testid="screen-share-again">
          {busy || snap.screen.requesting ? 'Waiting for you to choose…' : 'Share your screen'}
        </button>
      </div>
    </div>
  );
}

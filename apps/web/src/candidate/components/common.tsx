import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { PrivacyNoticeDTO } from '@sp/shared';
import { formatClock } from '@sp/shared';
import { announce, countdownAnnouncement, useDialogFocus, useDocumentTitle, useFocusOnMount } from '../../lib/a11y';
import { useController, useNow, useSnapshot } from '../context';

/* ------------------------------------------------------------------ layout */

export function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="cand-page">
      <div className={wide ? 'cand-container cand-container-wide' : 'cand-container'}>{children}</div>
    </div>
  );
}

export function BrandHeader({ title, right }: { title?: string; right?: ReactNode }) {
  return (
    <header className="cand-brand">
      <div className="cand-brand-name">SmartProctoring</div>
      {title && <div className="cand-brand-title">{title}</div>}
      <div className="spacer" />
      {right}
    </header>
  );
}

/* ------------------------------------------------------------------ screen heading */

/**
 * The <h1> of a screen or check step: sets the document title and receives the focus when the screen
 * appears, so keyboard and screen-reader users start at the new content (WCAG 2.4.2, 2.4.3).
 */
export function ScreenHeading({ children, title, id, className }: { children: ReactNode; title?: string; id?: string; className?: string }) {
  const snap = useSnapshot();
  const ref = useFocusOnMount<HTMLHeadingElement>();
  const screen = title ?? (typeof children === 'string' ? children : null);
  const exam = snap.state?.exam.title;
  useDocumentTitle(screen ? `${screen}${exam && exam !== screen ? ` — ${exam}` : ''} — SmartProctoring` : null);
  return (
    <h1 ref={ref} tabIndex={-1} id={id} className={className}>
      {children}
    </h1>
  );
}

/* ------------------------------------------------------------------ modal */

/**
 * Modal dialog: focus moves in (to `[data-autofocus]` or the first control), Tab stays inside, the page
 * behind is inert, Escape closes it when `onClose` is given (critical dialogs omit it), and focus returns
 * to the opener when it closes.
 */
export function Modal({
  title,
  children,
  onClose,
  labelledBy,
  describedBy,
}: {
  title: string;
  children: ReactNode;
  onClose?: () => void;
  labelledBy?: string;
  describedBy?: string;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, { onEscape: onClose ?? null });
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal cand-modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy ?? id} aria-describedby={describedBy} ref={ref}>
        <h2 id={labelledBy ?? id}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ privacy notice */

export function PrivacyNotice({ notice, compact }: { notice: PrivacyNoticeDTO; compact?: boolean }) {
  return (
    <div className="cand-notice">
      <div className={compact ? 'stack' : 'grid-2'}>
        <section>
          <h3>What is monitored</h3>
          <ul>
            {notice.monitored.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </section>
        <section>
          <h3>What is stored</h3>
          <ul>
            {notice.stored.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
          <h3>What is not stored</h3>
          <ul>
            {notice.notStored.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </section>
      </div>
      {notice.sections.map((s, i) => (
        <section key={i}>
          <h3>{s.heading}</h3>
          <p>{s.body}</p>
        </section>
      ))}
      <p className="muted small">
        Screenshots and identity data are deleted {notice.retentionDays} days after your exam ends. Questions or concerns: <strong>{notice.contact}</strong>. Notice version{' '}
        {notice.version}.
      </p>
    </div>
  );
}

export function PrivacyNoticeDialog({ notice, onClose }: { notice: PrivacyNoticeDTO; onClose: () => void }) {
  return (
    <Modal title="What is monitored during your exam" onClose={onClose}>
      {/* Focusable so the notice can be scrolled with the keyboard. */}
      <div className="cand-modal-scroll" tabIndex={0} role="region" aria-label="Privacy notice">
        <PrivacyNotice notice={notice} compact />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="btn btn-primary" onClick={onClose} data-autofocus>
          Close
        </button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ camera preview */

/** Mirrored (CSS only) live preview of the camera stream. Analysis never uses this element. */
export function CameraPreview({ stream, className, label = 'Your camera preview', overlay }: { stream: MediaStream | null; className?: string; label?: string; overlay?: ReactNode }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (v.srcObject !== stream) v.srcObject = stream;
    if (stream) void v.play().catch(() => undefined);
  }, [stream]);
  return (
    <div className={`cand-preview ${className ?? ''}`}>
      <video ref={ref} className="cand-preview-video" muted playsInline autoPlay aria-label={label} />
      {!stream && <div className="cand-preview-empty">Camera is off</div>}
      {overlay}
    </div>
  );
}

/* ------------------------------------------------------------------ banners & toasts */

/**
 * "Live reporting is interrupted" inside a persistent assertive live region (a blocking state): the
 * banner is announced when it appears; later changes of the waiting-items count are not re-announced
 * (aria-relevant="additions").
 */
export function ReportingBanner() {
  const snap = useSnapshot();
  return (
    <div className="cand-live-slot" aria-live="assertive" aria-relevant="additions">
      {snap.reportingInterrupted && (
        <div className="banner banner-warning cand-reporting" data-testid="reporting-banner">
          Live reporting is interrupted. Your answers and monitoring data are saved on this device and will be sent automatically when the connection returns.
          {snap.outbox && snap.outbox.size > 0 && <span className="muted small"> ({snap.outbox.size} item{snap.outbox.size === 1 ? '' : 's'} waiting)</span>}
        </div>
      )}
    </div>
  );
}

/** Notifications in a persistent polite live region: each is announced once when it appears. */
export function Toasts() {
  const snap = useSnapshot();
  const c = useController();
  return (
    <div className="cand-toasts" aria-live="polite" aria-relevant="additions">
      {snap.toasts.map((t) => (
        <div key={t.id} className={`cand-toast cand-toast-${t.kind}`}>
          <span>{t.message}</span>
          <button type="button" className="cand-toast-close" aria-label="Dismiss notification" onClick={() => c.dismissToast(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ countdown */

/**
 * Remaining exam time. The value is a role="timer" (not a live region: it is never read out every
 * second); with `announceMarks` the time left is announced politely at 10, 5 and 1 minute(s).
 */
export function CountdownDisplay({ label = 'Time remaining', announceMarks = false }: { label?: string; announceMarks?: boolean }) {
  const c = useController();
  useNow(500);
  const labelId = useId();
  const ms = c.remainingMs();
  const running = c.countdown.running;
  const low = running && ms < 5 * 60_000;
  const prev = useRef<number | null>(null);
  useEffect(() => {
    if (!announceMarks) return;
    const msg = running ? countdownAnnouncement(prev.current, ms) : null;
    prev.current = ms;
    if (msg) announce(`${msg} Your answers are saved automatically.`, 'polite');
  });
  return (
    <div className={`cand-countdown ${low ? 'cand-countdown-low' : ''}`} data-testid="countdown">
      <span className="cand-countdown-label" id={labelId}>
        {label}
      </span>
      <span className="cand-countdown-value" role="timer" aria-labelledby={labelId}>
        {formatClock(ms)}
      </span>
      {!running && <span className="badge badge-info">clock stopped</span>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="cand-spinner-wrap" role="status">
      <span className="cand-spinner" aria-hidden="true" />
      {label && <span>{label}</span>}
    </span>
  );
}

export function ContactLine() {
  const snap = useSnapshot();
  const contact = snap.state?.consent.notice.contact;
  if (!contact) return null;
  return (
    <p className="muted small">
      Questions or problems? Contact <strong>{contact}</strong>.
    </p>
  );
}

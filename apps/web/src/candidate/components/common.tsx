import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { PrivacyNoticeDTO } from '@sp/shared';
import { formatClock } from '@sp/shared';
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

/* ------------------------------------------------------------------ modal */

export function Modal({ title, children, onClose, labelledBy }: { title: string; children: ReactNode; onClose?: () => void; labelledBy?: string }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusable = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>('button, textarea, input, select, a[href]');
    focusable?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onClose) onClose();
      if (e.key === 'Tab' && el) {
        const items = [...el.querySelectorAll<HTMLElement>('button, textarea, input, select, a[href], [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled'));
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal cand-modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy ?? id} ref={ref}>
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
      <div className="cand-modal-scroll">
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

export function ReportingBanner() {
  const snap = useSnapshot();
  if (!snap.reportingInterrupted) return null;
  return (
    <div className="banner banner-warning cand-reporting" role="status" aria-live="polite" data-testid="reporting-banner">
      Live reporting is interrupted. Your answers and monitoring data are saved on this device and will be sent automatically when the connection returns.
      {snap.outbox && snap.outbox.size > 0 && <span className="muted small"> ({snap.outbox.size} item{snap.outbox.size === 1 ? '' : 's'} waiting)</span>}
    </div>
  );
}

export function Toasts() {
  const snap = useSnapshot();
  const c = useController();
  if (snap.toasts.length === 0) return null;
  return (
    <div className="cand-toasts" role="status" aria-live="polite">
      {snap.toasts.map((t) => (
        <div key={t.id} className={`cand-toast cand-toast-${t.kind}`}>
          <span>{t.message}</span>
          <button className="cand-toast-close" aria-label="Dismiss" onClick={() => c.dismissToast(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ countdown */

export function CountdownDisplay({ label = 'Time remaining' }: { label?: string }) {
  const c = useController();
  useNow(500);
  const ms = c.remainingMs();
  const running = c.countdown.running;
  const low = running && ms < 5 * 60_000;
  return (
    <div className={`cand-countdown ${low ? 'cand-countdown-low' : ''}`} aria-label={`${label}: ${formatClock(ms)}${running ? '' : ', clock stopped'}`} data-testid="countdown">
      <span className="cand-countdown-label">{label}</span>
      <span className="cand-countdown-value" role="timer">
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

import { useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useDialogFocus } from '../../lib/a11y';

/**
 * Accessible modal dialog: Escape / backdrop click closes; focus moves to the first field (else the
 * primary button), Tab stays inside, the page behind is inert, and focus returns to the opener.
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus(ref, {
    onEscape: onClose,
    initialFocus: () => {
      const el = ref.current;
      if (!el) return null;
      return (
        el.querySelector<HTMLElement>('[data-autofocus]') ??
        el.querySelector<HTMLElement>('.modal-body :is(input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled]))') ??
        el.querySelector<HTMLElement>('.modal-foot .btn-primary:not([disabled]), .modal-foot .btn-danger:not([disabled])') ??
        el.querySelector<HTMLElement>('.modal-foot button:not([disabled])') ??
        el.querySelector<HTMLElement>('.modal-head button')
      );
    },
  });
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`modal admin-modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Confirmation dialog. `requireText` makes the user type a reason (passed to onConfirm);
 * `danger` styles the confirm button red.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  danger = false,
  busy = false,
  error,
  requireText,
  optionalText,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  /** Label for a required text input (e.g. "Reason"). */
  requireText?: string;
  /** Label for an optional text input (e.g. "Note (optional)"). */
  optionalText?: string;
  onConfirm: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const needsText = Boolean(requireText);
  const disabled = busy || (needsText && !text.trim());
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={danger ? 'btn btn-danger' : 'btn btn-primary'} disabled={disabled} onClick={() => onConfirm(text.trim())}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="stack">
        <div>{message}</div>
        {requireText || optionalText ? (
          <label>
            {requireText ?? optionalText}
            <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} rows={3} />
          </label>
        ) : null}
        {error ? (
          <div className="banner banner-danger" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

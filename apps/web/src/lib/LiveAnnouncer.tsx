import { createPortal } from 'react-dom';
import { useAnnouncerState } from './a11y';

/**
 * Persistent, visually hidden live regions fed by `announce()`. Rendered once per app, outside the
 * screens (a region must exist before its text changes to be announced reliably), directly in <body>
 * and marked `data-a11y-keep` so it is never made inert while a dialog is open.
 */
export function LiveAnnouncer() {
  const { polite, assertive } = useAnnouncerState();
  // Portalled to <body> so that no dialog ever makes it inert.
  return createPortal(
    <div className="sr-only" data-a11y-keep="" data-testid="live-announcer">
      <div role="status" aria-live="polite" aria-atomic="true" data-testid="announcer-polite">
        {polite}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true" data-testid="announcer-assertive">
        {assertive}
      </div>
    </div>,
    document.body,
  );
}

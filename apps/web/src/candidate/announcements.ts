import { useEffect, useRef } from 'react';
import { announce } from '../lib/a11y';
import { useSnapshot } from './context';

/**
 * Screen-reader announcements for changes that have no visible text of their own (mounted once, above
 * the screens). Visible messages are announced by the live regions that contain them instead:
 * "Live reporting is interrupted" and the hold message (assertive: they block the candidate),
 * monitoring prompts, the camera problem, "time is up" and notifications (polite).
 * Screen changes themselves are conveyed by moving the focus to the new screen's heading.
 */
export function useCandidateAnnouncements(): void {
  const snap = useSnapshot();
  const wasInterrupted = useRef<boolean | null>(null);
  useEffect(() => {
    const prev = wasInterrupted.current;
    wasInterrupted.current = snap.reportingInterrupted;
    if (prev && !snap.reportingInterrupted) announce('Connection restored. Live reporting has resumed.', 'polite');
  }, [snap.reportingInterrupted]);
}

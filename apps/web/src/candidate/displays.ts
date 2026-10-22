import { useCallback, useEffect, useState } from 'react';
import { displayReport, type DisplayReport, type ScreenInfo } from '@sp/shared';

/**
 * Connected displays as the browser reports them: the Window Management API's `screen.isExtended` (Chrome and Edge)
 * and its `change` event on `window.screen`. Firefox and Safari do not report it ('unknown'). An exam that requires a
 * single display (policy.browser.requireSingleDisplay) cannot be started while more than one display is reported; the
 * welcome system check, the ready screen and the hold screen follow changes as they happen, without a reload.
 */

type ExtendedScreen = Screen & { isExtended?: boolean };

export function readDisplays(scr: Screen | undefined = typeof window !== 'undefined' ? window.screen : undefined): DisplayReport {
  return displayReport((scr as ExtendedScreen | undefined)?.isExtended);
}

/** DeviceInfo.screen: size, and isExtended (null where the browser cannot tell). */
export function screenInfo(scr: Screen = window.screen): ScreenInfo {
  const ext = (scr as ExtendedScreen).isExtended;
  return { width: scr.width, height: scr.height, isExtended: typeof ext === 'boolean' ? ext : null };
}

/** Calls `fn` when a display is connected or disconnected, where the browser reports it (no-op elsewhere). */
export function onDisplaysChange(fn: () => void, scr: Screen | undefined = typeof window !== 'undefined' ? window.screen : undefined): () => void {
  if (!scr || !('onchange' in scr) || typeof (scr as unknown as EventTarget).addEventListener !== 'function') return () => undefined;
  const target = scr as unknown as EventTarget;
  target.addEventListener('change', fn);
  return () => target.removeEventListener('change', fn);
}

/** The current display report, updated on every change; `recheck` reads it again (a "Check again" button). */
export function useDisplays(): { displays: DisplayReport; recheck: () => void } {
  const [displays, setDisplays] = useState<DisplayReport>(() => readDisplays());
  const recheck = useCallback(() => setDisplays(readDisplays()), []);
  useEffect(() => {
    recheck();
    return onDisplaysChange(recheck);
  }, [recheck]);
  return { displays, recheck };
}

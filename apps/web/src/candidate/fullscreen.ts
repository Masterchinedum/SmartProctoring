/**
 * Fullscreen API with the WebKit-prefixed fallback. Chrome, Edge, Firefox and Safari 16.4+ have the standard API;
 * Safari 16.0–16.3 (and iPadOS of that age) only `webkitRequestFullscreen` / `webkitFullscreenElement` /
 * `webkitfullscreenchange` — without the fallback a `requireFullscreen` exam would keep its "Return to fullscreen"
 * overlay up there. Browsers with neither (iPhone Safari) report "not supported" (the system check says so).
 */

type WebkitDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
};
type WebkitElement = HTMLElement & { webkitRequestFullscreen?: () => void };

/** The element shown in fullscreen, or null. */
export function fullscreenElement(doc: Document = document): Element | null {
  return doc.fullscreenElement ?? (doc as WebkitDocument).webkitFullscreenElement ?? null;
}

export function isFullscreen(doc: Document = document): boolean {
  return !!fullscreenElement(doc);
}

export function fullscreenSupported(doc: Document = document): boolean {
  const el = doc.documentElement as WebkitElement;
  return typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function';
}

/** Puts the whole page in fullscreen (needs a user gesture). Rejects when refused or not supported. */
export async function requestFullscreen(doc: Document = document): Promise<void> {
  const el = doc.documentElement as WebkitElement;
  if (typeof el.requestFullscreen === 'function') return el.requestFullscreen({ navigationUI: 'hide' });
  if (typeof el.webkitRequestFullscreen === 'function') {
    // The prefixed call returns nothing: the change (or nothing, when refused) arrives as webkitfullscreenchange.
    el.webkitRequestFullscreen();
    return;
  }
  throw new Error('Fullscreen is not supported in this browser');
}

export async function exitFullscreen(doc: Document = document): Promise<void> {
  if (!isFullscreen(doc)) return;
  if (typeof doc.exitFullscreen === 'function') return doc.exitFullscreen();
  (doc as WebkitDocument).webkitExitFullscreen?.();
}

/** Calls `fn` on every fullscreen change (the standard event, or the prefixed one where only that exists). */
export function onFullscreenChange(fn: () => void, doc: Document = document): () => void {
  // Chrome fires both events: listen to one only, so every change is reported once.
  const type = 'onfullscreenchange' in doc || !('onwebkitfullscreenchange' in doc) ? 'fullscreenchange' : 'webkitfullscreenchange';
  doc.addEventListener(type, fn);
  return () => doc.removeEventListener(type, fn);
}

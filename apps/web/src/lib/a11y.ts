import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * Accessibility helpers shared by the candidate and staff apps (no dependencies):
 *  - document titles per screen,
 *  - moving focus to a screen's heading when it appears,
 *  - modal dialogs: background made inert, Tab kept inside, Escape, focus restored on close,
 *  - a screen-reader announcer (persistent polite / assertive live regions),
 *  - countdown announcements at fixed minute marks (never every second),
 *  - WCAG contrast ratio (used by the unit tests that guard the colour tokens).
 */

/* ------------------------------------------------------------------ titles */

export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);
}

/* ------------------------------------------------------------------ focus */

/** Whether the user has pressed a key or pointer yet (no focus is moved on the initial page load). */
let userInteracted = false;
if (typeof window !== 'undefined') {
  const mark = () => {
    userInteracted = true;
  };
  for (const type of ['keydown', 'pointerdown', 'mousedown', 'touchstart']) window.addEventListener(type, mark, { capture: true, passive: true });
}

/**
 * Focus the element when it mounts (e.g. the <h1> of a new screen, which gets tabIndex={-1}), so screen
 * reader and keyboard users start at the new content instead of a button that no longer exists.
 * Skipped on the initial page load (before any interaction the reading position is the top of the
 * page anyway) and while a modal dialog owns the focus.
 */
export function useFocusOnMount<T extends HTMLElement>(enabled = true) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;
    const active = document.activeElement;
    if (!userInteracted && (!active || active === document.body)) return;
    if (active && active !== document.body && active.closest('[aria-modal="true"]') && !el.closest('[aria-modal="true"]')) return;
    el.focus({ preventScroll: false });
  }, [enabled]);
  return ref;
}

export const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, iframe, audio[controls], video[controls], [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])';

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[inert]') && el.getClientRects().length > 0);
}

/** Elements that must stay in the accessibility tree while a dialog is open (live regions). */
const KEEP_ATTR = 'data-a11y-keep';

/**
 * Make everything outside `el` inert (not focusable, hidden from assistive technology) — the robust way
 * to keep keyboard and screen-reader focus inside a modal. Returns a function that undoes it.
 */
export function inertOthers(el: HTMLElement): () => void {
  const changed: HTMLElement[] = [];
  let node: HTMLElement | null = el;
  while (node && node !== document.body && node.parentElement) {
    const parent: HTMLElement = node.parentElement;
    for (const sib of Array.from(parent.children)) {
      if (sib === node || !(sib instanceof HTMLElement)) continue;
      if (sib.hasAttribute(KEEP_ATTR) || sib.tagName === 'SCRIPT' || sib.tagName === 'STYLE') continue;
      if (sib.inert) continue;
      sib.inert = true;
      changed.push(sib);
    }
    node = parent;
  }
  return () => {
    for (const s of changed) s.inert = false;
  };
}

export interface DialogFocusOptions {
  /** Escape closes the dialog when given (omit for dialogs that must not be dismissed). */
  onEscape?: (() => void) | null;
  /** Element to focus first; default: `[data-autofocus]`, else the first focusable element, else the dialog. */
  initialFocus?: () => HTMLElement | null | undefined;
}

/**
 * Focus management for a modal dialog rendered while `ref` is mounted: initial focus, Tab / Shift+Tab
 * wrap inside the dialog, background inert, Escape (optional), focus returned to the opener on close.
 * The options are read through a ref, so re-renders with new callbacks never move the focus.
 */
export function useDialogFocus(ref: React.RefObject<HTMLElement | null>, opts: DialogFocusOptions = {}): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const restoreInert = inertOthers(el);
    const first = optsRef.current.initialFocus?.() ?? el.querySelector<HTMLElement>('[data-autofocus]') ?? focusableIn(el)[0] ?? el;
    if (first === el && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    first.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const esc = optsRef.current.onEscape;
        // Only the top-most dialog reacts (a lightbox above a drawer, for example).
        if (esc && isTopDialog(el)) {
          e.stopPropagation();
          e.preventDefault();
          esc();
        }
        return;
      }
      if (e.key !== 'Tab' || !isTopDialog(el)) return;
      const items = focusableIn(el);
      if (items.length === 0) {
        e.preventDefault();
        el.focus();
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!active || !el.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? lastItem : firstItem).focus();
      } else if (e.shiftKey && (active === firstItem || active === el)) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && active === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      restoreInert();
      // Return focus to the control that opened the dialog, if it is still there.
      if (opener && opener.isConnected && !opener.closest('[inert]')) opener.focus();
    };
  }, [ref]);
}

function isTopDialog(el: HTMLElement): boolean {
  const all = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].filter((d) => !d.closest('[inert]'));
  return all.length === 0 || all[all.length - 1] === el || el.contains(all[all.length - 1]);
}

/* ------------------------------------------------------------------ roving tabs */

/**
 * Keyboard support for a WAI-ARIA tablist (automatic activation): ←/→ (and ↑/↓) move to the previous /
 * next tab, Home / End to the first / last; only the selected tab is in the Tab order.
 */
export function tabKeyTarget<T>(ids: readonly T[], current: T, key: string): T | null {
  const i = ids.indexOf(current);
  if (i < 0 || ids.length === 0) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return ids[(i + 1) % ids.length];
    case 'ArrowLeft':
    case 'ArrowUp':
      return ids[(i - 1 + ids.length) % ids.length];
    case 'Home':
      return ids[0];
    case 'End':
      return ids[ids.length - 1];
    default:
      return null;
  }
}

export function tabProps<T extends string>(
  prefix: string,
  ids: readonly T[],
  id: T,
  selected: T,
  onSelect: (id: T) => void,
): {
  role: 'tab';
  id: string;
  'aria-selected': boolean;
  'aria-controls': string;
  tabIndex: number;
  onClick: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
} {
  return {
    role: 'tab',
    id: `${prefix}-tab-${id}`,
    'aria-selected': id === selected,
    'aria-controls': `${prefix}-panel`,
    tabIndex: id === selected ? 0 : -1,
    onClick: () => onSelect(id),
    onKeyDown: (e) => {
      const next = tabKeyTarget(ids, id, e.key);
      if (next == null) return;
      e.preventDefault();
      onSelect(next);
      document.getElementById(`${prefix}-tab-${next}`)?.focus();
    },
  };
}

/* ------------------------------------------------------------------ announcer */

export type Politeness = 'polite' | 'assertive';

interface AnnouncerState {
  polite: string;
  assertive: string;
}

let announcerState: AnnouncerState = { polite: '', assertive: '' };
const announcerListeners = new Set<() => void>();
const clearTimers: Partial<Record<Politeness, ReturnType<typeof setTimeout>>> = {};

function setAnnouncer(patch: Partial<AnnouncerState>): void {
  announcerState = { ...announcerState, ...patch };
  for (const l of announcerListeners) l();
}

/**
 * Speak `message` through the persistent live region of the given politeness. The region is emptied
 * first so that repeating the same message is announced again. Use 'assertive' only for blocking states.
 */
export function announce(message: string, politeness: Politeness = 'polite'): void {
  if (!message) return;
  setAnnouncer({ [politeness]: '' });
  clearTimeout(clearTimers[politeness]);
  // A short gap lets screen readers notice the change even when the text is the same as before.
  clearTimers[politeness] = setTimeout(() => {
    setAnnouncer({ [politeness]: message });
    clearTimers[politeness] = setTimeout(() => setAnnouncer({ [politeness]: '' }), 7_000);
  }, 60);
}

export function useAnnouncerState(): AnnouncerState {
  return useSyncExternalStore(
    (fn) => {
      announcerListeners.add(fn);
      return () => announcerListeners.delete(fn);
    },
    () => announcerState,
  );
}

/* ------------------------------------------------------------------ countdown */

/** Minute marks at which the remaining exam time is announced (not every second). */
export const COUNTDOWN_MARKS_MIN = [10, 5, 1] as const;

/**
 * The announcement due when the remaining time moves from `prevMs` to `ms`: the smallest mark crossed
 * (e.g. "5 minutes remaining."), or null. Crossing several marks at once (sleeping laptop) announces the
 * lowest one only; time going up (extension) announces nothing.
 */
export function countdownAnnouncement(prevMs: number | null, ms: number): string | null {
  if (prevMs == null || !(ms < prevMs)) return null;
  let crossed: number | null = null;
  for (const m of COUNTDOWN_MARKS_MIN) {
    const mark = m * 60_000;
    if (prevMs > mark && ms <= mark && ms > 0) crossed = m;
  }
  if (crossed == null) return null;
  return crossed === 1 ? '1 minute remaining.' : `${crossed} minutes remaining.`;
}

/* ------------------------------------------------------------------ contrast */

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = [...h].map((x) => x + x).join('');
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x contrast ratio between two opaque colours (#rgb or #rrggbb). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

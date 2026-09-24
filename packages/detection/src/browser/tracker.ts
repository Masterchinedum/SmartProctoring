import type { BrowserPolicy, EpisodeUpdate, EventType } from '@sp/shared';
import { EpisodeBook } from '../engine/episodes';
import { dur } from '../engine/span';
import { defaultIdFactory } from '../util/id';
import { round } from '../util/math';

/**
 * Exam-page browser signals as episodes with the same open / update / close semantics as the camera
 * engine. The browser only reports THAT the page was hidden / unfocused / not fullscreen — never what
 * the candidate did instead — and the observation sentences say exactly that.
 *
 *  - tab_hidden (policy.flagTabHidden): opens immediately when the page becomes hidden, closes when
 *    visible again. A blur that is still pending (shorter than windowBlurMinSec) when the page becomes
 *    hidden is converted: no window_unfocused is reported and tab_hidden starts at the blur time
 *    (switching apps usually fires blur first, then visibilitychange). A window_unfocused episode that
 *    was already open is closed at the moment the page is hidden.
 *  - window_unfocused (policy.flagWindowBlur): the window lost focus while visible for at least
 *    windowBlurMinSec (confirmed by tick() or the next call); startedAt = the blur time.
 *  - fullscreen_exited: only when policy.requireFullscreen.
 *  - clipboard_attempt: copy/cut/paste attempts aggregate into one episode while they keep coming;
 *    it closes after `clipboardQuietSec` (default 10 s) without another attempt (endedAt = last attempt).
 *  - additional_display_detected: neutral marker once per change of isExtended to true.
 *  Episodes of the same type within mergeGapSec (default 10 s) of the previous one re-open it (same id).
 */
export interface BrowserSignalTracker {
  visibility(hidden: boolean, t: number): EpisodeUpdate[];
  focus(focused: boolean, t: number): EpisodeUpdate[];
  fullscreen(active: boolean, t: number): EpisodeUpdate[];
  clipboard(action: 'copy' | 'cut' | 'paste', t: number): EpisodeUpdate[];
  displays(isExtended: boolean | null, t: number): EpisodeUpdate[];
  tick(t: number): EpisodeUpdate[];
  flush(t: number): EpisodeUpdate[];
}

interface SpanStats {
  count: number;
  totalMs: number;
  segStart: number;
}

type ClipAction = 'copy' | 'cut' | 'paste';

export function createBrowserSignalTracker(
  policy: BrowserPolicy,
  opts?: { idFactory?: () => string; mergeGapSec?: number; clipboardQuietSec?: number },
): BrowserSignalTracker {
  const book = new EpisodeBook({
    idFactory: opts?.idFactory ?? defaultIdFactory,
    mergeGapMs: (opts?.mergeGapSec ?? 10) * 1000,
    maxShots: 1,
    periodicShotMs: Number.MAX_SAFE_INTEGER,
    minUpdateMs: 5000,
    peakSpacingMs: Number.MAX_SAFE_INTEGER,
  });
  const quietMs = Math.max(1, opts?.clipboardQuietSec ?? 10) * 1000;
  const blurMinMs = Math.max(0, policy.windowBlurMinSec) * 1000;

  let hidden: boolean | null = null;
  let focused: boolean | null = null;
  let fs: boolean | null = null;
  let extended: boolean | null = null;
  let blurSince: number | null = null;
  let lastT = -Infinity;
  const stats: Partial<Record<EventType, SpanStats>> = {};
  let clip = { copy: 0, cut: 0, paste: 0, lastAt: 0, actions: [] as { action: ClipAction; at: number }[] };

  const at = (t: number) => (Number.isFinite(t) ? Math.max(t, lastT) : lastT);

  function describe(type: EventType, st: SpanStats, endedAt: number | null, t: number): { confidence: number; details: Record<string, unknown>; observation: string } {
    const running = endedAt === null ? t - st.segStart : 0;
    const totalSec = round((st.totalMs + running) / 1000, 1);
    const details: Record<string, unknown> = { count: st.count, totalSec };
    const times = st.count > 1 ? ` ${st.count} times (${dur(totalSec)} in total)` : ` for ${dur(totalSec)}`;
    let observation = '';
    if (type === 'tab_hidden') observation = endedAt === null && st.count === 1 ? 'The exam tab is hidden (another tab or application is in front, or the browser is minimised).' : `The exam tab was hidden${times}.`;
    else if (type === 'window_unfocused') observation = endedAt === null && st.count === 1 ? 'The exam window lost focus while remaining visible.' : `The exam window lost focus while remaining visible${times}.`;
    else if (type === 'fullscreen_exited') observation = endedAt === null && st.count === 1 ? 'The exam is not in the required fullscreen mode.' : `The exam was outside required fullscreen mode${times}.`;
    return { confidence: 1, details, observation };
  }

  function openSpan(type: EventType, startedAt: number, t: number, out: EpisodeUpdate[]): void {
    const wasMerge = book.wouldMerge(type, startedAt);
    if (!wasMerge || !stats[type]) stats[type] = { count: 0, totalMs: 0, segStart: startedAt };
    const st = stats[type]!;
    st.count++;
    st.segStart = startedAt;
    const { update } = book.begin(type, type, startedAt, t, describe(type, st, null, t));
    out.push(update);
  }

  function closeSpan(type: EventType, endedAt: number, t: number, out: EpisodeUpdate[]): void {
    const st = stats[type];
    if (!st || !book.isOpen(type)) return;
    st.totalMs += Math.max(0, endedAt - st.segStart);
    const u = book.end(type, endedAt, t, describe(type, st, endedAt, t));
    if (u) out.push(u);
  }

  function clipData(closed: boolean) {
    const total = clip.copy + clip.cut + clip.paste;
    const parts = (['copy', 'cut', 'paste'] as const).filter((k) => clip[k] > 0).map((k) => `${clip[k]} ${k}`);
    const observation =
      total === 1
        ? `A ${clip.actions[0]?.action ?? 'copy'} action was attempted on the exam page.`
        : `${total} copy/cut/paste actions ${closed ? 'were' : 'have been'} attempted on the exam page (${parts.join(', ')}).`;
    return {
      confidence: 1,
      details: { copy: clip.copy, cut: clip.cut, paste: clip.paste, total, blocked: policy.blockClipboard, actions: clip.actions.slice(-20) },
      observation,
    };
  }

  function advance(t: number, out: EpisodeUpdate[]): void {
    if (blurSince !== null && hidden !== true && policy.flagWindowBlur && !book.isOpen('window_unfocused') && t - blurSince >= blurMinMs) {
      openSpan('window_unfocused', blurSince, t, out);
    }
    if (book.isOpen('clipboard_attempt') && t - clip.lastAt >= quietMs) {
      const u = book.end('clipboard_attempt', clip.lastAt, t, clipData(true));
      if (u) out.push(u);
    }
    // Throttled progress updates for long spans (details change as time passes).
    for (const type of ['tab_hidden', 'window_unfocused', 'fullscreen_exited'] as EventType[]) {
      const st = stats[type];
      if (st && book.isOpen(type)) {
        const u = book.touch(type, t, String(Math.floor((t - st.segStart) / 60000)), () => describe(type, st, null, t));
        if (u) out.push(u);
      }
    }
  }

  function run(t: number, fn: (t: number, out: EpisodeUpdate[]) => void): EpisodeUpdate[] {
    const out: EpisodeUpdate[] = [];
    const tt = at(t);
    if (!Number.isFinite(tt)) return out;
    lastT = tt;
    advance(tt, out);
    fn(tt, out);
    return out;
  }

  return {
    visibility(isHidden, t) {
      return run(t, (tt, out) => {
        if (isHidden && hidden !== true) {
          hidden = true;
          let start = tt;
          if (book.isOpen('window_unfocused')) closeSpan('window_unfocused', tt, tt, out);
          else if (blurSince !== null) start = blurSince; // pending blur becomes part of the hidden period
          blurSince = null;
          if (policy.flagTabHidden) openSpan('tab_hidden', start, tt, out);
        } else if (!isHidden && hidden !== false) {
          const was = hidden;
          hidden = false;
          if (was === true) closeSpan('tab_hidden', tt, tt, out);
          if (focused === false) blurSince = tt;
        }
      });
    },
    focus(isFocused, t) {
      return run(t, (tt, out) => {
        if (!isFocused && focused !== false) {
          focused = false;
          if (hidden !== true) {
            blurSince = tt;
            if (blurMinMs === 0 && policy.flagWindowBlur) openSpan('window_unfocused', tt, tt, out);
          }
        } else if (isFocused && focused !== true) {
          focused = true;
          if (book.isOpen('window_unfocused')) closeSpan('window_unfocused', tt, tt, out);
          blurSince = null;
        }
      });
    },
    fullscreen(active, t) {
      return run(t, (tt, out) => {
        if (!active && fs !== false) {
          fs = false;
          if (policy.requireFullscreen) openSpan('fullscreen_exited', tt, tt, out);
        } else if (active && fs !== true) {
          fs = true;
          if (book.isOpen('fullscreen_exited')) closeSpan('fullscreen_exited', tt, tt, out);
        }
      });
    },
    clipboard(action, t) {
      return run(t, (tt, out) => {
        if (action !== 'copy' && action !== 'cut' && action !== 'paste') return;
        if (!book.isOpen('clipboard_attempt')) {
          if (!book.wouldMerge('clipboard_attempt', tt)) clip = { copy: 0, cut: 0, paste: 0, lastAt: tt, actions: [] };
          clip[action]++;
          clip.lastAt = tt;
          clip.actions.push({ action, at: tt });
          const { update } = book.begin('clipboard_attempt', 'clipboard_attempt', tt, tt, clipData(false), String(clip.copy + clip.cut + clip.paste));
          out.push(update);
          return;
        }
        clip[action]++;
        clip.lastAt = tt;
        clip.actions.push({ action, at: tt });
        if (clip.actions.length > 50) clip.actions.shift();
        const u = book.touch('clipboard_attempt', tt, String(clip.copy + clip.cut + clip.paste), () => clipData(false));
        if (u) out.push(u);
      });
    },
    displays(isExtended, t) {
      return run(t, (tt, out) => {
        if (isExtended === true && extended !== true) {
          out.push(
            book.marker('additional_display_detected', tt, {
              confidence: 1,
              details: { isExtended: true },
              observation: 'The browser reports that more than one display is connected. Activity on other displays cannot be observed.',
            }),
          );
        }
        extended = isExtended;
      });
    },
    tick(t) {
      return run(t, () => {});
    },
    flush(t) {
      return run(t, (tt, out) => {
        for (const type of ['tab_hidden', 'window_unfocused', 'fullscreen_exited'] as EventType[]) if (book.isOpen(type)) closeSpan(type, tt, tt, out);
        if (book.isOpen('clipboard_attempt')) {
          const u = book.end('clipboard_attempt', clip.lastAt, tt, clipData(true));
          if (u) out.push(u);
        }
        book.forgetClosed();
        blurSince = null;
        hidden = null;
        focused = null;
        fs = null;
        extended = null;
      });
    },
  };
}

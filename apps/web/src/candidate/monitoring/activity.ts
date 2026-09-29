import type { ActivityTiming } from '@sp/shared';

/**
 * Exam-page activity for the monitoring engine — TIMING ONLY: when the candidate last pressed a key, moved or
 * pressed the pointer, scrolled, or changed an answer (epoch ms on the monitoring clock). Never which key,
 * what was typed, or where the pointer is. The engine uses it to learn where this candidate looks while
 * working (screen, keyboard), so reading, typing and using the mouse are not mistaken for looking away.
 *
 * It stays in the browser: it is attached to each FrameObservation given to the in-browser engine (and to the
 * locally downloadable evaluation trace with `?trace=1`); nothing of it is sent to the server.
 */
export class ActivityTracker {
  private readonly a: Required<ActivityTiming> = { keyAt: null, answerKeyAt: null, pointerAt: null, clickAt: null, scrollAt: null, answerAt: null };

  constructor(private readonly now: () => number) {}

  /** Current timing (a copy). */
  snapshot(): ActivityTiming {
    return { ...this.a };
  }

  key(inAnswerField: boolean): void {
    const t = this.now();
    this.a.keyAt = t;
    if (inAnswerField) this.a.answerKeyAt = t;
  }

  pointer(): void {
    this.a.pointerAt = this.now();
  }

  click(): void {
    const t = this.now();
    this.a.clickAt = t;
    this.a.pointerAt = t;
  }

  scroll(): void {
    this.a.scrollAt = this.now();
  }

  answer(): void {
    this.a.answerAt = this.now();
  }

  /**
   * Listen on the exam page (capture phase, passive: never interferes with the page). Returns a function that
   * removes the listeners.
   */
  attach(doc: Document): () => void {
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    const handlers: [string, (e: Event) => void][] = [
      ['keydown', (e) => this.key(isAnswerField(e.target))],
      ['pointermove', () => this.pointer()],
      ['pointerdown', () => this.click()],
      ['wheel', () => this.scroll()],
      ['scroll', () => this.scroll()],
      ['input', () => this.answer()],
      ['change', () => this.answer()],
    ];
    for (const [type, fn] of handlers) doc.addEventListener(type, fn, opts);
    return () => {
      for (const [type, fn] of handlers) doc.removeEventListener(type, fn, opts);
    };
  }
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'number', 'email', 'tel', 'url', 'password', '']);

/** A text field the candidate types an answer into (text input, text area, editable element). */
export function isAnswerField(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: string; type?: string; isContentEditable?: boolean };
  const tag = (el.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has(String(el.type ?? '').toLowerCase());
  return el.isContentEditable === true;
}

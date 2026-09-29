import { describe, expect, it } from 'vitest';
import { ActivityTracker, isAnswerField } from './activity';

describe('ActivityTracker', () => {
  it('records only WHEN the candidate interacted, from events anywhere in the page', () => {
    let now = 1000;
    const tr = new ActivityTracker(() => now);
    const detach = tr.attach(document);
    document.body.innerHTML = '<main><textarea id="a"></textarea><input id="r" type="radio"><button id="b">Next</button></main>';
    const ta = document.getElementById('a')!;
    const btn = document.getElementById('b')!;

    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    expect(tr.snapshot()).toMatchObject({ keyAt: 1000, answerKeyAt: 1000, pointerAt: null, clickAt: null, scrollAt: null, answerAt: null });
    now = 2000;
    btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(tr.snapshot()).toMatchObject({ keyAt: 2000, answerKeyAt: 1000 });
    now = 3000;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    now = 4000;
    document.dispatchEvent(new Event('pointermove'));
    now = 5000;
    btn.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    now = 6000;
    document.dispatchEvent(new Event('wheel'));
    expect(tr.snapshot()).toEqual({ keyAt: 2000, answerKeyAt: 1000, pointerAt: 5000, clickAt: 5000, scrollAt: 6000, answerAt: 3000 });

    // Timing only: nothing about which key, what text or where the pointer was.
    const values = Object.values(tr.snapshot());
    expect(values.every((v) => v === null || typeof v === 'number')).toBe(true);

    detach();
    now = 9000;
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', bubbles: true }));
    expect(tr.snapshot().keyAt).toBe(2000);
  });

  it('snapshots are copies', () => {
    const tr = new ActivityTracker(() => 5);
    const a = tr.snapshot();
    tr.key(false);
    expect(a.keyAt).toBeNull();
    expect(tr.snapshot().keyAt).toBe(5);
  });
});

describe('isAnswerField', () => {
  it('recognises text entry fields', () => {
    const el = (html: string) => {
      document.body.innerHTML = html;
      return document.body.firstElementChild;
    };
    expect(isAnswerField(el('<textarea></textarea>'))).toBe(true);
    expect(isAnswerField(el('<input type="text">'))).toBe(true);
    expect(isAnswerField(el('<input>'))).toBe(true);
    expect(isAnswerField(el('<input type="radio">'))).toBe(false);
    expect(isAnswerField(el('<button>x</button>'))).toBe(false);
    expect(isAnswerField(null)).toBe(false);
    expect(isAnswerField({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
  });
});

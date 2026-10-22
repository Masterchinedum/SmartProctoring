import { describe, expect, it } from 'vitest';
import { CHECK_IN_LEAD_MS } from '@sp/shared';
import { describeWindow, formatWindowTime, fromLocalInput, parseReopenMinutes, parseWindowForm, toLocalInput } from './scheduling';

const H = 3600_000;
// A local-time instant (the inputs are in the viewer's time zone, whatever the test machine's is).
const T = new Date(2026, 10, 2, 9, 0, 0, 0).getTime();

describe('datetime-local values', () => {
  it('round-trips local date-times and rejects impossible dates', () => {
    expect(toLocalInput(T)).toBe('2026-11-02T09:00');
    expect(fromLocalInput('2026-11-02T09:00')).toBe(T);
    expect(fromLocalInput(toLocalInput(T + 90 * 60_000))).toBe(T + 90 * 60_000);
    expect(toLocalInput(null)).toBe('');
    expect(fromLocalInput('  ')).toBeNull();
    expect(fromLocalInput('2026-02-31T09:00')).toBeNaN();
    expect(fromLocalInput('tomorrow')).toBeNaN();
  });
});

describe('window form', () => {
  const now = T - 24 * H;
  it('accepts a window, an open-ended bound, or none', () => {
    expect(parseWindowForm({ opens: '2026-11-02T09:00', closes: '2026-11-02T12:00' }, now)).toEqual({ ok: true, window: { startsAt: T, endsAt: T + 3 * H } });
    expect(parseWindowForm({ opens: '', closes: '2026-11-02T12:00' }, now)).toEqual({ ok: true, window: { startsAt: null, endsAt: T + 3 * H } });
    expect(parseWindowForm({ opens: '', closes: '' }, now)).toEqual({ ok: true, window: null });
  });

  it('reports the field to fix with the server’s wording', () => {
    expect(parseWindowForm({ opens: '2026-11-02T12:00', closes: '2026-11-02T09:00' }, now)).toEqual({ ok: false, field: 'closes', error: 'The window must close after it opens.' });
    expect(parseWindowForm({ opens: '', closes: '2026-11-01T08:00' }, now)).toMatchObject({ ok: false, field: 'closes', error: expect.stringMatching(/already passed/) });
    expect(parseWindowForm({ opens: '2029-11-02T09:00', closes: '' }, now)).toMatchObject({ ok: false, field: 'opens', error: expect.stringMatching(/two years/) });
    expect(parseWindowForm({ opens: 'x', closes: '' }, now)).toMatchObject({ ok: false, field: 'opens' });
  });
});

describe('window summary', () => {
  it('says when the exam can be started and whether that is now', () => {
    const w = { startsAt: T, endsAt: T + 3 * H };
    expect(describeWindow(null, T)).toBe('Any time (no window)');
    expect(describeWindow(w, T - 2 * H)).toBe(`${formatWindowTime(T)} – ${formatWindowTime(T + 3 * H)} (opens in 2h 00m)`);
    expect(describeWindow(w, T - CHECK_IN_LEAD_MS / 2)).toMatch(/opens in 15m 00s/);
    expect(describeWindow(w, T + H)).toMatch(/\(open now\)$/);
    expect(describeWindow(w, T + 3 * H)).toMatch(/\(closed\)$/);
    expect(describeWindow({ startsAt: null, endsAt: T }, T - H)).toBe(`Until ${formatWindowTime(T)} (open now)`);
    expect(formatWindowTime(T)).toBe('2 Nov 2026, 09:00');
  });
});

describe('reopen minutes', () => {
  it('needs enough time for a started exam, any whole number otherwise', () => {
    expect(parseReopenMinutes('', 0, true)).toMatchObject({ ok: false, error: expect.stringMatching(/No exam time is left/) });
    expect(parseReopenMinutes('10', 0, true)).toEqual({ ok: true, minutes: 10 });
    expect(parseReopenMinutes('0', 5 * 60_000, true)).toEqual({ ok: true, minutes: 0 });
    expect(parseReopenMinutes('', 0, false)).toEqual({ ok: true, minutes: 0 });
    expect(parseReopenMinutes('1.5', 0, true)).toMatchObject({ ok: false });
    expect(parseReopenMinutes('1441', 0, true)).toMatchObject({ ok: false });
  });
});

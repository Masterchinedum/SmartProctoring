import { describe, expect, it } from 'vitest';
import { CHECK_IN_LEAD_MS, type CandidateSessionState, type SessionStatus, type SessionWindow } from '@sp/shared';
import { blockingPhase, formatWhen, startOpensAt, windowScreenText } from './window';

const H = 3600_000;
const T = Date.parse('2026-11-02T09:00:00Z');
const w: SessionWindow = { startsAt: T, endsAt: T + 2 * H };
const st = (status: SessionStatus, window: SessionWindow | null = w) => ({ session: { status, window } }) as Pick<CandidateSessionState, 'session'>;
const fmt = (ms: number) => new Date(ms).toISOString().slice(11, 16);

describe('candidate scheduling window', () => {
  it('blocks an exam that has not started before the check-in time and after the closing', () => {
    expect(blockingPhase(st('invited'), T - CHECK_IN_LEAD_MS - 1)).toBe('before_check_in');
    expect(blockingPhase(st('invited'), T - CHECK_IN_LEAD_MS)).toBeNull();
    expect(blockingPhase(st('ready'), T - H)).toBe('before_check_in'); // rescheduled after an early check-in
    expect(blockingPhase(st('ready'), T + 2 * H)).toBe('closed');
    expect(blockingPhase(st('invited', null), T + 100 * H)).toBeNull();
    // An exam in progress is never cut off.
    for (const s of ['active', 'paused', 'on_hold', 'submitted'] as SessionStatus[]) expect(blockingPhase(st(s), T + 3 * H)).toBeNull();
  });

  it('the ready screen waits for the opening after an early check-in', () => {
    expect(startOpensAt(st('ready'), T - 10 * 60_000)).toBe(T);
    expect(startOpensAt(st('ready'), T)).toBeNull();
    expect(startOpensAt(st('invited'), T - 10 * 60_000)).toBeNull();
  });

  it('says when the exam opens (and the check-in), or that it closed, in the candidate’s time zone', () => {
    const early = windowScreenText(w, 'before_check_in', fmt, 'Europe/Lisbon');
    expect(early).toEqual({
      heading: 'This exam is not open yet',
      lead: 'This exam opens on 09:00.',
      lines: [
        'From 08:30 you can do the camera and identity check, so you are ready on time.',
        'The exam must be started by 11:00.',
        'Come back then using the same link. This page also updates by itself.',
        'Times are shown in your time zone (Europe/Lisbon).',
      ],
    });
    const closed = windowScreenText(w, 'closed', fmt, '');
    expect(closed.heading).toBe('This exam is closed');
    expect(closed.lead).toBe('The time for starting this exam ended on 11:00.');
    expect(closed.lines.at(-1)).toBe('Times are shown in your time zone.');
    expect(formatWhen(T)).toMatch(/2026/);
  });
});

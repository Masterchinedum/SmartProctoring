import { describe, expect, it } from 'vitest';
import {
  formatDate,
  formatDetailValue,
  formatPercent,
  formatRelative,
  formatSimilarity,
  formatSmartTime,
  formatTime,
  humanizeKey,
  remainingAt,
} from './format';

const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

describe('time formatting', () => {
  it('formats local time and date', () => {
    expect(formatTime(at(2026, 9, 24, 9, 5, 7))).toBe('09:05:07');
    expect(formatDate(at(2026, 9, 24))).toBe('24 Sep 2026');
    expect(formatTime(null)).toBe('—');
    expect(formatTime(Number.NaN)).toBe('—');
  });

  it('shows only the time on the same day and date + time otherwise', () => {
    const now = at(2026, 9, 24, 18);
    expect(formatSmartTime(at(2026, 9, 24, 14, 3, 27), now)).toBe('14:03:27');
    expect(formatSmartTime(at(2026, 9, 23, 14, 3, 27), now)).toBe('23 Sep, 14:03');
    expect(formatSmartTime(at(2025, 12, 31, 23, 59), now)).toBe('31 Dec 2025, 23:59');
  });

  it('formats relative times', () => {
    const now = 1_000_000_000;
    expect(formatRelative(now - 2000, now)).toBe('just now');
    expect(formatRelative(now - 42_000, now)).toBe('42s ago');
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatRelative(now - 3 * 3600_000, now)).toBe('3h ago');
    expect(formatRelative(now - 3 * 86_400_000, now)).toBe('3d ago');
    expect(formatRelative(now + 60_000, now)).toBe('in 1m 00s');
    expect(formatRelative(null, now)).toBe('—');
  });
});

describe('number formatting', () => {
  it('formats percentages and similarity', () => {
    expect(formatPercent(0.873)).toBe('87%');
    expect(formatPercent(0.8734, 1)).toBe('87.3%');
    expect(formatPercent(null)).toBe('—');
    expect(formatSimilarity(0.41234)).toBe('0.41');
    expect(formatSimilarity(null)).toBe('—');
  });
});

describe('humanizeKey', () => {
  it('handles camelCase and snake_case', () => {
    expect(humanizeKey('lookDirection')).toBe('Look direction');
    expect(humanizeKey('max_yaw_deg')).toBe('Max yaw deg');
    expect(humanizeKey('precededBy')).toBe('Preceded by');
  });
});

describe('formatDetailValue', () => {
  it('uses key conventions for units', () => {
    expect(formatDetailValue('durationMs', 65_000)).toBe('1m 05s');
    expect(formatDetailValue('absentSec', 12.34)).toBe('12.3 s');
    expect(formatDetailValue('yawDeg', 31.6)).toBe('32°');
    expect(formatDetailValue('confidence', 0.912)).toBe('91%');
    expect(formatDetailValue('similarity', 0.2567)).toBe('0.26');
    expect(formatDetailValue('faces', 2)).toBe('2');
    expect(formatDetailValue('ratio', 0.123456)).toBe('12%');
  });
  it('formats timestamps, booleans, arrays and objects', () => {
    expect(formatDetailValue('returnedAt', at(2026, 9, 24, 10, 32, 0))).toBe('24 Sep 2026, 10:32:00');
    expect(formatDetailValue('flag', true)).toBe('Yes');
    expect(formatDetailValue('labels', ['cell phone', 'book'])).toBe('cell phone, book');
    expect(formatDetailValue('labels', [])).toBe('—');
    expect(formatDetailValue('x', null)).toBe('—');
    expect(formatDetailValue('box', { x: 1 })).toBe('{"x":1}');
  });
});

describe('remainingAt', () => {
  it('counts down only while the timer runs', () => {
    expect(remainingAt(60_000, true, 1000, 11_000)).toBe(50_000);
    expect(remainingAt(60_000, false, 1000, 11_000)).toBe(60_000);
    expect(remainingAt(5_000, true, 1000, 11_000)).toBe(0);
    // clock skew: never counts up
    expect(remainingAt(60_000, true, 5000, 1000)).toBe(60_000);
  });
});

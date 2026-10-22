import { describe, expect, it } from 'vitest';
import {
  CHECK_IN_LEAD_MS,
  hasWindow,
  MIN_WINDOW_MS,
  nextWindowBoundary,
  reopenEligibility,
  reopenRequestSchema,
  rescheduleRequestSchema,
  sessionWindowInputSchema,
  windowPhase,
  windowProblem,
  type ReopenFacts,
} from './scheduling';
import { DEFAULT_POLICY, resolvePolicy } from './policy';

const T = Date.parse('2026-11-02T09:00:00Z');
const H = 3600_000;

describe('scheduling windows', () => {
  it('phases: too early, check-in, open, closed (no window = always open)', () => {
    const w = { startsAt: T, endsAt: T + 2 * H };
    expect(windowPhase(null, T)).toBe('open');
    expect(windowPhase({ startsAt: null, endsAt: null }, T)).toBe('open');
    expect(windowPhase(w, T - CHECK_IN_LEAD_MS - 1)).toBe('before_check_in');
    expect(windowPhase(w, T - CHECK_IN_LEAD_MS)).toBe('check_in');
    expect(windowPhase(w, T - 1)).toBe('check_in');
    expect(windowPhase(w, T)).toBe('open');
    expect(windowPhase(w, T + 2 * H - 1)).toBe('open');
    expect(windowPhase(w, T + 2 * H)).toBe('closed');
    // Open-ended bounds.
    expect(windowPhase({ startsAt: null, endsAt: T }, T - H)).toBe('open');
    expect(windowPhase({ startsAt: T, endsAt: null }, T + 100 * H)).toBe('open');
  });

  it('the next boundary is where the phase changes', () => {
    const w = { startsAt: T, endsAt: T + 2 * H };
    expect(nextWindowBoundary(w, T - 2 * H)).toBe(T - CHECK_IN_LEAD_MS);
    expect(nextWindowBoundary(w, T - CHECK_IN_LEAD_MS)).toBe(T);
    expect(nextWindowBoundary(w, T)).toBe(T + 2 * H);
    expect(nextWindowBoundary(w, T + 2 * H)).toBeNull();
    expect(nextWindowBoundary(null, T)).toBeNull();
    expect(hasWindow({ startsAt: null, endsAt: null })).toBe(false);
    expect(hasWindow({ startsAt: null, endsAt: T })).toBe(true);
  });

  it('validates windows staff or integrations set', () => {
    expect(windowProblem({ startsAt: T, endsAt: T + H }, T - H)).toBeNull();
    expect(windowProblem({ startsAt: null, endsAt: null }, T)).toBeNull();
    expect(windowProblem({ startsAt: T + H, endsAt: T }, T - H)).toMatch(/close after it opens/);
    expect(windowProblem({ startsAt: T, endsAt: T + MIN_WINDOW_MS - 1 }, T - H)).toMatch(/at least 5 minutes/);
    expect(windowProblem({ startsAt: null, endsAt: T }, T + 1)).toMatch(/already passed/);
    expect(windowProblem({ startsAt: T + 3 * 366 * 24 * H, endsAt: null }, T)).toMatch(/two years/);
    // An opening time in the past is fine (the window is open now).
    expect(windowProblem({ startsAt: T - H, endsAt: T + H }, T)).toBeNull();
  });

  it('accepts epoch milliseconds or ISO 8601 date-times with a time zone', () => {
    expect(sessionWindowInputSchema.parse({ startsAt: '2026-11-02T09:00:00Z', endsAt: '2026-11-02T12:00:00+01:00' })).toEqual({ startsAt: T, endsAt: T + 2 * H });
    expect(sessionWindowInputSchema.parse({ startsAt: T })).toEqual({ startsAt: T, endsAt: null });
    expect(sessionWindowInputSchema.parse({})).toEqual({ startsAt: null, endsAt: null });
    expect(() => sessionWindowInputSchema.parse({ startsAt: '2026-11-02 09:00' })).toThrow();
    expect(() => sessionWindowInputSchema.parse({ startsAt: -1 })).toThrow();
    expect(rescheduleRequestSchema.parse({ window: { endsAt: T }, note: '  moved  ' })).toEqual({ window: { startsAt: null, endsAt: T }, note: 'moved' });
  });
});

describe('reopen for recovery', () => {
  const ended: ReopenFacts = {
    status: 'submitted',
    endReason: 'time_expired',
    startedAt: T,
    evidencePurgedAt: null,
    hasReference: true,
    staffVerified: false,
    reviewResolved: false,
    remainingMs: 0,
  };

  it('allows exams ended by time, staff, abandonment or the resume policy', () => {
    for (const endReason of ['time_expired', 'staff_submitted', 'staff_terminated', 'abandoned', 'resume_limit'] as const) {
      const r = reopenEligibility({ ...ended, endReason, status: endReason === 'staff_terminated' || endReason === 'abandoned' ? 'terminated' : 'submitted' });
      expect(r, endReason).toMatchObject({ allowed: true, code: null, started: true });
    }
    expect(reopenEligibility({ ...ended, startedAt: null, hasReference: false, endReason: 'abandoned', status: 'terminated' })).toMatchObject({ allowed: true, started: false, message: expect.stringMatching(/check-in/) });
    // Identity verified by staff: there is no face reference by design.
    expect(reopenEligibility({ ...ended, hasReference: false, staffVerified: true }).allowed).toBe(true);
  });

  it('refuses the rest, with a reason', () => {
    expect(reopenEligibility({ ...ended, status: 'active', endReason: null }).code).toBe('not_ended');
    expect(reopenEligibility({ ...ended, endReason: 'candidate_submitted' }).code).toBe('candidate_submitted');
    expect(reopenEligibility({ ...ended, status: 'terminated', endReason: 'candidate_withdrew' }).code).toBe('consent_withdrawn');
    expect(reopenEligibility({ ...ended, evidencePurgedAt: T + H })).toMatchObject({ allowed: false, code: 'evidence_purged', message: expect.stringMatching(/retention/) });
    expect(reopenEligibility({ ...ended, reviewResolved: true }).code).toBe('review_resolved');
    expect(reopenEligibility({ ...ended, hasReference: false }).code).toBe('reference_missing');
  });

  it('validates the request', () => {
    expect(reopenRequestSchema.parse({ reason: ' Power cut at the test centre ' })).toEqual({ reason: 'Power cut at the test centre', addMinutes: 0 });
    expect(() => reopenRequestSchema.parse({ reason: 'oops' })).toThrow();
    expect(() => reopenRequestSchema.parse({ reason: 'Power cut', addMinutes: 1441 })).toThrow();
    expect(() => reopenRequestSchema.parse({ reason: 'Power cut', addMinutes: 1.5 })).toThrow();
  });
});

describe('resume policy', () => {
  it('defaults keep the previous behaviour: no limits, hold when one is set', () => {
    expect(DEFAULT_POLICY.resume).toEqual({ maxReconnects: null, maxOfflineMinutes: null, onLimit: 'hold' });
    // A stored policy from before the resume policy existed resolves to the same defaults.
    expect(resolvePolicy({ pause: { allowed: false } }).resume).toEqual(DEFAULT_POLICY.resume);
  });

  it('validates the limits', () => {
    expect(resolvePolicy({ resume: { maxReconnects: 0, maxOfflineMinutes: 10, onLimit: 'end' } }).resume).toEqual({ maxReconnects: 0, maxOfflineMinutes: 10, onLimit: 'end' });
    expect(() => resolvePolicy({ resume: { maxReconnects: -1 } })).toThrow();
    expect(() => resolvePolicy({ resume: { maxOfflineMinutes: 0 } })).toThrow();
    expect(() => resolvePolicy({ resume: { maxOfflineMinutes: 1441 } })).toThrow();
    expect(() => resolvePolicy({ resume: { onLimit: 'terminate' } })).toThrow();
  });
});

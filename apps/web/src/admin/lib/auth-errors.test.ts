import { describe, expect, it } from 'vitest';
import { ApiError, errorMessage } from '../api/client';
import { isSessionEndedClose, LIVE_SESSION_ENDED_CLOSE_CODE, loginErrorMessage } from './auth-errors';

describe('sign-in error messages', () => {
  it('keeps wrong credentials generic', () => {
    expect(loginErrorMessage(new ApiError(401, 'unauthorized', 'Invalid email or password'))).toBe('Incorrect email or password.');
    expect(loginErrorMessage(new ApiError(400, 'validation_failed', 'Request validation failed'))).toBe('Incorrect email or password.');
  });

  it("shows the server's wait time for the per-account backoff and the per-IP limit", () => {
    expect(loginErrorMessage(new ApiError(429, 'too_many_attempts', 'Too many failed sign-in attempts for this account. Try again in 2 minutes.'))).toBe(
      'Too many failed sign-in attempts for this account. Try again in 2 minutes.',
    );
    expect(loginErrorMessage(new ApiError(429, 'rate_limited', 'Too many requests. Try again in 41 s.'))).toBe('Too many requests. Try again in 41 s.');
    // No server message (e.g. a proxy's bare 429): generic advice.
    expect(loginErrorMessage(new ApiError(429, 'server_error', '429 Too Many Requests'))).toBe('Too many attempts. Wait a minute and try again.');
  });

  it('shows the two-step sign-in messages as they are', () => {
    expect(loginErrorMessage(new ApiError(401, 'invalid_mfa_code', 'That code is not right.'))).toBe('That code is not right.');
    expect(loginErrorMessage(new ApiError(401, 'mfa_challenge_expired', 'This sign-in has expired. Enter your email and password again.'))).toBe(
      'This sign-in has expired. Enter your email and password again.',
    );
  });

  it('falls back to the generic error text', () => {
    expect(loginErrorMessage(new ApiError(0, 'network_error', 'Could not reach the server. Check your connection and try again.'))).toMatch(/Could not reach the server/);
    expect(loginErrorMessage(new ApiError(403, 'forbidden', 'nope'))).toMatch(/disabled/);
  });
});

describe('live channel close codes', () => {
  it('recognises the "staff session ended" close code only', () => {
    expect(LIVE_SESSION_ENDED_CLOSE_CODE).toBe(4401);
    expect(isSessionEndedClose(4401)).toBe(true);
    for (const code of [1000, 1001, 1006, 1011, 4400, 4403]) expect(isSessionEndedClose(code)).toBe(false);
  });
});

describe('staff API error messages', () => {
  it('keeps a missing role generic and shows why a specific refusal happened', () => {
    expect(errorMessage(new ApiError(403, 'forbidden', 'This action requires the admin role'))).toBe('You do not have permission to do this.');
    expect(errorMessage(new ApiError(403, 'bad_origin', 'Cross-origin request refused'))).toBe('You do not have permission to do this.');
    expect(errorMessage(new ApiError(403, 'four_eyes_required', 'Another administrator must approve or reject a change you proposed'))).toBe(
      'Another administrator must approve or reject a change you proposed',
    );
    expect(errorMessage(new ApiError(409, 'proposal_open', 'Version 2 is waiting for approval.'))).toBe('Version 2 is waiting for approval.');
    expect(errorMessage(new Error('Network down'))).toBe('Network down');
    expect(errorMessage('?')).toBe('Something went wrong.');
  });
});

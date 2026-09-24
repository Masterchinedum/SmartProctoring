import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
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

import { ApiError, errorMessage } from '../api/client';

/** WebSocket close code the server uses when the staff session ended (logout, expiry, revocation, disabled). */
export const LIVE_SESSION_ENDED_CLOSE_CODE = 4401;

/** The live channel was closed because the staff session is no longer valid (→ re-check sign-in). */
export function isSessionEndedClose(code: number): boolean {
  return code === LIVE_SESSION_ENDED_CLOSE_CODE;
}

/** Message shown on the sign-in page for a failed login. */
export function loginErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 400) return 'Incorrect email or password.';
    // Per-IP rate limit or per-account backoff: the server says how long to wait.
    if (err.status === 429) return err.message && !/^429\b/.test(err.message) ? err.message : 'Too many attempts. Wait a minute and try again.';
    if (err.status === 403) return 'This account is disabled. Contact your administrator.';
  }
  return errorMessage(err);
}

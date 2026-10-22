import { busyRetryDelayMs, isServerBusy } from '../api';

/**
 * What to do when a check frame could not be sent for a reason that may go away (no connection, a server error,
 * or a busy server). The two are told apart for the candidate: a busy server (many candidates checked at once,
 * 503 / 429) is not a problem with their connection or camera, and it asks how long to wait (Retry-After).
 */

/** Connection / server failures of one frame before it is given up (the check then sends another frame). */
export const FRAME_MAX_NETWORK_RETRIES = 3;
/** How long one frame may wait for a busy server before it is given up (the check then sends another frame). */
export const FRAME_MAX_BUSY_WAIT_MS = 45_000;

export const GUIDANCE_SERVER_BUSY = 'Many people are being checked right now. Stay in front of the camera — this can take a little longer.';
export const GUIDANCE_SERVER_STILL_BUSY = 'The server is still busy. We will keep trying — please stay in front of the camera.';
export const GUIDANCE_CONNECTION_RETRY = 'Connection problem while sending the picture — retrying…';
export const GUIDANCE_CONNECTION_FAILED = 'We could not send the picture. Check your internet connection.';

/** Retries so far for one frame. */
export interface FrameSendState {
  networkFailures: number;
  busyWaitedMs: number;
}

export type FrameSendRetry = { retry: true; delayMs: number; guidance: string } | { retry: false; guidance: string };

/** Decide on a retryable failure of one frame; updates `state`. */
export function frameSendRetry(err: unknown, state: FrameSendState, random: () => number = Math.random): FrameSendRetry {
  if (isServerBusy(err)) {
    if (state.busyWaitedMs >= FRAME_MAX_BUSY_WAIT_MS) return { retry: false, guidance: GUIDANCE_SERVER_STILL_BUSY };
    const delayMs = busyRetryDelayMs(err, 1000, random);
    state.busyWaitedMs += delayMs;
    return { retry: true, delayMs, guidance: GUIDANCE_SERVER_BUSY };
  }
  if (state.networkFailures >= FRAME_MAX_NETWORK_RETRIES) return { retry: false, guidance: GUIDANCE_CONNECTION_FAILED };
  state.networkFailures++;
  return { retry: true, delayMs: 1000 * state.networkFailures, guidance: GUIDANCE_CONNECTION_RETRY };
}

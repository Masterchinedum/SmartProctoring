import { useSyncExternalStore } from 'react';

/**
 * Server-corrected "now" and a single shared 1 s ticker for all live-updating durations/countdowns
 * (avoids one setInterval per component).
 */

let offsetMs = 0;

/** Record the server's clock (from DashboardDTO.serverTime / LiveMessage hello). */
export function setServerTime(serverTime: number, receivedAt: number = Date.now()): void {
  if (!Number.isFinite(serverTime)) return;
  const offset = serverTime - receivedAt;
  // Ignore sub-second jitter so values don't flicker.
  if (Math.abs(offset - offsetMs) > 750) offsetMs = offset;
}

export function serverNow(): number {
  return Date.now() + offsetMs;
}

type Listener = () => void;
const listeners = new Set<Listener>();
let current = serverNow();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (!timer) {
    current = serverNow();
    timer = setInterval(() => {
      current = serverNow();
      listeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  return current;
}

/** Current (server-corrected) epoch ms, re-rendering once per second while `live` is true. */
export function useNow(live = true): number {
  const value = useSyncExternalStore(live ? subscribe : noopSubscribe, getSnapshot, getSnapshot);
  return live ? value : serverNow();
}

function noopSubscribe(): () => void {
  return () => {};
}

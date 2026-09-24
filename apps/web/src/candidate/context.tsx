import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { CandidateController, ControllerSnapshot } from './controller';

const Ctx = createContext<CandidateController | null>(null);

export function ControllerProvider({ controller, children }: { controller: CandidateController; children: ReactNode }) {
  return <Ctx.Provider value={controller}>{children}</Ctx.Provider>;
}

export function useController(): CandidateController {
  const c = useContext(Ctx);
  if (!c) throw new Error('CandidateController missing');
  return c;
}

export function useSnapshot(): ControllerSnapshot {
  const c = useController();
  return useSyncExternalStore(c.subscribe, c.getSnapshot);
}

/** Re-render periodically (for countdowns and relative times). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function formatTime(ts: number | null | undefined): string {
  if (ts == null) return '—';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(ts: number | null | undefined): string {
  if (ts == null) return '—';
  return new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function errorMessage(e: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (e && typeof e === 'object' && 'status' in e && (e as { status: number }).status === 0) {
    return 'We could not reach the exam server. Check your internet connection and try again.';
  }
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { LiveMessage } from '@sp/shared';
import { setServerTime } from '../lib/clock';
import { LiveConnection, type LiveStatus, type SocketLike } from './liveConnection';
import { applyEvent, applyIdentityCheck, applyNote, applyPauseRequestMessage, applySessionSummary, qk } from './queries';

/**
 * Staff realtime channel: one WebSocket to /api/admin/live per tab. Every LiveMessage is applied to the
 * React Query cache (dashboard, session detail, timeline, event lists), then fanned out to page-level
 * subscribers (e.g. to flash new high-severity items). The connection (api/liveConnection.ts) refetches the live
 * views whenever a socket is subscribed (server 'hello') — on first load and after every reconnect — reconnects
 * at once when the server asks for a resync (4408) and otherwise with exponential backoff.
 */

export { backoffMs, type LiveStatus } from './liveConnection';

export interface LiveEnvelope {
  msg: LiveMessage;
  /** For 'event' messages: true if the event was not in the feed before. */
  isNew: boolean;
}

interface LiveContextValue {
  status: LiveStatus;
  /** Epoch ms of the next reconnect attempt (while reconnecting). */
  nextRetryAt: number | null;
  subscribe: (fn: (m: LiveEnvelope) => void) => () => void;
  reconnectNow: () => void;
}

const LiveContext = createContext<LiveContextValue>({
  status: 'connecting',
  nextRetryAt: null,
  subscribe: () => () => {},
  reconnectNow: () => {},
});

export function liveUrl(loc: Pick<Location, 'protocol' | 'host'> = window.location): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/api/admin/live`;
}

/** Apply a live message to the query cache. Returns null for message types this client does not know. */
export function applyLiveMessage(qc: QueryClient, msg: LiveMessage): { isNew: boolean } | null {
  switch (msg.type) {
    case 'hello':
      setServerTime(msg.serverTime);
      return { isNew: false };
    case 'session':
      applySessionSummary(qc, msg.session);
      return { isNew: false };
    case 'event':
      return { isNew: applyEvent(qc, msg.event, { candidateName: msg.candidateName, examTitle: msg.examTitle }).isNew };
    case 'identity_check':
      applyIdentityCheck(qc, msg.sessionId, msg.check);
      return { isNew: false };
    case 'pause_request':
      applyPauseRequestMessage(qc, msg.sessionId, msg.request);
      return { isNew: false };
    case 'note':
      applyNote(qc, msg.sessionId, msg.note);
      return { isNew: false };
    default:
      return null;
  }
}

/** Refetch everything the live channel keeps current (the snapshot may be older than the subscription). */
export function resyncLiveViews(qc: QueryClient): Promise<unknown> {
  return Promise.allSettled([
    qc.invalidateQueries({ queryKey: qk.dashboard }),
    qc.invalidateQueries({ queryKey: ['session'] }),
    qc.invalidateQueries({ queryKey: qk.sessionsAll }),
  ]);
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [nextRetryAt, setNextRetryAt] = useState<number | null>(null);
  const listeners = useRef(new Set<(m: LiveEnvelope) => void>());
  const reconnectRef = useRef<() => void>(() => {});

  useEffect(() => {
    const conn = new LiveConnection({
      createSocket: () => new WebSocket(liveUrl()) as unknown as SocketLike,
      onMessage: (msg, replay) => {
        const applied = applyLiveMessage(qc, msg);
        if (!applied || replay) return; // a replay after a resync was announced when it first arrived
        listeners.current.forEach((fn) => {
          try {
            fn({ msg, isNew: applied.isNew });
          } catch {
            /* a broken subscriber must not break the channel */
          }
        });
      },
      resync: () => resyncLiveViews(qc),
      onStatus: (st, at) => {
        setStatus(st);
        setNextRetryAt(at);
      },
      // 4401: the staff session ended (idle/absolute expiry, logout elsewhere, revoked). Re-check who is signed
      // in: a 401 there drops the cached user and routes to the login page with a return path.
      onSessionEnded: () => void qc.invalidateQueries({ queryKey: qk.me }),
    });
    reconnectRef.current = () => conn.reconnectNow();
    conn.start();
    return () => conn.stop();
  }, [qc]);

  const subscribe = useCallback((fn: (m: LiveEnvelope) => void) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const value = useMemo<LiveContextValue>(
    () => ({ status, nextRetryAt, subscribe, reconnectNow: () => reconnectRef.current() }),
    [status, nextRetryAt, subscribe],
  );
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveContextValue {
  return useContext(LiveContext);
}

/** Subscribe to live messages for the lifetime of the component. */
export function useLiveMessages(fn: (m: LiveEnvelope) => void): void {
  const { subscribe } = useLive();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => subscribe((m) => ref.current(m)), [subscribe]);
}

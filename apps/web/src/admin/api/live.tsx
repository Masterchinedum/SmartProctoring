import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LiveMessage } from '@sp/shared';
import { setServerTime } from '../lib/clock';
import { applyEvent, applyIdentityCheck, applyNote, applyPauseRequestMessage, applySessionSummary, qk } from './queries';

/**
 * Staff realtime channel: one WebSocket to /api/admin/live per tab. Every LiveMessage is applied to the
 * React Query cache (dashboard, session detail, timeline, event lists), then fanned out to page-level
 * subscribers (e.g. to flash new high-severity items). Reconnects with exponential backoff and, after a
 * reconnect, refetches the live views so nothing missed during the gap is lost.
 */

export type LiveStatus = 'connecting' | 'open' | 'reconnecting';

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

/** Backoff: 1 s, 2 s, 4 s … capped at 30 s, with ±20 % jitter. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.8 + 0.4 * random()));
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [nextRetryAt, setNextRetryAt] = useState<number | null>(null);
  const listeners = useRef(new Set<(m: LiveEnvelope) => void>());
  const reconnectRef = useRef<() => void>(() => {});

  useEffect(() => {
    let ws: WebSocket | null = null;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let everOpened = false;

    const handle = (raw: string) => {
      let msg: LiveMessage;
      try {
        msg = JSON.parse(raw) as LiveMessage;
      } catch {
        return;
      }
      let isNew = false;
      switch (msg.type) {
        case 'hello':
          setServerTime(msg.serverTime);
          break;
        case 'session':
          applySessionSummary(qc, msg.session);
          break;
        case 'event':
          isNew = applyEvent(qc, msg.event, { candidateName: msg.candidateName, examTitle: msg.examTitle }).isNew;
          break;
        case 'identity_check':
          applyIdentityCheck(qc, msg.sessionId, msg.check);
          break;
        case 'pause_request':
          applyPauseRequestMessage(qc, msg.sessionId, msg.request);
          break;
        case 'note':
          applyNote(qc, msg.sessionId, msg.note);
          break;
        default:
          return;
      }
      listeners.current.forEach((fn) => {
        try {
          fn({ msg, isNew });
        } catch {
          /* a broken subscriber must not break the channel */
        }
      });
    };

    const scheduleReconnect = () => {
      if (disposed) return;
      const delay = backoffMs(attempt);
      attempt += 1;
      setStatus('reconnecting');
      setNextRetryAt(Date.now() + delay);
      retryTimer = setTimeout(connect, delay);
    };

    const connect = () => {
      if (disposed) return;
      retryTimer = null;
      let socket: WebSocket;
      try {
        socket = new WebSocket(liveUrl());
      } catch {
        scheduleReconnect();
        return;
      }
      ws = socket;
      socket.onopen = () => {
        if (disposed) return;
        attempt = 0;
        setStatus('open');
        setNextRetryAt(null);
        if (everOpened) {
          // Catch up on anything missed while disconnected.
          void qc.invalidateQueries({ queryKey: qk.dashboard });
          void qc.invalidateQueries({ queryKey: ['session'] });
          void qc.invalidateQueries({ queryKey: qk.sessionsAll });
        }
        everOpened = true;
      };
      socket.onmessage = (e) => {
        if (typeof e.data === 'string') handle(e.data);
      };
      socket.onclose = () => {
        if (ws !== socket) return;
        ws = null;
        scheduleReconnect();
      };
      socket.onerror = () => {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      };
    };

    reconnectRef.current = () => {
      if (disposed || (ws && ws.readyState <= WebSocket.OPEN)) return;
      if (retryTimer) clearTimeout(retryTimer);
      attempt = 0;
      setStatus('connecting');
      connect();
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      const s = ws;
      ws = null;
      if (s) {
        s.onclose = null;
        s.onmessage = null;
        s.onerror = null;
        try {
          s.close();
        } catch {
          /* ignore */
        }
      }
    };
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

import type { SessionSummaryDTO } from '@sp/shared';
import { useNow } from '../lib/clock';
import { formatClock, formatDateTime, formatDuration, formatRelative, formatSmartTime, formatTime, remainingAt } from '../lib/format';
import { heartbeatView } from '../lib/liveness';

/** "42s ago" with the absolute time as tooltip; updates every second. */
export function RelativeTime({ at, prefix }: { at: number | null | undefined; prefix?: string }) {
  const now = useNow(at != null);
  if (at == null) return <span className="muted">—</span>;
  return (
    <time dateTime={new Date(at).toISOString()} title={formatDateTime(at)}>
      {prefix}
      {formatRelative(at, now)}
    </time>
  );
}

/** Local time of day (or date + time when not today), with full timestamp as tooltip. */
export function TimeOfDay({ at }: { at: number | null | undefined }) {
  const now = useNow(false);
  if (at == null) return <span className="muted">—</span>;
  return (
    <time dateTime={new Date(at).toISOString()} title={formatDateTime(at)}>
      {formatSmartTime(at, now)}
    </time>
  );
}

export function Clock({ at }: { at: number | null | undefined }) {
  if (at == null) return <span className="muted">—</span>;
  return <time title={formatDateTime(at)}>{formatTime(at)}</time>;
}

/** Duration between `from` and `to`; ticks live while `to` is null (ongoing). */
export function LiveDuration({ from, to, ongoingLabel = true }: { from: number; to: number | null | undefined; ongoingLabel?: boolean }) {
  const ongoing = to == null;
  const now = useNow(ongoing);
  const ms = (to ?? now) - from;
  return (
    <span className={ongoing ? 'duration ongoing' : 'duration'}>
      {formatDuration(ms)}
      {ongoing && ongoingLabel ? <span className="ongoing-tag"> ongoing</span> : null}
    </span>
  );
}

/** Exam time remaining, counting down locally while the timer runs. */
export function Countdown({ remainingMs, timerRunning, receivedAt }: { remainingMs: number; timerRunning: boolean; receivedAt: number }) {
  useNow(timerRunning); // re-render every second while running
  // receivedAt is a client timestamp, so compare against the client clock.
  const value = remainingAt(remainingMs, timerRunning, receivedAt, Date.now());
  return (
    <span className={`countdown${timerRunning ? ' running' : ' stopped'}`} title={timerRunning ? 'Exam clock running' : 'Exam clock stopped'}>
      {formatClock(value)}
      {!timerRunning ? <span className="muted small"> (stopped)</span> : null}
    </span>
  );
}

/** "Reporting interrupted since 14:03:27 (45s)" */
export function ReportingInterrupted({ since }: { since: number }) {
  const now = useNow(true);
  return (
    <div className="reporting-interrupted" role="status">
      <span className="pulse-dot" aria-hidden />
      Reporting interrupted since {formatTime(since)} ({formatDuration(now - since)})
    </div>
  );
}

/**
 * "Last heartbeat" of a session. While the server says the candidate is online and summaries are current, it
 * shows that heartbeats are arriving (the recorded time lags by up to the summary keepalive by design, so a
 * ticking "12s ago" would read as a problem that is not there); otherwise the plain time since the last one.
 * Offline is decided by the server (lib/liveness.ts).
 */
export function LastHeartbeat({ s }: { s: Pick<SessionSummaryDTO, 'status' | 'connection' | 'lastHeartbeatAt' | 'monitoring'> }) {
  const now = useNow(s.lastHeartbeatAt != null);
  const v = heartbeatView(s, now);
  if (v.kind === 'none') return <span className="muted">—</span>;
  if (v.kind === 'live') {
    return (
      <span title={`Last heartbeat recorded ${formatDateTime(v.at)}`}>
        Receiving <span className="muted small">(online)</span>
      </span>
    );
  }
  return (
    <>
      <RelativeTime at={v.at} />
      {v.kind === 'offline' ? <span className="muted small"> · offline</span> : null}
    </>
  );
}

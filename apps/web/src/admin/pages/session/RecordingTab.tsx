import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { isFlagCategory, type EventDTO, type RecordingSegmentDTO, type SessionRecordingSummaryDTO } from '@sp/shared';
import { api, shouldRetry } from '../../api/client';
import { qk } from '../../api/queries';
import { formatDateTime, formatTime } from '../../lib/format';
import { clockLabel, describeRecordingSummary, locate, notRecorded, recordingSpan, seekTimeForEvent, streamSegments, timelineFraction } from '../../lib/recording';
import { CategoryBadge } from '../../components/Badges';
import { EmptyState, ErrorState, Loading } from '../../components/Common';

/**
 * The exam recording on the session page: a webcam player and a screen player playing their segment lists in order on
 * one shared clock (play, pause and seek together; the next segment loads when one ends; periods without a segment
 * show as "not recorded"), and a timeline bar with the session's flagged events as markers. Selecting an event here,
 * or "Watch" on the Timeline / Events tabs, seeks both players to 10 s before it. Each segment is fetched once (the
 * server writes a `recording.view` audit entry for it) and played from memory.
 */

const TICK_MS = 200;
/** A player more than this far from the shared clock is moved to it. */
const MAX_DRIFT_S = 0.8;

export function RecordingTab({ sessionId, summary, seekTo, onOpenEvent }: { sessionId: string; summary: SessionRecordingSummaryDTO; seekTo: number | null; onOpenEvent: (id: string) => void }) {
  const rec = useQuery({ queryKey: qk.sessionRecording(sessionId), queryFn: () => api.sessionRecording(sessionId), retry: shouldRetry, refetchInterval: 30_000 });
  const events = useQuery({ queryKey: qk.sessionEvents(sessionId), queryFn: () => api.sessionEvents(sessionId), retry: shouldRetry });
  const data = rec.data;
  const span = useMemo(() => (data ? recordingSpan(data) : null), [data]);
  const camera = useMemo(() => (data ? streamSegments(data, 'camera') : []), [data]);
  const screen = useMemo(() => (data ? streamSegments(data, 'screen') : []), [data]);
  const flagged = useMemo(() => (events.data?.items ?? []).filter((e) => isFlagCategory(e.category) && (!span || (e.startedAt >= span.start - 60_000 && e.startedAt <= span.end))), [events.data, span]);

  const [clock, setClock] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const buffering = useRef<Record<string, boolean>>({});
  const setBuffering = useCallback((stream: string, b: boolean) => {
    buffering.current[stream] = b;
  }, []);

  // Start at the beginning — or 10 s before the event the reviewer came from.
  useEffect(() => {
    if (!span) return;
    setClock((c) => (seekTo != null ? seekTimeForEvent(seekTo, span) : (c ?? span.start)));
  }, [span, seekTo]);

  // The shared clock: advances with real time while playing, and waits while a player loads its next segment.
  useEffect(() => {
    if (!playing || !span) return;
    let last = performance.now();
    const id = setInterval(() => {
      const t = performance.now();
      const dt = t - last;
      last = t;
      if (Object.values(buffering.current).some(Boolean)) return;
      setClock((c) => {
        const next = Math.min(span.end, (c ?? span.start) + dt);
        if (next >= span.end) setPlaying(false);
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [playing, span]);

  const seek = useCallback((t: number) => span && setClock(Math.min(span.end, Math.max(span.start, t))), [span]);

  if (rec.isPending) return <Loading label="Loading the recording…" />;
  if (rec.isError) return <ErrorState error={rec.error} onRetry={() => void rec.refetch()} />;
  if (!data || !span || clock == null) return <EmptyState title="Nothing was recorded">This exam recorded nothing for this session.</EmptyState>;

  const deleted = summary.available === 0;
  return (
    <div className="stack recording-tab" data-testid="recording-tab">
      <div className="small muted">
        {describeRecordingSummary(summary)} in {summary.segments} part{summary.segments === 1 ? '' : 's'}, from {formatDateTime(span.start)} to {formatTime(span.end)}. Opening a part
        of the recording is written to the audit log.
      </div>
      {deleted ? (
        <div className="banner banner-info" data-testid="recording-deleted">
          The recording was deleted{summary.deletedAt ? ` on ${formatDateTime(summary.deletedAt)}` : ''}
          {summary.deletedBecause === 'retention' ? ' under the retention policy' : summary.deletedBecause ? ` (${summary.deletedBecause.replace(/_/g, ' ')})` : ''}. The list of parts and the
          timeline remain.
        </div>
      ) : null}
      <div className="rec-players">
        {camera.length ? <StreamPlayer label="Webcam and microphone" segments={camera} clock={clock} playing={playing} muted={false} onBuffering={(b) => setBuffering('camera', b)} testId="rec-camera" /> : null}
        {screen.length ? <StreamPlayer label="Screen" segments={screen} clock={clock} playing={playing} muted onBuffering={(b) => setBuffering('screen', b)} testId="rec-screen" /> : null}
      </div>
      <div className="rec-controls row">
        <button type="button" className="btn btn-primary" onClick={() => setPlaying((p) => !p)} disabled={deleted} data-testid="rec-play">
          {playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" className="btn" onClick={() => seek(clock - 10_000)} aria-label="Back 10 seconds">
          −10 s
        </button>
        <button type="button" className="btn" onClick={() => seek(clock + 10_000)} aria-label="Forward 10 seconds">
          +10 s
        </button>
        <span className="rec-clock" data-testid="rec-clock" data-clock={Math.round(clock)}>
          {clockLabel(clock - span.start)} / {clockLabel(span.end - span.start)} <span className="muted small">({formatTime(clock)})</span>
        </span>
      </div>
      <TimelineBar span={span} camera={camera} screen={screen} clock={clock} events={flagged} onSeek={seek} />
      {flagged.length ? (
        <section className="stack">
          <h3>Flagged events during the recording</h3>
          <ul className="rec-event-list">
            {flagged.slice(0, 100).map((e) => (
              <li key={e.id} className="row tight">
                <button type="button" className="link-btn" onClick={() => seek(seekTimeForEvent(e.startedAt, span) ?? span.start)} data-testid="rec-event-seek" data-event-type={e.type}>
                  {formatTime(e.startedAt)} — watch from 10 s before
                </button>
                <CategoryBadge category={e.category} />
                <button type="button" className="link-btn" onClick={() => onOpenEvent(e.id)}>
                  {e.title}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ players */

/** Fetched segment media (object URLs) for the life of the tab: one request — one audit entry — per segment. */
function useSegmentMedia() {
  const cache = useRef(new Map<string, Promise<string>>());
  useEffect(() => {
    const c = cache.current;
    return () => {
      for (const p of c.values()) void p.then((url) => URL.revokeObjectURL(url)).catch(() => undefined);
      c.clear();
    };
  }, []);
  return useCallback((id: string): Promise<string> => {
    let p = cache.current.get(id);
    if (!p) {
      p = fetch(api.recordingMediaUrl(id), { credentials: 'same-origin', cache: 'no-store' }).then(async (res) => {
        if (!res.ok) {
          let message = `This part of the recording could not be loaded (${res.status}).`;
          try {
            const body = (await res.json()) as { message?: string };
            if (body.message) message = body.message;
          } catch {
            /* not JSON */
          }
          throw new Error(message);
        }
        return URL.createObjectURL(await res.blob());
      });
      p.catch(() => cache.current.delete(id));
      cache.current.set(id, p);
    }
    return p;
  }, []);
}

function StreamPlayer({
  label,
  segments,
  clock,
  playing,
  muted,
  onBuffering,
  testId,
}: {
  label: string;
  segments: RecordingSegmentDTO[];
  clock: number;
  playing: boolean;
  muted: boolean;
  onBuffering: (b: boolean) => void;
  testId: string;
}) {
  const media = useSegmentMedia();
  const video = useRef<HTMLVideoElement>(null);
  const [current, setCurrent] = useState<{ id: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loc = locate(segments, clock);
  const seg = loc.kind === 'segment' ? segments[loc.index] : null;
  // In a gap the next part is loaded already (shown under "Not recorded"), so playback continues without a wait.
  const loadSeg = seg ?? (loc.kind === 'gap' && loc.nextIndex != null ? segments[loc.nextIndex] : null);
  const target = loc.kind === 'segment' ? loc.offsetMs / 1000 : 0;
  const targetRef = useRef(target);
  targetRef.current = target;

  // Load the segment playing now (or the next one during a gap), and prefetch the one after it.
  useEffect(() => {
    if (!loadSeg) {
      onBuffering(false);
      return;
    }
    let alive = true;
    setError(null);
    if (seg && current?.id !== seg.id) onBuffering(true);
    media(loadSeg.id)
      .then((url) => alive && setCurrent({ id: loadSeg.id, url }))
      .catch((e: Error) => {
        if (!alive) return;
        setError(e.message);
        onBuffering(false);
      });
    const i = segments.indexOf(loadSeg);
    const next = segments.slice(i + 1).find((s) => s.available);
    if (next) void media(next.id).catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadSeg?.id]);

  // Follow the shared clock: position (when it drifted) and play / pause.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (!seg || !current || current.id !== seg.id) {
      if (!v.paused) v.pause();
      return;
    }
    if (v.readyState >= 1 && Math.abs(v.currentTime - target) > MAX_DRIFT_S && !v.seeking) v.currentTime = target;
    if (playing && v.paused && !v.ended) void v.play().catch(() => undefined);
    else if (!playing && !v.paused) v.pause();
  }, [clock, playing, current, seg, target]);

  const onLoadedMetadata = () => {
    const v = video.current;
    if (!v) return;
    // MediaRecorder files carry no duration (Infinity): seeking to the end once makes the browser work it out, after
    // which positions are seekable.
    if (!Number.isFinite(v.duration)) {
      const restore = () => {
        v.removeEventListener('durationchange', restore);
        v.currentTime = targetRef.current;
      };
      v.addEventListener('durationchange', restore);
      v.currentTime = 1e6;
    } else {
      v.currentTime = targetRef.current;
    }
  };

  const until = loc.kind === 'gap' ? loc.until : null;
  return (
    <figure className="rec-player" data-testid={testId} data-segment={seg?.id ?? ''} data-gap={seg ? '0' : '1'}>
      <figcaption className="rec-player-label">{label}</figcaption>
      <div className="rec-video-wrap">
        <video
          ref={video}
          src={current?.url}
          muted={muted}
          playsInline
          preload="auto"
          onLoadedMetadata={onLoadedMetadata}
          onLoadedData={() => onBuffering(false)}
          onWaiting={() => onBuffering(true)}
          onPlaying={() => onBuffering(false)}
          aria-label={`${label} recording`}
        />
        {!seg ? (
          <div className="rec-gap" data-testid={`${testId}-gap`}>
            Not recorded at this time{until ? ` (recording resumes at ${formatTime(until)})` : ''}.
          </div>
        ) : null}
        {error && seg ? <div className="rec-gap">{error}</div> : null}
      </div>
    </figure>
  );
}

/* ------------------------------------------------------------------ timeline bar */

function TimelineBar({
  span,
  camera,
  screen,
  clock,
  events,
  onSeek,
}: {
  span: { start: number; end: number };
  camera: RecordingSegmentDTO[];
  screen: RecordingSegmentDTO[];
  clock: number;
  events: EventDTO[];
  onSeek: (t: number) => void;
}) {
  const lane = useRef<HTMLDivElement>(null);
  const pct = (t: number) => `${(timelineFraction(t, span) * 100).toFixed(3)}%`;
  const width = (a: number, b: number) => `${((timelineFraction(b, span) - timelineFraction(a, span)) * 100).toFixed(3)}%`;
  const track = (segs: RecordingSegmentDTO[], name: string) => (
    <div className="rec-track" aria-hidden>
      <span className="rec-track-label small muted">{name}</span>
      {segs.map((s) => (
        <span key={s.id} className={`rec-seg${s.available ? '' : ' rec-seg-deleted'}`} style={{ left: pct(s.startedAt), width: width(s.startedAt, s.endedAt) }} />
      ))}
      {notRecorded(segs, span).map((g) => (
        <span key={g.from} className="rec-seg-gap" style={{ left: pct(g.from), width: width(g.from, g.to) }} title="Not recorded" />
      ))}
    </div>
  );
  const fromPointer = (clientX: number) => {
    const r = lane.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return;
    onSeek(span.start + ((clientX - r.left) / r.width) * (span.end - span.start));
  };
  return (
    <div
      className="rec-timeline"
      role="slider"
      tabIndex={0}
      aria-label="Recording position"
      aria-valuemin={0}
      aria-valuemax={Math.round((span.end - span.start) / 1000)}
      aria-valuenow={Math.round((clock - span.start) / 1000)}
      aria-valuetext={`${clockLabel(clock - span.start)}, ${formatTime(clock)}`}
      onClick={(e) => fromPointer(e.clientX)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') onSeek(clock + 10_000);
        else if (e.key === 'ArrowLeft') onSeek(clock - 10_000);
        else if (e.key === 'Home') onSeek(span.start);
        else if (e.key === 'End') onSeek(span.end);
        else return;
        e.preventDefault();
      }}
      data-testid="rec-timeline"
    >
      <div className="rec-lane" ref={lane}>
        {camera.length ? track(camera, 'Webcam') : null}
        {screen.length ? track(screen, 'Screen') : null}
        {events.map((e) => (
          <button
            key={e.id}
            type="button"
            className={`rec-marker cat-bg-${e.category}`}
            style={{ left: pct(e.startedAt) }}
            title={`${formatTime(e.startedAt)} ${e.title}`}
            aria-label={`${e.title} at ${formatTime(e.startedAt)}: watch from 10 seconds before`}
            onClick={(ev) => {
              ev.stopPropagation();
              onSeek(seekTimeForEvent(e.startedAt, span) ?? span.start);
            }}
            data-testid="rec-marker"
          />
        ))}
        <span className="rec-cursor" style={{ left: pct(clock) }} aria-hidden />
      </div>
    </div>
  );
}

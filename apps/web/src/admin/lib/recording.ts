import { formatDuration, recordingPlan, type ProctoringPolicy, type RecordingSegmentDTO, type RecordingStream, type SessionRecordingDTO, type SessionRecordingSummaryDTO } from '@sp/shared';

/**
 * Exam recording in the staff app: what an exam records, and the timeline maths of the session page's Recording tab
 * (a list of individually playable segments per stream, played in order on one shared clock, with "not recorded" gaps).
 */

/** "Webcam, microphone and screen" / "Off" — what an exam's rules record. */
export function describeRecording(policy: Pick<ProctoringPolicy, 'recording' | 'camera'>): string {
  const plan = recordingPlan(policy);
  if (!plan.any) return 'Off';
  const parts = [plan.camera ? 'webcam' : null, plan.audio ? 'microphone' : null, plan.screen ? 'screen' : null].filter((x): x is string => !!x);
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "31m 10s of webcam, 30m 55s of screen" — what was recorded of a session. */
export function describeRecordingSummary(r: SessionRecordingSummaryDTO): string {
  const parts = [r.cameraMs > 0 ? `${formatDuration(r.cameraMs)} of webcam` : null, r.screenMs > 0 ? `${formatDuration(r.screenMs)} of screen` : null].filter((x): x is string => !!x);
  return parts.length ? parts.join(', ') : 'Nothing playable';
}

/** A stream's segments in time order (the order they play in). */
export function streamSegments(rec: Pick<SessionRecordingDTO, 'segments'>, stream: RecordingStream): RecordingSegmentDTO[] {
  return rec.segments.filter((s) => s.stream === stream).sort((a, b) => a.startedAt - b.startedAt || a.seq - b.seq);
}

/** First start and last end over both streams (the shared clock's range); null without segments. */
export function recordingSpan(rec: Pick<SessionRecordingDTO, 'segments'>): { start: number; end: number } | null {
  if (!rec.segments.length) return null;
  return { start: Math.min(...rec.segments.map((s) => s.startedAt)), end: Math.max(...rec.segments.map((s) => s.endedAt)) };
}

export type Located = { kind: 'segment'; index: number; offsetMs: number } | { kind: 'gap'; nextIndex: number | null; until: number | null };

/**
 * Where time `t` falls in a stream: inside segment `index` at `offsetMs`, or in a gap before segment `nextIndex`
 * (null: after the last one). A deleted segment is a gap too (nothing to play), ending where the next playable one starts.
 */
export function locate(segments: readonly RecordingSegmentDTO[], t: number): Located {
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (t < s.startedAt) {
      const next = nextPlayable(segments, i);
      return { kind: 'gap', nextIndex: next, until: next == null ? null : segments[next].startedAt };
    }
    if (t < s.endedAt && s.available) return { kind: 'segment', index: i, offsetMs: t - s.startedAt };
  }
  return { kind: 'gap', nextIndex: null, until: null };
}

function nextPlayable(segments: readonly RecordingSegmentDTO[], from: number): number | null {
  for (let i = from; i < segments.length; i++) if (segments[i].available) return i;
  return null;
}

/** Periods of [start, end] no playable segment of the stream covers ("not recorded"), at least `minMs` long. */
export function notRecorded(segments: readonly RecordingSegmentDTO[], span: { start: number; end: number }, minMs = 1500): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let cursor = span.start;
  for (const s of segments) {
    if (!s.available) continue;
    if (s.startedAt - cursor >= minMs) out.push({ from: cursor, to: s.startedAt });
    cursor = Math.max(cursor, s.endedAt);
  }
  if (span.end - cursor >= minMs) out.push({ from: cursor, to: span.end });
  return out;
}

/** Where to start watching an event: a little before it (default 10 s), within the recording. */
export function seekTimeForEvent(eventStartedAt: number, span: { start: number; end: number } | null, leadMs = 10_000): number | null {
  if (!span) return null;
  return Math.min(span.end, Math.max(span.start, eventStartedAt - leadMs));
}

/** Position of time `t` on the timeline bar (0..1). */
export function timelineFraction(t: number, span: { start: number; end: number }): number {
  const len = span.end - span.start;
  if (len <= 0) return 0;
  return Math.min(1, Math.max(0, (t - span.start) / len));
}

/** "00:12:30" — time since the start of the recording, for the player's clock. */
export function clockLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Staff URL of a segment's media (decrypted, audited when it is opened from the start). */
export function segmentMediaUrl(id: string): string {
  return `/api/admin/recordings/${id}/media`;
}

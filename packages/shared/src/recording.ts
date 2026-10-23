import { z } from 'zod';

/**
 * Recording of the whole exam (policy.recording, off by default; ./policy.ts recordingPlan).
 *
 * The candidate's browser records two streams — `camera` (webcam video, with the microphone when the exam records
 * audio) and `screen` (the shared entire screen) — and restarts its MediaRecorder every RECORDING_SEGMENT_MS, so every
 * segment is a complete, individually playable file (own header): a lost segment never breaks the others, and staff
 * play a list of segments with absolute start times. Segments are uploaded in order
 * (`POST /api/candidate/recordings/segments`, raw body) and stored as evidence (kind `recording`), encrypted like images,
 * in the organisation's evidence storage location; retention, legal holds, erasure, export, `storage:move` and `rekey`
 * cover them like every other evidence item.
 */

export const RECORDING_STREAMS = ['camera', 'screen'] as const;
export type RecordingStream = (typeof RECORDING_STREAMS)[number];

/** Length of one segment: the browser stops and restarts its recorder this often (each segment plays on its own). */
export const RECORDING_SEGMENT_MS = 30_000;
/** Largest accepted segment body (bytes): ~10× what a 30 s segment at the client's bitrates needs. */
export const RECORDING_MAX_SEGMENT_BYTES = 16 * 1024 * 1024;
/** Longest accepted segment: a recorder restart that was delayed (a busy page) still fits; anything longer is refused. */
export const RECORDING_MAX_SEGMENT_DURATION_MS = 10 * 60_000;
/** Container types the server accepts (what MediaRecorder produces: WebM in Chromium / Firefox, MP4 in Safari). */
export const RECORDING_CONTAINER_TYPES = ['video/webm', 'video/mp4'] as const;
export type RecordingContainerType = (typeof RECORDING_CONTAINER_TYPES)[number];

/** `video/webm;codecs=vp9,opus` → `video/webm`; null when it is not an accepted container type. */
export function recordingContainerType(mime: string | null | undefined): RecordingContainerType | null {
  const base = (mime ?? '').split(';')[0].trim().toLowerCase();
  return (RECORDING_CONTAINER_TYPES as readonly string[]).includes(base) ? (base as RecordingContainerType) : null;
}

/** File extension of a recording segment's container type. */
export function recordingFileExtension(mime: string | null | undefined): 'webm' | 'mp4' {
  return recordingContainerType(mime) === 'video/mp4' ? 'mp4' : 'webm';
}

const num = (schema: z.ZodNumber) => z.preprocess((v) => (v === '' || v == null ? undefined : v), z.coerce.number().pipe(schema));

/**
 * POST /api/candidate/recordings/segments?stream=&seq=&startedAt=&durationMs=[&instance=] — body: the segment
 * (Content-Type video/webm or video/mp4, codecs parameters allowed). Idempotent on (session, stream, instance, seq).
 * `instance` = the browser instance that RECORDED the segment (a reloaded page uploads the segments the previous page
 * queued; default: the X-Client-Instance of the request). `seq` counts from 0 per stream and instance.
 */
export const recordingSegmentQuerySchema = z.object({
  stream: z.enum(RECORDING_STREAMS),
  seq: num(z.number().int().min(0).max(1_000_000)),
  /** Epoch ms (server clock, as the client estimates it) when the segment started. */
  startedAt: num(z.number().finite().min(0)),
  durationMs: num(z.number().int().min(0).max(RECORDING_MAX_SEGMENT_DURATION_MS)),
  instance: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{8,100}$/)
    .optional(),
});
export type RecordingSegmentQuery = z.infer<typeof recordingSegmentQuerySchema>;

export interface RecordingSegmentUploadResponse {
  /** false: not kept (the server says why in `reason`); the client drops it either way. */
  stored: boolean;
  /** The same segment was stored before (a re-upload after an ambiguous failure). */
  duplicate: boolean;
  segmentId: string | null;
  reason?: 'during_unobserved_period' | 'before_start' | 'after_end';
}

/** One stored segment (GET /api/admin/sessions/:id/recordings). The media: GET /api/admin/recordings/:id/media. */
export interface RecordingSegmentDTO {
  id: string;
  stream: RecordingStream;
  seq: number;
  startedAt: number;
  durationMs: number;
  endedAt: number;
  /** As the browser produced it, e.g. `video/webm;codecs=vp8,opus`. */
  mimeType: string;
  byteSize: number;
  /** The browser instance (page load) that recorded it. */
  clientInstanceId: string;
  /** false once deleted (retention, consent withdrawal) or missing from storage. */
  available: boolean;
  deletedAt: number | null;
  deletedBecause: string | null;
}

export interface RecordingStreamSummaryDTO {
  segments: number;
  /** Sum of the segments' durations (gaps excluded). */
  durationMs: number;
  bytes: number;
  firstAt: number | null;
  lastAt: number | null;
}

/** GET /api/admin/sessions/:id/recordings */
export interface SessionRecordingDTO {
  sessionId: string;
  segments: RecordingSegmentDTO[];
  streams: Record<RecordingStream, RecordingStreamSummaryDTO>;
}

/** On the session page and in the report: what was recorded (null when nothing was). */
export interface SessionRecordingSummaryDTO {
  segments: number;
  /** Segments still available (not deleted). */
  available: number;
  /** Recorded time per stream (sum of segment durations). */
  cameraMs: number;
  screenMs: number;
  bytes: number;
  /** When the recording was deleted (all segments), with the reason; null while any segment remains. */
  deletedAt: number | null;
  deletedBecause: string | null;
}

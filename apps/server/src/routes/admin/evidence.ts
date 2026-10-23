/**
 * Staff API — evidence images, exam recordings and the identity comparison view.
 *
 *   GET /evidence/:id                -> the image (decrypted; every access audit-logged; 410 once purged)            [reviewer]
 *   GET /sessions/:id/recordings     -> SessionRecordingDTO (segment metadata only)                                  [reviewer]
 *   GET /recordings/:id/media        -> one recording segment, video/webm or video/mp4 (decrypted; Range requests;
 *                                       `recording.view` audit entry for each request that starts at byte 0)          [reviewer]
 *   GET /identity/compare/:eventId   -> IdentityComparisonDTO                                                        [reviewer]
 */
import { recordingContainerType, recordingFileExtension } from '@sp/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { getStaff, requireStaff } from '../../auth/staff.js';
import type { EvidenceRow } from '../../db/schema.js';
import { gone, HttpError, notFound } from '../../lib/errors.js';
import { readEvidenceForStaff } from '../../services/evidence.js';
import { readRecordingSegmentForStaff, sessionRecording } from '../../services/recordings.js';
import { resolveTimeZone } from '../../services/reports-format.js';
import { buildIdentityComparison } from '../../services/reports-identity.js';
import { idParam, noStore } from './common.js';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** A single `bytes=` range of a body of `size` bytes; null when absent, 'invalid' when it cannot be satisfied. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid'; // several ranges or another unit: not supported
  let start: number;
  let end: number;
  if (m[1] === '') {
    // Suffix range: the last N bytes.
    const n = Number(m[2]);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

/** Why a blob cannot be served: deleted (with when and why), or missing from storage. */
function unavailable(row: EvidenceRow, what: 'image' | 'recording'): HttpError {
  if (row.purgedAt) {
    const reason = row.purgeReason === 'retention' ? 'under the retention policy' : row.purgeReason ? `(${row.purgeReason.replace(/_/g, ' ')})` : '';
    const noun = what === 'image' ? 'This image' : 'This part of the recording';
    return gone('evidence_purged', `${noun} was deleted on ${row.purgedAt.toISOString()} ${reason}`.trim() + '. The event record remains.');
  }
  // Metadata exists but the encrypted blob is missing from storage (e.g. a failed or partial purge).
  return new HttpError(410, 'evidence_unavailable', what === 'image' ? 'This image is no longer available in the evidence store.' : 'This part of the recording is no longer available in the evidence store.');
}

/** Send decrypted media, honouring a single byte range (video players seek with Range requests). */
function sendMedia(req: FastifyRequest, reply: FastifyReply, data: Buffer, type: string, filename: string): FastifyReply {
  reply.header('Content-Type', type).header('Accept-Ranges', 'bytes').header('Content-Disposition', `inline; filename="${filename}"`).header('Cross-Origin-Resource-Policy', 'same-origin');
  const range = parseRange(req.headers.range, data.length);
  if (range === 'invalid') return reply.status(416).header('Content-Range', `bytes */${data.length}`).send();
  if (range) {
    const part = data.subarray(range.start, range.end + 1);
    return reply.status(206).header('Content-Range', `bytes ${range.start}-${range.end}/${data.length}`).header('Content-Length', String(part.length)).send(part);
  }
  return reply.header('Content-Length', String(data.length)).send(data);
}

/** The request asks for the start of the media (or all of it): one "view" for the audit log, not every seek. */
function startsAtZero(req: FastifyRequest): boolean {
  const h = req.headers.range;
  return !h || /^bytes=0-/.test(h.trim());
}

export const evidenceRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const reviewer = { preHandler: requireStaff('reviewer') };

  app.get('/evidence/:id', reviewer, async (req, reply) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Evidence', 'evidence_not_found');
    noStore(reply);
    const res = await readEvidenceForStaff(ctx, id, { id: staff.id, orgId: staff.orgId, ip: req.ip });
    if (!res) throw notFound('Evidence not found', 'evidence_not_found');
    const recording = res.row.kind === 'recording';
    if (!res.data) throw unavailable(res.row, recording ? 'recording' : 'image');
    if (recording) {
      const type = recordingContainerType(res.row.contentType) ?? 'application/octet-stream';
      return sendMedia(req, reply, res.data, type, `recording-${res.row.id}.${recordingFileExtension(res.row.contentType)}`);
    }
    const type = IMAGE_TYPES.has(res.row.contentType) ? res.row.contentType : 'application/octet-stream';
    return reply
      .header('Content-Type', type)
      .header('Content-Length', String(res.data.length))
      .header('Content-Disposition', `inline; filename="evidence-${res.row.id}.${type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg'}"`)
      .header('Cross-Origin-Resource-Policy', 'same-origin')
      .send(res.data);
  });

  app.get('/sessions/:id/recordings', reviewer, async (req, reply) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Session', 'session_not_found');
    noStore(reply);
    return sessionRecording(ctx.db, staff.orgId, id);
  });

  app.get('/recordings/:id/media', reviewer, async (req, reply) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Recording', 'recording_not_found');
    noStore(reply);
    const res = await readRecordingSegmentForStaff(ctx, id, { id: staff.id, orgId: staff.orgId, ip: req.ip }, { auditView: startsAtZero(req) });
    if (!res) throw notFound('Recording not found', 'recording_not_found');
    if (!res.data) throw unavailable(res.row, 'recording');
    const type = recordingContainerType(res.row.contentType) ?? 'application/octet-stream';
    return sendMedia(req, reply, res.data, type, `recording-${res.segment.stream}-${res.segment.seq}.${recordingFileExtension(res.row.contentType)}`);
  });

  app.get('/identity/compare/:eventId', reviewer, async (req) => {
    const staff = getStaff(req);
    const eventId = idParam(req, 'eventId', 'Event', 'event_not_found');
    const tz = resolveTimeZone((req.query as Record<string, unknown> | undefined)?.tz);
    return buildIdentityComparison(ctx, staff.orgId, eventId, { timeZone: tz });
  });
};

/**
 * Personal-data export for an access request (GET /api/admin/privacy-requests/:id/export): one ZIP with everything
 * recorded about a candidate, for staff to check and send through a secure channel.
 *
 *   README.txt                         what is in the archive, and which images were already deleted (and why)
 *   candidate.json                     the candidate record, approved ID photo, accommodations, privacy requests
 *   id-photo.jpg                       the approved ID photo (when there is one)
 *   sessions/<nn> <exam>/session.json  the session report, consent record and devices used
 *   sessions/<nn> <exam>/answers.json  each question with the candidate's answer and the points given (no answer keys)
 *   sessions/<nn> <exam>/events.json   the event timeline (with the file name of each image)
 *   sessions/<nn> <exam>/identity-checks.json
 *   sessions/<nn> <exam>/images/*.jpg  the session's images, decrypted
 *
 * Records are read up front (small); images are decrypted one at a time while the archive streams (lib/zip.ts), so
 * memory stays bounded however many there are. An image that cannot be read is listed in README.txt, not fatal.
 */
import type { AccommodationDTO, EventDTO, IdentityCheckDTO, SessionReportDTO } from '@sp/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { accommodations, answers, candidates, evidence, examSessions, exams, privacyRequests, type EvidenceRow } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { zipPathSegment, type ZipEntry } from '../lib/zip.js';
import { toAccommodationDTOs } from './accommodations.js';
import { loadDeviceRecordDTOs, loadIdentityCheckDTOs, loadSessionEventDTOs } from './dto.js';
import { readEvidence } from './evidence.js';
import { sessionExamContent } from './exam-versions.js';
import { buildSessionReport } from './reports.js';

export interface CandidateExport {
  filename: string;
  entries: AsyncIterable<ZipEntry>;
  /** What the archive holds (for the audit record). */
  counts: { sessions: number; images: number; imagesAlreadyDeleted: number };
}

const iso = (t: number) => new Date(t).toISOString();
const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

const KIND_LABEL: Record<EvidenceRow['kind'], string> = {
  event_screenshot: 'screenshot',
  identity_probe: 'identity-sample',
  identity_reference: 'identity-reference',
  id_photo: 'id-photo',
  liveness_frame: 'check-frame',
};

function imageName(row: EvidenceRow): string {
  return `images/${iso(row.capturedAt.getTime()).replace(/[:.]/g, '-')}-${KIND_LABEL[row.kind] ?? row.kind}-${row.id.slice(0, 8)}.jpg`;
}

/** The report without what only staff use: the access link (a credential) and the decision-configuration versions. */
function reportForCandidate(r: SessionReportDTO): SessionReportDTO {
  const { versions: _versions, ...identity } = r.identity;
  return { ...r, session: { ...r.session, accessLink: null }, identity };
}

function evidenceRef(byId: Map<string, EvidenceRow>, id: string) {
  const row = byId.get(id);
  if (!row) return { id, file: null, note: 'not recorded' };
  return row.purgedAt ? { id, file: null, deletedAt: iso(row.purgedAt.getTime()), deletedBecause: row.purgeReason } : { id, file: imageName(row) };
}

export async function buildCandidateExport(ctx: Ctx, orgId: string, candidateId: string, meta: { requestId: string; generatedBy: string }): Promise<CandidateExport> {
  const now = ctx.now();
  const [cand] = await ctx.db
    .select()
    .from(candidates)
    .where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)));
  if (!cand) throw notFound('Candidate not found', 'candidate_not_found');

  const accRows = await ctx.db.select().from(accommodations).where(eq(accommodations.candidateId, candidateId)).orderBy(asc(accommodations.grantedAt));
  const accs: AccommodationDTO[] = await toAccommodationDTOs(ctx.db, ctx.keyring, accRows, { includeNote: true, now });
  const requests = await ctx.db
    .select({ kind: privacyRequests.kind, status: privacyRequests.status, channel: privacyRequests.channel, receivedAt: privacyRequests.receivedAt, dueAt: privacyRequests.dueAt, closedAt: privacyRequests.closedAt })
    .from(privacyRequests)
    .where(and(eq(privacyRequests.orgId, orgId), eq(privacyRequests.candidateId, candidateId)))
    .orderBy(asc(privacyRequests.receivedAt));
  const idPhoto = cand.idPhotoEvidenceId ? (await ctx.db.select().from(evidence).where(and(eq(evidence.id, cand.idPhotoEvidenceId), isNull(evidence.purgedAt))))[0] : undefined;

  const sessions = await ctx.db
    .select({ session: examSessions, examTitle: exams.title })
    .from(examSessions)
    .innerJoin(exams, eq(exams.id, examSessions.examId))
    .where(and(eq(examSessions.candidateId, candidateId), eq(examSessions.orgId, orgId)))
    .orderBy(asc(examSessions.createdAt), asc(examSessions.id));

  interface SessionPart {
    folder: string;
    files: ZipEntry[];
    images: EvidenceRow[];
    deleted: EvidenceRow[];
  }
  const parts: SessionPart[] = [];
  for (const [i, { session: s, examTitle }] of sessions.entries()) {
    const folder = `sessions/${String(i + 1).padStart(2, '0')} ${zipPathSegment(examTitle, 'exam', 50)} (${iso(s.createdAt.getTime()).slice(0, 10)})`;
    const [report, events, checks, devices, rows, answerRows, content] = await Promise.all([
      buildSessionReport(ctx, s.id, orgId),
      loadSessionEventDTOs(ctx.db, s.id),
      loadIdentityCheckDTOs(ctx.db, s.id),
      loadDeviceRecordDTOs(ctx.db, s.id),
      ctx.db.select().from(evidence).where(eq(evidence.sessionId, s.id)).orderBy(asc(evidence.capturedAt), asc(evidence.id)),
      ctx.db.select().from(answers).where(eq(answers.sessionId, s.id)),
      sessionExamContent(ctx.db, s),
    ]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const answerBy = new Map(answerRows.map((a) => [a.questionId, a]));
    const perQuestion = new Map((s.score?.perQuestion ?? []).map((p) => [p.questionId, p]));
    const answersOut = content.snapshot.questions.map((q, n) => {
      const a = answerBy.get(q.id);
      const p = perQuestion.get(q.id);
      return {
        number: n + 1,
        type: q.type,
        prompt: q.prompt,
        options: q.options,
        answer: a?.value ?? null,
        answeredAt: a ? iso(a.answeredAt.getTime()) : null,
        points: p ? p.points : null,
        maxPoints: q.points,
      };
    });
    const eventsOut = events.map((e: EventDTO) => ({ ...e, evidence: e.evidence.map((r) => ({ ...evidenceRef(byId, r.id), kind: r.kind, capturedAt: iso(r.capturedAt) })) }));
    const checksOut = checks.map((c: IdentityCheckDTO) => ({ ...c, probeEvidence: c.probeEvidence ? evidenceRef(byId, c.probeEvidence.id) : null }));
    const sessionOut = {
      report: reportForCandidate(report),
      consent: s.consentAcceptedAt
        ? { acceptedAt: iso(s.consentAcceptedAt.getTime()), privacyNoticeVersion: s.consentNoticeVersion, ipAddress: s.consentIp, browser: s.consentUserAgent }
        : null,
      devices,
    };
    parts.push({
      folder,
      files: [
        { name: `${folder}/session.json`, data: json(sessionOut) },
        { name: `${folder}/answers.json`, data: json(answersOut) },
        { name: `${folder}/events.json`, data: json(eventsOut) },
        { name: `${folder}/identity-checks.json`, data: json(checksOut) },
      ],
      images: rows.filter((r) => !r.purgedAt),
      deleted: rows.filter((r) => r.purgedAt),
    });
  }

  const candidateOut = {
    exportedAt: iso(now),
    candidate: { id: cand.id, name: cand.name, email: cand.email, externalId: cand.externalId, createdAt: iso(cand.createdAt.getTime()) },
    approvedIdPhoto: cand.idPhotoApprovedAt ? { approvedAt: iso(cand.idPhotoApprovedAt.getTime()), quality: cand.idPhotoQuality, file: idPhoto ? 'id-photo.jpg' : null } : null,
    accommodations: accs.map(({ candidateId: _c, ...a }) => a),
    privacyRequests: requests.map((r) => ({ kind: r.kind, status: r.status, channel: r.channel, receivedAt: iso(r.receivedAt.getTime()), dueAt: iso(r.dueAt.getTime()), closedAt: r.closedAt ? iso(r.closedAt.getTime()) : null })),
    sessions: sessions.map((s, i) => ({ folder: parts[i].folder, sessionId: s.session.id, exam: s.examTitle, status: s.session.status, startedAt: s.session.startedAt ? iso(s.session.startedAt.getTime()) : null, endedAt: s.session.endedAt ? iso(s.session.endedAt.getTime()) : null })),
  };

  const images = parts.reduce((n, p) => n + p.images.length, 0) + (idPhoto ? 1 : 0);
  const alreadyDeleted = parts.reduce((n, p) => n + p.deleted.length, 0);
  const date = iso(now).slice(0, 10);

  async function* entries(): AsyncGenerator<ZipEntry> {
    const unreadable: string[] = [];
    const image = async (row: EvidenceRow, name: string): Promise<ZipEntry | null> => {
      try {
        const data = await readEvidence(ctx, row);
        if (data) return { name, data, date: row.capturedAt };
        unreadable.push(`${name} (no longer in storage)`);
      } catch (err) {
        ctx.log.error({ err, evidenceId: row.id }, 'export: evidence image could not be read');
        unreadable.push(`${name} (could not be decrypted)`);
      }
      return null;
    };
    yield { name: 'candidate.json', data: json(candidateOut) };
    if (idPhoto) {
      const e = await image(idPhoto, 'id-photo.jpg');
      if (e) yield e;
    }
    for (const p of parts) {
      for (const f of p.files) yield f;
      for (const row of p.images) {
        const e = await image(row, `${p.folder}/${imageName(row)}`);
        if (e) yield e;
      }
    }
    const deletedLines = parts.flatMap((p) => p.deleted.map((r) => `  ${p.folder}: ${KIND_LABEL[r.kind] ?? r.kind} captured ${iso(r.capturedAt.getTime())}, deleted ${iso(r.purgedAt!.getTime())} (${r.purgeReason ?? 'deleted'})`));
    const readme = [
      `Personal data held about ${cand.name}`,
      `Exported ${iso(now)} for privacy request ${meta.requestId} by ${meta.generatedBy}.`,
      '',
      'Contents',
      '  candidate.json    the candidate record, approved ID photo, accommodations (including administrators’ notes) and privacy requests',
      idPhoto ? '  id-photo.jpg      the approved ID photo used for identity comparison' : null,
      '  sessions/         one folder per exam session:',
      '    session.json         the session report (timeline periods, identity summary, flags and reviewer notes, score), consent record and devices',
      '    answers.json         each question with the answer given and the points awarded (answer keys are not included)',
      '    events.json          everything recorded during the session; "file" names the image in images/ when there is one',
      '    identity-checks.json each identity comparison and its result',
      '    images/              screenshots and identity images taken during the session',
      '',
      `Sessions: ${sessions.length}. Images included: ${images - unreadable.length}.`,
      '',
      deletedLines.length ? 'Images already deleted (only their record remains):' : 'No image of these sessions has been deleted yet.',
      ...deletedLines,
      ...(unreadable.length ? ['', 'Images that could not be included:', ...unreadable.map((u) => `  ${u}`)] : []),
      '',
      'Face templates (numeric descriptions of a face used for comparison) are not included: they are derived from the images above and are not readable by people.',
      'Before sending: check the archive, and send it to the person through a secure channel.',
      '',
    ].filter((l) => l !== null);
    yield { name: 'README.txt', data: readme.join('\n') };
  }

  return {
    filename: `personal-data-${zipPathSegment(cand.name, 'candidate', 40).replace(/\s+/g, '-')}-${date}.zip`,
    entries: entries(),
    counts: { sessions: sessions.length, images, imagesAlreadyDeleted: alreadyDeleted },
  };
}

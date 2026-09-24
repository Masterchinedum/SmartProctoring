import { buildPrivacyNotice, type PrivacyNoticeDTO, type ProctoringPolicy } from '@sp/shared';
import type { Candidate, ExamSession, Organization } from '../db/schema.js';
import { externalVerifierNoticeNameFor } from '../verifiers/settings.js';
import { orgSettings } from './org.js';

/** Candidate-facing privacy notice for a session (retention: exam override or org default). */
export function noticeFor(org: Organization | null, policy: ProctoringPolicy, candidate: Pick<Candidate, 'idPhotoEvidenceId' | 'idPhotoEmbedding'>, _session?: ExamSession): PrivacyNoticeDTO {
  const settings = orgSettings(org);
  return buildPrivacyNotice({
    retentionDays: policy.retention.evidenceDays ?? settings.evidenceRetentionDays,
    contact: settings.privacyContact || 'your exam administrator',
    orgName: org?.name ?? 'The exam provider',
    idPhotoComparison: policy.identity.idPhotoComparison !== 'off' && !!candidate.idPhotoEmbedding,
    // Names the external second-opinion provider while one is active (verifiers/, docs/EXTERNAL_VERIFIER.md).
    externalVerifier: externalVerifierNoticeNameFor(settings.externalVerifier),
  });
}

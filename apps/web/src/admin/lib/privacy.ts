import {
  MAX_PRIVACY_EXTENSION_DAYS,
  type OpsCheckStatus,
  type PrivacyRequestChannel,
  type PrivacyRequestDTO,
  type PrivacyRequestStatus,
  type RetentionJobStatusDTO,
} from '@sp/shared';
import { formatDate, formatDateTime, formatRelative, pluralize } from './format';

const DAY = 86_400_000;

export const REQUEST_STATUS_LABEL: Record<PrivacyRequestStatus, string> = { open: 'Open', in_progress: 'In progress', completed: 'Completed', rejected: 'Rejected' };
export const REQUEST_STATUS_CLASS: Record<PrivacyRequestStatus, string> = { open: 'badge badge-info', in_progress: 'badge badge-warning', completed: 'badge badge-success', rejected: 'badge' };

export const CHANNEL_LABEL: Record<PrivacyRequestChannel, string> = {
  email: 'Email',
  letter: 'Letter',
  phone: 'Phone',
  in_person: 'In person',
  candidate_app: 'Exam app',
  other: 'Other',
};

export const OPS_STATUS_LABEL: Record<OpsCheckStatus, string> = { ok: 'OK', warning: 'Needs attention', failing: 'Failing' };
export const OPS_STATUS_CLASS: Record<OpsCheckStatus, string> = { ok: 'badge badge-success', warning: 'badge badge-warning', failing: 'badge badge-danger' };

export function isClosed(r: Pick<PrivacyRequestDTO, 'status'>): boolean {
  return r.status === 'completed' || r.status === 'rejected';
}

/** "Overdue by 3 days", "Due today", "Due in 12 days" — or when it was closed. */
export function dueLabel(r: Pick<PrivacyRequestDTO, 'status' | 'dueAt' | 'closedAt'>, now: number): string {
  if (isClosed(r)) return r.closedAt ? `Closed ${formatDate(r.closedAt)}` : 'Closed';
  const days = Math.floor((r.dueAt - now) / DAY);
  if (r.dueAt < now) {
    const late = Math.max(1, Math.ceil((now - r.dueAt) / DAY));
    return `Overdue by ${pluralize(late, 'day')}`;
  }
  if (days === 0) return 'Due today';
  return `Due in ${pluralize(days, 'day')}`;
}

export interface NewRequestDraft {
  kind: string;
  subject: string;
  candidateId: string;
  channel: string;
  /** yyyy-mm-dd (local), empty = today. */
  receivedOn: string;
  details: string;
}

export function validateNewRequest(d: NewRequestDraft, today: string): Partial<Record<keyof NewRequestDraft, string>> {
  const errors: Partial<Record<keyof NewRequestDraft, string>> = {};
  if (!d.kind) errors.kind = 'Choose what was asked.';
  if (d.subject.trim().length < 2) errors.subject = 'Say who the request is from (name, email or reference).';
  if (d.subject.trim().length > 200) errors.subject = 'At most 200 characters.';
  if (d.receivedOn && !/^\d{4}-\d{2}-\d{2}$/.test(d.receivedOn)) errors.receivedOn = 'Enter a date.';
  else if (d.receivedOn && d.receivedOn > today) errors.receivedOn = 'The date the request arrived cannot be in the future.';
  if (d.details.length > 4000) errors.details = 'At most 4,000 characters.';
  return errors;
}

/** The received date as epoch ms: undefined for today (the server uses now), else noon local time that day. */
export function receivedAtFromDate(receivedOn: string, today: string): number | undefined {
  if (!receivedOn || receivedOn === today) return undefined;
  const [y, m, d] = receivedOn.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0).getTime();
}

/** Today as yyyy-mm-dd in local time. */
export function localDate(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function validateExtension(days: string, reason: string, current: number | null): string | null {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PRIVACY_EXTENSION_DAYS) return `Extend by 1 to ${MAX_PRIVACY_EXTENSION_DAYS} days in total.`;
  if (current && n <= current) return `The deadline is already extended by ${current} days; enter a longer total.`;
  if (reason.trim().length < 10) return 'Give the reason you tell the person (at least 10 characters).';
  return null;
}

/** One line about the retention job's last run. */
export function retentionJobLine(job: RetentionJobStatusDTO, now: number): string {
  if (job.lastStartedAt == null) return 'The retention job has not run yet.';
  if (job.lastError) return `The last run (${formatDateTime(job.lastFinishedAt)}) failed: ${job.lastError}`;
  if (job.lastSuccessAt == null) return `Running since ${formatDateTime(job.lastStartedAt)}.`;
  const s = job.lastSummary;
  const what = s
    ? `${pluralize(s.evidenceItemsPurged, 'evidence item')} of ${pluralize(s.sessionsEvidencePurged, 'session')} deleted${s.failures ? `, ${s.failures} to retry` : ''}`
    : 'completed';
  return `Last run ${formatRelative(job.lastSuccessAt, now)}: ${what}.${job.stale ? ' No successful run for over 3 hours.' : ''}`;
}

/** Pure helpers for the Integrations page (API keys, webhooks, email alerts). */
import { WEBHOOK_EVENT_TYPES, type Severity, type WebhookDTO, type WebhookDeliveryDTO, type WebhookEventType } from '@sp/shared';

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
export const MAX_ALERT_RECIPIENTS = 20;

/** Parse a free-text recipient list (commas, semicolons, spaces or new lines). Lower-cased, de-duplicated. */
export function parseRecipients(text: string): { emails: string[]; invalid: string[] } {
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const v = raw.trim().toLowerCase();
    if (!v) continue;
    if (!EMAIL_RE.test(v)) invalid.push(raw.trim());
    else if (!emails.includes(v)) emails.push(v);
  }
  return { emails, invalid };
}

export interface WebhookDraft {
  url: string;
  description: string;
  events: WebhookEventType[];
  minSeverity: Severity;
  active: boolean;
}

export const DEFAULT_WEBHOOK_DRAFT: WebhookDraft = {
  url: '',
  description: '',
  events: ['event.created', 'session.held', 'session.submitted', 'session.terminated'],
  minSeverity: 'medium',
  active: true,
};

export function webhookToDraft(w: WebhookDTO): WebhookDraft {
  return { url: w.url, description: w.description, events: [...w.events], minSeverity: w.minSeverity, active: w.active };
}

/** Client-side checks (the server validates again, including private-network rules). */
export function validateWebhookDraft(d: WebhookDraft, opts: { httpsRequired: boolean }): Record<string, string> {
  const e: Record<string, string> = {};
  const url = d.url.trim();
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (!url) e.url = 'Required';
  else if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) e.url = 'Enter a full URL, e.g. https://lms.example.com/hooks/proctoring';
  else if (opts.httpsRequired && parsed.protocol !== 'https:') e.url = 'Must start with https://';
  else if (parsed.username || parsed.password) e.url = 'Do not put credentials in the URL; verify the signature instead';
  if (d.events.length === 0) e.events = 'Choose at least one notification';
  if (d.description.length > 200) e.description = 'At most 200 characters';
  return e;
}

/** Keep the canonical order of notification types. */
export function toggleEvent(events: WebhookEventType[], type: WebhookEventType, on: boolean): WebhookEventType[] {
  const set = new Set(events);
  if (on) set.add(type);
  else set.delete(type);
  return WEBHOOK_EVENT_TYPES.filter((t) => set.has(t));
}

export type Tone = 'success' | 'danger' | 'warning' | 'info' | 'neutral';

export function webhookStatus(w: Pick<WebhookDTO, 'active' | 'disabledReason' | 'failureCount'>): { label: string; tone: Tone; hint: string } {
  if (!w.active && w.disabledReason === 'failures') {
    return { label: 'Disabled after repeated failures', tone: 'danger', hint: 'Deliveries kept failing, so sending was stopped. Fix the endpoint, send a test, then enable it again.' };
  }
  if (!w.active) return { label: 'Off', tone: 'neutral', hint: 'Switched off by staff. Nothing is sent.' };
  if (w.failureCount > 0) return { label: `Failing (${w.failureCount})`, tone: 'warning', hint: 'Recent deliveries failed and are being retried.' };
  return { label: 'Active', tone: 'success', hint: 'Notifications are being delivered.' };
}

export function deliveryStatus(d: Pick<WebhookDeliveryDTO, 'status' | 'attempts'>): { label: string; tone: Tone } {
  if (d.status === 'succeeded') return { label: 'Delivered', tone: 'success' };
  if (d.status === 'failed') return { label: 'Failed', tone: 'danger' };
  return d.attempts > 0 ? { label: 'Retrying', tone: 'warning' } : { label: 'Pending', tone: 'info' };
}

/** "HTTP 200", "HTTP 500: …", "Connection refused" … */
export function deliveryResult(d: Pick<WebhookDeliveryDTO, 'lastStatusCode' | 'lastError' | 'attempts'>): string {
  if (d.attempts === 0) return 'Not attempted yet';
  if (d.lastError) return d.lastError;
  return d.lastStatusCode != null ? `HTTP ${d.lastStatusCode}` : '—';
}

export const TONE_CLASS: Record<Tone, string> = {
  success: 'badge badge-success',
  danger: 'badge badge-danger',
  warning: 'badge badge-warning',
  info: 'badge badge-info',
  neutral: 'badge',
};

/** Pure helpers for the Integrations page (API keys, webhooks, email alerts). */
import {
  API_KEY_EXPIRY_WARNING_DAYS,
  API_KEY_MAX_LIFETIME_DAYS,
  API_KEY_READ_ONLY_SCOPES,
  API_KEY_SCOPE_INFO,
  API_KEY_SCOPES,
  apiKeyState,
  normaliseApiKeyScopes,
  WEBHOOK_EVENT_TYPES,
  type ApiKeyDTO,
  type ApiKeyScope,
  type Severity,
  type WebhookDTO,
  type WebhookDeliveryDTO,
  type WebhookEventType,
} from '@sp/shared';
import { formatDate, pluralize } from './format';

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

/* ------------------------------------------------------------------ API keys */

const DAY_MS = 86_400_000;

/** Access presets offered when creating a key; `custom` = the scopes ticked one by one. */
export type ScopePreset = 'full' | 'read' | 'custom';

export const SCOPE_PRESET_LABELS: Record<ScopePreset, string> = {
  full: 'Full access (read and write)',
  read: 'Read only',
  custom: 'Choose permissions…',
};

const sameScopes = (a: readonly ApiKeyScope[], b: readonly ApiKeyScope[]) => a.length === b.length && a.every((s) => b.includes(s));

export function scopePreset(scopes: readonly ApiKeyScope[]): ScopePreset {
  const s = normaliseApiKeyScopes(scopes);
  if (sameScopes(s, API_KEY_SCOPES)) return 'full';
  if (sameScopes(s, API_KEY_READ_ONLY_SCOPES)) return 'read';
  return 'custom';
}

export function scopesForPreset(preset: ScopePreset, custom: readonly ApiKeyScope[]): ApiKeyScope[] {
  if (preset === 'full') return [...API_KEY_SCOPES];
  if (preset === 'read') return [...API_KEY_READ_ONLY_SCOPES];
  return normaliseApiKeyScopes(custom);
}

/** "Full access", "Read only", or the permissions' labels. */
export function describeScopes(scopes: readonly ApiKeyScope[]): string {
  const preset = scopePreset(scopes);
  if (preset === 'full') return 'Full access';
  if (preset === 'read') return 'Read only';
  const s = normaliseApiKeyScopes(scopes);
  return s.length ? s.map((x) => API_KEY_SCOPE_INFO[x].label).join(', ') : 'No permissions';
}

export const EXPIRY_CHOICES = [
  { value: '30', label: 'In 30 days' },
  { value: '90', label: 'In 90 days' },
  { value: '365', label: 'In 1 year' },
  { value: '730', label: 'In 2 years' },
  { value: 'never', label: 'Never' },
  { value: 'date', label: 'On a date…' },
] as const;
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number]['value'];
export const DEFAULT_EXPIRY_CHOICE: ExpiryChoice = '365';

/** `YYYY-MM-DD` of a local date (the format of <input type="date">). */
export function isoDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The key's expiry for a choice (epoch ms; null = never). A chosen date means the end of that day (local time).
 * Errors are plain sentences for the form.
 */
export function expiryFromChoice(choice: ExpiryChoice, now: number, date = ''): { expiresAt: number | null } | { error: string } {
  if (choice === 'never') return { expiresAt: null };
  if (choice !== 'date') return { expiresAt: now + Number(choice) * DAY_MS };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return { error: 'Choose a date' };
  const end = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59).getTime();
  if (!Number.isFinite(end) || end <= now + 3600_000) return { error: 'Choose a date in the future' };
  if (end > now + API_KEY_MAX_LIFETIME_DAYS * DAY_MS) return { error: `Choose a date within ${API_KEY_MAX_LIFETIME_DAYS / 365} years` };
  return { expiresAt: end };
}

/** Status badge of a key in the list. */
export function apiKeyStatus(k: Pick<ApiKeyDTO, 'revokedAt' | 'expiresAt'>, now: number): { label: string; tone: Tone; hint: string } {
  const state = apiKeyState(k, now);
  if (state === 'revoked') return { label: `Revoked ${formatDate(k.revokedAt)}`, tone: 'neutral', hint: 'Requests with this key are refused.' };
  if (state === 'expired') return { label: `Expired ${formatDate(k.expiresAt)}`, tone: 'danger', hint: 'Requests with this key are refused (“API key expired”). Create a new key, then revoke this one.' };
  if (state === 'expiring') {
    const days = Math.max(0, Math.ceil((k.expiresAt! - now) / DAY_MS));
    return {
      label: days === 0 ? 'Expires today' : `Expires in ${pluralize(days, 'day')}`,
      tone: 'warning',
      hint: 'Create a replacement, update the connected system, then revoke this key.',
    };
  }
  return { label: 'Active', tone: 'success', hint: 'The key works.' };
}

/** Keys needing attention: expiring within the warning period, or expired (not revoked). */
export function apiKeyWarnings(keys: readonly Pick<ApiKeyDTO, 'revokedAt' | 'expiresAt'>[], now: number): { expiring: number; expired: number } {
  let expiring = 0;
  let expired = 0;
  for (const k of keys) {
    const st = apiKeyState(k, now, API_KEY_EXPIRY_WARNING_DAYS);
    if (st === 'expiring') expiring++;
    else if (st === 'expired') expired++;
  }
  return { expiring, expired };
}

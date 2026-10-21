import { API_KEY_READ_ONLY_SCOPES, API_KEY_SCOPES } from '@sp/shared';
import { describe, expect, it } from 'vitest';
import {
  apiKeyStatus,
  apiKeyWarnings,
  DEFAULT_WEBHOOK_DRAFT,
  deliveryResult,
  deliveryStatus,
  describeScopes,
  expiryFromChoice,
  isoDay,
  parseRecipients,
  scopePreset,
  scopesForPreset,
  toggleEvent,
  validateWebhookDraft,
  webhookStatus,
} from './integrations';

describe('integrations helpers', () => {
  it('parses recipient lists (separators, case, duplicates, invalid entries)', () => {
    expect(parseRecipients(' Proctors@Uni.example,\nops@uni.example; proctors@uni.example  ')).toEqual({ emails: ['proctors@uni.example', 'ops@uni.example'], invalid: [] });
    expect(parseRecipients('a@b.example nope x@y')).toEqual({ emails: ['a@b.example'], invalid: ['nope', 'x@y'] });
    expect(parseRecipients('')).toEqual({ emails: [], invalid: [] });
  });

  it('validates webhook drafts', () => {
    const ok = { ...DEFAULT_WEBHOOK_DRAFT, url: 'https://lms.example.com/hook' };
    expect(validateWebhookDraft(ok, { httpsRequired: true })).toEqual({});
    expect(validateWebhookDraft({ ...ok, url: '' }, { httpsRequired: true }).url).toBe('Required');
    expect(validateWebhookDraft({ ...ok, url: 'lms.example.com' }, { httpsRequired: true }).url).toMatch(/full URL/);
    expect(validateWebhookDraft({ ...ok, url: 'http://lms.example.com/hook' }, { httpsRequired: true }).url).toMatch(/https/);
    expect(validateWebhookDraft({ ...ok, url: 'http://127.0.0.1:9000/hook' }, { httpsRequired: false })).toEqual({});
    expect(validateWebhookDraft({ ...ok, url: 'https://u:p@lms.example.com/hook' }, { httpsRequired: true }).url).toMatch(/credentials/);
    expect(validateWebhookDraft({ ...ok, events: [] }, { httpsRequired: true }).events).toBeDefined();
  });

  it('keeps notification types in canonical order when toggling', () => {
    expect(toggleEvent(['session.held'], 'event.created', true)).toEqual(['event.created', 'session.held']);
    expect(toggleEvent(['event.created', 'session.held'], 'event.created', false)).toEqual(['session.held']);
  });

  it('describes webhook and delivery states', () => {
    expect(webhookStatus({ active: false, disabledReason: 'failures', failureCount: 20 })).toMatchObject({ label: 'Disabled after repeated failures', tone: 'danger' });
    expect(webhookStatus({ active: false, disabledReason: 'staff', failureCount: 0 })).toMatchObject({ label: 'Off' });
    expect(webhookStatus({ active: true, disabledReason: null, failureCount: 2 })).toMatchObject({ label: 'Failing (2)', tone: 'warning' });
    expect(webhookStatus({ active: true, disabledReason: null, failureCount: 0 })).toMatchObject({ label: 'Active', tone: 'success' });
    expect(deliveryStatus({ status: 'pending', attempts: 0 }).label).toBe('Pending');
    expect(deliveryStatus({ status: 'pending', attempts: 2 }).label).toBe('Retrying');
    expect(deliveryStatus({ status: 'failed', attempts: 10 }).tone).toBe('danger');
    expect(deliveryResult({ attempts: 1, lastStatusCode: 200, lastError: null })).toBe('HTTP 200');
    expect(deliveryResult({ attempts: 3, lastStatusCode: null, lastError: 'Connection refused' })).toBe('Connection refused');
    expect(deliveryResult({ attempts: 0, lastStatusCode: null, lastError: null })).toBe('Not attempted yet');
  });

  it('maps API key scopes to access presets and plain descriptions', () => {
    expect(scopePreset([...API_KEY_SCOPES].reverse())).toBe('full');
    expect(scopePreset(API_KEY_READ_ONLY_SCOPES)).toBe('read');
    expect(scopePreset(['exams:read', 'assignments:write'])).toBe('custom');
    expect(scopesForPreset('full', [])).toEqual([...API_KEY_SCOPES]);
    expect(scopesForPreset('read', ['candidates:write'])).toEqual([...API_KEY_READ_ONLY_SCOPES]);
    expect(scopesForPreset('custom', ['sessions:read', 'exams:read', 'sessions:read'])).toEqual(['exams:read', 'sessions:read']);
    expect(describeScopes(API_KEY_SCOPES)).toBe('Full access');
    expect(describeScopes(API_KEY_READ_ONLY_SCOPES)).toBe('Read only');
    expect(describeScopes(['exams:read', 'assignments:write'])).toBe('Read exams, Assign exams and see exam links');
    expect(describeScopes([])).toBe('No permissions');
  });

  it('turns the expiry choice into a time (a date means the end of that day, local time)', () => {
    const now = new Date(2026, 9, 21, 12, 0, 0).getTime();
    expect(expiryFromChoice('never', now)).toEqual({ expiresAt: null });
    expect(expiryFromChoice('30', now)).toEqual({ expiresAt: now + 30 * 86_400_000 });
    expect(expiryFromChoice('365', now)).toEqual({ expiresAt: now + 365 * 86_400_000 });
    expect(expiryFromChoice('date', now, '2026-12-31')).toEqual({ expiresAt: new Date(2026, 11, 31, 23, 59, 59).getTime() });
    expect(expiryFromChoice('date', now, '2026-10-21')).toEqual({ expiresAt: new Date(2026, 9, 21, 23, 59, 59).getTime() });
    expect(expiryFromChoice('date', now, '')).toEqual({ error: 'Choose a date' });
    expect(expiryFromChoice('date', now, '2026-10-20')).toEqual({ error: 'Choose a date in the future' });
    expect(expiryFromChoice('date', now, '2030-01-01')).toEqual({ error: 'Choose a date within 3 years' });
    expect(isoDay(now)).toBe('2026-10-21');
  });

  it('describes API key states and counts the keys needing attention', () => {
    const now = new Date(2026, 9, 21, 12, 0, 0).getTime();
    const day = 86_400_000;
    expect(apiKeyStatus({ revokedAt: now - day, expiresAt: null }, now)).toMatchObject({ label: 'Revoked 20 Oct 2026', tone: 'neutral' });
    expect(apiKeyStatus({ revokedAt: null, expiresAt: now - day }, now)).toMatchObject({ label: 'Expired 20 Oct 2026', tone: 'danger' });
    expect(apiKeyStatus({ revokedAt: null, expiresAt: now + 5 * day }, now)).toMatchObject({ label: 'Expires in 5 days', tone: 'warning' });
    expect(apiKeyStatus({ revokedAt: null, expiresAt: now + day - 1 }, now)).toMatchObject({ label: 'Expires in 1 day' });
    expect(apiKeyStatus({ revokedAt: null, expiresAt: now + 30 * day }, now)).toMatchObject({ label: 'Active', tone: 'success' });
    expect(apiKeyStatus({ revokedAt: null, expiresAt: null }, now)).toMatchObject({ label: 'Active' });
    expect(
      apiKeyWarnings(
        [
          { revokedAt: null, expiresAt: now + 3 * day },
          { revokedAt: null, expiresAt: now - day },
          { revokedAt: now, expiresAt: now - day },
          { revokedAt: null, expiresAt: null },
        ],
        now,
      ),
    ).toEqual({ expiring: 1, expired: 1 });
  });
});

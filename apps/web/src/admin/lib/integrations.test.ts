import { describe, expect, it } from 'vitest';
import { DEFAULT_WEBHOOK_DRAFT, deliveryResult, deliveryStatus, parseRecipients, toggleEvent, validateWebhookDraft, webhookStatus } from './integrations';

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
});

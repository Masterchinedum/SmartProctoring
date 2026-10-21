import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request, type APIRequestContext } from '@playwright/test';
import type { ApiKeyDTO } from '../../packages/shared/src/integrations';
import { expectNoA11yIssues } from '../lib/a11y';
import { BASE_URL, DATABASE_URL, EXTERNAL_SERVER, REPO_DIR } from '../lib/config';
import { sql } from '../lib/server';
import { expect, test } from '../lib/test';

/**
 * Scenario 18b — integration API maturity, on the main server (API keys are per organisation but change no setting the
 * other scenarios depend on; the keys created here are revoked at the end):
 *  - staff UI: create a read-only key expiring in 30 days and a key with chosen permissions expiring on a date in
 *    10 days (form validation, the access and expiry columns, the "expires soon" status and banner, accessibility);
 *  - /api/v1 with those keys: the read-only key reads but gets 403 insufficient_scope on a write; the roster key's
 *    POST with an Idempotency-Key is replayed (Idempotent-Replayed: true, same candidate) and refused with another
 *    body (422); the OpenAPI document is served without a key and matches docs/openapi.json;
 *  - expiry: once the read-only key is past its expiry it gets 401 api_key_expired, the Integrations page shows it as
 *    expired, and the Privacy page's operational checks report a key that expired while still in use.
 */

const suffix = Date.now().toString(36);
const REPORTING = `E2E reporting ${suffix}`;
const ROSTER = `E2E roster sync ${suffix}`;

/** `YYYY-MM-DD` of the local date `days` from now (the value an <input type="date"> takes). */
function localDay(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test.describe('integration API: scopes, expiry, idempotency, OpenAPI', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(EXTERNAL_SERVER, 'expires a key directly in the database');

  let reportingKey = '';
  let rosterKey = '';

  test('staff UI: keys with limited permissions and an expiry', async ({ staffPage }) => {
    const page = await staffPage();
    await page.goto('/admin/integrations');
    const keys = page.locator('section', { has: page.getByRole('heading', { name: 'API keys' }) });

    /* ---------------- read only, 30 days */
    await keys.getByLabel('Key name').fill(REPORTING);
    await keys.getByRole('combobox', { name: 'Access', exact: true }).selectOption({ label: 'Read only' });
    await expect(keys).toContainText('Read only: exams, candidates, attempts, reports and events. No changes, and no candidates’ exam links.');
    await keys.getByRole('combobox', { name: 'Expires', exact: true }).selectOption({ label: 'In 30 days' });
    await keys.getByRole('button', { name: 'Create API key' }).click();
    const modal = page.getByRole('dialog', { name: `API key “${REPORTING}” created` });
    reportingKey = (await modal.getByTestId('secret-value').innerText()).trim();
    expect(reportingKey).toMatch(/^sp_live_[A-Za-z0-9_-]{43}$/);
    await expect(modal).toContainText('Access: read only; it stops working after');
    await modal.getByRole('button', { name: 'I have stored it' }).click();
    const reportingRow = keys.locator('tr', { hasText: REPORTING });
    await expect(reportingRow).toContainText('Read only');
    await expect(reportingRow).toContainText('Active');
    await expect(reportingRow).not.toContainText('No expiry');

    /* ---------------- chosen permissions, expiring on a date in 10 days */
    await keys.getByLabel('Key name').fill(ROSTER);
    await keys.getByRole('combobox', { name: 'Access', exact: true }).selectOption({ label: 'Choose permissions…' });
    const perms = keys.getByRole('group', { name: 'Permissions' });
    const checked = perms.getByRole('checkbox', { checked: true });
    await expect(checked).toHaveCount(5); // starts from the read-only permissions
    while ((await checked.count()) > 0) await checked.first().uncheck();
    await keys.getByRole('combobox', { name: 'Expires', exact: true }).selectOption({ label: 'On a date…' });
    await keys.getByRole('button', { name: 'Create API key' }).click();
    await expect(perms).toContainText('Choose at least one permission');
    await expect(keys.getByText('Choose a date', { exact: true })).toBeVisible();
    await perms.getByRole('checkbox', { name: /Create and update candidates/ }).check();
    await perms.getByRole('checkbox', { name: /^Read exams/ }).check();
    await keys.getByLabel('Expiry date').fill(localDay(10));
    await expectNoA11yIssues(page, 'Integrations page (custom API key form)');
    await keys.getByRole('button', { name: 'Create API key' }).click();
    const modal2 = page.getByRole('dialog', { name: `API key “${ROSTER}” created` });
    rosterKey = (await modal2.getByTestId('secret-value').innerText()).trim();
    await modal2.getByRole('button', { name: 'I have stored it' }).click();
    const rosterRow = keys.locator('tr', { hasText: ROSTER });
    await expect(rosterRow).toContainText('Read exams, Create and update candidates');
    await expect(rosterRow).toContainText(/Expires in (10|11) days/);
    await expect(keys.getByTestId('api-key-expiry-warning')).toContainText(/key(s)? expires? within 14 days/);

    /* ---------------- the published contract is linked from the page */
    const status = (await (await page.request.get('/api/admin/integrations/status')).json()) as { apiBaseUrl: string };
    await expect(keys.getByRole('link', { name: 'openapi.json' })).toHaveAttribute('href', `${status.apiBaseUrl}/openapi.json`);
    await page.close();
  });

  test('/api/v1: scopes, Idempotency-Key, the OpenAPI document', async () => {
    expect(reportingKey && rosterKey, 'keys from the UI test').toBeTruthy();
    const anon = await request.newContext({ baseURL: BASE_URL });
    const as = (key: string): Promise<APIRequestContext> => request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { Authorization: `Bearer ${key}` } });
    const reporting = await as(reportingKey);
    const roster = await as(rosterKey);
    try {
      /* ---------------- the OpenAPI document: public, the committed one with this server's URL */
      const docRes = await anon.get('/api/v1/openapi.json');
      expect(docRes.status()).toBe(200);
      const served = (await docRes.json()) as { openapi: string; servers: { url: string }[]; paths: Record<string, unknown> };
      expect(served.openapi).toBe('3.1.0');
      expect(served.servers[0].url).toMatch(/\/api\/v1$/);
      const committed = JSON.parse(readFileSync(join(REPO_DIR, 'docs/openapi.json'), 'utf8')) as typeof served;
      expect({ ...served, servers: [] }).toEqual({ ...committed, servers: [] });

      /* ---------------- read-only key: reads, cannot write */
      expect((await reporting.get('/api/v1/exams')).status()).toBe(200);
      expect((await reporting.get('/api/v1/sessions?limit=1')).status()).toBe(200);
      const denied = await reporting.post('/api/v1/candidates', { data: { name: 'Should not exist' } });
      expect(denied.status()).toBe(403);
      expect(await denied.json()).toMatchObject({ error: 'insufficient_scope', details: { requiredScope: 'candidates:write' } });
      expect(denied.headers()['www-authenticate']).toContain('error="insufficient_scope"');

      /* ---------------- roster key: idempotent create, replayed; another body refused; no session access */
      const idem = crypto.randomUUID();
      const body = { name: 'Idem Candidate', externalId: `IDEM-${suffix}` };
      const first = await roster.post('/api/v1/candidates', { data: body, headers: { 'Idempotency-Key': idem } });
      expect(first.status()).toBe(201);
      const firstBody = (await first.json()) as { candidate: { id: string } };
      const replay = await roster.post('/api/v1/candidates', { data: body, headers: { 'Idempotency-Key': idem } });
      expect(replay.status()).toBe(201);
      expect(replay.headers()['idempotent-replayed']).toBe('true');
      expect(await replay.json()).toEqual(firstBody);
      const reused = await roster.post('/api/v1/candidates', { data: { ...body, name: 'Someone else' }, headers: { 'Idempotency-Key': idem } });
      expect(reused.status()).toBe(422);
      expect((await reused.json()).error).toBe('idempotency_key_reused');
      // The roster key can create candidates but not list them (no candidates:read) nor read sessions.
      expect((await roster.get(`/api/v1/candidates?externalId=IDEM-${suffix}`)).status()).toBe(403);
      expect((await roster.get('/api/v1/sessions')).status()).toBe(403);
      const found = (await (await reporting.get(`/api/v1/candidates?externalId=IDEM-${suffix}`)).json()) as { total: number };
      expect(found.total, 'created once').toBe(1);
    } finally {
      await anon.dispose();
      await reporting.dispose();
      await roster.dispose();
    }
  });

  test('an expired key is refused, shown as expired and reported by the operational checks', async ({ staff, staffPage }) => {
    const keys = await staff.json<{ items: ApiKeyDTO[] }>('get', '/api/admin/api-keys');
    const reportingRec = keys.items.find((k) => k.name === REPORTING)!;
    const rosterRec = keys.items.find((k) => k.name === ROSTER)!;
    // The key was used minutes ago (previous test); move its expiry into the past instead of waiting 30 days.
    await sql(DATABASE_URL, `UPDATE api_keys SET expires_at = now() - interval '1 minute' WHERE id = $1`, [reportingRec.id]);
    const reporting = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { Authorization: `Bearer ${reportingKey}` } });
    try {
      const res = await reporting.get('/api/v1/exams');
      expect(res.status()).toBe(401);
      expect((await res.json()).error).toBe('api_key_expired');
    } finally {
      await reporting.dispose();
    }

    const page = await staffPage();
    await page.goto('/admin/integrations');
    const section = page.locator('section', { has: page.getByRole('heading', { name: 'API keys' }) });
    await expect(section.locator('tr', { hasText: REPORTING })).toContainText('Expired');
    await expect(section.getByTestId('api-key-expiry-warning')).toContainText(/key(s)? (has|have) expired/);

    await page.goto('/admin/privacy');
    const check = page.getByTestId('ops-checks').getByTestId('ops-api_keys');
    await expect(check).toContainText('Failing');
    await expect(check).toContainText('expired while still in use');

    /* ---------------- clean up: revoke both keys (the roster key through the UI) */
    await page.goto('/admin/integrations');
    await section.locator('tr', { hasText: ROSTER }).getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('dialog', { name: `Revoke “${ROSTER}”?` }).getByRole('button', { name: 'Revoke key' }).click();
    await expect(section.locator('tr', { hasText: ROSTER })).toContainText('Revoked');
    await staff.json('post', `/api/admin/api-keys/${reportingRec.id}/revoke`);
    expect(rosterRec.scopes).toEqual(['exams:read', 'candidates:write']);
    await page.reload();
    await expect(section.locator('tr', { hasText: REPORTING })).toContainText('Revoked');
    await expect(section.getByTestId('api-key-expiry-warning')).toHaveCount(0);
    await page.close();
  });
});
